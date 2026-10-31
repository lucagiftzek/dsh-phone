/**
 * dsh-phone: route security for the human-facing API (copied from dsh-mail / dsh-hpc).
 *
 * Four-layer defence, modelled on dsh-hpc's security.js:
 *   L1  TRANSPORT   req.socket.remoteAddress must be loopback.
 *   L2  TRUST FENCE harness isTrustedApiRequest behaviour copy.
 *   L3  CAPABILITY  short-lived HMAC token minted by GET /api/session.
 *   L4  HARNESS     browser-session cookie must be present on mutations.
 *
 * Placing calls and sending SMS spend money and speak as the owner, so a leaked
 * route is a real-world risk. The fence is load-bearing.
 */

'use strict'

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import fsP from 'node:fs/promises'
import { dirname } from 'node:path'

const COOKIE_PREFIX = 'dsh-auth-'
const TOKEN_TTL_MS = 15 * 60 * 1000
const SECRET_BYTES = 32

function header(headers, name) {
  const v = headers ? headers[name] : undefined
  return typeof v === 'string' ? v : undefined
}

function parseAuthority(authority) {
  try { return new URL('http://' + authority) } catch { return undefined }
}

export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

export function isLoopbackPeer(remoteAddress) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(remoteAddress ?? ''))
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some(entry => {
    const entryUrl = parseAuthority(entry)
    if (!entryUrl) return false
    const port = entryUrl.port !== '' ? entryUrl.port : (() => { try { return new URL('https://' + entry).port } catch { return '' } })()
    return port === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
  })
}

export function isTrustedApiRequest(request, trustedHosts = []) {
  const host = header(request.headers, 'host')
  if (!host) return false
  const hostUrl = parseAuthority(host)
  if (!hostUrl) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

export function harnessCookieName(hostHeader) {
  const hostUrl = parseAuthority(String(hostHeader ?? ''))
  if (!hostUrl) return null
  const digest = createHash('sha256').update(hostUrl.host).digest()
  return COOKIE_PREFIX + digest.toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

export function hasCookie(cookieHeader, name) {
  if (typeof cookieHeader !== 'string' || !name) return false
  for (const segment of cookieHeader.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim().length > 0
  }
  return false
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

export async function loadOrCreateSecret(path) {
  try {
    const raw = await fsP.readFile(path, 'utf8')
    const trimmed = raw.trim()
    if (trimmed.length >= 32) return trimmed
  } catch {}
  await fsP.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const secret = b64url(randomBytes(SECRET_BYTES))
  await fsP.writeFile(path, secret + '\n', { mode: 0o600 })
  try { await fsP.chmod(path, 0o600) } catch {}
  return secret
}

export function mintToken(secret, { nowMs = Date.now(), ttlMs = TOKEN_TTL_MS } = {}) {
  const exp = nowMs + ttlMs
  const nonce = b64url(randomBytes(12))
  const body = 'v1.' + exp + '.' + nonce
  return body + '.' + b64url(createHmac('sha256', secret).update(body).digest())
}

export function verifyToken(secret, presented, { nowMs = Date.now() } = {}) {
  if (typeof presented !== 'string' || presented.length > 512) return { ok: false, reason: 'no token' }
  const parts = presented.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') return { ok: false, reason: 'malformed token' }
  const body = parts.slice(0, 3).join('.')
  const want = b64url(createHmac('sha256', secret).update(body).digest())
  const a = Buffer.from(parts[3], 'utf8')
  const b = Buffer.from(want, 'utf8')
  if (a.byteLength !== b.byteLength || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad signature' }
  const exp = Number(parts[1])
  if (!Number.isFinite(exp) || exp < nowMs) return { ok: false, reason: 'token expired, reload the tab' }
  return { ok: true, expiresAt: exp }
}

export function checkReadRequest(req, { trustedHosts = [] } = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return { ok: false, status: 405, reason: 'read route is GET/HEAD only' }
  if (!isLoopbackPeer(req.socket && req.socket.remoteAddress)) return { ok: false, status: 403, reason: 'non-loopback peer' }
  if (!isTrustedApiRequest(req, trustedHosts)) return { ok: false, status: 403, reason: 'cross-site or untrusted Host' }
  return { ok: true }
}

export function checkMutateRequest(req, { trustedHosts = [], secret, nowMs = Date.now(), requireHarnessCookie = true } = {}) {
  if (req.method !== 'POST') return { ok: false, status: 405, layer: 'L0', reason: 'mutating route is POST only' }
  if (!isLoopbackPeer(req.socket && req.socket.remoteAddress)) return { ok: false, status: 403, layer: 'L1', reason: 'non-loopback peer' }
  if (!isTrustedApiRequest(req, trustedHosts)) return { ok: false, status: 403, layer: 'L2', reason: 'cross-site or untrusted Host' }
  const site = header(req.headers, 'sec-fetch-site')
  if (site !== 'same-origin') return { ok: false, status: 403, layer: 'L2', reason: 'sec-fetch-site must be same-origin (got ' + String(site) + ')' }
  const origin = header(req.headers, 'origin')
  if (!origin) return { ok: false, status: 403, layer: 'L2', reason: 'Origin must be present on a mutating request' }
  const ctype = header(req.headers, 'content-type') || ''
  if (!ctype.toLowerCase().startsWith('application/json')) return { ok: false, status: 415, layer: 'L2', reason: 'content-type must be application/json' }
  if (!secret) return { ok: false, status: 503, layer: 'L3', reason: 'no per-install secret' }
  const tok = verifyToken(secret, header(req.headers, 'x-dsh-phone-token'), { nowMs })
  if (!tok.ok) return { ok: false, status: 403, layer: 'L3', reason: 'capability token: ' + tok.reason }
  if (requireHarnessCookie) {
    const name = harnessCookieName(header(req.headers, 'host'))
    if (!name || !hasCookie(header(req.headers, 'cookie'), name)) return { ok: false, status: 403, layer: 'L4', reason: 'no harness browser-session cookie' }
  }
  return { ok: true, expiresAt: tok.expiresAt }
}
