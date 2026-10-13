/**
 * Notes pipeline wiring: post-call structured notes.
 *
 * attachNotesPipeline subscribes to the session manager's "ended" event and
 * fires summarizeCall fire-and-forget for each finished call. Errors are
 * fully isolated: a note failure is logged and never affects the session
 * teardown, other listeners, or the process.
 *
 * Config and LLM client can be captured statically (tests, simple wiring) or
 * resolved lazily per ended call via getConfig/getLlm (live-apply: the admin
 * console's summarizer model / API key changes apply without a restart).
 */

import type { Kysely } from "kysely";
import type { AppConfig } from "../config/schema.js";
import type { Database } from "../db/schema.js";
import type { ChatOptions } from "../llm/openrouter.js";
import { logger as rootLogger, type Logger } from "../logging.js";
import type { CallSession } from "../session/call-session.js";
import type { CallSessionManager } from "../session/manager.js";
import type { CallStatus } from "../types.js";
import { summarizeCall } from "./summarizer.js";

export type { Note, noteSchema } from "./note-schema.js";
export { parseNote, extractJsonObject, type SummarizerLlm } from "./summarizer.js";
export { TranscriptWriter, type TranscriptWriteInput } from "./transcript-writer.js";

/** Structural LLM client so tests can mock without OpenRouter. */
export interface NotesLlm {
  chat(opts: ChatOptions): Promise<string>;
}

export interface AttachNotesPipelineOptions {
  db: Kysely<Database>;
  sessions: CallSessionManager;
  /** Startup/base config. Used directly unless getConfig is provided. */
  config: AppConfig;
  /** Static LLM client. Used directly unless getLlm is provided. */
  llm?: NotesLlm;
  /**
   * Live-apply: resolved once per ended call and used instead of `config`
   * (summarizer model + notes.enabled). Failures fall back to `config`.
   */
  getConfig?: () => Promise<AppConfig>;
  /**
   * Live-apply: resolved at summarize time and used instead of the captured
   * `llm`; returning undefined skips the note (warned, never thrown). May
   * return a promise (async resolution, e.g. from the settings resolver).
   */
  getLlm?: () => NotesLlm | undefined | Promise<NotesLlm | undefined>;
  logger?: Logger;
}

/**
 * Read the DB call id recorded on a session (session.meta.callId, set by the
 * call-lifecycle wiring once the calls row exists). Returns undefined when
 * absent or not an integer.
 */
export function sessionCallId(session: CallSession): number | undefined {
  const raw = session.meta["callId"];
  return typeof raw === "number" && Number.isInteger(raw) ? raw : undefined;
}

/**
 * Subscribe to session-manager "ended" events and generate structured notes.
 * Returns an unsubscribe function.
 */
export function attachNotesPipeline(options: AttachNotesPipelineOptions): () => void {
  const { db, sessions, config } = options;
  const log = options.logger ?? rootLogger;

  const onEnded = (session: CallSession, _status: CallStatus): void => {
    // Fire-and-forget with explicit error isolation: a note failure (or a
    // failing getConfig/getLlm resolution) must not affect session teardown
    // or any other listener.
    void summarizeEnded(session);
  };

  const summarizeEnded = async (session: CallSession): Promise<void> => {
    const summarizeConfig = options.getConfig
      ? await resolveConfigSafe(options.getConfig, config, log)
      : config;
    if (!summarizeConfig.notes.enabled) return;

    const llm = options.getLlm ? await options.getLlm() : options.llm;
    if (!llm) {
      log.warn(
        { callSid: session.callSid },
        "notes pipeline: no LLM client available; skipping note",
      );
      return;
    }

    const callId = sessionCallId(session);
    if (callId === undefined) {
      log.warn(
        { callSid: session.callSid },
        "notes pipeline: ended session has no callId; skipping note",
      );
      return;
    }

    try {
      await summarizeCall({ db, llm, config: summarizeConfig, callId, logger: log });
    } catch (err) {
      log.error({ err, callId, callSid: session.callSid }, "notes pipeline: summarizeCall failed");
    }
  };

  sessions.on("ended", onEnded);
  return () => {
    sessions.off("ended", onEnded);
  };
}

/** getConfig wrapper: falls back to the captured config when resolution fails. */
async function resolveConfigSafe(
  getConfig: () => Promise<AppConfig>,
  fallback: AppConfig,
  log: Logger,
): Promise<AppConfig> {
  try {
    return await getConfig();
  } catch (err) {
    log.error({ err }, "notes pipeline: config resolution failed; using base config");
    return fallback;
  }
}
