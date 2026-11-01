/**
 * dsh-phone: a small RFC 6455 WebSocket server endpoint (no dependencies).
 *
 * Used by phone-hookd for the two audio sockets: the browser link (through the
 * DSH plugin's upgrade route and hookd's private unix socket) and the Twilio
 * Media Streams link (public, through the edge). Server side only: client
 * frames must be masked, server frames are not. Fragmented messages are
 * reassembled; ping is answered; payloads above maxPayload close the socket
 * with 1009.
 */

import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function acceptKey(key) {
  return createHash('sha1').update(String(key) + GUID).digest('base64')
}

/** Parse Sec-WebSocket-Protocol into a list of tokens. */
export function offeredProtocols(req) {
  const v = req.headers['sec-websocket-protocol']
  return typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : []
}

/** Refuse an upgrade with a plain HTTP status (the socket is closed). */
export function refuseUpgrade(socket, status, text = '') {
  socket.on('error', () => {})
  const reason = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 426: 'Upgrade Required', 429: 'Too Many Requests', 503: 'Service Unavailable' }[status] || 'Error'
  const body = Buffer.from(text ? text + '\n' : '')
  try {
    socket.write('HTTP/1.1 ' + status + ' ' + reason + '\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: ' + body.length + '\r\n\r\n')
    socket.write(body)
  } catch {}
  try { socket.end() } catch {}
  setTimeout(() => { try { socket.destroy() } catch {} }, 1000).unref()
}

/**
 * Complete the handshake. Returns a WsConn, or null after answering 400.
 * protocol: the subprotocol to echo (must be one the client offered), or ''.
 */
export function acceptWebSocket(req, socket, head, { protocol = '', maxPayload = 64 * 1024, pingMs = 15000 } = {}) {
  const key = req.headers['sec-websocket-key']
  const upgrade = String(req.headers.upgrade || '').toLowerCase()
  if (req.method !== 'GET' || upgrade !== 'websocket' || typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || String(req.headers['sec-websocket-version'] || '') !== '13') {
    refuseUpgrade(socket, 400, 'not a WebSocket upgrade')
    return null
  }
  const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Accept: ' + acceptKey(key)]
  if (protocol) lines.push('Sec-WebSocket-Protocol: ' + protocol)
  socket.write(lines.join('\r\n') + '\r\n\r\n')
  const conn = new WsConn(socket, { maxPayload, pingMs })
  if (head && head.length) conn.feed(head)
  return conn
}

export class WsConn extends EventEmitter {
  constructor(socket, { maxPayload = 64 * 1024, pingMs = 15000 } = {}) {
    super()
    this.socket = socket
    this.maxPayload = maxPayload
    this.buf = Buffer.alloc(0)
    this.frags = null
    this.fragOp = 0
    this.closed = false
    this.closeSent = false
    this.lastPong = Date.now()
    this.bytesIn = 0
    this.bytesOut = 0
    try { socket.setNoDelay(true) } catch {}
    socket.on('data', (d) => this.feed(d))
    socket.on('close', () => this.finish(1006, 'socket closed'))
    socket.on('error', (e) => { this.emit('socketError', e); this.finish(1006, 'socket error') })
    if (pingMs > 0) {
      this.pinger = setInterval(() => {
        if (Date.now() - this.lastPong > pingMs * 3) { this.terminate(); return }
        this.raw(0x9, Buffer.alloc(0))
      }, pingMs)
      this.pinger.unref && this.pinger.unref()
    }
  }

  get bufferedAmount() { return this.socket.writableLength || 0 }

  feed(chunk) {
    if (this.closed) return
    this.bytesIn += chunk.length
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    while (!this.closed) {
      const b = this.buf
      if (b.length < 2) return
      const fin = (b[0] & 0x80) !== 0
      const rsv = b[0] & 0x70
      const op = b[0] & 0x0f
      const masked = (b[1] & 0x80) !== 0
      let len = b[1] & 0x7f
      let off = 2
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4 }
      else if (len === 127) {
        if (b.length < 10) return
        const hi = b.readUInt32BE(2)
        if (hi !== 0) { this.fail(1009, 'frame too large'); return }
        len = b.readUInt32BE(6); off = 10
      }
      if (rsv) { this.fail(1002, 'reserved bits set'); return }
      if (!masked) { this.fail(1002, 'client frames must be masked'); return }
      if (len > this.maxPayload) { this.fail(1009, 'message too large'); return }
      if (b.length < off + 4 + len) return
      const mask = b.subarray(off, off + 4)
      const data = Buffer.allocUnsafe(len)
      const src = b.subarray(off + 4, off + 4 + len)
      for (let i = 0; i < len; i++) data[i] = src[i] ^ mask[i & 3]
      this.buf = b.subarray(off + 4 + len)
      this.frame(fin, op, data)
    }
  }

  frame(fin, op, data) {
    if (op >= 0x8) {
      if (!fin || data.length > 125) { this.fail(1002, 'bad control frame'); return }
      if (op === 0x8) {
        const code = data.length >= 2 ? data.readUInt16BE(0) : 1005
        const reason = data.length > 2 ? data.subarray(2).toString('utf8') : ''
        if (!this.closeSent) this.sendClose(code === 1005 ? 1000 : code, '')
        this.finish(code, reason)
        try { this.socket.end() } catch {}
        return
      }
      if (op === 0x9) { this.raw(0xa, data); return }
      if (op === 0xa) { this.lastPong = Date.now(); this.emit('pong'); return }
      this.fail(1002, 'unknown control opcode')
      return
    }
    if (op === 0x0) {
      if (!this.frags) { this.fail(1002, 'continuation without start'); return }
      this.frags.push(data)
    } else if (op === 0x1 || op === 0x2) {
      if (this.frags) { this.fail(1002, 'new message inside a fragmented one'); return }
      this.frags = [data]
      this.fragOp = op
    } else { this.fail(1002, 'unknown opcode'); return }
    const total = this.frags.reduce((n, f) => n + f.length, 0)
    if (total > this.maxPayload) { this.fail(1009, 'message too large'); return }
    if (!fin) return
    const msg = this.frags.length === 1 ? this.frags[0] : Buffer.concat(this.frags)
    const binary = this.fragOp === 0x2
    this.frags = null
    this.lastPong = Date.now()
    this.emit('message', binary ? msg : msg.toString('utf8'), binary)
  }

  raw(op, payload) {
    if (this.closed || this.socket.destroyed) return false
    const len = payload.length
    let head
    if (len < 126) { head = Buffer.alloc(2); head[1] = len }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2) }
    else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6) }
    head[0] = 0x80 | op
    this.bytesOut += head.length + len
    try { this.socket.write(len ? Buffer.concat([head, payload]) : head); return true } catch { return false }
  }

  /** Send a text (string) or binary (Buffer / Uint8Array) message. */
  send(data) {
    if (typeof data === 'string') return this.raw(0x1, Buffer.from(data, 'utf8'))
    return this.raw(0x2, Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  }

  sendClose(code, reason) {
    if (this.closeSent) return
    this.closeSent = true
    const r = Buffer.from(String(reason || '').slice(0, 100), 'utf8')
    const p = Buffer.alloc(2 + r.length)
    p.writeUInt16BE(code, 0)
    r.copy(p, 2)
    this.raw(0x8, p)
  }

  close(code = 1000, reason = '') {
    if (this.closed) return
    this.sendClose(code, reason)
    try { this.socket.end() } catch {}
    const t = setTimeout(() => { try { this.socket.destroy() } catch {} }, 2000)
    t.unref && t.unref()
    this.finish(code, reason)
  }

  fail(code, reason) { this.emit('protocolError', reason); this.close(code, reason) }

  terminate() { try { this.socket.destroy() } catch {} this.finish(1006, 'terminated') }

  finish(code, reason) {
    if (this.closed) return
    this.closed = true
    clearInterval(this.pinger)
    this.emit('close', code, reason)
  }
}
