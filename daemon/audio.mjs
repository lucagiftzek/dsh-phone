/**
 * dsh-phone: server-routed call audio (the "Via server" route).
 *
 * The browser talks to ONE host over ONE wss socket (DSH origin -> plugin
 * upgrade route -> hookd's private unix socket). This hub bridges that socket
 * to the far leg of the call:
 *
 *   echo      "Test audio": the browser's audio comes straight back through the
 *             server jitter buffer (no call, no cost).
 *   asterisk  SIP lines: hookd originates an AudioSocket channel through AMI
 *             into a generated dialplan context that applies the account's
 *             destination policy and dials the SIP provider. Audio flows over
 *             loopback TCP (127.0.0.1) as 8 kHz 16-bit PCM. No Twilio.
 *   twilio    Twilio lines, and every incoming call answered here: a
 *             bidirectional Media Stream (<Connect><Stream>, mu-law 8 kHz,
 *             wss) to hookd's public listener, authenticated by the
 *             X-Twilio-Signature on the upgrade AND a one-time ticket in the
 *             stream's custom parameters, bound to the CallSid.
 *
 * Browser link framing: shared/frame.mjs (mu-law 20 ms blocks, control JSON),
 * playout and pacing: shared/jitter.mjs. Nothing is recorded: audio lives in
 * memory for one jitter-buffer window only.
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { JitterBuffer } from '../shared/jitter.mjs'
import { encodeAudio, encodeControl, decodeFrame, BLOCK_SAMPLES } from '../shared/frame.mjs'
import { ulawEncode, ulawDecode, ULAW_SILENCE, pcmToLeBytes, leBytesToPcm, ulawLevel } from '../shared/g711.mjs'
import { el, twiml } from './twilio.mjs'

const BLOCK = BLOCK_SAMPLES
const TICKET_TTL_MS = 60 * 1000
const STREAM_TICKET_TTL_MS = 3 * 60 * 1000
const HELLO_TIMEOUT_MS = 10 * 1000
const STREAM_START_TIMEOUT_MS = 10 * 1000
const RESUME_GRACE_MS = 15 * 1000
const MAX_PENDING_TICKETS = 16
const MAX_BROWSER_BUFFER = 64 * 1024
const SILENCE = new Uint8Array(BLOCK).fill(ULAW_SILENCE)
const HISTORY = 20

// ------------------------------------------------------------------ tones

export const TONES = {
  eu: { freqs: [425], cadence: [1000, 4000] },
  us: { freqs: [440, 480], cadence: [2000, 4000] },
  uk: { freqs: [400, 450], cadence: [400, 200, 400, 2000] },
}
const DTMF = { 1: [697, 1209], 2: [697, 1336], 3: [697, 1477], A: [697, 1633], 4: [770, 1209], 5: [770, 1336], 6: [770, 1477], B: [770, 1633], 7: [852, 1209], 8: [852, 1336], 9: [852, 1477], C: [852, 1633], '*': [941, 1209], 0: [941, 1336], '#': [941, 1477], D: [941, 1633] }

/** Cadenced tone generator producing 20 ms mu-law blocks. */
export class ToneGen {
  constructor(spec, amp = 0.18) { this.spec = spec; this.amp = amp; this.n = 0 }
  block() {
    const out = new Uint8Array(BLOCK)
    const { freqs, cadence } = this.spec
    const period = cadence.reduce((a, b) => a + b, 0)
    for (let i = 0; i < BLOCK; i++, this.n++) {
      const tMs = (this.n / 8) % period
      let acc = 0
      let on = false
      for (let c = 0; c < cadence.length; c++) { acc += cadence[c]; if (tMs < acc) { on = c % 2 === 0; break } }
      let v = 0
      if (on) for (const f of freqs) v += Math.sin(2 * Math.PI * f * this.n / 8000)
      out[i] = ulawEncode(Math.round(v / freqs.length * this.amp * 32767))
    }
    return out
  }
}

/** In-band DTMF: 100 ms tone + 60 ms silence as mu-law blocks (8 blocks). */
export function dtmfBlocks(digit) {
  const f = DTMF[String(digit).toUpperCase()]
  if (!f) return []
  const out = []
  let n = 0
  for (let b = 0; b < 8; b++) {
    const blk = new Uint8Array(BLOCK)
    for (let i = 0; i < BLOCK; i++, n++) {
      const v = n < 800 ? (Math.sin(2 * Math.PI * f[0] * n / 8000) + Math.sin(2 * Math.PI * f[1] * n / 8000)) * 0.25 : 0
      blk[i] = ulawEncode(Math.round(v * 32767))
    }
    out.push(blk)
  }
  return out
}

/** Ringback tone for a line: setting override, else by the line's number. */
export function ringbackFor(line, override = '') {
  if (override && TONES[override]) return TONES[override]
  const num = String((line && line.number) || '')
  if (num.startsWith('+1')) return TONES.us
  if (num.startsWith('+44')) return TONES.uk
  return TONES.eu
}

const b64 = (n) => randomBytes(n).toString('base64url')
function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''))
  const y = Buffer.from(String(b || ''))
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}
const ms = () => Number(process.hrtime.bigint() / 1000000n)

// ------------------------------------------------------------------ the hub

/**
 * deps:
 *   settings()            resolved settings (audio, lines, publicBaseUrl ...)
 *   log, warn
 *   store, broadcast      call log + UI events (optional in tests)
 *   fail(code, msg, st)   coded error factory
 *   hookUrl(path, query)  public webhook URL
 *   streamUrl()           wss URL of the Twilio stream endpoint
 *   twilio                { createCall(form), updateCall(sid, form) }
 *   asterisk              { originate({ uuid, channelId, account, dest, callerId }), hangup(channelId), dtmf(channel, digit), on('event'), release() }
 *   sipAccount(line)      account behind a SIP line or null
 *   allowed(acct, to)     { ok, reason }
 *   mode()                current incoming mode (for the call row)
 *   onVoicemail(...)      not used: voicemail stays in hookd
 */
/** Pseudo line for Telegram calls (calls log line 'tg'). */
export const TG_LINE = Object.freeze({ id: 'tg', label: 'Telegram', number: '', provider: 'telegram', voice: true, sms: false, enabled: true })

export class AudioHub {
  constructor(deps) {
    this.d = deps
    this.sessions = new Map() // id -> session
    this.tickets = new Map() // ticket -> { sessionId, exp }
    this.streams = new Map() // stream ticket -> { sessionId, exp }
    this.byCall = new Map() // callSid / channelId -> session id
    this.byUuid = new Map() // AudioSocket uuid -> session id
    this.history = []
    this.timer = setInterval(() => this.tick(), 5)
    this.timer.unref && this.timer.unref()
    this.sweeper = setInterval(() => this.sweep(), 1000)
    this.sweeper.unref && this.sweeper.unref()
  }

  get cfg() { return this.d.settings().audio }
  log(...a) { this.d.log && this.d.log('audio:', ...a) }
  warn(...a) { this.d.warn && this.d.warn('audio:', ...a) }
  fail(code, msg, status) { return this.d.fail ? this.d.fail(code, msg, status) : Object.assign(new Error(msg), { code, status }) }

  active(kinds) { let n = 0; for (const s of this.sessions.values()) if (s.state !== 'ended' && kinds.includes(s.kind)) n++; return n }

  info() {
    const c = this.cfg
    return {
      ok: true, route: c.route, packetMs: c.packetMs, jitter: { minMs: c.jitterMinMs, maxMs: c.jitterMaxMs },
      limits: { calls: c.maxCalls, tests: c.maxTests, testSeconds: c.testSeconds },
      active: { calls: this.active(['out', 'in']), tests: this.active(['test']) },
      recent: this.history.slice(-5),
    }
  }

  // ---------------------------------------------------------------- sessions

  newSession(kind, extra) {
    const id = b64(9)
    const c = this.cfg
    const s = {
      id, kind, state: 'pending', createdAt: Date.now(), resume: b64(18),
      browser: null, far: null, farKind: '', callSid: '', channelId: '', uuid: '', destChannel: '',
      jb: new JitterBuffer({ frameMs: 20, minMs: c.jitterMinMs, maxMs: c.jitterMaxMs }),
      packetBlocks: Math.max(1, Math.round(c.packetMs / 20)),
      downFifo: [], downBytes: Buffer.alloc(0), downSeq: 0, inject: [],
      ringback: null, ringTimer: null, graceTimer: null, helloTimer: null, endTimer: null,
      t0: 0, ticks: 0, outcome: '', answered: false, muted: false,
      st: {
        up: { packets: 0, bytes: 0, blocks: 0, invalid: 0 }, down: { packets: 0, bytes: 0, blocks: 0, dropped: 0 },
        far: { in: 0, out: 0 }, firstUpMs: null, firstDownMs: null, rttMs: null, rttMax: 0, resumes: 0,
        upLevel: 0, downLevel: 0,
      },
      ...extra,
    }
    this.sessions.set(id, s)
    return s
  }

  mintTicket(s) {
    if (this.tickets.size >= MAX_PENDING_TICKETS) this.sweep(true)
    if (this.tickets.size >= MAX_PENDING_TICKETS) throw this.fail('PHONE_AUDIO_BUSY', 'too many pending audio sessions', 429)
    const t = b64(24)
    this.tickets.set(t, { sessionId: s.id, exp: Date.now() + TICKET_TTL_MS })
    return t
  }

  mintStreamTicket(s) {
    const t = b64(24)
    this.streams.set(t, { sessionId: s.id, exp: Date.now() + STREAM_TICKET_TTL_MS })
    return t
  }

  /**
   * POST /audio/ticket. purpose: test | dial | answer | pickup | resume.
   * Returns { ticket, session, expiresAt, kind }. The browser then opens the
   * socket offering the protocols ['dshp.v1', 'k.' + ticket].
   */
  issueTicket(b, { lineById, defaultLine, toE164, defaultCountry, voicemailById } = {}) {
    const c = this.cfg
    const purpose = String(b.purpose || '')
    if (purpose === 'resume') {
      const s = this.sessions.get(String(b.session || ''))
      if (!s || s.state === 'ended' || !sameSecret(s.resume, b.resume)) throw this.fail('PHONE_AUDIO_SESSION_GONE', 'this audio session has ended', 404)
      return { ok: true, ticket: this.mintTicket(s), session: s.id, kind: s.kind, expiresAt: Date.now() + TICKET_TTL_MS }
    }
    if (purpose === 'test') {
      if (this.active(['test']) >= c.maxTests) throw this.fail('PHONE_AUDIO_BUSY', 'an audio test is already running', 429)
      const s = this.newSession('test', { farKind: 'echo' })
      return { ok: true, ticket: this.mintTicket(s), session: s.id, kind: s.kind, expiresAt: Date.now() + TICKET_TTL_MS }
    }
    if (this.active(['out', 'in']) >= c.maxCalls && purpose !== 'answer') throw this.fail('PHONE_AUDIO_BUSY', 'the server already carries ' + c.maxCalls + ' call(s)', 429)
    if (purpose === 'dial' && String(b.line || '') === 'tg') {
      // Telegram: "to" is the chat id of a person; telegramd places the call when the tab says hello.
      if (!this.d.tg) throw this.fail('PHONE_LINE_UNAVAILABLE', 'Telegram calls are not available')
      const chat = Number(b.to)
      if (!Number.isSafeInteger(chat) || chat <= 0) throw this.fail('PHONE_NUMBER_INVALID', 'not a Telegram user id: ' + b.to)
      const s = this.newSession('out', { farKind: 'telegram', line: TG_LINE, to: String(chat), peer: String(chat), origin: b.origin === 'agent' ? 'agent' : 'ui' })
      return { ok: true, ticket: this.mintTicket(s), session: s.id, kind: s.kind, expiresAt: Date.now() + TICKET_TTL_MS }
    }
    if (purpose === 'dial') {
      const line = (b.line && lineById(b.line)) || defaultLine()
      if (!line || !line.voice) throw this.fail('PHONE_LINE_UNAVAILABLE', 'no voice line available')
      const to = toE164(b.to, defaultCountry)
      if (!to || to.startsWith('client:')) throw this.fail('PHONE_NUMBER_INVALID', 'not a valid phone number: ' + b.to)
      let farKind = 'twilio'
      if (line.provider === 'sip') {
        const acct = this.d.sipAccount(line)
        if (!acct) throw this.fail('PHONE_LINE_UNAVAILABLE', 'line ' + line.id + ' has no enabled SIP account')
        const ok = this.d.allowed(acct, to)
        if (!ok.ok) throw this.fail('PHONE_OUTBOUND_DESTINATION_BLOCKED', 'This number cannot be called from line ' + line.id + ' (' + ok.reason + ')', 403)
        farKind = 'asterisk'
      }
      const s = this.newSession('out', { farKind, line, to, peer: to })
      return { ok: true, ticket: this.mintTicket(s), session: s.id, kind: s.kind, expiresAt: Date.now() + TICKET_TTL_MS }
    }
    if (purpose === 'answer') {
      const s = this.sessions.get(this.byCall.get(String(b.callSid || '')) || '')
      if (!s || s.kind !== 'in' || s.state === 'ended') throw this.fail('PHONE_AUDIO_SESSION_GONE', 'this call is no longer ringing', 404)
      if (s.answered) throw this.fail('PHONE_AUDIO_BUSY', 'this call was already answered', 409)
      return { ok: true, ticket: this.mintTicket(s), session: s.id, kind: s.kind, expiresAt: Date.now() + TICKET_TTL_MS }
    }
    if (purpose === 'pickup') {
      const vm = voicemailById(Number(b.vmId))
      if (!vm) throw this.fail('PHONE_VOICEMAIL_NOT_FOUND', 'voicemail not found')
      if (!['recording', 'greeting'].includes(vm.status)) throw this.fail('PHONE_PICKUP_TOO_LATE', 'the caller is no longer leaving a message')
      const s = this.newSession('in', { farKind: 'twilio', callSid: vm.callSid, line: lineById(vm.line), peer: vm.peer, pickupVm: vm.id, answered: true })
      this.byCall.set(vm.callSid, s.id)
      return { ok: true, ticket: this.mintTicket(s), session: s.id, kind: s.kind, expiresAt: Date.now() + TICKET_TTL_MS }
    }
    throw this.fail('PHONE_BODY_INVALID', 'purpose must be test, dial, answer, pickup or resume')
  }

  /** True when the ticket exists and has not expired (checked before the 101). */
  ticketValid(ticket) {
    const t = this.tickets.get(String(ticket || ''))
    return !!t && t.exp > Date.now() && this.sessions.has(t.sessionId)
  }

  // ---------------------------------------------------------------- browser side

  attachBrowser(ticket, conn) {
    const t = this.tickets.get(String(ticket || ''))
    this.tickets.delete(String(ticket || ''))
    const s = t && t.exp > Date.now() ? this.sessions.get(t.sessionId) : null
    if (!s || s.state === 'ended') { conn.close(4404, 'gone'); return null }
    const resumed = !!s.browserSeen
    if (s.browser && s.browser !== conn) { const old = s.browser; s.browser = null; try { old.close(4409, 'replaced') } catch {} }
    s.browser = conn
    s.browserSeen = true
    s.helloSeen = false
    clearTimeout(s.graceTimer); s.graceTimer = null
    if (resumed) s.st.resumes++
    // The proxy in front may drop bytes sent right after the 101, so the
    // server says nothing until the browser's hello arrives.
    s.helloTimer = setTimeout(() => { if (!s.helloSeen && s.browser === conn) { conn.close(4408, 'no hello'); } }, HELLO_TIMEOUT_MS)
    s.helloTimer.unref && s.helloTimer.unref()
    conn.on('message', (data, binary) => this.fromBrowser(s, conn, data, binary))
    conn.on('close', () => this.browserClosed(s, conn))
    return s
  }

  sendCtl(s, obj) { if (s.browser && !s.browser.closed) s.browser.send(encodeControl(obj)) }

  fromBrowser(s, conn, data, binary) {
    if (s.browser !== conn) return
    if (!binary) { s.st.up.invalid++; return }
    const f = decodeFrame(data)
    if (f.kind === 'invalid') { s.st.up.invalid++; if (s.st.up.invalid > 50) conn.close(4400, 'bad frames'); return }
    if (f.kind === 'control') { this.control(s, f.msg); return }
    if (!s.helloSeen) return
    const now = ms()
    s.st.up.packets++
    s.st.up.bytes += data.length
    s.st.up.blocks += f.blocks
    if (s.st.firstUpMs === null) s.st.firstUpMs = now - s.helloAt
    // Before the far leg is up (dialing, ringing) there is nobody to hear it: do not queue it.
    if (!s.t0) { s.st.up.early = (s.st.up.early || 0) + f.blocks; return }
    for (let i = 0; i < f.blocks; i++) s.jb.push((f.seq + i) & 0xffff, f.payload.slice(i * BLOCK, (i + 1) * BLOCK), now)
  }

  control(s, m) {
    switch (m.t) {
      case 'hello': {
        if (s.helloSeen) return
        s.helloSeen = true
        clearTimeout(s.helloTimer)
        const first = !s.helloAt
        if (first) s.helloAt = ms()
        this.sendCtl(s, { t: 'ready', session: s.id, kind: s.kind, leg: s.farKind, resume: s.resume, packetMs: s.packetBlocks * 20, jitter: { minMs: this.cfg.jitterMinMs, maxMs: this.cfg.jitterMaxMs }, resumed: !first, state: s.state === 'pending' ? 'connecting' : s.state })
        if (first) this.start(s).catch(e => { this.warn('start failed', e && e.message); this.sendCtl(s, { t: 'error', code: e.code || 'PHONE_AUDIO_LEG_FAILED', message: String(e && e.message || e) }); this.end(s, 'leg-failed') })
        return
      }
      case 'ping': this.sendCtl(s, { t: 'pong', c: m.c, s: Date.now() }); return
      case 'rtt': if (Number.isFinite(m.ms)) { s.st.rttMs = Math.round(m.ms); s.st.rttMax = Math.max(s.st.rttMax, s.st.rttMs) } return
      case 'key': this.key(s, String(m.d || '').slice(0, 1)); return
      case 'mute': s.muted = !!m.on; return
      case 'level': if (Number.isFinite(m.up)) s.st.upLevel = Math.max(0, Math.min(1, m.up)); return
      case 'end': this.end(s, 'browser-hangup'); return
      case 'decline': if (s.kind === 'in' && !s.answered) this.decline(s.callSid); return
      default: return
    }
  }

  browserClosed(s, conn) {
    if (s.browser !== conn) return
    s.browser = null
    clearTimeout(s.helloTimer)
    if (s.state === 'ended') return
    if (s.kind === 'test' || !s.helloAt) { this.end(s, 'browser-closed'); return }
    // A short network drop: keep the far leg for a while, the tab reconnects with its resume secret.
    this.log('session', s.id, 'browser socket lost, holding the call ' + RESUME_GRACE_MS / 1000 + ' s')
    s.graceTimer = setTimeout(() => this.end(s, 'browser-lost'), RESUME_GRACE_MS)
    s.graceTimer.unref && s.graceTimer.unref()
  }

  /** Far-end audio (mu-law bytes, any length) towards the browser, batched to packetMs. */
  toBrowser(s, ulaw) {
    if (!ulaw.length) return
    s.st.far.in += 1
    if (s.st.firstDownMs === null && s.helloAt) s.st.firstDownMs = ms() - s.helloAt
    s.downBytes = s.downBytes.length ? Buffer.concat([s.downBytes, ulaw]) : Buffer.from(ulaw)
    const need = s.packetBlocks * BLOCK
    while (s.downBytes.length >= need) {
      const chunk = s.downBytes.subarray(0, need)
      s.downBytes = s.downBytes.subarray(need)
      s.st.downLevel = s.st.downLevel * 0.7 + ulawLevel(chunk) * 0.3
      if (!s.browser || s.browser.closed || !s.helloSeen) { s.downSeq = (s.downSeq + s.packetBlocks) & 0xffff; continue }
      if (s.browser.bufferedAmount > MAX_BROWSER_BUFFER) { s.st.down.dropped += s.packetBlocks; s.downSeq = (s.downSeq + s.packetBlocks) & 0xffff; continue }
      const frame = encodeAudio(s.downSeq, Date.now() & 0xffffffff, chunk)
      s.downSeq = (s.downSeq + s.packetBlocks) & 0xffff
      s.browser.send(frame)
      s.st.down.packets++
      s.st.down.bytes += frame.length
      s.st.down.blocks += s.packetBlocks
    }
  }

  // ---------------------------------------------------------------- pacing (browser -> far)

  tick() {
    if (!this.sessions.size) return
    const now = ms()
    for (const s of this.sessions.values()) {
      if (s.state === 'ended' || !s.t0) continue
      let due = Math.floor((now - s.t0) / 20) - s.ticks
      if (due > 10) { s.ticks += due - 1; due = 1 } // stalled event loop: do not burst
      for (; due > 0; due--) { s.ticks++; this.paceOne(s) }
    }
  }

  paceOne(s) {
    // Ringing an incoming call on its stream: the caller hears ringback.
    if (s.ringback && !s.answered) { this.farSend(s, s.ringback.block()); return }
    let block
    if (s.inject.length) { block = s.inject.shift(); s.jb.pull() }
    else {
      const r = s.jb.pull()
      block = r.block && !s.muted ? r.block : SILENCE
    }
    if (s.farKind === 'echo') { this.toBrowser(s, block); return }
    this.farSend(s, block)
  }

  startPacing(s) { if (!s.t0) { s.t0 = ms(); s.ticks = 0 } }

  farSend(s, block) {
    const f = s.far
    if (!f) return
    s.st.far.out++
    if (s.farKind === 'twilio') {
      if (f.conn && !f.conn.closed && f.streamSid) f.conn.send(JSON.stringify({ event: 'media', streamSid: f.streamSid, media: { payload: Buffer.from(block).toString('base64') } }))
    } else if (s.farKind === 'telegram') {
      if (f.sock && f.ready && !f.sock.destroyed && f.sock.writableLength < 64 * BLOCK) f.sock.write(block)
    } else if (s.farKind === 'asterisk') {
      if (f.as && !f.as.closed) {
        const pcm = new Int16Array(BLOCK)
        for (let i = 0; i < BLOCK; i++) pcm[i] = ulawDecode(block[i])
        f.as.sendAudio(Buffer.from(pcmToLeBytes(pcm)))
      }
    }
  }

  key(s, d) {
    if (!d || !/^[0-9*#A-Da-d]$/.test(d) || s.state !== 'open') return
    if (s.farKind === 'asterisk' && s.destChannel && this.d.asterisk) {
      this.d.asterisk.dtmf(s.destChannel, d).catch(() => { s.inject.push(...dtmfBlocks(d)) })
      return
    }
    // Twilio streams cannot carry RFC 4733 digits: play the tones in-band.
    s.inject.push(...dtmfBlocks(d))
  }

  setState(s, state, extra = {}) {
    if (s.state === 'ended') return
    s.state = state
    this.sendCtl(s, { t: 'state', state, ...extra })
  }

  // ---------------------------------------------------------------- far legs

  async start(s) {
    if (s.kind === 'test') {
      this.setState(s, 'open')
      this.startPacing(s)
      s.endTimer = setTimeout(() => this.end(s, 'test-finished'), this.cfg.testSeconds * 1000)
      s.endTimer.unref && s.endTimer.unref()
      return
    }
    if (s.farKind === 'telegram') return s.kind === 'out' ? this.startTelegramOut(s) : this.startTelegramIn(s)
    if (s.kind === 'out' && s.farKind === 'twilio') return this.startTwilioOut(s)
    if (s.kind === 'out' && s.farKind === 'asterisk') return this.startAsteriskOut(s)
    if (s.kind === 'in' && s.pickupVm) return this.startPickup(s)
    if (s.kind === 'in') return this.answer(s)
  }

  // ---------------------------------------------------------------- Telegram leg (telegramd over calls.sock)

  async startTelegramOut(s) {
    this.setState(s, 'dialing')
    const r = await this.d.tg.place(Number(s.to), s.origin || 'ui')
    s.tgCallId = r.callId
    s.callSid = 'tg-' + r.callId
    s.peerName = r.title || ''
    this.byCall.set(s.callSid, s.id)
    this.record(s, { sid: s.callSid, line: 'tg', peer: s.to, direction: 'out', status: 'initiated', disposition: 'dialing', mode: this.d.mode ? this.d.mode() : '', origin: s.origin || 'ui' })
    this.sendCallUpdate(s)
    if (s.state === 'ended') { this.d.tg.hangup(r.callId).catch(() => {}); return }
    if (r.state === 'ringing') this.setState(s, 'ringing')
    this.attachTelegramAudio(s, r.audioKey)
  }

  /** An incoming Telegram call rings the tabs (phone-hookd decided by mode). */
  ringTelegram({ callId, audioKey, chat, title, ringSeconds }) {
    if (this.active(['out', 'in']) >= this.cfg.maxCalls) return null
    const s = this.newSession('in', { farKind: 'telegram', callSid: 'tg-' + callId, tgCallId: callId, tgAudioKey: audioKey, line: TG_LINE, peer: String(chat), peerName: title || '' })
    s.state = 'ringing'
    this.byCall.set(s.callSid, s.id)
    // The tabs stop ringing after ringSeconds; the Telegram call itself keeps ringing (the phone app may answer).
    s.ringTimer = setTimeout(() => { if (!s.answered && s.state !== 'ended') { s.outcome = 'no-answer'; this.end(s, 'no-answer') } }, (ringSeconds || 25) * 1000)
    s.ringTimer.unref && s.ringTimer.unref()
    return s
  }

  async startTelegramIn(s) {
    this.setState(s, 'connecting')
    clearTimeout(s.ringTimer)
    await this.d.tg.answer(s.tgCallId)
    s.answered = true
    this.record(s, { sid: s.callSid, disposition: 'answered' })
    this.sendCallUpdate(s)
    this.attachTelegramAudio(s, s.tgAudioKey)
  }

  attachTelegramAudio(s, key) {
    if (s.far || s.state === 'ended') return
    const sock = this.d.tg.audioSocket()
    const f = s.far = { sock, ready: false }
    let hello = Buffer.alloc(0)
    sock.on('connect', () => sock.write(JSON.stringify({ callId: s.tgCallId, key }) + '\n'))
    sock.on('data', (chunk) => {
      if (!f.ready) {
        hello = Buffer.concat([hello, chunk])
        const i = hello.indexOf(10)
        if (i < 0) { if (hello.length > 256) sock.destroy(); return }
        const line = hello.subarray(0, i).toString('utf8')
        if (!/"ok":true/.test(line)) { this.warn('telegram audio refused for', s.tgCallId); sock.destroy(); return }
        f.ready = true
        chunk = hello.subarray(i + 1)
        if (!chunk.length) return
      }
      if (s.state === 'open') this.toBrowser(s, chunk)
    })
    sock.on('error', (e) => this.warn('telegram audio socket:', e.message))
    sock.on('close', () => { if (s.far === f) f.closed = true })
  }

  /** telegramd call.state for a session. */
  tgState(callId, state, extra = {}) {
    const s = this.sessions.get(this.byCall.get('tg-' + callId) || '')
    if (!s || s.state === 'ended') return
    if (state === 'active') {
      if (!s.answered) { s.answered = true; this.record(s, { sid: s.callSid, disposition: 'answered' }) }
      if (s.state !== 'open') { this.record(s, { sid: s.callSid, status: 'in-progress' }); this.sendCallUpdate(s) }
      this.setState(s, 'open', extra.emojis ? { emojis: extra.emojis } : {})
      this.startPacing(s)
      return
    }
    if (state === 'ringing' && s.kind === 'out' && s.state === 'dialing') this.setState(s, 'ringing')
    if (extra.emojis && s.emojis !== extra.emojis) { s.emojis = extra.emojis; this.sendCtl(s, { t: 'state', state: s.state, emojis: extra.emojis }) }
  }

  /** telegramd call.ended for a session. */
  tgEnded(callId, reason) {
    const s = this.sessions.get(this.byCall.get('tg-' + callId) || '')
    if (!s || s.state === 'ended') return
    s.tgEnded = true
    s.tgReason = reason
    if (s.kind === 'in' && !s.answered) s.outcome = reason === 'declined' ? 'declined' : 'missed'
    this.end(s, s.answered ? 'far-hangup' : (reason === 'busy' ? 'busy' : reason === 'missed' || reason === 'no answer' ? 'no-answer' : reason === 'declined' ? 'declined' : 'far-' + String(reason || 'hangup').replace(/\s+/g, '-')))
  }

  /** Sessions of the Telegram leg (tool status). */
  tgSessions() { return [...this.sessions.values()].filter(s => s.farKind === 'telegram' && s.state !== 'ended') }

  streamTwiml(s, k, before = []) {
    const st = this.mintStreamTicket(s)
    return twiml(...before, el('Connect', { action: this.d.hookUrl('/voice/stream-done', { k }), method: 'POST' }, [
      el('Stream', { url: this.d.streamUrl() }, [el('Parameter', { name: 'k', value: st })]),
    ]))
  }

  async startTwilioOut(s) {
    this.setState(s, 'dialing')
    const r = await this.d.twilio.createCall({
      To: s.to, From: s.line.number, Twiml: this.streamTwiml(s, 'out'), Timeout: 45,
      StatusCallback: this.d.hookUrl('/voice/status'), StatusCallbackMethod: 'POST',
      StatusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    })
    s.callSid = r.sid
    this.byCall.set(r.sid, s.id)
    this.record(s, { sid: r.sid, line: s.line.id, peer: s.to, direction: 'out', status: r.status || 'queued', disposition: 'dialing', mode: this.d.mode ? this.d.mode() : '', origin: 'ui' })
    if (s.state === 'ended') this.cancelTwilio(s)
  }

  async startAsteriskOut(s) {
    const acct = this.d.sipAccount(s.line)
    if (!acct) throw this.fail('PHONE_LINE_UNAVAILABLE', 'the SIP account of line ' + s.line.id + ' is not enabled')
    s.uuid = randomUUID()
    s.channelId = 'dshp-' + s.uuid
    s.callSid = 'as-' + s.uuid
    this.byUuid.set(s.uuid, s.id)
    this.byCall.set(s.channelId, s.id)
    this.byCall.set(s.callSid, s.id)
    this.setState(s, 'dialing')
    this.record(s, { sid: s.callSid, line: s.line.id, peer: s.to, direction: 'out', status: 'initiated', disposition: 'dialing', mode: this.d.mode ? this.d.mode() : '', origin: 'ui' })
    s.amiListener = (ev) => this.amiEvent(s, ev)
    this.d.asterisk.on('event', s.amiListener)
    await this.d.asterisk.originate({ uuid: s.uuid, channelId: s.channelId, account: acct, dest: s.to })
  }

  /** AudioSocket connection from Asterisk (claim by uuid). */
  claimAudioSocket(uuid) {
    const s = this.sessions.get(this.byUuid.get(uuid) || '')
    if (!s || s.far) return null
    if (s.state === 'ended') return (as) => as.hangup()
    return (as) => {
      s.far = { as }
      this.startPacing(s)
      as.on('audio', (bytes) => {
        const pcm = leBytesToPcm(bytes)
        const u = new Uint8Array(pcm.length)
        for (let i = 0; i < pcm.length; i++) u[i] = ulawEncode(pcm[i])
        this.toBrowser(s, u)
      })
      as.on('dtmf', () => {})
      as.on('close', (why) => { if (s.state !== 'ended') this.end(s, why === 'hangup' ? (s.answered ? 'far-hangup' : (s.dialStatus || 'far-hangup')) : 'far-' + why) })
    }
  }

  amiEvent(s, ev) {
    const linked = ev.Linkedid || ''
    if (linked !== s.channelId && ev.Uniqueid !== s.channelId) return
    if (ev.Uniqueid === s.channelId && ev.Channel && !s.chanName) s.chanName = ev.Channel
    switch (ev.Event) {
      case 'DialBegin': if (ev.DestChannel) s.destChannel = ev.DestChannel; break
      case 'DialState':
        if (/RINGING/i.test(ev.DialStatus || '')) this.setState(s, 'ringing')
        else if (/PROGRESS/i.test(ev.DialStatus || '')) this.setState(s, 'early')
        break
      case 'DialEnd':
        s.dialStatus = String(ev.DialStatus || '').toLowerCase()
        if (s.dialStatus === 'answer') { s.answered = true; this.setState(s, 'open'); this.record(s, { sid: s.callSid, status: 'in-progress', disposition: 'answered' }); this.sendCallUpdate(s) }
        break
      case 'Hangup':
        if (ev.Uniqueid === s.channelId) { s.hangupCause = ev.Cause; this.end(s, s.answered ? 'far-hangup' : (s.dialStatus || 'cause-' + (ev.Cause || '?'))) }
        else if (!s.answered && ev.Channel && ev.Channel === s.destChannel) s.hangupCause = ev.Cause
        break
      default: break
    }
    // Early media (183) also lets audio through before the answer.
    if (ev.Event === 'Newstate' && ev.Uniqueid !== s.channelId && /Ringing/i.test(ev.ChannelStateDesc || '') && s.state === 'dialing') this.setState(s, 'ringing')
  }

  /** Incoming call on the server route: TwiML for the ring stream, or null when no slot is free. */
  ringSession({ callSid, from, line, ringSeconds }) {
    if (this.active(['out', 'in']) >= this.cfg.maxCalls) return null
    const s = this.newSession('in', { farKind: 'twilio', callSid, line, peer: from, ringSeconds })
    s.state = 'ringing'
    s.ringback = new ToneGen(ringbackFor(line, this.cfg.ringbackTone))
    this.byCall.set(callSid, s.id)
    s.ringDeadline = Date.now() + (ringSeconds + 15) * 1000 // stream must start in time
    return { session: s.id, twiml: this.streamTwiml(s, 'ring') }
  }

  async answer(s) {
    if (s.answered) return
    s.answered = true
    s.ringback = null
    clearTimeout(s.ringTimer)
    this.setState(s, 'open')
    this.record(s, { sid: s.callSid, disposition: 'answered' })
    this.sendCallUpdate(s)
  }

  decline(callSid) {
    const s = this.sessions.get(this.byCall.get(String(callSid || '')) || '')
    if (!s || s.kind !== 'in' || s.answered || s.state === 'ended') return false
    s.outcome = 'declined'
    this.end(s, 'declined')
    return true
  }

  async startPickup(s) {
    this.setState(s, 'connecting')
    const before = this.d.settings().voicemail.liveTranscript ? [el('Stop', {}, [el('Transcription', { name: 'vm' + s.pickupVm })])] : []
    await this.d.twilio.updateCall(s.callSid, { Twiml: this.streamTwiml(s, 'pickup', before) })
    if (this.d.onPickup) this.d.onPickup(s.pickupVm, s.callSid)
  }

  /** Twilio Media Stream socket (signature already checked before the upgrade). */
  attachTwilio(conn, { signed = false } = {}) {
    let s = null
    const timer = setTimeout(() => { if (!s) conn.close(1008, 'no start') }, STREAM_START_TIMEOUT_MS)
    timer.unref && timer.unref()
    conn.on('message', (data, binary) => {
      if (binary) return
      let m
      try { m = JSON.parse(data) } catch { return }
      if (!s) {
        if (m.event === 'connected') return
        if (m.event !== 'start' || !m.start) { conn.close(1008, 'expected start'); return }
        const k = String((m.start.customParameters || {}).k || '')
        const t = this.streams.get(k)
        this.streams.delete(k)
        const cand = t && t.exp > Date.now() ? this.sessions.get(t.sessionId) : null
        if (!cand || cand.state === 'ended' || (cand.callSid && cand.callSid !== m.start.callSid) || cand.far) {
          this.warn('stream refused: unknown, expired or reused ticket')
          clearTimeout(timer); conn.close(1008, 'refused'); return
        }
        clearTimeout(timer)
        s = cand
        if (!s.callSid) { s.callSid = m.start.callSid; this.byCall.set(s.callSid, s.id) }
        s.far = { conn, streamSid: m.start.streamSid, signed }
        this.startPacing(s)
        if (s.kind === 'out') { s.answered = true; this.setState(s, 'open'); this.record(s, { sid: s.callSid, disposition: 'answered' }); this.sendCallUpdate(s) }
        else if (s.pickupVm) { this.setState(s, 'open') }
        else if (!s.answered) {
          // Ringing: give the browsers ringSeconds to answer, then voicemail.
          s.ringTimer = setTimeout(() => { if (!s.answered && s.state !== 'ended') { s.outcome = 'no-answer'; this.end(s, 'no-answer') } }, (s.ringSeconds || 25) * 1000)
          s.ringTimer.unref && s.ringTimer.unref()
          if (this.d.broadcast) this.d.broadcast('audio.ring', { callSid: s.callSid, session: s.id })
        }
        return
      }
      if (m.event === 'media' && m.media && m.media.payload) {
        if (!s.answered) return // ringing: nothing to hear yet
        this.toBrowser(s, Buffer.from(m.media.payload, 'base64'))
      } else if (m.event === 'stop') {
        if (s.state !== 'ended') { if (!s.answered && s.kind === 'in') s.outcome = 'missed'; this.end(s, 'far-hangup') }
      }
    })
    conn.on('close', () => {
      clearTimeout(timer)
      if (s && s.state !== 'ended' && s.far && s.far.conn === conn) { if (!s.answered && s.kind === 'in') s.outcome = 'missed'; this.end(s, 'far-hangup') }
    })
  }

  /** Twilio status callback for a call we own. */
  onStatus(callSid, status) {
    const s = this.sessions.get(this.byCall.get(callSid) || '')
    if (!s || s.state === 'ended') return
    if (status === 'ringing' && s.kind === 'out' && !s.answered) this.setState(s, 'ringing')
    if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(status)) {
      if (s.kind === 'in' && !s.answered) s.outcome = 'missed'
      this.end(s, s.answered ? 'far-hangup' : status)
    }
  }

  /** <Connect action> after a stream ended: what Twilio should do next. */
  streamDone(callSid) {
    const s = this.sessions.get(this.byCall.get(String(callSid || '')) || '')
    if (!s) return 'hangup'
    if (s.kind === 'in' && !s.answered && (s.outcome === 'no-answer' || s.outcome === 'declined')) return 'voicemail'
    return 'hangup'
  }

  // ---------------------------------------------------------------- end + stats

  cancelTwilio(s) {
    if (!s.callSid || s.farKind !== 'twilio' || !this.d.twilio) return
    this.d.twilio.updateCall(s.callSid, { Status: s.answered ? 'completed' : 'canceled' }).catch(() => {
      this.d.twilio.updateCall(s.callSid, { Status: 'completed' }).catch(() => {})
    })
  }

  end(s, reason) {
    if (s.state === 'ended') return
    const was = s.state
    s.state = 'ended'
    s.endReason = reason
    s.endedAt = Date.now()
    for (const t of ['ringTimer', 'graceTimer', 'helloTimer', 'endTimer']) clearTimeout(s[t])
    // far leg
    if (s.farKind === 'twilio') {
      if (s.far && s.far.conn && !s.far.conn.closed) s.far.conn.close(1000, 'end') // Twilio continues with <Connect action>
      else if (s.kind === 'out' && s.callSid && !/^(completed|busy|no-answer|failed|canceled)$/.test(reason)) this.cancelTwilio(s)
      else if (s.kind === 'in' && s.pickupVm && !s.far) {} // pickup redirect never connected: Twilio keeps the old TwiML
    } else if (s.farKind === 'telegram') {
      if (s.far && s.far.sock) { try { s.far.sock.destroy() } catch {} }
      if (!s.tgEnded && s.tgCallId && this.d.tg) {
        // Ringing in and nobody answered here: leave the Telegram call alone (the phone app may still answer).
        if (s.kind === 'in' && !s.answered && s.outcome !== 'declined') {}
        else this.d.tg.hangup(s.tgCallId, s.kind === 'in' && !s.answered).catch(() => {})
      }
    } else if (s.farKind === 'asterisk') {
      if (s.far && s.far.as && !s.far.as.closed) s.far.as.hangup()
      else if (s.chanName && this.d.asterisk) this.d.asterisk.hangup(s.chanName).catch(() => {})
      else if (this.d.asterisk && was !== 'pending') s.hangupWanted = true // the AudioSocket connection is refused/closed on arrival
      if (s.amiListener) { this.d.asterisk.off('event', s.amiListener); s.amiListener = null }
      if (this.d.asterisk && this.d.asterisk.release) this.d.asterisk.release()
    }
    const stats = this.stats(s)
    if (s.browser && !s.browser.closed) {
      this.sendCtl(s, { t: 'end', reason, stats })
      const b = s.browser
      setTimeout(() => { try { b.close(1000, 'end') } catch {} }, 50).unref()
    }
    if (s.callSid && s.kind !== 'test') {
      const patch = { sid: s.callSid, audio: stats }
      if (s.farKind === 'asterisk' || s.farKind === 'telegram') {
        patch.status = 'completed'
        patch.ended = Math.floor(Date.now() / 1000)
        patch.duration = s.answeredAt ? Math.round((Date.now() - s.answeredAt) / 1000) : 0
        if (!s.answered) patch.disposition = s.farKind === 'telegram'
          ? (s.kind === 'in' ? (s.outcome === 'declined' ? 'declined' : 'missed') : ({ busy: 'busy', 'no-answer': 'no-answer', 'browser-hangup': 'canceled' })[reason] || 'failed')
          : ({ busy: 'busy', noanswer: 'no-answer', cancel: 'canceled', chanunavail: 'failed', congestion: 'failed' })[s.dialStatus] || (reason === 'browser-hangup' ? 'canceled' : 'failed')
      }
      if (s.kind === 'in' && !s.answered && s.outcome === 'declined') patch.disposition = 'declined'
      this.record(s, patch)
      this.sendCallUpdate(s, true)
    }
    this.history.push({ session: s.id, kind: s.kind, leg: s.farKind, line: s.line ? s.line.id : '', reason, at: new Date(s.endedAt).toISOString(), stats })
    if (this.history.length > HISTORY) this.history.shift()
    this.log('session', s.id, s.kind, s.farKind, 'ended:', reason, JSON.stringify({ up: stats.up, down: stats.down, firstAudioMs: stats.firstAudioMs, jitterMs: stats.jitter.jitterMs, underruns: stats.jitter.underruns }))
    // Keep the ended session a little so a late <Connect action> still finds its outcome.
    const keep = setTimeout(() => this.forget(s), 120000)
    keep.unref && keep.unref()
  }

  forget(s) {
    this.sessions.delete(s.id)
    for (const [k, v] of this.byCall) if (v === s.id) this.byCall.delete(k)
    for (const [k, v] of this.byUuid) if (v === s.id) this.byUuid.delete(k)
  }

  stats(s) {
    const j = s.jb.stats()
    return {
      route: 'server', leg: s.farKind, kind: s.kind,
      up: { packets: s.st.up.packets, bytes: s.st.up.bytes, blocks: s.st.up.blocks, invalid: s.st.up.invalid, early: s.st.up.early || 0 },
      down: { packets: s.st.down.packets, bytes: s.st.down.bytes, blocks: s.st.down.blocks, dropped: s.st.down.dropped },
      far: { in: s.st.far.in, out: s.st.far.out },
      jitter: { jitterMs: j.jitterMs, targetMs: j.targetMs, peakMs: j.peakMs, underruns: j.underruns, late: j.late, dropped: j.dropped, plc: j.plc },
      firstAudioMs: { up: s.st.firstUpMs, down: s.st.firstDownMs },
      rttMs: s.st.rttMs, rttMaxMs: s.st.rttMax || null,
      resumes: s.st.resumes,
      seconds: s.helloAt ? Math.round((ms() - s.helloAt) / 100) / 10 : 0,
      signed: !!(s.far && s.far.signed),
      end: s.endReason || null,
    }
  }

  record(s, patch) {
    if (patch.disposition === 'answered' && !s.answeredAt) s.answeredAt = Date.now()
    if (this.d.store) { try { this.d.store.upsertCall({ ...patch, audio: patch.audio || (patch.direction ? { route: 'server', leg: s.farKind } : undefined) }) } catch (e) { this.warn('call log', e.message) } }
  }

  sendCallUpdate(s, ended = false) {
    if (!this.d.store || !this.d.broadcast || !s.callSid) return
    const call = this.d.store.callBySid(s.callSid)
    if (call) this.d.broadcast(ended && (s.farKind === 'asterisk' || s.farKind === 'telegram') ? 'call.ended' : 'call.update', { call: s.peerName && !call.name ? { ...call, name: s.peerName } : call })
  }

  /** Live stats to the browser once a second; expire stale tickets and sessions. */
  sweep(ticketsOnly = false) {
    const now = Date.now()
    for (const [k, t] of this.tickets) if (t.exp < now) this.tickets.delete(k)
    for (const [k, t] of this.streams) if (t.exp < now) this.streams.delete(k)
    if (ticketsOnly) return
    for (const s of this.sessions.values()) {
      if (s.state === 'ended') continue
      if (!s.browserSeen && now - s.createdAt > TICKET_TTL_MS + 5000 && s.kind !== 'in') { this.end(s, 'never-connected'); continue }
      if (s.kind === 'in' && !s.answered && !s.far && s.ringDeadline && now > s.ringDeadline) { this.end(s, 'stream-never-started'); continue }
      if (s.browser && s.helloSeen) this.sendCtl(s, { t: 'stats', stats: this.stats(s), levels: { up: s.st.upLevel, down: s.st.downLevel } })
    }
  }

  shutdown() {
    for (const s of this.sessions.values()) this.end(s, 'shutdown')
    clearInterval(this.timer)
    clearInterval(this.sweeper)
  }
}
