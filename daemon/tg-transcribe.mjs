/**
 * dsh-phone: automatic transcription of Telegram voice messages.
 *
 * Voice messages, video messages (round) and, when enabled, audio files are
 * sent to the same speech-to-text engine as the voicemails (settings
 * voicemail.transcriber, normally the local Whisper endpoint: no audio leaves
 * the server for a third party). The language is detected by the engine.
 *
 * One job at a time (a CPU Whisper is slow), results cached per media content
 * (sha256 of the audio), so a forwarded voice note is never transcribed twice.
 * Rows live in phone.db (tg_transcripts); hookd stays the only writer.
 * Settings: <telegram dir>/transcribe.json (0600), edited through /tg/transcribe/config.
 */

import fs from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tg_transcripts (
  chat INTEGER NOT NULL,
  id INTEGER NOT NULL,
  media_key TEXT NOT NULL DEFAULT '',  -- sha256 of the audio
  status TEXT NOT NULL,                -- queued | running | done | failed | skipped
  text TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 0,
  engine TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT '',     -- auto | ui | agent
  updated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat, id)
);
CREATE INDEX IF NOT EXISTS tg_transcripts_key ON tg_transcripts(media_key);
`

/** Silence below this peak level is not sent to the engine (Whisper invents text on silence). */
export const SILENCE_DB = -50

/** Peak level of an audio buffer in dB (ffmpeg volumedetect); null when ffmpeg is missing or fails. */
export function peakDb(data, { ffmpeg = process.env.DSH_PHONE_FFMPEG || 'ffmpeg', timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    let err = ''
    let p
    try { p = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-i', 'pipe:0', '-af', 'volumedetect', '-f', 'null', '-'], { stdio: ['pipe', 'ignore', 'pipe'] }) } catch { return resolve(null) }
    const timer = setTimeout(() => { try { p.kill('SIGKILL') } catch {} }, timeoutMs)
    p.stderr.on('data', (c) => { if (err.length < 65536) err += c })
    p.on('error', () => { clearTimeout(timer); resolve(null) })
    p.on('close', () => {
      clearTimeout(timer)
      const m = /max_volume:\s*(-?[0-9.]+|-inf) dB/.exec(err)
      resolve(m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : null)
    })
    p.stdin.on('error', () => {})
    p.stdin.end(data)
  })
}

export const TX_DEFAULTS = Object.freeze({ auto: true, maxSeconds: 600, kinds: ['voice', 'round'], audioFiles: false })
const KINDS = ['voice', 'round', 'audio', 'video']

export function txKinds(cfg) {
  const k = new Set((cfg.kinds || TX_DEFAULTS.kinds).filter(x => KINDS.includes(x)))
  if (cfg.audioFiles) k.add('audio')
  return k
}

/** True when a message carries media this feature can transcribe at all (manual button). */
export function transcribable(m) {
  return !!(m && m.media && KINDS.includes(m.media.kind) && !m.deleted)
}

export function cleanConfig(c, base = TX_DEFAULTS) {
  const out = { ...base }
  if (c && typeof c === 'object') {
    if (typeof c.auto === 'boolean') out.auto = c.auto
    if (c.maxSeconds !== undefined) { const n = Math.round(Number(c.maxSeconds)); if (Number.isFinite(n)) out.maxSeconds = Math.min(3600, Math.max(10, n)) }
    if (Array.isArray(c.kinds)) out.kinds = c.kinds.filter(x => KINDS.includes(x))
    if (typeof c.audioFiles === 'boolean') out.audioFiles = c.audioFiles
  }
  return out
}

/**
 * @param {object} d { db, dir, fetchMedia(chat,id) -> Promise<{data:Buffer,type:string}>, transcribe(audio) -> Promise<{text,language,engine}>, peak?(buf) -> Promise<dB|null>, broadcast, log, warn }
 */
export function createTranscriber(d) {
  const { db } = d
  db.exec(SCHEMA)
  const cfgPath = join(d.dir, 'transcribe.json')
  let cfg = cleanConfig(null)
  try { cfg = cleanConfig(JSON.parse(fs.readFileSync(cfgPath, 'utf8'))) } catch {}

  const get = db.prepare('SELECT * FROM tg_transcripts WHERE chat=? AND id=?')
  const put = db.prepare(`INSERT INTO tg_transcripts (chat, id, media_key, status, text, language, duration, engine, error, origin, updated)
    VALUES (@chat, @id, @media_key, @status, @text, @language, @duration, @engine, @error, @origin, @updated)
    ON CONFLICT(chat, id) DO UPDATE SET media_key=excluded.media_key, status=excluded.status, text=excluded.text, language=excluded.language,
    duration=excluded.duration, engine=excluded.engine, error=excluded.error, origin=excluded.origin, updated=excluded.updated`)
  const byKey = db.prepare("SELECT * FROM tg_transcripts WHERE media_key=? AND status='done' ORDER BY updated DESC LIMIT 1")

  const queue = []          // [{ chat, id, duration, origin }]
  let running = null
  let stopped = false

  function row(chat, id) { return get.get(Number(chat), Number(id)) }

  /** The public shape attached to a message (lossless, stable field names). */
  function view(r) {
    if (!r) return undefined
    const t = { status: r.status }
    if (r.text) t.text = r.text
    if (r.language) t.language = r.language
    if (r.duration) t.duration = r.duration
    if (r.engine) t.engine = r.engine
    if (r.error) t.error = r.error
    if (r.updated) t.updated = r.updated
    return t
  }

  function save(chat, id, fields) {
    const prev = row(chat, id) || {}
    const next = {
      chat: Number(chat), id: Number(id), media_key: fields.media_key ?? prev.media_key ?? '', status: fields.status,
      text: fields.text ?? '', language: fields.language ?? '', duration: Number(fields.duration ?? prev.duration ?? 0) || 0,
      engine: fields.engine ?? '', error: fields.error ?? '', origin: fields.origin ?? prev.origin ?? '', updated: Math.floor(Date.now() / 1000),
    }
    put.run(next)
    d.broadcast('tg.transcript', { chat: Number(chat), id: Number(id), transcript: view(next) })
    return next
  }

  function enqueue(m, origin = 'auto') {
    if (!transcribable(m)) return null
    const r = row(m.chat, m.id)
    if (r && (r.status === 'queued' || r.status === 'running')) return view(r)
    if (r && r.status === 'done' && origin === 'auto') return view(r)
    // A manual request on a finished transcript means "transcribe again": skip the cache.
    const job = { chat: Number(m.chat), id: Number(m.id), duration: Number(m.media.duration || 0), origin, force: !!(r && r.status === 'done' && origin !== 'auto') }
    queue.push(job)
    const saved = save(job.chat, job.id, { status: 'queued', duration: job.duration, origin })
    pump()
    return view(saved)
  }

  /** Called for every new message from the event stream. */
  function onMessage(m, isNew) {
    if (!isNew || !cfg.auto || !transcribable(m)) return
    if (!txKinds(cfg).has(m.media.kind)) return
    const dur = Number(m.media.duration || 0)
    if (dur > cfg.maxSeconds) { save(m.chat, m.id, { status: 'skipped', duration: dur, error: 'longer than ' + cfg.maxSeconds + ' s', origin: 'auto' }); return }
    enqueue(m, 'auto')
  }

  async function pump() {
    if (running || stopped) return
    const job = queue.shift()
    if (!job) return
    running = job
    save(job.chat, job.id, { status: 'running', duration: job.duration, origin: job.origin })
    try {
      const audio = await d.fetchMedia(job.chat, job.id)
      const key = createHash('sha256').update(audio.data).digest('hex')
      const hit = job.force ? null : byKey.get(key)
      if (hit) {
        save(job.chat, job.id, { status: 'done', media_key: key, text: hit.text, language: hit.language, duration: job.duration || hit.duration, engine: hit.engine, origin: job.origin })
      } else if (await (d.peak || peakDb)(audio.data).then(db => db !== null && db < SILENCE_DB, () => false)) {
        save(job.chat, job.id, { status: 'done', media_key: key, text: '', language: '', duration: job.duration, engine: 'silence', origin: job.origin })
      } else {
        const t = await d.transcribe(audio)
        if (t.engine === 'off') save(job.chat, job.id, { status: 'skipped', media_key: key, duration: job.duration, error: 'transcription is off (voicemail transcriber setting)', origin: job.origin })
        else save(job.chat, job.id, { status: 'done', media_key: key, text: t.text, language: t.language, duration: job.duration, engine: t.engine, origin: job.origin })
      }
    } catch (e) {
      const msg = (e && e.body && e.body.error) || String((e && e.message) || e)
      d.warn('telegram: transcription of ' + job.chat + '/' + job.id + ' failed: ' + msg)
      save(job.chat, job.id, { status: 'failed', duration: job.duration, error: msg.slice(0, 300), origin: job.origin })
    } finally {
      running = null
      if (!stopped) setImmediate(pump)
    }
  }

  /** After a restart: rows left queued or running go back into the queue. */
  function resume(lookup) {
    for (const r of db.prepare("SELECT chat, id, duration, origin FROM tg_transcripts WHERE status IN ('queued','running') ORDER BY updated").all()) {
      const m = lookup(r.chat, r.id)
      if (m && transcribable(m)) { queue.push({ chat: r.chat, id: r.id, duration: r.duration, origin: r.origin || 'auto' }) }
      else save(r.chat, r.id, { status: 'failed', error: 'message no longer available', origin: r.origin })
    }
    pump()
  }

  function config() { return { ...cfg, kinds: [...(cfg.kinds || [])] } }
  function setConfig(c) {
    cfg = cleanConfig(c, cfg)
    fs.writeFileSync(cfgPath + '.tmp', JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(cfgPath + '.tmp', cfgPath)
    d.broadcast('tg.transcribe.config', config())
    return config()
  }

  function status() { return { queued: queue.length, running: running ? { chat: running.chat, id: running.id } : null } }
  function stop() { stopped = true }

  return { onMessage, enqueue, view, row, resume, config, setConfig, status, stop, _queue: queue }
}
