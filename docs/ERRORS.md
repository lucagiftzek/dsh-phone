# Error codes: dsh-phone

Every HTTP error body from the plugin routes and from the hook daemon, and every log line of the daemon, uses these codes. Error bodies have this shape:

```json
{ "ok": false, "error": "<legacy short string or message>", "code": "PHONE_SIGNATURE_INVALID",
  "message": "Webhook signature did not validate", "hint": "...", "docs": "docs/ERRORS.md#phone_signature_invalid" }
```

`error` keeps the text older clients already read (the same string as before codes existed); `code`, `message`, `hint` and `docs` are added. Some bodies carry extra fields (the plugin gate adds `layer`). HTTP statuses are unchanged from before the codes were added. Failed agent tool results (`phone_*`) have the same shape: `{ ok: false, error, code, message, hint, docs, text }`, where `error` and `text` are the strings tools returned before codes existed.

Webhook answers to the provider stay TwiML (or empty 204) on success; only the refusals (403, 404, 405, 503) now carry a JSON body. Daemon log lines start with the code, so `journalctl -u dsh-phone-hookd | grep PHONE_SIGNATURE_INVALID` finds them. The doctor (`GET /dsh-phone/api/doctor`, tool `phone_doctor`) reuses these codes on its failing checks.

| Code | HTTP | Where it appears | Meaning | Agent action |
|---|---|---|---|---|
| PHONE_INTERNAL | 400 (legacy) | any route | Unexpected error in the phone plugin or its daemon | Read the log line with the same code (daemon journal, `dsh web` log), note the request, and report a bug with the line ([details](#phone_internal)) |
| PHONE_NOT_FOUND | 404 | route `/dsh-phone/api/*` unknown path, daemon private socket unknown path, webhook listener unknown path | No such route | Check the path against the README routes ([details](#phone_not_found)) |
| PHONE_METHOD_NOT_ALLOWED | 405 | plugin gate, webhook listener | Wrong HTTP method for this route | Use the right method ([details](#phone_method_not_allowed)) |
| PHONE_BODY_INVALID | 400 | plugin routes, daemon private socket | Request body is not valid JSON | Send a JSON object with `content-type: application/json` ([details](#phone_body_invalid)) |
| PHONE_BODY_TOO_LARGE | 413 (400 on plugin routes, legacy) | plugin routes | Request body is too large | Send less data (for example fewer settings keys at once) ([details](#phone_body_too_large)) |
| PHONE_PEER_NOT_LOOPBACK | 403 | plugin gate L1 | The request did not come from the local machine | Call the API from the DSH machine or through the proxy that connects over loopback ([details](#phone_peer_not_loopback)) |
| PHONE_HOST_UNTRUSTED | 403 | plugin gate L2 | Cross-site request or untrusted Host header | Open DSH through localhost or add the public host to `trustedHosts` (Settings > Phone); send the request from the page itself, not cross-site ([details](#phone_host_untrusted)) |
| PHONE_CONTENT_TYPE_INVALID | 415 | plugin gate L2 | Mutating requests must be application/json | Send the header ([details](#phone_content_type_invalid)) |
| PHONE_TOKEN_INVALID | 403 | plugin gate L3 | Capability token missing, malformed, wrong or expired | Reload the Phone tab (it fetches `GET /dsh-phone/api/session`), then retry ([details](#phone_token_invalid)) |
| PHONE_SESSION_COOKIE_MISSING | 403 | plugin gate L4 | The DSH browser-session cookie is missing | Open DSH through its launch URL in that browser and reload ([details](#phone_session_cookie_missing)) |
| PHONE_SECRET_NOT_READY | 503 | route `GET /dsh-phone/api/session`, plugin gate L3 | The per-install secret is not ready yet | Retry after a second ([details](#phone_secret_not_ready)) |
| PHONE_SETTINGS_UNAVAILABLE | 503 | route `POST /dsh-phone/api/settings` | The DSH settings service cannot be written | See the troubleshooting entry and C3 ([details](#phone_settings_unavailable)) |
| PHONE_HOOKD_UNAVAILABLE | 503 | any `/dsh-phone/api/*` route that proxies to the daemon | phone-hookd is not reachable | Read-only: `systemctl status dsh-phone-hookd`, `ls -la ~/.dsh/phone/hookd.sock`, `journalctl -u dsh-phone-hookd -n 60` ([details](#phone_hookd_unavailable)) |
| PHONE_HOOKD_TIMEOUT | 503 (legacy) | any proxied route | phone-hookd did not answer in time | Check the daemon log and load; a provider Apply on a slow network can be long ([details](#phone_hookd_timeout)) |
| PHONE_HOOKD_ERROR | 400 or the daemon status (legacy) | any proxied route | phone-hookd reported an error without a code | Update and restart the daemon so both run the same build ([details](#phone_hookd_error)) |
| PHONE_MODE_INVALID | 400 | daemon `POST /mode`, tool `phone_set_mode` | Mode must be live, voicemail or dnd | Send one of the three ([details](#phone_mode_invalid)) |
| PHONE_NUMBER_INVALID | 400 | daemon `POST /sms/send`, `POST /call/say`, `POST /contacts/save` | Not a valid phone number | Use `+` country code number, or set `defaultCountry` in Settings ([details](#phone_number_invalid)) |
| PHONE_MESSAGE_INVALID | 400 | daemon `POST /sms/send`, `POST /call/say` | The message text is empty or too long | Send non-empty text within the limit ([details](#phone_message_invalid)) |
| PHONE_LINE_UNAVAILABLE | 400 | daemon `POST /sms/send`, `POST /call/say` | No enabled line can do this | Settings > Phone > Lines: add or enable the line and switch SMS or voice on ([details](#phone_line_unavailable)) |
| PHONE_AGENT_ACTION_DISABLED | 403 (tool result, no HTTP) | tools `phone_set_mode`, `phone_sms_send`, `phone_call_say` | This action is switched off for agents in Settings | Do not retry; ask the human to enable it in Settings > Phone > Agent if it is wanted ([details](#phone_agent_action_disabled)) |
| PHONE_PROVIDER_NOT_CONFIGURED | 400 | daemon routes that call the provider | Provider account SID and auth token are not configured | Fill both in Settings > Phone or in the `KEY=value` credentials file (mode 0600), then retry ([details](#phone_provider_not_configured)) |
| PHONE_PUBLIC_URL_MISSING | 503 on webhooks, 400 on Apply (legacy) | webhook listener | The public webhook base URL is not set | Set it to the exact HTTPS URL the provider calls, Save, run Apply ([details](#phone_public_url_missing)) |
| PHONE_VOICE_TOKEN_INCOMPLETE | 400 | daemon `GET /token` via `POST /dsh-phone/api/token` | Cannot mint a browser access token: API key or identity is missing | Run Apply to Twilio, then reload the tab ([details](#phone_voice_token_incomplete)) |
| PHONE_PROVIDER_AUTH_FAILED | 401 | any daemon route that calls the provider | The provider rejected the credentials | Read-only: `provider/check` account row ([details](#phone_provider_auth_failed)) |
| PHONE_PROVIDER_REQUEST_FAILED | 400 | any daemon route that calls the provider | The provider refused the request | Read the provider message in `error`; check the provider console for the number, geo permissions and balance ([details](#phone_provider_request_failed)) |
| PHONE_PROVIDER_UNREACHABLE | 400 (legacy) | any daemon route that calls the provider | The provider API did not answer | Check outbound HTTPS and DNS from the server; retry later ([details](#phone_provider_unreachable)) |
| PHONE_VOICEMAIL_NOT_FOUND | 400 | daemon `POST /pickup` | Voicemail not found | List voicemails again ([details](#phone_voicemail_not_found)) |
| PHONE_VOICEMAIL_NO_AUDIO | 404 on audio, 400 on retranscribe (legacy) | daemon `GET /voicemail/audio` | This voicemail has no audio file | Check the voicemail status (`failed`, `empty`) and `PHONE_RECORDING_DOWNLOAD_FAILED` in the log ([details](#phone_voicemail_no_audio)) |
| PHONE_PICKUP_TOO_LATE | 400 | daemon `POST /pickup` | The caller is no longer leaving a message | Nothing to fix; call the person back ([details](#phone_pickup_too_late)) |
| PHONE_TRANSCRIBE_FAILED | 400 | daemon `POST /voicemail/retranscribe` | Transcription failed | Check `voicemail.transcriber`, `localUrl`, the credentials file and that the service runs; then Retranscribe ([details](#phone_transcribe_failed)) |
| PHONE_RECORDING_DOWNLOAD_FAILED | 500 | log | Could not download the voicemail recording from the provider | See the provider credentials entry; the voicemail is marked `failed` ([details](#phone_recording_download_failed)) |
| PHONE_LIVE_TRANSCRIPT_FAILED | 500 | log | The provider live transcription reported an error | Check `voicemail.liveLanguage`, `liveEngine`, `liveModel`; the final transcript is unaffected ([details](#phone_live_transcript_failed)) |
| PHONE_SIGNATURE_INVALID | 403 | webhook listener `POST <publicBaseUrl>/*` | Webhook signature did not validate | Probe with an unsigned POST (expect this code) ([details](#phone_signature_invalid)) |
| PHONE_WEBHOOK_HANDLER_FAILED | 500 | log only | A webhook handler threw; the provider received a spoken apology | Read the stack after the code in the daemon log and report a bug unless it names a configuration problem ([details](#phone_webhook_handler_failed)) |
| PHONE_SMS_DELIVERY_FAILED | 500 | log | The provider reported an SMS as failed or undelivered | Look the provider error code up; see the SMS entry ([details](#phone_sms_delivery_failed)) |
| PHONE_OUTBOUND_CLIENT_REFUSED | 500 | log | An outbound browser call came from an unexpected client identity | Reload the tab so it mints a token for the current identity ([details](#phone_outbound_client_refused)) |
| PHONE_OUTBOUND_DESTINATION_BLOCKED | 500 | log | The destination is not allowed from this SIP line | Adjust the prefixes in the SIP account if the call should be allowed ([details](#phone_outbound_destination_blocked)) |
| PHONE_SIP_LINE_UNKNOWN | 500 | log | A relay call arrived for a line that does not exist | Check that the SIP account `line` is an enabled line with provider SIP ([details](#phone_sip_line_unknown)) |
| PHONE_AUDIO_UNAVAILABLE | 503 | plugin `POST /dsh-phone/api/audio/ticket`, audio socket upgrade | The server audio route is not available | Restart dsh web (human); the tab uses Direct meanwhile ([details](#phone_audio_unavailable)) |
| PHONE_AUDIO_INSECURE | 426 | audio socket upgrade | The audio socket must use wss (TLS) | Use the https address of the GUI ([details](#phone_audio_insecure)) |
| PHONE_AUDIO_BUSY | 429 | daemon `POST /audio/ticket` | The server already carries its maximum number of audio sessions | Wait or raise audio.maxCalls ([details](#phone_audio_busy)) |
| PHONE_AUDIO_SESSION_GONE | 404 | daemon `POST /audio/ticket` | The audio session ended or the call is no longer ringing | Nothing to fix ([details](#phone_audio_session_gone)) |
| PHONE_AUDIO_LEG_FAILED | 502 | audio socket control `error`, log | The server could not set up the far leg of the call | Run phone_doctor and read the hookd log line ([details](#phone_audio_leg_failed)) |
| PHONE_RELAY_DIR_UNUSABLE | 500 | log, state `relay.errors` | The media server include directory is missing or not writable | Create it as in RELAY.md install step 2 and add it to `ReadWritePaths` of the daemon unit ([details](#phone_relay_dir_unusable)) |
| PHONE_RELAY_DIR_FOREIGN | 409 | log, state `relay.errors` | The media server include directory belongs to another dsh-phone instance | Set `relay.configDir` to this instance's own directory; never edit the other instance's files ([details](#phone_relay_dir_foreign)) |
| PHONE_RELAY_AMI_FAILED | 500 | log, state `relay.errors`, `relay/status` `error` | The media server manager interface (AMI) rejected or did not answer | Read-only: `systemctl status asterisk`, `ss -ltn | grep 5038` ([details](#phone_relay_ami_failed)) |
| PHONE_RELAY_SYNC_FAILED | 500 | log, state `relay.errors` | Relay configuration could not be written or reloaded | Read the detail and the account `issues` in the state output; correct the settings ([details](#phone_relay_sync_failed)) |
| PHONE_STORE_UNAVAILABLE | 500 | log at daemon start | The phone database could not be opened | Check `node -v`, the data directory mode and free space; restart the daemon ([details](#phone_store_unavailable)) |

### PHONE_INTERNAL
- **Meaning:** Unexpected error in the phone plugin or its daemon.
- **Where:** any route, log (`PHONE_INTERNAL <detail>`). Status 400 (legacy).
- **Likely causes:** An unexpected exception in the plugin or the daemon (a bug, a full disk, a corrupted database row). Routes keep their legacy status (400) and put the original text in `error`.
- **Agent action:** Read the log line with the same code (daemon journal, `dsh web` log), note the request, and report a bug with the line. Do not retry in a loop.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-facts)

### PHONE_NOT_FOUND
- **Meaning:** No such route.
- **Where:** route `/dsh-phone/api/*` unknown path, daemon private socket unknown path, webhook listener unknown path. Status 404, legacy `error` text `not found`.
- **Likely causes:** A typo in the path, a plugin older or newer than the daemon, or a webhook path the daemon does not serve.
- **Agent action:** Check the path against the README routes. If every path answers it, the plugin is not loaded: restart `dsh web` (C1, C2).
- **Needs the human:** only for the restart
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-tab-missing)

### PHONE_METHOD_NOT_ALLOWED
- **Meaning:** Wrong HTTP method for this route.
- **Where:** plugin gate, webhook listener (also sets `allow: POST`). Status 405.
- **Likely causes:** A GET on a webhook path, or a non-POST on a mutating route.
- **Agent action:** Use the right method. A provider only POSTs webhooks; a browser GET on a webhook path is expected to be refused.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-webhooks)

### PHONE_BODY_INVALID
- **Meaning:** Request body is not valid JSON.
- **Where:** plugin routes, daemon private socket. Status 400.
- **Likely causes:** The request body is not valid JSON.
- **Agent action:** Send a JSON object with `content-type: application/json`.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-facts)

### PHONE_BODY_TOO_LARGE
- **Meaning:** Request body is too large.
- **Where:** plugin routes (answered with 400, legacy), daemon private socket (413), webhook listener (logged as `PHONE_WEBHOOK_HANDLER_FAILED`, the provider gets a spoken apology). Status 413 (400 on plugin routes, legacy).
- **Likely causes:** A body above the limit (256 KB plugin, 512 KB daemon socket, 64 KB webhook).
- **Agent action:** Send less data (for example fewer settings keys at once).
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-settings-02x)

### PHONE_PEER_NOT_LOOPBACK
- **Meaning:** The request did not come from the local machine.
- **Where:** plugin gate L1. Status 403.
- **Likely causes:** The request reached `dsh web` from a non-loopback address, for example by hitting its port directly from another host instead of through the local proxy.
- **Agent action:** Call the API from the DSH machine or through the proxy that connects over loopback.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-facts)

### PHONE_HOST_UNTRUSTED
- **Meaning:** Cross-site request or untrusted Host header.
- **Where:** plugin gate L2. Status 403.
- **Likely causes:** The `Host` header is not loopback and not in `trustedHosts`, or the request is cross-site, or a mutating request lacks `Origin`/`Sec-Fetch-Site: same-origin`.
- **Agent action:** Open DSH through localhost or add the public host to `trustedHosts` (Settings > Phone); send the request from the page itself, not cross-site.
- **Needs the human:** maybe (settings)
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-browser-no-ring)

### PHONE_CONTENT_TYPE_INVALID
- **Meaning:** Mutating requests must be application/json.
- **Where:** plugin gate L2. Status 415.
- **Likely causes:** A mutating request without `content-type: application/json`.
- **Agent action:** Send the header.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-facts)

### PHONE_TOKEN_INVALID
- **Meaning:** Capability token missing, malformed, wrong or expired.
- **Where:** plugin gate L3 (the legacy text names the reason: no token, malformed, bad signature, expired). Status 403.
- **Likely causes:** The capability token is missing, wrong or older than 15 minutes (the tab was open for a long time, or the plugin restarted with a new secret).
- **Agent action:** Reload the Phone tab (it fetches `GET /dsh-phone/api/session`), then retry.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-settings-02x)

### PHONE_SESSION_COOKIE_MISSING
- **Meaning:** The DSH browser-session cookie is missing.
- **Where:** plugin gate L4. Status 403.
- **Likely causes:** The DSH browser-session cookie is not present on the request, so the call did not come from a signed-in DSH page.
- **Agent action:** Open DSH through its launch URL in that browser and reload. Only set `requireHarnessCookie` to false if you understand the trade-off.
- **Needs the human:** yes (sign in)
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-settings-02x)

### PHONE_SECRET_NOT_READY
- **Meaning:** The per-install secret is not ready yet.
- **Where:** route `GET /dsh-phone/api/session`, plugin gate L3. Status 503.
- **Likely causes:** The per-install secret file is not created yet (first seconds after start) or its directory is not writable.
- **Agent action:** Retry after a second. If it persists, check that the data directory (`~/.dsh/phone`) is writable by the `dsh web` user.
- **Needs the human:** maybe (file permissions)
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-settings-02x)

### PHONE_SETTINGS_UNAVAILABLE
- **Meaning:** The DSH settings service cannot be written.
- **Where:** route `POST /dsh-phone/api/settings`. Status 503, legacy `error` text `settings service unavailable`.
- **Likely causes:** The DSH settings service is not available to the plugin, or the store is not writable (0.2.x without the injected settings service or a `Config` on the default export).
- **Agent action:** See the troubleshooting entry and C3. Restart `dsh web` after updating the plugin.
- **Needs the human:** yes (restart)
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-settings-02x)

### PHONE_HOOKD_UNAVAILABLE
- **Meaning:** phone-hookd is not reachable.
- **Where:** any `/dsh-phone/api/*` route that proxies to the daemon (503). Status 503.
- **Likely causes:** The daemon is not running, its socket is missing, or the socket path differs (`DSH_PHONE_SOCKET`, `DSH_PHONE_DATA`). The plugin itself is loaded.
- **Agent action:** Read-only: `systemctl status dsh-phone-hookd`, `ls -la ~/.dsh/phone/hookd.sock`, `journalctl -u dsh-phone-hookd -n 60`. Start the daemon.
- **Needs the human:** yes (start or restart a service)
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-facts)

### PHONE_HOOKD_TIMEOUT
- **Meaning:** phone-hookd did not answer in time.
- **Where:** any proxied route (answered with 503, legacy status; message `phone-hookd: phone-hookd did not answer in time`). Status 503 (legacy).
- **Likely causes:** The daemon accepted the connection but did not answer within the timeout (30 s; 5 minutes for Apply and Retranscribe).
- **Agent action:** Check the daemon log and load; a provider Apply on a slow network can be long. Retry once.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-facts)

### PHONE_HOOKD_ERROR
- **Meaning:** phone-hookd reported an error without a code.
- **Where:** any proxied route. Status 400 or the daemon status (legacy).
- **Likely causes:** The daemon answered with an error that has no code: the daemon is older than the plugin. The original text and status are kept.
- **Agent action:** Update and restart the daemon so both run the same build.
- **Needs the human:** yes (restart)
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-old-lib)

### PHONE_MODE_INVALID
- **Meaning:** Mode must be live, voicemail or dnd.
- **Where:** daemon `POST /mode`, tool `phone_set_mode`. Status 400.
- **Likely causes:** A mode other than live, voicemail or dnd.
- **Agent action:** Send one of the three.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-browser-no-ring)

### PHONE_NUMBER_INVALID
- **Meaning:** Not a valid phone number.
- **Where:** daemon `POST /sms/send`, `POST /call/say`, `POST /contacts/save`. Status 400.
- **Likely causes:** The number cannot be turned into E.164 (no country code and no default country, letters, too short).
- **Agent action:** Use `+` country code number, or set `defaultCountry` in Settings.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-sms-not-delivered)

### PHONE_MESSAGE_INVALID
- **Meaning:** The message text is empty or too long.
- **Where:** daemon `POST /sms/send`, `POST /call/say`. Status 400.
- **Likely causes:** Empty text, or longer than `sms.maxChars`.
- **Agent action:** Send non-empty text within the limit.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-sms-not-delivered)

### PHONE_LINE_UNAVAILABLE
- **Meaning:** No enabled line can do this.
- **Where:** daemon `POST /sms/send`, `POST /call/say`. Status 400.
- **Likely causes:** No enabled line with that id, the line has SMS or voice off, or the line is not a Twilio line (SMS and spoken calls are Twilio only).
- **Agent action:** Settings > Phone > Lines: add or enable the line and switch SMS or voice on.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-sms-not-delivered)

### PHONE_AGENT_ACTION_DISABLED
- **Meaning:** This action is switched off for agents in Settings.
- **Where:** tool results of `phone_set_mode` (`agent.allowModeChange`), `phone_sms_send` (`agent.allowSms`) and `phone_call_say` (`agent.allowCalls`). Nothing was sent, changed or called.
- **Likely causes:** The matching switch under Settings > Phone > Agent is off.
- **Agent action:** Do not work around it. Tell the human which switch blocks the action.
- **Needs the human:** yes, only the human decides whether an agent may send SMS, place calls or change the mode.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-facts)

### PHONE_PROVIDER_NOT_CONFIGURED
- **Meaning:** Provider account SID and auth token are not configured.
- **Where:** daemon routes that call the provider (`/provider/*`, `/balance`, `/sms/send`, `/call/say`, `/pickup`). Status 400.
- **Likely causes:** The account SID or auth token is empty in Settings, in the credentials file and in the provisioned file.
- **Agent action:** Fill both in Settings > Phone or in the `KEY=value` credentials file (mode 0600), then retry. Never paste them into chat.
- **Needs the human:** yes (needs the account secret)
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-apply-fails)

### PHONE_PUBLIC_URL_MISSING
- **Meaning:** The public webhook base URL is not set.
- **Where:** webhook listener (503), daemon `POST /provider/apply` (answered 400, legacy). Status 503 on webhooks, 400 on Apply (legacy).
- **Likely causes:** `publicBaseUrl` is not set.
- **Agent action:** Set it to the exact HTTPS URL the provider calls, Save, run Apply.
- **Needs the human:** maybe
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-webhooks)

### PHONE_VOICE_TOKEN_INCOMPLETE
- **Meaning:** Cannot mint a browser access token: API key or identity is missing.
- **Where:** daemon `GET /token` via `POST /dsh-phone/api/token`. Status 400.
- **Likely causes:** No API key, key secret, TwiML App or identity yet, so a browser token cannot be signed.
- **Agent action:** Run Apply to Twilio, then reload the tab.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-browser-no-ring)

### PHONE_PROVIDER_AUTH_FAILED
- **Meaning:** The provider rejected the credentials.
- **Where:** any daemon route that calls the provider, log. Status 401.
- **Likely causes:** The provider answered 401: wrong account SID/auth token pair (an API key secret instead of the auth token is the usual mix-up), or the account is suspended.
- **Agent action:** Read-only: `provider/check` account row. Correct the credentials in Settings or the credentials file.
- **Needs the human:** yes (needs the account secret)
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-apply-fails)

### PHONE_PROVIDER_REQUEST_FAILED
- **Meaning:** The provider refused the request.
- **Where:** any daemon route that calls the provider, log. Status 400.
- **Likely causes:** The provider refused the request (4xx/5xx other than 401): unknown number, capability missing, balance, geo permission, validation. The status is the provider status when below 500 (else 400) and `error` carries the provider text.
- **Agent action:** Read the provider message in `error`; check the provider console for the number, geo permissions and balance.
- **Needs the human:** often (provider console, money)
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-apply-fails)

### PHONE_PROVIDER_UNREACHABLE
- **Meaning:** The provider API did not answer.
- **Where:** any daemon route that calls the provider, log. Status 400 (legacy).
- **Likely causes:** The provider API timed out or the connection failed (DNS, outbound HTTPS blocked, an incident).
- **Agent action:** Check outbound HTTPS and DNS from the server; retry later.
- **Needs the human:** maybe (firewall)
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-apply-fails)

### PHONE_VOICEMAIL_NOT_FOUND
- **Meaning:** Voicemail not found.
- **Where:** daemon `POST /pickup`. Status 400.
- **Likely causes:** The voicemail id or call SID is unknown (deleted, or the call already ended).
- **Agent action:** List voicemails again.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-transcript-missing)

### PHONE_VOICEMAIL_NO_AUDIO
- **Meaning:** This voicemail has no audio file.
- **Where:** daemon `GET /voicemail/audio` (404), `POST /voicemail/retranscribe` (answered 400, legacy). Status 404 on audio, 400 on retranscribe (legacy).
- **Likely causes:** The voicemail has no audio file: the recording never downloaded or the file was removed.
- **Agent action:** Check the voicemail status (`failed`, `empty`) and `PHONE_RECORDING_DOWNLOAD_FAILED` in the log.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-transcript-missing)

### PHONE_PICKUP_TOO_LATE
- **Meaning:** The caller is no longer leaving a message.
- **Where:** daemon `POST /pickup`. Status 400.
- **Likely causes:** The caller already hung up or the recording is finished.
- **Agent action:** Nothing to fix; call the person back.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-browser-no-ring)

### PHONE_TRANSCRIBE_FAILED
- **Meaning:** Transcription failed.
- **Where:** daemon `POST /voicemail/retranscribe`, log (final transcription of a new voicemail). Status 400.
- **Likely causes:** The speech-to-text endpoint is not configured, unreachable or returned an error, or the Mistral key is missing.
- **Agent action:** Check `voicemail.transcriber`, `localUrl`, the credentials file and that the service runs; then Retranscribe. The live transcript stays as a fallback.
- **Needs the human:** maybe (start the service)
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-transcript-missing)

### PHONE_RECORDING_DOWNLOAD_FAILED
- **Meaning:** Could not download the voicemail recording from the provider.
- **Where:** log. Status 500.
- **Likely causes:** The recording could not be fetched from the provider (credentials, or it was already deleted).
- **Agent action:** See the provider credentials entry; the voicemail is marked `failed`.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-transcript-missing)

### PHONE_LIVE_TRANSCRIPT_FAILED
- **Meaning:** The provider live transcription reported an error.
- **Where:** log. Status 500.
- **Likely causes:** The provider reported an error on the live transcription stream (unsupported language or model, feature not enabled on the account).
- **Agent action:** Check `voicemail.liveLanguage`, `liveEngine`, `liveModel`; the final transcript is unaffected.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-transcript-missing)

### PHONE_SIGNATURE_INVALID
- **Meaning:** Webhook signature did not validate.
- **Where:** webhook listener `POST <publicBaseUrl>/*` (403), log. Status 403.
- **Likely causes:** The `X-Twilio-Signature` is missing or does not match `publicBaseUrl + path + params`: an unsigned probe (fine), a login gate or proxy rewriting scheme, host, port or path, a different public URL, or a wrong or empty auth token (the log line says "no auth token configured").
- **Agent action:** Probe with an unsigned POST (expect this code). If real provider traffic is refused: compare `publicBaseUrl` with the URL in the provider console, check the proxy forwards the original scheme and host, check the auth token.
- **Needs the human:** yes (edge, proxy or provider console)
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-webhooks)

### PHONE_WEBHOOK_HANDLER_FAILED
- **Meaning:** A webhook handler threw; the provider received a spoken apology.
- **Where:** log only (the provider receives TwiML with a spoken apology, HTTP 200). Status 500.
- **Likely causes:** A webhook handler threw (database error, bad provider payload, a bug).
- **Agent action:** Read the stack after the code in the daemon log and report a bug unless it names a configuration problem.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-webhooks)

### PHONE_SMS_DELIVERY_FAILED
- **Meaning:** The provider reported an SMS as failed or undelivered.
- **Where:** log (status callback `failed` or `undelivered`). Status 500.
- **Likely causes:** The provider could not deliver a text; the log carries the provider error code and the thread shows the same on the message.
- **Agent action:** Look the provider error code up; see the SMS entry.
- **Needs the human:** often (sender registration, geo permission, money)
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-sms-not-delivered)

### PHONE_OUTBOUND_CLIENT_REFUSED
- **Meaning:** An outbound browser call came from an unexpected client identity.
- **Where:** log (the caller hears "This client is not allowed to place calls."). Status 500.
- **Likely causes:** An outgoing browser call arrived from a client identity other than the configured `identity`.
- **Agent action:** Reload the tab so it mints a token for the current identity.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-browser-no-ring)

### PHONE_OUTBOUND_DESTINATION_BLOCKED
- **Meaning:** The destination is not allowed from this SIP line.
- **Where:** log (the caller hears "This number cannot be called from this line."). Status 500.
- **Likely causes:** The SIP account policy refused the destination: outside `allowPrefixes`, inside `blockPrefixes`, or not E.164.
- **Agent action:** Adjust the prefixes in the SIP account if the call should be allowed.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-relay-registration)

### PHONE_SIP_LINE_UNKNOWN
- **Meaning:** A relay call arrived for a line that does not exist.
- **Where:** log (the relay call is rejected). Status 500.
- **Likely causes:** A call arrived from the SIP relay for a line id that does not exist, is disabled, or is not a SIP line.
- **Agent action:** Check that the SIP account `line` is an enabled line with provider SIP.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-relay-registration)

### PHONE_AUDIO_UNAVAILABLE
- **Meaning:** The server audio route is not available.
- **Where:** plugin route `POST /dsh-phone/api/audio/ticket` and the audio socket upgrade. Status 503.
- **Likely causes:** dsh web has not been restarted since the plugin update, or phone-hookd runs an older version.
- **Agent action:** Report it; the human restarts dsh web. The Phone tab uses the direct route meanwhile.
- **Needs the human:** yes (restart)
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-server-audio)

### PHONE_AUDIO_INSECURE
- **Meaning:** The audio socket was opened without TLS.
- **Where:** plugin audio socket upgrade. Status 426.
- **Likely causes:** The GUI is reached over plain http on a non-loopback host.
- **Agent action:** Use the https address of the GUI.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-server-audio)

### PHONE_AUDIO_BUSY
- **Meaning:** The server already carries its maximum number of audio sessions.
- **Where:** daemon `POST /audio/ticket`. Status 429.
- **Likely causes:** Two calls (default audio.maxCalls) or an audio test are already running.
- **Agent action:** Wait, or ask the human to raise the limit.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-server-audio)

### PHONE_AUDIO_SESSION_GONE
- **Meaning:** The audio session ended, or the incoming call is no longer ringing.
- **Where:** daemon `POST /audio/ticket` (answer, resume). Status 404.
- **Likely causes:** The caller hung up, another tab answered, or voicemail took the call.
- **Agent action:** Nothing to fix.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-server-audio)

### PHONE_AUDIO_LEG_FAILED
- **Meaning:** The server could not set up the far leg of a call.
- **Where:** daemon audio hub (AMI Originate for SIP lines, Twilio REST for Twilio lines). Status 502.
- **Likely causes:** Asterisk down or chan_audiosocket not loaded, AMI user without originate, Twilio rejected the call (balance, geo permissions).
- **Agent action:** Run phone_doctor and read the hookd journal line with this code.
- **Needs the human:** maybe
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-server-audio)

### PHONE_RELAY_DIR_UNUSABLE
- **Meaning:** The media server include directory is missing or not writable.
- **Where:** log, state `relay.errors`. Status 500.
- **Likely causes:** The include directory for the generated media server files is missing or not writable by the daemon user.
- **Agent action:** Create it as in RELAY.md install step 2 and add it to `ReadWritePaths` of the daemon unit.
- **Needs the human:** yes (root)
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-relay-registration)

### PHONE_RELAY_DIR_FOREIGN
- **Meaning:** The media server include directory belongs to another dsh-phone instance.
- **Where:** log, state `relay.errors`. Status 409.
- **Likely causes:** Two phone-hookd instances (for example a test install next to the real one) point at the same include directory. Each generated file starts with `; dsh-phone-instance: <id>` (the id is kept in `relay.json` of the data directory) and an instance never writes over files that carry another id.
- **Agent action:** Read-only: `head -1 <dir>/pjsip.conf` and compare with `instanceId` in this instance's `relay.json` (never print the other fields). Point `relay.configDir` at this instance's own directory, or leave the relay off here.
- **Needs the human:** maybe
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-relay-registration)

### PHONE_RELAY_AMI_FAILED
- **Meaning:** The media server manager interface (AMI) rejected or did not answer.
- **Where:** log, state `relay.errors`, `relay/status` `error`. Status 500.
- **Likely causes:** The manager interface refused the login, did not answer, or a module reload failed (media server down, manager include not loaded yet).
- **Agent action:** Read-only: `systemctl status asterisk`, `ss -ltn | grep 5038`. Start the media server; a restart may be needed once for the manager include.
- **Needs the human:** yes (service restart)
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-relay-registration)

### PHONE_RELAY_SYNC_FAILED
- **Meaning:** Relay configuration could not be written or reloaded.
- **Where:** log, state `relay.errors`. Status 500.
- **Likely causes:** The relay configuration could not be rendered or written for another reason (invalid account fields, a value that is unsafe for the dialplan).
- **Agent action:** Read the detail and the account `issues` in the state output; correct the settings.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-relay-registration)

### PHONE_STORE_UNAVAILABLE
- **Meaning:** The phone database could not be opened.
- **Where:** log at daemon start (the daemon then exits). Status 500.
- **Likely causes:** The SQLite database could not be opened: data directory missing or not writable, disk full, or `node:sqlite` unavailable (Node older than 22.5).
- **Agent action:** Check `node -v`, the data directory mode and free space; restart the daemon.
- **Needs the human:** maybe
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-facts)
