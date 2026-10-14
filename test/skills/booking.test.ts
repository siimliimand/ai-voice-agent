/**
 * Task 2.5: the shipped booking skill, end to end —
 *  - skills/booking.yaml loads and produces the right ToolDefinition,
 *  - a dispatcher wired with the real http executor books against the
 *    reusable mock calendar (substituted URL/body/auth header asserted),
 *  - policies.requires_confirmation gates dispatch until confirmed,
 *  - an unconfigured endpoint yields a clear error tool-result that is
 *    still audited,
 *  - mock failure injection surfaces as a descriptive execution_error.
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config/schema.js";
import { createDispatcher } from "../../src/skills/dispatcher.js";
import { createHttpExecutor } from "../../src/skills/http-executor.js";
import { loadSkills } from "../../src/skills/loader.js";
import { startMockCalendar } from "../fixtures/mock-calendar.js";
import { fakeEventDb, fakeLogger, skillsConfig } from "./helpers.js";

/** The real shipped manifest directory — the test validates the actual file. */
const SHIPPED_SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));

const CALL_ID = 7;
const ARGS = {
  date: "2026-05-01",
  time: "14:30",
  service: "dental hygiene",
  patient_name: "Mari Maasikas",
};

function loadBookingRegistry() {
  return loadSkills(skillsConfig({ dir: SHIPPED_SKILLS_DIR }), { logger: fakeLogger() });
}

function bookingConfig(url: string): AppConfig {
  return skillsConfig({
    http: { booking: { url, method: "POST", timeoutMs: 5000 } },
    auth: { calendar: { header: "Authorization", value: "Bearer test-token" } },
  });
}

/** Dispatcher over the shipped manifest + real http executor + fake audit db. */
function bookingDispatcher(config: AppConfig) {
  const { db, events } = fakeEventDb();
  const dispatcher = createDispatcher({
    registry: loadBookingRegistry(),
    executors: { http: createHttpExecutor({ config }) },
    db,
    logger: fakeLogger(),
  });
  return { dispatcher, events };
}

const bookingInvocation = { name: "booking", arguments: { ...ARGS } };

describe("shipped booking skill manifest (2.5)", () => {
  it("loads skills/booking.yaml and lists the booking ToolDefinition", () => {
    const registry = loadBookingRegistry();

    expect(registry.get("booking")).toBeDefined();
    const tool = registry.listTools().find((t) => t.function.name === "booking");
    expect(tool).toEqual({
      type: "function",
      function: {
        name: "booking",
        description: expect.stringContaining("Book an appointment"),
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            date: { type: "string", description: expect.stringContaining("YYYY-MM-DD") },
            time: { type: "string", description: expect.stringContaining("HH:MM") },
            service: { type: "string", description: expect.any(String) },
            patient_name: { type: "string", description: expect.any(String) },
          },
          required: ["date", "time", "service", "patient_name"],
        },
      },
    });

    const skill = registry.get("booking");
    expect(skill?.manifest).toMatchObject({
      execution: "http",
      endpoint: "booking",
      auth: "calendar",
      policies: { requires_confirmation: true },
    });
  });

  it("validates arguments with the compiled schema", () => {
    const skill = loadBookingRegistry().get("booking");
    expect(skill?.validateArguments({ ...ARGS })).toBe(true);
    expect(skill?.validateArguments({ ...ARGS, time: 1430 })).toBe(false);
    expect(skill?.validateArguments({ date: "2026-05-01", time: "14:30" })).toBe(false);
    expect(skill?.validateArguments({ ...ARGS, extra: "nope" })).toBe(false);
  });
});

describe("booking dispatch against the mock calendar (2.5)", () => {
  it("books end to end: executed outcome, audited, mock saw URL/body/auth", async () => {
    const cal = await startMockCalendar();
    try {
      const { dispatcher, events } = bookingDispatcher(bookingConfig(cal.url));

      const out = await dispatcher.dispatch(CALL_ID, bookingInvocation, { confirmed: true });

      expect(out.outcome).toBe("executed");
      const payload = JSON.parse(out.result) as {
        ok: boolean;
        bookingId: string;
        date: string;
        patient_name: string;
      };
      expect(payload.ok).toBe(true);
      expect(payload.bookingId).toMatch(/^BK-\d{4}$/);
      expect(payload.date).toBe(ARGS.date);
      expect(payload.patient_name).toBe(ARGS.patient_name);

      expect(cal.requests).toHaveLength(1);
      const seen = cal.requests[0];
      expect(seen?.method).toBe("POST");
      expect(seen?.url).toBe("/book");
      expect(seen?.headers.authorization).toBe("Bearer test-token");
      expect(seen?.headers["content-type"]).toBe("application/json");
      expect(seen?.body).toEqual(ARGS);

      expect(events).toEqual([
        {
          call_id: CALL_ID,
          type: "skill_invocation",
          detail: { skill: "booking", args: ARGS, outcome: "executed" },
        },
      ]);
    } finally {
      await cal.stop();
    }
  });

  it("refuses without confirmation (untouched endpoint), books once confirmed", async () => {
    const cal = await startMockCalendar();
    try {
      const { dispatcher, events } = bookingDispatcher(bookingConfig(cal.url));

      const refused = await dispatcher.dispatch(CALL_ID, bookingInvocation);
      expect(refused.outcome).toBe("confirmation_required");
      expect(refused.result).toContain("requires caller confirmation");
      expect(cal.requests).toHaveLength(0); // nothing reached the calendar

      const booked = await dispatcher.dispatch(CALL_ID, bookingInvocation, { confirmed: true });
      expect(booked.outcome).toBe("executed");
      expect(cal.requests).toHaveLength(1);

      // Both the refusal and the booking are audited, in order.
      expect(events.map((e) => (e.detail as { outcome: string }).outcome)).toEqual([
        "confirmation_required",
        "executed",
      ]);
    } finally {
      await cal.stop();
    }
  });

  it("returns a clear audited error when the endpoint is not configured", async () => {
    // Default skills config: no endpoints, no auth — the shipped manifest's
    // `endpoint: booking` resolves to nothing.
    const { dispatcher, events } = bookingDispatcher(skillsConfig({}));

    const out = await dispatcher.dispatch(CALL_ID, bookingInvocation, { confirmed: true });

    expect(out.outcome).toBe("execution_error");
    expect(out.result).toContain("endpoint 'booking' is not configured");
    expect(out.result).toContain("skills.http.booking.url");
    expect(events).toEqual([
      {
        call_id: CALL_ID,
        type: "skill_invocation",
        detail: {
          skill: "booking",
          args: ARGS,
          outcome: "execution_error",
          error: expect.stringContaining("endpoint 'booking' is not configured"),
        },
      },
    ]);
  });

  it("surfaces injected mock failures (503) as a descriptive execution_error", async () => {
    const cal = await startMockCalendar({ status: 503 });
    try {
      const { dispatcher, events } = bookingDispatcher(bookingConfig(cal.url));

      const out = await dispatcher.dispatch(CALL_ID, bookingInvocation, { confirmed: true });

      expect(out.outcome).toBe("execution_error");
      expect(out.result).toContain("Skill 'booking' failed:");
      expect(out.result).toContain("HTTP 503 Service Unavailable");
      expect(cal.requests).toHaveLength(1); // the request did reach the calendar
      expect(events[0]?.detail).toMatchObject({ skill: "booking", outcome: "execution_error" });
    } finally {
      await cal.stop();
    }
  });
});

describe("mock calendar fixture", () => {
  it("rejects malformed booking bodies with 400 naming the bad fields", async () => {
    const cal = await startMockCalendar();
    try {
      const response = await fetch(cal.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-05-01", time: "" }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("service");
      expect(body.error).toContain("patient_name");
      expect(cal.requests).toHaveLength(1);
    } finally {
      await cal.stop();
    }
  });

  it("delays responses under delayMs (timeout-injection hook)", async () => {
    const cal = await startMockCalendar({ delayMs: 150 });
    try {
      const started = Date.now();
      const response = await fetch(cal.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ARGS),
      });
      expect(response.status).toBe(201);
      expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    } finally {
      await cal.stop();
    }
  });
});
