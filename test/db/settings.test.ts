import type { Kysely } from "kysely";
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
  let db: Kysely<Database>;

  beforeAll(async () => {
    db = createDb(databaseUrl as string);
    await runMigrations(db);
    await db.deleteFrom("settings").where("key", "=", SETTINGS_KEY).execute();
  });

  afterEach(async () => {
    await db.deleteFrom("settings").where("key", "=", SETTINGS_KEY).execute();
  });

  afterAll(async () => {
    await closeDb(db);
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
