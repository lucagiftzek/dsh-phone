/**
 * dsh-phone: persistent store (node:sqlite, WAL).
 *
 * One file, ~/.dsh/phone/phone.db, owned by phone-hookd only. Provider ids
 * (Twilio MessageSid / CallSid / RecordingSid) are the idempotency keys,
 * because providers retry webhooks.
 */

import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sid TEXT UNIQUE,
  line TEXT NOT NULL,
  peer TEXT NOT NULL,
  direction TEXT NOT NULL,          -- in | out
  body TEXT NOT NULL DEFAULT '',
  media TEXT NOT NULL DEFAULT '[]', -- JSON [{url,type}]
  status TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  segments INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT ''   -- ui | agent | auto | provider
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(line, peer, ts);
CREATE INDEX IF NOT EXISTS messages_unread ON messages(read, direction);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sid TEXT UNIQUE,
  line TEXT NOT NULL,
  peer TEXT NOT NULL,
  direction TEXT NOT NULL,          -- in | out
  status TEXT NOT NULL DEFAULT '',  -- provider call status
  disposition TEXT NOT NULL DEFAULT '', -- ringing | answered | missed | declined | voicemail | blocked | busy | failed | no-answer | picked_up
  mode TEXT NOT NULL DEFAULT '',    -- live | voicemail | dnd at arrival
  started INTEGER NOT NULL,
  ended INTEGER,
  duration INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS calls_started ON calls(started);

CREATE TABLE IF NOT EXISTS voicemails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_sid TEXT UNIQUE,
  line TEXT NOT NULL,
  peer TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'greeting', -- greeting | recording | processing | ready | empty | picked_up | failed
  recording_sid TEXT,
  file TEXT,
  duration INTEGER NOT NULL DEFAULT 0,
  live_text TEXT NOT NULL DEFAULT '',
  transcript TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  engine TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  picked_up INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS voicemails_ts ON voicemails(ts);

CREATE TABLE IF NOT EXISTS contacts (
  number TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  starred INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

const now = () => Math.floor(Date.now() / 1000)

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;')
    this.db.exec(SCHEMA)
  }

  close() { try { this.db.close() } catch {} }

  // -------------------------------------------------- kv
  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key)
    if (!row) return fallback
    try { return JSON.parse(row.value) } catch { return fallback }
  }
  set(key, value) {
    this.db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value))
  }

  // -------------------------------------------------- messages
  addMessage(m) {
    const ts = m.ts || now()
    const r = this.db.prepare(`INSERT INTO messages(sid,line,peer,direction,body,media,status,error,segments,ts,read,origin)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(sid) DO NOTHING`).run(
      m.sid || null, m.line, m.peer, m.direction, m.body || '', JSON.stringify(m.media || []), m.status || '',
      m.error || '', m.segments || 0, ts, m.read ? 1 : 0, m.origin || '')
    if (!r.changes) return null
    return this.message(Number(r.lastInsertRowid))
  }
  message(id) { return rowMessage(this.db.prepare('SELECT * FROM messages WHERE id=?').get(id)) }
  messageBySid(sid) { return rowMessage(this.db.prepare('SELECT * FROM messages WHERE sid=?').get(sid)) }
  setMessageSid(id, sid, status) { this.db.prepare('UPDATE messages SET sid=?, status=? WHERE id=?').run(sid, status || '', id) }
  setMessageStatus(sid, status, error = '') {
    const r = this.db.prepare('UPDATE messages SET status=?, error=CASE WHEN ?<>\'\' THEN ? ELSE error END WHERE sid=?').run(status, error, error, sid)
    return r.changes ? this.messageBySid(sid) : null
  }
  failMessage(id, error) { this.db.prepare("UPDATE messages SET status='failed', error=? WHERE id=?").run(String(error).slice(0, 300), id) }

  threads({ line = null, q = '', limit = 100 } = {}) {
    const args = []
    let where = '1=1'
    if (line) { where += ' AND m.line=?'; args.push(line) }
    if (q) { where += ' AND (m.peer LIKE ? OR m.body LIKE ? OR c.name LIKE ?)'; const like = '%' + q + '%'; args.push(like, like, like) }
    const rows = this.db.prepare(`
      SELECT m.line, m.peer, MAX(m.ts) AS ts,
        SUM(CASE WHEN m.direction='in' AND m.read=0 THEN 1 ELSE 0 END) AS unread,
        COUNT(*) AS count, c.name AS name, c.starred AS starred, c.blocked AS blocked
      FROM messages m LEFT JOIN contacts c ON c.number=m.peer
      WHERE ${where}
      GROUP BY m.line, m.peer ORDER BY ts DESC LIMIT ?`).all(...args, limit)
    const last = this.db.prepare('SELECT body, direction, status, media FROM messages WHERE line=? AND peer=? ORDER BY ts DESC, id DESC LIMIT 1')
    return rows.map(r => {
      const l = last.get(r.line, r.peer) || {}
      return {
        line: r.line, peer: r.peer, name: r.name || '', starred: !!r.starred, blocked: !!r.blocked,
        ts: r.ts, unread: Number(r.unread || 0), count: Number(r.count || 0),
        last: { body: l.body || '', direction: l.direction || '', status: l.status || '', hasMedia: (l.media || '[]') !== '[]' },
      }
    })
  }

  thread({ line, peer, limit = 200, before = null }) {
    const args = [line, peer]
    let extra = ''
    if (before) { extra = ' AND ts < ?'; args.push(before) }
    const rows = this.db.prepare(`SELECT * FROM messages WHERE line=? AND peer=?${extra} ORDER BY ts DESC, id DESC LIMIT ?`).all(...args, limit)
    return rows.reverse().map(rowMessage)
  }
  markThreadRead(line, peer) { return this.db.prepare("UPDATE messages SET read=1 WHERE line=? AND peer=? AND direction='in' AND read=0").run(line, peer).changes }
  deleteThread(line, peer) { return this.db.prepare('DELETE FROM messages WHERE line=? AND peer=?').run(line, peer).changes }
  recentOutbound(line, peer, sinceTs, origin) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE line=? AND peer=? AND direction=\'out\' AND origin=? AND ts>=?').get(line, peer, origin, sinceTs).n
  }

  // -------------------------------------------------- calls
  upsertCall(c) {
    const existing = this.db.prepare('SELECT * FROM calls WHERE sid=?').get(c.sid)
    if (existing) {
      const fields = []
      const args = []
      for (const k of ['status', 'disposition', 'ended', 'duration', 'peer', 'line']) {
        if (c[k] !== undefined && c[k] !== null && c[k] !== '') { fields.push(k + '=?'); args.push(c[k]) }
      }
      if (fields.length) this.db.prepare('UPDATE calls SET ' + fields.join(',') + ' WHERE sid=?').run(...args, c.sid)
      return this.callBySid(c.sid)
    }
    this.db.prepare(`INSERT INTO calls(sid,line,peer,direction,status,disposition,mode,started,ended,duration,seen,origin)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(c.sid, c.line || '', c.peer || '', c.direction || 'in', c.status || '',
      c.disposition || '', c.mode || '', c.started || now(), c.ended || null, c.duration || 0, c.seen ? 1 : 0, c.origin || '')
    return this.callBySid(c.sid)
  }
  callBySid(sid) { return rowCall(this.db.prepare('SELECT c.*, k.name AS name FROM calls c LEFT JOIN contacts k ON k.number=c.peer WHERE c.sid=?').get(sid)) }
  calls({ limit = 100 } = {}) {
    return this.db.prepare('SELECT c.*, k.name AS name FROM calls c LEFT JOIN contacts k ON k.number=c.peer ORDER BY started DESC LIMIT ?').all(limit).map(rowCall)
  }
  markCallsSeen() { return this.db.prepare('UPDATE calls SET seen=1 WHERE seen=0').run().changes }
  deleteCall(id) { return this.db.prepare('DELETE FROM calls WHERE id=?').run(id).changes }

  // -------------------------------------------------- voicemails
  addVoicemail(v) {
    this.db.prepare(`INSERT INTO voicemails(call_sid,line,peer,status,ts) VALUES(?,?,?,?,?)
      ON CONFLICT(call_sid) DO NOTHING`).run(v.callSid, v.line || '', v.peer || '', v.status || 'greeting', v.ts || now())
    return this.voicemailByCall(v.callSid)
  }
  voicemail(id) { return rowVm(this.db.prepare('SELECT v.*, k.name AS name FROM voicemails v LEFT JOIN contacts k ON k.number=v.peer WHERE v.id=?').get(id)) }
  voicemailByCall(callSid) { return rowVm(this.db.prepare('SELECT v.*, k.name AS name FROM voicemails v LEFT JOIN contacts k ON k.number=v.peer WHERE v.call_sid=?').get(callSid)) }
  updateVoicemail(id, patch) {
    const allowed = ['status', 'recording_sid', 'file', 'duration', 'live_text', 'transcript', 'language', 'engine', 'read', 'picked_up']
    const fields = []; const args = []
    for (const k of allowed) if (patch[k] !== undefined) { fields.push(k + '=?'); args.push(typeof patch[k] === 'boolean' ? (patch[k] ? 1 : 0) : patch[k]) }
    if (fields.length) this.db.prepare('UPDATE voicemails SET ' + fields.join(',') + ' WHERE id=?').run(...args, id)
    return this.voicemail(id)
  }
  voicemails({ limit = 100 } = {}) {
    return this.db.prepare('SELECT v.*, k.name AS name FROM voicemails v LEFT JOIN contacts k ON k.number=v.peer ORDER BY ts DESC LIMIT ?').all(limit).map(rowVm)
  }
  deleteVoicemail(id) { return this.db.prepare('DELETE FROM voicemails WHERE id=?').run(id).changes }

  // -------------------------------------------------- contacts
  contact(number) {
    const r = this.db.prepare('SELECT * FROM contacts WHERE number=?').get(number)
    return r ? { number: r.number, name: r.name, starred: !!r.starred, blocked: !!r.blocked, note: r.note } : null
  }
  contacts({ q = '' } = {}) {
    const like = '%' + q + '%'
    return this.db.prepare('SELECT * FROM contacts WHERE number LIKE ? OR name LIKE ? ORDER BY starred DESC, name COLLATE NOCASE LIMIT 500').all(like, like)
      .map(r => ({ number: r.number, name: r.name, starred: !!r.starred, blocked: !!r.blocked, note: r.note }))
  }
  saveContact(c) {
    const prev = this.contact(c.number) || { name: '', starred: false, blocked: false, note: '' }
    const next = {
      name: c.name !== undefined ? String(c.name).slice(0, 120) : prev.name,
      starred: c.starred !== undefined ? !!c.starred : prev.starred,
      blocked: c.blocked !== undefined ? !!c.blocked : prev.blocked,
      note: c.note !== undefined ? String(c.note).slice(0, 500) : prev.note,
    }
    this.db.prepare(`INSERT INTO contacts(number,name,starred,blocked,note,updated) VALUES(?,?,?,?,?,?)
      ON CONFLICT(number) DO UPDATE SET name=excluded.name, starred=excluded.starred, blocked=excluded.blocked, note=excluded.note, updated=excluded.updated`)
      .run(c.number, next.name, next.starred ? 1 : 0, next.blocked ? 1 : 0, next.note, now())
    return this.contact(c.number)
  }
  deleteContact(number) { return this.db.prepare('DELETE FROM contacts WHERE number=?').run(number).changes }

  // -------------------------------------------------- counters
  counts() {
    return {
      sms: this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction='in' AND read=0").get().n,
      voicemail: this.db.prepare("SELECT COUNT(*) AS n FROM voicemails WHERE read=0 AND status IN ('ready','processing','failed')").get().n,
      missed: this.db.prepare("SELECT COUNT(*) AS n FROM calls WHERE seen=0 AND direction='in' AND disposition IN ('missed','no-answer','declined','voicemail','blocked')").get().n,
    }
  }
}

function rowMessage(r) {
  if (!r) return null
  let media = []
  try { media = JSON.parse(r.media || '[]') } catch {}
  return { id: r.id, sid: r.sid, line: r.line, peer: r.peer, direction: r.direction, body: r.body, media, status: r.status, error: r.error, segments: r.segments, ts: r.ts, read: !!r.read, origin: r.origin }
}
function rowCall(r) {
  if (!r) return null
  return { id: r.id, sid: r.sid, line: r.line, peer: r.peer, name: r.name || '', direction: r.direction, status: r.status, disposition: r.disposition, mode: r.mode, started: r.started, ended: r.ended, duration: r.duration, seen: !!r.seen, origin: r.origin }
}
function rowVm(r) {
  if (!r) return null
  return { id: r.id, callSid: r.call_sid, line: r.line, peer: r.peer, name: r.name || '', status: r.status, recordingSid: r.recording_sid, hasAudio: !!r.file, duration: r.duration, liveText: r.live_text, transcript: r.transcript, language: r.language, engine: r.engine, ts: r.ts, read: !!r.read, pickedUp: !!r.picked_up }
}
