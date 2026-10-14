import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import type { Database } from "../../src/db/schema.js";
import type { ChatOptions } from "../../src/llm/openrouter.js";
import type { Logger } from "../../src/logging.js";
import { CallSession } from "../../src/session/call-session.js";
import { CallSessionManager } from "../../src/session/manager.js";
import { attachNotesPipeline } from "../../src/notes/index.js";
import { getCallById, getTranscript, insertCallEvent, upsertNote } from "../../src/db/queries.js";
import type { CallRow, TranscriptRow } from "../../src/db/queries.js";

vi.mock("../../src/db/queries.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../src/db/queries.js");
  return {
    ...actual,
    getCallById: vi.fn(async () => null as CallRow | null),
    getTranscript: vi.fn(async (): Promise<TranscriptRow[]> => [
      { id: 1, callId: 11, speaker: "caller", text: "Tere", language: "et", atMs: 0 },
    ]),
    upsertNote: vi.fn(async () => undefined),
    insertCallEvent: vi.fn(async () => 1),
  };
});

const getCallByIdMock = vi.mocked(getCallById);
const getTranscriptMock = vi.mocked(getTranscript);
const upsertNoteMock = vi.mocked(upsertNote);
const insertCallEventMock = vi.mocked(insertCallEvent);

const silentLogger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};
const logger = silentLogger as unknown as Logger;

const fakeDb = {} as Kysely<Database>;

const config = (notesEnabled: boolean): AppConfig =>
  configSchema.parse({ notes: { enabled: notesEnabled }, llm: { models: { summarizer: "m" } } });

const validNoteJson = JSON.stringify({
  summary: "s",
  language: "et",
  client: null,
  intents: [],
  actions_taken: [],
  unresolved_issues: [],
  follow_ups: [],
  urgency: "normal",
  sentiment: "neutral",
});

const chat = vi.fn<(opts: ChatOptions) => Promise<string>>(async () => validNoteJson);

const endedSession = (
  callId: number | undefined,
): { sessions: CallSessionManager; session: CallSession } => {
  const sessions = new CallSessionManager();
  const session = new CallSession({
    callSid: "test-pipeline-call",
    from: "+37251234567",
    provider: "twilio",
  });
  if (callId !== undefined) session.meta["callId"] = callId;
  sessions.create(session);
  return { sessions, session };
};

beforeEach(() => {
  chat.mockClear().mockResolvedValue(validNoteJson);
  getCallByIdMock.mockClear().mockResolvedValue(null);
  getTranscriptMock.mockClear();
  upsertNoteMock.mockClear().mockResolvedValue(undefined);
  insertCallEventMock.mockClear().mockResolvedValue(1);
  silentLogger.error.mockClear();
  silentLogger.warn.mockClear();
});

describe("attachNotesPipeline", () => {
  it("summarizes fire-and-forget when an enabled session ends", async () => {
    const { sessions, session } = endedSession(11);
    attachNotesPipeline({ db: fakeDb, sessions, config: config(true), llm: { chat }, logger });

    sessions.end(session, "completed");

    await vi.waitFor(() => {
      expect(upsertNoteMock).toHaveBeenCalledWith(fakeDb, {
        callId: 11,
        note: expect.anything(),
        model: "m",
      });
    });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("does nothing when notes are disabled", async () => {
    const { sessions, session } = endedSession(11);
    attachNotesPipeline({ db: fakeDb, sessions, config: config(false), llm: { chat }, logger });

    sessions.end(session, "completed");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(chat).not.toHaveBeenCalled();
    expect(upsertNoteMock).not.toHaveBeenCalled();
  });

  it("skips (with a warning) when the session carries no callId", async () => {
    const { sessions, session } = endedSession(undefined);
    attachNotesPipeline({ db: fakeDb, sessions, config: config(true), llm: { chat }, logger });

    sessions.end(session, "completed");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(chat).not.toHaveBeenCalled();
    expect(silentLogger.warn).toHaveBeenCalled();
  });

  it("isolates summarizeCall failures: logs but never rejects into the emitter", async () => {
    chat.mockImplementation(async () => {
      throw new Error("llm exploded");
    });
    const { sessions, session } = endedSession(12);
    attachNotesPipeline({ db: fakeDb, sessions, config: config(true), llm: { chat }, logger });

    // If the pipeline leaked the rejection, the emit below would trigger an
    // unhandled rejection and vitest would fail the run.
    expect(() => sessions.end(session, "completed")).not.toThrow();

    await vi.waitFor(() => {
      expect(insertCallEventMock).toHaveBeenCalledWith(fakeDb, {
        callId: 12,
        type: "note_failed",
        detail: { error: "llm exploded" },
      });
    });
    expect(silentLogger.error).toHaveBeenCalled();
  });

  it("forces the stored note urgent when the session was escalated (task 5.1)", async () => {
    const { sessions, session } = endedSession(11);
    session.meta["escalated"] = true; // set by the escalation handler (design D7)
    attachNotesPipeline({ db: fakeDb, sessions, config: config(true), llm: { chat }, logger });

    sessions.end(session, "completed");

    await vi.waitFor(() => expect(upsertNoteMock).toHaveBeenCalled());
    const stored = upsertNoteMock.mock.calls[0]?.[1]?.note as {
      urgency: string;
      actions_taken: string[];
    };
    // The model said "normal"; the escalation forces high + the action.
    expect(stored.urgency).toBe("high");
    expect(stored.actions_taken).toContain("escalated the call to a human agent");
  });
});
