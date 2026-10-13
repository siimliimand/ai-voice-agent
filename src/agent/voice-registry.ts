/**
 * Voice selection per language.
 *
 * Hot-swap semantics: the pipeline calls voiceForLanguage() once per TTS
 * stream (i.e. per spoken sentence), so after a language re-lock the new
 * voice takes effect on the NEXT spoken sentence. Audio already queued or
 * streaming keeps the previous voice until it finishes.
 */
import type { AppConfig } from "../config/schema.js";
import type { Language } from "../types.js";

/** TTS voice id for a language; null (not yet locked) uses the English voice. */
export function voiceForLanguage(config: AppConfig, language: Language | null): string {
  switch (language) {
    case "et":
      return config.tts.voiceEt;
    case "ru":
      return config.tts.voiceRu;
    case "en":
    case null:
      return config.tts.voiceEn;
  }
}
