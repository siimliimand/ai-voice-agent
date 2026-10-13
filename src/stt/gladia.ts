import WebSocket from "ws";
import type { AppConfig } from "../config/schema.js";
import { logger, type Logger } from "../logging.js";
import { LANGUAGES, type Language } from "../types.js";
import {
  normalizeLanguage,
  type SttEvent,
  type SttProvider,
  type SttStream,
  type SttStreamOptions,
} from "./types.js";
import { closeWebSocket, rawDataToText } from "./ws-common.js";

/** Gladia public API base (v2 live sessions; EU residency would use api.eu.gladia.io). */
const GLADIA_API_BASE = "https://api.gladia.io";
/** Max time to wait for the peer to answer our close handshake. */
const CLOSE_TIMEOUT_MS = 2_000;
/** Buffer cap while the session is being created (~10 s @16 kHz PCM16); oldest audio is dropped beyond this. */
const MAX_PENDING_BYTES = 320_000;

/** Shape of a Gladia live message we consume; parsed defensively. */
export interface GladiaLiveMessage {
  type?: unknown;
  data?: unknown;
}

export interface GladiaParseResult {
  text: string;
  isFinal: boolean;
  language?: Language;
  confidence?: number;
}

/**
 * Map a raw Gladia live WebSocket frame to text/final/language. Pure function.
 *
 * Transcript messages look like:
 * `{ type: "transcript", data: { id, is_final, utterance: { text, language,
 * confidence, start, end, ... } } }` — partials and finals share the same
 * shape, distinguished by `data.is_final`. All other message types
 * (speech_start/speech_end, acks, lifecycle events) carry no transcript.
 * Returns null for anything we do not map to an SttEvent.
 */
export function parseGladiaMessage(
  raw: string,
  atMs: number,
): (GladiaParseResult & { atMs: number }) | null {
  let msg: GladiaLiveMessage;
  try {
    msg = JSON.parse(raw) as GladiaLiveMessage;
  } catch {
    return null;
  }
  if (msg === null || typeof msg !== "object" || msg.type !== "transcript") return null;
  if (msg.data === null || typeof msg.data !== "object") return null;

  const data = msg.data as { is_final?: unknown; utterance?: unknown };
  if (data.utterance === null || typeof data.utterance !== "object") return null;
  const utterance = data.utterance as { text?: unknown; language?: unknown; confidence?: unknown };

  const text = typeof utterance.text === "string" ? utterance.text.trim() : "";
  if (text === "") return null;

  return {
    text,
    isFinal: data.is_final === true,
    language: normalizeLanguage(utterance.language),
    confidence: typeof utterance.confidence === "number" ? utterance.confidence : undefined,
    atMs,
  };
}

/**
 * Build the POST /v2/live request body for a PCM16 mono stream.
 *
 * TODO(verify-live): auto mode sends our three languages as explicit
 * candidates (rather than omitting language_config entirely) so results stay
 * within et/ru/en; verify Gladia auto-detects within a provided candidate
 * list as expected, and that `encoding: "wav/pcm"` remains the correct value
 * for raw PCM16 (per current live quickstart).
 */
export function buildGladiaInitBody(
  opts: SttStreamOptions,
  model: string,
): Record<string, unknown> {
  return {
    model,
    encoding: "wav/pcm",
    sample_rate: opts.sampleRateHz,
    bit_depth: 16,
    channels: 1,
    messages_config: { receive_partial_transcripts: true },
    language_config:
      opts.language === "auto"
        ? { languages: [...LANGUAGES], code_switching: false }
        : { languages: [opts.language], code_switching: false },
  };
}

/** Gladia v2 live streaming STT provider (Solaria). */
export class GladiaSttProvider implements SttProvider {
  readonly name = "gladia";

  private readonly log: Logger;
  private readonly model: string;
  private readonly apiKey: string;

  constructor(config: AppConfig, log: Logger = logger) {
    this.log = log.child({ stage: "stt", provider: this.name });
    this.model = config.gladia.model;
    this.apiKey = config.gladia.apiKey ?? "";
  }

  startStream(opts: SttStreamOptions): SttStream {
    return new GladiaStream(opts, this.model, this.apiKey, this.log);
  }
}

/**
 * Gladia requires a two-step flow (HTTP init → WebSocket connect), so the
 * stream kicks off the init request in its constructor and buffers writes
 * until the WebSocket is open.
 */
class GladiaStream implements SttStream {
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
    private readonly apiKey: string,
    private readonly log: Logger,
  ) {
    void this.initSession();
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
    this.pending.push(pcm);
    this.pendingBytes += pcm.length;
    while (this.pendingBytes > MAX_PENDING_BYTES && this.pending.length > 0) {
      const dropped = this.pending.shift();
      this.pendingBytes -= dropped?.length ?? 0;
      this.log.warn("dropped oldest buffered audio: session still initializing");
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.doClose();
    return this.closePromise;
  }

  /** POST /v2/live → { id, url }; then connect the WebSocket to `url`. */
  private async initSession(): Promise<void> {
    try {
      const res = await fetch(`${GLADIA_API_BASE}/v2/live`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gladia-key": this.apiKey,
        },
        body: JSON.stringify(buildGladiaInitBody(this.opts, this.model)),
      });
      if (!res.ok) {
        this.log.error(
          { status: res.status, body: (await res.text()).slice(0, 500) },
          "gladia live init failed",
        );
        this._closed = true;
        return;
      }
      const json = (await res.json()) as { url?: unknown };
      if (typeof json.url !== "string") {
        this.log.error({ response: json }, "gladia live init returned no websocket url");
        this._closed = true;
        return;
      }
      if (this.closeRequested) {
        this._closed = true;
        return;
      }
      this.connect(json.url);
    } catch (err) {
      this.log.error({ err }, "gladia live init threw");
      this._closed = true;
    }
  }

  private connect(url: string): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.log.error({ err }, "failed to create gladia websocket");
      this._closed = true;
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      for (const chunk of this.pending.splice(0)) this.sendChunk(chunk);
      if (this.closeRequested) void this.close();
    });
    ws.on("message", (data) => this.handleFrame(rawDataToText(data)));
    ws.on("error", (err) => {
      this.log.warn({ err }, "gladia websocket error");
    });
    ws.on("close", () => {
      this._closed = true;
    });
  }

  private sendChunk(pcm: Buffer): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "audio_chunk", data: { chunk: pcm.toString("base64") } }));
    } catch (err) {
      this.log.warn({ err }, "failed to send audio chunk to gladia");
    }
  }

  private handleFrame(text: string): void {
    const parsed = parseGladiaMessage(text, Date.now());
    if (parsed === null) return;
    const event: SttEvent = {
      type: parsed.isFinal ? "final" : "partial",
      text: parsed.text,
      language: parsed.language,
      confidence: parsed.confidence,
      atMs: parsed.atMs,
    };
    this.emitEvent(event);
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
      // Init may still be in flight; it checks closeRequested and bails out.
      this._closed = true;
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      // Ask Gladia to stop recording and finish post-processing; it closes
      // the socket with code 1000 afterwards.
      try {
        ws.send(JSON.stringify({ type: "stop_recording" }));
      } catch (err) {
        this.log.warn({ err }, "failed to send gladia stop_recording");
      }
    }
    await closeWebSocket(ws, CLOSE_TIMEOUT_MS);
    this._closed = true;
  }
}
