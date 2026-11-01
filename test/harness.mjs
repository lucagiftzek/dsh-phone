/**
 * Manual / headless end-to-end harness for the server audio route (not shipped).
 *
 *   node test/harness.mjs [port]
 *
 * Serves a loopback page that runs the REAL browser engine (src/server-audio.js)
 * against the REAL running phone-hookd: tickets come from hookd's private API,
 * the socket upgrade goes through the REAL plugin gate (lib/security.js
 * checkAudioUpgrade) and pipe (lib/hookc.js hookdUpgrade). Loopback host only,
 * so the socket is plain ws here and never leaves the machine.
 * The page exposes window.harness = { test(), dial(to, line), hangup(), snap() }.
 */
import http from 'node:http'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { checkAudioUpgrade, harnessCookieName } from '../lib/security.js'
import { hookd, hookdUpgrade } from '../lib/hookc.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const port = Number(process.argv[2] || 3399)
const entry = `
import { ServerCall } from ${JSON.stringify(join(HERE, '..', 'src', 'server-audio.js'))}
const apiPost = async (path, body) => {
  const r = await fetch('/dsh-phone/api' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json()
  if (!r.ok || j.ok === false) throw new Error(j.error || j.message || ('HTTP ' + r.status))
  return j
}
let call = null
const calls = {}
const log = []
window.harness = {
  log,
  async start(params, name = 'a') {
    call = calls[name] = new ServerCall(params, { apiPost, socketPath: '/dsh-phone/api/io', packetMs: 40 })
    for (const ev of ['accept', 'ringing', 'disconnect', 'error', 'state', 'reconnecting', 'resumed']) call.on(ev, (a) => log.push({ name, ev, a: a && a.message ? a.message : a, t: Math.round(performance.now()) }))
    await call.start()
    return true
  },
  test() { return this.start({ purpose: 'test' }) },
  dial(to, line) { return this.start({ purpose: 'dial', to, line }) },
  hangup(name) { const c = name ? calls[name] : call; if (c) c.disconnect() },
  pickup(vmId) { return this.start({ purpose: 'pickup', vmId }, 'b') },
  snapOf(name) { const c = calls[name]; return c ? { ...c.snapshot(), ended: c.ended, endReason: c.endReason || null } : null },
  key(d) { if (call) call.sendDigits(d) },
  snap() { return call ? { ...call.snapshot(), ended: call.ended, endReason: call.endReason || null } : null },
}
`
const bundle = (await build({ stdin: { contents: entry, resolveDir: HERE, loader: 'js' }, bundle: true, write: false, format: 'iife', platform: 'browser' })).outputFiles[0].text

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || ''
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': harnessCookieName(host) + '=harness; Path=/; SameSite=Strict' })
    res.end('<!doctype html><meta charset="utf-8"><title>dsh-phone audio harness</title><script src="/bundle.js"></script><p>dsh-phone audio harness</p>')
    return
  }
  if (req.url === '/bundle.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle); return }
  if (req.method === 'POST' && req.url === '/dsh-phone/api/audio/ticket') {
    let b = ''; req.on('data', c => { b += c }); req.on('end', async () => {
      try { const out = await hookd('POST', '/audio/ticket', JSON.parse(b || '{}')); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)) }
      catch (e) { res.writeHead(e.status || 400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message, code: e.code })) }
    })
    return
  }
  res.writeHead(404); res.end()
})
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {})
  if (req.url !== '/dsh-phone/api/io') { socket.destroy(); return }
  const g = checkAudioUpgrade(req, { trustedHosts: [], requireHarnessCookie: true })
  if (!g.ok) { socket.end('HTTP/1.1 ' + g.status + ' Refused\r\nContent-Length: 0\r\n\r\n'); console.error('refused', g.code); return }
  hookdUpgrade('/audio/io', req, socket, head, (e) => console.error('pipe', e.message))
})
server.listen(port, '127.0.0.1', () => console.log('harness on http://127.0.0.1:' + port + '/'))
