import { describe, expect, it } from "vitest";
import {
  durationMs,
  float32ToPcm16,
  frameBytesForMs,
  framePcm,
  pcm16ToFloat32,
  rms,
  sampleCount,
} from "../../src/audio/pcm.js";

describe("pcm helpers", () => {
  it("counts samples and durations", () => {
    const buf = Buffer.alloc(320 * 2); // 320 samples = 20 ms @ 16 kHz
    expect(sampleCount(buf)).toBe(320);
    expect(durationMs(buf)).toBe(20);
  });

  it("converts PCM16 <-> Float32 losslessly within int16 resolution", () => {
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(0, 0);
    buf.writeInt16LE(16384, 2);
    buf.writeInt16LE(-16384, 4);
    buf.writeInt16LE(32767, 6);

    const f = pcm16ToFloat32(buf);
    expect(f[0]).toBe(0);
    expect(f[1]).toBeCloseTo(0.5, 5);
    expect(f[2]).toBeCloseTo(-0.5, 5);

    const back = float32ToPcm16(f);
    expect(back.readInt16LE(0)).toBe(0);
    expect(Math.abs(back.readInt16LE(2) - 16384)).toBeLessThanOrEqual(1);
    expect(Math.abs(back.readInt16LE(4) + 16383)).toBeLessThanOrEqual(1);
    expect(Math.abs(back.readInt16LE(6) - 32767)).toBeLessThanOrEqual(1);
  });

  it("clamps float conversion to [-1, 1]", () => {
    const out = float32ToPcm16(Float32Array.from([5, -5]));
    expect(out.readInt16LE(0)).toBe(32767);
    expect(out.readInt16LE(2)).toBe(-32767);
  });

  it("computes rms: silence is 0, full-scale square is ~1", () => {
    expect(rms(Buffer.alloc(320))).toBe(0);
    const square = Buffer.alloc(320 * 2);
    for (let i = 0; i < 320; i++) square.writeInt16LE(i % 2 === 0 ? 32767 : -32767, i * 2);
    expect(rms(square)).toBeCloseTo(1, 2);
  });

  it("frames pcm into fixed-size chunks with a short tail", () => {
    const buf = Buffer.alloc(1000);
    const frames = framePcm(buf, 640);
    expect(frames).toHaveLength(2);
    expect(frames[0]?.length).toBe(640);
    expect(frames[1]?.length).toBe(360);
  });

  it("returns no frames for empty input", () => {
    expect(framePcm(Buffer.alloc(0), 640)).toHaveLength(0);
  });

  it("computes 20 ms frame size", () => {
    expect(frameBytesForMs(20)).toBe(640); // 16000 * 0.02 * 2
  });
});
