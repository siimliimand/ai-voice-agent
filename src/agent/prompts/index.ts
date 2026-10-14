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

/**
 * Fixed spoken fallback when the tool loop gives up (design D4): the
 * iteration bound was reached or the dispatcher refused an invocation. The
 * model sees the tool result in its history and picks up on the next turn.
 */
export const TOOL_FALLBACKS: Record<Language, string> = {
  et: "Hästi, märkin selle üles — kolleeg võtab sinuga varsti ühendust.",
  ru: "Хорошо, я это запишу — сотрудник скоро свяжется с вами.",
  en: "Let me note that down and get back to you shortly.",
};

/** Confirmation question for a confirmation-gated skill (design D6). */
const CONFIRMATION_QUESTIONS: Record<Language, (detail: string) => string> = {
  et: (detail) =>
    detail === "" ? "Kas kinnitate selle soovi?" : `Kas kinnitan: ${detail}?`,
  ru: (detail) =>
    detail === "" ? "Подтверждаете этот запрос?" : `Подтверждаете: ${detail}?`,
  en: (detail) =>
    detail === "" ? "Shall I go ahead with that?" : `Shall I go ahead with ${detail}?`,
};

/**
 * Spoken while the call is handed to a human (design D7). The escalation
 * handler plays it through the normal TTS path right before the call ends,
 * on both the browser/dev path and the Twilio REST-failure fallback.
 */
export const ESCALATION_ANNOUNCEMENTS: Record<Language, string> = {
  et: "Hästi, ühendan teid nüüd kolleegiga. Palun oodake.",
  ru: "Хорошо, сейчас я соединю вас с сотрудником. Пожалуйста, оставайтесь на линии.",
  en: "Sure — I'm connecting you with a colleague now. Please hold.",
};

/**
 * Spoken consent notice (design D5) played BEFORE any greeting when the call
 * starts consent-gated, in `consent.initialLanguage`. Plain spoken style: the
 * caller is told the call is recorded/processed and is asked to agree.
 */
export const CONSENT_NOTICES: Record<Language, string> = {
  et: "Tere! Seda kõnet salvestatakse ja töödeldakse. Kas te nõustute?",
  ru: "Здравствуйте! Обратите внимание: этот разговор записывается и обрабатывается. Вы согласны?",
  en: "Hello! Please note that this call is recorded and processed. Do you agree?",
};

/**
 * Spoken once when the first reply to the consent notice was unclear; a
 * second consecutive unclear answer resolves fail-closed as declined.
 */
export const CONSENT_REASKS: Record<Language, string> = {
  et: "Vabandust, ei saanud aru — öelge palun jah või ei: kas te nõustute salvestamisega?",
  ru: "Извините, я не расслышал — ответьте, пожалуйста, да или нет: вы согласны на запись?",
  en: "Sorry, I didn't catch that — please answer yes or no: do you agree to the recording?",
};

/**
 * Short polite farewell spoken when the caller declines (explicitly or by
 * failing the unclear/barge-in budgets) — nothing about the call was ever
 * transcribed, and the call ends right after.
 */
export const CONSENT_GOODBYES: Record<Language, string> = {
  et: "Selge, siis me midagi ei salvesta. Aitäh helistamast ja head päeva!",
  ru: "Хорошо, тогда мы ничего не записываем. Спасибо за звонок и всего доброго!",
  en: "Understood — then nothing is recorded. Thanks for calling and goodbye!",
};

/** Re-ask after one unclear reply; the second unclear answer cancels. */
const CONFIRMATION_REASKS: Record<Language, (detail: string) => string> = {
  et: (detail) =>
    detail === ""
      ? "Vabandust, kas see oli jah või ei?"
      : `Vabandust, kas kinnitan: ${detail} — jah või ei?`,
  ru: (detail) =>
    detail === ""
      ? "Извините, уточните: да или нет?"
      : `Извините, подтверждаете: ${detail} — да или нет?`,
  en: (detail) =>
    detail === ""
      ? "Sorry, was that a yes or a no?"
      : `Sorry — should I go ahead with ${detail}? Yes or no?`,
};

/** System prompt for a language; null (not yet detected) falls back to English. */
export function getSystemPrompt(language: Language | null): string {
  return SYSTEM_PROMPTS[language ?? "en"];
}

/** Opening greeting for a language; null (not yet detected) falls back to English. */
export function getGreeting(language: Language | null): string {
  return GREETINGS[language ?? "en"];
}

/** Spoken tool-loop fallback for a language; null falls back to English. */
export function getToolFallback(language: Language | null): string {
  return TOOL_FALLBACKS[language ?? "en"];
}

/**
 * Confirmation question for a pending gated skill (design D6). `detail` is a
 * short spoken restatement of the arguments (date, time, service) so the
 * caller knows what the yes applies to; empty when the call has none.
 */
export function getConfirmationQuestion(language: Language | null, detail?: string): string {
  return CONFIRMATION_QUESTIONS[language ?? "en"](detail ?? "");
}

/** Re-ask variant used once when the first reply was unclear. */
export function getConfirmationReask(language: Language | null, detail?: string): string {
  return CONFIRMATION_REASKS[language ?? "en"](detail ?? "");
}

/** Escalation announcement for a language; null falls back to English. */
export function getEscalationAnnouncement(language: Language | null): string {
  return ESCALATION_ANNOUNCEMENTS[language ?? "en"];
}

/**
 * Consent notice for a language; null falls back to English. Spoken in
 * `consent.initialLanguage` before any greeting (design D5).
 */
export function getConsentNotice(language: Language | null): string {
  return CONSENT_NOTICES[language ?? "en"];
}

/** Consent re-ask after one unclear reply; the second unclear declines. */
export function getConsentReask(language: Language | null): string {
  return CONSENT_REASKS[language ?? "en"];
}

/** Farewell spoken before hangup when the caller declines consent. */
export function getConsentGoodbye(language: Language | null): string {
  return CONSENT_GOODBYES[language ?? "en"];
}
