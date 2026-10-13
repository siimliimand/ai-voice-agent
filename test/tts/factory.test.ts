import { describe, expect, it } from "vitest";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import { createTtsProvider } from "../../src/tts/index.js";

/** Build a fully-parsed config with only the given provider API key set. */
function configWith(tts: Record<string, unknown>, elevenlabsApiKey = ""): AppConfig {
  return configSchema.parse({ tts, elevenlabs: { apiKey: elevenlabsApiKey } });
}

describe("tts provider factory", () => {
  it("names ELEVENLABS_API_KEY when elevenlabs is selected without a key", () => {
    expect(() => createTtsProvider(configWith({ provider: "elevenlabs" }))).toThrowError(
      /ELEVENLABS_API_KEY/,
    );
  });

  it("explains that azure is a documented contingency, not implemented", () => {
    expect(() => createTtsProvider(configWith({ provider: "azure" }))).toThrowError(
      /not implemented yet.*M1 contingency/s,
    );
  });

  it("creates the elevenlabs provider when a key is configured", () => {
    expect(createTtsProvider(configWith({ provider: "elevenlabs" }, "k")).name).toBe("elevenlabs");
  });
});
