import { describe, expect, it } from "vitest";
import { Resampler, resampleBuffer } from "../../src/audio/resample.js";

function pcmFrom(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

describe("resampler", () => {
  it("passes a constant signal through unchanged", () => {
    const r = new Resampler(8000, 16000);
    const out = r.process(new Int16Array(64).fill(1234));
    expect(out.length).toBeGreaterThanOrEqual(120);
    for (const v of out) expect(Math.abs(v - 1234)).toBeLessThanOrEqual(1);
  });

  it("doubles sample count when upsampling 8k -> 16k", () => {
    const input = Int16Array.from({ length: 800 }, (_, i) =>
      Math.round(10000 * Math.sin((2 * Math.PI * 50 * i) / 8000)),
    );
    const r = new Resampler(8000, 16000);
    const out = r.process(input);
    expect(out.length).toBeCloseTo(1600, -1);
  });

  it("halves sample count when downsampling 16k -> 8k", () => {
    const input = Int16Array.from({ length: 1600 }, (_, i) =>
      Math.round(10000 * Math.sin((2 * Math.PI * 50 * i) / 16000)),
    );
    const r = new Resampler(16000, 8000);
    const out = r.process(input);
    expect(out.length).toBeCloseTo(800, -1);
  });

  it("preserves frequency (zero crossings) when downsampling", () => {
    // 100 Hz tone at 16 kHz -> 100 Hz at 8 kHz: same crossing count per second.
    const mk = (rate: number) =>
      Int16Array.from({ length: rate }, (_, i) =>
        Math.round(10000 * Math.sin((2 * Math.PI * 100 * i) / rate)),
      );
    const crossings = (a: Int16Array) => {
      let c = 0;
      for (let i = 1; i < a.length; i++) {
        if (a[i - 1]! < 0 && a[i]! >= 0) c++;
      }
      return c;
    };
    const down = new Resampler(16000, 8000).process(mk(16000));
    expect(crossings(down)).toBe(crossings(mk(8000)));
  });

  it("is chunk-boundary invariant: split processing equals one-shot processing", () => {
    const input = Int16Array.from({ length: 4096 }, (_, i) =>
      Math.round(12000 * Math.sin((2 * Math.PI * 130 * i) / 16000) + 2000 * Math.cos(i / 7)),
    );
    const oneShot = new Resampler(16000, 8000).process(input);

    const chunked = new Resampler(16000, 8000);
    const out: number[] = [];
    for (let offset = 0; offset < input.length; offset += 320) {
      // 320 samples = 20 ms at 16 kHz (transport frame size).
      const piece = input.subarray(offset, Math.min(offset + 320, input.length));
      for (const v of chunked.process(piece)) out.push(v);
    }
    const chunkedArr = Int16Array.from(out);
    expect(chunkedArr.length).toBe(oneShot.length);
    for (let i = 0; i < oneShot.length; i++) {
      expect(Math.abs(chunkedArr[i]! - oneShot[i]!)).toBeLessThanOrEqual(1);
    }
  });

  it("resampleBuffer converts Buffer in/out", () => {
    const buf = pcmFrom([0, 100, 200, 300, 400, 500]);
    const out = resampleBuffer(buf, 8000, 16000);
    expect(out.length).toBe(22); // 11 samples (positions 0..5 @ step 0.5) * 2 bytes
    expect(out.readInt16LE(0)).toBe(0);
  });
});
