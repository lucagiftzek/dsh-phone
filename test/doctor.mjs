/**
 * dsh-phone: skill registration, agent tool failure shape and the doctor.
 *   node test/doctor.mjs
 *   DSH_GLOBAL_PREFIX=<prefix of a dsh 0.2.x install> node test/doctor.mjs   (also runs against the real skill registry)
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'phone-doctor-'))
process.env.DSH_HOME = join(dir, 'home')
process.env.DSH_PHONE_DATA = join(dir, 'data')
process.env.DSH_PHONE_SOCKET = join(dir, 'missing.sock') // no daemon listens here

const mod = await import('../lib/index.js')
const { E } = await import('../lib/errors.js')

let passed = 0
const t = async (name, fn) => { try { await fn(); passed++; console.log('ok  ', name) } catch (e) { console.error('FAIL', name, '\n', e); process.exitCode = 1 } }

// ------------------------------------------------------------ skill registration

await t('apply registers the packaged phone-doctor skill through ctx.inject(["skills"])', async () => {
  let provider = null
  const ctx = {
    inject(deps, cb) { assert.deepEqual(deps, ['skills']); cb({ skills: { registerProvider(f) { provider = f() } } }) },
    settings: { register: () => ({ get: () => ({}), update: async () => {} }) },
    webServer: { register: () => () => {} },
    tools: { register: () => () => {} },
    effect: (fn) => fn(),
  }
  mod.apply(ctx, {})
  assert.ok(provider, 'a skill provider was registered')
  assert.equal(provider.name, 'plugin-dsh-phone')
  const list = await provider.list()
  assert.deepEqual(list.map((s) => s.name), ['phone-doctor'])
  const def = await provider.get(list[0], {})
  assert.match(def.content, /dsh-phone doctor/)
})

const PREFIX = process.env.DSH_GLOBAL_PREFIX
await t('the real skill registry lists and loads phone-doctor' + (PREFIX ? '' : ' (skipped: DSH_GLOBAL_PREFIX not set)'), async () => {
  if (!PREFIX) return
  const N = join(PREFIX, 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  const { Context } = await import(join(N, 'cordis/lib/index.js'))
  const sk = await import(join(N, 'dsh-skill/lib/index.js'))
  const { registerPluginSkills } = await import('../lib/plugin-skills.js')
  const root = new Context()
  await root.plugin({ name: 'phone-skill-probe', apply(ctx) { registerPluginSkills(ctx, { plugin: 'dsh-phone', dir: new URL('../skills/', import.meta.url) }) } })
  await root.plugin(sk.SkillRegistry ?? sk.default)
  await new Promise((r) => setTimeout(r, 100))
  const list = await root.skills.list({})
  assert.ok(list.some((s) => s.name === 'phone-doctor' && s.provider === 'plugin-dsh-phone'))
  assert.match((await root.skills.get('phone-doctor', {})).content, /dsh-phone doctor/)
})

await t('vendored plugin-skills.js is byte-identical to the shared source', () => {
  const shared = process.env.DSH_SHARED_PLUGIN_SKILLS || ''
  if (!shared) return // set DSH_SHARED_PLUGIN_SKILLS to the shared source to compare against it
  try { readFileSync(shared) } catch { return }
  assert.equal(readFileSync(new URL('../lib/plugin-skills.js', import.meta.url), 'utf8'), readFileSync(shared, 'utf8'))
})

// ------------------------------------------------------------ agent tool failure shape

const { resolveSettings } = await import('../daemon/config.mjs')
const TOOL_LINES = [{ id: 'main', label: 'Main', provider: 'twilio', number: '+15550100', sms: true, voice: true, enabled: true }]
function loadTools(raw) {
  const tools = {}
  const ctx = { tools: { register: (d) => { tools[d.name] = d; return () => {} } } }
  mod.registerTools(ctx, (d) => d, () => resolveSettings(raw))
  return tools
}
const noExtra = (tool, r) => {
  const allowed = Object.keys(tool.output.schema.properties)
  for (const k of Object.keys(r)) assert.ok(allowed.includes(k), 'field not in the output schema: ' + k)
}
const failed = (r, code, error, text) => {
  assert.equal(r.ok, false); assert.equal(r.code, code); assert.equal(r.error, error); assert.equal(r.text, text)
  assert.equal(r.docs, 'docs/ERRORS.md#' + code.toLowerCase()); assert.ok(r.message && r.hint)
}

await t('tool output schema declares code, message, hint and docs', () => {
  const tools = loadTools({ lines: TOOL_LINES, defaultLine: 'main' })
  assert.equal(Object.keys(tools).length, 17)
  for (const d of Object.values(tools)) {
    assert.equal(d.output.schema.additionalProperties, false)
    for (const k of ['code', 'message', 'hint', 'docs']) assert.equal(d.output.schema.properties[k].type, 'string')
  }
})
await t('tool failure: daemon down keeps error and text, adds the code', async () => {
  const tools = loadTools({ lines: TOOL_LINES, defaultLine: 'main' })
  const legacy = 'phone-hookd is not running (systemctl status dsh-phone-hookd)'
  for (const [name, args] of [['phone_status', {}], ['phone_calls', {}], ['phone_sms_threads', {}], ['phone_set_mode', { mode: 'dnd' }]]) {
    const r = await tools[name].execute(args)
    failed(r, 'PHONE_HOOKD_UNAVAILABLE', legacy, 'Phone error: ' + legacy)
    noExtra(tools[name], r)
  }
})
await t('tool failure: agent switches off give PHONE_AGENT_ACTION_DISABLED with the old text', async () => {
  const tools = loadTools({ lines: TOOL_LINES, defaultLine: 'main', agent: { allowSms: false, allowCalls: false, allowModeChange: false } })
  const cases = [
    ['phone_set_mode', { mode: 'dnd' }, 'Changing the phone mode from an agent is disabled in Settings > Phone.'],
    ['phone_sms_send', { to: '+15550123', text: 'hi' }, 'Sending SMS from an agent is disabled in Settings > Phone.'],
    ['phone_call_say', { to: '+15550123', text: 'hi' }, 'Placing calls from an agent is disabled in Settings > Phone.'],
  ]
  for (const [name, args, text] of cases) {
    const r = await tools[name].execute(args)
    failed(r, 'PHONE_AGENT_ACTION_DISABLED', text, text); noExtra(tools[name], r)
  }
})
await t('tool failure: bad number, empty text and unknown line', async () => {
  const tools = loadTools({ lines: TOOL_LINES, defaultLine: 'main' })
  let r = await tools.phone_sms_send.execute({ to: 'abc', text: 'hi' })
  failed(r, 'PHONE_NUMBER_INVALID', 'Not a valid phone number: abc', 'Not a valid phone number: abc')
  r = await tools.phone_sms_send.execute({ to: '+15550123', text: '  ' })
  failed(r, 'PHONE_MESSAGE_INVALID', 'The message is empty.', 'The message is empty.')
  r = await tools.phone_sms_send.execute({ to: '+15550123', text: 'hi', line: 'nope' })
  failed(r, 'PHONE_LINE_UNAVAILABLE', 'No such line: nope', 'No such line: nope')
  r = await tools.phone_call_say.execute({ to: '+15550123', text: '' })
  failed(r, 'PHONE_MESSAGE_INVALID', 'Nothing to say.', 'Nothing to say.')
  for (const x of [r]) noExtra(tools.phone_call_say, x)
})
await t('tool success results are unchanged (draft keeps ok, drafted, text only)', async () => {
  const tools = loadTools({ lines: TOOL_LINES, defaultLine: 'main' })
  const r = await tools.phone_sms_send.execute({ to: '+15550123', text: 'hello' })
  assert.deepEqual(Object.keys(r).sort(), ['drafted', 'ok', 'text'])
  assert.equal(r.ok, true)
})
await t('a daemon error without a code becomes PHONE_HOOKD_ERROR in a tool result, other throws PHONE_INTERNAL', async () => {
  const http = await import('node:http')
  const fake = http.createServer((req, res) => { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'older daemon says no' })) })
  await new Promise((r) => fake.listen(process.env.DSH_PHONE_SOCKET, r))
  try {
    const tools = loadTools({ lines: TOOL_LINES, defaultLine: 'main' })
    failed(await tools.phone_status.execute({}), 'PHONE_HOOKD_ERROR', 'older daemon says no', 'Phone error: older daemon says no')
  } finally { fake.close() }
  const boom = {}
  mod.registerTools({ tools: { register: (d) => { boom[d.name] = d; return () => {} } } }, (d) => d, () => { throw new TypeError('settings exploded') })
  failed(await boom.phone_set_mode.execute({ mode: 'dnd' }), 'PHONE_INTERNAL', 'settings exploded', 'Phone error: settings exploded')
})

// ------------------------------------------------------------ doctor

const { phoneDoctor, renderDoctor } = await import('../lib/doctor.js')
const SECRET = 'S3cr3tPlantedValue' + 'x'.repeat(8)
const FAKE_SID = 'AC' + 'a1'.repeat(16)
const FAKE_URL = 'https://hooks.fake-host.example/phone-hook'
const FAKE_NUMBER = '+15550199'
const planted = [SECRET, FAKE_SID, FAKE_URL, 'hooks.fake-host.example', FAKE_NUMBER]

const RAW = {
  publicBaseUrl: FAKE_URL,
  twilio: { accountSid: FAKE_SID, authToken: SECRET, apiKeySecret: SECRET },
  lines: [{ id: 'main', provider: 'twilio', number: FAKE_NUMBER }, { id: 'office', provider: 'sip', number: '+15550188' }],
  sipAccounts: [{ id: 'a1', enabled: true, line: 'office', password: SECRET, registrar: 'sip.fake-host.example' }, { id: 'a2', enabled: false, password: SECRET }],
}
const DAEMON_STATE = {
  ok: true, mode: 'live', relay: { state: 'ok', errors: [], restartNeeded: false },
  credentials: {
    accountSid: { set: true, source: 'settings', hint: FAKE_SID.slice(0, 6) + '...' + FAKE_SID.slice(-4) },
    authToken: { set: true, source: 'file' }, apiKeySid: { set: true, source: 'provisioned' },
    apiKeySecret: { set: true, source: 'provisioned' }, twimlAppSid: { set: true, source: 'provisioned' },
  },
  sipAccounts: [{ id: 'a1', enabled: true, issues: [], warnings: [] }, { id: 'a2', enabled: false, issues: ['password missing ' + SECRET], warnings: [] }],
}
function fakeHookd(over = {}) {
  const routes = {
    '/health': { ok: true, version: '0.1.0', uptime: 42 },
    '/state': DAEMON_STATE,
    '/relay/status': { ok: true, relay: { registrations: [{ name: 'a1', status: 'Registered', serverUri: FAKE_URL }], error: '' } },
    ...over,
  }
  const calls = []
  const fn = async (method, path, _b, opts) => {
    calls.push(method + ' ' + path + ' ' + (opts && opts.timeoutMs))
    const r = routes[path]
    if (r instanceof Error) throw r
    return r
  }
  fn.calls = calls
  return fn
}
const fakeStore = (writable = true) => ({ describeStore: () => ({ mode: 'register', entryId: null }), writable: () => writable })
const run = (raw, hookd, extra = {}) => phoneDoctor({ ctx: {}, store: fakeStore(), settings: () => resolveSettings(raw), version: '0.1.0', configVisible: true, hookd, ...extra })
const byId = (r, id) => r.checks.find((c) => c.id === id)

await t('doctor: healthy install reports ok, no secret, number, url or id anywhere', async () => {
  const hk = fakeHookd()
  const r = await run(RAW, hk)
  assert.equal(r.plugin, 'dsh-phone'); assert.equal(r.version, '0.1.0'); assert.equal(r.status, 'ok')
  assert.ok(r.host && r.generatedAt && r.docs === 'docs/TROUBLESHOOTING.md')
  const json = JSON.stringify(r) + renderDoctor(r)
  for (const p of planted) assert.ok(!json.includes(p), 'leaked: ' + p.slice(0, 6))
  assert.equal(byId(r, 'lines').detail, '2 configured, 2 enabled (twilio 1, sip 1)')
  assert.equal(byId(r, 'public_url').status, 'ok')
  assert.match(byId(r, 'provider').detail, /accountSid set \(settings\), authToken set \(file\)/)
  assert.equal(byId(r, 'sip_accounts').detail, '2 accounts, 1 enabled, 0 with issues')
  assert.equal(byId(r, 'sip_registration').detail, '1 of 1 registered')
  assert.equal(byId(r, 'relay_config').status, 'ok')
  assert.match(byId(r, 'hookd').detail, /reachable, version 0.1.0, up 42 s, mode live/)
  // short timeouts, GET only, no provider route
  assert.ok(hk.calls.every((c) => c.startsWith('GET /health') || c.startsWith('GET /state') || c.startsWith('GET /relay/status')), hk.calls.join(','))
  assert.ok(hk.calls.every((c) => Number(c.split(' ').pop()) <= 6000))
})
await t('doctor: daemon down is one failing check with a code, dependent checks are skipped', async () => {
  const down = E.raise('PHONE_HOOKD_UNAVAILABLE')
  const r = await run(RAW, fakeHookd({ '/health': down }))
  assert.equal(r.status, 'fail')
  const h = byId(r, 'hookd')
  assert.equal(h.status, 'fail'); assert.equal(h.code, 'PHONE_HOOKD_UNAVAILABLE'); assert.equal(h.docs, 'docs/ERRORS.md#phone_hookd_unavailable'); assert.equal(h.human, true)
  for (const id of ['provider', 'relay_config', 'sip_registration']) assert.equal(byId(r, id).status, 'skip', id)
  for (const p of planted) assert.ok(!JSON.stringify(r).includes(p))
})
await t('doctor: a timeout is reported with its own code', async () => {
  const r = await run(RAW, fakeHookd({ '/health': E.raise('PHONE_HOOKD_TIMEOUT') }))
  assert.equal(byId(r, 'hookd').code, 'PHONE_HOOKD_TIMEOUT')
})
await t('doctor: an empty install warns on lines, provider and public URL with catalog codes', async () => {
  const emptyState = { ...DAEMON_STATE, credentials: { ...DAEMON_STATE.credentials, accountSid: { set: false, source: '' }, authToken: { set: false, source: '' } } }
  let r = await run({}, fakeHookd({ '/state': emptyState }))
  assert.equal(r.status, 'warn')
  assert.equal(byId(r, 'lines').code, 'PHONE_LINE_UNAVAILABLE')
  assert.equal(byId(r, 'provider').status, 'skip') // no Twilio line yet
  r = await run({ lines: [{ id: 'main', provider: 'twilio', number: FAKE_NUMBER }] }, fakeHookd({ '/state': emptyState }))
  assert.equal(byId(r, 'provider').code, 'PHONE_PROVIDER_NOT_CONFIGURED'); assert.equal(byId(r, 'provider').human, true)
  assert.equal(byId(r, 'public_url').code, 'PHONE_PUBLIC_URL_MISSING')
  for (const c of r.checks) if (c.code) assert.ok(E.has(c.code) && c.docs && c.hint, c.id)
  r = await run({ lines: RAW.lines.slice(0, 1), publicBaseUrl: 'http://plain.example/x' }, fakeHookd())
  assert.equal(byId(r, 'public_url').status, 'warn')
})
await t('doctor: relay errors, restart needed and unregistered accounts are visible without leaking detail', async () => {
  let r = await run(RAW, fakeHookd({ '/state': { ...DAEMON_STATE, relay: { state: 'error', errors: ['cannot write /etc/x ' + SECRET], restartNeeded: false } } }))
  assert.equal(byId(r, 'relay_config').status, 'fail'); assert.equal(byId(r, 'relay_config').code, 'PHONE_RELAY_SYNC_FAILED')
  assert.ok(!JSON.stringify(r).includes(SECRET) && !JSON.stringify(r).includes('/etc/x'))
  r = await run(RAW, fakeHookd({ '/state': { ...DAEMON_STATE, relay: { state: 'ok', errors: [], restartNeeded: true } } }))
  assert.equal(byId(r, 'relay_config').status, 'warn')
  r = await run(RAW, fakeHookd({ '/relay/status': { ok: true, relay: { registrations: [{ status: 'Rejected' }], error: '' } } }))
  assert.equal(byId(r, 'sip_registration').detail, '0 of 1 registered'); assert.equal(byId(r, 'sip_registration').status, 'warn')
  r = await run(RAW, fakeHookd({ '/relay/status': { ok: true, relay: { registrations: null, error: 'AMI: refused ' + SECRET } } }))
  assert.equal(byId(r, 'sip_registration').code, 'PHONE_RELAY_AMI_FAILED'); assert.ok(!JSON.stringify(r).includes(SECRET))
  r = await run(RAW, fakeHookd({ '/state': { ...DAEMON_STATE, sipAccounts: [{ id: 'a1', enabled: true, issues: ['no registrar'], warnings: [] }] } }))
  assert.equal(byId(r, 'sip_accounts').status, 'warn')
})
await t('doctor: Config check depends on the settings mode; read-only settings warn', async () => {
  const forms = { settings: { update() {}, describe() {} } }
  let r = await phoneDoctor({ ctx: forms, store: fakeStore(false), settings: () => resolveSettings(RAW), version: '0.1.0', configVisible: false, hookd: fakeHookd() })
  assert.equal(byId(r, 'config').status, 'fail'); assert.equal(byId(r, 'config').code, 'PHONE_SETTINGS_UNAVAILABLE')
  assert.equal(byId(r, 'settings').status, 'warn')
  r = await phoneDoctor({ ctx: forms, store: fakeStore(), settings: () => resolveSettings(RAW), version: '0.1.0', configVisible: true, hookd: fakeHookd() })
  assert.equal(byId(r, 'config').status, 'ok')
  r = await run(RAW, fakeHookd())
  assert.equal(byId(r, 'config').status, 'skip')
})
await t('doctor never throws: broken settings and store still give a report', async () => {
  const r = await phoneDoctor({ ctx: null, store: { describeStore() { throw new Error('boom') }, writable() { throw new Error('boom') } }, settings: () => { throw new Error('boom') }, version: '0.1.0', configVisible: true, hookd: fakeHookd({ '/health': new Error('x') }) })
  assert.ok(['ok', 'warn', 'fail'].includes(r.status)); assert.equal(byId(r, 'settings').status, 'fail')
})

// ---- route
{
  const http = await import('node:http')
  let handler = null
  const rctx = {
    settings: { register: () => ({ get: () => RAW, update: async () => {} }) },
    webServer: { register: (r) => { handler = r.handler; return () => {} } },
    tools: { register: () => () => {} },
    effect: (fn) => fn(),
  }
  mod.apply(rctx, {})
  const call = ({ method = 'GET', url = '/dsh-phone/api/doctor', headers = {}, remote = '127.0.0.1' } = {}) => new Promise((resolve) => {
    const req = { method, url, headers: { host: 'localhost:3080', ...headers }, socket: { remoteAddress: remote }, on(ev, fn) { if (ev === 'end') setImmediate(fn); return req }, destroy() {} }
    const out = { statusCode: 200, headers: {}, headersSent: false }
    const res = {
      get statusCode() { return out.statusCode }, set statusCode(v) { out.statusCode = v },
      get headersSent() { return out.headersSent },
      setHeader(k, v) { out.headers[k.toLowerCase()] = v },
      writeHead(code, h = {}) { out.statusCode = code; for (const [k, v] of Object.entries(h)) out.headers[k.toLowerCase()] = v; out.headersSent = true },
      end(text) { out.headersSent = true; resolve({ status: out.statusCode, headers: out.headers, body: text ? JSON.parse(text) : null }) },
    }
    handler(req, res)
  })
  await t('route: GET /doctor sits behind the read gate (same refusals as /state)', async () => {
    let r = await call({ remote: '203.0.113.5' })
    assert.equal(r.status, 403); assert.equal(r.body.code, 'PHONE_PEER_NOT_LOOPBACK'); assert.equal(r.body.docs, 'docs/ERRORS.md#phone_peer_not_loopback')
    r = await call({ headers: { host: 'evil.example' } })
    assert.equal(r.status, 403); assert.equal(r.body.code, 'PHONE_HOST_UNTRUSTED')
    // the doctor is read-only: other methods fall through to PHONE_NOT_FOUND, like the other read routes
    for (const method of ['PUT', 'POST', 'DELETE']) {
      r = await call({ method })
      assert.equal(r.status, 404); assert.equal(r.body.code, 'PHONE_NOT_FOUND')
    }
  })
  await t('route: GET /doctor with the daemon down answers 200 with a failing hookd check', async () => {
    const r = await call()
    assert.equal(r.status, 200)
    assert.equal(r.headers['cache-control'], 'no-store')
    assert.match(r.headers['content-type'], /json/)
    assert.equal(r.body.plugin, 'dsh-phone'); assert.equal(r.body.status, 'fail')
    assert.equal(r.body.checks.find((c) => c.id === 'hookd').code, 'PHONE_HOOKD_UNAVAILABLE')
    for (const p of planted) assert.ok(!JSON.stringify(r.body).includes(p))
  })
  await t('route: GET /doctor with a daemon answering is ok and leaks nothing', async () => {
    const fake = http.createServer((req, res) => {
      const p = req.url.split('?')[0]
      const body = p === '/health' ? { ok: true, version: '0.1.0', uptime: 5 } : p === '/state' ? DAEMON_STATE : p === '/relay/status' ? { ok: true, relay: { registrations: [{ status: 'Registered' }], error: '' } } : { ok: true }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body))
    })
    await new Promise((r) => fake.listen(process.env.DSH_PHONE_SOCKET, r))
    try {
      const r = await call()
      assert.equal(r.status, 200); assert.equal(r.body.status, 'ok')
      for (const p of planted) assert.ok(!JSON.stringify(r.body).includes(p))
    } finally { fake.close() }
  })
}

// ---- tool
await t('tool phone_doctor: read-only, result fits the output schema, no secret', async () => {
  const tools = {}
  const raw = RAW
  mod.registerTools({ tools: { register: (d) => { tools[d.name] = d; return () => {} } } }, (d) => d, () => resolveSettings(raw), { doctor: () => run(raw, fakeHookd()) })
  assert.equal(Object.keys(tools).length, 18)
  const r = await tools.phone_doctor.execute({})
  assert.equal(r.ok, true); assert.equal(r.status, 'ok'); assert.equal(r.report.plugin, 'dsh-phone')
  assert.match(r.text, /^dsh-phone doctor: OK/)
  noExtra(tools.phone_doctor, r)
  for (const p of planted) assert.ok(!JSON.stringify(r).includes(p))
  assert.deepEqual(tools.phone_doctor.parameters, {})
  // a doctor that throws still returns the standard failure shape
  const bad = {}
  mod.registerTools({ tools: { register: (d) => { bad[d.name] = d; return () => {} } } }, (d) => d, () => resolveSettings(raw), { doctor: async () => { throw new Error('nope') } })
  failed(await bad.phone_doctor.execute({}), 'PHONE_INTERNAL', 'nope', 'Phone error: nope')
})
await t('real harness tool runtime accepts every tool result' + (PREFIX ? '' : ' (skipped: DSH_GLOBAL_PREFIX not set)'), async () => {
  if (!PREFIX) return
  const N = join(PREFIX, 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  const tools = await import(join(N, 'dsh-tools/lib/index.js'))
  const reg = {}
  mod.registerTools({ tools: { register: (d) => { reg[d.name] = d; return () => {} } } }, tools.defineTool, () => resolveSettings({ lines: TOOL_LINES, defaultLine: 'main', agent: { allowSms: false } }), { doctor: () => run(RAW, fakeHookd()) })
  const check = async (name, args) => {
    const r = await reg[name].execute(args)
    const v = tools.validateJsonSchemaValue(reg[name].output.schema, JSON.parse(JSON.stringify(r)), 'value')
    assert.deepEqual(v, [], name + ': ' + v.join('; '))
  }
  await check('phone_doctor', {})
  await check('phone_status', {}) // failure shape (daemon down)
  await check('phone_sms_send', { to: '+15550123', text: 'hi' }) // agent switch off
  await check('phone_sms_threads', {})
})


// ------------------------------------------------------------ DSH 0.2.1: every tool result is lossless JSON

const { assertLossless } = await import('./lossless-check.mjs')
const ALL_ARGS = {
  phone_status: [{}], phone_doctor: [{}], phone_set_mode: [{ mode: 'dnd' }, { mode: '' }, {}],
  phone_sms_threads: [{}, { q: 'x', limit: 5 }], phone_sms_thread: [{ peer: '+15550123' }, { peer: '+15550123', markRead: true }, {}],
  phone_sms_send: [{ to: '+15550123', text: 'hi' }, { to: '+15550123', text: 'hi', confirm: true }, { to: 'abc', text: 'x' }, { to: '+15550123', text: '' }, { to: '+15550123', text: 'x', line: 'nope' }],
  phone_calls: [{}, { limit: 3 }], phone_voicemails: [{}, { markRead: true }],
  phone_contacts: [{}, { q: 'x' }, { save: { number: '+15550123', name: 'A' } }],
  phone_call_say: [{ to: '+15550123', text: 'hi' }, { to: '+15550123', text: 'hi', confirm: true }, { to: 'abc', text: 'x' }, { to: '+15550123', text: '' }],
  telegram_status: [{}], telegram_chats: [{}, { q: 'x', kind: 'channel', refresh: true, archived: true }],
  telegram_read: [{ chat: '42' }, { chat: '@a', markRead: true }, {}], telegram_send: [{ chat: '42', text: 'hi' }, { chat: 'A', text: '' }],
  telegram_channel_post: [{ chat: '42', text: 'hi' }], telegram_send_media: [{ chat: '42', file: '/nope' }],
  telegram_call: [{ action: 'place', chat: '42' }, { action: 'x' }, { action: 'status' }, { action: 'hangup' }], telegram_bot_notify: [{ text: 'hi' }],
}
async function sweepTools(raw, doctor) {
  const tools = {}
  mod.registerTools({ tools: { register: (d) => { tools[d.name] = d; return () => {} } } }, (d) => d, () => resolveSettings(raw), { doctor })
  assert.deepEqual(Object.keys(tools).sort(), Object.keys(ALL_ARGS).sort(), 'every tool is covered')
  for (const [name, list] of Object.entries(ALL_ARGS)) for (const args of list) {
    await assertLossless(await tools[name].execute(args), name + '(' + JSON.stringify(args) + ')')
  }
}
await t('lossless: every tool, daemon down, doctor failing, doctor with undefined fields', async () => {
  const ok = { lines: TOOL_LINES, defaultLine: 'main' }
  await sweepTools(ok, () => run(RAW, fakeHookd()))
  await sweepTools(ok, async () => { throw new Error('nope') })
  await sweepTools(ok, async () => { throw Object.assign(new Error('with undefined body'), { code: 'PHONE_HOOKD_ERROR', hint: undefined, docs: undefined, body: { ok: false, error: 'x', code: 'PHONE_HOOKD_ERROR', hint: undefined } }) })
  await sweepTools(ok, async () => ({ plugin: 'dsh-phone', status: 'ok', checks: [{ id: 'a', label: 'a', status: 'ok', detail: undefined }], host: undefined, n: NaN }))
  await sweepTools({ ...ok, agent: { allowSms: false, allowCalls: false, allowModeChange: false } }, () => run(RAW, fakeHookd()))
  await sweepTools({ lines: [], defaultLine: '' }, () => run({}, fakeHookd({ '/state': new Error('down') })))
})
await t('lossless: every tool against a live daemon answering with sparse, null-heavy JSON', async () => {
  const http = await import('node:http')
  const state = { ok: true, mode: 'live', browserOnline: false, lines: [{ id: 'main', number: '+15550100', label: 'Main', provider: 'twilio', sms: true, voice: true }], counts: { sms: 1, voicemail: 0, missed: 0 }, issues: [] }
  const msg = { ts: 1, peer: '+15550123', direction: 'in', body: 'hi', media: [], status: null, error: null }
  const routes = {
    '/state': state, '/balance': { ok: true, balance: 1.5, currency: 'EUR' }, '/mode': { ok: true, mode: 'dnd' },
    '/threads': { ok: true, threads: [{ peer: '+15550123', name: null, line: 'main', ts: 1, unread: 0, last: { direction: 'in', body: '', hasMedia: true } }] },
    '/thread': { ok: true, line: 'main', peer: '+15550123', contact: null, messages: [msg] }, '/thread/read': { ok: true },
    '/sms/send': { ok: true, message: { status: 'queued' } },
    '/calls': { ok: true, calls: [{ started: 0, direction: 'out', peer: '+15550123', name: null, status: 'ringing', disposition: null, duration: 0, origin: 'agent' }] },
    '/voicemails': { ok: true, voicemails: [{ id: 1, ts: 1, peer: '+15550123', name: null, duration: 3, status: 'new', pickedUp: false, read: false, transcript: null, liveText: null }] }, '/voicemail/read': { ok: true },
    '/contacts': { ok: true, contacts: [{ number: '+15550123', name: null, starred: false, blocked: false }] }, '/contacts/save': { ok: true, contact: { number: '+15550123', name: 'A' } },
    '/call/say': { ok: true, call: { sid: 'CA0123456789abcdef' } },
    '/tg/status': { ok: true, daemon: true, auth: { state: 'ready', connected: true, me: null }, agent: { enabled: true, limits: null, tripped: null }, counts: { unread: null, chats: 0 } },
    '/tg/chats': { ok: true, chats: [{ id: 42, kind: 'user', title: 'A', username: null, last: { date: 1, text: null, out: false }, unread: 0 }], counts: {} },
    '/tg/chat': { ok: true, chat: { id: 42, kind: 'user', title: 'A', username: null } },
    '/tg/messages': { ok: true, chat: null, warning: null, messages: [{ chat: 42, id: 1, date: 1, out: false, text: null, fromName: null, media: { kind: 'photo', name: null, duration: null } }] },
    '/tg/send': { ok: true, message: { id: 5, chat: 42 } }, '/tg/read': { ok: true, marked: null }, '/tg/send_media': { ok: true, message: { id: 6, media: null } },
    '/tg/call/place': { ok: false, code: 'TELEGRAM_CALLS_UNAVAILABLE', error: 'later' }, '/tg/call/status': { ok: true, call: { callId: null, state: null, title: null } }, '/tg/call/hangup': { ok: true, state: null }, '/tg/bot/notify': { ok: true, messageId: null },
  }
  const fake = http.createServer((req, res) => { const p = req.url.split('?')[0]; const r = routes[p]; res.writeHead(r ? 200 : 404, { 'content-type': 'application/json' }); res.end(JSON.stringify(r || { ok: false, error: 'not found' })); req.resume() })
  await new Promise((r) => fake.listen(process.env.DSH_PHONE_SOCKET, r))
  try {
    await sweepTools({ lines: TOOL_LINES, defaultLine: 'main', agent: { allowSms: true, allowCalls: true, allowModeChange: true } }, () => run(RAW, fakeHookd()))
  } finally { fake.close() }
})

// ------------------------------------------------------------ docs

await t('docs describe the real doctor route and tool, not a planned one', () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
  for (const f of ['../README.md', '../docs/ERRORS.md', '../docs/TROUBLESHOOTING.md', '../skills/phone-doctor/SKILL.md']) {
    const text = read(f)
    assert.ok(!/doctor[^\n]{0,160}\bplanned\b|\bplanned\b[^\n]{0,160}doctor/i.test(text), 'doctor still called planned in ' + f)
    assert.ok(!/[\u2013\u2014]/.test(text), 'dash in ' + f)
    assert.ok(text.includes('/dsh-phone/api/doctor'), 'route not mentioned in ' + f)
  }
  assert.ok(read('../README.md').includes('phone_doctor') && read('../skills/phone-doctor/SKILL.md').includes('phone_doctor'))
})

rmSync(dir, { recursive: true, force: true })
console.log(`\ndoctor tests: ${passed} passed` + (process.exitCode ? ', SOME FAILED' : ''))
process.exit(process.exitCode || 0)
