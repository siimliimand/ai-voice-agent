/**
 * Streaming linear-interpolation resampler with chunk-boundary continuity:
 * the same total input split into arbitrary chunks yields the same output as
 * a single call (design D2: conversions live at the transport edge).
 */
export class Resampler {
  private readonly step: number;
  /**
   * Position of the next output sample relative to the start of the incoming
   * chunk, in input-sample units. May be in [-1, 0), in which case the
   * interpolation partner is the last sample of the previous chunk.
   */
  private frac = 0;
  /** Last sample of the previous chunk. */
  private last = 0;

  constructor(
    readonly fromHz: number,
    readonly toHz: number,
  ) {
    if (fromHz <= 0 || toHz <= 0) throw new Error("Resampler rates must be positive");
    this.step = fromHz / toHz;
  }

  process(input: Int16Array): Int16Array {
    if (input.length === 0) return new Int16Array(0);
    const out: number[] = [];
    let frac = this.frac;

    while (frac <= input.length - 1) {
      const i = Math.floor(frac);
      const local = frac - i;
      const a = i < 0 ? this.last : (input[i] as number);
      const b = i + 1 < input.length ? (input[i + 1] as number) : a;
      out.push(Math.round(a + (b - a) * local));
      frac += this.step;
    }

    this.frac = frac - input.length;
    this.last = input[input.length - 1] as number;
    return Int16Array.from(out);
  }
}

/** Convenience: resample a whole PCM16-LE buffer at once. */
export function resampleBuffer(pcm: Buffer, fromHz: number, toHz: number): Buffer {
  const r = new Resampler(fromHz, toHz);
  const samples = new Int16Array(pcm.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2);
  const out = r.process(samples);
  const buf = Buffer.allocUnsafe(out.length * 2);
  for (let i = 0; i < out.length; i++) buf.writeInt16LE(out[i] as number, i * 2);
  return buf;
}
