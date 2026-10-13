import { describe, expect, it } from "vitest";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import { voiceForLanguage } from "../../src/agent/voice-registry.js";

const config: AppConfig = configSchema.parse({
  tts: { voiceEt: "voice-et-id", voiceRu: "voice-ru-id", voiceEn: "voice-en-id" },
});

describe("voiceForLanguage", () => {
  it("maps each language to its configured voice", () => {
    expect(voiceForLanguage(config, "et")).toBe("voice-et-id");
    expect(voiceForLanguage(config, "ru")).toBe("voice-ru-id");
    expect(voiceForLanguage(config, "en")).toBe("voice-en-id");
  });

  it("falls back to the English voice when no language is locked", () => {
    expect(voiceForLanguage(config, null)).toBe("voice-en-id");
  });

  it("returns the provider defaults from config when no overrides are set", () => {
    const defaults = configSchema.parse({});
    expect(voiceForLanguage(defaults, "et")).toBe(defaults.tts.voiceEt);
    expect(voiceForLanguage(defaults, "ru")).toBe(defaults.tts.voiceRu);
    expect(voiceForLanguage(defaults, "en")).toBe(defaults.tts.voiceEn);
    expect(voiceForLanguage(defaults, null)).toBe(defaults.tts.voiceEn);
  });
});
