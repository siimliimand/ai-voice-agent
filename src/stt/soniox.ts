import WebSocket from "ws";
import type { AppConfig } from "../config/schema.js";
import { logger, type Logger } from "../logging.js";
import { LANGUAGES, type Language } from "../types.js";
import {
  normalizeLanguage,
  type SttEvent,
  type SttLanguage,
  type SttProvider,
  type SttStream,
  type SttStreamOptions,
} from "./types.js";
import { closeWebSocket, rawDataToText } from "./ws-common.js";

/**
 * Soniox realtime STT WebSocket endpoint.
 * Assumption (high confidence, matches soniox-js SDK `SONIOX_WS_URL`).
 */
const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
/** Max time to wait for the peer to answer our close handshake. */
const CLOSE_TIMEOUT_MS = 2_000;
/** Buffer cap while the socket is still connecting (~10 s @16 kHz PCM16); oldest audio is dropped beyond this. */
const MAX_PENDING_BYTES = 320_000;

/** Shape of a Soniox realtime result; parsed defensively. */
export interface SonioxResultMessage {
  tokens?: unknown;
  finished?: unknown;
  error_code?: unknown;
  error_message?: unknown;
}

export interface SonioxParseResult {
  text: string;
  /** True when the segment is settled (`finished`, `<fin>` or `<end>` control token). */
  isFinal: boolean;
  language?: Language;
  confidence?: number;
  /** Present when the payload was a server error instead of a result. */
  error?: string;
}

/**
 * Map a raw Soniox realtime frame to text/final/language. Pure function.
 *
 * Soniox streams token lists: every result contains the tokens of the current
 * segment (so later results replace earlier partials), special control tokens
 * `<end>` (endpoint detected) and `<fin>` (finalized) may appear among them,
 * and `finished: true` marks the end of the whole session. Returns null for
 * malformed/non-result payloads.
 */
export function parseSonioxMessage(
  raw: string,
  atMs: number,
): (SonioxParseResult & { atMs: number }) | null {
  let msg: SonioxResultMessage;
  try {
    msg = JSON.parse(raw) as SonioxResultMessage;
  } catch {
    return null;
  }
  if (msg === null || typeof msg !== "object") return null;

  if (msg.error_code !== undefined || msg.error_message !== undefined) {
    return {
      text: "",
      isFinal: false,
      error: `${String(msg.error_code ?? "error")}: ${String(msg.error_message ?? "unknown error")}`,
      atMs,
    };
  }

  const tokens = Array.isArray(msg.tokens) ? msg.tokens : [];
  const parts: string[] = [];
  let language: Language | undefined;
  let confidenceSum = 0;
  let confidenceCount = 0;
  let hasFin = false;
  let hasEnd = false;

  for (const token of tokens) {
    if (token === null || typeof token !== "object") continue;
    const t = token as { text?: unknown; confidence?: unknown; language?: unknown };
    const text = typeof t.text === "string" ? t.text : "";
    if (text === "<fin>") {
      hasFin = true;
      continue;
    }
    if (text === "<end>") {
      hasEnd = true;
      continue;
    }
    if (text.length > 0) parts.push(text);
    const lang = normalizeLanguage(t.language);
    if (lang !== undefined) language = lang;
    if (typeof t.confidence === "number") {
      confidenceSum += t.confidence;
      confidenceCount += 1;
    }
  }

  const text = parts.join("").trim();
  if (text === "" && !hasFin && !hasEnd && msg.finished !== true) return null;

  return {
    text,
    isFinal: msg.finished === true || hasFin || hasEnd,
    language,
    confidence: confidenceCount > 0 ? confidenceSum / confidenceCount : undefined,
    atMs,
  };
}

/**
 * Build the Soniox session config message (sent as the first JSON frame
 * after the WebSocket opens). Pinned languages use strict hints; auto mode
 * restricts identification to our supported set.
 *
 * TODO(verify-live): confirm `language_hints_strict` semantics against the
 * current API version; the soniox-js SDK sends the same fields.
 */
export function buildSonioxConfig(
  language: SttLanguage,
  sampleRateHz: number,
  model: string,
): Record<string, unknown> {
  const pinned = language !== "auto";
  return {
    model,
    // TODO(verify-live): confirm explicit pcm_s16le + sample_rate is accepted
    // by the current endpoint (SDK default is audio_format "auto").
    audio_format: "pcm_s16le",
    sample_rate: sampleRateHz,
    num_channels: 1,
    language_hints: pinned ? [language] : [...LANGUAGES],
    language_hints_strict: pinned,
    enable_language_identification: !pinned,
    enable_endpoint_detection: true,
  };
}

/** Soniox realtime STT provider. */
export class SonioxSttProvider implements SttProvider {
  readonly name = "soniox";

  private readonly log: Logger;
  private readonly model: string;
  private readonly apiKey: string;

  constructor(config: AppConfig, log: Logger = logger) {
    this.log = log.child({ stage: "stt", provider: this.name });
    this.model = config.soniox.model;
    this.apiKey = config.soniox.apiKey ?? "";
  }

  startStream(opts: SttStreamOptions): SttStream {
    return new SonioxStream(opts, this.model, this.apiKey, this.log);
  }
}

class SonioxStream implements SttStream {
  private readonly listeners = new Set<(e: SttEvent) => void>();
  private readonly pending: Buffer[] = [];
  private pendingBytes = 0;
  private ws: WebSocket | null = null;
  private closePromise: Promise<void> | null = null;
  private closeRequested = false;
  private _closed = false;

  constructor(
    private readonly opts: SttStreamOptions,
    model: string,
    apiKey: string,
    private readonly log: Logger,
  ) {
    this.connect(model, apiKey);
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
      this.sendAudio(pcm);
      return;
    }
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

  private connect(model: string, apiKey: string): void {
    let ws: WebSocket;
    try {
      // Auth handshake: the Soniox endpoint takes the API key as the second
      // WebSocket subprotocol (`['soniox-api-key', <key>]`), matching the
      // soniox-js SDK's default 'protocol-list' transport.
      ws = new WebSocket(SONIOX_WS_URL, ["soniox-api-key", apiKey]);
    } catch (err) {
      this.log.error({ err }, "failed to create soniox websocket");
      this._closed = true;
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.sendJson(buildSonioxConfig(this.opts.language, this.opts.sampleRateHz, model));
      for (const chunk of this.pending.splice(0)) this.sendAudio(chunk);
      if (this.closeRequested) void this.close();
    });
    ws.on("message", (data) => this.handleFrame(rawDataToText(data)));
    ws.on("error", (err) => {
      this.log.warn({ err }, "soniox websocket error");
    });
    ws.on("close", () => {
      this._closed = true;
    });
  }

  private sendJson(payload: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      this.log.warn({ err }, "failed to send soniox control message");
    }
  }

  /** Soniox takes raw audio as binary WebSocket frames. */
  private sendAudio(pcm: Buffer): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(pcm);
    } catch (err) {
      this.log.warn({ err }, "failed to send audio chunk to soniox");
    }
  }

  private handleFrame(text: string): void {
    const parsed = parseSonioxMessage(text, Date.now());
    if (parsed === null) return;
    if (parsed.error !== undefined) {
      this.log.warn({ error: parsed.error }, "soniox error event");
      return;
    }
    if (parsed.text === "" && !parsed.isFinal) return;
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
      this._closed = true;
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      // Settle the in-flight segment, then signal end-of-audio (empty text
      // frame), matching the soniox-js SDK finalize/finish sequence.
      this.sendJson({ type: "finalize" });
      try {
        ws.send("");
      } catch (err) {
        this.log.warn({ err }, "failed to send soniox end-of-audio signal");
      }
    }
    await closeWebSocket(ws, CLOSE_TIMEOUT_MS);
    this._closed = true;
  }
}
