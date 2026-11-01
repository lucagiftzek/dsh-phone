/**
 * dsh-phone: telegram_* agent tools. They talk to phone-hookd (/tg/*), which
 * relays to telegramd. Sends from agents go out DIRECTLY from the owner's
 * account (his decision), inside telegramd's agent policy: existing
 * conversations or the allowlist only, per-chat interval, hourly and daily
 * caps, kill switch, audit log. Agents never resolve unknown usernames.
 */

import { hookd, HookdError } from './hookc.js'

const fmtTime = (unix) => unix ? new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '?'
const kindLabel = (c) => c.kind === 'channel' ? (c.broadcast ? 'channel' : 'group') : c.kind === 'group' ? 'group' : (c.bot ? 'bot' : 'user')

function mediaLabel(m) {
  if (!m) return ''
  const k = m.kind
  const extra = m.name ? ' ' + m.name : m.duration ? ' ' + Math.round(m.duration) + 's' : ''
  return '[' + k + extra + ']'
}

function lineOf(m, chatTitle) {
  const who = m.out ? 'You' : (m.fromName || chatTitle || String(m.from || ''))
  if (m.service) return '[' + fmtTime(m.date) + '] ' + who + ' ' + m.service
  const parts = []
  if (m.fwd) parts.push('(forwarded from ' + m.fwd + ')')
  if (m.replyTo) parts.push('(reply to #' + m.replyTo + ')')
  if (m.text) parts.push(m.text)
  if (m.media) parts.push(mediaLabel(m.media) + (m.media.kind === 'webpage' && m.media.url ? ' ' + m.media.url : ''))
  const tx = m.transcript
  if (tx && tx.status === 'done') parts.push(tx.text ? 'transcript' + (tx.language ? ' (' + tx.language + ')' : '') + ': "' + tx.text + '"' : '(no speech)')
  else if (tx) parts.push('(transcript ' + tx.status + (tx.error ? ': ' + tx.error : '') + ')')
  return '#' + m.id + ' [' + fmtTime(m.date) + '] ' + who + ': ' + parts.join(' ') + (m.edit ? ' (edited)' : '') + (m.deleted ? ' (deleted)' : '')
}

/** Failed tool result from a hookd/telegramd error, keeping TELEGRAM_* codes. */
function tgFail(e) {
  const raw = (e instanceof HookdError && e.raw) || e.body || null
  const code = (raw && raw.code) || (e && e.code) || 'TELEGRAM_INTERNAL'
  const msg = (raw && (raw.error || raw.message)) || String(e && e.message || e)
  const out = { ok: false, code, message: msg, error: msg, text: 'Telegram error (' + code + '): ' + msg }
  if (raw && raw.retryAfter) { out.report = { retryAfter: raw.retryAfter }; out.text += ' Retry after ' + raw.retryAfter + ' s.' }
  if (code === 'TELEGRAM_DAEMON_UNAVAILABLE') out.hint = 'telegramd is not running: systemctl status dsh-telegramd'
  if (code === 'TELEGRAM_NOT_LOGGED_IN' || code === 'TELEGRAM_NOT_CONFIGURED') out.hint = 'The owner logs the account in from Settings > Phone > Telegram.'
  if (code === 'TELEGRAM_CHAT_NOT_ALLOWED') out.hint = 'Agents write only to existing conversations or chats on the allowlist (Settings > Phone > Telegram).'
  out.docs = 'docs/TELEGRAM.md'
  return out
}

/** Finds a chat in the local list by marked id, @username or exact title. */
async function findChat(ref) {
  const s = String(ref == null ? '' : ref).trim()
  if (!s) throw Object.assign(new Error('chat missing'), { body: { code: 'TELEGRAM_BAD_REQUEST', error: 'give chat: a chat id from telegram_chats, an @username or the exact chat title' } })
  if (/^-?\d+$/.test(s)) {
    const r = await hookd('GET', '/tg/chat?chat=' + s)
    return r.chat
  }
  const q = s.replace(/^@/, '')
  const r = await hookd('GET', '/tg/chats?limit=500&q=' + encodeURIComponent(q))
  const arch = await hookd('GET', '/tg/chats?limit=200&archived=1&q=' + encodeURIComponent(q)).catch(() => ({ chats: [] }))
  const all = [...(r.chats || []), ...(arch.chats || [])]
  const lc = q.toLowerCase()
  const exact = all.filter(c => (s.startsWith('@') ? (c.username || '').toLowerCase() === lc : (c.title || '').toLowerCase() === lc || (c.username || '').toLowerCase() === lc))
  if (exact.length === 1) return exact[0]
  const list = (exact.length ? exact : all).slice(0, 8).map(c => c.id + ' ' + c.title + (c.username ? ' @' + c.username : '')).join('; ')
  throw Object.assign(new Error('ambiguous chat'), { body: { code: 'TELEGRAM_CHAT_NOT_FOUND', error: (exact.length ? 'several chats match "' : 'no chat matches "') + s + '"' + (list ? '. Candidates: ' + list : '') + '. Use the numeric id.' } })
}

export function registerTelegramTools(reg) {
  reg({
    name: 'telegram_status',
    description: 'Telegram account status (the owner\'s account in the Phone plugin): login state, account name, daemon health, unread count, agent sending switch and limits.',
    parameters: {},
    async execute() {
      try {
        const st = await hookd('GET', '/tg/status')
        if (!st.daemon) return { ok: true, status: 'down', text: 'telegramd is not reachable: ' + (st.error || 'unknown') + '. Local chats stay readable.', report: { daemon: false } }
        const a = st.auth || {}
        const me = a.me ? a.me.title + (a.me.username ? ' (@' + a.me.username + ')' : '') : '(not logged in)'
        const ag = st.agent || {}
        const lim = ag.limits || {}
        return { ok: true, status: a.state, text: 'Telegram: ' + a.state + (a.connected ? ', connected' : '') + '. Account: ' + me + '. Unread: ' + ((st.counts || {}).unread || 0) + ' in ' + ((st.counts || {}).chats || 0) + ' chats.' +
          '\nAgent sending: ' + (ag.enabled && !ag.flagFile && !ag.tripped ? 'on' : 'OFF' + (ag.tripped ? ' (paused after a Telegram spam warning until ' + fmtTime(ag.tripped.until) + ')' : '')) +
          ', limits ' + (lim.perChatSeconds || '?') + ' s per chat, ' + (lim.perHour || '?') + '/hour, ' + (lim.perDay || '?') + '/day; sent last hour ' + (ag.sentLastHour || 0) + ', last day ' + (ag.sentLastDay || 0) + '.',
          report: { state: a.state, me: a.me || null, counts: st.counts || {}, agent: ag } }
      } catch (e) { return tgFail(e) }
    },
  })

  reg({
    name: 'telegram_chats',
    description: 'List Telegram chats of the owner\'s account (users, groups, channels) from the local store, newest first, with unread counts and the last message. Use the numeric id with the other telegram_* tools.',
    parameters: {
      q: { type: 'string', description: 'Optional search in chat title or @username.' },
      kind: { type: 'string', description: 'Optional filter: user | group | channel.' },
      archived: { type: 'boolean', description: 'List the archive instead of the main list.' },
      refresh: { type: 'boolean', description: 'Re-sync the chat list from Telegram first.' },
      limit: { type: 'integer', description: 'Max chats (default 30, max 200).' },
    },
    async execute(args) {
      try {
        const p = new URLSearchParams({ q: args.q || '', kind: ['user', 'group', 'channel'].includes(args.kind) ? args.kind : '', limit: String(Math.min(200, Number(args.limit) || 30)) })
        if (args.archived) p.set('archived', '1')
        if (args.refresh) p.set('refresh', '1')
        const r = await hookd('GET', '/tg/chats?' + p, undefined, { timeoutMs: 150000 })
        if (!r.chats.length) return { ok: true, text: 'No Telegram chats' + (args.q ? ' matching "' + args.q + '"' : '') + '.', report: { chats: [] } }
        return {
          ok: true,
          text: r.chats.map(c => '- ' + c.id + ' ' + c.title + (c.username ? ' @' + c.username : '') + ' (' + kindLabel(c) + (c.canPost && c.broadcast ? ', you can post' : '') + ')' +
            (c.unread ? ' · ' + c.unread + ' unread' : '') + (c.muted ? ' · muted' : '') + (c.last ? '\n  ' + fmtTime(c.last.date) + ' ' + (c.last.out ? 'You: ' : '') + String(c.last.text || '').slice(0, 140) : '')).join('\n'),
          report: { chats: r.chats, counts: r.counts },
        }
      } catch (e) { return tgFail(e) }
    },
  })

  reg({
    name: 'telegram_read',
    description: 'Read messages of one Telegram chat (oldest first). Fetches the latest page from Telegram into the local store. Does not mark the chat read unless markRead is true and the setting allows agents to mark read.',
    parameters: {
      chat: { type: 'string', description: 'Chat id from telegram_chats, @username or exact title.' },
      limit: { type: 'integer', description: 'Max messages (default 30, max 100).' },
      before: { type: 'integer', description: 'Only messages older than this message id (paging).' },
      markRead: { type: 'boolean', description: 'Mark the chat read up to the newest message shown.' },
    },
    async execute(args) {
      try {
        const c = await findChat(args.chat)
        const r = await hookd('GET', '/tg/messages?' + new URLSearchParams({ chat: String(c.id), limit: String(Math.min(100, Number(args.limit) || 30)), before: String(Number(args.before) || 0) }), undefined, { timeoutMs: 90000 })
        const msgs = r.messages || []
        let marked = false
        if (args.markRead && msgs.length) marked = !!(await hookd('POST', '/tg/read', { chat: c.id, maxId: msgs.at(-1).id, origin: 'agent' }).catch(() => ({}))).marked
        const head = c.title + (c.username ? ' @' + c.username : '') + ' (' + kindLabel(c) + ', id ' + c.id + ')' + (r.warning ? '\n(note: showing local copy, Telegram fetch failed: ' + r.warning + ')' : '')
        return { ok: true, text: head + ':\n' + (msgs.length ? msgs.map(m => lineOf(m, c.title)).join('\n') : '(no messages)') + (marked ? '\n(marked read)' : ''), report: { chat: c, messages: msgs, marked } }
      } catch (e) { return tgFail(e) }
    },
  })

  const send = async (args, channelPost) => {
    const c = await findChat(args.chat)
    const r = await hookd('POST', '/tg/send', { chat: c.id, text: String(args.text || ''), replyTo: Number(args.replyTo) || 0, silent: !!args.silent, origin: 'agent', channelPost }, { timeoutMs: 140000 })
    return { ok: true, text: (channelPost ? 'Posted in ' : 'Sent to ') + c.title + ' (message #' + r.message.id + ').', report: { chat: c, message: r.message } }
  }

  reg({
    name: 'telegram_send',
    description: 'Send a Telegram text message from the owner\'s account, directly (no draft step). Only to existing conversations or allowlisted chats; limits: one message per few seconds per chat and hourly/daily caps. Max 4096 characters.',
    parameters: {
      chat: { type: 'string', description: 'Chat id from telegram_chats, @username or exact title.' },
      text: { type: 'string', description: 'Message text (plain).' },
      replyTo: { type: 'integer', description: 'Optional message id to reply to.' },
      silent: { type: 'boolean', description: 'Send without a notification sound.' },
    },
    async execute(args) { try { return await send(args, false) } catch (e) { return tgFail(e) } },
  })

  reg({
    name: 'telegram_channel_post',
    description: 'Publish a post in a Telegram channel that the owner\'s account owns or administers (for example a project channel). Refused for channels where the account cannot post.',
    parameters: {
      chat: { type: 'string', description: 'Channel id from telegram_chats (kind channel), @username or exact title.' },
      text: { type: 'string', description: 'Post text (plain, max 4096 characters).' },
      silent: { type: 'boolean', description: 'Publish without notifying subscribers.' },
    },
    async execute(args) { try { return await send(args, true) } catch (e) { return tgFail(e) } },
  })

  reg({
    name: 'telegram_send_media',
    description: 'Send a local file from this machine to a Telegram chat or channel from the owner\'s account: photo, voice note (any audio, converted to Telegram voice format), audio, video or document, with an optional caption. Same rules and limits as telegram_send; upload size limit in Settings (default 50 MB).',
    parameters: {
      chat: { type: 'string', description: 'Chat id from telegram_chats, @username or exact title.' },
      file: { type: 'string', description: 'Absolute path of the local file.' },
      kind: { type: 'string', description: 'photo | voice | audio | video | document (default: from the file type).' },
      caption: { type: 'string', description: 'Optional caption (max 1024 characters).' },
      channelPost: { type: 'boolean', description: 'Require the chat to be a channel the account can post in.' },
    },
    async execute(args) {
      try {
        const c = await findChat(args.chat)
        const r = await hookd('POST', '/tg/send_media', { chat: c.id, file: String(args.file || ''), kind: String(args.kind || ''), caption: String(args.caption || ''), origin: 'agent', channelPost: !!args.channelPost }, { timeoutMs: 17 * 60000 })
        return { ok: true, text: 'Sent ' + ((r.message.media && r.message.media.kind) || 'file') + ' to ' + c.title + ' (message #' + r.message.id + ').', report: { chat: c, message: r.message } }
      } catch (e) { return tgFail(e) }
    },
  })

  reg({
    name: 'telegram_call',
    description: 'Telegram voice calls of the owner\'s account on the Phone call screen. place: the owner\'s open Phone tab dials a user of an existing conversation (the owner talks, the audio goes through the server). answer: answers the ringing Telegram call in his tab. hangup: ends a Telegram call. status: the current Telegram call, if any. Agent limits: existing conversations only, one call at a time, a daily cap. Needs a Phone tab open on the server audio route.',
    parameters: {
      action: { type: 'string', description: 'place | answer | hangup | status' },
      chat: { type: 'string', description: 'For place: user chat id, @username or exact name.' },
      callId: { type: 'string', description: 'For answer and hangup: the call id (default: the current Telegram call).' },
    },
    async execute(args) {
      try {
        const action = ['place', 'answer', 'hangup', 'status'].includes(args.action) ? args.action : ''
        if (!action) return tgFail({ body: { code: 'TELEGRAM_BAD_REQUEST', error: 'action must be place, answer, hangup or status' } })
        const body = { origin: 'agent', callId: String(args.callId || '') }
        if (action === 'place') body.chat = (await findChat(args.chat)).id
        const r = action === 'status'
          ? await hookd('GET', '/tg/call/status', undefined, { timeoutMs: 15000 })
          : await hookd('POST', '/tg/call/' + action, body, { timeoutMs: 60000 })
        const call = r.call || null
        const text = action === 'status'
          ? (call ? 'Telegram call ' + (call.callId || '') + ' with ' + (call.title || call.chat || '?') + ': ' + call.state + '.' : 'No Telegram call right now.')
          : 'Telegram call ' + action + ': ' + (r.state || (call && call.state) || 'ok') + (r.note ? ' (' + r.note + ')' : '') + '.'
        return { ok: true, text, report: r }
      } catch (e) { return tgFail(e) }
    },
  })

  reg({
    name: 'telegram_bot_notify',
    description: 'Send a notification to the owner through the agents\' Telegram bot. Only works once the owner has decided to create the bot and has started it; until then it reports that no bot is configured.',
    parameters: { text: { type: 'string', description: 'Notification text (plain, max 4096 characters).' } },
    async execute(args) {
      try {
        const r = await hookd('POST', '/tg/bot/notify', { text: String(args.text || ''), origin: 'agent' })
        return { ok: true, text: 'Notification sent to the owner' + (r.messageId ? ' (#' + r.messageId + ')' : '') + '.', report: r }
      } catch (e) {
        const out = tgFail(e)
        if (out.code === 'TELEGRAM_NOT_FOUND') { out.code = 'TELEGRAM_BOT_NOT_CONFIGURED'; out.message = out.error = 'no Telegram bot is configured yet'; out.text = 'Telegram error (TELEGRAM_BOT_NOT_CONFIGURED): no Telegram bot is configured yet. Use phone or mail tools to reach the owner instead.' }
        return out
      }
    },
  })
}
