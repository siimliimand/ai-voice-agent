/**
 * Skill dispatcher (design D2): the single entry point the tool loop calls
 * for every LLM tool invocation. Validates arguments against the compiled
 * JSON Schema, enforces confirmation policies, executes through pluggable
 * executors, and writes one `skill_invocation` call_events audit row per
 * processed invocation.
 *
 * Error contract: dispatch NEVER throws into the audio path — every failure
 * (unknown skill, bad arguments, refused confirmation, executor error) comes
 * back as a descriptive tool-result string on DispatchResult.result.
 */

import type { Kysely } from "kysely";
import { insertCallEvent } from "../db/queries.js";
import type { Database } from "../db/schema.js";
import { logger as rootLogger, type Logger } from "../logging.js";
import type { SkillExecutionKind } from "./manifest.js";
import type { LoadedSkill, SkillRegistry } from "./registry.js";
import { validationErrorText } from "./ajv.js";

/** Outcome values written to skill_invocation audit events. */
export type SkillInvocationOutcome =
  "executed" | "validation_error" | "unknown_skill" | "confirmation_required" | "execution_error";

/** One tool invocation as assembled by the tool loop (arguments JSON-parsed). */
export interface SkillInvocation {
  /** Tool name as invoked by the model. */
  name: string;
  /** Parsed arguments object; anything non-object is a validation error. */
  arguments: unknown;
}

export interface DispatchOptions {
  /** True only after the caller explicitly confirmed (design D6). */
  confirmed?: boolean;
}

export interface DispatchResult {
  outcome: SkillInvocationOutcome;
  /** Tool-result string — success payload or descriptive error. */
  result: string;
}

/** Executes one validated skill; http/db implementations live beside this. */
export type SkillExecutor = (skill: LoadedSkill, args: Record<string, unknown>) => Promise<string>;

/** Executors per manifest execution kind; unregistered kinds fail closed. */
export type SkillExecutors = Partial<Record<SkillExecutionKind, SkillExecutor>>;

export interface SkillInvocationAudit {
  skill: string;
  /** Kept as-is: these are tool arguments, not secrets (per design D8). */
  args: unknown;
  outcome: SkillInvocationOutcome;
  /** Extra context for failures (error text). */
  error?: string;
}

/** Persists one audit entry; default implementation writes a call_events row. */
export type SkillAuditWriter = (callId: number, entry: SkillInvocationAudit) => Promise<void>;

export interface DispatcherDeps {
  registry: SkillRegistry;
  executors: SkillExecutors;
  /** DB used by the default audit writer (callEventAudit). */
  db?: Kysely<Database>;
  /** Overrides the default skill_invocation call_events writer. */
  audit?: SkillAuditWriter;
  logger?: Logger;
}

export interface SkillDispatcher {
  dispatch(
    callId: number,
    invocation: SkillInvocation,
    opts?: DispatchOptions,
  ): Promise<DispatchResult>;
}

/** Default audit writer: a `skill_invocation` row via the shared query helper. */
export function callEventAudit(db: Kysely<Database>): SkillAuditWriter {
  return async (callId, entry) => {
    await insertCallEvent(db, {
      callId,
      type: "skill_invocation",
      detail: {
        skill: entry.skill,
        args: entry.args,
        outcome: entry.outcome,
        ...(entry.error !== undefined ? { error: entry.error } : {}),
      },
    });
  };
}

export function createDispatcher(deps: DispatcherDeps): SkillDispatcher {
  const log = deps.logger ?? rootLogger;
  const audit = deps.audit ?? (deps.db ? callEventAudit(deps.db) : null);

  // Audit failures are logged and swallowed — the caller must still get a
  // tool result; the audio path never depends on the audit write.
  const writeAudit = async (callId: number, entry: SkillInvocationAudit): Promise<void> => {
    if (!audit) return;
    try {
      await audit(callId, entry);
    } catch (err) {
      log.error(
        { err, callId, skill: entry.skill },
        "skills: failed to write skill_invocation audit event",
      );
    }
  };

  return {
    async dispatch(
      callId: number,
      invocation: SkillInvocation,
      opts: DispatchOptions = {},
    ): Promise<DispatchResult> {
      const skill = deps.registry.get(invocation.name);
      if (!skill) {
        const available = deps.registry.all().map((s) => s.manifest.name);
        const result =
          `Unknown skill '${invocation.name}'.` +
          (available.length > 0 ? ` Available skills: ${available.join(", ")}.` : "");
        await writeAudit(callId, {
          skill: invocation.name,
          args: invocation.arguments,
          outcome: "unknown_skill",
          error: result,
        });
        return { outcome: "unknown_skill", result };
      }

      const args = invocation.arguments;
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        const result =
          `Invalid arguments for skill '${skill.manifest.name}': ` +
          "arguments must be a JSON object.";
        await writeAudit(callId, {
          skill: skill.manifest.name,
          args,
          outcome: "validation_error",
          error: result,
        });
        return { outcome: "validation_error", result };
      }

      let valid = false;
      try {
        valid = skill.validateArguments(args);
      } catch (err) {
        log.warn({ err, skill: skill.manifest.name }, "skills: validator threw during dispatch");
      }
      if (!valid) {
        const detail = validationErrorText(skill.validateArguments);
        const result = `Invalid arguments for skill '${skill.manifest.name}': ${detail}`;
        await writeAudit(callId, {
          skill: skill.manifest.name,
          args,
          outcome: "validation_error",
          error: result,
        });
        return { outcome: "validation_error", result };
      }

      if (skill.manifest.policies.requires_confirmation === true && opts.confirmed !== true) {
        const result =
          `Skill '${skill.manifest.name}' requires caller confirmation — ` +
          "ask the caller to confirm, then call it again with the confirmation flag.";
        await writeAudit(callId, {
          skill: skill.manifest.name,
          args,
          outcome: "confirmation_required",
          error: result,
        });
        return { outcome: "confirmation_required", result };
      }

      const execution = skill.manifest.execution;
      if (execution === "rag" && !deps.executors.rag) {
        const result = `Skill '${skill.manifest.name}' is unavailable: rag execution is not implemented yet.`;
        await writeAudit(callId, {
          skill: skill.manifest.name,
          args,
          outcome: "execution_error",
          error: result,
        });
        return { outcome: "execution_error", result };
      }
      const executor = deps.executors[execution];
      if (!executor) {
        const result = `No executor registered for skill '${skill.manifest.name}' (execution: ${execution}).`;
        await writeAudit(callId, {
          skill: skill.manifest.name,
          args,
          outcome: "execution_error",
          error: result,
        });
        return { outcome: "execution_error", result };
      }

      try {
        const result = await executor(skill, args as Record<string, unknown>);
        await writeAudit(callId, {
          skill: skill.manifest.name,
          args,
          outcome: "executed",
        });
        return { outcome: "executed", result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const result = `Skill '${skill.manifest.name}' failed: ${message}`;
        await writeAudit(callId, {
          skill: skill.manifest.name,
          args,
          outcome: "execution_error",
          error: message,
        });
        return { outcome: "execution_error", result };
      }
    },
  };
}
