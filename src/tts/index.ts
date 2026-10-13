import type { AppConfig } from "../config/schema.js";
import { ElevenLabsTtsProvider } from "./elevenlabs.js";
import type { TtsProvider } from "./types.js";

export * from "./types.js";
export { chunkSentences, DEFAULT_MIN_SENTENCE_LENGTH, SentenceChunker } from "./sentence.js";
export { ElevenLabsTtsProvider } from "./elevenlabs.js";

/**
 * Create the TTS provider selected by config.tts.provider. Throws a clear
 * Error naming the missing environment variable when no API key is set.
 */
export function createTtsProvider(config: AppConfig): TtsProvider {
  switch (config.tts.provider) {
    case "elevenlabs": {
      if (!config.elevenlabs.apiKey) {
        throw new Error(
          'TTS provider "elevenlabs" requires an ElevenLabs API key: set the ELEVENLABS_API_KEY environment variable (or config.elevenlabs.apiKey).',
        );
      }
      return new ElevenLabsTtsProvider(config);
    }
    case "azure":
      // Azure Neural TTS fallback: planned contingency if ElevenLabs quality
      // or cost fails the bake-off for any language (see change notes).
      throw new Error(
        'TTS provider "azure" is not implemented yet — Azure fallback adapter is a documented M1 contingency.',
      );
    default: {
      const provider: never = config.tts.provider;
      throw new Error(`Unknown TTS provider: ${String(provider)}`);
    }
  }
}
