/**
 * Skills framework public API (design D1–D3). The tool-calling loop
 * (ConversationManager, task 3.2) codes against `loadSkills(config)` and
 * `createDispatcher(...)`; executors plug in per execution kind:
 *
 *   const registry = loadSkills(config);
 *   const dispatcher = createDispatcher({
 *     registry,
 *     db,
 *     executors: {
 *       http: createHttpExecutor({ config }),
 *       db: createDbExecutor({ db }),
 *       // rag stays unregistered → clear not-implemented tool result
 *     },
 *   });
 *   const { outcome, result } = await dispatcher(callId, invocation, { confirmed });
 */

export { loadSkills, type LoadSkillsDeps } from "./loader.js";
export { createRegistry, type LoadedSkill, type SkillRegistry } from "./registry.js";
export {
  skillManifestSchema,
  SKILL_NAME_PATTERN,
  PARAM_PATTERN,
  skillExecutionKinds,
  type SkillExecutionKind,
  type SkillManifest,
} from "./manifest.js";
export { findSqlViolation } from "./sql-guard.js";
export {
  createDispatcher,
  callEventAudit,
  type SkillDispatcher,
  type SkillInvocation,
  type DispatchOptions,
  type DispatchResult,
  type SkillInvocationOutcome,
  type SkillExecutor,
  type SkillExecutors,
  type SkillAuditWriter,
  type SkillInvocationAudit,
  type DispatcherDeps,
} from "./dispatcher.js";
export { createHttpExecutor, type HttpExecutorDeps } from "./http-executor.js";
export { createDbExecutor, type DbExecutorDeps } from "./db-executor.js";
