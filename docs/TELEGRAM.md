# Telegram in the Phone tab

Status: **unreleased, in development** (messaging, voice message transcription and voice calls done; an optional bot may come later).

A Telegram account lives on the server and appears in the Phone tab next to the SMS lines: chats, groups and channels, photos, voice messages and files, posting in channels the account owns, and agent tools. The browser never talks to Telegram: it talks to the DSH origin only, and the server does the rest.

## How it fits together

```
browser (Phone tab) --HTTPS/wss, same origin--> DSH plugin /dsh-phone/api/tg/*
   --unix socket--> phone-hookd (bridge: phone.db tables tg_chats, tg_messages; events to the tabs)
   --unix socket--> telegramd (Go, gotd/td, MTProto) --MTProto over TCP--> Telegram data centres
```

- **telegramd** (`telegramd/`, Go): holds the account. It listens on **no network port**, only on `~/.dsh/phone/telegram/telegramd.sock` (0600, directory 0700). It keeps the MTProto session, the update state (with gap recovery after downtime) and the access hashes of known chats, all sealed with AES-256-GCM under a key in `vault.key` (0600) or a systemd credential `telegramd.key`. Downloaded media go to a size-capped cache (`media/`, least recently used files go first).
- **phone-hookd** follows telegramd's event stream, stores chats and messages in `phone.db` (it stays the only writer of that database) and serves `/tg/*` on its private socket.
- **The plugin** gates every browser request (site login, same origin, capability token for writes) and forwards `/tg/*` as it is. Writes from the browser are marked `origin: ui`; the agent tools send `origin: agent`. Server files can only be sent by agents (`telegram_send_media`), never by a browser request; the browser uploads its own file through `/tg/upload`.

Media, link previews and the login QR code are fetched by the server and served from the DSH origin.

## Setup

1. **Account safety first.** In the Telegram app: Settings, Privacy and Security, Two-Step Verification: set a **cloud password and a recovery email**. If the account's number cannot receive SMS (a virtual number, for example), this is what keeps the account recoverable.
2. **API credentials** from https://my.telegram.org (log in with the account's number; the code arrives inside the Telegram app), API development tools, create an application. Put them in `~/.dsh/phone/telegram/api.env` (mode 600):
   ```
   TELEGRAM_API_ID=...
   TELEGRAM_API_HASH=...
   ```
   The file wins over credentials entered in Settings; a file readable by others is refused. Never use a sample or published api_id.
3. **Build and install telegramd** (Go 1.25 or newer; compiling the generated Telegram schema needs about 5 GB of RAM once, the build cache keeps later builds small):
   ```
   cd telegramd && go build -trimpath -ldflags "-s -w" -o bin/telegramd .
   sudo install -d /usr/local/lib/dsh-phone
   sudo install -o root -g root -m 0755 bin/telegramd /usr/local/lib/dsh-phone/telegramd
   cd /usr/local/lib/dsh-phone && sha256sum telegramd | sed "s#  telegramd#  $PWD/telegramd#" | sudo tee telegramd.sha256
   sudo cp deploy/dsh-telegramd.service /etc/systemd/system/   # edit YOUR_USER first
   sudo systemctl daemon-reload && sudo systemctl enable --now dsh-telegramd
   ```
   The unit refuses to start a binary whose sha256 does not match the pinned file.
4. Restart phone-hookd, then dsh web (the plugin routes and tools load at start).
5. **Log in** in Settings, Phone, Telegram (or the Telegram tab): **QR code** (recommended: Telegram app, Settings, Devices, Link Desktop Device, scan) or **a code** sent inside the Telegram app. With two-step verification the cloud password is asked next; it is used once for the SRP check and never stored or logged. The session appears in the app's device list as "DSH Phone".

## Voice message transcription

Voice messages and video messages (round) are transcribed automatically, with the language detected, by the **same engine as the voicemails** (Settings, Voicemail, Final transcript; normally the local Whisper endpoint, so the audio never leaves the server for a third party).

- One job at a time in the background (a CPU Whisper is slow), results cached per media content (sha256 of the audio): a forwarded voice note is not transcribed twice.
- Silence (peak below -50 dB, measured with ffmpeg) is not sent to the engine, because Whisper invents words on silence; it is stored as "no speech".
- The Phone tab shows the transcript under the voice note with a language tag, "Transcribing..." while it runs, and a Transcribe or Retry button for failures, longer messages and messages older than the feature.
- `telegram_read` returns `transcript: { status, text, language, duration, engine, error?, updated }` on each voice message (status `queued`, `running`, `done`, `failed` or `skipped`).
- Settings, Telegram, Voice message transcription: automatic on or off (default on), longest message transcribed automatically (default 10 minutes), audio files too (default off). Stored in `~/.dsh/phone/telegram/transcribe.json` by phone-hookd; transcripts in `phone.db` table `tg_transcripts`.
- Routes (through the plugin's `/tg/*` passthrough): `POST /tg/transcribe {chat, msg}` (transcribe, or transcribe again), `GET` and `POST /tg/transcribe/config`.

## Voice calls

1:1 Telegram voice calls ring the Phone tab and are placed from it (call button in a chat), on the **server audio route** like the other lines: the browser talks to the DSH origin, phone-hookd bridges the audio to telegramd over `calls.sock` (0600, a per-call key), and telegramd runs the call with **libntgcalls** (LGPL-3.0, prebuilt, dynamically linked, pinned by sha256 like the binary). Media goes only through Telegram's relays (peer to peer is never enabled), so the other side never learns the server's address; it is end to end encrypted, and the call screen shows the four emoji key that also appears on the other phone. The Diffie-Hellman values are checked in telegramd before the library sees them.

- **Phone modes** (Settings, Telegram calls): Do not disturb = decline silently (or ignore); Voicemail = decline and send one polite text per caller every 12 hours (or decline silently, or ignore); Live = ring the open Phone tabs, and with no tab open ignore the call (or decline). "Ignore" leaves the call ringing on the phone app. A call the tab does not answer in time stops ringing there but keeps ringing on the phone app.
- One call at a time; outgoing calls only to people (agents: existing conversations or the allowlist), at most `calls.dailyCap` a day (default 20).
- Audio is telephone band (8 kHz G.711 inside the hub, resampled to 48 kHz for Telegram).
- Build: `scripts/fetch-ntgcalls.sh` fetches the pinned library into `telegramd/ntg/`; `go build -tags ntgcalls` (cgo) links it with an rpath to `/usr/local/lib/dsh-phone`; install `libntgcalls.so` there root-owned with `libntgcalls.sha256` next to it (the unit checks it) and the licence files. Without the tag telegramd builds without calls (`TELEGRAM_CALLS_UNAVAILABLE`).

## Agent tools

| Tool | What it does |
|---|---|
| `telegram_status` | Login state, account, unread count, agent switch and limits |
| `telegram_chats` | Chat list (users, groups, channels) with ids, unread, last message; `refresh` re-syncs |
| `telegram_read` | Messages of one chat (fetches the latest page); marks read only when allowed |
| `telegram_send` | Text message, sent directly from the account |
| `telegram_channel_post` | Post in a channel the account owns or administers |
| `telegram_send_media` | A local file as photo, voice message (converted to Ogg Opus), audio, video or document |
| `telegram_call` | Voice calls on the owner's Phone tab: `place` (the tab dials, he talks), `answer` (the tab answers the ringing call), `hangup`, `status` |
| `telegram_bot_notify` | Notification through an agents' bot: no bot yet (`TELEGRAM_BOT_NOT_CONFIGURED`) |

Chats are named by numeric id (Bot API style: users positive, groups `-id`, channels `-100...`), `@username` or exact title. Results are lossless JSON with a text summary and the structured data in `report`.

## Rules for automated use

Telegram's terms: accounts that log in with third-party API clients are put under observation, and flooding or spam gets an account banned for good (https://core.telegram.org/api/obtaining_api_id). telegramd therefore enforces, for agents:

- Only **existing conversations** (chats in the dialog list or with messages) or chats on the **allowlist** (Settings). Agents never look up unknown usernames, import contacts, add members, join by invite link or create groups or channels.
- **Limits** (Settings): one message per 3 s per chat, 30 per hour, 100 per day by default. Your own messages from the tab only have a 1 s per chat guard.
- **Flood waits**: Telegram's `FLOOD_WAIT` up to 30 s (setting) is waited out once; longer ones come back as `TELEGRAM_FLOOD_WAIT` with `retryAfter`. A `PEER_FLOOD` (Telegram's spam signal) **pauses agent sending for 24 hours** and tells the tabs; Settings has a Resume button.
- **Kill switch**: the "Agents may send" switch in Settings, or the file `~/.dsh/phone/telegram/agent-send.off`.
- **Audit log**: `~/.dsh/phone/telegram/audit.jsonl` (0600, rotated at 5 MB): every agent send, refusal and failure, login, logout and settings change, with chat id and size, never the text.
- Agents read without marking chats read unless "Agents may mark chats as read" is on.

Keep the first days of a new account low volume and human paced.

## Error codes

Every `/tg/*` answer is `{ ok: true, ... }` or `{ ok: false, code, error, retryAfter? }`.

| Code | Meaning |
|---|---|
| `TELEGRAM_NOT_CONFIGURED` | No api_id/api_hash yet |
| `TELEGRAM_NOT_LOGGED_IN` | The account is not logged in (or the session was revoked) |
| `TELEGRAM_LOGIN_STATE` | Wrong login step (no code requested, already logged in) |
| `TELEGRAM_CODE_INVALID` / `TELEGRAM_PASSWORD_INVALID` | Wrong login code or cloud password |
| `TELEGRAM_UNAVAILABLE` | Not connected to Telegram yet |
| `TELEGRAM_DAEMON_UNAVAILABLE` | telegramd is not running |
| `TELEGRAM_CHAT_NOT_FOUND` | Unknown chat, or not addressable |
| `TELEGRAM_MESSAGE_NOT_FOUND` | The message is not stored here (read the chat first) |
| `TELEGRAM_CHAT_NOT_ALLOWED` | Agents may not write there (not a conversation, not allowlisted) |
| `TELEGRAM_CANNOT_POST` | No right to write (channel subscriber, blocked, restricted) |
| `TELEGRAM_RATE_LIMITED` | Own limit reached; `retryAfter` in seconds |
| `TELEGRAM_FLOOD_WAIT` | Telegram's flood or slow mode wait; `retryAfter` |
| `TELEGRAM_PEER_FLOOD` | Telegram's spam signal (agent sending paused) |
| `TELEGRAM_AGENT_SEND_OFF` | Switch off, kill switch file, or paused after a spam signal |
| `TELEGRAM_MEDIA_TOO_LARGE` / `TELEGRAM_MEDIA_UNAVAILABLE` | Upload or download limits, missing media |
| `TELEGRAM_BAD_REQUEST` | Invalid input (empty text, over 4096 characters, bad file) |
| `TELEGRAM_CALLS_UNAVAILABLE` | telegramd was built without call support |
| `TELEGRAM_CALL_BUSY` / `TELEGRAM_CALL_NOT_FOUND` / `TELEGRAM_NO_TAB` | A call is already running; no such call; no Phone tab open for an agent call |
| `TELEGRAM_BOT_NOT_CONFIGURED` | No bot yet |
| `TELEGRAM_TIMEOUT`, `TELEGRAM_RPC`, `TELEGRAM_INTERNAL` | Telegram did not answer, other Telegram error (`telegram` field has its type), bug |

## Files

| Path | What |
|---|---|
| `~/.dsh/phone/telegram/api.env` | api_id, api_hash (you write it, 0600) |
| `vault.key` | Key that seals the files below (0600) |
| `session.bin`, `state.bin`, `api.bin` | MTProto session, update state and peers, credentials saved from Settings (sealed) |
| `config.json` | Settings: phone, agent switch, limits, allowlist, media caps |
| `audit.jsonl`, `agent-trip.json`, `agent-send.off` | Audit log, spam pause, kill switch |
| `media/`, `spool/` | Download cache, uploads in transit (removed after sending) |
| `calls.sock` | Call audio between phone-hookd and telegramd (0600) |
| `transcribe.json` | Voice message transcription settings (written by phone-hookd) |

## Operations

- Status: `systemctl status dsh-telegramd`, `GET /dsh-phone/api/tg/status`, tool `telegram_status`.
- Log out of this server only: Settings, Telegram, Log out (the phone app stays logged in). From the phone: Telegram app, Devices, terminate "DSH Phone".
- Remove everything: stop and disable the unit, delete `~/.dsh/phone/telegram/` except `api.env`, drop the `tg_chats` and `tg_messages` tables.
