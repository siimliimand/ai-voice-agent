import type { IncomingMessage } from "node:http";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config/schema.js";
import { createHttpExecutor } from "../../src/skills/http-executor.js";
import { loadSkills } from "../../src/skills/loader.js";
import type { LoadedSkill } from "../../src/skills/registry.js";
import { mustGet, skillsConfig, withSkillDir } from "./helpers.js";

const HTTP_SKILLS = {
  "book.yaml": `
name: book_appointment
description: Book an appointment for the caller.
parameters:
  type: object
  properties:
    date: { type: string }
    room: { type: string }
  required: [date, room]
execution: http
endpoint: booking
auth: calendar
`,
  "slots.yaml": `
name: check_slots
description: Check available slots.
parameters:
  type: object
  properties:
    date: { type: string }
  required: [date]
execution: http
endpoint: slots
`,
  "rooms.yaml": `
name: room_check
description: Check a room.
parameters:
  type: object
  properties:
    room: { type: string }
    date: { type: string }
  required: [room, date]
execution: http
endpoint: rooms
`,
};

function stubConfig(overrides: {
  http?: Record<string, unknown>;
  auth?: Record<string, unknown>;
}): AppConfig {
  return skillsConfig({
    http: overrides.http ?? {
      booking: { url: "http://api.test/book", method: "POST", timeoutMs: 200 },
      slots: { url: "http://api.test/slots?date={date}", method: "GET", timeoutMs: 200 },
      rooms: {
        url: "http://api.test/rooms/{room}/slots?date={date}",
        method: "GET",
        timeoutMs: 200,
      },
    },
    auth: overrides.auth ?? { calendar: { header: "Authorization", value: "Bearer tok" } },
  });
}

function loadHttpSkills(): {
  book: LoadedSkill;
  slots: LoadedSkill;
  rooms: LoadedSkill;
  cleanup: () => void;
} {
  const { dir, cleanup } = withSkillDir(HTTP_SKILLS);
  const registry = loadSkills(skillsConfig({ dir }));
  return {
    book: mustGet(registry, "book_appointment"),
    slots: mustGet(registry, "check_slots"),
    rooms: mustGet(registry, "room_check"),
    cleanup,
  };
}

/** A fetch that never resolves unless aborted (timeout path). */
function hangingFetch(): typeof fetch {
  return vi.fn(
    (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("This operation was aborted", "AbortError")),
        );
      }),
  ) as unknown as typeof fetch;
}

describe("http executor (stubbed fetch)", () => {
  it("POSTs the JSON arguments with the auth header and returns the parsed body", async () => {
    const { book, cleanup } = loadHttpSkills();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"ok":true,"id":42}', { status: 200 }));
    const executor = createHttpExecutor({
      config: stubConfig({}),
      fetch: fetchMock as typeof fetch,
    });

    const out = await executor(book, { date: "2026-05-01", room: "tallinn" });

    expect(out).toBe('{"ok":true,"id":42}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/book");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer tok",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({ date: "2026-05-01", room: "tallinn" });
    cleanup();
  });

  it("falls back to the raw text body when the 2xx response is not JSON", async () => {
    const { book, cleanup } = loadHttpSkills();
    const executor = createHttpExecutor({
      config: stubConfig({}),
      fetch: vi.fn().mockResolvedValue(new Response("CREATED slot 7", { status: 201 })),
    });

    await expect(executor(book, { date: "d", room: "r" })).resolves.toBe("CREATED slot 7");
    cleanup();
  });

  it("substitutes URL template params with URI-encoded values (2.3)", async () => {
    const { rooms, cleanup } = loadHttpSkills();
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    const executor = createHttpExecutor({
      config: stubConfig({}),
      fetch: fetchMock as typeof fetch,
    });

    await executor(rooms, { room: "a b/c?d", date: "2026-05-01" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/rooms/a%20b%2Fc%3Fd/slots?date=2026-05-01");
    cleanup();
  });

  it("maps 4xx responses to a descriptive error tool-result (2.3)", async () => {
    const { book, cleanup } = loadHttpSkills();
    const executor = createHttpExecutor({
      config: stubConfig({}),
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response('{"error":"no slot"}', { status: 404, statusText: "Not Found" }),
        ),
    });

    await expect(executor(book, { date: "d", room: "r" })).rejects.toThrow(
      /HTTP 404 Not Found — .+"no slot"/,
    );
    cleanup();
  });

  it("maps 5xx responses to a descriptive error tool-result (2.3)", async () => {
    const { book, cleanup } = loadHttpSkills();
    const executor = createHttpExecutor({
      config: stubConfig({}),
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response("calendar exploded", { status: 500, statusText: "Internal Server Error" }),
        ),
    });

    await expect(executor(book, { date: "d", room: "r" })).rejects.toThrow(
      /HTTP 500 Internal Server Error — calendar exploded/,
    );
    cleanup();
  });

  it("maps timeouts (abort) to a timeout error tool-result (2.3)", async () => {
    const { book, cleanup } = loadHttpSkills();
    const executor = createHttpExecutor({
      config: skillsConfig({
        http: { booking: { url: "http://api.test/book", method: "POST", timeoutMs: 20 } },
        auth: { calendar: { header: "Authorization", value: "Bearer tok" } },
      }),
      fetch: hangingFetch(),
    });

    await expect(executor(book, { date: "d", room: "r" })).rejects.toThrow(
      "request timed out after 20ms",
    );
    cleanup();
  });

  it("maps network failures to a descriptive error tool-result", async () => {
    const { book, cleanup } = loadHttpSkills();
    const executor = createHttpExecutor({
      config: stubConfig({}),
      fetch: vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    });

    await expect(executor(book, { date: "d", room: "r" })).rejects.toThrow(
      "request failed: fetch failed",
    );
    cleanup();
  });

  it("sends GET requests without a body or content-type", async () => {
    const { slots, cleanup } = loadHttpSkills();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"slots":[]}'));
    const executor = createHttpExecutor({
      config: stubConfig({}),
      fetch: fetchMock as typeof fetch,
    });

    const out = await executor(slots, { date: "2026-05-01" });

    expect(out).toBe('{"slots":[]}');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/slots?date=2026-05-01");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty("content-type");
    cleanup();
  });

  it("fails with clear errors for missing endpoint/auth/argument config", async () => {
    const { book, rooms, cleanup } = loadHttpSkills();
    const failing = createHttpExecutor({
      config: stubConfig({
        http: {
          slots: { url: "http://api.test/slots", method: "GET", timeoutMs: 200 },
          rooms: { url: "http://api.test/rooms/{room}", method: "GET", timeoutMs: 200 },
        },
      }),
      fetch: vi.fn(),
    });
    await expect(failing(book, { date: "d", room: "r" })).rejects.toThrow(
      "endpoint 'booking' is not configured — set skills.http.booking.url",
    );

    const noAuth = createHttpExecutor({
      config: stubConfig({ auth: {} }),
      fetch: vi.fn(),
    });
    await expect(noAuth(book, { date: "d", room: "r" })).rejects.toThrow(
      "auth reference 'calendar' is not configured — set skills.auth.calendar",
    );

    const missingArg = createHttpExecutor({ config: stubConfig({}), fetch: vi.fn() });
    await expect(missingArg(rooms, { date: "2026-05-01" })).rejects.toThrow(
      "URL template references '{room}' which is not in the validated arguments",
    );
    cleanup();
  });
});

describe("http executor against a real localhost server", () => {
  let server: Server;
  let port: number;
  let seen: { method?: string; url?: string; auth?: string | undefined; body?: unknown };

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        seen = { method: req.method, url: req.url, auth: req.headers.authorization };
        try {
          seen.body = raw === "" ? null : JSON.parse(raw);
        } catch {
          seen.body = raw;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ booked: true, echoed: seen }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("posts JSON with the auth header through the real fetch and returns the response", async () => {
    const { book, cleanup } = loadHttpSkills();
    const config = skillsConfig({
      http: {
        booking: { url: `http://127.0.0.1:${port}/book`, method: "POST", timeoutMs: 5000 },
      },
      auth: { calendar: { header: "Authorization", value: "Bearer tok" } },
    });
    const executor = createHttpExecutor({ config }); // real global fetch

    const out = await executor(book, { date: "2026-05-01", room: "tallinn" });

    expect(JSON.parse(out)).toEqual({
      booked: true,
      echoed: {
        method: "POST",
        url: "/book",
        auth: "Bearer tok",
        body: { date: "2026-05-01", room: "tallinn" },
      },
    });
    cleanup();
  });
});
