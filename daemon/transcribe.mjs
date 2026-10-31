/**
 * dsh-phone: voicemail transcription.
 *
 * Engines (settings voicemail.transcriber):
 *   local    any ElevenLabs-compatible /v1/speech-to-text endpoint you host
 *            (for example faster-whisper behind a small FastAPI server): free,
 *            language auto-detected, good on Greek with whisper medium. Default.
 *            URL from voicemail.localUrl or TTS_BASE_URL, key from TTS_API_KEY.
 *   mistral  Voxtral via api.mistral.ai /v1/audio/transcriptions (English is
 *            excellent, Greek is poor; pick it only for English-only lines).
 *   off      keep the recording, no transcript.
 *
 * Credentials come from env-style files (KEY=value), never from the repo.
 */

import { readFileSync } from 'node:fs'

export function readEnvFile(path) {
  const out = {}
  if (!path) return out
  try {
    const text = readFileSync(path.replace(/^~(?=\/)/, process.env.HOME || ''), 'utf8')
    for (const line of text.split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
      if (!m) continue
      let v = m[2].trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      out[m[1]] = v
    }
  } catch {}
  return out
}

function multipart(fields, file) {
  const boundary = '----dshphone' + Math.random().toString(16).slice(2)
  const parts = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + v + '\r\n'))
  }
  parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + file.name + '"\r\nContent-Type: ' + file.type + '\r\n\r\n'))
  parts.push(file.data)
  parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'))
  return { body: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + boundary }
}

async function sttLocal(cfg, audio) {
  const env = readEnvFile(cfg.localCredentialsFile)
  const base = (cfg.localUrl || env.TTS_BASE_URL || 'http://127.0.0.1:8771').replace(/\/+$/, '')
  const key = env.TTS_API_KEY || process.env.TTS_API_KEY || ''
  const fields = {}
  const mp = multipart(fields, { name: 'voicemail.mp3', type: audio.type || 'audio/mpeg', data: audio.data })
  const path = cfg.localModel ? '/v1/speech-to-text?model=' + encodeURIComponent(cfg.localModel) : '/v1/speech-to-text'
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': mp.contentType, ...(key ? { 'xi-api-key': key } : {}) },
    body: mp.body,
    signal: AbortSignal.timeout(300000),
  })
  const text = await r.text()
  if (!r.ok) throw new Error('local stt ' + r.status + ': ' + text.slice(0, 200))
  const j = JSON.parse(text)
  return { text: String(j.text || '').trim(), language: j.language_code || '', engine: 'local:' + (j.model_id && j.model_id !== 'scribe_v1' ? j.model_id : (cfg.localModel || 'whisper')) }
}

async function sttMistral(cfg, audio) {
  const env = readEnvFile(cfg.mistralCredentialsFile)
  const key = env.MISTRAL_API_KEY || process.env.MISTRAL_API_KEY || ''
  if (!key) throw new Error('no MISTRAL_API_KEY')
  const fields = { model: cfg.mistralModel || 'voxtral-mini-latest' }
  const mp = multipart(fields, { name: 'voicemail.mp3', type: audio.type || 'audio/mpeg', data: audio.data })
  const r = await fetch('https://api.mistral.ai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': mp.contentType },
    body: mp.body,
    signal: AbortSignal.timeout(120000),
  })
  const text = await r.text()
  if (!r.ok) throw new Error('mistral stt ' + r.status + ': ' + text.slice(0, 200))
  const j = JSON.parse(text)
  return { text: String(j.text || '').trim(), language: j.language || '', engine: 'mistral:' + fields.model }
}

/** Returns { text, language, engine } or throws. */
export async function transcribe(cfg, audio) {
  const engine = (cfg && cfg.transcriber) || 'local'
  if (engine === 'off') return { text: '', language: '', engine: 'off' }
  if (engine === 'mistral') return sttMistral(cfg, audio)
  return sttLocal(cfg, audio)
}
