/**
 * dsh-phone: the binary framing of the browser audio link.
 *
 * Every message on the link is ONE binary blob, whatever carries it (today a
 * WebSocket, later possibly an encrypted channel): the framing never relies on
 * the socket's text/binary distinction.
 *
 *   byte 0      kind: 0x01 audio, 0x02 control
 *   audio:
 *   byte 1      codec: 0x00 = PCMU (G.711 mu-law, 8 kHz, mono)
 *   bytes 2-3   seq, uint16 big-endian, counted in 20 ms blocks (wraps)
 *   bytes 4-7   sender clock in ms, uint32 big-endian (wraps), for jitter and echo RTT
 *   bytes 8..   payload: n * 160 bytes (n blocks of 20 ms)
 *   control:
 *   bytes 1..   UTF-8 JSON object { t: '<type>', ... }
 *
 * Self-contained functions (no outer references) so the client can inline them.
 */

export const KIND_AUDIO = 0x01
export const KIND_CONTROL = 0x02
export const CODEC_PCMU = 0x00
export const BLOCK_SAMPLES = 160 // 20 ms at 8 kHz
export const HEADER_BYTES = 8
export const MAX_FRAME_BYTES = 8 + 160 * 10 // up to 200 ms per message

/** Build an audio frame. payload: Uint8Array of n*160 mu-law bytes. */
export function encodeAudio(seq, clockMs, payload) {
  const out = new Uint8Array(8 + payload.length)
  out[0] = 0x01
  out[1] = 0x00
  out[2] = (seq >> 8) & 0xff
  out[3] = seq & 0xff
  const c = clockMs >>> 0
  out[4] = (c >>> 24) & 0xff
  out[5] = (c >>> 16) & 0xff
  out[6] = (c >>> 8) & 0xff
  out[7] = c & 0xff
  out.set(payload, 8)
  return out
}

/** Build a control frame from a plain object. */
export function encodeControl(obj) {
  const json = new TextEncoder().encode(JSON.stringify(obj))
  const out = new Uint8Array(1 + json.length)
  out[0] = 0x02
  out.set(json, 1)
  return out
}

/**
 * Parse one frame. Returns { kind: 'audio', codec, seq, clock, payload, blocks }
 * or { kind: 'control', msg } or { kind: 'invalid', reason }.
 */
export function decodeFrame(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (!b.length) return { kind: 'invalid', reason: 'empty' }
  if (b.length > 8 + 160 * 10 && b[0] === 0x01) return { kind: 'invalid', reason: 'too large' }
  if (b[0] === 0x01) {
    if (b.length < 8 + 160) return { kind: 'invalid', reason: 'short audio frame' }
    if (b[1] !== 0x00) return { kind: 'invalid', reason: 'unknown codec' }
    const plen = b.length - 8
    if (plen % 160 !== 0) return { kind: 'invalid', reason: 'payload not a multiple of 20 ms' }
    const seq = (b[2] << 8) | b[3]
    const clock = ((b[4] << 24) >>> 0) + (b[5] << 16) + (b[6] << 8) + b[7]
    return { kind: 'audio', codec: 0, seq, clock, payload: b.subarray(8), blocks: plen / 160 }
  }
  if (b[0] === 0x02) {
    if (b.length > 16384) return { kind: 'invalid', reason: 'control too large' }
    try {
      const msg = JSON.parse(new TextDecoder().decode(b.subarray(1)))
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return { kind: 'invalid', reason: 'control without type' }
      return { kind: 'control', msg }
    } catch { return { kind: 'invalid', reason: 'control not JSON' } }
  }
  return { kind: 'invalid', reason: 'unknown kind' }
}
