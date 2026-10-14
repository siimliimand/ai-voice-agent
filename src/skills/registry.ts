/**
 * Skill registry (design D2): the in-memory set of valid manifests, each with
 * its ajv-compiled argument validator. Produces the OpenAI tool definitions
 * array passed through to the LLM.
 */

import type { ValidateFunction } from "ajv";
import type { ToolDefinition } from "../llm/openrouter.js";
import type { SkillManifest } from "./manifest.js";

/** One manifest that passed load-time validation, ready to execute. */
export interface LoadedSkill {
  manifest: SkillManifest;
  /** ajv-compiled validator over manifest.parameters (compiled once at load). */
  validateArguments: ValidateFunction;
}

export interface SkillRegistry {
  /** Number of loaded skills. */
  readonly size: number;
  /** OpenAI tool definitions for the LLM, ordered by skill name. */
  listTools(): ToolDefinition[];
  /** Look up one loaded skill by tool name. */
  get(name: string): LoadedSkill | undefined;
  /** All loaded skills, ordered by name. */
  all(): LoadedSkill[];
}

/** Build a registry from already-validated skills (input keeps its order). */
export function createRegistry(skills: LoadedSkill[]): SkillRegistry {
  const byName = new Map(skills.map((s) => [s.manifest.name, s] as const));
  return {
    get size() {
      return byName.size;
    },
    listTools() {
      return [...byName.values()].map((s) => ({
        type: "function" as const,
        function: {
          name: s.manifest.name,
          description: s.manifest.description,
          parameters: s.manifest.parameters,
        },
      }));
    },
    get: (name) => byName.get(name),
    all: () => [...byName.values()],
  };
}
