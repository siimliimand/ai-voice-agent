/**
 * Consent-gated start (design D5): the pipeline starts without the main STT
 * stream and with the transcript tap locked; an ephemeral consent stream
 * feeds only the grant/decline classifier and the language vote; normal
 * operation unlocks on consentGrant(); decline persists nothing; the
 * toggle-off path is today's exact event order.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/logging.js";
import type {
  ConsentGateOptions,
  ConsentPhaseHandlers,
  ConsentReplyClassifier,
  ConsentUtterance,
  ConsentVerdict,
  ConversationAgent,
  PipelineUtterance,
} from "../../src/pipeline/voice-pipeline.js";
import { VoicePipeline } from "../../src/pipeline/voice-pipeline.js";
import { CallSession } from "../../src/session/call-session.js";
import type { SttEvent, SttProvider, SttStream, SttStreamOptions } from "../../src/stt/types.js";
import type { CallTransport } from "../../src/telephony/transport.js";
import type { CallInfo, Language } from "../../src/types.js";
import type { TtsProvider, TtsRequest, TtsStream } from "../../src/tts/types.js";

const FRAME_MS = 20;
const FRAME_BYTES = 640; // 20 ms at 16 kHz PCM16

/** Constant-amplitude PCM16 buffer (every sample set to `value`). */
function pcmWithValue(value: number, bytes = FRAME_BYTES): Buffer {
  const pcm = Buffer.alloc(bytes);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(value, i);
  return pcm;
}

/** Drain microtasks (async generator chains) without firing interval timers. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
};

/** Transport double: records outbound events, lets tests inject caller audio. */
class FakeTransport extends EventEmitter implements CallTransport {
  readonly info: CallInfo = {
    callSid: "CA-consent",
    from: "+10000000000",
    to: "+37200000000",
    provider: "browser",
  };
  /** Unified ordered log: "audio:<bytes>" / "mark:<name>" entries. */
  readonly calls: string[] = [];
  readonly announcements: Record<string, unknown>[] = [];
  flushCount = 0;

  start(): Promise<void> {
    return Promise.resolve();
  }

  sendAudio(pcm: Buffer): void {
    this.calls.push(`audio:${pcm.length}`);
  }

  sendMark(name: string): void {
    this.calls.push(`mark:${name}`);
  }

  flush(): void {
    this.flushCount += 1;
  }

  hangup(): Promise<void> {
    return Promise.resolve();
  }

  announce(event: Record<string, unknown>): void {
    this.announcements.push(event);
  }

  /** Test helper: simulate inbound caller audio. */
  emitAudio(pcm: Buffer): void {
    this.emit("audio", pcm);
  }
}

/** STT stream double: records writes, replays scripted transcript events. */
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
  emit(e: SttEvent): void {
    this.listener?.(e);
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

/** TTS stream double: on end() queues one audio frame, then defers "done". */
class FakeTtsStream implements TtsStream {
  readonly events = new EventEmitter();
  closed = false;
  ended = false;

  constructor(private readonly doneDelayMs: number) {}

  push(_text: string): void {
    // nothing to record here
  }

  end(): void {
    if (this.ended || this.closed) return;
    this.ended = true;
    this.events.emit("audio", pcmWithValue(1000, 2 * FRAME_BYTES));
    this.events.emit("firstByte", 5);
    setTimeout(() => this.events.emit("done"), this.doneDelayMs);
  }

  close(): void {
    this.closed = true;
  }
}

class FakeTtsProvider implements TtsProvider {
  readonly name = "fake-tts";
  readonly requests: TtsRequest[] = [];
  readonly streams: FakeTtsStream[] = [];
  /** Drain duration; tests can raise it to keep playback active indefinitely. */
  doneDelayMs = FRAME_MS;

  stream(req: TtsRequest): FakeTtsStream {
    this.requests.push(req);
    const stream = new FakeTtsStream(this.doneDelayMs);
    this.streams.push(stream);
    return stream;
  }
}

/** Agent double: scripted token stream; records every utterance it sees. */
class FakeAgent implements ConversationAgent {
  readonly calls: { text: string; language: Language | null }[] = [];
  readonly languages: (Language | null)[] = [];
  bargeIns = 0;
  closeCount = 0;
  tokens: string[] = [
    "Hello there, I am your virtual assistant calling",
    " about your request. Please tell me a little more about the problem you are facing.",
  ];

  async *handleUtterance(text: string, language: Language | null): AsyncIterable<string> {
    this.calls.push({ text, language });
    for (const token of this.tokens) yield token;
  }

  onBargeIn(): void {
    this.bargeIns += 1;
  }

  setLanguage(language: Language | null): void {
    this.languages.push(language);
  }

  close(): void {
    this.closeCount += 1;
  }
}

/** Classifier double (stand-in for the injected AffirmationClassifier). */
class FakeClassifier implements ConsentReplyClassifier {
  readonly calls: { answer: string; language: Language | null }[] = [];
  verdict: ConsentVerdict = "affirmative";
  failure: Error | null = null;

  async decide(answer: string, language: Language | null): Promise<ConsentVerdict> {
    this.calls.push({ answer, language });
    if (this.failure) throw this.failure;
    return this.verdict;
  }
}

type LoggerSpy = Logger & {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
};

const finalEvent = (text: string, language?: Language, confidence?: number): SttEvent => ({
  type: "final",
  text,
  ...(language === undefined ? {} : { language }),
  ...(confidence === undefined ? {} : { confidence }),
  atMs: Date.now(),
});

describe("VoicePipeline consent gate (design D5)", () => {
  let transport: FakeTransport;
  let stt: FakeSttProvider;
  let tts: FakeTtsProvider;
  let agent: FakeAgent;
  let session: CallSession;
  let logger: LoggerSpy;
  /** The transcript tap double: everything the writer WOULD have received. */
  let tap: PipelineUtterance[];

  beforeEach(() => {
    vi.useFakeTimers();
    transport = new FakeTransport();
    stt = new FakeSttProvider();
    tts = new FakeTtsProvider();
    agent = new FakeAgent();
    session = new CallSession(transport.info);
    logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as LoggerSpy;
    tap = [];
  });

  afterEach(() => {
    pipeline?.close();
    vi.useRealTimers();
  });

  let pipeline: VoicePipeline | undefined;

  /** Build + start a pipeline with the suite's shared fakes. */
  function buildPipeline(consentGate?: ConsentGateOptions): VoicePipeline {
    const p = new VoicePipeline({
      transport,
      session,
      stt,
      tts,
      agent,
      logger,
      resolveVoice: (language) => `voice-${language ?? "auto"}`,
      onUtterance: (u) => {
        tap.push(u);
      },
      ...(consentGate === undefined ? {} : { consentGate }),
    });
    p.start();
    pipeline = p;
    return p;
  }

  it("gated start opens no STT stream and transcribes/persists nothing before the decision", async () => {
    const classifier = new FakeClassifier();
    classifier.verdict = "unclear"; // no definitive reply → no unlock path runs
    const gate: ConsentGateOptions = { classifier, initialLanguage: "et" };
    const p = buildPipeline(gate);

    // No stream at all exists before the consent window opens.
    expect(stt.streams).toHaveLength(0);
    expect(stt.options).toHaveLength(0);

    // Caller audio arrives: nothing receives it (no main stream yet).
    transport.emitAudio(pcmWithValue(50));

    // The consent window opens the ONE ephemeral stream, pinned to the
    // notice language.
    const handlers: ConsentPhaseHandlers = {};
    p.beginConsentPhase(handlers);
    expect(stt.streams).toHaveLength(1);
    expect(stt.options[0]).toEqual({ language: "et", sampleRateHz: 16000 });

    // An unclear reply: classified and reported, but nothing is transcribed
    // or persisted — no transcript announcements, no session rows, no tap.
    stt.streams[0]?.emit(finalEvent("Tere, mul on küsimus arve kohta", "et"));
    await settle();

    expect(stt.streams).toHaveLength(1); // still only the ephemeral stream
    expect(stt.streams[0]?.written).toHaveLength(0); // no audio was forwarded before the window
    expect(tap).toEqual([]); // transcript writer never received anything
    expect(session.transcript).toEqual([]); // nothing in-memory either
    expect(agent.calls).toEqual([]); // never reached conversation history
    expect(
      transport.announcements.filter((a) => a["type"] === "transcript"),
    ).toEqual([]); // no live captions before consent
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("affirmative reply reports onDecision(granted); consentGrant() closes the ephemeral stream, opens the main stream, and attaches the tap", async () => {
    const classifier = new FakeClassifier();
    classifier.verdict = "affirmative";
    const p = buildPipeline({ classifier, initialLanguage: "et" });

    const decisions: Array<{ decision: string; utterance: ConsentUtterance }> = [];
    p.beginConsentPhase({
      onDecision: (decision, utterance) => {
        decisions.push({ decision, utterance });
      },
    });

    stt.streams[0]?.emit(finalEvent("Jah, palun", "et"));
    await settle();

    // The decision is reported, but the pipeline does not act on its own:
    // the flow drives consentGrant().
    expect(decisions).toEqual([
      { decision: "granted", utterance: expect.objectContaining({ text: "Jah, palun" }) },
    ]);
    expect(stt.streams).toHaveLength(1); // no main stream before the flow unlocks

    p.consentGrant();

    // Ephemeral stream closed + discarded; the main STT stream is open.
    expect(stt.streams[0]?.closed).toBe(true);
    expect(stt.streams).toHaveLength(2);

    // Normal operation from here: audio is transcribed as today.
    const frame = pcmWithValue(50);
    transport.emitAudio(frame);
    expect(stt.streams[1]?.written).toEqual([frame]);

    stt.streams[1]?.emit(finalEvent("Mul on küsimus arve kohta", "et"));
    await vi.advanceTimersByTimeAsync(300);

    // The pipeline hands the agent the session language (null here — the
    // language vote is what would set it; see the dedicated vote test).
    expect(agent.calls).toEqual([{ text: "Mul on küsimus arve kohta", language: null }]);
    expect(session.transcript).toEqual([
      expect.objectContaining({ speaker: "caller", text: "Mul on küsimus arve kohta" }),
    ]);
    expect(transport.announcements.at(-1)).toEqual({
      type: "transcript",
      speaker: "caller",
      text: "Mul on küsimus arve kohta",
      partial: false,
    });

    // The consent reply itself never reached the transcript tap; everything
    // after the grant does (caller final + both agent sentences).
    const texts = tap.map((u) => `${u.speaker}:${u.text}`);
    expect(texts.some((t) => t.includes("Jah, palun"))).toBe(false);
    expect(texts).toContain("caller:Mul on küsimus arve kohta");
    expect(tap.filter((u) => u.speaker === "agent")).toHaveLength(2);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("decline: the main STT stream never opens and nothing is ever persisted", async () => {
    const classifier = new FakeClassifier();
    classifier.verdict = "decline";
    const p = buildPipeline({ classifier, initialLanguage: "et" });

    const decisions: string[] = [];
    p.beginConsentPhase({
      onDecision: (decision) => {
        decisions.push(decision);
        p.consentDecline();
      },
    });

    stt.streams[0]?.emit(finalEvent("Ei, aitäh", "et"));
    await settle();

    expect(decisions).toEqual(["declined"]);
    expect(stt.streams[0]?.closed).toBe(true); // ephemeral stream closed...
    expect(stt.streams).toHaveLength(1); // ...and no main stream ever opened

    // Audio after the decline goes nowhere; a late ephemeral final is ignored.
    transport.emitAudio(pcmWithValue(50));
    stt.streams[0]?.emit(finalEvent("tere?", "et"));
    await settle();

    expect(tap).toEqual([]);
    expect(session.transcript).toEqual([]);
    expect(agent.calls).toEqual([]);
    expect(
      transport.announcements.filter((a) => a["type"] === "transcript"),
    ).toEqual([]);
    expect(decisions).toEqual(["declined"]); // decided exactly once
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("ephemeral text feeds the normal language vote and the grant opens the stream pinned to it", async () => {
    const classifier = new FakeClassifier();
    classifier.verdict = "affirmative";
    const languageVote = vi.fn(async (): Promise<Language | null> => "ru");
    const p = buildPipeline({ classifier, initialLanguage: "et", languageVote });

    p.beginConsentPhase({});
    stt.streams[0]?.emit(finalEvent("да, хорошо", "ru", 0.9));
    await settle();

    // Same shape the first normal utterance feeds LanguageManager with.
    expect(languageVote).toHaveBeenCalledWith("да, хорошо", { language: "ru", confidence: 0.9 });
    // Vote applied to session + agent (no stream restart — none exists yet).
    expect(session.language).toBe("ru");
    expect(agent.languages).toContain("ru");

    p.consentGrant();
    expect(stt.options[1]).toEqual({ language: "ru", sampleRateHz: 16000 });
  });

  it("reports unclear replies via onReply (re-ask primitive) and decides exactly once", async () => {
    const classifier = new FakeClassifier();
    classifier.verdict = "unclear";
    const p = buildPipeline({ classifier, initialLanguage: "en" });

    const replies: ConsentVerdict[] = [];
    const decisions: string[] = [];
    p.beginConsentPhase({
      onReply: (reply) => {
        replies.push(reply.verdict);
      },
      onDecision: (decision) => {
        decisions.push(decision);
      },
    });

    stt.streams[0]?.emit(finalEvent("uh, what?"));
    await settle();
    expect(replies).toEqual(["unclear"]);
    expect(decisions).toEqual([]); // the flow re-asks; the pipeline waits

    // The caller answers the re-ask affirmatively → the decision fires once.
    classifier.verdict = "affirmative";
    stt.streams[0]?.emit(finalEvent("yes sure"));
    await settle();
    expect(replies).toEqual(["unclear", "affirmative"]);
    expect(decisions).toEqual(["granted"]);

    // Post-decision replies are ignored (no duplicate decisions).
    stt.streams[0]?.emit(finalEvent("yes yes"));
    await settle();
    expect(decisions).toEqual(["granted"]);
  });

  it("classifies a failing classifier fail-closed to unclear — never grants", async () => {
    const classifier = new FakeClassifier();
    classifier.failure = new Error("utility model down");
    const p = buildPipeline({ classifier, initialLanguage: "et" });

    const decisions: string[] = [];
    const replies: ConsentVerdict[] = [];
    p.beginConsentPhase({
      onReply: (reply) => replies.push(reply.verdict),
      onDecision: (decision) => decisions.push(decision),
    });

    stt.streams[0]?.emit(finalEvent("jah jah"));
    await settle();

    expect(replies).toEqual(["unclear"]);
    expect(decisions).toEqual([]);
    expect(logger.error).toHaveBeenCalled(); // the failure is reported...
    expect(stt.streams).toHaveLength(1); // ...but nothing unlocked, nothing persisted
    expect(tap).toEqual([]);
  });

  it("barge-in during the consent window tears the ephemeral stream down cleanly", async () => {
    const classifier = new FakeClassifier();
    const p = buildPipeline({ classifier, initialLanguage: "et" });
    tts.doneDelayMs = 60_000; // keep the notice playback active

    p.beginConsentPhase({});
    void p.speakGreeting(
      "This notice is spoken before anything at all is transcribed or stored.",
    );
    await settle();
    vi.advanceTimersByTime(2 * FRAME_MS); // one paced frame out → playback active
    expect(stt.streams[0]?.closed).toBe(false);

    // Caller talks over the notice: two loud frames trigger the VAD onset.
    const loud = pcmWithValue(3000);
    transport.emitAudio(loud);
    transport.emitAudio(loud);

    expect(transport.flushCount).toBe(1);
    expect(stt.streams[0]?.closed).toBe(true); // ephemeral stream torn down
    expect(stt.streams).toHaveLength(1); // main stream still does not exist
    expect(logger.error).not.toHaveBeenCalled();

    // Subsequent audio is simply dropped — no errors, no transcription.
    transport.emitAudio(pcmWithValue(50));
    stt.streams[0]?.emit(finalEvent("hello?"));
    await settle();
    expect(logger.error).not.toHaveBeenCalled();
    expect(tap).toEqual([]);

    // The window is restartable (the re-ask path after an interruption).
    p.beginConsentPhase({});
    expect(stt.streams).toHaveLength(2);
    expect(stt.streams[1]?.closed).toBe(false);
  });

  it("close() during the consent window closes the ephemeral stream without errors", async () => {
    const classifier = new FakeClassifier();
    const p = buildPipeline({ classifier, initialLanguage: "et" });
    p.beginConsentPhase({});

    p.close();
    expect(stt.streams[0]?.closed).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();

    // Events after close are ignored (listener detached, guards hold).
    transport.emitAudio(pcmWithValue(50));
    stt.streams[0]?.emit(finalEvent("jah"));
    await settle();
    expect(tap).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("consentGrant() is idempotent and a no-op on an ungated pipeline", () => {
    // Ungated: start() opens the main stream immediately, and the consent
    // API cannot disturb normal operation.
    const ungated = buildPipeline(undefined);
    expect(stt.options[0]).toEqual({ language: "auto", sampleRateHz: 16000 });
    ungated.consentGrant();
    ungated.consentDecline();
    ungated.beginConsentPhase({});
    expect(stt.streams).toHaveLength(1); // no restart, no extra stream
    expect(stt.streams[0]?.closed).toBe(false);
    ungated.close();

    // Gated: a double grant must not restart the main stream.
    stt.streams.length = 0;
    stt.options.length = 0;
    const gated = buildPipeline({ classifier: new FakeClassifier(), initialLanguage: "et" });
    gated.consentGrant();
    gated.consentGrant();
    expect(stt.streams).toHaveLength(1);
    gated.close();
  });

  it("cancelConsentPhase() tears the window down but keeps the grant possible", async () => {
    const classifier = new FakeClassifier();
    const p = buildPipeline({ classifier, initialLanguage: "et" });
    p.beginConsentPhase({});

    p.cancelConsentPhase();
    expect(stt.streams[0]?.closed).toBe(true);

    // Timeout-style cancel does not settle the phase: grant still unlocks.
    p.consentGrant();
    expect(stt.streams).toHaveLength(2);
    expect(tap).toEqual([]);
  });

  it("toggle-off: the ungated flow and a gated flow after the grant produce identical event order", async () => {
    const runNormalTraffic = async (mainStream: FakeSttStream): Promise<void> => {
      const frame = pcmWithValue(50);
      transport.emitAudio(frame);
      mainStream.emit(finalEvent("Mul on küsimus arve kohta", "et"));
      await vi.advanceTimersByTimeAsync(300);
    };

    // --- Toggle OFF: today's exact flow.
    const ungated = buildPipeline(undefined);
    expect(stt.options[0]).toEqual({ language: "auto", sampleRateHz: 16000 });
    await runNormalTraffic(stt.streams[0]!);
    const ungatedCalls = [...transport.calls];
    const ungatedAnnouncements = transport.announcements.map((a) => ({ ...a }));
    const ungatedTap = [...tap];
    const ungatedTranscriptLength = session.transcript.length;
    ungated.close();

    // --- Toggle ON: gated start, ephemeral grant, then the same traffic.
    transport.calls.length = 0;
    transport.announcements.length = 0;
    stt.streams.length = 0;
    stt.options.length = 0;
    tap = [];
    const classifier = new FakeClassifier();
    classifier.verdict = "affirmative";
    const gated = buildPipeline({
      classifier,
      // null vote → session.language stays null → main stream opens "auto",
      // matching the toggle-off run exactly.
      languageVote: async () => null,
    });
    gated.beginConsentPhase({
      onDecision: (decision) => {
        if (decision === "granted") gated.consentGrant();
      },
    });
    expect(stt.streams).toHaveLength(1); // consent window only
    expect(transport.calls).toEqual([]); // and no outbound events from it
    stt.streams[0]?.emit(finalEvent("Jah, palun", "et"));
    await settle();
    expect(stt.streams).toHaveLength(2);
    expect(stt.options[1]).toEqual({ language: "auto", sampleRateHz: 16000 });

    await runNormalTraffic(stt.streams[1]!);

    // Identical outbound event order, byte for byte.
    expect(transport.calls).toEqual(ungatedCalls);
    expect(transport.announcements).toEqual(ungatedAnnouncements);
    // Identical persisted transcript shape (the consent reply is absent
    // from BOTH runs' persisted output; atMs is wall-clock under fake
    // timers and legitimately differs between the two runs).
    const shape = (list: PipelineUtterance[]) =>
      list.map((u) => ({ speaker: u.speaker, text: u.text, language: u.language ?? null }));
    expect(shape(tap)).toEqual(shape(ungatedTap));
    expect(tap.every((u) => u.speaker === "caller" || u.speaker === "agent")).toBe(true);
    // The session transcript grows by exactly the post-grant utterance —
    // the consent reply never entered it (the session is shared across the
    // two runs of this test, hence the delta assertion).
    expect(session.transcript.length).toBe(ungatedTranscriptLength + 1);
    expect(session.transcript.at(-1)).toEqual(
      expect.objectContaining({ speaker: "caller", text: "Mul on küsimus arve kohta" }),
    );
    expect(session.transcript.some((u) => u.text.includes("Jah, palun"))).toBe(false);
    gated.close();
  });
});
