/**
 * Process-local metrics registry (M4 design D10): bounded per-stage latency
 * sample rings, monotonic counters, and the active-session gauge that
 * `GET /api/metrics` (task 7.2) serializes as JSON behind the admin
 * basic-auth gate.
 *
 * Counters and rings live only in this process and reset on restart; the
 * snapshot's `since` boot timestamp makes that explicit. DB-backed call
 * counts by status survive restarts (D10) and are layered on at the
 * endpoint, not here.
 *
 * Feeds (all additive hooks on existing code paths):
 * - stage latencies: the VoicePipeline's TurnLatencyTracker first-byte hook
 *   (`recordTurnLatency`) — no timing logic is duplicated;
 * - call statuses + active gauge: `attachSessionMetrics` on the existing
 *   CallSessionManager "started"/"ended" events (no manager changes);
 * - errors: the pipeline's existing `reportError` catch points, categorized
 *   pipeline | llm | stream. `skill` is exposed here for the skills
 *   dispatcher to use later.
 */
import type { CallSession } from "../session/call-session.js";
import type { CallSessionManager } from "../session/manager.js";
import type { CallStatus } from "../types.js";
import type { TurnLatencyReport } from "./latency.js";

/** The four measured turn stages, in call order. */
export const LATENCY_STAGES = [
  "stt_finalize",
  "llm_first_token",
  "tts_first_byte",
  "end_to_end",
] as const;

export type LatencyStage = (typeof LATENCY_STAGES)[number];

/** Samples kept per stage; older samples are dropped (bounded memory). */
export const RING_CAPACITY = 500;

/** Error counter categories. `skill` is reserved for the skills dispatcher. */
export const ERROR_CATEGORIES = ["pipeline", "llm", "stream", "skill"] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/** Per-stage view of one latency ring, with on-demand percentiles. */
export interface LatencyStageSnapshot {
  /** Samples currently held (≤ RING_CAPACITY). */
  count: number;
  /** Nearest-rank median; null while the ring is empty. */
  p50: number | null;
  /** Nearest-rank 95th percentile; null while the ring is empty. */
  p95: number | null;
}

/**
 * The exact JSON structure `GET /api/metrics` returns (task 7.2). Keep this
 * shape stable and JSON-safe: numbers, strings, plain objects — no Dates,
 * Maps or infinities.
 */
export interface MetricsSnapshot {
  /** Boot time (registry construction) as an ISO-8601 UTC timestamp. */
  since: string;
  /** Latency rings per stage, with nearest-rank p50/p95. */
  latency: Record<LatencyStage, LatencyStageSnapshot>;
  /**
   * Calls by status since boot: calls started count under "in_progress"
   * (not decremented on end — it is a started-calls counter), finals under
   * "completed"/"failed". Active-ness lives in `activeSessions`.
   */
  callsByStatus: Record<CallStatus, number>;
  /** Errors by category since boot. */
  errors: Record<ErrorCategory, number>;
  /** Point-in-time gauge of non-finalized sessions. */
  activeSessions: number;
  /**
   * Generic named counters (see `incrementCounter`); starts empty. Reserved
   * for cross-cutting instrumentation (e.g. the skills framework) that does
   * not fit the fixed categories above.
   */
  counters: Record<string, number>;
}

/** Bounded FIFO of samples: keeps only the most recent `capacity` values. */
class SampleRing {
  private values: number[] = [];

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.values.length;
  }

  add(value: number): void {
    this.values.push(value);
    if (this.values.length > this.capacity) this.values.shift();
  }

  /**
   * Nearest-rank percentile over a sorted copy: rank = ceil(p/100 · n),
   * clamped to [1, n]. Null for an empty ring.
   */
  percentile(p: number): number | null {
    const n = this.values.length;
    if (n === 0) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    const rank = Math.min(Math.max(Math.ceil((p / 100) * n), 1), n);
    return sorted[rank - 1]!;
  }
}

/**
 * Central process-local metrics sink. One instance per process, constructed
 * in the composition root (buildApp) and passed to the pipelines; reach it
 * from route handlers via `AppHandle.metrics`.
 */
export class MetricsRegistry {
  private readonly bootedAt: string;
  private readonly rings: Record<LatencyStage, SampleRing>;
  private readonly callStatusCounts: Record<CallStatus, number> = {
    in_progress: 0,
    completed: 0,
    failed: 0,
  };
  private readonly errorCounts: Record<ErrorCategory, number> = {
    pipeline: 0,
    llm: 0,
    stream: 0,
    skill: 0,
  };
  private readonly namedCounters: Record<string, number> = {};
  private activeSessions = 0;

  /** `now` is injectable so tests can pin the `since` boot timestamp. */
  constructor(now: () => Date = () => new Date()) {
    this.bootedAt = now().toISOString();
    const rings = {} as Record<LatencyStage, SampleRing>;
    for (const stage of LATENCY_STAGES) rings[stage] = new SampleRing(RING_CAPACITY);
    this.rings = rings;
  }

  /** Record one latency sample (milliseconds) for a stage. */
  recordLatency(stage: LatencyStage, ms: number): void {
    this.rings[stage].add(ms);
  }

  /** Sample all four stage durations of one completed turn at once. */
  recordTurnLatency(report: TurnLatencyReport): void {
    this.recordLatency("stt_finalize", report.sttFinalizeMs);
    this.recordLatency("llm_first_token", report.llmFirstTokenMs);
    this.recordLatency("tts_first_byte", report.ttsFirstByteMs);
    this.recordLatency("end_to_end", report.endToEndMs);
  }

  /** Bump a call-status counter (default step 1). */
  incrementCallStatus(status: CallStatus, by = 1): void {
    this.callStatusCounts[status] += by;
  }

  /** Bump an error-category counter (default step 1). */
  incrementError(category: ErrorCategory, by = 1): void {
    this.errorCounts[category] += by;
  }

  /** Bump a generic named counter (default step 1); created on first use. */
  incrementCounter(name: string, by = 1): void {
    this.namedCounters[name] = (this.namedCounters[name] ?? 0) + by;
  }

  /** Replace the active-session gauge (fed from CallSessionManager events). */
  setActiveSessions(n: number): void {
    this.activeSessions = n;
  }

  /** Build the serializable JSON-safe snapshot served by /api/metrics. */
  snapshot(): MetricsSnapshot {
    const latency = {} as Record<LatencyStage, LatencyStageSnapshot>;
    for (const stage of LATENCY_STAGES) {
      const ring = this.rings[stage];
      latency[stage] = { count: ring.size, p50: ring.percentile(50), p95: ring.percentile(95) };
    }
    return {
      since: this.bootedAt,
      latency,
      callsByStatus: { ...this.callStatusCounts },
      errors: { ...this.errorCounts },
      activeSessions: this.activeSessions,
      counters: { ...this.namedCounters },
    };
  }
}

/**
 * Feed call-status counters and the active-session gauge from a
 * CallSessionManager's existing lifecycle events (no manager changes).
 * "started" fires after the session is registered, "ended" after it is
 * finalized, so `active()` is accurate inside both listeners.
 */
export function attachSessionMetrics(
  sessions: CallSessionManager,
  registry: MetricsRegistry,
): void {
  sessions.on("started", () => {
    registry.incrementCallStatus("in_progress");
    registry.setActiveSessions(sessions.active().length);
  });
  sessions.on("ended", (_session: CallSession, status: CallStatus) => {
    registry.incrementCallStatus(status);
    registry.setActiveSessions(sessions.active().length);
  });
}
