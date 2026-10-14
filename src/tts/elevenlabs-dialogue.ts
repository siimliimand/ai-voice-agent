import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import WebSocket from "ws";
import type { AppConfig } from "../config/schema.js";
import { logger, type Logger } from "../logging.js";
import { closeWebSocket, rawDataToText } from "../stt/ws-common.js";
import type { TtsProvider, TtsRequest, TtsStream } from "./types.js";

/** ElevenLabs public API WebSocket base. */
const ELEVENLABS_WS_BASE = "wss://api.elevenlabs.io";
/** Max time to wait for the peer to answer our close handshake. */
const CLOSE_TIMEOUT_MS = 2_000;
/**
 * The dialogue endpoint drops the session after 20 s of server-side
 * inactivity; a keep-alive well inside that window keeps an idle socket
 * alive between sentences.
 */
const KEEP_ALIVE_INTERVAL_MS = 15_000;
/**
 * Only send the keep-alive when the server has been quiet for this long —
 * while audio is flowing the generation itself resets the inactivity timer,
 * so pinging mid-stream would be pure noise.
 */
const KEEP_ALIVE_IDLE_MS = 10_000;
/** Stability is the only voice_setting the v3/v4 dialogue models read. */
const VOICE_STABILITY = 0.5;
/** PCM output formats the dialogue endpoint accepts via output_format. */
const PCM_RATES: ReadonlySet<number> = new Set([8_000, 16_000, 22_050, 24_000, 44_100, 48_000]);

/**
 * Models the text-to-dialogue endpoint requires: anything in the Eleven v3 /
 * v4 families. The text-to-speech stream-input endpoint rejects exactly these
 * at handshake (HTTP 400 unsupported_model), so the same predicate splits the
 * two transports in both directions.
 */
export function isDialogueFamilyModel(model: string): boolean {
  return model.startsWith("eleven_v3") || model.startsWith("eleven_v4");
}

/** Forced-transport setting (config.tts.api). */
export type ElevenLabsTtsApiSetting = "auto" | "tts" | "dialogue";

/**
 * Resolve which transport a model must use. "auto" picks by model family;
 * an explicitly forced transport that the model family cannot use throws a
 * clear Error (surfaced like every other bad-config problem: the provider
 * factory rejects it and the call runs degraded with a warning that names
 * the exact mismatch).
 */
export function resolveTtsTransport(
  api: ElevenLabsTtsApiSetting,
  model: string,
): "tts" | "dialogue" {
  const dialogue = isDialogueFamilyModel(model);
  if (api === "auto") return dialogue ? "dialogue" : "tts";
  if (api === "dialogue" && !dialogue) {
    throw new Error(
      `tts.api "dialogue" requires an Eleven v3/v4 model (eleven_v3* or eleven_v4*), ` +
        `but tts.model is "${model}" — set tts.api to "auto" or use a v3/v4 model.`,
    );
  }
  if (api === "tts" && dialogue) {
    throw new Error(
      `ElevenLabs model "${model}" only streams over the text-to-dialogue API ` +
        `(the text-to-speech stream-input endpoint rejects it) — set tts.api to "auto" or "dialogue".`,
    );
  }
  return api;
}

/** Shape of the dialogue server messages we consume; parsed defensively. */
export interface DialogueServerMessage {
  audio?: unknown;
  is_final_audio_for_turn?: unknown;
  is_final?: unknown;
  error?: unknown;
  status?: unknown;
  message?: unknown;
}

/**
 * Return a human-readable error message when the frame carries an error,
 * else null. Handles both string errors and {status, message} objects; kept
 * separate from frame handling so error mapping stays testable.
 */
export function dialogueErrorText(raw: string): string | null {
  let msg: DialogueServerMessage;
  try {
    msg = JSON.parse(raw) as DialogueServerMessage;
  } catch {
    return null;
  }
  if (msg === null || typeof msg !== "object") return null;

  const err = msg.error;
  if (typeof err === "string" && err.length > 0) return err;
  if (err !== null && typeof err === "object") {
    const text = statusMessageText(err);
    if (text) return text;
  }
  // Frames that carry audio or completion flags are never errors, even if a
  // message-shaped field is present.
  if (msg.audio !== undefined || msg.is_final === true || msg.is_final_audio_for_turn === true) {
    return null;
  }
  // Remaining frames are errors only when they carry a status-style payload
  // (e.g. {status, message}); a bare informational field is ignored.
  if (msg.status !== undefined) return statusMessageText(msg) ?? null;
  return null;
}

/** Render a {status, message}-shaped value as "status: message". */
function statusMessageText(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const shape = value as { status?: unknown; message?: unknown };
  // status is numeric in most error frames but a string code in handshake
  // details (e.g. "unsupported_model").
  const status =
    typeof shape.status === "number" || typeof shape.status === "string"
      ? String(shape.status)
      : undefined;
  const message =
    typeof shape.message === "string" && shape.message.length > 0 ? shape.message : undefined;
  if (status && message) return `${status}: ${message}`;
  return message ?? status ?? null;
}

/**
 * Build the error message for a failed WS handshake (non-101 response).
 * Prefers the JSON detail from the response body (ElevenLabs answers e.g.
 * {"detail":{"status":"unsupported_model","message":"…"}}), falling back to
 * the HTTP status line.
 */
export function handshakeErrorText(status: number, statusMessage: string, body: string): string {
  let detail: string | null = null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object") {
      const obj = parsed as { detail?: unknown; message?: unknown; error?: unknown };
      detail =
        statusMessageText(obj.detail) ??
        (typeof obj.message === "string" && obj.message ? obj.message : null) ??
        (typeof obj.error === "string" && obj.error ? obj.error : null);
    }
  } catch {
    // Non-JSON body: fall through to the status line.
  }
  const line = `HTTP ${status} ${statusMessage}`.trim();
  return detail
    ? `elevenlabs dialogue tts handshake failed: ${line}: ${detail}`
    : `elevenlabs dialogue tts handshake failed: ${line}`;
}

export interface ElevenLabsDialogueTtsStreamOptions {
  apiKey: string;
  defaultModel: string;
  outputSampleRateHz: number;
  log: Logger;
}

/**
 * Text-to-Dialogue stream-input adapter (the only websocket transport the
 * Eleven v3 / v4 models support).
 *
 * Protocol (verified live 2026-10-14 against api.elevenlabs.io):
 * - open `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input
 *   ?model_id=...&output_format=pcm_...&language_code=...`
 * - first client message registers the voices:
 *   `{ voices: ["<voice_id>"], voice_settings: { stability } }` (v4 reads
 *   only stability)
 * - every text chunk is one turn: `{ inputs: [{ text, voice_id }], flush:
 *   true }` — flush-per-sentence is the documented latency win
 * - server frames are JSON snake_case: `{ audio: "<base64 pcm>" }` chunks,
 *   `{ is_final_audio_for_turn: true }` per flushed turn, `{ is_final: true }`
 *   when the generation is complete, `{ error: ... }` on failure
 * - `{ keep_alive: true }` resets a 20 s server inactivity timer
 * - there is no cancel message: barge-in simply closes the socket (the
 *   ~100-120 ms handshake makes socket-per-turn viable)
 */
export class ElevenLabsDialogueTtsStream implements TtsStream {
  readonly events = new EventEmitter();

  private readonly ws: WebSocket;
  private readonly created = Date.now();
  private readonly voiceId: string;
  /** Sentences queued while the socket is still connecting. */
  private readonly pending: string[] = [];
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private lastServerActivityAt = Date.now();
  /** True once the open handler ran (voices registered). */
  private registered = false;
  /** True once push() queued/sent at least one non-empty text. */
  private hasText = false;
  private ended = false;
  /** Set on done()/close()/error: no further events are emitted afterwards. */
  private finished = false;
  private firstByteSent = false;

  constructor(req: TtsRequest, opts: ElevenLabsDialogueTtsStreamOptions) {
    this.voiceId = req.voiceId;
    const modelId = req.modelId ?? opts.defaultModel;
    const rate = PCM_RATES.has(opts.outputSampleRateHz) ? opts.outputSampleRateHz : 16_000;
    const url = new URL(`${ELEVENLABS_WS_BASE}/v1/text-to-dialogue/stream-input`);
    url.searchParams.set("model_id", modelId);
    url.searchParams.set("output_format", `pcm_${rate}`);
    url.searchParams.set("language_code", req.language);

    this.ws = new WebSocket(url.toString(), { headers: { "xi-api-key": opts.apiKey } });
    const ws = this.ws;

    ws.on("open", () => {
      // Voices registration must be the first message on the socket.
      this.sendJson({
        voices: [this.voiceId],
        voice_settings: { stability: VOICE_STABILITY },
      });
      this.registered = true;
      this.startKeepAlive();
      for (const text of this.pending.splice(0)) this.sendInputs(text);
      // end() before any text (or before the socket opened with nothing to
      // say): there is no turn in flight, so settle immediately instead of
      // waiting for completion flags that will never arrive.
      if (this.ended && !this.hasText) this.finish("done");
    });
    ws.on("message", (data) => {
      this.lastServerActivityAt = Date.now();
      this.handleFrame(rawDataToText(data));
    });
    ws.on("unexpected-response", (req: ClientRequest, res: IncomingMessage) => {
      this.handleUnexpectedResponse(req, res, opts.log);
    });
    ws.on("error", (err) => {
      opts.log.warn({ err }, "elevenlabs dialogue tts websocket error");
      this.finish("error", err instanceof Error ? err : new Error(String(err)));
    });
    ws.on("close", () => {
      // Server closed without a completion flag (or after done); settle quietly.
      this.finishSilently();
    });
  }

  push(text: string): void {
    if (this.finished || this.ended || text.length === 0) return;
    this.hasText = true;
    if (this.registered && this.ws.readyState === WebSocket.OPEN) {
      this.sendInputs(text);
    } else {
      this.pending.push(text);
    }
  }

  /**
   * End of text. Every sentence was already flushed on push (flush-per-turn
   * is the point of this transport), so there is no EOS message to send:
   * the server's completion flags close the stream out. Verified cleanly:
   * a flushed turn is answered by audio chunks + is_final_audio_for_turn
   * (treated as done once ended) and finally is_final.
   */
  end(): void {
    if (this.finished || this.ended) return;
    this.ended = true;
    if (this.registered && this.ws.readyState === WebSocket.OPEN && !this.hasText) {
      // Open, registered, and nothing was ever pushed: settle immediately.
      this.finish("done");
    }
    // All other cases settle via handleFrame (completion flags) or the
    // socket's close event.
  }

  /** Abort immediately (barge-in / hangup). No protocol goodbye exists. */
  close(): void {
    this.stopKeepAlive();
    this.finished = true;
    try {
      this.ws.terminate(); // abort: do not wait for the close handshake
    } catch {
      // Already dead.
    }
  }

  /** One dialogue turn: the sentence, flushed so generation starts now. */
  private sendInputs(text: string): void {
    this.sendJson({
      inputs: [{ text, voice_id: this.voiceId }],
      flush: true,
    });
  }

  private startKeepAlive(): void {
    if (this.finished) return; // torn down before the socket ever opened
    this.stopKeepAlive();
    this.keepAlive = setInterval(() => {
      if (this.ws.readyState !== WebSocket.OPEN) return;
      // Mid-generation the server hears from us constantly; only an idle
      // socket needs the inactivity-timer reset.
      if (Date.now() - this.lastServerActivityAt < KEEP_ALIVE_IDLE_MS) return;
      this.sendJson({ keep_alive: true });
    }, KEEP_ALIVE_INTERVAL_MS);
    this.keepAlive.unref?.(); // never hold the process open for a keep-alive
  }

  private stopKeepAlive(): void {
    if (this.keepAlive !== null) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
  }

  private sendJson(payload: Record<string, unknown>): void {
    // The finished guard also covers the teardown race where the open event
    // lands after close(): nothing is ever written for a cancelled stream.
    if (this.finished || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      this.finish("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  private handleFrame(text: string): void {
    if (this.finished) return; // no events after done/close/error
    let msg: DialogueServerMessage;
    try {
      msg = JSON.parse(text) as DialogueServerMessage;
    } catch {
      return; // ignore anything that is not JSON
    }
    if (msg === null || typeof msg !== "object") return;

    const errorText = dialogueErrorText(text);
    if (errorText !== null) {
      this.finish("error", new Error(`elevenlabs dialogue tts error: ${errorText}`));
      return;
    }
    if (typeof msg.audio === "string" && msg.audio.length > 0) {
      const pcm = Buffer.from(msg.audio, "base64");
      if (!this.firstByteSent) {
        this.firstByteSent = true;
        this.events.emit("firstByte", Date.now() - this.created);
      }
      this.events.emit("audio", pcm);
      return;
    }
    if (msg.is_final === true) {
      this.finish("done"); // generation complete: fully drained
      return;
    }
    // Per-turn completion: only an ended stream can treat it as drained —
    // otherwise more turns may still be pushed onto this socket.
    if (msg.is_final_audio_for_turn === true && this.ended) this.finish("done");
  }

  /**
   * Non-101 handshake answer (e.g. HTTP 400 unsupported_model when a v2.x
   * model is pointed at the dialogue endpoint). Read the (small) body for
   * the server's error detail, then fail the stream with a clear message.
   */
  private handleUnexpectedResponse(_req: ClientRequest, res: IncomingMessage, log: Logger): void {
    const status = res.statusCode ?? 0;
    const statusMessage = res.statusMessage ?? "";
    const chunks: Buffer[] = [];
    const settle = (body: string): void => {
      log.warn({ status }, "elevenlabs dialogue tts handshake rejected");
      this.finish("error", new Error(handshakeErrorText(status, statusMessage, body)));
    };
    res.on("data", (chunk: Buffer) => {
      if (chunks.length < 8) chunks.push(chunk);
    });
    res.once("end", () => settle(Buffer.concat(chunks).toString("utf8")));
    res.once("error", () => settle(""));
  }

  private finish(event: "done" | "error", err?: Error): void {
    if (this.finished) return;
    this.finished = true;
    this.stopKeepAlive();
    void closeWebSocket(this.ws, CLOSE_TIMEOUT_MS);
    if (event === "error" && err !== undefined) this.events.emit("error", err);
    else this.events.emit("done");
  }

  /** Socket went away without an explicit outcome; settle without events. */
  private finishSilently(): void {
    if (this.finished) return;
    this.finished = true;
    this.stopKeepAlive();
  }
}

/** ElevenLabs Eleven v3 / v4 (text-to-dialogue) streaming TTS provider. */
export class ElevenLabsDialogueTtsProvider implements TtsProvider {
  readonly name = "elevenlabs";

  private readonly log: Logger;
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly outputSampleRateHz: number;

  constructor(config: AppConfig, log: Logger = logger) {
    this.log = log.child({ stage: "tts", provider: this.name, transport: "dialogue" });
    this.apiKey = config.elevenlabs.apiKey ?? "";
    this.defaultModel = config.tts.model;
    this.outputSampleRateHz = config.tts.outputSampleRateHz;
  }

  stream(req: TtsRequest): TtsStream {
    // Guard the per-request override too: config-level mismatches are
    // rejected by the provider factory, but a stream may pin any model.
    const modelId = req.modelId ?? this.defaultModel;
    if (!isDialogueFamilyModel(modelId)) {
      throw new Error(
        `ElevenLabs dialogue TTS requires an Eleven v3/v4 model, but the requested ` +
          `model is "${modelId}" — set tts.api to "auto" or use a model starting ` +
          `with eleven_v3/eleven_v4.`,
      );
    }
    return new ElevenLabsDialogueTtsStream(req, {
      apiKey: this.apiKey,
      defaultModel: this.defaultModel,
      outputSampleRateHz: this.outputSampleRateHz,
      log: this.log,
    });
  }
}
