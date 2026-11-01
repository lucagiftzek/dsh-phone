/**
 * dsh-phone doctor: a read-only self-check (standard: PLUGIN-DOCS-STANDARD.md, section 5).
 *
 * Served as GET /dsh-phone/api/doctor (behind the read gate) and as the agent
 * tool phone_doctor. It never calls the provider, never spends money, never
 * writes, and never throws. Only local state and the daemon's private socket
 * are read (/health, /state, and the media server registrations over loopback
 * when a SIP account is enabled). Values are reduced to booleans, counts and
 * short words: no secret, URL, number, account id or file path is reported.
 */

import { check, doctorReport, hostInfo } from './plugin-errors.js'
import { E } from './errors.js'

const DOCS = 'docs/TROUBLESHOOTING.md'

/** Code, hint and docs of a catalog entry, for a check row. */
const coded = (code, extra = {}) => ({ code, hint: E.codes[code].hint, docs: E.codes[code].docs, ...extra })

const word = (n, one, many) => `${n} ${n === 1 ? one : many}`

/**
 * @param {object} o
 * @param {object} o.ctx        the plugin context (settings mode only)
 * @param {object} o.store      the dual-settings store (describeStore, writable)
 * @param {() => object} o.settings   effective settings (secrets are never read from it)
 * @param {string} o.version
 * @param {boolean} o.configVisible   a Config is exported (0.2.x forms need it)
 * @param {(method: string, path: string, body?: any, opts?: object) => Promise<any>} o.hookd
 * @param {number} [o.timeoutMs]
 */
export async function phoneDoctor({ ctx, store, settings, version, configVisible, hookd, timeoutMs = 3000 }) {
  const host = await hostInfo(ctx).catch(() => null)
  const s = (() => { try { return settings() || {} } catch { return {} } })()
  const lines = Array.isArray(s.lines) ? s.lines : []
  const accounts = Array.isArray(s.sipAccounts) ? s.sipAccounts : []
  const twilioLines = lines.filter((l) => l.provider === 'twilio' && l.enabled !== false)
  const enabledAccounts = accounts.filter((a) => a.enabled !== false)

  // Daemon facts, read once and shared by several checks.
  const probe = async (path, ms = timeoutMs) => {
    try { return { ok: true, body: await hookd('GET', path, undefined, { timeoutMs: ms }) } } catch (e) { return { ok: false, error: e } }
  }
  const health = await probe('/health')
  const state = health.ok ? await probe('/state') : { ok: false, error: health.error }
  const st = state.ok ? state.body : null
  const relayLive = st && enabledAccounts.length ? await probe('/relay/status', timeoutMs + 2000) : null

  const checks = []
  checks.push(await check('plugin', 'Plugin loaded', async () => ({ status: 'ok', detail: `dsh-phone ${version}, route /dsh-phone/api, ${s.enabled === false ? 'disabled in Settings' : 'enabled'}` })))

  checks.push(await check('settings', 'Settings store', async () => {
    const d = store.describeStore()
    const writable = store.writable()
    return {
      status: writable ? 'ok' : 'warn',
      detail: `mode ${d.mode}${d.entryId ? ', entry ' + d.entryId : ''}, ${writable ? 'writable' : 'read-only'}`,
      ...(writable ? {} : coded('PHONE_SETTINGS_UNAVAILABLE', { human: true })),
    }
  }))

  checks.push(await check('config', 'Config visible to the loader', async () => {
    if (!host || host.settingsMode !== 'forms') return { status: 'skip', detail: 'only needed on DSH 0.2.x (settings mode forms)' }
    return configVisible
      ? { status: 'ok', detail: 'Config exported (named and default)' }
      : { status: 'fail', detail: 'no Config: the Settings form cannot be built', ...coded('PHONE_SETTINGS_UNAVAILABLE', { human: true }) }
  }))

  checks.push(await check('lines', 'Lines configured', async () => {
    if (!lines.length) return { status: 'warn', detail: 'no line configured', ...coded('PHONE_LINE_UNAVAILABLE', { human: true }) }
    const enabled = lines.filter((l) => l.enabled !== false)
    const types = {}
    for (const l of lines) types[l.provider || 'twilio'] = (types[l.provider || 'twilio'] || 0) + 1
    const typeText = Object.entries(types).map(([k, n]) => `${k} ${n}`).join(', ')
    return enabled.length
      ? { status: 'ok', detail: `${lines.length} configured, ${enabled.length} enabled (${typeText})` }
      : { status: 'warn', detail: `${lines.length} configured, none enabled (${typeText})`, ...coded('PHONE_LINE_UNAVAILABLE', { human: true }) }
  }))

  checks.push(await check('hookd', 'Hook daemon (private socket)', async () => {
    if (!health.ok) {
      const code = health.error && E.has(health.error.code) ? health.error.code : 'PHONE_HOOKD_UNAVAILABLE'
      return { status: 'fail', detail: 'not reachable over the private socket', ...coded(code, { human: true }) }
    }
    const up = Number(health.body.uptime)
    return { status: 'ok', detail: `reachable, version ${String(health.body.version || '?').slice(0, 20)}${Number.isFinite(up) ? ', up ' + up + ' s' : ''}${st ? ', mode ' + String(st.mode).slice(0, 12) : ''}` }
  }))

  checks.push(await check('provider', 'Provider credentials', async () => {
    if (!twilioLines.length) return { status: 'skip', detail: 'no enabled Twilio line' }
    if (!st || !st.credentials) return { status: 'skip', detail: 'unknown: the daemon is not reachable' }
    const c = st.credentials
    const set = (k) => !!(c[k] && c[k].set)
    const src = (k) => (c[k] && c[k].source) || 'none'
    const detail = ['accountSid', 'authToken', 'apiKeySid', 'apiKeySecret', 'twimlAppSid']
      .map((k) => `${k} ${set(k) ? 'set (' + src(k) + ')' : 'missing'}`).join(', ')
    if (!set('accountSid') || !set('authToken')) return { status: 'warn', detail, ...coded('PHONE_PROVIDER_NOT_CONFIGURED', { human: true }) }
    if (!set('apiKeySid') || !set('apiKeySecret') || !set('twimlAppSid')) return { status: 'warn', detail, ...coded('PHONE_VOICE_TOKEN_INCOMPLETE', { human: true }) }
    return { status: 'ok', detail }
  }))

  checks.push(await check('public_url', 'Public webhook base URL', async () => {
    if (!twilioLines.length) return { status: 'skip', detail: 'no enabled Twilio line' }
    const url = String(s.publicBaseUrl || '')
    if (!url) return { status: 'warn', detail: 'publicBaseUrl not set', ...coded('PHONE_PUBLIC_URL_MISSING', { human: true }) }
    return /^https:\/\//i.test(url)
      ? { status: 'ok', detail: 'set, https (reachability is not probed here: see the troubleshooting guide, webhooks)' }
      : { status: 'warn', detail: 'set, but not an https URL', hint: 'The provider only calls HTTPS webhooks; use the exact public HTTPS URL of the edge route to the daemon.', docs: E.codes.PHONE_PUBLIC_URL_MISSING.docs, human: true }
  }))

  checks.push(await check('sip_accounts', 'SIP accounts', async () => {
    if (!accounts.length) return { status: 'skip', detail: 'none configured' }
    const view = st && Array.isArray(st.sipAccounts) ? st.sipAccounts : null
    const withIssues = view ? view.filter((a) => a.enabled !== false && Array.isArray(a.issues) && a.issues.length).length : null
    const detail = `${word(accounts.length, 'account', 'accounts')}, ${enabledAccounts.length} enabled` + (withIssues === null ? ', issues unknown (daemon unreachable)' : `, ${word(withIssues, 'with issues', 'with issues')}`)
    return withIssues ? { status: 'warn', detail, ...coded('PHONE_RELAY_SYNC_FAILED', { human: true }), hint: 'An enabled account has setup issues: read sipAccounts[].issues in GET /dsh-phone/api/state and correct the settings.' } : { status: 'ok', detail }
  }))

  checks.push(await check('relay_config', 'Media server configuration generated', async () => {
    if (!enabledAccounts.length) return { status: 'skip', detail: 'no enabled SIP account' }
    if (!st || !st.relay) return { status: 'skip', detail: 'unknown: the daemon is not reachable' }
    const r = st.relay
    const n = Array.isArray(r.errors) ? r.errors.length : 0
    if (r.state === 'ok') return r.restartNeeded
      ? { status: 'warn', detail: 'generated, but the media server needs a restart to load the transport change', hint: 'Ask the human to restart the media server once (see the relay guide).', docs: E.codes.PHONE_RELAY_AMI_FAILED.docs, human: true }
      : { status: 'ok', detail: 'generated, last sync ok' }
    if (r.state === 'error') return { status: 'fail', detail: `last sync failed (${word(n, 'error', 'errors')})`, ...coded('PHONE_RELAY_SYNC_FAILED', { human: true }) }
    return { status: 'warn', detail: 'not generated yet (relay disabled or no sync has run)', ...coded('PHONE_RELAY_SYNC_FAILED', { human: true }) }
  }))

  checks.push(await check('sip_registration', 'SIP registrations', async () => {
    if (!enabledAccounts.length) return { status: 'skip', detail: 'no enabled SIP account' }
    if (!relayLive) return { status: 'skip', detail: 'unknown: the daemon is not reachable' }
    if (!relayLive.ok) return { status: 'warn', detail: 'status not available from the daemon', ...coded('PHONE_RELAY_AMI_FAILED', { human: true }) }
    const rs = relayLive.body && relayLive.body.relay
    if (rs && rs.error) return { status: 'warn', detail: 'the media server did not answer over its manager interface', ...coded('PHONE_RELAY_AMI_FAILED', { human: true }) }
    const regs = rs && Array.isArray(rs.registrations) ? rs.registrations : null
    if (!regs) return { status: 'skip', detail: 'the daemon reports no registration list (relay off)' }
    const ok = regs.filter((r) => r.status === 'Registered').length
    return ok === regs.length && regs.length > 0
      ? { status: 'ok', detail: `${ok} of ${regs.length} registered` }
      : { status: 'warn', detail: `${ok} of ${regs.length} registered`, hint: 'Check the SIP account credentials, transport and registrar reachability (troubleshooting: SIP relay, registration fails).', docs: DOCS, human: true }
  }))

  return doctorReport({ plugin: 'dsh-phone', version, host, checks, docs: DOCS })
}

/** One-paragraph text form of a report, for agent tool output. */
export function renderDoctor(report) {
  const mark = { ok: 'OK', warn: 'WARN', fail: 'FAIL', skip: 'skip', info: 'info' }
  const rows = report.checks.map((c) => `- [${mark[c.status] || c.status}] ${c.label}${c.detail ? ': ' + c.detail : ''}${c.code ? ' (' + c.code + ')' : ''}${c.human ? ' [HUMAN]' : ''}`)
  return `dsh-phone doctor: ${report.status.toUpperCase()}\n${rows.join('\n')}\nDocs: ${report.docs}`
}
