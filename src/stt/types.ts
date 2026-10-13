import type { Language } from "../types.js";

/** Language request for an STT stream: a pinned language or auto-detection. */
export type SttLanguage = "et" | "ru" | "en" | "auto";

/** A transcript event produced by an SttStream. */
export interface SttEvent {
  type: "partial" | "final";
  text: string;
  /** Detected or pinned language, when the provider supplies one. */
  language?: Language;
  /** Provider confidence in [0..1], when available. */
  confidence?: number;
  /**
   * Wall-clock time of event creation (Date.now()). The voice pipeline
   * normalizes this to a call-relative offset (`atMs - session.startedAt`)
   * before storing an utterance in the session transcript or persisting it
   * to call_transcripts.at_ms; adapters always emit wall-clock here.
   */
  atMs: number;
}

/** Options for opening an STT stream. */
export interface SttStreamOptions {
  language: SttLanguage;
  /** Sample rate of the mono PCM16 audio passed to write(). */
  sampleRateHz: number;
}

/** A live speech-to-text stream: audio in, transcript events out. */
export interface SttStream {
  /** Feed mono 16-bit little-endian PCM at the negotiated sample rate. */
  write(pcm: Buffer): void;
  /**
   * Flush and close gracefully (asks the provider to commit any pending
   * audio); resolves once the underlying socket is down. Never throws.
   */
  close(): Promise<void>;
  /** Register a transcript listener. Later partials replace earlier ones. */
  on(listener: (e: SttEvent) => void): void;
  /** True once the stream is finished and no more events will be emitted. */
  readonly closed: boolean;
}

/** Factory for STT streams backed by one provider. */
export interface SttProvider {
  readonly name: string;
  startStream(opts: SttStreamOptions): SttStream;
}

/**
 * Normalize a provider language tag ("et", "et-EE", "est", "rus", ...)
 * to one of our Language values; undefined when unrecognized.
 */
export function normalizeLanguage(code: unknown): Language | undefined {
  if (typeof code !== "string") return undefined;
  const lower = code.toLowerCase();
  if (lower.startsWith("et") || lower.startsWith("est")) return "et";
  if (lower.startsWith("ru") || lower.startsWith("rus")) return "ru";
  if (lower.startsWith("en") || lower.startsWith("eng")) return "en";
  return undefined;
}
