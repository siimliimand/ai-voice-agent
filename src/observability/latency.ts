import type { Logger } from "../logging.js";

/** End-to-end turn latency target: final utterance → first audio back. */
export const TURN_LATENCY_TARGET_MS = 1000;

/** Stage durations for one conversational turn, in milliseconds. */
export interface TurnLatencyReport {
  /** Turn start → STT final transcript. */
  sttFinalizeMs: number;
  /** STT final → first LLM token. */
  llmFirstTokenMs: number;
  /** First LLM token → first TTS audio byte. */
  ttsFirstByteMs: number;
  /** STT final → first TTS audio byte (the user-perceived reply delay). */
  endToEndMs: number;
}

type Clock = () => number;

const defaultClock: Clock = () => performance.now();

/**
 * Collects the three stage marks of one turn and derives the stage durations.
 * Marks are monotonic first-write-wins: a late second call is a no-op, so
 * per-sentence TTS streams cannot skew the first-byte measurement.
 *
 * Lifecycle: one tracker per turn (final utterance → first audio back); the
 * turn clock starts at construction. A custom `now()` can be injected for
 * deterministic tests.
 */
export class TurnLatencyTracker {
  private readonly startAt: number;
  private sttFinalAt: number | undefined;
  private llmFirstTokenAt: number | undefined;
  private ttsFirstByteAt: number | undefined;

  constructor(private readonly now: Clock = defaultClock) {
    this.startAt = now();
  }

  /** Call when the STT provider commits a final transcript. */
  markSttFinal(): void {
    this.sttFinalAt ??= this.now();
  }

  /** Call on the first LLM reply delta. */
  markLlmFirstToken(): void {
    this.llmFirstTokenAt ??= this.now();
  }

  /** Call on the first synthesized audio byte. */
  markTtsFirstByte(): void {
    this.ttsFirstByteAt ??= this.now();
  }

  /** Stage durations, or null until every mark has been set. */
  report(): TurnLatencyReport | null {
    if (
      this.sttFinalAt === undefined ||
      this.llmFirstTokenAt === undefined ||
      this.ttsFirstByteAt === undefined
    ) {
      return null;
    }
    return {
      sttFinalizeMs: this.sttFinalAt - this.startAt,
      llmFirstTokenMs: this.llmFirstTokenAt - this.sttFinalAt,
      ttsFirstByteMs: this.ttsFirstByteAt - this.llmFirstTokenAt,
      endToEndMs: this.ttsFirstByteAt - this.sttFinalAt,
    };
  }
}

/**
 * Emit the one structured latency line for a finished turn. Silent when the
 * turn has not completed all stages (e.g. it was interrupted by barge-in).
 */
export function logTurn(
  tracker: TurnLatencyTracker,
  log: Logger,
  meta: Record<string, unknown>,
): void {
  const report = tracker.report();
  if (!report) return;
  log.info(
    {
      meta,
      ...report,
      targetEndToEndMs: TURN_LATENCY_TARGET_MS,
      meetsTarget: report.endToEndMs < TURN_LATENCY_TARGET_MS,
    },
    "turn_latency",
  );
}
