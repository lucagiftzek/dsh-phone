/**
 * dsh-phone Telegram bridge tests: node test/telegram.mjs
 * Real phone-hookd on a temp data dir against a FAKE telegramd (unix socket,
 * same HTTP/NDJSON contract as telegramd/rpc.go): dialog sync, events into
 * phone.db, unread counts, send (origin passed through), read marks, deletes,
 * uploads through the spool, media piping, coded errors, daemon down.
 * Nothing here talks to Telegram.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { violations } from './lossless-check.mjs'
import { previewOf, kindOf, maskCodes, parseTg, groupId } from '../daemon/telegram.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
let passed = 0
const t = async (name, fn) => { try { await fn(); passed++; console.log('ok  ', name) } catch (e) { console.error('FAIL', name, '\n', e); process.exitCode = 1 } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(50) } return false }

await t('preview text and kinds', () => {
  assert.equal(previewOf({ text: 'hi\nthere' }), 'hi there')
  assert.equal(previewOf({ text: 'look', media: { kind: 'photo' } }), 'Photo: look')
  assert.equal(previewOf({ media: { kind: 'voice' } }), 'Voice message')
  assert.equal(previewOf({ service: 'pinned a message' }), 'pinned a message')
  assert.equal(kindOf(5), 'user'); assert.equal(kindOf(-5), 'group'); assert.equal(kindOf(-1001234567890), 'channel')
  assert.equal(maskCodes('Login code: 12345. Do not give it to anyone'), 'Login code: [code hidden]. Do not give it to anyone')
  assert.equal(maskCodes('web login code: Ab3dEf9GhIk'), 'web login code: [code hidden]')
  assert.equal(maskCodes('See https://my.telegram.org/auth'), 'See https://my.telegram.org/auth')
})

// ---------------------------------------------------------------- fake telegramd

const dir = mkdtempSync(join(process.env.TMPDIR || '/var/tmp', 'dshp-tg-'))
const tgDir = join(dir, 'telegram')
mkdirSync(join(tgDir, 'spool'), { recursive: true, mode: 0o700 })
const sockPath = join(tgDir, 'telegramd.sock')
const CH = -1001111111111
const fake = { streams: new Set(), seq: 0, calls: [], sendReply: null, uploads: [] }
function push(type, data) {
  const line = JSON.stringify({ seq: ++fake.seq, type, at: Date.now(), data }) + '\n'
  for (const s of fake.streams) s.write(line)
}
const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
const readBody = (req) => new Promise(r => { let d = ''; req.on('data', c => { d += c }); req.on('end', () => r(d ? JSON.parse(d) : {})) })
const auth = { state: 'ready', connected: true, me: { id: 99, kind: 'user', title: 'Example Account', username: 'example_account', self: true } }
function fakeHandler(req, res) {
  const u = new URL(req.url, 'http://x')
  fake.calls.push(req.method + ' ' + u.pathname)
  if (u.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write(JSON.stringify({ type: 'hello', data: { auth, gap: false, seq: fake.seq } }) + '\n')
    fake.streams.add(res); req.on('close', () => fake.streams.delete(res))
    return
  }
  if (u.pathname === '/status') return json(res, 200, { ok: true, version: 'fake', credentials: true, credentialsSource: 'file', auth, agent: { enabled: true } })
  if (u.pathname === '/config') return json(res, 200, { ok: true, config: { media: { uploadMB: 1 } } })
  if (u.pathname === '/dialogs') {
    if (u.searchParams.get('archived') === '1') return json(res, 200, { ok: true, dialogs: [] })
    return json(res, 200, { ok: true, dialogs: [
      { chat: { id: 42, kind: 'user', title: 'Alice', username: 'alice' }, unread: 2, readIn: 10, readOut: 11, top: { chat: 42, id: 12, date: 1700000100, out: false, text: 'hello Alex', from: 42, fromName: 'Alice' } },
      { chat: { id: CH, kind: 'channel', title: 'Example Channel', username: 'example_channel', broadcast: true, canPost: true, creator: true }, unread: 0, pinned: true, top: { chat: CH, id: 3, date: 1700000000, out: true, text: 'welcome', post: true } },
    ] })
  }
  if (u.pathname === '/history') {
    const chat = Number(u.searchParams.get('chat'))
    return json(res, 200, { ok: true, chat: { id: chat, kind: 'user', title: 'Alice' }, messages: [{ chat, id: 11, date: 1700000050, out: true, text: 'earlier' }, { chat, id: 10, date: 1700000040, out: false, text: 'first', media: { kind: 'photo', file: true, thumb: true } }] })
  }
  if (u.pathname === '/send') {
    return readBody(req).then(b => {
      fake.lastSend = b
      if (fake.sendReply) return json(res, fake.sendReply.status, fake.sendReply.body)
      json(res, 200, { ok: true, message: { chat: b.chat, id: 13, date: 1700000200, out: true, text: b.text } })
    })
  }
  if (u.pathname === '/send_media') {
    return readBody(req).then(b => {
      const content = fs.readFileSync(b.path, 'utf8')
      fake.uploads.push({ ...b, content, inSpool: b.path.startsWith(join(tgDir, 'spool') + '/') })
      json(res, 200, { ok: true, message: { chat: b.chat, id: 14 + fake.uploads.length, date: 1700000300, out: true, text: b.text, media: { kind: b.kind || 'document', name: b.name } } })
    })
  }
  if (u.pathname === '/read') return readBody(req).then(b => { fake.lastRead = b; json(res, 200, { ok: true, marked: b.origin === 'ui' }) })
  if (u.pathname === '/media') {
    if (u.searchParams.get('msg') === '404') return json(res, 404, { ok: false, code: 'TELEGRAM_MEDIA_UNAVAILABLE', error: 'message 404 not found' })
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': 4, 'x-file-name': '"p.jpg"' }); res.end('JPEG')
    return
  }
  if (u.pathname === '/resolve') return readBody(req).then(b => b.origin === 'ui' ? json(res, 200, { ok: true, chat: { id: 77, kind: 'user', title: 'Bob', username: 'bob' }, dialog: false }) : json(res, 403, { ok: false, code: 'TELEGRAM_CHAT_NOT_ALLOWED', error: 'only the owner' }))
  json(res, 404, { ok: false, code: 'TELEGRAM_NOT_FOUND', error: 'fake: ' + u.pathname })
}
let fakeServer = http.createServer(fakeHandler)
await new Promise(r => fakeServer.listen(sockPath, r))

// ---------------------------------------------------------------- real hookd

writeFileSync(join(dir, 'hookd-config.json'), JSON.stringify({ publicBaseUrl: 'https://hooks.example.test/phone-hook', lines: [], relay: { enabled: false } }), { mode: 0o600 })
const free = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const child = spawn(process.execPath, [join(HERE, '..', 'daemon', 'hookd.mjs')], {
  env: { ...process.env, HOME: dir, DSH_PHONE_DATA: dir, DSH_PHONE_HOOK_PORT: String(await free()), DSH_PHONE_AUDIOSOCKET_PORT: String(await free()), DSH_PHONE_ASTERISK_DIR: join(dir, 'ast'), NODE_NO_WARNINGS: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let childOut = ''
child.stdout.on('data', d => { childOut += d }); child.stderr.on('data', d => { childOut += d })
for (let i = 0; i < 80 && !existsSync(join(dir, 'hookd.sock')); i++) await sleep(100)

function priv(path, method = 'GET', body, { raw = false, headers = {} } = {}) {
  return new Promise((res, rej) => {
    const isBuf = Buffer.isBuffer(body)
    const req = http.request({ socketPath: join(dir, 'hookd.sock'), path, method, headers: body ? { 'content-type': isBuf ? 'application/octet-stream' : 'application/json', ...headers } : headers }, (r) => {
      const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => {
        const buf = Buffer.concat(chunks)
        res({ status: r.statusCode, headers: r.headers, body: raw ? buf : JSON.parse(buf.toString('utf8') || '{}') })
      })
    })
    req.on('error', rej); req.end(body ? (isBuf ? body : JSON.stringify(body)) : undefined)
  })
}

// hookd's own SSE stream, to see what the Phone tabs receive
const sse = []
const sseReq = http.request({ socketPath: join(dir, 'hookd.sock'), path: '/events' }, (r) => { r.setEncoding('utf8'); r.on('data', d => sse.push(d)) })
sseReq.on('error', () => {}); sseReq.end()
const sseHas = (ev) => sse.join('').includes('event: ' + ev + '\n')

await t('hookd follows the event stream and syncs dialogs on hello (ready)', async () => {
  assert.ok(await until(() => fake.streams.size === 1), 'stream connected\n' + childOut)
  assert.ok(await until(async () => (await priv('/tg/chats')).body.chats.length === 2), 'dialogs synced')
  const r = await priv('/tg/chats')
  assert.equal(r.status, 200)
  assert.equal(r.body.chats[0].id, CH, 'pinned first')
  assert.equal(r.body.chats[0].canPost, true); assert.equal(r.body.chats[0].broadcast, true)
  assert.equal(r.body.chats[1].title, 'Alice'); assert.equal(r.body.chats[1].unread, 2)
  assert.equal(r.body.chats[1].last.text, 'hello Alex')
  assert.equal(r.body.counts.unread, 2)
  assert.deepEqual(violations(r.body), [])
  const s = await priv('/state')
  assert.equal(s.body.telegram.auth, 'ready'); assert.equal(s.body.telegram.me.username, 'example_account')
})

await t('incoming message event: stored, unread +1 once, broadcast to tabs', async () => {
  push('message', { chat: { id: 42, kind: 'user', title: 'Alice', username: 'alice' }, message: { chat: 42, id: 20, date: 1700000400, out: false, text: 'are you there?', from: 42, fromName: 'Alice' } })
  assert.ok(await until(async () => (await priv('/tg/chats?q=ali')).body.chats[0]?.unread === 3))
  push('message', { chat: { id: 42, kind: 'user', title: 'Alice' }, message: { chat: 42, id: 20, date: 1700000400, out: false, text: 'are you there?' } })
  await sleep(200)
  assert.equal((await priv('/tg/chats?q=ali')).body.chats[0].unread, 3, 'duplicate does not count twice')
  const m = await priv('/tg/messages?chat=42&local=1')
  assert.equal(m.body.messages.at(-1).text, 'are you there?')
  assert.ok(await until(() => sseHas('tg.message')), 'tabs got tg.message')
  push('message.edit', { chat: { id: 42, kind: 'user', title: 'Alice' }, message: { chat: 42, id: 20, date: 1700000400, edit: 1700000410, out: false, text: 'are you there??' } })
  assert.ok(await until(async () => (await priv('/tg/messages?chat=42&local=1')).body.messages.at(-1).text === 'are you there??'))
})

await t('history fetch on open fills older messages; media JSON kept', async () => {
  const r = await priv('/tg/messages?chat=42')
  assert.equal(r.body.fetched, 2)
  const ids = r.body.messages.map(m => m.id)
  assert.deepEqual(ids, [10, 11, 12, 20])
  assert.equal(r.body.messages[0].media.kind, 'photo')
  assert.deepEqual(violations(r.body), [])
})

await t('send: origin passed to telegramd, result stored and broadcast; coded errors pass through', async () => {
  const r = await priv('/tg/send', 'POST', { chat: 42, text: 'yes, here', origin: 'agent', session: 'abc' })
  assert.equal(r.status, 200); assert.equal(r.body.message.id, 13)
  assert.equal(fake.lastSend.origin, 'agent'); assert.equal(fake.lastSend.session, 'abc')
  const ui = await priv('/tg/send', 'POST', { chat: 42, text: 'from the tab', origin: 'ui' })
  assert.equal(fake.lastSend.origin, 'ui'); assert.equal(ui.status, 200)
  const noOrigin = await priv('/tg/send', 'POST', { chat: 42, text: 'x' })
  assert.equal(fake.lastSend.origin, 'agent', 'missing origin means agent (the stricter policy)')
  assert.equal(noOrigin.status, 200)
  const m = await priv('/tg/messages?chat=42&local=1')
  assert.equal(m.body.messages.find(x => x.id === 13).origin, 'agent')
  fake.sendReply = { status: 429, body: { ok: false, code: 'TELEGRAM_RATE_LIMITED', error: 'at most one agent message every 3 s per chat', retryAfter: 3 } }
  const lim = await priv('/tg/send', 'POST', { chat: 42, text: 'again', origin: 'agent' })
  fake.sendReply = null
  assert.equal(lim.status, 429); assert.equal(lim.body.code, 'TELEGRAM_RATE_LIMITED'); assert.equal(lim.body.retryAfter, 3)
})

await t('read (ui) clears unread; agent read does not', async () => {
  const a = await priv('/tg/read', 'POST', { chat: 42, maxId: 20, origin: 'agent' })
  assert.equal(a.body.marked, false)
  assert.equal((await priv('/tg/chats?q=ali')).body.chats[0].unread, 3)
  const u = await priv('/tg/read', 'POST', { chat: 42, maxId: 20, origin: 'ui' })
  assert.equal(u.body.marked, true); assert.equal(u.body.counts.unread, 0)
  push('read', { chat: 42, box: 'out', maxId: 13 })
  assert.ok(await until(async () => (await priv('/tg/chats?q=ali')).body.chats[0].readOut === 13))
})

await t('delete events mark messages deleted (channel scoped and private)', async () => {
  push('message.delete', { chat: 0, ids: [11] })
  assert.ok(await until(async () => (await priv('/tg/messages?chat=42&local=1')).body.messages.find(m => m.id === 11)?.deleted === true))
  push('message.delete', { chat: CH, ids: [3] })
  assert.ok(await until(async () => (await priv('/tg/messages?chat=' + CH + '&local=1')).body.messages.find(m => m.id === 3)?.deleted === true))
})

await t('upload from the tab goes through the spool (origin ui), file removed after; size cap', async () => {
  const r = await priv('/tg/upload?chat=' + CH + '&kind=document&name=' + encodeURIComponent('cv.pdf') + '&caption=hi', 'POST', Buffer.from('PDFDATA'))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const up = fake.uploads.at(-1)
  assert.equal(up.content, 'PDFDATA'); assert.ok(up.inSpool); assert.equal(up.origin, 'ui'); assert.equal(up.text, 'hi')
  await sleep(100)
  assert.equal(fs.readdirSync(join(tgDir, 'spool')).length, 0, 'spool emptied')
  const big = await priv('/tg/upload?chat=42&name=big.bin', 'POST', Buffer.alloc(1100 * 1024))
  assert.equal(big.status, 413); assert.equal(big.body.code, 'TELEGRAM_MEDIA_TOO_LARGE')
  await sleep(100)
  assert.equal(fs.readdirSync(join(tgDir, 'spool')).length, 0)
})

await t('agent send_media copies a local file into the spool; missing file is a coded error', async () => {
  const f = join(dir, 'report.txt'); writeFileSync(f, 'REPORT')
  const r = await priv('/tg/send_media', 'POST', { chat: 42, file: f, caption: 'the report', origin: 'agent' })
  assert.equal(r.status, 200)
  assert.equal(fake.uploads.at(-1).content, 'REPORT'); assert.equal(fake.uploads.at(-1).name, 'report.txt'); assert.equal(fake.uploads.at(-1).origin, 'agent')
  assert.ok(existsSync(f), 'original untouched')
  const miss = await priv('/tg/send_media', 'POST', { chat: 42, file: join(dir, 'nope') })
  assert.equal(miss.status, 400); assert.equal(miss.body.code, 'TELEGRAM_BAD_REQUEST')
})

await t('media is piped with its type and hardened headers; errors stay JSON', async () => {
  const r = await priv('/tg/media?chat=42&msg=10&thumb=1', 'GET', undefined, { raw: true })
  assert.equal(r.status, 200); assert.equal(r.body.toString(), 'JPEG')
  assert.equal(r.headers['content-type'], 'image/jpeg'); assert.equal(r.headers['x-content-type-options'], 'nosniff')
  assert.match(r.headers['content-security-policy'], /default-src 'none'/)
  const nf = await priv('/tg/media?chat=42&msg=404')
  assert.equal(nf.status, 404); assert.equal(nf.body.code, 'TELEGRAM_MEDIA_UNAVAILABLE')
})

await t('resolve: ui allowed, agent refused by telegramd policy', async () => {
  const ok = await priv('/tg/resolve', 'POST', { username: 'bob', origin: 'ui' })
  assert.equal(ok.status, 200); assert.equal(ok.body.chat.title, 'Bob')
  const no = await priv('/tg/resolve', 'POST', { username: 'bob', origin: 'agent' })
  assert.equal(no.status, 403); assert.equal(no.body.code, 'TELEGRAM_CHAT_NOT_ALLOWED')
  const nr = await priv('/tg/nope')
  assert.equal(nr.status, 404); assert.equal(nr.body.code, 'TELEGRAM_NOT_FOUND')
})

await t('album id above 2^53 stays exact and reading the chat does not throw', async () => {
  const GID = '14350891792988188'
  assert.ok(Number(GID) > Number.MAX_SAFE_INTEGER)
  assert.equal(parseTg('{"a":1,"group":' + GID + '}').group, GID, 'exact digits from the JSON source')
  assert.equal(parseTg('{"group":0}').group, '0')
  assert.equal(groupId(GID), GID); assert.equal(groupId(undefined), 0); assert.equal(groupId('abc'), 0)
  // raw JSON line: JSON.stringify would round the number, so write the digits by hand
  const raw = '{"seq":' + (++fake.seq) + ',"type":"message","at":1,"data":{"chat":{"id":42,"kind":"user","title":"Alice"},"message":{"chat":42,"id":31,"date":1700000500,"out":true,"text":"album","group":' + GID + ',"media":{"kind":"photo"}}}}\n'
  for (const s of fake.streams) s.write(raw)
  assert.ok(await until(async () => (await priv('/tg/messages?chat=42&local=1')).body.messages.some(m => m.id === 31)))
  const r = await priv('/tg/messages?chat=42&local=1')
  assert.equal(r.status, 200)
  assert.equal(r.body.messages.find(m => m.id === 31).group, GID)
  assert.equal(r.body.messages.find(m => m.id === 10).group, undefined, 'no album: no group field')
  const open = await priv('/tg/messages?chat=42')
  assert.equal(open.status, 200)
  assert.equal(open.body.messages.find(m => m.id === 31).group, GID)
})

await t('telegramd down: status says so, calls answer TELEGRAM_DAEMON_UNAVAILABLE, stream reconnects', async () => {
  for (const s of fake.streams) s.destroy()
  await new Promise(r => fakeServer.close(r))
  fs.rmSync(sockPath, { force: true })
  await sleep(200)
  const st = await priv('/tg/status')
  assert.equal(st.status, 200); assert.equal(st.body.daemon, false)
  const s = await priv('/tg/send', 'POST', { chat: 42, text: 'x', origin: 'ui' })
  assert.equal(s.status, 503); assert.equal(s.body.code, 'TELEGRAM_DAEMON_UNAVAILABLE')
  assert.ok((await priv('/tg/chats')).body.chats.length === 2, 'local data still served')
  fakeServer = http.createServer(fakeHandler)
  await new Promise(r => fakeServer.listen(sockPath, r))
  assert.ok(await until(() => fake.streams.size === 1, 8000), 'reconnected')
  const st2 = await priv('/tg/status')
  assert.equal(st2.body.daemon, true); assert.equal(st2.body.stream.connected, true)
})

child.kill('SIGTERM')
await sleep(200)
try { sseReq.destroy() } catch {}
fakeServer.close()
rmSync(dir, { recursive: true, force: true })
console.log(passed + ' passed' + (process.exitCode ? ', FAILURES above' : ''))
if (process.exitCode) console.log(childOut.split('\n').slice(-30).join('\n'))
process.exit(process.exitCode || 0)
