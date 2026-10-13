import type { CallInfo, CallStatus, Language, Speaker } from "../types.js";

/** One finalized utterance in a call. */
export interface UtteranceRecord {
  speaker: Speaker;
  text: string;
  language?: Language;
  /** Offset from call start, milliseconds. */
  atMs: number;
}

/**
 * Per-call conversation/session state (in-memory; DB persistence is layered
 * on by the notes pipeline). Lifecycle: created on transport start → active
 * while audio flows → finalized on hangup (status + duration).
 */
export class CallSession {
  readonly startedAt = Date.now();
  endedAt: number | undefined;
  status: CallStatus = "in_progress";
  /** Locked call language once detected (null until then). */
  language: Language | null = null;
  /** In-memory transcript, mirrors persisted rows. */
  readonly transcript: UtteranceRecord[] = [];
  /** Bag for pipeline/notes bookkeeping (e.g. DB row ids). */
  readonly meta: Record<string, unknown> = {};

  constructor(readonly info: CallInfo) {}

  get callSid(): string {
    return this.info.callSid;
  }

  get durationMs(): number {
    return (this.endedAt ?? Date.now()) - this.startedAt;
  }

  addUtterance(u: UtteranceRecord): void {
    this.transcript.push(u);
  }

  /** Mark the session finished; idempotent. */
  finalize(status: CallStatus = "completed"): void {
    if (this.endedAt === undefined) this.endedAt = Date.now();
    this.status = status;
  }

  get isActive(): boolean {
    return this.endedAt === undefined;
  }
}
