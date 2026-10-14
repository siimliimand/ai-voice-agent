/**
 * ElevenLabsDialogueTtsStream (text-to-dialogue transport for the Eleven
 * v3/v4 models): wire protocol shapes, event parity with the stream-input
 * adapter, keep-alive scheduling, teardown safety, and error mapping —
 * against a mocked `ws` module (no network).
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dialogueErrorText,
  ElevenLabsDialogueTtsProvider,
  ElevenLabsDialogueTtsStream,
  handshakeErrorText,
  isDialogueFamilyModel,
  resolveTtsTransport,
} from "../../src/tts/elevenlabs-dialogue.js";
import { ElevenLabsTtsProvider } from "../../src/tts/elevenlabs.js";
import { logger } from "../../src/logging.js";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import type { TtsRequest } from "../../src/tts/types.js";

const { MockWebSocket } = vi.hoisted(() => {
  /** Minimal stand-in for `ws.WebSocket`: records sends, manual events. */
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];

    url: string;
    options: { headers?: Record<string, string> } | undefined;
    readyState = MockWebSocket.CONNECTING;
    sent: string[] = [];
    terminated = false;

    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(url: string, options?: { headers?: Record<string, string> }) {
      this.url = url;
      this.options = options;
      MockWebSocket.instances.push(this);
    }

    on(event: string, fn: (...args: unknown[]) => void): void {
      const list = this.listeners.get(event) ?? [];
      list.push(fn);
      this.listeners.set(event, list);
    }

    once(event: string, fn: (...args: unknown[]) => void): void {
      const wrapped = (...args: unknown[]): void => {
        this.removeListener(event, wrapped);
        fn(...args);
      };
      this.on(event, wrapped);
    }

    removeListener(event: string, fn: (...args: unknown[]) => void): void {
      const list = this.listeners.get(event);
      if (!list) return;
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    }

    emit(event: string, ...args: unknown[]): void {
      for (const fn of [...(this.listeners.get(event) ?? [])]) fn(...args);
    }

    send(data: string): void {
      this.sent.push(data);
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close");
    }

    terminate(): void {
      this.terminated = true;
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close");
    }

    /** Test-side: handshake completed. */
    open(): void {
      this.readyState = MockWebSocket.OPEN;
      this.emit("open");
    }

    /** Test-side: one JSON server frame. */
    serverMessage(text: string): void {
      this.emit("message", Buffer.from(text, "utf8"));
    }

    /** Test-side: transport-level failure. */
    serverError(err: Error): void {
      this.emit("error", err);
    }
  }
  return { MockWebSocket };
});

vi.mock("ws", () => ({ default: MockWebSocket }));

const OPTIONS = {
  apiKey: "key-123",
  defaultModel: "eleven_v4_turbo",
  outputSampleRateHz: 16_000,
  log: logger.child({ stage: "tts", test: true }),
};

const REQUEST: TtsRequest = { language: "et", voiceId: "voice-et-1" };

/** Instance type of the hoisted mock class (its own name is value-only). */
type MockSocket = InstanceType<typeof MockWebSocket>;

function configWith(tts: Record<string, unknown>): AppConfig {
  return configSchema.parse({ tts, elevenlabs: { apiKey: "key-123" } });
}

function lastSocket(): MockSocket {
  const ws = MockWebSocket.instances.at(-1);
  if (!ws) throw new Error("no socket was created");
  return ws;
}

function sentJson(ws: MockSocket): Array<Record<string, unknown>> {
  return ws.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

/** Collect the stream's events in order: ["firstByte", "audio", "done", …]. */
function track(stream: ElevenLabsDialogueTtsStream): {
  order: string[];
  audio: Buffer[];
  errors: Error[];
} {
  const order: string[] = [];
  const audio: Buffer[] = [];
  const errors: Error[] = [];
  stream.events.on("firstByte", () => order.push("firstByte"));
  stream.events.on("audio", (pcm: Buffer) => {
    order.push("audio");
    audio.push(pcm);
  });
  stream.events.on("done", () => order.push("done"));
  stream.events.on("error", (err: Error) => {
    order.push("error");
    errors.push(err);
  });
  return { order, audio, errors };
}

beforeEach(() => {
  MockWebSocket.instances.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ElevenLabsDialogueTtsStream: connection", () => {
  it("opens the text-to-dialogue endpoint with model, format, and language", () => {
    new ElevenLabsDialogueTtsStream(REQUEST, OPTIONS);
    const ws = lastSocket();
    const url = new URL(ws.url);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(
      "wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input",
    );
    expect(url.searchParams.get("model_id")).toBe("eleven_v4_turbo");
    expect(url.searchParams.get("output_format")).toBe("pcm_16000");
    expect(url.searchParams.get("language_code")).toBe("et");
    expect(ws.options?.headers?.["xi-api-key"]).toBe("key-123");
  });

  it("falls back to 16 kHz for unsupported output rates", () => {
    new ElevenLabsDialogueTtsStream(REQUEST, { ...OPTIONS, outputSampleRateHz: 44_500 });
    expect(new URL(lastSocket().url).searchParams.get("output_format")).toBe("pcm_16000");
  });

  it("registers the voices first, then flushes queued sentences in order", () => {
    const stream = new ElevenLabsDialogueTtsStream(REQUEST, OPTIONS);
    stream.push("Tere hommikust.");
    stream.push("Kuidas ma saan aidata?");
    const ws = lastSocket();
    expect(ws.sent).toEqual([]); // nothing before the handshake

    ws.open();
    expect(sentJson(ws)).toEqual([
      { voices: ["voice-et-1"], voice_settings: { stability: 0.5 } },
      { inputs: [{ text: "Tere hommikust.", voice_id: "voice-et-1" }], flush: true },
      { inputs: [{ text: "Kuidas ma saan aidata?", voice_id: "voice-et-1" }], flush: true },
    ]);
  });

  it("sends each push as a flushed turn once open (exact payload shape)", () => {
    const stream = new ElevenLabsDialogueTtsStream(REQUEST, OPTIONS);
    const ws = lastSocket();
    ws.open();
    stream.push("Tere.");
    expect(sentJson(ws)[1]).toEqual({
      inputs: [{ text: "Tere.", voice_id: "voice-et-1" }],
      flush: true,
    });
  });
});

describe("ElevenLabsDialogueTtsStream: audio events", () => {
  it("decodes base64 audio and tracks firstByte once (parity with stream-input)", () => {
    const stream = new ElevenLabsDialogueTtsStream(REQUEST, OPTIONS);
    const ws = lastSocket();
    const tracked = track(stream);
    ws.open();
    stream.push("Tere.");

    const pcm = Buffer.from([0x01, 0x00, 0xff, 0x7f]);
    ws.serverMessage(JSON.stringify({ audio: pcm.toString("base64") }));
    ws.serverMessage(JSON.stringify({ audio: pcm.toString("base64") }));

    expect(tracked.order).toEqual(["firstByte", "audio", "audio"]);
    expect(tracked.audio).toEqual([pcm, pcm]);
    expect(tracked.order[0]).toBe("firstByte"); // precedes every audio chunk
    expect(typeof stream.events.listenerCount("audio")).toBe("number");
  });

  it("finishes with done on is_final and emits nothing afterwards", () => {
    const stream = new ElevenLabsDialogueTtsStream(REQUEST, OPTIONS);
    const ws = lastSocket();
    const tracked = track(stream);
    ws.open();
    stream.push("Tere.");
    ws.serverMessage(JSON.stringify({ audio: Buffer.from([1]).toString("base64") }));
    ws.serverMessage(JSON.stringify({ is_final: true }));
    ws.serverMessage(JSON.stringify({ audio: Buffer.from([2]).toString("base64") }));

    expect(tracked.order).toEqual(["firstByte", "audio", "done"]);
  });

  it("treats is_final_audio_for_turn as drained only for an ended stream", () => {
    const stream = new ElevenLabsDialogueTtsStream(REQUEST, OPTIONS);
    const ws = lastSocket();
    const tracked = track(stream);
    ws.open();
    stream.push("Tere.");
    ws.serverMessage(JSON.stringify({ is_final_audio_for_turn: true }));
    expect(tracked.order).toEqual([]); // more turns may still be pushed

    stream.end();
    ws.serverMessage(JSON.stringify({ is_final_audio_for_turn: true }));
    expect(tracked.order).toEqual(["done"]);
  });

  it("settles immediately when end() arrives before any text", () => {
    const stream = new ElevenLabsDialogueTtsStream(REQUEST, OPTIONS);
    const ws = lastSocket();
    const tracked = track(stream);
    stream.end();
    ws.open();
    expect(tracked.order).toEqual(["done"]);
    expect(ws.sent).toHaveLength(1); // voices registration only
  });

  it("ignores empty pushes and pushes after end()", () => {
    const stream = new ElevenLabsDialogueTtsStream(REQUEST, OPTIONS);
    const ws = lastSocket();
    ws.open();
    stream.push("");
    stream.push("Tere.");
    stream.end();
    stream.push("hiljem");
    expect(ws.sent).toHaveLength(2); // voices + one turn
  });
});

describe("ElevenLabsDialogueTtsStream: keep-alive", () => {
  it("sends keep_alive every 15 s while idle and stops on close", () => {
    vi.useFakeTimers();
    const stream = new ElevenLabsDialogueTtsStream(REQUEST, OPTIONS);
    const ws = lastSocket();
    ws.open();

    vi.advanceTimersByTime(15_000);
    expect(sentJson(ws).at(-1)).toEqual({ keep_alive: true });

    vi.advanceTimersByTime(15_000);
    expect(sentJson(ws).filter((m) => m.keep_alive === true)).toHaveLength(2);

    stream.close();
    vi.advanceTimersByTime(60_000);
    expect(sentJson(ws).filter((m) => m.keep_alive === true)).toHaveLength(2); // cleared
  });

  it("skips the ping while the server is actively sending audio", () => {
    vi.useFakeTimers();
    const _stream = new ElevenLabsDialogueTtsStream(REQUEST, OPTIONS);
    const ws = lastSocket();
    ws.open();

    vi.advanceTimersByTime(15_000); // t=15s: idle → ping
    expect(sentJson(ws).filter((m) => m.keep_alive === true)).toHaveLength(1);

    vi.advanceTimersByTime(10_000); // t=25s: audio arrives
    ws.serverMessage(JSON.stringify({ audio: Buffer.from([1]).toString("base64") }));

    vi.advanceTimersByTime(5_000); // t=30s tick: 5 s since activity → skipped
    expect(sentJson(ws).filter((m) => m.keep_alive === true)).toHaveLength(1);

    vi.advanceTimersByTime(15_000); // t=45s: 20 s since activity → ping
    expect(sentJson(ws).filter((m) => m.keep_alive === true)).toHaveLength(2);
  });
});

describe("ElevenLabsDialogueTtsStream: teardown safety", () => {
  it("close() before the socket opened never throws or emits", () => {
    const stream = new ElevenLabsDialogueTtsStream(REQUEST, OPTIONS);
    const ws = lastSocket();
    const tracked = track(stream);
    stream.push("queued text");
    expect(() => stream.close()).not.toThrow();
    expect(ws.terminated).toBe(true);
    stream.end();
    stream.push("after close");
    expect(tracked.order).toEqual([]);
    expect(ws.sent).toEqual([]);
  });

  it("stays safe when the socket still opens after a pre-open close (teardown race)", () => {
    const stream = new ElevenLabsDialogueTtsStream(REQUEST, OPTIONS);
    const ws = lastSocket();
    const tracked = track(stream);
    stream.push("queued text");
    stream.close();
    // A real socket will not fire open() after terminate(), but the guards
    // must make this harmless even if the event raced through.
    expect(() => ws.open()).not.toThrow();
    expect(tracked.order).toEqual([]);
    expect(ws.sent).toEqual([]); // nothing sent on a closed stream
  });

  it("close() does not emit done/error even when the socket reports close", () => {
    const stream = new ElevenLabsDialogueTtsStream(REQUEST, OPTIONS);
    const ws = lastSocket();
    const tracked = track(stream);
    ws.open();
    stream.push("Tere.");
    stream.close();
    ws.close(); // the terminate's close event
    expect(tracked.order).toEqual([]);
  });
});

describe("ElevenLabsDialogueTtsStream: error mapping", () => {
  it("maps a string server error frame to an error event", () => {
    const stream = new ElevenLabsDialogueTtsStream(REQUEST, OPTIONS);
    const ws = lastSocket();
    const tracked = track(stream);
    ws.open();
    stream.push("Tere.");
    ws.serverMessage(JSON.stringify({ error: "quota exceeded" }));
    expect(tracked.errors).toHaveLength(1);
    expect(tracked.errors[0]?.message).toContain("quota exceeded");
    expect(tracked.order).toEqual(["error"]); // no done after an error
  });

  it("maps an object server error frame to status: message", () => {
    const stream = new ElevenLabsDialogueTtsStream(REQUEST, OPTIONS);
    const ws = lastSocket();
    const tracked = track(stream);
    ws.open();
    ws.serverMessage(JSON.stringify({ error: { status: 401, message: "bad key" } }));
    expect(tracked.errors[0]?.message).toContain("401: bad key");
  });

  it("maps transport errors to error events", () => {
    const stream = new ElevenLabsDialogueTtsStream(REQUEST, OPTIONS);
    const ws = lastSocket();
    const tracked = track(stream);
    ws.serverError(new Error("ECONNRESET"));
    expect(tracked.errors[0]?.message).toBe("ECONNRESET");
  });

  it("maps a rejected handshake (unexpected-response) with the server detail", () => {
    const stream = new ElevenLabsDialogueTtsStream(REQUEST, OPTIONS);
    const ws = lastSocket();
    const tracked = track(stream);
    const res = new EventEmitter() as EventEmitter & {
      statusCode: number;
      statusMessage: string;
    };
    res.statusCode = 400;
    res.statusMessage = "Bad Request";
    ws.emit("unexpected-response", {}, res);
    res.emit(
      "data",
      Buffer.from(
        JSON.stringify({ detail: { status: "unsupported_model", message: "model not allowed" } }),
      ),
    );
    res.emit("end");
    expect(tracked.errors).toHaveLength(1);
    expect(tracked.errors[0]?.message).toContain("HTTP 400");
    expect(tracked.errors[0]?.message).toContain("unsupported_model");
    expect(tracked.errors[0]?.message).toContain("model not allowed");
  });
});

describe("dialogueErrorText", () => {
  it("extracts string and object errors", () => {
    expect(dialogueErrorText(JSON.stringify({ error: "boom" }))).toBe("boom");
    expect(
      dialogueErrorText(JSON.stringify({ error: { status: 402, message: "no credits" } })),
    ).toBe("402: no credits");
  });

  it("never flags audio or completion frames", () => {
    expect(dialogueErrorText(JSON.stringify({ audio: "aGk=" }))).toBeNull();
    expect(dialogueErrorText(JSON.stringify({ is_final: true }))).toBeNull();
    expect(dialogueErrorText(JSON.stringify({ is_final_audio_for_turn: true }))).toBeNull();
    expect(dialogueErrorText("not-json{{")).toBeNull();
    expect(dialogueErrorText(JSON.stringify({}))).toBeNull();
    expect(dialogueErrorText(JSON.stringify({ message: "informational" }))).toBeNull();
  });

  it("flags status-style error frames without an error field", () => {
    expect(dialogueErrorText(JSON.stringify({ status: 500, message: "internal" }))).toBe(
      "500: internal",
    );
  });
});

describe("handshakeErrorText", () => {
  it("prefers the JSON detail from the response body", () => {
    const text = handshakeErrorText(
      400,
      "Bad Request",
      JSON.stringify({ detail: { status: "unsupported_model", message: "nope" } }),
    );
    expect(text).toContain("HTTP 400 Bad Request");
    expect(text).toContain("unsupported_model");
    expect(text).toContain("nope");
  });

  it("falls back to the status line for non-JSON bodies", () => {
    expect(handshakeErrorText(502, "Bad Gateway", "<html>")).toBe(
      "elevenlabs dialogue tts handshake failed: HTTP 502 Bad Gateway",
    );
  });
});

describe("transport selection (model family)", () => {
  it.each([
    ["eleven_v3", true],
    ["eleven_v3_alpha", true],
    ["eleven_v4", true],
    ["eleven_v4_turbo", true],
    ["eleven_turbo_v2_5", false],
    ["eleven_flash_v2_5", false],
    ["eleven_multilingual_v2", false],
  ])("isDialogueFamilyModel(%s) → %s", (model, expected) => {
    expect(isDialogueFamilyModel(model)).toBe(expected);
  });

  it.each([
    ["eleven_v3", "dialogue"],
    ["eleven_v4_turbo", "dialogue"],
    ["eleven_turbo_v2_5", "tts"],
    ["eleven_flash_v2_5", "tts"],
    ["eleven_multilingual_v2", "tts"],
  ])('auto: "%s" → "%s"', (model, expected) => {
    expect(resolveTtsTransport("auto", model)).toBe(expected);
  });

  it("passes a forced transport through when the family matches", () => {
    expect(resolveTtsTransport("dialogue", "eleven_v4_turbo")).toBe("dialogue");
    expect(resolveTtsTransport("tts", "eleven_turbo_v2_5")).toBe("tts");
  });

  it("rejects a forced dialogue transport for a v2.x model", () => {
    expect(() => resolveTtsTransport("dialogue", "eleven_turbo_v2_5")).toThrowError(
      /tts\.api "dialogue" requires an Eleven v3\/v4 model.*eleven_turbo_v2_5.*tts\.api to "auto"/s,
    );
  });

  it("rejects a forced tts transport for a v3/v4 model", () => {
    expect(() => resolveTtsTransport("tts", "eleven_v4_turbo")).toThrowError(
      /eleven_v4_turbo.*only streams over the text-to-dialogue API.*"auto" or "dialogue"/s,
    );
  });
});

describe("provider-level model guards", () => {
  it("the stream-input provider rejects v3/v4 models at stream creation", () => {
    const provider = new ElevenLabsTtsProvider(configWith({ provider: "elevenlabs" }));
    expect(() =>
      provider.stream({ language: "et", voiceId: "v", modelId: "eleven_v4_turbo" }),
    ).toThrowError(/only streams over the text-to-dialogue API/);
  });

  it("the dialogue provider rejects v2.x models at stream creation", () => {
    const provider = new ElevenLabsDialogueTtsProvider(configWith({ provider: "elevenlabs" }));
    expect(() =>
      provider.stream({ language: "et", voiceId: "v", modelId: "eleven_turbo_v2_5" }),
    ).toThrowError(/requires an Eleven v3\/v4 model/);
  });

  it("the dialogue provider accepts its own family without an override", () => {
    const provider = new ElevenLabsDialogueTtsProvider(
      configWith({ provider: "elevenlabs", model: "eleven_v4_turbo" }),
    );
    const stream = provider.stream({ language: "ru", voiceId: "v-ru" });
    expect(stream.events).toBeDefined();
    // The stream pins the default model into the dialogue URL.
    expect(new URL(lastSocket().url).searchParams.get("model_id")).toBe("eleven_v4_turbo");
    expect(new URL(lastSocket().url).searchParams.get("language_code")).toBe("ru");
    stream.close();
  });
});
