/**
 * dsh-phone server audio route tests: node test/audio.mjs
 * G.711, link framing, jitter buffer, the WebSocket server, the audio hub with
 * fake peers (browser, Twilio Media Streams, Asterisk AudioSocket + AMI), the
 * upgrade gate, the route default, and phone-hookd itself on a temp data dir
 * (signed stream upgrade, ticketed browser upgrade, echo test). Loopback only.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { ulawEncode, ulawDecode, ulawToPcm, pcmToUlaw, ulawLevel, ULAW_SILENCE } from '../shared/g711.mjs'
import { encodeAudio, encodeControl, decodeFrame } from '../shared/frame.mjs'
import { JitterBuffer } from '../shared/jitter.mjs'
import { acceptWebSocket, acceptKey } from '../daemon/ws.mjs'
import { AudioHub, ToneGen, TONES, dtmfBlocks, ringbackFor } from '../daemon/audio.mjs'
import { audioSocketServer, asMessage, uuidToBytes, AsParser, AS_AUDIO, AS_UUID, AS_HANGUP } from '../daemon/audiosocket.mjs'
import { resolveSettings, preserveUnknownKeys } from '../daemon/config.mjs'
import { checkAudioUpgrade, harnessCookieName } from '../lib/security.js'
import { expectedSignature } from '../daemon/twilio.mjs'
import { wsConnect } from './wsclient.mjs'
import { violations } from './lossless-check.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
let passed = 0
const t = async (name, fn) => { try { await fn(); passed++; console.log('ok  ', name) } catch (e) { console.error('FAIL', name, '\n', e); process.exitCode = 1 } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const tone = (n, f = 440, amp = 8000, off = 0) => { const p = new Int16Array(n); for (let i = 0; i < n; i++) p[i] = Math.round(amp * Math.sin(2 * Math.PI * f * (i + off) / 8000)); return p }

// ---------------------------------------------------------------- codec + framing

await t('G.711 mu-law: silence, sign, round trip within the quantisation step', () => {
  assert.equal(ulawEncode(0), 0xff)
  assert.equal(ulawDecode(0xff), 0)
  assert.equal(ULAW_SILENCE, 0xff)
  for (const v of [1, -1, 100, -100, 1000, -1000, 8000, -8000, 32000, -32000, 32767, -32768]) {
    const back = ulawDecode(ulawEncode(v))
    assert.ok(Math.abs(back - v) <= Math.max(16, Math.abs(v) * 0.07), v + ' -> ' + back)
    if (Math.abs(v) >= 100) assert.equal(Math.sign(back), Math.sign(v))
  }
  const p = tone(160)
  const q = ulawToPcm(pcmToUlaw(p))
  let err = 0, sig = 0
  for (let i = 0; i < 160; i++) { err += (p[i] - q[i]) ** 2; sig += p[i] ** 2 }
  assert.ok(10 * Math.log10(sig / err) > 30, 'SNR above 30 dB')
  assert.ok(ulawLevel(pcmToUlaw(p)) > 0.1 && ulawLevel(new Uint8Array(160).fill(0xff)) === 0)
})

await t('link framing: audio and control frames round trip; malformed frames are refused', () => {
  const payload = new Uint8Array(320).map((_, i) => i & 0xff)
  const f = encodeAudio(65535, 0xfffffffe, payload)
  assert.equal(f.length, 328)
  const d = decodeFrame(f)
  assert.equal(d.kind, 'audio'); assert.equal(d.seq, 65535); assert.equal(d.clock, 0xfffffffe); assert.equal(d.blocks, 2)
  assert.deepEqual([...d.payload], [...payload])
  const c = decodeFrame(encodeControl({ t: 'hello', v: 1 }))
  assert.equal(c.kind, 'control'); assert.equal(c.msg.t, 'hello')
  assert.equal(decodeFrame(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 1, 2])).kind, 'invalid') // short
  assert.equal(decodeFrame(encodeAudio(1, 1, new Uint8Array(170))).kind, 'invalid') // not 20 ms multiple
  assert.equal(decodeFrame(new Uint8Array([9, 1, 2])).kind, 'invalid')
  assert.equal(decodeFrame(new Uint8Array([2, 0x7b, 0x7d])).kind, 'invalid') // {} without t
  assert.equal(decodeFrame(new Uint8Array(8 + 160 * 11).fill(1)).kind, 'invalid') // too large
})

// ---------------------------------------------------------------- jitter buffer

await t('jitter buffer: steady stream plays every block in order, no underrun after start', () => {
  const jb = new JitterBuffer({ minMs: 40, maxMs: 400 })
  const got = []
  let now = 0
  for (let i = 0; i < 200; i++) {
    jb.push(i, new Uint8Array([i & 0xff]), now)
    const r = jb.pull(now)
    if (r.block) got.push(r.block[0])
    now += 20
  }
  const s0 = jb.stats()
  for (let i = 0; i < 5; i++) { const r = jb.pull(); if (r.block) got.push(r.block[0]) }
  assert.ok(got.length >= 195, 'played ' + got.length)
  for (let i = 1; i < got.length; i++) assert.equal(got[i], (got[i - 1] + 1) & 0xff)
  assert.equal(s0.underruns, 0); assert.equal(s0.late, 0); assert.equal(s0.targetMs, 40)
})

await t('jitter buffer: a 200 ms stall raises the target, nothing is lost, latency trims back down', () => {
  const jb = new JitterBuffer({ minMs: 40, maxMs: 400 })
  let now = 0, seq = 0, played = 0
  const out = []
  // 100 blocks steady, then a stall: 10 blocks arrive at once, then steady again
  for (let tick = 0; tick < 600; tick++) {
    if (tick < 100 || tick >= 110) {
      if (tick === 110) { for (let k = 0; k < 10; k++) jb.push(seq & 0xffff, new Uint8Array([seq & 0xff]), now), seq++ }
      jb.push(seq & 0xffff, new Uint8Array([seq & 0xff]), now); seq++
    }
    const r = jb.pull(now)
    if (r.block) { played++; out.push(r.block[0]) }
    now += 20
  }
  const s = jb.stats()
  assert.ok(s.peakMs >= 150, 'peak follows the stall: ' + s.peakMs)
  assert.ok(s.underruns >= 1)
  assert.equal(s.late, 0)
  assert.ok(played + s.dropped + jb.depth() >= seq - 2, 'every block played, trimmed or queued')
  for (let i = 1; i < out.length; i++) { const d = (out[i] - out[i - 1] + 256) & 0xff; assert.ok(d === 1 || d === 2, 'order kept (a trim skips one)') }
})

await t('jitter buffer: uint16 wrap, duplicates and late blocks', () => {
  const jb = new JitterBuffer({ minMs: 20, maxMs: 200 })
  let now = 0
  const seqs = [65533, 65534, 65535, 0, 1, 2, 3]
  const got = []
  for (const s of seqs) { jb.push(s, new Uint8Array([s & 0xff]), now); const r = jb.pull(now); if (r.block) got.push(r.block[0]); now += 20 }
  jb.push(3, new Uint8Array([3]), now) // duplicate or late
  jb.push(65534, new Uint8Array([1]), now) // late, before the playout point
  for (let i = 0; i < 3; i++) { const r = jb.pull(); if (r.block) got.push(r.block[0]) }
  assert.deepEqual(got, [65533 & 0xff, 65534 & 0xff, 65535 & 0xff, 0, 1, 2, 3])
  const s = jb.stats()
  assert.ok(s.late + s.dup >= 2)
})

await t('jitter buffer: inlinable into an AudioWorklet (no outer references)', () => {
  const src = 'const JB = (' + JitterBuffer.toString() + ');\nreturn new JB({ minMs: 40 }).stats().targetMs'
  assert.equal(new Function(src)(), 40)
  const g = new Function('const e = (' + ulawEncode.toString() + '); const d = (' + ulawDecode.toString() + '); return d(e(1000))')()
  assert.ok(Math.abs(g - 1000) < 64)
})

await t('browser engine: the worklet source parses, wss only off loopback', async () => {
  const { workletSource, socketUrl } = await import('../src/server-audio.js')
  const src = workletSource()
  assert.doesNotThrow(() => new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', 'currentTime', src))
  // run it against a fake worklet scope: capture 48 kHz -> 8 kHz packets, play far audio
  let Proc = null
  class AWP { constructor() { this.port = { postMessage: (m) => posted.push(m), onmessage: null } } }
  const posted = []
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', 'currentTime', src)(AWP, (n, c) => { Proc = c }, 48000, 0)
  const p = new Proc({ processorOptions: { packetMs: 40 } })
  const sine = new Float32Array(128).map((_, i) => 0.3 * Math.sin(2 * Math.PI * 440 * i / 48000))
  p.port.onmessage({ data: { t: 'down', seq: 0, payload: pcmToUlaw(tone(320, 500, 8000)).buffer } })
  const outs = []
  for (let k = 0; k < 375 * 2; k++) { const o = [[new Float32Array(128)]]; p.process([[sine]], o); outs.push(o[0][0]) }
  const ups = posted.filter(m => m.t === 'up')
  assert.ok(ups.length >= 48 && ups.length <= 51, '2 s of 48 kHz input gives about 50 packets of 40 ms: ' + ups.length)
  assert.equal(new Uint8Array(ups[0].payload).length, 320)
  assert.ok(posted.some(m => m.t === 'lvl' && m.up > 0.05))
  assert.ok(outs.some(o => o.some(v => Math.abs(v) > 0.05)), 'far audio reaches the speakers')
  assert.equal(socketUrl({ protocol: 'https:', host: 'llm.example.test', hostname: 'llm.example.test' }, '/x'), 'wss://llm.example.test/x')
  assert.equal(socketUrl({ protocol: 'http:', host: '127.0.0.1:3080', hostname: '127.0.0.1' }, '/x'), 'ws://127.0.0.1:3080/x')
  assert.throws(() => socketUrl({ protocol: 'http:', host: 'llm.example.test', hostname: 'llm.example.test' }, '/x'), /wss only/)
})

await t('tones: ringback by line, DTMF blocks, cadence has silence', () => {
  assert.equal(ringbackFor({ number: '+15550001234' }), TONES.us)
  assert.equal(ringbackFor({ number: '+302100000001' }), TONES.eu)
  assert.equal(ringbackFor({ number: '+302100000001' }, 'uk'), TONES.uk)
  const g = new ToneGen(TONES.eu)
  const blocks = Array.from({ length: 250 }, () => g.block())
  assert.ok(ulawLevel(blocks[10]) > 0.05 && ulawLevel(blocks[100]) === 0)
  assert.equal(dtmfBlocks('5').length, 8)
  assert.equal(dtmfBlocks('x').length, 0)
})

// ---------------------------------------------------------------- settings default + gate

await t('route default: Via server, clamps, kept across an old plugin push', () => {
  const s = resolveSettings({})
  assert.equal(s.audio.route, 'server')
  assert.equal(s.audio.maxCalls, 2)
  assert.equal(s.audio.packetMs, 40)
  assert.equal(resolveSettings({ audio: { route: 'direct' } }).audio.route, 'direct')
  assert.equal(resolveSettings({ audio: { route: 'bogus', packetMs: 33, maxCalls: 99 } }).audio.route, 'server')
  assert.equal(resolveSettings({ audio: { packetMs: 33, maxCalls: 99 } }).audio.packetMs, 40)
  assert.equal(resolveSettings({ audio: { maxCalls: 99 } }).audio.maxCalls, 8)
  const kept = preserveUnknownKeys({ lines: [] }, { audio: { route: 'direct' } })
  assert.equal(kept.audio.route, 'direct')
})

const HOST = 'llm.example.test'
const cookie = harnessCookieName(HOST) + '=x'
const gateReq = (h = {}, { peer = '127.0.0.1', method = 'GET' } = {}) => ({
  method, socket: { remoteAddress: peer },
  headers: { host: HOST, upgrade: 'websocket', origin: 'https://' + HOST, 'x-forwarded-proto': 'https', cookie, 'sec-websocket-protocol': 'dshp.v1, k.' + 'a'.repeat(32), ...h },
})
await t('audio socket gate: wss only, same origin, loopback peer, cookie, ticket present', () => {
  const g = (h, o) => checkAudioUpgrade(gateReq(h, o), { trustedHosts: [HOST] })
  assert.equal(g().ok, true)
  assert.equal(g({ 'x-forwarded-proto': 'http' }).code, 'PHONE_AUDIO_INSECURE')
  assert.equal(g({ 'x-forwarded-proto': undefined }).code, 'PHONE_AUDIO_INSECURE')
  assert.equal(g({ origin: 'http://' + HOST }).code, 'PHONE_AUDIO_INSECURE') // an http page cannot open the audio socket
  assert.equal(g({ origin: 'https://evil.test' }).code, 'PHONE_HOST_UNTRUSTED')
  assert.equal(g({ origin: undefined }).code, 'PHONE_HOST_UNTRUSTED')
  assert.equal(g({ host: 'evil.test', origin: 'https://evil.test' }).code, 'PHONE_HOST_UNTRUSTED')
  assert.equal(g({}, { peer: '10.0.0.5' }).code, 'PHONE_PEER_NOT_LOOPBACK')
  assert.equal(g({ cookie: 'other=1' }).code, 'PHONE_SESSION_COOKIE_MISSING')
  assert.equal(g({ 'sec-websocket-protocol': 'dshp.v1' }).code, 'PHONE_TOKEN_INVALID')
  assert.equal(g({ 'sec-fetch-site': 'cross-site' }).code, 'PHONE_HOST_UNTRUSTED')
  assert.equal(g({}, { method: 'POST' }).code, 'PHONE_METHOD_NOT_ALLOWED')
  // a loopback host (local test) may use plain ws
  const local = checkAudioUpgrade(gateReq({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-forwarded-proto': undefined, cookie: harnessCookieName('127.0.0.1:3080') + '=x' }), { trustedHosts: [] })
  assert.equal(local.ok, true)
})

// ---------------------------------------------------------------- the hub with fake peers

const LINES = [{ id: 'ca', provider: 'twilio', number: '+15550001234', voice: true, enabled: true }, { id: 'gr', provider: 'sip', number: '+302100000001', voice: true, enabled: true }]
function makeHub(over = {}) {
  const settings = resolveSettings({ publicBaseUrl: 'https://hooks.example.test/phone-hook', lines: LINES, audio: { packetMs: 20, testSeconds: 5, maxCalls: 2 }, ...(over.settings || {}) })
  const calls = new Map()
  const events = []
  const twilioLog = []
  const asterisk = new EventEmitter()
  asterisk.originated = []
  asterisk.originate = async (o) => { asterisk.originated.push(o); if (over.onOriginate) await over.onOriginate(o) }
  asterisk.hangup = async (c) => { asterisk.hungup = c }
  asterisk.dtmf = async (c, d) => { asterisk.digits = (asterisk.digits || '') + d }
  asterisk.release = () => {}
  const store = {
    upsertCall(c) { const prev = calls.get(c.sid) || {}; const next = { ...prev }; for (const [k, v] of Object.entries(c)) if (v !== undefined) next[k] = v; calls.set(c.sid, next); return next },
    callBySid(sid) { return calls.get(sid) || null },
  }
  const hub = new AudioHub({
    settings: () => settings, log: () => {}, warn: () => {}, store, broadcast: (type, data) => events.push({ type, data }),
    fail: (code, message, status) => Object.assign(new Error(message), { code, status }),
    hookUrl: (p, q) => 'https://hooks.example.test/phone-hook' + p + (q ? '?' + new URLSearchParams(q) : ''),
    streamUrl: () => 'wss://hooks.example.test/phone-hook/s', mode: () => 'dnd',
    twilio: { createCall: async (f) => { twilioLog.push({ op: 'create', f }); return { sid: 'CAout1', status: 'queued' } }, updateCall: async (sid, f) => { twilioLog.push({ op: 'update', sid, f }); return {} } },
    asterisk,
    sipAccount: (line) => line && line.provider === 'sip' ? { id: 'acme', line: 'gr' } : null,
    allowed: (acct, to) => to.startsWith('+30') ? { ok: true } : { ok: false, reason: 'not in allowPrefixes' },
    onPickup: () => {},
  })
  const server = http.createServer()
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/io') {
      const k = String(req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim()).find(s => s.startsWith('k.')) || ''
      if (!hub.ticketValid(k.slice(2))) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
      const c = acceptWebSocket(req, socket, head, { protocol: 'dshp.v1' })
      hub.attachBrowser(k.slice(2), c)
    } else if (req.url === '/s') {
      hub.attachTwilio(acceptWebSocket(req, socket, head), { signed: true })
    } else socket.destroy()
  })
  const opts = { lineById: (id) => LINES.find(l => l.id === id), defaultLine: () => LINES[0], toE164: (n) => String(n).startsWith('+') ? n : '+30' + n, defaultCountry: '+30', voicemailById: (id) => (over.vms || {})[id] }
  return { hub, server, calls, events, twilioLog, asterisk, settings, opts }
}
async function listen(server) { await new Promise(r => server.listen(0, '127.0.0.1', r)); return server.address().port }
async function browser(port, ticket) {
  const r = await wsConnect({ port, path: '/io', protocols: ['dshp.v1', 'k.' + ticket] })
  assert.equal(r.status, 101)
  assert.match(r.head, /sec-websocket-protocol: dshp\.v1/i)
  const ws = r.ws
  ws.frames = () => ws.messages.map(m => decodeFrame(m))
  ws.ctl = (pred) => ws.waitFor(m => { const f = decodeFrame(m); return f.kind === 'control' && pred(f.msg) }).then(m => decodeFrame(m).msg)
  ws.audio = () => ws.frames().filter(f => f.kind === 'audio')
  ws.sendCtl = (o) => ws.send(encodeControl(o))
  return ws
}
function pump(ws, seconds, f = 440) {
  return new Promise(resolve => {
    let seq = 0
    const t0 = Date.now()
    const iv = setInterval(() => {
      ws.send(encodeAudio(seq, Date.now(), pcmToUlaw(tone(160, f, 8000, seq * 160))))
      seq++
      if (Date.now() - t0 > seconds * 1000) { clearInterval(iv); resolve(seq) }
    }, 20)
  })
}

await t('hub echo test: ticket is one-time, server silent until hello, audio comes back, stats count both ways', async () => {
  const { hub, server, opts } = makeHub()
  const port = await listen(server)
  const tk = hub.issueTicket({ purpose: 'test' }, opts)
  const ws = await browser(port, tk.ticket)
  await sleep(150)
  assert.equal(ws.messages.length, 0, 'nothing before hello (proxy trap)')
  // the same ticket cannot open a second socket
  const again = await wsConnect({ port, path: '/io', protocols: ['dshp.v1', 'k.' + tk.ticket] })
  assert.equal(again.status, 403)
  ws.sendCtl({ t: 'hello', v: 1, codec: 'pcmu' })
  const ready = await ws.ctl(m => m.t === 'ready')
  assert.equal(ready.kind, 'test'); assert.equal(ready.leg, 'echo'); assert.ok(ready.resume)
  const sent = await pump(ws, 0.8)
  await sleep(300)
  const audio = ws.audio()
  assert.ok(audio.length >= sent * 0.6, 'echoed ' + audio.length + ' of ' + sent)
  assert.ok(audio.some(a => ulawLevel(a.payload) > 0.1), 'the echo carries the tone')
  ws.sendCtl({ t: 'ping', c: 123 })
  const pong = await ws.ctl(m => m.t === 'pong')
  assert.equal(pong.c, 123)
  ws.sendCtl({ t: 'end' })
  const end = await ws.ctl(m => m.t === 'end')
  assert.equal(end.reason, 'browser-hangup')
  assert.ok(end.stats.up.packets >= sent * 0.9 && end.stats.down.packets > 0)
  assert.ok(end.stats.firstAudioMs.up !== null && end.stats.firstAudioMs.down !== null)
  assert.equal(hub.info().recent.length, 1)
  assert.deepEqual(violations(hub.info()), [], 'info and per-call stats are lossless JSON')
  hub.shutdown(); server.close()
})

await t('hub limits: max tests, max calls, destination policy, unknown purpose', async () => {
  const { hub, opts } = makeHub({ settings: { audio: { maxTests: 1, maxCalls: 1 } } })
  assert.throws(() => hub.issueTicket({ purpose: 'nope' }, opts), e => e.code === 'PHONE_BODY_INVALID')
  hub.issueTicket({ purpose: 'test' }, opts)
  assert.throws(() => hub.issueTicket({ purpose: 'test' }, opts), e => e.code === 'PHONE_AUDIO_BUSY')
  assert.throws(() => hub.issueTicket({ purpose: 'dial', line: 'gr', to: '+15550001234' }, opts), e => e.code === 'PHONE_OUTBOUND_DESTINATION_BLOCKED')
  const ok = hub.issueTicket({ purpose: 'dial', line: 'gr', to: '+302100000000' }, opts)
  assert.equal(ok.kind, 'out')
  assert.throws(() => hub.issueTicket({ purpose: 'dial', line: 'ca', to: '+15550001234' }, opts), e => e.code === 'PHONE_AUDIO_BUSY')
  assert.throws(() => hub.issueTicket({ purpose: 'answer', callSid: 'CAx' }, opts), e => e.code === 'PHONE_AUDIO_SESSION_GONE')
  hub.shutdown()
})

async function twilioPeer(port, k, callSid) {
  const r = await wsConnect({ port, path: '/s' })
  const tw = r.ws
  tw.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }))
  tw.send(JSON.stringify({ event: 'start', sequenceNumber: '1', start: { streamSid: 'MZ1', callSid, customParameters: { k }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } }))
  tw.media = () => tw.messages.map(m => JSON.parse(m)).filter(m => m.event === 'media')
  tw.speak = (seconds, f = 300) => new Promise(resolve => {
    let n = 0
    const iv = setInterval(() => { tw.send(JSON.stringify({ event: 'media', media: { track: 'inbound', payload: Buffer.from(pcmToUlaw(tone(160, f, 8000, n * 160))).toString('base64') } })); n++; if (n >= seconds * 50) { clearInterval(iv); resolve(n) } }, 20)
  })
  return tw
}
const ticketOf = (xml) => /name="k" value="([^"]+)"/.exec(xml)[1]

await t('hub twilio out: REST call with a <Connect><Stream> and status callbacks, stream ticket one-time and bound to the CallSid, audio both ways', async () => {
  const { hub, server, opts, twilioLog, calls } = makeHub()
  const port = await listen(server)
  const tk = hub.issueTicket({ purpose: 'dial', line: 'ca', to: '+15550001234' }, opts)
  const ws = await browser(port, tk.ticket)
  ws.sendCtl({ t: 'hello', v: 1 })
  await ws.ctl(m => m.t === 'state' && m.state === 'dialing')
  await sleep(50)
  const create = twilioLog.find(x => x.op === 'create').f
  assert.equal(create.To, '+15550001234'); assert.equal(create.From, '+15550001234')
  assert.match(create.Twiml, /<Connect action="https:\/\/hooks\.example\.test\/phone-hook\/voice\/stream-done\?k=out" method="POST"><Stream url="wss:\/\/hooks\.example\.test\/phone-hook\/s"><Parameter name="k" value="[A-Za-z0-9_-]{32}"\/><\/Stream><\/Connect>/)
  assert.deepEqual(create.StatusCallbackEvent, ['initiated', 'ringing', 'answered', 'completed'])
  assert.equal(calls.get('CAout1').audio.route, 'server')
  hub.onStatus('CAout1', 'ringing')
  await ws.ctl(m => m.t === 'state' && m.state === 'ringing')
  const k = ticketOf(create.Twiml)
  // wrong CallSid with the right ticket: refused and the ticket is spent
  const bad = await twilioPeer(port, k, 'CAother')
  assert.equal(await bad.waitClose(), 1008)
  // so the real stream cannot reuse it either; mint a fresh one through a second call to keep the test going
  const tk2 = hub.issueTicket({ purpose: 'dial', line: 'ca', to: '+15550001234' }, opts)
  hub.shutdown(); server.close()
  // second hub: happy path
  const h2 = makeHub()
  const p2 = await listen(h2.server)
  const t2 = h2.hub.issueTicket({ purpose: 'dial', line: 'ca', to: '+15550001234' }, h2.opts)
  const b2 = await browser(p2, t2.ticket)
  b2.sendCtl({ t: 'hello', v: 1 })
  await b2.ctl(m => m.t === 'state' && m.state === 'dialing')
  await sleep(50)
  const tw = await twilioPeer(p2, ticketOf(h2.twilioLog[0].f.Twiml), 'CAout1')
  await b2.ctl(m => m.t === 'state' && m.state === 'open')
  const [up, down] = await Promise.all([pump(b2, 0.6), tw.speak(0.6)])
  await sleep(300)
  assert.ok(tw.media().length >= up * 0.6, 'twilio got ' + tw.media().length + ' of ' + up)
  assert.ok(tw.media().some(m => m.streamSid === 'MZ1' && ulawLevel(Buffer.from(m.media.payload, 'base64')) > 0.1))
  assert.ok(b2.audio().length >= down * 0.6, 'browser got ' + b2.audio().length + ' of ' + down)
  // DTMF on a stream: in-band tones
  b2.sendCtl({ t: 'key', d: '5' })
  await sleep(250)
  // far hangup: Twilio stops
  tw.send(JSON.stringify({ event: 'stop' }))
  const end = await b2.ctl(m => m.t === 'end')
  assert.equal(end.reason, 'far-hangup')
  assert.equal(h2.hub.streamDone('CAout1'), 'hangup')
  const row = h2.calls.get('CAout1')
  assert.equal(row.disposition, 'answered')
  assert.ok(row.audio.up.packets > 0 && row.audio.down.packets > 0 && row.audio.far.in > 0 && row.audio.far.out > 0)
  assert.equal(row.audio.signed, true)
  void tk2
  h2.hub.shutdown(); h2.server.close()
})

await t('hub incoming: ring stream plays ringback, unanswered goes to voicemail, answered bridges, decline goes to voicemail', async () => {
  const { hub, server, opts, events } = makeHub({ settings: { incoming: { ringSeconds: 5 } } })
  const port = await listen(server)
  // 1) unanswered
  const ring = hub.ringSession({ callSid: 'CAin1', from: '+306900000000', line: LINES[1], ringSeconds: 1 })
  assert.match(ring.twiml, /\/voice\/stream-done\?k=ring/)
  const tw = await twilioPeer(port, ticketOf(ring.twiml), 'CAin1')
  await sleep(400)
  assert.ok(tw.media().some(m => ulawLevel(Buffer.from(m.media.payload, 'base64')) > 0.05), 'caller hears ringback')
  assert.ok(events.some(e => e.type === 'audio.ring' && e.data.callSid === 'CAin1'))
  await tw.waitClose(3000)
  assert.equal(hub.streamDone('CAin1'), 'voicemail')
  // 2) answered
  const ring2 = hub.ringSession({ callSid: 'CAin2', from: '+306900000001', line: LINES[1], ringSeconds: 10 })
  const tw2 = await twilioPeer(port, ticketOf(ring2.twiml), 'CAin2')
  await sleep(100)
  const tk = hub.issueTicket({ purpose: 'answer', callSid: 'CAin2' }, opts)
  const ws = await browser(port, tk.ticket)
  ws.sendCtl({ t: 'hello', v: 1 })
  await ws.ctl(m => m.t === 'state' && m.state === 'open')
  assert.throws(() => hub.issueTicket({ purpose: 'answer', callSid: 'CAin2' }, opts), e => e.code === 'PHONE_AUDIO_BUSY')
  const before = tw2.media().length
  await Promise.all([pump(ws, 0.4, 1000), tw2.speak(0.4)])
  await sleep(200)
  const after = tw2.media().slice(before)
  assert.ok(after.length > 10)
  assert.ok(ws.audio().length > 10)
  ws.sendCtl({ t: 'end' })
  await tw2.waitClose(2000)
  assert.equal(hub.streamDone('CAin2'), 'hangup')
  // 3) declined
  const ring3 = hub.ringSession({ callSid: 'CAin3', from: '+306900000002', line: LINES[0], ringSeconds: 10 })
  const tw3 = await twilioPeer(port, ticketOf(ring3.twiml), 'CAin3')
  await sleep(100)
  assert.equal(hub.decline('CAin3'), true)
  await tw3.waitClose(2000)
  assert.equal(hub.streamDone('CAin3'), 'voicemail')
  hub.shutdown(); server.close()
})

await t('hub asterisk out: AMI originate into the server context, AudioSocket audio both ways, dial events, far hangup ends the call', async () => {
  const asPort = await new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
  let fakeAst = null
  const ctx = makeHub({
    onOriginate: async (o) => {
      // Asterisk connects to the AudioSocket server with the uuid, like chan_audiosocket.
      fakeAst = net.connect({ host: '127.0.0.1', port: asPort })
      await new Promise(r => fakeAst.on('connect', r))
      fakeAst.write(asMessage(AS_UUID, uuidToBytes(o.uuid)))
      fakeAst.parser = new AsParser(); fakeAst.got = []
      fakeAst.on('data', d => { for (const m of fakeAst.parser.feed(d)) fakeAst.got.push(m) })
    },
  })
  const { hub, server, opts, asterisk, calls } = ctx
  const ass = audioSocketServer({ host: '127.0.0.1', port: asPort, claim: (u) => hub.claimAudioSocket(u) })
  await new Promise(r => ass.on('listening', r))
  const port = await listen(server)
  const tk = hub.issueTicket({ purpose: 'dial', line: 'gr', to: '+302100000000' }, opts)
  const ws = await browser(port, tk.ticket)
  ws.sendCtl({ t: 'hello', v: 1 })
  await ws.ctl(m => m.t === 'state' && m.state === 'dialing')
  await sleep(100)
  const o = asterisk.originated[0]
  assert.equal(o.dest, '+302100000000'); assert.equal(o.account.id, 'acme'); assert.equal(o.channelId, 'dshp-' + o.uuid)
  const ch = 'AudioSocket/127.0.0.1:' + asPort + '-00000001'
  asterisk.emit('event', { Event: 'Newchannel', Uniqueid: o.channelId, Linkedid: o.channelId, Channel: ch })
  asterisk.emit('event', { Event: 'DialBegin', Uniqueid: o.channelId, Linkedid: o.channelId, DestChannel: 'PJSIP/dshp-acme-00000002' })
  asterisk.emit('event', { Event: 'DialState', Uniqueid: o.channelId, Linkedid: o.channelId, DialStatus: 'RINGING' })
  asterisk.emit('event', { Event: 'DialState', Uniqueid: 'other', Linkedid: 'unrelated', DialStatus: 'RINGING' })
  await ws.ctl(m => m.t === 'state' && m.state === 'ringing')
  asterisk.emit('event', { Event: 'DialEnd', Uniqueid: o.channelId, Linkedid: o.channelId, DialStatus: 'ANSWER' })
  await ws.ctl(m => m.t === 'state' && m.state === 'open')
  // far audio: 20 ms slin frames
  for (let i = 0; i < 20; i++) { const p = tone(160, 600, 8000, i * 160); const b = Buffer.alloc(320); for (let j = 0; j < 160; j++) b.writeInt16LE(p[j], 2 * j); fakeAst.write(asMessage(AS_AUDIO, b)) }
  await pump(ws, 0.5)
  await sleep(200)
  assert.ok(ws.audio().length >= 15, 'browser got far audio: ' + ws.audio().length)
  const toAst = fakeAst.got.filter(m => m.kind === AS_AUDIO)
  assert.ok(toAst.length >= 15 && toAst.every(m => m.payload.length === 320), 'asterisk got 20 ms slin frames: ' + toAst.length)
  ws.sendCtl({ t: 'key', d: '7' })
  await sleep(50)
  assert.equal(asterisk.digits, '7')
  fakeAst.write(asMessage(AS_HANGUP))
  const end = await ws.ctl(m => m.t === 'end')
  assert.equal(end.reason, 'far-hangup')
  const row = calls.get('as-' + o.uuid)
  assert.equal(row.disposition, 'answered'); assert.equal(row.status, 'completed'); assert.equal(row.audio.leg, 'asterisk')
  // an unknown uuid is refused
  const stray = net.connect({ host: '127.0.0.1', port: asPort })
  await new Promise(r => stray.on('connect', r))
  stray.write(asMessage(AS_UUID, uuidToBytes('00000000-0000-4000-8000-000000000000')))
  await new Promise(r => stray.on('close', r))
  hub.shutdown(); server.close(); ass.close()
})

await t('hub resume: a dropped browser socket keeps the call, the resume ticket re-attaches it', async () => {
  const { hub, server, opts } = makeHub()
  const port = await listen(server)
  const ring = hub.ringSession({ callSid: 'CAr1', from: '+306900000009', line: LINES[0], ringSeconds: 10 })
  const tw = await twilioPeer(port, ticketOf(ring.twiml), 'CAr1')
  await sleep(50)
  const tk = hub.issueTicket({ purpose: 'answer', callSid: 'CAr1' }, opts)
  const ws = await browser(port, tk.ticket)
  ws.sendCtl({ t: 'hello', v: 1 })
  const ready = await ws.ctl(m => m.t === 'ready')
  ws.sock.destroy()
  await sleep(200)
  assert.equal(tw.closed, false, 'far leg held')
  assert.throws(() => hub.issueTicket({ purpose: 'resume', session: ready.session, resume: 'wrong' }, opts), e => e.code === 'PHONE_AUDIO_SESSION_GONE')
  const rt = hub.issueTicket({ purpose: 'resume', session: ready.session, resume: ready.resume }, opts)
  const ws2 = await browser(port, rt.ticket)
  ws2.sendCtl({ t: 'hello', v: 1 })
  const r2 = await ws2.ctl(m => m.t === 'ready')
  assert.equal(r2.resumed, true); assert.equal(r2.state, 'open')
  ws2.sendCtl({ t: 'end' })
  const end = await ws2.ctl(m => m.t === 'end')
  assert.equal(end.stats.resumes, 1)
  hub.shutdown(); server.close()
})

// ---------------------------------------------------------------- phone-hookd itself

const dir = mkdtempSync(join(process.env.TMPDIR || '/var/tmp', 'dshp-audio-'))
const TOKEN = 'b'.repeat(32)
const BASE = 'https://hooks.example.test/phone-hook'
writeFileSync(join(dir, 'creds'), 'TWILIO_ACCOUNT_SID=AC' + '1'.repeat(32) + '\nTWILIO_AUTH_TOKEN=' + TOKEN + '\n', { mode: 0o600 })
writeFileSync(join(dir, 'hookd-config.json'), JSON.stringify({ publicBaseUrl: BASE, lines: LINES.slice(0, 1), twilio: { credentialsFile: join(dir, 'creds') }, relay: { enabled: false } }), { mode: 0o600 })
const free = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const hookPort = await free()
const asPort = await free()
const child = spawn(process.execPath, [join(HERE, '..', 'daemon', 'hookd.mjs')], {
  env: { ...process.env, HOME: dir, DSH_PHONE_DATA: dir, DSH_PHONE_HOOK_PORT: String(hookPort), DSH_PHONE_AUDIOSOCKET_PORT: String(asPort), DSH_PHONE_ASTERISK_DIR: join(dir, 'ast'), NODE_NO_WARNINGS: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let childOut = ''
child.stdout.on('data', d => { childOut += d }); child.stderr.on('data', d => { childOut += d })
for (let i = 0; i < 80 && !existsSync(join(dir, 'hookd.sock')); i++) await sleep(100)
await sleep(300)
function priv(path, method = 'GET', body) {
  return new Promise((res, rej) => {
    const req = http.request({ socketPath: join(dir, 'hookd.sock'), path, method, headers: body ? { 'content-type': 'application/json' } : {} }, (r) => {
      let d = ''; r.on('data', c => { d += c }); r.on('end', () => res({ status: r.statusCode, body: JSON.parse(d || '{}') }))
    })
    req.on('error', rej); req.end(body ? JSON.stringify(body) : undefined)
  })
}

await t('hookd: /audio/info, ticket + private upgrade (bad ticket 403), echo test end to end, lossless JSON', async () => {
  const info = await priv('/audio/info')
  assert.equal(info.status, 200)
  assert.equal(info.body.route, 'server'); assert.equal(info.body.audioSocket, 'listening')
  assert.deepEqual(JSON.parse(JSON.stringify(info.body)), info.body)
  const bad = await wsConnect({ socketPath: join(dir, 'hookd.sock'), path: '/audio/io', protocols: ['dshp.v1', 'k.' + 'z'.repeat(32)] })
  assert.equal(bad.status, 403)
  const tk = await priv('/audio/ticket', 'POST', { purpose: 'test' })
  assert.equal(tk.status, 200)
  const r = await wsConnect({ socketPath: join(dir, 'hookd.sock'), path: '/audio/io', protocols: ['dshp.v1', 'k.' + tk.body.ticket] })
  assert.equal(r.status, 101)
  const ws = r.ws
  ws.send(encodeControl({ t: 'hello', v: 1 }))
  await ws.waitFor(m => decodeFrame(m).kind === 'control' && decodeFrame(m).msg.t === 'ready')
  await pump(ws, 0.4)
  await sleep(300)
  assert.ok(ws.messages.map(decodeFrame).filter(f => f.kind === 'audio').length > 5)
  ws.send(encodeControl({ t: 'end' }))
  await ws.waitClose()
})

await t('hookd: Twilio stream upgrade needs a valid signature over the wss URL; a signed socket without a ticket is closed', async () => {
  const unsigned = await wsConnect({ port: hookPort, path: '/phone-hook/s' })
  assert.equal(unsigned.status, 403)
  const wrong = await wsConnect({ port: hookPort, path: '/phone-hook/s', headers: { 'x-twilio-signature': expectedSignature(TOKEN, BASE + '/s', {}) } })
  assert.equal(wrong.status, 403, 'the https:// URL is not what Twilio signs')
  const signed = await wsConnect({ port: hookPort, path: '/phone-hook/s', headers: { 'x-twilio-signature': expectedSignature(TOKEN, BASE.replace('https:', 'wss:') + '/s', {}) } })
  assert.equal(signed.status, 101)
  signed.ws.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZx', callSid: 'CAx', customParameters: { k: 'nope' } } }))
  assert.equal(await signed.ws.waitClose(), 1008)
  assert.match(childOut, /PHONE_SIGNATURE_INVALID rejected stream upgrade/)
})

await t('hookd: incoming call with a server-route tab online returns the ring stream TwiML; with a direct tab, the client Dial as before', async () => {
  const post = (path, params) => new Promise((res, rej) => {
    const body = new URLSearchParams(params).toString()
    const req = http.request({ host: '127.0.0.1', port: hookPort, path: '/phone-hook' + path, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': expectedSignature(TOKEN, BASE + path, params) } }, (r) => {
      let d = ''; r.on('data', c => { d += c }); r.on('end', () => res({ status: r.statusCode, body: d }))
    })
    req.on('error', rej); req.end(body)
  })
  await priv('/mode', 'POST', { mode: 'live' })
  await priv('/presence', 'POST', { clientId: 'tab1', registered: true, audio: 'direct' })
  const direct = await post('/voice/incoming', { CallSid: 'CAd1', From: '+306900000000', To: '+15550001234', CallStatus: 'ringing' })
  assert.match(direct.body, /<Client><Identity>/)
  await priv('/presence', 'POST', { clientId: 'tab2', registered: true, audio: 'server' })
  const srv = await post('/voice/incoming', { CallSid: 'CAs1', From: '+306900000000', To: '+15550001234', CallStatus: 'ringing' })
  assert.match(srv.body, /<Connect action="https:\/\/hooks\.example\.test\/phone-hook\/voice\/stream-done\?k=ring" method="POST"><Stream url="wss:\/\/hooks\.example\.test\/phone-hook\/s">/)
  // decline: next stream-done plays voicemail
  const dec = await priv('/audio/decline', 'POST', { callSid: 'CAs1' })
  assert.equal(dec.body.declined, true)
  const done = await post('/voice/stream-done?k=ring', { CallSid: 'CAs1', From: '+306900000000' })
  assert.match(done.body, /<Record|<Say|<Play/)
  const calls = await priv('/calls')
  const row = calls.body.calls.find(c => c.sid === 'CAs1')
  assert.equal(row.disposition, 'voicemail') // as a declined direct call: the voicemail takes over
  await priv('/mode', 'POST', { mode: 'dnd' })
})

await t('plugin host: registers the generic audio socket route and pipes an authorised upgrade to hookd; refuses without the cookie', async () => {
  process.env.DSH_PHONE_SOCKET = join(dir, 'hookd.sock')
  const mod = await import('../lib/index.js')
  const upgrades = []
  let stored = { publicBaseUrl: BASE, lines: LINES.slice(0, 1), twilio: { credentialsFile: join(dir, 'creds') }, relay: { enabled: false } }
  const settings = { register: (ns, schema, opts) => ({ get: () => ({ ...opts.base, ...stored }), update: async (p) => { stored = { ...stored, ...p } } }) }
  const ctx = { settings, webServer: { register: () => () => {}, registerUpgrade: (r) => { upgrades.push(r); return () => {} } }, tools: { register: () => () => {} }, effect: (fn) => fn() }
  mod.apply(ctx, {})
  assert.equal(upgrades.length, 1)
  assert.equal(upgrades[0].path, '/dsh-phone/api/io')
  const host = http.createServer()
  host.on('upgrade', (req, socket, head) => upgrades[0].handler(req, socket, head))
  const port = await listen(host)
  const H = '127.0.0.1:' + port
  const tk = await priv('/audio/ticket', 'POST', { purpose: 'test' })
  const headers = { host: H, origin: 'http://' + H, cookie: harnessCookieName(H) + '=1' }
  const noCookie = await wsConnect({ port, path: '/dsh-phone/api/io', headers: { host: H, origin: 'http://' + H }, protocols: ['dshp.v1', 'k.' + tk.body.ticket] })
  assert.equal(noCookie.status, 403)
  const crossOrigin = await wsConnect({ port, path: '/dsh-phone/api/io', headers: { ...headers, origin: 'http://evil.test' }, protocols: ['dshp.v1', 'k.' + tk.body.ticket] })
  assert.equal(crossOrigin.status, 403)
  const r = await wsConnect({ port, path: '/dsh-phone/api/io', headers, protocols: ['dshp.v1', 'k.' + tk.body.ticket] })
  assert.equal(r.status, 101)
  r.ws.send(encodeControl({ t: 'hello', v: 1 }))
  const ready = await r.ws.waitFor(m => decodeFrame(m).kind === 'control' && decodeFrame(m).msg.t === 'ready')
  assert.equal(decodeFrame(ready).msg.kind, 'test')
  r.ws.send(encodeControl({ t: 'end' }))
  await r.ws.waitClose()
  host.close()
})

child.kill('SIGTERM')
await sleep(300)
rmSync(dir, { recursive: true, force: true })
console.log('\naudio tests: ' + passed + ' passed' + (process.exitCode ? ', SOME FAILED' : ''))
if (process.exitCode) console.log(childOut.split('\n').slice(-30).join('\n'))
