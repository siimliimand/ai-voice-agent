/**
 * PCM framing and conversion helpers. The pipeline core speaks 16 kHz mono
 * PCM16 little-endian Buffers; these helpers convert formats and split
 * streams into fixed-duration frames.
 */

export const PCM_SAMPLE_RATE_HZ = 16_000;
export const BYTES_PER_SAMPLE = 2;

/** Number of PCM16 samples contained in a buffer. */
export function sampleCount(pcm: Buffer): number {
  return pcm.length >> 1;
}

/** Duration of a PCM buffer in milliseconds. */
export function durationMs(pcm: Buffer, sampleRateHz = PCM_SAMPLE_RATE_HZ): number {
  return Math.round((sampleCount(pcm) / sampleRateHz) * 1000);
}

/** Convert signed 16-bit LE PCM to normalized floats in [-1, 1]. */
export function pcm16ToFloat32(pcm: Buffer): Float32Array {
  const n = sampleCount(pcm);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = pcm.readInt16LE(i * 2) / 32768;
  }
  return out;
}

/** Convert normalized floats in [-1, 1] back to signed 16-bit LE PCM. */
export function float32ToPcm16(samples: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples.length; i++) {
    let v = samples[i] ?? 0;
    if (v > 1) v = 1;
    else if (v < -1) v = -1;
    out.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return out;
}

/** Root mean square of a PCM buffer, normalized to [0, 1]. */
export function rms(pcm: Buffer): number {
  const n = sampleCount(pcm);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/**
 * Split a PCM buffer into fixed-size frames (last frame may be shorter).
 * `frameBytes` must be even.
 */
export function framePcm(pcm: Buffer, frameBytes: number): Buffer[] {
  const frames: Buffer[] = [];
  for (let offset = 0; offset < pcm.length; offset += frameBytes) {
    frames.push(pcm.subarray(offset, Math.min(offset + frameBytes, pcm.length)));
  }
  return frames;
}

/** Bytes for a frame of the given duration at the given sample rate. */
export function frameBytesForMs(ms: number, sampleRateHz = PCM_SAMPLE_RATE_HZ): number {
  return Math.round((sampleRateHz * ms) / 1000) * BYTES_PER_SAMPLE;
}
