/**
 * Real-database round-trip for TranscriptWriter (skipped without
 * DATABASE_URL). Kept in a separate file from the mocked-db tests so the
 * module-level vi.mock there cannot intercept the writer's inserts here.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { getTranscript, insertCall } from "../../src/db/queries.js";
import type { Database } from "../../src/db/schema.js";
import type { Logger } from "../../src/logging.js";
import { TranscriptWriter } from "../../src/notes/transcript-writer.js";
import { createScratchDb, type ScratchDb } from "../helpers/scratch-db.js";

const databaseUrl = process.env.DATABASE_URL;

const silentLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

describe.skipIf(!databaseUrl)("TranscriptWriter (real db)", () => {
  // Scratch database: the fixture call rows (and the writer's transcript
  // inserts) stay on the isolated database, never the shared server.
  let scratch: ScratchDb;
  let db: Kysely<Database>;

  beforeAll(async () => {
    scratch = await createScratchDb("transcript_writer_db");
    db = scratch.db;
  });

  afterAll(async () => {
    if (scratch) await scratch.destroy();
  });

  it("persists utterances round-trip and survives the call-id race", async () => {
    const callSid = "test-writer-round-trip";
    let callId: number | undefined = undefined;
    const writer = new TranscriptWriter({ db, callId: () => callId, logger: silentLogger });

    // 1) Utterances written before the calls row exists get buffered...
    void writer.write({ speaker: "caller", text: "Tere, mul on küsimus", language: "et", atMs: 0 });
    void writer.write({
      speaker: "agent",
      text: "Tere! Kuidas saan aidata?",
      language: "et",
      atMs: 900,
    });

    // 2) ...then the calls row is inserted and the session learns its id.
    callId = await insertCall(db, { callSid, from: "+37251234567", provider: "twilio" });

    // 3) A later write flushes the buffer and its own row.
    await writer.write({ speaker: "caller", text: "Arve kohta", language: "et", atMs: 2000 });

    const transcript = await getTranscript(db, callId);
    expect(transcript.map((r) => ({ speaker: r.speaker, text: r.text, atMs: r.atMs }))).toEqual([
      { speaker: "caller", text: "Tere, mul on küsimus", atMs: 0 },
      { speaker: "agent", text: "Tere! Kuidas saan aidata?", atMs: 900 },
      { speaker: "caller", text: "Arve kohta", atMs: 2000 },
    ]);
  });
});
