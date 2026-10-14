import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/logging.js";
import { LATENCY_STAGES, MetricsRegistry } from "../../src/observability/metrics.js";
import type { ConversationAgent } from "../../src/pipeline/voice-pipeline.js";
import { VoicePipeline } from "../../src/pipeline/voice-pipeline.js";
import { CallSession } from "../../src/session/call-session.js";
import type { SttEvent, SttProvider, SttStream, SttStreamOptions } from "../../src/stt/types.js";
import type { CallTransport } from "../../src/telephony/transport.js";
import type { CallInfo } from "../../src/types.js";
import type { TtsProvider, TtsRequest, TtsStream } from "../../src/tts/types.js";

/**
 * Wiring tests: the MetricsRegistry is fed from the VoicePipeline's existing
 * TurnLatencyTracker hook and reportError catch points (design D10). Fakes
 * are minimal versions of the ones in test/pipeline/voice-pipeline.test.ts.
 */

/** Drain every pending microtask/immidiate of one turn. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

class FakeTransport extends EventEmitter implements CallTransport {
  readonly info: CallInfo = {
    callSid: "CA-metrics",
    from: "+10000000000",
    provider: "browser",
  };
  readonly announcements: Record<string, unknown>[] = [];
  start(): Promise<void> {
    return Promise.resolve();
  }
  sendAudio(): void {}
  sendMark(): void {}
  flush(): void {}
  hangup(): Promise<void> {
    return Promise.resolve();
  }
  announce(event: Record<string, unknown>): void {
    this.announcements.push(event);
  }
  /** Test helper: inbound caller audio. */
  emitAudio(pcm: Buffer): void {
    this.emit("audio", pcm);
  }
}

class FakeSttStream implements SttStream {
  closed = false;
  throwOnWrite = false;
  private listener: ((e: SttEvent) => void) | null = null;
  on(listener: (e: SttEvent) => void): void {
    this.listener = listener;
  }
  write(): void {
    if (this.throwOnWrite) throw new Error("stt write boom");
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  emitFinal(text: string): void {
    this.listener?.({ type: "final", text, atMs: Date.now() });
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

/** TTS stream whose whole lifecycle fires synchronously on end(). */
class FakeTtsStream implements TtsStream {
  readonly events = new EventEmitter();
  closed = false;
  private ended = false;
  push(): void {}
  end(): void {
    if (this.ended || this.closed) return;
    this.ended = true;
    this.events.emit("audio", Buffer.alloc(2));
    this.events.emit("firstByte", 1);
    this.events.emit("done");
  }
  close(): void {
    this.closed = true;
  }
}

class FakeTtsProvider implements TtsProvider {
  readonly name = "fake-tts";
  readonly streams: FakeTtsStream[] = [];
  stream(_req: TtsRequest): FakeTtsStream {
    const stream = new FakeTtsStream();
    this.streams.push(stream);
    return stream;
  }
}

class FakeAgent implements ConversationAgent {
  failure: Error | null = null;
  closeCount = 0;
  async *handleUtterance(): AsyncGenerator<string> {
    if (this.failure) throw this.failure;
    yield "This is a complete sentence long enough for the chunker to release.";
  }
  onBargeIn(): void {}
  setLanguage(): void {}
  close(): void {
    this.closeCount += 1;
  }
}

describe("VoicePipeline → MetricsRegistry wiring", () => {
  let transport: FakeTransport;
  let stt: FakeSttProvider;
  let tts: FakeTtsProvider;
  let agent: FakeAgent;
  let metrics: MetricsRegistry;
  let pipeline: VoicePipeline;

  beforeEach(() => {
    transport = new FakeTransport();
    stt = new FakeSttProvider();
    tts = new FakeTtsProvider();
    agent = new FakeAgent();
    metrics = new MetricsRegistry();
    const logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    pipeline = new VoicePipeline({
      transport,
      session: new CallSession(transport.info),
      stt,
      tts,
      agent,
      resolveVoice: () => "voice-en",
      logger,
      metrics,
    });
    pipeline.start();
  });

  afterEach(() => {
    pipeline.close();
  });

  it("samples all four stage rings once for a completed turn", async () => {
    stt.streams[0]?.emitFinal("hello there");
    await settle();

    const latency = metrics.snapshot().latency;
    for (const stage of LATENCY_STAGES) {
      const stats = latency[stage];
      expect(stats?.count).toBe(1);
      expect(stats?.p50).toBeTypeOf("number");
      expect(stats?.p95).toBe(stats?.p50); // single sample → p50 === p95
    }
  });

  it("keeps sampling across turns", async () => {
    stt.streams[0]?.emitFinal("first utterance");
    await settle();
    stt.streams[0]?.emitFinal("second utterance");
    await settle();

    for (const stage of LATENCY_STAGES) {
      expect(metrics.snapshot().latency[stage]?.count).toBe(2);
    }
  });

  it("counts agent reply failures as llm errors", async () => {
    agent.failure = new Error("llm down");
    stt.streams[0]?.emitFinal("hello there");
    await settle();

    const errors = metrics.snapshot().errors;
    expect(errors.llm).toBe(1);
    expect(errors.pipeline).toBe(0);
    expect(errors.stream).toBe(0);
    expect(transport.announcements.at(-1)).toEqual({ type: "status", text: "error" });
  });

  it("counts TTS stream failures as stream errors", async () => {
    stt.streams[0]?.emitFinal("hello there");
    await settle();
    tts.streams[0]?.events.emit("error", new Error("tts socket died"));
    await settle();

    expect(metrics.snapshot().errors.stream).toBe(1);
  });

  it("counts handler failures at the transport/STT boundary as pipeline errors", async () => {
    stt.streams[0]!.throwOnWrite = true;
    transport.emitAudio(Buffer.alloc(4));
    transport.emitAudio(Buffer.alloc(4));

    const errors = metrics.snapshot().errors;
    expect(errors.pipeline).toBe(2);
    expect(errors.llm).toBe(0);
  });

  it("records nothing when no turn has completed", () => {
    const latency = metrics.snapshot().latency;
    for (const stage of LATENCY_STAGES) expect(latency[stage]?.count).toBe(0);
  });
});
