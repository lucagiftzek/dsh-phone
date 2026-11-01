/**
 * dsh-phone: the I/O half of the SIP relay.
 *
 * phone-hookd owns the relay configuration: it renders the Asterisk include
 * files from Settings (daemon/sip.mjs), writes them into the include
 * directory (relay.configDir; empty = <phone data dir>/asterisk, so each
 * instance has its own; a system relay uses e.g. /etc/asterisk/dsh-phone,
 * owned by the hookd user with group asterisk, setgid, mode 0750; files 0640)
 * and reloads Asterisk over the loopback-only AMI. Asterisk's own pjsip.conf /
 * extensions.conf / manager.conf only #include these files.
 *
 * Safety: nothing is written unless the relay is enabled AND at least one SIP
 * account is configured. Every file starts with an instance marker
 * ("; dsh-phone-instance: <id>", id kept in relay.json); a directory whose
 * files carry another instance's marker is never written.
 *
 * Secrets the relay needs:
 *   ~/.dsh/phone/relay.json (0600)   amiSecret, bridgeKey (generated here)
 *   provisioned.json (0600)          the Twilio SIP Domain bridge credential
 *   the account's credentials file   the SIP provider password (read only)
 * The generated files hold the SIP passwords and the AMI secret (Asterisk has
 * to read them), and only a SHA1 digest of the bridge key.
 */

import fs from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { readEnvFile } from './transcribe.mjs'
import { DEFAULTS, dataDir, expandHome, readProvisioned, writeJson0600 } from './config.mjs'
import { normaliseSipAccounts, withCredentials, accountIssues, accountWarnings, buildRelayConfig, bridgeKeyHash } from './sip.mjs'
import { amiReload, amiRegistrations, amiRegister } from './ami.mjs'
import { E } from './errors.mjs'

export const RELAY_DEFAULTS = DEFAULTS.relay

export function relayConfigDir(settings) {
  return process.env.DSH_PHONE_ASTERISK_DIR || expandHome((settings.relay && settings.relay.configDir) || RELAY_DEFAULTS.configDir || '') || join(dataDir(), 'asterisk')
}

export const MARKER_PREFIX = '; dsh-phone-instance: '

/** The instance id in a generated file's marker line, '' when the file has none (older builds). */
export function fileInstance(text) {
  const m = /^; dsh-phone-instance: ([A-Za-z0-9-]+)/m.exec(String(text || ''))
  return m ? m[1] : ''
}

/** Prefix a generated file with this instance's marker. */
export function withMarker(text, id) {
  return MARKER_PREFIX + id + ' (this directory belongs to that phone-hookd; others refuse to write here)\n' + text
}

function stripMarker(text) {
  return String(text || '').replace(/^; dsh-phone-instance: [^\n]*\n/, '')
}

export function relaySecretsPath() { return join(dataDir(), 'relay.json') }

/** amiSecret + bridgeKey + instanceId, created once (0600). */
export function relaySecrets() {
  const p = relaySecretsPath()
  let cur = {}
  try { cur = JSON.parse(fs.readFileSync(p, 'utf8')) } catch {}
  let changed = false
  if (!cur.amiSecret) { cur.amiSecret = randomBytes(24).toString('hex'); changed = true }
  if (!cur.bridgeKey) { cur.bridgeKey = randomBytes(24).toString('hex'); changed = true }
  if (!cur.instanceId || !/^[A-Za-z0-9-]+$/.test(cur.instanceId)) { cur.instanceId = randomBytes(8).toString('hex'); changed = true }
  if (changed) writeJson0600(p, { ...cur, updatedAt: new Date().toISOString() })
  return cur
}

/** The provisioned Twilio SIP Domain bridge, or null. */
export function bridgeInfo(settings, prov = readProvisioned()) {
  if (!prov.sipDomainName || !prov.sipBridgeUser || !prov.sipBridgePassword) return null
  return { domain: prov.sipDomainName, user: prov.sipBridgeUser, password: prov.sipBridgePassword, edge: (settings.twilio && settings.twilio.sipEdge) || '' }
}

/** Accounts with credentials filled from their files and their issues. Secrets stay inside. */
export function resolveAccounts(settings, prov = readProvisioned()) {
  const bridge = bridgeInfo(settings, prov)
  return normaliseSipAccounts(settings.sipAccounts).map(a => {
    const full = withCredentials(a, a.credentialsFile ? readEnvFile(expandHome(a.credentialsFile)) : {})
    full.issues = accountIssues(full, { lines: settings.lines, bridge })
    full.warnings = accountWarnings(full, { bridge })
    return full
  })
}

/** Public view of an account (no password). */
export function accountView(a) {
  const { password, ...rest } = a
  return { ...rest, passwordSet: !!password }
}

export function amiOptions(settings, secrets = relaySecrets()) {
  const r = { ...RELAY_DEFAULTS, ...(settings.relay || {}) }
  return {
    host: process.env.DSH_PHONE_AMI_HOST || r.amiHost,
    port: Number(process.env.DSH_PHONE_AMI_PORT || r.amiPort),
    username: r.amiUser,
    secret: secrets.amiSecret,
  }
}

function transportBlock(text) {
  return String(text || '').split(/\n(?=\[)/).filter(s => /\ntype=transport\n/.test(s + '\n')).join('\n')
}

let lastSync = { at: null, state: 'off', changed: [], errors: [], restartNeeded: false, reload: null }

export function lastRelaySync() { return lastSync }

/**
 * Render + write + reload. Never throws: the result says what happened.
 * Does nothing (state 'off') unless the relay is enabled AND at least one SIP
 * account is configured, so installs without a relay never touch any
 * directory (an existing /etc/asterisk/dsh-phone of another install included).
 * Refuses (state 'error', PHONE_RELAY_DIR_FOREIGN) when a file in the include
 * directory carries another instance's marker. Files of an older build (no
 * marker) are adopted; when only the marker is new, the file is rewritten
 * without an Asterisk reload.
 */
export async function syncRelay(settings, { reload = true, log = () => {}, warn = () => {} } = {}) {
  const dir = relayConfigDir(settings)
  const r = { ...RELAY_DEFAULTS, ...(settings.relay || {}) }
  const accounts = resolveAccounts(settings)
  const codes = [] // error code of each entry of result.errors, for the log only
  const result = { at: new Date().toISOString(), state: 'ok', dir, changed: [], errors: [], restartNeeded: lastSync.restartNeeded, reload: null }
  if (!r.enabled || !accounts.length) {
    lastSync = { ...result, state: 'off', reason: !r.enabled ? 'relay disabled' : 'no SIP accounts' }
    return lastSync
  }
  try {
    // The per-instance default directory is ours to create; an explicit one (a system path) must be provisioned.
    if (!process.env.DSH_PHONE_ASTERISK_DIR && !(settings.relay && settings.relay.configDir) && !RELAY_DEFAULTS.configDir) fs.mkdirSync(dir, { recursive: true, mode: 0o750 })
    const secrets = relaySecrets()
    const bridge = bridgeInfo(settings)
    const rendered = buildRelayConfig({
      relay: r, accounts, lines: settings.lines, bridge,
      keyHash: bridgeKeyHash(secrets.bridgeKey),
      ami: { user: r.amiUser, secret: secrets.amiSecret },
      defaultCountry: settings.defaultCountry,
    })
    const files = Object.entries(rendered).map(([name, text]) => {
      let old = null
      try { old = fs.readFileSync(join(dir, name), 'utf8') } catch {}
      return { name, text: withMarker(text, secrets.instanceId), old }
    })
    const foreign = files.filter(x => x.old !== null && fileInstance(x.old) && fileInstance(x.old) !== secrets.instanceId)
    if (foreign.length) {
      codes.push('PHONE_RELAY_DIR_FOREIGN')
      result.errors.push('include directory ' + dir + ' belongs to another dsh-phone instance (' + foreign.map(x => x.name).join(', ') + '): nothing written. Set relay.configDir to this instance\'s own directory.')
      files.length = 0
    }
    for (const { name, text, old } of files) {
      if (old === text) continue
      const file = join(dir, name)
      const markerOnly = old !== null && stripMarker(old) === stripMarker(text)
      if (name === 'pjsip.conf' && old !== null && !markerOnly && transportBlock(stripMarker(old)) !== transportBlock(stripMarker(text))) result.restartNeeded = true
      const tmp = join(dir, '.' + name + '.tmp-' + process.pid)
      fs.writeFileSync(tmp, text, { mode: 0o640 })
      fs.chmodSync(tmp, 0o640)
      fs.renameSync(tmp, file)
      if (markerOnly) (result.marked = result.marked || []).push(name)
      else result.changed.push(name)
    }
    if (result.marked) log('relay config marked with this instance id (no content change, no reload): ' + result.marked.join(', ') + ' in ' + dir)
    if (result.changed.length) log('relay config written: ' + result.changed.join(', ') + ' in ' + dir)
    if (reload && result.changed.length) {
      const modules = []
      if (result.changed.includes('pjsip.conf')) modules.push('res_pjsip.so')
      if (result.changed.includes('extensions.conf')) modules.push('pbx_config.so')
      if (result.changed.includes('manager.conf')) modules.push('manager')
      try {
        result.reload = await amiReload(amiOptions(settings, secrets), modules)
        if (result.reload.some(x => !x.ok)) { result.errors.push('reload: ' + result.reload.filter(x => !x.ok).map(x => x.module + ' ' + x.message).join('; ')); codes.push('PHONE_RELAY_AMI_FAILED') }
      } catch (e) {
        result.errors.push('AMI reload failed: ' + e.message); codes.push('PHONE_RELAY_AMI_FAILED')
      }
    }
  } catch (e) {
    codes.push(['ENOENT', 'EACCES', 'EROFS'].includes(e.code) ? 'PHONE_RELAY_DIR_UNUSABLE' : 'PHONE_RELAY_SYNC_FAILED')
    result.errors.push(e.code === 'ENOENT' ? 'include directory ' + dir + ' does not exist' : e.code === 'EACCES' || e.code === 'EROFS' ? 'cannot write ' + dir + ' (' + e.code + ')' : e.message)
  }
  result.state = result.errors.length ? 'error' : 'ok'
  result.errors.forEach((msg, i) => warn(E.logLine(codes[i] || 'PHONE_RELAY_SYNC_FAILED', 'relay: ' + msg)))
  lastSync = result
  return result
}

/** Registrations as Asterisk sees them (AMI), plus the account list without secrets. */
export async function relayStatus(settings) {
  const accounts = resolveAccounts(settings).map(accountView)
  const out = { sync: lastSync, accounts, registrations: null, error: '' }
  if (lastSync.state === 'off') return out
  try { out.registrations = await amiRegistrations(amiOptions(settings)) } catch (e) { out.error = e.message }
  return out
}

/**
 * Registrations whose refresh Asterisk scheduled later than the expiry we asked for.
 * Seen with the Twilio registrar after a contact change: the 200 OK listed an older
 * binding with a longer lifetime, Asterisk refreshed on that one, and the registrar
 * dropped the live binding after 600 s ("not currently registered", error 32009).
 */
export function staleRegistrations(regs, expiries, slack = 60) {
  return (regs || []).filter(r => {
    const want = expiries[r.name]
    if (!want) return false
    return r.status !== 'Registered' ? false : r.nextReg > want + slack
  }).map(r => r.name)
}

/** Expected expiry per registration name for the current settings. */
export function registrationExpiries(settings) {
  const out = { 'dshp-bridge-reg': 600 }
  for (const a of resolveAccounts(settings)) out['dshp-' + a.id + '-reg'] = a.expiry
  return out
}

/** One watchdog pass: re-register what would outlive the registrar's binding. */
export async function relayWatchdog(settings, { log = () => {}, warn = () => {} } = {}) {
  if (lastSync.state === 'off') return []
  const opts = amiOptions(settings)
  const stale = staleRegistrations(await amiRegistrations(opts), registrationExpiries(settings))
  for (const name of stale) {
    try { if (await amiRegister(opts, name)) log('relay: re-registered ' + name + ' (refresh was scheduled past its expiry)') } catch (e) { warn('relay: re-register ' + name + ': ' + e.message) }
  }
  return stale
}
