import { describe, expect, it } from "vitest";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import { resolveModel } from "../../src/llm/resolve-model.js";

function makeConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return configSchema.parse({
    llm: {
      models: { conversation: "prov/conv", summarizer: "prov/sum", utility: "prov/util" },
      overrides,
    },
  });
}

describe("resolveModel", () => {
  it("returns the role default when no language is given", () => {
    const config = makeConfig();
    expect(resolveModel(config, "conversation")).toBe("prov/conv");
    expect(resolveModel(config, "summarizer")).toBe("prov/sum");
    expect(resolveModel(config, "utility")).toBe("prov/util");
  });

  it("falls back to the role default for null/unknown-override languages", () => {
    const config = makeConfig({ et: { conversation: "prov/conv-et" } });
    expect(resolveModel(config, "conversation", null)).toBe("prov/conv");
    expect(resolveModel(config, "conversation", undefined)).toBe("prov/conv");
    expect(resolveModel(config, "conversation", "ru")).toBe("prov/conv");
  });

  it("prefers the per-language override for that role only", () => {
    const config = makeConfig({ et: { conversation: "prov/conv-et" } });
    expect(resolveModel(config, "conversation", "et")).toBe("prov/conv-et");
    // summarizer is unaffected by the et conversation override
    expect(resolveModel(config, "summarizer", "et")).toBe("prov/sum");
    expect(resolveModel(config, "utility", "et")).toBe("prov/util");
  });

  it("resolves independent overrides per language and role", () => {
    const config = makeConfig({
      et: { conversation: "prov/conv-et", summarizer: "prov/sum-et" },
      ru: { conversation: "prov/conv-ru" },
    });
    expect(resolveModel(config, "conversation", "et")).toBe("prov/conv-et");
    expect(resolveModel(config, "summarizer", "et")).toBe("prov/sum-et");
    expect(resolveModel(config, "conversation", "ru")).toBe("prov/conv-ru");
    expect(resolveModel(config, "summarizer", "ru")).toBe("prov/sum");
    expect(resolveModel(config, "conversation", "en")).toBe("prov/conv");
  });
});
