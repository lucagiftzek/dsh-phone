/**
 * dsh-phone: the error catalog, shared by the host half (lib/errors.js) and the
 * hook daemon (daemon/errors.mjs). Plain data, no imports, so the daemon
 * directory can be deployed on its own.
 *
 * Codes are an API: never rename one, only add. Every code has a heading in
 * docs/ERRORS.md (a test keeps both in step). `legacy` is the short `error`
 * string older clients already read; codes without it keep the original
 * (sometimes dynamic) text in `error` by passing it as the message.
 */

export const PREFIX = 'PHONE'

export const CATALOG = {
  // ---- general
  PHONE_INTERNAL: {
    status: 500,
    message: 'Unexpected error in the phone plugin or its daemon',
    hint: 'Collect the log line that starts with the code (daemon journal or the dsh web log) and report a bug with it.',
  },
  PHONE_NOT_FOUND: {
    status: 404, legacy: 'not found',
    message: 'No such route',
    hint: 'Check the path and that the plugin and the daemon run the same version (restart dsh web after an update).',
  },
  PHONE_METHOD_NOT_ALLOWED: {
    status: 405,
    message: 'Wrong HTTP method for this route',
    hint: 'Read routes accept GET and HEAD, mutating routes accept POST, webhooks accept POST.',
  },
  PHONE_BODY_INVALID: {
    status: 400,
    message: 'Request body is not valid JSON',
    hint: 'Send a JSON object with content-type application/json.',
  },
  PHONE_BODY_TOO_LARGE: {
    status: 413,
    message: 'Request body is too large',
    hint: 'Send a smaller body (limits: 256 KB on plugin routes, 64 KB on webhooks, 512 KB on the daemon private socket).',
  },

  // ---- plugin route gate (lib/security.js)
  PHONE_PEER_NOT_LOOPBACK: {
    status: 403,
    message: 'The request did not come from the local machine',
    hint: 'The plugin API only answers loopback peers. Reach DSH through its local proxy or edge, not directly from another host.',
  },
  PHONE_HOST_UNTRUSTED: {
    status: 403,
    message: 'Cross-site request or untrusted Host header',
    hint: 'Open DSH through localhost or a host listed in trustedHosts; mutating calls must be same-origin with an Origin header.',
  },
  PHONE_CONTENT_TYPE_INVALID: {
    status: 415,
    message: 'Mutating requests must be application/json',
    hint: 'Send the header content-type: application/json.',
  },
  PHONE_TOKEN_INVALID: {
    status: 403,
    message: 'Capability token missing, malformed, wrong or expired',
    hint: 'Reload the Phone tab so it mints a fresh token (GET /dsh-phone/api/session), then retry.',
  },
  PHONE_SESSION_COOKIE_MISSING: {
    status: 403,
    message: 'The DSH browser-session cookie is missing',
    hint: 'Open DSH in the browser through the launch URL (sign in again) before using the Phone tab, or set requireHarnessCookie to false.',
  },
  PHONE_SECRET_NOT_READY: {
    status: 503,
    message: 'The per-install secret is not ready yet',
    hint: 'It is created at start under the data directory (mode 0600). Wait a second and retry; if it persists check the data directory is writable.',
  },
  PHONE_SETTINGS_UNAVAILABLE: {
    status: 503, legacy: 'settings service unavailable',
    message: 'The DSH settings service cannot be written',
    hint: 'On DSH 0.2.x the plugin needs the settings service injected and a Config on its default export; see the troubleshooting guide (settings do not save).',
  },

  // ---- plugin to daemon link (lib/hookc.js)
  PHONE_HOOKD_UNAVAILABLE: {
    status: 503,
    message: 'phone-hookd is not reachable',
    hint: 'Start the daemon (systemctl status dsh-phone-hookd) and check the socket exists under the plugin data directory.',
  },
  PHONE_HOOKD_TIMEOUT: {
    status: 503,
    message: 'phone-hookd did not answer in time',
    hint: 'The daemon is busy or stuck. Check its log; a provider Apply can legitimately take a few minutes.',
  },
  PHONE_HOOKD_ERROR: {
    status: 400,
    message: 'phone-hookd reported an error without a code',
    hint: 'The daemon is older than the plugin. Update and restart the daemon so its errors carry codes.',
  },

  // ---- daemon API validation
  PHONE_MODE_INVALID: {
    status: 400,
    message: 'Mode must be live, voicemail or dnd',
    hint: 'Send one of live, voicemail, dnd.',
  },
  PHONE_NUMBER_INVALID: {
    status: 400,
    message: 'Not a valid phone number',
    hint: 'Use E.164 (+ then country code and number), or set a default country in Settings for numbers typed without one.',
  },
  PHONE_MESSAGE_INVALID: {
    status: 400,
    message: 'The message text is empty or too long',
    hint: 'Send non-empty text; SMS is limited by sms.maxChars, spoken text by 1000 characters.',
  },
  PHONE_AGENT_ACTION_DISABLED: {
    status: 403,
    message: 'This action is switched off for agents in Settings',
    hint: 'Settings > Phone > Agent: allowSms, allowCalls and allowModeChange decide what the phone_* tools may do. Only the human should change them.',
  },
  PHONE_LINE_UNAVAILABLE: {
    status: 400,
    message: 'No enabled line can do this',
    hint: 'Check Settings > Phone > Lines: the line must exist, be enabled, and have SMS or voice switched on; SMS and spoken calls need a Twilio line.',
  },

  // ---- provider (Twilio) side
  PHONE_PROVIDER_NOT_CONFIGURED: {
    status: 400,
    message: 'Provider account SID and auth token are not configured',
    hint: 'Fill the account SID and auth token in Settings > Phone (or in the credentials file), then Apply.',
  },
  PHONE_PUBLIC_URL_MISSING: {
    status: 503,
    message: 'The public webhook base URL is not set',
    hint: 'Set publicBaseUrl in Settings > Phone to the exact HTTPS URL the provider calls (the route that reaches the daemon public port).',
  },
  PHONE_VOICE_TOKEN_INCOMPLETE: {
    status: 400,
    message: 'Cannot mint a browser access token: API key or identity is missing',
    hint: 'Run Apply to Twilio in setup so the API key and the TwiML App are created, then reload the Phone tab.',
  },
  PHONE_PROVIDER_AUTH_FAILED: {
    status: 401,
    message: 'The provider rejected the credentials',
    hint: 'Check the account SID and the auth token (the main auth token, not an API key secret) in Settings or the credentials file.',
  },
  PHONE_PROVIDER_REQUEST_FAILED: {
    status: 400,
    message: 'The provider refused the request',
    hint: 'Read the provider message in this error and the provider console (number capabilities, geo permissions, account status, balance).',
  },
  PHONE_PROVIDER_UNREACHABLE: {
    status: 400,
    message: 'The provider API did not answer',
    hint: 'Check the server has outbound HTTPS and DNS; retry later if the provider has an incident.',
  },

  // ---- voicemail
  PHONE_VOICEMAIL_NOT_FOUND: {
    status: 400,
    message: 'Voicemail not found',
    hint: 'It was deleted or the id is wrong; list voicemails again.',
  },
  PHONE_VOICEMAIL_NO_AUDIO: {
    status: 404,
    message: 'This voicemail has no audio file',
    hint: 'The recording was never downloaded (status failed or empty) or the file was removed.',
  },
  PHONE_PICKUP_TOO_LATE: {
    status: 400,
    message: 'The caller is no longer leaving a message',
    hint: 'Pick up only works while the caller is still recording.',
  },
  PHONE_TRANSCRIBE_FAILED: {
    status: 400,
    message: 'Transcription failed',
    hint: 'Check voicemail.transcriber, the local speech-to-text URL and model (or the Mistral key); the live transcript is kept as a fallback.',
  },
  PHONE_RECORDING_DOWNLOAD_FAILED: {
    status: 500,
    message: 'Could not download the voicemail recording from the provider',
    hint: 'Check the provider credentials and that the recording still exists; see PHONE_PROVIDER_AUTH_FAILED.',
  },
  PHONE_LIVE_TRANSCRIPT_FAILED: {
    status: 500,
    message: 'The provider live transcription reported an error',
    hint: 'Check voicemail.liveLanguage, liveEngine and liveModel; the final transcript still comes from the recording.',
  },

  // ---- webhooks (daemon public listener)
  PHONE_SIGNATURE_INVALID: {
    status: 403,
    message: 'Webhook signature did not validate',
    hint: 'The provider signs the exact public URL it called. Make publicBaseUrl match it (scheme, host, port, path) and make any proxy forward the original scheme and host unchanged.',
  },
  PHONE_WEBHOOK_HANDLER_FAILED: {
    status: 500,
    message: 'A webhook handler threw; the provider received a spoken apology',
    hint: 'Read the log line detail and the stack that follows it; report a bug if it is not a configuration problem.',
  },
  PHONE_SMS_DELIVERY_FAILED: {
    status: 500,
    message: 'The provider reported an SMS as failed or undelivered',
    hint: 'Look up the provider error code in the log line: sender type, country filtering of the sender, a blocked or invalid destination, or a messaging service sender name.',
  },

  // ---- calls
  PHONE_OUTBOUND_CLIENT_REFUSED: {
    status: 500,
    message: 'An outbound browser call came from an unexpected client identity',
    hint: 'The browser identity in Settings must match the identity the access token was minted for; reload the Phone tab after changing it.',
  },
  PHONE_OUTBOUND_DESTINATION_BLOCKED: {
    status: 500,
    message: 'The destination is not allowed from this SIP line',
    hint: 'Check the SIP account allowPrefixes and blockPrefixes, and the dial format.',
  },
  PHONE_SIP_LINE_UNKNOWN: {
    status: 500,
    message: 'A relay call arrived for a line that does not exist',
    hint: 'The SIP account line must be an enabled line with provider sip; check the X-Line header the relay sets.',
  },

  // ---- server audio route (daemon/audio.mjs, 0.2)
  PHONE_AUDIO_UNAVAILABLE: {
    status: 503,
    message: 'The server audio route is not available',
    hint: 'The plugin routes for server audio load at the next dsh web restart, and phone-hookd must run the same version. Until then the Phone tab falls back to the direct route.',
  },
  PHONE_AUDIO_INSECURE: {
    status: 426,
    message: 'The audio socket must use wss (TLS)',
    hint: 'Open the GUI over https. Plain ws is refused except on a loopback host.',
  },
  PHONE_AUDIO_BUSY: {
    status: 429,
    message: 'The server already carries its maximum number of audio sessions',
    hint: 'Hang up another call or test, or raise audio.maxCalls / audio.maxTests in Settings > Phone.',
  },
  PHONE_AUDIO_SESSION_GONE: {
    status: 404,
    message: 'This audio session has ended or the call is no longer ringing',
    hint: 'Nothing to fix: the call ended, was answered elsewhere, or went to voicemail.',
  },
  PHONE_AUDIO_LEG_FAILED: {
    status: 502,
    message: 'The server could not set up the far leg of the call',
    hint: 'For SIP lines check that Asterisk runs, chan_audiosocket is loaded and the AMI user may originate; for Twilio lines check the public webhook base and the account balance.',
  },

  // ---- SIP relay (daemon/relay.mjs)
  PHONE_RELAY_DIR_UNUSABLE: {
    status: 500,
    message: 'The media server include directory is missing or not writable',
    hint: 'Create the include directory, owned by the daemon user with the media server group, mode 0750 (see docs/RELAY.md).',
  },
  PHONE_RELAY_DIR_FOREIGN: {
    status: 409,
    message: 'The media server include directory belongs to another dsh-phone instance',
    hint: 'Its files carry another instance marker, so nothing was written. Give this instance its own relay include directory (relay.configDir), or remove the other instance first.',
  },
  PHONE_RELAY_AMI_FAILED: {
    status: 500,
    message: 'The media server manager interface (AMI) rejected or did not answer',
    hint: 'Check the media server is running, the manager interface listens on loopback, and the generated manager include was loaded (a restart can be needed once).',
  },
  PHONE_RELAY_SYNC_FAILED: {
    status: 500,
    message: 'Relay configuration could not be written or reloaded',
    hint: 'Read the detail; fix the account issues listed by the state route and run Sync again.',
  },

  // ---- store (daemon/store.mjs)
  PHONE_STORE_UNAVAILABLE: {
    status: 500,
    message: 'The phone database could not be opened',
    hint: 'Check the data directory exists, is writable by the daemon user, and the disk is not full; Node must provide node:sqlite (Node 22.5 or newer).',
  },
}

/**
 * Remove obvious secrets from text that goes into messages, hints and logs.
 * Deliberately narrow: legacy error strings must stay readable, so only
 * key=value secrets, bearer tokens, credentials inside URLs and a standalone
 * 32-hex-character token (a provider auth token) are masked. Provider ids
 * (two letters plus 32 hex) are not standalone and stay.
 */
export function scrub(text) {
  return String(text)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b(password|passwd|secret|token|api[_-]?key|auth[_-]?token)=[^\s&"']+/gi, '$1=[redacted]')
    .replace(/(https?:\/\/)[^\s\/:@]+:[^\s\/@]+@/gi, '$1[redacted]@')
    .replace(/(?<![A-Za-z0-9])[0-9a-f]{32}(?![A-Za-z0-9])/gi, '[redacted]')
}

/**
 * Body for a caught error, keeping the original message in `error`.
 * A known coded error keeps its body; anything else becomes `fallback` with
 * the original message as message (so older clients read the same text).
 */
export function errorBody(E, err, fallback = 'PHONE_INTERNAL', extra = {}) {
  if (err && typeof err.code === 'string' && E.has(err.code)) return err.body || E.body(err.code, { ...extra, message: err.message })
  return E.body(fallback, { ...extra, message: String(err && err.message ? err.message : err) })
}
