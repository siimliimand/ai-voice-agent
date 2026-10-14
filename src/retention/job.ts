/**
 * GDPR retention job (design D9): in-process scheduler that purges aged call
 * data and anonymizes caller numbers.
 *
 * One run (`run`):
 * - `retention.enabled = false` → a single warn log, nothing else.
 * - enabled but `retention.hashSalt` is EMPTY → a prominent error and the
 *   whole run is SKIPPED. Fail-safe: never purge or anonymize without the
 *   salt — the fixed per-deployment salt is what prevents reconstructing
 *   caller numbers from a candidate list once they are hashed.
 * - otherwise: calls started before `now − retention.days` and not yet
 *   anonymized are processed in batches of 1000, one transaction per batch:
 *   their `call_transcripts` and `call_notes` rows are deleted, then
 *   `from_number` is replaced with `anon:<sha256(from_number + salt)[0..12]>`
 *   (hashed in Node, bound as a parameter) and one small `retention_purged`
 *   `call_events` row per call is written ({retentionDays, purgedAt}).
 *
 * Idempotency: a call whose `from_number` already starts with `anon:` counts
 * as purged and is never selected again, so re-running with no newly aged
 * calls deletes nothing and writes no events. Each committed batch is atomic
 * (deletes + anonymization + audit events together), so a crashed instance
 * self-heals from where it stopped on the next run.
 *
 * Scheduling (`schedule`): one fire-and-forget run at startup (errors are
 * logged, never thrown), then a 24 h setTimeout chain; overlapping runs are
 * prevented by an in-flight flag. `stop()`/`dispose()` clears the timer and
 * is wired into the app's graceful-shutdown close sequence. The timer is
 * unref'd so it never keeps the process alive on its own.
 */

import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { AppConfig } from "../config/schema.js";
import type { Database } from "../db/schema.js";
import { logger as rootLogger, type Logger } from "../logging.js";

/** Calls processed (and their child rows deleted) per transaction. */
export const RETENTION_BATCH_SIZE = 1000;

/** Delay between scheduled runs: 24 h. */
export const RETENTION_TICK_MS = 24 * 60 * 60 * 1000;

export interface RetentionJobOptions {
  db: Kysely<Database>;
  /**
   * Returns the EFFECTIVE config (startup config <- DB settings doc) for
   * every run, so admin changes to retention.enabled/days/hashSalt apply on
   * the next run without a restart.
   */
  getConfig: () => Promise<AppConfig>;
  logger?: Logger;
}

export interface RetentionRunSummary {
  outcome: "purged" | "skipped_disabled" | "skipped_no_salt" | "skipped_inflight" | "error";
  retentionDays?: number;
  batches?: number;
  /** Calls whose from_number was anonymized this run. */
  callsAnonymized?: number;
  transcriptsDeleted?: number;
  notesDeleted?: number;
  durationMs?: number;
}

/**
 * Anonymized caller number per design D9:
 * `anon:` + the first 12 hex chars of sha256(from_number + hashSalt).
 */
export function anonymizeNumber(fromNumber: string, hashSalt: string): string {
  return `anon:${createHash("sha256").update(fromNumber + hashSalt).digest("hex").slice(0, 12)}`;
}

export class RetentionJob {
  private readonly db: Kysely<Database>;
  private readonly getConfig: () => Promise<AppConfig>;
  private readonly log: Logger;
  private timer: NodeJS.Timeout | undefined;
  private scheduled = false;
  private stopped = false;
  private running = false;

  constructor(options: RetentionJobOptions) {
    this.db = options.db;
    this.getConfig = options.getConfig;
    this.log = options.logger ?? rootLogger;
  }

  /**
   * Run once immediately (fire-and-forget) and re-arm a 24 h setTimeout
   * chain after every run. A second call is ignored; after stop() the job
   * stays stopped.
   */
  schedule(): void {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    const tick = async (): Promise<void> => {
      await this.run(); // run() logs its own errors; it never throws.
      if (this.stopped) return;
      this.timer = setTimeout(() => {
        void tick();
      }, RETENTION_TICK_MS);
      this.timer.unref();
    };
    void tick();
  }

  /** Clear the pending timer (graceful shutdown). An in-flight run finishes. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Alias of stop(). */
  dispose(): void {
    this.stop();
  }

  /**
   * One purge pass. Never throws: errors are logged and reported as
   * `outcome: "error"`. Overlapping runs no-op with a log line.
   */
  async run(): Promise<RetentionRunSummary> {
    if (this.running) {
      this.log.warn("retention: run already in progress — skipping overlapping run");
      return { outcome: "skipped_inflight" };
    }
    this.running = true;
    const startedAt = Date.now();
    try {
      const config = await this.getConfig();
      const { enabled, days, hashSalt } = config.retention;
      if (!enabled) {
        this.log.warn("retention: disabled (retention.enabled=false) — skipping purge run");
        return { outcome: "skipped_disabled" };
      }
      if (hashSalt === "") {
        // Fail-safe: without the salt the hash offers no protection against
        // reconstructing numbers from a candidate list, so no data is purged
        // at all until an operator configures one.
        this.log.error(
          "retention: hashSalt is EMPTY while retention is enabled — refusing to purge or anonymize any data. " +
            "Set retention.hashSalt (a per-deployment secret) in the admin settings to enable the retention job.",
        );
        return { outcome: "skipped_no_salt" };
      }
      return await this.purge(days, hashSalt, startedAt);
    } catch (err) {
      this.log.error({ err }, "retention: run failed");
      return { outcome: "error" };
    } finally {
      this.running = false;
    }
  }

  private async purge(
    days: number,
    hashSalt: string,
    startedAt: number,
  ): Promise<RetentionRunSummary> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const purgedAt = new Date().toISOString();
    let batches = 0;
    let callsAnonymized = 0;
    let transcriptsDeleted = 0;
    let notesDeleted = 0;

    // The loop self-terminates: every processed call leaves the selection
    // because its from_number now starts with "anon:".
    for (;;) {
      const aged = await this.db
        .selectFrom("calls")
        .select(["id", "from_number"])
        .where("started_at", "<", cutoff)
        .where("from_number", "not like", "anon:%")
        .orderBy("id", "asc")
        .limit(RETENTION_BATCH_SIZE)
        .execute();
      if (aged.length === 0) break;

      batches += 1;
      // pg returns int8 ids as strings — normalize before binding.
      const targets = aged.map((c) => ({ id: Number(c.id), fromNumber: c.from_number }));

      await this.db.transaction().execute(async (tx) => {
        const transcripts = await tx
          .deleteFrom("call_transcripts")
          .where(
            "call_id",
            "in",
            targets.map((t) => t.id),
          )
          .execute();
        transcriptsDeleted += Number(transcripts[0]?.numDeletedRows ?? 0);

        const notes = await tx
          .deleteFrom("call_notes")
          .where(
            "call_id",
            "in",
            targets.map((t) => t.id),
          )
          .execute();
        notesDeleted += Number(notes[0]?.numDeletedRows ?? 0);

        // Anonymize: the hash is computed in Node and bound as a parameter.
        await sql`
          UPDATE calls AS c
          SET from_number = v.anon
          FROM (VALUES ${sql.join(
            targets.map((t) =>
              sql`(${t.id}::integer, ${anonymizeNumber(t.fromNumber, hashSalt)}::text)`,
            ),
            sql`, `,
          )}) AS v(id, anon)
          WHERE c.id = v.id
        `.execute(tx);

        // One small audit event per purged call.
        await tx
          .insertInto("call_events")
          .values(
            targets.map((t) => ({
              call_id: t.id,
              type: "retention_purged",
              detail: { retentionDays: days, purgedAt },
            })),
          )
          .execute();
      });

      callsAnonymized += targets.length;
    }

    const summary = {
      retentionDays: days,
      batches,
      callsAnonymized,
      transcriptsDeleted,
      notesDeleted,
      durationMs: Date.now() - startedAt,
    };
    this.log.info(summary, "retention: purge complete");
    return { outcome: "purged", ...summary };
  }
}
