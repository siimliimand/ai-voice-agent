import { afterEach, describe, expect, it, vi } from "vitest";
import { createDispatcher, type SkillExecutor } from "../../src/skills/dispatcher.js";
import { loadSkills } from "../../src/skills/loader.js";
import type { SkillRegistry } from "../../src/skills/registry.js";
import { fakeEventDb, fakeLogger, skillsConfig, withSkillDir } from "./helpers.js";

const LOOKUP_YAML = `
name: find_call
description: Look up a call by SID.
parameters:
  type: object
  properties:
    call_sid: { type: string }
  required: [call_sid]
execution: db
sql: |
  SELECT id, call_sid FROM calls WHERE call_sid = {call_sid}
`;

const CONFIRM_YAML = `
name: book_appointment
description: Book an appointment.
parameters:
  type: object
  properties:
    date: { type: string }
  required: [date]
execution: http
endpoint: booking
policies:
  requires_confirmation: true
`;

const RAG_YAML = `
name: search_docs
description: Search the knowledge base.
parameters:
  type: object
  properties:
    query: { type: string }
  required: [query]
execution: rag
`;

const CALL_ID = 7;

/** Registry over the three fixture skills + a db executor stub. */
function fixtureRegistry(): { registry: SkillRegistry; cleanup: () => void } {
  const { dir, cleanup } = withSkillDir({
    "lookup.yaml": LOOKUP_YAML,
    "confirm.yaml": CONFIRM_YAML,
    "rag.yaml": RAG_YAML,
  });
  return { registry: loadSkills(skillsConfig({ dir })), cleanup };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dispatcher", () => {
  it("executes a valid invocation and audits outcome=executed (2.2)", async () => {
    const { registry, cleanup } = fixtureRegistry();
    const { db, events } = fakeEventDb();
    const dbExecutor = vi.fn().mockResolvedValue('[{"id":1,"call_sid":"CA123"}]');
    const dispatcher = createDispatcher({
      registry,
      executors: { db: dbExecutor as SkillExecutor },
      db,
      logger: fakeLogger(),
    });

    const out = await dispatcher.dispatch(CALL_ID, {
      name: "find_call",
      arguments: { call_sid: "CA123" },
    });

    expect(out).toEqual({ outcome: "executed", result: '[{"id":1,"call_sid":"CA123"}]' });
    expect(dbExecutor).toHaveBeenCalledTimes(1);
    const [skill, args] = dbExecutor.mock.calls[0] as [
      { manifest: { name: string } },
      Record<string, unknown>,
    ];
    expect(skill.manifest.name).toBe("find_call");
    expect(args).toEqual({ call_sid: "CA123" });
    expect(events).toEqual([
      {
        call_id: CALL_ID,
        type: "skill_invocation",
        detail: { skill: "find_call", args: { call_sid: "CA123" }, outcome: "executed" },
      },
    ]);
    cleanup();
  });

  it("returns a descriptive validation error and audits it (2.2)", async () => {
    const { registry, cleanup } = fixtureRegistry();
    const { db, events } = fakeEventDb();
    const dbExecutor = vi.fn();
    const dispatcher = createDispatcher({
      registry,
      executors: { db: dbExecutor as SkillExecutor },
      db,
      logger: fakeLogger(),
    });

    const out = await dispatcher.dispatch(CALL_ID, {
      name: "find_call",
      arguments: { wrong: true },
    });

    expect(out.outcome).toBe("validation_error");
    expect(out.result).toContain("Invalid arguments for skill 'find_call'");
    expect(out.result).toContain("call_sid"); // names the failing parameter
    expect(dbExecutor).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        call_id: CALL_ID,
        type: "skill_invocation",
        detail: {
          skill: "find_call",
          args: { wrong: true },
          outcome: "validation_error",
          error: expect.stringContaining("Invalid arguments"),
        },
      },
    ]);
    cleanup();
  });

  it("treats non-object arguments as a validation error", async () => {
    const { registry, cleanup } = fixtureRegistry();
    const dispatcher = createDispatcher({
      registry,
      executors: { db: vi.fn() as SkillExecutor },
      audit: vi.fn().mockResolvedValue(undefined),
      logger: fakeLogger(),
    });

    const out = await dispatcher.dispatch(CALL_ID, { name: "find_call", arguments: "garbage" });

    expect(out.outcome).toBe("validation_error");
    expect(out.result).toContain("arguments must be a JSON object");
    cleanup();
  });

  it("reports unknown skills with the available list (2.2)", async () => {
    const { registry, cleanup } = fixtureRegistry();
    const { db, events } = fakeEventDb();
    const dispatcher = createDispatcher({
      registry,
      executors: {},
      db,
      logger: fakeLogger(),
    });

    const out = await dispatcher.dispatch(CALL_ID, { name: "nope", arguments: {} });

    expect(out.outcome).toBe("unknown_skill");
    expect(out.result).toContain("Unknown skill 'nope'");
    expect(out.result).toContain("find_call");
    expect(events).toEqual([
      {
        call_id: CALL_ID,
        type: "skill_invocation",
        detail: {
          skill: "nope",
          args: {},
          outcome: "unknown_skill",
          error: expect.stringContaining("Unknown skill"),
        },
      },
    ]);
    cleanup();
  });

  it("refuses confirmation-required skills without the flag, dispatches with it (2.2)", async () => {
    const { registry, cleanup } = fixtureRegistry();
    const { db, events } = fakeEventDb();
    const httpExecutor = vi.fn().mockResolvedValue('{"ok":true}');
    const dispatcher = createDispatcher({
      registry,
      executors: { http: httpExecutor as SkillExecutor },
      db,
      logger: fakeLogger(),
    });

    const refused = await dispatcher.dispatch(CALL_ID, {
      name: "book_appointment",
      arguments: { date: "2026-05-01" },
    });
    expect(refused.outcome).toBe("confirmation_required");
    expect(refused.result).toContain("requires caller confirmation");
    expect(httpExecutor).not.toHaveBeenCalled();

    const confirmed = await dispatcher.dispatch(
      CALL_ID,
      { name: "book_appointment", arguments: { date: "2026-05-01" } },
      { confirmed: true },
    );
    expect(confirmed.outcome).toBe("executed");

    expect(events.map((e) => (e.detail as { outcome: string }).outcome)).toEqual([
      "confirmation_required",
      "executed",
    ]);
    cleanup();
  });

  it("maps executor failures to error tool-results, never throws (2.2)", async () => {
    const { registry, cleanup } = fixtureRegistry();
    const { db, events } = fakeEventDb();
    const dbExecutor = vi.fn().mockRejectedValue(new Error("boom"));
    const dispatcher = createDispatcher({
      registry,
      executors: { db: dbExecutor as SkillExecutor },
      db,
      logger: fakeLogger(),
    });

    const out = await dispatcher.dispatch(CALL_ID, {
      name: "find_call",
      arguments: { call_sid: "CA123" },
    });

    expect(out.outcome).toBe("execution_error");
    expect(out.result).toBe("Skill 'find_call' failed: boom");
    expect(events[0]?.detail).toMatchObject({ outcome: "execution_error", error: "boom" });
    cleanup();
  });

  it("fails closed when no executor is registered for the execution kind", async () => {
    const { registry, cleanup } = fixtureRegistry();
    const dispatcher = createDispatcher({
      registry,
      executors: {},
      audit: vi.fn().mockResolvedValue(undefined),
      logger: fakeLogger(),
    });

    const out = await dispatcher.dispatch(CALL_ID, {
      name: "find_call",
      arguments: { call_sid: "CA123" },
    });

    expect(out.outcome).toBe("execution_error");
    expect(out.result).toContain("No executor registered for skill 'find_call'");
    cleanup();
  });

  it("returns the rag not-implemented tool-result (2.4)", async () => {
    const { registry, cleanup } = fixtureRegistry();
    const { db, events } = fakeEventDb();
    const dispatcher = createDispatcher({
      registry,
      executors: {},
      db,
      logger: fakeLogger(),
    });

    const out = await dispatcher.dispatch(CALL_ID, {
      name: "search_docs",
      arguments: { query: "opening hours" },
    });

    expect(out.outcome).toBe("execution_error");
    expect(out.result).toMatch(/rag execution is not implemented yet/);
    expect(events[0]?.detail).toMatchObject({ skill: "search_docs", outcome: "execution_error" });
    cleanup();
  });

  it("keeps working when the audit write fails", async () => {
    const { registry, cleanup } = fixtureRegistry();
    const logger = fakeLogger();
    const dbExecutor = vi.fn().mockResolvedValue("ok");
    const dispatcher = createDispatcher({
      registry,
      executors: { db: dbExecutor as SkillExecutor },
      audit: vi.fn().mockRejectedValue(new Error("db down")),
      logger,
    });

    const out = await dispatcher.dispatch(CALL_ID, {
      name: "find_call",
      arguments: { call_sid: "CA123" },
    });

    expect(out).toEqual({ outcome: "executed", result: "ok" });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ skill: "find_call" }),
      expect.stringContaining("audit"),
    );
    cleanup();
  });

  it("supports an injected audit writer instead of the db", async () => {
    const { registry, cleanup } = fixtureRegistry();
    const audit = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createDispatcher({
      registry,
      executors: { db: vi.fn().mockResolvedValue("ok") as SkillExecutor },
      audit,
      logger: fakeLogger(),
    });

    await dispatcher.dispatch(CALL_ID, { name: "find_call", arguments: { call_sid: "X" } });

    expect(audit).toHaveBeenCalledWith(
      CALL_ID,
      expect.objectContaining({ skill: "find_call", outcome: "executed" }),
    );
    cleanup();
  });
});
