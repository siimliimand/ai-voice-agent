import { describe, expect, it } from "vitest";
import {
  attachSessionMetrics,
  ERROR_CATEGORIES,
  LATENCY_STAGES,
  MetricsRegistry,
  RING_CAPACITY,
} from "../../src/observability/metrics.js";
import { CallSession } from "../../src/session/call-session.js";
import { CallSessionManager } from "../../src/session/manager.js";
import type { CallStatus } from "../../src/types.js";

const stageStats = (
  registry: MetricsRegistry,
  stage: (typeof LATENCY_STAGES)[number],
): { count: number; p50: number | null; p95: number | null } => registry.snapshot().latency[stage];

describe("MetricsRegistry latency rings", () => {
  it("reports count 0 and null percentiles for an empty ring", () => {
    const registry = new MetricsRegistry();
    expect(stageStats(registry, "stt_finalize")).toEqual({ count: 0, p50: null, p95: null });
  });

  it("computes exact nearest-rank p50/p95 for an odd sample count", () => {
    const registry = new MetricsRegistry();
    for (const ms of [10, 20, 30, 40, 50]) registry.recordLatency("llm_first_token", ms);
    // p50: rank ceil(0.5·5)=3 → 30; p95: rank ceil(0.95·5)=5 → 50.
    expect(stageStats(registry, "llm_first_token")).toEqual({ count: 5, p50: 30, p95: 50 });
  });

  it("computes exact nearest-rank p50/p95 for an even sample count", () => {
    const registry = new MetricsRegistry();
    for (const ms of [10, 20, 30, 40]) registry.recordLatency("tts_first_byte", ms);
    // p50: rank ceil(0.5·4)=2 → 20 (nearest-rank lower median); p95: ceil(0.95·4)=4 → 40.
    expect(stageStats(registry, "tts_first_byte")).toEqual({ count: 4, p50: 20, p95: 40 });
  });

  it("sorts internally regardless of insertion order", () => {
    const registry = new MetricsRegistry();
    for (const ms of [30, 10, 20]) registry.recordLatency("end_to_end", ms);
    expect(stageStats(registry, "end_to_end")).toEqual({ count: 3, p50: 20, p95: 30 });
  });

  it("returns the sample itself when the ring holds a single value", () => {
    const registry = new MetricsRegistry();
    registry.recordLatency("stt_finalize", 42.5);
    expect(stageStats(registry, "stt_finalize")).toEqual({ count: 1, p50: 42.5, p95: 42.5 });
  });

  it("bounds the ring at RING_CAPACITY, dropping the oldest samples", () => {
    const registry = new MetricsRegistry();
    for (let ms = 1; ms <= RING_CAPACITY + 100; ms++) {
      registry.recordLatency("end_to_end", ms);
    }
    // Ring now holds 101..600 (n=500): p50 rank 250 → 350, p95 rank 475 → 575;
    // the oldest 100 samples (1..100) are gone.
    expect(stageStats(registry, "end_to_end")).toEqual({ count: RING_CAPACITY, p50: 350, p95: 575 });

    // Further inserts keep the ring bounded and advance the window.
    registry.recordLatency("end_to_end", 601);
    expect(stageStats(registry, "end_to_end").count).toBe(RING_CAPACITY);
    expect(stageStats(registry, "end_to_end").p50).toBe(351); // 102..601
  });

  it("keeps one bounded ring per stage", () => {
    const registry = new MetricsRegistry();
    for (const stage of LATENCY_STAGES) registry.recordLatency(stage, 100);
    const latency = registry.snapshot().latency;
    expect(Object.keys(latency).sort()).toEqual([...LATENCY_STAGES].sort());
    for (const stage of LATENCY_STAGES) expect(latency[stage]).toEqual({ count: 1, p50: 100, p95: 100 });
  });

  it("records all four stage durations from one TurnLatencyReport", () => {
    const registry = new MetricsRegistry();
    registry.recordTurnLatency({
      sttFinalizeMs: 120,
      llmFirstTokenMs: 60,
      ttsFirstByteMs: 90,
      endToEndMs: 270,
    });
    expect(registry.snapshot().latency.stt_finalize).toMatchObject({ count: 1, p50: 120 });
    expect(registry.snapshot().latency.llm_first_token).toMatchObject({ count: 1, p50: 60 });
    expect(registry.snapshot().latency.tts_first_byte).toMatchObject({ count: 1, p50: 90 });
    expect(registry.snapshot().latency.end_to_end).toMatchObject({ count: 1, p50: 270 });
  });
});

describe("MetricsRegistry counters", () => {
  it("counts each call status independently", () => {
    const registry = new MetricsRegistry();
    registry.incrementCallStatus("in_progress");
    registry.incrementCallStatus("in_progress");
    registry.incrementCallStatus("completed");
    registry.incrementCallStatus("failed");
    expect(registry.snapshot().callsByStatus).toEqual({
      in_progress: 2,
      completed: 1,
      failed: 1,
    });
  });

  it("supports explicit multi-step increments", () => {
    const registry = new MetricsRegistry();
    registry.incrementCallStatus("completed", 3);
    registry.incrementError("llm", 2);
    expect(registry.snapshot().callsByStatus.completed).toBe(3);
    expect(registry.snapshot().errors.llm).toBe(2);
  });

  it("counts errors per category, including the reserved skill category", () => {
    const registry = new MetricsRegistry();
    registry.incrementError("pipeline");
    registry.incrementError("stream");
    registry.incrementError("stream");
    registry.incrementError("skill");
    const errors = registry.snapshot().errors;
    expect(Object.keys(errors).sort()).toEqual([...ERROR_CATEGORIES].sort());
    expect(errors).toEqual({ pipeline: 1, llm: 0, stream: 2, skill: 1 });
  });

  it("tracks generic named counters with a default step of 1", () => {
    const registry = new MetricsRegistry();
    registry.incrementCounter("skills_invoked");
    registry.incrementCounter("skills_invoked");
    registry.incrementCounter("skills_refused", 4);
    expect(registry.snapshot().counters).toEqual({ skills_invoked: 2, skills_refused: 4 });
  });

  it("updates the active-session gauge", () => {
    const registry = new MetricsRegistry();
    expect(registry.snapshot().activeSessions).toBe(0);
    registry.setActiveSessions(7);
    expect(registry.snapshot().activeSessions).toBe(7);
  });
});

describe("MetricsRegistry snapshot", () => {
  it("exposes the documented JSON-safe shape with a boot since timestamp", () => {
    const boot = new Date("2026-10-13T10:00:00.000Z");
    const registry = new MetricsRegistry(() => boot);
    registry.incrementCounter("anything");
    const snap = registry.snapshot();

    expect(snap.since).toBe("2026-10-13T10:00:00.000Z");
    expect(Object.keys(snap).sort()).toEqual([
      "activeSessions",
      "callsByStatus",
      "counters",
      "errors",
      "latency",
      "since",
    ]);
    expect(Object.keys(snap.callsByStatus).sort()).toEqual(["completed", "failed", "in_progress"]);
    expect(snap.latency.stt_finalize).toEqual({ count: 0, p50: null, p95: null });

    // JSON round-trip is lossless (JSON-safe: no Dates, Maps or NaN).
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  it("returns a fresh object each call (callers cannot mutate the registry)", () => {
    const registry = new MetricsRegistry();
    const snap = registry.snapshot();
    snap.callsByStatus.completed = 99;
    snap.counters["x"] = 1;
    expect(registry.snapshot().callsByStatus.completed).toBe(0);
    expect(registry.snapshot().counters).toEqual({});
  });
});

describe("attachSessionMetrics", () => {
  const info = (callSid: string) => ({ callSid, from: "+10000000000", provider: "browser" as const });

  it("counts started calls as in_progress and finals by status, tracking the gauge", () => {
    const sessions = new CallSessionManager();
    const registry = new MetricsRegistry();
    attachSessionMetrics(sessions, registry);

    const a = sessions.create(new CallSession(info("CA-1")));
    const b = sessions.create(new CallSession(info("CA-2")));
    expect(registry.snapshot().callsByStatus).toEqual({
      in_progress: 2,
      completed: 0,
      failed: 0,
    });
    expect(registry.snapshot().activeSessions).toBe(2);

    sessions.end(a, "completed");
    expect(registry.snapshot().callsByStatus).toEqual({
      in_progress: 2,
      completed: 1,
      failed: 0,
    });
    expect(registry.snapshot().activeSessions).toBe(1);

    sessions.end(b, "failed");
    expect(registry.snapshot().callsByStatus).toEqual({
      in_progress: 2,
      completed: 1,
      failed: 1,
    });
    expect(registry.snapshot().activeSessions).toBe(0);
  });

  it("never double-counts an idempotent finalize", () => {
    const sessions = new CallSessionManager();
    const registry = new MetricsRegistry();
    attachSessionMetrics(sessions, registry);
    const session = sessions.create(new CallSession(info("CA-1")));

    sessions.end(session, "completed");
    sessions.end(session, "failed"); // manager ignores already-finalized sessions

    const byStatus = registry.snapshot().callsByStatus as Record<CallStatus, number>;
    expect(byStatus.completed).toBe(1);
    expect(byStatus.failed).toBe(0);
    expect(registry.snapshot().activeSessions).toBe(0);
  });
});
