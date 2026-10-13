import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnergyVAD } from "../../src/audio/vad.js";
import type { Logger } from "../../src/logging.js";
import type { ConversationAgent } from "../../src/pipeline/voice-pipeline.js";
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Drain microtasks (async generator chains) without firing interval timers. */
const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
};

/** Transport double: records outbound audio/marks, lets tests inject caller audio. */
class FakeTransport extends EventEmitter implements CallTransport {
  readonly info: CallInfo = {
    callSid: "CA-test",
    from: "+10000000000",
    to: "+37200000000",
    provider: "browser",
  };
  /** Unified ordered log: "audio:<bytes>" / "mark:<name>" entries. */
  readonly calls: string[] = [];
  readonly sent: Buffer[] = [];
  readonly marks: string[] = [];
  readonly announcements: Record<string, unknown>[] = [];
  flushCount = 0;

  start(): Promise<void> {
    return Promise.resolve();
  }

  sendAudio(pcm: Buffer): void {
    const copy = Buffer.from(pcm);
    this.sent.push(copy);
    this.calls.push(`audio:${copy.length}`);
  }

  sendMark(name: string): void {
    this.marks.push(name);
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

/**
 * TTS stream double: on end() replays scripted audio + firstByte, then defers
 * "done" by one (fake-timer) frame, the way a real provider drains async.
 */
class FakeTtsStream implements TtsStream {
  readonly events = new EventEmitter();
  closed = false;
  ended = false;
  readonly pushed: string[] = [];

  constructor(
    private readonly audio: Buffer[],
    private readonly firstByteMs = 5,
    private readonly doneDelayMs = FRAME_MS,
  ) {}

  push(text: string): void {
    this.pushed.push(text);
  }

  end(): void {
    if (this.ended || this.closed) return;
    this.ended = true;
    for (const pcm of this.audio) this.events.emit("audio", pcm);
    this.events.emit("firstByte", this.firstByteMs);
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
  /** Drain duration; tests can raise it to keep a stream active indefinitely. */
  doneDelayMs = FRAME_MS;
  private chunkValue = 0;

  stream(req: TtsRequest): FakeTtsStream {
    this.requests.push(req);
    // Distinct amplitude per stream so audio order is assertable.
    this.chunkValue += 1000;
    const stream = new FakeTtsStream(
      [pcmWithValue(this.chunkValue, 2 * FRAME_BYTES)],
      5,
      this.doneDelayMs,
    );
    this.streams.push(stream);
    return stream;
  }
}

/** Agent double: scripted token stream, optional injected failure. */
class FakeAgent implements ConversationAgent {
  readonly calls: { text: string; language: Language | null }[] = [];
  readonly languages: (Language | null)[] = [];
  bargeIns = 0;
  closeCount = 0;
  tokens: string[] = [];
  interTokenDelayMs = 0;
  failure: Error | null = null;

  async *handleUtterance(text: string, language: Language | null): AsyncIterable<string> {
    this.calls.push({ text, language });
    if (this.failure) throw this.failure;
    for (let i = 0; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      if (token === undefined) break;
      if (i > 0 && this.interTokenDelayMs > 0) await sleep(this.interTokenDelayMs);
      yield token;
    }
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

type LoggerSpy = Logger & {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
};

const finalEvent = (text: string, language?: Language): SttEvent => ({
  type: "final",
  text,
  ...(language === undefined ? {} : { language }),
  atMs: Date.now(),
});

describe("VoicePipeline", () => {
  let transport: FakeTransport;
  let stt: FakeSttProvider;
  let tts: FakeTtsProvider;
  let agent: FakeAgent;
  let session: CallSession;
  let logger: LoggerSpy;
  let voices: string[];
  let pipeline: VoicePipeline;

  beforeEach(() => {
    vi.useFakeTimers();
    transport = new FakeTransport();
    stt = new FakeSttProvider();
    tts = new FakeTtsProvider();
    agent = new FakeAgent();
    session = new CallSession(transport.info);
    logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as LoggerSpy;
    voices = [];
    // Two sentences, each long enough to clear the chunker's min length.
    agent.tokens = [
      "Hello there, I am your virtual assistant calling",
      " about your request. Please tell me a little more about the problem you are facing.",
    ];
    pipeline = new VoicePipeline({
      transport,
      session,
      stt,
      tts,
      agent,
      logger,
      resolveVoice: (language) => {
        const voice = `voice-${language ?? "auto"}`;
        voices.push(voice);
        return voice;
      },
    });
    pipeline.start();
  });

  afterEach(() => {
    pipeline.close();
    vi.useRealTimers();
  });

  it("opens the initial auto STT stream and forwards caller audio to it", () => {
    expect(stt.options).toEqual([{ language: "auto", sampleRateHz: 16000 }]);

    const frame = pcmWithValue(50);
    transport.emitAudio(frame);
    expect(stt.streams[0]?.written).toEqual([frame]);
  });

  it("setLanguage stores the language, informs the agent, and restarts the stream pinned", () => {
    pipeline.setLanguage("et");

    expect(session.language).toBe("et");
    expect(agent.languages).toEqual(["et"]);
    expect(stt.options[1]).toEqual({ language: "et", sampleRateHz: 16000 });
    expect(stt.streams[0]?.closed).toBe(true);

    pipeline.setLanguage(null);
    expect(stt.options[2]).toEqual({ language: "auto", sampleRateHz: 16000 });
    expect(session.language).toBeNull();
  });

  it("announces partial transcripts", () => {
    stt.streams[0]?.emit({ type: "partial", text: "hel", atMs: Date.now() });
    stt.streams[0]?.emit({ type: "partial", text: "hello", atMs: Date.now() });

    expect(transport.announcements).toEqual([
      { type: "transcript", speaker: "caller", text: "hel", partial: true },
      { type: "transcript", speaker: "caller", text: "hello", partial: true },
    ]);
  });

  it("on a final utterance: records it, calls the agent, and streams reply sentences to TTS", async () => {
    pipeline.setLanguage("et"); // pin the call language; restarts the STT stream
    stt.streams[1]?.emit(finalEvent("Tere, mul on probleem", "et"));
    await settle();

    expect(agent.calls).toEqual([{ text: "Tere, mul on probleem", language: "et" }]);
    expect(session.transcript).toEqual([
      {
        speaker: "caller",
        text: "Tere, mul on probleem",
        language: "et",
        atMs: expect.any(Number),
      },
    ]);
    expect(transport.announcements.at(-1)).toEqual({
      type: "transcript",
      speaker: "caller",
      text: "Tere, mul on probleem",
      partial: false,
    });

    // Both sentences were synthesized with the resolved voice for "et".
    expect(tts.requests).toHaveLength(2);
    expect(tts.requests[0]).toEqual({ language: "et", voiceId: "voice-et" });
    expect(tts.requests[1]).toEqual({ language: "et", voiceId: "voice-et" });
    expect(voices).toEqual(["voice-et", "voice-et"]);
    expect(tts.streams[0]?.pushed[0]).toContain("Hello there");
    expect(tts.streams[1]?.pushed[0]).toContain("Please tell me");
  });

  it("forwards TTS audio to the transport in order and queues one mark per sentence", async () => {
    stt.streams[0]?.emit(finalEvent("hello"));
    await vi.advanceTimersByTimeAsync(200); // 2 sentences × (mark + 2 frames) + done ticks

    const first = pcmWithValue(1000, 2 * FRAME_BYTES);
    const second = pcmWithValue(2000, 2 * FRAME_BYTES);
    expect(Buffer.concat(transport.sent)).toEqual(Buffer.concat([first, second]));

    // Marks: one per turn/sentence, in sentence order.
    expect(transport.marks).toEqual(["t1-s0", "t1-s1"]);

    // Full outbound ordering: each sentence's mark precedes its own audio.
    expect(transport.calls).toEqual([
      "mark:t1-s0",
      "audio:640",
      "audio:640",
      "mark:t1-s1",
      "audio:640",
      "audio:640",
    ]);
  });

  it("emits one turn_latency log line when the first TTS byte arrives", async () => {
    stt.streams[0]?.emit(finalEvent("hello"));
    await settle();

    expect(logger.info).toHaveBeenCalledTimes(1);
    const [obj, msg] = logger.info.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe("turn_latency");
    expect(obj.meta).toEqual({ callSid: "CA-test", turn: 1, sentence: 0 });
    expect(obj.sttFinalizeMs).toEqual(expect.any(Number));
    expect(obj.llmFirstTokenMs).toEqual(expect.any(Number));
    expect(obj.ttsFirstByteMs).toEqual(expect.any(Number));
    expect(obj.endToEndMs).toEqual(expect.any(Number));
    expect(obj.targetEndToEndMs).toBe(1000);

    // The second sentence's first byte does not log a second line.
    await vi.advanceTimersByTimeAsync(200);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  describe("barge-in", () => {
    it("flushes playback, cancels TTS, notifies the agent, and stops the reply", async () => {
      // Second token arrives late, so the reply is still mid-flight when the
      // caller interrupts. Token 1 is a complete sentence, so its audio is
      // already queued (and playing) at interrupt time.
      agent.tokens = [
        "Hello there, I am your virtual assistant calling today.",
        "And this second sentence must never be spoken aloud at all.",
      ];
      agent.interTokenDelayMs = 50;
      // Keep the first stream mid-drain (no "done") so the barge-in cancel
      // path has an active stream to close.
      tts.doneDelayMs = 60_000;

      stt.streams[0]?.emit(finalEvent("hello"));
      await settle(); // first sentence queued; generator parked in sleep(50)

      expect(tts.streams).toHaveLength(1);
      vi.advanceTimersByTime(2 * FRAME_MS); // tick 1: mark fires; tick 2: one frame out
      const sentAtInterrupt = transport.sent.length;
      expect(sentAtInterrupt).toBe(1);
      expect(transport.marks).toEqual(["t1-s0"]);

      // Caller speaks: two loud frames trigger the energy VAD onset.
      const loud = pcmWithValue(3000); // rms ≈ 0.09 ≥ default threshold
      transport.emitAudio(loud);
      expect(agent.bargeIns).toBe(0); // onset needs 2 consecutive loud frames
      transport.emitAudio(loud);

      expect(transport.flushCount).toBe(1);
      expect(agent.bargeIns).toBe(1);
      expect(transport.announcements.at(-1)).toEqual({ type: "status", text: "barge-in" });
      expect(tts.streams[0]?.closed).toBe(true);

      // Let the parked generator resume and the (flushed) queue run: the
      // interrupted reply must not continue and nothing further is sent.
      await vi.advanceTimersByTimeAsync(500);
      expect(tts.streams).toHaveLength(1); // second sentence never synthesized
      expect(transport.marks).toEqual(["t1-s0"]);
      expect(transport.sent).toHaveLength(sentAtInterrupt);
    });

    it("does not consult the VAD while playback is idle", () => {
      const loud = pcmWithValue(3000);
      transport.emitAudio(loud);
      transport.emitAudio(loud);
      expect(agent.bargeIns).toBe(0);
    });

    it("resets the VAD so continued speech does not re-trigger immediately", async () => {
      stt.streams[0]?.emit(finalEvent("hello"));
      await settle();

      const loud = pcmWithValue(3000);
      transport.emitAudio(loud);
      transport.emitAudio(loud);
      expect(agent.bargeIns).toBe(1);
      expect(transport.flushCount).toBe(1);

      // Playback is no longer active → VAD idle → no further barge-ins.
      transport.emitAudio(loud);
      transport.emitAudio(loud);
      expect(agent.bargeIns).toBe(1);
      expect(transport.flushCount).toBe(1);
    });
  });

  it("isolates agent failures: logs, announces error, and keeps the session alive", async () => {
    agent.failure = new Error("llm exploded");
    stt.streams[0]?.emit(finalEvent("first question"));
    await settle();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ callSid: "CA-test", err: agent.failure }),
      "voice_pipeline_error",
    );
    expect(transport.announcements.at(-1)).toEqual({ type: "status", text: "error" });

    // The session survives: a following turn goes through end to end.
    agent.failure = null;
    agent.tokens = ["All good now, everything is fixed and working properly again."];
    stt.streams[0]?.emit(finalEvent("second question"));
    await vi.advanceTimersByTimeAsync(100);
    expect(agent.calls).toHaveLength(2);
    expect(tts.streams).toHaveLength(1);
    expect(transport.marks).toEqual(["t2-s0"]); // next turn, sentence 0
    expect(transport.sent).toHaveLength(2); // fully played out and drained
  });

  it("isolates TTS failures without killing the pipeline", async () => {
    stt.streams[0]?.emit(finalEvent("hello"));
    await settle();

    const failing = tts.streams[0];
    tts.streams.length = 0; // keep assertions clean

    failing?.events.emit("error", new Error("tts socket died"));
    await settle();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "voice_pipeline_error",
    );
    expect(transport.announcements.at(-1)).toEqual({ type: "status", text: "error" });
  });

  it("close() tears down streams, stops playback, detaches listeners, closes the agent", async () => {
    // Park the reply mid-flight so a TTS stream is still active at close().
    // Token 1 is a complete sentence, so its stream exists and is unclosed.
    agent.tokens = [
      "Hello there, I am your virtual assistant calling today.",
      "And this second sentence is never reached, because we close first.",
    ];
    agent.interTokenDelayMs = 50;
    stt.streams[0]?.emit(finalEvent("hello"));
    await settle();
    expect(agent.closeCount).toBe(0);

    pipeline.close();

    expect(stt.streams[0]?.closed).toBe(true);
    expect(tts.streams[0]?.closed).toBe(true); // active stream cancelled
    expect(agent.closeCount).toBe(1);

    const writesBefore = stt.streams[0]?.written.length ?? 0;
    transport.emitAudio(pcmWithValue(1));
    expect(stt.streams[0]?.written).toHaveLength(writesBefore); // listener removed

    // The parked generator resumes after close but must not speak.
    await vi.advanceTimersByTimeAsync(500);
    expect(tts.streams).toHaveLength(1);

    pipeline.close(); // idempotent
    expect(agent.closeCount).toBe(1);
  });

  it("closes itself when the transport hangs up", () => {
    transport.emit("hangup", "caller-ended");
    expect(agent.closeCount).toBe(1);
    expect(stt.streams[0]?.closed).toBe(true);
  });
});

describe("VoicePipeline VAD assumption", () => {
  it("EnergyVAD onset requires consecutive loud frames (used by barge-in tests)", () => {
    const vad = new EnergyVAD();
    const loud = pcmWithValue(3000);
    expect(vad.process(loud)).toEqual({ isSpeech: false, started: false, ended: false });
    expect(vad.process(loud)).toEqual({ isSpeech: true, started: true, ended: false });
  });
});
