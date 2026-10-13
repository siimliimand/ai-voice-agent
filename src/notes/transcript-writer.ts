/**
 * Crash-safe incremental persistence of finalized utterances.
 *
 * Every utterance is its own INSERT (per-row), so a crash loses at most the
 * one utterance currently being written. write() NEVER throws into the
 * pipeline: insert failures are logged and recorded as a
 * "transcript_write_failed" call event, and the returned promise always
 * resolves — `void writer.write(...)` is safe.
 *
 * The calls-row insert races session start, so the call id may be unknown
 * when the first utterances arrive; they are buffered in memory and flushed
 * (in order) as soon as the id resolves — either on a later write() or via
 * the bounded internal retry loop.
 */

import type { Kysely } from "kysely";
import { insertCallEvent, insertUtterance } from "../db/queries.js";
import type { Database } from "../db/schema.js";
import { logger as rootLogger, type Logger } from "../logging.js";
import type { Language } from "../types.js";

/** One finalized utterance handed to the writer by the pipeline core. */
export interface TranscriptWriteInput {
  speaker: "caller" | "agent";
  text: string;
  language?: Language | null;
  /** Offset from call start, milliseconds. */
  atMs: number;
}

export interface TranscriptWriterOptions {
  db: Kysely<Database>;
  /**
   * The call's DB row id — or a getter for it. A getter supports the common
   * race where the calls row is inserted shortly after streaming starts;
   * the getter is re-consulted until it returns a number.
   */
  callId: number | (() => number | undefined);
  logger?: Logger;
}

/** Backoff schedule (ms) for re-resolving a not-yet-known call id. */
const CALL_ID_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1_600] as const;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class TranscriptWriter {
  private readonly db: Kysely<Database>;
  private readonly callIdSource: TranscriptWriterOptions["callId"];
  private readonly logger: Logger;
  /** Utterances waiting for the call id; flushed in arrival order. */
  private readonly buffered: TranscriptWriteInput[] = [];
  /** True while the background call-id retry loop is running. */
  private retrying = false;

  constructor(options: TranscriptWriterOptions) {
    this.db = options.db;
    this.callIdSource = options.callId;
    this.logger = options.logger ?? rootLogger;
  }

  /**
   * Persist one finalized utterance. Never rejects; failures are logged and
   * recorded as a "transcript_write_failed" call event instead.
   */
  async write(input: TranscriptWriteInput): Promise<void> {
    try {
      const callId = this.resolveCallId();
      if (callId === undefined) {
        this.buffered.push(input);
        this.scheduleCallIdRetry();
        return;
      }
      await this.flushBuffered(callId);
      await this.insertOne(callId, input);
    } catch (err) {
      // Defensive: insertOne never throws, but nothing here may reach the pipeline.
      this.reportFailure(err, input);
    }
  }

  /** Number of utterances currently buffered awaiting a call id. */
  get pendingCount(): number {
    return this.buffered.length;
  }

  private resolveCallId(): number | undefined {
    return typeof this.callIdSource === "function" ? this.callIdSource() : this.callIdSource;
  }

  /**
   * Drain the buffer into the given call. Rows are shifted off before the
   * (async) insert so concurrent flushes can never duplicate or reorder them.
   */
  private async flushBuffered(callId: number): Promise<void> {
    for (let next = this.buffered.shift(); next !== undefined; next = this.buffered.shift()) {
      await this.insertOne(callId, next);
    }
  }

  /** Insert a single utterance row; failures degrade to log + call event. */
  private async insertOne(callId: number, input: TranscriptWriteInput): Promise<void> {
    try {
      await insertUtterance(this.db, {
        callId,
        speaker: input.speaker,
        text: input.text,
        language: input.language ?? undefined,
        atMs: input.atMs,
      });
    } catch (err) {
      this.logger.error({ err, callId, atMs: input.atMs }, "transcript write failed");
      try {
        await insertCallEvent(this.db, {
          callId,
          type: "transcript_write_failed",
          detail: { error: errorMessage(err), speaker: input.speaker, atMs: input.atMs },
        });
      } catch (eventErr) {
        this.logger.error(
          { err: eventErr, callId },
          "failed to record transcript_write_failed event",
        );
      }
    }
  }

  /**
   * Start a bounded background loop that re-resolves the call id and flushes
   * the buffer once it appears — so a lone final utterance near call start is
   * persisted even if no further write() calls come.
   */
  private scheduleCallIdRetry(): void {
    if (this.retrying) return;
    this.retrying = true;
    void (async () => {
      try {
        for (const delay of CALL_ID_RETRY_DELAYS_MS) {
          await sleep(delay);
          if (this.buffered.length === 0) return;
          const callId = this.resolveCallId();
          if (callId !== undefined) {
            await this.flushBuffered(callId);
            return;
          }
        }
        // Still unknown after all retries: keep the buffer; a later write()
        // will retry the flush. Nothing is thrown or lost silently — log it.
        this.logger.warn(
          { buffered: this.buffered.length },
          "transcript writer: call id still unknown after retries; utterances remain buffered",
        );
      } catch (err) {
        this.logger.error({ err }, "transcript writer: buffered flush failed");
      } finally {
        this.retrying = false;
      }
    })();
  }

  /** Last-resort error sink; reports via call event when the call id is known. */
  private reportFailure(err: unknown, input: TranscriptWriteInput): void {
    this.logger.error({ err, atMs: input.atMs }, "transcript writer: unexpected write failure");
    const callId = this.resolveCallId();
    if (callId === undefined) return;
    void insertCallEvent(this.db, {
      callId,
      type: "transcript_write_failed",
      detail: { error: errorMessage(err), speaker: input.speaker, atMs: input.atMs },
    }).catch((eventErr: unknown) => {
      this.logger.error(
        { err: eventErr, callId },
        "failed to record transcript_write_failed event",
      );
    });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
