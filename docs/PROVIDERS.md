# Providers, standards and options

dsh-phone is meant to work with whatever phone service a DSH user already has. This page lists the ways a browser can reach the phone network, the providers in each family, the standards behind every setting, and what is implemented today.

Status legend: **done** (in this release, tested on a real line), **next** (being built), **planned** (designed, not started), **listed** (possible, no work planned yet).

## 1. Three ways to connect

| Style | How it works | Good for | What you need |
|---|---|---|---|
| **A. CPaaS** (programmable voice + SMS) | The provider owns the number, the phone network and the media servers. phone-hookd answers its webhooks with call-control markup (TwiML and friends); the browser joins calls through the provider's WebRTC SDK. | Quickest start, SMS and voice from one account, no telephony server to run. | An account and a number at the provider, a public HTTPS hostname for webhooks. |
| **B. SIP account or trunk + relay** | Any provider that speaks SIP (residential VoIP, business trunks, your own PBX). Browsers cannot speak plain SIP over UDP, so a relay (Asterisk) holds the registration and either bridges calls into a style-A line (**bridge mode**) or offers WebRTC to the browser itself (**direct mode**, SIP over WebSocket). | Keeping an existing number (a landline, an office DID), lowest per-minute prices, countries a CPaaS does not cover, full self-hosting. | SIP credentials (registrar, username, password) or an IP-authenticated trunk; for direct mode a TURN server so media crosses NAT. |
| **C. SMS gateway** | An HTTP API (or SMPP) that sends and receives texts only. Pairs with A or B for the voice side. | Lines whose provider has no SMS (most landlines), bulk or alphanumeric senders, cheaper SMS routes. | An API key; an inbound webhook if the gateway supports replies. |

## 2. Support matrix

### A. CPaaS providers

| Provider | Call-control markup | Browser calling | SMS / MMS | Webhook signature | Status |
|---|---|---|---|---|---|
| **Twilio** | TwiML | Twilio Voice JS SDK (WebRTC) | yes / yes (US, CA) | `X-Twilio-Signature`, HMAC-SHA1 | **done** (reference adapter) |
| **SignalWire** | LaML (TwiML compatible; REST paths mirror Twilio's) | SIP endpoints or relay | yes / yes | `X-SignalWire-Signature`, same HMAC scheme | **next** (shares the Twilio adapter) |
| **Telnyx** | TeXML (TwiML-like) or Call Control API | `@telnyx/webrtc`, or SIP over WSS | yes / yes | Ed25519 (`telnyx-signature-ed25519` + timestamp) | planned |
| **Vonage** (Nexmo) | NCCO (JSON) | Vonage Client SDK | yes / limited | signed JWT on webhooks | planned |
| **Plivo** | Plivo XML | Plivo Browser SDK | yes / yes (US, CA) | `X-Plivo-Signature-V3` | planned |
| **Bandwidth** | BXML | WebRTC API | yes / yes (US) | basic auth on callbacks | listed |
| **Sinch**, **Infobip**, **Bird** (MessageBird) | provider JSON | provider SDKs | yes | provider specific | listed |
| **jambonz** (open source, self-hosted CPaaS) | jambonz verbs (JSON, webhook driven) | any SIP over WSS client | through carriers | shared secret | listed |
| **Fonoster** (open source Twilio alternative) | programmable voice API | SIP / WebRTC | through carriers | API keys | listed |

### B. SIP (any provider) through the relay

| Option | Status |
|---|---|
| SIP **account** with registration (REGISTER + digest auth): residential and small-business VoIP (for example Yuboto in Greece, VoIP.ms, sipgate, Zadarma, OVHcloud VoIP, Telnyx SIP connections) | **built** (bridge mode, see [RELAY.md](RELAY.md)): registration and call routing tested on a real line; behind NAT the RTP ports must be reachable |
| SIP **trunk** with IP authentication (no REGISTER): business trunks, Twilio Elastic SIP Trunking, Telnyx, Bandwidth | planned (same relay, `identify` by provider IPs) |
| **Bridge mode**: the relay forwards calls into a CPaaS line (Twilio SIP Domain with registration), so the landline gets the same browser phone, voicemail, live transcript, DND and logs. Small extra per-minute cost for the CPaaS SIP leg. | **built** ([RELAY.md](RELAY.md)) |
| **Direct mode**: the relay offers WebRTC (SIP over WSS, DTLS-SRTP) to an in-browser SIP client (SIP.js or JsSIP); voicemail and live transcripts handled by the relay + phone-hookd (Asterisk ARI). No CPaaS at all. | planned |
| Your own PBX (Asterisk, FreeSWITCH, FreePBX, 3CX, Wazo) as the "provider": register the relay as an extension or trunk | planned (same configuration as a SIP account) |
| Desk phones / softphones on the same relay (message-waiting light for voicemail, RFC 3842) | listed |

### C. SMS gateways

| Gateway | Notes | Status |
|---|---|---|
| Twilio, SignalWire, Telnyx, Vonage, Plivo | from the CPaaS line itself | Twilio **done**, rest follows the CPaaS adapters |
| **Yuboto Octapush** (Greece) | HTTP API; Viber and alphanumeric senders too | planned |
| **VoIP.ms** | SMS on the same DID as the SIP account (REST API + URL callback) | planned |
| **sipgate** | SMS from sipgate numbers (REST API) | listed |
| **Android phone as a gateway** (open source apps such as android-sms-gateway) | uses a real SIM, sends and receives over an HTTP API | listed |
| **SMPP 3.4** (bulk carriers) | binary protocol, long-lived bind; needs a small connector | listed |

## 3. Standards behind the settings

**Signalling (SIP)**
- SIP: RFC 3261. Transports: UDP or TCP on 5060, TLS on 5061 (`sips:`), WebSocket WS/WSS (RFC 7118) for browsers.
- Registration (REGISTER with a Contact and an expiry) versus IP-authenticated trunks. Digest authentication (RFC 8760); some providers want a separate auth username, a `From` domain, or an outbound proxy.
- NAT: `rport` (RFC 3581) and contact rewriting keep replies flowing through a home router; keepalives (OPTIONS or CRLF) keep the pinhole open. Media NAT traversal: STUN (RFC 8489), TURN (RFC 8656), ICE (RFC 8445).
- Session timers (RFC 4028), PRACK / early media (RFC 3262), REFER transfers (RFC 3515): exposed only where a provider needs them.

**Media**
- RTP / RTCP (RFC 3550). Encryption: SRTP (RFC 3711) keyed by SDES (RFC 4568) on SIP trunks, or DTLS-SRTP (RFC 5764), which WebRTC requires.
- Codecs: **Opus** (WebRTC, wideband), **G.711 PCMU / PCMA** (every phone network; PCMA in Europe), **G.722** (HD voice), G.729 (low bandwidth), iLBC, GSM. The relay transcodes between the browser (Opus) and the carrier (usually G.711).
- DTMF (keypad tones): RFC 4733 `telephone-event` (preferred), SIP INFO, or in-band audio.

**Numbers and caller ID**
- E.164 (`+` country code + number). National numbers are completed with the `defaultCountry` setting.
- Caller ID (CLI) is set by the line; providers only allow numbers you own or have verified. Caller-ID attestation: STIR/SHAKEN (US, Canada). Many countries block foreign routes that present a national caller ID (anti-spoofing), so present a line's own number.
- CNAM (caller name) lookups exist in North America only.

**Messaging**
- SMS segments: GSM 03.38 7-bit (160 characters, 153 when split) versus UCS-2 for any other script (70, 67 when split); Greek lowercase forces UCS-2. The composer shows the count before sending.
- MMS (pictures) mostly US and Canada. Alphanumeric sender IDs (one-way) in most of Europe. US rules: A2P 10DLC registration for US long codes, toll-free verification for toll-free senders. RCS business messaging is listed for later.

**Call control markups**: TwiML (Twilio), LaML (SignalWire), TeXML (Telnyx), NCCO (Vonage), Plivo XML, BXML (Bandwidth), jambonz verbs, and the older W3C VoiceXML. phone-hookd keeps its call logic (ring, voicemail, pick up, DND) provider neutral and renders it to the markup of each adapter.

**Voicemail**: recording (MP3 / WAV), final transcript by a local Whisper endpoint (any ElevenLabs-compatible `/v1/speech-to-text`) or Mistral Voxtral, live transcript by the provider's real-time transcription (Twilio today) or, in direct SIP mode, by streaming the caller's audio to a local recogniser.

**Emergency calls**: a browser phone is not a reliable way to reach 112 / 911 (no fixed location, depends on the page being open). Keep another phone for emergencies.

## 4. Settings, per family

| Family | Settings |
|---|---|
| CPaaS | account id / key / secret (or a credentials file), number and its provider id, region or edge, webhook base URL; **Apply** sets the provider-side webhooks |
| SIP account / trunk | registrar host, port, transport (UDP / TCP / TLS), username, auth username, password, `From` domain, outbound proxy, registration expiry, keepalive interval, DID (the number that rings), caller ID, codecs (ordered), DTMF mode, SRTP (off / SDES / required), NAT (external address, STUN server), mode (bridge into a CPaaS line, or direct WebRTC with a TURN server) |
| SMS gateway | gateway type, API key / secret, sender (number or alphanumeric), inbound webhook secret |

## 5. Which setup should I pick?

1. **Fastest**: a Twilio number (style A). Ten minutes from zero to calls and texts in the sidebar.
2. **Keep the number you already have**: register it through the relay (style B). Bridge mode gives every feature at once if you also have a CPaaS line; direct mode avoids a CPaaS completely.
3. **Lowest running cost**: a local SIP provider in direct mode, plus an SMS gateway if you need texts.
4. **Fully self-hosted**: your own Asterisk / FreeSWITCH or jambonz with a SIP trunk.

Corrections and provider adapters are welcome as pull requests: an adapter implements number provisioning, sending SMS, verifying webhooks, rendering the neutral call plan to its markup, and (optionally) minting browser tokens.
