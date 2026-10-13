/**
 * G.711 μ-law codec.
 *
 * Telephony audio (Twilio Media Streams) arrives as 8 kHz μ-law; the pipeline
 * core runs on 16 kHz signed PCM16 (see design D2). Encoding/decoding is
 * bit-exact against the classic CCITT G.711 tables.
 */

const BIAS = 0x84;
const CLIP = 32635;

/** Decode table for all 256 μ-law byte values (lazily built once). */
const DECODE_TABLE = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const mantissa = u & 0x0f;
    const exponent = (u & 0x70) >> 4;
    const sign = u & 0x80;
    let t = ((mantissa << 3) + BIAS) << exponent;
    t -= BIAS;
    table[i] = sign === 0x80 ? -t : t;
  }
  return table;
})();

/** Encode one PCM16 sample to a μ-law byte. */
export function linearToUlaw(sample: number): number {
  const sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;

  let exponent = 7;
  let mask = 0x4000;
  while (exponent > 0 && (sample & mask) === 0) {
    exponent--;
    mask >>= 1;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Decode one μ-law byte to a PCM16 sample. */
export function ulawToLinear(u: number): number {
  return DECODE_TABLE[u & 0xff] ?? 0;
}

/** Decode a μ-law byte stream to a PCM16 little-endian Buffer. */
export function decodeUlaw(data: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(data.length * 2);
  for (let i = 0; i < data.length; i++) {
    out.writeInt16LE(DECODE_TABLE[data[i] ?? 0] ?? 0, i * 2);
  }
  return out;
}

/** Encode a PCM16 little-endian Buffer to μ-law bytes. */
export function encodeUlaw(pcm: Buffer): Buffer {
  const samples = pcm.length >> 1;
  const out = Buffer.allocUnsafe(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = linearToUlaw(pcm.readInt16LE(i * 2));
  }
  return out;
}
