/**
 * dsh-phone: browser half.
 *
 *   Phone service   one per page, started at apply(): live events (SSE), the
 *                   Twilio Voice Device (registered so calls can ring here),
 *                   ringtone and chimes (WebAudio, no assets), browser
 *                   notifications. Do-not-disturb silences all of it.
 *   Overlay         a React root on document.body: incoming call, active call
 *                   (mute, keypad, hang up), live voicemail with transcript and
 *                   Pick up, toasts. Visible whatever sidebar tab is open.
 *   Phone tab       Messages, Calls, Voicemail, Keypad, Contacts, Setup.
 *   Settings        the same Setup view, as Settings > Phone.
 *
 * The client is never the authority: every action goes to /dsh-phone/api,
 * which gates it and forwards to phone-hookd. Purity: no @deepseek-ai/* imports.
 */
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

const TAB_ID = 'dsh-phone:main'
const API = '/dsh-phone/api'
const CLIENT_ID = Math.random().toString(36).slice(2, 12)

// ---------------------------------------------------------------- api

let capToken = null
async function mint() {
  const r = await fetch(API + '/session', { credentials: 'same-origin', headers: { accept: 'application/json' } })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.token) throw new Error(j.error || 'could not mint a session token (HTTP ' + r.status + ')')
  capToken = j.token
  return capToken
}
async function apiGet(path) {
  const r = await fetch(API + path, { credentials: 'same-origin', headers: { accept: 'application/json' } })
  const j = await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }))
  if (!r.ok || j.ok === false) throw new Error(j.error || 'HTTP ' + r.status)
  return j
}
async function apiPost(path, body) {
  const send = (tok) => fetch(API + path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-dsh-phone-token': tok },
    body: JSON.stringify(body || {}),
  })
  let r = await send(capToken || await mint())
  if (r.status === 403) r = await send(await mint())
  const j = await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }))
  if (!r.ok || j.ok === false) throw new Error(j.error || 'HTTP ' + r.status)
  return j
}

// ---------------------------------------------------------------- formatting

function fmtNum(n) {
  const s = String(n || '')
  let m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(s)
  if (m) return '+1 ' + m[1] + ' ' + m[2] + ' ' + m[3]
  m = /^\+(30|39)(\d{3})(\d{3})(\d{3,4})$/.exec(s)
  if (m) return '+' + m[1] + ' ' + m[2] + ' ' + m[3] + ' ' + m[4]
  m = /^\+(44)(\d{4})(\d{6})$/.exec(s)
  if (m) return '+44 ' + m[2] + ' ' + m[3]
  return s || 'Unknown'
}
const label = (peer, name) => name || fmtNum(peer)
function fmtWhen(unix) {
  if (!unix) return ''
  const d = new Date(unix * 1000)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (now - d < 6 * 86400000) return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}
const fmtDur = (s) => { s = Math.max(0, Math.round(Number(s) || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') }

const GSM7 = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
const GSM7_EXT = '^{}\\[~]|€\f'
function segments(text) {
  let gsm = true; let units = 0
  for (const ch of String(text || '')) {
    if (GSM7.includes(ch)) units += 1
    else if (GSM7_EXT.includes(ch)) units += 2
    else { gsm = false; break }
  }
  if (gsm) return { enc: 'GSM-7', chars: units, seg: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153) }
  const u = Array.from(String(text)).reduce((n, ch) => n + (ch.codePointAt(0) > 0xffff ? 2 : 1), 0)
  return { enc: 'UCS-2', chars: u, seg: u === 0 ? 0 : u <= 70 ? 1 : Math.ceil(u / 67) }
}

// ---------------------------------------------------------------- store

const S = {
  st: null, stErr: '',
  mode: null,
  counts: { sms: 0, voicemail: 0, missed: 0 },
  dev: 'off', devErr: '',
  call: null, callInfo: null,
  incoming: null,
  live: {},            // vmId -> { vm, text, silent, dismissed }
  toasts: [],
  ver: { sms: 0, calls: 0, vm: 0, contacts: 0, config: 0 },
  pendingPickup: null,
  notifPerm: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  sidebar: null,
}
const subs = new Set()
let tick = 0
function changed() { tick++; for (const f of subs) { try { f(tick) } catch {} } }
function usePhone() {
  const [, set] = useState(0)
  useEffect(() => { const f = (t) => set(t); subs.add(f); return () => { subs.delete(f) } }, [])
  return S
}
function bump(...keys) { for (const k of keys) S.ver[k]++; changed() }

let stateTimer = null
function refreshSoon() { clearTimeout(stateTimer); stateTimer = setTimeout(() => { void refreshState() }, 250) }
async function refreshState() {
  try {
    const st = await apiGet('/state')
    S.st = st; S.stErr = ''; S.mode = st.mode; S.counts = st.counts
    changed()
    if (st.ready && st.enabled && S.dev === 'off') void initDevice()
  } catch (e) { S.stErr = String(e.message || e); changed() }
  return S.st
}

// ---------------------------------------------------------------- sound + notifications

let actx = null
function audio() {
  try {
    if (!actx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; actx = new C() }
    if (actx.state === 'suspended') actx.resume().catch(() => {})
    return actx
  } catch { return null }
}
function tone(freqs, dur, gain = 0.07, when = 0) {
  const a = audio(); if (!a) return
  const t0 = a.currentTime + when
  const g = a.createGain()
  g.gain.setValueAtTime(0, t0)
  g.gain.linearRampToValueAtTime(gain, t0 + 0.02)
  g.gain.setValueAtTime(gain, Math.max(t0 + 0.03, t0 + dur - 0.05))
  g.gain.linearRampToValueAtTime(0, t0 + dur)
  g.connect(a.destination)
  for (const f of freqs) { const o = a.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.connect(g); o.start(t0); o.stop(t0 + dur + 0.02) }
}
const soundsOn = () => !(S.st && S.st.notifications && S.st.notifications.sound === false)
let ringTimer = null
function startRing() {
  if (ringTimer || !soundsOn()) return
  const ring = () => { tone([440, 480], 0.8); tone([440, 480], 0.8, 0.07, 1.1) }
  ring(); ringTimer = setInterval(ring, 3800)
}
function stopRing() { if (ringTimer) { clearInterval(ringTimer); ringTimer = null } }
const ping = () => { if (soundsOn()) { tone([880], 0.11, 0.05); tone([1320], 0.16, 0.045, 0.12) } }
const chime = () => { if (soundsOn()) { tone([660], 0.16, 0.05); tone([990], 0.22, 0.045, 0.17) } }

function notify(title, body, tag) {
  if (!S.st || !S.st.notifications || S.st.notifications.browser === false) return
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return
  try {
    const n = new Notification(title, { body, tag: 'dsh-phone-' + (tag || 'x'), silent: true })
    n.onclick = () => { try { window.focus(); openTab() } catch {} n.close() }
  } catch {}
}
function toast(t) {
  if (S.st && S.st.notifications && S.st.notifications.toasts === false) return
  const id = Math.random().toString(36).slice(2)
  S.toasts = [...S.toasts.slice(-3), { id, ...t }]
  changed()
  setTimeout(() => { S.toasts = S.toasts.filter(x => x.id !== id); changed() }, t.ms || 7000)
}
function openTab() { try { S.sidebar && S.sidebar.openTab({ type: TAB_ID }) } catch {} }

// ---------------------------------------------------------------- live events

let es = null
function openEvents() {
  if (es || typeof EventSource === 'undefined') return
  es = new EventSource(API + '/events', { withCredentials: true })
  const on = (type, fn) => es.addEventListener(type, (ev) => { let d = {}; try { d = JSON.parse(ev.data || '{}') } catch {} try { fn(d) } catch (e) { console.error('[dsh-phone]', type, e) } })
  on('hello', (d) => { if (d.mode) S.mode = d.mode; if (d.counts) S.counts = d.counts; changed(); refreshSoon() })
  on('mode', (d) => { S.mode = d.mode; changed() })
  on('counts', (d) => { S.counts = d; changed() })
  on('config', () => { refreshSoon(); bump('config') })
  on('contacts', () => bump('contacts', 'sms', 'calls', 'vm'))
  on('sms.out', () => bump('sms'))
  on('sms.status', () => bump('sms'))
  on('sms.in', (d) => {
    bump('sms'); refreshSoon()
    if (d.silent) return
    const m = d.message
    ping()
    toast({ kind: 'sms', title: label(m.peer, d.name), body: m.body || (m.media.length ? 'Attachment' : ''), peer: m.peer, line: m.line })
    notify('SMS from ' + label(m.peer, d.name), m.body || 'Attachment', 'sms-' + m.peer)
  })
  on('call.incoming', () => bump('calls'))
  on('call.update', () => { bump('calls'); refreshSoon() })
  on('call.ended', (d) => {
    bump('calls'); refreshSoon()
    for (const [id, l] of Object.entries(S.live)) if (l.vm.callSid === d.call.sid) delete S.live[id]
    changed()
  })
  on('vm.started', (d) => {
    S.live[d.vm.id] = { vm: d.vm, text: '', silent: !!d.silent, dismissed: !!d.silent }
    bump('vm', 'calls')
    if (!d.silent) { chime(); notify('Voicemail', label(d.vm.peer, d.vm.name) + ' is leaving a message', 'vm-' + d.vm.id) }
  })
  on('vm.live', (d) => { const l = S.live[d.vmId]; if (l) { l.text = d.text; changed() } })
  on('vm.update', (d) => {
    const l = S.live[d.vm.id]
    if (l && d.vm.status !== 'recording') delete S.live[d.vm.id]
    bump('vm')
  })
  on('vm.ready', (d) => {
    delete S.live[d.vm.id]
    bump('vm'); refreshSoon()
    if (d.silent || d.vm.status === 'empty') return
    chime()
    toast({ kind: 'vm', title: 'Voicemail from ' + label(d.vm.peer, d.vm.name), body: d.vm.transcript || d.vm.liveText || fmtDur(d.vm.duration), ms: 10000 })
    notify('Voicemail from ' + label(d.vm.peer, d.vm.name), d.vm.transcript || 'New voicemail', 'vmr-' + d.vm.id)
  })
  es.onerror = () => { /* EventSource reconnects by itself (retry: 3000) */ }
}

// ---------------------------------------------------------------- Twilio device

let device = null
let presenceTimer = null
function loadSdk() {
  if (window.Twilio && window.Twilio.Device) return Promise.resolve(window.Twilio)
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = API + '/sdk.js'
    s.async = true
    s.onload = () => (window.Twilio && window.Twilio.Device ? resolve(window.Twilio) : reject(new Error('voice SDK did not load')))
    s.onerror = () => reject(new Error('voice SDK could not be fetched'))
    document.head.appendChild(s)
  })
}
async function fetchToken() { return (await apiPost('/token', {})).token }
async function presence() {
  try { await apiPost('/presence', { clientId: CLIENT_ID, registered: S.dev === 'ready' }) } catch {}
}
async function initDevice() {
  if (device || S.dev === 'loading') return
  S.dev = 'loading'; S.devErr = ''; changed()
  try {
    const Twilio = await loadSdk()
    const token = await fetchToken()
    const opts = { logLevel: 'error', codecPreferences: ['opus', 'pcmu'], closeProtection: 'A call is in progress. Leave anyway?', allowIncomingWhileBusy: false }
    if (S.st && S.st.edge) opts.edge = S.st.edge
    device = new Twilio.Device(token, opts)
    try { device.audio.incoming(false); device.audio.outgoing(false); device.audio.disconnect(false) } catch {}
    device.on('registered', () => { S.dev = 'ready'; S.devErr = ''; changed(); void presence() })
    device.on('unregistered', () => { S.dev = 'offline'; changed(); void presence() })
    device.on('error', (e) => {
      S.devErr = (e && (e.message || e.description)) || 'device error'
      if (e && (e.code === 20104 || e.code === 31205)) { fetchToken().then(t => device.updateToken(t)).catch(() => {}) }
      changed()
    })
    device.on('tokenWillExpire', () => { fetchToken().then(t => device.updateToken(t)).catch(e => { S.devErr = 'token refresh: ' + e.message; changed() }) })
    device.on('incoming', onIncoming)
    await device.register()
    if (!presenceTimer) presenceTimer = setInterval(() => { void presence() }, 30000)
  } catch (e) {
    S.dev = 'error'; S.devErr = String(e.message || e); device = null; changed()
  }
}
async function restartDevice() {
  try { if (device) device.destroy() } catch {}
  device = null; S.dev = 'off'; changed()
  await initDevice()
}

function callParams(call) {
  const p = call.customParameters || new Map()
  const get = (k) => (typeof p.get === 'function' ? p.get(k) : p[k]) || ''
  return { peer: get('peer') || (call.parameters && call.parameters.From) || '', name: get('name'), line: get('line'), pickup: get('pickup'), pickupToken: get('pickupToken') }
}

function wireCall(call, info) {
  S.call = call
  S.callInfo = { ...info, status: info.direction === 'out' ? 'ringing' : 'connecting', startedAt: null, muted: false }
  const end = () => {
    if (S.call !== call) return
    stopRing(); S.call = null; S.callInfo = null; changed(); bump('calls')
  }
  call.on('accept', () => { if (S.call === call) { S.callInfo.status = 'open'; S.callInfo.startedAt = Date.now(); changed() } })
  call.on('ringing', () => { if (S.call === call) { S.callInfo.status = 'ringing'; changed() } })
  call.on('mute', (m) => { if (S.call === call) { S.callInfo.muted = !!m; changed() } })
  call.on('disconnect', end); call.on('cancel', end); call.on('reject', end)
  call.on('error', (e) => { S.devErr = (e && e.message) || 'call error'; end() })
  changed()
}

function onIncoming(call) {
  const info = { ...callParams(call), direction: 'in' }
  if (info.pickupToken && info.pickupToken === S.pendingPickup) {
    S.pendingPickup = null
    wireCall(call, info)
    call.accept()
    return
  }
  if (S.call || S.incoming) { call.reject(); return } // busy: the caller gets voicemail
  S.incoming = { call, info }
  const clear = () => { if (S.incoming && S.incoming.call === call) { S.incoming = null; stopRing(); changed() } }
  call.on('cancel', clear); call.on('disconnect', clear); call.on('reject', clear)
  startRing()
  notify('Incoming call', label(info.peer, info.name), 'call')
  changed()
}

const phone = {
  accept() {
    const inc = S.incoming; if (!inc) return
    S.incoming = null; stopRing()
    wireCall(inc.call, inc.info)
    inc.call.accept()
  },
  decline() { const inc = S.incoming; if (!inc) return; S.incoming = null; stopRing(); inc.call.reject(); changed() },
  async declineWithText(text) {
    const inc = S.incoming; if (!inc) return
    phone.decline()
    try { await apiPost('/sms/send', { to: inc.info.peer, body: text, line: inc.info.line }) } catch (e) { toast({ kind: 'err', title: 'SMS not sent', body: e.message }) }
  },
  hangup() { if (S.call) { try { S.call.disconnect() } catch {} } },
  mute() { if (S.call) { S.call.mute(!S.call.isMuted()) } },
  digit(d) { if (S.call) { try { S.call.sendDigits(d) } catch {} tone([697 + '123456789*0#'.indexOf(d) * 20], 0.08, 0.04) } },
  async dial(to, line) {
    if (!device || S.dev !== 'ready') throw new Error('The phone is not connected yet (' + (S.devErr || S.dev) + ').')
    if (S.call) throw new Error('Hang up the current call first.')
    const call = await device.connect({ params: { To: to, line: line || '' } })
    wireCall(call, { peer: to, name: '', line, direction: 'out' })
  },
  async pickup(vmId) {
    const token = Math.random().toString(36).slice(2, 14).replace(/[^a-z0-9]/g, '')
    S.pendingPickup = token
    if (S.live[vmId]) S.live[vmId].picking = true
    changed()
    try { await apiPost('/pickup', { vmId, token }) } catch (e) {
      S.pendingPickup = null; if (S.live[vmId]) S.live[vmId].picking = false
      toast({ kind: 'err', title: 'Could not pick up', body: e.message }); changed()
    }
  },
  dismissLive(vmId) { if (S.live[vmId]) { S.live[vmId].dismissed = true; changed() } },
  async setMode(mode) {
    const prev = S.mode
    S.mode = mode; changed()
    try { await apiPost('/mode', { mode }) } catch (e) { S.mode = prev; changed(); toast({ kind: 'err', title: 'Mode not changed', body: e.message }) }
  },
  async enableNotifications() {
    if (typeof Notification === 'undefined') return
    try { S.notifPerm = await Notification.requestPermission() } catch {}
    audio()
    changed()
  },
}

// ---------------------------------------------------------------- styles

const CSS = `
.phx,.phx-ov{--ok:var(--dsw-alias-state-success-primary,#2e9e5b);--warn:var(--dsw-alias-state-warn-primary,#c98a14);
  --bad:var(--dsw-alias-state-error-primary,#cf3b3b);--brand:var(--dsw-alias-brand-primary,#4d6bfe);
  --ink:var(--dsw-alias-label-primary,inherit);--ink2:var(--dsw-alias-label-secondary,inherit);
  --ink3:var(--dsw-alias-label-tertiary,inherit);--line:var(--dsw-alias-border-l2,rgba(128,128,128,.28));
  --line1:var(--dsw-alias-border-l1,rgba(128,128,128,.18));--l1:var(--dsw-alias-bg-layer-1,transparent);
  --l2:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.07));--hov:var(--dsh-alias-interactive-bg-hover,rgba(128,128,128,.12));
  --bg:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1,#fff));
  --mono:var(--tz-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}
.phx{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;font:inherit;font-size:13px;color:var(--ink)}
.phx *,.phx-ov *{box-sizing:border-box}
.phx-bar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--line);flex:0 0 auto}
.phx-body{flex:1;min-height:0;overflow-y:auto;padding:10px 10px 24px}
.phx-btn{font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}
.phx-btn:hover:not(:disabled){background:var(--hov)}
.phx-btn:disabled{opacity:.45;cursor:not-allowed}
.phx-btn.p{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--brand));color:#fff;font-weight:600}
.phx-btn.ok{border-color:transparent;background:var(--ok);color:#fff;font-weight:600}
.phx-btn.d{border-color:var(--bad);color:var(--bad)}
.phx-btn.dd{border-color:transparent;background:var(--bad);color:#fff;font-weight:600}
.phx-btn.i{padding:4px 6px}
.phx-seg{display:flex;gap:2px;padding:2px;border:1px solid var(--line);border-radius:8px;background:var(--l2)}
.phx-seg button{flex:1;font:inherit;font-size:12px;padding:4px 8px;border:0;border-radius:6px;background:transparent;color:var(--ink2);cursor:pointer;white-space:nowrap;display:flex;align-items:center;justify-content:center;gap:5px}
.phx-seg button[aria-pressed=true]{background:var(--l1);color:var(--ink);font-weight:650;box-shadow:0 0 0 1px var(--line1)}
.phx-seg button[aria-pressed=true][data-m=live]{color:var(--ok)}
.phx-seg button[aria-pressed=true][data-m=voicemail]{color:var(--brand)}
.phx-seg button[aria-pressed=true][data-m=dnd]{color:var(--warn)}
.phx-nav{display:flex;gap:2px;padding:6px 10px 0;border-bottom:1px solid var(--line);flex:0 0 auto;overflow-x:auto}
.phx-nav button{font:inherit;font-size:12px;padding:5px 8px 7px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--ink2);cursor:pointer;white-space:nowrap;display:flex;gap:5px;align-items:center}
.phx-nav button[aria-selected=true]{color:var(--ink);border-bottom-color:var(--brand);font-weight:650}
.phx-badge{font-size:10px;line-height:15px;min-width:16px;padding:0 4px;border-radius:999px;background:var(--brand);color:#fff;font-weight:700;text-align:center}
.phx-badge.bad{background:var(--bad)}
.phx-k{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3)}
.phx-h{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--ink3);margin:16px 0 6px;display:flex;align-items:center;gap:8px}
.phx-s{font-size:11px;color:var(--ink3)}
.phx-mono{font-family:var(--mono);font-size:11.5px}
.phx-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.phx-row{display:flex;gap:9px;align-items:center;padding:7px 8px;border:1px solid var(--line1);border-radius:7px;margin-bottom:5px;background:var(--l1);cursor:pointer;text-align:left;width:100%;font:inherit;color:inherit}
.phx-row:hover{background:var(--hov)}
.phx-row.unread .phx-name{font-weight:700}
.phx-av{width:30px;height:30px;border-radius:50%;flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;background:var(--l2);border:1px solid var(--line1);color:var(--ink2)}
.phx-name{font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.phx-note{border:1px solid var(--line);border-left-width:3px;border-radius:8px;padding:9px 11px;margin:0 0 10px;line-height:1.5;background:var(--l1)}
.phx-note.bad{border-left-color:var(--bad)}.phx-note.warn{border-left-color:var(--warn)}.phx-note.ok{border-left-color:var(--ok)}.phx-note.info{border-left-color:var(--brand)}
.phx-empty{color:var(--ink3);padding:14px;border:1px dashed var(--line);border-radius:8px;line-height:1.5;text-align:center}
.phx-in{font:inherit;font-size:12.5px;width:100%;padding:6px 8px;border-radius:7px;border:1px solid var(--line);background:transparent;color:inherit}
.phx-in:focus{outline:2px solid var(--brand);outline-offset:-1px}
textarea.phx-in{resize:vertical;min-height:38px;line-height:1.45}
.phx-flex{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.phx-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;display:inline-block;background:var(--ink3)}
.phx-dot.ok{background:var(--ok)}.phx-dot.warn{background:var(--warn)}.phx-dot.bad{background:var(--bad)}
.phx-thread{display:flex;flex-direction:column;height:100%;min-height:0}
.phx-msgs{flex:1;min-height:0;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:6px}
.phx-bub{max-width:82%;padding:7px 10px;border-radius:12px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;border:1px solid var(--line1)}
.phx-bub.in{align-self:flex-start;background:var(--l2)}
.phx-bub.out{align-self:flex-end;background:var(--dsw-alias-button-primary-fill,var(--brand));color:#fff;border-color:transparent}
.phx-bub.out.failed{background:transparent;color:var(--bad);border-color:var(--bad)}
.phx-meta{font-size:10.5px;color:var(--ink3);margin:-2px 4px 4px}
.phx-meta.out{align-self:flex-end}
.phx-bub img{max-width:100%;border-radius:8px;display:block;margin-top:4px}
.phx-compose{border-top:1px solid var(--line);padding:8px 10px;display:flex;gap:8px;align-items:flex-end;flex:0 0 auto}
.phx-pad{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-width:260px;margin:12px auto}
.phx-key{font:inherit;font-size:20px;font-weight:550;height:52px;border-radius:12px;border:1px solid var(--line1);background:var(--l1);color:inherit;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1.05}
.phx-key small{font-size:9px;letter-spacing:.12em;color:var(--ink3);font-weight:600}
.phx-key:hover{background:var(--hov)}
.phx-dial{font-family:var(--mono);font-size:22px;text-align:center;letter-spacing:.04em;border:0;border-bottom:1px solid var(--line);border-radius:0;padding:8px 4px;background:transparent;color:inherit;width:100%}
.phx-dial:focus{outline:none;border-bottom-color:var(--brand)}
.phx-callstrip{display:flex;align-items:center;gap:8px;padding:7px 10px;background:color-mix(in srgb,var(--ok) 14%,transparent);border-bottom:1px solid var(--line);flex:0 0 auto}
.phx-vm{border:1px solid var(--line);border-radius:9px;padding:9px 11px;margin-bottom:8px;background:var(--l1)}
.phx-vm.new{border-left:3px solid var(--brand)}
.phx-vm audio{width:100%;height:32px;margin:6px 0 2px}
.phx-tx{line-height:1.5;margin-top:5px;white-space:pre-wrap}
.phx-pill{font-size:10px;padding:1px 7px;border-radius:999px;border:1px solid currentColor;white-space:nowrap;font-weight:600}
.phx-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.phx-field{display:flex;flex-direction:column;gap:3px;margin-bottom:9px;min-width:0}
.phx-field>span{font-size:11.5px;color:var(--ink2);font-weight:550}
.phx-field>em{font-style:normal;font-size:10.5px;color:var(--ink3);line-height:1.4}
.phx-chk{display:flex;align-items:flex-start;gap:7px;margin-bottom:8px;cursor:pointer;line-height:1.35}
.phx-chk input{margin-top:2px}
.phx-card{border:1px solid var(--line);border-radius:9px;padding:10px 11px;margin-bottom:10px;background:var(--l1)}
.phx-check{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px dashed var(--line1)}
.phx-check:last-child{border-bottom:0}
.phx-linerow{display:grid;grid-template-columns:62px 1fr 1fr auto;gap:6px;align-items:center;margin-bottom:6px}
.phx-ov{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;gap:10px;align-items:flex-end;pointer-events:none;font-size:13px;color:var(--ink)}
.phx-ov>*{pointer-events:auto}
.phx-oc{width:330px;max-width:calc(100vw - 32px);border:1px solid var(--line);border-radius:12px;padding:12px 13px;background:var(--bg);box-shadow:0 10px 32px rgba(0,0,0,.28)}
.phx-oc.ring{border-color:var(--ok);animation:phx-pulse 1.4s ease-in-out infinite}
.phx-oc.vm{border-color:var(--brand)}
@keyframes phx-pulse{0%,100%{box-shadow:0 10px 32px rgba(0,0,0,.28),0 0 0 0 color-mix(in srgb,var(--ok) 50%,transparent)}50%{box-shadow:0 10px 32px rgba(0,0,0,.28),0 0 0 7px color-mix(in srgb,var(--ok) 0%,transparent)}}
.phx-big{font-size:17px;font-weight:700;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.phx-live{max-height:110px;overflow-y:auto;line-height:1.45;margin:8px 0;padding:7px 9px;border-radius:8px;background:var(--l2);font-size:12.5px;white-space:pre-wrap}
.phx-live:empty::before{content:'Listening...';color:var(--ink3)}
.phx-toast{width:330px;max-width:calc(100vw - 32px);border:1px solid var(--line);border-left:3px solid var(--brand);border-radius:10px;padding:9px 11px;background:var(--bg);box-shadow:0 8px 24px rgba(0,0,0,.22);cursor:pointer}
.phx-toast.err{border-left-color:var(--bad)}
.phx-toast .b{color:var(--ink2);margin-top:2px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;line-height:1.4}
`
function injectCss() {
  if (document.getElementById('dsh-phone-css')) return
  const s = document.createElement('style')
  s.id = 'dsh-phone-css'
  s.textContent = CSS
  document.head.appendChild(s)
}

// ---------------------------------------------------------------- icons

const I = {
  phone: (s = 16) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true"><path d="M3.2 1.8h2.4l1.2 3-1.6 1.1a8.2 8.2 0 0 0 4.9 4.9l1.1-1.6 3 1.2v2.4c0 .7-.6 1.3-1.3 1.3A11.7 11.7 0 0 1 1.9 3.1c0-.7.6-1.3 1.3-1.3z" /></svg>,
  hang: (s = 16) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><path d="M1.5 9.6c3.6-3.4 9.4-3.4 13 0l-1.6 2-2.6-1.1V8.6a8 8 0 0 0-4.6 0v1.9l-2.6 1.1z" /></svg>,
  msg: (s = 16) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true"><path d="M2 3.2h12v8H6.5L3.5 14v-2.8H2z" /></svg>,
  vm: (s = 16) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><circle cx="4.4" cy="8.6" r="2.6" /><circle cx="11.6" cy="8.6" r="2.6" /><path d="M4.4 11.2h7.2" /></svg>,
  pad: (s = 16) => <svg width={s} height={s} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">{[3, 8, 13].flatMap(x => [3, 8, 13].map(y => <circle key={x + '-' + y} cx={x} cy={y} r="1.3" />))}</svg>,
  user: (s = 16) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><circle cx="8" cy="5.5" r="2.8" /><path d="M2.6 14c.6-2.8 2.8-4.3 5.4-4.3s4.8 1.5 5.4 4.3" /></svg>,
  gear: (s = 16) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" strokeLinecap="round" /></svg>,
  back: (s = 16) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3L5 8l5 5" /></svg>,
  mic: (s = 16, off = false) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true"><rect x="5.6" y="1.8" width="4.8" height="8" rx="2.4" /><path d="M3.4 7.8a4.6 4.6 0 0 0 9.2 0M8 12.4v2" />{off ? <path d="M2.5 2.5l11 11" /> : null}</svg>,
  moon: (s = 14) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true"><path d="M13 9.8A5.6 5.6 0 0 1 6.2 3a5.6 5.6 0 1 0 6.8 6.8z" /></svg>,
  star: (s = 14, on = false) => <svg width={s} height={s} viewBox="0 0 16 16" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true"><path d="M8 1.8l1.9 4 4.3.5-3.2 2.9.9 4.3L8 11.4l-3.9 2.1.9-4.3L1.8 6.3l4.3-.5z" /></svg>,
  arrowIn: (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M12 4L4 12M4 6v6h6" /></svg>,
  arrowOut: (s = 13) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 12l8-8M6 4h6v6" /></svg>,
}
const initials = (peer, name) => {
  if (name) return name.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
  return String(peer || '?').replace(/\D/g, '').slice(-2) || '#'
}

// ---------------------------------------------------------------- overlay

function CallTimer({ since }) {
  const [, set] = useState(0)
  useEffect(() => { const t = setInterval(() => set(x => x + 1), 1000); return () => clearInterval(t) }, [])
  return <span className="phx-mono">{since ? fmtDur((Date.now() - since) / 1000) : '0:00'}</span>
}

function Keypad({ onKey, compact }) {
  const keys = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']]
  return (
    <div className="phx-pad" style={compact ? { margin: '8px 0 2px', maxWidth: 'none', gap: 6 } : null}>
      {keys.map(([k, sub]) => (
        <button key={k} type="button" className="phx-key" style={compact ? { height: 40, fontSize: 17 } : null}
          onClick={() => onKey(k)} onContextMenu={(e) => { if (k === '0') { e.preventDefault(); onKey('+') } }}>
          {k}{sub && !compact ? <small>{sub}</small> : null}
        </button>
      ))}
    </div>
  )
}

function ActiveCallCard() {
  const p = usePhone()
  const [pad, setPad] = useState(false)
  if (!p.call || !p.callInfo) return null
  const c = p.callInfo
  return (
    <div className="phx-oc" role="dialog" aria-label="Active call">
      <div className="phx-flex" style={{ justifyContent: 'space-between' }}>
        <span className="phx-k">{c.direction === 'out' ? 'Outgoing call' : 'Call'}{c.line ? ' · ' + c.line : ''}</span>
        <span className="phx-s">{c.status === 'open' ? <CallTimer since={c.startedAt} /> : c.status === 'ringing' ? 'Ringing...' : 'Connecting...'}</span>
      </div>
      <div className="phx-big" style={{ margin: '6px 0 10px' }}>{label(c.peer, c.name)}</div>
      {pad ? <Keypad compact onKey={phone.digit} /> : null}
      <div className="phx-flex" style={{ justifyContent: 'space-between', marginTop: 6 }}>
        <div className="phx-flex">
          <button type="button" className={'phx-btn' + (c.muted ? ' d' : '')} onClick={phone.mute} title={c.muted ? 'Unmute' : 'Mute'}>{I.mic(14, c.muted)}{c.muted ? 'Muted' : 'Mute'}</button>
          <button type="button" className="phx-btn" aria-pressed={pad} onClick={() => setPad(!pad)}>{I.pad(13)}Keypad</button>
        </div>
        <button type="button" className="phx-btn dd" onClick={phone.hangup}>{I.hang(15)}Hang up</button>
      </div>
    </div>
  )
}

function IncomingCard() {
  const p = usePhone()
  const [reply, setReply] = useState(false)
  if (!p.incoming) return null
  const c = p.incoming.info
  const quick = ['Cannot talk right now. I will call you back.', 'In a meeting, text me?', 'Call you in 10 minutes.']
  return (
    <div className="phx-oc ring" role="alertdialog" aria-label="Incoming call">
      <div className="phx-k">Incoming call{c.line ? ' · line ' + c.line : ''}</div>
      <div className="phx-big" style={{ margin: '6px 0 2px' }}>{label(c.peer, c.name)}</div>
      {c.name ? <div className="phx-s phx-mono">{fmtNum(c.peer)}</div> : null}
      {reply ? (
        <div style={{ marginTop: 8 }}>
          {quick.map(q => <button key={q} type="button" className="phx-row" style={{ cursor: 'pointer' }} onClick={() => phone.declineWithText(q)}>{q}</button>)}
        </div>
      ) : null}
      <div className="phx-flex" style={{ marginTop: 10, justifyContent: 'space-between' }}>
        <div className="phx-flex">
          <button type="button" className="phx-btn d" onClick={phone.decline} title="Send to voicemail">{I.hang(15)}Decline</button>
          <button type="button" className="phx-btn" onClick={() => setReply(!reply)} title="Decline with a text message">{I.msg(14)}Text</button>
        </div>
        <button type="button" className="phx-btn ok" onClick={phone.accept} autoFocus>{I.phone(14)}Answer</button>
      </div>
    </div>
  )
}

function LiveVoicemailCards() {
  const p = usePhone()
  const ref = useRef({})
  const live = Object.entries(p.live).filter(([, l]) => !l.dismissed)
  useEffect(() => { for (const el of Object.values(ref.current)) if (el) el.scrollTop = el.scrollHeight })
  return live.map(([id, l]) => (
    <div key={id} className="phx-oc vm" role="dialog" aria-label="Live voicemail">
      <div className="phx-flex" style={{ justifyContent: 'space-between' }}>
        <span className="phx-k">Leaving a voicemail{l.vm.line ? ' · ' + l.vm.line : ''}</span>
        <button type="button" className="phx-btn i" title="Hide" onClick={() => phone.dismissLive(id)}>&#x2715;</button>
      </div>
      <div className="phx-big" style={{ marginTop: 6 }}>{label(l.vm.peer, l.vm.name)}</div>
      <div className="phx-live" ref={el => { ref.current[id] = el }}>{l.text}</div>
      <div className="phx-flex" style={{ justifyContent: 'space-between' }}>
        <span className="phx-s">{p.dev === 'ready' ? 'Pick up to take the call here.' : 'Phone not connected: cannot pick up.'}</span>
        <button type="button" className="phx-btn ok" disabled={p.dev !== 'ready' || !!p.call || l.picking} onClick={() => phone.pickup(Number(id))}>{I.phone(14)}{l.picking ? 'Connecting...' : 'Pick up'}</button>
      </div>
    </div>
  ))
}

function Toasts() {
  const p = usePhone()
  return p.toasts.map(t => (
    <div key={t.id} className={'phx-toast' + (t.kind === 'err' ? ' err' : '')} role="status"
      onClick={() => { S.toasts = S.toasts.filter(x => x.id !== t.id); changed(); if (t.kind !== 'err') { if (t.peer) S.openThread = { peer: t.peer, line: t.line }; openTab(); changed() } }}>
      <div className="phx-flex" style={{ gap: 6 }}>{t.kind === 'sms' ? I.msg(13) : t.kind === 'vm' ? I.vm(13) : null}<b className="phx-grow">{t.title}</b></div>
      {t.body ? <div className="b">{t.body}</div> : null}
    </div>
  ))
}

function Overlay() {
  usePhone()
  return (
    <>
      <Toasts />
      <LiveVoicemailCards />
      <IncomingCard />
      <ActiveCallCard />
    </>
  )
}

// ---------------------------------------------------------------- tab: header

function StatusDot() {
  const p = usePhone()
  const st = p.st
  let cls = '', text = 'Loading'
  if (p.stErr) { cls = 'bad'; text = 'Phone service unreachable' }
  else if (st && !st.ready) { cls = 'warn'; text = 'Setup needed' }
  else if (p.dev === 'ready') { cls = 'ok'; text = 'Connected' }
  else if (p.dev === 'loading') { cls = 'warn'; text = 'Connecting' }
  else if (p.dev === 'error') { cls = 'bad'; text = 'Device error' }
  else if (p.dev === 'offline') { cls = 'warn'; text = 'Offline' }
  return <span className="phx-flex" style={{ gap: 6 }} title={p.devErr || p.stErr || text}><span className={'phx-dot ' + cls} /><span className="phx-s">{text}</span></span>
}

function ModeSwitch() {
  const p = usePhone()
  const modes = [
    ['live', 'Live', 'Calls ring this browser. Unanswered calls go to voicemail.'],
    ['voicemail', 'Voicemail', 'Every call goes to voicemail. You see a live transcript and can pick up.'],
    ['dnd', 'Do not disturb', 'Calls go to voicemail; no rings, sounds or notifications. Starred contacts can still ring.'],
  ]
  const cur = modes.find(m => m[0] === p.mode)
  return (
    <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--line)', flex: '0 0 auto' }}>
      <div className="phx-seg" role="group" aria-label="Incoming calls">
        {modes.map(([m, l, hint]) => (
          <button key={m} type="button" data-m={m} aria-pressed={p.mode === m} title={hint} onClick={() => phone.setMode(m)}>
            {m === 'live' ? I.phone(13) : m === 'voicemail' ? I.vm(13) : I.moon(13)}{l}
          </button>
        ))}
      </div>
      {cur ? <div className="phx-s" style={{ marginTop: 5 }}>{cur[2]}</div> : null}
    </div>
  )
}

function CallStrip() {
  const p = usePhone()
  if (!p.call || !p.callInfo) return null
  return (
    <div className="phx-callstrip">
      {I.phone(14)}<b className="phx-grow">{label(p.callInfo.peer, p.callInfo.name)}</b>
      {p.callInfo.status === 'open' ? <CallTimer since={p.callInfo.startedAt} /> : <span className="phx-s">{p.callInfo.status}...</span>}
      <button type="button" className="phx-btn i" onClick={phone.mute} title="Mute">{I.mic(14, p.callInfo.muted)}</button>
      <button type="button" className="phx-btn dd i" onClick={phone.hangup} title="Hang up">{I.hang(15)}</button>
    </div>
  )
}

function useLoad(fn, deps) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let alive = true
    fn().then(d => { if (alive) { setData(d); setErr('') } }).catch(e => { if (alive) setErr(String(e.message || e)) })
    return () => { alive = false }
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  return [data, err, setData]
}

function LineSelect({ value, onChange, needs }) {
  const p = usePhone()
  const lines = ((p.st && p.st.lines) || []).filter(l => l.enabled && (!needs || l[needs]))
  if (lines.length <= 1) return null
  return (
    <select className="phx-in" style={{ width: 'auto' }} value={value || ''} onChange={e => onChange(e.target.value)} aria-label="Line">
      {lines.map(l => <option key={l.id} value={l.id}>{l.label} {fmtNum(l.number)}</option>)}
    </select>
  )
}

// ---------------------------------------------------------------- tab: messages

function Threads({ onOpen, onNew }) {
  const p = usePhone()
  const [q, setQ] = useState('')
  const [data, err] = useLoad(() => apiGet('/threads?q=' + encodeURIComponent(q)), [p.ver.sms, q])
  const threads = (data && data.threads) || []
  return (
    <div>
      <div className="phx-flex" style={{ marginBottom: 8, flexWrap: 'nowrap' }}>
        <input className="phx-in" placeholder="Search messages" value={q} onChange={e => setQ(e.target.value)} />
        <button type="button" className="phx-btn p" onClick={onNew}>{I.msg(13)}New</button>
      </div>
      {err ? <div className="phx-note bad">{err}</div> : null}
      {data && !threads.length ? <div className="phx-empty">No messages yet. Texts to your number appear here.</div> : null}
      {threads.map(t => (
        <button key={t.line + t.peer} type="button" className={'phx-row' + (t.unread ? ' unread' : '')} onClick={() => onOpen(t)}>
          <span className="phx-av">{initials(t.peer, t.name)}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="phx-flex" style={{ flexWrap: 'nowrap' }}>
              <span className="phx-name phx-grow">{label(t.peer, t.name)}</span>
              <span className="phx-s">{fmtWhen(t.ts)}</span>
            </span>
            <span className="phx-flex" style={{ flexWrap: 'nowrap' }}>
              <span className="phx-s phx-grow">{t.last.direction === 'out' ? 'You: ' : ''}{t.last.body || (t.last.hasMedia ? 'Attachment' : '')}</span>
              {t.unread ? <span className="phx-badge">{t.unread}</span> : null}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}

function Thread({ peer, line, onBack, onCall }) {
  const p = usePhone()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const box = useRef(null)
  const [data] = useLoad(() => apiGet('/thread?' + new URLSearchParams({ peer, line })), [p.ver.sms, peer, line])
  const msgs = (data && data.messages) || []
  const contact = data && data.contact
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight }, [msgs.length])
  useEffect(() => { if (data && msgs.some(m => m.direction === 'in' && !m.read)) apiPost('/thread/read', { line: data.line, peer: data.peer }).catch(() => {}) }, [data])
  const seg = segments(text)
  async function send() {
    const body = text.trim(); if (!body || busy) return
    setBusy(true); setErr('')
    try { await apiPost('/sms/send', { to: peer, body, line }); setText('') } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <div className="phx-thread">
      <div className="phx-bar">
        <button type="button" className="phx-btn i" onClick={onBack} aria-label="Back">{I.back(14)}</button>
        <span className="phx-av">{initials(peer, contact && contact.name)}</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <div className="phx-name">{label(peer, contact && contact.name)}</div>
          <div className="phx-s phx-mono">{contact && contact.name ? fmtNum(peer) : 'line ' + line}</div>
        </span>
        <button type="button" className="phx-btn i" title="Call" onClick={() => onCall(peer, line)}>{I.phone(14)}</button>
      </div>
      <div className="phx-msgs" ref={box}>
        {data && !msgs.length ? <div className="phx-empty">Start the conversation.</div> : null}
        {msgs.map(m => (
          <div key={m.id} style={{ display: 'flex', flexDirection: 'column' }}>
            <div className={'phx-bub ' + m.direction + (m.status === 'failed' || m.status === 'undelivered' ? ' failed' : '')}>
              {m.body}
              {m.media.map((x, i) => /^image\//.test(x.type)
                ? <a key={i} href={API + '/media?url=' + encodeURIComponent(x.url)} target="_blank" rel="noreferrer"><img alt="attachment" src={API + '/media?url=' + encodeURIComponent(x.url)} /></a>
                : <div key={i}><a href={API + '/media?url=' + encodeURIComponent(x.url)} target="_blank" rel="noreferrer">Attachment ({x.type})</a></div>)}
            </div>
            <div className={'phx-meta ' + m.direction}>
              {fmtWhen(m.ts)}{m.direction === 'out' ? ' · ' + (m.status || 'sending') + (m.error ? ' (' + m.error + ')' : '') : ''}{m.origin === 'agent' ? ' · by agent' : m.origin === 'auto' ? ' · auto reply' : ''}
            </div>
          </div>
        ))}
      </div>
      {err ? <div className="phx-note bad" style={{ margin: '0 10px 6px' }}>{err}</div> : null}
      <div className="phx-compose">
        <div style={{ flex: 1, minWidth: 0 }}>
          <textarea className="phx-in" rows={2} placeholder="Text message" value={text} onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
          <div className="phx-s" style={{ marginTop: 3 }}>{text ? seg.chars + ' chars · ' + seg.seg + ' SMS' + (seg.enc === 'UCS-2' ? ' · Unicode' : '') : 'Enter to send, Shift+Enter for a new line'}</div>
        </div>
        <button type="button" className="phx-btn p" disabled={busy || !text.trim()} onClick={() => void send()}>{busy ? 'Sending' : 'Send'}</button>
      </div>
    </div>
  )
}

function NewMessage({ onBack, onSent }) {
  const p = usePhone()
  const [to, setTo] = useState('')
  const [line, setLine] = useState((p.st && p.st.defaultLine) || '')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const seg = segments(text)
  async function send() {
    setBusy(true); setErr('')
    try { const r = await apiPost('/sms/send', { to, body: text, line }); onSent(r.message.peer, r.message.line) } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <div>
      <div className="phx-flex" style={{ marginBottom: 10 }}>
        <button type="button" className="phx-btn i" onClick={onBack} aria-label="Back">{I.back(14)}</button><b>New message</b>
      </div>
      <label className="phx-field"><span>To</span><input className="phx-in phx-mono" placeholder={(p.st && p.st.defaultCountry ? p.st.defaultCountry + ' ' : '+') + '...'} value={to} onChange={e => setTo(e.target.value)} autoFocus /></label>
      <div style={{ marginBottom: 9 }}><LineSelect value={line} onChange={setLine} needs="sms" /></div>
      <label className="phx-field"><span>Message</span><textarea className="phx-in" rows={4} value={text} onChange={e => setText(e.target.value)} /><em>{seg.chars} chars · {seg.seg} SMS{seg.enc === 'UCS-2' ? ' · Unicode (70 per SMS)' : ''}</em></label>
      {err ? <div className="phx-note bad">{err}</div> : null}
      <button type="button" className="phx-btn p" disabled={busy || !to.trim() || !text.trim()} onClick={() => void send()}>{busy ? 'Sending' : 'Send'}</button>
    </div>
  )
}

// ---------------------------------------------------------------- tab: calls

const DISP = {
  answered: ['Answered', 'ok'], picked_up: ['Picked up', 'ok'], missed: ['Missed', 'bad'], 'no-answer': ['No answer', 'warn'],
  declined: ['Declined', 'warn'], voicemail: ['Voicemail', ''], blocked: ['Blocked', 'bad'], busy: ['Busy', 'warn'],
  failed: ['Failed', 'bad'], canceled: ['Cancelled', 'warn'], ringing: ['Ringing', 'ok'], dialing: ['Dialing', 'ok'],
}
function Calls({ onCall, onText }) {
  const p = usePhone()
  const [data, err] = useLoad(() => apiGet('/calls?limit=150'), [p.ver.calls])
  useEffect(() => { if (p.counts.missed) apiPost('/calls/seen', {}).then(() => refreshSoon()).catch(() => {}) }, [p.counts.missed])
  const calls = (data && data.calls) || []
  return (
    <div>
      {err ? <div className="phx-note bad">{err}</div> : null}
      {data && !calls.length ? <div className="phx-empty">No calls yet.</div> : null}
      {calls.map(c => {
        const d = DISP[c.disposition] || [c.disposition || c.status, '']
        const bad = d[1] === 'bad'
        return (
          <div key={c.id} className="phx-row" style={{ cursor: 'default' }}>
            <span style={{ color: bad ? 'var(--bad)' : 'var(--ink3)' }}>{c.direction === 'in' ? I.arrowIn() : I.arrowOut()}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <div className="phx-name" style={bad ? { color: 'var(--bad)' } : null}>{label(c.peer, c.name)}</div>
              <div className="phx-s">{fmtWhen(c.started)} · {d[0]}{c.duration ? ' · ' + fmtDur(c.duration) : ''}{c.origin === 'agent' ? ' · by agent' : ''}{c.line ? ' · ' + c.line : ''}</div>
            </span>
            <button type="button" className="phx-btn i" title="Text" onClick={() => onText(c.peer, c.line)}>{I.msg(13)}</button>
            <button type="button" className="phx-btn i" title="Call back" onClick={() => onCall(c.peer, c.line)}>{I.phone(13)}</button>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- tab: voicemail

const VMST = { recording: ['Recording', 'ok'], processing: ['Transcribing', 'warn'], ready: ['', ''], empty: ['No message', ''], failed: ['Failed', 'bad'], picked_up: ['Picked up', 'ok'] }
function Voicemails({ onCall, onText }) {
  const p = usePhone()
  const [data, err] = useLoad(() => apiGet('/voicemails?limit=100'), [p.ver.vm])
  const vms = ((data && data.voicemails) || []).filter(v => v.status !== 'empty' || v.pickedUp)
  async function act(path, id) { try { await apiPost(path, { id }); bump('vm'); refreshSoon() } catch (e) { toast({ kind: 'err', title: 'Voicemail', body: e.message }) } }
  return (
    <div>
      {err ? <div className="phx-note bad">{err}</div> : null}
      {data && !vms.length ? <div className="phx-empty">No voicemails.</div> : null}
      {vms.map(v => {
        const st = VMST[v.status] || [v.status, '']
        const live = p.live[v.id]
        return (
          <div key={v.id} className={'phx-vm' + (v.read ? '' : ' new')}>
            <div className="phx-flex" style={{ flexWrap: 'nowrap' }}>
              <b className="phx-grow">{label(v.peer, v.name)}</b>
              {st[0] ? <span className="phx-pill" style={{ color: st[1] ? 'var(--' + st[1] + ')' : 'var(--ink3)' }}>{st[0]}</span> : null}
              {v.pickedUp && v.status !== 'picked_up' ? <span className="phx-pill" style={{ color: 'var(--ok)' }}>Picked up</span> : null}
            </div>
            <div className="phx-s">{fmtWhen(v.ts)}{v.duration ? ' · ' + fmtDur(v.duration) : ''}{v.line ? ' · ' + v.line : ''}{v.language ? ' · ' + v.language : ''}</div>
            {v.hasAudio ? <audio controls preload="none" src={API + '/voicemail/audio?id=' + v.id} onPlay={() => { if (!v.read) void act('/voicemail/read', v.id) }} /> : null}
            <div className="phx-tx">{live ? (live.text || 'Listening...') : (v.transcript || v.liveText || (v.status === 'processing' ? 'Transcribing...' : ''))}</div>
            <div className="phx-flex" style={{ marginTop: 7 }}>
              {live && !live.picking ? <button type="button" className="phx-btn ok" disabled={p.dev !== 'ready' || !!p.call} onClick={() => phone.pickup(v.id)}>{I.phone(13)}Pick up</button> : null}
              <button type="button" className="phx-btn" onClick={() => onCall(v.peer, v.line)}>{I.phone(13)}Call back</button>
              <button type="button" className="phx-btn" onClick={() => onText(v.peer, v.line)}>{I.msg(13)}Text</button>
              {!v.read ? <button type="button" className="phx-btn" onClick={() => void act('/voicemail/read', v.id)}>Mark read</button> : null}
              {v.hasAudio ? <button type="button" className="phx-btn" title="Transcribe again" onClick={() => void act('/voicemail/retranscribe', v.id)}>Re-transcribe</button> : null}
              <button type="button" className="phx-btn d" onClick={() => { if (window.confirm('Delete this voicemail?')) void act('/voicemail/delete', v.id) }}>Delete</button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- tab: keypad

function Dialer({ preset }) {
  const p = usePhone()
  const [num, setNum] = useState(preset ? preset.peer : '')
  const [line, setLine] = useState((preset && preset.line) || (p.st && p.st.defaultLine) || '')
  const [err, setErr] = useState('')
  useEffect(() => { if (preset) { setNum(preset.peer); if (preset.line) setLine(preset.line) } }, [preset])
  async function call() {
    setErr('')
    try { await phone.dial(num.trim(), line) } catch (e) { setErr(e.message) }
  }
  return (
    <div style={{ maxWidth: 300, margin: '0 auto' }}>
      <input className="phx-dial" value={num} onChange={e => setNum(e.target.value)} placeholder={(p.st && p.st.defaultCountry) || '+'} aria-label="Number"
        onKeyDown={e => { if (e.key === 'Enter') void call() }} />
      <Keypad onKey={(k) => { if (p.call) phone.digit(k); else setNum(n => n + k) }} />
      <div className="phx-flex" style={{ justifyContent: 'center' }}>
        <LineSelect value={line} onChange={setLine} needs="voice" />
        {p.call
          ? <button type="button" className="phx-btn dd" style={{ padding: '8px 22px' }} onClick={phone.hangup}>{I.hang(16)}Hang up</button>
          : <button type="button" className="phx-btn ok" style={{ padding: '8px 22px' }} disabled={!num.trim() || p.dev !== 'ready'} onClick={() => void call()}>{I.phone(15)}Call</button>}
        {num && !p.call ? <button type="button" className="phx-btn i" title="Delete" onClick={() => setNum(num.slice(0, -1))}>&#x232b;</button> : null}
      </div>
      {p.dev !== 'ready' ? <div className="phx-s" style={{ textAlign: 'center', marginTop: 8 }}>{p.devErr || 'The phone is connecting...'}</div> : null}
      {err ? <div className="phx-note bad" style={{ marginTop: 10 }}>{err}</div> : null}
      <div className="phx-s" style={{ textAlign: 'center', marginTop: 12 }}>Calls go out from {(() => { const l = ((p.st && p.st.lines) || []).find(x => x.id === line); return l ? fmtNum(l.number) : 'the default line' })()}. The first call asks for microphone access.</div>
    </div>
  )
}

// ---------------------------------------------------------------- tab: contacts

function Contacts({ onCall, onText }) {
  const p = usePhone()
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState(null)
  const [err, setErr] = useState('')
  const [data] = useLoad(() => apiGet('/contacts?q=' + encodeURIComponent(q)), [p.ver.contacts, q])
  async function save() {
    setErr('')
    try { await apiPost('/contacts/save', edit); setEdit(null); bump('contacts') } catch (e) { setErr(e.message) }
  }
  async function del(number) { if (!window.confirm('Delete this contact?')) return; await apiPost('/contacts/delete', { number }).catch(() => {}); bump('contacts') }
  if (edit) {
    return (
      <div>
        <div className="phx-flex" style={{ marginBottom: 10 }}><button type="button" className="phx-btn i" onClick={() => setEdit(null)}>{I.back(14)}</button><b>{edit.isNew ? 'New contact' : 'Edit contact'}</b></div>
        <label className="phx-field"><span>Name</span><input className="phx-in" value={edit.name || ''} onChange={e => setEdit({ ...edit, name: e.target.value })} autoFocus /></label>
        <label className="phx-field"><span>Number</span><input className="phx-in phx-mono" value={edit.number || ''} disabled={!edit.isNew} onChange={e => setEdit({ ...edit, number: e.target.value })} /></label>
        <label className="phx-chk"><input type="checkbox" checked={!!edit.starred} onChange={e => setEdit({ ...edit, starred: e.target.checked })} /><span>Starred <span className="phx-s">(rings through Do not disturb)</span></span></label>
        <label className="phx-chk"><input type="checkbox" checked={!!edit.blocked} onChange={e => setEdit({ ...edit, blocked: e.target.checked })} /><span>Blocked <span className="phx-s">(calls rejected, texts hidden)</span></span></label>
        <label className="phx-field"><span>Note</span><input className="phx-in" value={edit.note || ''} onChange={e => setEdit({ ...edit, note: e.target.value })} /></label>
        {err ? <div className="phx-note bad">{err}</div> : null}
        <div className="phx-flex"><button type="button" className="phx-btn p" onClick={() => void save()}>Save</button>{!edit.isNew ? <button type="button" className="phx-btn d" onClick={() => { void del(edit.number); setEdit(null) }}>Delete</button> : null}</div>
      </div>
    )
  }
  const list = (data && data.contacts) || []
  return (
    <div>
      <div className="phx-flex" style={{ marginBottom: 8, flexWrap: 'nowrap' }}>
        <input className="phx-in" placeholder="Search contacts" value={q} onChange={e => setQ(e.target.value)} />
        <button type="button" className="phx-btn p" onClick={() => setEdit({ isNew: true, number: '', name: '' })}>Add</button>
      </div>
      {data && !list.length ? <div className="phx-empty">No contacts. Names you add here show up in messages, calls and voicemail.</div> : null}
      {list.map(c => (
        <div key={c.number} className="phx-row" style={{ cursor: 'default' }}>
          <span className="phx-av">{initials(c.number, c.name)}</span>
          <span style={{ flex: 1, minWidth: 0 }} onClick={() => setEdit(c)} role="button" tabIndex={0}>
            <div className="phx-name">{c.name || fmtNum(c.number)} {c.starred ? <span style={{ color: 'var(--warn)' }}>{I.star(11, true)}</span> : null}</div>
            <div className="phx-s phx-mono">{fmtNum(c.number)}{c.blocked ? ' · blocked' : ''}</div>
          </span>
          <button type="button" className="phx-btn i" title="Text" onClick={() => onText(c.number)}>{I.msg(13)}</button>
          <button type="button" className="phx-btn i" title="Call" onClick={() => onCall(c.number)}>{I.phone(13)}</button>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- setup (tab + Settings > Phone)

const VOICES = ['Polly.Joanna-Neural', 'Polly.Matthew-Neural', 'Polly.Amy-Neural', 'Polly.Brian-Neural', 'Polly.Bianca-Neural', 'Polly.Adriano-Neural', 'Google.el-GR-Standard-A', 'Google.it-IT-Standard-A', 'Google.en-GB-Standard-A', 'alice']

function Field({ label: l, hint, children }) {
  return <label className="phx-field"><span>{l}</span>{children}{hint ? <em>{hint}</em> : null}</label>
}
function Check({ checked, onChange, children }) {
  return <label className="phx-chk"><input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)} /><span>{children}</span></label>
}
function Secret({ value, onChange, placeholder }) {
  const set = value === '__set__'
  return <input className="phx-in phx-mono" type="password" autoComplete="new-password" placeholder={set ? 'saved (type to replace)' : (placeholder || '')} value={set ? '' : (value || '')} onChange={e => onChange(e.target.value || (set ? '__set__' : ''))} />
}

function Checklist() {
  const p = usePhone()
  const [check, setCheck] = useState(null)
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState(null)
  const [err, setErr] = useState('')
  async function runCheck() { setBusy('check'); setErr(''); try { setCheck((await apiGet('/provider/check')).check) } catch (e) { setErr(e.message) } finally { setBusy('') } }
  async function applyTwilio() {
    setBusy('apply'); setErr('')
    try { const r = await apiPost('/provider/apply', {}); setResult(r.result); await refreshState(); await runCheck(); if (S.dev !== 'ready') void restartDevice() } catch (e) { setErr(e.message) } finally { setBusy('') }
  }
  useEffect(() => { void runCheck() }, [p.ver.config])
  const row = (ok, name, detail) => (
    <div className="phx-check" key={name}><span className={'phx-dot ' + (ok === null ? '' : ok ? 'ok' : 'bad')} /><span style={{ flex: 1 }}>{name}</span><span className="phx-s" style={{ textAlign: 'right' }}>{detail}</span></div>
  )
  const st = p.st || {}
  return (
    <div className="phx-card">
      <div className="phx-flex" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <b>Status</b>
        <div className="phx-flex">
          <button type="button" className="phx-btn" disabled={!!busy} onClick={() => void runCheck()}>{busy === 'check' ? 'Checking...' : 'Check'}</button>
          <button type="button" className="phx-btn p" disabled={!!busy} onClick={() => void applyTwilio()} title="Create the API key and TwiML App if missing, and point every Twilio line's voice + SMS webhooks at the public base URL">{busy === 'apply' ? 'Applying...' : 'Apply to Twilio'}</button>
        </div>
      </div>
      {check ? <>
        {row(check.account && check.account.ok, 'Twilio account', check.account ? (check.account.name || check.account.error || '') + (check.balance ? ' · ' + Number(check.balance.amount).toFixed(2) + ' ' + check.balance.currency : '') : '')}
        {row(check.apiKey && check.apiKey.ok, 'API key (browser calls)', check.apiKey ? (check.apiKey.name || check.apiKey.error || 'missing') : '')}
        {row(check.app && check.app.ok, 'TwiML App (outgoing calls)', check.app ? (check.app.ok ? 'ok' : check.app.error || 'missing or stale') : '')}
        {(check.lines || []).map(l => row(l.ok, 'Line ' + l.id + ' ' + fmtNum(l.number), l.ok ? 'webhooks ok' : (l.error || 'webhooks not applied')))}
        {row(check.publicHook && check.publicHook.ok, 'Public webhook endpoint', check.publicHook ? (check.publicHook.ok ? st.publicBaseUrl : (check.publicHook.error || 'HTTP ' + check.publicHook.status)) : '')}
      </> : <div className="phx-s">{busy ? 'Checking...' : 'Not checked yet.'}</div>}
      {row(p.dev === 'ready', 'This browser', p.dev === 'ready' ? 'registered, calls can ring here' : (p.devErr || p.dev))}
      {row(p.notifPerm === 'granted', 'Notifications', p.notifPerm === 'granted' ? 'allowed' : <button type="button" className="phx-btn" onClick={() => void phone.enableNotifications()}>Allow</button>)}
      {err ? <div className="phx-note bad" style={{ marginTop: 8 }}>{err}</div> : null}
      {result ? <div className={'phx-note ' + (result.ok ? 'ok' : 'bad')} style={{ marginTop: 8 }}>{result.report.map(r => <div key={r.name}>{r.ok ? 'OK' : 'FAILED'} · {r.name}: {r.detail}</div>)}</div> : null}
      {p.dev !== 'ready' && st.ready ? <button type="button" className="phx-btn" style={{ marginTop: 8 }} onClick={() => void restartDevice()}>Reconnect this browser</button> : null}
    </div>
  )
}

function Setup({ embedded }) {
  usePhone()
  const [form, setForm] = useState(null)
  const [err, setErr] = useState('')
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false)
  const [numbers, setNumbers] = useState(null)
  useEffect(() => { apiGet('/settings').then(r => setForm(r.settings)).catch(e => setErr(e.message)) }, [])
  if (!form) return <div className="phx-body">{err ? <div className="phx-note bad">{err}</div> : 'Loading...'}</div>
  const set = (path, v) => {
    const next = structuredClone(form)
    const keys = path.split('.')
    let o = next
    for (const k of keys.slice(0, -1)) o = o[k]
    o[keys[keys.length - 1]] = v
    setForm(next); setSaved('')
  }
  const g = (path) => path.split('.').reduce((o, k) => (o ? o[k] : undefined), form)
  const T = (path) => ({ value: g(path) ?? '', onChange: e => set(path, e.target.value) })
  const N = (path) => ({ value: g(path) ?? '', type: 'number', onChange: e => set(path, Number(e.target.value)) })
  const lines = form.lines || []
  const setLine = (i, k, v) => { const ls = structuredClone(lines); ls[i][k] = v; set('lines', ls) }
  async function save() {
    setBusy(true); setErr(''); setSaved('')
    try { const r = await apiPost('/settings', { settings: form }); setForm(r.settings); setSaved('Saved. phone-hookd picked up the change.'); await refreshState(); bump('config') } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  async function loadNumbers() { try { setNumbers((await apiGet('/provider/numbers')).numbers) } catch (e) { setErr(e.message) } }
  return (
    <div className={embedded ? '' : 'phx-body'}>
      <Checklist />

      <div className="phx-h">General</div>
      <Check checked={form.enabled} onChange={v => set('enabled', v)}>Phone enabled</Check>
      <div className="phx-grid">
        <Field label="Default country" hint="For numbers typed without a prefix, e.g. +30"><input className="phx-in phx-mono" {...T('defaultCountry')} /></Field>
        <Field label="Browser identity" hint="Who the calls ring (a name, no spaces)"><input className="phx-in phx-mono" {...T('identity')} /></Field>
      </div>
      <Field label="Public webhook base URL" hint="The provider calls this. It must reach phone-hookd (edge route /phone-hook/, no login). Run Apply to Twilio after changing it."><input className="phx-in phx-mono" {...T('publicBaseUrl')} /></Field>

      <div className="phx-h">Lines</div>
      {lines.map((l, i) => (
        <div key={i} className="phx-card" style={{ padding: 9 }}>
          <div className="phx-linerow">
            <input className="phx-in phx-mono" title="Line id" placeholder="id" value={l.id} onChange={e => setLine(i, 'id', e.target.value)} />
            <input className="phx-in" title="Label" placeholder="Label" value={l.label} onChange={e => setLine(i, 'label', e.target.value)} />
            <input className="phx-in phx-mono" title="Number (E.164)" placeholder="+1..." value={l.number} onChange={e => setLine(i, 'number', e.target.value)} />
            <button type="button" className="phx-btn i d" title="Remove line" onClick={() => set('lines', lines.filter((_, j) => j !== i))}>&#x2715;</button>
          </div>
          <div className="phx-flex">
            <select className="phx-in" style={{ width: 'auto' }} value={l.provider} onChange={e => setLine(i, 'provider', e.target.value)}><option value="twilio">Twilio</option><option value="sip">SIP (coming next)</option></select>
            <input className="phx-in phx-mono" style={{ flex: 1, minWidth: 140 }} placeholder="Number SID (PN..., optional)" value={l.numberSid} onChange={e => setLine(i, 'numberSid', e.target.value)} />
            <Check checked={l.sms} onChange={v => setLine(i, 'sms', v)}>SMS</Check>
            <Check checked={l.voice} onChange={v => setLine(i, 'voice', v)}>Voice</Check>
            <Check checked={l.enabled} onChange={v => setLine(i, 'enabled', v)}>On</Check>
            <label className="phx-chk"><input type="radio" name="phx-defline" checked={form.defaultLine === l.id} onChange={() => set('defaultLine', l.id)} /><span>Default</span></label>
          </div>
        </div>
      ))}
      <div className="phx-flex" style={{ marginBottom: 6 }}>
        <button type="button" className="phx-btn" onClick={() => set('lines', [...lines, { id: 'line' + (lines.length + 1), label: '', provider: 'twilio', number: '', numberSid: '', sms: true, voice: true, enabled: true }])}>Add line</button>
        <button type="button" className="phx-btn" onClick={() => void loadNumbers()}>Numbers on the Twilio account</button>
      </div>
      {numbers ? numbers.map(n => (
        <div key={n.sid} className="phx-check">
          <span className="phx-mono" style={{ flex: 1 }}>{fmtNum(n.number)}</span>
          <span className="phx-s">{['voice', 'sms', 'mms'].filter(k => n.capabilities && n.capabilities[k]).join(' ')}</span>
          {lines.some(l => l.number === n.number) ? <span className="phx-s">added</span>
            : <button type="button" className="phx-btn" onClick={() => set('lines', [...lines, { id: 'line' + (lines.length + 1), label: n.name, provider: 'twilio', number: n.number, numberSid: n.sid, sms: !!n.capabilities.sms, voice: !!n.capabilities.voice, enabled: true }])}>Add</button>}
        </div>
      )) : null}

      <div className="phx-h">Twilio</div>
      <div className="phx-grid">
        <Field label="Account SID"><input className="phx-in phx-mono" placeholder="from credentials file" {...T('twilio.accountSid')} /></Field>
        <Field label="Auth token"><Secret value={form.twilio.authToken} onChange={v => set('twilio.authToken', v)} placeholder="from credentials file" /></Field>
        <Field label="API key SID"><input className="phx-in phx-mono" placeholder="created by Apply" {...T('twilio.apiKeySid')} /></Field>
        <Field label="API key secret"><Secret value={form.twilio.apiKeySecret} onChange={v => set('twilio.apiKeySecret', v)} placeholder="created by Apply" /></Field>
        <Field label="TwiML App SID"><input className="phx-in phx-mono" placeholder="created by Apply" {...T('twilio.twimlAppSid')} /></Field>
        <Field label="Edge" hint="Empty = roaming. e.g. dublin, frankfurt"><input className="phx-in phx-mono" {...T('twilio.edge')} /></Field>
      </div>
      <Field label="Credentials file" hint="KEY=value lines used for any empty field above: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_TWIML_APP_SID"><input className="phx-in phx-mono" {...T('twilio.credentialsFile')} /></Field>

      <div className="phx-h">Incoming calls</div>
      <div className="phx-grid">
        <Field label="Mode after a restart">
          <select className="phx-in" value={form.incoming.defaultMode} onChange={e => set('incoming.defaultMode', e.target.value)}><option value="live">Live</option><option value="voicemail">Voicemail</option><option value="dnd">Do not disturb</option></select>
        </Field>
        <Field label="Ring for (seconds)" hint="Then voicemail"><input className="phx-in" min={5} max={60} {...N('incoming.ringSeconds')} /></Field>
      </div>
      <Field label="Also ring this number in Live mode" hint="Optional mobile. It hears who is calling and must press 1, so its own voicemail cannot steal the call."><input className="phx-in phx-mono" placeholder="+30..." {...T('incoming.forwardTo')} /></Field>
      <Check checked={form.incoming.dndBypassStarred} onChange={v => set('incoming.dndBypassStarred', v)}>Starred contacts ring through Do not disturb</Check>
      <Check checked={form.incoming.rejectAnonymous} onChange={v => set('incoming.rejectAnonymous', v)}>Reject calls with a hidden number</Check>

      <div className="phx-h">Voicemail</div>
      <Check checked={form.voicemail.enabled} onChange={v => set('voicemail.enabled', v)}>Voicemail on (off: unanswered callers hear "not available")</Check>
      <Field label="Greeting (spoken)"><textarea className="phx-in" rows={3} {...T('voicemail.greeting')} /></Field>
      <div className="phx-grid">
        <Field label="Greeting voice"><input className="phx-in phx-mono" list="phx-voices" {...T('voicemail.greetingVoice')} /><datalist id="phx-voices">{VOICES.map(v => <option key={v} value={v} />)}</datalist></Field>
        <Field label="Greeting language"><input className="phx-in phx-mono" placeholder="en-US" {...T('voicemail.greetingLanguage')} /></Field>
      </div>
      <Field label="Greeting audio URL" hint="Optional public MP3/WAV; replaces the spoken greeting"><input className="phx-in phx-mono" {...T('voicemail.greetingAudioUrl')} /></Field>
      <div className="phx-grid">
        <Field label="Max message length (s)"><input className="phx-in" min={10} max={600} {...N('voicemail.maxSeconds')} /></Field>
        <Field label="Final transcript" hint="Local = your own Whisper endpoint, free, good Greek">
          <select className="phx-in" value={form.voicemail.transcriber} onChange={e => set('voicemail.transcriber', e.target.value)}><option value="local">Local Whisper</option><option value="mistral">Mistral Voxtral</option><option value="off">Off</option></select>
        </Field>
      </div>
      <Check checked={form.voicemail.liveTranscript} onChange={v => set('voicemail.liveTranscript', v)}>Live transcript while the caller speaks, with Pick up (Twilio real-time transcription, about 0.03 USD per minute)</Check>
      <div className="phx-grid">
        <Field label="Live transcript language" hint="en-US, it-IT; Greek: el-GR with model chirp_2"><input className="phx-in phx-mono" {...T('voicemail.liveLanguage')} /></Field>
        <Field label="Live engine / model" hint="Empty = provider default"><div className="phx-flex" style={{ flexWrap: 'nowrap' }}><input className="phx-in phx-mono" placeholder="google" {...T('voicemail.liveEngine')} /><input className="phx-in phx-mono" placeholder="telephony" {...T('voicemail.liveModel')} /></div></Field>
      </div>
      <Check checked={form.voicemail.deleteFromProvider} onChange={v => set('voicemail.deleteFromProvider', v)}>Delete recordings from Twilio once they are stored here</Check>

      <div className="phx-h">Messages</div>
      <Field label="Do-not-disturb auto reply" hint="Optional. Sent at most once per sender every 12 hours while DND is on."><input className="phx-in" {...T('sms.dndAutoReply')} /></Field>

      <div className="phx-h">Notifications</div>
      <Check checked={form.notifications.sound} onChange={v => set('notifications.sound', v)}>Ringtone and chimes</Check>
      <Check checked={form.notifications.browser} onChange={v => set('notifications.browser', v)}>Browser notifications when the page is in the background</Check>
      <Check checked={form.notifications.toasts} onChange={v => set('notifications.toasts', v)}>In-page toasts for new texts and voicemails</Check>

      <div className="phx-h">Agent tools</div>
      <Check checked={form.agent.allowSms} onChange={v => set('agent.allowSms', v)}>Agents may send SMS (always as a draft first, then confirm)</Check>
      <Check checked={form.agent.allowCalls} onChange={v => set('agent.allowCalls', v)}>Agents may place spoken alert calls (draft first, then confirm)</Check>
      <Check checked={form.agent.allowModeChange} onChange={v => set('agent.allowModeChange', v)}>Agents may switch Live / Voicemail / Do not disturb</Check>

      <div className="phx-h">SIP line <span className="phx-pill" style={{ color: 'var(--ink3)' }}>next</span></div>
      <div className="phx-note info">A second line from a SIP provider (for example Yuboto) through a relay on this server. The fields are stored now; the relay is not wired yet.</div>
      <Check checked={form.sip.enabled} onChange={v => set('sip.enabled', v)}>Enable SIP line</Check>
      <div className="phx-grid">
        <Field label="Label"><input className="phx-in" {...T('sip.label')} /></Field>
        <Field label="Number"><input className="phx-in phx-mono" {...T('sip.number')} /></Field>
        <Field label="Registrar / host"><input className="phx-in phx-mono" {...T('sip.registrar')} /></Field>
        <Field label="Username"><input className="phx-in phx-mono" {...T('sip.username')} /></Field>
        <Field label="Password"><Secret value={form.sip.password} onChange={v => set('sip.password', v)} /></Field>
        <Field label="WebSocket (WSS) URL"><input className="phx-in phx-mono" {...T('sip.wssUrl')} /></Field>
      </div>

      <div style={{ position: 'sticky', bottom: 0, padding: '10px 0', background: 'var(--bg)', borderTop: '1px solid var(--line)', marginTop: 10 }}>
        <div className="phx-flex">
          <button type="button" className="phx-btn p" disabled={busy} onClick={() => void save()}>{busy ? 'Saving...' : 'Save settings'}</button>
          {saved ? <span className="phx-s" style={{ color: 'var(--ok)' }}>{saved}</span> : null}
        </div>
        {err ? <div className="phx-note bad" style={{ marginTop: 8 }}>{err}</div> : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- tab root

function PhoneView({ visible }) {
  const p = usePhone()
  const [view, setView] = useState('messages')
  const [thread, setThread] = useState(null)
  const [compose, setCompose] = useState(false)
  const [preset, setPreset] = useState(null)
  useEffect(() => { injectCss() }, [])
  useEffect(() => { if (visible) void refreshState() }, [visible])
  useEffect(() => {
    if (S.openThread) { setThread(S.openThread); setView('messages'); S.openThread = null }
  }, [p.toasts.length, visible])

  const callTo = (peer, line) => { setPreset({ peer, line, at: Date.now() }); setView('keypad'); phone.dial(peer, line).catch(e => toast({ kind: 'err', title: 'Call failed', body: e.message })) }
  const textTo = (peer, line) => { setThread({ peer, line: line || (p.st && p.st.defaultLine) || '' }); setView('messages') }

  const st = p.st
  const tabs = [
    ['messages', 'Messages', I.msg(13), p.counts.sms, ''],
    ['calls', 'Calls', I.phone(13), p.counts.missed, 'bad'],
    ['voicemail', 'Voicemail', I.vm(13), p.counts.voicemail, ''],
    ['keypad', 'Keypad', I.pad(12), 0, ''],
    ['contacts', 'Contacts', I.user(13), 0, ''],
  ]
  const needsSetup = st && !st.ready
  let body
  if (view === 'setup') body = <Setup />
  else if (needsSetup && view !== 'setup') {
    body = (
      <div className="phx-body">
        <div className="phx-note warn"><b>Setup needed.</b><ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{st.issues.map(i => <li key={i}>{i}</li>)}</ul></div>
        <button type="button" className="phx-btn p" onClick={() => setView('setup')}>{I.gear(13)}Open setup</button>
      </div>
    )
  } else if (view === 'messages' && thread) body = <Thread peer={thread.peer} line={thread.line} onBack={() => setThread(null)} onCall={callTo} />
  else if (view === 'messages' && compose) body = <div className="phx-body"><NewMessage onBack={() => setCompose(false)} onSent={(peer, line) => { setCompose(false); setThread({ peer, line }) }} /></div>
  else if (view === 'messages') body = <div className="phx-body"><Threads onOpen={t => setThread({ peer: t.peer, line: t.line })} onNew={() => setCompose(true)} /></div>
  else if (view === 'calls') body = <div className="phx-body"><Calls onCall={callTo} onText={textTo} /></div>
  else if (view === 'voicemail') body = <div className="phx-body"><Voicemails onCall={callTo} onText={textTo} /></div>
  else if (view === 'keypad') body = <div className="phx-body"><Dialer preset={preset} /></div>
  else body = <div className="phx-body"><Contacts onCall={(n, l) => callTo(n, l)} onText={(n, l) => textTo(n, l)} /></div>

  const defLine = st && (st.lines || []).find(l => l.id === st.defaultLine)
  return (
    <div className="phx">
      <div className="phx-bar">
        <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
          <b className="phx-mono" style={{ fontSize: 12.5 }}>{defLine ? fmtNum(defLine.number) : 'Phone'}{st && (st.lines || []).length > 1 ? ' +' + ((st.lines || []).length - 1) : ''}</b>
          <StatusDot />
        </span>
        <button type="button" className="phx-btn i" aria-pressed={view === 'setup'} title="Setup" onClick={() => setView(view === 'setup' ? 'messages' : 'setup')}>{I.gear(15)}</button>
      </div>
      {p.stErr ? <div className="phx-note bad" style={{ margin: 10 }}>{p.stErr}</div> : null}
      <ModeSwitch />
      <CallStrip />
      {view !== 'setup' ? (
        <div className="phx-nav" role="tablist">
          {tabs.map(([id, l, icon, n, cls]) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => { setView(id); if (id === 'messages') { setThread(null); setCompose(false) } }}>
              {icon}{l}{n ? <span className={'phx-badge ' + cls}>{n}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{body}</div>
    </div>
  )
}

function SettingsSection() {
  useEffect(() => { injectCss() }, [])
  return <div className="phx" style={{ height: 'auto', overflow: 'visible' }}><Setup embedded /></div>
}

// ---------------------------------------------------------------- plugin contract

/** Start the per-page phone service. Returns a disposer (HMR re-applies the plugin). */
function boot() {
  if (typeof document === 'undefined') return () => {}
  injectCss()
  const host = document.createElement('div')
  host.className = 'phx-ov'
  host.setAttribute('aria-live', 'polite')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(<Overlay />)
  const wake = () => { if (actx && actx.state === 'suspended') actx.resume().catch(() => {}) }
  document.addEventListener('pointerdown', wake, { capture: true, passive: true })
  void refreshState().then((st) => { if (st && st.enabled) openEvents() })
  return () => {
    document.removeEventListener('pointerdown', wake, { capture: true })
    stopRing()
    try { if (es) es.close() } catch {}
    es = null
    try { if (device) device.destroy() } catch {}
    device = null
    if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null }
    try { root.unmount() } catch {}
    host.remove()
  }
}

const tabIcon = (size) => I.phone(size)

export const inject = ['betterSidebar', 'slots']

export function apply(ctx) {
  if (ctx.betterSidebar && typeof ctx.betterSidebar.registerTab === 'function') {
    S.sidebar = ctx.betterSidebar
    ctx.effect(() => ctx.betterSidebar.registerTab({
      id: TAB_ID,
      title: 'Phone',
      order: 92,
      single: true,
      icon: tabIcon,
      badge: () => { const n = (S.counts.sms || 0) + (S.counts.voicemail || 0) + (S.counts.missed || 0); return n > 0 ? n : null },
      component: (props) => <PhoneView visible={props.visible !== false} />,
    }), 'dsh-phone: register the Phone sidebar tab')
  } else {
    console.error('[dsh-phone] ctx.betterSidebar.registerTab is unavailable; Phone tab not registered')
  }
  if (ctx.slots && typeof ctx.slots.inject === 'function') {
    ctx.effect(() => {
      const d = ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-phone',
        order: 62,
        label: () => 'Phone',
        inject: () => ({}),
      }, function PhoneSettingsSlot() { return <SettingsSection /> }))
      return typeof d === 'function' ? d : () => {}
    }, 'dsh-phone: settings section')
  }
  ctx.effect(() => {
    try { return boot() } catch (e) { console.error('[dsh-phone] boot failed', e); return () => {} }
  }, 'dsh-phone: phone service (events, device, overlay)')
}
