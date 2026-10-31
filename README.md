# dsh-phone

A phone in the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web GUI. It adds a **Phone** tab to the sidebar ([dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)) where you can:

- **Text**: SMS threads, send and receive, delivery status, MMS pictures, segment counter (GSM-7 / Unicode).
- **Call**: place and answer calls in the browser (WebRTC through the Twilio Voice SDK), mute, keypad (DTMF), call log.
- **Choose how calls reach you**, with one switch:
  - **Live**: calls ring this browser (and optionally a mobile, which must press 1 so its own voicemail cannot steal the call). Unanswered calls go to voicemail.
  - **Voicemail**: every call goes to voicemail. While the caller speaks you see a **live transcript** and can **Pick up** (hot answer), like iOS Live Voicemail.
  - **Do not disturb**: calls go to voicemail and nothing rings, chimes or notifies. Starred contacts can still ring. Optional auto reply by SMS.
- **Voicemail**: greeting (spoken or an audio file), recording stored on your server, final transcript by a **local Whisper** endpoint (good Greek, free) or Mistral Voxtral, and the recording is deleted from the provider.
- **Contacts**: names, starred (breaks through DND), blocked (rejected).
- **Agent tools** so a model can work the phone: `phone_status`, `phone_set_mode`, `phone_sms_threads`, `phone_sms_thread`, `phone_sms_send`, `phone_calls`, `phone_voicemails`, `phone_contacts`, `phone_call_say`. Sending an SMS or placing a spoken alert call always returns a **draft first** and needs `confirm: true`.
- **Everything is configured from DSH Settings > Phone** (or the gear in the tab): lines, credentials, webhooks, voicemail, notifications, agent permissions. **Apply to Twilio** creates the API key and the TwiML App and points every number's voice and SMS webhooks at your server, then a status checklist verifies each piece end to end.

dsh-phone is provider-agnostic by design. **Twilio is the first adapter** (done, tested on a real line). Next: any **SIP account or trunk** through a relay on your server (for example an existing landline from a local VoIP provider), Twilio-compatible **SignalWire**, then Telnyx, Vonage, Plivo and SMS gateways. See **[docs/PROVIDERS.md](docs/PROVIDERS.md)** for every option, the standards behind each setting (SIP, WebRTC, SRTP, codecs, DTMF, E.164, SMS encodings) and which setup to pick.

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

# 3. the plugin, in your DSH web profile (~/.dsh/profiles/web/package.json)
#    "dependencies": { "dsh-phone": "link:/path/to/dsh-phone" }, and add "dsh-phone" to dsh.profile.bundles
pnpm install   # in the profile, then restart dsh web
```

Then open **Settings > Phone**: put the account SID and auth token in the fields or in a `KEY=value` credentials file (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`; default `~/.config/twilio/credentials`), add your number as a line (or pick it from "Numbers on the Twilio account"), set the public webhook base URL, **Save**, then **Apply to Twilio**. The checklist should go green, and the browser registers so calls can ring.

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

The incoming-call **mode** itself is runtime state (the switch in the tab, or `phone_set_mode`), so flipping it never rewrites your settings file. `incoming.defaultMode` only applies to a fresh database.

## Costs (Twilio, late 2026)

Browser calls are billed as Twilio Client minutes plus the PSTN leg; SMS per segment (Greek lowercase is Unicode: 70 characters per segment); the live voicemail transcript uses Twilio real-time transcription (about 0.027 USD per minute, voicemail only); the final transcript is local and free; recordings are deleted from Twilio after download, so there is no storage charge.

## Notes

- A Canadian long code is not part of US A2P 10DLC; texts to US mobiles may still be filtered. Texts to Greece and the EU work but cost more per segment.
- Greek live transcripts: set `voicemail.liveLanguage` to `el-GR` and `voicemail.liveModel` to `chirp_2`. The final transcript (local Whisper) detects the language by itself.
- The first call asks for microphone permission. Use **Allow** in the status checklist for background notifications.

## Security

See [docs/SECURITY.md](docs/SECURITY.md). In short: the only unauthenticated path is the signature-checked webhook prefix, served by a hardened daemon that never reaches the web UI; secrets are never returned by any read endpoint; sending and calling from agents are opt-in and draft-first.

## Development

```bash
npm test            # signature (Twilio's published vector), JWT, TwiML, E.164, segments, settings, store
npm run build       # src/client.jsx -> lib/client.js (verified before it replaces the live file)
```

MIT licence. The Twilio Voice SDK is Apache-2.0 and is served from `node_modules`, not committed.

---

Built by Luca Tzekos, who also makes [**Job Opportunities API**](https://jobopportunitiesapi.org): employer-direct job data with per-field provenance you can verify yourself, free to read and available as an API. If dsh-phone is useful to you, a star on this repo or a look at [jobopportunitiesapi.org](https://jobopportunitiesapi.org) is the best thanks.
