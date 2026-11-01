/**
 * dsh-phone: G.711 mu-law (PCMU) codec, shared by the browser worklet and the
 * server. Every function is self-contained (no outer references) so the
 * client can inline it into the AudioWorklet source with Function#toString.
 *
 * mu-law is the codec of the browser audio link: the far ends are 8 kHz G.711
 * anyway (Twilio Media Streams send and expect audio/x-mulaw; Asterisk turns
 * the AudioSocket 16-bit PCM into alaw/ulaw for the SIP provider), so the link
 * adds no transcoding loss on the Twilio path and needs no codec library.
 */

/** One 16-bit signed PCM sample to one mu-law byte. */
export function ulawEncode(sample) {
  let s = sample | 0
  if (s > 32767) s = 32767
  else if (s < -32768) s = -32768
  const sign = s < 0 ? 0x80 : 0
  if (sign) s = -s
  if (s > 32635) s = 32635
  s += 0x84
  let exp = 7
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp--
  const mant = (s >> (exp + 3)) & 0x0f
  return (~(sign | (exp << 4) | mant)) & 0xff
}

/** One mu-law byte to one 16-bit signed PCM sample. */
export function ulawDecode(byte) {
  const u = (~byte) & 0xff
  const sign = u & 0x80
  const exp = (u >> 4) & 0x07
  const mant = u & 0x0f
  const mag = (((mant << 3) + 0x84) << exp) - 0x84
  return sign ? -mag : mag
}

/** mu-law byte for digital silence. */
export const ULAW_SILENCE = 0xff

/** Uint8Array mu-law to Int16Array PCM. */
export function ulawToPcm(bytes) {
  const out = new Int16Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = ulawDecode(bytes[i])
  return out
}

/** Int16Array PCM to Uint8Array mu-law. */
export function pcmToUlaw(pcm) {
  const out = new Uint8Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = ulawEncode(pcm[i])
  return out
}

/** Int16Array PCM to a little-endian byte Buffer/Uint8Array (AudioSocket slin). */
export function pcmToLeBytes(pcm) {
  const out = new Uint8Array(pcm.length * 2)
  for (let i = 0; i < pcm.length; i++) { const v = pcm[i]; out[2 * i] = v & 0xff; out[2 * i + 1] = (v >> 8) & 0xff }
  return out
}

/** Little-endian 16-bit bytes to Int16Array. */
export function leBytesToPcm(bytes) {
  const n = bytes.length >> 1
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) { const v = bytes[2 * i] | (bytes[2 * i + 1] << 8); out[i] = v > 32767 ? v - 65536 : v }
  return out
}

/** RMS level of a mu-law block, 0..1. */
export function ulawLevel(bytes) {
  if (!bytes || !bytes.length) return 0
  let sum = 0
  for (let i = 0; i < bytes.length; i++) { const v = ulawDecode(bytes[i]) / 32768; sum += v * v }
  return Math.sqrt(sum / bytes.length)
}
