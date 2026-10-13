/**
 * Per-call language manager.
 *
 * Detects the caller's language from the first utterance using the utility
 * LLM (with an STT hint as fallback), locks the language, and afterwards
 * re-locks when the caller switches languages mid-call. Estonian and Russian
 * callers often code-switch; the classification prompt therefore asks for the
 * dominant language of the words rather than the script.
 *
 * Events (Node EventEmitter):
 *   - "locked"   (language)      — first detection for this call
 *   - "relocked" ({ from, to })  — caller switched languages mid-call
 */
import { EventEmitter } from "node:events";
import { z } from "zod";
import type { AppConfig } from "../config/schema.js";
import type { OpenRouterClient } from "../llm/openrouter.js";
import { resolveModel } from "../llm/resolve-model.js";
import { isLanguage, type Language } from "../types.js";

/** STT-provided hint about the language it heard. */
export interface SttHint {
  language?: string;
  confidence?: number;
}

/** Payload of the "relocked" event. */
export interface RelockEvent {
  from: Language;
  to: Language;
}

/** A language classification with a confidence in [0..1]. */
interface Vote {
  language: Language;
  confidence: number;
}

const detectionSchema = z.object({
  language: z.enum(["et", "ru", "en"]),
  confidence: z.number().min(0).max(1).optional(),
});

/** Confidence assumed when the utility model omits it. */
const DEFAULT_CONFIDENCE = 0.5;
/** Confidence assigned to the STT-hint fallback when the hint omits one. */
const FALLBACK_HINT_CONFIDENCE = 0.5;
/** Confidence assigned to the last-resort "en" fallback. */
const FALLBACK_CONFIDENCE = 0.3;
/** Utility votes at/above this confidence count toward a re-lock. */
const RELOCK_VOTE_CONFIDENCE = 0.7;
/** STT hints at/above this confidence re-lock immediately. */
const RELOCK_HINT_CONFIDENCE = 0.9;
/** Consecutive confident different-language votes required to re-lock. */
const VOTES_TO_RELOCK = 2;

const DETECTION_SYSTEM_PROMPT = `You identify the dominant spoken language of a caller on a trilingual (Estonian, Russian, English) support line.
Rules:
- Estonian and Russian callers often mix the two languages (code-switching). Classify by the dominant language of the actual words, never by script or alphabet alone.
- Ignore isolated greetings or filler words from another language.
Respond with ONLY a JSON object and nothing else:
{"language":"et","confidence":0.87}
where "language" is exactly one of "et", "ru", "en" and "confidence" is between 0.0 and 1.0.`;

/**
 * Extract and validate the first JSON object in an LLM response. Anything
 * unexpected (prose, markdown fences, garbage) yields null.
 */
function parseDetection(raw: string): Vote | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const result = detectionSchema.safeParse(parsed);
  if (!result.success) return null;
  return {
    language: result.data.language,
    confidence: result.data.confidence ?? DEFAULT_CONFIDENCE,
  };
}

export class LanguageManager extends EventEmitter {
  private _current: Language | null = null;
  private _confidence = 0;
  private _locked = false;
  /** Rolling window of recent utility votes favouring a different language. */
  private pendingSwitchVotes: string[] = [];

  constructor(
    private readonly config: AppConfig,
    private readonly llm: OpenRouterClient,
  ) {
    super();
  }

  /** Currently locked/known language, or null before the first detection. */
  get current(): Language | null {
    return this._current;
  }

  /** Confidence of the current language assignment. */
  get confidence(): number {
    return this._confidence;
  }

  /** True once a language has been locked for this call. */
  get locked(): boolean {
    return this._locked;
  }

  /** Recent different-language votes (introspection for tests/dev). */
  get pendingVotes(): readonly string[] {
    return this.pendingSwitchVotes;
  }

  /**
   * Detect the caller's language for an utterance. The utility model votes
   * first; if it fails, the STT hint is used, and "en" is the last resort.
   * The first resolution locks the language for this call.
   */
  async detect(text: string, sttHint?: SttHint): Promise<Language> {
    const vote = await this.voteWithFallback(text, sttHint);
    this.apply(vote.language, vote.confidence);
    return vote.language;
  }

  /**
   * Re-detection for an already-locked call. Re-locks (and emits "relocked")
   * when the utility model votes for a different language with confidence
   * >= 0.7 twice in a row, or when the STT hint names a different language
   * with confidence >= 0.9. Returns the new language, or null when unchanged.
   */
  async maybeRelock(text: string, sttHint?: SttHint): Promise<Language | null> {
    if (!this._locked || this._current === null) return null;
    const current = this._current;

    let vote: Vote | null = null;
    try {
      vote = await this.classify(text);
    } catch {
      vote = null; // utility unavailable; the STT-hint path below still applies
    }

    if (vote !== null) {
      if (vote.language === current) {
        this._confidence = vote.confidence;
        this.pendingSwitchVotes = [];
      } else if (vote.confidence >= RELOCK_VOTE_CONFIDENCE) {
        // Keep only consecutive votes for the same target language.
        if (this.pendingSwitchVotes.at(-1) !== vote.language) this.pendingSwitchVotes = [];
        this.pendingSwitchVotes.push(vote.language);
        if (this.pendingSwitchVotes.length >= VOTES_TO_RELOCK) {
          return this.relockTo(current, vote.language, vote.confidence);
        }
      } else {
        // Different language but weakly held: reset the streak.
        this.pendingSwitchVotes = [];
      }
    }

    if (
      sttHint?.language !== undefined &&
      isLanguage(sttHint.language) &&
      sttHint.language !== current &&
      (sttHint.confidence ?? 0) >= RELOCK_HINT_CONFIDENCE
    ) {
      return this.relockTo(current, sttHint.language, sttHint.confidence ?? RELOCK_HINT_CONFIDENCE);
    }
    return null;
  }

  /** Manual override (dev/testing): behaves like a definitive detection. */
  pin(language: Language): void {
    this.apply(language, 1);
  }

  /** Assign the language, locking on first use and emitting the right event. */
  private apply(language: Language, confidence: number): void {
    const previous = this._current;
    this._current = language;
    this._confidence = confidence;
    this.pendingSwitchVotes = [];
    if (!this._locked) {
      this._locked = true;
      this.emit("locked", language);
    } else if (previous !== null && previous !== language) {
      this.emit("relocked", { from: previous, to: language } satisfies RelockEvent);
    }
  }

  /** Switch the locked language and announce it to pipeline listeners. */
  private relockTo(from: Language, to: Language, confidence: number): Language {
    this._current = to;
    this._confidence = confidence;
    this.pendingSwitchVotes = [];
    this.emit("relocked", { from, to } satisfies RelockEvent);
    return to;
  }

  /** Utility-model classification, with STT-hint then "en" fallbacks. */
  private async voteWithFallback(text: string, sttHint?: SttHint): Promise<Vote> {
    try {
      return await this.classify(text);
    } catch {
      if (sttHint?.language !== undefined && isLanguage(sttHint.language)) {
        return {
          language: sttHint.language,
          confidence: sttHint.confidence ?? FALLBACK_HINT_CONFIDENCE,
        };
      }
      return { language: "en", confidence: FALLBACK_CONFIDENCE };
    }
  }

  /** Ask the utility model for a JSON language vote; throws when unusable. */
  private async classify(text: string): Promise<Vote> {
    const raw = await this.llm.chat({
      model: resolveModel(this.config, "utility"),
      messages: [
        { role: "system", content: DETECTION_SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      temperature: 0,
      maxTokens: 40,
    });
    const vote = parseDetection(raw);
    if (vote === null) {
      throw new Error("utility model did not return a valid language detection");
    }
    return vote;
  }
}
