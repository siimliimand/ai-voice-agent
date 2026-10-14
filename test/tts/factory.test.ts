import { describe, expect, it } from "vitest";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import { ElevenLabsDialogueTtsProvider } from "../../src/tts/elevenlabs-dialogue.js";
import { ElevenLabsTtsProvider } from "../../src/tts/elevenlabs.js";
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

describe("createTtsProvider: transport selection per tts.api", () => {
  it("uses the stream-input provider for v2.x models under auto", () => {
    expect(
      createTtsProvider(configWith({ provider: "elevenlabs", model: "eleven_turbo_v2_5" }, "k")),
    ).toBeInstanceOf(ElevenLabsTtsProvider);
  });

  it("uses the dialogue provider for Eleven v3/v4 models under auto", () => {
    expect(
      createTtsProvider(configWith({ provider: "elevenlabs", model: "eleven_v4_turbo" }, "k")),
    ).toBeInstanceOf(ElevenLabsDialogueTtsProvider);
    expect(
      createTtsProvider(configWith({ provider: "elevenlabs", model: "eleven_v3" }, "k")),
    ).toBeInstanceOf(ElevenLabsDialogueTtsProvider);
  });

  it("honors explicitly forced transports", () => {
    expect(
      createTtsProvider(
        configWith({ provider: "elevenlabs", api: "dialogue", model: "eleven_v4_turbo" }, "k"),
      ),
    ).toBeInstanceOf(ElevenLabsDialogueTtsProvider);
    expect(
      createTtsProvider(
        configWith({ provider: "elevenlabs", api: "tts", model: "eleven_turbo_v2_5" }, "k"),
      ),
    ).toBeInstanceOf(ElevenLabsTtsProvider);
  });

  it("fails with a clear error when a forced dialogue transport gets a v2.x model", () => {
    expect(() =>
      createTtsProvider(
        configWith({ provider: "elevenlabs", api: "dialogue", model: "eleven_turbo_v2_5" }, "k"),
      ),
    ).toThrowError(/tts\.api "dialogue" requires an Eleven v3\/v4 model.*eleven_turbo_v2_5/s);
  });

  it("fails with a clear error when a forced tts transport gets a v3/v4 model", () => {
    expect(() =>
      createTtsProvider(
        configWith({ provider: "elevenlabs", api: "tts", model: "eleven_v4_turbo" }, "k"),
      ),
    ).toThrowError(/only streams over the text-to-dialogue API/);
  });
});
