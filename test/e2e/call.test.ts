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

import {
  getConsentGoodbye,
  getConfirmationQuestion,
  getEscalationAnnouncement,
  getGreeting,
} from "../../src/agent/prompts/index.js";
import { buildApp, type AppHandle } from "../../src/app.js";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import type { Database } from "../../src/db/schema.js";
import {
  OpenRouterClient,
  type ChatOptions,
  type ChatStreamOptions,
  type CompletedToolCall,
  type StreamDelta,
} from "../../src/llm/openrouter.js";
import { noteSchema, type Note } from "../../src/notes/note-schema.js";
import { ESCALATION_ACTION } from "../../src/notes/summarizer.js";
import { startMockCalendar, type MockCalendar } from "../fixtures/mock-calendar.js";
import type { SttEvent, SttProvider, SttStream, SttStreamOptions } from "../../src/stt/types.js";
import type { TtsProvider } from "../../src/tts/types.js";
import { createScratchDb, type ScratchDb } from "../helpers/scratch-db.js";

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
 * firstByte + done on end() — the shape the playback queue paces out. Every
 * pushed sentence is recorded so scenarios can wait for (and assert) exactly
 * what the agent spoke.
 */
function makeSilenceTts(): TtsProvider & { readonly spoken: string[] } {
  const spoken: string[] = [];
  return {
    name: "fake-tts",
    spoken,
    stream(_req) {
      const events = new EventEmitter();
      const createdAt = Date.now();
      return {
        events,
        push(text: string): void {
          spoken.push(text);
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

/** One scripted chatStream() turn: a generator factory switched in order. */
type StreamScript = (opts: ChatStreamOptions) => AsyncGenerator<StreamDelta>;

/**
 * Stream impl that streams REAL tool-call deltas (arguments streamed as
 * function-call fragments, then assembled on the finish delta) — the same
 * wire shape the OpenRouter accumulator parses.
 */
function toolCallStream(calls: CompletedToolCall[]): StreamScript {
  return async function* (): AsyncGenerator<StreamDelta> {
    yield {
      toolCalls: calls.map((c, index) => ({
        index,
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      })),
    };
    yield { finishReason: "tool_calls", completedToolCalls: calls };
  };
}

/** Stream impl for a plain spoken reply. */
function spokenStream(text: string): StreamScript {
  return async function* (): AsyncGenerator<StreamDelta> {
    yield { content: text };
    yield { finishReason: "stop" };
  };
}

/**
 * LLM double switched on the prompt content:
 * - language-detection system prompt → an "et" vote,
 * - call-notes summarizer system prompt → a valid note JSON,
 * - chatStream (conversation replies) → the scripted turns in order, falling
 *   back to a plain streamed Estonian reply once the script runs out (the
 *   tool-free path the first fixture-call scenario exercises).
 */
class FakeOpenRouter extends OpenRouterClient {
  private readonly scripts: StreamScript[];
  private nextScript = 0;

  constructor(scripts: StreamScript[] = []) {
    super({ apiKey: "e2e-fake-key" });
    this.scripts = scripts;
  }

  override async chat(opts: ChatOptions): Promise<string> {
    const system = opts.messages.find((m) => m.role === "system")?.content ?? "";
    if (system.includes("call-notes summarizer")) return JSON.stringify(FAKE_NOTE);
    if (system.includes("dominant spoken language")) return DETECTION_RESPONSE;
    if (system.includes("yes/no question")) return "unclear"; // affirmation tiebreaker
    throw new Error(`unexpected chat() prompt: ${system.slice(0, 100)}`);
  }

  override async *chatStream(opts: ChatStreamOptions): AsyncGenerator<StreamDelta> {
    const script = this.scripts[this.nextScript];
    this.nextScript += 1;
    if (script !== undefined) {
      yield* script(opts);
      return;
    }
    yield { content: "Tere! Kindlasti. " };
    yield { content: "Kuidas saan aidata?" };
    yield { finishReason: "stop" };
  }
}

/* ------------------------------------------------------------ wav helper */

/** Normalize one ws RawData message into a Buffer. */
function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

/** Reference transcript the fake STT commits (test/fixtures/fixture-et.txt). */
function fixtureReferenceText(): string {
  return readFileSync(
    fileURLToPath(new URL("../fixtures/fixture-et.txt", import.meta.url)),
    "utf8",
  ).trim();
}

/** PCM payload of the fixture wav (test/fixtures/fixture-et.wav). */
function fixturePcm(): Buffer {
  return pcmFromWav(readFileSync(fileURLToPath(new URL("../fixtures/fixture-et.wav", import.meta.url))));
}

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

/** Poll the calls row of `callSid` into `status` (bounded). */
async function pollForDbRow(database: Kysely<Database>, callSid: string, status: string) {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const row = await database
      .selectFrom("calls")
      .selectAll()
      .where("call_sid", "=", callSid)
      .executeTakeFirst();
    if (row !== undefined && row.status === status) return row;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for a ${status} calls row (call_sid=${callSid})`);
    }
    await sleep(100);
  }
}

/* ------------------------------------------------- transport-driving helpers */

/** Compact ordered log of one call's text frames (bounded), for diagnostics. */
interface FrameLog {
  text: Array<Record<string, unknown>>;
  trail: string[];
}

function makeFrameLog(): FrameLog {
  return { text: [], trail: [] };
}

/** TCP port an app is listening on (the apps bind port 0). */
function portOf(handle: AppHandle): number {
  const address = handle.app.server?.address();
  if (address === undefined || address === null || typeof address === "string") {
    throw new Error(`app is not listening on a TCP socket: ${String(address)}`);
  }
  return (address as AddressInfo).port;
}

/** The synthetic dev- callSid of the (single) live transport of an app. */
function captureSid(handle: AppHandle): string {
  const sid = [...handle.transports.keys()].find((k) => k.startsWith("dev-"));
  expect(sid, "no dev- transport registered after start").toBeDefined();
  return sid as string;
}

/**
 * Open the browser media socket, attach the text-frame collector, send
 * `start`, and resolve once the socket is open.
 */
async function openCall(
  port: number,
  from: string,
  log: FrameLog,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/media/browser`);
  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    try {
      const msg = JSON.parse(rawToBuffer(data).toString("utf8")) as Record<string, unknown>;
      log.text.push(msg);
      log.trail.push(`text:${JSON.stringify(msg)}`);
      if (log.trail.length > 60) log.trail.shift();
    } catch {
      log.trail.push("text:<unparseable>");
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket open timed out")), TIMEOUT_MS);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  ws.send(JSON.stringify({ type: "start", from }));
  return ws;
}

/** Stream `n` silent 20 ms caller frames (5 ms pacing, below the VAD gate). */
async function sendChunks(ws: WebSocket, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(Buffer.alloc(CHUNK_BYTES, 0));
    await sleep(CHUNK_PACE_MS);
  }
}

/** Stream `pcm` in 20 ms chunks (5 ms pacing) until the socket closes. */
async function streamPcm(ws: WebSocket, pcm: Buffer): Promise<void> {
  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(pcm.subarray(offset, offset + CHUNK_BYTES));
    await sleep(CHUNK_PACE_MS);
  }
}

/** Wait until the socket is closed (bounded). */
async function collectUntilClose(ws: WebSocket, log: FrameLog): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    if (ws.readyState !== ws.OPEN) return;
    if (Date.now() > deadline) {
      throw new Error(`socket close timed out; lastFrames=[${log.trail.slice(-12).join(" | ")}]`);
    }
    await sleep(10);
  }
}

/** Poll the collected text frames until one of `type` matches `filter`. */
async function waitForFrame(
  frames: Array<Record<string, unknown>>,
  type: string,
  filter: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const found = frames.find((m) => m["type"] === type && filter(m));
    if (found !== undefined) return found;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for a "${type}" frame`);
    }
    await sleep(10);
  }
}

/** Wait until the fake TTS has been pushed a sentence containing `fragment`. */
async function waitForSpoken(tts: { spoken: string[] }, fragment: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    if (tts.spoken.some((s) => s.includes(fragment))) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for spoken "${fragment}"; spoken=[${tts.spoken.join(" | ")}]`,
      );
    }
    await sleep(10);
  }
}

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
  // Scratch database: persisted rows (and this suite's cleanup) stay on an
  // isolated database — never the shared DATABASE_URL database (incident:
  // suites used to delete the operator's `settings` row there).
  let scratch: ScratchDb | undefined;
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

    scratch = await createScratchDb("e2e_fixture_call");
    db = scratch.db;

    const config: AppConfig = configSchema.parse({
      logLevel: "error",
      devBrowserCalls: true,
      admin: { user: "admin", password: ADMIN_PASSWORD },
      notes: { enabled: true },
    });

    // Consent is on by default (design D5): the scripted call answers the
    // spoken notice affirmatively first; the pipeline then unlocks and the
    // rest of the script plays into the normal (post-grant) STT stream.
    // Steps fire by cumulative received bytes across streams (the script
    // lives on the provider, so the grant mid-stream cannot replay steps).
    const stt = makeScriptedStt([
      {
        afterBytes: CHUNK_BYTES,
        event: { type: "final", text: "Jah, kindlasti", language: "et", confidence: 0.95 },
      },
      {
        afterBytes: 3 * CHUNK_BYTES,
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
      // Dropping the scratch database removes the calls row and everything
      // cascaded to it (transcripts, notes, events) — no shared-table deletes.
      if (scratch) await scratch.destroy();
    }
  });

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
    expect(row.consent).toBe("granted"); // the fixture answered the notice
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
    // Consent-window speech never lands in the transcript: neither the
    // fixture's affirmative reply nor the agent's spoken notice/greeting
    // preamble may appear.
    expect(rows.some((r) => r.text.includes("Jah, kindlasti"))).toBe(false);
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
      const required = ["call_started", "call_ended", "note_generated", "consent_granted"];
      return required.every((t) => names.includes(t)) ? names : undefined;
    });

    expect(types).toContain("call_started");
    expect(types).toContain("call_ended");
    expect(types).toContain("note_generated");
    expect(types).toContain("consent_granted");
  });
});

describe.skipIf(!DATABASE_URL)("e2e: consent decline and toggle-off scenarios", () => {
  // Scratch database: the shared `settings` row deletions this suite used to
  // perform (before AND after the run — an incident-class wipe of the
  // operator's saved settings) are unnecessary on an isolated database, where
  // defaults hold because the table starts empty.
  let scratch: ScratchDb | undefined;
  let db: Kysely<Database> | undefined;
  /** Apps under test, closed in afterAll. */
  const handles: AppHandle[] = [];
  /** callSid of the declined call (server hangs it up). */
  let declineCallSid: string | undefined;
  /** callSid of the toggle-off call. */
  let toggleOffCallSid: string | undefined;
  /** The decline app's TTS — records the notice/goodbye speech for assertions. */
  let declineTts: ReturnType<typeof makeSilenceTts>;

  const DECLINE_FROM = "+3725550002";
  const TOGGLE_OFF_FROM = "+3725550003";

  const requireDb = (): Kysely<Database> => {
    if (db === undefined) throw new Error("database was not initialized");
    return db;
  };

  beforeAll(async () => {
    scratch = await createScratchDb("e2e_consent_toggle");
    db = scratch.db;

    const baseConfig: Record<string, unknown> = {
      logLevel: "error",
      devBrowserCalls: true,
      admin: { user: "admin", password: ADMIN_PASSWORD },
      notes: { enabled: false },
    };

    // --- Decline app: consent on; the scripted caller refuses the notice.
    const declineStt = makeScriptedStt([
      {
        afterBytes: CHUNK_BYTES,
        event: { type: "final", text: "Ei, ei taha", language: "et", confidence: 0.9 },
      },
    ]);
    declineTts = makeSilenceTts();
    const declineHandle = await buildApp(configSchema.parse(baseConfig), {
      stt: declineStt,
      tts: declineTts,
      llm: new FakeOpenRouter(),
      db,
    });
    await declineHandle.app.listen({ port: 0, host: "127.0.0.1" });
    handles.push(declineHandle);

    // --- Toggle-off app: the CONSENT_ENABLED=false equivalent — today's flow.
    const toggleOffStt = makeScriptedStt([
      {
        afterBytes: CHUNK_BYTES,
        event: { type: "partial", text: "Tere, mul on küsimus arve kohta" },
      },
      {
        afterBytes: FINAL_AFTER_BYTES,
        event: { type: "final", text: fixtureReferenceText(), language: "et", confidence: 0.95 },
      },
    ]);
    const toggleOffHandle = await buildApp(
      configSchema.parse({ ...baseConfig, consent: { enabled: false }, notes: { enabled: true } }),
      { stt: toggleOffStt, tts: makeSilenceTts(), llm: new FakeOpenRouter(), db },
    );
    await toggleOffHandle.app.listen({ port: 0, host: "127.0.0.1" });
    handles.push(toggleOffHandle);

    const captureSidLocal = (handle: AppHandle): string => {
      const sid = [...handle.transports.keys()].find((k) => k.startsWith("dev-"));
      expect(sid, "no dev- transport registered after start").toBeDefined();
      return sid as string;
    };

    // Drive the DECLINE call: a little silence, the scripted refusal, then
    // the server speaks the goodbye and hangs up with consent_declined.
    {
      const log = makeFrameLog();
      const ws = await openCall(portOf(declineHandle), DECLINE_FROM, log);
      try {
        await waitForFrame(log.text, "mark", () => true); // notice mark: session wired
        declineCallSid = captureSidLocal(declineHandle);
        await streamPcm(ws, Buffer.alloc(20 * CHUNK_BYTES, 0));
        const hangup = await waitForFrame(log.text, "hangup", () => true);
        expect(String(hangup["reason"])).toBe("consent_declined");
        await collectUntilClose(ws, log);
      } finally {
        ws.close();
      }
    }

    // Drive the TOGGLE-OFF call: greeting plays immediately (no notice), the
    // fixture utterance is answered, the caller stops the call.
    {
      const log = makeFrameLog();
      const ws = await openCall(portOf(toggleOffHandle), TOGGLE_OFF_FROM, log);
      try {
        await waitForFrame(log.text, "mark", () => true); // greeting mark: session wired
        toggleOffCallSid = captureSidLocal(toggleOffHandle);
        await streamPcm(ws, fixturePcm());
        await waitForFrame(
          log.text,
          "transcript",
          (m) => m["speaker"] === "caller" && m["partial"] === false,
        );
        ws.send(JSON.stringify({ type: "stop" }));
        const hangup = await waitForFrame(log.text, "hangup", () => true);
        expect(String(hangup["reason"])).toBe("client_stop");
        await collectUntilClose(ws, log);
      } finally {
        ws.close();
      }
    }
  });

  afterAll(async () => {
    try {
      while (handles.length > 0) await handles.pop()?.close();
    } finally {
      // Dropping the scratch database removes the fixture calls rows and
      // everything cascaded to them — no shared-table deletes.
      if (scratch) await scratch.destroy();
    }
  });

  it("declined call: consent_declined event + zero transcript rows + spoken goodbye", async () => {
    const database = requireDb();
    expect(declineCallSid).toBeDefined();
    const row = await pollForDbRow(database, declineCallSid as string, "completed");

    expect(row.consent).toBe("declined");
    const events = await database
      .selectFrom("call_events")
      .select(["type", "detail"])
      .where("call_id", "=", row.id)
      .execute();
    const types = events.map((e) => e.type);
    expect(types).toContain("consent_declined");
    expect(types).not.toContain("consent_granted");
    const declined = events.find((e) => e.type === "consent_declined");
    expect(declined?.detail).toEqual({ reason: "explicit" });

    // The point of the gate: nothing about this call was ever transcribed —
    // no caller speech, no notice, no goodbye.
    const transcripts = await database
      .selectFrom("call_transcripts")
      .selectAll()
      .where("call_id", "=", row.id)
      .execute();
    expect(transcripts).toEqual([]);

    // The declined call was finished politely: the per-language goodbye was
    // spoken (never a greeting), then the call was hung up — the beforeAll
    // driver above already asserted the consent_declined hangup frame.
    const spoken = declineTts.spoken.join(" ");
    expect(spoken).toContain(getConsentGoodbye("et"));
    expect(spoken).not.toContain(getGreeting("et"));
  });

  it("toggle-off call: existing flow with transcript rows and no consent artifacts", async () => {
    const database = requireDb();
    expect(toggleOffCallSid).toBeDefined();
    const row = await pollForDbRow(database, toggleOffCallSid as string, "completed");

    expect(row.language).toBe("et");
    expect(row.consent ?? null).toBeNull(); // consent never recorded

    const transcripts = await pollUntil(async () => {
      const rows = await database
        .selectFrom("call_transcripts")
        .selectAll()
        .where("call_id", "=", row.id)
        .execute();
      return rows.length > 0 ? rows : undefined;
    }, "transcript rows");
    expect(transcripts.some((r) => r.speaker === "caller")).toBe(true);
    expect(transcripts.some((r) => r.speaker === "agent")).toBe(true);

    const types = (
      await database
        .selectFrom("call_events")
        .select("type")
        .where("call_id", "=", row.id)
        .execute()
    ).map((r) => r.type);
    expect(types).not.toContain("consent_granted");
    expect(types).not.toContain("consent_declined");
  });

  /** Poll until `probe` returns a value (bounded). */
  async function pollUntil<T>(probe: () => Promise<T | undefined>, desc: string): Promise<T> {
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const found = await probe();
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${desc}`);
      await sleep(100);
    }
  }
});

/* ------------------------------------------------- booking flow (task 8.1) */

const BOOKING_FROM = "+3725550004";
const CALENDAR_TOKEN = "Bearer e2e-calendar-token";
/** Caller utterances scripted through the fake STT (consent reply → request → confirm). */
const BOOKING_REQUEST = "Tere, sooviksin broneerida aja puhastusele";
const BOOKING_CONFIRM = "Jah";
const BOOKING_ARGS = {
  date: "2026-05-01",
  time: "14:30",
  service: "dental hygiene",
  patient_name: "Mari Maasikas",
};
/** The confirmation question the loop speaks for the gated booking skill (D6). */
const BOOKING_QUESTION = getConfirmationQuestion("et", Object.values(BOOKING_ARGS).join(", "));
/** Spoken by the scripted model on the re-stream after the confirmed dispatch. */
const BOOKING_OUTCOME = "Teie aeg on broneeritud, täname!";
/** Tail of the Estonian greeting — proves the consent grant unlocked the call. */
const GREETING_TAIL = "kuidas saan aidata";

describe.skipIf(!DATABASE_URL)("e2e: booking skill over the browser transport (task 8.1)", () => {
  // Scratch database: like the other e2e suites, the persisted rows stay on
  // an isolated database (this suite used to delete the shared `settings`
  // row on DATABASE_URL — an incident-class wipe of the operator's data).
  let scratch: ScratchDb | undefined;
  let db: Kysely<Database> | undefined;
  /** RUNNING mock calendar the skills.http.booking endpoint points at. */
  let calendar: MockCalendar | undefined;
  let handle: AppHandle | undefined;
  let tts: ReturnType<typeof makeSilenceTts> | undefined;
  /** Synthetic callSid of the driven booking call (dev-...). */
  let callSid: string | undefined;

  const requireDb = (): Kysely<Database> => {
    if (db === undefined) throw new Error("database was not initialized");
    return db;
  };
  const requireCallSid = (): string => {
    if (callSid === undefined) throw new Error("callSid was not captured (driver failed?)");
    return callSid;
  };

  beforeAll(async () => {
    scratch = await createScratchDb("e2e_booking_skill");
    db = scratch.db;

    // Ephemeral port: nothing fixed to collide with across suite runs.
    calendar = await startMockCalendar();
    tts = makeSilenceTts();

    const config: AppConfig = configSchema.parse({
      logLevel: "error",
      devBrowserCalls: true,
      admin: { user: "admin", password: ADMIN_PASSWORD },
      notes: { enabled: true },
      skills: {
        // The shipped booking skill loads from ./skills at startup; point its
        // endpoint at the running mock and hand it the header credential.
        http: { booking: { url: calendar.url } },
        auth: { calendar: { header: "Authorization", value: CALENDAR_TOKEN } },
      },
    });

    handle = await buildApp(config, {
      stt: makeScriptedStt([
        {
          afterBytes: CHUNK_BYTES,
          event: { type: "final", text: "Jah, kindlasti", language: "et", confidence: 0.95 },
        },
        {
          afterBytes: 4 * CHUNK_BYTES,
          event: { type: "final", text: BOOKING_REQUEST, language: "et", confidence: 0.95 },
        },
        {
          afterBytes: 7 * CHUNK_BYTES,
          event: { type: "final", text: BOOKING_CONFIRM, language: "et", confidence: 0.95 },
        },
      ]),
      tts,
      llm: new FakeOpenRouter([
        // Turn 1: the model books with the full argument set; booking.yaml has
        // requires_confirmation → the loop parks it and asks the caller.
        toolCallStream([
          { id: "call_book_1", name: "booking", arguments: JSON.stringify(BOOKING_ARGS) },
        ]),
        // Turn 2 (after "Jah"): the loop dispatches confirmed, re-streams, and
        // the model speaks the outcome.
        spokenStream(BOOKING_OUTCOME),
      ]),
      db,
    });
    await handle.app.listen({ port: 0, host: "127.0.0.1" });

    // Drive the whole call; the `it`s below assert on recordings + DB rows.
    const log = makeFrameLog();
    const ws = await openCall(portOf(handle), BOOKING_FROM, log);
    try {
      await waitForFrame(log.text, "mark", () => true); // notice mark: session wired
      callSid = captureSid(handle);

      // Consent: affirmative reply → grant → greeting in the voted language.
      await sendChunks(ws, 1);
      await waitForSpoken(tts, GREETING_TAIL);

      // Booking request → tool-call phase → gated → spoken confirmation question.
      await sendChunks(ws, 3);
      await waitForSpoken(tts, BOOKING_QUESTION);
      expect(calendar.requests, "gated skill must not execute before confirmation").toHaveLength(0);

      // "Jah" → keyword-affirmative → dispatch(confirmed) → re-stream → outcome.
      await sendChunks(ws, 3);
      await waitForSpoken(tts, BOOKING_OUTCOME);
      expect(calendar.requests).toHaveLength(1);

      ws.send(JSON.stringify({ type: "stop" }));
      const hangup = await waitForFrame(log.text, "hangup", () => true);
      expect(String(hangup["reason"])).toBe("client_stop");
      await collectUntilClose(ws, log);
    } finally {
      ws.close();
    }
  });

  afterAll(async () => {
    try {
      if (handle) await handle.close();
    } finally {
      await calendar?.stop();
      // Dropping the scratch database removes the fixture calls row and
      // everything cascaded to it — no shared-table deletes.
      if (scratch) await scratch.destroy();
    }
  });

  it("books exactly once against the running mock calendar with the substituted request", async () => {
    const cal = calendar;
    if (cal === undefined) throw new Error("mock calendar was not started");
    // Exactly ONE HTTP request: the confirmed dispatch. The first (gated)
    // tool call and any other turn must never have reached the calendar.
    expect(cal.requests).toHaveLength(1);
    const request = cal.requests[0];
    if (request === undefined) throw new Error("mock calendar recorded no request");
    expect(request.method).toBe("POST");
    expect(request.url).toBe(new URL(cal.url).pathname); // {param}-free template, verbatim path
    expect(request.headers.authorization).toBe(CALENDAR_TOKEN);
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.body).toEqual(BOOKING_ARGS);
    expect(request.rawBody).toBe(JSON.stringify(BOOKING_ARGS));
  });

  it("persists consent, confirmation audit and executed skill_invocation rows", async () => {
    const database = requireDb();
    const call = await pollForDbRow(database, requireCallSid(), "completed");
    expect(call.consent).toBe("granted");
    expect(call.language).toBe("et");
    expect(call.escalated).toBe(false);

    const events = await database
      .selectFrom("call_events")
      .select(["type", "detail"])
      .where("call_id", "=", call.id)
      .execute();
    const types = events.map((e) => e.type);
    expect(types).toContain("consent_granted");

    // The dispatcher's audit row: one executed booking invocation with args.
    const skillEvents = events.filter((e) => e.type === "skill_invocation");
    expect(skillEvents).toHaveLength(1);
    expect(skillEvents[0]?.detail).toEqual({
      skill: "booking",
      args: BOOKING_ARGS,
      outcome: "executed",
    });

    // The confirmation seam's audit row: the caller's affirmative reply.
    const confirmed = events.find((e) => e.type === "confirmation_confirmed");
    expect(confirmed?.detail).toEqual({ skill: "booking" });
    expect(types).not.toContain("confirmation_cancelled");
    expect(types).not.toContain("confirmation_required");
  });

  it("persists post-consent transcript rows only (no consent-window text)", async () => {
    const database = requireDb();
    const call = await pollForDbRow(database, requireCallSid(), "completed");
    const rows = await pollForDb(
      "booking-call transcript rows",
      async () => {
        const all = await database
          .selectFrom("call_transcripts")
          .selectAll()
          .where("call_id", "=", call.id)
          .orderBy("id", "asc")
          .execute();
        const hasRequest = all.some(
          (r) => r.speaker === "caller" && r.text === BOOKING_REQUEST,
        );
        const hasQuestion = all.some(
          (r) => r.speaker === "agent" && r.text === BOOKING_QUESTION,
        );
        return hasRequest && hasQuestion ? all : undefined;
      },
    );

    expect(rows.some((r) => r.speaker === "caller" && r.text === BOOKING_CONFIRM)).toBe(true);
    expect(rows.some((r) => r.speaker === "agent" && r.text === BOOKING_OUTCOME)).toBe(true);
    // The consent window's speech never lands in the transcript.
    expect(rows.some((r) => r.text.includes("Jah, kindlasti"))).toBe(false);
  });

  it("generates a structured note for the booking call", async () => {
    const database = requireDb();
    const call = await pollForDbRow(database, requireCallSid(), "completed");
    const noteRow = await pollForDb("booking-call note row", async () => {
      return database
        .selectFrom("call_notes")
        .selectAll()
        .where("call_id", "=", call.id)
        .executeTakeFirst();
    });

    const parsed = noteSchema.safeParse(noteRow.note);
    if (!parsed.success) {
      throw new Error(`note failed schema validation: ${parsed.error.message}`);
    }
    expect(parsed.data.language).toBe("et");
    expect(parsed.data.summary.length).toBeGreaterThan(0);
    // Nothing forced this note: no escalation happened on the booking call.
    expect(parsed.data.urgency).toBe("normal");
  });
});

/* ------------------------------------- browser-path escalation guardrail (8.2b) */

const ESCALATION_FROM = "+3725550005";
const ESCALATION_REQUEST = "Tahaksin rääkida inimesega";
const ESCALATION_REASON = "Caller asked for a human colleague";

describe.skipIf(!DATABASE_URL)(
  "e2e: browser-path escalation guardrail (tasks 5.3/8.2)",
  () => {
    // Scratch database: the shared `settings` row deletion this suite used to
    // perform (before AND after the run) wiped the operator's saved settings
    // on every full-suite run — the isolated database makes it moot.
    let scratch: ScratchDb | undefined;
    let db: Kysely<Database> | undefined;
    let handle: AppHandle | undefined;
    let tts: ReturnType<typeof makeSilenceTts> | undefined;
    let callSid: string | undefined;
    /** Hangup reason the server ended the driven call with. */
    let hangupReason: string | undefined;

    const requireDb = (): Kysely<Database> => {
      if (db === undefined) throw new Error("database was not initialized");
      return db;
    };
    const requireCallSid = (): string => {
      if (callSid === undefined) throw new Error("callSid was not captured (driver failed?)");
      return callSid;
    };
    const requireTts = (): { spoken: string[] } => {
      if (tts === undefined) throw new Error("tts was not initialized (beforeAll failed?)");
      return tts;
    };

    beforeAll(async () => {
      scratch = await createScratchDb("e2e_escalation_guard");
      db = scratch.db;

      tts = makeSilenceTts();
      const config: AppConfig = configSchema.parse({
        logLevel: "error",
        devBrowserCalls: true,
        admin: { user: "admin", password: ADMIN_PASSWORD },
        notes: { enabled: true },
        // escalation.staffNumber defaults to "" → the announce-and-end path
        // (and a browser transport would skip the REST transfer regardless).
      });

      handle = await buildApp(config, {
        stt: makeScriptedStt([
          {
            afterBytes: CHUNK_BYTES,
            event: { type: "final", text: "Jah, kindlasti", language: "et", confidence: 0.95 },
          },
          {
            afterBytes: 4 * CHUNK_BYTES,
            event: { type: "final", text: ESCALATION_REQUEST, language: "et", confidence: 0.95 },
          },
        ]),
        tts,
        llm: new FakeOpenRouter([
          // The caller asks for a human; the model calls the BUILTIN tool.
          toolCallStream([
            {
              id: "call_esc_1",
              name: "escalate_to_human",
              arguments: JSON.stringify({ reason: ESCALATION_REASON }),
            },
          ]),
        ]),
        db,
      });
      await handle.app.listen({ port: 0, host: "127.0.0.1" });

      const log = makeFrameLog();
      const ws = await openCall(portOf(handle), ESCALATION_FROM, log);
      try {
        await waitForFrame(log.text, "mark", () => true); // notice mark: session wired
        callSid = captureSid(handle);

        // Consent grant → greeting; then the human request → escalation.
        await sendChunks(ws, 1);
        await waitForSpoken(tts, GREETING_TAIL);
        await sendChunks(ws, 3);

        // The server announces the handover and ends the call itself.
        const hangup = await waitForFrame(log.text, "hangup", () => true);
        hangupReason = String(hangup["reason"]);
        await collectUntilClose(ws, log); // server closed the socket
      } finally {
        ws.close();
      }
    });

    afterAll(async () => {
      try {
        if (handle) await handle.close();
      } finally {
        // Dropping the scratch database removes the fixture calls row and
        // everything cascaded to it — no shared-table deletes.
        if (scratch) await scratch.destroy();
      }
    });

    it("speaks the per-language announcement and ends the call", async () => {
      expect(hangupReason).toBe("escalated");
      // The announcement went through the call's normal TTS path, in the
      // locked language (et — voted from the consent reply).
      await waitForSpoken(requireTts(), "ühendan teid nüüd kolleegiga");
      expect(requireTts().spoken.join(" ")).toContain(getEscalationAnnouncement("et"));
      // No tool-loop fallback speech replaced it, and the call was not kept open.
      expect(requireTts().spoken.join(" ")).not.toContain(BOOKING_OUTCOME);
    });

    it("records calls.escalated, the escalation_triggered event and the session flag", async () => {
      const database = requireDb();
      // setCallEscalated + the escalation_triggered event are fire-and-forget
      // writes (src/agent/escalation.ts) that can land just AFTER the row
      // reads "completed" — poll for the settled state instead of asserting
      // on a bare completed row.
      const call = await pollForDb("escalated completed calls row", async () => {
        const row = await database
          .selectFrom("calls")
          .selectAll()
          .where("call_sid", "=", requireCallSid())
          .executeTakeFirst();
        return row !== undefined && row.status === "completed" && row.escalated ? row : undefined;
      });
      expect(call.consent).toBe("granted");

      const events = await pollForDb("escalation call_events rows", async () => {
        const rows = await database
          .selectFrom("call_events")
          .select(["type", "detail"])
          .where("call_id", "=", call.id)
          .execute();
        return rows.some((e) => e.type === "escalation_triggered") ? rows : undefined;
      });
      const types = events.map((e) => e.type);
      const triggered = events.find((e) => e.type === "escalation_triggered");
      expect(triggered?.detail).toEqual({ reason: ESCALATION_REASON });
      // Escalation is the builtin, not a dispatched skill (design D7).
      expect(types).not.toContain("skill_invocation");
      // The call_ended row carries the escalation hangup reason.
      expect(events.find((e) => e.type === "call_ended")?.detail).toEqual({
        reason: "escalated",
      });

      // The session-meta flag the notes pipeline reads was set in-process too.
      const session = requireHandleForEscalation().sessions.get(requireCallSid());
      expect(session?.meta["escalated"]).toBe(true);
    });

    it("forces the stored note's urgency to high with escalation among actions_taken", async () => {
      const database = requireDb();
      const call = await pollForDbRow(database, requireCallSid(), "completed");

      // The note pipeline needs a transcript: the consent-gated call has the
      // caller's human request (and agent speech) persisted.
      const transcripts = await pollForDb("escalation-call transcript rows", async () => {
        const rows = await database
          .selectFrom("call_transcripts")
          .selectAll()
          .where("call_id", "=", call.id)
          .execute();
        return rows.some((r) => r.speaker === "caller" && r.text === ESCALATION_REQUEST)
          ? rows
          : undefined;
      });
      expect(transcripts.length).toBeGreaterThanOrEqual(2); // caller + agent rows

      const noteRow = await pollForDb("escalation-call note row", async () => {
        return database
          .selectFrom("call_notes")
          .selectAll()
          .where("call_id", "=", call.id)
          .executeTakeFirst();
      });
      const parsed = noteSchema.safeParse(noteRow.note);
      if (!parsed.success) {
        throw new Error(`note failed schema validation: ${parsed.error.message}`);
      }
      // The fake summarizer said "normal"; the escalation forced high (D7).
      expect(parsed.data.urgency).toBe("high");
      expect(parsed.data.actions_taken).toContain(ESCALATION_ACTION);
    });

    /** Local alias so the it-blocks read naturally alongside `requireCallSid`. */
    function requireHandleForEscalation(): AppHandle {
      if (handle === undefined) throw new Error("app was not built (beforeAll failed?)");
      return handle;
    }
  },
);
