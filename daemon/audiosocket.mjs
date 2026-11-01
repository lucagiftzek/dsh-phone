/**
 * dsh-phone: Asterisk AudioSocket server (loopback only, no dependencies).
 *
 * Protocol (docs.asterisk.org, Channel Drivers > AudioSocket): a TCP stream of
 * messages [kind u8][length u16 big-endian][payload].
 *   0x00 hangup        0x01 UUID (16 bytes, first message from Asterisk)
 *   0x03 DTMF (1 byte) 0x10 audio, signed linear 16-bit little-endian, 8 kHz mono
 *   0xff error
 *
 * Asterisk connects to us for every server-routed call on a SIP line (the
 * AudioSocket channel hookd originates through AMI). A connection whose UUID
 * is not one hookd is waiting for is closed at once.
 */

import net from 'node:net'
import { EventEmitter } from 'node:events'

export const AS_HANGUP = 0x00
export const AS_UUID = 0x01
export const AS_DTMF = 0x03
export const AS_AUDIO = 0x10
export const AS_ERROR = 0xff

export function uuidFromBytes(b) {
  const h = Buffer.from(b).toString('hex')
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-')
}

export function uuidToBytes(uuid) {
  const h = String(uuid).replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/i.test(h)) throw new Error('bad uuid')
  return Buffer.from(h, 'hex')
}

/** Encode one AudioSocket message. */
export function asMessage(kind, payload = Buffer.alloc(0)) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const head = Buffer.alloc(3)
  head[0] = kind
  head.writeUInt16BE(p.length, 1)
  return Buffer.concat([head, p])
}

/** Incremental parser: feed(chunk) -> [{ kind, payload }]. */
export class AsParser {
  constructor(maxLen = 8192) { this.buf = Buffer.alloc(0); this.maxLen = maxLen }
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const out = []
    while (this.buf.length >= 3) {
      const len = this.buf.readUInt16BE(1)
      if (len > this.maxLen) throw new Error('AudioSocket message too large')
      if (this.buf.length < 3 + len) break
      out.push({ kind: this.buf[0], payload: this.buf.subarray(3, 3 + len) })
      this.buf = this.buf.subarray(3 + len)
    }
    return out
  }
}

/** One accepted Asterisk connection, after its UUID matched. */
export class AsConn extends EventEmitter {
  constructor(sock, uuid, parser) {
    super()
    this.sock = sock
    this.uuid = uuid
    this.parser = parser
    this.closed = false
    sock.on('data', (d) => this.onData(d))
    sock.on('close', () => this.finish('closed'))
    sock.on('error', () => this.finish('error'))
  }
  onData(d) {
    let msgs
    try { msgs = this.parser.feed(d) } catch (e) { this.finish('protocol'); try { this.sock.destroy() } catch {} return }
    for (const m of msgs) this.dispatch(m)
  }
  dispatch(m) {
    if (m.kind === AS_AUDIO) this.emit('audio', m.payload)
    else if (m.kind === AS_DTMF) this.emit('dtmf', m.payload.toString('latin1'))
    else if (m.kind === AS_HANGUP) { this.finish('hangup') }
    else if (m.kind === AS_ERROR) this.emit('asError', m.payload.length ? m.payload[0] : 0)
  }
  sendAudio(slinLe) { if (!this.closed) { try { this.sock.write(asMessage(AS_AUDIO, slinLe)) } catch {} } }
  hangup() {
    if (this.closed) return
    try { this.sock.write(asMessage(AS_HANGUP)) } catch {}
    try { this.sock.end() } catch {}
    this.finish('local')
  }
  finish(why) {
    if (this.closed) return
    this.closed = true
    try { this.sock.destroy() } catch {}
    this.emit('close', why)
  }
}

/**
 * Listen on host:port (loopback). claim(uuid) returns a handler function
 * (conn) => void for an expected call, or null to refuse the connection.
 */
export function audioSocketServer({ host = '127.0.0.1', port, claim, log = () => {}, warn = () => {} }) {
  if (!/^(127\.\d+\.\d+\.\d+|::1|localhost)$/.test(host)) throw new Error('AudioSocket server must bind the loopback')
  const server = net.createServer((sock) => {
    try { sock.setNoDelay(true) } catch {}
    const parser = new AsParser()
    let done = false
    const timer = setTimeout(() => { if (!done) { warn('audiosocket: no UUID within 5 s, closed'); sock.destroy() } }, 5000)
    timer.unref && timer.unref()
    const first = (d) => {
      let msgs
      try { msgs = parser.feed(d) } catch { sock.destroy(); return }
      if (!msgs.length) return
      done = true
      clearTimeout(timer)
      sock.off('data', first)
      const [m, ...rest] = msgs
      if (m.kind !== AS_UUID || m.payload.length !== 16) { warn('audiosocket: first message is not a UUID, closed'); sock.destroy(); return }
      const uuid = uuidFromBytes(m.payload)
      const handler = claim(uuid)
      if (!handler) { warn('audiosocket: unknown UUID, closed'); sock.destroy(); return }
      const conn = new AsConn(sock, uuid, parser)
      handler(conn)
      for (const r of rest) conn.dispatch(r)
    }
    sock.on('data', first)
    sock.on('error', () => {})
  })
  server.on('error', (e) => warn('audiosocket server: ' + e.message))
  server.listen(port, host, () => log('audiosocket listening on ' + host + ':' + port + ' (loopback)'))
  return server
}
