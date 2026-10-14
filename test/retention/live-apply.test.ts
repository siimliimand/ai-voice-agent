/**
 * Retention settings live-apply (task 6.2) at the composition-root level:
 * PUT /api/settings persists retention overrides and invalidates the
 * effective-config resolver, so the NEXT RetentionJob.run() (via
 * AppHandle.retention, the same object the shutdown path stops) uses the new
 * retention.enabled / retention.days / retention.hashSalt without a restart.
 *
 * Proof of "new days": the fixture is aged 10 days — purged under
 * days=5 but kept by the default window of 90 — so only a run that actually
 * picked up the saved settings can purge it. Flipping enabled=false through
 * the same API then turns the next run into a full no-op.
 *
 * Runs against its own scratch database on the same Postgres server: the
 * retention job purges GLOBALLY, so sharing the default test database would
 * let this suite eat other suites' backdated fixtures mid-flight (and a
 * shared settings row would race the settings API suite). skipIf no
 * DATABASE_URL, like the other DB-backed suites.
 */
import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp, type AppHandle } from "../../src/app.js";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import {
  getCallById,
  getNote,
  getTranscript,
  insertCall,
  insertUtterance,
  upsertNote,
} from "../../src/db/queries.js";
import type { Database } from "../../src/db/schema.js";
import type { RetentionRunSummary } from "../../src/retention/index.js";
import { createScratchDb, type ScratchDb } from "../helpers/scratch-db.js";

const databaseUrl = process.env.DATABASE_URL;

const ADMIN_USER = "admin";
const ADMIN_PASSWORD = "live-apply-admin";
const SALT = "live-apply-salt";

const authHeader = (): string =>
  `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString("base64")}`;

/** Expected D9 anonymization for the salt saved through the settings API. */
const expectedAnon = (from: string): string =>
  `anon:${createHash("sha256").update(from + SALT).digest("hex").slice(0, 12)}`;

/** Backdate a call's started_at so it falls before a retention cutoff. */
const daysAgo = (days: number): Date => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

describe.skipIf(!databaseUrl)("retention settings live-apply", () => {
  // Scratch database (shared helper). The retention job purges GLOBALLY, so
  // sharing the default test database would let this suite eat other suites'
  // backdated fixtures mid-flight (and a shared settings row would race the
  // settings API suite).
  let scratch: ScratchDb;
  let db: Kysely<Database>; // the scratch database the app under test uses
  let handle: AppHandle;

  const putSettings = async (values: Record<string, unknown>): Promise<number> => {
    const res = await handle.app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { authorization: authHeader(), "content-type": "application/json" },
      payload: JSON.stringify({ values }),
    });
    return res.statusCode;
  };

  const runJob = async (): Promise<RetentionRunSummary> => {
    const job = handle.retention;
    if (!job) throw new Error("retention job is not wired (db missing?)");
    return job.run();
  };

  /** Insert a call with 1 transcript and 1 note. */
  async function seedCall(sid: string, from: string): Promise<number> {
    const callId = await insertCall(db, { callSid: sid, from, provider: "twilio" });
    await insertUtterance(db, {
      callId,
      speaker: "caller",
      text: "Tere, palun abi",
      language: "et",
      atMs: 0,
    });
    await upsertNote(db, { callId, note: { summary: "live-apply note" }, model: "test-model" });
    return callId;
  }

  beforeAll(async () => {
    scratch = await createScratchDb("retention_live_apply");
    db = scratch.db;
    // retention disabled in the BASE config: the job's startup run is a
    // deterministic no-op, so only the saved settings can arm a purge.
    const baseConfig: AppConfig = configSchema.parse({
      admin: { user: ADMIN_USER, password: ADMIN_PASSWORD },
      logLevel: "error",
      retention: { enabled: false },
    });
    handle = await buildApp(baseConfig, { db });
  });

  afterAll(async () => {
    await handle?.close();
    // Dropping the scratch database removes the fixture calls/settings rows —
    // no shared-table deletes.
    if (scratch) await scratch.destroy();
  });

  it("a saved retention.days/enabled/hashSalt applies on the next run without a restart", async () => {
    // Save the new retention config through the settings API; the PUT
    // invalidates the resolver the job reads per run.
    const put = await putSettings({
      retention: { enabled: true, days: 5, hashSalt: SALT },
    });
    expect(put).toBe(200);

    // The 10-day-old fixture is the live-apply proof: inside the new 5-day
    // window, but a default-90 run would keep it. Seeded AFTER the PUT so
    // even the (disabled) startup run could never see it.
    const aged = await seedCall("test-retention-live-aged", "+37260000001");
    await db.updateTable("calls").set({ started_at: daysAgo(10) }).where("id", "=", aged).execute();
    const fresh = await seedCall("test-retention-live-fresh", "+37260000002");
    await db
      .updateTable("calls")
      .set({ started_at: daysAgo(1) })
      .where("id", "=", fresh)
      .execute();

    const result = await runJob();
    expect(result.outcome).toBe("purged");
    expect(result.retentionDays).toBe(5); // the SAVED window, not the default 90

    // Aged call: purged using the saved salt (D9 anonymization format).
    expect(await getTranscript(db, aged)).toHaveLength(0);
    expect(await getNote(db, aged)).toBeNull();
    expect((await getCallById(db, aged))?.from).toBe(expectedAnon("+37260000001"));
    expect((await getCallById(db, aged))?.from).toMatch(/^anon:[0-9a-f]{12}$/);
    const events = await db
      .selectFrom("call_events")
      .selectAll()
      .where("call_id", "=", aged)
      .where("type", "=", "retention_purged")
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({ retentionDays: 5 });

    // Fresh call (1 day < 5-day window) is untouched.
    expect(await getTranscript(db, fresh)).toHaveLength(1);
    expect(await getNote(db, fresh)).not.toBeNull();
    expect((await getCallById(db, fresh))?.from).toBe("+37260000002");

    // The salt is write-only: never echoed back by GET /api/settings.
    const get = await handle.app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { authorization: authHeader() },
    });
    expect(get.statusCode).toBe(200);
    expect(get.body).not.toContain(SALT);
  });

  it("flipping retention.enabled=false via the same API no-ops the next run", async () => {
    expect(await putSettings({ retention: { enabled: false } })).toBe(200);

    // Would be purged (10 days > 5-day window) if the flip had not applied.
    const aged = await seedCall("test-retention-live-off", "+37260000003");
    await db.updateTable("calls").set({ started_at: daysAgo(10) }).where("id", "=", aged).execute();

    const result = await runJob();
    expect(result.outcome).toBe("skipped_disabled");

    // Full no-op: number, transcript and note all intact.
    expect((await getCallById(db, aged))?.from).toBe("+37260000003");
    expect(await getTranscript(db, aged)).toHaveLength(1);
    expect(await getNote(db, aged)).not.toBeNull();
    const events = await db
      .selectFrom("call_events")
      .selectAll()
      .where("call_id", "=", aged)
      .where("type", "=", "retention_purged")
      .execute();
    expect(events).toHaveLength(0);
  });
});
