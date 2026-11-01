---
name: phone-doctor
description: Diagnose and fix dsh-phone problems step by step (Phone tab missing, webhooks rejected, provider Apply, browser calls, SMS, voicemail transcripts, SIP relay audio). Load it when a /dsh-phone/api route or the phone-hookd daemon returns a PHONE_* code, or the user reports that calls, texts or voicemail do not work.
---

# dsh-phone doctor

Two processes: the **plugin** (inside `dsh web`, routes under `/dsh-phone/api/`) and the **daemon** `phone-hookd` (own service, public webhook listener plus a private unix socket). Most symptoms are one of: plugin not loaded, daemon not running, webhooks not reaching the daemon, wrong credentials.

## Rules
- Read-only checks first. Never print secrets: do not cat credentials files, `provisioned.json`, `hookd-config.json`, `relay.json`, the settings file or the profile patch. Read a secret into a command, never echo it.
- Never restart `dsh web` yourself: the chat you are in may run inside it. Ask the human. Restarting the daemon or the media server is also a [HUMAN] step.
- Never place calls or send texts to test (they cost money and ring people). Use the existing state, check and log views.
- Steps marked [HUMAN] need the human (router, provider console, money, restart, other people).
- Stop and report after a fix; verify with the step given.
- Start with the doctor: tool `phone_doctor` or `GET /dsh-phone/api/doctor` (read-only, no secrets, no provider calls). Its failing checks carry a `PHONE_*` code; the commands below give the same facts by hand when the plugin answers 404 or the tool is missing.

## 0. Facts (read-only)
Placeholders: `<dsh-url>` (for example `http://127.0.0.1:3080`), `<public-base-url>` (the `publicBaseUrl` setting). Run on the DSH machine.
1. Plugin dir and docs: `node -p "require('path').dirname(require.resolve('dsh-phone/package.json',{paths:[(process.env.DSH_HOME||require('os').homedir()+'/.dsh')+'/profiles/web']}))"` then read `docs/TROUBLESHOOTING.md` and `docs/ERRORS.md` there.
2. Doctor (one call): `curl -s <dsh-url>/dsh-phone/api/doctor`; read `status` and every check that is not `ok` or `skip`.
3. Plugin loaded and settings store: `curl -s <dsh-url>/dsh-phone/api/settings` (look at `version`, `store`; do not paste `settings`).
4. State, setup issues, relay: `curl -s <dsh-url>/dsh-phone/api/state` and print only `ready`, `issues`, `mode`, `browserOnline`, `relay`, `sipAccounts[].issues` (the full body is safe but long; credentials show only `set` and `source`).
5. Daemon alive: `curl -s --unix-socket "${DSH_HOME:-$HOME/.dsh}/phone/hookd.sock" http://localhost/health`.
6. Public endpoint: `curl -s -o /dev/null -w '%{http_code}\n' <public-base-url>/health` (expect 200).
7. Provider and relay check (read-only GETs): `curl -s <dsh-url>/dsh-phone/api/provider/check`, `curl -s <dsh-url>/dsh-phone/api/relay/status`.
8. Daemon log: `journalctl -u dsh-phone-hookd --since "1 hour ago" | grep -E 'PHONE_[A-Z_]+' | tail -40`.

## 1. Decision tree
Start from what you observe.
- **Any `/dsh-phone/api/*` answers 404, or the Phone tab or Settings is missing** -> plugin not loaded or `dsh web` not restarted after an update: TROUBLESHOOTING entry 1, then C1 and C2. Ask the human to restart `dsh web` [HUMAN].
- **Error code `PHONE_HOOKD_UNAVAILABLE` or `PHONE_HOOKD_TIMEOUT`** -> the plugin is loaded, the daemon is down or stuck: `systemctl status dsh-phone-hookd`, `journalctl -u dsh-phone-hookd -n 60`. Starting the service is [HUMAN] unless the human allowed it.
- **`PHONE_HOOKD_ERROR`** -> daemon older than the plugin: entry 14 [HUMAN].
- **`PHONE_SIGNATURE_INVALID`, calls or texts never appear** -> entry 2 and C9. Probe `curl -s -X POST <public-base-url>/voice/incoming`: `403` + this code is healthy; `302` or `401` is a login gate in front of the webhook path [HUMAN]; real provider traffic refused means `publicBaseUrl` differs from what the provider calls (scheme, host, port, path) or the proxy rewrites it [HUMAN for the proxy].
- **`PHONE_PROVIDER_AUTH_FAILED`, `PHONE_PROVIDER_NOT_CONFIGURED`, Apply fails** -> entry 3: the account SID and the main auth token (not an API key secret). Ask the human to fix the credentials [HUMAN]; never ask them to paste the token into chat.
- **`PHONE_PUBLIC_URL_MISSING`** -> set `publicBaseUrl` (entry 2, 3).
- **`PHONE_VOICE_TOKEN_INCOMPLETE`, browser does not ring, device error** -> entry 4: Apply, microphone permission, HTTPS or localhost, mode Live, `browserOnline` true.
- **`PHONE_TOKEN_INVALID`, `PHONE_SESSION_COOKIE_MISSING`, `PHONE_HOST_UNTRUSTED`, `PHONE_PEER_NOT_LOOPBACK`** -> the request gate; reload the Phone tab or call from the DSH machine; add the public host to `trustedHosts` (entries 4, 7).
- **`PHONE_AGENT_ACTION_DISABLED`** (a tool refused) -> the human switched that action off for agents in Settings > Phone > Agent. Do not work around it; tell the human which switch blocks it [HUMAN].
- **`PHONE_SETTINGS_UNAVAILABLE`, settings reset** -> entry 7 and C3.
- **`PHONE_SMS_DELIVERY_FAILED`, `PHONE_LINE_UNAVAILABLE`, `PHONE_NUMBER_INVALID`** -> entry 5: read the provider error code in the log line; sender type and country filtering are provider-console fixes [HUMAN].
- **`PHONE_TRANSCRIBE_FAILED`, `PHONE_LIVE_TRANSCRIPT_FAILED`, `PHONE_RECORDING_DOWNLOAD_FAILED`** -> entry 6: local speech-to-text endpoint, language and model, credentials.
- **SIP relay symptoms** (only when a SIP account is configured):
  - connects but no audio -> entry 8 and C10: capture with `sudo tcpdump -ni any udp portrange 10000-10100 -c 50` during one human-placed test call [HUMAN places the call]. Fix is a router port forward [HUMAN], SIP ALG off [HUMAN], or `relay.bridgeTransport: tls` (SIP over TLS 5061 with SRTP).
  - every call 503 -> entry 9: `grep -n -i maxload /etc/asterisk/asterisk.conf` [HUMAN edits].
  - registration fails, `PHONE_RELAY_*` -> entry 10: `curl .../relay/status`, `sudo asterisk -rx 'pjsip show registrations'`.
  - rings or forks twice after a restart -> entry 11; other phone answers first -> entry 12 (lower `ringFirstSeconds`); a transport change has no effect -> entry 13 (media server restart [HUMAN]).
- **Unknown code, `PHONE_INTERNAL`** -> collect the matching daemon log line and report a bug; do not loop.
- **Anything else** -> read the section of `docs/ERRORS.md` for the code (`#phone_...`), then the linked troubleshooting entry.

## 2. Fixes you may apply (reversible, no restart)
- Settings through the Phone tab or `POST /dsh-phone/api/settings` need the browser gate (token, cookie) and are normally done by the human in the UI; offer the exact values instead of calling the route yourself.
- Back up a config file before any hand edit: `cp file file.bak-$(date +%Y%m%d)`.
- Everything else here is read-only; for anything that edits the profile, the router, the edge proxy, the media server config or the provider console, ask the human.

## 3. Steps that need the human
Restart of `dsh web`, of `dsh-phone-hookd` or of the media server; edge or reverse-proxy login-gate exceptions; router port forwards and SIP ALG; provider console (webhooks, geo permissions, sender registration, balance); entering credentials; placing a test call.
Ask a precise question, for example: "Please restart `dsh web` so the server half of dsh-phone loads, then tell me when the Phone tab shows."

## 4. Report back
Tell the human: the failing check or code, the cause in one sentence, what you changed (if anything), what they must do next, and the verify command and its expected output. Do not include any secret value.
