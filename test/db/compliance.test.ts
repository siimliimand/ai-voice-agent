import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getCallById,
  insertCall,
  listCalls,
  setCallConsent,
  setCallEscalated,
} from "../../src/db/queries.js";
import type { Database } from "../../src/db/schema.js";
import { createScratchDb, type ScratchDb } from "../helpers/scratch-db.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("db calls consent/escalated columns", () => {
  // Scratch database: this suite writes calls rows; the isolated database
  // keeps them (and the cleanup deletes below) away from the shared server.
  let scratch: ScratchDb;
  let db: Kysely<Database>;

  beforeAll(async () => {
    scratch = await createScratchDb("db_compliance");
    db = scratch.db;
  });

  afterAll(async () => {
    if (scratch) await scratch.destroy();
  });

  it("defaults to consent=null and escalated=false, setters update and read back", async () => {
    const callId = await insertCall(db, {
      callSid: "test-compliance-caabcdef1234567890",
      from: "+37251234567",
      to: "+37260000000",
      provider: "twilio",
    });

    // Fresh insert: consent not asked yet, escalation flag off.
    const fresh = await getCallById(db, callId);
    expect(fresh?.consent).toBeNull();
    expect(fresh?.escalated).toBe(false);

    // setCallConsent — and a later decline overwrites an earlier grant.
    await setCallConsent(db, callId, "granted");
    expect((await getCallById(db, callId))?.consent).toBe("granted");
    await setCallConsent(db, callId, "declined");
    expect((await getCallById(db, callId))?.consent).toBe("declined");

    // setCallEscalated — both directions.
    await setCallEscalated(db, callId, true);
    expect((await getCallById(db, callId))?.escalated).toBe(true);
    await setCallEscalated(db, callId, false);
    expect((await getCallById(db, callId))?.escalated).toBe(false);
  });

  it("exposes the new columns via listCalls and rejects invalid consent values", async () => {
    const callId = await insertCall(db, {
      callSid: "test-compliance-cbbabcdef1234567890",
      from: "+37251234568",
    });
    await setCallConsent(db, callId, "granted");
    await setCallEscalated(db, callId, true);

    const ours = (await listCalls(db, { limit: 50 })).find(
      (c) => c.callSid === "test-compliance-cbbabcdef1234567890",
    );
    expect(ours).toMatchObject({ consent: "granted", escalated: true });

    // DB-level CHECK guard on top of the type system.
    await expect(
      db
        .updateTable("calls")
        .set({ consent: "maybe" as never })
        .where("id", "=", callId)
        .execute(),
    ).rejects.toThrow();
  });
});
