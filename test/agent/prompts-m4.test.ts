/**
 * M4 system-prompt guidance tests (task 3.4): tool-use discipline,
 * confirmation-question wording, and escalation guidance must exist in all
 * three language variants; the fixed agent speech (tool-loop fallback,
 * confirmation questions) must exist per language too.
 */
import { describe, expect, it } from "vitest";
import {
  getConfirmationQuestion,
  getConfirmationReask,
  getEscalationAnnouncement,
  getToolFallback,
  SYSTEM_PROMPTS,
} from "../../src/agent/prompts/index.js";
import { LANGUAGES } from "../../src/types.js";

describe("M4 system prompt guidance (task 3.4)", () => {
  it("teaches tool-use discipline in all three variants", () => {
    expect(SYSTEM_PROMPTS.en).toMatch(/valid JSON/);
    expect(SYSTEM_PROMPTS.en).toMatch(/never invent a function's results/i);
    expect(SYSTEM_PROMPTS.et).toMatch(/kehtiva JSON-i/);
    expect(SYSTEM_PROMPTS.et).toMatch(/ära kunagi leiuta funktsiooni tulemust/);
    expect(SYSTEM_PROMPTS.ru).toMatch(/корректного JSON/i);
    expect(SYSTEM_PROMPTS.ru).toMatch(/никогда не выдумывай результат функции/i);
  });

  it("guides confirmation-question wording in all three variants", () => {
    expect(SYSTEM_PROMPTS.en).toMatch(/yes-or-no question.*restates/i);
    expect(SYSTEM_PROMPTS.et).toMatch(/ja-ei küsimus/);
    expect(SYSTEM_PROMPTS.ru).toMatch(/«да или нет»/);
  });

  it("guides escalation via the escalate_to_human builtin in all three variants", () => {
    for (const language of LANGUAGES) {
      expect(SYSTEM_PROMPTS[language]).toContain("escalate_to_human");
    }
    expect(SYSTEM_PROMPTS.en).toMatch(/asks for a human colleague/);
    expect(SYSTEM_PROMPTS.et).toMatch(/palub inimkolleegi/);
    expect(SYSTEM_PROMPTS.ru).toMatch(/просит позвать человека/);
  });
});

describe("M4 fixed agent speech (tasks 3.2/3.3)", () => {
  it("provides a distinct trilingual tool-loop fallback", () => {
    for (const language of LANGUAGES) {
      expect(getToolFallback(language).length).toBeGreaterThan(10);
    }
    expect(new Set(LANGUAGES.map((l) => getToolFallback(l))).size).toBe(LANGUAGES.length);
  });

  it("provides confirmation questions that restate a detail when given", () => {
    for (const language of LANGUAGES) {
      const question = getConfirmationQuestion(language, "1. mai, koristus");
      const reask = getConfirmationReask(language, "1. mai, koristus");
      expect(question).toContain("1. mai, koristus");
      expect(reask).toContain("1. mai, koristus");
      expect(getConfirmationQuestion(language)).not.toContain("undefined");
      expect(getConfirmationReask(language)).not.toContain("undefined");
    }
  });

  it("provides a distinct trilingual escalation announcement (task 5.1)", () => {
    for (const language of LANGUAGES) {
      expect(getEscalationAnnouncement(language).length).toBeGreaterThan(10);
    }
    expect(new Set(LANGUAGES.map((l) => getEscalationAnnouncement(l))).size).toBe(
      LANGUAGES.length,
    );
    // Unlocked language falls back to English, like every fixed speech.
    expect(getEscalationAnnouncement(null)).toBe(getEscalationAnnouncement("en"));
  });
});
