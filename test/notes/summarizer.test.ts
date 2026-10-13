import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import type { Database } from "../../src/db/schema.js";
import type { ChatOptions } from "../../src/llm/openrouter.js";
import { parseNote, summarizeCall } from "../../src/notes/summarizer.js";
import type { TranscriptRow } from "../../src/db/queries.js";
import { getTranscript, insertCallEvent, upsertNote } from "../../src/db/queries.js";

vi.mock("../../src/db/queries.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../src/db/queries.js");
  return {
    ...actual,
    getTranscript: vi.fn(async () => [] as TranscriptRow[]),
    upsertNote: vi.fn(async () => undefined),
    insertCallEvent: vi.fn(async () => 1),
  };
});

import type { Logger } from "../../src/logging.js";

const getTranscriptMock = vi.mocked(getTranscript);
const upsertNoteMock = vi.mocked(upsertNote);
const insertCallEventMock = vi.mocked(insertCallEvent);

const config: AppConfig = configSchema.parse({
  llm: { models: { summarizer: "test-summarizer-model" } },
});

const silentLogger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};

const logger = silentLogger as unknown as Logger;

const fakeDb = {} as Kysely<Database>;

const transcript: TranscriptRow[] = [
  {
    id: 1,
    callId: 11,
    speaker: "caller",
    text: "Tere, mul on küsimus arve kohta.",
    language: "et",
    atMs: 0,
  },
  {
    id: 2,
    callId: 11,
    speaker: "agent",
    text: "Tere! Kuidas saan aidata?",
    language: "et",
    atMs: 1200,
  },
];

const validNoteJson = `{
  "summary": "Caller asked about their invoice.",
  "language": "et",
  "client": null,
  "intents": ["billing question"],
  "actions_taken": [],
  "unresolved_issues": [],
  "follow_ups": [],
  "urgency": "low",
  "sentiment": "neutral"
}`;

const chat = vi.fn<(opts: ChatOptions) => Promise<string>>(async () => validNoteJson);

const opts = () => ({ db: fakeDb, llm: { chat }, config, callId: 11, logger });

beforeEach(() => {
  chat.mockClear().mockResolvedValue(validNoteJson);
  getTranscriptMock.mockClear().mockResolvedValue(transcript);
  upsertNoteMock.mockClear().mockResolvedValue(undefined);
  insertCallEventMock.mockClear().mockResolvedValue(1);
});

describe("parseNote", () => {
  it("parses plain JSON", () => {
    const note = parseNote(validNoteJson);
    expect(note.summary).toBe("Caller asked about their invoice.");
    expect(note.language).toBe("et");
    expect(note.client).toBeNull();
    expect(note.urgency).toBe("low");
  });

  it("strips markdown code fences", () => {
    const fenced = "```json\n" + validNoteJson + "\n```";
    expect(parseNote(fenced).summary).toBe("Caller asked about their invoice.");
  });

  it("finds the JSON object inside surrounding prose", () => {
    const noisy = "Here is the note you asked for:\n" + validNoteJson + "\nLet me know!";
    expect(parseNote(noisy).language).toBe("et");
  });

  it("throws a clear error when no JSON object exists", () => {
    expect(() => parseNote("no json here at all")).toThrow(/no JSON object/);
  });

  it("throws when the object does not match the schema", () => {
    expect(() => parseNote('{"summary": ""}')).toThrow(/note schema/);
  });
});

describe("summarizeCall", () => {
  it("summarizes, upserts the note and records note_generated", async () => {
    const note = await summarizeCall(opts());

    expect(note.summary).toBe("Caller asked about their invoice.");
    expect(chat).toHaveBeenCalledTimes(1);
    const chatOpts = chat.mock.calls[0]![0];
    expect(chatOpts.model).toBe("test-summarizer-model");

    // user message renders caller:/agent: lines
    const userMessage = chatOpts.messages.find((m) => m.role === "user");
    expect(userMessage?.content).toContain("caller: Tere, mul on küsimus arve kohta.");
    expect(userMessage?.content).toContain("agent: Tere! Kuidas saan aidata?");
    // system message demands JSON-only output
    const systemMessage = chatOpts.messages.find((m) => m.role === "system");
    expect(systemMessage?.content).toMatch(/JSON/i);

    expect(upsertNoteMock).toHaveBeenCalledWith(fakeDb, {
      callId: 11,
      note,
      model: "test-summarizer-model",
    });
    expect(insertCallEventMock).toHaveBeenCalledWith(fakeDb, {
      callId: 11,
      type: "note_generated",
      detail: { model: "test-summarizer-model" },
    });
  });

  it("parses fenced model output", async () => {
    chat.mockResolvedValue("```json\n" + validNoteJson + "\n```");
    const note = await summarizeCall(opts());
    expect(note.summary).toBe("Caller asked about their invoice.");
    expect(upsertNoteMock).toHaveBeenCalledTimes(1);
  });

  it("retries once with a corrective message and then succeeds", async () => {
    chat.mockImplementationOnce(async () => "definitely not json");
    const note = await summarizeCall(opts());

    expect(chat).toHaveBeenCalledTimes(2);
    expect(note.summary).toBe("Caller asked about their invoice.");

    const retryOpts = chat.mock.calls[1]![0];
    const roles = retryOpts.messages.map((m) => m.role);
    // assistant (invalid output) + corrective user message appended
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
    expect(retryOpts.messages[2]?.content).toBe("definitely not json");
    expect(retryOpts.messages[3]?.content).toMatch(/invalid/i);

    expect(insertCallEventMock.mock.calls.some((call) => call[1]?.type === "note_failed")).toBe(
      false,
    );
  });

  it("records note_failed and rethrows after the retry also fails", async () => {
    chat.mockImplementation(async () => "still not json");
    await expect(summarizeCall(opts())).rejects.toThrow(/no JSON object/);

    expect(chat).toHaveBeenCalledTimes(2); // exactly ONE retry
    expect(upsertNoteMock).not.toHaveBeenCalled();
    expect(insertCallEventMock).toHaveBeenCalledWith(fakeDb, {
      callId: 11,
      type: "note_failed",
      detail: { error: expect.stringContaining("no JSON object") },
    });
  });

  it("throws a clear error for an empty transcript without calling the LLM", async () => {
    getTranscriptMock.mockResolvedValue([]);
    await expect(summarizeCall(opts())).rejects.toThrow(/transcript is empty/);
    expect(chat).not.toHaveBeenCalled();
    expect(upsertNoteMock).not.toHaveBeenCalled();
  });

  it("uses the summarizer role model from config (no language context)", async () => {
    const withOverride = configSchema.parse({
      llm: {
        models: { summarizer: "default-sum" },
        overrides: { et: { summarizer: "et-sum" } },
      },
    });
    await summarizeCall({ db: fakeDb, llm: { chat }, config: withOverride, callId: 11, logger });
    // The summarizer role is resolved without a language, so the role default wins.
    expect(chat.mock.calls[0]![0].model).toBe("default-sum");
  });
});
