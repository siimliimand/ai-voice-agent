import type { EventEmitter } from "node:events";
import type { Language } from "../types.js";

/** Request for one synthesis stream. */
export interface TtsRequest {
  language: Language;
  voiceId: string;
  /** Overrides config.tts.model for this stream when set. */
  modelId?: string;
}

/**
 * Events emitted on TtsStream.events:
 * - "audio"     (pcm: Buffer)   — synthesized audio, 16 kHz mono PCM16 LE
 * - "firstByte" (ms: number)    — ms since stream creation, on first audio
 * - "error"     (err: Error)    — provider/socket failure
 * - "done"                      — synthesis fully drained after end()
 */
export interface TtsStream {
  /** Queue more text for synthesis (any size fragment). */
  push(text: string): void;
  /** Signal end of text; remaining audio drains, then "done" fires. */
  end(): void;
  /** Abort immediately: no further audio or events. Never throws. */
  close(): void;
  /** EventEmitter carrying the events documented above. */
  events: EventEmitter;
}

/** Factory for TTS streams backed by one provider. */
export interface TtsProvider {
  readonly name: string;
  stream(req: TtsRequest): TtsStream;
}
