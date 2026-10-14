/**
 * Static regression guard for the test-suite/production interlock.
 *
 * INCIDENT: test suites connected straight to DATABASE_URL (pointing at the
 * production compose Postgres) and deleted shared rows as fixture cleanup —
 * including the operator's ENTIRE `settings` row (key='global', the saved
 * API keys). The invariant now is:
 *
 *   1. Test code never opens a Postgres connection itself (no `createDb(`,
 *      no `new Kysely(`) — DB handles only come from the scratch-DB factory
 *      (test/helpers/scratch-db.ts), which always creates a randomly-named
 *      throwaway database and drops it afterwards.
 *   2. Destructive primitives (`deleteFrom(`, `TRUNCATE`, `DELETE FROM`) may
 *      only appear in suites that use that factory, so they provably execute
 *      against a scratch database, never the shared one.
 *
 * This file scans test sources at test time. If it fails, a test is about to
 * (or already does) write to the shared/deployed database — do not "fix" the
 * guard; move the suite to createScratchDb().
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

const TEST_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HELPER = "helpers/scratch-db.ts";
const GUARD = "helpers/scratch-db.guard.test.ts";

/** All repo-relative .ts files under test/, excluding this guard. */
function testSources(): Array<{ rel: string; text: string }> {
  const files: Array<{ rel: string; text: string }> = [];
  for (const entry of readdirSync(TEST_ROOT, { recursive: true })) {
    const rel = String(entry);
    if (!rel.endsWith(".ts")) continue;
    if (rel === GUARD || rel === HELPER) continue;
    files.push({ rel: `test/${rel}`, text: readFileSync(join(TEST_ROOT, rel), "utf8") });
  }
  return files;
}

describe("test/ ↔ production database interlock (static guard)", () => {
  const sources = testSources();

  it("found test sources to scan (sanity)", () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it("no test file opens a Postgres connection outside the scratch-DB factory", () => {
    // The factory is the only place allowed to call createDb — and it never
    // connects to the DATABASE_URL database (random scratch name + tripwire).
    const offenders = sources.filter((f) => /\bcreateDb\s*\(/.test(f.text));
    expect
      .soft(
        offenders.map((f) => f.rel),
        "use createScratchDb() from test/helpers/scratch-db.js — direct createDb() can hit the production database",
      )
      .toEqual([]);
    const directKysely = sources.filter((f) => /\bnew\s+Kysely\s*\(/.test(f.text));
    expect
      .soft(
        directKysely.map((f) => f.rel),
        "constructing Kysely directly bypasses the scratch-DB interlock",
      )
      .toEqual([]);
  });

  it("destructive SQL primitives only appear in scratch-DB suites", () => {
    const destructive = /\bdeleteFrom\s*\(|\bTRUNCATE\b/i;
    const offenders = sources.filter(
      (f) => destructive.test(f.text) && !f.text.includes("createScratchDb"),
    );
    expect
      .soft(
        offenders.map((f) => f.rel),
        "file contains deleteFrom/TRUNCATE but does not use createScratchDb — writes would target the shared database",
      )
      .toEqual([]);
  });

  it("the scratch-DB factory always invents a random database name (never DATABASE_URL's)", () => {
    const helper = readFileSync(join(TEST_ROOT, HELPER), "utf8");
    // Random suffix per call — the factory can never reuse the shared db.
    expect(helper).toMatch(/randomBytes\(/);
    expect(helper).toMatch(/voice_scratch_/);
    // Tripwire: refuses if the generated name/URL collides with DATABASE_URL.
    expect(helper).toMatch(/collided with the DATABASE_URL database/);
    expect(helper).toMatch(/scratch URL equals DATABASE_URL/);
    // Drops with FORCE so suites clean up after themselves.
    expect(helper).toMatch(/DROP DATABASE IF EXISTS/);
  });
});
