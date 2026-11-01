/**
 * dsh-phone: small adaptive jitter buffer for 20 ms audio blocks.
 *
 * Used in two places: the browser AudioWorklet (playout of the far end) and
 * the server (pacing the browser's audio towards Asterisk / Twilio). The class
 * is self-contained (no outer references) so the client can inline it into the
 * worklet source with Function#toString.
 *
 * Model: the link is a WebSocket over TCP, so blocks arrive in order and are
 * rarely lost, but they arrive in bursts after a stall. The buffer measures
 * how late each block arrives compared with the earliest observed transit
 * ("delay deviation"), keeps a slowly decaying peak of that deviation, and
 * plays out with a target delay of peak + one block, clamped to [minMs, maxMs].
 *
 *   push(seq, block, nowMs)   seq is uint16 (wraps), counted in 20 ms blocks
 *   pull(nowMs)               -> { block, kind } kind: audio | plc | silence
 *                                block is null for plc/silence (the caller
 *                                conceals with its own decoded history)
 *
 * Latency control: when the queue holds more than target + 3 blocks for a
 * while, one block is dropped (at most one per 5 pulls). An empty queue is an
 * underrun: the buffer re-buffers up to the (now larger) target.
 */
export class JitterBuffer {
  constructor(opts) {
    const o = opts || {}
    this.frameMs = o.frameMs || 20
    this.minMs = o.minMs || 40
    this.maxMs = o.maxMs || 400
    this.reset()
  }

  reset() {
    this.q = new Map()
    this.playing = false
    this.next = 0
    this.highest = -1
    this.base = null
    this.peak = 0
    this.jitter = 0
    this.lastTransit = null
    this.sinceTrim = 0
    this.plcRun = 0
    this.st = { received: 0, played: 0, late: 0, dropped: 0, dup: 0, underruns: 0, plc: 0, silence: 0, resets: 0 }
  }

  /** Map a uint16 sequence number onto a monotonic integer near the highest seen. */
  unwrap(seq) {
    if (this.highest < 0) return seq
    const hi = this.highest
    let ext = (hi & ~0xffff) | (seq & 0xffff)
    if (ext < hi - 32768) ext += 65536
    else if (ext > hi + 32768) ext -= 65536
    return ext
  }

  targetMs() {
    const t = this.peak + this.frameMs
    return Math.max(this.minMs, Math.min(this.maxMs, t))
  }

  depth() { return this.q.size }

  push(seq, block, nowMs) {
    const ext = this.unwrap(seq)
    this.st.received++
    // A jump far ahead (sender restarted) or far behind: start again.
    if (this.highest >= 0 && (ext > this.highest + 250 || ext < this.next - 250)) {
      const keep = this.st
      this.reset()
      this.st = keep
      this.st.resets++
      this.st.received--
      return this.push(seq, block, nowMs)
    }
    if (this.playing && ext < this.next) { this.st.late++; return false }
    if (this.q.has(ext)) { this.st.dup++; return false }
    this.q.set(ext, block)
    if (ext > this.highest) this.highest = ext
    // Transit = arrival - send slot. Its minimum is the base; the deviation
    // above the base is how much delay this block needed.
    const transit = nowMs - ext * this.frameMs
    if (this.base === null || transit < this.base) this.base = transit
    const dev = transit - this.base
    if (dev > this.peak) this.peak = dev
    if (this.lastTransit !== null) {
      const d = Math.abs(transit - this.lastTransit)
      this.jitter += (d - this.jitter) / 16
    }
    this.lastTransit = transit
    return true
  }

  pull() {
    // Slow decay of the peak (about 1 % per second at 20 ms blocks), and of the
    // base so clock drift between sender and receiver cannot pin it.
    this.peak *= 0.9998
    if (this.base !== null) this.base += 0.0005 * this.frameMs
    if (!this.playing) {
      if (!this.q.size) return this.conceal('silence')
      let first = Infinity
      for (const k of this.q.keys()) if (k < first) first = k
      if (this.q.size * this.frameMs >= this.targetMs() || this.highest - first >= Math.ceil(this.targetMs() / this.frameMs)) {
        this.playing = true
        this.next = first
      } else return this.conceal('silence')
    }
    this.sinceTrim++
    // Too much queued: drop one block to bring the latency back down.
    const excess = this.q.size - Math.ceil(this.targetMs() / this.frameMs) - 3
    if (excess > 0 && this.sinceTrim >= 5 && this.q.has(this.next) && this.q.has(this.next + 1)) {
      this.q.delete(this.next)
      this.next++
      this.st.dropped++
      this.sinceTrim = 0
    }
    if (this.q.has(this.next)) {
      const block = this.q.get(this.next)
      this.q.delete(this.next)
      this.next++
      this.st.played++
      this.plcRun = 0
      return { block, kind: 'audio' }
    }
    if (this.q.size) {
      // A gap with later blocks waiting: conceal this slot and move on.
      for (const k of [...this.q.keys()]) if (k < this.next) this.q.delete(k)
      this.next++
      return this.conceal('plc')
    }
    // Empty: underrun. Re-buffer (the stall raised the peak, so the target grows).
    this.st.underruns++
    this.playing = false
    return this.conceal('plc')
  }

  conceal(kind) {
    if (kind === 'plc') { this.plcRun++; this.st.plc++ } else this.st.silence++
    return { block: null, kind, run: this.plcRun }
  }

  stats() {
    return {
      depthMs: this.q.size * this.frameMs,
      targetMs: Math.round(this.targetMs()),
      jitterMs: Math.round(this.jitter * 10) / 10,
      peakMs: Math.round(this.peak),
      received: this.st.received, played: this.st.played, late: this.st.late, dropped: this.st.dropped,
      dup: this.st.dup, underruns: this.st.underruns, plc: this.st.plc, silence: this.st.silence, resets: this.st.resets,
    }
  }
}
