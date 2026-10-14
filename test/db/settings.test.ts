import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  SETTINGS_KEY,
  clearSettingsPath,
  getAtPath,
  getSettingsDoc,
  saveSettingsDoc,
} from "../../src/db/settings.js";
import type { Database } from "../../src/db/schema.js";
import { createScratchDb, type ScratchDb } from "../helpers/scratch-db.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("db settings document", () => {
  // Scratch database: this suite writes the shared `settings` doc, which
  // other DB-backed suites also read/write — an isolated database removes
  // the cross-file race in both directions (and can never touch operator
  // data on the shared server).
  let scratch: ScratchDb;
  let db: Kysely<Database>;

  beforeAll(async () => {
    scratch = await createScratchDb("db_settings");
    db = scratch.db;
  });

  afterEach(async () => {
    await db.deleteFrom("settings").where("key", "=", SETTINGS_KEY).execute();
  });

  afterAll(async () => {
    if (scratch) await scratch.destroy();
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

  it("writeDoc bumps updated_at on every update, not only the initial insert", async () => {
    // Regression: updates used to keep the INSERT timestamp, which masked an
    // incident where a test suite deleted the operator's settings row (with
    // a stale updated_at there was no visible "recently saved" signal).
    await saveSettingsDoc(db, { llm: { models: { summarizer: "v1" } } });
    const first = await db
      .selectFrom("settings")
      .select("updated_at")
      .where("key", "=", SETTINGS_KEY)
      .executeTakeFirstOrThrow();

    // The column is TIMESTAMPTZ with µs precision but JS dates are ms —
    // space the writes out so the second save cannot land on the same ms.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await saveSettingsDoc(db, { llm: { models: { summarizer: "v2" } } });
    const second = await db
      .selectFrom("settings")
      .select("updated_at")
      .where("key", "=", SETTINGS_KEY)
      .executeTakeFirstOrThrow();

    expect(second.updated_at.getTime()).toBeGreaterThan(first.updated_at.getTime());
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
