/**
 * dsh-phone: error shape on the plugin routes, vendored helper copies and the
 * catalog (the ERRORS.md drift test is at the end).
 *   node test/errors.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'phone-errors-'))
process.env.DSH_HOME = join(dir, 'home')
process.env.DSH_PHONE_DATA = join(dir, 'data')
process.env.DSH_PHONE_SOCKET = join(dir, 'missing.sock') // no daemon listens here

const mod = await import('../lib/index.js')
const { E } = await import('../lib/errors.js')
const { E: DE } = await import('../daemon/errors.mjs')

let passed = 0
const t = async (name, fn) => { try { await fn(); passed++; console.log('ok  ', name) } catch (e) { console.error('FAIL', name, '\n', e); process.exitCode = 1 } }
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

// Drive the registered route handler with fake requests.
let handler = null
const ctx = {
  settings: { register: () => ({ get: () => ({ trustedHosts: [] }), update: async () => {} }) },
  webServer: { register: (r) => { handler = r.handler; return () => {} } },
  tools: { register: () => () => {} },
  effect: (fn) => fn(),
}
mod.apply(ctx, {})
await new Promise((r) => setTimeout(r, 200))
assert.ok(handler, 'route registered')

function call({ method = 'GET', url = '/dsh-phone/api/state', headers = {}, remote = '127.0.0.1', body } = {}) {
  return new Promise((resolve) => {
    const req = {
      method, url, headers: { host: 'localhost:3080', ...headers }, socket: { remoteAddress: remote },
      on(ev, fn) { if (ev === 'end') setImmediate(fn); if (ev === 'data' && body) setImmediate(() => fn(Buffer.from(body))) ; return req },
      destroy() {},
    }
    const out = { statusCode: 200, headers: {}, headersSent: false }
    const res = {
      get statusCode() { return out.statusCode }, set statusCode(v) { out.statusCode = v },
      get headersSent() { return out.headersSent },
      setHeader(k, v) { out.headers[k.toLowerCase()] = v },
      writeHead(code, h = {}) { out.statusCode = code; for (const [k, v] of Object.entries(h)) out.headers[k.toLowerCase()] = v; out.headersSent = true },
      end(text) { out.headersSent = true; out.text = text; resolve({ status: out.statusCode, headers: out.headers, body: text ? JSON.parse(text) : null }) },
    }
    handler(req, res)
  })
}
const standard = (b, code, legacy) => {
  assert.equal(b.ok, false); assert.equal(b.code, code); assert.equal(b.error, legacy)
  assert.equal(b.docs, 'docs/ERRORS.md#' + code.toLowerCase())
  assert.ok(b.message && b.hint)
}

await t('plugin route: unknown path keeps 404 and "not found"', async () => {
  const r = await call({ url: '/dsh-phone/api/nope' })
  assert.equal(r.status, 404); standard(r.body, 'PHONE_NOT_FOUND', 'not found')
  assert.equal(r.headers['cache-control'], 'no-store')
})
await t('plugin route: gate refusals keep status and the legacy reason, add the code', async () => {
  let r = await call({ remote: '203.0.113.5' })
  assert.equal(r.status, 403); standard(r.body, 'PHONE_PEER_NOT_LOOPBACK', 'non-loopback peer')
  r = await call({ headers: { host: 'evil.example' } })
  assert.equal(r.status, 403); standard(r.body, 'PHONE_HOST_UNTRUSTED', 'cross-site or untrusted Host')
  r = await call({ method: 'POST', url: '/dsh-phone/api/mode' })
  assert.equal(r.status, 403); assert.equal(r.body.code, 'PHONE_HOST_UNTRUSTED'); assert.equal(r.body.layer, 'L2')
  assert.match(r.body.error, /^sec-fetch-site must be same-origin/)
  // every refusal of the gate carries a catalog code
  const { checkReadRequest, checkMutateRequest } = await import('../lib/security.js')
  const g = checkReadRequest({ method: 'PUT', headers: {}, socket: {} })
  assert.deepEqual([g.status, g.code, g.reason], [405, 'PHONE_METHOD_NOT_ALLOWED', 'read route is GET/HEAD only'])
  const m = checkMutateRequest({ method: 'POST', headers: { host: 'localhost', 'sec-fetch-site': 'same-origin', origin: 'http://localhost', 'content-type': 'text/plain' }, socket: { remoteAddress: '127.0.0.1' } }, { secret: 'x'.repeat(40) })
  assert.deepEqual([m.status, m.code, m.layer], [415, 'PHONE_CONTENT_TYPE_INVALID', 'L2'])
  assert.ok(E.has(g.code) && E.has(m.code))
})
await t('plugin route: daemon down gives 503 with the legacy text and a code', async () => {
  const r = await call({ url: '/dsh-phone/api/state' })
  assert.equal(r.status, 503)
  assert.equal(r.body.code, 'PHONE_HOOKD_UNAVAILABLE')
  assert.equal(r.body.error, 'phone-hookd is not running (systemctl status dsh-phone-hookd)')
  assert.equal(r.body.docs, 'docs/ERRORS.md#phone_hookd_unavailable')
})
await t('plugin route: a coded daemon error passes through; an uncoded one becomes PHONE_HOOKD_ERROR', async () => {
  const http = await import('node:http')
  const fake = http.createServer((req, res) => {
    const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (req.url.startsWith('/state')) send(400, E.body('PHONE_LINE_UNAVAILABLE', { message: 'no enabled line' }))
    else if (req.url.startsWith('/calls')) send(409, { ok: false, error: 'older daemon says no' })
    else send(200, { ok: true })
  })
  await new Promise((r) => fake.listen(process.env.DSH_PHONE_SOCKET, r))
  try {
    let r = await call({ url: '/dsh-phone/api/state' })
    assert.equal(r.status, 400); standard(r.body, 'PHONE_LINE_UNAVAILABLE', 'no enabled line')
    r = await call({ url: '/dsh-phone/api/calls' })
    assert.equal(r.status, 409); standard(r.body, 'PHONE_HOOKD_ERROR', 'older daemon says no')
  } finally { fake.close() }
})
await t('plugin route: a success body is unchanged', async () => {
  const r = await call({ url: '/dsh-phone/api/session' })
  // the secret is created asynchronously; either a token or the 503 shape, never another shape
  if (r.status === 200) assert.deepEqual(Object.keys(r.body).sort(), ['ok', 'token'])
  else standard(r.body, 'PHONE_SECRET_NOT_READY', 'secret not ready')
})

await t('vendored plugin-errors copies are byte-identical (host half and daemon)', () => {
  assert.equal(read('../daemon/plugin-errors.mjs'), read('../lib/plugin-errors.js'))
})
await t('host and daemon catalogs are the same data', () => {
  assert.deepEqual(Object.keys(E.codes), Object.keys(DE.codes))
  for (const c of Object.keys(E.codes)) assert.deepEqual(E.codes[c], DE.codes[c])
  assert.ok(E.has('PHONE_INTERNAL'))
})
await t('scrub masks secrets but leaves legacy reasons readable', () => {
  const b = E.body('PHONE_INTERNAL', { message: 'failed token=abc123 and auth ' + 'a'.repeat(32) + ' capability token: bad signature' })
  assert.ok(!b.message.includes('abc123') && !b.message.includes('a'.repeat(32)))
  assert.match(b.message, /capability token: bad signature/)
})

await t('docs/ERRORS.md documents every code of the catalog (drift)', () => {
  assert.deepEqual(E.missingFromDoc(read('../docs/ERRORS.md')), [])
  assert.deepEqual(DE.missingFromDoc(read('../docs/ERRORS.md')), [])
})
await t('docs: troubleshooting anchors resolve, codes mentioned exist, no em or en dashes', () => {
  const ts = read('../docs/TROUBLESHOOTING.md'), es = read('../docs/ERRORS.md')
  const anchors = new Set([...ts.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]))
  for (const m of ts.matchAll(/^#{1,3} (.+)$/gm)) anchors.add(m[1].toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-'))
  for (const m of es.matchAll(/TROUBLESHOOTING\.md#([a-z0-9-]+)/g)) assert.ok(anchors.has(m[1]), 'ERRORS.md links a missing anchor ' + m[1])
  for (const m of ts.matchAll(/\]\(#([a-z0-9-]+)\)/g)) assert.ok(anchors.has(m[1]), 'TROUBLESHOOTING.md links a missing anchor ' + m[1])
  for (const m of (ts + es + read('../skills/phone-doctor/SKILL.md')).matchAll(/\bPHONE_[A-Z0-9_]+\b/g)) {
    if (/^PHONE_(DISABLE|HOOK_.*)$/.test(m[0])) continue
    assert.ok(E.has(m[0]) || Object.keys(E.codes).some((c) => c.startsWith(m[0])), 'unknown code in the docs: ' + m[0]) // a prefix is a grep pattern
  }
  for (const f of ['../docs/ERRORS.md', '../docs/TROUBLESHOOTING.md', '../skills/phone-doctor/SKILL.md', '../README.md']) {
    assert.ok(!/[\u2013\u2014]/.test(read(f)), 'dash in ' + f)
  }
})
await t('the phone-doctor skill has the frontmatter the loader needs and ships in the package', () => {
  const md = read('../skills/phone-doctor/SKILL.md')
  assert.match(md, /^---\nname: phone-doctor\ndescription: [^\n]+\n---\n/)
  const pkg = JSON.parse(read('../package.json'))
  assert.ok(pkg.files.includes('docs') && pkg.files.includes('skills'))
})

rmSync(dir, { recursive: true, force: true })
console.log(`\nerror tests: ${passed} passed` + (process.exitCode ? ', SOME FAILED' : ''))
process.exit(process.exitCode || 0)
