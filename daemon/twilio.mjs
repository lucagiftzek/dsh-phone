/**
 * dsh-phone: Twilio primitives with no Twilio SDK.
 *
 *   validateSignature()  X-Twilio-Signature check (HMAC-SHA1 over URL + sorted params)
 *   voiceAccessToken()   JWT for the browser Voice SDK (VoiceGrant), HS256
 *   TwilioRest           tiny REST client (form-encoded, basic auth)
 *   twiml / el()         TwiML builder with XML escaping
 *
 * Everything here is pure and unit-tested in test/run.mjs.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

// ---------------------------------------------------------------- signature

/**
 * Twilio's request signature: base64(HMAC-SHA1(authToken, url + k1 + v1 + k2 + v2 ...))
 * with POST params sorted by key. Repeated keys contribute each unique value,
 * sorted, exactly like twilio-node's validator. The URL must be the exact URL
 * Twilio called (public scheme + host + path + query), never the URL as seen
 * behind the reverse proxy.
 */
export function expectedSignature(authToken, url, params = {}) {
  let data = String(url)
  for (const key of Object.keys(params).sort()) {
    const value = params[key]
    if (Array.isArray(value)) {
      for (const v of Array.from(new Set(value)).sort()) data += key + v
    } else {
      data += key + (value == null ? '' : value)
    }
  }
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64')
}

export function validateSignature(authToken, signature, url, params = {}) {
  if (!authToken || typeof signature !== 'string' || !signature) return false
  const candidates = [String(url)]
  // twilio-node also accepts the same URL with an explicit :443 or without it.
  // (new URL() drops a default port, so this is string surgery on purpose.)
  if (/^https:\/\//i.test(url)) {
    candidates.push(String(url).replace(/^(https:\/\/[^/:?#]+)(?=[/?#]|$)/i, '$1:443'))
    candidates.push(String(url).replace(/^(https:\/\/[^/:?#]+):443(?=[/?#]|$)/i, '$1'))
  }
  const got = Buffer.from(signature, 'utf8')
  for (const c of candidates) {
    const want = Buffer.from(expectedSignature(authToken, c, params), 'utf8')
    if (want.length === got.length && timingSafeEqual(want, got)) return true
  }
  return false
}

// ---------------------------------------------------------------- access token

function b64url(input) {
  return Buffer.from(input).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/**
 * Access token for @twilio/voice-sdk v2: an API Key (SK...) signs it, the grant
 * allows incoming calls for `identity` and outgoing calls through the TwiML App.
 */
export function voiceAccessToken({ accountSid, apiKeySid, apiKeySecret, identity, appSid, ttl = 3600, now = Date.now() }) {
  if (!accountSid || !apiKeySid || !apiKeySecret || !identity) throw new Error('voice token needs accountSid, apiKeySid, apiKeySecret and identity')
  const iat = Math.floor(now / 1000)
  const header = { typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' }
  const voice = { incoming: { allow: true } }
  if (appSid) voice.outgoing = { application_sid: appSid }
  const payload = {
    jti: apiKeySid + '-' + iat,
    iss: apiKeySid,
    sub: accountSid,
    iat,
    nbf: iat - 5,
    exp: iat + Math.max(60, Math.min(Number(ttl) || 3600, 86400)),
    grants: { identity, voice },
  }
  const body = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload))
  return body + '.' + b64url(createHmac('sha256', apiKeySecret).update(body).digest())
}

// ---------------------------------------------------------------- REST

export class TwilioError extends Error {
  constructor(status, body) {
    const msg = (body && (body.message || body.detail)) || ('HTTP ' + status)
    super('twilio ' + status + ': ' + msg)
    this.status = status
    this.code = body && body.code
    this.body = body
  }
}

export class TwilioRest {
  constructor({ accountSid, authToken, fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
    if (!accountSid || !authToken) throw new Error('Twilio account SID and auth token are required')
    this.accountSid = accountSid
    this.auth = 'Basic ' + Buffer.from(accountSid + ':' + authToken).toString('base64')
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
    this.base = 'https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(accountSid)
  }

  async request(method, path, form, { raw = false, absolute = false } = {}) {
    const url = absolute ? path : this.base + path
    const init = { method, headers: { authorization: this.auth, accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) }
    if (form) {
      const body = new URLSearchParams()
      for (const [k, v] of Object.entries(form)) {
        if (v === undefined || v === null) continue
        if (Array.isArray(v)) v.forEach(x => body.append(k, String(x)))
        else body.append(k, String(v))
      }
      init.body = body.toString()
      init.headers['content-type'] = 'application/x-www-form-urlencoded'
    }
    const r = await this.fetch(url, init)
    if (raw) {
      if (!r.ok) throw new TwilioError(r.status, null)
      return r
    }
    const text = await r.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = { message: text.slice(0, 200) } }
    if (!r.ok) throw new TwilioError(r.status, json)
    return json
  }

  account() { return this.request('GET', '.json') }
  balance() { return this.request('GET', '/Balance.json') }
  numbers() { return this.request('GET', '/IncomingPhoneNumbers.json?PageSize=100') }
  number(sid) { return this.request('GET', '/IncomingPhoneNumbers/' + encodeURIComponent(sid) + '.json') }
  updateNumber(sid, form) { return this.request('POST', '/IncomingPhoneNumbers/' + encodeURIComponent(sid) + '.json', form) }
  applications() { return this.request('GET', '/Applications.json?PageSize=100') }
  createApplication(form) { return this.request('POST', '/Applications.json', form) }
  updateApplication(sid, form) { return this.request('POST', '/Applications/' + encodeURIComponent(sid) + '.json', form) }
  keys() { return this.request('GET', '/Keys.json?PageSize=100') }
  createKey(friendlyName) { return this.request('POST', '/Keys.json', { FriendlyName: friendlyName }) }
  sendMessage(form) { return this.request('POST', '/Messages.json', form) }
  createCall(form) { return this.request('POST', '/Calls.json', form) }
  updateCall(sid, form) { return this.request('POST', '/Calls/' + encodeURIComponent(sid) + '.json', form) }
  call(sid) { return this.request('GET', '/Calls/' + encodeURIComponent(sid) + '.json') }
  deleteRecording(sid) { return this.request('DELETE', '/Recordings/' + encodeURIComponent(sid) + '.json').catch(e => { if (e.status === 404) return null; throw e }) }

  /** Download a recording or media URL that lives under this account. */
  async download(url) {
    const u = new URL(url)
    if (u.protocol !== 'https:' || u.hostname !== 'api.twilio.com' || !u.pathname.startsWith('/2010-04-01/Accounts/' + this.accountSid + '/')) {
      throw new Error('refusing to download a non-account Twilio URL')
    }
    const r = await this.request('GET', u.toString(), null, { raw: true, absolute: true })
    return { type: r.headers.get('content-type') || 'application/octet-stream', data: Buffer.from(await r.arrayBuffer()) }
  }
}

// ---------------------------------------------------------------- TwiML

export function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // strip characters XML 1.0 forbids
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

/**
 * el('Dial', { timeout: 20 }, [el('Client', {}, [el('Identity', {}, 'luca')])])
 * A string child is TEXT (escaped); an array child is MARKUP built by el().
 */
export function el(name, attrs = {}, children) {
  let out = '<' + name
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === '') continue
    out += ' ' + k + '="' + xmlEscape(v === true ? 'true' : v === false ? 'false' : v) + '"'
  }
  if (children === undefined || children === null || (Array.isArray(children) && children.filter(Boolean).length === 0)) return out + '/>'
  const inner = Array.isArray(children) ? children.filter(Boolean).join('') : xmlEscape(children)
  return out + '>' + inner + '</' + name + '>'
}

export function twiml(...verbs) {
  return '<?xml version="1.0" encoding="UTF-8"?><Response>' + verbs.flat().filter(Boolean).join('') + '</Response>'
}

// ---------------------------------------------------------------- numbers

/**
 * Normalise a user-typed number to E.164. "00" becomes "+"; a national number
 * gets the configured default country prefix. Returns null when it cannot be
 * a phone number. "client:..." identities pass through untouched.
 */
export function toE164(input, defaultCountry = '') {
  let s = String(input || '').trim()
  if (!s) return null
  if (/^client:[A-Za-z0-9_.@-]{1,120}$/.test(s)) return s
  s = s.replace(/[\s().\-\u00a0/]/g, '')
  if (s.startsWith('00')) s = '+' + s.slice(2)
  if (!s.startsWith('+')) {
    let cc = String(defaultCountry || '').replace(/[^\d]/g, '')
    if (!cc) return null
    cc = '+' + cc
    // Drop one national trunk "0" (UK 07..., DE 0151...), except Italy, where
    // the leading 0 of a landline is part of the number. Greek numbers never
    // start with 0, so this is a no-op there.
    if (cc !== '+39') s = s.replace(/^0(?=\d{6,})/, '')
    s = cc + s
  }
  if (!/^\+[1-9]\d{6,14}$/.test(s)) return null
  return s
}

/** GSM-7 vs UCS-2 segment count, so the UI and the agent can warn before sending. */
const GSM7 = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
const GSM7_EXT = '^{}\\[~]|€\f'
export function smsSegments(text) {
  const s = String(text || '')
  let gsm = true; let units = 0
  for (const ch of s) {
    if (GSM7.includes(ch)) units += 1
    else if (GSM7_EXT.includes(ch)) units += 2
    else { gsm = false; break }
  }
  if (gsm) return { encoding: 'GSM-7', chars: units, segments: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153) }
  const u = Array.from(s).reduce((n, ch) => n + (ch.codePointAt(0) > 0xffff ? 2 : 1), 0)
  return { encoding: 'UCS-2', chars: u, segments: u === 0 ? 0 : u <= 70 ? 1 : Math.ceil(u / 67) }
}
