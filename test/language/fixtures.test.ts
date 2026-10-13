/**
 * Validates the hand-written test vectors in test/language/fixtures.ts
 * themselves: shape, non-emptiness, expected-language consistency, and —
 * at the text level — that code-switch samples genuinely mix scripts.
 */

import { describe, expect, it } from "vitest";
import {
  ambiguousSamples,
  codeSwitchSamples,
  enSamples,
  etSamples,
  ruSamples,
  transcriptFixtures,
} from "./fixtures.js";

const hasCyrillic = (text: string): boolean => /\p{Script=Cyrillic}/u.test(text);
const hasLatin = (text: string): boolean => /\p{Script=Latin}/u.test(text);

describe("language test vectors (fixtures.ts)", () => {
  it("exposes 2-3 samples for each language", () => {
    for (const samples of [etSamples, ruSamples, enSamples]) {
      expect(samples.length).toBeGreaterThanOrEqual(2);
      expect(samples.length).toBeLessThanOrEqual(3);
    }
  });

  it.each([["et", etSamples] as const, ["ru", ruSamples] as const, ["en", enSamples] as const])(
    "%s samples are non-empty strings expecting their own language",
    (lang, samples) => {
      for (const sample of samples) {
        expect(typeof sample.text).toBe("string");
        expect(sample.text.trim().length).toBeGreaterThan(3); // real utterances, not stubs
        expect(sample.expected).toBe(lang);
      }
    },
  );

  it("monolingual samples are single-script (no stray other-language letters)", () => {
    for (const sample of [...etSamples, ...enSamples]) {
      expect(hasLatin(sample.text)).toBe(true);
      expect(hasCyrillic(sample.text)).toBe(false);
    }
    for (const sample of ruSamples) {
      expect(hasCyrillic(sample.text)).toBe(true);
      expect(hasLatin(sample.text)).toBe(false);
    }
  });

  it("exposes 2-3 code-switch samples that mix Cyrillic and Latin scripts", () => {
    expect(codeSwitchSamples.length).toBeGreaterThanOrEqual(2);
    expect(codeSwitchSamples.length).toBeLessThanOrEqual(3);
    for (const sample of codeSwitchSamples) {
      expect(sample.text.trim().length).toBeGreaterThan(3);
      // et<->ru code-switching must genuinely contain both scripts.
      expect(hasCyrillic(sample.text)).toBe(true);
      expect(hasLatin(sample.text)).toBe(true);
      expect(["et", "ru", "en"]).toContain(sample.expected);
    }
  });

  it("exposes 1-2 ambiguous samples documenting fallback behavior", () => {
    expect(ambiguousSamples.length).toBeGreaterThanOrEqual(1);
    expect(ambiguousSamples.length).toBeLessThanOrEqual(2);
    for (const sample of ambiguousSamples) {
      expect(sample.text.trim().length).toBeGreaterThan(0);
      expect(sample.reason.trim().length).toBeGreaterThan(10);
      expect(["et", "ru", "en"]).toContain(sample.expectedFallback);
    }
  });

  it("has no duplicate utterances across all vector groups", () => {
    const all = [...etSamples, ...ruSamples, ...enSamples, ...codeSwitchSamples].map(
      (sample) => sample.text,
    );
    for (const sample of ambiguousSamples) all.push(sample.text);
    expect(new Set(all).size).toBe(all.length);
  });

  it("transcript fixture vectors reference the committed .txt files", () => {
    expect(transcriptFixtures.map((fixture) => fixture.file)).toEqual([
      "fixture-et.txt",
      "fixture-ru.txt",
      "fixture-en.txt",
    ]);
    for (const fixture of transcriptFixtures) {
      expect(["et", "ru", "en"]).toContain(fixture.expected);
    }
  });
});
