/**
 * dsh-phone: client for phone-hookd's private unix-socket API.
 * Used by the DSH host half (routes + agent tools). Never exposed directly.
 */

import http from 'node:http'
import net from 'node:net'
import { socketPath } from '../daemon/config.mjs'
import { E } from './errors.js'

/**
 * An error from the daemon link. `code`, `hint`, `docs` and `body` are set
 * when the daemon answered with a coded body, or when the link itself failed
 * (unreachable, timeout); the HTTP status is the legacy one.
 */
export class HookdError extends Error {
  constructor(message, status, body) {
    super(message)
    this.status = status
    // The daemon body as sent, also for codes outside the PHONE catalog (TELEGRAM_*).
    if (body && typeof body === 'object') this.raw = body
    if (body && typeof body.code === 'string' && E.has(body.code)) {
      this.code = body.code; this.hint = body.hint; this.docs = body.docs; this.body = body
    }
  }
}

function linkError(code, message, status) {
  return new HookdError(message, status, E.body(code, { message }))
}

/** JSON request over the unix socket. Resolves the parsed body or throws HookdError. */
export function hookd(method, path, body, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = http.request({
      socketPath: socketPath(),
      path,
      method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
      timeout: timeoutMs,
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = text ? JSON.parse(text) : {} } catch { json = { ok: false, error: text.slice(0, 200) } }
        if (res.statusCode >= 400 || (json && json.ok === false)) reject(new HookdError((json && json.error) || ('hookd HTTP ' + res.statusCode), res.statusCode, json))
        else resolve(json)
      })
    })
    req.on('timeout', () => req.destroy(linkError('PHONE_HOOKD_TIMEOUT', 'phone-hookd did not answer in time', 504)))
    req.on('error', (e) => {
      // A timeout arrives here too, wrapped (legacy: status 503, doubled prefix).
      if (e instanceof HookdError && e.code === 'PHONE_HOOKD_TIMEOUT') return reject(linkError('PHONE_HOOKD_TIMEOUT', 'phone-hookd: ' + e.message, 503))
      const down = e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
      reject(linkError('PHONE_HOOKD_UNAVAILABLE', down ? 'phone-hookd is not running (systemctl status dsh-phone-hookd)' : 'phone-hookd: ' + e.message, 503))
    })
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * Pipe a raw hookd response (SSE stream, audio, media) to a browser response.
 * Status and the safe headers are copied; the request is aborted when the
 * browser goes away.
 */
export function hookdPipe(method, path, req, res, { headers = {} } = {}) {
  const up = http.request({ socketPath: socketPath(), path, method, headers }, (u) => {
    const pass = {}
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'x-content-type-options', 'content-security-policy', 'x-accel-buffering']) {
      if (u.headers[h] !== undefined) pass[h] = u.headers[h]
    }
    res.writeHead(u.statusCode || 502, pass)
    u.pipe(res)
  })
  up.on('error', (e) => {
    try {
      if (!res.headersSent) E.send(res, 'PHONE_HOOKD_UNAVAILABLE', { message: 'phone-hookd unavailable: ' + e.message })
      else res.end()
    } catch {}
  })
  req.on('close', () => up.destroy())
  up.end()
}

/**
 * Forward a request WITH a body to hookd and pipe the answer back (status and
 * safe headers copied). `body` is a Buffer to send, or `stream: true` streams
 * the browser request itself (uploads; content-length is forwarded).
 */
export function hookdForward(method, path, req, res, { body = null, stream = false, contentType = 'application/json' } = {}) {
  const headers = { 'content-type': contentType }
  if (body) headers['content-length'] = body.length
  else if (stream && req.headers['content-length']) headers['content-length'] = req.headers['content-length']
  const up = http.request({ socketPath: socketPath(), path, method, headers }, (u) => {
    const pass = {}
    for (const h of ['content-type', 'content-length', 'cache-control', 'x-content-type-options']) if (u.headers[h] !== undefined) pass[h] = u.headers[h]
    res.writeHead(u.statusCode || 502, pass)
    u.pipe(res)
  })
  up.on('error', (e) => {
    try {
      if (!res.headersSent) E.send(res, 'PHONE_HOOKD_UNAVAILABLE', { message: 'phone-hookd unavailable: ' + e.message })
      else res.end()
    } catch {}
  })
  // Abort upstream only when the browser goes away before the answer is complete.
  res.on('close', () => { if (!res.writableFinished) up.destroy() })
  if (stream) req.pipe(up)
  else up.end(body || undefined)
}

/**
 * Pipe an authenticated WebSocket upgrade to phone-hookd's private socket.
 * Only the headers the handshake needs are forwarded; after that the two
 * sockets are spliced byte for byte (hookd speaks the WebSocket protocol).
 */
export function hookdUpgrade(path, req, socket, head, onError = () => {}) {
  const up = net.connect(socketPath())
  const keep = ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']
  let text = 'GET ' + path + ' HTTP/1.1\r\nHost: hookd.sock\r\n'
  for (const k of keep) {
    if (k === 'sec-websocket-extensions') continue // no compression on audio frames
    const v = req.headers[k]
    if (typeof v === 'string' && !/[\r\n]/.test(v)) text += k + ': ' + v + '\r\n'
  }
  text += '\r\n'
  const fail = (e) => { onError(e); try { socket.destroy() } catch {} try { up.destroy() } catch {} }
  up.once('error', (e) => {
    if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') { try { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n') } catch {} }
    fail(e)
  })
  up.on('connect', () => {
    try { socket.setNoDelay(true) } catch {}
    up.write(text)
    if (head && head.length) up.write(head)
    up.pipe(socket)
    socket.pipe(up)
  })
  socket.on('error', () => { try { up.destroy() } catch {} })
  socket.on('close', () => { try { up.destroy() } catch {} })
  up.on('close', () => { try { socket.destroy() } catch {} })
}
