# dsh-phone security model

A phone line spends money and speaks as its owner, and the host it runs on (a DSH web UI) usually has shell access. The design keeps those two facts apart.

## Surfaces

| Surface | Who reaches it | Protection |
|---|---|---|
| `https://<host>/phone-hook/*` | the internet (Twilio) | Edge router sends ONLY this prefix, without the login middleware, to phone-hookd's public listener on `127.0.0.1:3098`, rate limited (20 req/s, burst 60). Every POST must carry a valid `X-Twilio-Signature` (HMAC-SHA1 with the account auth token over the exact public URL plus the sorted form parameters, compared in constant time) or it gets 403 and is logged with the client IP. The only GET is `/phone-hook/health` (returns `{ok:true}` and nothing else). Bodies are capped at 64 KB, request time at 15 s. |
| `~/.dsh/phone/hookd.sock` | the DSH plugin | Unix socket, mode 0600, directory 0700. Not reachable over the network. |
| `/dsh-phone/api/*` | the browser | Behind your site login (for example a forward-auth proxy in front of DSH), then the dsh-hpc / dsh-mail gates: L1 loopback peer, L2 trusted Host + same-origin (Origin and `Sec-Fetch-Site` on writes, JSON only), L3 short-lived HMAC capability token (`x-dsh-phone-token`, 15 min), L4 harness session cookie present. Reads need L1 and L2. |
| Agent tools | models in DSH | `phone_sms_send` and `phone_call_say` return a draft unless `confirm: true`; each class (SMS, calls, mode changes) can be switched off in Settings. |

phone-hookd never talks to dsh, dsh-proxy or a shell. The public handlers only parse provider form posts, write to its own SQLite database, and answer TwiML. The systemd unit runs it with `ProtectSystem=strict`, `ProtectHome=read-only` (write access only to `~/.dsh/phone`), `NoNewPrivileges`, an empty capability set, `PrivateDevices`, restricted address families and a 512 MB memory cap.

## Secrets

- Auth token, API key secret and SIP password are accepted from Settings, from a `KEY=value` credentials file, or (API key, TwiML App) from what **Apply to Twilio** created, stored in `~/.dsh/phone/provisioned.json` with mode 0600.
- No read endpoint returns a secret. `GET /settings` replaces each one with the marker `__set__`; saving the marker back keeps the stored value.
- Browser access tokens (Twilio JWT, one hour) are minted only on an authenticated POST and carry one identity.
- Outgoing calls through the TwiML App are accepted only from `client:<identity>`.
- Recordings and MMS are fetched with account credentials only from `https://api.twilio.com/2010-04-01/Accounts/<this account>/...` (no open proxy), stored 0600 and served back only through the gated API. Recordings are deleted from Twilio after download (setting `voicemail.deleteFromProvider`).

## Abuse limits

- Blocked contacts are rejected (calls) or hidden (texts); anonymous callers can be rejected.
- The DND auto reply is sent at most once per sender every 12 hours, so two auto-responders cannot loop.
- Caller-controlled text (names, transcripts, message bodies) is rendered as text in React; TwiML output is built with an escaping builder (unit tested).

## Reporting

Open a private security advisory on the GitHub repository.
