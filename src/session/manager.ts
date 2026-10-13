import { EventEmitter } from "node:events";
import type { CallStatus } from "../types.js";
import type { CallSession } from "./call-session.js";

/**
 * Registry of active call sessions. Emits:
 * - "started" (session: CallSession)
 * - "ended"   (session: CallSession, status: CallStatus)
 */
export class CallSessionManager extends EventEmitter {
  private readonly sessions = new Map<string, CallSession>();

  create(session: CallSession): CallSession {
    this.sessions.set(session.callSid, session);
    this.emit("started", session);
    return session;
  }

  get(callSid: string): CallSession | undefined {
    return this.sessions.get(callSid);
  }

  /** All currently active (not finalized) sessions. */
  active(): CallSession[] {
    return [...this.sessions.values()].filter((s) => s.isActive);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Finalize a session and notify listeners. Idempotent. */
  end(session: CallSession, status: CallStatus = "completed"): void {
    if (!session.isActive) return;
    session.finalize(status);
    this.emit("ended", session, status);
  }

  /** Finalize every active session (used by graceful shutdown). */
  endAll(status: CallStatus = "completed"): void {
    for (const s of this.active()) this.end(s, status);
  }
}
