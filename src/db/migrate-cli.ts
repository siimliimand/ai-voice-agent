import { parseArgs } from "node:util";
import { createDb, closeDb } from "./client.js";
import { appliedMigrations, runMigrations } from "./migrate.js";

/**
 * Migration CLI: `npm run migrate` or `node dist/db/migrate-cli.js`.
 * Connection string comes from --url or DATABASE_URL. Exits non-zero on
 * failure; logs applied/pending counts otherwise.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
    },
  });

  const databaseUrl = values.url ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("migrate: DATABASE_URL (or --url) is required");
    process.exitCode = 1;
    return;
  }

  const db = createDb(databaseUrl);
  try {
    const alreadyApplied = (await appliedMigrations(db)).length;
    const applied = await runMigrations(db);
    if (applied.length === 0) {
      console.log(`migrate: nothing to do (${alreadyApplied} already applied)`);
    } else {
      for (const name of applied) console.log(`migrate: applied ${name}`);
      console.log(
        `migrate: applied ${applied.length} migration(s), pending 0 (${alreadyApplied} previously applied)`,
      );
    }
  } finally {
    await closeDb(db);
  }
}

main().catch((err: unknown) => {
  const e = err as Error & { code?: string; errors?: unknown[] };
  const detail = e.message || (e.errors ? e.errors.map(String).join("; ") : "") || String(err);
  console.error(`migrate: failed${e.code ? ` (${e.code})` : ""}: ${detail}`);
  process.exit(1);
});
