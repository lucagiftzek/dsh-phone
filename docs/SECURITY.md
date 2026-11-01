# dsh-phone security model

A phone line spends money and speaks as its owner, and the host it runs on (a DSH web UI) usually has shell access. The design keeps those two facts apart.

## Surfaces

| Surface | Who reaches it | Protection |
|---|---|---|
| `https://<host>/phone-hook/*` | the internet (Twilio) | Edge router sends ONLY this prefix, without the login middleware, to phone-hookd's public listener on `127.0.0.1:3098`, rate limited (20 req/s, burst 60). Every POST must carry a valid `X-Twilio-Signature` (HMAC-SHA1 with the account auth token over the exact public URL plus the sorted form parameters, compared in constant time) or it gets 403 and is logged with the client IP. The only GET is `/phone-hook/health` (returns `{ok:true}` and nothing else). Bodies are capped at 64 KB, request time at 15 s. |
| `~/.dsh/phone/hookd.sock` | the DSH plugin | Unix socket, mode 0600, directory 0700. Not reachable over the network. |
| `/dsh-phone/api/*` | the browser | Behind your site login (for example a forward-auth proxy in front of DSH), then the dsh-hpc / dsh-mail gates: L1 loopback peer, L2 trusted Host + same-origin (Origin and `Sec-Fetch-Site` on writes, JSON only), L3 short-lived HMAC capability token (`x-dsh-phone-token`, 15 min), L4 harness session cookie present. Reads need L1 and L2. |
| `/dsh-phone/api/io` (audio socket) | the browser | One generic WebSocket endpoint, upgrade only. Same gates as a write before the 101: loopback peer, trusted Host, an Origin equal to the Host, the harness cookie, and TLS on the outer hop (`X-Forwarded-Proto: https` and an https Origin; plain ws only for a loopback Host). The capability is a one-time ticket (60 s) minted by the gated `POST /audio/ticket` and offered in `Sec-WebSocket-Protocol`; phone-hookd checks and consumes it. The server sends nothing before the client's hello. |
| `wss://<host>/phone-hook/s` (Twilio Media Streams) | Twilio | Upgrade refused (403) without a valid `X-Twilio-Signature` over the wss URL; the stream must then present a one-time ticket (3 min) bound to its CallSid in the start message, else it is closed (1008). At most `maxCalls + 4` such sockets. |
| AudioSocket `127.0.0.1:9093` | Asterisk | Loopback only; a connection whose UUID hookd did not originate is closed at once. |
| SIP relay (Asterisk) | SIP providers, Twilio | Binds the LAN address and 127.0.0.1 only, registrations outbound, providers identified by IP, everything else hangs up. Outgoing calls need the bridge key (only its digest is on disk). AMI on 127.0.0.1 with one least-privilege user. Details: [RELAY.md](RELAY.md). |
| Agent tools | models in DSH | `phone_sms_send` and `phone_call_say` return a draft unless `confirm: true`; each class (SMS, calls, mode changes) can be switched off in Settings. |
| `~/.dsh/phone/telegram/telegramd.sock` | phone-hookd | telegramd (Telegram account, unreleased): unix socket 0600 in a 0700 directory, no network listener. Its session, update state and credentials are sealed (AES-256-GCM, key in a separate 0600 file); the QR login token is rendered to a PNG on the server and never sent as text; the cloud password is used once and not stored. Agent sends are direct but limited to existing conversations or an allowlist, rate capped, audited, and paused 24 h on Telegram's spam signal. Details: [TELEGRAM.md](TELEGRAM.md). |
| `/dsh-phone/api/tg/*` | the browser | Same gates as the other reads and writes; writes are forced to `origin: ui`; a browser can upload its own file but can never make the server send one of its files. |

phone-hookd never talks to dsh, dsh-proxy or a shell. The public handlers only parse provider form posts, write to its own SQLite database, and answer TwiML. The systemd unit runs it with `ProtectSystem=strict`, `ProtectHome=read-only` (write access only to `~/.dsh/phone`), `NoNewPrivileges`, an empty capability set, `PrivateDevices`, restricted address families and a 512 MB memory cap.

## Secrets

- Auth token, API key secret and SIP password are accepted from Settings, from a `KEY=value` credentials file, or (API key, TwiML App) from what **Apply to Twilio** created, stored in `~/.dsh/phone/provisioned.json` with mode 0600.
- No read endpoint returns a secret. `GET /settings` replaces each one with the marker `__set__`; saving the marker back keeps the stored value.
- Browser access tokens (Twilio JWT, one hour) are minted only on an authenticated POST and carry one identity.
- Outgoing calls through the TwiML App are accepted only from `client:<identity>`.
- Recordings and MMS are fetched with account credentials only from `https://api.twilio.com/2010-04-01/Accounts/<this account>/...` (no open proxy), stored 0600 and served back only through the gated API. Recordings are deleted from Twilio after download (setting `voicemail.deleteFromProvider`).

## Encryption per call leg (server audio route)

| Leg | Transport |
|---|---|
| Browser to DSH host | TLS (wss through the Cloudflare tunnel and the edge), always |
| DSH host to phone-hookd, hookd to Asterisk | unix socket and 127.0.0.1 (never leaves the machine) |
| Twilio Media Stream to hookd | TLS (wss) |
| Asterisk to Twilio SIP Domain (bridge) | TLS signalling + SRTP media |
| Asterisk to the SIP provider (for example a residential SIP trunk) | UDP SIP + RTP, plaintext: the provider offers no TLS / SRTP today; this leg runs only between the server and the provider, never on a client |
| Twilio or the SIP provider to the PSTN | the carriers' network (not under our control) |
| telegramd to Telegram (messages, media) | MTProto 2.0 (encrypted by the protocol, server to Telegram only) |

## Abuse limits

- Blocked contacts are rejected (calls) or hidden (texts); anonymous callers can be rejected.
- The DND auto reply is sent at most once per sender every 12 hours, so two auto-responders cannot loop.
- Caller-controlled text (names, transcripts, message bodies) is rendered as text in React; TwiML output is built with an escaping builder (unit tested).

## Reporting

Open a private security advisory on the GitHub repository.
