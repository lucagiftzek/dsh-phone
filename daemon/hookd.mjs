#!/usr/bin/env node
/**
 * phone-hookd: the dsh-phone call/SMS engine.
 *
 * Two listeners, deliberately separate:
 *
 *   PUBLIC   127.0.0.1:3098, reached ONLY through the edge router for
 *            https://<host>/phone-hook/ (no the site login: the provider cannot log
 *            in). Every request must carry a valid X-Twilio-Signature computed
 *            with the account auth token over the exact public URL. Nothing
 *            here reaches dsh, dsh-proxy or a shell; it answers TwiML and
 *            writes to its own database.
 *
 *   PRIVATE  unix socket ~/.dsh/phone/hookd.sock (0600). The DSH plugin is the
 *            only client: it authenticates the human (site login + same-origin +
 *            capability token) and proxies the sidebar and the agent tools here.
 *
 * Running outside dsh-web means calls keep going to voicemail and SMS keep
 * arriving while the web UI restarts.
 */

import http from 'node:http'
import fs from 'node:fs'
import fsP from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { Store } from './store.mjs'
import { TwilioRest, TwilioError, validateSignature, voiceAccessToken, el, twiml, toE164, smsSegments } from './twilio.mjs'
import { transcribe } from './transcribe.mjs'
import { E, errorBody } from './errors.mjs'
import {
  VERSION, DEFAULTS, dataDir, socketPath, resolveSettings, twilioCredentials, redact,
  writeJson0600, writeProvisioned, readProvisioned, preserveUnknownKeys,
} from './config.mjs'
import { normaliseCaller, sipHeaders, sipUser, bridgeSipUri, destinationAllowed, accountCountry } from './sip.mjs'
import { syncRelay, relayStatus, relaySecrets, bridgeInfo, resolveAccounts, accountView, lastRelaySync, relayWatchdog, amiOptions } from './relay.mjs'
import { EventEmitter } from 'node:events'
import { AudioHub } from './audio.mjs'
import { audioSocketServer } from './audiosocket.mjs'
import { acceptWebSocket, offeredProtocols, refuseUpgrade } from './ws.mjs'
import { AmiSession } from './ami.mjs'
import { createTelegram } from './telegram.mjs'

const PUBLIC_HOST = process.env.DSH_PHONE_HOOK_HOST || '127.0.0.1'
const PUBLIC_PORT = Number(process.env.DSH_PHONE_HOOK_PORT || 3098)
const MAX_BODY = 64 * 1024
const PRESENCE_TTL_MS = 75 * 1000

const DATA = dataDir()
const CONFIG_FILE = join(DATA, 'hookd-config.json')
const REC_DIR = join(DATA, 'recordings')
fs.mkdirSync(REC_DIR, { recursive: true, mode: 0o700 })
try { fs.chmodSync(DATA, 0o700) } catch {}

const log = (...a) => console.log(new Date().toISOString(), ...a)
const warn = (...a) => console.error(new Date().toISOString(), 'WARN', ...a)
const now = () => Math.floor(Date.now() / 1000)

let store
try { store = new Store(join(DATA, 'phone.db')) } catch (e) {
  console.error(new Date().toISOString(), 'WARN', E.logLine('PHONE_STORE_UNAVAILABLE', e && e.message ? e.message : e))
  throw e
}

/** Throwable coded error; `error` keeps the original text (message). */
const fail = (code, message, status) => E.raise(code, status ? { message, status } : { message })

// ------------------------------------------------------------------ config

let settings = loadConfig()

function readRawConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch { return null }
}

function loadConfig() {
  const raw = readRawConfig()
  return resolveSettings(raw || {})
}

function setConfig(raw) {
  // An older plugin build strips keys it does not know (sipAccounts, relay):
  // keep the stored ones so a dsh-web restart cannot unregister the relay.
  const next = preserveUnknownKeys(raw || {}, readRawConfig())
  writeJson0600(CONFIG_FILE, next)
  settings = resolveSettings(next)
  restCache = null
  broadcast('config', { at: Date.now() })
  queueRelaySync()
}

// ------------------------------------------------------------------ SIP relay

let relayTimer = null
function queueRelaySync(delay = 300) {
  clearTimeout(relayTimer)
  relayTimer = setTimeout(() => { syncRelay(settings, { log, warn }).catch(e => warn(E.logLine('PHONE_RELAY_SYNC_FAILED', e.message))) }, delay)
  relayTimer.unref && relayTimer.unref()
}

/** The SIP account behind a line, or null. */
function sipAccountForLine(line) {
  if (!line || line.provider !== 'sip') return null
  return resolveAccounts(settings).find(a => a.enabled && a.line === line.id) || null
}

let restCache = null
function rest() {
  const c = twilioCredentials(settings)
  const key = c.accountSid.value + ':' + c.authToken.value
  if (restCache && restCache.key === key) return restCache.client
  if (!c.accountSid.value || !c.authToken.value) throw fail('PHONE_PROVIDER_NOT_CONFIGURED', 'Twilio account SID and auth token are not configured')
  restCache = { key, client: new TwilioRest({ accountSid: c.accountSid.value, authToken: c.authToken.value }) }
  return restCache.client
}

function authToken() { return twilioCredentials(settings).authToken.value }

function lineById(id) { return settings.lines.find(l => l.id === id && l.enabled) || null }
function lineForNumber(num) { return settings.lines.find(l => l.enabled && l.number === num) || null }
function defaultLine() { return lineById(settings.defaultLine) || settings.lines.find(l => l.enabled) || null }

function hook(path, query) {
  const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString() : ''
  return settings.publicBaseUrl + path + (qs ? '?' + qs : '')
}

// ------------------------------------------------------------------ mode + presence

function getMode() {
  const m = store.get('mode', null)
  return ['live', 'voicemail', 'dnd'].includes(m) ? m : settings.incoming.defaultMode
}
function setMode(mode, by) {
  if (!['live', 'voicemail', 'dnd'].includes(mode)) throw fail('PHONE_MODE_INVALID', 'mode must be live, voicemail or dnd')
  store.set('mode', mode)
  log('mode ->', mode, 'by', by || '?')
  broadcast('mode', { mode, by: by || '' })
  return mode
}

const presence = new Map() // clientId -> { at, registered }
/** A Phone tab that takes calls through the server audio route is online. */
function serverBrowserOnline() {
  const cutoff = Date.now() - PRESENCE_TTL_MS
  for (const p of presence.values()) if (p.at >= cutoff && p.registered && p.audio === 'server') return true
  return false
}

function browserOnline() {
  const cutoff = Date.now() - PRESENCE_TTL_MS
  for (const [id, p] of presence) {
    if (p.at < cutoff) { presence.delete(id); continue }
    if (p.registered) return true
  }
  return false
}

// ------------------------------------------------------------------ events (SSE)

const sseClients = new Set()
let eventSeq = 0
function broadcast(type, data) {
  const payload = 'id: ' + (++eventSeq) + '\nevent: ' + type + '\ndata: ' + JSON.stringify(data || {}) + '\n\n'
  for (const res of sseClients) { try { res.write(payload) } catch { sseClients.delete(res) } }
}
setInterval(() => { for (const res of sseClients) { try { res.write(': ping\n\n') } catch { sseClients.delete(res) } } }, 20000).unref()

// Telegram: telegramd (Go) holds the account; this bridge stores chats in phone.db and serves /tg/*.
const tg = createTelegram({
  store, broadcast, log, warn, dataDir: DATA, transcribe: (audio) => transcribe(settings.voicemail, audio),
  hub: () => hub, mode: () => getMode(), online: () => browserOnline(), ringSeconds: () => settings.incoming.ringSeconds,
})

// ------------------------------------------------------------------ helpers

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolveP, reject) => {
    let size = 0; const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > limit) { reject(fail('PHONE_BODY_TOO_LARGE', 'body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolveP(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function parseForm(buf) {
  const out = {}
  for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) {
    if (k in out) out[k] = [].concat(out[k], v)
    else out[k] = v
  }
  return out
}

function sendXml(res, xml) {
  res.writeHead(200, { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store' })
  res.end(xml)
}
function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}
const one = (v) => Array.isArray(v) ? v[0] : (v == null ? '' : String(v))

function displayName(num) {
  const c = store.contact(num)
  return c && c.name ? c.name : ''
}

/** Read a number aloud digit by digit for the screening prompt. */
function spokenNumber(num) {
  const n = displayName(num)
  if (n) return n
  return String(num || 'an unknown number').replace(/^\+/, 'plus ').split('').join(' ').replace(/\s+/g, ' ')
}

// ------------------------------------------------------------------ voicemail

const vmLive = new Map() // callSid -> { vmId, finals: [], partial: '' }

function voicemailTwiml({ callSid, line, peer, greeting = true }) {
  const vmCfg = settings.voicemail
  if (!vmCfg.enabled) {
    store.upsertCall({ sid: callSid, disposition: 'missed' })
    broadcast('call.update', { call: store.callBySid(callSid) })
    return twiml(el('Say', sayAttrs(), 'The person you are calling is not available. Please try again later.'), el('Hangup'))
  }
  let vm = store.addVoicemail({ callSid, line: line ? line.id : '', peer, status: 'recording' })
  // A pickup that was not answered comes back here for the same call.
  if (vm.status !== 'recording') vm = store.updateVoicemail(vm.id, { status: 'recording' })
  store.upsertCall({ sid: callSid, disposition: 'voicemail' })
  if (!vmLive.has(callSid)) vmLive.set(callSid, { vmId: vm.id, finals: [], partial: '' })
  const contact = store.contact(peer)
  broadcast('vm.started', { vm, call: store.callBySid(callSid), silent: isSilent(contact) })

  const verbs = []
  if (vmCfg.liveTranscript) {
    verbs.push(el('Start', {}, [el('Transcription', {
      name: 'vm' + vm.id,
      statusCallbackUrl: hook('/voice/live-transcript', { vm: vm.id }),
      languageCode: vmCfg.liveLanguage || 'en-US',
      track: 'inbound_track',
      partialResults: true,
      profanityFilter: false,
      transcriptionEngine: vmCfg.liveEngine || undefined,
      speechModel: vmCfg.liveModel || undefined,
    })]))
  }
  if (greeting) {
    if (vmCfg.greetingAudioUrl) verbs.push(el('Play', {}, vmCfg.greetingAudioUrl))
    else verbs.push(el('Say', sayAttrs(), vmCfg.greeting || DEFAULTS.voicemail.greeting))
  } else {
    verbs.push(el('Say', sayAttrs(), 'Please leave a message after the tone.'))
  }
  verbs.push(el('Record', {
    maxLength: vmCfg.maxSeconds,
    playBeep: true,
    timeout: 6,
    trim: 'trim-silence',
    finishOnKey: '#',
    action: hook('/voice/vm-done', { vm: vm.id }),
    method: 'POST',
    recordingStatusCallback: hook('/voice/recording', { vm: vm.id }),
    recordingStatusCallbackMethod: 'POST',
    recordingStatusCallbackEvent: 'completed',
  }))
  verbs.push(el('Say', sayAttrs(), 'No message was recorded. Goodbye.'))
  verbs.push(el('Hangup'))
  return twiml(verbs)
}

function sayAttrs() {
  const v = settings.voicemail
  return { voice: v.greetingVoice || undefined, language: v.greetingLanguage || undefined }
}

function isSilent(contact) {
  const mode = getMode()
  if (mode !== 'dnd') return false
  return !(contact && contact.starred && settings.incoming.dndBypassStarred)
}

async function processRecording(vmId, p) {
  const vm = store.voicemail(vmId) || store.voicemailByCall(one(p.CallSid))
  if (!vm) { warn('recording for unknown voicemail', vmId); return }
  const recSid = one(p.RecordingSid)
  if (vm.recordingSid === recSid && vm.hasAudio) return // retried callback
  const duration = Number(one(p.RecordingDuration)) || 0
  if (!recSid || one(p.RecordingStatus) !== 'completed') {
    store.updateVoicemail(vm.id, { status: vm.pickedUp ? 'picked_up' : 'failed' })
    broadcast('vm.update', { vm: store.voicemail(vm.id) })
    return
  }
  if (duration < 1) {
    store.updateVoicemail(vm.id, { status: vm.pickedUp ? 'picked_up' : 'empty', recording_sid: recSid, duration })
    broadcast('vm.update', { vm: store.voicemail(vm.id) })
    if (settings.voicemail.deleteFromProvider) rest().deleteRecording(recSid).catch(e => warn('delete recording', e.message))
    return
  }
  store.updateVoicemail(vm.id, { status: 'processing', recording_sid: recSid, duration })
  broadcast('vm.update', { vm: store.voicemail(vm.id) })
  let audio
  try {
    audio = await rest().download(one(p.RecordingUrl) + '.mp3')
    const file = join(REC_DIR, recSid.replace(/[^A-Za-z0-9]/g, '') + '.mp3')
    await fsP.writeFile(file, audio.data, { mode: 0o600 })
    store.updateVoicemail(vm.id, { file })
  } catch (e) {
    warn(E.logLine('PHONE_RECORDING_DOWNLOAD_FAILED', e.message))
    store.updateVoicemail(vm.id, { status: 'failed' })
    broadcast('vm.update', { vm: store.voicemail(vm.id) })
    return
  }
  try {
    const t = await transcribe(settings.voicemail, { type: 'audio/mpeg', data: audio.data })
    store.updateVoicemail(vm.id, { status: 'ready', transcript: t.text, language: t.language, engine: t.engine })
  } catch (e) {
    warn(E.logLine('PHONE_TRANSCRIBE_FAILED', e.message))
    const live = store.voicemail(vm.id).liveText
    store.updateVoicemail(vm.id, { status: 'ready', transcript: live || '', engine: live ? 'live' : 'none' })
  }
  const done = store.voicemail(vm.id)
  broadcast('vm.ready', { vm: done, silent: isSilent(store.contact(done.peer)) })
  if (settings.voicemail.deleteFromProvider) rest().deleteRecording(recSid).catch(e => warn('delete recording', e.message))
}

// ------------------------------------------------------------------ SMS

async function sendSms({ to, body, line: lineId, origin = 'ui' }) {
  const line = lineId ? lineById(lineId) : defaultLine()
  if (!line) throw fail('PHONE_LINE_UNAVAILABLE', 'no enabled line' + (lineId ? ' with id ' + lineId : ''))
  if (!line.sms) throw fail('PHONE_LINE_UNAVAILABLE', 'line ' + line.id + ' has SMS disabled')
  if (line.provider !== 'twilio') throw fail('PHONE_LINE_UNAVAILABLE', 'line ' + line.id + ' (' + line.provider + ') cannot send SMS yet')
  const dest = toE164(to, settings.defaultCountry)
  if (!dest || dest.startsWith('client:')) throw fail('PHONE_NUMBER_INVALID', 'not a valid phone number: ' + to + (settings.defaultCountry ? '' : ' (use +countrycode, or set a default country in Settings)'))
  const text = String(body || '').trim()
  if (!text) throw fail('PHONE_MESSAGE_INVALID', 'empty message')
  if (text.length > settings.sms.maxChars) throw fail('PHONE_MESSAGE_INVALID', 'message is longer than ' + settings.sms.maxChars + ' characters')
  const seg = smsSegments(text)
  const row = store.addMessage({ sid: null, line: line.id, peer: dest, direction: 'out', body: text, status: 'sending', segments: seg.segments, read: true, origin })
  broadcast('sms.out', { message: row })
  try {
    const r = await rest().sendMessage({ From: line.number, To: dest, Body: text, StatusCallback: hook('/sms/status') })
    store.setMessageSid(row.id, r.sid, r.status || 'queued')
    const m = store.message(row.id)
    broadcast('sms.status', { message: m })
    return m
  } catch (e) {
    store.failMessage(row.id, e.message)
    broadcast('sms.status', { message: store.message(row.id) })
    throw e
  }
}

// ------------------------------------------------------------------ incoming calls (shared)

/**
 * The incoming-call plan for any line: block list, Live (ring the browser and
 * the forward number) or voicemail with the live transcript, DND silence.
 * ringFirst (SIP lines whose other phones should ring first): when the call
 * would go straight to voicemail, answer busy without recording anything; the
 * relay keeps the other phones ringing and calls back with X-Dsh-Voicemail.
 */
function incomingCall({ callSid, from, line, callStatus, ringFirst = false }) {
  const mode = getMode()
  const contact = store.contact(from)
  const sipLine = !!(line && line.provider === 'sip')
  const anonymous = !/^\+?\d{5,}$/.test(from)
  const blocked = (contact && contact.blocked) || (anonymous && settings.incoming.rejectAnonymous)
  const ringBrowser = mode === 'live' || (mode === 'dnd' && contact && contact.starred && settings.incoming.dndBypassStarred)
  const online = browserOnline()
  const forward = mode === 'live' ? toE164(settings.incoming.forwardTo, settings.defaultCountry) : null
  const ringsSomething = (ringBrowser && online) || !!(forward && !forward.startsWith('client:'))
  if (ringFirst && !blocked && !(line && !line.voice) && !ringsSomething) {
    log('sip line', line ? line.id : '?', 'call from', from, ': nothing to ring here, the relay rings its other phones first')
    return twiml(el('Reject', { reason: 'busy' }))
  }

  store.upsertCall({ sid: callSid, line: line ? line.id : '', peer: from, direction: 'in', status: callStatus, disposition: 'ringing', mode, origin: sipLine ? 'sip' : 'provider' })

  if (blocked) {
    store.upsertCall({ sid: callSid, disposition: 'blocked' })
    broadcast('call.update', { call: store.callBySid(callSid), silent: true })
    return twiml(el('Reject', { reason: sipLine ? 'rejected' : 'busy' }))
  }
  if (line && !line.voice) {
    store.upsertCall({ sid: callSid, disposition: 'blocked' })
    return twiml(el('Reject', { reason: sipLine ? 'rejected' : 'busy' }))
  }

  // Server audio route (0.2): a Phone tab that takes calls via the server is
  // online. The call is held on a Twilio Media Stream to hookd (the caller hears
  // ringback generated here), the tabs ring over the event stream, and the tab
  // that answers is bridged to the stream. Unanswered after ringSeconds, or
  // declined, the stream closes and <Connect action> plays voicemail as before.
  const forwardSet = !!(forward && !forward.startsWith('client:'))
  let serverRing = null
  if (ringBrowser && online && !forwardSet && serverBrowserOnline()) {
    serverRing = hub.ringSession({ callSid, from, line, ringSeconds: settings.incoming.ringSeconds })
    if (!serverRing) warn('audio: no free server audio slot, ringing the direct route only')
  }
  broadcast('call.incoming', { call: store.callBySid(callSid), ringing: ringBrowser && online, silent: isSilent(contact), route: serverRing ? 'server' : 'direct' })
  if (serverRing) return serverRing.twiml

  const targets = []
  if (ringBrowser && online) {
    targets.push(el('Client', {}, [
      el('Identity', {}, settings.identity),
      el('Parameter', { name: 'line', value: line ? line.id : '' }),
      el('Parameter', { name: 'peer', value: from }),
      el('Parameter', { name: 'name', value: contact && contact.name ? contact.name : '' }),
    ]))
  }
  if (forward && !forward.startsWith('client:')) {
    targets.push(el('Number', { url: hook('/voice/screen', { from }) }, forward))
  }
  if (!targets.length) return voicemailTwiml({ callSid, line, peer: from })
  return twiml(el('Dial', {
    timeout: settings.incoming.ringSeconds,
    answerOnBridge: true,
    action: hook('/voice/dial-done', { line: line ? line.id : '' }),
    method: 'POST',
  }, targets))
}

// ------------------------------------------------------------------ PUBLIC: webhook handlers

const PUBLIC_ROUTES = {
  async '/voice/incoming'(p, q) {
    const line = lineById(q.line) || lineForNumber(one(p.To)) || defaultLine()
    return incomingCall({ callSid: one(p.CallSid), from: one(p.From) || 'anonymous', line, callStatus: one(p.CallStatus) })
  },

  /**
   * A call from the SIP relay through the Twilio SIP Domain (its Voice URL).
   * The relay sets X-Line (the line id, also the To user) and X-Caller (the
   * caller in E.164); X-Dsh-Voicemail: 1 marks the second attempt of a
   * ring-first account, which goes straight to voicemail.
   */
  async '/voice/sip'(p) {
    const h = sipHeaders(p)
    const lineId = String(h['x-line'] || sipUser(one(p.To)) || '').toLowerCase()
    const line = lineById(lineId)
    if (!line || line.provider !== 'sip') {
      warn(E.logLine('PHONE_SIP_LINE_UNKNOWN', 'sip call for unknown line ' + (lineId || '(none)')))
      return twiml(el('Reject', { reason: 'rejected' }))
    }
    const acct = sipAccountForLine(line)
    const cc = acct ? accountCountry(acct, settings.defaultCountry) : String(settings.defaultCountry || '').replace(/\D/g, '')
    let from = normaliseCaller(h['x-caller'] || sipUser(one(p.From)), cc)
    if (from !== 'anonymous' && !/^\+[1-9]\d{6,14}$/.test(from) && !/^\d{2,15}$/.test(from)) from = 'anonymous'
    const vmNow = h['x-dsh-voicemail'] === '1'
    return incomingCall({ callSid: one(p.CallSid), from, line, callStatus: one(p.CallStatus), ringFirst: !!(acct && acct.ringFirstSeconds > 0 && !vmNow) })
  },

  async '/voice/dial-done'(p, q) {
    const callSid = one(p.CallSid)
    const status = one(p.DialCallStatus)
    const call = store.callBySid(callSid)
    const line = lineById(q.line) || (call && lineById(call.line)) || defaultLine()
    const peer = (call && call.peer) || one(p.From)
    if (status === 'completed' || status === 'answered') {
      store.upsertCall({ sid: callSid, disposition: q.pickup ? 'picked_up' : 'answered', duration: Number(one(p.DialCallDuration)) || 0 })
      broadcast('call.update', { call: store.callBySid(callSid) })
      return twiml(el('Hangup'))
    }
    if (one(p.CallStatus) === 'completed' || status === 'canceled') {
      // The caller hung up while it was ringing.
      store.upsertCall({ sid: callSid, disposition: 'missed' })
      broadcast('call.update', { call: store.callBySid(callSid), missed: true })
      return twiml(el('Hangup'))
    }
    store.upsertCall({ sid: callSid, disposition: status === 'busy' ? 'declined' : 'no-answer' })
    return voicemailTwiml({ callSid, line, peer, greeting: !q.pickup })
  },

  /** <Connect><Stream> ended (server audio route): voicemail for an unanswered ring, else hang up. */
  async '/voice/stream-done'(p, q) {
    const callSid = one(p.CallSid)
    const next = hub.streamDone(callSid)
    const call = store.callBySid(callSid)
    if (next === 'voicemail' && call) {
      if (call.disposition !== 'declined') store.upsertCall({ sid: callSid, disposition: 'no-answer' })
      const line = lineById(call.line) || defaultLine()
      return voicemailTwiml({ callSid, line, peer: call.peer })
    }
    return twiml(el('Hangup'))
  },

  async '/voice/screen'(p, q) {
    return twiml(
      el('Gather', { numDigits: 1, timeout: 8, action: hook('/voice/screen-result'), method: 'POST' }, [
        el('Say', sayAttrs(), 'Call from ' + spokenNumber(q.from) + '. Press 1 to accept.'),
      ]),
      el('Hangup'),
    )
  },

  async '/voice/screen-result'(p) {
    return one(p.Digits) === '1' ? twiml() : twiml(el('Hangup'))
  },

  async '/voice/vm-done'(p, q) {
    const vm = store.voicemail(Number(q.vm)) || store.voicemailByCall(one(p.CallSid))
    if (vm && Number(one(p.RecordingDuration)) > 0 && vm.status === 'recording') {
      store.updateVoicemail(vm.id, { status: 'processing' })
      broadcast('vm.update', { vm: store.voicemail(vm.id) })
    }
    return twiml(el('Say', sayAttrs(), 'Thank you. Goodbye.'), el('Hangup'))
  },

  async '/voice/recording'(p, q) {
    // Answer at once; the download and transcription run after the response.
    setImmediate(() => { processRecording(Number(q.vm), p).catch(e => warn(E.logLine('PHONE_INTERNAL', 'processRecording ' + e.message))) })
    return null
  },

  async '/voice/live-transcript'(p, q) {
    const callSid = one(p.CallSid)
    const ev = one(p.TranscriptionEvent)
    let live = vmLive.get(callSid)
    if (!live) {
      const vm = store.voicemail(Number(q.vm)) || store.voicemailByCall(callSid)
      if (!vm) return null
      live = { vmId: vm.id, finals: [], partial: '' }
      vmLive.set(callSid, live)
    }
    if (ev === 'transcription-content') {
      let text = ''
      try { text = String(JSON.parse(one(p.TranscriptionData) || '{}').transcript || '') } catch {}
      const final = one(p.Final) === 'true'
      if (final) { if (text.trim()) live.finals.push(text.trim()); live.partial = '' } else live.partial = text.trim()
      const joined = live.finals.join(' ') + (live.partial ? (live.finals.length ? ' ' : '') + live.partial : '')
      if (final) store.updateVoicemail(live.vmId, { live_text: live.finals.join(' ') })
      broadcast('vm.live', { vmId: live.vmId, callSid, text: joined, final })
    } else if (ev === 'transcription-stopped' || ev === 'transcription-error') {
      store.updateVoicemail(live.vmId, { live_text: live.finals.join(' ') })
      if (ev === 'transcription-error') warn(E.logLine('PHONE_LIVE_TRANSCRIPT_FAILED', [one(p.TranscriptionError), one(p.TranscriptionErrorCode)].filter(Boolean).join(' ')))
      broadcast('vm.live', { vmId: live.vmId, callSid, text: live.finals.join(' '), final: true, stopped: true })
    }
    return null
  },

  async '/voice/status'(p) {
    const callSid = one(p.CallSid)
    const status = one(p.CallStatus)
    hub.onStatus(callSid, status)
    const call = store.callBySid(callSid)
    if (!call) return null
    const terminal = ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(status)
    const patch = { sid: callSid, status }
    if (terminal) {
      patch.ended = now()
      if (p.CallDuration) patch.duration = Math.max(call.duration || 0, Number(one(p.CallDuration)) || 0)
      if (call.disposition === 'ringing' || call.disposition === 'dialing') patch.disposition = call.direction === 'in' ? 'missed' : status
      vmLive.delete(callSid)
    }
    store.upsertCall(patch)
    const updated = store.callBySid(callSid)
    broadcast(terminal ? 'call.ended' : 'call.update', { call: updated })
    if (terminal) {
      const vm = store.voicemailByCall(callSid)
      if (vm && vm.status === 'recording') {
        // Hung up before the beep, or a pickup that ended: the recording
        // callback (if any) will still upgrade this.
        setTimeout(() => {
          const v = store.voicemail(vm.id)
          if (v && v.status === 'recording') { store.updateVoicemail(v.id, { status: v.pickedUp ? 'picked_up' : 'empty' }); broadcast('vm.update', { vm: store.voicemail(v.id) }) }
        }, 90000).unref()
      }
    }
    return null
  },

  async '/voice/outbound'(p) {
    const callSid = one(p.CallSid)
    if (one(p.From) !== 'client:' + settings.identity) {
      warn(E.logLine('PHONE_OUTBOUND_CLIENT_REFUSED', 'outbound from unexpected client ' + one(p.From)))
      return twiml(el('Say', {}, 'This client is not allowed to place calls.'), el('Hangup'))
    }
    const to = toE164(one(p.To), settings.defaultCountry)
    const line = lineById(one(p.line)) || defaultLine()
    if (!to || to.startsWith('client:')) return twiml(el('Say', {}, 'That number is not valid.'), el('Hangup'))
    if (line && line.voice && line.provider === 'sip') return outboundSip({ callSid, line, to })
    if (!line || !line.voice || line.provider !== 'twilio') return twiml(el('Say', {}, 'No line is available for calls.'), el('Hangup'))
    store.upsertCall({ sid: callSid, line: line.id, peer: to, direction: 'out', status: 'initiated', disposition: 'dialing', mode: getMode(), origin: 'ui' })
    broadcast('call.update', { call: store.callBySid(callSid) })
    return twiml(el('Dial', {
      callerId: line.number,
      answerOnBridge: true,
      timeout: 45,
      action: hook('/voice/out-done'),
      method: 'POST',
    }, [el('Number', {}, to)]))
  },

  async '/voice/out-done'(p) {
    const callSid = one(p.CallSid)
    const status = one(p.DialCallStatus)
    store.upsertCall({ sid: callSid, disposition: status === 'completed' ? 'answered' : status, duration: Number(one(p.DialCallDuration)) || 0 })
    broadcast('call.update', { call: store.callBySid(callSid) })
    return twiml(el('Hangup'))
  },

  async '/voice/say-done'(p) {
    const callSid = one(p.CallSid)
    const status = one(p.CallStatus)
    if (store.callBySid(callSid)) {
      store.upsertCall({ sid: callSid, status, ended: now(), duration: Number(one(p.CallDuration)) || 0, disposition: status === 'completed' ? 'answered' : status })
      broadcast('call.ended', { call: store.callBySid(callSid) })
    }
    return null
  },

  async '/sms'(p, q) {
    const sid = one(p.MessageSid) || one(p.SmsSid)
    const from = one(p.From)
    const line = lineById(q.line) || lineForNumber(one(p.To)) || defaultLine()
    const contact = store.contact(from)
    const media = []
    const n = Math.min(10, Number(one(p.NumMedia)) || 0)
    for (let i = 0; i < n; i++) {
      const url = one(p['MediaUrl' + i])
      if (url) media.push({ url, type: one(p['MediaContentType' + i]) })
    }
    const blocked = !!(contact && contact.blocked)
    const msg = store.addMessage({ sid, line: line ? line.id : '', peer: from, direction: 'in', body: one(p.Body), media, status: 'received', read: blocked, origin: 'provider', segments: Number(one(p.NumSegments)) || 1 })
    if (!msg || blocked) return twiml()
    broadcast('sms.in', { message: msg, name: contact ? contact.name : '', silent: isSilent(contact) })
    // Do-not-disturb auto reply: at most once per sender per 12 hours.
    const auto = String(settings.sms.dndAutoReply || '').trim()
    if (auto && getMode() === 'dnd' && line && store.recentOutbound(line.id, from, now() - 12 * 3600, 'auto') === 0) {
      sendSms({ to: from, body: auto, line: line.id, origin: 'auto' }).catch(e => warn('auto reply', e.message))
    }
    return twiml()
  },

  async '/sms/status'(p) {
    const sid = one(p.MessageSid) || one(p.SmsSid)
    const status = one(p.MessageStatus) || one(p.SmsStatus)
    const code = one(p.ErrorCode)
    const m = store.setMessageStatus(sid, status, code ? 'error ' + code : '')
    if (status === 'failed' || status === 'undelivered') warn(E.logLine('PHONE_SMS_DELIVERY_FAILED', 'status ' + status + (code ? ' provider error ' + code : '')))
    if (m) broadcast('sms.status', { message: m })
    return null
  },
}

/**
 * Browser call on a SIP line: Twilio dials the registered relay, which checks
 * the bridge key and places the call through the SIP provider.
 */
function outboundSip({ callSid, line, to }) {
  const acct = sipAccountForLine(line)
  const bridge = bridgeInfo(settings)
  if (!acct || acct.mode !== 'bridge' || !bridge) return twiml(el('Say', {}, 'This line is not connected yet.'), el('Hangup'))
  const allowed = destinationAllowed(acct, to, settings.defaultCountry)
  if (!allowed.ok) {
    warn(E.logLine('PHONE_OUTBOUND_DESTINATION_BLOCKED', ['sip outbound refused', line.id, to, allowed.reason].join(' ')))
    return twiml(el('Say', {}, 'This number cannot be called from this line.'), el('Hangup'))
  }
  store.upsertCall({ sid: callSid, line: line.id, peer: to, direction: 'out', status: 'initiated', disposition: 'dialing', mode: getMode(), origin: 'ui' })
  broadcast('call.update', { call: store.callBySid(callSid) })
  const uri = bridgeSipUri({ user: bridge.user, domain: bridge.domain, dest: to, key: relaySecrets().bridgeKey, account: acct.id, tls: settings.relay.bridgeTransport === 'tls' })
  return twiml(el('Dial', {
    callerId: line.number || undefined,
    answerOnBridge: true,
    timeout: 45,
    action: hook('/voice/out-done'),
    method: 'POST',
  }, [el('Sip', {}, uri)]))
}

async function handlePublic(req, res) {
  try {
    if (!settings.publicBaseUrl) { E.send(res, 'PHONE_PUBLIC_URL_MISSING'); return }
    const base = new URL(settings.publicBaseUrl)
    const basePath = base.pathname.replace(/\/+$/, '')
    const reqUrl = req.url || '/'
    const subPath = basePath && reqUrl.startsWith(basePath + '/') ? reqUrl.slice(basePath.length) : reqUrl
    const parsed = new URL(subPath, 'http://hook.local')
    const route = parsed.pathname.replace(/\/+$/, '')

    if (req.method === 'GET' && route === '/health') { sendJson(res, 200, { ok: true, service: 'dsh-phone' }); return }
    if (req.method !== 'POST') { res.setHeader('allow', 'POST'); E.send(res, 'PHONE_METHOD_NOT_ALLOWED'); return }
    const handler = PUBLIC_ROUTES[route]
    if (!handler) { E.send(res, 'PHONE_NOT_FOUND'); return }

    const buf = await readBody(req)
    const params = parseForm(buf)
    const token = authToken()
    const signatureUrl = settings.publicBaseUrl + subPath
    if (!token || !validateSignature(token, one(req.headers['x-twilio-signature']), signatureUrl, params)) {
      warn(E.logLine('PHONE_SIGNATURE_INVALID', 'rejected unsigned/invalid webhook ' + route + ' from ' + (one(req.headers['cf-connecting-ip']) || one(req.headers['x-forwarded-for']) || req.socket.remoteAddress) + (token ? '' : ' (no auth token configured)')))
      E.send(res, 'PHONE_SIGNATURE_INVALID'); return
    }
    const q = Object.fromEntries(parsed.searchParams)
    const out = await handler(params, q)
    if (out === null || out === undefined) { res.writeHead(204); res.end(); return }
    sendXml(res, out)
  } catch (e) {
    warn(E.logLine('PHONE_WEBHOOK_HANDLER_FAILED', (e && e.stack) || String(e)))
    // A voice webhook must still say something sensible.
    try { sendXml(res, twiml(el('Say', {}, 'Sorry, something went wrong. Please try again later.'), el('Hangup'))) } catch {}
  }
}

// ------------------------------------------------------------------ PRIVATE: plugin API

function stateSnapshot() {
  const creds = twilioCredentials(settings)
  const issues = []
  if (!settings.enabled) issues.push('Phone is disabled in Settings.')
  if (!creds.accountSid.value || !creds.authToken.value) issues.push('Twilio account SID and auth token are missing.')
  if (!creds.apiKeySid.value || !creds.apiKeySecret.value) issues.push('No Twilio API key yet: run "Apply to Twilio" in setup.')
  if (!creds.twimlAppSid.value) issues.push('No TwiML App yet: run "Apply to Twilio" in setup.')
  if (!settings.lines.length) issues.push('No line configured.')
  if (!settings.publicBaseUrl) issues.push('Set the public webhook base URL (https://your-host/phone-hook).')
  const prov = readProvisioned()
  return {
    ok: true,
    version: VERSION,
    enabled: settings.enabled,
    ready: issues.length === 0,
    issues,
    mode: getMode(),
    identity: settings.identity,
    browserOnline: browserOnline(),
    lines: settings.lines,
    defaultLine: settings.defaultLine,
    defaultCountry: settings.defaultCountry,
    publicBaseUrl: settings.publicBaseUrl,
    counts: store.counts(),
    notifications: settings.notifications,
    voicemail: { enabled: settings.voicemail.enabled, liveTranscript: settings.voicemail.liveTranscript, transcriber: settings.voicemail.transcriber },
    audio: { route: settings.audio.route, maxCalls: settings.audio.maxCalls },
    credentials: Object.fromEntries(Object.entries(creds).map(([k, v]) => [k, { set: !!v.value, source: v.source, ...(k.endsWith('Sid') && v.value ? { hint: v.value.slice(0, 6) + '...' + v.value.slice(-4) } : {}) }])),
    provisionedAt: prov.updatedAt || null,
    lastApply: store.get('lastApply', null),
    sip: { enabled: !!settings.sip.enabled, label: settings.sip.label },
    sipAccounts: resolveAccounts(settings).map(a => ({ id: a.id, label: a.label, line: a.line, mode: a.mode, bridgeVia: a.bridgeVia, enabled: a.enabled, issues: a.issues, warnings: a.warnings })),
    relay: { state: lastRelaySync().state, errors: lastRelaySync().errors, restartNeeded: lastRelaySync().restartNeeded },
    telegram: tg.summary(),
  }
}

async function provisionCheck() {
  const client = rest()
  const creds = twilioCredentials(settings)
  const out = { account: null, apiKey: null, app: null, lines: [], publicHook: null }
  try {
    const a = await client.account()
    out.account = { ok: a.status === 'active', name: a.friendly_name, status: a.status }
  } catch (e) { out.account = { ok: false, error: e.message } }
  try {
    const b = await client.balance()
    out.balance = { amount: b.balance, currency: b.currency }
  } catch {}
  try {
    const keys = await client.keys()
    const found = (keys.keys || []).find(k => k.sid === creds.apiKeySid.value)
    out.apiKey = { ok: !!found && !!creds.apiKeySecret.value, name: found ? found.friendly_name : null }
  } catch (e) { out.apiKey = { ok: false, error: e.message } }
  try {
    const apps = await client.applications()
    const app = (apps.applications || []).find(x => x.sid === creds.twimlAppSid.value)
    out.app = { ok: !!app && app.voice_url === hook('/voice/outbound'), voiceUrl: app ? app.voice_url : null, expected: hook('/voice/outbound') }
  } catch (e) { out.app = { ok: false, error: e.message } }
  for (const line of settings.lines.filter(l => l.provider === 'twilio')) {
    try {
      const sid = line.numberSid || await findNumberSid(client, line.number)
      const n = await client.number(sid)
      const want = expectedNumberConfig(line)
      out.lines.push({
        id: line.id, number: n.phone_number, sid,
        ok: n.voice_url === want.VoiceUrl && n.sms_url === want.SmsUrl && n.status_callback === want.StatusCallback && !n.voice_application_sid,
        voiceUrl: n.voice_url, smsUrl: n.sms_url, capabilities: n.capabilities,
      })
    } catch (e) { out.lines.push({ id: line.id, number: line.number, ok: false, error: e.message }) }
  }
  if (bridgeWanted() || readProvisioned().sipDomainSid) {
    out.sip = await checkSipDomain(client)
    try {
      const st = await relayStatus(settings)
      const regs = st.registrations || []
      out.relay = { ok: !st.error && regs.length > 0 && regs.every(r => r.status === 'Registered'), registrations: regs, error: st.error || (st.sync.errors || []).join('; ') }
    } catch (e) { out.relay = { ok: false, error: e.message } }
  }
  try {
    const r = await fetch(settings.publicBaseUrl + '/health', { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'dsh-phone-selfcheck' } })
    const j = await r.json().catch(() => null)
    out.publicHook = { ok: r.status === 200 && j && j.service === 'dsh-phone', status: r.status }
  } catch (e) { out.publicHook = { ok: false, error: e.message } }
  return out
}

async function findNumberSid(client, number) {
  const list = await client.numbers()
  const n = (list.incoming_phone_numbers || []).find(x => x.phone_number === number)
  if (!n) throw new Error('number ' + number + ' is not on this Twilio account')
  return n.sid
}

function expectedNumberConfig(line) {
  return {
    VoiceUrl: hook('/voice/incoming', { line: line.id }),
    VoiceMethod: 'POST',
    StatusCallback: hook('/voice/status'),
    StatusCallbackMethod: 'POST',
    SmsUrl: hook('/sms', { line: line.id }),
    SmsMethod: 'POST',
    VoiceApplicationSid: '',
  }
}

// ------------------------------------------------------------------ SIP Domain (relay bridge)

const listOf = (r) => (r && Object.values(r).find(Array.isArray)) || []

/** Whether any enabled SIP account bridges through a Twilio line. */
function bridgeWanted() {
  return settings.sipAccounts.some(a => a.enabled && a.mode === 'bridge' && settings.lines.some(l => l.id === a.bridgeVia && l.provider === 'twilio'))
}

function sipDomainName(accountSid, prov) {
  const wanted = String(settings.twilio.sipDomain || '').toLowerCase().replace(/[^a-z0-9.-]/g, '')
  if (wanted) return wanted.endsWith('.sip.twilio.com') ? wanted : wanted + '.sip.twilio.com'
  if (prov.sipDomainName) return prov.sipDomainName
  return 'dsh-phone-' + String(accountSid).slice(-8).toLowerCase() + '.sip.twilio.com'
}

/** A password Twilio accepts for a SIP credential (12+ chars, upper, lower, digit). */
function sipPassword() {
  return 'Dp' + randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '') + '7x'
}

function bridgeSecure() { return settings.relay.bridgeTransport === 'tls' && settings.relay.bridgeSrtp !== false }

function expectedDomainConfig() {
  return {
    VoiceUrl: hook('/voice/sip'),
    VoiceMethod: 'POST',
    VoiceStatusCallbackUrl: hook('/voice/status'),
    VoiceStatusCallbackMethod: 'POST',
    SipRegistration: 'true',
    // Secure media (TLS + SRTP enforced) goes with a TLS bridge.
    Secure: bridgeSecure() ? 'true' : 'false',
  }
}

async function provisionSipDomain(client, step) {
  const creds = twilioCredentials(settings)
  const prov = readProvisioned()
  const name = sipDomainName(creds.accountSid.value, prov)
  // 1. the domain (Voice URL -> /voice/sip, SIP registration on)
  const domains = listOf(await client.sipDomains())
  let dom = domains.find(d => d.sid === prov.sipDomainSid) || domains.find(d => d.domain_name === name)
  const form = { ...expectedDomainConfig(), FriendlyName: 'dsh-phone relay' }
  if (dom) { await client.updateSipDomain(dom.sid, form); step('SIP Domain', true, 'updated ' + dom.domain_name) }
  else { dom = await client.createSipDomain({ ...form, DomainName: name }); step('SIP Domain', true, 'created ' + dom.domain_name) }
  // 2. the credential list with the bridge user
  const lists = listOf(await client.credentialLists())
  let cl = lists.find(l => l.sid === prov.sipCredentialListSid) || lists.find(l => l.friendly_name === 'dsh-phone-bridge')
  if (!cl) cl = await client.createCredentialList('dsh-phone-bridge')
  const user = prov.sipBridgeUser || 'dshbridge' + randomBytes(3).toString('hex')
  let password = prov.sipBridgePassword || ''
  const existing = listOf(await client.credentials(cl.sid)).find(c => c.username === user)
  if (!existing) {
    password = password || sipPassword()
    await client.createCredential(cl.sid, user, password)
  } else if (!password) {
    password = sipPassword()
    await client.updateCredential(cl.sid, existing.sid, password)
  }
  writeProvisioned({ sipDomainSid: dom.sid, sipDomainName: dom.domain_name, sipCredentialListSid: cl.sid, sipBridgeUser: user, sipBridgePassword: password })
  step('SIP credential list', true, 'dsh-phone-bridge, user ' + user + ' (password stored 0600 in ~/.dsh/phone/provisioned.json)')
  // 3. the list authenticates both registrations and calls on the domain
  for (const kind of ['Registrations', 'Calls']) {
    const maps = listOf(await client.domainCredentialMappings(dom.sid, kind))
    if (!maps.some(m => m.sid === cl.sid || m.credential_list_sid === cl.sid)) await client.mapCredentialList(dom.sid, kind, cl.sid)
  }
  step('SIP auth mappings', true, 'registrations + calls use dsh-phone-bridge')
  const sync = await syncRelay(settings, { log, warn })
  step('Relay config', sync.state !== 'error', sync.state === 'off' ? 'relay off' : (sync.errors.join('; ') || (sync.changed.length ? 'written: ' + sync.changed.join(', ') : 'unchanged')))
}

async function checkSipDomain(client) {
  const prov = readProvisioned()
  const out = { domain: null, credentials: null, mappings: null }
  try {
    const dom = listOf(await client.sipDomains()).find(d => d.sid === prov.sipDomainSid)
    const want = expectedDomainConfig()
    out.domain = dom
      ? { ok: dom.voice_url === want.VoiceUrl && dom.sip_registration === true && !!dom.secure === bridgeSecure(), name: dom.domain_name, voiceUrl: dom.voice_url, registration: dom.sip_registration, secure: !!dom.secure }
      : { ok: false, error: prov.sipDomainSid ? 'domain not found' : 'not provisioned' }
  } catch (e) { out.domain = { ok: false, error: e.message } }
  try {
    const creds = prov.sipCredentialListSid ? listOf(await client.credentials(prov.sipCredentialListSid)) : []
    out.credentials = { ok: !!prov.sipBridgePassword && creds.some(c => c.username === prov.sipBridgeUser), user: prov.sipBridgeUser || null }
  } catch (e) { out.credentials = { ok: false, error: e.message } }
  try {
    const kinds = {}
    for (const kind of ['Registrations', 'Calls']) {
      kinds[kind] = prov.sipDomainSid ? listOf(await client.domainCredentialMappings(prov.sipDomainSid, kind)).some(m => m.sid === prov.sipCredentialListSid) : false
    }
    out.mappings = { ok: kinds.Registrations && kinds.Calls, ...kinds }
  } catch (e) { out.mappings = { ok: false, error: e.message } }
  return out
}

async function provisionApply() {
  if (!settings.publicBaseUrl) throw fail('PHONE_PUBLIC_URL_MISSING', 'Set the public webhook base URL first (https://your-host/phone-hook).', 400)
  const client = rest()
  const report = []
  const step = (name, ok, detail) => report.push({ name, ok, detail: detail || '' })
  const creds = twilioCredentials(settings)

  const acct = await client.account()
  step('Account', acct.status === 'active', acct.friendly_name + ' (' + acct.status + ')')

  // 1. API key for browser access tokens (the secret is only shown once).
  let keySid = creds.apiKeySid.value
  if (keySid && creds.apiKeySecret.value) {
    const keys = await client.keys()
    if (!(keys.keys || []).some(k => k.sid === keySid)) keySid = ''
  } else keySid = ''
  if (!keySid) {
    const k = await client.createKey('dsh-phone ' + new Date().toISOString().slice(0, 10))
    writeProvisioned({ apiKeySid: k.sid, apiKeySecret: k.secret })
    step('API key', true, 'created ' + k.sid.slice(0, 6) + '... (secret stored 0600 in ~/.dsh/phone/provisioned.json)')
  } else step('API key', true, 'existing ' + keySid.slice(0, 6) + '...')

  // 2. TwiML App: browser outgoing calls land on /voice/outbound.
  const appForm = { FriendlyName: 'dsh-phone', VoiceUrl: hook('/voice/outbound'), VoiceMethod: 'POST', StatusCallback: hook('/voice/status'), StatusCallbackMethod: 'POST' }
  let appSid = twilioCredentials(settings).twimlAppSid.value
  const apps = await client.applications()
  let app = (apps.applications || []).find(a => a.sid === appSid) || (apps.applications || []).find(a => a.friendly_name === 'dsh-phone')
  if (app) {
    await client.updateApplication(app.sid, appForm)
    appSid = app.sid
    step('TwiML App', true, 'updated ' + appSid.slice(0, 6) + '...')
  } else {
    app = await client.createApplication(appForm)
    appSid = app.sid
    step('TwiML App', true, 'created ' + appSid.slice(0, 6) + '...')
  }
  if (twilioCredentials(settings).twimlAppSid.source !== 'settings') writeProvisioned({ twimlAppSid: appSid })

  // 3. Numbers: voice + SMS webhooks + status callback.
  for (const line of settings.lines.filter(l => l.provider === 'twilio' && l.enabled)) {
    try {
      const sid = line.numberSid || await findNumberSid(client, line.number)
      await client.updateNumber(sid, expectedNumberConfig(line))
      step('Number ' + line.number, true, 'voice + SMS webhooks point at ' + settings.publicBaseUrl)
    } catch (e) { step('Number ' + line.number, false, e.message) }
  }
  // 4. SIP Domain for the relay bridge (only when a SIP account bridges through Twilio).
  if (bridgeWanted()) {
    try { await provisionSipDomain(client, step) } catch (e) { step('SIP Domain', false, e.message) }
  }
  restCache = null
  const result = { at: new Date().toISOString(), ok: report.every(r => r.ok), report }
  store.set('lastApply', result)
  broadcast('config', { at: Date.now() })
  return result
}

function intQ(v, d, lo = 1, hi = 1000) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d }

const PRIVATE_ROUTES = {
  'GET /health': async () => ({ ok: true, version: VERSION, uptime: Math.round(process.uptime()) }),
  'GET /state': async () => stateSnapshot(),
  'PUT /config': async (b) => { setConfig(b && b.settings); return { ok: true } },
  'POST /mode': async (b) => ({ ok: true, mode: setMode(String(b.mode || ''), b.by) }),
  'GET /token': async () => {
    const c = twilioCredentials(settings)
    const ttl = 3600
    let token
    try {
      token = voiceAccessToken({ accountSid: c.accountSid.value, apiKeySid: c.apiKeySid.value, apiKeySecret: c.apiKeySecret.value, identity: settings.identity, appSid: c.twimlAppSid.value, ttl })
    } catch (e) { throw fail('PHONE_VOICE_TOKEN_INCOMPLETE', e.message) }
    return { ok: true, token, identity: settings.identity, ttl, edge: settings.twilio.edge || '' }
  },
  'POST /presence': async (b) => {
    const id = String(b.clientId || '').slice(0, 64)
    if (id) presence.set(id, { at: Date.now(), registered: !!b.registered, audio: b.audio === 'server' ? 'server' : 'direct' })
    return { ok: true, browserOnline: browserOnline() }
  },
  'GET /threads': async (b, q) => ({ ok: true, threads: store.threads({ line: q.line || null, q: q.q || '', limit: intQ(q.limit, 100) }) }),
  'GET /thread': async (b, q) => {
    const line = q.line || (defaultLine() || {}).id || ''
    const peer = toE164(q.peer, settings.defaultCountry) || q.peer
    return { ok: true, line, peer, contact: store.contact(peer), messages: store.thread({ line, peer, limit: intQ(q.limit, 200), before: q.before ? Number(q.before) : null }) }
  },
  'POST /thread/read': async (b) => { const n = store.markThreadRead(b.line, b.peer); broadcast('counts', store.counts()); return { ok: true, marked: n } },
  'POST /thread/delete': async (b) => ({ ok: true, deleted: store.deleteThread(b.line, b.peer) }),
  'POST /sms/send': async (b) => ({ ok: true, message: await sendSms({ to: b.to, body: b.body, line: b.line, origin: b.origin === 'agent' ? 'agent' : 'ui' }) }),
  'GET /calls': async (b, q) => ({ ok: true, calls: store.calls({ limit: intQ(q.limit, 100) }).map(c => (c.line === 'tg' && !c.name ? { ...c, name: (tg.chat(c.peer) || {}).title || '' } : c)) }),
  'POST /calls/seen': async () => { store.markCallsSeen(); broadcast('counts', store.counts()); return { ok: true } },
  'POST /calls/delete': async (b) => ({ ok: true, deleted: store.deleteCall(Number(b.id)) }),
  'POST /call/say': async (b) => {
    const line = b.line ? lineById(b.line) : defaultLine()
    if (!line || !line.voice || line.provider !== 'twilio') throw fail('PHONE_LINE_UNAVAILABLE', 'no voice line available')
    const to = toE164(b.to, settings.defaultCountry)
    if (!to || to.startsWith('client:')) throw fail('PHONE_NUMBER_INVALID', 'not a valid phone number: ' + b.to)
    const text = String(b.text || '').trim().slice(0, 1000)
    if (!text) throw fail('PHONE_MESSAGE_INVALID', 'nothing to say')
    const attrs = { voice: b.voice || settings.voicemail.greetingVoice || undefined, language: b.language || settings.voicemail.greetingLanguage || undefined }
    const xml = twiml(el('Pause', { length: 1 }), el('Say', attrs, text), el('Pause', { length: 1 }), el('Say', attrs, text), el('Hangup'))
    const r = await rest().createCall({ To: to, From: line.number, Twiml: xml, StatusCallback: hook('/voice/say-done'), StatusCallbackMethod: 'POST', Timeout: 30 })
    store.upsertCall({ sid: r.sid, line: line.id, peer: to, direction: 'out', status: r.status, disposition: 'dialing', mode: getMode(), origin: 'agent' })
    broadcast('call.update', { call: store.callBySid(r.sid) })
    return { ok: true, call: store.callBySid(r.sid) }
  },
  'GET /voicemails': async (b, q) => ({ ok: true, voicemails: store.voicemails({ limit: intQ(q.limit, 100) }) }),
  'POST /voicemail/read': async (b) => { const v = store.updateVoicemail(Number(b.id), { read: true }); broadcast('counts', store.counts()); return { ok: true, vm: v } },
  'POST /voicemail/delete': async (b) => {
    const v = store.voicemail(Number(b.id))
    if (v) {
      const row = store.db.prepare('SELECT file FROM voicemails WHERE id=?').get(v.id)
      if (row && row.file && row.file.startsWith(REC_DIR)) await fsP.rm(row.file, { force: true })
      store.deleteVoicemail(v.id)
    }
    broadcast('counts', store.counts())
    return { ok: true }
  },
  'POST /voicemail/retranscribe': async (b) => {
    const v = store.voicemail(Number(b.id))
    const row = v && store.db.prepare('SELECT file FROM voicemails WHERE id=?').get(v.id)
    if (!row || !row.file) throw fail('PHONE_VOICEMAIL_NO_AUDIO', 'no audio for this voicemail', 400)
    let t
    try {
      t = await transcribe({ ...settings.voicemail, transcriber: b.engine || settings.voicemail.transcriber }, { type: 'audio/mpeg', data: await fsP.readFile(row.file) })
    } catch (e) { throw fail('PHONE_TRANSCRIBE_FAILED', e.message) }
    const out = store.updateVoicemail(v.id, { transcript: t.text, language: t.language, engine: t.engine })
    broadcast('vm.update', { vm: out })
    return { ok: true, vm: out }
  },
  'POST /pickup': async (b) => {
    const vm = b.vmId ? store.voicemail(Number(b.vmId)) : store.voicemailByCall(String(b.callSid || ''))
    if (!vm) throw fail('PHONE_VOICEMAIL_NOT_FOUND', 'voicemail not found')
    if (!['recording', 'greeting'].includes(vm.status)) throw fail('PHONE_PICKUP_TOO_LATE', 'the caller is no longer leaving a message')
    const token = String(b.token || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 32)
    const xml = twiml(
      settings.voicemail.liveTranscript ? el('Stop', {}, [el('Transcription', { name: 'vm' + vm.id })]) : null,
      el('Dial', { answerOnBridge: true, timeout: 20, action: hook('/voice/dial-done', { line: vm.line, pickup: 1 }), method: 'POST' }, [
        el('Client', {}, [
          el('Identity', {}, settings.identity),
          el('Parameter', { name: 'line', value: vm.line }),
          el('Parameter', { name: 'peer', value: vm.peer }),
          el('Parameter', { name: 'pickup', value: String(vm.id) }),
          el('Parameter', { name: 'pickupToken', value: token }),
        ]),
      ]),
    )
    await rest().updateCall(vm.callSid, { Twiml: xml })
    const out = store.updateVoicemail(vm.id, { picked_up: true, status: 'picked_up' })
    store.upsertCall({ sid: vm.callSid, disposition: 'picked_up' })
    broadcast('vm.update', { vm: out })
    return { ok: true, vm: out }
  },
  'GET /audio/info': async () => ({ ...hub.info(), audioSocket: audioSocketState, stream: !!settings.publicBaseUrl }),
  'POST /audio/ticket': async (b) => hub.issueTicket(b || {}, { lineById, defaultLine, toE164, defaultCountry: settings.defaultCountry, voicemailById: (id) => store.voicemail(id) }),
  'POST /audio/decline': async (b) => ({ ok: true, declined: hub.decline(String(b.callSid || '')) }),
  'GET /contacts': async (b, q) => ({ ok: true, contacts: store.contacts({ q: q.q || '' }) }),
  'POST /contacts/save': async (b) => {
    const number = toE164(b.number, settings.defaultCountry)
    if (!number || number.startsWith('client:')) throw fail('PHONE_NUMBER_INVALID', 'not a valid phone number')
    const c = store.saveContact({ number, name: b.name, starred: b.starred, blocked: b.blocked, note: b.note })
    broadcast('contacts', { contact: c })
    return { ok: true, contact: c }
  },
  'POST /contacts/delete': async (b) => ({ ok: true, deleted: store.deleteContact(String(b.number || '')) }),
  'GET /provider/check': async () => ({ ok: true, check: await provisionCheck() }),
  'POST /provider/apply': async () => ({ ok: true, result: await provisionApply() }),
  'GET /provider/numbers': async () => {
    const list = await rest().numbers()
    return { ok: true, numbers: (list.incoming_phone_numbers || []).map(n => ({ sid: n.sid, number: n.phone_number, name: n.friendly_name, capabilities: n.capabilities, voiceUrl: n.voice_url, smsUrl: n.sms_url })) }
  },
  'GET /relay/status': async () => ({ ok: true, relay: await relayStatus(settings) }),
  'POST /relay/sync': async () => ({ ok: true, sync: await syncRelay(settings, { log, warn }) }),
  'GET /balance': async () => { const b = await rest().balance(); return { ok: true, balance: b.balance, currency: b.currency } },
}

/** Coded body for anything a private route threw; the legacy status rule is applied by the caller. */
function privateErrorBody(e) {
  if (e instanceof TwilioError) return errorBody(E, e, e.status === 401 ? 'PHONE_PROVIDER_AUTH_FAILED' : 'PHONE_PROVIDER_REQUEST_FAILED')
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError' || (e.name === 'TypeError' && /fetch failed/i.test(String(e.message))))) return errorBody(E, e, 'PHONE_PROVIDER_UNREACHABLE')
  return errorBody(E, e, 'PHONE_INTERNAL')
}

async function handlePrivate(req, res) {
  const url = new URL(req.url || '/', 'http://hookd.sock')
  const path = url.pathname.replace(/\/+$/, '') || '/'
  try {
    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
      res.write('retry: 3000\nevent: hello\ndata: ' + JSON.stringify({ mode: getMode(), counts: store.counts() }) + '\n\n')
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }
    if (req.method === 'GET' && path === '/voicemail/audio') {
      const v = store.voicemail(Number(url.searchParams.get('id')))
      const row = v && store.db.prepare('SELECT file FROM voicemails WHERE id=?').get(v.id)
      if (!row || !row.file || !row.file.startsWith(REC_DIR)) { E.send(res, 'PHONE_VOICEMAIL_NO_AUDIO', { message: 'no audio' }); return }
      const st = await fsP.stat(row.file)
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''))
      if (range) {
        const start = range[1] ? Number(range[1]) : 0
        const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1
        res.writeHead(206, { 'content-type': 'audio/mpeg', 'content-length': end - start + 1, 'content-range': 'bytes ' + start + '-' + end + '/' + st.size, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' })
        fs.createReadStream(row.file, { start, end }).pipe(res)
      } else {
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' })
        fs.createReadStream(row.file).pipe(res)
      }
      return
    }
    if (req.method === 'GET' && path === '/media') {
      const m = await rest().download(String(url.searchParams.get('url') || ''))
      res.writeHead(200, { 'content-type': m.type, 'content-length': m.data.length, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self' data:; media-src 'self'" })
      res.end(m.data)
      return
    }
    if (path.startsWith('/tg/') && await tg.handle(req, res, path, url, { readBody, sendJson })) return
    const fn = PRIVATE_ROUTES[req.method + ' ' + path]
    if (!fn) { E.send(res, 'PHONE_NOT_FOUND'); return }
    let body = {}
    if (req.method !== 'GET') {
      const buf = await readBody(req, 512 * 1024)
      try { body = buf.length ? JSON.parse(buf.toString('utf8')) : {} } catch (e) { throw fail('PHONE_BODY_INVALID', e.message) }
    }
    const out = await fn(body, Object.fromEntries(url.searchParams))
    sendJson(res, 200, out)
  } catch (e) {
    const body = privateErrorBody(e)
    if (['PHONE_INTERNAL', 'PHONE_PROVIDER_AUTH_FAILED', 'PHONE_PROVIDER_REQUEST_FAILED', 'PHONE_PROVIDER_UNREACHABLE'].includes(body.code)) warn(E.logLine(body.code, req.method + ' ' + path + ' ' + (e && e.message ? e.message : e)))
    sendJson(res, e.status && e.status < 500 ? e.status : 400, body)
  }
}

// ------------------------------------------------------------------ start

// ------------------------------------------------------------------ server audio route

/** Asterisk side of the hub: one AMI session with call events while SIP calls are up. */
function asteriskAdapter() {
  const em = new EventEmitter()
  em.setMaxListeners(50)
  let ami = null
  let idle = null
  const session = async () => {
    clearTimeout(idle)
    if (ami && !ami.closed) return ami.connect()
    const a = new AmiSession({ ...amiOptions(settings), events: 'call' })
    ami = a
    a.on('event', (ev) => em.emit('event', ev))
    a.on('close', () => { if (ami === a) ami = null })
    return a.connect()
  }
  em.originate = async ({ uuid, channelId, account, dest }) => {
    const a = await session()
    const r = await a.action({
      Action: 'Originate', Channel: 'AudioSocket/127.0.0.1:' + AS_PORT + '/' + uuid,
      Context: 'dshp-srv-' + account.id, Exten: 's', Priority: 1, Async: 'true', ChannelId: channelId,
      Variable: 'DSHP_DEST=' + dest, Timeout: 20000,
    })
    if (r.Response !== 'Success') throw fail('PHONE_AUDIO_LEG_FAILED', 'Asterisk refused the call: ' + (r.Message || 'no reason'))
  }
  em.hangup = async (channel) => { const a = await session(); await a.action({ Action: 'Hangup', Channel: channel }) }
  em.dtmf = async (channel, digit) => {
    const a = await session()
    const r = await a.action({ Action: 'PlayDTMF', Channel: channel, Digit: digit, Duration: 120 })
    if (r.Response !== 'Success') throw new Error(r.Message || 'PlayDTMF failed')
  }
  em.release = () => {
    clearTimeout(idle)
    idle = setTimeout(() => { if (!hub.active(['out', 'in']) && ami) { ami.close(); ami = null } }, 30000)
    idle.unref && idle.unref()
  }
  return em
}

// Fixed at boot (the listener binds once): a port change needs a hookd restart.
const AS_PORT = Number(process.env.DSH_PHONE_AUDIOSOCKET_PORT || settings.audio.audioSocketPort)

function streamUrl() { return settings.publicBaseUrl.replace(/^https:/i, 'wss:') + '/s' }

const hub = new AudioHub({
  settings: () => settings, log, warn, store, broadcast, fail,
  hookUrl: hook, streamUrl, mode: getMode,
  twilio: { createCall: (f) => rest().createCall(f), updateCall: (sid, f) => rest().updateCall(sid, f) },
  asterisk: asteriskAdapter(),
  tg: tg.callApi,
  sipAccount: sipAccountForLine,
  allowed: (acct, to) => destinationAllowed(acct, to, settings.defaultCountry),
  onPickup: (vmId, callSid) => {
    const out = store.updateVoicemail(Number(vmId), { picked_up: true, status: 'picked_up' })
    store.upsertCall({ sid: callSid, disposition: 'picked_up' })
    broadcast('vm.update', { vm: out })
  },
})

let audioSocketState = 'off'
const asServer = audioSocketServer({ host: '127.0.0.1', port: AS_PORT, claim: (uuid) => hub.claimAudioSocket(uuid), log, warn })
asServer.on('listening', () => { audioSocketState = 'listening' })
asServer.on('error', () => { audioSocketState = 'error' })

let publicStreams = 0
const pub = http.createServer(handlePublic)
pub.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {})
  try {
    const base = settings.publicBaseUrl ? new URL(settings.publicBaseUrl) : null
    const basePath = base ? base.pathname.replace(/\/+$/, '') : ''
    const p = String(req.url || '').split('?')[0]
    if (!base || (p !== basePath + '/s' && p !== basePath + '/s/')) { refuseUpgrade(socket, 404); return }
    const token = authToken()
    const sig = one(req.headers['x-twilio-signature'])
    const url = streamUrl()
    const signed = !!token && !!sig && (validateSignature(token, sig, url, {}) || validateSignature(token, sig, url + '/', {}))
    if (!signed) {
      warn(E.logLine('PHONE_SIGNATURE_INVALID', 'rejected stream upgrade without a valid signature from ' + (one(req.headers['cf-connecting-ip']) || one(req.headers['x-forwarded-for']) || req.socket.remoteAddress)))
      refuseUpgrade(socket, 403); return
    }
    if (publicStreams >= settings.audio.maxCalls + 4) { refuseUpgrade(socket, 503); return }
    const conn = acceptWebSocket(req, socket, head, { maxPayload: 64 * 1024 })
    if (!conn) return
    publicStreams++
    conn.on('close', () => { publicStreams-- })
    hub.attachTwilio(conn, { signed })
  } catch (e) { warn('stream upgrade', e.message); try { socket.destroy() } catch {} }
})
pub.requestTimeout = 15000
pub.headersTimeout = 10000
pub.listen(PUBLIC_PORT, PUBLIC_HOST, () => log('public webhooks on http://' + PUBLIC_HOST + ':' + PUBLIC_PORT, '->', settings.publicBaseUrl))

const sock = socketPath()
try { fs.rmSync(sock, { force: true }) } catch {}
const priv = http.createServer(handlePrivate)
// Browser audio socket (the DSH plugin pipes the authenticated upgrade here).
priv.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {})
  try {
    const p = String(req.url || '').split('?')[0]
    if (p !== '/audio/io') { refuseUpgrade(socket, 404); return }
    const protos = offeredProtocols(req)
    const k = (protos.find(x => x.startsWith('k.')) || '').slice(2)
    if (!protos.includes('dshp.v1')) { refuseUpgrade(socket, 400, 'protocol dshp.v1 required'); return }
    if (!hub.ticketValid(k)) { refuseUpgrade(socket, 403, 'ticket invalid or expired'); return }
    const conn = acceptWebSocket(req, socket, head, { protocol: 'dshp.v1', maxPayload: 16 * 1024 })
    if (conn) hub.attachBrowser(k, conn)
  } catch (e) { warn('audio upgrade', e.message); try { socket.destroy() } catch {} }
})
priv.listen(sock, () => {
  try { fs.chmodSync(sock, 0o600) } catch {}
  log('private API on unix:' + sock)
})

if (!store.get('mode', null)) store.set('mode', settings.incoming.defaultMode)
tg.start()
queueRelaySync(1000)
setInterval(() => { relayWatchdog(settings, { log, warn }).catch(e => warn('relay watchdog', e.message)) }, 120000).unref()
log('dsh-phone hookd ' + VERSION + ' ready; mode=' + getMode() + '; lines=' + settings.lines.map(l => l.id + ':' + l.number).join(',') + '; boot=' + randomBytes(3).toString('hex'))

function shutdown() {
  log('shutting down')
  for (const res of sseClients) { try { res.end() } catch {} }
  try { hub.shutdown() } catch {}
  try { tg.shutdown() } catch {}
  pub.close(); priv.close(); try { asServer.close() } catch {}
  try { fs.rmSync(sock, { force: true }) } catch {}
  store.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
