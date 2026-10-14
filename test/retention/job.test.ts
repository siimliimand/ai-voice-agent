import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import { closeDb, createDb } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  getCallById,
  getNote,
  getTranscript,
  insertCall,
  insertCallEvent,
  insertUtterance,
  upsertNote,
} from "../../src/db/queries.js";
import type { Database } from "../../src/db/schema.js";
import { anonymizeNumber, RetentionJob } from "../../src/retention/index.js";

const databaseUrl = process.env.DATABASE_URL;

/** Suite-scoped salt; expected hashes are computed independently below. */
const SALT = "test-retention-salt";

const retentionConfig = (overrides: Partial<AppConfig["retention"]> = {}): AppConfig =>
  configSchema.parse({
    retention: { enabled: true, days: 90, hashSalt: SALT, ...overrides },
  });

/** Expected D9 format for a number: anon:<12 hex chars>. */
const expectedAnon = (from: string): string =>
  `anon:${createHash("sha256").update(from + SALT).digest("hex").slice(0, 12)}`;

describe.skipIf(!databaseUrl)("retention job", () => {
  let db: Kysely<Database>;

  // FK cascades remove transcripts/notes/events with the call rows. Scoped
  // to this suite's prefix — other suites use their own "test-<suite>-%"
  // prefix and run against the same database in parallel.
  const clean = async (): Promise<void> => {
    await db.deleteFrom("calls").where("call_sid", "like", "test-retention-%").execute();
  };

  beforeAll(async () => {
    db = createDb(databaseUrl as string);
    await runMigrations(db);
    await clean();
  });

  afterEach(clean);

  afterAll(async () => {
    if (db) {
      await clean();
      await closeDb(db);
    }
  });

  /** Insert a call with 2 transcripts, 1 note and a call_started event. */
  async function seedCall(sid: string, from: string): Promise<number> {
    const callId = await insertCall(db, { callSid: sid, from, provider: "twilio" });
    await insertUtterance(db, { callId, speaker: "caller", text: "Tere", language: "et", atMs: 0 });
    await insertUtterance(db, {
      callId,
      speaker: "agent",
      text: "Tere! Kuidas saan aidata?",
      language: "et",
      atMs: 1000,
    });
    await upsertNote(db, { callId, note: { summary: "test note" }, model: "test-model" });
    await insertCallEvent(db, { callId, type: "call_started", detail: { provider: "twilio" } });
    return callId;
  }

  /** Backdate started_at so the call falls before the retention cutoff. */
  async function age(callId: number, daysAgo = 100): Promise<void> {
    await db
      .updateTable("calls")
      .set({ started_at: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000) })
      .where("id", "=", callId)
      .execute();
  }

  async function countEvents(callId: number, type: string): Promise<number> {
    const rows = await db
      .selectFrom("call_events")
      .selectAll()
      .where("call_id", "=", callId)
      .where("type", "=", type)
      .execute();
    return rows.length;
  }

  /** Everything the retention job is allowed to touch, for idempotency checks. */
  async function snapshot(callId: number) {
    const call = await getCallById(db, callId);
    return {
      from: call?.from,
      transcripts: (await getTranscript(db, callId)).length,
      hasNote: (await getNote(db, callId)) !== null,
      purgedEvents: await countEvents(callId, "retention_purged"),
    };
  }

  it("purges aged transcripts/notes, anonymizes from_number, writes one retention_purged event per call", async () => {
    const agedA = await seedCall("test-retention-aged-a", "+37251234567");
    const agedB = await seedCall("test-retention-aged-b", "+37251234568");
    await age(agedA);
    await age(agedB);
    const freshId = await seedCall("test-retention-fresh-a", "+37255500011");

    const job = new RetentionJob({ db, getConfig: async () => retentionConfig() });
    const result = await job.run();

    expect(result.outcome).toBe("purged");
    expect(result.callsAnonymized).toBe(2);
    expect(result.transcriptsDeleted).toBe(4);
    expect(result.notesDeleted).toBe(2);
    expect(result.batches).toBe(1);

    // Aged calls: transcript + note gone, number anonymized to the exact
    // D9 format for the configured salt.
    for (const [callId, from] of [
      [agedA, "+37251234567"],
      [agedB, "+37251234568"],
    ] as const) {
      expect(await getTranscript(db, callId)).toHaveLength(0);
      expect(await getNote(db, callId)).toBeNull();
      expect((await getCallById(db, callId))?.from).toBe(expectedAnon(from));
      expect((await getCallById(db, callId))?.from).toMatch(/^anon:[0-9a-f]{12}$/);

      // Exactly ONE retention_purged event with a small detail payload;
      // pre-existing events are untouched.
      const events = await db
        .selectFrom("call_events")
        .selectAll()
        .where("call_id", "=", callId)
        .where("type", "=", "retention_purged")
        .execute();
      expect(events).toHaveLength(1);
      expect(events[0]!.detail).toMatchObject({ retentionDays: 90 });
      expect(typeof (events[0]!.detail as { purgedAt?: unknown }).purgedAt).toBe("string");
      expect(await countEvents(callId, "call_started")).toBe(1);
    }

    // The helper agrees with the independent computation above.
    expect(anonymizeNumber("+37251234567", SALT)).toBe(expectedAnon("+37251234567"));

    // Fresh call completely untouched.
    expect(await getTranscript(db, freshId)).toHaveLength(2);
    expect((await getNote(db, freshId))?.note).toEqual({ summary: "test note" });
    expect((await getCallById(db, freshId))?.from).toBe("+37255500011");
    expect(await countEvents(freshId, "retention_purged")).toBe(0);
  });

  it("is idempotent: a re-run with no newly aged calls deletes nothing and writes no events", async () => {
    const callId = await seedCall("test-retention-idem-a", "+37251230001");
    await age(callId);
    const job = new RetentionJob({ db, getConfig: async () => retentionConfig() });

    const first = await job.run();
    expect(first.outcome).toBe("purged");
    const afterFirst = await snapshot(callId);

    const second = await job.run();
    expect(second.outcome).toBe("purged");
    expect(second.callsAnonymized).toBe(0);
    expect(second.transcriptsDeleted).toBe(0);
    expect(second.notesDeleted).toBe(0);

    // Nothing changed: counts stable, number not re-hashed, no dup event.
    expect(await snapshot(callId)).toEqual(afterFirst);
    expect(await countEvents(callId, "retention_purged")).toBe(1);
  });

  it("disabled retention is a full no-op", async () => {
    const callId = await seedCall("test-retention-off-a", "+37251230002");
    await age(callId);
    const job = new RetentionJob({
      db,
      getConfig: async () => retentionConfig({ enabled: false }),
    });

    const result = await job.run();
    expect(result.outcome).toBe("skipped_disabled");

    expect(await getTranscript(db, callId)).toHaveLength(2);
    expect(await getNote(db, callId)).not.toBeNull();
    expect((await getCallById(db, callId))?.from).toBe("+37251230002");
    expect(await countEvents(callId, "retention_purged")).toBe(0);
  });

  it("enabled without hashSalt skips the whole run (fail-safe: no deletes, no anonymization)", async () => {
    const callId = await seedCall("test-retention-nosalt-a", "+37251230003");
    await age(callId);
    const job = new RetentionJob({
      db,
      getConfig: async () => retentionConfig({ hashSalt: "" }),
    });

    const result = await job.run();
    expect(result.outcome).toBe("skipped_no_salt");

    expect(await getTranscript(db, callId)).toHaveLength(2);
    expect(await getNote(db, callId)).not.toBeNull();
    expect((await getCallById(db, callId))?.from).toBe("+37251230003");
    expect(await countEvents(callId, "retention_purged")).toBe(0);
  });

  it("overlapping runs no-op via the in-flight guard", async () => {
    let release!: (config: AppConfig) => void;
    // The first run blocks inside getConfig; the second must skip.
    const gate = new Promise<AppConfig>((resolve) => {
      release = resolve;
    });
    const job = new RetentionJob({ db, getConfig: () => gate });

    const first = job.run();
    const second = await job.run();
    expect(second.outcome).toBe("skipped_inflight");

    release(retentionConfig());
    expect((await first).outcome).toBe("purged");
  });
});
