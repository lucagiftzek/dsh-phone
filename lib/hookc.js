/**
 * dsh-phone: client for phone-hookd's private unix-socket API.
 * Used by the DSH host half (routes + agent tools). Never exposed directly.
 */

import http from 'node:http'
import { socketPath } from '../daemon/config.mjs'

export class HookdError extends Error {
  constructor(message, status) { super(message); this.status = status }
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
        if (res.statusCode >= 400 || (json && json.ok === false)) reject(new HookdError((json && json.error) || ('hookd HTTP ' + res.statusCode), res.statusCode))
        else resolve(json)
      })
    })
    req.on('timeout', () => req.destroy(new HookdError('phone-hookd did not answer in time', 504)))
    req.on('error', (e) => reject(new HookdError(e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
      ? 'phone-hookd is not running (systemctl status dsh-phone-hookd)'
      : 'phone-hookd: ' + e.message, 503)))
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
      if (!res.headersSent) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'phone-hookd unavailable: ' + e.message })) } else res.end()
    } catch {}
  })
  req.on('close', () => up.destroy())
  up.end()
}
