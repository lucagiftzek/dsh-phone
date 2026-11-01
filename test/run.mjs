/**
 * dsh-phone unit tests: node test/run.mjs
 * Pure functions + the sqlite store on a temp file. No network.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'

import { expectedSignature, validateSignature, voiceAccessToken, el, twiml, toE164, smsSegments, xmlEscape } from '../daemon/twilio.mjs'
import { Store } from '../daemon/store.mjs'
import { resolveSettings, redact, sanitisePatch, merge } from '../daemon/config.mjs'

let passed = 0
const t = (name, fn) => { try { fn(); passed++; console.log('ok  ', name) } catch (e) { console.error('FAIL', name, '\n', e); process.exitCode = 1 } }

// Twilio's own published test vector (twilio-node webhooks spec).
const URL_ = 'https://mycompany.com/myapp.php?foo=1&bar=2'
const PARAMS = { CallSid: 'CA1234567890ABCDE', Caller: '+14158675309', Digits: '1234', From: '+14158675309', To: '+18005551212' }
t('signature matches the Twilio test vector', () => {
  assert.equal(expectedSignature('12345', URL_, PARAMS), 'RSOYDt4T1cUTdK1PDd93/VVr8B8=')
})
t('validateSignature accepts good, rejects tampered', () => {
  assert.equal(validateSignature('12345', 'RSOYDt4T1cUTdK1PDd93/VVr8B8=', URL_, PARAMS), true)
  assert.equal(validateSignature('12345', 'RSOYDt4T1cUTdK1PDd93/VVr8B8=', URL_, { ...PARAMS, Digits: '9999' }), false)
  assert.equal(validateSignature('12345', '', URL_, PARAMS), false)
  assert.equal(validateSignature('', 'RSOYDt4T1cUTdK1PDd93/VVr8B8=', URL_, PARAMS), false)
})
t('validateSignature tolerates an explicit :443', () => {
  const sig = expectedSignature('tok', 'https://h.example:443/p?x=1', { A: '1' })
  assert.equal(validateSignature('tok', sig, 'https://h.example/p?x=1', { A: '1' }), true)
})

t('voice access token is a valid HS256 JWT with the grant', () => {
  const tok = voiceAccessToken({ accountSid: 'ACx', apiKeySid: 'SKy', apiKeySecret: 'shh', identity: 'owner', appSid: 'APz', ttl: 600, now: 1_700_000_000_000 })
  const [h, p, s] = tok.split('.')
  const want = createHmac('sha256', 'shh').update(h + '.' + p).digest('base64url')
  assert.equal(s, want)
  const header = JSON.parse(Buffer.from(h, 'base64url').toString())
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString())
  assert.equal(header.cty, 'twilio-fpa;v=1')
  assert.equal(payload.iss, 'SKy'); assert.equal(payload.sub, 'ACx')
  assert.equal(payload.exp - payload.iat, 600)
  assert.deepEqual(payload.grants, { identity: 'owner', voice: { incoming: { allow: true }, outgoing: { application_sid: 'APz' } } })
})

t('TwiML builder escapes text and attributes', () => {
  const x = twiml(el('Say', { voice: 'Polly.Joanna-Neural', language: '' }, 'a < b & "c"'), el('Dial', { timeout: 20, answerOnBridge: true }, [el('Client', {}, [el('Identity', {}, 'owner')])]))
  assert.equal(x, '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">a &lt; b &amp; &quot;c&quot;</Say><Dial timeout="20" answerOnBridge="true"><Client><Identity>owner</Identity></Client></Dial></Response>')
  assert.equal(el('Hangup'), '<Hangup/>')
  assert.equal(xmlEscape('\u0001ok'), 'ok')
})

t('E.164 normalisation', () => {
  assert.equal(toE164('+1 (555) 010-0199'), '+15550100199')
  assert.equal(toE164('0030 694 123 4567'), '+306941234567')
  assert.equal(toE164('694 123 4567', '+30'), '+306941234567')
  assert.equal(toE164('07700 900123', '+44'), '+447700900123')
  assert.equal(toE164('06 1234 5678', '+39'), '+390612345678')
  assert.equal(toE164('694 123 4567'), null)
  assert.equal(toE164('hello'), null)
  assert.equal(toE164('client:owner'), 'client:owner')
})

t('SMS segment counting', () => {
  assert.deepEqual(smsSegments('hello'), { encoding: 'GSM-7', chars: 5, segments: 1 })
  assert.equal(smsSegments('x'.repeat(161)).segments, 2)
  assert.equal(smsSegments('ΓΔΘ').encoding, 'GSM-7') // some Greek capitals are in GSM-7
  assert.equal(smsSegments('Γεια σου').encoding, 'UCS-2') // lowercase Greek is not
  assert.equal(smsSegments('γεια').encoding, 'UCS-2')
  assert.equal(smsSegments('€').chars, 2)
  assert.equal(smsSegments('🙂'.repeat(36)).segments, 2)
})

t('settings resolve, redact and keep secrets on "__set__"', () => {
  const s = resolveSettings({ lines: [{ id: 'CA!', number: '+1 555 010 0199' }, { id: 'ca' }], twilio: { authToken: 'secret' }, incoming: { ringSeconds: 999 } })
  assert.equal(s.lines.length, 1)
  assert.equal(s.lines[0].id, 'ca'); assert.equal(s.lines[0].number, '+15550100199')
  assert.equal(s.defaultLine, 'ca')
  assert.equal(s.incoming.ringSeconds, 60)
  assert.equal(redact(s).twilio.authToken, '__set__')
  assert.equal(sanitisePatch({ twilio: { authToken: '__set__' } }, s).twilio.authToken, 'secret')
  assert.deepEqual(merge({ a: { b: 1, c: [1] } }, { a: { c: [2] } }), { a: { b: 1, c: [2] } })
})

t('store: messages, threads, idempotency, counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-phone-test-'))
  const st = new Store(join(dir, 'p.db'))
  try {
    assert.ok(st.addMessage({ sid: 'SM1', line: 'ca', peer: '+306900000001', direction: 'in', body: 'hi', ts: 10 }))
    assert.equal(st.addMessage({ sid: 'SM1', line: 'ca', peer: '+306900000001', direction: 'in', body: 'hi', ts: 10 }), null)
    st.addMessage({ sid: 'SM2', line: 'ca', peer: '+306900000001', direction: 'out', body: 'yo', ts: 11, read: true })
    st.saveContact({ number: '+306900000001', name: 'Maria', starred: true })
    const th = st.threads()
    assert.equal(th.length, 1); assert.equal(th[0].name, 'Maria'); assert.equal(th[0].unread, 1); assert.equal(th[0].last.body, 'yo')
    assert.equal(st.counts().sms, 1)
    st.markThreadRead('ca', '+306900000001')
    assert.equal(st.counts().sms, 0)
    st.upsertCall({ sid: 'CA1', line: 'ca', peer: '+306900000001', direction: 'in', disposition: 'ringing' })
    st.upsertCall({ sid: 'CA1', disposition: 'missed' })
    assert.equal(st.callBySid('CA1').disposition, 'missed'); assert.equal(st.counts().missed, 1)
    const vm = st.addVoicemail({ callSid: 'CA1', line: 'ca', peer: '+306900000001', status: 'recording' })
    assert.equal(st.addVoicemail({ callSid: 'CA1', line: 'ca', peer: 'x' }).id, vm.id)
    st.updateVoicemail(vm.id, { status: 'ready', transcript: 'call me', picked_up: true })
    assert.equal(st.voicemail(vm.id).pickedUp, true)
    assert.equal(st.counts().voicemail, 1)
    st.set('mode', 'dnd'); assert.equal(st.get('mode'), 'dnd')
  } finally { st.close(); rmSync(dir, { recursive: true, force: true }) }
})

console.log(passed + ' passed' + (process.exitCode ? ', SOME FAILED' : ''))
