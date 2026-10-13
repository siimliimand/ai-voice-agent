import { readdir, readFile } from "node:fs/promises";
import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.js";

/**
 * Resolve the migrations directory relative to this module file. Both
 * src/db/migrate.ts and dist/db/migrate.js sit two levels below the package
 * root, so ../../migrations/ works in either layout.
 */
export const migrationsDir = new URL("../../migrations/", import.meta.url);

/**
 * List applied migration names, creating the bookkeeping table if needed.
 * `_migrations` is runner-owned and therefore not part of the typed schema.
 */
export async function appliedMigrations(db: Kysely<Database>): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`.execute(
    db,
  );
  const result = await sql<{ name: string }>`SELECT name FROM _migrations`.execute(db);
  return result.rows.map((r) => r.name).sort();
}

/**
 * Apply all pending migrations from the migrations directory, each in its own
 * transaction (SQL body + bookkeeping row commit together). Returns the names
 * of migrations applied by this call.
 */
export async function runMigrations(
  db: Kysely<Database>,
  dir: URL = migrationsDir,
): Promise<string[]> {
  const applied = new Set(await appliedMigrations(db));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  const pending = files.filter((f) => !applied.has(f));
  for (const file of pending) {
    const body = await readFile(new URL(file, dir), "utf8");
    await db.transaction().execute(async (tx) => {
      await sql.raw(body).execute(tx);
      await sql`INSERT INTO _migrations (name) VALUES (${file})`.execute(tx);
    });
  }
  return pending;
}
