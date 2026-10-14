/**
 * DB skill executor (design D3): runs a manifest's read-only SELECT/WITH
 * statement through Kysely with bound parameters. `{param}` slots in the SQL
 * are replaced by `sql.val()` fragments — argument values always travel as
 * bound query parameters, never interpolated into the SQL text.
 */

import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import { PARAM_PATTERN } from "./manifest.js";
import type { SkillExecutor } from "./dispatcher.js";
import { findSqlViolation } from "./sql-guard.js";

export interface DbExecutorDeps {
  db: Kysely<Database>;
}

export function createDbExecutor(deps: DbExecutorDeps): SkillExecutor {
  return async (skill, args) => {
    const statement = skill.manifest.sql;
    if (typeof statement !== "string" || statement === "") {
      throw new Error("db skill carries no SQL");
    }
    // Defense in depth: also enforced at manifest load time.
    const violation = findSqlViolation(statement);
    if (violation) {
      throw new Error(`SQL rejected: ${violation}`);
    }

    const chunks: unknown[] = [];
    let last = 0;
    for (const match of statement.matchAll(PARAM_PATTERN)) {
      const name = match[1] ?? "";
      const at = match.index ?? 0;
      if (!(name in args)) {
        throw new Error(`SQL placeholder '{${name}}' has no matching argument`);
      }
      chunks.push(sql.raw(statement.slice(last, at)));
      chunks.push(sql.val(args[name]));
      last = at + match[0].length;
    }
    chunks.push(sql.raw(statement.slice(last)));

    const result = await sql.join(chunks, sql.raw("")).execute(deps.db);
    return JSON.stringify(result.rows ?? []);
  };
}
