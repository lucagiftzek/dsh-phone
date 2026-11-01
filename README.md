# dsh-phone

A phone in the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web GUI. It adds a **Phone** tab to the sidebar ([dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)) where you can:

- **Text**: SMS threads, send and receive, delivery status, MMS pictures, segment counter (GSM-7 / Unicode).
- **Call**: place and answer calls in the browser, mute, keypad (DTMF), call log. **Call audio goes through your server by default** ("Via server": one encrypted wss socket to the DSH origin, so it works on networks that block WebRTC and the browser talks to no third party); **Direct** (WebRTC to Twilio through the Twilio Voice SDK) stays one click away. A **Test audio** button checks a network without placing a call.
- **Choose how calls reach you**, with one switch:
  - **Live**: calls ring this browser (and optionally a mobile, which must press 1 so its own voicemail cannot steal the call). Unanswered calls go to voicemail.
  - **Voicemail**: every call goes to voicemail. While the caller speaks you see a **live transcript** and can **Pick up** (hot answer), like iOS Live Voicemail.
  - **Do not disturb**: calls go to voicemail and nothing rings, chimes or notifies. Starred contacts can still ring. Optional auto reply by SMS.
- **Voicemail**: greeting (spoken or an audio file), recording stored on your server, final transcript by a **local Whisper** endpoint (good Greek, free) or Mistral Voxtral, and the recording is deleted from the provider.
- **Contacts**: names, starred (breaks through DND), blocked (rejected).
- **Agent tools** so a model can work the phone: `phone_status`, `phone_set_mode`, `phone_sms_threads`, `phone_sms_thread`, `phone_sms_send`, `phone_calls`, `phone_voicemails`, `phone_contacts`, `phone_call_say`, and the read-only `phone_doctor`. Sending an SMS or placing a spoken alert call always returns a **draft first** and needs `confirm: true`.
- **Everything is configured from DSH Settings > Phone** (or the gear in the tab): lines, credentials, webhooks, voicemail, notifications, agent permissions. **Apply to Twilio** creates the API key and the TwiML App and points every number's voice and SMS webhooks at your server, then a status checklist verifies each piece end to end.

dsh-phone is provider-agnostic by design. **Twilio is the first adapter** (done, tested on a real line). Next: any **SIP account or trunk** through a relay on your server (for example an existing landline from a local VoIP provider), Twilio-compatible **SignalWire**, then Telnyx, Vonage, Plivo and SMS gateways. A SIP account (an existing landline) can join through an Asterisk relay in bridge mode: **[docs/RELAY.md](docs/RELAY.md)**. See **[docs/PROVIDERS.md](docs/PROVIDERS.md)** for every option, the standards behind each setting (SIP, WebRTC, SRTP, codecs, DTMF, E.164, SMS encodings) and which setup to pick.

## How it fits together

```
 Browser (DSH web UI)                         Your server                               Twilio
 ───────────────────                          ───────────                               ──────
 Phone tab + call overlay ──/dsh-phone/api──▶ dsh-web: dsh-phone plugin  ──unix socket──▶ phone-hookd ◀──signed webhooks── voice + SMS
   (behind your login)        (gated)          settings, tools, gates        (0600)        SQLite, TwiML,  ──REST──────────▶ calls, SMS,
 Twilio Voice SDK  ◀════════════════════════ WebRTC media ═══════════════════════════════════ recordings,                       recordings
                                                                                           local Whisper
```

- **phone-hookd** (`daemon/hookd.mjs`) is a small Node service that owns the database and talks to the provider. It has two listeners:
  - a **public** one (`127.0.0.1:3098`, exposed only as `https://<host>/phone-hook/`) for provider webhooks. Every request must carry a valid `X-Twilio-Signature`; anything else gets 403.
  - a **private** unix socket (`~/.dsh/phone/hookd.sock`, mode 0600) used only by the plugin.
  It runs outside the web UI on purpose: calls still reach voicemail and texts still arrive while the UI restarts.
- **The plugin** (`lib/index.js`) runs inside dsh-web. It registers the settings, the agent tools and `/dsh-phone/api/*`, where every request passes the same four gates as dsh-mail / dsh-hpc (loopback peer, same-origin trust fence, short-lived capability token, harness session cookie) before it is forwarded to the socket. It also serves the Voice SDK locally (no CDN).
- **The browser half** (`src/client.jsx`, built to `lib/client.js`) starts one phone service per page: live events (SSE), the Twilio Device, a WebAudio ringtone, browser notifications, and an overlay for incoming calls, the active call, live voicemail and toasts, visible whichever tab is open.

## Install

Requirements: DSH web with `dsh-better-sidebar`, Node 22.5+ (for `node:sqlite`), a Twilio account with a voice + SMS number, and a public HTTPS hostname your reverse proxy can route to a loopback port.

```bash
git clone https://github.com/lucagiftzek/dsh-phone && cd dsh-phone
npm install && npm run build && npm test

# 1. the daemon (edit YOUR_USER, the node path and the repo path first)
sudo install -m 644 deploy/dsh-phone-hookd.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now dsh-phone-hookd

# 2. the public webhook route: send ONLY /phone-hook/ to 127.0.0.1:3098, without your login
#    middleware (see deploy/traefik-phone-hook.yml for a Traefik example)

# 3. the plugin, in your DSH web profile: link the checkout (the daemon runs from it too)
dsh plugin --profile web add link:$PWD   # then restart dsh web
```

Plugin only (the Phone tab and agent tools, when the daemon runs elsewhere): `dsh plugin --profile web add github:lucagiftzek/dsh-phone`. The package declares `dsh.bundle`, so `dsh plugin add` lists it in the profile bundles.

Then open **Settings > Phone**: put the account SID and auth token in the fields or in a `KEY=value` credentials file (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`; default `~/.config/twilio/credentials`), add your number as a line (or pick it from "Numbers on the Twilio account"), set the public webhook base URL, **Save**, then **Apply to Twilio**. The checklist should go green, and the browser registers so calls can ring.

## Call audio: Via server (default) or Direct

With **Via server** the browser captures the microphone (echo cancellation, noise suppression and auto gain on), encodes G.711 mu-law in an AudioWorklet and sends 20 ms blocks over ONE wss socket to the DSH origin (`/dsh-phone/api/io`, about 70 kbit/s each way at the default 40 ms per message); far audio plays through a small adaptive jitter buffer. No Twilio SDK, CDN, STUN or TURN is loaded. phone-hookd bridges the socket to the call:

- **SIP lines** (an Asterisk relay): hookd originates an AudioSocket channel over AMI into a generated context that applies the line's destination policy and dials the provider. Audio between Asterisk and hookd stays on 127.0.0.1. Twilio is not involved.
- **Twilio lines** and **every incoming call you answer here**: a bidirectional Twilio Media Stream (`<Connect><Stream>`, mu-law 8 kHz) to `wss://<host>/phone-hook/s`, accepted only with a valid `X-Twilio-Signature` over the wss URL and a one-time ticket bound to the CallSid. Incoming calls ring the Phone tab through the event stream while the caller hears ringback from the server; unanswered or declined calls go to voicemail as before, and **Pick up** on a live voicemail works the same way.
- Per-call audio stats (route, packets and bytes each way, jitter, first-audio time, end reason) are stored with the call log row, so a silent call can be diagnosed from the server. Nothing is recorded beyond the voicemail you already have.
- Limits: `audio.maxCalls` (default 2) calls and `audio.maxTests` (2) tests at once; a dropped browser socket keeps the call for 15 s while the tab reconnects.

Choose the route per browser in the Phone tab (Keypad, "Call audio"), or set the default with `audio.route`.

## Settings (namespace `dsh-phone`)

| Key | Default | Meaning |
|---|---|---|
| `publicBaseUrl` | empty (required) | What Twilio calls, e.g. `https://your-host/phone-hook`. Must reach phone-hookd's public listener. |
| `trustedHosts` | `[]` | Public hostnames the browser uses for the UI (loopback is always trusted). |
| `identity` | `owner` | The browser client identity that rings. |
| `defaultCountry` | empty | Prefix for numbers typed without one (`+30`). |
| `lines[]` | `[]` | `{ id, label, provider: twilio, number, numberSid, sms, voice, enabled }` |
| `twilio.*` | empty | `accountSid`, `authToken`, `apiKeySid`, `apiKeySecret`, `twimlAppSid`, `edge`, `credentialsFile`. Empty fields fall back to the credentials file, then to what Apply created (`~/.dsh/phone/provisioned.json`, 0600). |
| `incoming.*` | live, 25 s | `defaultMode`, `ringSeconds`, `forwardTo`, `dndBypassStarred`, `rejectAnonymous` |
| `voicemail.*` | on | greeting text / voice / language / audio URL, `maxSeconds`, `liveTranscript` (+ `liveLanguage`, `liveEngine`, `liveModel`), `transcriber` (`local`, `mistral`, `off`), `localUrl` + `localCredentialsFile` (KEY=value with `TTS_BASE_URL`, `TTS_API_KEY`) for the local Whisper endpoint, `deleteFromProvider` |
| `sms.dndAutoReply` | empty | Sent once per sender per 12 h while DND is on. |
| `notifications.*` | all on | `sound`, `browser`, `toasts` |
| `agent.*` | all on | `allowSms`, `allowCalls`, `allowModeChange` |
| `audio.*` | server | `route` (`server` or `direct`), `maxCalls` (2), `maxTests` (2), `packetMs` (20, 40, 60), `jitterMinMs` / `jitterMaxMs` (40 / 400), `testSeconds` (30), `audioSocketPort` (9093, loopback), `ringbackTone` (`eu`, `us`, `uk`, empty = from the line number) |

The incoming-call **mode** itself is runtime state (the switch in the tab, or `phone_set_mode`), so flipping it never rewrites your settings file. `incoming.defaultMode` only applies to a fresh database.

## Costs (Twilio, late 2026)

Calls on the server route over a Twilio line are billed as a normal PSTN call plus Media Streams (0.0044 USD per minute); SIP-line calls on the server route do not touch Twilio at all. Direct browser calls are billed as Twilio Client minutes plus the PSTN leg; SMS per segment (Greek lowercase is Unicode: 70 characters per segment); the live voicemail transcript uses Twilio real-time transcription (about 0.027 USD per minute, voicemail only); the final transcript is local and free; recordings are deleted from Twilio after download, so there is no storage charge.

## Notes

- A Canadian long code is not part of US A2P 10DLC; texts to US mobiles may still be filtered. Texts to Greece and the EU work but cost more per segment.
- Greek live transcripts: set `voicemail.liveLanguage` to `el-GR` and `voicemail.liveModel` to `chirp_2`. The final transcript (local Whisper) detects the language by itself.
- The first call asks for microphone permission. Use **Allow** in the status checklist for background notifications.

## Telegram

A Telegram account on the server, in its own Phone tab section: chats, groups and channels, photos, voice messages (transcribed by the voicemail engine) and files, channel posts, 1:1 voice calls on the server audio route, and `telegram_*` agent tools, with the browser talking only to the DSH origin. A Go daemon (`telegramd/`, MTProto via gotd/td) holds the account behind a private unix socket.

Setup in short (details in [docs/TELEGRAM.md](docs/TELEGRAM.md)):

1. In the Telegram app, turn on Two-Step Verification (a cloud password and a recovery email) before anything else.
2. Create your own API credentials at https://my.telegram.org (API development tools) and put them in `~/.dsh/phone/telegram/api.env` (0600) as `TELEGRAM_API_ID=...` and `TELEGRAM_API_HASH=...`, or in Settings. Never use a sample or published api_id.
3. Build and start `telegramd` (`deploy/dsh-telegramd.service` is an example unit), then log in from Settings, Phone, Telegram: **QR code** (Telegram app, Settings, Devices, Link Desktop Device) or the login code, then the cloud password.

Terms caveat: Telegram watches accounts that log in through third-party API clients, and flooding or spam gets an account banned. The agent tools therefore only write to existing conversations or allowlisted chats, with rate limits, an audit log and a kill switch; read "Rules for automated use" in docs/TELEGRAM.md before you enable agent sending. Use it on your own account at your own risk.

Voice calls use [ntgcalls](https://github.com/pytgcalls/ntgcalls) (`libntgcalls`, LGPL-3.0). It is **not** part of this repository: `telegramd/scripts/fetch-ntgcalls.sh` downloads the pinned release (v3.0.5) and checks its sha256, and `go build -tags ntgcalls` (cgo) links it dynamically, so you can replace the library with your own build. Without the build tag, telegramd builds as pure Go and calls report that the engine is missing; chats, media and transcription work either way.

## Security

See [docs/SECURITY.md](docs/SECURITY.md). In short: the only unauthenticated path is the signature-checked webhook prefix, served by a hardened daemon that never reaches the web UI; secrets are never returned by any read endpoint; sending and calling from agents are opt-in and draft-first.

## Development

```bash
npm test            # signature (Twilio's published vector), JWT, TwiML, E.164, segments, settings, store
npm run build       # src/client.jsx -> lib/client.js (verified before it replaces the live file)
```

## When something goes wrong

- Ask your agent to load the **`phone-doctor`** skill (bundled in `skills/phone-doctor/`). The plugin registers it with the skills service at start, so it is offered after `dsh web` restarts. If your DSH does not list it, copy it once by hand: `P=$(node -p "require('path').dirname(require.resolve('dsh-phone/package.json',{paths:[(process.env.DSH_HOME||require('os').homedir()+'/.dsh')+'/profiles/web']}))"); mkdir -p "${DSH_HOME:-$HOME/.dsh}/skills" && cp -r "$P/skills/phone-doctor" "${DSH_HOME:-$HOME/.dsh}/skills/"` (see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md#start-here)).
- One-call self-check: `GET /dsh-phone/api/doctor` (same access rules as the other read routes) or the read-only agent tool `phone_doctor`. It reports settings mode, lines, provider credentials (set or missing, never the values), the public webhook URL (set or not), whether the hook daemon answers on its private socket, SIP account registrations and the media server configuration. It never calls the provider, never places a call or sends a text, and failing checks carry a `PHONE_*` code and a hint. The read-only commands in [section 0 of the troubleshooting guide](docs/TROUBLESHOOTING.md#t-facts) give the same facts by hand.
- Every error carries a stable `code`, and the daemon log lines start with it: [docs/ERRORS.md](docs/ERRORS.md).

MIT licence. The Twilio Voice SDK is Apache-2.0 and is served from `node_modules`, not committed. libntgcalls (optional, Telegram calls) is LGPL-3.0, fetched by a script and linked dynamically, never committed.

---

Built by Luca Tzekos, who also makes [**Job Opportunities API**](https://jobopportunitiesapi.org): employer-direct job data with per-field provenance you can verify yourself, free to read and available as an API. If dsh-phone is useful to you, a star on this repo or a look at [jobopportunitiesapi.org](https://jobopportunitiesapi.org) is the best thanks.
