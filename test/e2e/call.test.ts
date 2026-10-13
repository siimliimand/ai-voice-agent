/**
 * E2E: one fixture wav driven through the real browser media transport into
 * the full call pipeline (STT → language detection → conversation → TTS →
 * playback), asserting the persisted rows in Postgres.
 *
 * Everything external is faked at the composition-root seams (buildApp
 * overrides): the STT emits scripted finals when it has received enough
 * bytes, the TTS emits a short silence buffer per sentence, and the LLM is a
 * subclass of OpenRouterClient whose chat()/chatStream() are switched on the
 * prompt content (language vote / note JSON / streamed Estonian reply).
 *
 * Run (dockerized Postgres, host port may be unpublished):
 *   docker compose up -d postgres
 *   export DATABASE_URL="postgres://voice:voice@$(docker inspect \
 *     --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
 *     $(docker compose ps -q postgres)):5432/voice"
 *   npx vitest run test/e2e
 *
 * Without DATABASE_URL the suite skips cleanly.
 */
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import WebSocket, { type RawData } from "ws";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp, type AppHandle } from "../../src/app.js";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import { closeDb, createDb } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import type { Database } from "../../src/db/schema.js";
import {
  OpenRouterClient,
  type ChatOptions,
  type ChatStreamOptions,
  type StreamDelta,
} from "../../src/llm/openrouter.js";
import { noteSchema, type Note } from "../../src/notes/note-schema.js";
import type { SttEvent, SttProvider, SttStream, SttStreamOptions } from "../../src/stt/types.js";
import type { TtsProvider } from "../../src/tts/types.js";

/* ------------------------------------------------------------- constants */

const DATABASE_URL = process.env.DATABASE_URL ?? "";

const FROM_NUMBER = "+3725550001";
const ADMIN_PASSWORD = "e2e-admin-password";

/** Caller audio framing: 20 ms of 16 kHz mono PCM16 = 640 bytes. */
const CHUNK_BYTES = 640;
const CHUNK_PACE_MS = 5;
/** The fake STT commits its final once this many bytes have arrived (~200 ms). */
const FINAL_AFTER_BYTES = 6400;
/** WebSocket / DB poll budget. Generous, but bounded. */
const TIMEOUT_MS = 5_000;

const DETECTION_RESPONSE = '{"language":"et","confidence":0.95}';

/** A valid note the fake summarizer LLM returns; must pass noteSchema. */
const FAKE_NOTE: Note = {
  summary:
    "Helistaja küsis arve kohta; agent lubas asja kontrollida ja kliendile tagasi helistada.",
  language: "et",
  client: null,
  intents: ["küsimus arve kohta"],
  actions_taken: ["lubas arvet kontrollida"],
  unresolved_issues: ["arve küsimus jäi avatuks"],
  follow_ups: ["agent helistab kliendile tagasi"],
  urgency: "normal",
  sentiment: "neutral",
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/* --------------------------------------------------------- fake providers */

interface ScriptedSttStep {
  /** Emit once this many total bytes have been written (across streams). */
  afterBytes: number;
  event: Omit<SttEvent, "atMs">;
}

/**
 * STT that plays a scripted sequence of transcript events as audio arrives.
 * Script state lives on the PROVIDER, not the stream: the pipeline reopens
 * the STT stream when the language locks, and the script must not replay.
 *
 * atMs is an offset from the first audio byte, matching PipelineUtterance's
 * "offset from call start" contract and the at_ms INTEGER column. (The real
 * providers emit Date.now() wall-clock here, which overflows that column —
 * reported separately; the fakes must not reproduce it.)
 */
function makeScriptedStt(script: ScriptedSttStep[]): SttProvider {
  let receivedBytes = 0;
  let next = 0;
  let clockStart: number | undefined;
  return {
    name: "fake-stt",
    startStream(_opts: SttStreamOptions): SttStream {
      const listeners: Array<(e: SttEvent) => void> = [];
      let closed = false;
      const emit = (step: Omit<SttEvent, "atMs">): void => {
        if (clockStart === undefined) clockStart = Date.now();
        const event: SttEvent = { ...step, atMs: Date.now() - clockStart };
        for (const listener of listeners) listener(event);
      };
      return {
        write(pcm: Buffer): void {
          if (closed) return;
          receivedBytes += pcm.length;
          for (;;) {
            const step = script[next];
            if (step === undefined || receivedBytes < step.afterBytes) break;
            next += 1;
            emit(step.event);
          }
        },
        async close(): Promise<void> {
          closed = true;
        },
        on(listener: (e: SttEvent) => void): void {
          listeners.push(listener);
        },
        get closed(): boolean {
          return closed;
        },
      };
    },
  };
}

/**
 * TTS that emits one 320-sample (640-byte) silence frame per push, then
 * firstByte + done on end() — the shape the playback queue paces out.
 */
function makeSilenceTts(): TtsProvider {
  return {
    name: "fake-tts",
    stream(_req) {
      const events = new EventEmitter();
      const createdAt = Date.now();
      return {
        events,
        push(_text: string): void {
          events.emit("audio", Buffer.alloc(320 * 2, 0));
        },
        end(): void {
          events.emit("firstByte", Math.max(1, Date.now() - createdAt));
          events.emit("done");
        },
        close(): void {
          // nothing in flight; nothing to abort
        },
      };
    },
  };
}

/**
 * LLM double switched on the prompt content:
 * - language-detection system prompt → an "et" vote,
 * - call-notes summarizer system prompt → a valid note JSON,
 * - chatStream (conversation replies) → a scripted Estonian reply.
 */
class FakeOpenRouter extends OpenRouterClient {
  constructor() {
    super({ apiKey: "e2e-fake-key" });
  }

  override async chat(opts: ChatOptions): Promise<string> {
    const system = opts.messages.find((m) => m.role === "system")?.content ?? "";
    if (system.includes("call-notes summarizer")) return JSON.stringify(FAKE_NOTE);
    if (system.includes("dominant spoken language")) return DETECTION_RESPONSE;
    throw new Error(`unexpected chat() prompt: ${system.slice(0, 100)}`);
  }

  override async *chatStream(_opts: ChatStreamOptions): AsyncGenerator<StreamDelta> {
    yield { content: "Tere! Kindlasti. " };
    yield { content: "Kuidas saan aidata?" };
    yield { finishReason: "stop" };
  }
}

/* ------------------------------------------------------------ wav helper */

/** Strip the RIFF container and return the PCM payload of the data chunk. */
function pcmFromWav(wav: Buffer): Buffer {
  const riff = wav.toString("latin1", 0, 4);
  const wave = wav.toString("latin1", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error(`not a RIFF/WAVE file (got "${riff}"..."${wave}")`);
  }
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("latin1", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      if (offset + 8 + chunkSize > wav.length) throw new Error("WAV data chunk is truncated");
      return wav.subarray(offset + 8, offset + 8 + chunkSize);
    }
    if (chunkId === "fmt ") {
      const format = wav.readUInt16LE(offset + 8);
      const channels = wav.readUInt16LE(offset + 10);
      const sampleRate = wav.readUInt32LE(offset + 12);
      const bits = wav.readUInt16LE(offset + 22);
      if (format !== 1 || channels !== 1 || sampleRate !== 16000 || bits !== 16) {
        throw new Error(
          `unexpected wav format: fmt=${format} ch=${channels} hz=${sampleRate} bits=${bits}`,
        );
      }
    }
    offset += 8 + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  throw new Error("WAV file has no data chunk");
}

/* ------------------------------------------------------------------ suite */

describe.skipIf(!DATABASE_URL)("e2e: fixture call through the browser transport", () => {
  let handle: AppHandle | undefined;
  let db: Kysely<Database> | undefined;
  /** Synthetic callSid of the call driven in the flow test (dev-...). */
  let callSid: string | undefined;
  /** Reference transcript the fake STT commits (from fixture-et.txt). */
  let referenceText = "";

  const requireDb = (): Kysely<Database> => {
    if (db === undefined) throw new Error("database was not initialized");
    return db;
  };
  const requireCallSid = (): string => {
    if (callSid === undefined) throw new Error("callSid was not captured (flow test failed?)");
    return callSid;
  };

  beforeAll(async () => {
    referenceText = readFileSync(
      fileURLToPath(new URL("../fixtures/fixture-et.txt", import.meta.url)),
      "utf8",
    ).trim();

    db = createDb(DATABASE_URL);
    await runMigrations(db);

    const config: AppConfig = configSchema.parse({
      logLevel: "error",
      devBrowserCalls: true,
      admin: { user: "admin", password: ADMIN_PASSWORD },
      notes: { enabled: true },
    });

    const stt = makeScriptedStt([
      {
        afterBytes: CHUNK_BYTES,
        event: { type: "partial", text: "Tere, mul on küsimus arve kohta" },
      },
      {
        afterBytes: FINAL_AFTER_BYTES,
        event: { type: "final", text: referenceText, language: "et", confidence: 0.95 },
      },
    ]);

    handle = await buildApp(config, {
      stt,
      tts: makeSilenceTts(),
      llm: new FakeOpenRouter(),
      db,
    });
    await handle.app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    try {
      if (handle) await handle.close();
    } finally {
      if (db) {
        // calls row delete cascades to transcripts, notes and events.
        await db
          .deleteFrom("calls")
          .where((eb) =>
            eb.or([
              eb("call_sid", "=", callSid ?? "__none__"),
              eb("from_number", "=", FROM_NUMBER),
            ]),
          )
          .execute();
        await closeDb(db);
      }
    }
  });

  /** Poll the database until `query` returns a value (or time out). */
  async function pollForDb<T>(desc: string, query: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      let failure = "";
      try {
        const found = await query();
        if (found !== undefined) return found;
      } catch (err) {
        failure = `; last query error: ${String(err)}`;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out after ${TIMEOUT_MS}ms waiting for ${desc}${failure}`);
      }
      await sleep(100);
    }
  }

  /** The calls row of the captured callSid, waited into "completed". */
  async function completedCallRow() {
    const database = requireDb();
    const sid = requireCallSid();
    return pollForDb("completed calls row", async () => {
      const row = await database
        .selectFrom("calls")
        .selectAll()
        .where("call_sid", "=", sid)
        .executeTakeFirst();
      return row !== undefined && row.status === "completed" ? row : undefined;
    });
  }

  it(
    "drives a fixture wav call over /media/browser end to end " +
      "(start → greeting audio → caller audio → final → reply/barge-in → stop → hangup)",
    async () => {
      const app = handle?.app;
      if (app === undefined) throw new Error("app was not built");
      const address = app.server?.address();
      if (address === undefined || address === null || typeof address === "string") {
        throw new Error(`app is not listening on a TCP socket: ${String(address)}`);
      }
      const port = (address as AddressInfo).port;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/media/browser`);
      const frames = {
        /** Parsed server JSON control frames, in arrival order. */
        text: [] as Array<Record<string, unknown>>,
        binaryFrames: 0,
        binaryBytes: 0,
        closed: false,
        closeCode: undefined as number | undefined,
      };
      /** Compact frame log for timeout diagnostics. */
      const trail: string[] = [];
      const record = (entry: string): void => {
        trail.push(entry);
        if (trail.length > 60) trail.shift();
      };
      let socketError: Error | undefined;

      const toBuffer = (data: RawData): Buffer => {
        if (Buffer.isBuffer(data)) return data;
        if (Array.isArray(data)) return Buffer.concat(data);
        return Buffer.from(data as ArrayBuffer);
      };

      ws.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) {
          frames.binaryFrames += 1;
          frames.binaryBytes += toBuffer(data).length;
          record(`binary(${toBuffer(data).length}B)`);
          return;
        }
        try {
          const msg = JSON.parse(toBuffer(data).toString("utf8")) as Record<string, unknown>;
          frames.text.push(msg);
          record(`text:${JSON.stringify(msg)}`);
        } catch {
          record(`text:<unparseable>`);
        }
      });
      ws.on("close", (code: number) => {
        frames.closed = true;
        frames.closeCode = code;
        record(`close(${code})`);
      });
      ws.on("error", (err: Error) => {
        socketError = err;
        record(`error:${err.message}`);
      });

      const timeoutDetails = (desc: string): string =>
        `${desc}: timed out after ${TIMEOUT_MS}ms — ` +
        `binaryFrames=${frames.binaryFrames} binaryBytes=${frames.binaryBytes} ` +
        `socketError=${String(socketError)} ` +
        `lastFrames=[${trail.slice(-12).join(" | ")}]`;

      const waitForEvent = (event: string, desc: string): Promise<void> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            ws.off(event, onEvent);
            reject(new Error(timeoutDetails(`ws "${event}" (${desc})`)));
          }, TIMEOUT_MS);
          function onEvent(): void {
            clearTimeout(timer);
            ws.off(event, onEvent);
            resolve();
          }
          ws.once(event, onEvent);
        });

      /** Resolve with probe()'s value as soon as it returns non-undefined. */
      const waitFor = async <T>(desc: string, probe: () => T | undefined): Promise<T> => {
        const deadline = Date.now() + TIMEOUT_MS;
        for (;;) {
          const found = probe();
          if (found !== undefined) return found;
          if (Date.now() > deadline) throw new Error(timeoutDetails(desc));
          await sleep(10);
        }
      };

      try {
        await waitForEvent("open", "socket open");

        // 1. start the call (server synthesizes a dev-... callSid).
        ws.send(JSON.stringify({ type: "start", from: FROM_NUMBER }));

        // 2. greeting: binary agent audio must arrive before any caller audio.
        await waitFor("greeting audio frame", () => (frames.binaryFrames > 0 ? true : undefined));
        await waitFor("greeting playback mark", () =>
          frames.text.find((m) => m["type"] === "mark"),
        );

        // The greeting mark proves the session is wired; grab the callSid.
        const sid = [...(handle?.transports.keys() ?? [])].find((k) => k.startsWith("dev-"));
        expect(sid, "no dev- transport registered after start").toBeDefined();
        callSid = sid;

        // 3. stream the fixture PCM payload in 20 ms chunks (5 ms pacing).
        const wav = readFileSync(
          fileURLToPath(new URL("../fixtures/fixture-et.wav", import.meta.url)),
        );
        const pcm = pcmFromWav(wav);
        for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
          if (ws.readyState !== ws.OPEN) break;
          ws.send(pcm.subarray(offset, offset + CHUNK_BYTES));
          await sleep(CHUNK_PACE_MS);
        }

        // 4. the fake STT's scripted final must be announced to the client.
        const finalFrame = await waitFor("caller final transcript frame", () =>
          frames.text.find(
            (m) =>
              m["type"] === "transcript" &&
              m["speaker"] === "caller" &&
              m["partial"] === false &&
              m["text"] === referenceText,
          ),
        );
        expect(finalFrame).toBeDefined();

        // 5. the pipeline reacts to the utterance: either the reply is played
        // (t-mark / more audio) or the loud fixture barges in over playback.
        const binaryAtFinal = frames.binaryFrames;
        await waitFor("reply playback or barge-in", () => {
          if (frames.binaryFrames > binaryAtFinal) return true;
          return frames.text.some(
            (m) =>
              (m["type"] === "mark" &&
                typeof m["name"] === "string" &&
                m["name"].startsWith("t")) ||
              (m["type"] === "status" && m["text"] === "barge-in"),
          )
            ? true
            : undefined;
        });

        // 6. stop → hangup control frame → clean close (1000).
        ws.send(JSON.stringify({ type: "stop" }));
        const hangup = await waitFor(
          "hangup control frame",
          () => frames.text.find((m) => m["type"] === "hangup") as { reason?: unknown } | undefined,
        );
        expect(String(hangup["reason"])).toBe("client_stop");
        // Poll the close flag instead of registering a listener here: the
        // server may hang up and close within one poll tick, before a
        // late-registered "close" listener would ever fire.
        await waitFor("socket close after hangup", () => (frames.closed ? true : undefined));

        expect(frames.closed).toBe(true);
        expect(frames.closeCode).toBe(1000);
        // Greeting (and usually the reply) audio reached the client.
        expect(frames.binaryFrames).toBeGreaterThanOrEqual(1);
        expect(frames.binaryBytes).toBeGreaterThanOrEqual(640);
      } finally {
        ws.close();
      }
    },
  );

  it("persists a completed browser call row under a synthetic dev- callSid", async () => {
    const row = await completedCallRow();
    expect(row.call_sid.startsWith("dev-")).toBe(true);
    expect(row.from_number).toBe(FROM_NUMBER);
    expect(row.provider).toBe("browser");
    expect(row.language).toBe("et");
    expect(row.status).toBe("completed");
    expect(row.ended_at).not.toBeNull();
    expect(row.duration_s).not.toBeNull();
    expect(row.duration_s ?? -1).toBeGreaterThanOrEqual(0);
  });

  it("persists caller and agent transcript rows for the call", async () => {
    const database = requireDb();
    const call = await completedCallRow();
    const rows = await pollForDb("transcript rows (caller final + agent)", async () => {
      const all = await database
        .selectFrom("call_transcripts")
        .selectAll()
        .where("call_id", "=", call.id)
        .orderBy("id", "asc")
        .execute();
      const hasCallerFinal = all.some((r) => r.speaker === "caller" && r.text === referenceText);
      const hasAgent = all.some((r) => r.speaker === "agent");
      return hasCallerFinal && hasAgent ? all : undefined;
    });

    const callerRows = rows.filter((r) => r.speaker === "caller");
    const agentRows = rows.filter((r) => r.speaker === "agent");
    const finalRow = callerRows.find((r) => r.text === referenceText);

    expect(finalRow).toBeDefined();
    expect(finalRow?.language).toBe("et");
    expect(agentRows.length).toBeGreaterThanOrEqual(1);
    // Greeting (English, pre-detection) and/or Estonian reply — both are agent
    // speech; just require at least one non-empty persisted agent utterance.
    expect(agentRows.some((r) => r.text.trim().length > 0)).toBe(true);
  });

  it("persists a structured note that validates against noteSchema", async () => {
    const database = requireDb();
    const call = await completedCallRow();
    const noteRow = await pollForDb("call_notes row", async () => {
      return database
        .selectFrom("call_notes")
        .selectAll()
        .where("call_id", "=", call.id)
        .executeTakeFirst();
    });

    expect(typeof noteRow.model).toBe("string");
    expect(noteRow.model.length).toBeGreaterThan(0);

    const parsed = noteSchema.safeParse(noteRow.note);
    if (!parsed.success) {
      throw new Error(
        `call_notes.note failed schema validation: ${parsed.error.message} — ` +
          `note was ${JSON.stringify(noteRow.note)}`,
      );
    }
    expect(parsed.data.language).toBe("et");
    expect(parsed.data.summary.length).toBeGreaterThan(0);
    expect(parsed.data.urgency).toBe("normal");
    expect(parsed.data.sentiment).toBe("neutral");
  });

  it("records call_started, call_ended and note_generated events", async () => {
    const database = requireDb();
    const call = await completedCallRow();
    const types = await pollForDb("call lifecycle + note events", async () => {
      const rows = await database
        .selectFrom("call_events")
        .select("type")
        .where("call_id", "=", call.id)
        .execute();
      const names = rows.map((r) => r.type);
      const required = ["call_started", "call_ended", "note_generated"];
      return required.every((t) => names.includes(t)) ? names : undefined;
    });

    expect(types).toContain("call_started");
    expect(types).toContain("call_ended");
    expect(types).toContain("note_generated");
  });
});
