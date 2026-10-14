/**
 * Escalation handler (design D7): the generic base behavior behind the
 * built-in `escalate_to_human` tool. Wired by the composition root for every
 * call; also the fallback path when a Twilio REST transfer fails (task 5.2).
 *
 * One invocation:
 *  (a) persists `calls.escalated = true` + an `escalation_triggered`
 *      call_events row carrying the model's reason;
 *  (b) marks the session (`meta.escalated`) so the notes pipeline forces the
 *      stored note's urgency to high even if persistence failed;
 *  (c) Twilio calls only (when a `transfer` dep + staff number are wired):
 *      first attempts the REST redirect — Twilio speaks the announcement and
 *      bridges the caller to staff; success closes the media session and
 *      skips the speak-then-hangup base behavior;
 *  (d) otherwise (browser/dev path, or REST failure → audited fallback):
 *      speaks the per-language escalation announcement through the call's
 *      normal TTS path and hangs up with the "escalated" reason.
 *
 * The escalated flag + event are recorded in BOTH paths — (a)/(b) run before
 * the transfer attempt so the flag is set even if everything else fails.
 *
 * Fire-and-forget semantics: every failure is logged, never thrown — the call
 * still ends.
 */
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import type { Logger } from "../logging.js";
import { insertCallEvent, setCallEscalated } from "../db/queries.js";
import type { CallSession } from "../session/call-session.js";
import type { CallTransport } from "../telephony/transport.js";
import type { TwilioTransfer } from "../telephony/twilio/transfer.js";
import type { Language } from "../types.js";
import type { EscalationHandler, EscalationRequest } from "./conversation-manager.js";
import { getEscalationAnnouncement } from "./prompts/index.js";

export interface EscalationHandlerDeps {
  /** Persistence; absent (degraded mode) → only the session flag + hangup. */
  db?: Kysely<Database>;
  /**
   * Resolves the numeric call id once the calls row exists (the row inserts
   * asynchronously at call start). Returning undefined skips persistence.
   */
  getCallId?: () => Promise<number | undefined> | number | undefined;
  session: CallSession;
  transport: CallTransport;
  /** Speaks one fixed text through the call's normal TTS/playback path. */
  speak: (text: string) => Promise<void>;
  /**
   * Twilio REST transfer (design D7, task 5.2): updates the live call to
   * <Say> the announcement and <Dial> the staff number. Attempted before the
   * base behavior when the transport is Twilio AND `staffNumber` is
   * non-empty; `{ ok: true }` closes the media session without speaking
   * (Twilio plays the announcement), any failure falls back to it.
   */
  transfer?: TwilioTransfer;
  /** Staff number for the <Dial>; empty/unset disables the transfer step. */
  staffNumber?: string;
  /** Announcement language; defaults to the session's locked language. */
  getLanguage?: () => Language | null;
  logger?: Logger;
}

/** Session-meta key the notes pipeline reads (see src/notes/index.ts). */
export const SESSION_ESCALATED_KEY = "escalated";

/** The transport-independent hangup reason recorded for escalations. */
export const ESCALATED_HANGUP_REASON = "escalated";

/** call_events type audit-logging a failed REST transfer (design D7/D8). */
export const ESCALATION_TRANSFER_FAILED_EVENT = "escalation_transfer_failed";

/** Build the per-call escalation trigger wired into the tool loop. */
export function createEscalationHandler(
  deps: EscalationHandlerDeps,
): EscalationHandler {
  const log = deps.logger;
  const language = (): Language | null => deps.getLanguage?.() ?? deps.session.language;

  return async (request: EscalationRequest): Promise<void> => {
    // (a) Persist — fire-and-forget: the call ends even if the write fails.
    if (deps.db) {
      const db = deps.db;
      void Promise.resolve(deps.getCallId?.())
        .then(async (callId) => {
          if (callId === undefined) return; // call row never landed
          await setCallEscalated(db, callId, true);
          await insertCallEvent(db, {
            callId,
            type: "escalation_triggered",
            detail: request.reason !== undefined ? { reason: request.reason } : {},
          });
        })
        .catch((err: unknown) => {
          log?.error({ err }, "escalation: failed to record escalated flag/event");
        });
    }

    // (b) Session flag — the notes pipeline's escalation source of truth
    // alongside the calls row.
    deps.session.meta[SESSION_ESCALATED_KEY] = true;

    // (c) Twilio REST transfer first (task 5.2): when it succeeds Twilio has
    // re-routed the call and plays the announcement itself — close the media
    // session and skip the speak-then-hangup base behavior.
    if (await attemptTransfer()) {
      await deps.transport.hangup(ESCALATED_HANGUP_REASON).catch((err: unknown) => {
        log?.error({ err }, "escalation: hangup after transfer failed");
      });
      return;
    }

    // (d) Base behavior: announce through the normal speech path, then end
    // the call.
    try {
      await deps.speak(getEscalationAnnouncement(language()));
    } catch (err) {
      log?.warn({ err }, "escalation: announcement failed; hanging up anyway");
    }
    await deps.transport.hangup(ESCALATED_HANGUP_REASON).catch((err: unknown) => {
      log?.error({ err }, "escalation: hangup failed");
    });
  };

  /**
   * Attempt the REST redirect. Resolves true only when Twilio re-routed the
   * call; false means the base behavior must run — either the step does not
   * apply (no transfer dep, non-Twilio transport, empty staff number) or the
   * REST attempt failed (warn-logged + fire-and-forget audit event).
   */
  async function attemptTransfer(): Promise<boolean> {
    const staffNumber = deps.staffNumber?.trim() ?? "";
    if (!deps.transfer || staffNumber === "") return false;
    if (deps.transport.info.provider !== "twilio") return false;

    const result = await deps.transfer(deps.session.callSid, {
      announcementText: getEscalationAnnouncement(language()),
      staffNumber,
    });
    if (result.ok) return true;

    log?.warn(
      { status: result.status, error: result.error },
      "escalation: Twilio REST transfer failed; falling back to announce + end",
    );
    auditTransferFailure(result);
    return false;
  }

  /** Fire-and-forget `escalation_transfer_failed` row (reuses the audit path). */
  function auditTransferFailure(result: { status?: number; error?: string }): void {
    if (!deps.db) return;
    const db = deps.db;
    void Promise.resolve(deps.getCallId?.())
      .then(async (callId) => {
        if (callId === undefined) return; // call row never landed
        await insertCallEvent(db, {
          callId,
          type: ESCALATION_TRANSFER_FAILED_EVENT,
          detail: {
            error: result.error ?? "unknown error",
            ...(result.status !== undefined ? { status: result.status } : {}),
          },
        });
      })
      .catch((err: unknown) => {
        log?.error({ err }, "escalation: failed to record transfer-failure event");
      });
  }
}
