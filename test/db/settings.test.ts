import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  SETTINGS_KEY,
  clearSettingsPath,
  getAtPath,
  getSettingsDoc,
  saveSettingsDoc,
} from "../../src/db/settings.js";
import type { Database } from "../../src/db/schema.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("db settings document", () => {
  // Scratch database: this suite writes the shared `settings` doc, which
  // other DB-backed suites (consent flow, browser escalation) delete in
  // parallel — an isolated database removes the cross-file race.
  let admin: Kysely<Database>;
  let db: Kysely<Database>;
  const SCRATCH_DB = "voice_db_settings_test";

  beforeAll(async () => {
    admin = createDb(databaseUrl as string);
    await sql`DROP DATABASE IF EXISTS ${sql.raw(SCRATCH_DB)} WITH (FORCE)`.execute(admin);
    await sql`CREATE DATABASE ${sql.raw(SCRATCH_DB)}`.execute(admin);
    const scratchUrl = new URL(databaseUrl as string);
    scratchUrl.pathname = `/${SCRATCH_DB}`;
    db = createDb(scratchUrl.toString());
    await runMigrations(db);
    await db.deleteFrom("settings").where("key", "=", SETTINGS_KEY).execute();
  });

  afterEach(async () => {
    await db.deleteFrom("settings").where("key", "=", SETTINGS_KEY).execute();
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    if (admin) {
      await sql`DROP DATABASE IF EXISTS ${sql.raw(SCRATCH_DB)} WITH (FORCE)`.execute(admin);
      await closeDb(admin);
    }
  });

  it("getSettingsDoc returns {} when the row is absent", async () => {
    expect(await getSettingsDoc(db)).toEqual({});
  });

  it("saveSettingsDoc deep-merges and overwrites per dotted path", async () => {
    await saveSettingsDoc(db, { llm: { models: { summarizer: "m/1" } } });
    await saveSettingsDoc(db, { llm: { models: { summarizer: "m/2" } }, vad: { onsetFrames: 3 } });

    const doc = await getSettingsDoc(db);
    expect(getAtPath(doc, "llm.models.summarizer")).toBe("m/2");
    expect(getAtPath(doc, "vad.onsetFrames")).toBe(3);

    const row = await db
      .selectFrom("settings")
      .selectAll()
      .where("key", "=", SETTINGS_KEY)
      .executeTakeFirstOrThrow();
    expect(row.updated_at).toBeTruthy();
  });

  it("clearSettingsPath removes one field, then drops the row when empty", async () => {
    await saveSettingsDoc(db, { llm: { models: { summarizer: "m/1" } }, vad: { onsetFrames: 2 } });

    await clearSettingsPath(db, "vad.onsetFrames");
    let doc = await getSettingsDoc(db);
    expect(getAtPath(doc, "vad.onsetFrames")).toBeUndefined();
    expect(getAtPath(doc, "llm.models.summarizer")).toBe("m/1");

    await clearSettingsPath(db, "llm.models.summarizer");
    doc = await getSettingsDoc(db);
    expect(doc).toEqual({});
    const rows = await db.selectFrom("settings").selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it("clearSettingsPath on a missing path is a no-op", async () => {
    await clearSettingsPath(db, "no.such.path");
    expect(await getSettingsDoc(db)).toEqual({});
  });
});
