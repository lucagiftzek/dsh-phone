# Troubleshooting dsh-phone

Checked on: DSH 0.1.5-rc.1 and 0.2.1-rc.5, plugin 0.1.0 (branch with the SIP relay).

<a id="start-here"></a>
**Start here.** Ask your agent to load the `phone-doctor` skill (bundled in `skills/phone-doctor/`; see [Section 0](#t-facts) to copy it into your skills folder if your DSH does not list it). A one-call doctor is built in: `GET /dsh-phone/api/doctor` or the read-only tool `phone_doctor` (settings mode, lines, credentials as booleans, public URL, daemon, SIP registrations; no provider calls). The same facts by hand are in [Section 0](#t-facts). Every error the plugin or its daemon returns carries a `code`; look it up in [ERRORS.md](ERRORS.md). Daemon log lines start with the code, so `grep PHONE_` finds them.

Two processes matter, keep them apart when you read symptoms:

- **The plugin** runs inside `dsh web` and serves `/dsh-phone/api/*` (settings, tools, the gated proxy). It loads at the start of `dsh web`.
- **phone-hookd** is a separate daemon (service `dsh-phone-hookd`) with a public webhook listener and a private unix socket. It owns the database and talks to the provider. It keeps working while `dsh web` restarts.

## Quick index

| # | Symptom (what you see) | Most likely cause | Jump |
|---|---|---|---|
| 1 | Phone tab or Settings > Phone is missing | `dsh web` was not restarted (client hot-reloads, server half does not) | [1](#t-tab-missing) |
| 2 | Calls or texts never arrive, or the daemon logs `PHONE_SIGNATURE_INVALID` | login gate in front of the webhook path, or public URL differs from what the provider calls | [2](#t-webhooks) |
| 3 | "Apply to Twilio" fails or the checklist stays red | wrong credentials (auth token vs API key), missing public URL | [3](#t-apply-fails) |
| 4 | The browser does not ring, or "device error" in the tab | token mint failed, microphone permission, insecure context | [4](#t-browser-no-ring) |
| 5 | A text is sent but never delivered | sender type, country filtering, messaging service sender name | [5](#t-sms-not-delivered) |
| 6 | A voicemail has no transcript | local speech-to-text not configured, wrong language or model | [6](#t-transcript-missing) |
| 7 | Settings do not save or reset (0.2.x) | profile row, `Config` on the default export | [7](#t-settings-02x) |
| 8 | SIP relay: calls connect but there is no audio | NAT drops the provider media, router SIP ALG | [8](#t-relay-no-audio) |
| 9 | SIP relay: every call is answered with 503 | media server load limit | [9](#t-relay-503) |
| 10 | SIP relay: registration fails | credentials, transport, expiry | [10](#t-relay-registration) |
| 11 | SIP relay: the call rings or forks twice after a restart | stale registration at the carrier | [11](#t-relay-twice) |
| 12 | SIP relay: another phone answers before DSH | ring-first seconds longer than the other phone's answer time | [12](#t-relay-other-phone) |
| 13 | SIP relay: a transport change has no effect | transports need a media server restart | [13](#t-relay-restart) |
| 14 | SIP relay disappears after a `dsh web` restart | an older plugin lib pushed settings without the relay keys | [14](#t-old-lib) |
| C1 to C7, C9, C10 | Install problems shared by all DSH plugins | | [Common install problems](#common-install-problems-on-dsh) |

<a id="t-facts"></a>
## 0. Collect facts (read-only, always safe)

Placeholders: `<dsh-url>` is where your DSH web UI answers (example `http://127.0.0.1:3080`), `<public-base-url>` is the value of the `publicBaseUrl` setting (what the provider calls). `DSH_HOME` defaults to `~/.dsh`. The plugin API answers only loopback peers with a trusted Host, so run the `curl` lines on the DSH machine.

```bash
# one call: the doctor (read-only, no secrets, no provider calls); look at every check that is not ok
curl -s <dsh-url>/dsh-phone/api/doctor | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.status||r.code,(r.checks||[]).filter(c=>c.status!=="ok"&&c.status!=="skip").map(c=>[c.id,c.status,c.code,c.detail]))})'

# versions
dsh --version; node -v                      # Node must be 22.5 or newer (node:sqlite)

# plugin loaded? state (setup issues, mode, relay) without secrets
curl -s <dsh-url>/dsh-phone/api/state | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log({ok:r.ok,code:r.code,error:r.error,ready:r.ready,issues:r.issues,mode:r.mode,browserOnline:r.browserOnline,relay:r.relay,sip:(r.sipAccounts||[]).map(a=>({id:a.id,issues:a.issues,warnings:a.warnings}))})})'

# which settings store is active (0.1.5 namespace or 0.2.x row), plugin version
curl -s <dsh-url>/dsh-phone/api/settings | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log({version:r.version,store:r.store,code:r.code})})'

# daemon alive? (private socket, no network)
curl -s --unix-socket "${DSH_HOME:-$HOME/.dsh}/phone/hookd.sock" http://localhost/health
ls -la "${DSH_HOME:-$HOME/.dsh}/phone/"      # hookd.sock should be srw------- ; keep the secrets files at mode 0600

# public webhook endpoint reachable from outside? (GET, no signature needed)
curl -s -o /dev/null -w '%{http_code}\n' <public-base-url>/health        # 200 when the edge route is right

# provider side check (read-only GETs at the provider, no charge, plus the public health above)
curl -s <dsh-url>/dsh-phone/api/provider/check

# logs: every daemon line that matters starts with a PHONE_ code
journalctl -u dsh-phone-hookd --since "1 hour ago" | grep -E 'PHONE_[A-Z_]+' | tail -40
journalctl -u dsh-phone-hookd -n 60 --no-pager | tail -60
```

Reading the answers: `PHONE_HOOKD_UNAVAILABLE` (503) from a `/dsh-phone/api/*` call means the **plugin is loaded** and only the daemon is down. A 404 on every path means the plugin is not loaded (see C1 and C2). `ready: false` with `issues` lists missing setup items in plain words.

If the `phone-doctor` skill is not offered to your agent, copy it by hand (it appears without a restart):

```bash
P=$(node -p "require('path').dirname(require.resolve('dsh-phone/package.json',{paths:[(process.env.DSH_HOME||require('os').homedir()+'/.dsh')+'/profiles/web']}))")
mkdir -p "${DSH_HOME:-$HOME/.dsh}/skills" && cp -r "$P/skills/phone-doctor" "${DSH_HOME:-$HOME/.dsh}/skills/"
```

<a id="t-tab-missing"></a>
## 1. The Phone tab or Settings > Phone is missing

**Likely causes** (most likely first)
1. `dsh web` was not restarted after installing or updating the plugin. The client half (the tab) hot-reloads, the server half (settings, routes, tools) loads only at start, so a half-updated plugin shows a tab with no settings or an empty one.
2. The package is not in the profile's bundle list, or DSH refused it as incompatible (see C1).
3. `dsh-better-sidebar` is missing or too old: the Phone tab needs its sidebar host (see C4).
4. The plugin was switched off on purpose: the environment variable `DSH_PHONE_DISABLE=1` is set for `dsh web` (the log says "armed off").

**Diagnose** (read-only)
```bash
curl -s -o /dev/null -w '%{http_code}\n' <dsh-url>/dsh-phone/api/settings     # 200 = server half loaded; 404 = not loaded
journalctl -u <your-dsh-unit> --since "1 hour ago" | grep -i -E 'dsh-phone|incompatible|skipped|duplicate loader entry|declares no dsh.bundle' | tail -20
```
Expected when healthy: `200` and a line `dsh-phone: armed 0.1.0, route /dsh-phone/api`. A `404` is cause 1 or 2; `200` with no tab is cause 3 (browser console names the failing plugin).

**Fix**
- Cause 1 **[HUMAN]**: restart `dsh web` (your chat may run inside it, so the human restarts it), then reload the browser tab.
- Cause 2 and 3: follow C1 and C4 below.
- Cause 4: unset `DSH_PHONE_DISABLE` and restart `dsh web` **[HUMAN]**.

**Verify:** the tab and Settings > Phone appear, `curl` above prints `200`.

**Related codes:** `PHONE_NOT_FOUND`, `PHONE_HOOKD_UNAVAILABLE`.

<a id="t-webhooks"></a>
## 2. Calls or texts never arrive, or webhooks are rejected

Symptom variants: the provider console shows webhook errors (401, 403, 302, 11200), nothing appears in the Phone tab when you call or text the number, or the daemon logs `PHONE_SIGNATURE_INVALID`.

**Likely causes**
1. A login gate (SSO, basic auth, forward auth) in front of DSH also covers the webhook path, so the provider gets a redirect or 401. The gate must exclude **only** the webhook path (for example `/phone-hook/`); every other DSH path stays behind it.
2. The public base URL does not match what the provider actually calls. The provider signs the exact URL it requested; the daemon rebuilds `publicBaseUrl + path` and compares. A reverse proxy that rewrites scheme, host, port or path prefix, or a `publicBaseUrl` with a different host, trailing path or `http://` instead of `https://`, makes every request fail with `PHONE_SIGNATURE_INVALID`.
3. The auth token in Settings is not the one of the account that owns the number (or is empty): the log line says "no auth token configured".
4. A rate limit or firewall at the edge drops the provider (the provider console shows timeouts, the daemon log shows nothing).
5. The number's webhooks at the provider point somewhere else (never applied, or applied for an old URL).

**Diagnose** (read-only)
```bash
# 1. does the path pass the login gate? (an unsigned POST must answer 403 from the daemon, never 302/401)
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -X POST <public-base-url>/voice/incoming
curl -s -X POST <public-base-url>/voice/incoming          # healthy body: {"ok":false,"error":"...","code":"PHONE_SIGNATURE_INVALID",...}
# 2. is the daemon seeing the requests, and which URL did it expect?
journalctl -u dsh-phone-hookd --since "30 min ago" | grep -E 'PHONE_SIGNATURE_INVALID|PHONE_PUBLIC_URL_MISSING' | tail
curl -s <dsh-url>/dsh-phone/api/provider/check | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=(JSON.parse(s).check)||{};console.log({app:r.app,lines:(r.lines||[]).map(l=>({id:l.id,ok:l.ok,voiceUrl:l.voiceUrl,smsUrl:l.smsUrl})),publicHook:r.publicHook})})'
```
Expected when healthy: `403` with code `PHONE_SIGNATURE_INVALID` for the unsigned probe (the route is reached and refuses an unsigned request, which is correct), `publicHook.ok: true`, every line `ok: true`. `302` or `401` is cause 1. `404` or a connection error is a missing edge route. Valid provider requests logging `PHONE_SIGNATURE_INVALID` while the probe above also works is cause 2 or 3: compare the line's `voiceUrl` with `publicBaseUrl`, character by character.

**Fix**
- Cause 1 **[HUMAN]**: in the edge or proxy config, route only `/phone-hook/` (your prefix) to the daemon's public port without the login middleware, with a modest rate limit; keep the rest of DSH behind the gate. See `deploy/traefik-phone-hook.yml` for an example.
- Cause 2: set `publicBaseUrl` in Settings > Phone to exactly the HTTPS URL the provider calls (no query, no trailing slash), make the proxy pass the original scheme and host (`X-Forwarded-Proto`, `X-Forwarded-Host`) and not rewrite the path prefix, then Save and run **Apply to Twilio** again so the number webhooks carry the same URL.
- Cause 3: fix the auth token (see entry 3).
- Cause 4 **[HUMAN]**: allow the provider through the firewall or raise the rate limit.
- Cause 5: run **Apply to Twilio**.

**Verify:** place a test call or send a text to the number; `journalctl ... | grep PHONE_SIGNATURE_INVALID` shows no new lines and the event appears in the tab. The checklist shows "Public webhook endpoint" green.

**Related codes:** `PHONE_SIGNATURE_INVALID`, `PHONE_PUBLIC_URL_MISSING`, `PHONE_METHOD_NOT_ALLOWED`, `PHONE_NOT_FOUND`, `PHONE_WEBHOOK_HANDLER_FAILED`.

<a id="t-apply-fails"></a>
## 3. "Apply to Twilio" fails or the checklist stays red

**Likely causes**
1. Wrong or missing credentials. The daemon needs the **account SID and the main auth token**; an API key SID with its secret is created by Apply and is only used for browser tokens. Pasting an API key secret where the auth token goes gives `PHONE_PROVIDER_AUTH_FAILED` (401).
2. The public base URL is not set (`PHONE_PUBLIC_URL_MISSING`).
3. A line's number is not on this account (the step "Number ..." fails with "is not on this ... account"), or the number lacks voice or SMS capability.
4. Apply ran but the browser never re-registered (reload the tab).
5. Outbound HTTPS from the server is blocked (`PHONE_PROVIDER_UNREACHABLE`).

**Diagnose** (read-only)
```bash
curl -s <dsh-url>/dsh-phone/api/state | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log({issues:r.issues,credentials:Object.fromEntries(Object.entries(r.credentials||{}).map(([k,v])=>[k,{set:v.set,source:v.source}])),lastApply:r.lastApply})})'
curl -s <dsh-url>/dsh-phone/api/provider/check
journalctl -u dsh-phone-hookd --since "1 hour ago" | grep -E 'PHONE_PROVIDER' | tail
```
`credentials.*.set` shows which of the five values exist and where they come from (settings, credentials file or what Apply created); never a value. `lastApply.report` names the failing step.

**Fix**
- Cause 1: put the account SID and auth token into Settings > Phone (or the `KEY=value` credentials file: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`), Save, Apply again. Keep the file at mode 0600.
- Cause 2: set `publicBaseUrl` (see entry 2).
- Cause 3 **[HUMAN]**: buy or move the number in the provider console, or pick it from "Numbers on the account" in Settings.
- Cause 4: reload the browser tab.
- Cause 5 **[HUMAN]**: open outbound HTTPS and DNS for the server.

**Verify:** `provider/check` returns every row `ok: true`; Apply twice is safe (idempotent).

**Related codes:** `PHONE_PROVIDER_NOT_CONFIGURED`, `PHONE_PROVIDER_AUTH_FAILED`, `PHONE_PROVIDER_REQUEST_FAILED`, `PHONE_PROVIDER_UNREACHABLE`, `PHONE_PUBLIC_URL_MISSING`.

<a id="t-browser-no-ring"></a>
## 4. The browser does not ring, or the tab shows a device error

**Likely causes**
1. The browser access token cannot be minted: no API key or TwiML App yet (`PHONE_VOICE_TOKEN_INCOMPLETE`), fixed by Apply.
2. Microphone permission is blocked for the page, or the page is not a secure context. Browsers allow the microphone and the WebRTC device only on HTTPS or on `localhost`; a plain `http://<server-ip>` URL will not work.
3. No browser is registered: the incoming mode is Live but "browserOnline" is false, so the daemon sends the call straight to voicemail. The tab registers when it is open and the device is ready.
4. The mode is Voicemail or Do not disturb (nothing rings by design), or the caller is not starred during DND.
5. The browser identity in Settings (`identity`) changed and the open tab still holds a token for the old one (`PHONE_OUTBOUND_CLIENT_REFUSED` for outgoing calls).
6. The Voice SDK did not load (`/dsh-phone/api/sdk.js` blocked by a content blocker or the proxy).

**Diagnose** (read-only)
```bash
curl -s <dsh-url>/dsh-phone/api/state | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log({mode:r.mode,browserOnline:r.browserOnline,identity:r.identity,issues:r.issues})})'
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' <dsh-url>/dsh-phone/api/sdk.js       # 200 text/javascript
journalctl -u dsh-phone-hookd --since "30 min ago" | grep -E 'PHONE_(VOICE_TOKEN|OUTBOUND)' | tail
```
In the browser, open the page over `https://` or `localhost`, then the site settings for the microphone; the devtools console shows the SDK error text.

**Fix**
- Cause 1: Settings > Phone > **Apply to Twilio**, then reload the tab.
- Cause 2 **[HUMAN]**: allow the microphone for the site; open DSH through HTTPS.
- Cause 3: keep one DSH tab open on the Phone tab, wait until the status says ready.
- Cause 4: switch the mode to Live in the tab, or star the contact.
- Cause 5: reload the tab so it mints a new token.
- Cause 6: allow `/dsh-phone/api/sdk.js` through the blocker or proxy.

**Verify:** `browserOnline` is `true` in the state output; place a call to the number and the overlay rings.

**Related codes:** `PHONE_VOICE_TOKEN_INCOMPLETE`, `PHONE_TOKEN_INVALID`, `PHONE_SESSION_COOKIE_MISSING`, `PHONE_OUTBOUND_CLIENT_REFUSED`, `PHONE_HOST_UNTRUSTED`.

<a id="t-sms-not-delivered"></a>
## 5. A text is sent but not delivered

**Likely causes**
1. The sender type is filtered for that destination: a long code (ordinary number) from one country texting mobiles in another can be blocked by carriers or by the provider's geo permissions; some countries need a registered sender (for example US local numbers need A2P 10DLC registration, toll-free senders need verification); some countries accept only alphanumeric senders.
2. The text is sent through a messaging service whose sender name differs from your number: replies and filtering follow that service, and a branded sender name can be rejected or shown instead of your number. Send from the number itself.
3. The destination is blocked, not mobile, or invalid. Landlines cannot receive SMS.
4. The line has SMS switched off, is not a Twilio line (`PHONE_LINE_UNAVAILABLE`), or the message is empty or too long (`PHONE_MESSAGE_INVALID`).
5. The provider account has no balance.

**Diagnose** (read-only)
```bash
journalctl -u dsh-phone-hookd --since "1 day ago" | grep PHONE_SMS_DELIVERY_FAILED | tail     # carries the provider error code
curl -s "<dsh-url>/dsh-phone/api/thread?peer=<your-number>" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const m of (JSON.parse(s).messages||[]).slice(-5))console.log(m.direction,m.status,m.error||"")})'
```
The message status and error (for example `failed`, `error 30007`) come from the provider callback; look the number up in the provider's error code list (30007 is carrier filtering, 21408 is a region not enabled, 21610 is a recipient who opted out).

**Fix**
- Cause 1 **[HUMAN]**: use a sender that is allowed for the destination (a local number, a registered or verified sender), or enable the destination country in the provider's geo permissions.
- Cause 2: send from the number itself; remove branded sender names from the path.
- Cause 3: check the number format (E.164) and that it is a mobile.
- Cause 4: Settings > Phone > Lines: SMS on, provider Twilio.
- Cause 5 **[HUMAN]**: top up the account.

**Verify:** a new text to your own mobile shows status `delivered` in the thread.

**Related codes:** `PHONE_SMS_DELIVERY_FAILED`, `PHONE_NUMBER_INVALID`, `PHONE_MESSAGE_INVALID`, `PHONE_LINE_UNAVAILABLE`, `PHONE_PROVIDER_REQUEST_FAILED`.

<a id="t-transcript-missing"></a>
## 6. A voicemail has no transcript

Two transcripts exist: the **live** one (streamed by the provider while the caller speaks) and the **final** one (made by your own speech-to-text from the recording). The agent tool and the tab fall back to the live text when the final one fails.

**Likely causes**
1. `voicemail.transcriber` is `local` but no local speech-to-text endpoint is configured or reachable (`localUrl` and the credentials file with the base URL and API key).
2. The model or language is wrong: the live transcript needs `voicemail.liveLanguage` (for example `de-DE`) and for some languages a different `liveModel`; a small local model can return an empty text for non-English audio.
3. The recording never arrived (`PHONE_RECORDING_DOWNLOAD_FAILED`): provider credentials or the recording was already deleted.
4. Live transcription is off (`voicemail.liveTranscript`), or the provider reported an error (`PHONE_LIVE_TRANSCRIPT_FAILED`).
5. Mistral was chosen without its key.

**Diagnose** (read-only)
```bash
journalctl -u dsh-phone-hookd --since "1 day ago" | grep -E 'PHONE_(TRANSCRIBE|LIVE_TRANSCRIPT|RECORDING)' | tail
curl -s "<dsh-url>/dsh-phone/api/voicemails?limit=3" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const v of (JSON.parse(s).voicemails||[]))console.log(v.id,v.status,v.engine,v.language,v.duration,(v.transcript||v.liveText||"").length)})'
curl -s -o /dev/null -w '%{http_code}\n' <local-stt-base-url>/health        # your own endpoint; 200 or 404 means something listens
```
`engine: none` with status `ready` means the final transcription failed and nothing live was captured.

**Fix**
- Cause 1: set `voicemail.localUrl` (or the credentials file keys) to your speech-to-text service, start it, check it from the server. Then in the tab use **Retranscribe** on the voicemail.
- Cause 2: set `liveLanguage`/`liveModel` to values your provider supports; use a larger local model for that language.
- Cause 3: fix credentials (entry 3); the recording is deleted at the provider after download when `deleteFromProvider` is on.
- Cause 4: enable `voicemail.liveTranscript`.
- Cause 5: set the key in the Mistral credentials file or choose `local`.

**Verify:** Retranscribe returns a transcript; a new test voicemail shows text.

**Related codes:** `PHONE_TRANSCRIBE_FAILED`, `PHONE_LIVE_TRANSCRIPT_FAILED`, `PHONE_RECORDING_DOWNLOAD_FAILED`, `PHONE_VOICEMAIL_NO_AUDIO`.

<a id="t-settings-02x"></a>
## 7. Settings do not save, or reset (DSH 0.2.x)

Shared causes are in C3. Specific to dsh-phone:

**Likely causes**
1. On 0.2.x the values live in the profile row `- id: dsh-phone` under `config:` of `profiles/web/cordis.patch.yml`; the form only writes fields the plugin's `Config` declares. The plugin exports `Config` on the **default export** (the loader reads it there). An older build that exports it only by name shows no form.
2. `POST /dsh-phone/api/settings` answers `PHONE_SETTINGS_UNAVAILABLE` (503): the settings service is not injected, or the store is not writable.
3. The save is refused with `PHONE_TOKEN_INVALID` or `PHONE_SESSION_COOKIE_MISSING`: reload the tab and sign in again.
4. A leftover `settings.yaml` is imported again at boot and overwrites the row (C3 point e).
5. After a save, the daemon keeps the previous value because the push failed: the tab says "phone-hookd picked up the change" only when it worked.

**Diagnose** (read-only)
```bash
curl -s <dsh-url>/dsh-phone/api/settings | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log({version:r.version,store:r.store})})'
grep -n -B1 -A4 -- '- id: dsh-phone' "${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml" | grep -v -i -E 'token|secret|password'
```
`store.mode` is `register` on 0.1.5 and `forms` on 0.2.x; `config` means the plugin found neither and runs on defaults.

**Fix:** update the plugin to a build with `Config` on the default export; edit non-live keys in the row; back the file up first (`cp file file.bak-$(date +%Y%m%d)`). Restart `dsh web` **[HUMAN]** after a plugin update.

**Related codes:** `PHONE_SETTINGS_UNAVAILABLE`, `PHONE_TOKEN_INVALID`, `PHONE_SESSION_COOKIE_MISSING`.

<a id="t-relay-no-audio"></a>
## 8. SIP relay: calls connect but there is no audio

Applies to a SIP account joined through the Asterisk relay (see [RELAY.md](RELAY.md)). Signalling works (the call reaches voicemail, the caller hears the greeting or ringing), but the recording is silent or one party hears nothing.

**Likely causes**
1. **NAT drops the provider's media.** Many cloud voice providers (Twilio among them) send RTP to the address and port in the SDP and do not "latch" onto the source of your packets. A port-restricted NAT then drops their media. The RTP port range must be forwarded to the relay host (or the relay needs a public address).
2. **The router's SIP ALG** rewrites the SIP it can read and remaps the RTP source ports of those calls, so media goes out from a port other than the one announced, and RTP sent back to the announced port is dropped. Typical of some ISP routers.
3. The provider has no IPv6: moving the relay to an IPv6-only path does not help.
4. The external media address or the local networks are wrong in Settings, so the SDP announces a private address (`relay.externalMediaAddress`, `relay.localNets`).

**Diagnose** (read-only; run during one short test call)
```bash
sudo tcpdump -ni any udp portrange 10000-10100 -c 50       # RTP range of the relay
```
No inbound RTP at all means cause 1 or 2. RTP leaves but nothing returns: cause 1. To tell ALG from plain NAT, compare the port announced in the SDP (`m=audio <port>`) with the source port you see on a public test peer: **different means a SIP ALG**.

**Fix**
- Cause 1 **[HUMAN]**: forward the relay's RTP range (UDP, default 10000-10100) on the router to the relay host's LAN address, and set `relay.externalMediaAddress` to the public address or hostname.
- Cause 2: use **SIP over TLS (port 5061) with SRTP towards the provider** (`relay.bridgeTransport: tls`, then Apply): the ALG cannot read encrypted SIP and leaves the leg alone, with no router change. Or switch the router's SIP ALG off **[HUMAN]** (router admin page; some ISP builds hide it, then ask the ISP).
- Cause 4: correct the addresses, Save; the relay config regenerates and reloads live (transport and bind changes need a media server restart, entry 13).

**Verify:** `tcpdump` shows RTP in both directions during a test call, and a test voicemail has audio and a transcript.

**Related codes:** `PHONE_RELAY_SYNC_FAILED`, `PHONE_RELAY_AMI_FAILED`.

<a id="t-relay-503"></a>
## 9. SIP relay: every call is answered with 503

**Likely cause:** a load limit in the media server (`maxload` in its main config) rejects new calls with SIP 503 when the host is busy; a loaded desktop or build machine exceeds a small limit without any call running.

**Diagnose** (read-only)
```bash
grep -n -i maxload /etc/asterisk/asterisk.conf; uptime
sudo asterisk -rx 'core show channels' | tail -3
```
A `maxload` line at or below the load average is the cause.

**Fix** **[HUMAN]** (edits the media server config, then a restart): remove `maxload` (the shipped `deploy/asterisk/asterisk.conf` does not set it) or raise it above the normal load, restart the media server.

**Verify:** the next test call reaches voicemail instead of failing; no 503 in the provider's call log.

**Related codes:** none (the failure is on the media server, outside the plugin).

<a id="t-relay-registration"></a>
## 10. SIP relay: registration fails

**Likely causes:** wrong credentials (registrar, username, auth username, password), a transport the provider does not offer (most residential providers have UDP/TCP only, no TLS), an expiry the provider refuses, the account disabled in Settings, or the relay is not bound where the provider can answer.

**Diagnose** (read-only)
```bash
curl -s <dsh-url>/dsh-phone/api/relay/status | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=(JSON.parse(s).relay)||{};console.log({sync:{state:(r.sync||{}).state,errors:(r.sync||{}).errors,restartNeeded:(r.sync||{}).restartNeeded},error:r.error,registrations:r.registrations,accounts:(r.accounts||[]).map(a=>({id:a.id,enabled:a.enabled,issues:a.issues,warnings:a.warnings}))})})'
journalctl -u dsh-phone-hookd --since "1 hour ago" | grep -E 'PHONE_RELAY' | tail
sudo asterisk -rx 'pjsip show registrations'
```
`Rejected` or `Unregistered` with account `issues` pointing at a missing field is a settings problem; a registration stuck in `Rejected` with all fields present is credentials or transport.

**Fix:** correct the fields (the password may live in a `KEY=value` credentials file at mode 0600), use the transport the provider documents, keep `expiry` at the provider's minimum or higher, Save and wait for the relay to sync. `PHONE_RELAY_DIR_UNUSABLE` means the include directory is missing or not writable (see [RELAY.md](RELAY.md) install step 2) **[HUMAN]**; `PHONE_RELAY_AMI_FAILED` means the media server is down or its manager include was not loaded yet (a restart can be needed once) **[HUMAN]**.

**Verify:** both `pjsip show registrations` and the state output list `Registered`.

**Related codes:** `PHONE_RELAY_DIR_UNUSABLE`, `PHONE_RELAY_AMI_FAILED`, `PHONE_RELAY_SYNC_FAILED`.

<a id="t-relay-twice"></a>
## 11. SIP relay: a call rings or forks twice after a media server restart

**Cause:** after a restart the relay registers again with a new contact token while the carrier still holds the old binding (long expiry), so one incoming call is forked to both contacts. The generated dialplan drops the duplicate by SIP Call-ID, which needs the lock and group-count modules loaded.

**Diagnose** (read-only)
```bash
sudo asterisk -rx 'module show like func_lock'; sudo asterisk -rx 'module show like func_groupcount'
sudo asterisk -rx 'pjsip show contacts' | head
```
Both modules must be `Running`; two contacts for one account is the stale binding, which expires by itself.

**Fix:** load the two modules (the shipped `modules.conf` does) **[HUMAN]**; otherwise wait for the old binding to expire, or unregister it at the carrier **[HUMAN]**.

**Verify:** one test call produces one call record in the tab.

<a id="t-relay-other-phone"></a>
## 12. SIP relay: another phone answers before DSH

**Cause:** the carrier rings every registration of the account in parallel (a desk phone, a router with a phone port). With **Ring other phones first** (`ringFirstSeconds`) the relay waits that long before DSH takes the call to voicemail. If something on another branch answers earlier (the router's own voicemail, an answering machine, call forwarding), keep `ringFirstSeconds` **below** that time.

**Diagnose:** time how long a test call rings the other phone before it is answered; read the call log in the tab (`disposition`).

**Fix:** lower `ringFirstSeconds` (a few seconds under the other branch), Save.

**Verify:** a test call that nobody answers ends in DSH voicemail instead of the other branch.

<a id="t-relay-restart"></a>
## 13. SIP relay: a change has no effect until the media server restarts

Changing the transports (bind address or port, TCP on or off, external signalling address or port, the TLS port or CA file) is read by the media server only at start. Everything else (accounts, dial rules, ring-first, codecs) reloads live over the manager interface. The state output shows `relay.restartNeeded: true` after such a change.

**Fix** **[HUMAN]**: `systemctl restart asterisk` (briefly drops the registrations, which return within seconds). Then see entry 11 if calls fork twice for a while.

**Verify:** registrations are `Registered` and a test call works. `restartNeeded` stays `true` until phone-hookd itself restarts, so treat it as a reminder, not a live status.

<a id="t-old-lib"></a>
## 14. The SIP relay vanished after a `dsh web` restart

An older plugin lib (before the relay) pushes settings to the daemon without the relay keys (`sipAccounts`, `relay`, `twilio.sipEdge`). The daemon keeps the stored ones, so a restart onto an old lib does not unregister the relay; but the Settings page of that old lib cannot show or edit them.

**Diagnose** (read-only): `curl -s <dsh-url>/dsh-phone/api/settings` shows `version`; compare with the daemon's version in `curl -s --unix-socket "${DSH_HOME:-$HOME/.dsh}/phone/hookd.sock" http://localhost/health`. A plugin older than the daemon is the cause.

**Fix:** update the plugin to the same build as the daemon and restart `dsh web` **[HUMAN]**; the stored relay settings reappear. Do not re-enter them by hand before that.

**Related codes:** `PHONE_HOOKD_ERROR` (a daemon older than the plugin answers without codes).

<!-- dsh-common-install:v1 -->
## Common install problems on DSH

Placeholders: `<dsh-url>` is where your DSH web UI answers (for example
`http://127.0.0.1:3080`), `DSH_HOME` defaults to `~/.dsh`, the profile is `web`.
The self-check route of this plugin is `/dsh-phone/api/doctor` (tool `phone_doctor`); it answers 404 when the plugin is not loaded,
which is itself the C1/C2 symptom, so where the shared text below says "doctor" the read-only routes `api/state` and `api/settings` work as well.

<a id="c1-not-loaded"></a>
### C1. The plugin does not appear at all (no tab, no settings, no tools)

**Causes:** (1) the package is installed but not in the profile's bundle list;
(2) it is in the list but `dsh web` was not restarted; (3) DSH refused it as
incompatible (engines or peer range); (4) its server entry threw at start;
(5) the entry is defined twice (`duplicate loader entry id`: a hand-written `insert` row in
the profile patch plus the package's own patch); (6) an old build without `dsh.bundle` in its
`package.json` (`declares no dsh.bundle`).

**Diagnose**
```bash
D="${DSH_HOME:-$HOME/.dsh}/profiles/web"
node -e 'const p=require(process.argv[1]);console.log((p.dsh?.profile?.bundles||[]).join("\n"))' "$D/package.json" | grep -n 'dsh-phone' || echo "NOT IN BUNDLES"
ls -la "$D/node_modules/dsh-phone" 2>/dev/null || echo "NOT INSTALLED"
dsh --profile web --dump-config 2>/dev/null | grep -n -i 'dsh-phone' | head    # composed tree, does not boot
# DSH log: the terminal running `dsh web`, or your service manager, e.g.
journalctl -u <your-dsh-unit> --since "1 hour ago" | grep -i -E 'dsh-phone|incompatible|skipped|exemption|duplicate loader entry|declares no dsh.bundle' | tail -40
```

**Fix:** install with `dsh plugin --profile web add @lucagiftzek/dsh-phone` (it adds the package to
`dsh.profile.bundles` when the package declares `dsh.bundle`; override values with a plain
`- id: dsh-phone` row, never a second `insert` row), then restart
`dsh web` **[HUMAN if your chat runs inside dsh web]**. If the log says the bundle
was skipped as incompatible, update the plugin; DSH 0.2.x also offers an exact-version
exemption (`dsh plugin allow-version`, see the log message), which must be granted
again after every DSH version change.

**Verify:** the tab or settings page appears; `curl -s -o /dev/null -w '%{http_code}\n' <dsh-url>/dsh-phone/api/settings` prints `200`.

<a id="c2-route-404"></a>
### C2. Every plugin route answers 404

**Causes:** the plugin's server half is not loaded (C1), or it was updated and the
running `dsh web` still has the old server code (the client half hot-reloads, the
server half loads only at start). A 404 on ONE path while others answer means a
wrong path, not a load problem.

**Diagnose**
```bash
for p in api/settings api/state api/does-not-exist; do echo "$p $(curl -s -o /dev/null -w '%{http_code}' <dsh-url>/dsh-phone/$p)"; done
```
All 404 = route prefix not registered. `200` on settings, `200` or `503` on state (503 with code `PHONE_HOOKD_UNAVAILABLE` only means the daemon is down) and `404` on the last = healthy.

**Fix:** restart `dsh web` **[HUMAN]**. If you open DSH through a browser login or a
reverse proxy, check the proxy forwards `/dsh-phone/` to DSH. After a restart the
web UI may ask you to open the launch URL again (the one `dsh web` prints, with its
one-time token); that is expected and unrelated to plugin routes.

<a id="c3-settings-not-saved"></a>
### C3. Settings do not save, or reset after a restart

**Causes by DSH line:**
- **0.1.5:** the plugin registers a settings namespace; values live in
  `$DSH_HOME/settings.yaml` under the plugin's section. A hand edit with a YAML error
  makes the whole file unreadable.
- **0.2.x:** settings are forms over the plugin's exported `Config`; values live in
  `$DSH_HOME/profiles/web/cordis.patch.yml` under the row `- id: dsh-phone` `config:`.
  (a) Only fields marked live (`volatile`) are editable in forms; others are edited in
  the row and remount the plugin. (b) The loader reads `Config` from the DEFAULT export
  when the module has one: a plugin that exports `default { name, apply }` without
  `Config` gets no form. (c) A plugin that touches `ctx.settings` without declaring
  `inject: ['settings']` throws on 0.2.x. (d) A home patch or command-line overlay that
  sets the same key wins, and the form write is refused. (e) On first boot 0.2.x renames
  `settings.yaml` to `settings.yaml.imported` and imports only sections whose name equals
  an entry id with all keys declared live; a `settings.yaml` that reappears (a script
  rewriting it) is imported AGAIN at every boot and overwrites profile rows.

**Diagnose**
```bash
dsh --version
curl -s <dsh-url>/dsh-phone/api/settings | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log({version:r.version,store:r.store,code:r.code})})'
D="${DSH_HOME:-$HOME/.dsh}"; ls -la "$D/settings.yaml" "$D/settings.yaml.imported" 2>/dev/null
grep -n -A12 -- '- id: dsh-phone' "$D/profiles/web/cordis.patch.yml"   # 0.2.x row (may contain secrets: do not paste it anywhere)
```

**Fix:** use a plugin version that supports your DSH line (`store.mode` must not be
`config` on a normal install). On 0.2.x stop any script that rewrites
`settings.yaml`, and edit non-live fields in the row. Back up the file before any hand
edit (`cp file file.bak-$(date +%Y%m%d)`).

<a id="c4-gui-blank"></a>
### C4. After a DSH update the web UI does not render ("Failed to load plugins", blank page)

**Causes:** on 0.2.x an unmet REQUIRED client inject stops the whole GUI, not just one
plugin. Typical: a plugin requires `dsh-better-sidebar` (or another client service) and
that package was refused as too old for the new DSH. Older plugin builds that require
their sidebar host are affected; current ones inject it optionally.

**Diagnose:** browser devtools console (the first red error names the plugin), and the
DSH log for `skipped` / `incompatible` bundles (C1 command).

**Fix:** update `dsh-better-sidebar` (0.28 or newer for DSH 0.2.1) and the plugin;
or disable the failing bundle by row and restart **[HUMAN]**:
```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: dsh-phone
  disabled: true
```

<a id="c5-model-404"></a>
### C5. After a DSH update every model turn fails (HTTP 404) for one provider

**Cause:** an environment variable such as `DEEPSEEK_BASE_URL` changed meaning between
DSH lines (0.1.5: plain API host; 0.2.x: the Anthropic-messages base, for example
`https://api.deepseek.com/anthropic`). Not a plugin bug, but it looks like one.

**Fix:** set the base URL the new line expects (env or the provider row), restart **[HUMAN]**.

<a id="c6-oom-install"></a>
### C6. The machine runs out of memory during an install

**Cause:** a profile-level `pnpm install` (or `npm i -g` of the harness) can grow to many
GB on a large profile; with swap full, the kernel or earlyoom kills unrelated services.

**Fix:** check `free -m` first, then install inside a memory-capped scope:
```bash
systemd-run --user --scope -p MemoryMax=3G dsh plugin --profile web add @lucagiftzek/dsh-phone
# pnpm only: add --child-concurrency 1 to reduce peak memory
```
A runaway then kills only itself. Check afterwards that your other services are up.

<a id="c7-stale-client"></a>
### C7. UI shows new options but they do nothing, or "restart dsh web" banners

**Cause:** the client half (browser bundle) hot-reloaded, the server half did not. Mixed
versions are tolerated by design, but new server features stay off until a restart.
**Fix:** restart `dsh web` when convenient **[HUMAN]**; reload the browser tab.

<a id="c9-webhooks-blocked"></a>
### C9. Provider webhooks never arrive, or arrive and are rejected (401/403/302)

**Causes:** (1) a login gate (SSO, basic auth, a "sign in" redirect) in front of DSH also
covers the webhook path; (2) the reverse proxy does not forward the path, or rewrites
scheme/host/port so the request signature no longer matches (providers sign the exact
public URL they called); (3) a firewall or the home router blocks the provider.

**Diagnose**
```bash
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -X POST <public-base-url>/voice/incoming
```
`302` to a login page = login gate (cause 1). `403` with code `PHONE_SIGNATURE_INVALID` =
the route is reached and an unsigned request is correctly refused (good). Then compare
the URL configured at the provider with the one the plugin reconstructs
(`publicBaseUrl` plus the path; `provider/check` lists both, see entry 2).

**Fix:** expose ONLY the webhook path (default `/phone-hook/`) without the login gate (rate-limited), keep every
other DSH path behind it **[HUMAN]**. Configure the public base URL in the plugin's
settings (`publicBaseUrl`) exactly as the provider calls it, and make the proxy pass `X-Forwarded-Proto`
and `X-Forwarded-Host`.

<a id="c10-media-nat"></a>
### C10. Voice and media: calls connect but there is no audio, or one-way audio

Applies to the SIP relay (SIP/RTP); browser calls through the provider's WebRTC SDK need no port forward.
**Causes:** (1) NAT: the media ports are not reachable from the provider, and many cloud
providers do not "latch" (send media back to where your media came from), so a
port-restricted NAT drops theirs; (2) the router's SIP ALG rewrites SIP and remaps RTP
source ports; (3) the provider has no IPv6, so an IPv6-only path does not help; (4) a
load limit on the media server rejects calls (SIP 503).
**Diagnose:** capture on the media port range during a short test call
(`sudo tcpdump -ni any udp portrange 10000-10100 -c 50`, the relay's RTP range): no inbound packets =
1 or 2. Compare the port announced in SDP with the source port seen on the wire from a
public test peer: different = SIP ALG.
**Fix:** forward the RTP range to the media host **[HUMAN]**; switch the router's SIP ALG
off **[HUMAN]**; or use SIP over TLS (5061) with SRTP towards the provider (`relay.bridgeTransport: tls`), which hides SIP
from the ALG with no router change. Remove media-server load limits that reject calls on a
busy host (entries 8 and 9).
<!-- /dsh-common-install -->

<a id="t-server-audio"></a>
## 9. Server audio route: no audio, or the call screen shows an audio error

The Phone tab carries call audio over one wss socket to this host by default ("Call audio: Via server"). Check, in order:

1. **Test audio** in the Phone tab (dialer): speak, you should hear yourself after a short delay and see packet counters move both ways. No call, no cost. If the test fails, the network or the GUI connection is the problem, not the phone line.
2. "Server audio is not available yet": the plugin routes load at the next dsh web restart (PHONE_AUDIO_UNAVAILABLE). Until then the tab uses the direct route.
3. Microphone denied: allow the microphone for the GUI origin in the browser and reload the tab.
4. A SIP line call fails at once (PHONE_AUDIO_LEG_FAILED): `sudo asterisk -rx 'module show like audiosocket'` must list chan_audiosocket and res_audiosocket as Running; the AMI user needs `write=...originate` (generated by phone-hookd into /etc/asterisk/dsh-phone/manager.conf).
5. Silent call: the call log row keeps per-call audio stats (packets and bytes each way, jitter, first audio time). `far.in = 0` means the far end sent nothing; `up.packets = 0` means the browser sent nothing (microphone).
6. Switch the route to Direct in the Phone tab to compare (WebRTC straight to Twilio; needs UDP to Twilio).
