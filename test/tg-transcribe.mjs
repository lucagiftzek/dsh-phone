/**
 * Telegram voice message transcription: node test/tg-transcribe.mjs
 *
 * Real phone-hookd on a temp data dir, a FAKE telegramd (unix socket) that
 * serves three synthetic voice notes (test/fixtures/voice-{en,it,el}.ogg) and a
 * FAKE ElevenLabs-shaped speech-to-text server (the voicemail engine "local").
 * Checks: auto transcription of new voice notes, one job at a time, cache per
 * media content, transcript + language in /tg/messages, events to the tabs,
 * duration limit, auto off, manual retry after a failure, settings file.
 *
 * Live mode (optional): DSH_PHONE_LIVE_STT=<base url> plus DSH_PHONE_LIVE_STT_ENV=<KEY=value file
 * with TTS_API_KEY> sends the same fixtures to a real Whisper endpoint and checks the detected
 * language and a few words of each. Nothing here talks to Telegram.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { cleanConfig, txKinds, transcribable } from '../daemon/tg-transcribe.mjs'
import { transcribe, readEnvFile } from '../daemon/transcribe.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
let passed = 0
const t = async (name, fn) => { try { await fn(); passed++; console.log('ok  ', name) } catch (e) { console.error('FAIL', name, '\n', e); process.exitCode = 1 } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(50) } return false }

const FIX = { en: readFileSync(join(HERE, 'fixtures', 'voice-en.ogg')), it: readFileSync(join(HERE, 'fixtures', 'voice-it.ogg')), el: readFileSync(join(HERE, 'fixtures', 'voice-el.ogg')) }
const EXPECT = {
  en: { language: 'en', words: ['voice message', 'athens'] },
  it: { language: 'it', words: ['messaggio vocale', 'roma'] },
  el: { language: 'el', words: ['μήνυμα', 'αθήνα'] },
}
const sha = (b) => createHash('sha256').update(b).digest('hex')
const LANG_OF = Object.fromEntries(Object.entries(FIX).map(([k, v]) => [sha(v), k]))

await t('config: defaults, clamping, kinds', () => {
  const d = cleanConfig(null)
  assert.equal(d.auto, true); assert.equal(d.maxSeconds, 600); assert.deepEqual([...txKinds(d)].sort(), ['round', 'voice'])
  const c = cleanConfig({ auto: false, maxSeconds: 99999, kinds: ['voice', 'bogus'], audioFiles: true })
  assert.equal(c.auto, false); assert.equal(c.maxSeconds, 3600); assert.deepEqual([...txKinds(c)].sort(), ['audio', 'voice'])
  assert.equal(cleanConfig({ maxSeconds: 1 }).maxSeconds, 10)
  assert.equal(transcribable({ media: { kind: 'voice' } }), true)
  assert.equal(transcribable({ media: { kind: 'photo' } }), false)
  assert.equal(transcribable({ media: { kind: 'voice' }, deleted: true }), false)
})

// ---------------------------------------------------------------- live Whisper (optional)

if (process.env.DSH_PHONE_LIVE_STT) {
  const env = readEnvFile(process.env.DSH_PHONE_LIVE_STT_ENV || '')
  const cfg = { transcriber: 'local', localUrl: process.env.DSH_PHONE_LIVE_STT, localCredentialsFile: process.env.DSH_PHONE_LIVE_STT_ENV || '' }
  for (const lang of ['en', 'it', 'el']) {
    await t('live Whisper: ' + lang + ' fixture, language detected, text recognised', async () => {
      const r = await transcribe(cfg, { type: 'audio/ogg', data: FIX[lang] })
      assert.equal(r.language, EXPECT[lang].language, 'language: ' + r.language + ' text: ' + r.text)
      const low = r.text.toLowerCase()
      assert.ok(EXPECT[lang].words.some(w => low.includes(w)), 'text: ' + r.text)
      assert.match(r.engine, /^local:/)
    })
  }
  void env
}

// ---------------------------------------------------------------- fake speech-to-text

const stt = { calls: 0, active: 0, maxActive: 0, fail: 0, delayMs: 150 }
const sttServer = http.createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', async () => {
    stt.calls++; stt.active++; stt.maxActive = Math.max(stt.maxActive, stt.active)
    await sleep(stt.delayMs)
    stt.active--
    if (stt.fail > 0) { stt.fail--; res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"engine down"}'); return }
    const body = Buffer.concat(chunks)
    let lang = ''
    for (const l of Object.values(LANG_OF)) if (body.indexOf(FIX[l]) >= 0) lang = l
    const text = { en: 'Hello, this is a voice message test. The weather in Athens is sunny today.', it: 'Ciao, questo è un messaggio vocale di prova. Oggi a Roma fa bel tempo.', el: 'Γεια σας, αυτό είναι ένα δοκιμαστικό φωνητικό μήνυμα. Σήμερα στην Αθήνα έχει ήλιο.' }[lang] || ''
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ text, language_code: lang || 'en', model_id: 'scribe_v1' }))
  })
})
await new Promise(r => sttServer.listen(0, '127.0.0.1', r))
const sttUrl = 'http://127.0.0.1:' + sttServer.address().port

// ---------------------------------------------------------------- fake telegramd

const dir = mkdtempSync(join(process.env.TMPDIR || '/var/tmp', 'dshp-tgtx-'))
const tgDir = join(dir, 'telegram')
mkdirSync(join(tgDir, 'spool'), { recursive: true, mode: 0o700 })
const sockPath = join(tgDir, 'telegramd.sock')
const fake = { streams: new Set(), seq: 0, media: {}, mediaCalls: 0 }
const auth = { state: 'ready', connected: true, me: { id: 99, kind: 'user', title: 'Example Account', username: 'example_account', self: true } }
const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
function push(type, data) { const line = JSON.stringify({ seq: ++fake.seq, type, at: Date.now(), data }) + '\n'; for (const s of fake.streams) s.write(line) }
const fakeServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write(JSON.stringify({ type: 'hello', data: { auth, gap: false, seq: fake.seq } }) + '\n')
    fake.streams.add(res); req.on('close', () => fake.streams.delete(res)); return
  }
  if (u.pathname === '/status') return json(res, 200, { ok: true, version: 'fake', credentials: true, auth })
  if (u.pathname === '/dialogs') return json(res, 200, { ok: true, dialogs: u.searchParams.get('archived') === '1' ? [] : [{ chat: { id: 42, kind: 'user', title: 'Alice' }, unread: 0 }] })
  if (u.pathname === '/history') return json(res, 200, { ok: true, messages: [] })
  if (u.pathname === '/media') {
    fake.mediaCalls++
    const b = fake.media[u.searchParams.get('chat') + '/' + u.searchParams.get('msg')]
    if (!b) return json(res, 404, { ok: false, code: 'TELEGRAM_MEDIA_UNAVAILABLE', error: 'no media' })
    res.writeHead(200, { 'content-type': 'audio/ogg', 'content-length': b.length }); res.end(b); return
  }
  json(res, 404, { ok: false, code: 'TELEGRAM_NOT_FOUND', error: 'fake: ' + u.pathname })
})
await new Promise(r => fakeServer.listen(sockPath, r))

writeFileSync(join(dir, 'hookd-config.json'), JSON.stringify({ publicBaseUrl: 'https://hooks.example.test/phone-hook', lines: [], relay: { enabled: false }, voicemail: { transcriber: 'local', localUrl: sttUrl, localCredentialsFile: '' } }), { mode: 0o600 })
const free = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const child = spawn(process.execPath, [join(HERE, '..', 'daemon', 'hookd.mjs')], {
  env: { ...process.env, HOME: dir, DSH_PHONE_DATA: dir, DSH_PHONE_HOOK_PORT: String(await free()), DSH_PHONE_AUDIOSOCKET_PORT: String(await free()), DSH_PHONE_ASTERISK_DIR: join(dir, 'ast'), NODE_NO_WARNINGS: '1', TTS_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let childOut = ''
child.stdout.on('data', d => { childOut += d }); child.stderr.on('data', d => { childOut += d })
for (let i = 0; i < 80 && !existsSync(join(dir, 'hookd.sock')); i++) await sleep(100)

function priv(path, method = 'GET', body) {
  return new Promise((res, rej) => {
    const req = http.request({ socketPath: join(dir, 'hookd.sock'), path, method, headers: body ? { 'content-type': 'application/json' } : {} }, (r) => {
      const c = []; r.on('data', x => c.push(x)); r.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); let j; try { j = JSON.parse(raw) } catch { j = raw } res({ status: r.statusCode, body: j }) })
    })
    req.on('error', rej)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}
const sse = []
const sseReq = http.request({ socketPath: join(dir, 'hookd.sock'), path: '/events' }, (r) => { r.setEncoding('utf8'); r.on('data', d => sse.push(d)) })
sseReq.on('error', () => {}); sseReq.end()
await sleep(400)

const voice = (id, lang, extra = {}) => { fake.media['42/' + id] = FIX[lang]; return { chat: 42, id, date: 1700000000 + id, out: false, from: 42, fromName: 'Alice', text: '', media: { kind: 'voice', mime: 'audio/ogg', size: FIX[lang].length, duration: 6, file: true, ...extra } } }
const txOf = async (id) => { const r = await priv('/tg/messages?chat=42&local=1&limit=100'); const m = r.body.messages.find(x => x.id === id); return m && m.transcript }

await t('hookd connects to the fake telegramd', async () => {
  assert.ok(await until(() => fake.streams.size === 1), 'stream: ' + childOut)
})

await t('three new voice notes (en, it, el): transcribed in the background, one at a time, language stored', async () => {
  push('message', { chat: { id: 42, kind: 'user', title: 'Alice' }, message: voice(101, 'en') })
  push('message', { chat: { id: 42, kind: 'user', title: 'Alice' }, message: voice(102, 'it') })
  push('message', { chat: { id: 42, kind: 'user', title: 'Alice' }, message: voice(103, 'el') })
  assert.ok(await until(async () => { const x = await txOf(103); return x && x.status === 'done' }, 8000), 'done')
  for (const [id, lang] of [[101, 'en'], [102, 'it'], [103, 'el']]) {
    const x = await txOf(id)
    assert.equal(x.status, 'done'); assert.equal(x.language, lang); assert.equal(x.duration, 6); assert.match(x.engine, /^local:/)
    assert.ok(x.text.toLowerCase().includes(EXPECT[lang].words[1]), x.text)
  }
  assert.equal(stt.maxActive, 1, 'concurrency 1')
  assert.equal(stt.calls, 3)
  const ev = sse.join('')
  assert.ok(ev.includes('event: tg.transcript\n'), 'tabs told')
  assert.ok(/"status":"running"/.test(ev) && /"status":"queued"/.test(ev), 'queued and running states broadcast')
})

await t('cache per media content: the same audio again (a forward) is not sent to the engine', async () => {
  const before = stt.calls
  push('message', { chat: { id: 42, kind: 'user', title: 'Alice' }, message: voice(104, 'en') })
  assert.ok(await until(async () => { const x = await txOf(104); return x && x.status === 'done' }), 'done')
  assert.equal(stt.calls, before, 'no new engine call')
  assert.equal((await txOf(104)).language, 'en')
})

await t('longer than the limit: skipped, not sent; a manual request still transcribes it', async () => {
  const before = stt.calls
  push('message', { chat: { id: 42, kind: 'user', title: 'Alice' }, message: voice(105, 'it', { duration: 900 }) })
  assert.ok(await until(async () => { const x = await txOf(105); return x && x.status === 'skipped' }), 'skipped')
  assert.match((await txOf(105)).error, /longer than 600 s/)
  const r = await priv('/tg/transcribe', 'POST', { chat: 42, msg: 105, origin: 'ui' })
  assert.equal(r.status, 200); assert.equal(r.body.transcript.status, 'queued')
  assert.ok(await until(async () => { const x = await txOf(105); return x && x.status === 'done' }), 'done after manual')
  assert.equal(stt.calls, before, 'the it audio was already cached')
})

await t('engine failure: status failed with the error; retry works', async () => {
  stt.fail = 1
  push('message', { chat: { id: 42, kind: 'user', title: 'Alice' }, message: voice(106, 'en', { duration: 7 }) })
  fake.media['42/106'] = Buffer.concat([FIX.en, Buffer.from('x')])  // new content, so not cached
  assert.ok(await until(async () => { const x = await txOf(106); return x && x.status === 'failed' }), 'failed')
  assert.match((await txOf(106)).error, /engine down|500/)
  await priv('/tg/transcribe', 'POST', { chat: 42, msg: 106, origin: 'ui' })
  assert.ok(await until(async () => { const x = await txOf(106); return x && x.status === 'done' }), 'done on retry')
})

await t('settings: auto off stops new jobs; file written 0600; status shows the queue', async () => {
  const s = await priv('/tg/transcribe/config', 'POST', { config: { auto: false, maxSeconds: 120 }, origin: 'ui' })
  assert.equal(s.status, 200); assert.equal(s.body.config.auto, false); assert.equal(s.body.config.maxSeconds, 120)
  const file = join(tgDir, 'transcribe.json')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).auto, false)
  push('message', { chat: { id: 42, kind: 'user', title: 'Alice' }, message: voice(107, 'el') })
  await sleep(400)
  assert.equal(await txOf(107), undefined, 'no transcript row while auto is off')
  const st = await priv('/tg/status')
  assert.equal(st.body.transcription.auto, false); assert.equal(st.body.transcription.queued, 0)
  await priv('/tg/transcribe/config', 'POST', { config: { auto: true, maxSeconds: 600 } })
})

await t('silence is not sent to the engine (Whisper would invent words): done, empty text, engine silence', async () => {
  let sil
  try { sil = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '2', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1']) } catch { console.log('     (ffmpeg missing: skipped)'); return }
  const before = stt.calls
  fake.media['42/109'] = sil
  push('message', { chat: { id: 42, kind: 'user', title: 'Alice' }, message: { chat: 42, id: 109, date: 1700000300, out: false, text: '', media: { kind: 'voice', mime: 'audio/ogg', size: sil.length, duration: 2, file: true } } })
  assert.ok(await until(async () => { const x = await txOf(109); return x && x.status === 'done' }), 'done')
  const x = await txOf(109)
  assert.equal(x.engine, 'silence'); assert.equal(x.text, undefined)
  assert.equal(stt.calls, before)
})

await t('errors: unknown message and non-audio are coded', async () => {
  const nf = await priv('/tg/transcribe', 'POST', { chat: 42, msg: 999 })
  assert.equal(nf.status, 404); assert.equal(nf.body.code, 'TELEGRAM_MESSAGE_NOT_FOUND')
  push('message', { chat: { id: 42, kind: 'user', title: 'Alice' }, message: { chat: 42, id: 108, date: 1700000200, out: false, text: 'plain' } })
  assert.ok(await until(async () => (await priv('/tg/messages?chat=42&local=1&limit=100')).body.messages.some(m => m.id === 108)))
  const na = await priv('/tg/transcribe', 'POST', { chat: 42, msg: 108 })
  assert.equal(na.status, 400); assert.equal(na.body.code, 'TELEGRAM_BAD_REQUEST')
})

child.kill('SIGTERM')
await sleep(200)
try { sseReq.destroy() } catch {}
fakeServer.close(); sttServer.close()
rmSync(dir, { recursive: true, force: true })
console.log(passed + ' passed' + (process.exitCode ? ', FAILURES above' : ''))
if (process.exitCode) console.log(childOut.split('\n').slice(-30).join('\n'))
process.exit(process.exitCode || 0)
