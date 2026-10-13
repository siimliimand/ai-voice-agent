import { describe, expect, it } from "vitest";
import {
  GREETINGS,
  SYSTEM_PROMPTS,
  getGreeting,
  getSystemPrompt,
} from "../../src/agent/prompts/index.js";
import { LANGUAGES } from "../../src/types.js";

describe("agent prompts", () => {
  it("provides a non-empty system prompt for every language", () => {
    for (const language of LANGUAGES) {
      expect(SYSTEM_PROMPTS[language].length).toBeGreaterThan(100);
      expect(getSystemPrompt(language)).toBe(SYSTEM_PROMPTS[language]);
    }
  });

  it("provides distinct persona variants per language", () => {
    const prompts = LANGUAGES.map((language) => getSystemPrompt(language));
    expect(new Set(prompts).size).toBe(LANGUAGES.length);
  });

  it("falls back to English when no language is known", () => {
    expect(getSystemPrompt(null)).toBe(SYSTEM_PROMPTS.en);
    expect(getGreeting(null)).toBe(GREETINGS.en);
  });

  it("provides short, distinct greetings for every language", () => {
    const greetings = LANGUAGES.map((language) => getGreeting(language));
    expect(new Set(greetings).size).toBe(LANGUAGES.length);
    for (const greeting of greetings) {
      expect(greeting.length).toBeGreaterThan(0);
      expect(greeting.length).toBeLessThan(120); // one short opening sentence
    }
  });
});
