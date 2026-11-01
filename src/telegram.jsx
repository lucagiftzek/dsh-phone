/**
 * dsh-phone: Telegram in the Phone tab (browser half).
 *
 * The page talks only to the DSH origin (/dsh-phone/api/tg/*); phone-hookd
 * relays to telegramd, which holds the account. Media (photos, voice notes,
 * files, link previews) and the login QR code come from the server, never
 * from a Telegram host. Created by client.jsx with its shared helpers (kit).
 */
import { useEffect, useRef, useState } from 'react'

export function createTelegramUI(k) {
  const { API, apiGet, apiPost, apiUpload, usePhone, S, bump, changed, toast, I, fmtWhen, fmtDur } = k
  const TG = API + '/tg'
  const media = (m, extra = '') => TG + '/media?chat=' + m.chat + '&msg=' + m.id + extra

  S.tg = { st: null, err: '', counts: { unread: 0, chats: 0 } }
  S.ver.tg = 0
  S.tgTx = {}  // live transcript states from events, by 'chat/id'

  async function refreshTg() {
    try {
      const st = await apiGet('/tg/status')
      S.tg.st = st; S.tg.err = ''
      if (st.counts) S.tg.counts = st.counts
    } catch (e) {
      const m = String(e.message || e)
      S.tg.err = /^not found$/i.test(m) ? 'Telegram is installed, but the DSH web server has not loaded its routes yet: restart dsh web.' : m
    }
    changed()
    return S.tg.st
  }

  /** Live events from the hookd stream (called by openEvents in client.jsx). */
  function wire(on) {
    const tgBump = () => { S.ver.tg++; changed() }
    on('tg.message', (d) => {
      if (d.counts) S.tg.counts = d.counts
      tgBump()
      const m = d.message
      if (!d.isNew || !m || m.out || m.service || (d.chat && d.chat.muted)) return
      if (S.mode === 'dnd') return
      if (S.tgOpen === m.chat && !document.hidden) return
      k.ping()
      const who = d.chat ? d.chat.title : 'Telegram'
      toast({ kind: 'tg', title: who + (d.chat && d.chat.kind !== 'user' && m.fromName ? ': ' + m.fromName : ''), body: m.text || mediaWord(m.media) || 'Message', tgChat: m.chat })
      k.notify('Telegram: ' + who, m.text || mediaWord(m.media) || 'Message', 'tg-' + m.chat)
    })
    for (const ev of ['tg.edit', 'tg.delete', 'tg.chats']) on(ev, tgBump)
    on('tg.transcript', (d) => { if (d && d.chat && d.transcript) { S.tgTx[d.chat + '/' + d.id] = d.transcript; changed() } })
    on('tg.read', (d) => { if (d.counts) S.tg.counts = d.counts; tgBump() })
    for (const ev of ['tg.auth', 'tg.daemon', 'tg.config', 'tg.safety']) on(ev, () => { void refreshTg(); tgBump() })
    on('tg.flood', (d) => { if (!d.waiting) toast({ kind: 'err', title: 'Telegram flood limit', body: 'Telegram asks to wait ' + d.seconds + ' s before more requests of this kind.' }) })
    on('tg.call.incoming', (d) => {
      tgBump()
      if (S.mode === 'dnd' || d.supported !== false) return // supported calls ring through call.incoming
      toast({ kind: 'tg', title: 'Telegram call from ' + (d.title || 'someone'), body: 'This server cannot take Telegram calls: answer it in the Telegram app.', ms: 15000 })
    })
    // Agent tool telegram_call: the tab places or answers (the owner talks).
    on('tg.call.dial', (d) => { if (!S.call && d && d.chat) k.dial(String(d.chat), 'tg', d.title || '').catch(e => toast({ kind: 'err', title: 'Telegram call failed', body: e.message })) })
    on('tg.call.answer', (d) => { if (d && d.callSid) k.accept(d.callSid) })
  }

  function mediaWord(md) {
    if (!md) return ''
    return { photo: 'Photo', voice: 'Voice message', audio: 'Audio', video: 'Video', round: 'Video message', document: md.name || 'File', sticker: (md.emoji || '') + ' Sticker', gif: 'GIF', geo: 'Location', venue: 'Location', contact: 'Contact', poll: 'Poll', dice: md.emoji || 'Dice', webpage: md.title || 'Link' }[md.kind] || 'Attachment'
  }
  const fmtSize = (n) => !n ? '' : n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB'
  const tgInitials = (t) => String(t || '?').replace(/^@/, '').split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '#'
  const kindLabel = (c) => c.kind === 'channel' ? (c.broadcast ? 'Channel' : 'Group') : c.kind === 'group' ? 'Group' : (c.bot ? 'Bot' : c.self ? 'Saved messages' : 'User')

  const icon = (s = 14) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true"><path d="M14.5 2L1.6 7.1c-.5.2-.5.9 0 1.1l3.2 1.1 1.2 3.9c.1.4.6.5.9.2l1.8-1.7 3.3 2.4c.4.3.9.1 1-.4L15.2 2.6c.1-.4-.3-.8-.7-.6z" /><path d="M4.8 9.3l7.5-5.1-5.9 6.2" /></svg>
  const clip = (s = 14) => <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true"><path d="M13.2 7.6l-5.3 5.3a3.3 3.3 0 0 1-4.7-4.7l5.6-5.6a2.2 2.2 0 0 1 3.1 3.1L6.4 11.2a1.1 1.1 0 0 1-1.6-1.6l5-5" /></svg>

  // ---------------------------------------------------------------- login

  function Login({ st }) {
    const a = (st && st.auth) || {}
    const [code, setCode] = useState('')
    const [pw, setPw] = useState('')
    const [phone, setPhone] = useState('')
    const [apiId, setApiId] = useState('')
    const [apiHash, setApiHash] = useState('')
    const [busy, setBusy] = useState(false)
    const [err, setErr] = useState('')
    const [qrTick, setQrTick] = useState(0)
    useEffect(() => { if (st && st.phone && !phone) setPhone(st.phone) }, [st && st.phone])
    useEffect(() => {
      if (a.state !== 'wait_qr') return undefined
      const t = setInterval(() => { setQrTick(x => x + 1); void refreshTg() }, 4000)
      return () => clearInterval(t)
    }, [a.state])
    const run = async (fn) => { setBusy(true); setErr(''); try { await fn(); await refreshTg() } catch (e) { setErr(e.message) } finally { setBusy(false) } }
    if (!st) return null
    if (!st.daemon) return <div className="phx-note bad">The Telegram service (telegramd) is not running. <span className="phx-mono">systemctl status dsh-telegramd</span></div>
    if (!st.credentials) {
      return (
        <div className="phx-card">
          <div style={{ fontWeight: 650, marginBottom: 6 }}>Telegram API credentials</div>
          <div className="phx-s" style={{ marginBottom: 8 }}>From my.telegram.org, API development tools. The preferred place is the file <span className="phx-mono">~/.dsh/phone/telegram/api.env</span> (TELEGRAM_API_ID, TELEGRAM_API_HASH, mode 600). Or enter them here once: they are stored encrypted on the server and never shown again.</div>
          <div className="phx-grid">
            <input className="phx-in" inputMode="numeric" placeholder="api_id" value={apiId} onChange={e => setApiId(e.target.value)} />
            <input className="phx-in" type="password" autoComplete="off" placeholder="api_hash" value={apiHash} onChange={e => setApiHash(e.target.value)} />
          </div>
          <button type="button" className="phx-btn p" style={{ marginTop: 8 }} disabled={busy || !apiId || !apiHash} onClick={() => run(async () => { await apiPost('/tg/creds', { apiId, apiHash }); setApiHash('') })}>Save credentials</button>
          {err ? <div className="phx-note bad" style={{ marginTop: 8 }}>{err}</div> : null}
        </div>
      )
    }
    if (a.state === 'ready') return null
    return (
      <div className="phx-card">
        <div style={{ fontWeight: 650, marginBottom: 6 }}>Log in to Telegram</div>
        {a.state === 'connecting' || a.state === 'no_credentials' ? <div className="phx-s">Connecting to Telegram...</div> : null}
        {a.state === 'error' ? <div className="phx-note bad">{a.error || 'Telegram connection error'}; retrying.</div> : null}
        {a.state === 'logged_out' ? (
          <div>
            {a.error ? <div className="phx-note warn">{a.error}</div> : null}
            <div className="phx-s" style={{ marginBottom: 8 }}>Recommended: scan a QR code with the Telegram app on your phone (Settings, Devices, Link Desktop Device). Or ask for a login code: it arrives inside the Telegram app, not by SMS.</div>
            <div className="phx-flex">
              <button type="button" className="phx-btn p" disabled={busy} onClick={() => run(() => apiPost('/tg/login/qr', {}))}>Log in with QR code</button>
              <input className="phx-in" style={{ width: 170 }} placeholder="+1 555 0100" value={phone} onChange={e => setPhone(e.target.value)} aria-label="Account phone number" />
              <button type="button" className="phx-btn" disabled={busy || !phone.trim()} onClick={() => run(() => apiPost('/tg/login/phone', { phone }))}>Send a code</button>
            </div>
          </div>
        ) : null}
        {a.state === 'wait_qr' ? (
          <div style={{ textAlign: 'center' }}>
            {a.qr ? <img alt="Telegram login QR code" src={TG + '/login/qr.png?e=' + a.qr.expires + '&t=' + qrTick} style={{ width: 280, height: 280, imageRendering: 'pixelated', background: '#fff', borderRadius: 8, padding: 6 }} /> : <div className="phx-s">Preparing the QR code...</div>}
            <div className="phx-s" style={{ margin: '6px 0' }}>Telegram app, Settings, Devices, Link Desktop Device, then scan. The code refreshes by itself.</div>
            <button type="button" className="phx-btn" onClick={() => run(() => apiPost('/tg/login/cancel', {}))}>Cancel</button>
          </div>
        ) : null}
        {a.state === 'wait_code' ? (
          <div>
            <div className="phx-s" style={{ marginBottom: 6 }}>Enter the code Telegram sent {a.code && a.code.type === 'app' ? 'inside the Telegram app' : 'to ' + ((a.code && a.code.phone) || 'the account')}.</div>
            <div className="phx-flex">
              <input className="phx-in" style={{ width: 140 }} inputMode="numeric" autoComplete="one-time-code" placeholder="Code" value={code} onChange={e => setCode(e.target.value)} />
              <button type="button" className="phx-btn p" disabled={busy || !code.trim()} onClick={() => run(async () => { await apiPost('/tg/login/code', { code }); setCode('') })}>Log in</button>
              <button type="button" className="phx-btn" onClick={() => run(() => apiPost('/tg/login/cancel', {}))}>Cancel</button>
            </div>
          </div>
        ) : null}
        {a.state === 'wait_password' ? (
          <div>
            <div className="phx-s" style={{ marginBottom: 6 }}>This account has two-step verification. Enter the Telegram cloud password{a.password && a.password.hint ? ' (hint: ' + a.password.hint + ')' : ''}. It is used once and never stored.</div>
            <div className="phx-flex">
              <input className="phx-in" style={{ width: 200 }} type="password" autoComplete="current-password" placeholder="Password" value={pw} onChange={e => setPw(e.target.value)} />
              <button type="button" className="phx-btn p" disabled={busy || !pw} onClick={() => run(async () => { try { await apiPost('/tg/login/password', { password: pw }) } finally { setPw('') } })}>Unlock</button>
              <button type="button" className="phx-btn" onClick={() => run(() => apiPost('/tg/login/cancel', {}))}>Cancel</button>
            </div>
          </div>
        ) : null}
        {err ? <div className="phx-note bad" style={{ marginTop: 8 }}>{err}</div> : null}
      </div>
    )
  }

  // ---------------------------------------------------------------- chat list

  function Chats({ onOpen }) {
    const p = usePhone()
    const [q, setQ] = useState('')
    const [kind, setKind] = useState('')
    const [archived, setArchived] = useState(false)
    const [busy, setBusy] = useState(false)
    const [err, setErr] = useState('')
    const [data, setData] = useState(null)
    const [lookup, setLookup] = useState('')
    useEffect(() => {
      let alive = true
      apiGet('/tg/chats?' + new URLSearchParams({ q, kind, limit: '300', ...(archived ? { archived: '1' } : {}) }))
        .then(d => { if (alive) { setData(d); setErr('') } }).catch(e => { if (alive) setErr(e.message) })
      return () => { alive = false }
    }, [p.ver.tg, q, kind, archived])
    const chats = (data && data.chats) || []
    async function refresh() { setBusy(true); try { await apiPost('/tg/sync', {}); S.ver.tg++; changed() } catch (e) { setErr(e.message) } finally { setBusy(false) } }
    async function find() {
      const u = lookup.trim(); if (!u) return
      setBusy(true); setErr('')
      try { const r = await apiPost('/tg/resolve', { username: u }); setLookup(''); onOpen(r.chat) } catch (e) { setErr(e.message) } finally { setBusy(false) }
    }
    return (
      <div>
        <div className="phx-flex" style={{ marginBottom: 6, flexWrap: 'nowrap' }}>
          <input className="phx-in" placeholder="Search chats" value={q} onChange={e => setQ(e.target.value)} />
          <button type="button" className="phx-btn" disabled={busy} title="Sync the chat list from Telegram" onClick={() => void refresh()}>{busy ? 'Syncing' : 'Sync'}</button>
        </div>
        <div className="phx-seg" style={{ marginBottom: 8 }}>
          {[['', 'All'], ['user', 'People'], ['group', 'Groups'], ['channel', 'Channels']].map(([id, l]) => <button key={id} type="button" aria-pressed={kind === id && !archived} onClick={() => { setKind(id); setArchived(false) }}>{l}</button>)}
          <button type="button" aria-pressed={archived} onClick={() => setArchived(!archived)}>Archive</button>
        </div>
        {err ? <div className="phx-note bad">{err}</div> : null}
        {data && !chats.length ? <div className="phx-empty">{q || kind || archived ? 'Nothing here.' : 'No chats yet. Press Sync after the first login.'}</div> : null}
        {chats.map(c => (
          <button key={c.id} type="button" className={'phx-row' + (c.unread ? ' unread' : '')} onClick={() => onOpen(c)}>
            <span className="phx-av" style={c.kind === 'channel' ? { borderRadius: 8 } : undefined}>{tgInitials(c.title)}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="phx-flex" style={{ flexWrap: 'nowrap' }}>
                <span className="phx-name phx-grow">{c.title}{c.verified ? ' ✓' : ''}</span>
                <span className="phx-s">{c.last ? fmtWhen(c.last.date) : ''}</span>
              </span>
              <span className="phx-flex" style={{ flexWrap: 'nowrap' }}>
                <span className="phx-s phx-grow">{c.last ? (c.last.out ? 'You: ' : '') + c.last.text : kindLabel(c)}</span>
                {c.pinned ? <span className="phx-s" title="Pinned">pinned</span> : null}
                {c.unread ? <span className="phx-badge" style={c.muted ? { background: 'var(--ink3)' } : undefined}>{c.unread}</span> : null}
              </span>
            </span>
          </button>
        ))}
        <div className="phx-h">Open a chat by username</div>
        <div className="phx-flex" style={{ flexWrap: 'nowrap' }}>
          <input className="phx-in" placeholder="@username" value={lookup} onChange={e => setLookup(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void find() }} />
          <button type="button" className="phx-btn" disabled={busy || !lookup.trim()} onClick={() => void find()}>Open</button>
        </div>
        <div className="phx-s" style={{ marginTop: 4 }}>Only you can do this: agents write only to existing conversations.</div>
      </div>
    )
  }

  // ---------------------------------------------------------------- one chat

  /** Transcript of a voice or video message: language tag, progress, retry. */
  function Transcript({ m }) {
    usePhone()
    const [busy, setBusy] = useState(false)
    const t = S.tgTx[m.chat + '/' + m.id] || m.transcript
    async function run() {
      setBusy(true)
      try {
        const r = await apiPost('/tg/transcribe', { chat: m.chat, msg: m.id })
        if (r.transcript) { S.tgTx[m.chat + '/' + m.id] = r.transcript; changed() }
      } catch (e) { toast({ kind: 'err', title: 'Transcription', body: e.message }) } finally { setBusy(false) }
    }
    const box = { marginTop: 4, maxWidth: 320, fontSize: 12.5, lineHeight: 1.45 }
    if (!t) return <button type="button" className="phx-btn" style={{ marginTop: 4 }} disabled={busy} onClick={() => void run()}>Transcribe</button>
    if (t.status === 'queued' || t.status === 'running') return <div className="phx-s" style={box}><i>Transcribing...</i></div>
    if (t.status === 'done') {
      return (
        <div style={box} className="phx-tgtx">
          {t.language ? <span className="phx-pill" title={'Detected language' + (t.engine ? ', ' + t.engine : '')} style={{ marginRight: 6, fontSize: 10.5, textTransform: 'uppercase' }}>{t.language}</span> : null}
          <span style={{ whiteSpace: 'pre-wrap' }}>{t.text || <i>No speech recognised.</i>}</span>
        </div>
      )
    }
    return (
      <div className="phx-s" style={box}>
        {t.status === 'skipped' ? 'Not transcribed' : 'Transcription failed'}{t.error ? ': ' + t.error : ''}
        {' '}<button type="button" className="phx-btn" style={{ marginLeft: 4, padding: '1px 8px' }} disabled={busy} onClick={() => void run()}>{t.status === 'skipped' ? 'Transcribe' : 'Retry'}</button>
      </div>
    )
  }

  function MediaView({ m }) {
    const md = m.media
    const [big, setBig] = useState(false)
    if (!md) return null
    if (md.kind === 'photo') {
      return big
        ? <a href={media(m)} target="_blank" rel="noreferrer"><img alt="photo" src={media(m)} /></a>
        : <img alt="photo" src={media(m, '&thumb=1')} style={{ cursor: 'zoom-in' }} onClick={() => setBig(true)} />
    }
    if (md.kind === 'voice' || md.kind === 'audio') {
      return (
        <div style={{ marginTop: 4 }}>
          {md.kind === 'audio' ? <div className="phx-s">{[md.performer, md.title || md.name].filter(Boolean).join(' - ')}</div> : null}
          <audio controls preload="none" src={media(m)} style={{ width: 230, height: 32, display: 'block' }} />
          {md.duration ? <span className="phx-s">{fmtDur(md.duration)}</span> : null}
          {md.kind === 'voice' || m.transcript ? <Transcript m={m} /> : null}
        </div>
      )
    }
    if (md.kind === 'video' || md.kind === 'round' || md.kind === 'gif') {
      const tooBig = md.size > 20 * 1048576
      return (
        <div style={{ marginTop: 4 }}>
          {md.thumb && !big ? <img alt="video preview" src={media(m, '&thumb=1')} /> : null}
          {big ? <video controls autoPlay={md.kind === 'gif'} loop={md.kind === 'gif'} muted={md.kind === 'gif'} src={media(m, tooBig ? '&force=1' : '')} style={{ maxWidth: '100%', borderRadius: 8, display: 'block' }} />
            : <button type="button" className="phx-btn" style={{ marginTop: 4 }} onClick={() => setBig(true)}>Play {md.kind === 'gif' ? 'GIF' : 'video'}{md.duration ? ' ' + fmtDur(md.duration) : ''}{md.size ? ' (' + fmtSize(md.size) + ')' : ''}</button>}
          {md.kind === 'round' || m.transcript ? <Transcript m={m} /> : null}
        </div>
      )
    }
    if (md.kind === 'sticker') return md.thumb ? <img alt={md.emoji || 'sticker'} src={media(m, '&thumb=1')} style={{ maxWidth: 120 }} /> : <span style={{ fontSize: 28 }}>{md.emoji}</span>
    if (md.kind === 'document') {
      const tooBig = md.size > 20 * 1048576
      return (
        <div style={{ marginTop: 4 }}>
          {md.thumb ? <img alt="" src={media(m, '&thumb=1')} style={{ maxWidth: 90 }} /> : null}
          <a href={media(m, tooBig ? '&force=1' : '')} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>{clip(12)} {md.name || 'File'}</a>
          <span className="phx-s"> {fmtSize(md.size)}</span>
        </div>
      )
    }
    if (md.kind === 'webpage') {
      return (
        <div style={{ marginTop: 6, borderLeft: '3px solid currentColor', paddingLeft: 8, opacity: 0.92 }}>
          {md.site ? <div className="phx-s" style={{ color: 'inherit', fontWeight: 650 }}>{md.site}</div> : null}
          {md.title ? <div style={{ fontWeight: 600 }}>{md.title}</div> : null}
          {md.desc ? <div className="phx-s" style={{ color: 'inherit', maxHeight: 60, overflow: 'hidden' }}>{md.desc}</div> : null}
          {md.thumb ? <img alt="" src={media(m, '&thumb=1')} /> : null}
        </div>
      )
    }
    if (md.kind === 'geo' || md.kind === 'venue') return <div className="phx-mono">{md.title ? md.title + ', ' : ''}{md.desc ? md.desc + ', ' : ''}{Number(md.lat).toFixed(5)}, {Number(md.long).toFixed(5)}</div>
    if (md.kind === 'contact') return <div>{md.name} <span className="phx-mono">{md.phone}</span></div>
    if (md.kind === 'poll') return <div><b>Poll:</b> {md.title}</div>
    if (md.kind === 'dice') return <div style={{ fontSize: 22 }}>{md.emoji} {md.value}</div>
    return <div className="phx-s">[{md.name || md.kind}]</div>
  }

  function Chat({ chat, onBack }) {
    const p = usePhone()
    const [c, setC] = useState(chat)
    const [msgs, setMsgs] = useState(null)
    const [older, setOlder] = useState(false)
    const [warning, setWarning] = useState('')
    const [text, setText] = useState('')
    const [replyTo, setReplyTo] = useState(null)
    const [busy, setBusy] = useState(false)
    const [err, setErr] = useState('')
    const [rec, setRec] = useState(null)
    const box = useRef(null)
    const file = useRef(null)
    const first = useRef(true)
    useEffect(() => { S.tgOpen = chat.id; return () => { if (S.tgOpen === chat.id) S.tgOpen = null } }, [chat.id])
    useEffect(() => {
      let alive = true
      const local = first.current ? '' : '&local=1'
      apiGet('/tg/messages?chat=' + chat.id + '&limit=50' + local).then(r => {
        if (!alive) return
        first.current = false
        if (r.chat) setC(r.chat)
        setWarning(r.warning || '')
        setMsgs(prev => {
          const olderKept = (prev || []).filter(m => r.messages.length && m.id < r.messages[0].id)
          return [...olderKept, ...r.messages]
        })
      }).catch(e => { if (alive) setErr(e.message) })
      return () => { alive = false }
    }, [chat.id, p.ver.tg])
    const list = msgs || []
    const newest = list.length ? list[list.length - 1].id : 0
    useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight }, [newest])
    useEffect(() => {
      if (newest && c && (c.unread || 0) > 0 && !document.hidden) apiPost('/tg/read', { chat: chat.id, maxId: newest }).catch(() => {})
    }, [newest, c && c.unread])
    async function loadOlder() {
      if (!list.length) return
      setOlder(true)
      try {
        const r = await apiGet('/tg/messages?chat=' + chat.id + '&limit=50&before=' + list[0].id)
        setMsgs(prev => [...r.messages.filter(m => !(prev || []).some(x => x.id === m.id)), ...(prev || [])])
      } catch (e) { setErr(e.message) } finally { setOlder(false) }
    }
    const readOnly = c && c.kind === 'channel' && c.broadcast && !c.canPost
    async function send() {
      const t = text.trim(); if (!t || busy) return
      setBusy(true); setErr('')
      try { await apiPost('/tg/send', { chat: chat.id, text: t, replyTo: replyTo ? replyTo.id : 0 }); setText(''); setReplyTo(null) } catch (e) { setErr(e.message) } finally { setBusy(false) }
    }
    async function upload(blob, name, kind, extra = {}) {
      setBusy(true); setErr('')
      try {
        const qs = new URLSearchParams({ chat: String(chat.id), name, kind, mime: blob.type || '', caption: text.trim(), replyTo: String(replyTo ? replyTo.id : 0), ...extra })
        await apiUpload('/tg/upload?' + qs, blob)
        setText(''); setReplyTo(null)
      } catch (e) { setErr(e.message) } finally { setBusy(false) }
    }
    function pickFile(e) {
      const f = e.target.files && e.target.files[0]
      e.target.value = ''
      if (!f) return
      const kind = /^image\/(jpeg|png)$/.test(f.type) ? 'photo' : /^audio\//.test(f.type) ? 'audio' : /^video\//.test(f.type) ? 'video' : 'document'
      void upload(f, f.name, kind)
    }
    async function toggleRec() {
      if (rec) { rec.stop(); return }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
        const mime = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm'].find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || ''
        const r = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined)
        const parts = []
        const started = Date.now()
        r.ondataavailable = (ev) => { if (ev.data && ev.data.size) parts.push(ev.data) }
        r.onstop = () => {
          stream.getTracks().forEach(t => t.stop())
          setRec(null)
          const secs = (Date.now() - started) / 1000
          if (secs < 0.7 || !parts.length) return
          const blob = new Blob(parts, { type: r.mimeType || 'audio/webm' })
          void upload(blob, 'voice.' + (/ogg/.test(blob.type) ? 'ogg' : 'webm'), 'voice', { duration: String(Math.round(secs)) })
        }
        r.start(250)
        setRec(r)
      } catch (e) { setErr('Microphone: ' + (e.message || e)) }
    }
    const isGroup = c && (c.kind === 'group' || (c.kind === 'channel' && !c.broadcast))
    return (
      <div className="phx-thread">
        <div className="phx-bar">
          <button type="button" className="phx-btn i" onClick={onBack} aria-label="Back">{I.back(14)}</button>
          <span className="phx-av" style={c && c.kind === 'channel' ? { borderRadius: 8 } : undefined}>{tgInitials(c && c.title)}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <div className="phx-name">{c ? c.title : chat.id}</div>
            <div className="phx-s">{c ? kindLabel(c) + (c.username ? ' · @' + c.username : '') + (c.canPost && c.broadcast ? ' · you can post' : '') : ''}</div>
          </span>
          {c && c.kind === 'user' && !c.bot && !c.self ? <button type="button" className="phx-btn i" title="Telegram call (audio through the server)" disabled={!!p.call} onClick={() => { k.dial(String(c.id), 'tg', c.title).catch(e => toast({ kind: 'err', title: 'Call failed', body: e.message })) }}>{I.phone(14)}</button> : null}
        </div>
        <div className="phx-msgs" ref={box}>
          {list.length >= 20 ? <button type="button" className="phx-btn" style={{ alignSelf: 'center' }} disabled={older} onClick={() => void loadOlder()}>{older ? 'Loading' : 'Older messages'}</button> : null}
          {warning ? <div className="phx-note warn">Showing the local copy: {warning}</div> : null}
          {msgs && !list.length ? <div className="phx-empty">No messages yet.</div> : null}
          {list.map(m => m.service ? (
            <div key={m.id} className="phx-s" style={{ alignSelf: 'center', textAlign: 'center', margin: '4px 0' }}>{(m.out ? 'You' : m.fromName || '') + ' ' + m.service} · {fmtWhen(m.date)}</div>
          ) : (
            <div key={m.id} style={{ display: 'flex', flexDirection: 'column', opacity: m.deleted ? 0.5 : 1 }}>
              <div className={'phx-bub ' + (m.out ? 'out' : 'in')}>
                {isGroup && !m.out && m.fromName ? <div style={{ fontWeight: 650, fontSize: 11.5, marginBottom: 2 }}>{m.fromName}</div> : null}
                {m.fwd ? <div className="phx-s" style={{ color: 'inherit', opacity: 0.8 }}>Forwarded from {m.fwd}</div> : null}
                {m.replyTo ? <div className="phx-s" style={{ color: 'inherit', opacity: 0.8 }}>Reply to {(list.find(x => x.id === m.replyTo) || {}).text ? '"' + String(list.find(x => x.id === m.replyTo).text).slice(0, 60) + '"' : '#' + m.replyTo}</div> : null}
                {m.text}
                <MediaView m={m} />
              </div>
              <div className={'phx-meta ' + (m.out ? 'out' : 'in')}>
                {fmtWhen(m.date)}{m.edit ? ' · edited' : ''}{m.views ? ' · ' + m.views + ' views' : ''}{m.deleted ? ' · deleted' : ''}{m.origin === 'agent' ? ' · by agent' : ''}
                {m.out && c && c.kind === 'user' && c.readOut >= m.id ? ' · read' : ''}
                {!readOnly ? <> · <a href="#reply" style={{ color: 'inherit' }} onClick={e => { e.preventDefault(); setReplyTo(m) }}>reply</a></> : null}
              </div>
            </div>
          ))}
        </div>
        {err ? <div className="phx-note bad" style={{ margin: '0 10px 6px' }}>{err}</div> : null}
        {readOnly ? <div className="phx-s" style={{ padding: '8px 10px', borderTop: '1px solid var(--line)' }}>You can read this channel; only its admins can post.</div> : (
          <div>
            {replyTo ? <div className="phx-s" style={{ padding: '4px 10px', borderTop: '1px solid var(--line)' }}>Replying to: {String(replyTo.text || mediaWord(replyTo.media)).slice(0, 80)} <a href="#cancel" onClick={e => { e.preventDefault(); setReplyTo(null) }}>cancel</a></div> : null}
            <div className="phx-compose">
              <input ref={file} type="file" style={{ display: 'none' }} onChange={pickFile} />
              <button type="button" className="phx-btn i" title="Attach a photo or file" disabled={busy} onClick={() => file.current && file.current.click()}>{clip(14)}</button>
              <button type="button" className={'phx-btn i' + (rec ? ' dd' : '')} title={rec ? 'Stop and send the voice message' : 'Record a voice message'} disabled={busy && !rec} onClick={() => void toggleRec()}>{I.mic(14)}</button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <textarea className="phx-in" rows={2} placeholder={c && c.broadcast ? 'Post to the channel' : 'Message'} value={text} onChange={e => setText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
                <div className="phx-s" style={{ marginTop: 3 }}>{rec ? 'Recording... press the microphone again to send' : text ? text.length + ' / 4096' : 'Enter to send, Shift+Enter for a new line. Text is used as caption for attachments.'}</div>
              </div>
              <button type="button" className="phx-btn p" disabled={busy || !text.trim()} onClick={() => void send()}>{busy ? 'Sending' : 'Send'}</button>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ---------------------------------------------------------------- tab view

  function View() {
    const p = usePhone()
    const [chat, setChat] = useState(null)
    useEffect(() => { void refreshTg() }, [])
    useEffect(() => { if (S.tgOpenRequest) { setChat({ id: S.tgOpenRequest, title: '' }); S.tgOpenRequest = null } }, [p.toasts.length])
    const st = p.tg.st
    const ready = st && st.daemon && st.auth && st.auth.state === 'ready'
    if (chat && ready) return <Chat key={chat.id} chat={chat} onBack={() => setChat(null)} />
    return (
      <div className="phx-body">
        {p.tg.err ? <div className="phx-note bad">{p.tg.err}</div> : null}
        {!st && !p.tg.err ? <div className="phx-s">Loading...</div> : null}
        {st && !ready ? <Login st={st} /> : null}
        {ready ? (
          <>
            {st.agent && st.agent.tripped ? <div className="phx-note warn">Agent sending is paused until {new Date(st.agent.tripped.until * 1000).toLocaleString()} after a Telegram spam warning ({st.agent.tripped.why}). Settings, Telegram, to resume.</div> : null}
            <Chats onOpen={(c) => setChat(c)} />
          </>
        ) : null}
      </div>
    )
  }

  // ---------------------------------------------------------------- settings section

  function Setup() {
    const p = usePhone()
    const [cfg, setCfg] = useState(null)
    const [audit, setAudit] = useState(null)
    const [tx, setTx] = useState(null)
    const [msg, setMsg] = useState('')
    const [err, setErr] = useState('')
    const [busy, setBusy] = useState(false)
    useEffect(() => { void refreshTg(); apiGet('/tg/config').then(r => setCfg(r.config)).catch(e => setErr(e.message)); apiGet('/tg/transcribe/config').then(r => setTx(r.config)).catch(() => {}) }, [p.ver.tg])
    const st = p.tg.st
    const a = (st && st.auth) || {}
    const set = (path, v) => { const n = structuredClone(cfg); const ks = path.split('.'); let o = n; for (const kk of ks.slice(0, -1)) o = o[kk]; o[ks[ks.length - 1]] = v; setCfg(n); setMsg('') }
    async function save() {
      setBusy(true); setErr('')
      try { const r = await apiPost('/tg/config', cfg); setCfg(r.config); if (tx) { const t2 = await apiPost('/tg/transcribe/config', { config: tx }); setTx(t2.config) } setMsg('Saved.') } catch (e) { setErr(e.message) } finally { setBusy(false) }
    }
    const act = async (path, label) => { setBusy(true); setErr(''); try { await apiPost(path, {}); setMsg(label); await refreshTg() } catch (e) { setErr(e.message) } finally { setBusy(false) } }
    return (
      <div>
        <div className="phx-h">{icon(12)} Telegram</div>
        {!st ? <div className="phx-s">Loading...</div> : (
          <div className="phx-card">
            <div className="phx-check"><span className={'phx-dot ' + (st.daemon ? 'ok' : 'bad')} /> Service (telegramd): {st.daemon ? 'running' + (st.version ? ', ' + st.version : '') : 'not running'}</div>
            {st.daemon ? <div className="phx-check"><span className={'phx-dot ' + (st.credentials ? 'ok' : 'warn')} /> API credentials: {st.credentials ? 'set (' + (st.credentialsSource === 'file' ? 'api.env file' : 'saved here') + ')' : 'missing'}</div> : null}
            {st.daemon ? <div className="phx-check"><span className={'phx-dot ' + (a.state === 'ready' ? 'ok' : 'warn')} /> Account: {a.state === 'ready' && a.me ? a.me.title + (a.me.username ? ' @' + a.me.username : '') : a.state}</div> : null}
            {st.daemon && st.cache ? <div className="phx-check"><span className="phx-dot" /> Local: {st.counts ? st.counts.chats : 0} chats, media cache {fmtSize(st.cache.media && st.cache.media.bytes) || '0 B'} of {fmtSize(st.cache.media && st.cache.media.capBytes)}</div> : null}
          </div>
        )}
        {st && a.state !== 'ready' ? <Login st={st} /> : null}
        <div className="phx-note warn" style={{ fontSize: 12 }}><b>Account safety:</b> the account's number cannot receive SMS here. In the Telegram app set a cloud password and a recovery email (Settings, Privacy and Security, Two-Step Verification), so the account can always be recovered.</div>
        {cfg ? (
          <div>
            <div className="phx-field"><span>Account phone number (for the code login)</span><input className="phx-in" value={cfg.phone || ''} placeholder="+1 555 0100" onChange={e => set('phone', e.target.value)} /></div>
            <label className="phx-chk"><input type="checkbox" checked={!!cfg.agentSend} onChange={e => set('agentSend', e.target.checked)} /><span>Agents may send from this account (directly, no draft), within the limits below. Off = kill switch.</span></label>
            <label className="phx-chk"><input type="checkbox" checked={!!cfg.agentMarkRead} onChange={e => set('agentMarkRead', e.target.checked)} /><span>Agents may mark chats as read (off: agents read without changing your unread state)</span></label>
            <div className="phx-grid">
              <div className="phx-field"><span>Seconds between agent messages per chat</span><input className="phx-in" type="number" min="1" value={cfg.limits.perChatSeconds} onChange={e => set('limits.perChatSeconds', Number(e.target.value))} /></div>
              <div className="phx-field"><span>Agent messages per hour</span><input className="phx-in" type="number" min="1" value={cfg.limits.perHour} onChange={e => set('limits.perHour', Number(e.target.value))} /></div>
              <div className="phx-field"><span>Agent messages per day</span><input className="phx-in" type="number" min="1" value={cfg.limits.perDay} onChange={e => set('limits.perDay', Number(e.target.value))} /></div>
              <div className="phx-field"><span>Wait out flood limits up to (s)</span><input className="phx-in" type="number" min="1" value={cfg.floodWaitMaxSeconds} onChange={e => set('floodWaitMaxSeconds', Number(e.target.value))} /></div>
            </div>
            <div className="phx-field"><span>Agent allowlist</span><textarea className="phx-in" rows={2} placeholder="@username or chat id, one per line" value={(cfg.agentAllow || []).join('\n')} onChange={e => set('agentAllow', e.target.value.split('\n').map(x => x.trim()).filter(Boolean))} /><em>Chats agents may write to besides existing conversations. Agents never look up new usernames.</em></div>
            <div className="phx-grid">
              <div className="phx-field"><span>Media cache (MB)</span><input className="phx-in" type="number" min="64" value={cfg.media.cacheMB} onChange={e => set('media.cacheMB', Number(e.target.value))} /></div>
              <div className="phx-field"><span>Auto download up to (MB)</span><input className="phx-in" type="number" min="1" value={cfg.media.autoDownloadMB} onChange={e => set('media.autoDownloadMB', Number(e.target.value))} /></div>
              <div className="phx-field"><span>Upload limit (MB)</span><input className="phx-in" type="number" min="1" value={cfg.media.uploadMB} onChange={e => set('media.uploadMB', Number(e.target.value))} /></div>
            </div>
            {cfg.calls ? (
              <div>
                <div className="phx-h">Telegram calls</div>
                <div className="phx-s" style={{ marginBottom: 6 }}>Calls ring the Phone tab on the server audio route; audio goes through Telegram's relays, never straight to the caller. What happens by Phone mode:</div>
                <div className="phx-grid">
                  <div className="phx-field"><span>Do not disturb</span><select className="phx-in" value={cfg.calls.dnd} onChange={e => set('calls.dnd', e.target.value)}><option value="decline">Decline silently</option><option value="ignore">Ignore (the phone app keeps ringing)</option></select></div>
                  <div className="phx-field"><span>Voicemail</span><select className="phx-in" value={cfg.calls.voicemail} onChange={e => set('calls.voicemail', e.target.value)}><option value="decline_text">Decline and send the text below (once per caller every 12 h)</option><option value="decline">Decline silently</option><option value="ignore">Ignore (the phone app keeps ringing)</option></select></div>
                  <div className="phx-field"><span>Live, no Phone tab open</span><select className="phx-in" value={cfg.calls.liveNoTab} onChange={e => set('calls.liveNoTab', e.target.value)}><option value="ignore">Ignore (the phone app keeps ringing)</option><option value="decline">Decline silently</option></select></div>
                  <div className="phx-field"><span>Outgoing calls per day (limit)</span><input className="phx-in" type="number" min="1" max="200" value={cfg.calls.dailyCap} onChange={e => set('calls.dailyCap', Number(e.target.value))} /></div>
                </div>
                <div className="phx-field"><span>Text after a declined call (voicemail mode)</span><textarea className="phx-in" rows={2} maxLength={500} value={cfg.calls.voicemailText || ''} onChange={e => set('calls.voicemailText', e.target.value)} /></div>
              </div>
            ) : null}
            {tx ? (
              <div>
                <div className="phx-h">Voice message transcription</div>
                <label className="phx-chk"><input type="checkbox" checked={!!tx.auto} onChange={e => { setTx({ ...tx, auto: e.target.checked }); setMsg('') }} /><span>Transcribe voice and video messages automatically (language detected; same engine as the voicemails, the local Whisper keeps audio on this server)</span></label>
                <label className="phx-chk"><input type="checkbox" checked={!!tx.audioFiles} onChange={e => { setTx({ ...tx, audioFiles: e.target.checked }); setMsg('') }} /><span>Also audio files (music and recordings sent as files)</span></label>
                <div className="phx-field" style={{ maxWidth: 260 }}><span>Longest message transcribed automatically (minutes)</span><input className="phx-in" type="number" min="1" max="60" value={Math.round((tx.maxSeconds || 600) / 60)} onChange={e => { setTx({ ...tx, maxSeconds: Math.max(1, Number(e.target.value)) * 60 }); setMsg('') }} /><em>Longer ones and older messages have a Transcribe button.</em></div>
              </div>
            ) : null}
            <div className="phx-flex">
              <button type="button" className="phx-btn p" disabled={busy} onClick={() => void save()}>Save Telegram settings</button>
              {st && st.agent && st.agent.tripped ? <button type="button" className="phx-btn" disabled={busy} onClick={() => void act('/tg/agent/untrip', 'Agent sending resumed.')}>Resume agent sending</button> : null}
              <button type="button" className="phx-btn" disabled={busy} onClick={() => void act('/tg/media/clear', 'Media cache cleared.')}>Clear media cache</button>
              <button type="button" className="phx-btn" onClick={() => apiGet('/tg/audit?n=30').then(r => setAudit(r.entries)).catch(e => setErr(e.message))}>Agent audit log</button>
              {a.state === 'ready' ? <button type="button" className="phx-btn d" disabled={busy} onClick={() => { if (window.confirm('Log the DSH session out of Telegram? The Telegram app on your phone stays logged in.')) void act('/tg/logout', 'Logged out.') }}>Log out</button> : null}
            </div>
            {msg ? <div className="phx-s" style={{ color: 'var(--ok)', marginTop: 6 }}>{msg}</div> : null}
            {audit ? <pre className="phx-mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', background: 'var(--l2)', padding: 8, borderRadius: 7 }}>{audit.length ? audit.map(e => JSON.stringify(e)).join('\n') : 'No entries.'}</pre> : null}
          </div>
        ) : null}
        {err ? <div className="phx-note bad" style={{ marginTop: 8 }}>{err}</div> : null}
      </div>
    )
  }

  return { View, Setup, wire, refreshTg, icon }
}
