/**
 * Test helper: a minimal WebSocket CLIENT (masked frames, custom headers) so
 * the tests can play the browser and the Twilio Media Streams peer without
 * any dependency. Not shipped.
 */
import net from 'node:net'
import { randomBytes, createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'

export function wsConnect({ host = '127.0.0.1', port, path = '/', socketPath, headers = {}, protocols = [] }) {
  return new Promise((resolve, reject) => {
    const sock = socketPath ? net.connect(socketPath) : net.connect({ host, port })
    const key = randomBytes(16).toString('base64')
    let buf = Buffer.alloc(0)
    let done = false
    sock.on('error', (e) => { if (!done) { done = true; reject(e) } })
    sock.on('connect', () => {
      let req = 'GET ' + path + ' HTTP/1.1\r\nHost: ' + (headers.host || '127.0.0.1') + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n'
      if (protocols.length) req += 'Sec-WebSocket-Protocol: ' + protocols.join(', ') + '\r\n'
      for (const [k, v] of Object.entries(headers)) if (k !== 'host') req += k + ': ' + v + '\r\n'
      sock.write(req + '\r\n')
    })
    const onData = (d) => {
      buf = Buffer.concat([buf, d])
      const i = buf.indexOf('\r\n\r\n')
      if (i < 0) return
      const head = buf.subarray(0, i).toString()
      const rest = buf.subarray(i + 4)
      sock.off('data', onData)
      const status = Number(head.split(' ')[1])
      done = true
      if (status !== 101) { sock.destroy(); resolve({ status, head }); return }
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)
      const want = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      if (!accept || accept[1] !== want) { sock.destroy(); reject(new Error('bad accept')); return }
      const c = new TestWs(sock, head)
      resolve({ status, head, ws: c })
      if (rest.length) c.feed(rest)
    }
    sock.on('data', onData)
  })
}

export class TestWs extends EventEmitter {
  constructor(sock, head) {
    super()
    this.sock = sock
    this.head = head
    this.buf = Buffer.alloc(0)
    this.closed = false
    this.messages = []
    sock.on('data', (d) => this.feed(d))
    sock.on('close', () => { if (!this.closed) { this.closed = true; this.emit('close', this.closeCode || 1006) } })
  }
  feed(d) {
    this.buf = Buffer.concat([this.buf, d])
    while (this.buf.length >= 2) {
      const op = this.buf[0] & 0x0f
      let len = this.buf[1] & 0x7f
      let off = 2
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (this.buf.length < 10) return; len = this.buf.readUInt32BE(6); off = 10 }
      if (this.buf.length < off + len) return
      const data = this.buf.subarray(off, off + len)
      this.buf = this.buf.subarray(off + len)
      if (op === 0x8) { this.closeCode = data.length >= 2 ? data.readUInt16BE(0) : 1005; this.closed = true; this.emit('close', this.closeCode); this.sock.end(); return }
      if (op === 0x9) { this.raw(0xa, data); continue }
      if (op === 0x1 || op === 0x2) { const m = op === 0x1 ? data.toString() : Buffer.from(data); this.messages.push(m); this.emit('message', m, op === 0x2) }
    }
  }
  raw(op, payload) {
    const p = Buffer.from(payload)
    const mask = randomBytes(4)
    let head
    if (p.length < 126) { head = Buffer.alloc(2); head[1] = 0x80 | p.length }
    else if (p.length < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2) }
    else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeUInt32BE(p.length, 6) }
    head[0] = 0x80 | op
    const m = Buffer.alloc(p.length)
    for (let i = 0; i < p.length; i++) m[i] = p[i] ^ mask[i & 3]
    try { this.sock.write(Buffer.concat([head, mask, m])) } catch {}
  }
  send(data) { if (typeof data === 'string') this.raw(0x1, Buffer.from(data)); else this.raw(0x2, data) }
  close() { this.raw(0x8, Buffer.from([0x03, 0xe8])); setTimeout(() => this.sock.destroy(), 100) }
  waitFor(pred, ms = 3000) {
    return new Promise((resolve, reject) => {
      for (const m of this.messages) if (pred(m)) return resolve(m)
      const t = setTimeout(() => { this.off('message', on); reject(new Error('timeout waiting for message')) }, ms)
      const on = (m) => { if (pred(m)) { clearTimeout(t); this.off('message', on); resolve(m) } }
      this.on('message', on)
    })
  }
  waitClose(ms = 3000) {
    return new Promise((resolve, reject) => {
      if (this.closed) return resolve(this.closeCode)
      const t = setTimeout(() => reject(new Error('timeout waiting for close')), ms)
      this.once('close', (c) => { clearTimeout(t); resolve(c) })
    })
  }
}
