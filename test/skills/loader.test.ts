import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../../src/llm/openrouter.js";
import { loadSkills } from "../../src/skills/loader.js";
import { fakeLogger, skillsConfig, withSkillDir } from "./helpers.js";

const BOOKING_YAML = `
name: book_appointment
description: Book an appointment for the caller.
parameters:
  type: object
  properties:
    date: { type: string }
    time: { type: string }
  required: [date, time]
execution: http
endpoint: booking
auth: calendar
policies:
  requires_confirmation: true
`;

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

const EXPECTED_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "book_appointment",
      description: "Book an appointment for the caller.",
      parameters: {
        type: "object",
        properties: { date: { type: "string" }, time: { type: "string" } },
        required: ["date", "time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_call",
      description: "Look up a call by SID.",
      parameters: {
        type: "object",
        properties: { call_sid: { type: "string" } },
        required: ["call_sid"],
      },
    },
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadSkills", () => {
  it("loads valid manifests and generates OpenAI ToolDefinitions (2.1)", () => {
    const { dir, cleanup } = withSkillDir({
      "book.yaml": BOOKING_YAML,
      "lookup.yaml": LOOKUP_YAML,
    });
    try {
      const registry = loadSkills(skillsConfig({ dir }));

      expect(registry.size).toBe(2);
      expect(registry.listTools()).toEqual(EXPECTED_TOOLS);

      const booking = registry.get("book_appointment");
      expect(booking?.manifest).toMatchObject({
        execution: "http",
        endpoint: "booking",
        auth: "calendar",
        policies: { requires_confirmation: true },
      });
      expect(booking?.validateArguments({ date: "2026-05-01", time: "10:00" })).toBe(true);
      expect(booking?.validateArguments({ date: 42 })).toBe(false);

      const lookup = registry.get("find_call");
      expect(lookup?.manifest.execution).toBe("db");
      expect(registry.get("nope")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("skips invalid manifests with the file name in the error log (2.1)", () => {
    const { dir, cleanup } = withSkillDir({
      "lookup.yaml": LOOKUP_YAML,
      "broken.yaml": "name: Bad Name!\ndescription: nope\nexecution: rag\n",
      "garbage.yaml": "{ unbalanced: [yaml",
    });
    const logger = fakeLogger();
    try {
      const registry = loadSkills(skillsConfig({ dir }), { logger });

      // The one valid manifest still loads — fail-soft.
      expect(registry.size).toBe(1);
      expect(logger.error).toHaveBeenCalledTimes(2);
      for (const file of ["broken.yaml", "garbage.yaml"]) {
        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({ file }),
          expect.stringContaining(file),
        );
      }
    } finally {
      cleanup();
    }
  });

  it("rejects db manifests that are not a single read-only statement, at load", () => {
    const { dir, cleanup } = withSkillDir({
      "write.yaml": LOOKUP_YAML.replace("SELECT id, call_sid", "UPDATE calls SET"),
      "multi.yaml": LOOKUP_YAML.replace(
        "WHERE call_sid = {call_sid}",
        "WHERE call_sid = {call_sid}; DROP TABLE calls",
      ),
      "explain.yaml": LOOKUP_YAML.replace("SELECT id, call_sid", "EXPLAIN SELECT id, call_sid"),
    });
    const logger = fakeLogger();
    try {
      const registry = loadSkills(skillsConfig({ dir }), { logger });
      expect(registry.size).toBe(0);
      expect(logger.error).toHaveBeenCalledTimes(3);
    } finally {
      cleanup();
    }
  });

  it("keeps the first manifest for duplicate skill names", () => {
    const { dir, cleanup } = withSkillDir({
      "a.yaml": LOOKUP_YAML,
      "b.yaml": LOOKUP_YAML,
    });
    const logger = fakeLogger();
    try {
      const registry = loadSkills(skillsConfig({ dir }), { logger });
      expect(registry.size).toBe(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ file: "b.yaml" }),
        expect.stringContaining("b.yaml"),
      );
    } finally {
      cleanup();
    }
  });

  it("starts with no skills when the manifest directory is missing", () => {
    const logger = fakeLogger();
    const registry = loadSkills(skillsConfig({ dir: "./does-not-exist" }), { logger });
    expect(registry.size).toBe(0);
    expect(registry.listTools()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ dir: "./does-not-exist" }),
      expect.stringContaining("./does-not-exist"),
    );
  });

  it("skips manifests whose JSON Schema does not compile with ajv", () => {
    const { dir, cleanup } = withSkillDir({
      "bad-schema.yaml": LOOKUP_YAML.replace(
        "call_sid: { type: string }",
        'call_sid: { type: string, pattern: "[" }',
      ),
    });
    const logger = fakeLogger();
    try {
      const registry = loadSkills(skillsConfig({ dir }), { logger });
      expect(registry.size).toBe(0);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ file: "bad-schema.yaml" }),
        expect.stringContaining("bad-schema.yaml"),
      );
    } finally {
      cleanup();
    }
  });
});
