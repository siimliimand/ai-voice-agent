import { describe, expect, it } from "vitest";
import { PCM_SAMPLE_RATE_HZ, rms } from "../../src/audio/pcm.js";
import { EnergyVAD, createVadFromConfig } from "../../src/audio/vad.js";

const FRAME_MS = 20;
const FRAME_SAMPLES = (PCM_SAMPLE_RATE_HZ * FRAME_MS) / 1000; // 320
const DEFAULT_THRESHOLD = 0.015;

/** Deterministic sine burst; RMS ≈ amplitude/√2. */
function sine(amplitude: number, samples = FRAME_SAMPLES, freqHz = 440): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = amplitude * Math.sin((2 * Math.PI * freqHz * i) / PCM_SAMPLE_RATE_HZ);
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return pcm;
}

/** Deterministic xorshift32 pseudo-noise; RMS ≈ amplitude/√3. */
function quietNoise(amplitude = 0.005, samples = FRAME_SAMPLES, seed = 7): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  let s = seed | 0;
  for (let i = 0; i < samples; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s |= 0;
    const unit = (s >>> 0) / 0xffffffff; // [0, 1]
    const v = (unit * 2 - 1) * amplitude; // [-amplitude, amplitude]
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return pcm;
}

describe("EnergyVAD fixtures", () => {
  it("quiet noise sits below the threshold and loud sine above it", () => {
    expect(rms(quietNoise())).toBeLessThan(DEFAULT_THRESHOLD);
    expect(rms(sine(0.3))).toBeGreaterThan(DEFAULT_THRESHOLD);
    expect(rms(Buffer.alloc(FRAME_SAMPLES * 2))).toBe(0);
  });
});

describe("EnergyVAD", () => {
  it("stays silent on silence", () => {
    const vad = new EnergyVAD();
    const silence = Buffer.alloc(FRAME_SAMPLES * 2);
    for (let i = 0; i < 5; i++) {
      expect(vad.process(silence)).toEqual({
        isSpeech: false,
        started: false,
        ended: false,
      });
    }
  });

  it("starts only after onsetFrames consecutive loud frames", () => {
    const vad = new EnergyVAD(); // onsetFrames = 2
    const loud = sine(0.3);
    expect(vad.process(loud)).toEqual({
      isSpeech: false,
      started: false,
      ended: false,
    });
    expect(vad.process(loud)).toEqual({
      isSpeech: true,
      started: true,
      ended: false,
    });
    expect(vad.process(loud)).toEqual({
      isSpeech: true,
      started: false,
      ended: false,
    });
  });

  it("ends exactly after hangoverFrames consecutive quiet frames", () => {
    const vad = new EnergyVAD(); // hangoverFrames = 15
    const loud = sine(0.3);
    const quiet = quietNoise();
    vad.process(loud);
    expect(vad.process(loud).started).toBe(true);

    for (let i = 1; i < 15; i++) {
      expect(vad.process(quiet)).toEqual({
        isSpeech: true,
        started: false,
        ended: false,
      });
    }
    expect(vad.process(quiet)).toEqual({
      isSpeech: false,
      started: false,
      ended: true,
    });
    expect(vad.process(quiet)).toEqual({
      isSpeech: false,
      started: false,
      ended: false,
    });
  });

  it("ignores blips shorter than the onset window", () => {
    const vad = new EnergyVAD();
    const loud = sine(0.3);
    const quiet = quietNoise();
    for (let i = 0; i < 6; i++) {
      expect(vad.process(loud)).toEqual({
        isSpeech: false,
        started: false,
        ended: false,
      });
      expect(vad.process(quiet)).toEqual({
        isSpeech: false,
        started: false,
        ended: false,
      });
    }
  });

  it("hangover bridges short pauses without ending or restarting", () => {
    const vad = new EnergyVAD();
    const loud = sine(0.3);
    const quiet = quietNoise();
    vad.process(loud);
    expect(vad.process(loud).started).toBe(true);

    for (let i = 0; i < 10; i++) {
      const result = vad.process(quiet); // 10 < 15 hangover frames
      expect(result.isSpeech).toBe(true);
      expect(result.ended).toBe(false);
    }

    // Speech resumes without a new "started" transition.
    expect(vad.process(loud)).toEqual({
      isSpeech: true,
      started: false,
      ended: false,
    });
  });

  it("counts arbitrary chunk sizes, including sub-frame chunks", () => {
    const vad = new EnergyVAD(); // onsetFrames = 2
    const loudHalfFrame = sine(0.3, FRAME_SAMPLES / 2); // 10 ms
    expect(vad.process(loudHalfFrame).started).toBe(false);
    expect(vad.process(loudHalfFrame)).toEqual({
      isSpeech: true,
      started: true,
      ended: false,
    });
  });

  it("reset() returns to silence and requires a fresh onset", () => {
    const vad = new EnergyVAD();
    const loud = sine(0.3);
    vad.process(loud);
    vad.reset();

    expect(vad.process(loud)).toEqual({
      isSpeech: false,
      started: false,
      ended: false,
    });
    expect(vad.process(loud)).toEqual({
      isSpeech: true,
      started: true,
      ended: false,
    });
  });

  it("honors custom options", () => {
    // Amplitude-0.3 sine (RMS ≈ 0.21) stays below a 0.5 threshold.
    const strict = new EnergyVAD({ threshold: 0.5, onsetFrames: 1 });
    expect(strict.process(sine(0.3)).isSpeech).toBe(false);

    // onsetFrames = 1 starts on the very first loud frame.
    const instant = new EnergyVAD({ onsetFrames: 1 });
    expect(instant.process(sine(0.3))).toEqual({
      isSpeech: true,
      started: true,
      ended: false,
    });
  });
});

describe("createVadFromConfig", () => {
  it("builds a VAD honoring the app config values", () => {
    const vad = createVadFromConfig({
      threshold: 0.015,
      hangoverFrames: 15,
      onsetFrames: 2,
    });
    expect(vad).toBeInstanceOf(EnergyVAD);

    const loud = sine(0.3);
    const quiet = quietNoise();
    vad.process(loud);
    expect(vad.process(loud).started).toBe(true);

    for (let i = 1; i < 15; i++) {
      expect(vad.process(quiet).ended).toBe(false);
    }
    expect(vad.process(quiet).ended).toBe(true);
  });
});
