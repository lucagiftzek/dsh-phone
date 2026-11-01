/**
 * dsh-phone: browser side of the server audio route.
 *
 * Only ONE host is contacted: the DSH origin (wss://<origin>/dsh-phone/api/io).
 * No Twilio SDK, no STUN/TURN, no third-party script.
 *
 *   AudioLink    the transport: sendFrame(bytes) / onFrame(cb) over one socket,
 *                binary framing from shared/frame.mjs (independent of the socket,
 *                so the same frames can later travel inside another channel).
 *   engine       getUserMedia (echo cancellation, noise suppression, auto gain)
 *                -> low-pass -> AudioWorklet: resample to 8 kHz, mu-law, 20 ms
 *                blocks batched to packetMs; far audio -> adaptive jitter buffer
 *                (shared/jitter.mjs, inlined) -> resample -> speakers.
 *   ServerCall   the call object the Phone tab drives (same events and methods
 *                as an SDK call: accept, ringing, disconnect, error, mute;
 *                disconnect(), mute(), isMuted(), sendDigits()).
 */
import { JitterBuffer } from '../shared/jitter.mjs'
import { ulawEncode, ulawDecode } from '../shared/g711.mjs'
import { encodeAudio, encodeControl, decodeFrame } from '../shared/frame.mjs'

export class AudioError extends Error {
  constructor(kind, message) { super(message); this.kind = kind }
}

const isLoopbackHost = (h) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(h)

/** wss URL of the audio socket on this origin; plain ws only for a loopback host. */
export function socketUrl(loc, path) {
  if (loc.protocol === 'https:') return 'wss://' + loc.host + path
  if (isLoopbackHost(loc.hostname)) return 'ws://' + loc.host + path
  throw new AudioError('insecure', 'Server audio needs the https address of the GUI (wss only).')
}

// ---------------------------------------------------------------- transport

export class AudioLink {
  constructor(url, ticket, { onFrame, onControl, onClose, onOpen } = {}) {
    this.onFrame = onFrame || (() => {})
    this.onControl = onControl || (() => {})
    this.onClose = onClose || (() => {})
    this.closed = false
    this.bytesIn = 0
    this.bytesOut = 0
    const ws = new WebSocket(url, ['dshp.v1', 'k.' + ticket])
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => { if (onOpen) onOpen() }
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') return
      this.bytesIn += ev.data.byteLength
      const f = decodeFrame(new Uint8Array(ev.data))
      if (f.kind === 'audio') this.onFrame(f)
      else if (f.kind === 'control') this.onControl(f.msg)
    }
    ws.onclose = (ev) => { if (!this.closed) { this.closed = true; this.onClose(ev.code, ev.reason) } }
    ws.onerror = () => {}
  }
  get open() { return this.ws.readyState === 1 }
  /** Send one already-framed message (audio or control). */
  sendFrame(bytes) {
    if (this.ws.readyState !== 1) return false
    if (this.ws.bufferedAmount > 64 * 1024) return false // congested: drop rather than queue latency
    this.bytesOut += bytes.byteLength
    this.ws.send(bytes)
    return true
  }
  control(obj) { return this.sendFrame(encodeControl(obj)) }
  close() { this.closed = true; try { this.ws.close(1000) } catch {} }
}

// ---------------------------------------------------------------- worklet

/** Source of the AudioWorklet processor, with the jitter buffer and G.711 inlined. */
export function workletSource() {
  return [
    'const JitterBuffer = (' + JitterBuffer.toString() + ');',
    'const ulawEncode = (' + ulawEncode.toString() + ');',
    'const ulawDecode = (' + ulawDecode.toString() + ');',
    'const DEC = new Float32Array(256); for (let i = 0; i < 256; i++) DEC[i] = ulawDecode(i) / 32768;',
    'class DshpIo extends AudioWorkletProcessor {',
    '  constructor(o) {',
    '    super();',
    '    const p = (o && o.processorOptions) || {};',
    '    this.blocks = Math.max(1, Math.round((p.packetMs || 40) / 20));',
    '    this.jb = new JitterBuffer({ frameMs: 20, minMs: p.jbMin || 40, maxMs: p.jbMax || 400 });',
    '    this.inStep = 8000 / sampleRate; this.inPos = 0; this.inPrev = 0;',
    '    this.cap = new Uint8Array(160 * this.blocks); this.capN = 0;',
    '    this.outStep = 8000 / sampleRate; this.outPos = 0;',
    '    this.fifo = new Float32Array(0); this.last = new Float32Array(160); this.plc = 0;',
    '    this.muted = false; this.upE = 0; this.dnE = 0; this.n = 0; this.ticks = 0;',
    '    this.port.onmessage = (e) => {',
    '      const m = e.data;',
    '      if (m.t === "down") { const b = new Uint8Array(m.payload); const n = b.length / 160; const now = currentTime * 1000; for (let i = 0; i < n; i++) this.jb.push((m.seq + i) & 0xffff, b.slice(i * 160, (i + 1) * 160), now); }',
    '      else if (m.t === "mute") this.muted = !!m.on;',
    '    };',
    '  }',
    '  nextBlock() {',
    '    const r = this.jb.pull();',
    '    const out = new Float32Array(160);',
    '    if (r.block) { for (let i = 0; i < 160; i++) out[i] = DEC[r.block[i]]; this.last = out; this.plc = 0; }',
    '    else if (r.kind === "plc" && this.plc < 3) { const g = 0.6 / (this.plc + 1); for (let i = 0; i < 160; i++) out[i] = this.last[i] * g; this.plc++; }',
    '    return out;',
    '  }',
    '  process(inputs, outputs) {',
    '    const inp = inputs[0] && inputs[0][0];',
    '    if (inp) {',
    '      for (let i = 0; i < inp.length; i++) {',
    '        const x = inp[i];',
    '        this.inPos += this.inStep;',
    '        if (this.inPos >= 1) {',
    '          this.inPos -= 1;',
    '          const v = this.muted ? 0 : this.inPrev + (x - this.inPrev) * (1 - this.inPos / this.inStep);',
    '          this.upE = this.upE * 0.999 + v * v * 0.001;',
    '          this.cap[this.capN++] = ulawEncode(Math.max(-32768, Math.min(32767, Math.round(v * 32767))));',
    '          if (this.capN === this.cap.length) { const b = this.cap.slice(0); this.capN = 0; this.port.postMessage({ t: "up", payload: b.buffer }, [b.buffer]); }',
    '        }',
    '        this.inPrev = x;',
    '      }',
    '    }',
    '    const out = outputs[0] && outputs[0][0];',
    '    if (out) {',
    '      for (let i = 0; i < out.length; i++) {',
    '        let idx = Math.floor(this.outPos);',
    '        while (idx + 1 >= this.fifo.length) {',
    '          const nb = this.nextBlock(); const keep = this.fifo.subarray(Math.max(0, this.fifo.length - 1)); const f = new Float32Array(keep.length + 160);',
    '          f.set(keep, 0); f.set(nb, keep.length); this.outPos -= (this.fifo.length - keep.length); this.fifo = f; idx = Math.floor(this.outPos);',
    '        }',
    '        const fr = this.outPos - idx;',
    '        const v = this.fifo[idx] + (this.fifo[idx + 1] - this.fifo[idx]) * fr;',
    '        out[i] = v; this.dnE = this.dnE * 0.999 + v * v * 0.001;',
    '        this.outPos += this.outStep;',
    '      }',
    '      for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);',
    '    }',
    '    if (++this.ticks % 12 === 0) this.port.postMessage({ t: "lvl", up: Math.sqrt(this.upE), down: Math.sqrt(this.dnE), jb: this.ticks % 120 === 0 ? this.jb.stats() : null });',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("dshp-io", DshpIo);',
  ].join('\n')
}

let workletUrl = null
function moduleUrl() {
  if (!workletUrl) workletUrl = URL.createObjectURL(new Blob([workletSource()], { type: 'text/javascript' }))
  return workletUrl
}

/**
 * Microphone + speakers through the worklet. onUp(Uint8Array mu-law of
 * packetMs) is called for every captured packet; push(seq, payload) plays far
 * audio; levels arrive through onLevel({ up, down, jb }).
 */
export async function createEngine({ packetMs = 40, jbMin = 40, jbMax = 400, onUp, onLevel } = {}) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new AudioError('mic', 'This browser cannot capture audio here (it needs https).')
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
    throw new AudioError('mic', denied ? 'Microphone access was denied. Allow it for this site and try again.' : 'No microphone available (' + (e && e.message || e) + ').')
  }
  const C = window.AudioContext || window.webkitAudioContext
  const ctx = new C({ latencyHint: 'interactive' })
  if (ctx.state === 'suspended') { try { await ctx.resume() } catch {} }
  await ctx.audioWorklet.addModule(moduleUrl())
  const src = ctx.createMediaStreamSource(stream)
  const lp = (f) => { const b = ctx.createBiquadFilter(); b.type = 'lowpass'; b.frequency.value = f; b.Q.value = 0.7; return b }
  const a1 = lp(3400), a2 = lp(3400), o1 = lp(3800)
  const node = new AudioWorkletNode(ctx, 'dshp-io', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { packetMs, jbMin, jbMax } })
  src.connect(a1); a1.connect(a2); a2.connect(node); node.connect(o1); o1.connect(ctx.destination)
  node.port.onmessage = (e) => {
    const m = e.data
    if (m.t === 'up' && onUp) onUp(new Uint8Array(m.payload))
    else if (m.t === 'lvl' && onLevel) onLevel(m)
  }
  return {
    ctx, stream,
    push(seq, payload) { const b = payload.slice(0); node.port.postMessage({ t: 'down', seq, payload: b.buffer }, [b.buffer]) },
    mute(on) { node.port.postMessage({ t: 'mute', on: !!on }) },
    close() {
      try { stream.getTracks().forEach(t => t.stop()) } catch {}
      try { node.disconnect(); src.disconnect() } catch {}
      try { ctx.close() } catch {}
    },
  }
}

// ---------------------------------------------------------------- call object

/**
 * A server-routed call (or audio test). params: { purpose: dial|answer|pickup|test, ... }.
 * deps: { apiPost, socketPath, packetMs, location }.
 */
export class ServerCall {
  constructor(params, deps) {
    this.params = params
    this.deps = deps
    this.h = {}
    this.muted = false
    this.state = 'starting'
    this.levels = { up: 0, down: 0 }
    this.jb = null
    this.counters = { upPackets: 0, downPackets: 0, upBytes: 0, downBytes: 0 }
    this.server = null
    this.rttMs = null
    this.ended = false
    this.route = 'server'
    this.seq = 0
    this.t0 = performance.now()
  }
  on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); return this }
  emit(ev, ...a) { for (const f of this.h[ev] || []) { try { f(...a) } catch (e) { console.error('[dsh-phone]', e) } } }

  async start() {
    const d = this.deps
    const url = socketUrl(d.location || window.location, d.socketPath)
    this.engine = await createEngine({
      packetMs: d.packetMs || 40, jbMin: d.jbMin, jbMax: d.jbMax,
      onUp: (payload) => {
        if (!this.link || !this.ready) return
        const frame = encodeAudio(this.seq, Math.round(performance.now()) >>> 0, payload)
        this.seq = (this.seq + payload.length / 160) & 0xffff
        if (this.link.sendFrame(frame)) { this.counters.upPackets++; this.counters.upBytes += frame.byteLength }
      },
      onLevel: (m) => { this.levels = { up: m.up, down: m.down }; if (m.jb) this.jb = m.jb; this.emit('levels', this.levels) },
    })
    let t
    try { t = await d.apiPost('/audio/ticket', this.params) } catch (e) { this.engine.close(); throw e }
    this.session = t.session
    this.connect(url, t.ticket)
  }

  connect(url, ticket) {
    this.ready = false
    this.link = new AudioLink(url, ticket, {
      onOpen: () => this.link.control({ t: 'hello', v: 1, codec: 'pcmu', packetMs: this.deps.packetMs || 40 }),
      onFrame: (f) => { this.counters.downPackets++; this.counters.downBytes += f.payload.byteLength + 8; this.engine.push(f.seq, f.payload) },
      onControl: (m) => this.control(m),
      onClose: (code) => this.closed(code),
    })
    clearInterval(this.pinger)
    this.pinger = setInterval(() => { if (this.link && this.link.open) this.link.control({ t: 'ping', c: Math.round(performance.now()) }) }, 2000)
  }

  control(m) {
    if (m.t === 'ready') {
      this.ready = true
      this.resume = m.resume
      this.leg = m.leg
      this.retries = 0
      if (m.resumed) this.emit('resumed')
      if (m.state && m.state !== 'connecting') this.setState(m.state)
    } else if (m.t === 'state') { if (m.emojis) { this.emojis = String(m.emojis); this.emit('emojis', this.emojis) } this.setState(m.state) }
    else if (m.t === 'pong') { this.rttMs = Math.round(performance.now() - m.c); this.link.control({ t: 'rtt', ms: this.rttMs }) }
    else if (m.t === 'stats') { this.server = m.stats; this.emit('stats', m.stats) }
    else if (m.t === 'error') { this.error = m.message; this.emit('error', new AudioError('leg', m.message)) }
    else if (m.t === 'end') { this.server = m.stats || this.server; this.finish(m.reason || 'ended') }
  }

  setState(s) {
    const prev = this.state
    this.state = s
    if (s === 'open' && prev !== 'open') this.emit('accept')
    else if (s === 'ringing' || s === 'early') this.emit('ringing')
    this.emit('state', s)
  }

  /** The socket closed without an end message: try to resume for 12 s. */
  async closed(code) {
    if (this.ended) return
    if (!this.resume || this.state === 'starting' || code === 4404) { this.finish(code === 4404 ? 'gone' : 'socket-closed'); return }
    this.emit('reconnecting')
    const until = Date.now() + 12000
    while (!this.ended && Date.now() < until) {
      await new Promise(r => setTimeout(r, 1000))
      try {
        const t = await this.deps.apiPost('/audio/ticket', { purpose: 'resume', session: this.session, resume: this.resume })
        this.connect(socketUrl(this.deps.location || window.location, this.deps.socketPath), t.ticket)
        return
      } catch (e) { if (/ended|gone|no longer/i.test(String(e.message))) break }
    }
    this.finish('socket-closed')
  }

  finish(reason) {
    if (this.ended) return
    this.ended = true
    this.endReason = reason
    clearInterval(this.pinger)
    try { this.link && this.link.close() } catch {}
    try { this.engine && this.engine.close() } catch {}
    this.emit('disconnect', reason)
  }

  disconnect() { if (this.ended) return; try { this.link && this.link.control({ t: 'end' }) } catch {} setTimeout(() => this.finish('hangup'), 300) }
  mute(on) { this.muted = !!on; if (this.engine) this.engine.mute(this.muted); if (this.link) this.link.control({ t: 'mute', on: this.muted }); this.emit('mute', this.muted) }
  isMuted() { return this.muted }
  sendDigits(d) { if (this.link) this.link.control({ t: 'key', d: String(d).slice(0, 1) }) }
  /** Live numbers for the call screen. */
  snapshot() {
    return { state: this.state, leg: this.leg || '', levels: this.levels, counters: { ...this.counters }, jb: this.jb, rttMs: this.rttMs, server: this.server, elapsed: (performance.now() - this.t0) / 1000 }
  }
}
