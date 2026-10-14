/**
 * Skill manifest schema (design D1): one declarative YAML file per skill.
 * A manifest describes a callable tool — name/description for the LLM, a JSON
 * Schema for the arguments object, an execution kind (http | db | rag) with
 * the per-kind payload, an optional auth reference into `skills.auth`, and
 * safety policies. Secrets never live in manifests; they stay in config.
 */

import { z } from "zod";

/** Tool names are lowercase identifiers used verbatim in the tools array. */
export const SKILL_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

export const skillExecutionKinds = ["http", "db", "rag"] as const;
export type SkillExecutionKind = (typeof skillExecutionKinds)[number];

/**
 * `{param}` slots shared by http URL templates and db SQL statements. Names
 * must be simple identifiers so both substitution and DB parameter binding
 * stay unambiguous.
 */
export const PARAM_PATTERN = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

export const skillManifestSchema = z
  .object({
    name: z.string().regex(SKILL_NAME_PATTERN),
    /** LLM-facing: shown verbatim in the tool definition. */
    description: z.string().trim().min(1),
    /** JSON Schema for the arguments object (compiled with ajv once at load). */
    parameters: z.record(z.unknown()).default({ type: "object", properties: {} }),
    execution: z.enum(skillExecutionKinds),
    /** http skills only: name of the endpoint in config.skills.http. */
    endpoint: z.string().trim().min(1).optional(),
    /** db skills only: a single read-only SELECT/WITH statement (see sql-guard.ts). */
    sql: z.string().trim().min(1).optional(),
    /** Reference into config.skills.auth ({header, value}); optional. */
    auth: z.string().trim().min(1).optional(),
    policies: z
      .object({
        /** Dispatch refuses unless the loop passes an explicit confirmation. */
        requires_confirmation: z.boolean().optional(),
      })
      .default({}),
  })
  .superRefine((m, ctx) => {
    if (m.execution === "http" && m.endpoint === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "http skills must reference a config endpoint via 'endpoint: <name>'",
        path: ["endpoint"],
      });
    }
    if (m.execution === "db" && m.sql === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "db skills must carry their SQL in 'sql'",
        path: ["sql"],
      });
    }
    const type = m.parameters["type"];
    if (type !== undefined && type !== "object") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'parameters must be a JSON Schema object ("type": "object")',
        path: ["parameters"],
      });
    }
  });

export type SkillManifest = z.infer<typeof skillManifestSchema>;
