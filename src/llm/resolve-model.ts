/**
 * Model selection per LLM role: an explicit per-language override for the role
 * wins, otherwise the role's default model from config.llm.models is used.
 */

import type { AppConfig, LlmRole } from "../config/schema.js";
import type { Language } from "../types.js";

export function resolveModel(config: AppConfig, role: LlmRole, language?: Language | null): string {
  if (language) {
    const override = config.llm.overrides[language]?.[role];
    if (override) return override;
  }
  return config.llm.models[role];
}
