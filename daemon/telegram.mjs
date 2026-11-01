/**
 * dsh-phone: Telegram bridge inside phone-hookd.
 *
 * telegramd (Go, telegramd/) holds the Telegram account and talks MTProto.
 * This module is its only client: it follows telegramd's NDJSON event stream,
 * keeps chats and messages in phone.db (tg_chats, tg_messages; hookd stays
 * the single writer of the database), relays events to the Phone tabs and
 * serves the /tg/* private routes the plugin proxies for the browser and the
 * agent tools. Nothing here talks to Telegram directly.
 */

import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import { join, basename } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createTranscriber, transcribable } from './tg-transcribe.mjs'

const CHANNEL_MARK = 1000000000000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tg_chats (
  id INTEGER PRIMARY KEY,           -- Bot API style marked id
  kind TEXT NOT NULL,               -- user | group | channel
  title TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  flags TEXT NOT NULL DEFAULT '{}', -- broadcast, megagroup, canPost, creator, bot, self, verified, left
  unread INTEGER NOT NULL DEFAULT 0,
  mentions INTEGER NOT NULL DEFAULT 0,
  read_in INTEGER NOT NULL DEFAULT 0,
  read_out INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  last_ts INTEGER NOT NULL DEFAULT 0,
  last_id INTEGER NOT NULL DEFAULT 0,
  last_text TEXT NOT NULL DEFAULT '',
  last_out INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tg_chats_order ON tg_chats(archived, pinned, last_ts);
CREATE TABLE IF NOT EXISTS tg_messages (
  chat INTEGER NOT NULL,
  id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  out INTEGER NOT NULL DEFAULT 0,
  sender INTEGER NOT NULL DEFAULT 0,
  sender_name TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  reply_to INTEGER NOT NULL DEFAULT 0,
  fwd TEXT NOT NULL DEFAULT '',
  edit INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  service TEXT NOT NULL DEFAULT '',
  grp INTEGER NOT NULL DEFAULT 0,
  media TEXT NOT NULL DEFAULT '',   -- JSON or ''
  links TEXT NOT NULL DEFAULT '',   -- JSON or ''
  deleted INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT '',  -- ui | agent | '' (Telegram)
  PRIMARY KEY (chat, id)
);
CREATE INDEX IF NOT EXISTS tg_messages_ts ON tg_messages(chat, ts);
`

const FLAG_KEYS = ['broadcast', 'megagroup', 'canPost', 'creator', 'bot', 'self', 'verified', 'scam', 'left', 'deleted']

export function previewOf(m) {
  if (!m) return ''
  if (m.service) return m.service
  const t = String(m.text || '').replace(/\s+/g, ' ').trim()
  if (m.media && m.media.kind && m.media.kind !== 'webpage') {
    const label = { photo: 'Photo', voice: 'Voice message', audio: 'Audio', video: 'Video', round: 'Video message', document: m.media.name || 'File', sticker: (m.media.emoji || '') + ' Sticker', gif: 'GIF', geo: 'Location', venue: 'Location', contact: 'Contact', poll: 'Poll', dice: m.media.emoji || 'Dice' }[m.media.kind] || 'Attachment'
    return t ? label + ': ' + t : label
  }
  return t
}

/** Telegram's own service account: it sends login codes. */
export const SERVICE_CHAT = 777000

/**
 * Login codes from the Telegram service chat never enter DSH (UI, agents,
 * reports): numbers of 5 to 8 digits and code-like tokens (letters and
 * digits mixed, 6 to 24 characters) are replaced. They stay in the app.
 */
export function maskCodes(text) {
  return String(text || '')
    .replace(/(?<![\w])\d(?:[ -]?\d){4,7}(?![\w])/g, '[code hidden]')
    .replace(/(?<![\w/.])(?=[A-Za-z0-9_-]{6,24}(?![\w]))(?=[A-Za-z_-]*\d)(?=[0-9_-]*[A-Za-z])[A-Za-z0-9_-]{6,24}(?![\w])/g, '[code hidden]')
}

export function kindOf(id) {
  id = Number(id)
  if (id > 0) return 'user'
  if (id < -CHANNEL_MARK) return 'channel'
  return 'group'
}

/**
 * @param {object} d  { store, broadcast(type,data), log, warn, dataDir, transcribe(audio), hub(), mode(), online(), ringSeconds() }
 */
export function createTelegram(d) {
  const dir = process.env.DSH_TELEGRAM_DIR || join(d.dataDir, 'telegram')
  const sock = process.env.DSH_TELEGRAM_SOCKET || join(dir, 'telegramd.sock')
  const spool = join(dir, 'spool')
  const db = d.store.db
  db.exec(SCHEMA)
  // Mask codes already stored from the service chat (rows written before masking existed).
  for (const r of db.prepare('SELECT id, text FROM tg_messages WHERE chat=?').all(SERVICE_CHAT)) {
    const t = maskCodes(r.text)
    if (t !== r.text) db.prepare('UPDATE tg_messages SET text=? WHERE chat=? AND id=?').run(t, SERVICE_CHAT, r.id)
  }
  const svc = db.prepare('SELECT last_text FROM tg_chats WHERE id=?').get(SERVICE_CHAT)
  if (svc && maskCodes(svc.last_text) !== svc.last_text) db.prepare('UPDATE tg_chats SET last_text=? WHERE id=?').run(maskCodes(svc.last_text), SERVICE_CHAT)

  // Voice message transcription (same engine as the voicemails; one job at a time).
  const tx = createTranscriber({
    db, dir, broadcast: d.broadcast, log: d.log, warn: d.warn,
    fetchMedia: (chatId, msgId) => mediaBuffer(chatId, msgId),
    transcribe: (audio) => (d.transcribe ? d.transcribe(audio) : Promise.reject(new Error('no transcription engine configured'))),
  })

  const st = {
    connected: false, lastSeq: 0, lastError: '', auth: null, syncing: false, lastSync: 0, stream: null, stopped: false, retry: 1000,
  }

  // ---------------------------------------------------------------- telegramd client

  function tgd(method, path, body, { timeoutMs = 60000 } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
      const req = http.request({ socketPath: sock, path, method, timeout: timeoutMs, headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {} }, (res) => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          let json
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { json = { ok: false, code: 'TELEGRAM_INTERNAL', error: 'telegramd answered something that is not JSON' } }
          if (res.statusCode >= 400 || json.ok === false) {
            const e = new Error(json.error || ('telegramd HTTP ' + res.statusCode))
            e.status = res.statusCode; e.body = { ok: false, code: json.code || 'TELEGRAM_INTERNAL', error: json.error || e.message, ...(json.retryAfter ? { retryAfter: json.retryAfter } : {}), ...(json.telegram ? { telegram: json.telegram } : {}) }
            reject(e)
          } else resolve(json)
        })
      })
      req.on('timeout', () => req.destroy(Object.assign(new Error('telegramd did not answer in time'), { status: 504, body: { ok: false, code: 'TELEGRAM_TIMEOUT', error: 'telegramd did not answer in time' } })))
      req.on('error', (e) => {
        if (e.body) return reject(e)
        const down = e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
        reject(Object.assign(new Error(e.message), { status: 503, body: { ok: false, code: 'TELEGRAM_DAEMON_UNAVAILABLE', error: down ? 'telegramd is not running (systemctl status dsh-telegramd)' : 'telegramd: ' + e.message } }))
      })
      if (payload) req.write(payload)
      req.end()
    })
  }

  // ---------------------------------------------------------------- database

  const upChat = db.prepare(`INSERT INTO tg_chats (id, kind, title, username, flags, updated) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, title=CASE WHEN excluded.title<>'' THEN excluded.title ELSE tg_chats.title END,
    username=excluded.username, flags=excluded.flags, updated=excluded.updated`)
  const upDialog = db.prepare(`UPDATE tg_chats SET unread=?, mentions=?, read_in=?, read_out=?, pinned=?, muted=?, archived=? WHERE id=?`)
  const upMsg = db.prepare(`INSERT INTO tg_messages (chat, id, ts, out, sender, sender_name, text, reply_to, fwd, edit, views, service, grp, media, links, origin)
    VALUES (@chat, @id, @ts, @out, @sender, @sender_name, @text, @reply_to, @fwd, @edit, @views, @service, @grp, @media, @links, @origin)
    ON CONFLICT(chat, id) DO UPDATE SET ts=excluded.ts, text=excluded.text, edit=excluded.edit, views=excluded.views, media=excluded.media, links=excluded.links,
    sender_name=CASE WHEN excluded.sender_name<>'' THEN excluded.sender_name ELSE tg_messages.sender_name END,
    origin=CASE WHEN tg_messages.origin<>'' THEN tg_messages.origin ELSE excluded.origin END, deleted=0`)
  const setLast = db.prepare(`UPDATE tg_chats SET last_ts=?, last_id=?, last_text=?, last_out=? WHERE id=? AND (last_id<=? OR last_ts<?)`)

  function saveChat(c) {
    if (!c || !c.id) return
    const flags = {}
    for (const k of FLAG_KEYS) if (c[k]) flags[k] = true
    upChat.run(Number(c.id), c.kind || kindOf(c.id), String(c.title || ''), String(c.username || ''), JSON.stringify(flags), Math.floor(Date.now() / 1000))
  }

  function saveMessage(m, origin = '') {
    if (!m || !m.chat || !m.id) return false
    if (Number(m.chat) === SERVICE_CHAT) m = { ...m, text: maskCodes(m.text) }
    upMsg.run({
      chat: Number(m.chat), id: Number(m.id), ts: Number(m.date || 0), out: m.out ? 1 : 0, sender: Number(m.from || 0), sender_name: String(m.fromName || ''),
      text: String(m.text || ''), reply_to: Number(m.replyTo || 0), fwd: String(m.fwd || ''), edit: Number(m.edit || 0), views: Number(m.views || 0),
      service: String(m.service || ''), grp: Number(m.group || 0), media: m.media ? JSON.stringify(m.media) : '', links: m.links && m.links.length ? JSON.stringify(m.links) : '', origin: origin || '',
    })
    setLast.run(Number(m.date || 0), Number(m.id), previewOf(m).slice(0, 200), m.out ? 1 : 0, Number(m.chat), Number(m.id), Number(m.date || 0))
    return true
  }

  function chatRow(r) {
    if (!r) return null
    let flags = {}
    try { flags = JSON.parse(r.flags || '{}') } catch {}
    return {
      id: r.id, kind: r.kind, title: r.title, username: r.username || undefined, ...flags,
      unread: r.unread, mentions: r.mentions || undefined, pinned: !!r.pinned, muted: !!r.muted, archived: !!r.archived,
      readIn: r.read_in, readOut: r.read_out,
      last: r.last_id ? { id: r.last_id, date: r.last_ts, text: r.last_text, out: !!r.last_out } : null,
    }
  }

  function msgRow(r) {
    if (!r) return null
    const m = { chat: r.chat, id: r.id, date: r.ts, out: !!r.out, text: r.text }
    if (r.sender) m.from = r.sender
    if (r.sender_name) m.fromName = r.sender_name
    if (r.reply_to) m.replyTo = r.reply_to
    if (r.fwd) m.fwd = r.fwd
    if (r.edit) m.edit = r.edit
    if (r.views) m.views = r.views
    if (r.service) m.service = r.service
    if (r.grp) m.group = r.grp
    if (r.media) { try { m.media = JSON.parse(r.media) } catch {} }
    if (r.links) { try { m.links = JSON.parse(r.links) } catch {} }
    if (r.deleted) m.deleted = true
    if (r.origin) m.origin = r.origin
    if (m.media && transcribable(m)) { const t = tx.view(tx.row(r.chat, r.id)); if (t) m.transcript = t }
    return m
  }

  function chat(id) { return chatRow(db.prepare('SELECT * FROM tg_chats WHERE id=?').get(Number(id))) }

  function chats({ q = '', limit = 200, archived = false, kind = '' } = {}) {
    const where = ['archived=?']
    const args = [archived ? 1 : 0]
    if (q) { where.push("(title LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\')"); const like = '%' + String(q).replace(/[\\%_]/g, m => '\\' + m) + '%'; args.push(like, like) }
    if (kind) { where.push('kind=?'); args.push(kind) }
    const rows = db.prepare('SELECT * FROM tg_chats WHERE ' + where.join(' AND ') + ' AND (last_id>0 OR pinned=1 OR unread>0) ORDER BY pinned DESC, last_ts DESC LIMIT ?').all(...args, Math.min(500, Math.max(1, limit)))
    return rows.map(chatRow)
  }

  function messages(chatId, { before = 0, limit = 50 } = {}) {
    const rows = before
      ? db.prepare('SELECT * FROM tg_messages WHERE chat=? AND id<? ORDER BY id DESC LIMIT ?').all(Number(chatId), Number(before), limit)
      : db.prepare('SELECT * FROM tg_messages WHERE chat=? ORDER BY id DESC LIMIT ?').all(Number(chatId), limit)
    return rows.reverse().map(msgRow)
  }

  function counts() {
    const r = db.prepare('SELECT COALESCE(SUM(CASE WHEN muted=0 THEN unread ELSE 0 END),0) AS unread, COUNT(*) AS chats FROM tg_chats WHERE archived=0').get()
    return { unread: Number(r.unread), chats: Number(r.chats) }
  }

  // ---------------------------------------------------------------- sync

  async function syncDialogs(reason) {
    if (st.syncing) return
    st.syncing = true
    try {
      for (const archived of [false, true]) {
        const r = await tgd('GET', '/dialogs?limit=' + (archived ? 100 : 300) + (archived ? '&archived=1' : ''), undefined, { timeoutMs: 120000 })
        db.exec('BEGIN')
        try {
          for (const dl of r.dialogs || []) {
            saveChat(dl.chat)
            upDialog.run(dl.unread || 0, dl.mentions || 0, dl.readIn || 0, dl.readOut || 0, dl.pinned ? 1 : 0, dl.muted ? 1 : 0, archived ? 1 : 0, Number(dl.chat.id))
            if (dl.top) saveMessage(dl.top)
          }
          db.exec('COMMIT')
        } catch (e) { db.exec('ROLLBACK'); throw e }
      }
      st.lastSync = Date.now()
      d.log('telegram: dialogs synced (' + reason + '), ' + counts().chats + ' chats')
      d.broadcast('tg.chats', { reason, counts: counts() })
    } catch (e) {
      d.warn('telegram: dialog sync failed:', (e.body && e.body.code) || e.message)
    } finally { st.syncing = false }
  }

  async function fetchHistory(chatId, before, limit) {
    const r = await tgd('GET', '/history?chat=' + Number(chatId) + '&before=' + Number(before || 0) + '&limit=' + limit)
    if (r.chat) saveChat(r.chat)
    db.exec('BEGIN')
    try { for (const m of r.messages || []) saveMessage(m); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e }
    return (r.messages || []).length
  }

  // ---------------------------------------------------------------- events from telegramd

  function onEvent(ev) {
    if (!ev || !ev.type) return
    if (ev.seq) st.lastSeq = ev.seq
    const data = ev.data || {}
    switch (ev.type) {
      case 'hello': {
        st.auth = data.auth || null
        if ((data.gap || !st.lastSync) && st.auth && st.auth.state === 'ready') void syncDialogs(data.gap ? 'event gap' : 'start')
        d.broadcast('tg.auth', st.auth || {})
        break
      }
      case 'ping': break
      case 'message': case 'message.edit': {
        if (data.chat) saveChat(data.chat)
        const m = data.message
        if (!m) break
        const known = db.prepare('SELECT 1 FROM tg_messages WHERE chat=? AND id=?').get(Number(m.chat), Number(m.id))
        saveMessage(m, data.origin || '')
        if (ev.type === 'message' && !known && !m.out && !m.service) db.prepare('UPDATE tg_chats SET unread=unread+1 WHERE id=?').run(Number(m.chat))
        const saved = msgRow(db.prepare('SELECT * FROM tg_messages WHERE chat=? AND id=?').get(Number(m.chat), Number(m.id)))
        d.broadcast(ev.type === 'message' ? 'tg.message' : 'tg.edit', { message: saved, chat: chat(m.chat), isNew: !known, counts: counts() })
        if (ev.type === 'message') tx.onMessage(saved, !known)
        break
      }
      case 'message.delete': {
        const ids = (data.ids || []).map(Number).filter(Boolean)
        if (!ids.length) break
        const marks = ids.map(() => '?').join(',')
        if (data.chat) db.prepare('UPDATE tg_messages SET deleted=1 WHERE chat=? AND id IN (' + marks + ')').run(Number(data.chat), ...ids)
        else db.prepare('UPDATE tg_messages SET deleted=1 WHERE chat>? AND id IN (' + marks + ')').run(-CHANNEL_MARK, ...ids)
        d.broadcast('tg.delete', { chat: data.chat || 0, ids })
        break
      }
      case 'read': {
        const id = Number(data.chat)
        if (data.box === 'in') db.prepare('UPDATE tg_chats SET read_in=MAX(read_in, ?), unread=? WHERE id=?').run(Number(data.maxId || 0), Number(data.unread || 0), id)
        else db.prepare('UPDATE tg_chats SET read_out=MAX(read_out, ?) WHERE id=?').run(Number(data.maxId || 0), id)
        d.broadcast('tg.read', { chat: id, box: data.box, maxId: data.maxId, counts: counts() })
        break
      }
      case 'auth': {
        const was = st.auth && st.auth.state
        st.auth = data
        d.broadcast('tg.auth', data)
        if (data.state === 'ready' && was !== 'ready') void syncDialogs('login')
        break
      }
      case 'resync': void syncDialogs(data.why || 'resync'); break
      case 'flood': case 'safety': case 'config':
        d.broadcast('tg.' + ev.type, data)
        if (ev.type === 'safety') d.warn('telegram: agent sending paused:', data.why)
        break
      case 'call.incoming':
        d.broadcast('tg.call.incoming', data)
        void onCallIncoming(data).catch(e => d.warn('telegram: incoming call handling failed:', e.message))
        break
      case 'call.state': {
        const hub = d.hub && d.hub()
        if (hub) hub.tgState(data.callId, data.state, { emojis: data.emojis })
        d.broadcast('tg.call.state', data)
        break
      }
      case 'call.ended': {
        const hub = d.hub && d.hub()
        const sid = 'tg-' + data.callId
        const had = hub && hub.byCall.has(sid)
        if (hub) hub.tgEnded(data.callId, data.reason)
        if (!had && d.store.callBySid && d.store.callBySid(sid)) {
          // Not on the call screen (declined by mode, ignored, or answered on another device).
          const row = d.store.callBySid(sid)
          const disp = row.disposition === 'declined' ? 'declined' : data.duration ? 'answered' : (row.disposition === 'ringing' ? 'missed' : row.disposition)
          d.store.upsertCall({ sid, status: 'completed', disposition: disp, ended: Math.floor(Date.now() / 1000), duration: data.duration || 0 })
          d.broadcast('call.ended', { call: { ...d.store.callBySid(sid), name: data.title || '' } })
        }
        d.broadcast('tg.call.ended', data)
        break
      }
      default:
        d.broadcast('tg.event', { type: ev.type, data })
    }
  }

  function connect() {
    if (st.stopped) return
    const req = http.request({ socketPath: sock, path: '/events?since=' + st.lastSeq, method: 'GET' }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return retry('HTTP ' + res.statusCode) }
      st.connected = true; st.lastError = ''; st.retry = 1000
      d.broadcast('tg.daemon', { connected: true })
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buf += chunk
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1)
          if (!line.trim()) continue
          let ev
          try { ev = JSON.parse(line) } catch { continue }
          try { onEvent(ev) } catch (e) { d.warn('telegram: event ' + ev.type + ' failed:', e.message) }
        }
        if (buf.length > 4 << 20) buf = ''
      })
      res.on('end', () => retry('stream ended'))
      res.on('error', (e) => retry(e.message))
    })
    req.on('error', (e) => retry(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'telegramd not running' : e.message))
    req.end()
    st.stream = req
  }

  let retryTimer = null
  function retry(why) {
    if (st.connected) d.broadcast('tg.daemon', { connected: false })
    st.connected = false
    st.lastError = why
    if (st.stopped || retryTimer) return
    retryTimer = setTimeout(() => { retryTimer = null; connect() }, st.retry)
    retryTimer.unref && retryTimer.unref()
    st.retry = Math.min(st.retry * 2, 30000)
  }

  // ---------------------------------------------------------------- media in (uploads)

  function spoolName(name) {
    const safe = basename(String(name || 'file')).replace(/[^\w.\- ]+/g, '_').slice(-80) || 'file'
    return join(spool, randomBytes(8).toString('hex') + '-' + safe)
  }

  /** Streams a request body into the spool (size-capped). */
  function receiveUpload(req, maxBytes, name) {
    fs.mkdirSync(spool, { recursive: true, mode: 0o700 })
    const path = spoolName(name)
    const tooLarge = () => Object.assign(new Error('file too large'), { status: 413, body: { ok: false, code: 'TELEGRAM_MEDIA_TOO_LARGE', error: 'the file is larger than the upload limit (' + (maxBytes >> 20) + ' MB)' } })
    if (Number(req.headers['content-length'] || 0) > maxBytes) { req.resume(); return Promise.reject(tooLarge()) }
    return new Promise((resolve, reject) => {
      let size = 0
      let failed = false
      const out = fs.createWriteStream(path, { mode: 0o600 })
      const abort = (e) => { if (failed) return; failed = true; try { out.destroy() } catch {} fs.rm(path, { force: true }, () => {}); reject(e) }
      req.on('data', (c) => {
        size += c.length
        // Keep draining (so the 413 reaches the client) but stop writing.
        if (size > maxBytes && !failed) { req.unpipe(out); req.resume(); abort(tooLarge()) }
      })
      req.on('error', abort)
      req.pipe(out)
      out.on('finish', () => resolve({ path, size }))
      out.on('error', abort)
    })
  }

  /** Copies a local file (agent tool) into the spool. */
  async function spoolCopy(file, maxBytes) {
    const p = String(file || '')
    let stt
    try { stt = fs.statSync(p) } catch { throw Object.assign(new Error('no such file'), { status: 400, body: { ok: false, code: 'TELEGRAM_BAD_REQUEST', error: 'file not found: ' + p } }) }
    if (!stt.isFile()) throw Object.assign(new Error('not a file'), { status: 400, body: { ok: false, code: 'TELEGRAM_BAD_REQUEST', error: 'not a regular file: ' + p } })
    if (stt.size > maxBytes) throw Object.assign(new Error('too large'), { status: 413, body: { ok: false, code: 'TELEGRAM_MEDIA_TOO_LARGE', error: 'the file is ' + (stt.size >> 20) + ' MB, the limit is ' + (maxBytes >> 20) + ' MB' } })
    fs.mkdirSync(spool, { recursive: true, mode: 0o700 })
    const dest = spoolName(basename(p))
    await fs.promises.copyFile(p, dest)
    await fs.promises.chmod(dest, 0o600)
    return { path: dest, size: stt.size, name: basename(p) }
  }

  async function uploadLimit() {
    try { const c = await tgd('GET', '/config'); return (c.config && c.config.media && c.config.media.uploadMB ? c.config.media.uploadMB : 50) << 20 } catch { return 50 << 20 }
  }

  function afterSend(r, origin) {
    const m = r.message
    if (m && m.id) {
      const known = db.prepare('SELECT 1 FROM tg_messages WHERE chat=? AND id=?').get(Number(m.chat), Number(m.id))
      saveMessage(m, origin)
      const saved = msgRow(db.prepare('SELECT * FROM tg_messages WHERE chat=? AND id=?').get(Number(m.chat), Number(m.id)))
      d.broadcast('tg.message', { message: saved, chat: chat(m.chat), isNew: true, counts: counts() })
      tx.onMessage(saved, !known)
    }
    return { ok: true, message: m, chat: m ? chat(m.chat) : null }
  }

  /** Downloads one message's media from telegramd into memory (transcription; capped). */
  function mediaBuffer(chatId, msgId, maxBytes = 64 << 20) {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: sock, path: '/media?chat=' + Number(chatId) + '&msg=' + Number(msgId) + '&force=1', method: 'GET', timeout: 300000 }, (res) => {
        const chunks = []; let size = 0
        res.on('data', (c) => { size += c.length; if (size > maxBytes) { req.destroy(new Error('media larger than ' + (maxBytes >> 20) + ' MB')) } else chunks.push(c) })
        res.on('end', () => {
          const data = Buffer.concat(chunks)
          if (res.statusCode >= 400) { let e = 'media download failed (HTTP ' + res.statusCode + ')'; try { e = JSON.parse(data.toString('utf8')).error || e } catch {} return reject(new Error(e)) }
          resolve({ data, type: String(res.headers['content-type'] || 'application/octet-stream') })
        })
        res.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new Error('telegramd did not deliver the media in time')))
      req.on('error', reject)
      req.end()
    })
  }

  function msgOf(chatId, msgId) { return msgRow(db.prepare('SELECT * FROM tg_messages WHERE chat=? AND id=?').get(Number(chatId), Number(msgId))) }

  // ---------------------------------------------------------------- calls

  /** What the audio hub needs from telegramd. */
  const callApi = {
    place: async (chatId, origin) => (await tgd('POST', '/call/place', { chat: Number(chatId), origin: origin === 'ui' ? 'ui' : 'agent' }, { timeoutMs: 30000 })).call,
    answer: (callId) => tgd('POST', '/call/answer', { callId: String(callId) }, { timeoutMs: 30000 }),
    hangup: (callId, busy = false) => tgd('POST', '/call/hangup', { callId: String(callId), busy: !!busy }),
    audioSocket: () => net.createConnection(join(dir, 'calls.sock')),
  }

  const autoTexted = new Map() // chat -> last auto text (ms)
  const AUTO_TEXT_EVERY = 12 * 3600 * 1000

  /**
   * An incoming Telegram call: ring the tabs, decline or ignore, by Phone mode
   * and the Telegram settings (calls.dnd, calls.voicemail, calls.liveNoTab).
   */
  async function onCallIncoming(c) {
    const sid = 'tg-' + c.callId
    const mode = d.mode ? d.mode() : 'live'
    if (d.store.upsertCall) d.store.upsertCall({ sid, line: 'tg', peer: String(c.chat), direction: 'in', status: 'ringing', disposition: 'ringing', mode, origin: '' })
    let cfg = {}
    try { cfg = ((await tgd('GET', '/config')).config || {}).calls || {} } catch {}
    let action
    if (c.supported === false) action = 'ignore'
    else if (mode === 'dnd') action = cfg.dnd || 'decline'
    else if (mode === 'voicemail') action = cfg.voicemail || 'decline_text'
    else action = d.online && d.online() ? 'ring' : (cfg.liveNoTab || 'ignore')
    const hub = d.hub && d.hub()
    if (action === 'ring' && hub) {
      const s = hub.ringTelegram({ callId: c.callId, audioKey: c.audioKey, chat: c.chat, title: c.title, ringSeconds: d.ringSeconds ? d.ringSeconds() : 25 })
      if (s) {
        d.broadcast('call.incoming', { call: { ...d.store.callBySid(sid), name: c.title || '' }, ringing: true, silent: false, route: 'server', telegram: true })
        d.log('telegram: call from ' + c.chat + ' rings the Phone tab')
        return action
      }
      action = 'ignore'
    }
    if (action === 'decline' || action === 'decline_text') {
      try { await callApi.hangup(c.callId, true) } catch (e) { d.warn('telegram: decline failed:', (e.body && e.body.code) || e.message) }
      d.store.upsertCall({ sid, disposition: 'declined' })
      if (action === 'decline_text' && cfg.voicemailText) {
        const last = autoTexted.get(Number(c.chat)) || 0
        if (Date.now() - last > AUTO_TEXT_EVERY) {
          autoTexted.set(Number(c.chat), Date.now())
          try {
            // the owner's own configured reply, at most once per caller every 12 hours: sent as his (ui), stored as auto.
            const r = await tgd('POST', '/send', { chat: Number(c.chat), text: String(cfg.voicemailText), origin: 'ui', silent: false })
            afterSend(r, 'auto')
          } catch (e) { d.warn('telegram: auto text after a declined call failed:', (e.body && e.body.code) || e.message) }
        }
      }
    }
    d.log('telegram: call from ' + c.chat + ' in mode ' + mode + ': ' + action)
    d.broadcast('call.update', { call: { ...d.store.callBySid(sid), name: c.title || '' } })
    return action
  }

  function tgSessionFor(callId) {
    const hub = d.hub && d.hub()
    if (!hub) return null
    const all = hub.tgSessions()
    return (callId ? all.find(s => s.tgCallId === callId) : all[0]) || null
  }
  const callView = (s) => s ? { callId: s.tgCallId || '', callSid: s.callSid, chat: Number(s.peer) || 0, title: s.peerName || '', direction: s.kind === 'out' ? 'out' : 'in', state: s.state } : null

  // ---------------------------------------------------------------- routes

  const origin = (b) => (b && b.origin === 'ui' ? 'ui' : 'agent')
  const num = (v, def = 0) => { const n = Number(v); return Number.isFinite(n) ? n : def }

  const ROUTES = {
    'GET /tg/status': async () => {
      let daemon = null
      try { daemon = await tgd('GET', '/status', undefined, { timeoutMs: 5000 }) } catch (e) { return { ok: true, daemon: false, error: e.body ? e.body.error : e.message, stream: { connected: st.connected, lastError: st.lastError }, counts: counts() } }
      return { ...daemon, ok: true, daemon: true, stream: { connected: st.connected, lastSeq: st.lastSeq, lastSync: st.lastSync ? new Date(st.lastSync).toISOString() : null }, counts: counts(), transcription: { ...tx.config(), ...tx.status() } }
    },
    'GET /tg/chats': async (b, q) => {
      if (q.refresh === '1') await syncDialogs('refresh')
      return { ok: true, chats: chats({ q: q.q || '', limit: num(q.limit, 200), archived: q.archived === '1', kind: q.kind || '' }), counts: counts() }
    },
    'GET /tg/chat': async (b, q) => {
      const c = chat(q.chat)
      if (!c) throw Object.assign(new Error('unknown chat'), { status: 404, body: { ok: false, code: 'TELEGRAM_CHAT_NOT_FOUND', error: 'chat ' + q.chat + ' is not in the local list; refresh chats first' } })
      return { ok: true, chat: c }
    },
    'GET /tg/messages': async (b, q) => {
      const id = num(q.chat)
      const limit = Math.min(100, Math.max(1, num(q.limit, 50)))
      const before = num(q.before)
      let fetched = 0; let warning
      if (q.local !== '1') {
        try { fetched = await fetchHistory(id, before, limit) } catch (e) { warning = e.body ? e.body.error : e.message }
      }
      return { ok: true, chat: chat(id), messages: messages(id, { before, limit }), fetched, ...(warning ? { warning } : {}) }
    },
    'POST /tg/send': async (b) => afterSend(await tgd('POST', '/send', { chat: num(b.chat), text: String(b.text || ''), replyTo: num(b.replyTo), silent: !!b.silent, origin: origin(b), session: String(b.session || '').slice(0, 80), channelPost: !!b.channelPost }, { timeoutMs: 130000 }), origin(b)),
    'POST /tg/send_media': async (b) => {
      const f = await spoolCopy(b.file, await uploadLimit())
      try {
        return afterSend(await tgd('POST', '/send_media', { chat: num(b.chat), path: f.path, kind: String(b.kind || ''), name: String(b.name || f.name), mime: String(b.mime || ''), text: String(b.caption || b.text || ''), replyTo: num(b.replyTo), origin: origin(b), session: String(b.session || '').slice(0, 80), channelPost: !!b.channelPost, duration: num(b.duration) }, { timeoutMs: 16 * 60000 }), origin(b))
      } finally { fs.rm(f.path, { force: true }, () => {}) }
    },
    'POST /tg/read': async (b) => {
      const r = await tgd('POST', '/read', { chat: num(b.chat), maxId: num(b.maxId), origin: origin(b) })
      if (r.marked && origin(b) === 'ui') { db.prepare('UPDATE tg_chats SET unread=0, mentions=0, read_in=MAX(read_in, ?) WHERE id=?').run(num(b.maxId), num(b.chat)); d.broadcast('tg.read', { chat: num(b.chat), box: 'in', maxId: num(b.maxId), counts: counts() }) }
      return { ok: true, marked: !!r.marked, counts: counts() }
    },
    'POST /tg/resolve': async (b) => {
      const r = await tgd('POST', '/resolve', { username: String(b.username || ''), origin: origin(b) })
      if (r.chat) saveChat(r.chat)
      return { ok: true, chat: chat(r.chat.id) || r.chat, dialog: !!r.dialog }
    },
    'GET /tg/config': async () => tgd('GET', '/config'),
    'POST /tg/config': async (b) => { const { origin: _o, ...rest } = b || {}; return tgd('POST', '/config', rest) },
    'POST /tg/creds': async (b) => tgd('POST', '/creds', { apiId: b.apiId, apiHash: String(b.apiHash || '') }),
    'POST /tg/login/qr': async () => tgd('POST', '/login/qr', {}),
    'POST /tg/login/phone': async (b) => tgd('POST', '/login/phone', { phone: String(b.phone || '') }),
    'POST /tg/login/code': async (b) => tgd('POST', '/login/code', { code: String(b.code || '') }),
    'POST /tg/login/password': async (b) => tgd('POST', '/login/password', { password: String(b.password || '') }),
    'POST /tg/login/cancel': async () => tgd('POST', '/login/cancel', {}),
    'POST /tg/logout': async () => { const r = await tgd('POST', '/logout', {}); return r },
    'POST /tg/agent/untrip': async () => tgd('POST', '/agent/untrip', {}),
    'POST /tg/media/clear': async () => tgd('POST', '/media/clear', {}),
    'GET /tg/audit': async (b, q) => tgd('GET', '/audit?n=' + Math.min(500, Math.max(1, num(q.n, 50)))),
    'POST /tg/sync': async () => { await syncDialogs('manual'); return { ok: true, counts: counts(), lastSync: st.lastSync } },
    'POST /tg/transcribe': async (b) => {
      const m = msgOf(b.chat, b.msg || b.id)
      if (!m) throw Object.assign(new Error('unknown message'), { status: 404, body: { ok: false, code: 'TELEGRAM_MESSAGE_NOT_FOUND', error: 'message ' + (b.msg || b.id) + ' of chat ' + b.chat + ' is not stored here; read the chat first' } })
      if (!transcribable(m)) throw Object.assign(new Error('not audio'), { status: 400, body: { ok: false, code: 'TELEGRAM_BAD_REQUEST', error: 'this message has no voice, video message or audio to transcribe' } })
      return { ok: true, chat: m.chat, msg: m.id, transcript: tx.enqueue(m, origin(b)) }
    },
    'GET /tg/transcribe/config': async () => ({ ok: true, config: tx.config(), ...tx.status() }),
    'POST /tg/transcribe/config': async (b) => { const { origin: _o, ...rest } = b || {}; return { ok: true, config: tx.setConfig(rest.config || rest) } },
    // Agent tool: the call runs on the owner's Phone tab (the owner talks); the tab does the dialing and answering.
    'POST /tg/call/place': async (b) => {
      const c = chat(b.chat)
      if (!c || c.kind !== 'user') throw Object.assign(new Error('not a person'), { status: 400, body: { ok: false, code: 'TELEGRAM_BAD_REQUEST', error: 'only people can be called' } })
      if (!(d.online && d.online())) throw Object.assign(new Error('no tab'), { status: 409, body: { ok: false, code: 'TELEGRAM_NO_TAB', error: 'no Phone tab is open: Telegram calls run in the owner\'s Phone tab (server audio route)' } })
      if (tgSessionFor('')) throw Object.assign(new Error('busy'), { status: 409, body: { ok: false, code: 'TELEGRAM_CALL_BUSY', error: 'a Telegram call is already in progress' } })
      d.broadcast('tg.call.dial', { chat: c.id, title: c.title, origin: origin(b) })
      return { ok: true, state: 'dialing', note: 'the Phone tab places the call', call: { chat: c.id, title: c.title, state: 'dialing' } }
    },
    'POST /tg/call/answer': async (b) => {
      const s = tgSessionFor(String(b.callId || ''))
      if (!s || s.kind !== 'in' || s.answered) throw Object.assign(new Error('none'), { status: 404, body: { ok: false, code: 'TELEGRAM_CALL_NOT_FOUND', error: 'no Telegram call is ringing in the Phone tab' } })
      d.broadcast('tg.call.answer', { callSid: s.callSid })
      return { ok: true, state: 'answering', note: 'the Phone tab answers', call: callView(s) }
    },
    'POST /tg/call/hangup': async (b) => {
      const s = tgSessionFor(String(b.callId || ''))
      const hub = d.hub && d.hub()
      if (s && hub) { if (s.kind === 'in' && !s.answered) s.outcome = 'declined'; hub.end(s, 'agent-hangup'); return { ok: true, state: 'ended', call: callView(s) } }
      if (b.callId) { await callApi.hangup(String(b.callId)); return { ok: true, state: 'ended' } }
      throw Object.assign(new Error('none'), { status: 404, body: { ok: false, code: 'TELEGRAM_CALL_NOT_FOUND', error: 'no Telegram call in progress' } })
    },
    'GET /tg/call/status': async () => {
      let daemon = {}
      try { daemon = await tgd('GET', '/call/status', undefined, { timeoutMs: 5000 }) } catch (e) { daemon = { available: false, reason: e.body ? e.body.error : e.message } }
      const hub = d.hub && d.hub()
      const sessions = hub ? hub.tgSessions().map(callView) : []
      return { ok: true, available: !!daemon.available, engine: daemon.engine || '', ...(daemon.reason ? { reason: daemon.reason } : {}), call: sessions[0] || (daemon.calls && daemon.calls[0]) || null, calls: daemon.calls || [], sessions }
    },
  }

  /** Handles /tg/* on the private socket; returns false for other paths. */
  async function handle(req, res, path, url, { readBody, sendJson }) {
    if (!path.startsWith('/tg/')) return false
    try {
      if (req.method === 'GET' && (path === '/tg/media' || path === '/tg/login/qr.png')) {
        const q = url.searchParams
        const p = path === '/tg/login/qr.png' ? '/login/qr.png' : '/media?chat=' + num(q.get('chat')) + '&msg=' + num(q.get('msg')) + (q.get('thumb') === '1' ? '&thumb=1' : '') + (q.get('force') === '1' ? '&force=1' : '')
        const up = http.request({ socketPath: sock, path: p, method: 'GET', headers: req.headers.range ? { range: req.headers.range } : {} }, (u) => {
          const pass = { 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'" }
          for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'x-file-name']) if (u.headers[h] !== undefined) pass[h] = u.headers[h]
          if (u.statusCode >= 400) pass['cache-control'] = 'no-store'
          if (path === '/tg/login/qr.png') pass['cache-control'] = 'no-store'
          res.writeHead(u.statusCode || 502, pass)
          u.pipe(res)
        })
        up.on('error', (e) => { try { if (!res.headersSent) sendJson(res, 503, { ok: false, code: 'TELEGRAM_DAEMON_UNAVAILABLE', error: 'telegramd unavailable: ' + e.message }); else res.end() } catch {} })
        req.on('close', () => up.destroy())
        up.end()
        return true
      }
      if (req.method === 'POST' && path === '/tg/upload') {
        // Raw body from the Phone tab (origin ui): ?chat=&kind=&name=&mime=&caption=&replyTo=&duration=
        const q = url.searchParams
        const f = await receiveUpload(req, await uploadLimit(), q.get('name') || 'file')
        try {
          const r = await tgd('POST', '/send_media', { chat: num(q.get('chat')), path: f.path, kind: q.get('kind') || '', name: q.get('name') || 'file', mime: q.get('mime') || '', text: q.get('caption') || '', replyTo: num(q.get('replyTo')), duration: num(q.get('duration')), origin: 'ui' }, { timeoutMs: 16 * 60000 })
          sendJson(res, 200, afterSend(r, 'ui'))
        } finally { fs.rm(f.path, { force: true }, () => {}) }
        return true
      }
      const fn = ROUTES[req.method + ' ' + path]
      if (!fn) { sendJson(res, 404, { ok: false, code: 'TELEGRAM_NOT_FOUND', error: 'no such Telegram route: ' + req.method + ' ' + path }); return true }
      let body = {}
      if (req.method !== 'GET') {
        const buf = await readBody(req, 256 * 1024)
        try { body = buf.length ? JSON.parse(buf.toString('utf8')) : {} } catch { sendJson(res, 400, { ok: false, code: 'TELEGRAM_BAD_REQUEST', error: 'bad JSON body' }); return true }
      }
      const out = await fn(body, Object.fromEntries(url.searchParams))
      sendJson(res, 200, out)
    } catch (e) {
      const body = e.body || { ok: false, code: 'TELEGRAM_INTERNAL', error: String(e && e.message || e) }
      if (body.code === 'TELEGRAM_INTERNAL') d.warn('telegram: ' + req.method + ' ' + path + ' ' + body.error)
      try { sendJson(res, e.status && e.status >= 400 && e.status < 600 ? e.status : 500, body) } catch {}
    }
    return true
  }

  function summary() {
    return { stream: st.connected, auth: st.auth ? st.auth.state : null, me: st.auth && st.auth.me ? { id: st.auth.me.id, title: st.auth.me.title, username: st.auth.me.username } : null, counts: counts() }
  }

  function start() { connect(); tx.resume(msgOf) }
  function shutdown() { st.stopped = true; tx.stop(); try { st.stream && st.stream.destroy() } catch {} if (retryTimer) clearTimeout(retryTimer) }

  return { start, shutdown, handle, summary, counts, chats, chat, messages, syncDialogs, onEvent, tgd, tx, callApi, onCallIncoming, _st: st }
}
