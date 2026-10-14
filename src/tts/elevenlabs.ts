import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { AppConfig } from "../config/schema.js";
import { logger, type Logger } from "../logging.js";
import { closeWebSocket, rawDataToText } from "../stt/ws-common.js";
import { isDialogueFamilyModel } from "./elevenlabs-dialogue.js";
import type { TtsProvider, TtsRequest, TtsStream } from "./types.js";

/** ElevenLabs public API WebSocket base. */
const ELEVENLABS_WS_BASE = "wss://api.elevenlabs.io";
/** Max time to wait for the peer to answer our close handshake. */
const CLOSE_TIMEOUT_MS = 2_000;
/**
 * Lower chunk_length_schedule than the default [120, 160, 250, 290] so audio
 * generation starts on shorter input (each value must be 50–500). We push
 * sentence-sized chunks already, so early triggers keep first-byte latency
 * low without cutting into a single word.
 */
const CHUNK_LENGTH_SCHEDULE = [50, 100, 200, 300];
/** PCM output formats the stream-input endpoint accepts via output_format. */
const PCM_RATES: ReadonlySet<number> = new Set([8_000, 16_000, 22_050, 24_000, 44_100, 48_000]);

/** Shape of the stream-input server messages we consume; parsed defensively. */
interface StreamInputMessage {
  audio?: unknown;
  isFinal?: unknown;
}

/** ElevenLabs Eleven v3 (and friends) streaming TTS provider. */
export class ElevenLabsTtsProvider implements TtsProvider {
  readonly name = "elevenlabs";

  private readonly log: Logger;
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly outputSampleRateHz: number;

  constructor(config: AppConfig, log: Logger = logger) {
    this.log = log.child({ stage: "tts", provider: this.name });
    this.apiKey = config.elevenlabs.apiKey ?? "";
    this.defaultModel = config.tts.model;
    this.outputSampleRateHz = config.tts.outputSampleRateHz;
  }

  stream(req: TtsRequest): TtsStream {
    // The stream-input endpoint rejects Eleven v3/v4 models at handshake
    // (HTTP 400 unsupported_model, by official design) — they only stream
    // over the text-to-dialogue transport (see elevenlabs-dialogue.ts).
    const modelId = req.modelId ?? this.defaultModel;
    if (isDialogueFamilyModel(modelId)) {
      throw new Error(
        `ElevenLabs model "${modelId}" only streams over the text-to-dialogue API ` +
          `(the text-to-speech stream-input endpoint rejects it) — set tts.api to "auto" or "dialogue".`,
      );
    }
    return new ElevenLabsTtsStream(req, {
      apiKey: this.apiKey,
      defaultModel: this.defaultModel,
      outputSampleRateHz: this.outputSampleRateHz,
      log: this.log,
    });
  }
}

export interface ElevenLabsTtsStreamOptions {
  apiKey: string;
  defaultModel: string;
  outputSampleRateHz: number;
  log: Logger;
}

/**
 * Stream-input WebSocket adapter.
 *
 * Protocol (per ElevenLabs docs):
 * - open `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input
 *   ?model_id=...&output_format=pcm_16000`
 * - first client message is the init: `{ text: " ", generation_config }`
 * - text chunks are `{ text: "... " }` (should end with a single space)
 * - end of stream is the close signal `{ text: "" }`
 * - server sends `{ audio: "<base64>" }` chunks, then `{ isFinal: true }`
 */
export class ElevenLabsTtsStream implements TtsStream {
  readonly events = new EventEmitter();

  private readonly ws: WebSocket;
  private readonly created = Date.now();
  private readonly textQueue: string[] = [];
  private helloSent = false;
  private ended = false;
  /** Set on done()/close()/error: no further events are emitted afterwards. */
  private finished = false;
  private firstByteSent = false;

  constructor(req: TtsRequest, opts: ElevenLabsTtsStreamOptions) {
    const modelId = req.modelId ?? opts.defaultModel;
    const rate = PCM_RATES.has(opts.outputSampleRateHz) ? opts.outputSampleRateHz : 16_000;
    const url = new URL(
      `${ELEVENLABS_WS_BASE}/v1/text-to-speech/${encodeURIComponent(req.voiceId)}/stream-input`,
    );
    url.searchParams.set("model_id", modelId);
    url.searchParams.set("output_format", `pcm_${rate}`);
    url.searchParams.set("enable_logging", "false");

    this.ws = new WebSocket(url.toString(), { headers: { "xi-api-key": opts.apiKey } });
    const ws = this.ws;

    ws.on("open", () => {
      // InitializeConnection: text must be exactly one blank space.
      this.sendJson({
        text: " ",
        generation_config: { chunk_length_schedule: CHUNK_LENGTH_SCHEDULE },
      });
      this.helloSent = true;
      for (const text of this.textQueue.splice(0)) this.sendText(text);
      if (this.ended) this.sendJson({ text: "" }); // CloseConnection / EOS
    });
    ws.on("message", (data) => this.handleFrame(rawDataToText(data)));
    ws.on("error", (err) => {
      opts.log.warn({ err }, "elevenlabs tts websocket error");
      this.finish("error", err instanceof Error ? err : new Error(String(err)));
    });
    ws.on("close", () => {
      // Server closed without isFinal (or after done); settle quietly.
      this.finishSilently();
    });
  }

  push(text: string): void {
    if (this.finished || this.ended || text.length === 0) return;
    if (this.helloSent && this.ws.readyState === WebSocket.OPEN) {
      this.sendText(text);
    } else {
      this.textQueue.push(text);
    }
  }

  end(): void {
    if (this.finished || this.ended) return;
    this.ended = true;
    if (this.helloSent && this.ws.readyState === WebSocket.OPEN) {
      this.sendJson({ text: "" }); // CloseConnection / EOS: drains, then isFinal
    }
  }

  close(): void {
    this.finished = true;
    try {
      this.ws.terminate(); // abort: do not wait for the close handshake
    } catch {
      // Already dead.
    }
  }

  private sendText(text: string): void {
    // Docs: text chunks should always end with a single space.
    const payload = text.endsWith(" ") ? text : `${text} `;
    this.sendJson({ text: payload });
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      this.finish("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  private handleFrame(text: string): void {
    let msg: StreamInputMessage;
    try {
      msg = JSON.parse(text) as StreamInputMessage;
    } catch {
      return; // ignore anything that is not JSON
    }
    if (msg === null || typeof msg !== "object") return;

    if (typeof msg.audio === "string" && msg.audio.length > 0) {
      const pcm = Buffer.from(msg.audio, "base64");
      if (!this.firstByteSent) {
        this.firstByteSent = true;
        this.events.emit("firstByte", Date.now() - this.created);
      }
      this.events.emit("audio", pcm);
      return;
    }
    if (msg.isFinal === true) {
      this.finish("done");
    }
  }

  private finish(event: "done" | "error", err?: Error): void {
    if (this.finished) return;
    this.finished = true;
    void closeWebSocket(this.ws, CLOSE_TIMEOUT_MS);
    if (event === "error" && err !== undefined) this.events.emit("error", err);
    else this.events.emit("done");
  }

  /** Socket went away without an explicit outcome; settle without events. */
  private finishSilently(): void {
    if (this.finished) return;
    this.finished = true;
  }
}
