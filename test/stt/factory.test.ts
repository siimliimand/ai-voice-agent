import { describe, expect, it } from "vitest";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import { createSttProvider } from "../../src/stt/index.js";

/** Build a fully-parsed config with only the given provider API keys set. */
function configWith(
  stt: Record<string, unknown>,
  keys: { elevenlabs?: string; soniox?: string; gladia?: string } = {},
): AppConfig {
  return configSchema.parse({
    stt,
    elevenlabs: { apiKey: keys.elevenlabs ?? "" },
    soniox: { apiKey: keys.soniox ?? "" },
    gladia: { apiKey: keys.gladia ?? "" },
  });
}

describe("stt provider factory", () => {
  it("names ELEVENLABS_API_KEY when scribe is selected without a key", () => {
    expect(() => createSttProvider(configWith({ provider: "scribe" }))).toThrowError(
      /ELEVENLABS_API_KEY/,
    );
  });

  it("names SONIOX_API_KEY when soniox is selected without a key", () => {
    expect(() => createSttProvider(configWith({ provider: "soniox" }))).toThrowError(
      /SONIOX_API_KEY/,
    );
  });

  it("names GLADIA_API_KEY when gladia is selected without a key", () => {
    expect(() => createSttProvider(configWith({ provider: "gladia" }))).toThrowError(
      /GLADIA_API_KEY/,
    );
  });

  it("creates the right provider when keys are configured", () => {
    const keys = { elevenlabs: "k1", soniox: "k2", gladia: "k3" };
    expect(createSttProvider(configWith({ provider: "scribe" }, keys)).name).toBe("scribe");
    expect(createSttProvider(configWith({ provider: "soniox" }, keys)).name).toBe("soniox");
    expect(createSttProvider(configWith({ provider: "gladia" }, keys)).name).toBe("gladia");
  });
});
