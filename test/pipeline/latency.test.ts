import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/logging.js";
import { TurnLatencyTracker, logTurn } from "../../src/observability/latency.js";

/** Deterministic clock: every call advances 100 ms. */
function stepClock(stepMs = 100): () => number {
  let t = 0;
  return () => (t += stepMs);
}

function fakeLogger(): Logger & { info: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger & {
    info: ReturnType<typeof vi.fn>;
  };
}

describe("TurnLatencyTracker", () => {
  it("derives stage durations between consecutive marks", () => {
    const tracker = new TurnLatencyTracker(stepClock());
    tracker.markSttFinal(); // t=100, start=100 → sttFinalize 100
    tracker.markLlmFirstToken(); // t=200 → llm 100
    tracker.markTtsFirstByte(); // t=300 → tts 100
    expect(tracker.report()).toEqual({
      sttFinalizeMs: 100,
      llmFirstTokenMs: 100,
      ttsFirstByteMs: 100,
      endToEndMs: 200, // sttFinal → ttsFirstByte
    });
  });

  it("returns null until all three marks are set", () => {
    const tracker = new TurnLatencyTracker(stepClock());
    expect(tracker.report()).toBeNull();
    tracker.markSttFinal();
    expect(tracker.report()).toBeNull();
    tracker.markLlmFirstToken();
    expect(tracker.report()).toBeNull();
    tracker.markTtsFirstByte();
    expect(tracker.report()).not.toBeNull();
  });

  it("marks are first-write-wins (idempotent under repeats)", () => {
    const clock = stepClock();
    const tracker = new TurnLatencyTracker(clock);
    tracker.markSttFinal();
    tracker.markLlmFirstToken();
    tracker.markTtsFirstByte();
    const first = tracker.report();
    tracker.markSttFinal();
    tracker.markTtsFirstByte();
    expect(tracker.report()).toEqual(first);
  });

  it("measures zero-width stages when marks share a timestamp", () => {
    let fixed = 500;
    const tracker = new TurnLatencyTracker(() => fixed);
    tracker.markSttFinal();
    tracker.markLlmFirstToken();
    tracker.markTtsFirstByte();
    expect(tracker.report()).toEqual({
      sttFinalizeMs: 0,
      llmFirstTokenMs: 0,
      ttsFirstByteMs: 0,
      endToEndMs: 0,
    });
    fixed = 900; // late report still reflects the captured marks
    expect(tracker.report()).toEqual({
      sttFinalizeMs: 0,
      llmFirstTokenMs: 0,
      ttsFirstByteMs: 0,
      endToEndMs: 0,
    });
  });
});

describe("logTurn", () => {
  it("emits one structured line with the report and target note", () => {
    const tracker = new TurnLatencyTracker(stepClock());
    tracker.markSttFinal();
    tracker.markLlmFirstToken();
    tracker.markTtsFirstByte();
    const log = fakeLogger();

    logTurn(tracker, log, { callSid: "CA-1", turn: 3 });

    expect(log.info).toHaveBeenCalledTimes(1);
    const [obj, msg] = log.info.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe("turn_latency");
    expect(obj.meta).toEqual({ callSid: "CA-1", turn: 3 });
    expect(obj.sttFinalizeMs).toBe(100);
    expect(obj.llmFirstTokenMs).toBe(100);
    expect(obj.ttsFirstByteMs).toBe(100);
    expect(obj.endToEndMs).toBe(200);
    expect(obj.targetEndToEndMs).toBe(1000);
    expect(obj.meetsTarget).toBe(true); // 200 < 1000
  });

  it("flags turns that miss the endToEnd < 1000 target", () => {
    // endToEnd = 1300 ms > target.
    let t = 0;
    const tracker = new TurnLatencyTracker(() => (t += 650));
    tracker.markSttFinal();
    tracker.markLlmFirstToken();
    tracker.markTtsFirstByte();
    const log = fakeLogger();

    logTurn(tracker, log, { callSid: "CA-2" });

    const [obj] = log.info.mock.calls[0] as [Record<string, unknown>, string];
    expect(obj.endToEndMs).toBe(1300);
    expect(obj.meetsTarget).toBe(false);
  });

  it("logs nothing for an incomplete turn", () => {
    const tracker = new TurnLatencyTracker(stepClock());
    tracker.markSttFinal();
    const log = fakeLogger();

    logTurn(tracker, log, { callSid: "CA-3" });

    expect(log.info).not.toHaveBeenCalled();
  });
});
