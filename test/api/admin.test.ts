import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import { registerBasicAuth } from "../../src/auth/basic-auth.js";
import {
  registerAdminApi,
  type CallListItemDto,
  type CallDto,
  type NoteDto,
  type TranscriptEntryDto,
} from "../../src/api/routes.js";
import { registerAdminPages } from "../../src/web/admin/pages.js";
import type { CallListItem, CallRow, NoteRow, TranscriptRow } from "../../src/db/queries.js";

const USERNAME = "admin";
const PASSWORD = "s3cret";
const STARTED_AT = new Date("2026-10-13T14:05:09.000Z");
const ENDED_AT = new Date("2026-10-13T14:07:39.000Z");
const LONG_SUMMARY = "x".repeat(200);

const authHeader = (user = USERNAME, pass = PASSWORD): string =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

function makeCallRow(overrides: Partial<CallRow> = {}): CallRow {
  return {
    id: 1,
    callSid: "CA1555550101",
    from: "+37251234567",
    to: "+37260000000",
    provider: "twilio",
    language: "et",
    status: "completed",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    durationS: 150,
    consent: null,
    escalated: false,
    ...overrides,
  };
}

function makeListItem(overrides: Partial<CallListItem> = {}): CallListItem {
  return { ...makeCallRow(), noteSummary: null, noteModel: null, ...overrides };
}

const ITEM_1: CallListItem = makeListItem({
  noteSummary: LONG_SUMMARY,
  noteModel: "gpt-4o-mini",
  consent: "granted",
});
const ITEM_2: CallListItem = makeListItem({
  id: 2,
  callSid: "CA1555550102",
  from: "<script>alert(1)</script>",
  status: "in_progress",
  language: null,
  endedAt: null,
  durationS: null,
  noteSummary: "<script>alert(1)</script>",
  consent: "declined",
  escalated: true,
});

const TRANSCRIPT: TranscriptRow[] = [
  {
    id: 11,
    callId: 1,
    speaker: "caller",
    text: "Tere, mul on küsimus arve kohta <img src=x onerror=alert(1)>",
    language: "et",
    atMs: 1500,
  },
  {
    id: 12,
    callId: 1,
    speaker: "agent",
    text: "Tere! Millist arvet te silmas peate?",
    language: "et",
    atMs: 32_000,
  },
  { id: 13, callId: 1, speaker: "caller", text: "Oktoobri oma.", language: "et", atMs: 90_500 },
];

const NOTE_ROW: NoteRow = {
  callId: 1,
  model: "gpt-4o-mini",
  createdAt: new Date("2026-10-13T14:08:00.000Z"),
  updatedAt: new Date("2026-10-13T14:08:00.000Z"),
  note: {
    summary: 'Caller asked for the October invoice copy "before Friday" & was reassured.',
    client: "OÜ Näide",
    intents: ["billing", "invoice copy"],
    actions_taken: ["located the October invoice", "promised to email a copy"],
    unresolved_issues: ["invoice arrives after the agreed deadline"],
    follow_ups: ["email invoice before Friday"],
    urgency: "medium",
    sentiment: "positive",
  },
};

function makeFakeDb() {
  return {
    listCalls: vi.fn(async (_opts?: { limit?: number; offset?: number }) => [ITEM_1, ITEM_2]),
    getCallById: vi.fn(async (id: number) => (id === 1 ? makeCallRow() : null)),
    getCallBySid: vi.fn(async (_sid: string) => null),
    getTranscript: vi.fn(async (_callId: number) => TRANSCRIPT),
    getNote: vi.fn(async (_callId: number): Promise<NoteRow | null> => NOTE_ROW),
    countCallsByStatus: vi.fn(async () => ({ in_progress: 1, completed: 1, failed: 0 })),
  };
}
type FakeDb = ReturnType<typeof makeFakeDb>;

function buildConfig(admin: Partial<AppConfig["admin"]> = {}): AppConfig {
  return configSchema.parse({ admin: { user: USERNAME, password: PASSWORD, ...admin } });
}

function buildApp(db: FakeDb, config: AppConfig): FastifyInstance {
  const app = Fastify({ logger: false });
  registerBasicAuth(app, config);
  registerAdminApi(app, { db, config });
  registerAdminPages(app, { db, config });
  return app;
}

let db: FakeDb;
let app: FastifyInstance;

beforeEach(() => {
  db = makeFakeDb();
  app = buildApp(db, buildConfig());
});

afterAll(async () => {
  await app?.close();
});

interface CallsResponse {
  calls: CallListItemDto[];
  total: number;
}
interface CallDetailResponse {
  call: CallDto;
  transcript: TranscriptEntryDto[];
  note: NoteDto | null;
}

describe("basic auth", () => {
  it("responds 401 with WWW-Authenticate for unauthenticated /api/calls and /admin", async () => {
    await app.ready();
    for (const url of ["/api/calls", "/admin", "/admin/calls/1"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
      expect(res.headers["www-authenticate"], url).toBe('Basic realm="admin"');
    }
  });

  it("does not leak fixture data in unauthenticated responses", async () => {
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/admin" });
    expect(res.body).not.toContain("CA1555550101");
    const api = await app.inject({ method: "GET", url: "/api/calls" });
    expect(api.body).not.toContain("CA1555550101");
  });

  it("responds 401 with wrong credentials", async () => {
    await app.ready();
    const badUser = await app.inject({
      method: "GET",
      url: "/api/calls",
      headers: { authorization: authHeader("root", PASSWORD) },
    });
    const badPass = await app.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: authHeader(USERNAME, "nope") },
    });
    expect(badUser.statusCode).toBe(401);
    expect(badPass.statusCode).toBe(401);
  });

  it("responds 200 with valid credentials on both scopes", async () => {
    await app.ready();
    const api = await app.inject({
      method: "GET",
      url: "/api/calls",
      headers: { authorization: authHeader() },
    });
    const page = await app.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: authHeader() },
    });
    expect(api.statusCode).toBe(200);
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
  });
});

describe("GET /api/calls", () => {
  it("returns the adapted list row shape and total", async () => {
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/api/calls",
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as CallsResponse;
    expect(body.calls).toHaveLength(2);
    expect(body.total).toBe(2);

    const first = body.calls[0]!;
    expect(Object.keys(first).sort()).toEqual(
      [
        "id",
        "callSid",
        "fromNumber",
        "toNumber",
        "language",
        "status",
        "consent",
        "escalated",
        "startedAt",
        "endedAt",
        "durationS",
        "noteExcerpt",
      ].sort(),
    );
    expect(first).toMatchObject({
      id: 1,
      callSid: "CA1555550101",
      fromNumber: "+37251234567",
      toNumber: "+37260000000",
      language: "et",
      status: "completed",
      consent: "granted",
      escalated: false,
      startedAt: STARTED_AT.toISOString(),
      endedAt: ENDED_AT.toISOString(),
      durationS: 150,
      noteExcerpt: LONG_SUMMARY,
    });

    const second = body.calls[1]!;
    expect(second).toMatchObject({ consent: "declined", escalated: true });
  });

  it("defaults to limit 50 / offset 0", async () => {
    await app.ready();
    await app.inject({
      method: "GET",
      url: "/api/calls",
      headers: { authorization: authHeader() },
    });
    expect(db.listCalls.mock.lastCall?.[0]).toEqual({ limit: 50, offset: 0 });
  });

  it("clamps limit to 1..200 and offset to >= 0", async () => {
    await app.ready();
    await app.inject({
      method: "GET",
      url: "/api/calls?limit=99999&offset=-4",
      headers: { authorization: authHeader() },
    });
    expect(db.listCalls.mock.lastCall?.[0]).toEqual({ limit: 200, offset: 0 });

    await app.inject({
      method: "GET",
      url: "/api/calls?limit=0",
      headers: { authorization: authHeader() },
    });
    expect(db.listCalls.mock.lastCall?.[0]).toEqual({ limit: 1, offset: 0 });

    await app.inject({
      method: "GET",
      url: "/api/calls?limit=abc&offset=10",
      headers: { authorization: authHeader() },
    });
    expect(db.listCalls.mock.lastCall?.[0]).toEqual({ limit: 50, offset: 10 });

    await app.inject({
      method: "GET",
      url: "/api/calls?limit=25",
      headers: { authorization: authHeader() },
    });
    expect(db.listCalls.mock.lastCall?.[0]).toEqual({ limit: 25, offset: 0 });
  });
});

describe("GET /api/calls/:id", () => {
  it("returns call, transcript and note", async () => {
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/api/calls/1",
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as CallDetailResponse;
    expect(body.call).toMatchObject({
      id: 1,
      callSid: "CA1555550101",
      provider: "twilio",
      durationS: 150,
      consent: null,
      escalated: false,
    });
    expect(body.transcript).toHaveLength(3);
    expect(body.transcript[0]).toEqual({
      id: 11,
      speaker: "caller",
      text: TRANSCRIPT[0]!.text,
      language: "et",
      atMs: 1500,
      createdAt: null,
    });
    expect(body.note?.model).toBe("gpt-4o-mini");
    expect((body.note?.note as { summary?: string }).summary).toContain("October invoice copy");
  });

  it("returns note null when the call has no note", async () => {
    db.getNote.mockResolvedValue(null);
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/api/calls/1",
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as CallDetailResponse).note).toBeNull();
  });

  it("responds 400 for non-numeric ids", async () => {
    await app.ready();
    for (const id of ["abc", "1.5", "-1", "1e3", "%20"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/calls/${id}`,
        headers: { authorization: authHeader() },
      });
      expect(res.statusCode, id).toBe(400);
    }
    expect(db.getCallById).not.toHaveBeenCalled();
  });

  it("responds 404 for an unknown call", async () => {
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/api/calls/99999",
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(404);
    expect(db.getCallById).toHaveBeenCalledWith(99999);
  });
});

describe("GET /admin (call list page)", () => {
  it("renders rows with escaped data, truncation, links and status badges", async () => {
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    const html = res.body;

    // Fixture <script> values must be escaped everywhere.
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");

    // Note excerpt truncation to ~120 chars.
    expect(html).toContain(`${"x".repeat(119)}…`);
    expect(html).not.toContain("x".repeat(125));

    // Row links, human time with ISO title, duration, badge.
    expect(html).toContain('href="/admin/calls/1"');
    expect(html).toContain(`title="${STARTED_AT.toISOString()}"`);
    expect(html).toContain("2026-10-13 14:05 UTC");
    expect(html).toContain("2:30");
    expect(html).toContain("badge-completed");
    expect(html).toContain("in progress"); // badge label of in_progress
  });

  it("renders consent + escalated badges in the flags column (task 5.1)", async () => {
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    const html = res.body;

    expect(html).toContain("<th>Flags</th>");
    expect(html).toContain("badge-granted");
    expect(html).toContain("consent granted");
    expect(html).toContain("badge-declined");
    expect(html).toContain("consent declined");
    expect(html).toContain("badge-escalated");
    expect(html).toContain("escalated");
  });

  it("shows an empty state when there are no calls", async () => {
    db.listCalls.mockResolvedValue([]);
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("No calls yet");
  });
});

describe("GET /admin/calls/:id (detail page)", () => {
  it("renders metadata, speaker-attributed transcript and all note sections", async () => {
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/admin/calls/1",
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    const html = res.body;

    // Header metadata.
    expect(html).toContain("+37251234567");
    expect(html).toContain("twilio");
    expect(html).toContain("2:30");

    // Transcript: ordered speaker-attributed entries with mm:ss timestamps.
    expect(html).toContain("Caller");
    expect(html).toContain("Agent");
    expect(html).toContain("0:01");
    expect(html).toContain("0:32");
    expect(html).toContain("1:30");
    expect(html).toContain("Oktoobri oma.");

    // Transcript XSS is escaped.
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");

    // Note sections.
    for (const label of [
      "Summary",
      "Client",
      "Intents",
      "Actions taken",
      "Unresolved issues",
      "Follow-ups",
      "Urgency",
      "Sentiment",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("OÜ Näide");
    expect(html).toContain("email invoice before Friday");
    // Note values with quotes/ampersands are escaped.
    expect(html).toContain("&quot;before Friday&quot;");
    expect(html).toContain(" &amp; was reassured.");
    expect(html).not.toContain('"before Friday" &');
  });

  it("shows the empty state when the note is missing", async () => {
    db.getNote.mockResolvedValue(null);
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/admin/calls/1",
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("No note yet");
  });

  it("renders consent + escalated rows in the metadata (task 5.1)", async () => {
    db.getCallById.mockResolvedValue(makeCallRow({ consent: "granted", escalated: true }));
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/admin/calls/1",
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    expect(html).toContain("<dt>Consent</dt>");
    expect(html).toContain("consent granted");
    expect(html).toContain("<dt>Escalated</dt>");
    expect(html).toContain("badge-escalated");
  });

  it("renders an em-dash placeholder before a consent decision exists", async () => {
    await app.ready(); // default makeCallRow: consent null, escalated false
    const res = await app.inject({
      method: "GET",
      url: "/admin/calls/1",
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("badge-flag_none");
  });

  it("renders a 404 page for an unknown or non-numeric call", async () => {
    await app.ready();
    for (const id of ["99999", "abc"]) {
      const res = await app.inject({
        method: "GET",
        url: `/admin/calls/${id}`,
        headers: { authorization: authHeader() },
      });
      expect(res.statusCode, id).toBe(404);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain("404");
    }
  });
});

describe("fail-closed when ADMIN_PASSWORD is unset", () => {
  function buildAppWithWarn() {
    const warns = vi.fn();
    const loggerInstance = {
      level: "silent",
      child: () => loggerInstance,
      info: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
      fatal: () => undefined,
      warn: warns,
    } as unknown as FastifyBaseLogger;
    const config = buildConfig({ password: undefined });
    const lockedApp = Fastify({ loggerInstance });
    registerBasicAuth(lockedApp, config);
    registerAdminApi(lockedApp, { db, config });
    registerAdminPages(lockedApp, { db, config });
    return { lockedApp, warns };
  }

  it("responds 401 even with well-formed credentials, and warns once at startup", async () => {
    const { lockedApp, warns } = buildAppWithWarn();
    await lockedApp.ready();
    try {
      for (const request of [
        { url: "/api/calls", headers: { authorization: authHeader() } },
        { url: "/admin", headers: {} as Record<string, string> },
      ]) {
        const res = await lockedApp.inject({ method: "GET", ...request });
        expect(res.statusCode, request.url).toBe(401);
        expect(res.headers["www-authenticate"], request.url).toBe('Basic realm="admin"');
      }
      expect(warns).toHaveBeenCalledTimes(1);
      expect(String(warns.mock.calls[0]?.[0])).toContain("ADMIN_PASSWORD not set");
    } finally {
      await lockedApp.close();
    }
  });
});
