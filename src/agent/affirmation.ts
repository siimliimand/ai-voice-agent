/**
 * AffirmationClassifier (design D6): decides whether a caller's short spoken
 * reply to a yes/no question — a confirmation-gated skill or the consent
 * notice — means yes or no. Deterministic per-language keyword lists cover the
 * common case with zero latency; the utility model is a tiebreaker used ONLY
 * for "unclear" answers, and any tiebreaker failure maps back to "unclear"
 * (fail-closed — ambiguity never dispatches a skill).
 *
 * Matching is token-based over a union of all three languages so callers who
 * code-switch (et/ru mixes are common) still resolve; mixed signals ("yes but
 * no") are treated as unclear by design.
 */
import type { AppConfig } from "../config/schema.js";
import type { OpenRouterClient } from "../llm/openrouter.js";
import { resolveModel } from "../llm/resolve-model.js";
import { logger as rootLogger, type Logger } from "../logging.js";
import type { Language } from "../types.js";

export type AffirmationVerdict = "affirmative" | "decline" | "unclear";

export interface AffirmationClassifierDeps {
  config: AppConfig;
  /** Client used for the utility-model tiebreaker (chat only). */
  llm: Pick<OpenRouterClient, "chat">;
  logger?: Logger;
}

/**
 * Yes-words per language. Estonian includes the polite conditional forms the
 * brief lists ("oleks", "palun", "tehke"); Russian includes the request forms
 * ("запишите", "давайте"); English includes the idiom tokens ("go ahead",
 * "book it" → "ahead", "book").
 */
const AFFIRMATIVE_WORDS: Record<Language, readonly string[]> = {
  et: [
    "jah", "jaa", "juu", "jap", "jep", "mhm", "oleks", "palun", "ühel", "ühes",
    "tehke", "tehku", "tee", "olgu", "hästi", "selge", "sobib", "kindlasti",
    "muidugi", "nõus", "täpselt",
  ],
  ru: [
    "да", "давай", "давайте", "хорошо", "конечно", "ладно", "запишите",
    "запиши", "угу", "ага", "согласен", "согласна", "обязательно",
    "подтверждаю", "верно", "точно", "ок", "окей",
  ],
  en: [
    "yes", "yep", "yeah", "yea", "yup", "sure", "please", "ok", "okay",
    "correct", "right", "absolutely", "definitely", "certainly", "confirm",
    "confirmed", "go", "ahead", "book", "booking",
  ],
};

/** No-words per language. Apostrophes are stripped, so "don't" → "dont". */
const DECLINE_WORDS: Record<Language, readonly string[]> = {
  et: ["ei", "kahjuks", "ära", "mitte", "tühista", "tühistan", "pole"],
  ru: ["нет", "не", "отмена", "отменить", "отмените", "отменяю"],
  en: ["no", "nope", "nah", "not", "cancel", "dont", "cannot", "cant", "stop"],
};

/** Union sets: matching ignores which language the single word came from. */
const AFFIRMATIVE = new Set(Object.values(AFFIRMATIVE_WORDS).flat());
const DECLINE = new Set(Object.values(DECLINE_WORDS).flat());

/** Tiebreaker prompt for the utility model — one word out, nothing else. */
const TIEBREAK_SYSTEM_PROMPT =
  "You judge a caller's short spoken reply to a yes/no question on a trilingual " +
  "(Estonian, Russian, English) support line; the languages may mix. " +
  'Reply with exactly one word: "yes" when the caller agrees or asks to proceed, ' +
  '"no" when they refuse or cancel, "unclear" when the reply is ambiguous, ' +
  "off-topic, or you cannot tell.";

/**
 * Lowercase, drop apostrophes ("don't" → "dont"), and split into word tokens
 * across Latin (incl. Estonian õäöü) and Cyrillic scripts.
 */
function tokenize(answer: string): string[] {
  return answer
    .toLowerCase()
    .replace(/['’`´]/g, "")
    .split(/[^a-zа-яёõäöü0-9]+/)
    .filter((token) => token.length > 0);
}

export class AffirmationClassifier {
  private readonly log: Logger;

  constructor(private readonly deps: AffirmationClassifierDeps) {
    this.log = deps.logger ?? rootLogger;
  }

  /**
   * Classify one reply. Deterministic keywords first; the utility model is
   * consulted only when keywords come back unclear, and it can only break
   * the tie — its failure never upgrades an answer to a decision.
   */
  async decide(answer: string, language: Language | null): Promise<AffirmationVerdict> {
    const verdict = this.judge(answer);
    if (verdict !== "unclear") return verdict;
    return this.tiebreak(answer, language);
  }

  /** Deterministic keyword pass: affirmative/decline; mixed or empty → unclear. */
  private judge(answer: string): AffirmationVerdict {
    const tokens = tokenize(answer);
    if (tokens.length === 0) return "unclear";
    let affirmative = false;
    let decline = false;
    for (const token of tokens) {
      if (AFFIRMATIVE.has(token)) affirmative = true;
      if (DECLINE.has(token)) decline = true;
    }
    if (affirmative && !decline) return "affirmative";
    if (decline && !affirmative) return "decline";
    return "unclear"; // nothing matched, or contradictory signals
  }

  /** Utility-model tiebreaker; fail-closed to "unclear" on any error. */
  private async tiebreak(answer: string, language: Language | null): Promise<AffirmationVerdict> {
    try {
      const raw = await this.deps.llm.chat({
        model: resolveModel(this.deps.config, "utility", language),
        messages: [
          { role: "system", content: TIEBREAK_SYSTEM_PROMPT },
          { role: "user", content: answer },
        ],
        temperature: 0,
        maxTokens: 8,
      });
      const word = raw.trim().toLowerCase();
      if (word.startsWith("yes")) return "affirmative";
      if (word.startsWith("no")) return "decline";
      return "unclear";
    } catch (err) {
      this.log.debug({ err }, "affirmation tiebreaker failed — falling back to unclear");
      return "unclear";
    }
  }
}
