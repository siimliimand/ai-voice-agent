/**
 * Per-suite scratch database factory — the ONLY sanctioned way for a test to
 * reach Postgres.
 *
 * INCIDENT BACKGROUND: suites used to connect straight to DATABASE_URL and
 * delete/truncate shared tables (settings, calls, ...) as fixture cleanup.
 * With DATABASE_URL pointing at the production compose Postgres this DELETED
 * THE OPERATOR'S SAVED SETTINGS (the `settings` row key='global') on every
 * full-suite run. Every DB-backed suite must now create its own throwaway
 * database on the same server, run migrations there, and drop it afterwards —
 * the shared database is never touched.
 *
 * Usage:
 *   describe.skipIf(!process.env.DATABASE_URL)("suite", () => {
 *     let scratch: ScratchDb;
 *     let db: Kysely<Database>;
 *     beforeAll(async () => {
 *       scratch = await createScratchDb("my_suite");
 *       db = scratch.db;
 *     });
 *     afterAll(async () => {
 *       if (scratch) await scratch.destroy();
 *     });
 *     ...
 *   });
 *
 * The scratch name is RANDOM per call (`voice_scratch_<label>_<hex>`), so the
 * factory can never collide with itself, another suite, or — critically — the
 * DATABASE_URL database. A guard below refuses to continue if the generated
 * name (or URL) points at the shared/deployed database anyway.
 *
 * Trade-off: a hard-crashed runner can leak a `voice_scratch_*` database on
 * the server (the previous fixed-name pattern self-healed on the next run).
 * Accepted: leaking an empty scratch database is harmless; reusing predictable
 * names against a shared server was not.
 */
import { randomBytes } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { runMigrations } from "../../src/db/migrate.js";
import type { Database } from "../../src/db/schema.js";

export interface ScratchDb {
  /** Connection to the scratch database, migrations applied. */
  db: Kysely<Database>;
  /** Admin connection (same server); used only to create/drop the scratch database. */
  admin: Kysely<Database>;
  /** The scratch database name. */
  name: string;
  /** Drop the scratch database (WITH (FORCE)) and close both connections. */
  destroy(): Promise<void>;
}

/** DATABASE_URL or throws — pair with describe.skipIf(!process.env.DATABASE_URL). */
export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim() === "") {
    throw new Error(
      "scratch-db: DATABASE_URL is not set — gate the suite with describe.skipIf(!process.env.DATABASE_URL)",
    );
  }
  return url;
}

/**
 * Build the Kysely handle over a pool this helper OWNS (small max — a dozen
 * suites may be alive in parallel). The pool 'error' listener is required:
 * when DROP DATABASE ... WITH (FORCE) terminates an idle client during
 * teardown, pg emits 'error' on it after the pool ended; without a listener
 * that surfaces as an uncaught exception and vitest reports unhandled errors.
 */
function makeDb(databaseUrl: string, max: number): Kysely<Database> {
  const pool = new Pool({ connectionString: databaseUrl, max });
  pool.on("error", () => undefined); // idle client terminated at teardown — see above
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * Create a randomly-named scratch database on the DATABASE_URL server and run
 * migrations into it. `label` (snake_case, ≤40 chars) only makes leaked
 * databases identifiable in `\l`.
 */
export async function createScratchDb(label = "suite"): Promise<ScratchDb> {
  if (!/^[a-z0-9_]{1,40}$/.test(label)) {
    throw new Error(`scratch-db: label must be snake_case/≤40 chars, got ${JSON.stringify(label)}`);
  }
  const databaseUrl = requireDatabaseUrl();

  const shared = new URL(databaseUrl);
  const sharedName = decodeURIComponent(shared.pathname.replace(/^\//, ""));

  // Random name: the factory NEVER reuses the DATABASE_URL database (interlock).
  const name = `voice_scratch_${label}_${randomBytes(6).toString("hex")}`;
  if (name === sharedName) {
    // Unreachable with a random suffix; kept as an explicit tripwire so a
    // future refactor cannot silently reconnect this helper to the shared db.
    throw new Error(
      `scratch-db: refusing to continue — generated scratch name collided with the DATABASE_URL database "${sharedName}"`,
    );
  }

  const admin = makeDb(databaseUrl, 2);
  try {
    await sql`CREATE DATABASE ${sql.raw(name)}`.execute(admin);

    const scratchUrl = new URL(databaseUrl);
    scratchUrl.pathname = `/${name}`;
    if (scratchUrl.toString() === databaseUrl) {
      throw new Error(
        `scratch-db: refusing to continue — scratch URL equals DATABASE_URL (database "${sharedName}")`,
      );
    }
    const db = makeDb(scratchUrl.toString(), 4);
    await runMigrations(db);

    return {
      db,
      admin,
      name,
      destroy: async (): Promise<void> => {
        await db.destroy();
        try {
          await sql`DROP DATABASE IF EXISTS ${sql.raw(name)} WITH (FORCE)`.execute(admin);
        } finally {
          await admin.destroy();
        }
      },
    };
  } catch (err) {
    // Best-effort unwind so a failed setup does not leak the scratch database.
    await admin.destroy().catch(() => undefined);
    try {
      const unwind = makeDb(databaseUrl, 2);
      await sql`DROP DATABASE IF EXISTS ${sql.raw(name)} WITH (FORCE)`.execute(unwind);
      await unwind.destroy();
    } catch {
      // ignore — the original error matters more
    }
    throw err;
  }
}
