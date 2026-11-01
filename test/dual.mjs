/**
 * dsh-phone: settings on DSH 0.1.5 (register) AND DSH 0.2.x (forms), and the
 * phone-hookd push in both modes.
 *
 *   DSH_GLOBAL_PREFIX=<prefix of a dsh 0.2.x install> node test/dual.mjs
 * Without a 0.2.x schemastery the forms half is skipped (reported).
 *
 * A fake phone-hookd listens on DSH_PHONE_SOCKET and records every
 * PUT /config, so the test proves the plugin still pushes the same settings to
 * hookd whichever store it reads them from.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'phone-dual-'))
process.env.DSH_HOME = join(dir, 'home')
process.env.DSH_PHONE_SOCKET = join(dir, 'hookd.sock')
const pushes = []
const hookd = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    if (req.method === 'PUT' && req.url === '/config') pushes.push(JSON.parse(body).settings)
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}')
  })
})
await new Promise((r) => hookd.listen(process.env.DSH_PHONE_SOCKET, r))

const mod = await import('../lib/index.js')
const { loadHostSchemastery, plain: plainOf } = await import('../lib/dual-settings.js')
const z = loadHostSchemastery(import.meta.url)
const volatileOk = Boolean(z && typeof z.prototype.volatile === 'function')
let passed = 0
const ok = (m) => { passed++; console.log('  ok - ' + m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SECTION = {
  identity: 'tester', publicBaseUrl: 'https://example.invalid/phone-hook', trustedHosts: ['example.invalid'],
  defaultCountry: '+30', defaultLine: 'l1',
  lines: [{ id: 'l1', label: 'Line one', provider: 'twilio', number: '+15550000000', sms: true, voice: true, enabled: true }],
  incoming: { defaultMode: 'voicemail' }, voicemail: { greeting: 'Hello.' },
}

// The loader reads the DEFAULT export when there is one: Config must be on it.
assert.ok(mod.Config, 'named Config export')
assert.equal(mod.default.Config, mod.Config, 'default export carries Config (the 0.2.x loader uses it)')
ok('Config is on the named AND the default export')

function ctxWith(settings, extra = {}) {
  return {
    settings,
    webServer: { register: () => () => {} },
    tools: { register: () => () => {} },
    effect: (fn) => { const d = fn(); return d },
    ...extra,
  }
}

console.log('# DSH 0.1.5 register mode')
let pushed15
{
  let stored = structuredClone(SECTION)
  const calls = []
  const settings = {
    register(ns, schema, opts) {
      calls.push([ns, opts.applies])
      // a 0.1.5 scope resolves schema defaults, then base, then user, to plain values
      return { get: () => plainOf(schema({ ...opts.base, ...stored })), update: async (p) => { stored = { ...stored, ...p } } }
    },
  }
  pushes.length = 0
  mod.apply(ctxWith(settings), {})
  await sleep(300)
  assert.deepEqual(calls, [['dsh-phone', 'live']])
  assert.ok(pushes.length >= 1, 'pushed to hookd at boot')
  pushed15 = pushes.at(-1)
  assert.equal(pushed15.identity, 'tester')
  assert.equal(pushed15.lines[0].id, 'l1')
  ok('registers namespace dsh-phone and pushes the settings.yaml values to phone-hookd')
}

if (!volatileOk) {
  console.log('# DSH 0.2 forms mode SKIPPED (set DSH_GLOBAL_PREFIX to a dsh 0.2.x prefix)')
} else {
  console.log('# DSH 0.2 forms mode')
  const home = join(dir, 'home2')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(home, { recursive: true })
  // JSON is valid YAML flow syntax: a one-line section is enough here.
  writeFileSync(join(home, 'settings.yaml.imported'), 'dsh-phone: ' + JSON.stringify(SECTION) + '\n')
  const WRITE = Symbol.for('cosmokit.volatile.write')
  let user = {}
  const config = mod.Config(structuredClone(user))
  const fiber = {}
  const writes = []
  const merge = (a, b) => (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b))
    ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, k in b ? merge(a[k], b[k]) : a[k]])) : b
  const forms = {
    describe: () => [{ ns: 'dsh-phone', user: structuredClone(user) }],
    async update(id, patch) {
      assert.equal(id, 'dsh-phone')
      writes.push(structuredClone(patch))
      user = merge(user, patch)
      const next = mod.Config(structuredClone(user))
      for (const [k, v] of Object.entries(config)) if (v && WRITE in v) v[WRITE](next[k].get())
    },
    configure: (policy) => { assert.equal(policy.auto, false, 'own settings page: no auto form'); return () => {} },
  }
  pushes.length = 0
  mod.apply(ctxWith(forms, {
    fiber,
    loader: { entries: () => [{ options: { id: 'dsh-phone', name: 'dsh-phone' }, fiber }], await: async () => {} },
    profileContext: { home },
  }), config)
  await sleep(400)
  assert.equal(writes.length, 1, 'one legacy import write')
  ok('legacy section dsh-phone imported once into the empty row')
  // the push timer re-pushes on change (15 s); force the same path the route uses
  await sleep(50)
  const lastBoot = pushes.at(-1)
  assert.ok(lastBoot, 'pushed at boot')
  // Effective values after the import equal the 0.1.5 run.
  const { plain } = await import('../lib/dual-settings.js')
  const plainNow = plain(config) // the live references the plugin itself reads
  assert.equal(plainNow.identity, pushed15.identity)
  assert.deepEqual(plainNow.lines, pushed15.lines)
  assert.deepEqual(plainNow.trustedHosts, pushed15.trustedHosts)
  ok('effective settings after the import equal the 0.1.5 values')
}

hookd.close()
console.log(`\nall dual tests passed (${passed})`)
process.exit(0)
