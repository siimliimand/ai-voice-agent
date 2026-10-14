/**
 * Task 5.3: the browser/dev escalation path (design D7) at the composition
 * root. A REAL BrowserTransport (over a minimal fake ws socket) is wired
 * through buildApp → startCallSession exactly like the dev media route does;
 * the scripted LLM emits a real `escalate_to_human` tool-call delta flow and
 * the test asserts the full browser path:
 *
 *   tool call → escalation handler → per-language announcement spoken through
 *   the call's normal TTS path → session meta flagged → transport.hangup
 *   ("escalated" control frame + close 1000) → calls.escalated +
 *   escalation_triggered persisted (DATABASE_URL-gated describe below).
 *
 * No Twilio transfer step can run here: the transport provider is "browser"
 * and escalation.staffNumber defaults to "" — the handler goes straight to
 * the announce-and-end base behavior.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { getEscalationAnnouncement } from "../../src/agent/prompts/index.js";
import { buildApp, type AppHandle } from "../../src/app.js";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import type { Database } from "../../src/db/schema.js";
import {
  OpenRouterClient,
  type ChatOptions,
  type ChatStreamOptions,
  type StreamDelta,
} from "../../src/llm/openrouter.js";
import {
  BrowserTransport,
  makeBrowserCallInfo,
} from "../../src/telephony/browser-transport.js";
import type { SttEvent, SttProvider, SttStream, SttStreamOptions } from "../../src/stt/types.js";
import type { TtsProvider, TtsStream } from "../../src/tts/types.js";
import { createScratchDb, type ScratchDb } from "../helpers/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "";

const ESCALATION_REASON = "caller asked for a human";
const CALLER_REQUEST = "I want to talk to a human, please";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Poll until `probe` returns a value (bounded). */
async function waitFor<T>(desc: string, probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${desc}`);
    await sleep(10);
  }
}

/* --------------------------------------------------------- fake providers */

/**
 * Minimal ws-WebSocket double: records outgoing control (JSON text) frames
 * and the close handshake; binary agent audio is counted only.
 */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly textFrames: Array<Record<string, unknown>> = [];
  binaryFrames = 0;
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;

  send(data: Buffer | string, opts?: { binary?: boolean }): void {
    if (opts?.binary === true) {
      this.binaryFrames += 1;
      return;
    }
    try {
      this.textFrames.push(JSON.parse(String(data)) as Record<string, unknown>);
    } catch {
      this.textFrames.push({ raw: String(data) });
    }
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }

  terminate(): void {
    this.closed = true;
  }
}

class FakeSttStream implements SttStream {
  closed = false;
  private listener: ((e: SttEvent) => void) | null = null;

  on(listener: (e: SttEvent) => void): void {
    this.listener = listener;
  }

  write(_pcm: Buffer): void {
    // utterances are injected via emit(); no audio recognition here
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  /** Test helper: deliver one transcript event to the pipeline. */
  emit(e: Omit<SttEvent, "atMs">): void {
    this.listener?.({ ...e, atMs: Date.now() } as SttEvent);
  }
}

class FakeSttProvider implements SttProvider {
  readonly name = "fake-stt";
  readonly streams: FakeSttStream[] = [];

  startStream(_opts: SttStreamOptions): FakeSttStream {
    const stream = new FakeSttStream();
    this.streams.push(stream);
    return stream;
  }
}

/** TTS that records every spoken sentence and queues a few silent frames. */
class FakeTtsProvider implements TtsProvider {
  readonly name = "fake-tts";
  readonly sentences: string[] = [];

  stream(_req: Parameters<TtsProvider["stream"]>[0]): TtsStream {
    const events = new EventEmitter();
    return {
      events,
      push: (text: string): void => {
        this.sentences.push(text);
      },
      end: (): void => {
        for (let i = 0; i < 4; i += 1) events.emit("audio", Buffer.alloc(640, 0));
        events.emit("firstByte", 5);
        setTimeout(() => events.emit("done"), 1);
      },
      close: (): void => undefined,
    };
  }
}

/**
 * LLM double: the conversation stream ALWAYS escalates (a real tool-call
 * delta flow — fragments streamed, then assembled on the finish delta);
 * chat() answers the utility prompts (detection votes "en").
 */
class EscalatingLlm extends OpenRouterClient {
  constructor() {
    super({ apiKey: "unit-fake-key" });
  }

  override async chat(opts: ChatOptions): Promise<string> {
    const system = opts.messages.find((m) => m.role === "system")?.content ?? "";
    if (system.includes("dominant spoken language")) return '{"language":"en","confidence":0.9}';
    if (system.includes("yes/no question")) return "unclear";
    if (system.includes("call-notes summarizer")) return "{}"; // notes off; never hit
    throw new Error(`unexpected chat() prompt: ${system.slice(0, 80)}`);
  }

  override async *chatStream(_opts: ChatStreamOptions): AsyncGenerator<StreamDelta> {
    yield {
      toolCalls: [
        {
          index: 0,
          id: "call_e1",
          type: "function",
          function: {
            name: "escalate_to_human",
            arguments: JSON.stringify({ reason: ESCALATION_REASON }),
          },
        },
      ],
    };
    yield {
      finishReason: "tool_calls",
      completedToolCalls: [
        { id: "call_e1", name: "escalate_to_human", arguments: JSON.stringify({ reason: ESCALATION_REASON }) },
      ],
    };
  }
}

/* --------------------------------------------------------------- scenario */

interface EscalationScenario {
  handle: AppHandle;
  tts: FakeTtsProvider;
  transport: BrowserTransport;
  socket: FakeSocket;
  callSid: string;
  /** Reasons observed on the transport's "hangup" event, in order. */
  hangups: string[];
}

/**
 * Build an app (test-provider overrides, optional db) and drive one consent
 * free browser call until the server escalates and ends it.
 */
async function runEscalationCall(db?: Kysely<Database>): Promise<EscalationScenario> {
  const config: AppConfig = configSchema.parse({
    logLevel: "error",
    admin: { user: "admin", password: "unit-admin-password" },
    notes: { enabled: false },
    consent: { enabled: false },
    retention: { enabled: false },
  });
  const stt = new FakeSttProvider();
  const tts = new FakeTtsProvider();
  const handle = await buildApp(config, {
    stt,
    tts,
    llm: new EscalatingLlm(),
    ...(db ? { db } : {}),
  });

  // Real transport over the fake socket, named like the dev route names one.
  const socket = new FakeSocket();
  const callSid = `dev-unit-${randomUUID()}`;
  const info = makeBrowserCallInfo(config, { type: "start", from: "+3725552001" });
  const transport = new BrowserTransport(socket as unknown as WebSocket, {
    ...info,
    callSid,
  });
  const hangups: string[] = [];
  transport.on("hangup", (reason: string) => hangups.push(reason));
  handle.startCallSession(transport);

  // Consent is off → the greeting is the first speech once wiring finished.
  await waitFor("greeting spoken (session wired)", () =>
    tts.sentences.some((s) => s.includes("how can I help you today")) ? true : undefined,
  );

  // The caller asks for a human; the scripted model calls the builtin.
  transport.feedAudio(Buffer.alloc(640, 0));
  stt.streams[0]?.emit({ type: "final", text: CALLER_REQUEST, confidence: 0.95 });

  await waitFor("escalation hangup control frame", () => {
    const frame = socket.textFrames.find((m) => m["type"] === "hangup");
    return frame !== undefined && frame["reason"] === "escalated" ? true : undefined;
  });
  return { handle, tts, transport, socket, callSid, hangups };
}

/* ------------------------------------------------------------------ suite */

describe("browser-transport escalation path (task 5.3)", () => {
  it("speaks the announcement, flags the session and ends the call", async () => {
    const { handle, tts, socket, callSid, hangups } = await runEscalationCall();
    try {
      // The per-language announcement went through the normal TTS path —
      // "en" (the vote from the scripted detection; the composition root
      // passes no getLanguage, so the handler reads session.language).
      expect(tts.sentences.join(" ")).toContain(getEscalationAnnouncement("en"));

      // The call ended through the transport: hangup event, the "escalated"
      // control frame (already waited for) and a clean socket close.
      expect(hangups).toEqual(["escalated"]);
      const frame = socket.textFrames.find((m) => m["type"] === "hangup");
      expect(frame).toMatchObject({ type: "hangup", reason: "escalated" });
      expect(socket.closed).toBe(true);
      expect(socket.closeCode).toBe(1000);
      expect(socket.closeReason).toBe("escalated");

      // The session flag the notes pipeline reads was set in-process.
      expect(handle.sessions.get(callSid)?.meta["escalated"]).toBe(true);
    } finally {
      await handle.close();
    }
  });
});

describe.skipIf(!DATABASE_URL)(
  "browser-transport escalation path persists the flag (task 5.3)",
  () => {
    // Scratch database — this suite used to delete the shared `settings` row
    // (key='global') on DATABASE_URL before and after the test, wiping the
    // operator's saved settings on every run (the incident). The isolated
    // database also keeps the calls/call_events fixture rows private.
    let scratch: ScratchDb;
    let db: Kysely<Database>;

    beforeAll(async () => {
      scratch = await createScratchDb("browser_escalation");
      db = scratch.db;
    });

    afterAll(async () => {
      if (scratch) await scratch.destroy();
    });

    it("sets calls.escalated and writes the escalation_triggered event", async () => {
      const { handle, tts, callSid } = await runEscalationCall(db);
      try {
        expect(tts.sentences.join(" ")).toContain(getEscalationAnnouncement("en"));

        const row = await waitFor("calls.escalated=true row", async () => {
          const r = await db
            .selectFrom("calls")
            .selectAll()
            .where("call_sid", "=", callSid)
            .executeTakeFirst();
          return r !== undefined && r.escalated && r.status === "completed" ? r : undefined;
        });

        // The call_ended event is inserted fire-and-forget right AFTER the
        // calls row is finalized (which the waitFor above resolves on) —
        // poll for it instead of racing the two-step finalization.
        const events = await waitFor("call_ended event row", async () => {
          const rows = await db
            .selectFrom("call_events")
            .select(["type", "detail"])
            .where("call_id", "=", row.id)
            .execute();
          return rows.some((e) => e.type === "call_ended") ? rows : undefined;
        });
        const types = events.map((e) => e.type);
        expect(types).toContain("escalation_triggered");
        expect(events.find((e) => e.type === "escalation_triggered")?.detail).toEqual({
          reason: ESCALATION_REASON,
        });
        // Escalation is the builtin, never a dispatched skill (design D7).
        expect(types).not.toContain("skill_invocation");
        // The call was finalized with the escalation hangup reason.
        expect(events.find((e) => e.type === "call_ended")?.detail).toEqual({
          reason: "escalated",
        });
      } finally {
        await handle.close();
      }
    });
  },
);
