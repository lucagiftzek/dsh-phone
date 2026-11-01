/**
 * dsh-phone: host half (runs inside dsh-web).
 *
 *   Settings     DSH 0.1.5: namespace `dsh-phone` in ~/.dsh/settings.yaml.
 *                DSH 0.2.x: the `dsh-phone` row of the profile's cordis.patch.yml
 *                (every field of the exported `Config` is live), imported once
 *                from settings.yaml(.imported) when the row is still empty.
 *                Both editable from Settings > Phone and from the gear in the
 *                Phone tab (lib/dual-settings.js picks the store). Pushed to
 *                phone-hookd whenever it changes.
 *   Routes       /dsh-phone/api/*  human-facing, gated (the site login at the edge,
 *                then loopback + same-origin + capability token + harness
 *                cookie, see lib/security.js). Proxied to phone-hookd's
 *                private unix socket.
 *   Doctor       GET /dsh-phone/api/doctor and the read-only tool phone_doctor
 *                (lib/doctor.js): local state and the daemon socket only.
 *   Tools        phone_status, phone_set_mode, phone_sms_threads,
 *                phone_sms_thread, phone_sms_send, phone_calls,
 *                phone_voicemails, phone_contacts, phone_call_say, phone_doctor.
 *
 * The public Twilio webhooks are NOT served here: they live in phone-hookd
 * (daemon/hookd.mjs) behind their own edge router, so nothing unauthenticated
 * ever reaches this process.
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import { createDualSettings, loadHostSchemastery, liveObject } from './dual-settings.js'

import { loadOrCreateSecret, mintToken, checkReadRequest, checkMutateRequest, checkAudioUpgrade } from './security.js'
import { hookd, hookdPipe, hookdForward, hookdUpgrade, HookdError } from './hookc.js'
import { registerTelegramTools } from './telegram-tools.js'
import { E, errorBody } from './errors.js'
import { losslessDefineTool } from './plugin-errors.js'
import { registerPluginSkills } from './plugin-skills.js'
import { phoneDoctor, renderDoctor } from './doctor.js'
import { DEFAULTS, VERSION, dataDir, resolveSettings, redact, sanitisePatch } from '../daemon/config.mjs'
import { smsSegments, toE164 } from '../daemon/twilio.mjs'

export const name = 'dsh-phone'
export const inject = ['tools', 'webServer', 'settings']

const PLUGIN_ID = 'dsh-phone'
const API_PREFIX = '/' + PLUGIN_ID + '/api'
const DISABLE_ENV = 'DSH_PHONE_DISABLE'
const HERE = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------- host libs

// The RUNNING harness's schemastery: on 0.2.x only its copy wraps live fields
// the way the Loader commits them (see lib/dual-settings.js).
function loadSchemastery() { return loadHostSchemastery(import.meta.url) }

function resolveDefineTool() {
  const bases = [import.meta.url, join(homedir(), '.dsh', 'profiles', 'web', 'probe.js')]
  if (process.argv && process.argv[1]) bases.push(process.argv[1])
  for (const base of bases) {
    try {
      const mod = createRequire(base)('@deepseek-ai/dsh-tools')
      const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
      if (typeof fn === 'function') return fn
    } catch {}
  }
  return null
}

function settingsSchema(z) {
  if (!z) return null
  const D = DEFAULTS
  const secret = (s) => (typeof s.role === 'function' ? s.role('secret') : s)
  // Every field is live: the plugin reads settings at the moment of use and
  // pushes them to phone-hookd, so no field needs a remount.
  return liveObject(z, {
    enabled: z.boolean().default(D.enabled).description('Master switch for the Phone tab and tools.'),
    identity: z.string().default(D.identity).description('Browser client identity the calls ring (letters, digits, . _ - @).'),
    publicBaseUrl: z.string().default('').description('Public HTTPS base the provider calls for webhooks, e.g. https://your-host/phone-hook (edge route to phone-hookd).'),
    defaultCountry: z.string().default(D.defaultCountry).description('Country prefix for numbers typed without one, e.g. +30.'),
    defaultLine: z.string().default(D.defaultLine).description('Line id used when none is chosen.'),
    trustedHosts: z.array(z.string()).default(D.trustedHosts),
    requireHarnessCookie: z.boolean().default(D.requireHarnessCookie),
    twilio: z.object({
      accountSid: z.string().default(''),
      authToken: secret(z.string().default('')),
      apiKeySid: z.string().default(''),
      apiKeySecret: secret(z.string().default('')),
      twimlAppSid: z.string().default(''),
      credentialsFile: z.string().default(D.twilio.credentialsFile).description('KEY=value file used for any field left empty (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, ...).'),
      edge: z.string().default('').description('Optional Twilio edge for the browser SDK (e.g. dublin, frankfurt). Empty = roaming.'),
      sipDomain: z.string().default('').description('SIP Domain for the relay bridge (empty = dsh-phone-<account>.sip.twilio.com, created by Apply).'),
      sipEdge: z.string().default('').description('Twilio edge the relay registers through (e.g. dublin, frankfurt). Empty = ashburn.'),
    }).default({}),
    lines: z.array(z.object({
      id: z.string(),
      label: z.string().default(''),
      provider: z.union([z.const('twilio'), z.const('sip')]).default('twilio'),
      number: z.string().default(''),
      numberSid: z.string().default(''),
      sms: z.boolean().default(true),
      voice: z.boolean().default(true),
      enabled: z.boolean().default(true),
    })).default([]),
    incoming: z.object({
      defaultMode: z.union([z.const('live'), z.const('voicemail'), z.const('dnd')]).default(D.incoming.defaultMode),
      ringSeconds: z.number().default(D.incoming.ringSeconds),
      forwardTo: z.string().default('').description('Also ring this number in Live mode (it must press 1 to accept).'),
      dndBypassStarred: z.boolean().default(true),
      rejectAnonymous: z.boolean().default(false),
    }).default({}),
    voicemail: z.object({
      enabled: z.boolean().default(true),
      greeting: z.string().default(D.voicemail.greeting),
      greetingVoice: z.string().default(D.voicemail.greetingVoice),
      greetingLanguage: z.string().default(D.voicemail.greetingLanguage),
      greetingAudioUrl: z.string().default(''),
      maxSeconds: z.number().default(D.voicemail.maxSeconds),
      liveTranscript: z.boolean().default(true),
      liveLanguage: z.string().default(D.voicemail.liveLanguage),
      liveEngine: z.string().default(''),
      liveModel: z.string().default(''),
      transcriber: z.union([z.const('local'), z.const('mistral'), z.const('off')]).default('local'),
      localUrl: z.string().default(''),
      localModel: z.string().default(''),
      localCredentialsFile: z.string().default(D.voicemail.localCredentialsFile),
      mistralCredentialsFile: z.string().default(D.voicemail.mistralCredentialsFile),
      deleteFromProvider: z.boolean().default(true),
    }).default({}),
    sms: z.object({
      dndAutoReply: z.string().default(''),
      maxChars: z.number().default(D.sms.maxChars),
    }).default({}),
    notifications: z.object({
      browser: z.boolean().default(true),
      sound: z.boolean().default(true),
      toasts: z.boolean().default(true),
    }).default({}),
    agent: z.object({
      allowSms: z.boolean().default(true),
      allowCalls: z.boolean().default(true),
      allowModeChange: z.boolean().default(true),
    }).default({}),
    audio: z.object({
      route: z.union([z.const('server'), z.const('direct')]).default(D.audio.route).description('Call audio: server = through this host over one wss socket (default; works on networks that block WebRTC), direct = WebRTC from the browser straight to Twilio.'),
      maxCalls: z.number().default(D.audio.maxCalls).description('Most calls the server carries at once.'),
      maxTests: z.number().default(D.audio.maxTests),
      packetMs: z.number().default(D.audio.packetMs).description('Audio per socket message: 20, 40 or 60 ms (40 = about 70 kbit/s each way).'),
      jitterMinMs: z.number().default(D.audio.jitterMinMs),
      jitterMaxMs: z.number().default(D.audio.jitterMaxMs),
      testSeconds: z.number().default(D.audio.testSeconds),
      audioSocketPort: z.number().default(D.audio.audioSocketPort).description('Loopback port Asterisk AudioSocket connects to (phone-hookd restart to change).'),
      ringbackTone: z.string().default('').description('Ringback the caller hears while the tab rings: eu, us, uk, or empty = from the line number.'),
    }).default({}),
    sipAccounts: z.array(z.object({
      id: z.string(),
      label: z.string().default(''),
      enabled: z.boolean().default(true),
      line: z.string().default('').description('Line id (provider sip) this account rings.'),
      registrar: z.string().default(''),
      port: z.number().default(0),
      callPort: z.number().default(0).description('Port for calls when it differs from the registration port (0 = same). Helps when a router SIP ALG drops INVITEs to 5060.'),
      callSourcePort: z.number().default(0).description('Local UDP port that calls leave from (0 = the registration socket). A separate port keeps a router SIP ALG away from the calls.'),
      transport: z.union([z.const('udp'), z.const('tcp'), z.const('tls')]).default('udp'),
      username: z.string().default(''),
      authUser: z.string().default(''),
      password: secret(z.string().default('')),
      fromDomain: z.string().default(''),
      outboundProxy: z.string().default(''),
      expiry: z.number().default(300),
      keepalive: z.number().default(30),
      did: z.string().default(''),
      callerId: z.string().default(''),
      country: z.string().default(''),
      codecs: z.array(z.string()).default(['alaw', 'ulaw']),
      dtmf: z.union([z.const('rfc4733'), z.const('info'), z.const('inband'), z.const('auto')]).default('rfc4733'),
      srtp: z.union([z.const('off'), z.const('sdes'), z.const('required')]).default('off'),
      mode: z.union([z.const('bridge'), z.const('direct')]).default('bridge'),
      bridgeVia: z.string().default('').description('Twilio line whose SIP Domain carries the calls (bridge mode).'),
      ringFirstSeconds: z.number().default(0).description('Let the provider\'s other phones ring this long before voicemail answers here.'),
      dialFormat: z.union([z.const('national'), z.const('e164'), z.const('intl00')]).default('national'),
      allowPrefixes: z.array(z.string()).default([]),
      blockPrefixes: z.array(z.string()).default([]),
      identifyIps: z.array(z.string()).default([]),
      credentialsFile: z.string().default('').description('KEY=value file for empty fields (<PREFIX>SIP_REGISTRAR, SIP_PORT, SIP_USERNAME, SIP_AUTH_USER, SIP_PASSWORD, DID).'),
    })).default([]),
    relay: z.object({
      enabled: z.boolean().default(D.relay.enabled),
      configDir: z.string().default(D.relay.configDir),
      bindAddress: z.string().default('').description('LAN address the relay binds SIP to (never 0.0.0.0).'),
      bindPort: z.number().default(D.relay.bindPort),
      loopback: z.boolean().default(D.relay.loopback),
      tcp: z.boolean().default(false),
      localNets: z.array(z.string()).default([]),
      externalMediaAddress: z.string().default('').description('Public address (or hostname) put into SDP behind NAT.'),
      externalSignalingAddress: z.string().default(''),
      externalSignalingPort: z.number().default(0),
      rtpKeepalive: z.number().default(D.relay.rtpKeepalive),
      bridgeTransport: z.union([z.const('udp'), z.const('tls')]).default(D.relay.bridgeTransport).description('Transport to the Twilio SIP Domain. tls = port 5061 with SRTP; it also keeps router SIP ALGs out of the call.'),
      bridgeSrtp: z.boolean().default(D.relay.bridgeSrtp),
      tlsPort: z.number().default(D.relay.tlsPort),
      caFile: z.string().default(D.relay.caFile),
      certFile: z.string().default('').description('Certificate (PEM) for the relay TLS listener; Twilio connects to it for calls you place.'),
      keyFile: z.string().default(''),
      tlsExternalAddress: z.string().default('').description('Behind NAT: the public address put into the TLS Contact.'),
      tlsExternalPort: z.number().default(0).description('Behind NAT: the router port forwarded to the TLS listener (0 = same as the TLS port).'),
      amiHost: z.string().default(D.relay.amiHost),
      amiPort: z.number().default(D.relay.amiPort),
      amiUser: z.string().default(D.relay.amiUser),
    }).default({}),
    // Legacy single SIP line of 0.1.x, superseded by sipAccounts (kept so old settings validate).
    sip: z.object({
      enabled: z.boolean().default(false),
      label: z.string().default(D.sip.label),
      registrar: z.string().default(''),
      username: z.string().default(''),
      password: secret(z.string().default('')),
      wssUrl: z.string().default(''),
      number: z.string().default(''),
    }).default({}),
  })
}

/** Settings schema as the plugin's Config (0.2.x forms and row validation). */
export const Config = settingsSchema(loadSchemastery()) || undefined

// ---------------------------------------------------------------- http helpers

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > 256 * 1024) { reject(E.raise('PHONE_BODY_TOO_LARGE', { status: 400, message: 'request body too large' })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch (e) { reject(E.raise('PHONE_BODY_INVALID', { message: 'invalid JSON body' })) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

/** Standard error body (status kept as before; `error` keeps the legacy text). */
function sendError(res, code, extra) { return E.send(res, code, extra) }

const READ_PROXY = new Set(['/state', '/threads', '/thread', '/calls', '/voicemails', '/contacts', '/provider/check', '/provider/numbers', '/balance', '/relay/status', '/audio/info'])
const MUTATE_PROXY = new Set(['/mode', '/presence', '/sms/send', '/thread/read', '/thread/delete', '/calls/seen', '/calls/delete',
  '/voicemail/read', '/voicemail/delete', '/voicemail/retranscribe', '/pickup', '/contacts/save', '/contacts/delete', '/provider/apply', '/call/say', '/relay/sync', '/audio/ticket', '/audio/decline'])

// ---------------------------------------------------------------- plugin

export function apply(ctx, config = {}) {
  if (process.env[DISABLE_ENV] === '1') { console.log('dsh-phone: ' + DISABLE_ENV + '=1, armed off'); return }
  const log = m => console.log('dsh-phone: ' + m)
  const warn = m => console.error('dsh-phone: ' + m)

  // -- packaged skills (phone-doctor), offered to agents through the skills service
  registerPluginSkills(ctx, { plugin: 'dsh-phone', dir: new URL('../skills/', import.meta.url), log })

  // -- settings (0.1.5: registered namespace; 0.2.x: live Config row)
  const store = createDualSettings(ctx, config, {
    ns: PLUGIN_ID, packageName: 'dsh-phone', schema: Config || null, base: DEFAULTS,
    autoForm: false, log, warn, metaUrl: import.meta.url,
  })
  log('settings store: ' + store.mode + (store.entryId ? ' (entry ' + store.entryId + ')' : ''))
  const raw = () => store.get()
  const effective = () => resolveSettings(raw())

  // -- keep phone-hookd in step with Settings
  let pushedHash = ''
  async function pushConfig(force = false) {
    const r = raw() || {}
    const h = createHash('sha256').update(JSON.stringify(r)).digest('hex')
    if (!force && h === pushedHash) return false
    await hookd('PUT', '/config', { settings: r })
    pushedHash = h
    return true
  }
  const pushTimer = setInterval(() => { pushConfig().catch(() => {}) }, 15000)
  if (typeof pushTimer.unref === 'function') pushTimer.unref()
  ctx.effect(() => () => clearInterval(pushTimer), 'dsh-phone: config push timer')
  pushConfig(true).then(() => log('settings pushed to phone-hookd')).catch(e => warn('phone-hookd not reachable yet (' + e.message + '); will retry'))

  // -- capability secret for mutating routes
  let secret = null
  loadOrCreateSecret(join(dataDir(), 'capability.secret')).then(s => { secret = s }).catch(e => warn('secret: ' + e.message))

  // -- the browser SDK, served locally (no CDN), wrapped so an AMD loader on the page cannot capture it
  let sdkCache = null
  function sdkSource() {
    if (sdkCache) return sdkCache
    // The package only exports ".", which resolves to <pkg>/es5/twilio.js; the
    // browser UMD build sits beside it in <pkg>/dist.
    const req = createRequire(import.meta.url)
    const file = join(dirname(dirname(req.resolve('@twilio/voice-sdk'))), 'dist', 'twilio.min.js')
    const src = readFileSync(file, 'utf8')
    const body = '/* @twilio/voice-sdk, Apache-2.0, served by dsh-phone */\n(function(define, module, exports, require){\n' + src + '\n})(undefined, undefined, undefined, undefined);\n'
    sdkCache = { body, etag: '"' + createHash('sha1').update(body).digest('hex').slice(0, 16) + '"' }
    return sdkCache
  }

  // -- doctor: read-only self-check, shared by the route and the tool
  const runDoctor = () => phoneDoctor({ ctx, store, settings: effective, version: VERSION, configVisible: Config !== undefined, hookd })

  // -- routes
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://dsh-phone.local')
      const path = url.pathname.replace(/\/+$/, '') || '/'
      const sub = path.startsWith(API_PREFIX) ? path.slice(API_PREFIX.length) || '/' : path
      const s = effective()
      const readGate = () => {
        const g = checkReadRequest(req, { trustedHosts: s.trustedHosts })
        if (!g.ok) sendError(res, g.code, { status: g.status, message: g.reason })
        return g.ok
      }
      const mutateGate = () => {
        const g = checkMutateRequest(req, { trustedHosts: s.trustedHosts, secret, requireHarnessCookie: s.requireHarnessCookie })
        if (!g.ok) sendError(res, g.code, { status: g.status, message: g.reason, layer: g.layer })
        return g.ok
      }

      if (req.method === 'GET' && sub === '/session') {
        if (!readGate()) return
        if (!secret) { sendError(res, 'PHONE_SECRET_NOT_READY', { message: 'secret not ready' }); return }
        sendJson(res, 200, { ok: true, token: mintToken(secret) })
        return
      }
      if (req.method === 'GET' && sub === '/sdk.js') {
        if (!readGate()) return
        const sdk = sdkSource()
        if (req.headers['if-none-match'] === sdk.etag) { res.writeHead(304); res.end(); return }
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', etag: sdk.etag, 'cache-control': 'private, max-age=86400' })
        res.end(sdk.body)
        return
      }
      if (req.method === 'GET' && sub === '/events') {
        if (!readGate()) return
        hookdPipe('GET', '/events', req, res)
        return
      }
      if (req.method === 'GET' && (sub === '/voicemail/audio' || sub === '/media')) {
        if (!readGate()) return
        hookdPipe('GET', sub + url.search, req, res, { headers: req.headers.range ? { range: req.headers.range } : {} })
        return
      }
      if (req.method === 'GET' && sub === '/doctor') {
        if (!readGate()) return
        sendJson(res, 200, await runDoctor())
        return
      }
      if (req.method === 'GET' && sub === '/settings') {
        if (!readGate()) return
        sendJson(res, 200, { ok: true, version: VERSION, settings: redact(s), defaults: redact(resolveSettings({})), store: store.describeStore() })
        return
      }
      if (req.method === 'POST' && sub === '/settings') {
        if (!mutateGate()) return
        if (!store.writable()) { sendError(res, 'PHONE_SETTINGS_UNAVAILABLE'); return }
        const body = await readJsonBody(req)
        const patch = sanitisePatch(body.settings || {}, s)
        // Arrays (lines, trustedHosts) are replaced as a whole by update().
        await store.update(patch)
        await pushConfig(true).catch(e => warn('push after save: ' + e.message))
        sendJson(res, 200, { ok: true, settings: redact(effective()) })
        return
      }
      if (req.method === 'POST' && sub === '/token') {
        if (!mutateGate()) return
        const out = await hookd('GET', '/token')
        sendJson(res, 200, out)
        return
      }
      // Telegram: one generic passthrough to phone-hookd /tg/* (reads: read gate; writes: mutate gate,
      // origin forced to ui; raw uploads streamed). Server files are never sent from the browser.
      if (sub.startsWith('/tg/')) {
        if (req.method === 'GET') {
          if (!readGate()) return
          hookdPipe('GET', sub + url.search, req, res, { headers: req.headers.range ? { range: req.headers.range } : {} })
          return
        }
        if (req.method === 'POST') {
          if (!mutateGate()) return
          if (sub === '/tg/upload') { hookdForward('POST', sub + url.search, req, res, { stream: true, contentType: 'application/octet-stream' }); return }
          if (sub === '/tg/send_media') { sendError(res, 'PHONE_NOT_FOUND'); return }
          const body = await readJsonBody(req)
          body.origin = 'ui'
          hookdForward('POST', sub, req, res, { body: Buffer.from(JSON.stringify(body)) })
          return
        }
        sendError(res, 'PHONE_METHOD_NOT_ALLOWED')
        return
      }
      if (req.method === 'GET' && READ_PROXY.has(sub)) {
        if (!readGate()) return
        if (sub === '/state') await pushConfig().catch(() => {})
        const out = await hookd('GET', sub + url.search)
        if (sub === '/audio/info') out.upgrade = upgradeArmed
        sendJson(res, 200, out)
        return
      }
      if (req.method === 'POST' && MUTATE_PROXY.has(sub)) {
        if (!mutateGate()) return
        const body = await readJsonBody(req)
        if (sub === '/mode') body.by = 'ui'
        if (sub === '/provider/apply') await pushConfig(true).catch(() => {})
        sendJson(res, 200, await hookd('POST', sub, body, { timeoutMs: sub === '/provider/apply' || sub === '/voicemail/retranscribe' ? 300000 : 30000 }))
        return
      }
      sendError(res, 'PHONE_NOT_FOUND')
    } catch (e) {
      try {
        if (res.headersSent) { res.end(); return }
        const code = e instanceof HookdError ? 'PHONE_HOOKD_ERROR' : 'PHONE_INTERNAL'
        const body = errorBody(E, e, code)
        if (body.code === 'PHONE_INTERNAL' || body.code === 'PHONE_HOOKD_ERROR') warn(E.logLine(body.code, String(e && e.message || e)))
        sendJson(res, e.status && e.status < 600 ? e.status : 400, body)
      } catch {}
    }
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }), 'dsh-phone: api route')

  // -- the browser audio socket (server audio route): one generic endpoint,
  // gated like the mutating routes (loopback peer, trusted Host + same Origin,
  // harness cookie, wss only) and then piped raw to phone-hookd, which checks
  // the one-time ticket the tab got from POST /audio/ticket (capability token).
  let upgradeArmed = false
  if (ctx.webServer && typeof ctx.webServer.registerUpgrade === 'function') {
    const upgrade = (req, socket, head) => {
      const s = effective()
      const g = checkAudioUpgrade(req, { trustedHosts: s.trustedHosts, requireHarnessCookie: s.requireHarnessCookie })
      if (!g.ok) {
        const body = Buffer.from(JSON.stringify(E.body(g.code, { message: g.reason })))
        try { socket.end('HTTP/1.1 ' + g.status + ' Refused\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ' + body.length + '\r\n\r\n' + body.toString()) } catch {}
        return
      }
      hookdUpgrade('/audio/io', req, socket, head, (e) => warn('audio socket: ' + e.message))
    }
    ctx.effect(() => { upgradeArmed = true; const off = ctx.webServer.registerUpgrade({ path: API_PREFIX + '/io', handler: upgrade }); return () => { upgradeArmed = false; off() } }, 'dsh-phone: audio socket')
  } else warn('this DSH has no upgrade routes: the server audio route is off, the Phone tab uses the direct route')

  // -- agent tools
  const defineTool = resolveDefineTool()
  if (defineTool && ctx.tools && typeof ctx.tools.register === 'function') {
    try { registerTools(ctx, defineTool, effective, { doctor: runDoctor }) } catch (e) { warn('tool registration failed: ' + e.message) }
  } else warn('defineTool or ctx.tools unavailable; agent tools not registered (sidebar still works)')

  log('armed ' + VERSION + ', route ' + API_PREFIX + ', hookd socket ' + join(dataDir(), 'hookd.sock'))
}

// ---------------------------------------------------------------- tools

const fmtTime = (unix) => unix ? new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '?'
const who = (peer, name) => name ? name + ' (' + peer + ')' : peer

export function registerTools(ctx, defineTool, effective, { doctor } = {}) {
  const TEXT = (s) => [{ type: 'text', text: s }]
  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      text: { type: 'string', required: true },
      error: { type: 'string' },
      drafted: { type: 'boolean' },
      status: { type: 'string' },
      report: { type: 'object', additionalProperties: true },
      code: { type: 'string' },
      message: { type: 'string' },
      hint: { type: 'string' },
      docs: { type: 'string' },
    },
  }
  const output = { schema, render: (_a, v) => TEXT(v.text || v.error || 'no result') }
  // Failed result in the standard shape (E.tool); `error` and `text` keep the exact legacy strings.
  const fail = (e) => {
    const msg = String(e && e.message || e)
    const body = errorBody(E, e, e instanceof HookdError ? 'PHONE_HOOKD_ERROR' : 'PHONE_INTERNAL')
    return { ...body, error: msg, text: 'Phone error: ' + msg }
  }
  const refuse = (code, text) => ({ ...E.tool(code, { message: text }), text })
  // DSH 0.2.1 rejects tool results that are not lossless JSON (undefined, NaN, Date, ...): sanitize at the boundary.
  const defineLossless = losslessDefineTool(defineTool)
  const reg = (def) => ctx.tools.register(defineLossless({ ...def, output }))

  reg({
    name: 'phone_status',
    description: 'Phone line status: incoming-call mode (live / voicemail / dnd), configured lines and numbers, whether a browser is online to ring, unread SMS, new voicemails, missed calls, and setup issues.',
    parameters: {},
    async execute() {
      try {
        const st = await hookd('GET', '/state')
        const lines = st.lines.map(l => '- ' + l.id + ': ' + l.number + ' (' + l.label + ', ' + l.provider + (l.sms ? ', sms' : '') + (l.voice ? ', voice' : '') + ')').join('\n') || '- none'
        let bal = ''
        try { const b = await hookd('GET', '/balance'); bal = '\nProvider balance: ' + b.balance + ' ' + b.currency } catch {}
        return { ok: true, text: 'Mode: ' + st.mode + (st.browserOnline ? ' (a browser is online and will ring)' : ' (no browser online: live calls go to voicemail)') +
          '\nLines:\n' + lines + '\nUnread SMS: ' + st.counts.sms + ', new voicemails: ' + st.counts.voicemail + ', missed calls: ' + st.counts.missed + bal +
          (st.issues.length ? '\nSetup issues:\n- ' + st.issues.join('\n- ') : '') }
      } catch (e) { return fail(e) }
    },
  })

  if (typeof doctor === 'function') reg({
    name: 'phone_doctor',
    description: 'Read-only self-check of the phone plugin: settings mode, lines, provider credentials (booleans), public webhook URL, hook daemon reachability, SIP account registrations and media server configuration. Never calls the provider, never places a call or sends an SMS. Failing checks carry a PHONE_* code and a hint; see docs/TROUBLESHOOTING.md.',
    parameters: {},
    async execute() {
      try {
        const report = await doctor()
        return { ok: true, status: report.status, text: renderDoctor(report), report }
      } catch (e) { return fail(e) }
    },
  })

  reg({
    name: 'phone_set_mode',
    description: 'Set how incoming calls are handled: "live" rings the browser (unanswered calls go to voicemail), "voicemail" sends every call to voicemail with a live transcript and a Pick up button, "dnd" (do not disturb) sends calls to voicemail and silences every notification and sound.',
    parameters: { mode: { type: 'string', description: 'live | voicemail | dnd' } },
    async execute(args) {
      try {
        if (!effective().agent.allowModeChange) return refuse('PHONE_AGENT_ACTION_DISABLED', 'Changing the phone mode from an agent is disabled in Settings > Phone.')
        const r = await hookd('POST', '/mode', { mode: String(args.mode || '').toLowerCase().trim(), by: 'agent' })
        return { ok: true, text: 'Phone mode is now ' + r.mode + '.' }
      } catch (e) { return fail(e) }
    },
  })

  reg({
    name: 'phone_sms_threads',
    description: 'List SMS conversations (newest first) with contact name, unread count and the last message.',
    parameters: {
      q: { type: 'string', description: 'Optional search over number, name and message text.' },
      limit: { type: 'integer', description: 'Max conversations (default 20, max 100).' },
    },
    async execute(args) {
      try {
        const r = await hookd('GET', '/threads?' + new URLSearchParams({ q: args.q || '', limit: String(Math.min(100, Number(args.limit) || 20)) }))
        if (!r.threads.length) return { ok: true, text: 'No SMS conversations.' }
        return { ok: true, text: r.threads.map(t => '- ' + who(t.peer, t.name) + ' on line ' + t.line + ' · ' + fmtTime(t.ts) + (t.unread ? ' · ' + t.unread + ' unread' : '') +
          '\n  ' + (t.last.direction === 'out' ? 'You: ' : '') + (t.last.body || (t.last.hasMedia ? '[media]' : '')).slice(0, 160)).join('\n') }
      } catch (e) { return fail(e) }
    },
  })

  reg({
    name: 'phone_sms_thread',
    description: 'Read one SMS conversation with a number (oldest first). Marks it read only if markRead is true.',
    parameters: {
      peer: { type: 'string', description: 'The other party, E.164 (+30...) or a number in the default country.' },
      line: { type: 'string', description: 'Line id (default: the default line).' },
      limit: { type: 'integer', description: 'Max messages (default 50).' },
      markRead: { type: 'boolean', description: 'Mark the conversation as read.' },
    },
    async execute(args) {
      try {
        const r = await hookd('GET', '/thread?' + new URLSearchParams({ peer: args.peer || '', line: args.line || '', limit: String(Math.min(500, Number(args.limit) || 50)) }))
        if (args.markRead) await hookd('POST', '/thread/read', { line: r.line, peer: r.peer }).catch(() => {})
        if (!r.messages.length) return { ok: true, text: 'No messages with ' + r.peer + ' on line ' + r.line + '.' }
        const name = r.contact && r.contact.name
        return { ok: true, text: 'Conversation with ' + who(r.peer, name) + ' on line ' + r.line + ':\n' + r.messages.map(m =>
          '[' + fmtTime(m.ts) + '] ' + (m.direction === 'in' ? (name || m.peer) : 'You') + ': ' + m.body + (m.media.length ? ' [' + m.media.length + ' attachment(s)]' : '') +
          (m.direction === 'out' && m.status && m.status !== 'delivered' ? ' (' + m.status + (m.error ? ', ' + m.error : '') + ')' : '')).join('\n') }
      } catch (e) { return fail(e) }
    },
  })

  reg({
    name: 'phone_sms_send',
    description: 'Send an SMS from one of the phone lines. Without confirm:true it only returns a draft (recipient, line, encoding, segment count) for the human to approve; re-run with confirm:true to send. Each segment is billed.',
    parameters: {
      to: { type: 'string', description: 'Recipient, E.164 (+30...) or a number in the default country.' },
      text: { type: 'string', description: 'Message text (plain).' },
      line: { type: 'string', description: 'Line id (default: the default line).' },
      confirm: { type: 'boolean', description: 'true actually sends. Omit to get the draft back.' },
    },
    async execute(args) {
      try {
        const s = effective()
        if (!s.agent.allowSms) return refuse('PHONE_AGENT_ACTION_DISABLED', 'Sending SMS from an agent is disabled in Settings > Phone.')
        const to = toE164(args.to, s.defaultCountry)
        if (!to || to.startsWith('client:')) return refuse('PHONE_NUMBER_INVALID', 'Not a valid phone number: ' + args.to)
        const text = String(args.text || '').trim()
        if (!text) return refuse('PHONE_MESSAGE_INVALID', 'The message is empty.')
        const seg = smsSegments(text)
        const line = s.lines.find(l => l.id === (args.line || s.defaultLine))
        if (!line) return refuse('PHONE_LINE_UNAVAILABLE', 'No such line: ' + (args.line || s.defaultLine || '(none configured)'))
        if (args.confirm !== true) {
          return { ok: true, drafted: true, text: 'Draft (not sent) from ' + line.number + ' (' + line.id + ') to ' + to + ', ' + seg.encoding + ', ' + seg.chars + ' chars, ' + seg.segments + ' segment(s):\n\n' + text + '\n\nRe-run with confirm:true to send it.' }
        }
        const r = await hookd('POST', '/sms/send', { to, body: text, line: line.id, origin: 'agent' })
        return { ok: true, text: 'Sent to ' + to + ' from ' + line.number + ' (status ' + r.message.status + ', ' + seg.segments + ' segment(s)).' }
      } catch (e) { return fail(e) }
    },
  })

  reg({
    name: 'phone_calls',
    description: 'Recent call log: direction, number/contact, outcome (answered, missed, voicemail, declined, blocked...), duration.',
    parameters: { limit: { type: 'integer', description: 'Max calls (default 20).' } },
    async execute(args) {
      try {
        const r = await hookd('GET', '/calls?limit=' + Math.min(200, Number(args.limit) || 20))
        if (!r.calls.length) return { ok: true, text: 'No calls yet.' }
        return { ok: true, text: r.calls.map(c => '- ' + fmtTime(c.started) + ' ' + (c.direction === 'in' ? 'from ' : 'to ') + who(c.peer, c.name) + ' · ' + (c.disposition || c.status) + (c.duration ? ' · ' + c.duration + 's' : '') + (c.origin === 'agent' ? ' · by agent' : '')).join('\n') }
      } catch (e) { return fail(e) }
    },
  })

  reg({
    name: 'phone_voicemails',
    description: 'Voicemails with caller, time, duration and transcript (local Whisper; the live transcript if the final one is not ready).',
    parameters: {
      limit: { type: 'integer', description: 'Max voicemails (default 10).' },
      markRead: { type: 'boolean', description: 'Mark the returned voicemails as read.' },
    },
    async execute(args) {
      try {
        const r = await hookd('GET', '/voicemails?limit=' + Math.min(100, Number(args.limit) || 10))
        if (!r.voicemails.length) return { ok: true, text: 'No voicemails.' }
        if (args.markRead) for (const v of r.voicemails.filter(v => !v.read)) await hookd('POST', '/voicemail/read', { id: v.id }).catch(() => {})
        return { ok: true, text: r.voicemails.map(v => '- #' + v.id + ' ' + fmtTime(v.ts) + ' from ' + who(v.peer, v.name) + ' · ' + v.duration + 's · ' + v.status + (v.pickedUp ? ' (picked up)' : '') + (v.read ? '' : ' · NEW') +
          '\n  ' + (v.transcript || v.liveText || '(no transcript)')).join('\n') }
      } catch (e) { return fail(e) }
    },
  })

  reg({
    name: 'phone_contacts',
    description: 'Phone contacts (names shown in the Phone tab). Search with q, or save one with save: { number, name, starred, blocked }. Starred contacts ring through Do Not Disturb; blocked ones are rejected.',
    parameters: {
      q: { type: 'string', description: 'Search name or number.' },
      save: { type: 'json', description: 'Optional contact to save: { number, name, starred, blocked, note }.' },
    },
    async execute(args) {
      try {
        if (args.save && typeof args.save === 'object') {
          const r = await hookd('POST', '/contacts/save', args.save)
          return { ok: true, text: 'Saved ' + who(r.contact.number, r.contact.name) + (r.contact.starred ? ', starred' : '') + (r.contact.blocked ? ', BLOCKED' : '') + '.' }
        }
        const r = await hookd('GET', '/contacts?q=' + encodeURIComponent(args.q || ''))
        if (!r.contacts.length) return { ok: true, text: 'No contacts' + (args.q ? ' matching "' + args.q + '"' : '') + '.' }
        return { ok: true, text: r.contacts.map(c => '- ' + who(c.number, c.name) + (c.starred ? ' ★' : '') + (c.blocked ? ' [blocked]' : '')).join('\n') }
      } catch (e) { return fail(e) }
    },
  })

  reg({
    name: 'phone_call_say',
    description: 'Place an outbound phone call that speaks a short message (text-to-speech, said twice) and hangs up. Use for urgent alerts. Without confirm:true it returns a draft; re-run with confirm:true to call. Billed per minute.',
    parameters: {
      to: { type: 'string', description: 'Number to call, E.164 or default-country.' },
      text: { type: 'string', description: 'What to say (max 1000 chars).' },
      line: { type: 'string', description: 'Line id (default: the default line).' },
      language: { type: 'string', description: 'Optional TTS language, e.g. en-US, el-GR, it-IT.' },
      voice: { type: 'string', description: 'Optional Twilio voice, e.g. Polly.Joanna-Neural, Google.el-GR-Standard-A.' },
      confirm: { type: 'boolean', description: 'true actually calls.' },
    },
    async execute(args) {
      try {
        const s = effective()
        if (!s.agent.allowCalls) return refuse('PHONE_AGENT_ACTION_DISABLED', 'Placing calls from an agent is disabled in Settings > Phone.')
        const to = toE164(args.to, s.defaultCountry)
        if (!to || to.startsWith('client:')) return refuse('PHONE_NUMBER_INVALID', 'Not a valid phone number: ' + args.to)
        const text = String(args.text || '').trim().slice(0, 1000)
        if (!text) return refuse('PHONE_MESSAGE_INVALID', 'Nothing to say.')
        if (args.confirm !== true) return { ok: true, drafted: true, text: 'Draft (not called): call ' + to + ' from line ' + (args.line || s.defaultLine) + ' and say:\n\n' + text + '\n\nRe-run with confirm:true to place the call.' }
        const r = await hookd('POST', '/call/say', { to, text, line: args.line, language: args.language, voice: args.voice })
        return { ok: true, text: 'Calling ' + to + ' (call ' + r.call.sid.slice(0, 10) + '...). The outcome appears in phone_calls.' }
      } catch (e) { return fail(e) }
    },
  })

  registerTelegramTools(reg)
}

export default { name, inject, Config, apply }
