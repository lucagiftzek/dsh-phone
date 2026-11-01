/**
 * dsh-phone: SIP accounts and the Asterisk relay configuration (pure functions).
 *
 * A SIP account (Settings > Phone > SIP accounts) is a landline or VoIP number
 * that registers through a local Asterisk relay. In bridge mode the relay
 * forwards incoming calls into a CPaaS line (a Twilio SIP Domain with SIP
 * registration), so the SIP line gets the same browser phone, voicemail, live
 * transcript and do not disturb as any other line, and it places outgoing
 * calls that the CPaaS sends back to it with a bridge key.
 *
 *   caller -> SIP provider -> Asterisk (registered) -> Twilio SIP Domain
 *          -> {base}/voice/sip (phone-hookd) -> browser / voicemail
 *   browser -> Twilio -> <Dial><Sip> to the registered relay (X-Dest, X-Bridge-Key)
 *          -> Asterisk checks the key -> SIP provider -> callee
 *
 * Everything here is pure (no I/O) and unit-tested in test/relay.mjs. The I/O
 * half (files, secrets, AMI) is daemon/relay.mjs.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

export const CODECS = ['opus', 'alaw', 'ulaw', 'g722', 'g729', 'gsm']
export const DTMF_MODES = ['rfc4733', 'info', 'inband', 'auto']
export const SRTP_MODES = ['off', 'sdes', 'required']
export const TRANSPORTS = ['udp', 'tcp', 'tls']
export const DEFAULT_CA_FILE = '/etc/ssl/certs/ca-certificates.crt'
export const DIAL_FORMATS = ['national', 'e164', 'intl00']

/** Twilio SIP signalling gateways (docs: sip-trunking/ip-addresses), keyed by edge. */
export const TWILIO_SIP_SIGNALLING = {
  ashburn: ['54.172.60.0/30'],
  umatilla: ['54.244.51.0/30'],
  dublin: ['54.171.127.192/30'],
  frankfurt: ['35.156.191.128/30'],
  tokyo: ['54.65.63.192/30'],
  singapore: ['54.169.127.128/30'],
  sydney: ['54.252.254.64/30'],
  'sao-paulo': ['177.71.206.192/30'],
}
/** Twilio media range (same for every edge). Documented here, used only for notes. */
export const TWILIO_MEDIA_RANGE = '168.86.128.0/18'

/** National significant number length for countries with a fixed length (0 = variable). */
const NSN_LENGTH = { 1: 10, 30: 10, 31: 9, 32: 9, 33: 9, 34: 9, 351: 9, 352: 0, 353: 0, 357: 8, 39: 0, 41: 9, 43: 0, 44: 10, 45: 8, 46: 0, 47: 8, 48: 9, 49: 0 }

export function nsnLength(cc) { return NSN_LENGTH[String(cc).replace(/\D/g, '')] || 0 }

export const SIP_ACCOUNT_DEFAULTS = {
  id: '',
  label: '',
  enabled: true,
  line: '',
  registrar: '',
  port: 0,
  callPort: 0,
  callSourcePort: 0,
  transport: 'udp',
  username: '',
  authUser: '',
  password: '',
  fromDomain: '',
  outboundProxy: '',
  expiry: 300,
  keepalive: 30,
  did: '',
  callerId: '',
  country: '',
  codecs: ['alaw', 'ulaw'],
  dtmf: 'rfc4733',
  srtp: 'off',
  mode: 'bridge',
  bridgeVia: '',
  ringFirstSeconds: 0,
  dialFormat: 'national',
  allowPrefixes: [],
  blockPrefixes: [],
  identifyIps: [],
  credentialsFile: '',
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,253})$/
const USER_RE = /^[A-Za-z0-9_.+@!~*'()&=$,-]{1,64}$/
const IP_OR_NET_RE = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}
function e164Prefix(p) { const s = String(p || '').replace(/[^\d+]/g, ''); return /^\+\d{1,15}$/.test(s) ? s : '' }
function ccDigits(v) { return String(v || '').replace(/\D/g, '').slice(0, 3) }

/** Clean the sipAccounts[] array from settings (unknown keys dropped, values bounded). */
export function normaliseSipAccounts(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const a of list) {
    if (!isObj(a)) continue
    const id = String(a.id || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const codecs = (Array.isArray(a.codecs) ? a.codecs : SIP_ACCOUNT_DEFAULTS.codecs).map(c => String(c).toLowerCase()).filter(c => CODECS.includes(c))
    out.push({
      id,
      label: String(a.label || id).slice(0, 40),
      enabled: a.enabled !== false,
      line: String(a.line || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32),
      registrar: String(a.registrar || '').trim(),
      port: clampInt(a.port, 0, 65535, 0),
      callPort: clampInt(a.callPort, 0, 65535, 0),
      callSourcePort: clampInt(a.callSourcePort, 0, 65535, 0),
      transport: TRANSPORTS.includes(a.transport) ? a.transport : 'udp',
      username: String(a.username || '').trim(),
      authUser: String(a.authUser || '').trim(),
      password: typeof a.password === 'string' ? a.password : '',
      fromDomain: String(a.fromDomain || '').trim(),
      outboundProxy: String(a.outboundProxy || '').trim(),
      expiry: clampInt(a.expiry, 60, 3600, 300),
      keepalive: clampInt(a.keepalive, 0, 300, 30),
      did: String(a.did || '').replace(/[^\d+]/g, ''),
      callerId: String(a.callerId || '').replace(/[^\d+]/g, ''),
      country: String(a.country || '').replace(/[^\d+]/g, ''),
      codecs: codecs.length ? Array.from(new Set(codecs)) : SIP_ACCOUNT_DEFAULTS.codecs.slice(),
      dtmf: DTMF_MODES.includes(a.dtmf) ? a.dtmf : 'rfc4733',
      srtp: SRTP_MODES.includes(a.srtp) ? a.srtp : 'off',
      mode: a.mode === 'direct' ? 'direct' : 'bridge',
      bridgeVia: String(a.bridgeVia || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32),
      ringFirstSeconds: clampInt(a.ringFirstSeconds, 0, 60, 0),
      dialFormat: DIAL_FORMATS.includes(a.dialFormat) ? a.dialFormat : 'national',
      allowPrefixes: (Array.isArray(a.allowPrefixes) ? a.allowPrefixes : []).map(e164Prefix).filter(Boolean).slice(0, 20),
      blockPrefixes: (Array.isArray(a.blockPrefixes) ? a.blockPrefixes : []).map(e164Prefix).filter(Boolean).slice(0, 50),
      identifyIps: (Array.isArray(a.identifyIps) ? a.identifyIps : []).map(String).filter(x => IP_OR_NET_RE.test(x)).slice(0, 20),
      credentialsFile: String(a.credentialsFile || '').trim(),
    })
  }
  return out
}

/**
 * Fill empty fields of an account from its credentials file (KEY=value). The
 * keys are <PREFIX>SIP_REGISTRAR, SIP_PORT, SIP_USERNAME, SIP_AUTH_USER,
 * SIP_PASSWORD, plus <PREFIX>DID; the prefix is detected from the one key that
 * ends in SIP_PASSWORD (for example ACME_SIP_PASSWORD gives ACME_).
 * Values typed in Settings win over the file.
 */
export function withCredentials(acct, env = {}) {
  const a = { ...acct }
  const pwKeys = Object.keys(env).filter(k => /SIP_PASSWORD$/.test(k))
  const prefix = pwKeys.length === 1 ? pwKeys[0].slice(0, -'SIP_PASSWORD'.length) : ''
  const pick = (name) => env[prefix + name] || ''
  const filled = []
  const fill = (field, name, transform = (x) => x) => {
    if (a[field]) return
    const v = pick(name)
    if (v) { a[field] = transform(v); filled.push(field) }
  }
  fill('registrar', 'SIP_REGISTRAR', v => String(v).trim())
  fill('port', 'SIP_PORT', v => clampInt(v, 1, 65535, 5060))
  fill('username', 'SIP_USERNAME', v => String(v).trim())
  fill('authUser', 'SIP_AUTH_USER', v => String(v).trim())
  fill('password', 'SIP_PASSWORD')
  fill('did', 'DID', v => String(v).replace(/[^\d+]/g, ''))
  a.credentialSource = filled.length ? 'file' : 'settings'
  return a
}

/** Country code digits for an account: its own setting, else its DID, else the default country. */
export function accountCountry(acct, defaultCountry = '') {
  const own = ccDigits(acct && acct.country)
  if (own) return own
  const dc = ccDigits(defaultCountry)
  const did = String(acct && acct.did || '')
  if (dc && did.startsWith('+' + dc)) return dc
  return dc
}

/** The DID as E.164 for display and matching (a national DID gets the account country). */
export function accountDid(acct, defaultCountry = '') {
  const d = String(acct && acct.did || '').replace(/[^\d+]/g, '')
  if (!d) return ''
  if (d.startsWith('+')) return d
  if (d.startsWith('00')) return '+' + d.slice(2)
  const cc = accountCountry(acct, defaultCountry)
  if (cc && d.length === cc.length + nsnLength(cc) && d.startsWith(cc)) return '+' + d
  return cc ? '+' + cc + d.replace(cc === '39' ? /^$/ : /^0/, '') : d
}

// ---------------------------------------------------------------- numbers

/**
 * Caller id from a SIP provider to E.164. Same rules as the dialplan
 * subroutine dshp-e164 that the relay runs first (see buildExtensions):
 *   sip:/tel: and @host are cut, "anonymous" style words give 'anonymous',
 *   +... stays, 00... becomes +..., a national number of the country's fixed
 *   length gets +cc, cc+national gets a +, a leading trunk 0 is replaced by +cc
 *   (not for Italy, where the 0 is part of the number). Anything else is
 *   returned as bare digits (short codes and the like).
 */
export function normaliseCaller(raw, country = '') {
  let s = String(raw == null ? '' : raw).trim()
  s = s.replace(/^<|>$/g, '').replace(/^(sips?|tel):/i, '')
  s = s.split('@')[0].split(';')[0]
  if (!s || /^(anonymous|unknown|restricted|private|unavailable|withheld)$/i.test(s)) return 'anonymous'
  let n = s.replace(/[^\d+]/g, '')
  if (n.indexOf('+') > 0) n = n.replace(/\+/g, '')
  if (!/\d/.test(n)) return 'anonymous'
  const cc = ccDigits(country)
  const nsn = nsnLength(cc)
  if (n.startsWith('+')) return n
  if (n.startsWith('00')) return '+' + n.slice(2)
  if (!cc) return n
  if (nsn && n.length === nsn) return '+' + cc + n
  if (nsn && n.length === cc.length + nsn && n.startsWith(cc)) return '+' + n
  if (cc !== '39' && n.startsWith('0') && n.length > 6) return '+' + cc + n.slice(1)
  if (!nsn && n.length > 6) return '+' + cc + n
  return n
}

/** Whether an outgoing destination may be dialled through an account. */
export function destinationAllowed(acct, dest, defaultCountry = '') {
  if (!/^\+[1-9]\d{6,14}$/.test(String(dest || ''))) return { ok: false, reason: 'not an E.164 number' }
  for (const p of acct.blockPrefixes || []) if (dest.startsWith(p)) return { ok: false, reason: 'blocked prefix ' + p }
  const allow = (acct.allowPrefixes && acct.allowPrefixes.length) ? acct.allowPrefixes : [defaultAllowPrefix(acct, defaultCountry)].filter(Boolean)
  if (!allow.length) return { ok: true }
  if (allow.some(p => dest.startsWith(p))) return { ok: true }
  return { ok: false, reason: 'outside the allowed prefixes ' + allow.join(', ') }
}

function defaultAllowPrefix(acct, defaultCountry) {
  const cc = accountCountry(acct, defaultCountry)
  return cc ? '+' + cc : ''
}

/** Caller ID the relay presents to the provider: callerId, else the DID, formatted like dialString. */
export function outgoingCallerId(acct, defaultCountry = '') {
  const raw = acct.callerId || acct.did
  if (!raw) return ''
  const e164 = accountDid({ ...acct, did: raw }, defaultCountry)
  if (!/^\+\d{6,15}$/.test(e164)) return ''
  return dialString(acct, e164, defaultCountry)
}

/** What the relay sends to the SIP provider for an E.164 destination. */
export function dialString(acct, dest, defaultCountry = '') {
  const cc = accountCountry(acct, defaultCountry)
  if (acct.dialFormat === 'e164') return dest
  if (acct.dialFormat === 'intl00') return '00' + dest.slice(1)
  if (cc && dest.startsWith('+' + cc)) return dest.slice(1 + cc.length)
  return '00' + dest.slice(1)
}

// ---------------------------------------------------------------- bridge key

export const BRIDGE_KEY_SALT = 'dsh-phone-bridge:'

/** What the relay stores: a digest of the key, never the key itself. */
export function bridgeKeyHash(key) {
  return createHash('sha1').update(BRIDGE_KEY_SALT + String(key || '')).digest('hex')
}

/**
 * Check a presented key against the stored digest in constant time. The
 * dialplan does the same comparison on digests (SHA1 of the presented key
 * against the stored SHA1), so the timing of the string compare reveals
 * nothing about the key itself.
 */
export function checkBridgeKey(presented, storedHash) {
  if (!presented || !storedHash || !/^[0-9a-f]{40}$/.test(storedHash)) return false
  const a = Buffer.from(bridgeKeyHash(presented), 'hex')
  const b = Buffer.from(storedHash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The <Sip> URI Twilio dials to send an outgoing call through the relay. */
export function bridgeSipUri({ user, domain, dest, key, account, tls = false }) {
  const q = new URLSearchParams()
  q.set('X-Dest', dest)
  q.set('X-Account', account)
  q.set('X-Bridge-Key', key)
  return 'sip:' + user + '@' + domain + (tls ? ';transport=tls;secure=true' : '') + '?' + q.toString()
}

/** Headers Twilio passes to the webhook as SipHeader_X-... params, lower-cased names. */
export function sipHeaders(params) {
  const out = {}
  for (const [k, v] of Object.entries(params || {})) {
    if (!/^SipHeader_/i.test(k)) continue
    out[k.slice('SipHeader_'.length).toLowerCase()] = Array.isArray(v) ? String(v[0]) : String(v)
  }
  return out
}

/** User part of a SIP URI (sip:gr@domain;transport=udp -> gr). */
export function sipUser(uri) {
  const s = String(uri || '').replace(/^<|>$/g, '').replace(/^(sips?|tel):/i, '')
  return s.split('@')[0].split(';')[0]
}

// ---------------------------------------------------------------- config validation

/** Problems that keep an account out of the generated relay config. */
export function accountIssues(a, { lines = [], bridge = null } = {}) {
  const issues = []
  if (!a.registrar || !HOST_RE.test(a.registrar)) issues.push('registrar host missing or invalid')
  if (!a.username || !USER_RE.test(a.username)) issues.push('username missing or has characters SIP does not allow')
  if (a.authUser && !USER_RE.test(a.authUser)) issues.push('auth username has characters SIP does not allow')
  if (!a.password) issues.push('password missing (Settings or credentials file)')
  if (/[\r\n]/.test(a.password)) issues.push('password contains a line break')
  if (a.fromDomain && !HOST_RE.test(a.fromDomain)) issues.push('from domain invalid')
  if (a.outboundProxy && !HOST_RE.test(a.outboundProxy.replace(/^sips?:/, '').replace(/:\d+$/, '').replace(/;lr$/, ''))) issues.push('outbound proxy invalid')
  if (a.mode === 'direct') issues.push('direct mode (WebRTC from the relay) is not implemented yet')
  if (a.mode === 'bridge') {
    const via = lines.find(l => l.id === a.bridgeVia)
    if (!via) issues.push('bridgeVia must name a Twilio line')
    else if (via.provider !== 'twilio') issues.push('bridgeVia line ' + via.id + ' is not a Twilio line')
  }
  const line = lines.find(l => l.id === a.line)
  if (!line) issues.push('line ' + (a.line || '(empty)') + ' does not exist')
  else if (line.provider !== 'sip') issues.push('line ' + line.id + ' must have provider sip')
  return issues
}

/** Problems that do not stop the registration (the account still rings its other phones). */
export function accountWarnings(a, { bridge = null } = {}) {
  const w = []
  if (a.mode === 'bridge' && (!bridge || !bridge.domain || !bridge.user || !bridge.password)) w.push('the Twilio SIP Domain is not provisioned yet (run Apply to Twilio): calls are not bridged')
  return w
}

// ---------------------------------------------------------------- Asterisk config

const HEADER = (what) => [
  '; ' + what + ' for the dsh-phone relay.',
  '; GENERATED by phone-hookd from Settings > Phone. Do not edit: changes are overwritten.',
  '',
]

/** A value for pjsip.conf / manager.conf: no line breaks, ';' escaped. */
export function confValue(v) {
  const s = String(v == null ? '' : v)
  if (/[\r\n]/.test(s)) throw new Error('config value contains a line break')
  return s.replace(/;/g, '\\;')
}

function section(name, type, pairs) {
  const out = ['[' + name + ']', 'type=' + type]
  for (const [k, v] of pairs) {
    if (v === undefined || v === null || v === '') continue
    for (const one of Array.isArray(v) ? v : [v]) out.push(k + '=' + confValue(one))
  }
  out.push('')
  return out
}

function hostPort(host, port) { return port && port !== 5060 ? host + ':' + port : host }

function mediaOpts(a, relay = {}) {
  const ka = clampInt(relay.rtpKeepalive, 0, 30, 2)
  return [
    // NAT without a port forward: send comfort-noise keepalives from the first moment, so the
    // router opens the RTP pinhole before the provider's media arrives (else both sides wait).
    ['rtp_keepalive', ka || undefined],
    ['rtp_timeout', 60],
    ['rtp_timeout_hold', 300],
    ['disallow', 'all'],
    ['allow', a.codecs.join(',')],
    ['dtmf_mode', a.dtmf],
    ['media_encryption', a.srtp === 'off' ? 'no' : 'sdes'],
    ['media_encryption_optimistic', a.srtp === 'sdes' ? 'yes' : ''],
    ['direct_media', 'no'],
    ['rtp_symmetric', 'yes'],
    ['force_rport', 'yes'],
    ['rewrite_contact', 'yes'],
    ['send_pai', 'no'],
    ['send_rpid', 'no'],
    ['trust_id_inbound', 'no'],
    ['trust_id_outbound', 'no'],
    ['allow_subscribe', 'no'],
    ['allow_transfer', 'no'],
    ['inband_progress', 'no'],
  ]
}

/**
 * The relay files phone-hookd writes into the include directory.
 *
 * input = {
 *   relay:    resolved settings.relay (bindAddress, bindPort, loopback, externalMediaAddress, ...)
 *   accounts: normalised accounts WITH credentials filled, each with .issues (only clean ones are used)
 *   lines:    settings.lines
 *   bridge:   { domain, user, password, edge } of the provisioned Twilio SIP Domain, or null
 *   keyHash:  bridgeKeyHash(bridge key)
 *   ami:      { user, secret }
 *   defaultCountry
 * }
 */
export function buildRelayConfig(input) {
  const { relay = {}, accounts = [], lines = [], bridge = null, keyHash = '', ami = null, defaultCountry = '' } = input
  const usable = accounts.filter(a => a.enabled && !(a.issues && a.issues.length))
  return {
    'pjsip.conf': buildPjsip({ relay, accounts: usable, bridge, defaultCountry }),
    'extensions.conf': buildExtensions({ relay, accounts: usable, lines, bridge, keyHash, defaultCountry }),
    'manager.conf': buildManager(ami),
  }
}

export const TRANSPORT_UDP = 'dshp-udp'
export const TRANSPORT_TCP = 'dshp-tcp'
export const TRANSPORT_TLS = 'dshp-tls'
export const TRANSPORT_LO = 'dshp-lo'
export const BRIDGE_ENDPOINT = 'dshp-bridge'

function transportsFor(relay, accounts) {
  const out = []
  const bind = String(relay.bindAddress || '').trim()
  const port = clampInt(relay.bindPort, 1024, 65535, 5070)
  const nets = (relay.localNets || []).filter(n => IP_OR_NET_RE.test(n))
  const ext = [
    ['local_net', nets.length ? nets : undefined],
    ['local_net', '127.0.0.0/8'],
    ['external_media_address', relay.externalMediaAddress || undefined],
    ['external_signaling_address', relay.externalSignalingAddress || undefined],
    ['external_signaling_port', relay.externalSignalingAddress && relay.externalSignalingPort ? relay.externalSignalingPort : undefined],
  ]
  if (bind) {
    out.push(...section(TRANSPORT_UDP, 'transport', [['protocol', 'udp'], ['bind', bind + ':' + port], ...ext]))
    if (accounts.some(a => a.transport === 'tcp') || relay.tcp) out.push(...section(TRANSPORT_TCP, 'transport', [['protocol', 'tcp'], ['bind', bind + ':' + port], ...ext]))
    if (needsTls(relay, accounts)) {
      // TLS hides SIP from router "SIP ALG" helpers, which otherwise rewrite the
      // signalling and remap the RTP ports of the calls they see.
      out.push(...section(TRANSPORT_TLS, 'transport', [
        ['protocol', 'tls'],
        ['bind', bind + ':' + clampInt(relay.tlsPort, 1024, 65535, 5061)],
        ['method', 'tlsv1_2'],
        ['ca_list_file', relay.caFile || DEFAULT_CA_FILE],
        ['verify_server', 'yes'],
        // Server side: Twilio opens its own TLS connection to the registered Contact for
        // calls towards the relay (it does not reuse the registration's connection), so the
        // listener needs a certificate and, behind NAT, a public Contact on a forwarded port.
        ['cert_file', relay.certFile || undefined],
        ['priv_key_file', relay.certFile ? relay.keyFile || undefined : undefined],
        ...ext.filter(([k]) => !k.startsWith('external_signaling')),
        ['external_signaling_address', relay.tlsExternalAddress || relay.externalSignalingAddress || undefined],
        ['external_signaling_port', (relay.tlsExternalAddress || relay.externalSignalingAddress) ? clampInt(relay.tlsExternalPort || relay.tlsPort, 1, 65535, 5061) : undefined],
      ]))
    }
  }
  // Per-account call socket: requests for calls leave from their own UDP port, away from
  // the registration socket that a router SIP ALG tracks (and then mangles INVITEs from).
  for (const a of accounts) {
    if (!bind || !a.callSourcePort || a.transport !== 'udp') continue
    const pub = relay.callExternalAddress || relay.tlsExternalAddress || relay.externalSignalingAddress || relay.externalMediaAddress
    out.push(...section(callTransportName(a), 'transport', [
      ['protocol', 'udp'],
      ['bind', bind + ':' + a.callSourcePort],
      ...ext.filter(([k]) => !k.startsWith('external_signaling')),
      ['external_signaling_address', pub || undefined],
      ['external_signaling_port', pub ? a.callSourcePort : undefined],
    ]))
  }
  if (relay.loopback !== false) out.push(...section(TRANSPORT_LO, 'transport', [['protocol', 'udp'], ['bind', '127.0.0.1:' + port]]))
  return out
}

export function callTransportName(a) { return 'dshp-' + a.id + '-call' }

function accountTransport(a) { return a.transport === 'tcp' ? TRANSPORT_TCP : a.transport === 'tls' ? TRANSPORT_TLS : TRANSPORT_UDP }
export function bridgeUsesTls(relay) { return !!relay && relay.bridgeTransport === 'tls' }
function needsTls(relay, accounts) { return bridgeUsesTls(relay) || accounts.some(a => a.transport === 'tls') }

function buildPjsip({ relay, accounts, bridge, defaultCountry }) {
  const out = HEADER('PJSIP accounts, transports and the Twilio bridge')
  out.push(...transportsFor(relay, accounts))
  for (const a of accounts) {
    const n = 'dshp-' + a.id
    const server = 'sip:' + hostPort(a.registrar, a.port) + (a.transport === 'tcp' ? ';transport=tcp' : a.transport === 'tls' ? ';transport=tls' : '')
    const proxy = a.outboundProxy ? (/^sips?:/.test(a.outboundProxy) ? a.outboundProxy : 'sip:' + a.outboundProxy) + (a.outboundProxy.includes(';lr') ? '' : ';lr') : ''
    out.push('; ---- account ' + a.id + ' (' + a.label + '), line ' + a.line + ', ' + a.mode + (a.bridgeVia ? ' via ' + a.bridgeVia : ''))
    out.push(...section(n + '-auth', 'auth', [['auth_type', 'userpass'], ['username', a.authUser || a.username], ['password', a.password]]))
    // Calls and keepalives may use another port of the same provider: some home routers'
    // SIP ALG silently drops INVITEs with SDP sent to 5060 (seen on a ZTE F670L).
    const callUri = a.callPort ? 'sip:' + a.registrar + ':' + a.callPort + (a.transport === 'tcp' ? ';transport=tcp' : a.transport === 'tls' ? ';transport=tls' : '') : server
    out.push(...section(n, 'aor', [['contact', callUri], ['qualify_frequency', a.keepalive || undefined], ['qualify_timeout', a.keepalive ? 3 : undefined], ['outbound_proxy', proxy]]))
    out.push(...section(n, 'endpoint', [
      ['transport', a.callSourcePort && a.transport === 'udp' ? callTransportName(a) : accountTransport(a)],
      ['context', 'dshp-in-' + a.id],
      ['aors', n],
      ['outbound_auth', n + '-auth'],
      ['from_user', a.username],
      ['from_domain', a.fromDomain || a.registrar],
      ['outbound_proxy', proxy],
      ['callerid', a.callerId ? '<' + a.callerId + '>' : undefined],
      ...mediaOpts(a, relay),
    ]))
    out.push(...section(n + '-reg', 'registration', [
      ['transport', accountTransport(a)],
      ['outbound_auth', n + '-auth'],
      ['server_uri', server],
      ['client_uri', 'sip:' + a.username + '@' + (a.fromDomain || hostPort(a.registrar, a.port))],
      ['contact_user', a.username],
      ['outbound_proxy', proxy],
      ['expiration', a.expiry],
      ['retry_interval', 60],
      ['forbidden_retry_interval', 600],
      ['fatal_retry_interval', 600],
      ['max_retries', 10000],
      ['auth_rejection_permanent', 'no'],
      ['line', 'yes'],
      ['endpoint', n],
    ]))
    out.push(...section(n, 'identify', [['endpoint', n], ['match', [a.registrar, ...a.identifyIps]]]))
  }
  if (bridge && bridge.domain && bridge.user && bridge.password && accounts.some(a => a.mode === 'bridge')) {
    const n = BRIDGE_ENDPOINT
    const edge = String(bridge.edge || '').toLowerCase()
    const tls = bridgeUsesTls(relay)
    // Over TLS the next hop must be a name on Twilio's certificate: the edge proxy
    // (sip.<edge>.twilio.com), never the wildcard domain host.
    const proxy = tls ? 'sip:sip.' + (edge || 'ashburn') + '.twilio.com:5061;transport=tls;lr' : edge ? 'sip:sip.' + edge + '.twilio.com;lr' : ''
    const tp = tls ? TRANSPORT_TLS : TRANSPORT_UDP
    const uriSuffix = tls ? ';transport=tls' : ''
    const ranges = edge && TWILIO_SIP_SIGNALLING[edge] ? TWILIO_SIP_SIGNALLING[edge] : []
    // Twilio may deliver from any of its gateways (resiliency), so all of them identify the bridge.
    const all = Array.from(new Set([...ranges, ...Object.values(TWILIO_SIP_SIGNALLING).flat()]))
    out.push('; ---- Twilio SIP Domain bridge (registered as ' + bridge.user + ', edge ' + (edge || 'ashburn') + ')')
    out.push(...section(n + '-auth', 'auth', [['auth_type', 'userpass'], ['username', bridge.user], ['password', bridge.password]]))
    out.push(...section(n, 'aor', [['contact', 'sip:' + bridge.domain + uriSuffix], ['qualify_frequency', 30], ['qualify_timeout', 3], ['outbound_proxy', proxy]]))
    out.push(...section(n, 'endpoint', [
      ['transport', tp],
      ['context', 'dshp-from-bridge'],
      ['aors', n],
      ['outbound_auth', n + '-auth'],
      ['from_domain', bridge.domain],
      ['outbound_proxy', proxy],
      ...mediaOpts({ codecs: ['ulaw', 'alaw'], dtmf: 'rfc4733', srtp: tls && relay.bridgeSrtp !== false ? 'required' : 'off' }, relay),
    ]))
    out.push(...section(n + '-reg', 'registration', [
      ['transport', tp],
      ['outbound_auth', n + '-auth'],
      ['server_uri', 'sip:' + bridge.domain + uriSuffix],
      ['client_uri', 'sip:' + bridge.user + '@' + bridge.domain],
      ['contact_user', bridge.user],
      ['outbound_proxy', proxy],
      ['expiration', 600],
      ['retry_interval', 60],
      ['forbidden_retry_interval', 600],
      ['fatal_retry_interval', 600],
      ['max_retries', 10000],
      ['auth_rejection_permanent', 'no'],
      ['line', 'yes'],
      ['endpoint', n],
    ]))
    out.push(...section(n, 'identify', [['endpoint', n], ['match', all]]))
  }
  return out.join('\n')
}

/** Dialplan pattern lines that send every extension of a context to a target. */
function catchAll(ctx, target) {
  return [
    'exten => s,1,Goto(' + target + ')',
    'exten => _[0-9a-zA-Z+*#],1,Goto(' + target + ')',
    'exten => _[0-9a-zA-Z+*#].,1,Goto(' + target + ')',
    'exten => i,1,Goto(' + target + ')',
  ]
}

/** extensions.conf string: a comma, a pipe or a newline would break the application syntax. */
function dpSafe(v, re = /^[A-Za-z0-9_.+@-]*$/) {
  const s = String(v == null ? '' : v)
  if (!re.test(s)) throw new Error('unsafe dialplan value: ' + JSON.stringify(s))
  return s
}

/**
 * E.164 normalisation in the dialplan, the mirror of normaliseCaller() with
 * the account's country baked in. ARG1 is the raw caller number.
 */
function e164Sub(name, cc, nsn) {
  const out = ['[' + name + ']',
    'exten => s,1,Set(LOCAL(n)=${FILTER(+0123456789,${CUT(ARG1,@,1)})})',
    ' same => n,GotoIf($["${LOCAL(n)}" = ""]?anon)',
    ' same => n,GotoIf($["${LOCAL(n):0:1}" = "+"]?keep)',
    ' same => n,Set(LOCAL(n)=${FILTER(0123456789,${LOCAL(n)})})',
    ' same => n,GotoIf($["${LOCAL(n):0:2}" = "00"]?intl)',
  ]
  if (!cc) out.push(' same => n,Goto(keep)')
  else {
    if (nsn) {
      out.push(' same => n,GotoIf($[${LEN(${LOCAL(n)})} = ' + nsn + ']?nat)')
      out.push(' same => n,GotoIf($[${LEN(${LOCAL(n)})} = ' + (cc.length + nsn) + ' & "${LOCAL(n):0:' + cc.length + '}" = "' + cc + '"]?cc)')
    }
    if (cc !== '39') out.push(' same => n,GotoIf($["${LOCAL(n):0:1}" = "0" & ${LEN(${LOCAL(n)})} > 6]?trunk)')
    if (!nsn) out.push(' same => n,GotoIf($[${LEN(${LOCAL(n)})} > 6]?nat)')
  }
  out.push(
    ' same => n(keep),Return(${LOCAL(n)})',
    ' same => n(intl),Return(+${LOCAL(n):2})',
    ' same => n(nat),Return(+' + cc + '${LOCAL(n)})',
    ' same => n(cc),Return(+${LOCAL(n)})',
    ' same => n(trunk),Return(+' + cc + '${LOCAL(n):1})',
    ' same => n(anon),Return(anonymous)', '')
  return out
}

/** Destination policy + caller ID + Dial for an account, from DSHP_DEST onwards. */
export function policyDial(a, defaultCountry) {
  const out = []
  const cc = accountCountry(a, defaultCountry)
  const allow = a.allowPrefixes.length ? a.allowPrefixes : (cc ? ['+' + cc] : [])
  const n = 'dshp-' + a.id
  out.push(
    ' same => n,Set(DSHP_DEST=${FILTER(+0123456789,${DSHP_DEST})})',
    ' same => n,GotoIf(${REGEX("^[+][1-9][0-9]{6,14}$" ${DSHP_DEST})}?valid)',
    ' same => n,Goto(dshp-deny,s,1)',
  )
  out.push(' same => n(valid),NoOp(dsh-phone: outgoing on ' + a.id + ' to ${DSHP_DEST})')
  for (const p of a.blockPrefixes) out.push(' same => n,GotoIf($["${DSHP_DEST:0:' + p.length + '}" = "' + dpSafe(p) + '"]?dshp-deny,s,1)')
  if (allow.length) {
    for (const p of allow) out.push(' same => n,GotoIf($["${DSHP_DEST:0:' + p.length + '}" = "' + dpSafe(p) + '"]?allowed)')
    out.push(' same => n,Goto(dshp-deny,s,1)')
  }
  out.push(' same => n(allowed),NoOp()')
  if (a.dialFormat === 'e164') out.push(' same => n,Set(DSHP_NUM=${DSHP_DEST})')
  else if (a.dialFormat === 'intl00' || !cc) out.push(' same => n,Set(DSHP_NUM=00${DSHP_DEST:1})')
  else {
    out.push(
      ' same => n,GotoIf($["${DSHP_DEST:0:' + (cc.length + 1) + '}" = "+' + cc + '"]?nat)',
      ' same => n,Set(DSHP_NUM=00${DSHP_DEST:1})',
      ' same => n,Goto(dial)',
      ' same => n(nat),Set(DSHP_NUM=${DSHP_DEST:' + (cc.length + 1) + '})',
    )
  }
  // Present the account's own number (providers reject or replace foreign caller IDs):
  // the configured caller ID, else the DID, in the format the provider dials in.
  const cli = outgoingCallerId(a, defaultCountry)
  if (cli) out.push(' same => n(dial),Set(CALLERID(all)=<' + dpSafe(cli) + '>)')
  else out.push(' same => n(dial),NoOp()')
  out.push(' same => n,Dial(PJSIP/${DSHP_NUM}@' + n + ',60)', ' same => n,Hangup()', '')
  return out
}

function buildExtensions({ relay = {}, accounts, lines, bridge, keyHash, defaultCountry }) {
  const out = HEADER('Dialplan')
  const haveBridge = !!(bridge && bridge.domain && bridge.user && bridge.password)
  out.push('[dshp-hangup]', ...catchAll('dshp-hangup', 'dshp-deny,s,1'), '')
  out.push('[dshp-deny]',
    'exten => s,1,Log(WARNING,dsh-phone-security: denied call from ${CHANNEL(pjsip,remote_addr)} endpoint ${CHANNEL(endpoint)} to ${CALLERID(dnid)})',
    ' same => n,Hangup(21)', '')

  // Headers on the call into the Twilio SIP Domain: ARG1 caller, ARG2 line, ARG3 voicemail now.
  out.push('[dshp-hdr]',
    'exten => s,1,Set(PJSIP_HEADER(add,X-Caller)=${ARG1})',
    ' same => n,Set(PJSIP_HEADER(add,X-Line)=${ARG2})',
    ' same => n,GotoIf($["${ARG3}" != "1"]?done)',
    ' same => n,Set(PJSIP_HEADER(add,X-Dsh-Voicemail)=1)',
    ' same => n(done),Return()', '')

  for (const a of accounts) {
    const cc = accountCountry(a, defaultCountry)
    const nsn = nsnLength(cc)
    const line = dpSafe(a.line, /^[a-z0-9_-]+$/)
    out.push('; ---- account ' + a.id + ': calls from the provider ring line ' + line)
    out.push(...e164Sub('dshp-e164-' + a.id, cc, nsn))
    out.push('[dshp-in-' + a.id + ']', ...catchAll('dshp-in-' + a.id, 'dshp-ring-' + a.id + ',s,1'), '')
    out.push('[dshp-ring-' + a.id + ']')
    if (a.mode === 'bridge' && haveBridge) {
      // ';' starts a comment in extensions.conf, hence the backslash.
      const target = 'PJSIP/' + BRIDGE_ENDPOINT + '/sip:' + line + '@' + dpSafe(bridge.domain) + (bridgeUsesTls(relay) ? '\\;transport=tls' : '')
      out.push(
        'exten => s,1,NoOp(dsh-phone: call on line ' + line + ' from ${CALLERID(num)})',
        ' same => n,Ringing()',
        // One call per SIP Call-ID: after a relay restart the provider may still hold the
        // previous registration for a while and fork the same call to both bindings.
        ' same => n,Set(DSHP_CID=${SHA1(${CHANNEL(pjsip,call-id)})})',
        ' same => n,Set(DSHP_L=${LOCK(dshp${DSHP_CID})})',
        ' same => n,GotoIf($[${GROUP_COUNT(${DSHP_CID}@dshpcid)} > 0]?dup)',
        ' same => n,Set(GROUP(dshpcid)=${DSHP_CID})',
        ' same => n,Set(DSHP_L=${UNLOCK(dshp${DSHP_CID})})',
        ' same => n,Gosub(dshp-e164-' + a.id + ',s,1(${CALLERID(num)}))',
        ' same => n,Set(DSHP_CALLER=${GOSUB_RETVAL})',
        ' same => n,Set(CALLERID(num)=${DSHP_CALLER})',
        ' same => n,Set(DSHP_VM=0)',
        ' same => n(dial),Dial(' + target + ',90,b(dshp-hdr^s^1(${DSHP_CALLER},' + line + ',${DSHP_VM})))',
      )
      if (a.ringFirstSeconds > 0) {
        // phone-hookd answers "busy" when the call would go straight to voicemail:
        // keep ringing the other phones on the account for a while, then ask again for voicemail.
        out.push(
          ' same => n,GotoIf($["${DIALSTATUS}" = "BUSY" & "${DSHP_VM}" = "0"]?ringfirst)',
          ' same => n,Hangup()',
          ' same => n(ringfirst),Wait(' + a.ringFirstSeconds + ')',
          ' same => n,Set(DSHP_VM=1)',
          ' same => n,Goto(dial)',
        )
      } else out.push(' same => n,Hangup()')
      out.push(
        ' same => n(dup),Set(DSHP_L=${UNLOCK(dshp${DSHP_CID})})',
        ' same => n,Log(NOTICE,dsh-phone: duplicate fork of call ${DSHP_CID} on line ' + line + ' dropped)',
        ' same => n,Hangup(17)',
      )
    } else {
      out.push('exten => s,1,Log(NOTICE,dsh-phone: line ' + line + ' has no bridge yet, the call is left to the other phones)', ' same => n,Hangup(34)')
    }
    out.push('')
  }

  // Outgoing: Twilio dials the registered relay with X-Dest, X-Account and X-Bridge-Key.
  const bridged = accounts.filter(a => a.mode === 'bridge')
  out.push('[dshp-from-bridge]', ...catchAll('dshp-from-bridge', 'dshp-out,s,1'), '')
  out.push('[dshp-out]')
  if (haveBridge && /^[0-9a-f]{40}$/.test(keyHash || '') && bridged.length) {
    out.push(
      'exten => s,1,GotoIf($["${SHA1(' + BRIDGE_KEY_SALT + '${PJSIP_HEADER(read,X-Bridge-Key)})}" != "' + keyHash + '"]?dshp-deny,s,1)',
      ' same => n,Set(DSHP_ACCT=${FILTER(a-z0-9_,${PJSIP_HEADER(read,X-Account)})})',
    )
    for (const a of bridged) out.push(' same => n,GotoIf($["${DSHP_ACCT}" = "' + a.id + '"]?dshp-out-' + a.id + ',s,1)')
    out.push(' same => n,Goto(dshp-deny,s,1)', '')
  } else {
    out.push('exten => s,1,Goto(dshp-deny,s,1)', '')
  }
  for (const a of bridged) {
    if (!haveBridge) continue
    out.push('[dshp-out-' + a.id + ']',
      'exten => s,1,Set(DSHP_DEST=${PJSIP_HEADER(read,X-Dest)})',
      ' same => n,Set(DSHP_DEST=${STRREPLACE(DSHP_DEST,%2B,+)})',
      ...policyDial(a, defaultCountry))
  }
  // Server-routed audio (0.2): hookd originates an AudioSocket channel over AMI
  // (loopback) into this context with DSHP_DEST set. No SIP endpoint can reach
  // it (endpoint contexts are dshp-in-* and dshp-from-bridge only), and the
  // same destination policy as the bridge applies.
  for (const a of accounts) {
    out.push('; ---- account ' + a.id + ': calls placed through the server audio route')
    out.push('[dshp-srv-' + a.id + ']',
      'exten => s,1,GotoIf($["${CHANNEL(channeltype)}" != "AudioSocket"]?dshp-deny,s,1)',
      ...policyDial(a, defaultCountry))
  }
  return out.join('\n')
}

function buildManager(ami) {
  const out = HEADER('Asterisk Manager Interface user (loopback only)')
  if (!ami || !ami.user || !ami.secret) return out.join('\n')
  out.push(
    '[' + dpSafe(ami.user, /^[A-Za-z0-9_-]+$/) + ']',
    'secret=' + confValue(ami.secret),
    'deny=0.0.0.0/0.0.0.0',
    'permit=127.0.0.1/255.255.255.255',
    // call: Dial/Hangup events of server-routed calls; originate: place them (0.2).
    'read=system,call',
    'write=system,config,originate,call',
    'writetimeout=5000',
    '',
  )
  return out.join('\n')
}
