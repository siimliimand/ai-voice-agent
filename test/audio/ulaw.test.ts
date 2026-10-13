import { describe, expect, it } from "vitest";
import { decodeUlaw, encodeUlaw, linearToUlaw, ulawToLinear } from "../../src/audio/ulaw.js";

/**
 * Golden vectors for G.711 μ-law (standard CCITT table edges).
 */
describe("ulaw codec", () => {
  it("maps known sample values to golden code bytes", () => {
    expect(linearToUlaw(0)).toBe(0xff); // silence
    expect(linearToUlaw(32767)).toBe(0x80); // +full scale
    expect(linearToUlaw(-32768)).toBe(0x00); // -full scale
    expect(linearToUlaw(8158)).toBe(0x9f); // segment 6, mantissa 0
    expect(linearToUlaw(32124)).toBe(0x80); // decodes back to max magnitude
  });

  it("decodes known code bytes to golden sample values", () => {
    expect(ulawToLinear(0xff)).toBe(0);
    expect(ulawToLinear(0x80)).toBe(32124); // max positive magnitude
    expect(ulawToLinear(0x00)).toBe(-32124); // max negative magnitude
    expect(ulawToLinear(0x7f)).toBe(0); // negative zero
    expect(ulawToLinear(0xfe)).toBe(8); // first positive step
  });

  it("decodes buffers to little-endian PCM16", () => {
    const pcm = decodeUlaw(Buffer.from([0xff, 0x80]));
    expect(pcm.length).toBe(4);
    expect(pcm.readInt16LE(0)).toBe(0);
    expect(pcm.readInt16LE(2)).toBe(32124);
  });

  it("round-trips the full 16-bit range within quantization tolerance", () => {
    let maxErr = 0;
    let sumSq = 0;
    let sigSq = 0;
    for (let s = -32768; s <= 32767; s += 1) {
      const decoded = ulawToLinear(linearToUlaw(s));
      const err = Math.abs(decoded - s);
      // μ-law quantizes logarithmically: up to ~16 mid-range, ~600 at full scale.
      expect(err).toBeLessThanOrEqual(Math.max(16, Math.abs(s) * 0.05));
      maxErr = Math.max(maxErr, err);
      sumSq += err * err;
      sigSq += s * s;
    }
    expect(maxErr).toBeLessThan(700);
    // Logarithmic quantization keeps error proportional to signal level (~2% RMS).
    expect(Math.sqrt(sumSq / sigSq)).toBeLessThan(0.05);
  });

  it("round-trips block encode/decode", () => {
    const samples = [0, 100, -100, 1000, -1000, 16000, -16000, 32000, -32000];
    const pcm = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => pcm.writeInt16LE(s, i * 2));
    const decoded = decodeUlaw(encodeUlaw(pcm));
    for (let i = 0; i < samples.length; i++) {
      expect(Math.abs(decoded.readInt16LE(i * 2) - (samples[i] as number))).toBeLessThanOrEqual(
        Math.max(4, Math.abs(samples[i] as number) * 0.03),
      );
    }
  });
});
