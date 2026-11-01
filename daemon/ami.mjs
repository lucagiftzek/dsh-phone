/**
 * dsh-phone: a minimal Asterisk Manager Interface client (no dependencies).
 *
 * One TCP connection per call: login, run the actions in order, log off.
 * Responses and events are "Key: Value" blocks separated by a blank line.
 * Actions that answer with a list (EventList: start) are collected until
 * their *Complete event. Used only against 127.0.0.1 (the relay's manager.conf
 * binds the loopback and permits only 127.0.0.1).
 */

import net from 'node:net'
import { EventEmitter } from 'node:events'

export function parseBlock(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const k = line.slice(0, i).trim()
    const v = line.slice(i + 1).trim()
    if (k in out) out[k] = [].concat(out[k], v)
    else out[k] = v
  }
  return out
}

function serialise(action) {
  let s = ''
  for (const [k, v] of Object.entries(action)) {
    if (v === undefined || v === null) continue
    for (const one of Array.isArray(v) ? v : [v]) {
      const val = String(one)
      if (/[\r\n]/.test(val) || /[\r\n:]/.test(k)) throw new Error('AMI field contains a line break')
      s += k + ': ' + val + '\r\n'
    }
  }
  return s + '\r\n'
}

/**
 * amiRun({ host, port, username, secret, timeoutMs }, [ { Action: 'Reload', Module: 'pbx_config.so' }, ... ])
 * resolves to [{ response, events }] in the same order. Throws on connect,
 * login or timeout errors; a failed action is returned with response.Response = 'Error'.
 */
export function amiRun({ host = '127.0.0.1', port = 5038, username, secret, timeoutMs = 8000 } = {}, actions = []) {
  if (!username || !secret) return Promise.reject(new Error('AMI user or secret missing'))
  try { for (const a of actions) serialise(a); serialise({ Username: username, Secret: secret }) } catch (e) { return Promise.reject(e) }
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port })
    let buf = ''
    let banner = false
    let seq = 0
    const pending = new Map() // id -> { response, events, list }
    const queue = []
    const results = []
    let done = false
    const finish = (err, val) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { sock.end() } catch {}
      setTimeout(() => { try { sock.destroy() } catch {} }, 200).unref()
      if (err) reject(err); else resolve(val)
    }
    const timer = setTimeout(() => finish(new Error('AMI timeout')), timeoutMs)
    timer.unref && timer.unref()

    const send = (action) => {
      const id = 'dshp-' + (++seq)
      pending.set(id, { action, response: null, events: [], list: false })
      queue.push(id)
      sock.write(serialise({ ...action, ActionID: id }))
      return id
    }
    let step = -1
    const next = () => {
      step++
      if (step < actions.length) { send(actions[step]); return }
      send({ Action: 'Logoff' })
    }

    sock.setEncoding('utf8')
    sock.on('error', (e) => finish(e))
    sock.on('close', () => finish(null, results))
    sock.on('data', (chunk) => {
      buf += chunk
      if (!banner) {
        const nl = buf.indexOf('\r\n')
        if (nl < 0) return
        if (!/^Asterisk Call Manager/.test(buf.slice(0, nl))) return finish(new Error('not an AMI endpoint'))
        banner = true
        buf = buf.slice(nl + 2)
        send({ Action: 'Login', Username: username, Secret: secret, Events: 'off' })
      }
      let idx
      while ((idx = buf.indexOf('\r\n\r\n')) >= 0) {
        const block = parseBlock(buf.slice(0, idx))
        buf = buf.slice(idx + 4)
        const id = block.ActionID
        const p = id && pending.get(id)
        if (!p) continue
        if ('Response' in block && !p.response) {
          p.response = block
          if (p.action.Action === 'Login') {
            if (block.Response !== 'Success') return finish(new Error('AMI login failed'))
            pending.delete(id)
            next()
            continue
          }
          if (p.action.Action === 'Logoff') { pending.delete(id); return finish(null, results) }
          if (String(block.EventList || '').toLowerCase() === 'start') { p.list = true; continue }
        } else if ('Event' in block) {
          if (/Complete$/.test(block.Event) || String(block.EventList || '').toLowerCase() === 'complete') {
            p.list = false
          } else { p.events.push(block); continue }
        }
        if (p.response && !p.list) {
          pending.delete(id)
          results.push({ response: p.response, events: p.events })
          next()
        }
      }
    })
  })
}

/** Reload the relay's modules after the generated files changed. */
export async function amiReload(opts, modules = ['res_pjsip.so', 'pbx_config.so']) {
  const res = await amiRun(opts, modules.map(m => ({ Action: 'Reload', Module: m })))
  return res.map((r, i) => ({ module: modules[i], ok: r.response.Response === 'Success', message: r.response.Message || '' }))
}

/** Outbound registrations: [{ name, serverUri, clientUri, status, nextReg }]. */
export async function amiRegistrations(opts) {
  const [r] = await amiRun(opts, [{ Action: 'PJSIPShowRegistrationsOutbound' }])
  if (!r || r.response.Response !== 'Success') throw new Error('AMI: ' + ((r && r.response.Message) || 'no answer'))
  return r.events.filter(e => e.Event === 'OutboundRegistrationDetail').map(e => ({
    name: e.ObjectName,
    serverUri: e.ServerUri,
    clientUri: e.ClientUri,
    status: e.Status,
    nextReg: Number(e.NextReg) || 0,
  }))
}

/** Re-send an outbound registration now (AMI PJSIPRegister: unregister + register). */
export async function amiRegister(opts, name) {
  const [r] = await amiRun(opts, [{ Action: 'PJSIPRegister', Registration: name }])
  return !!r && r.response.Response === 'Success'
}

/**
 * A persistent AMI connection with events (used while server-routed calls on
 * a SIP line are up): action(obj) resolves to the response block, 'event'
 * emits every event block, 'close' fires once. Login asks only for the
 * classes it needs (default 'call').
 */
export class AmiSession extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 5038, username, secret, events = 'call', timeoutMs = 8000 } = {}) {
    super()
    this.opts = { host, port, username, secret, events, timeoutMs }
    this.pending = new Map()
    this.seq = 0
    this.closed = false
    this.ready = null
  }

  connect() {
    if (this.ready) return this.ready
    const { host, port, username, secret, events, timeoutMs } = this.opts
    this.ready = new Promise((resolve, reject) => {
      if (!username || !secret) { reject(new Error('AMI user or secret missing')); return }
      const sock = net.connect({ host, port })
      this.sock = sock
      let buf = ''
      let banner = false
      const timer = setTimeout(() => { reject(new Error('AMI timeout')); this.close() }, timeoutMs)
      timer.unref && timer.unref()
      sock.setEncoding('utf8')
      sock.on('error', (e) => { clearTimeout(timer); reject(e); this.close() })
      sock.on('close', () => { clearTimeout(timer); reject(new Error('AMI closed')); this.close() })
      sock.on('data', (chunk) => {
        buf += chunk
        if (!banner) {
          const nl = buf.indexOf('\r\n')
          if (nl < 0) return
          if (!/^Asterisk Call Manager/.test(buf.slice(0, nl))) { reject(new Error('not an AMI endpoint')); this.close(); return }
          banner = true
          buf = buf.slice(nl + 2)
          this.action({ Action: 'Login', Username: username, Secret: secret, Events: events })
            .then(r => { clearTimeout(timer); if (r.Response === 'Success') resolve(this); else { reject(new Error('AMI login failed')); this.close() } })
            .catch(e => { clearTimeout(timer); reject(e) })
        }
        let idx
        while ((idx = buf.indexOf('\r\n\r\n')) >= 0) {
          const block = parseBlock(buf.slice(0, idx))
          buf = buf.slice(idx + 4)
          if ('Response' in block && block.ActionID && this.pending.has(block.ActionID)) {
            const p = this.pending.get(block.ActionID)
            this.pending.delete(block.ActionID)
            p(block)
          } else if ('Event' in block) this.emit('event', block)
        }
      })
    })
    this.ready.catch(() => {})
    return this.ready
  }

  /** Send one action; resolves to its response block (never rejects on Response: Error). */
  action(obj) {
    if (this.closed || !this.sock) return Promise.reject(new Error('AMI not connected'))
    const id = 'dshp-s' + (++this.seq)
    let data
    try { data = serialise({ ...obj, ActionID: id }) } catch (e) { return Promise.reject(e) }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('AMI action timeout')) }, this.opts.timeoutMs)
      t.unref && t.unref()
      this.pending.set(id, (block) => { clearTimeout(t); resolve(block) })
      this.sock.write(data)
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    try { this.sock && this.sock.write(serialise({ Action: 'Logoff', ActionID: 'dshp-bye' })) } catch {}
    try { this.sock && this.sock.end() } catch {}
    setTimeout(() => { try { this.sock && this.sock.destroy() } catch {} }, 300).unref()
    for (const p of this.pending.values()) { try { p({ Response: 'Error', Message: 'AMI closed' }) } catch {} }
    this.pending.clear()
    this.emit('close')
  }
}
