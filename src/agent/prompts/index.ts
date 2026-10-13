/**
 * Per-language system prompts and opening greetings for the conversation
 * agent. Null (no language locked yet) resolves to English everywhere.
 */
import type { Language } from "../../types.js";
import { SYSTEM_PROMPT as EN_PROMPT } from "./en.js";
import { SYSTEM_PROMPT as ET_PROMPT } from "./et.js";
import { SYSTEM_PROMPT as RU_PROMPT } from "./ru.js";

/** Support-worker persona, one variant per supported language. */
export const SYSTEM_PROMPTS: Record<Language, string> = {
  en: EN_PROMPT,
  et: ET_PROMPT,
  ru: RU_PROMPT,
};

/** Short trilingual openings spoken as the very first utterance of a call. */
export const GREETINGS: Record<Language, string> = {
  et: "Tere! Abikeskuse robotist räägin — kuidas saan aidata?",
  ru: "Здравствуйте! Вас приветствует служба поддержки — чем могу помочь?",
  en: "Hello, support line here — how can I help you today?",
};

/** System prompt for a language; null (not yet detected) falls back to English. */
export function getSystemPrompt(language: Language | null): string {
  return SYSTEM_PROMPTS[language ?? "en"];
}

/** Opening greeting for a language; null (not yet detected) falls back to English. */
export function getGreeting(language: Language | null): string {
  return GREETINGS[language ?? "en"];
}
