import WebSocket from "ws";
import type { AppConfig } from "../config/schema.js";
import { logger, type Logger } from "../logging.js";
import {
  normalizeLanguage,
  type SttEvent,
  type SttProvider,
  type SttStream,
  type SttStreamOptions,
} from "./types.js";
import { closeWebSocket, rawDataToText } from "./ws-common.js";

/** ElevenLabs public API WebSocket endpoint for Scribe v2 Realtime. */
const ELEVENLABS_WS_BASE = "wss://api.elevenlabs.io";
const REALTIME_PATH = "/v1/speech-to-text/realtime";
/** Max time to wait for the peer to answer our close handshake. */
const CLOSE_TIMEOUT_MS = 2_000;
/** Buffer cap while the socket is still connecting (~10 s @16 kHz PCM16); oldest audio is dropped beyond this. */
const MAX_PENDING_BYTES = 320_000;
/** PCM sample rates the realtime endpoint accepts via the audio_format query param. */
const PCM_RATES: ReadonlySet<number> = new Set([8_000, 16_000, 22_050, 24_000, 44_100, 48_000]);

/** Shape of the Scribe realtime messages we consume; parsed defensively. */
export interface ScribeRealtimeMessage {
  message_type?: unknown;
  text?: unknown;
  language_code?: unknown;
  error?: unknown;
}

/** Every error event type the Scribe realtime API can emit (see event reference). */
const ERROR_TYPES: ReadonlySet<string> = new Set([
  "error",
  "auth_error",
  "quota_exceeded",
  "transcriber_error",
  "input_error",
  "invalid_request",
  "commit_throttled",
  "unaccepted_terms",
  "rate_limited",
  "queue_overflow",
  "resource_exhausted",
  "session_time_limit_exceeded",
  "chunk_size_exceeded",
  "insufficient_audio_activity",
]);

export interface ParseScribeOptions {
  /** Wall-clock ms for the produced event. */
  atMs: number;
  /**
   * True when the session was opened with language detection / timestamps.
   * In that mode every commit produces BOTH `committed_transcript` and
   * `committed_transcript_with_timestamps` (the latter carrying the detected
   * language), so the plain variant is suppressed in favor of the timestamped
   * one to avoid duplicate finals.
   */
  timestampsAuthoritative?: boolean;
}

/**
 * Map a raw Scribe realtime frame to a transcript event.
 * Pure function; returns null for anything that is not user speech:
 * malformed JSON, keepalives (empty partials), session/warning/error events.
 */
export function parseScribeMessage(raw: string, opts: ParseScribeOptions): SttEvent | null {
  let msg: ScribeRealtimeMessage;
  try {
    msg = JSON.parse(raw) as ScribeRealtimeMessage;
  } catch {
    return null;
  }
  if (msg === null || typeof msg !== "object") return null;

  const type = typeof msg.message_type === "string" ? msg.message_type : undefined;
  const text = typeof msg.text === "string" ? msg.text : "";
  const language = normalizeLanguage(msg.language_code);

  switch (type) {
    case "partial_transcript":
      // Empty text is a keepalive, not speech.
      if (text.trim() === "") return null;
      return { type: "partial", text, language, atMs: opts.atMs };
    case "committed_transcript":
      if (opts.timestampsAuthoritative) return null; // the timestamped variant follows immediately
      if (text.trim() === "") return null;
      return { type: "final", text, language, atMs: opts.atMs };
    case "committed_transcript_with_timestamps":
      if (!opts.timestampsAuthoritative) return null; // duplicate of committed_transcript
      if (text.trim() === "") return null;
      return { type: "final", text, language, atMs: opts.atMs };
    default:
      // session_started, warning, entity/edit events and all *error types
      // carry no transcript; errors are surfaced separately via scribeErrorText.
      return null;
  }
}

/**
 * Return a human-readable error message when the frame is one of the Scribe
 * error events, else null. Kept separate from parseScribeMessage so error
 * handling stays testable without coupling to transcript parsing.
 */
export function scribeErrorText(raw: string): string | null {
  let msg: ScribeRealtimeMessage;
  try {
    msg = JSON.parse(raw) as ScribeRealtimeMessage;
  } catch {
    return null;
  }
  const type = msg?.message_type;
  if (typeof type === "string" && ERROR_TYPES.has(type)) {
    return typeof msg.error === "string" && msg.error.length > 0 ? `${type}: ${msg.error}` : type;
  }
  return null;
}

/** Scribe v2 Realtime STT provider (ElevenLabs). */
export class ScribeSttProvider implements SttProvider {
  readonly name = "scribe";

  private readonly log: Logger;
  private readonly model: string;
  private readonly apiKey: string;

  constructor(config: AppConfig, log: Logger = logger) {
    this.log = log.child({ stage: "stt", provider: this.name });
    this.model = config.stt.model;
    this.apiKey = config.elevenlabs.apiKey ?? "";
  }

  startStream(opts: SttStreamOptions): SttStream {
    return new ScribeStream(opts, this.model, this.apiKey, this.log);
  }
}

class ScribeStream implements SttStream {
  private readonly listeners = new Set<(e: SttEvent) => void>();
  private readonly pending: Buffer[] = [];
  private pendingBytes = 0;
  private ws: WebSocket | null = null;
  private closePromise: Promise<void> | null = null;
  private closeRequested = false;
  private _closed = false;

  constructor(
    private readonly opts: SttStreamOptions,
    private readonly model: string,
    apiKey: string,
    private readonly log: Logger,
  ) {
    this.connect(apiKey);
  }

  get closed(): boolean {
    return this._closed;
  }

  on(listener: (e: SttEvent) => void): void {
    this.listeners.add(listener);
  }

  write(pcm: Buffer): void {
    if (this._closed || this.closeRequested) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendChunk(pcm);
      return;
    }
    // Socket still connecting: buffer and flush on open.
    this.pending.push(pcm);
    this.pendingBytes += pcm.length;
    while (this.pendingBytes > MAX_PENDING_BYTES && this.pending.length > 0) {
      const dropped = this.pending.shift();
      this.pendingBytes -= dropped?.length ?? 0;
      this.log.warn("dropped oldest buffered audio: socket still connecting");
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.doClose();
    return this.closePromise;
  }

  private connect(apiKey: string): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.buildUrl(), { headers: { "xi-api-key": apiKey } });
    } catch (err) {
      this.log.error({ err }, "failed to create Scribe websocket");
      this._closed = true;
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      for (const chunk of this.pending.splice(0)) {
        this.sendChunk(chunk);
      }
      if (this.closeRequested) {
        void this.close();
      }
    });
    ws.on("message", (data) => this.handleFrame(rawDataToText(data)));
    ws.on("error", (err) => {
      // Never propagate into the pipeline; log and consider the stream dead.
      this.log.warn({ err }, "scribe websocket error");
    });
    ws.on("close", () => {
      this._closed = true;
    });
  }

  private buildUrl(): string {
    const url = new URL(`${ELEVENLABS_WS_BASE}${REALTIME_PATH}`);
    url.searchParams.set("model_id", this.model);
    const rate = PCM_RATES.has(this.opts.sampleRateHz) ? this.opts.sampleRateHz : 16_000;
    url.searchParams.set("audio_format", `pcm_${rate}`);
    // Auto-commit on end-of-speech via server VAD; manual commits would add
    // orchestrator round-trips we do not need in v1.
    url.searchParams.set("commit_strategy", "vad");
    if (this.opts.language !== "auto") {
      url.searchParams.set("language_code", this.opts.language);
    } else {
      // Detection mode: commits then include committed_transcript_with_timestamps
      // carrying the detected language_code.
      url.searchParams.set("include_language_detection", "true");
    }
    return url.toString();
  }

  private sendChunk(pcm: Buffer): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(
        JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: pcm.toString("base64"),
          commit: false,
          sample_rate: this.opts.sampleRateHz,
        }),
      );
    } catch (err) {
      this.log.warn({ err }, "failed to send audio chunk to scribe");
    }
  }

  private handleFrame(text: string): void {
    const errorText = scribeErrorText(text);
    if (errorText !== null) {
      this.log.warn({ error: errorText }, "scribe error event");
      return;
    }
    const event = parseScribeMessage(text, {
      atMs: Date.now(),
      timestampsAuthoritative: this.opts.language === "auto",
    });
    if (event !== null) this.emitEvent(event);
  }

  private emitEvent(event: SttEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.log.warn({ err }, "stt listener threw");
      }
    }
  }

  private async doClose(): Promise<void> {
    this.closeRequested = true;
    const ws = this.ws;
    if (!ws) {
      this._closed = true;
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      // Commit signal: empty audio chunk with commit=true settles the last
      // segment before the socket goes away.
      try {
        ws.send(
          JSON.stringify({
            message_type: "input_audio_chunk",
            audio_base_64: "",
            commit: true,
            sample_rate: this.opts.sampleRateHz,
          }),
        );
      } catch (err) {
        this.log.warn({ err }, "failed to send scribe commit signal");
      }
    }
    await closeWebSocket(ws, CLOSE_TIMEOUT_MS);
    this._closed = true;
  }
}
