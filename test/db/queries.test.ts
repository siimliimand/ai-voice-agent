import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import {
  finalizeCall,
  getCallById,
  getCallBySid,
  getNote,
  getTranscript,
  insertCall,
  insertCallEvent,
  insertUtterance,
  listCalls,
  upsertNote,
} from "../../src/db/queries.js";
import type { Database } from "../../src/db/schema.js";
import { createScratchDb, type ScratchDb } from "../helpers/scratch-db.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("db queries", () => {
  // Scratch database: this suite writes calls/transcripts/notes/events rows;
  // the isolated database keeps them away from the shared server.
  let scratch: ScratchDb;
  let db: Kysely<Database>;

  beforeAll(async () => {
    scratch = await createScratchDb("db_queries");
    db = scratch.db;
  });

  afterAll(async () => {
    if (scratch) await scratch.destroy();
  });

  it("round-trips a call end to end", async () => {
    // insertCall
    const callId = await insertCall(db, {
      callSid: "test-queries-caabcdef1234567890",
      from: "+37251234567",
      to: "+37260000000",
      provider: "twilio",
    });
    expect(Number.isInteger(callId)).toBe(true);

    // idempotent on call_sid: same id returned
    const again = await insertCall(db, {
      callSid: "test-queries-caabcdef1234567890",
      from: "+37251234567",
    });
    expect(again).toBe(callId);

    // insertUtterance
    const uttId = await insertUtterance(db, {
      callId,
      speaker: "caller",
      text: "Tere, mul on küsimus",
      language: "et",
      atMs: 1500,
    });
    expect(Number.isInteger(uttId)).toBe(true);
    await insertUtterance(db, {
      callId,
      speaker: "agent",
      text: "Tere! Kuidas saan aidata?",
      language: "et",
      atMs: 3200,
    });

    // insertCallEvent
    await insertCallEvent(db, {
      callId,
      type: "stream.start",
      detail: { mediaWsPath: "/media/twilio" },
    });

    // finalizeCall
    await finalizeCall(db, callId, { status: "completed", durationS: 42, language: "et" });

    // upsertNote (twice — second upsert replaces)
    const note = { summary: "Caller asked about billing", language: "et", topics: ["billing"] };
    await upsertNote(db, { callId, note, model: "test-model" });
    await upsertNote(db, { callId, note, model: "test-model-2" });

    // getCallBySid / getCallById shapes
    const bySid = await getCallBySid(db, "test-queries-caabcdef1234567890");
    expect(bySid).toMatchObject({
      id: callId,
      callSid: "test-queries-caabcdef1234567890",
      from: "+37251234567",
      to: "+37260000000",
      provider: "twilio",
      language: "et",
      status: "completed",
      durationS: 42,
    });
    expect(bySid?.startedAt).toBeInstanceOf(Date);
    expect(bySid?.endedAt).toBeInstanceOf(Date);

    const byId = await getCallById(db, callId);
    expect(byId?.callSid).toBe("test-queries-caabcdef1234567890");
    expect(await getCallBySid(db, "test-does-not-exist")).toBeNull();

    // getTranscript
    const transcript = await getTranscript(db, callId);
    expect(transcript).toHaveLength(2);
    expect(transcript[0]).toMatchObject({
      callId,
      speaker: "caller",
      text: "Tere, mul on küsimus",
      language: "et",
      atMs: 1500,
    });
    expect(transcript[1]?.speaker).toBe("agent");

    // getNote — last upsert wins
    const storedNote = await getNote(db, callId);
    expect(storedNote).toMatchObject({ callId, model: "test-model-2" });
    expect(storedNote?.note).toEqual(note);
    expect(await getNote(db, 999999)).toBeNull();

    // listCalls — newest first with note excerpt joined
    const list = await listCalls(db, { limit: 50 });
    const ours = list.find((c) => c.callSid === "test-queries-caabcdef1234567890");
    expect(ours).toBeDefined();
    expect(ours).toMatchObject({
      id: callId,
      status: "completed",
      noteSummary: "Caller asked about billing",
      noteModel: "test-model-2",
    });
    const idx = list.findIndex((c) => c.callSid.startsWith("test-queries-"));
    if (list.length > 1 && idx > 0) {
      expect(list[idx - 1]!.startedAt.getTime()).toBeGreaterThanOrEqual(
        list[idx]!.startedAt.getTime(),
      );
    }
  });
});
