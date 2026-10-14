/**
 * Call-start consent flow (design D5, task 4.2) at the composition-root
 * level: buildApp with fake STT/TTS/LLM overrides and a fake transport fed
 * to handle.startCallSession, against real Postgres (skipIf no
 * DATABASE_URL) for the calls.consent + call_events assertions.
 *
 * Scenarios: grant → notice → greeting + consent_granted + calls.consent;
 * decline → goodbye + hangup reason + consent_declined + zero transcripts;
 * unclear → re-ask once → second unclear → declined; barge-in over the
 * notice → replay once → second interruption → declined; toggle-off runs
 * today's ungated flow with no consent artifacts.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp, type AppHandle } from "../../src/app.js";
import {
  getConsentGoodbye,
  getConsentNotice,
  getConsentReask,
  getGreeting,
} from "../../src/agent/prompts/index.js";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import { closeDb, createDb } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { SETTINGS_KEY } from "../../src/db/settings.js";
import type { Database } from "../../src/db/schema.js";
import { getTranscript } from "../../src/db/queries.js";
import {
  OpenRouterClient,
  type ChatOptions,
  type ChatStreamOptions,
  type StreamDelta,
} from "../../src/llm/openrouter.js";
import type { SttEvent, SttProvider, SttStream, SttStreamOptions } from "../../src/stt/types.js";
import type { CallTransport } from "../../src/telephony/transport.js";
import type { CallInfo, Language } from "../../src/types.js";
import type { TtsProvider, TtsStream } from "../../src/tts/types.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "";

/** Caller audio framing: 20 ms of 16 kHz mono PCM16 = 640 bytes. */
const FRAME_BYTES = 640;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/* --------------------------------------------------------- fake providers */

class FakeSttStream implements SttStream {
  closed = false;
  readonly written: Buffer[] = [];
  private listener: ((e: SttEvent) => void) | null = null;

  on(listener: (e: SttEvent) => void): void {
    this.listener = listener;
  }

  write(pcm: Buffer): void {
    this.written.push(pcm);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  /** Test helper: deliver a transcript event to the pipeline. */
  emit(e: Omit<SttEvent, "atMs">): void {
    this.listener?.({ ...e, atMs: Date.now() } as SttEvent);
  }
}

class FakeSttProvider implements SttProvider {
  readonly name = "fake-stt";
  readonly options: SttStreamOptions[] = [];
  readonly streams: FakeSttStream[] = [];

  startStream(opts: SttStreamOptions): FakeSttStream {
    this.options.push(opts);
    const stream = new FakeSttStream();
    this.streams.push(stream);
    return stream;
  }
}

/**
 * TTS that records every spoken sentence and queues a few silent frames so
 * the playback queue stays "active" for a while (barge-in tests raise
 * framesPerSentence to widen that window).
 */
class FakeTtsProvider implements TtsProvider {
  readonly name = "fake-tts";
  readonly sentences: string[] = [];
  framesPerSentence = 4;

  stream(_req: Parameters<TtsProvider["stream"]>[0]): TtsStream {
    const events = new EventEmitter();
    return {
      events,
      push: (text: string): void => {
        this.sentences.push(text);
      },
      end: (): void => {
        for (let i = 0; i < this.framesPerSentence; i += 1) {
          events.emit("audio", Buffer.alloc(FRAME_BYTES, 0));
        }
        events.emit("firstByte", 5);
        setTimeout(() => events.emit("done"), 1);
      },
      close: (): void => {
        // cancellation settles via the pipeline's greeting settlers
      },
    };
  }
}

/** LLM double: deterministic language vote; tiebreaker always says "unclear". */
class FakeLlm extends OpenRouterClient {
  constructor() {
    super({ apiKey: "unit-fake-key" });
  }

  override async chat(opts: ChatOptions): Promise<string> {
    const system = opts.messages.find((m) => m.role === "system")?.content ?? "";
    if (system.includes("yes/no question")) return "unclear"; // affirmation tiebreaker
    if (system.includes("dominant spoken language")) return '{"language":"et","confidence":0.95}';
    if (system.includes("call-notes summarizer")) return "{}"; // notes are off; never hit
    throw new Error(`unexpected chat() prompt: ${system.slice(0, 80)}`);
  }

  override async *chatStream(_opts: ChatStreamOptions): AsyncGenerator<StreamDelta> {
    yield { content: "Selge, kirjas. " };
    yield { content: "Kuidas saan aidata?" };
    yield { finishReason: "stop" };
  }
}

/** Transport double: lets tests inject audio and records outbound events. */
class FakeTransport extends EventEmitter implements CallTransport {
  readonly info: CallInfo;
  ended = false;
  readonly hangups: string[] = [];
  readonly announcements: Record<string, unknown>[] = [];
  flushCount = 0;

  constructor(
    readonly callSid: string,
    from: string,
  ) {
    super();
    this.info = { callSid, from, to: "+37200000000", provider: "browser" };
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  sendAudio(_pcm: Buffer): void {
    // not asserted in this suite
  }

  sendMark(_name: string): void {
    // not asserted in this suite
  }

  flush(): void {
    this.flushCount += 1;
  }

  async hangup(reason: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.hangups.push(reason);
    this.emit("hangup", reason); // like BrowserTransport: local hangup event
  }

  announce(event: Record<string, unknown>): void {
    this.announcements.push(event);
  }

  /** Test helper: simulate inbound caller audio. */
  emitAudio(pcm: Buffer): void {
    if (!this.ended) this.emit("audio", pcm);
  }
}

/* ---------------------------------------------------------------- helpers */

/** One loud 20 ms frame (RMS well above the VAD threshold). */
function loudFrame(): Buffer {
  const pcm = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(3000, i);
  return pcm;
}

const finalEvent = (text: string, language?: Language, confidence?: number) => ({
  type: "final" as const,
  text,
  ...(language === undefined ? {} : { language }),
  ...(confidence === undefined ? {} : { confidence }),
});

/** Everything spoken so far, in order (sentences are chunked from texts). */
const spokenText = (tts: FakeTtsProvider): string => tts.sentences.join(" ");

/** Poll until `probe` returns a value (or time out). */
async function waitFor<T>(desc: string, probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${desc}`);
    await sleep(10);
  }
}

/* ------------------------------------------------------------------ suite */

describe.skipIf(!DATABASE_URL)("app: call-start consent flow (design D5)", () => {
  let db: Kysely<Database>;
  const usedCallSids: string[] = [];
  const openHandles: AppHandle[] = [];

  const requireDb = (): Kysely<Database> => {
    if (db === undefined) throw new Error("database was not initialized");
    return db;
  };

  const makeConfig = (overrides: Record<string, unknown> = {}): AppConfig =>
    configSchema.parse({
      logLevel: "error",
      admin: { user: "admin", password: "unit-admin-password" },
      notes: { enabled: false },
      retention: { enabled: false },
      ...overrides,
    });

  /** Build an app with fake providers on the shared test database. */
  const buildScenario = async (configOverrides: Record<string, unknown> = {}) => {
    const stt = new FakeSttProvider();
    const tts = new FakeTtsProvider();
    const handle = await buildApp(makeConfig(configOverrides), {
      stt,
      tts,
      llm: new FakeLlm(),
      db: requireDb(),
    });
    openHandles.push(handle);
    return { handle, stt, tts };
  };

  const startCall = (handle: AppHandle, callSid: string, from: string): FakeTransport => {
    usedCallSids.push(callSid);
    const transport = new FakeTransport(callSid, from);
    handle.startCallSession(transport);
    return transport;
  };

  const callRow = async (callSid: string) =>
    requireDb().selectFrom("calls").selectAll().where("call_sid", "=", callSid).executeTakeFirst();

  const eventTypes = async (callId: number): Promise<string[]> => {
    const rows = await requireDb()
      .selectFrom("call_events")
      .select(["type", "detail"])
      .where("call_id", "=", callId)
      .execute();
    return rows.map((r) => r.type);
  };

  const consentEventDetail = async (callId: number, type: string): Promise<unknown> => {
    const row = await requireDb()
      .selectFrom("call_events")
      .select("detail")
      .where("call_id", "=", callId)
      .where("type", "=", type)
      .executeTakeFirst();
    return row?.detail;
  };

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    await runMigrations(db);
    // Defaults for the effective-config resolver: a leftover admin-console
    // settings document (e.g. consent disabled) from another suite must not
    // leak into these scenarios.
    await db.deleteFrom("settings").where("key", "=", SETTINGS_KEY).execute();
  });

  afterAll(async () => {
    try {
      while (openHandles.length > 0) await openHandles.pop()?.close();
      if (usedCallSids.length > 0) {
        // calls row delete cascades to transcripts, notes and events.
        await db.deleteFrom("calls").where("call_sid", "in", usedCallSids).execute();
        await db.deleteFrom("settings").where("key", "=", SETTINGS_KEY).execute();
      }
    } finally {
      await closeDb(db);
    }
  });

  it("grant: notice → affirmative → unlocked call, greeting, consent_granted event, calls.consent=granted", async () => {
    const callSid = `unit-${randomUUID()}`;
    const { handle, stt, tts } = await buildScenario();
    const transport = startCall(handle, callSid, "+3725551001");

    // The consent window opens pinned to the notice language and the notice
    // is the FIRST thing spoken — before any greeting.
    await waitFor("consent window", () => (stt.streams.length >= 1 ? true : undefined));
    expect(stt.options[0]).toEqual({ language: "et", sampleRateHz: 16000 });
    await waitFor("notice spoken", () => (tts.sentences.length >= 1 ? true : undefined));
    expect(spokenText(tts)).toBe(getConsentNotice("et"));
    expect(stt.streams).toHaveLength(1); // no main STT stream before the grant

    // Affirmative reply on the ephemeral window → grant → greeting in the
    // notice language (the vote confirms it).
    stt.streams[0]?.emit(finalEvent("Jah, kindlasti", "et", 0.95));
    await waitFor("main STT stream after grant", () => (stt.streams.length >= 2 ? true : undefined));
    await waitFor("greeting spoken", () =>
      spokenText(tts).includes(getGreeting("et")) ? true : undefined,
    );

    const row = await waitFor("calls.consent=granted", async () => {
      const r = await callRow(callSid);
      return r?.consent === "granted" ? r : undefined;
    });
    await waitFor("consent_granted event", async () =>
      (await eventTypes(row.id)).includes("consent_granted") ? true : undefined,
    );

    // The call is live: a normal utterance is transcribed; neither the
    // consent reply nor the notice was ever persisted.
    stt.streams[1]?.emit(finalEvent("Mul on küsimus arve kohta", "et"));
    const transcripts = await waitFor("transcript row", async () => {
      const rows = await getTranscript(db, row.id);
      return rows.some((r) => r.text === "Mul on küsimus arve kohta") ? rows : undefined;
    });
    expect(transcripts.some((r) => r.text.includes("Jah, kindlasti"))).toBe(false);
    expect(transcripts.some((r) => r.text === getConsentNotice("et"))).toBe(false);

    await transport.hangup("client_stop");
    await waitFor("call finalized", async () => {
      const r = await callRow(callSid);
      return r?.status === "completed" ? r : undefined;
    });
    await handle.close();
  });

  it("decline: goodbye + hangup(consent_declined) + consent_declined event + calls.consent=declined + zero transcripts", async () => {
    const callSid = `unit-${randomUUID()}`;
    const { handle, stt, tts } = await buildScenario();
    const transport = startCall(handle, callSid, "+3725551002");

    await waitFor("consent window", () => (stt.streams.length >= 1 ? true : undefined));
    stt.streams[0]?.emit(finalEvent("Ei, ei taha", "et", 0.9));

    await waitFor("decline hangup", () =>
      transport.hangups.includes("consent_declined") ? true : undefined,
    );
    // Goodbye spoken, never a greeting; the ephemeral stream closed and no
    // main stream ever opened.
    expect(spokenText(tts)).toContain(getConsentGoodbye("et"));
    expect(spokenText(tts)).not.toContain(getGreeting("et"));
    expect(stt.streams[0]?.closed).toBe(true);
    expect(stt.streams).toHaveLength(1);

    const row = await waitFor("calls.consent=declined", async () => {
      const r = await callRow(callSid);
      return r?.consent === "declined" ? r : undefined;
    });
    const types = await waitFor("consent_declined event", async () => {
      const names = await eventTypes(row.id);
      return names.includes("consent_declined") ? names : undefined;
    });
    expect(await consentEventDetail(row.id, "consent_declined")).toEqual({ reason: "explicit" });
    expect(types).not.toContain("consent_granted");

    // Nothing about this call was ever transcribed.
    await waitFor("call finalized", async () => {
      const r = await callRow(callSid);
      return r?.status === "completed" ? r : undefined;
    });
    expect(await getTranscript(db, row.id)).toEqual([]);
    await handle.close();
  });

  it("unclear: re-asks once on the same window, then an affirmative reply grants", async () => {
    const callSid = `unit-${randomUUID()}`;
    const { handle, stt, tts } = await buildScenario();
    startCall(handle, callSid, "+3725551003");

    await waitFor("consent window", () => (stt.streams.length >= 1 ? true : undefined));
    stt.streams[0]?.emit(finalEvent("Tere, mul on küsimus arve kohta", "et"));

    await waitFor("re-ask spoken", () =>
      spokenText(tts).includes(getConsentReask("et")) ? true : undefined,
    );
    expect(stt.streams).toHaveLength(1); // same window, still no main stream

    stt.streams[0]?.emit(finalEvent("Jah", "et"));
    await waitFor("main STT stream after grant", () => (stt.streams.length >= 2 ? true : undefined));
    const row = await waitFor("calls.consent=granted", async () => {
      const r = await callRow(callSid);
      return r?.consent === "granted" ? r : undefined;
    });
    expect(await eventTypes(row.id)).toContain("consent_granted");
    await handle.close();
  });

  it("second consecutive unclear reply fails closed: declined, goodbye, hangup", async () => {
    const callSid = `unit-${randomUUID()}`;
    const { handle, stt, tts } = await buildScenario();
    const transport = startCall(handle, callSid, "+3725551004");

    await waitFor("consent window", () => (stt.streams.length >= 1 ? true : undefined));
    stt.streams[0]?.emit(finalEvent("Tere, mul on küsimus arve kohta", "et"));
    await waitFor("re-ask spoken", () =>
      spokenText(tts).includes(getConsentReask("et")) ? true : undefined,
    );
    stt.streams[0]?.emit(finalEvent("mis sa ütlesid? korda", "et"));

    await waitFor("fail-closed hangup", () =>
      transport.hangups.includes("consent_declined") ? true : undefined,
    );
    expect(spokenText(tts)).toContain(getConsentGoodbye("et"));
    const row = await waitFor("calls.consent=declined", async () => {
      const r = await callRow(callSid);
      return r?.consent === "declined" ? r : undefined;
    });
    expect(await consentEventDetail(row.id, "consent_declined")).toEqual({ reason: "unclear_x2" });
    expect(await getTranscript(db, row.id)).toEqual([]);
    await handle.close();
  });

  it("barge-in over the notice replays the notice once, then the reply grants", async () => {
    const callSid = `unit-${randomUUID()}`;
    const { handle, stt, tts } = await buildScenario();
    tts.framesPerSentence = 100; // ~2 s of paced playback per sentence
    const transport = startCall(handle, callSid, "+3725551005");

    await waitFor("consent window", () => (stt.streams.length >= 1 ? true : undefined));
    await sleep(100); // let the notice playback become active
    transport.emitAudio(loudFrame());
    transport.emitAudio(loudFrame()); // VAD onset → barge-in

    // The interrupted window was torn down and the notice replayed once.
    await waitFor("replayed notice window", () => (stt.streams.length >= 2 ? true : undefined));
    expect(stt.streams[0]?.closed).toBe(true);
    await waitFor("notice spoken twice", () =>
      spokenText(tts).split(getConsentNotice("et")).length >= 3 ? true : undefined,
    );

    // The caller answers the replay → grant.
    stt.streams[1]?.emit(finalEvent("Jah, kindlasti", "et", 0.95));
    await waitFor("main STT stream after grant", () => (stt.streams.length >= 3 ? true : undefined));
    const row = await waitFor("calls.consent=granted", async () => {
      const r = await callRow(callSid);
      return r?.consent === "granted" ? r : undefined;
    });
    expect(await eventTypes(row.id)).toContain("consent_granted");
    await handle.close();
  });

  it("a second interruption resolves fail-closed as declined", async () => {
    const callSid = `unit-${randomUUID()}`;
    const { handle, stt, tts } = await buildScenario();
    tts.framesPerSentence = 100;
    const transport = startCall(handle, callSid, "+3725551006");

    await waitFor("consent window", () => (stt.streams.length >= 1 ? true : undefined));
    await sleep(100);
    transport.emitAudio(loudFrame());
    transport.emitAudio(loudFrame());
    await waitFor("replayed notice window", () => (stt.streams.length >= 2 ? true : undefined));
    await sleep(100);
    transport.emitAudio(loudFrame());
    transport.emitAudio(loudFrame()); // second interruption → fail-closed

    await waitFor("fail-closed hangup", () =>
      transport.hangups.includes("consent_declined") ? true : undefined,
    );
    expect(spokenText(tts)).toContain(getConsentGoodbye("et"));
    const row = await waitFor("calls.consent=declined", async () => {
      const r = await callRow(callSid);
      return r?.consent === "declined" ? r : undefined;
    });
    expect(await consentEventDetail(row.id, "consent_declined")).toEqual({ reason: "unresolved" });
    expect(await getTranscript(db, row.id)).toEqual([]);
    await handle.close();
  });

  it("toggle-off (consent.enabled=false): today's flow — immediate greeting, transcript, no consent artifacts", async () => {
    const callSid = `unit-${randomUUID()}`;
    const { handle, stt, tts } = await buildScenario({ consent: { enabled: false } });
    const transport = startCall(handle, callSid, "+3725551007");

    // No consent window: the main STT stream opens immediately, pinned
    // "auto", and the greeting is the very first speech (English until the
    // first utterance is detected).
    await waitFor("main STT stream", () => (stt.streams.length >= 1 ? true : undefined));
    expect(stt.options[0]).toEqual({ language: "auto", sampleRateHz: 16000 });
    await waitFor("greeting spoken", () =>
      spokenText(tts).includes(getGreeting("en")) ? true : undefined,
    );
    expect(spokenText(tts)).not.toContain(getConsentNotice("et"));

    stt.streams[0]?.emit(finalEvent("Mul on küsimus arve kohta", "et"));
    const row = await waitFor("calls row", async () => callRow(callSid));
    const transcripts = await waitFor("transcript row", async () => {
      const rows = await getTranscript(db, row.id);
      return rows.some((r) => r.text === "Mul on küsimus arve kohta") ? rows : undefined;
    });
    expect(transcripts.length).toBeGreaterThanOrEqual(2); // caller final + agent reply

    await transport.hangup("client_stop");
    const finalRow = await waitFor("call finalized", async () => {
      const r = await callRow(callSid);
      return r?.status === "completed" ? r : undefined;
    });
    expect(finalRow.consent ?? null).toBeNull(); // consent never recorded
    const types = await eventTypes(finalRow.id);
    expect(types).toContain("call_started");
    expect(types).toContain("call_ended");
    expect(types).not.toContain("consent_granted");
    expect(types).not.toContain("consent_declined");
    await handle.close();
  });
});
