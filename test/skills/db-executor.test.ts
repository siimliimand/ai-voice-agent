import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/schema.js";
import { insertCall } from "../../src/db/queries.js";
import { ajv } from "../../src/skills/ajv.js";
import { createDbExecutor } from "../../src/skills/db-executor.js";
import { findSqlViolation } from "../../src/skills/sql-guard.js";
import { createDispatcher } from "../../src/skills/dispatcher.js";
import { skillManifestSchema } from "../../src/skills/manifest.js";
import { loadSkills } from "../../src/skills/loader.js";
import type { LoadedSkill } from "../../src/skills/registry.js";
import { fakeLogger, skillsConfig, withSkillDir } from "./helpers.js";
import { createScratchDb, type ScratchDb } from "../helpers/scratch-db.js";

describe("sql guard (load-time, no DB needed)", () => {
  it("accepts single SELECT/WITH statements, including a trailing semicolon", () => {
    expect(findSqlViolation("SELECT id FROM calls")).toBeNull();
    expect(findSqlViolation("select id from calls where id = {id}")).toBeNull();
    expect(
      findSqlViolation("  WITH recent AS (SELECT id FROM calls)\n    SELECT * FROM recent;\n"),
    ).toBeNull();
  });

  it("rejects everything that is not a single SELECT/WITH statement", () => {
    expect(findSqlViolation("")).toMatch(/empty/);
    expect(findSqlViolation("EXPLAIN SELECT 1")).toMatch(/SELECT or WITH/);
    expect(findSqlViolation("SELECT 1; SELECT 2")).toMatch(/single statement/);
    expect(findSqlViolation("SELECT 1;\nDROP TABLE calls")).toMatch(/single statement/);
  });

  it("rejects write keywords as word-boundary matches, case-insensitively", () => {
    // Statements not even starting with SELECT/WITH hit the leading-keyword check.
    for (const stmt of [
      "INSERT INTO calls (call_sid) VALUES ('x')",
      "UPDATE calls SET status = 'done'",
      "DELETE FROM calls",
      "drop table calls",
      "ALTER TABLE calls ADD COLUMN x TEXT",
      "CREATE TABLE hack (id int)",
      "TRUNCATE calls",
      "GRANT ALL ON calls TO public",
      "COPY calls FROM '/tmp/x'",
    ]) {
      expect(findSqlViolation(stmt), stmt).toMatch(/SELECT or WITH/);
    }
    // SELECT/WITH statements still reject write keywords anywhere.
    expect(
      findSqlViolation("WITH moved AS (DELETE FROM calls RETURNING *) SELECT * FROM moved"),
    ).toMatch(/write keyword 'DELETE'/);
    expect(findSqlViolation("SELECT 'insert' FROM calls")).toMatch(/write keyword 'INSERT'/);
  });

  it("does not reject identifiers merely containing keyword substrings", () => {
    expect(findSqlViolation("SELECT id, created_at, updated_at, deleted_by FROM calls")).toBeNull();
  });
});

describe("db executor against real Postgres", () => {
  const databaseUrl = process.env.DATABASE_URL;
  const SID = "test-skills-caabcdef1234567890";

  describe.skipIf(!databaseUrl)("bound-parameter SELECT execution", () => {
    // Scratch database: the fixture call row lives on the isolated database.
    let scratch: ScratchDb;
    let db: Kysely<Database>;

    beforeAll(async () => {
      scratch = await createScratchDb("skills_db_executor");
      db = scratch.db;
      await insertCall(db, { callSid: SID, from: "+37251234567", provider: "twilio" });
    });

    afterAll(async () => {
      if (scratch) await scratch.destroy();
    });

    it("returns rows for a parameterized read-only manifest (2.4)", async () => {
      const { dir, cleanup } = withSkillDir({
        "lookup.yaml": `
name: find_call
description: Look up a call by SID.
parameters:
  type: object
  properties:
    call_sid: { type: string }
    provider: { type: string }
  required: [call_sid]
execution: db
sql: |
  SELECT id, call_sid, from_number FROM calls
  WHERE call_sid = {call_sid} AND provider = {provider}
`,
      });
      try {
        const registry = loadSkills(skillsConfig({ dir }));
        const dispatcher = createDispatcher({
          registry,
          executors: { db: createDbExecutor({ db }) },
          logger: fakeLogger(),
        });

        const out = await dispatcher.dispatch(7, {
          name: "find_call",
          arguments: { call_sid: SID, provider: "twilio" },
        });

        expect(out.outcome).toBe("executed");
        const rows = JSON.parse(out.result) as Array<{ call_sid: string; from_number: string }>;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ call_sid: SID, from_number: "+37251234567" });
      } finally {
        cleanup();
      }
    });

    it("rejects a manifest whose placeholder has no matching argument", async () => {
      const { dir, cleanup } = withSkillDir({
        "lookup.yaml": `
name: find_call
description: Look up a call by SID.
parameters:
  type: object
  properties:
    call_sid: { type: string }
  required: [call_sid]
execution: db
sql: |
  SELECT id FROM calls WHERE call_sid = {call_sid} AND provider = {provider}
`,
      });
      try {
        const registry = loadSkills(skillsConfig({ dir }));
        const dispatcher = createDispatcher({
          registry,
          executors: { db: createDbExecutor({ db }) },
          logger: fakeLogger(),
        });

        const out = await dispatcher.dispatch(7, {
          name: "find_call",
          arguments: { call_sid: SID },
        });

        expect(out.outcome).toBe("execution_error");
        expect(out.result).toMatch(/placeholder '\{provider\}' has no matching argument/);
      } finally {
        cleanup();
      }
    });

    it("refuses write SQL defensively at execution time, not just at load", async () => {
      // A write-SQL manifest cannot come through loadSkills; build one by hand
      // to prove the executor's own guard holds even against misuse.
      const evil: LoadedSkill = {
        manifest: skillManifestSchema.parse({
          name: "evil_skill",
          description: "never loadable via loadSkills",
          parameters: { type: "object", properties: {} },
          execution: "db",
          sql: "WITH moved AS (DELETE FROM calls RETURNING *) SELECT * FROM moved",
        }),
        validateArguments: ajv.compile({ type: "object", properties: {} }),
      };

      await expect(createDbExecutor({ db })(evil, {})).rejects.toThrow(
        /SQL rejected:.*write keyword/,
      );
    });
  });
});
