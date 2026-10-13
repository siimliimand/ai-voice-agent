import type { AppConfig } from "../config/schema.js";
import { rms } from "./pcm.js";

/** Tunables for the energy VAD; defaults mirror src/config/schema.ts vad. */
export interface VadOptions {
  /** RMS level in [0..1] at or above which a frame counts as speech. */
  threshold?: number;
  /** Consecutive quiet frames required to leave the speech state. */
  hangoverFrames?: number;
  /** Consecutive loud frames required to enter the speech state. */
  onsetFrames?: number;
}

export interface VadResult {
  /** Current smoothed state. */
  isSpeech: boolean;
  /** True exactly on the silence→speech transition. */
  started: boolean;
  /** True exactly on the speech→silence transition. */
  ended: boolean;
}

const DEFAULT_THRESHOLD = 0.015;
const DEFAULT_HANGOVER_FRAMES = 15;
const DEFAULT_ONSET_FRAMES = 2;

/**
 * Deterministic energy-based voice activity detector.
 *
 * Each process() call is one decision "frame" (feed fixed 20 ms chunks so the
 * frame counts line up with the config). A frame is loud when its RMS is at
 * or above the threshold. Speech must persist for onsetFrames consecutive
 * loud frames before the state flips to speech (filters clicks and lip
 * noise); it survives hangoverFrames consecutive quiet frames before flipping
 * back (bridges inter-word pauses).
 */
export class EnergyVAD {
  private readonly threshold: number;
  private readonly hangoverFrames: number;
  private readonly onsetFrames: number;
  private inSpeech = false;
  /** Consecutive loud frames accumulated toward onset. */
  private onsetRun = 0;
  /** Consecutive quiet frames accumulated against the hangover. */
  private hangoverRun = 0;

  constructor(options: VadOptions = {}) {
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.hangoverFrames = options.hangoverFrames ?? DEFAULT_HANGOVER_FRAMES;
    this.onsetFrames = options.onsetFrames ?? DEFAULT_ONSET_FRAMES;
  }

  /** Feed one chunk of caller PCM16 16k audio (any size). */
  process(pcm: Buffer): VadResult {
    const loud = rms(pcm) >= this.threshold;
    let started = false;
    let ended = false;

    if (this.inSpeech) {
      if (loud) {
        this.hangoverRun = 0;
      } else {
        this.hangoverRun += 1;
        if (this.hangoverRun >= this.hangoverFrames) {
          this.inSpeech = false;
          this.onsetRun = 0;
          this.hangoverRun = 0;
          ended = true;
        }
      }
    } else if (loud) {
      this.onsetRun += 1;
      if (this.onsetRun >= this.onsetFrames) {
        this.inSpeech = true;
        this.onsetRun = 0;
        this.hangoverRun = 0;
        started = true;
      }
    } else {
      this.onsetRun = 0;
    }

    return { isSpeech: this.inSpeech, started, ended };
  }

  /** Return to the initial silence state (e.g. after a flush or reconnect). */
  reset(): void {
    this.inSpeech = false;
    this.onsetRun = 0;
    this.hangoverRun = 0;
  }
}

/** Build a VAD from the parsed app config's vad section. */
export function createVadFromConfig(config: AppConfig["vad"]): EnergyVAD {
  return new EnergyVAD(config);
}
