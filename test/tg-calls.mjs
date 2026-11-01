/**
 * Telegram calls in phone-hookd: node test/tg-calls.mjs
 *
 * Real phone-hookd on a temp data dir against a FAKE telegramd (unix sockets
 * telegramd.sock and calls.sock). Checks the decision per Phone mode (DND
 * declines silently, voicemail declines and texts once per 12 h, live with no
 * Phone tab ignores, live with a tab rings), the call log, answering from the
 * tab through the audio hub with audio both ways over calls.sock, hangup, the
 * agent routes (place and answer go through the tab) and outgoing calls.
 * Nothing here talks to Telegram.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { wsConnect } from './wsclient.mjs'
import { encodeAudio, encodeControl, decodeFrame } from '../shared/frame.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
let passed = 0
const t = async (name, fn) => { try { await fn(); passed++; console.log('ok  ', name) } catch (e) { console.error('FAIL', name, '\n', e); process.exitCode = 1 } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(40) } return false }

const dir = mkdtempSync(join(process.env.TMPDIR || '/var/tmp', 'dshp-tgcall-'))
const tgDir = join(dir, 'telegram')
mkdirSync(join(tgDir, 'spool'), { recursive: true, mode: 0o700 })
const fake = { streams: new Set(), seq: 0, hangups: [], answers: [], places: [], sends: [], audioIn: 0, audioConns: [], calls: { dnd: 'decline', voicemail: 'decline_text', voicemailText: 'Busy now, please text me.', liveNoTab: 'ignore' } }
const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
const readBody = (req) => new Promise(r => { let d = ''; req.on('data', c => { d += c }); req.on('end', () => r(d ? JSON.parse(d) : {})) })
const auth = { state: 'ready', connected: true, me: { id: 99, kind: 'user', title: 'Example Account', self: true } }
function push(type, data) { const line = JSON.stringify({ seq: ++fake.seq, type, at: Date.now(), data }) + '\n'; for (const s of fake.streams) s.write(line) }
const ALICE = { id: 42, kind: 'user', title: 'Alice' }
const tgServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write(JSON.stringify({ type: 'hello', data: { auth, gap: false, seq: fake.seq } }) + '\n')
    fake.streams.add(res); req.on('close', () => fake.streams.delete(res)); return
  }
  if (u.pathname === '/status') return json(res, 200, { ok: true, auth })
  if (u.pathname === '/config') return json(res, 200, { ok: true, config: { calls: fake.calls, media: { uploadMB: 1 } } })
  if (u.pathname === '/dialogs') return json(res, 200, { ok: true, dialogs: u.searchParams.get('archived') === '1' ? [] : [{ chat: ALICE, unread: 0, top: { chat: 42, id: 1, date: 1700000000, text: 'hi' } }] })
  if (u.pathname === '/call/status') return json(res, 200, { ok: true, available: true, engine: 'fake', calls: [] })
  if (req.method === 'POST') {
    return readBody(req).then(b => {
      if (u.pathname === '/call/hangup') { fake.hangups.push(b); push('call.ended', { callId: b.callId, chat: 42, title: 'Alice', reason: b.busy ? 'declined' : 'hangup' }); return json(res, 200, { ok: true }) }
      if (u.pathname === '/call/answer') { fake.answers.push(b); setTimeout(() => push('call.state', { callId: b.callId, state: 'active', emojis: 'ABCD', chat: 42 }), 100); return json(res, 200, { ok: true, call: { callId: b.callId, state: 'accepting' } }) }
      if (u.pathname === '/call/place') { fake.places.push(b); const callId = 'tc-out' + fake.places.length; setTimeout(() => push('call.state', { callId, state: 'active', chat: 42 }), 300); return json(res, 200, { ok: true, call: { callId, state: 'ringing', chat: 42, title: 'Alice', audioKey: 'K-' + callId } }) }
      if (u.pathname === '/send') { fake.sends.push(b); return json(res, 200, { ok: true, message: { chat: b.chat, id: 100 + fake.sends.length, date: 1700000100, out: true, text: b.text } }) }
      json(res, 404, { ok: false, code: 'TELEGRAM_NOT_FOUND', error: 'fake ' + u.pathname })
    })
  }
  json(res, 404, { ok: false, code: 'TELEGRAM_NOT_FOUND', error: 'fake ' + u.pathname })
})
await new Promise(r => tgServer.listen(join(tgDir, 'telegramd.sock'), r))
// calls.sock: check the hello, count audio in, send far-end audio back.
const audioServer = net.createServer((c) => {
  let hello = Buffer.alloc(0); let ok = false
  c.on('data', (d) => {
    if (!ok) {
      hello = Buffer.concat([hello, d]); const i = hello.indexOf(10); if (i < 0) return
      const h = JSON.parse(hello.subarray(0, i).toString())
      ok = h.key === 'K-' + h.callId || h.key === 'KEY-' + h.callId
      c.write(JSON.stringify({ ok }) + '\n')
      if (!ok) { c.end(); return }
      fake.audioConns.push(c)
      const far = Buffer.alloc(160, 0x20)
      const iv = setInterval(() => { if (c.destroyed) clearInterval(iv); else c.write(far) }, 20)
      d = hello.subarray(i + 1)
    }
    fake.audioIn += d.length
  })
  c.on('error', () => {})
})
await new Promise(r => audioServer.listen(join(tgDir, 'calls.sock'), r))

writeFileSync(join(dir, 'hookd-config.json'), JSON.stringify({ publicBaseUrl: 'https://hooks.example.test/phone-hook', lines: [], relay: { enabled: false }, audio: { route: 'server', packetMs: 20 } }), { mode: 0o600 })
const free = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const child = spawn(process.execPath, [join(HERE, '..', 'daemon', 'hookd.mjs')], {
  env: { ...process.env, HOME: dir, DSH_PHONE_DATA: dir, DSH_PHONE_HOOK_PORT: String(await free()), DSH_PHONE_AUDIOSOCKET_PORT: String(await free()), DSH_PHONE_ASTERISK_DIR: join(dir, 'ast'), NODE_NO_WARNINGS: '1' },
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
const events = (type) => sse.join('').split('\n\n').filter(b => b.includes('event: ' + type + '\n')).map(b => JSON.parse(b.split('\ndata: ')[1]))
const callRow = async (sid) => (await priv('/calls?limit=50')).body.calls.find(c => c.sid === sid)
const incoming = (n) => push('call.incoming', { callId: 'tc-' + n, chat: 42, title: 'Alice', direction: 'in', state: 'incoming', audioKey: 'KEY-tc-' + n, supported: true })

await t('hookd connects and syncs the chat list', async () => {
  assert.ok(await until(() => fake.streams.size === 1), childOut)
  assert.ok(await until(async () => ((await priv('/tg/chats')).body.chats || []).length === 1))
})

await t('DND: declined at once (busy), logged as declined, no text', async () => {
  await priv('/mode', 'POST', { mode: 'dnd' })
  incoming(1)
  assert.ok(await until(() => fake.hangups.some(h => h.callId === 'tc-1')))
  assert.equal(fake.hangups.find(h => h.callId === 'tc-1').busy, true)
  assert.ok(await until(async () => (await callRow('tg-tc-1') || {}).disposition === 'declined'))
  const row = await callRow('tg-tc-1')
  assert.equal(row.line, 'tg'); assert.equal(row.peer, '42'); assert.equal(row.name, 'Alice'); assert.equal(row.direction, 'in')
  assert.equal(fake.sends.length, 0)
})

await t('voicemail: declined plus one polite text per caller per 12 hours', async () => {
  await priv('/mode', 'POST', { mode: 'voicemail' })
  incoming(2)
  assert.ok(await until(() => fake.sends.length === 1))
  assert.equal(fake.sends[0].text, 'Busy now, please text me.'); assert.equal(fake.sends[0].chat, 42)
  incoming(3)
  assert.ok(await until(() => fake.hangups.some(h => h.callId === 'tc-3')))
  await sleep(200)
  assert.equal(fake.sends.length, 1, 'second call in 12 h: no second text')
  const msgs = (await priv('/tg/messages?chat=42&local=1')).body.messages
  assert.equal(msgs.find(m => m.id === 101).origin, 'auto')
})

await t('voicemail with the "ignore" alternative: nothing is done, the call stays ringing, then missed', async () => {
  fake.calls.voicemail = 'ignore'
  incoming(4)
  await sleep(300)
  assert.ok(!fake.hangups.some(h => h.callId === 'tc-4'))
  assert.equal((await callRow('tg-tc-4')).disposition, 'ringing')
  push('call.ended', { callId: 'tc-4', chat: 42, title: 'Alice', reason: 'missed' })
  assert.ok(await until(async () => (await callRow('tg-tc-4')).disposition === 'missed'))
  fake.calls.voicemail = 'decline_text'
})

await t('live with no Phone tab: ignored (the phone app keeps ringing)', async () => {
  await priv('/mode', 'POST', { mode: 'live' })
  incoming(5)
  await sleep(300)
  assert.ok(!fake.hangups.some(h => h.callId === 'tc-5'))
  assert.ok(!events('call.incoming').some(e => e.call && e.call.sid === 'tg-tc-5' && e.ringing))
  push('call.ended', { callId: 'tc-5', chat: 42, reason: 'missed' })
})

let ws
await t('live with a tab: rings on the server route; the tab answers; audio flows both ways; emojis shown', async () => {
  await priv('/presence', 'POST', { clientId: 'tab1', registered: true, audio: 'server' })
  incoming(6)
  assert.ok(await until(() => events('call.incoming').some(e => e.call && e.call.sid === 'tg-tc-6' && e.ringing && e.route === 'server')))
  const ev = events('call.incoming').find(e => e.call.sid === 'tg-tc-6')
  assert.equal(ev.call.name, 'Alice'); assert.equal(ev.call.line, 'tg')
  const tk = await priv('/audio/ticket', 'POST', { purpose: 'answer', callSid: 'tg-tc-6' })
  assert.equal(tk.status, 200, JSON.stringify(tk.body))
  const r = await wsConnect({ socketPath: join(dir, 'hookd.sock'), path: '/audio/io', protocols: ['dshp.v1', 'k.' + tk.body.ticket] })
  assert.equal(r.status, 101)
  ws = r.ws
  ws.send(encodeControl({ t: 'hello' }))
  assert.ok(await until(() => fake.answers.some(a => a.callId === 'tc-6')), 'telegramd asked to answer')
  assert.ok(await until(() => ws.messages.map(m => decodeFrame(m)).some(f => f.kind === 'control' && f.msg.t === 'state' && f.msg.state === 'open' && f.msg.emojis === 'ABCD')), 'open with emojis')
  for (let i = 0; i < 30; i++) { ws.send(encodeAudio(i, Date.now() & 0xffffffff, Buffer.alloc(160, 0x55))); await sleep(20) }
  assert.ok(await until(() => fake.audioIn >= 160 * 10), 'browser audio reached calls.sock: ' + fake.audioIn)
  assert.ok(await until(() => ws.messages.map(m => decodeFrame(m)).filter(f => f.kind === 'audio').length >= 5), 'far-end audio reached the browser')
  assert.equal((await callRow('tg-tc-6')).disposition, 'answered')
})

await t('hangup from the tab ends the Telegram call', async () => {
  ws.send(encodeControl({ t: 'end' }))
  assert.ok(await until(() => fake.hangups.some(h => h.callId === 'tc-6' && !h.busy)))
  assert.ok(await until(async () => (await callRow('tg-tc-6')).status === 'completed'))
})

await t('agent routes: place goes to the tab (tg.call.dial); answer is broadcast to the tab; status; hangup declines', async () => {
  const pl = await priv('/tg/call/place', 'POST', { chat: 42, origin: 'agent' })
  assert.equal(pl.status, 200, JSON.stringify(pl.body)); assert.equal(pl.body.state, 'dialing')
  assert.ok(await until(() => events('tg.call.dial').some(e => e.chat === 42)))
  incoming(7)
  assert.ok(await until(() => events('call.incoming').some(e => e.call && e.call.sid === 'tg-tc-7')))
  const an = await priv('/tg/call/answer', 'POST', { origin: 'agent' })
  assert.equal(an.status, 200); assert.ok(await until(() => events('tg.call.answer').some(e => e.callSid === 'tg-tc-7')))
  const st = await priv('/tg/call/status')
  assert.equal(st.body.call.callId, 'tc-7'); assert.equal(st.body.available, true)
  const hu = await priv('/tg/call/hangup', 'POST', { origin: 'agent' })
  assert.equal(hu.status, 200)
  assert.ok(await until(() => fake.hangups.some(h => h.callId === 'tc-7' && h.busy)), 'unanswered: declined')
})

await t('outgoing from the tab: ticket on line tg, telegramd places, open on active, audio connected', async () => {
  const bad = await priv('/audio/ticket', 'POST', { purpose: 'dial', line: 'tg', to: 'abc' })
  assert.equal(bad.status, 400)
  const tk = await priv('/audio/ticket', 'POST', { purpose: 'dial', line: 'tg', to: '42' })
  assert.equal(tk.status, 200, JSON.stringify(tk.body))
  const r = await wsConnect({ socketPath: join(dir, 'hookd.sock'), path: '/audio/io', protocols: ['dshp.v1', 'k.' + tk.body.ticket] })
  const w = r.ws
  w.send(encodeControl({ t: 'hello' }))
  assert.ok(await until(() => fake.places.length === 1 && fake.places[0].origin === 'ui'))
  assert.ok(await until(() => w.messages.map(m => decodeFrame(m)).some(f => f.kind === 'control' && f.msg.t === 'state' && f.msg.state === 'open')))
  const sid = 'tg-tc-out1'
  assert.ok(await until(async () => (await callRow(sid) || {}).disposition === 'answered'))
  w.send(encodeControl({ t: 'end' }))
  assert.ok(await until(() => fake.hangups.some(h => h.callId === 'tc-out1')))
})

child.kill('SIGTERM')
await sleep(200)
try { sseReq.destroy() } catch {}
tgServer.close(); audioServer.close()
rmSync(dir, { recursive: true, force: true })
console.log(passed + ' passed' + (process.exitCode ? ', FAILURES above' : ''))
if (process.exitCode) console.log(childOut.split('\n').slice(-30).join('\n'))
process.exit(process.exitCode || 0)
