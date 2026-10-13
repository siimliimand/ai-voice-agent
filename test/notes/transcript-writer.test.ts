import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import { insertCallEvent, insertUtterance } from "../../src/db/queries.js";
import type { Database } from "../../src/db/schema.js";
import { TranscriptWriter } from "../../src/notes/transcript-writer.js";
import type { Logger } from "../../src/logging.js";

vi.mock("../../src/db/queries.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../src/db/queries.js");
  return {
    ...actual,
    insertUtterance: vi.fn(async () => 1),
    insertCallEvent: vi.fn(async () => 2),
  };
});

const insertUtteranceMock = vi.mocked(insertUtterance);
const insertCallEventMock = vi.mocked(insertCallEvent);

/** The queries module is mocked, so the db handle is never actually used. */
const fakeDb = {} as Kysely<Database>;

const silentLogger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};

/** Stub shaped as the pino Logger the writer expects. */
const logger = silentLogger as unknown as Logger;

const utterance = (text: string, atMs: number) => ({
  speaker: "caller" as const,
  text,
  language: "et" as const,
  atMs,
});

beforeEach(() => {
  insertUtteranceMock.mockClear().mockResolvedValue(1);
  insertCallEventMock.mockClear().mockResolvedValue(2);
  silentLogger.error.mockClear();
});

describe("TranscriptWriter (mocked db)", () => {
  it("buffers utterances until the call id getter resolves, then flushes in order", async () => {
    // Initialized explicitly so `callId = ...` is a reassignment, not the
    // single assignment prefer-const would fold into a `const`.
    let callId: number | undefined = undefined;
    const writer = new TranscriptWriter({
      db: fakeDb,
      callId: () => callId,
      logger,
    });

    // Race: session started but the calls row is not inserted yet.
    void writer.write(utterance("Tere", 0));
    void writer.write(utterance("Mul on küsimus", 1500));
    expect(writer.pendingCount).toBe(2);
    expect(insertUtteranceMock).not.toHaveBeenCalled();

    callId = 42;
    await writer.write(utterance("Aitäh", 4000));

    expect(insertUtteranceMock).toHaveBeenCalledTimes(3);
    // insertUtterance(db, input) — index the input argument.
    expect(insertUtteranceMock.mock.calls.map((c) => c[1])).toEqual([
      { callId: 42, speaker: "caller", text: "Tere", language: "et", atMs: 0 },
      { callId: 42, speaker: "caller", text: "Mul on küsimus", language: "et", atMs: 1500 },
      { callId: 42, speaker: "caller", text: "Aitäh", language: "et", atMs: 4000 },
    ]);
    expect(writer.pendingCount).toBe(0);
  });

  it("accepts a plain number call id", async () => {
    const writer = new TranscriptWriter({ db: fakeDb, callId: 7, logger });
    await writer.write(utterance("hello", 10));
    expect(insertUtteranceMock).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ callId: 7, text: "hello" }),
    );
  });

  it("background-retries and flushes buffered rows once the id appears", async () => {
    let callId: number | undefined = undefined;
    const writer = new TranscriptWriter({
      db: fakeDb,
      callId: () => callId,
      logger,
    });

    void writer.write(utterance("alone near call start", 100));
    callId = 9;
    await vi.waitFor(
      () => {
        expect(insertUtteranceMock).toHaveBeenCalled();
      },
      { timeout: 3_000, interval: 20 },
    );
    expect(insertUtteranceMock).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ callId: 9, text: "alone near call start" }),
    );
  });

  it("never throws: insert failure logs and records transcript_write_failed", async () => {
    insertUtteranceMock.mockRejectedValueOnce(new Error("db down"));
    const writer = new TranscriptWriter({ db: fakeDb, callId: 5, logger });

    await expect(writer.write(utterance("will fail", 0))).resolves.toBeUndefined();

    expect(silentLogger.error).toHaveBeenCalled();
    expect(insertCallEventMock).toHaveBeenCalledTimes(1);
    expect(insertCallEventMock).toHaveBeenCalledWith(fakeDb, {
      callId: 5,
      type: "transcript_write_failed",
      detail: { error: "db down", speaker: "caller", atMs: 0 },
    });
  });

  it("still resolves when recording the failure event also fails", async () => {
    insertUtteranceMock.mockRejectedValueOnce(new Error("db down"));
    insertCallEventMock.mockRejectedValueOnce(new Error("event insert down"));
    const writer = new TranscriptWriter({ db: fakeDb, callId: 5, logger });

    await expect(writer.write(utterance("double failure", 0))).resolves.toBeUndefined();
    expect(silentLogger.error).toHaveBeenCalled();
  });

  it("maps null language to undefined on the insert input", async () => {
    const writer = new TranscriptWriter({ db: fakeDb, callId: 3, logger });
    await writer.write({ speaker: "agent", text: "Tere!", language: null, atMs: 5 });
    expect(insertUtteranceMock).toHaveBeenCalledWith(fakeDb, {
      callId: 3,
      speaker: "agent",
      text: "Tere!",
      language: undefined,
      atMs: 5,
    });
  });
});
