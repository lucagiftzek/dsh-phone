/**
 * dsh-phone SIP relay tests: node test/relay.mjs
 * Pure functions (E.164, bridge key, Asterisk config) + a fake AMI server +
 * phone-hookd itself on a temp data dir (signed /voice/sip and /voice/outbound).
 * No network beyond loopback.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import net from 'node:net'
import http from 'node:http'

import {
  normaliseCaller, normaliseSipAccounts, withCredentials, accountIssues, accountWarnings, buildRelayConfig, bridgeKeyHash, checkBridgeKey,
  bridgeSipUri, sipHeaders, sipUser, destinationAllowed, dialString, outgoingCallerId, confValue, accountDid, TWILIO_SIP_SIGNALLING,
} from '../daemon/sip.mjs'
import { amiRun, amiReload, amiRegistrations, amiRegister } from '../daemon/ami.mjs'
import { staleRegistrations } from '../daemon/relay.mjs'
import { resolveSettings, redact, sanitisePatch, preserveUnknownKeys } from '../daemon/config.mjs'
import { expectedSignature } from '../daemon/twilio.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
let passed = 0
const t = async (name, fn) => { try { await fn(); passed++; console.log('ok  ', name) } catch (e) { console.error('FAIL', name, '\n', e); process.exitCode = 1 } }

// ---------------------------------------------------------------- E.164 (Greece first)

await t('Greek callers normalise to E.164', () => {
  assert.equal(normaliseCaller('2310123456', '30'), '+302310123456')
  assert.equal(normaliseCaller('6941234567', '+30'), '+306941234567')
  assert.equal(normaliseCaller('306941234567', '30'), '+306941234567')
  assert.equal(normaliseCaller('00306941234567', '30'), '+306941234567')
  assert.equal(normaliseCaller('+306941234567', '30'), '+306941234567')
  assert.equal(normaliseCaller('sip:2101234567@198.51.100.7;user=phone', '30'), '+302101234567')
  assert.equal(normaliseCaller('<tel:00447700900123>', '30'), '+447700900123')
  assert.equal(normaliseCaller('8001234567', '30'), '+308001234567')
})
await t('anonymous and short numbers', () => {
  for (const x of ['anonymous', 'Anonymous', 'unknown', 'restricted', '', null, 'sip:anonymous@anonymous.invalid']) assert.equal(normaliseCaller(x, '30'), 'anonymous')
  assert.equal(normaliseCaller('1234', '30'), '1234')
  assert.equal(normaliseCaller('112', '30'), '112')
})
await t('other countries keep their own rules', () => {
  assert.equal(normaliseCaller('07700900123', '44'), '+447700900123')
  assert.equal(normaliseCaller('0612345678', '39'), '+390612345678')
  assert.equal(normaliseCaller('2015550123', '1'), '+12015550123')
  assert.equal(normaliseCaller('2015550123', ''), '2015550123')
})
await t('DID to E.164', () => {
  assert.equal(accountDid({ did: '2310123456' }, '+30'), '+302310123456')
  assert.equal(accountDid({ did: '302310123456' }, '+30'), '+302310123456')
  assert.equal(accountDid({ did: '+302310123456' }, ''), '+302310123456')
})

// ---------------------------------------------------------------- accounts

const LINES = [
  { id: 'ca', provider: 'twilio', number: '+15550100199', voice: true, sms: true, enabled: true },
  { id: 'gr', provider: 'sip', number: '+302310123456', voice: true, sms: false, enabled: true },
]
const BRIDGE = { domain: 'dsh-phone-test.sip.twilio.com', user: 'dshbridgeabc123', password: 'Bridge-Pass-123', edge: 'dublin' }

await t('credentials file fills empty fields, settings win', () => {
  const [a] = normaliseSipAccounts([{ id: 'Yub-o', line: 'gr', username: 'typed' }])
  assert.equal(a.id, 'yubo')
  const env = { ACME_SIP_REGISTRAR: 'sip.example.net', ACME_SIP_PORT: '5060', ACME_SIP_USERNAME: 'fromfile', ACME_SIP_PASSWORD: 'p;w', ACME_DID: '2310123456', OTHER: 'x' }
  const f = withCredentials(a, env)
  assert.equal(f.registrar, 'sip.example.net')
  assert.equal(f.port, 5060)
  assert.equal(f.username, 'typed')
  assert.equal(f.password, 'p;w')
  assert.equal(f.did, '2310123456')
  assert.equal(f.credentialSource, 'file')
})
await t('account issues', () => {
  const [a] = normaliseSipAccounts([{ id: 'y', line: 'gr', registrar: 'sip.example.net', username: 'u1', password: 'x', bridgeVia: 'ca' }])
  assert.deepEqual(accountIssues(a, { lines: LINES, bridge: BRIDGE }), [])
  assert.deepEqual(accountIssues(a, { lines: LINES, bridge: null }), [], 'a missing bridge does not stop the registration')
  assert.match(accountWarnings(a, { bridge: null }).join(), /not provisioned/)
  assert.match(accountIssues({ ...a, bridgeVia: 'gr' }, { lines: LINES, bridge: BRIDGE }).join(), /not a Twilio line/)
  assert.match(accountIssues({ ...a, username: 'bad user\n' }, { lines: LINES, bridge: BRIDGE }).join(), /username/)
  assert.match(accountIssues({ ...a, password: 'a\nb' }, { lines: LINES, bridge: BRIDGE }).join(), /line break/)
  assert.match(accountIssues({ ...a, line: 'ca' }, { lines: LINES, bridge: BRIDGE }).join(), /provider sip/)
})
await t('outgoing destination policy and dial format', () => {
  const [a] = normaliseSipAccounts([{ id: 'y', did: '+302310123456', blockPrefixes: ['+3090'] }])
  assert.equal(destinationAllowed(a, '+306941234567', '+30').ok, true)
  assert.equal(destinationAllowed(a, '+309012345678', '+30').ok, false)
  assert.equal(destinationAllowed(a, '+447700900123', '+30').ok, false)
  assert.equal(destinationAllowed({ ...a, allowPrefixes: ['+30', '+44'] }, '+447700900123', '+30').ok, true)
  assert.equal(destinationAllowed(a, '6941234567', '+30').ok, false)
  assert.equal(dialString(a, '+306941234567', '+30'), '6941234567')
  assert.equal(dialString(a, '+447700900123', '+30'), '00447700900123')
  assert.equal(dialString({ ...a, dialFormat: 'e164' }, '+306941234567', '+30'), '+306941234567')
  assert.equal(outgoingCallerId(a, '+30'), '2310123456')
  assert.equal(outgoingCallerId({ ...a, callerId: '+302109999999' }, '+30'), '2109999999')
  assert.equal(outgoingCallerId({ ...a, did: '', callerId: '' }, '+30'), '')
})

// ---------------------------------------------------------------- bridge key

await t('bridge key: digest only, constant-time check', () => {
  const key = 'a'.repeat(48)
  const h = bridgeKeyHash(key)
  assert.match(h, /^[0-9a-f]{40}$/)
  assert.equal(checkBridgeKey(key, h), true)
  assert.equal(checkBridgeKey(key + 'x', h), false)
  assert.equal(checkBridgeKey('', h), false)
  assert.equal(checkBridgeKey(key, ''), false)
  assert.equal(checkBridgeKey(key, 'zz'), false)
})
await t('bridge SIP URI and webhook header helpers', () => {
  const uri = bridgeSipUri({ user: 'dshbridge1', domain: 'd.sip.twilio.com', dest: '+306941234567', key: 'k1', account: 'y' })
  assert.equal(uri, 'sip:dshbridge1@d.sip.twilio.com?X-Dest=%2B306941234567&X-Account=y&X-Bridge-Key=k1')
  assert.deepEqual(sipHeaders({ 'SipHeader_X-Caller': '+30', 'SipHeader_X-Line': 'gr', From: 'x' }), { 'x-caller': '+30', 'x-line': 'gr' })
  assert.equal(sipUser('sip:gr@d.sip.twilio.com;transport=udp'), 'gr')
})

// ---------------------------------------------------------------- Asterisk config

function sampleConfig(extra = {}) {
  const accounts = normaliseSipAccounts([{ id: 'acme', label: 'Acme', line: 'gr', registrar: 'sip.example.net', port: 5060, username: 'u100', password: 's3cr;et', bridgeVia: 'ca', did: '+302310123456', ringFirstSeconds: 20, blockPrefixes: ['+3090'], codecs: ['alaw', 'ulaw'], ...extra }])
    .map(a => ({ ...a, issues: accountIssues(a, { lines: LINES, bridge: BRIDGE }) }))
  return buildRelayConfig({
    relay: { bindAddress: '192.0.2.10', bindPort: 5070, loopback: true, localNets: ['192.0.2.0/24'], externalMediaAddress: 'relay.example.org', amiUser: 'dsh-phone' },
    accounts, lines: LINES, bridge: BRIDGE, keyHash: bridgeKeyHash('k'.repeat(48)), ami: { user: 'dsh-phone', secret: 'amisecret' }, defaultCountry: '+30',
  })
}

await t('pjsip.conf: transports, account, bridge, identify by IP', () => {
  const c = sampleConfig()['pjsip.conf']
  assert.match(c, /\[dshp-udp\]\ntype=transport\nprotocol=udp\nbind=192\.0\.2\.10:5070\nlocal_net=192\.0\.2\.0\/24\nlocal_net=127\.0\.0\.0\/8\nexternal_media_address=relay\.example\.org/)
  assert.match(c, /\[dshp-lo\]\ntype=transport\nprotocol=udp\nbind=127\.0\.0\.1:5070/)
  assert.doesNotMatch(c, /0\.0\.0\.0/)
  assert.match(c, /\[dshp-acme-auth\]\ntype=auth\nauth_type=userpass\nusername=u100\npassword=s3cr\\;et/)
  assert.match(c, /\[dshp-acme-reg\]\ntype=registration[\s\S]*server_uri=sip:sip\.example\.net\n[\s\S]*line=yes\nendpoint=dshp-acme/)
  assert.match(c, /\[dshp-acme\]\ntype=identify\nendpoint=dshp-acme\nmatch=sip\.example\.net/)
  const cp = sampleConfig({ callPort: 5070 })['pjsip.conf']
  assert.match(cp, /\[dshp-acme\]\ntype=aor\ncontact=sip:sip\.example\.net:5070\n/, 'calls go to the call port')
  assert.match(cp, /\[dshp-acme-reg\][\s\S]*server_uri=sip:sip\.example\.net\n/, 'registration keeps its own port')
  const cs = sampleConfig({ callPort: 5070, callSourcePort: 5072 })['pjsip.conf']
  assert.match(cs, /\[dshp-acme-call\]\ntype=transport\nprotocol=udp\nbind=192\.0\.2\.10:5072\n[\s\S]*external_signaling_address=relay\.example\.org\nexternal_signaling_port=5072\n/)
  assert.match(cs, /\[dshp-acme\]\ntype=endpoint\ntransport=dshp-acme-call\n/, 'calls leave from the call socket')
  assert.match(cs, /\[dshp-acme-reg\]\ntype=registration\ntransport=dshp-udp\n/, 'registration stays on the main socket')
  assert.match(c, /context=dshp-in-acme/)
  for (const k of ['rtp_keepalive=2', 'rtp_timeout=60', 'rtp_symmetric=yes', 'force_rport=yes', 'rewrite_contact=yes', 'direct_media=no', 'allow=alaw,ulaw']) assert.ok(c.includes(k), k)
  assert.match(c, /\[dshp-bridge-reg\][\s\S]*server_uri=sip:dsh-phone-test\.sip\.twilio\.com\nclient_uri=sip:dshbridgeabc123@dsh-phone-test\.sip\.twilio\.com/)
  assert.match(c, /outbound_proxy=sip:sip\.dublin\.twilio\.com\\;lr/)
  assert.match(c, /expiration=600/)
  for (const net of Object.values(TWILIO_SIP_SIGNALLING).flat()) assert.ok(c.includes('match=' + net), net)
})
await t('extensions.conf: E.164 subroutine, headers, ring first, key check, policy', () => {
  const x = sampleConfig()['extensions.conf']
  assert.match(x, /\[dshp-e164-acme\][\s\S]*= 10\]\?nat\)[\s\S]*= 12 & "\$\{LOCAL\(n\):0:2\}" = "30"\]\?cc\)/)
  assert.match(x, /Dial\(PJSIP\/dshp-bridge\/sip:gr@dsh-phone-test\.sip\.twilio\.com,90,b\(dshp-hdr\^s\^1\(\$\{DSHP_CALLER\},gr,\$\{DSHP_VM\}\)\)\)/)
  assert.match(x, /"\$\{DIALSTATUS\}" = "BUSY"[\s\S]*Wait\(20\)/)
  assert.match(x, /GROUP_COUNT\(\$\{DSHP_CID\}@dshpcid\)\} > 0\]\?dup\)[\s\S]*n\(dup\),Set\(DSHP_L=\$\{UNLOCK/, 'one call per Call-ID')
  assert.ok(x.includes('Set(PJSIP_HEADER(add,X-Caller)=${ARG1})'))
  assert.ok(x.includes(bridgeKeyHash('k'.repeat(48))))
  assert.ok(!x.includes('k'.repeat(48)), 'the key itself is never written')
  assert.match(x, /\$\{SHA1\(dsh-phone-bridge:\$\{PJSIP_HEADER\(read,X-Bridge-Key\)\}\)\}/)
  assert.match(x, /"\$\{DSHP_DEST:0:5\}" = "\+3090"\]\?dshp-deny,s,1/)
  assert.match(x, /"\$\{DSHP_DEST:0:3\}" = "\+30"\]\?allowed/)
  assert.match(x, /Set\(DSHP_NUM=\$\{DSHP_DEST:3\}\)/)
  assert.match(x, /Dial\(PJSIP\/\$\{DSHP_NUM\}@dshp-acme,60\)/)
  assert.match(x, /n\(dial\),Set\(CALLERID\(all\)=<2310123456>\)/, 'presents the DID in national format')
  assert.match(x, /\[dshp-hangup\][\s\S]*Goto\(dshp-deny,s,1\)/)
})
await t('TLS bridge: transport 5061 with CA + verify, edge proxy on the certificate name, SRTP required', () => {
  const accounts = normaliseSipAccounts([{ id: 'acme', line: 'gr', registrar: 'sip.example.net', username: 'u100', password: 'p', bridgeVia: 'ca' }]).map(a => ({ ...a, issues: [] }))
  const c = buildRelayConfig({ relay: { bindAddress: '192.0.2.10', bindPort: 5070, bridgeTransport: 'tls', tlsPort: 5061 }, accounts, lines: LINES, bridge: BRIDGE, keyHash: bridgeKeyHash('k'), ami: null, defaultCountry: '+30' })
  const p = c['pjsip.conf']
  assert.match(p, /\[dshp-tls\]\ntype=transport\nprotocol=tls\nbind=192\.0\.2\.10:5061\nmethod=tlsv1_2\nca_list_file=\/etc\/ssl\/certs\/ca-certificates\.crt\nverify_server=yes/)
  assert.match(p, /\[dshp-bridge-reg\]\ntype=registration\ntransport=dshp-tls[\s\S]*server_uri=sip:dsh-phone-test\.sip\.twilio\.com\\;transport=tls[\s\S]*outbound_proxy=sip:sip\.dublin\.twilio\.com:5061\\;transport=tls\\;lr/)
  assert.match(p, /\[dshp-bridge\]\ntype=endpoint\ntransport=dshp-tls[\s\S]*media_encryption=sdes\n(?!media_encryption_optimistic)/)
  assert.match(p, /\[dshp-acme\]\ntype=endpoint\ntransport=dshp-udp[\s\S]*media_encryption=no/, 'the provider leg stays UDP + RTP')
  assert.match(c['extensions.conf'], /Dial\(PJSIP\/dshp-bridge\/sip:gr@dsh-phone-test\.sip\.twilio\.com\\;transport=tls,90,/)
  const nat = buildRelayConfig({ relay: { bindAddress: '192.0.2.10', bridgeTransport: 'tls', tlsPort: 15061, certFile: '/k/c.pem', keyFile: '/k/k.pem', tlsExternalAddress: 'relay.example.org', externalSignalingAddress: '' }, accounts, lines: LINES, bridge: BRIDGE, keyHash: '', ami: null, defaultCountry: '+30' })['pjsip.conf']
  assert.match(nat, /\[dshp-tls\]\ntype=transport\nprotocol=tls\nbind=192\.0\.2\.10:15061\n[\s\S]*cert_file=\/k\/c\.pem\npriv_key_file=\/k\/k\.pem\n[\s\S]*external_signaling_address=relay\.example\.org\nexternal_signaling_port=15061\n/)
  assert.doesNotMatch(nat.split('[dshp-tls]')[0], /external_signaling_address=relay/, 'the UDP transport keeps its own (ALG-handled) contact')
  const plain = buildRelayConfig({ relay: { bindAddress: '192.0.2.10' }, accounts, lines: LINES, bridge: BRIDGE, keyHash: '', ami: null, defaultCountry: '+30' })['pjsip.conf']
  assert.doesNotMatch(plain, /dshp-tls/)
  assert.equal(bridgeSipUri({ user: 'b', domain: 'd.sip.twilio.com', dest: '+306941234567', key: 'k', account: 'y', tls: true }), 'sip:b@d.sip.twilio.com;transport=tls;secure=true?X-Dest=%2B306941234567&X-Account=y&X-Bridge-Key=k')
  const s = resolveSettings({ relay: { bridgeTransport: 'TLS?', tlsPort: 99999 }, sipAccounts: [{ id: 'x', transport: 'tls' }] })
  assert.equal(s.relay.bridgeTransport, 'udp')
  assert.equal(s.relay.tlsPort, 65535)
  assert.equal(s.sipAccounts[0].transport, 'tls')
  assert.equal(resolveSettings({ relay: { bridgeTransport: 'tls' } }).relay.bridgeTransport, 'tls')
})
await t('manager.conf: loopback only, least privilege', () => {
  const m = sampleConfig()['manager.conf']
  assert.match(m, /\[dsh-phone\]\nsecret=amisecret\ndeny=0\.0\.0\.0\/0\.0\.0\.0\npermit=127\.0\.0\.1\/255\.255\.255\.255\nread=system,call\nwrite=system,config,originate,call/)
})
await t('an account with issues is left out; no bridge means no outgoing route', () => {
  const c = sampleConfig({ password: '' })
  assert.doesNotMatch(c['pjsip.conf'], /dshp-acme/)
  assert.doesNotMatch(c['pjsip.conf'], /dshp-bridge/)
  assert.match(c['extensions.conf'], /\[dshp-out\]\nexten => s,1,Goto\(dshp-deny,s,1\)/)
  const nb = buildRelayConfig({ relay: { bindAddress: '192.0.2.10' }, accounts: normaliseSipAccounts([{ id: 'y', line: 'gr', registrar: 'sip.example.net', username: 'u1', password: 'x', bridgeVia: 'ca' }]).map(a => ({ ...a, issues: [] })), lines: LINES, bridge: null, keyHash: '', ami: null, defaultCountry: '+30' })
  assert.match(nb['pjsip.conf'], /\[dshp-y-reg\]/, 'registers without a bridge')
  assert.match(nb['extensions.conf'], /\[dshp-ring-y\]\nexten => s,1,Log\(NOTICE,dsh-phone: line gr has no bridge yet/)
  assert.throws(() => confValue('a\nb'))
})

// ---------------------------------------------------------------- settings

await t('settings: sipAccounts passwords redacted and kept on "__set__"', () => {
  const s = resolveSettings({ sipAccounts: [{ id: 'y', password: 'pw' }, { id: 'z' }] })
  const r = redact(s)
  assert.equal(r.sipAccounts[0].password, '__set__')
  assert.equal(r.sipAccounts[1].password, '')
  const p = sanitisePatch({ sipAccounts: [{ id: 'y', password: '__set__' }, { id: 'z', password: 'new' }] }, s)
  assert.equal(p.sipAccounts[0].password, 'pw')
  assert.equal(p.sipAccounts[1].password, 'new')
  assert.equal(s.relay.bindPort, 5070)
})
await t('hookd keeps relay keys an older plugin push stripped', () => {
  const prev = { lines: [], sipAccounts: [{ id: 'y' }], relay: { bindAddress: '192.0.2.10' }, twilio: { sipEdge: 'dublin', authToken: 'a' } }
  const next = preserveUnknownKeys({ lines: [{ id: 'x' }], twilio: { authToken: 'b' } }, prev)
  assert.deepEqual(next.sipAccounts, [{ id: 'y' }])
  assert.equal(next.relay.bindAddress, '192.0.2.10')
  assert.equal(next.twilio.sipEdge, 'dublin')
  assert.equal(next.twilio.authToken, 'b')
  assert.deepEqual(preserveUnknownKeys({ sipAccounts: [] }, prev).sipAccounts, [], 'an explicit empty list wins')
  const kept = preserveUnknownKeys({ sipAccounts: [{ id: 'y', label: 'new' }] }, { sipAccounts: [{ id: 'y', callPort: 5070 }] })
  assert.deepEqual(kept.sipAccounts, [{ id: 'y', label: 'new', callPort: 5070 }])
})

// ---------------------------------------------------------------- fake AMI

function fakeAmi({ secret = 'amisecret' } = {}) {
  const seen = []
  const server = net.createServer((sock) => {
    sock.write('Asterisk Call Manager/11.0.0\r\n')
    let buf = ''
    let authed = false
    sock.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\r\n\r\n')) >= 0) {
        const block = Object.fromEntries(buf.slice(0, i).split('\r\n').map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]))
        buf = buf.slice(i + 4)
        seen.push(block)
        const id = block.ActionID
        const reply = (o) => sock.write(Object.entries({ ...o, ActionID: id }).map(([k, v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n')
        if (block.Action === 'Login') { authed = block.Secret === secret; reply(authed ? { Response: 'Success', Message: 'Authentication accepted' } : { Response: 'Error', Message: 'Authentication failed' }); if (!authed) sock.end(); continue }
        if (!authed) { reply({ Response: 'Error', Message: 'Permission denied' }); continue }
        if (block.Action === 'Reload') reply({ Response: 'Success', Message: 'Module Reloaded' })
        else if (block.Action === 'PJSIPRegister') reply({ Response: block.Registration ? 'Success' : 'Error', Message: 'Register sent' })
        else if (block.Action === 'PJSIPShowRegistrationsOutbound') {
          reply({ Response: 'Success', EventList: 'start', Message: 'Following are Events for each Outbound registration' })
          reply({ Event: 'OutboundRegistrationDetail', ObjectName: 'dshp-acme-reg', ServerUri: 'sip:sip.example.net', ClientUri: 'sip:u100@sip.example.net', Status: 'Registered', NextReg: '250' })
          reply({ Event: 'OutboundRegistrationDetail', ObjectName: 'dshp-bridge-reg', ServerUri: 'sip:x.sip.twilio.com', ClientUri: 'sip:b@x.sip.twilio.com', Status: 'Rejected', NextReg: '0' })
          reply({ Event: 'OutboundRegistrationDetailComplete', EventList: 'Complete', ListItems: '2' })
        } else if (block.Action === 'Logoff') { reply({ Response: 'Goodbye', Message: 'Thanks for all the fish.' }); sock.end() }
        else reply({ Response: 'Error', Message: 'Invalid/unknown command' })
      }
    })
  })
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port, seen })))
}

const ami = await fakeAmi()
await t('watchdog flags registrations refreshed later than their expiry', () => {
  const regs = [{ name: 'dshp-bridge-reg', status: 'Registered', nextReg: 2720 }, { name: 'dshp-y-reg', status: 'Registered', nextReg: 280 }, { name: 'dshp-z-reg', status: 'Rejected', nextReg: 9999 }]
  assert.deepEqual(staleRegistrations(regs, { 'dshp-bridge-reg': 600, 'dshp-y-reg': 300, 'dshp-z-reg': 300 }), ['dshp-bridge-reg'])
})
await t('AMI: login, reload, list registrations, bad secret', async () => {
  const opts = { host: '127.0.0.1', port: ami.port, username: 'dsh-phone', secret: 'amisecret' }
  const r = await amiReload(opts, ['res_pjsip.so', 'pbx_config.so'])
  assert.deepEqual(r.map(x => [x.module, x.ok]), [['res_pjsip.so', true], ['pbx_config.so', true]])
  const regs = await amiRegistrations(opts)
  assert.equal(await amiRegister(opts, 'dshp-bridge-reg'), true)
  assert.deepEqual(regs.map(x => [x.name, x.status]), [['dshp-acme-reg', 'Registered'], ['dshp-bridge-reg', 'Rejected']])
  await assert.rejects(amiRun({ ...opts, secret: 'wrong' }, [{ Action: 'Reload' }]), /login failed/)
  assert.throws(() => { throw new Error('x') })
  await assert.rejects(amiRun({ ...opts }, [{ Action: 'Reload', Module: 'a\r\nAction: Command' }]), /line break/)
})

// ---------------------------------------------------------------- phone-hookd end to end

const dir = mkdtempSync(join(tmpdir(), 'dshp-relay-'))
const astDir = join(dir, 'asterisk')
mkdirSync(astDir)
const credFile = join(dir, 'sip.credentials')
writeFileSync(credFile, 'ACME_SIP_REGISTRAR=sip.example.net\nACME_SIP_PORT=5060\nACME_SIP_USERNAME=u100\nACME_SIP_PASSWORD=pw-from-file\nACME_DID=2310123456\n', { mode: 0o600 })
const TOKEN = 'test-auth-token'
const BASE = 'https://hook.example.org/phone-hook'
const config = {
  identity: 'tester', publicBaseUrl: BASE, defaultCountry: '+30', defaultLine: 'ca',
  twilio: { accountSid: 'ACtest', authToken: TOKEN, credentialsFile: '', sipEdge: 'dublin' },
  lines: LINES,
  sipAccounts: [{ id: 'acme', label: 'Acme', line: 'gr', bridgeVia: 'ca', credentialsFile: credFile, ringFirstSeconds: 20, blockPrefixes: ['+3090'] }],
  relay: { bindAddress: '127.0.0.1', bindPort: 5070, loopback: false },
  voicemail: { liveTranscript: true, transcriber: 'off' },
}
writeFileSync(join(dir, 'hookd-config.json'), JSON.stringify(config), { mode: 0o600 })
writeFileSync(join(dir, 'relay.json'), JSON.stringify({ amiSecret: 'amisecret', bridgeKey: 'b'.repeat(48) }), { mode: 0o600 })
ami.seen.length = 0
writeFileSync(join(dir, 'provisioned.json'), JSON.stringify({ sipDomainName: BRIDGE.domain, sipBridgeUser: BRIDGE.user, sipBridgePassword: BRIDGE.password, sipDomainSid: 'SDtest' }), { mode: 0o600 })
const port = await new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const child = spawn(process.execPath, [join(HERE, '..', 'daemon', 'hookd.mjs')], {
  env: { ...process.env, HOME: dir, DSH_PHONE_DATA: dir, DSH_PHONE_HOOK_PORT: String(port), DSH_PHONE_ASTERISK_DIR: astDir, DSH_PHONE_AMI_PORT: String(ami.port), NODE_NO_WARNINGS: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let childOut = ''
child.stdout.on('data', d => { childOut += d }); child.stderr.on('data', d => { childOut += d })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
for (let i = 0; i < 60 && !existsSync(join(astDir, 'extensions.conf')); i++) await sleep(100)
await sleep(300)

function post(path, params, { sign = true } = {}) {
  const body = new URLSearchParams(params).toString()
  const headers = { 'content-type': 'application/x-www-form-urlencoded' }
  if (sign) headers['x-twilio-signature'] = expectedSignature(TOKEN, BASE + path, params)
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/phone-hook' + path, method: 'POST', headers }, (r) => {
      let d = ''; r.on('data', c => { d += c }); r.on('end', () => res({ status: r.statusCode, body: d }))
    })
    req.on('error', rej); req.end(body)
  })
}
function priv(path, method = 'GET', body) {
  return new Promise((res, rej) => {
    const req = http.request({ socketPath: join(dir, 'hookd.sock'), path, method, headers: { 'content-type': 'application/json' } }, (r) => {
      let d = ''; r.on('data', c => { d += c }); r.on('end', () => { try { res(JSON.parse(d)) } catch { res(d) } })
    })
    req.on('error', rej); req.end(body ? JSON.stringify(body) : undefined)
  })
}

await t('hookd writes the relay files (0640) and reloads over AMI', () => {
  for (const f of ['pjsip.conf', 'extensions.conf', 'manager.conf']) {
    assert.ok(existsSync(join(astDir, f)), f)
    assert.equal(statSync(join(astDir, f)).mode & 0o777, 0o640, f + ' mode')
  }
  const p = readFileSync(join(astDir, 'pjsip.conf'), 'utf8')
  assert.match(p, /password=pw-from-file/)
  assert.match(p, /bind=127\.0\.0\.1:5070/)
  const reloads = ami.seen.filter(b => b.Action === 'Reload').map(b => b.Module)
  assert.ok(reloads.includes('res_pjsip.so') && reloads.includes('pbx_config.so'), 'reloaded: ' + reloads.join(','))
  const rel = JSON.parse(readFileSync(join(dir, 'relay.json'), 'utf8'))
  assert.equal(statSync(join(dir, 'relay.json')).mode & 0o777, 0o600)
  assert.ok(readFileSync(join(astDir, 'extensions.conf'), 'utf8').includes(bridgeKeyHash(rel.bridgeKey)))
})

const sipCall = (sid, extra = {}) => ({ AccountSid: 'ACtest', CallSid: sid, From: 'sip:6941234567@203.0.113.9', To: 'sip:gr@' + BRIDGE.domain, CallStatus: 'ringing', Direction: 'inbound', 'SipHeader_X-Line': 'gr', 'SipHeader_X-Caller': '6941234567', ...extra })

await t('/voice/sip: unsigned requests are refused', async () => {
  const r = await post('/voice/sip', sipCall('CAunsigned'), { sign: false })
  assert.equal(r.status, 403)
})
await t('/voice/sip: ring-first account answers busy when nothing would ring', async () => {
  const r = await post('/voice/sip', sipCall('CAfirst'))
  assert.equal(r.status, 200)
  assert.match(r.body, /<Reject reason="busy"\/>/)
  const calls = await priv('/calls')
  assert.equal(calls.calls.filter(c => c.sid === 'CAfirst').length, 0, 'no call record for the ring-first pass')
})
await t('/voice/sip: second pass goes to voicemail as line gr with an E.164 caller', async () => {
  const r = await post('/voice/sip', sipCall('CAvm', { 'SipHeader_X-Dsh-Voicemail': '1' }))
  assert.match(r.body, /<Start><Transcription /)
  assert.match(r.body, /<Record [^>]*action="https:\/\/hook\.example\.org\/phone-hook\/voice\/vm-done\?vm=\d+"/)
  const vms = await priv('/voicemails')
  const vm = vms.voicemails.find(v => v.callSid === 'CAvm')
  assert.ok(vm, 'voicemail row')
  assert.equal(vm.line, 'gr')
  assert.equal(vm.peer, '+306941234567')
})
await t('/voice/sip: browser online rings the client with line gr', async () => {
  await priv('/presence', 'POST', { clientId: 'test-client', registered: true })
  const r = await post('/voice/sip', sipCall('CAlive', { 'SipHeader_X-Caller': '+302101234567' }))
  assert.match(r.body, /<Dial timeout="25" answerOnBridge="true" action="[^"]*dial-done\?line=gr"/)
  assert.match(r.body, /<Client><Identity>tester<\/Identity><Parameter name="line" value="gr"\/><Parameter name="peer" value="\+302101234567"\/>/)
  await priv('/presence', 'POST', { clientId: 'test-client', registered: false })
})
await t('/voice/sip: unknown line and blocked caller are rejected (603)', async () => {
  const r = await post('/voice/sip', sipCall('CAbad', { 'SipHeader_X-Line': 'ca' }))
  assert.match(r.body, /<Reject reason="rejected"\/>/)
  await priv('/contacts/save', 'POST', { number: '+306900000000', blocked: true })
  const b = await post('/voice/sip', sipCall('CAblk', { 'SipHeader_X-Caller': '6900000000' }))
  assert.match(b.body, /<Reject reason="rejected"\/>/)
})
await t('/voice/outbound on line gr dials the relay with the bridge key', async () => {
  const rel = JSON.parse(readFileSync(join(dir, 'relay.json'), 'utf8'))
  const r = await post('/voice/outbound', { CallSid: 'CAout', From: 'client:tester', To: '2310999888', line: 'gr' })
  const want = '<Dial callerId="+302310123456" answerOnBridge="true" timeout="45" action="https://hook.example.org/phone-hook/voice/out-done" method="POST"><Sip>sip:' + BRIDGE.user + '@' + BRIDGE.domain + '?X-Dest=%2B302310999888&amp;X-Account=acme&amp;X-Bridge-Key=' + rel.bridgeKey + '</Sip></Dial>'
  assert.ok(r.body.includes(want), r.body)
  const blocked = await post('/voice/outbound', { CallSid: 'CAout2', From: 'client:tester', To: '+309012345678', line: 'gr' })
  assert.match(blocked.body, /cannot be called from this line/)
  const intl = await post('/voice/outbound', { CallSid: 'CAout3', From: 'client:tester', To: '+447700900123', line: 'gr' })
  assert.match(intl.body, /cannot be called from this line/)
})
await t('/voice/outbound over a TLS bridge asks Twilio for TLS + SRTP', async () => {
  await priv('/config', 'PUT', { settings: { ...config, relay: { ...config.relay, bridgeTransport: 'tls' } } })
  const r = await post('/voice/outbound', { CallSid: 'CAouttls', From: 'client:tester', To: '2310999888', line: 'gr' })
  assert.match(r.body, /<Sip>sip:dshbridgeabc123@dsh-phone-test\.sip\.twilio\.com;transport=tls;secure=true\?X-Dest=%2B302310999888&amp;/)
  await sleep(500)
  assert.match(readFileSync(join(astDir, 'pjsip.conf'), 'utf8'), /\[dshp-tls\]/)
  await priv('/config', 'PUT', { settings: config })
})
await t('Twilio line behaviour unchanged (incoming voicemail, outbound Number)', async () => {
  const r = await post('/voice/incoming?line=ca', { CallSid: 'CAtw', From: '+15550100111', To: '+15550100199', CallStatus: 'ringing' })
  assert.match(r.body, /<Record /)
  assert.doesNotMatch(r.body, /Reject/)
  const o = await post('/voice/outbound', { CallSid: 'CAtwo', From: 'client:tester', To: '+306941234567', line: 'ca' })
  assert.match(o.body, /<Dial callerId="\+15550100199" answerOnBridge="true" timeout="45" action="[^"]+" method="POST"><Number>\+306941234567<\/Number><\/Dial>/)
})
await t('a push without relay keys keeps them; state lists accounts without secrets', async () => {
  const { sipAccounts, relay, ...old } = config
  await priv('/config', 'PUT', { settings: old })
  const stored = JSON.parse(readFileSync(join(dir, 'hookd-config.json'), 'utf8'))
  assert.equal(stored.sipAccounts.length, 1)
  assert.equal(stored.relay.bindAddress, '127.0.0.1')
  const st = await priv('/state')
  assert.equal(st.sipAccounts[0].id, 'acme')
  assert.deepEqual(st.sipAccounts[0].issues, [])
  assert.ok(!JSON.stringify(st).includes('pw-from-file'))
  const rs = await priv('/relay/status')
  assert.deepEqual(rs.relay.registrations.map(x => x.status), ['Registered', 'Rejected'])
  assert.ok(!JSON.stringify(rs).includes('pw-from-file'))
})

await t('daemon errors carry the standard body and keep status and legacy text', async () => {
  const raw = (path, method = 'POST', body, headers = { 'content-type': 'application/json' }) => new Promise((res, rej) => {
    const req = http.request({ socketPath: join(dir, 'hookd.sock'), path, method, headers }, (r) => {
      let d = ''; r.on('data', c => { d += c }); r.on('end', () => res({ status: r.statusCode, body: JSON.parse(d), cache: r.headers['cache-control'] }))
    })
    req.on('error', rej); req.end(body)
  })
  const std = (b, code) => { assert.equal(b.ok, false); assert.equal(b.code, code); assert.match(b.docs, new RegExp('^docs/ERRORS\\.md#' + code.toLowerCase() + '$')); assert.ok(b.message && b.hint) }
  let r = await raw('/nope', 'GET')
  assert.equal(r.status, 404); assert.equal(r.body.error, 'not found'); std(r.body, 'PHONE_NOT_FOUND'); assert.equal(r.cache, 'no-store')
  r = await raw('/mode', 'POST', JSON.stringify({ mode: 'sleepy' }))
  assert.equal(r.status, 400); assert.equal(r.body.error, 'mode must be live, voicemail or dnd'); std(r.body, 'PHONE_MODE_INVALID')
  r = await raw('/mode', 'POST', '{not json')
  assert.equal(r.status, 400); std(r.body, 'PHONE_BODY_INVALID'); assert.ok(r.body.error.length > 0)
  r = await raw('/sms/send', 'POST', JSON.stringify({ to: 'abc', body: 'hi', line: 'ca' }))
  assert.equal(r.status, 400); std(r.body, 'PHONE_NUMBER_INVALID'); assert.match(r.body.error, /^not a valid phone number: abc/)
  r = await raw('/pickup', 'POST', JSON.stringify({ vmId: 99999 }))
  assert.equal(r.status, 400); assert.equal(r.body.error, 'voicemail not found'); std(r.body, 'PHONE_VOICEMAIL_NOT_FOUND')
  r = await raw('/voicemail/audio?id=99999', 'GET')
  assert.equal(r.status, 404); assert.equal(r.body.error, 'no audio'); std(r.body, 'PHONE_VOICEMAIL_NO_AUDIO')
})
await t('public webhook refusals keep their status and now explain themselves', async () => {
  const bad = await post('/voice/incoming', { CallSid: 'CAbad', From: '+15550100', To: '+15550000000' }, { sign: false })
  assert.equal(bad.status, 403)
  const b = JSON.parse(bad.body)
  assert.equal(b.ok, false); assert.equal(b.code, 'PHONE_SIGNATURE_INVALID'); assert.equal(b.docs, 'docs/ERRORS.md#phone_signature_invalid')
  const nf = await post('/voice/doesnotexist', { A: '1' })
  assert.equal(nf.status, 404); assert.equal(JSON.parse(nf.body).code, 'PHONE_NOT_FOUND')
  assert.match(childOut, /PHONE_SIGNATURE_INVALID rejected unsigned\/invalid webhook \/voice\/incoming/)
  assert.ok(!childOut.includes(TOKEN), 'no secret in the daemon log')
})

child.kill('SIGTERM')
await sleep(200)
ami.server.close()
if (process.exitCode) console.error('--- hookd output ---\n' + childOut)
rmSync(dir, { recursive: true, force: true })
console.log(`\nrelay tests: ${passed} passed` + (process.exitCode ? ', SOME FAILED' : ''))
process.exit(process.exitCode || 0)
