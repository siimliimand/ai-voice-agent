/**
 * Agent-level call_events audit (design D6/D8): confirmation decisions land as
 * call_events rows alongside the dispatcher's skill_invocation rows. This is a
 * tiny fire-and-forget wrapper over the shared insertCallEvent helper — the
 * call row is inserted asynchronously at call start, so the id resolves
 * through a promise supplier and a failed write is logged, never thrown into
 * the audio path.
 */
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import { insertCallEvent } from "../db/queries.js";
import { logger as rootLogger, type Logger } from "../logging.js";

/** Writes one agent lifecycle event; type values live with the callers. */
export type AgentEventAudit = (type: string, detail?: unknown) => Promise<void>;

/** Build an auditor bound to one call's database and lazy call id. */
export function callEventAuditor(
  db: Kysely<Database>,
  getCallId: () => Promise<number | undefined>,
  log: Logger = rootLogger,
): AgentEventAudit {
  return async (type, detail) => {
    try {
      const callId = await getCallId();
      if (callId === undefined) return; // call row never landed; nothing to attach to
      await insertCallEvent(db, { callId, type, detail });
    } catch (err) {
      log.error({ err, type }, "agent: failed to write call_events audit event");
    }
  };
}
