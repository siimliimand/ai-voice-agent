/**
 * Hand-written language test vectors for the trilingual (et/ru/en) support
 * line.
 *
 * These complement the committed reference transcripts in
 * `test/fixtures/fixture-{et,ru,en}.txt` with a richer, deterministic set of
 * utterances — including realistic Estonian–Russian code-switching (very
 * common among callers in Estonia) and genuinely ambiguous inputs that
 * document the LanguageManager fallback chain.
 */

import type { Language } from "../../src/types.js";

/** A single utterance plus the language it is expected to resolve to. */
export interface LanguageSample {
  readonly text: string;
  /** Expected classification (dominant language for code-switch samples). */
  readonly expected: Language;
}

/** A short/ambiguous input documenting the documented fallback behavior. */
export interface AmbiguousSample {
  readonly text: string;
  /** Why this input is genuinely ambiguous. */
  readonly reason: string;
  /** Expected result of the fallback chain: utility LLM throws, no STT hint. */
  readonly expectedFallback: Language;
}

/** Natural monolingual Estonian support-line utterances. */
export const etSamples: readonly LanguageSample[] = [
  { text: "Tere, tahaksin oma internetipaketti vahetada. Kas see on võimalik?", expected: "et" },
  { text: "Palun vabandust, ühendus katkes ära. Kas saate mind uuesti kuulda?", expected: "et" },
  { text: "Tänan väga, ootan teie kõnet tagasi. Head päeva!", expected: "et" },
];

/** Natural monolingual Russian support-line utterances. */
export const ruSamples: readonly LanguageSample[] = [
  { text: "Здравствуйте, я хотел бы уточнить баланс на своём счёте.", expected: "ru" },
  { text: "Извините, связь прервалась. Вы меня хорошо слышите?", expected: "ru" },
  { text: "Большое спасибо за помощь, всего вам доброго!", expected: "ru" },
];

/** Natural monolingual English support-line utterances. */
export const enSamples: readonly LanguageSample[] = [
  { text: "Hi, I'd like to upgrade my subscription, please.", expected: "en" },
  { text: "Sorry, the line dropped for a second. Can you still hear me?", expected: "en" },
  { text: "Thanks a lot for your help. Have a great day!", expected: "en" },
];

/**
 * Realistic Estonian–Russian code-switching utterances, each classified by
 * its DOMINANT language (per the detection prompt's contract), not by script.
 */
export const codeSwitchSamples: readonly LanguageSample[] = [
  // Estonian frame, mid-sentence switch into Russian, back to Estonian.
  {
    text: "Tere, kas saaksite mind aidata — у меня проблема со счётом, arve tuli väga suur.",
    expected: "et",
  },
  // Russian frame with Estonian billing loanwords (very common in Estonia).
  {
    text: "Здравствуйте, подскажите пожалуйста, arve makse — оплата счёта — прошла или ещё нет?",
    expected: "ru",
  },
  // Russian frame repeating the complaint in Estonian, then back to Russian.
  {
    text: "Добрый день! Помогите разобраться: makse ei läinud läbi, платёж не прошёл, что делать?",
    expected: "ru",
  },
];

/**
 * Genuinely ambiguous or too-short inputs. These document the fallback
 * chain: without a usable utility vote or STT hint the manager lands on
 * "en" as the last resort.
 */
export const ambiguousSamples: readonly AmbiguousSample[] = [
  {
    text: "aloha",
    reason:
      "Greeting from none of the supported languages — no reliable script or lexical evidence; " +
      "documents the last-resort 'en' fallback when the utility vote fails and no STT hint exists.",
    expectedFallback: "en",
  },
  {
    text: "да",
    reason:
      "Single word — far too little evidence for a trustworthy classification; " +
      "documents the fallback chain (utility vote -> STT hint -> 'en') on minimal input.",
    expectedFallback: "en",
  },
];

/** Committed reference transcripts and the language each must classify to. */
export const transcriptFixtures: readonly { file: string; expected: Language }[] = [
  { file: "fixture-et.txt", expected: "et" },
  { file: "fixture-ru.txt", expected: "ru" },
  { file: "fixture-en.txt", expected: "en" },
];
