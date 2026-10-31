/**
 * dsh-phone: configuration shared by the DSH plugin and phone-hookd.
 *
 * The source of truth is the `dsh-phone` namespace of ~/.dsh/settings.yaml,
 * edited from DSH Settings > Phone (or the gear in the Phone tab). The plugin
 * pushes the effective settings to phone-hookd over its private unix socket;
 * hookd keeps a 0600 copy so calls are still answered while dsh-web restarts.
 *
 * Secrets resolve in this order: a value typed in Settings, then the
 * credentials file (KEY=value lines), then what provisioning created
 * (~/.dsh/phone/provisioned.json, 0600). Nothing secret is ever returned by
 * a read endpoint: only "set / not set".
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { readEnvFile } from './transcribe.mjs'

export const VERSION = '0.1.0'

export const DEFAULTS = {
  enabled: true,
  identity: 'owner',
  publicBaseUrl: '',
  defaultCountry: '',
  defaultLine: '',
  trustedHosts: [],
  requireHarnessCookie: true,
  twilio: {
    accountSid: '',
    authToken: '',
    apiKeySid: '',
    apiKeySecret: '',
    twimlAppSid: '',
    credentialsFile: '~/.config/twilio/credentials',
    edge: '',
  },
  lines: [],
  incoming: {
    defaultMode: 'live',
    ringSeconds: 25,
    forwardTo: '',
    dndBypassStarred: true,
    rejectAnonymous: false,
  },
  voicemail: {
    enabled: true,
    greeting: 'Hello, you have reached me. I cannot take your call right now. Please leave a message after the tone, and press the hash key when you are done.',
    greetingVoice: 'Polly.Joanna-Neural',
    greetingLanguage: 'en-US',
    greetingAudioUrl: '',
    maxSeconds: 120,
    liveTranscript: true,
    liveLanguage: 'en-US',
    liveEngine: '',
    liveModel: '',
    transcriber: 'local',
    localUrl: '',
    localModel: '',
    localCredentialsFile: '',
    mistralCredentialsFile: '~/.config/mistral/credentials',
    deleteFromProvider: true,
  },
  sms: {
    dndAutoReply: '',
    maxChars: 1600,
  },
  notifications: {
    browser: true,
    sound: true,
    toasts: true,
  },
  agent: {
    allowSms: true,
    allowCalls: true,
    allowModeChange: true,
  },
  sip: {
    enabled: false,
    label: 'SIP line',
    registrar: '',
    username: '',
    password: '',
    wssUrl: '',
    number: '',
  },
}

export const SECRET_PATHS = ['twilio.authToken', 'twilio.apiKeySecret', 'sip.password']

export function dshHome() { return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh') }
export function dataDir() { return process.env.DSH_PHONE_DATA ? resolve(process.env.DSH_PHONE_DATA) : join(dshHome(), 'phone') }
export function socketPath() { return process.env.DSH_PHONE_SOCKET || join(dataDir(), 'hookd.sock') }
export function expandHome(p) { return String(p || '').replace(/^~(?=\/|$)/, homedir()) }

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

/** Deep merge: arrays and scalars from `over` replace those in `base`. */
export function merge(base, over) {
  if (!isObj(over)) return structuredClone(base)
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue
    out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : structuredClone(v)
  }
  return out
}

export function normaliseLines(lines) {
  if (!Array.isArray(lines)) return []
  const seen = new Set()
  const out = []
  for (const l of lines) {
    if (!isObj(l)) continue
    const id = String(l.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      label: String(l.label || id).slice(0, 40),
      provider: l.provider === 'sip' ? 'sip' : 'twilio',
      number: String(l.number || '').replace(/[^\d+]/g, ''),
      numberSid: String(l.numberSid || '').trim(),
      sms: l.sms !== false,
      voice: l.voice !== false,
      enabled: l.enabled !== false,
    })
  }
  return out
}

export function resolveSettings(raw) {
  const s = merge(DEFAULTS, isObj(raw) ? raw : {})
  s.lines = normaliseLines(s.lines)
  s.trustedHosts = Array.isArray(s.trustedHosts) ? s.trustedHosts.map(String).filter(Boolean) : []
  s.publicBaseUrl = /^https:\/\/[^/]+/i.test(String(s.publicBaseUrl || '')) ? String(s.publicBaseUrl).replace(/\/+$/, '') : ''
  s.identity = String(s.identity || DEFAULTS.identity).replace(/[^A-Za-z0-9_.@-]/g, '').slice(0, 64) || DEFAULTS.identity
  if (!['live', 'voicemail', 'dnd'].includes(s.incoming.defaultMode)) s.incoming.defaultMode = 'live'
  s.incoming.ringSeconds = clampInt(s.incoming.ringSeconds, 5, 60, 25)
  s.voicemail.maxSeconds = clampInt(s.voicemail.maxSeconds, 10, 600, 120)
  s.sms.maxChars = clampInt(s.sms.maxChars, 70, 1600, 1600)
  if (!s.defaultLine || !s.lines.some(l => l.id === s.defaultLine)) s.defaultLine = (s.lines.find(l => l.enabled) || {}).id || ''
  return s
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

// ---------------------------------------------------------------- provisioned

export function provisionedPath() { return join(dataDir(), 'provisioned.json') }

export function readProvisioned() {
  try { return JSON.parse(readFileSync(provisionedPath(), 'utf8')) } catch { return {} }
}

export function writeJson0600(path, obj) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = path + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
  try { chmodSync(path, 0o600) } catch {}
}

export function writeProvisioned(patch) {
  const cur = readProvisioned()
  writeJson0600(provisionedPath(), { ...cur, ...patch, updatedAt: new Date().toISOString() })
}

/** Twilio credentials with their source, for the status checklist. */
export function twilioCredentials(settings) {
  const t = settings.twilio || {}
  const file = readEnvFile(expandHome(t.credentialsFile))
  const prov = readProvisioned()
  const pick = (name, settingVal, envKeys, provKey) => {
    if (settingVal) return { value: settingVal, source: 'settings' }
    for (const k of envKeys) if (file[k]) return { value: file[k], source: 'file' }
    if (provKey && prov[provKey]) return { value: prov[provKey], source: 'provisioned' }
    return { value: '', source: '' }
  }
  return {
    accountSid: pick('accountSid', t.accountSid, ['TWILIO_ACCOUNT_SID'], null),
    authToken: pick('authToken', t.authToken, ['TWILIO_AUTH_TOKEN'], null),
    apiKeySid: pick('apiKeySid', t.apiKeySid, ['TWILIO_API_KEY_SID', 'TWILIO_API_KEY'], 'apiKeySid'),
    apiKeySecret: pick('apiKeySecret', t.apiKeySecret, ['TWILIO_API_KEY_SECRET', 'TWILIO_API_SECRET'], 'apiKeySecret'),
    twimlAppSid: pick('twimlAppSid', t.twimlAppSid, ['TWILIO_TWIML_APP_SID'], 'twimlAppSid'),
  }
}

/** Settings with every secret replaced by a boolean "is set" marker. */
export function redact(settings) {
  const s = structuredClone(settings)
  for (const p of SECRET_PATHS) {
    const [a, b] = p.split('.')
    if (s[a] && b in s[a]) s[a][b] = s[a][b] ? '__set__' : ''
  }
  return s
}

/** Apply a settings patch from the UI: "__set__" means "keep the stored secret". */
export function sanitisePatch(patch, current) {
  const out = isObj(patch) ? structuredClone(patch) : {}
  for (const p of SECRET_PATHS) {
    const [a, b] = p.split('.')
    if (out[a] && out[a][b] === '__set__') out[a][b] = (current && current[a] && current[a][b]) || ''
  }
  delete out.__proto__
  return out
}
