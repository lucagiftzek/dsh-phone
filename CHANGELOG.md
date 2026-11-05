# Changelog

## 0.3.2 (2026-11-05)

- **Fix: Telegram chats with a photo album no longer fail to open.** Telegram album ids (grouped_id) are 64-bit and often above 2^53, and node:sqlite refused to read them back ("Value is too large to be represented as a JavaScript number"). The id is now kept as its exact decimal digits end to end (parsed from the JSON source text, stored as a decimal string, always read back with CAST(... AS TEXT)). Existing rows keep working.

## 0.3.1 (2026-11-02)

- **Fix: white text on a white button in dark mode.** On a stock DSH theme in dark mode the host primary colour is near white, but the Send and other primary buttons, the outgoing SMS bubble and the unread badges had hard-coded white text. They now use the host's paired foreground token (`--dsw-alias-label-primary-foreground`, white as the fallback), so they read in light and dark and with custom themes; a muted Telegram badge uses the background colour on its grey.
- **Fix: the SIP relay never writes into a directory it does not own.** phone-hookd wrote its Asterisk include files into `/etc/asterisk/dsh-phone` whenever that directory existed, even with no SIP account configured, so a second install on the same machine (a test instance) could overwrite the real relay. Now nothing is written unless the relay is enabled AND at least one SIP account exists; the include directory (`relay.configDir`) defaults to a private folder of each instance (`<phone data dir>/asterisk`); every generated file starts with an instance marker (`; dsh-phone-instance: <id>`, the id lives in `relay.json`) and an instance refuses to write over files with another instance's marker (new code PHONE_RELAY_DIR_FOREIGN). Files written by an older build are adopted on the first sync without an Asterisk reload.
- **Upgrading with a running relay:** if you rely on the old default, set **Include directory** to `/etc/asterisk/dsh-phone` in Settings > Phone (installs that saved their settings already have it stored).

## 0.3.0 (2026-11-02)

- **Telegram:** a Telegram account on the server (Go daemon `telegramd`, private unix socket only), chats, groups, channels and media in the Phone tab, login by QR code or code plus cloud password, `telegram_*` agent tools with conversation-only sending, rate limits, audit log and kill switch. See docs/TELEGRAM.md.
- **Telegram voice calls:** in and out on the Phone tab over the server audio route (telegramd + libntgcalls 3.0.5, relays only, DH checks, emoji key on the call screen); per mode: DND declines, voicemail declines and texts once per 12 h, live with no tab ignores, each with an ignore or decline alternative in Settings; telegram_call places and answers through the tab.
- **Telegram voice message transcription:** voice and video messages are transcribed in the background by the voicemail engine (local Whisper by default), language detected, cached per audio, silence skipped; transcript under the voice note in the Phone tab with Transcribe and Retry buttons, in `telegram_read` results, and settings for auto on or off and the longest message.

## 0.2.0 (2026-11-01)

- **Call audio through the server (new default).** The browser keeps one wss socket to the server; phone-hookd bridges it to Asterisk AudioSocket for SIP lines or to Twilio Media Streams for Twilio lines, incoming calls and pick up. A Test audio loopback and per-call audio stats. Direct WebRTC from the browser stays available as an option.
- **SIP relay (bridge mode).** Register SIP accounts from a residential or business VoIP provider through Asterisk and bridge them into a Twilio SIP Domain, so a second line rings in the Phone tab and can call out. TLS and SRTP towards Twilio, a dedicated call socket per account, a registration watchdog, and outgoing calls behind NAT with a public TLS contact.
- **Settings on DSH 0.1.5 and 0.2.x** from one code base (dual store, live `Config` export, one-time legacy import).
- **Troubleshooting:** stable `PHONE_*` error codes on routes, the hook daemon and logs; agent tool errors in the standard `{ code, message, hint, docs }` shape; `GET /dsh-phone/api/doctor` and the read-only `phone_doctor` tool; the `phone-doctor` skill registered at start; docs/TROUBLESHOOTING.md and docs/ERRORS.md.
- **Fix:** on DSH 0.2.1 the phone tools failed with "value is not lossless JSON"; results are sanitized at the tool boundary.

## 0.1.0

First public release: SMS, browser calls over Twilio Voice, live voicemail with transcripts, do not disturb, agent tools.
