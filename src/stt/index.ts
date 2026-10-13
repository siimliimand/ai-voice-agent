import type { AppConfig } from "../config/schema.js";
import { GladiaSttProvider } from "./gladia.js";
import { ScribeSttProvider } from "./scribe.js";
import { SonioxSttProvider } from "./soniox.js";
import type { SttProvider } from "./types.js";

export * from "./types.js";
export { parseScribeMessage, scribeErrorText, ScribeSttProvider } from "./scribe.js";
export { buildSonioxConfig, parseSonioxMessage, SonioxSttProvider } from "./soniox.js";
export { buildGladiaInitBody, GladiaSttProvider, parseGladiaMessage } from "./gladia.js";

/**
 * Create the STT provider selected by config.stt.provider. Throws a clear
 * Error naming the missing environment variable when no API key is set.
 */
export function createSttProvider(config: AppConfig): SttProvider {
  switch (config.stt.provider) {
    case "scribe": {
      if (!config.elevenlabs.apiKey) {
        throw new Error(
          'STT provider "scribe" requires an ElevenLabs API key: set the ELEVENLABS_API_KEY environment variable (or config.elevenlabs.apiKey).',
        );
      }
      return new ScribeSttProvider(config);
    }
    case "soniox": {
      if (!config.soniox.apiKey) {
        throw new Error(
          'STT provider "soniox" requires a Soniox API key: set the SONIOX_API_KEY environment variable (or config.soniox.apiKey).',
        );
      }
      return new SonioxSttProvider(config);
    }
    case "gladia": {
      if (!config.gladia.apiKey) {
        throw new Error(
          'STT provider "gladia" requires a Gladia API key: set the GLADIA_API_KEY environment variable (or config.gladia.apiKey).',
        );
      }
      return new GladiaSttProvider(config);
    }
    default: {
      const provider: never = config.stt.provider;
      throw new Error(`Unknown STT provider: ${String(provider)}`);
    }
  }
}
