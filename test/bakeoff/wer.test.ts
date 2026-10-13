import { describe, expect, it } from "vitest";
import { normalizedTokens, wer, werDetail } from "../../scripts/bakeoff/wer.js";

describe("normalizedTokens", () => {
  it("lowercases, strips punctuation and collapses whitespace", () => {
    expect(normalizedTokens("  Hello,   WORLD! ")).toEqual(["hello", "world"]);
    expect(normalizedTokens("It's fine; really---ok?")).toEqual(["it's", "fine", "really", "ok"]);
    expect(normalizedTokens("...")).toEqual([]);
    expect(normalizedTokens("")).toEqual([]);
  });

  it("keeps accented Cyrillic and Estonian letters", () => {
    expect(normalizedTokens("Tere, mul on KÜSIMUS arve kohta!")).toEqual([
      "tere",
      "mul",
      "on",
      "küsimus",
      "arve",
      "kohta",
    ]);
    expect(normalizedTokens("Здравствуйте, у меня вопрос.")).toEqual([
      "здравствуйте",
      "у",
      "меня",
      "вопрос",
    ]);
  });
});

describe("wer", () => {
  it("is 0 for identical text (even with differing punctuation/case)", () => {
    expect(wer("the cat sat on the mat", "The cat sat on the mat.")).toBe(0);
  });

  it("is 0 for empty reference and hypothesis", () => {
    expect(wer("", "")).toBe(0);
    expect(wer([], [])).toBe(0);
  });

  it("counts pure insertions", () => {
    // ref = 2 tokens, 1 inserted → 1/2
    expect(wer("the cat", "the big cat")).toBeCloseTo(1 / 2, 10);
  });

  it("counts pure deletions", () => {
    // ref = 3 tokens, 1 deleted → 1/3
    expect(wer("the cat sat", "the sat")).toBeCloseTo(1 / 3, 10);
  });

  it("counts pure substitutions", () => {
    // ref = 2 tokens, 1 substituted → 1/2
    expect(wer("the cat", "the hat")).toBeCloseTo(1 / 2, 10);
  });

  it("handles a hypothesis much longer than the reference", () => {
    expect(wer("hello", "hello there now friend")).toBeCloseTo(3, 10);
  });

  it("scores 1 (100%) when the reference is empty but the hypothesis is not", () => {
    expect(wer("", "hello world")).toBe(1);
  });

  it("accepts pre-normalized token arrays", () => {
    expect(wer(["a", "b"], ["a", "b"])).toBe(0);
    expect(wer(["a", "b"], ["a"])).toBeCloseTo(1 / 2, 10);
  });

  it("is symmetric-ish on transpositions (counts them as sub+del or sub+ins)", () => {
    // "ab" vs "ba": classic WER = 2 edits / 2 ref tokens
    expect(wer("ab ba", "ba ab")).toBeCloseTo(2 / 2, 10);
  });
});

describe("werDetail", () => {
  it("returns exact edit counts for a mixed case", () => {
    // ref: the cat sat on the mat (6)
    // hyp: the hat sat on mat  (5) → 1 substitution + 1 deletion
    const detail = werDetail("the cat sat on the mat", "the hat sat on mat");
    expect(detail.wer).toBeCloseTo(2 / 6, 10);
    expect(detail.substitutions).toBe(1);
    expect(detail.deletions).toBe(1);
    expect(detail.insertions).toBe(0);
    expect(detail.refTokens).toEqual(["the", "cat", "sat", "on", "the", "mat"]);
  });

  it("returns exact counts for a pure insertion", () => {
    const detail = werDetail("the cat", "the big fat cat");
    expect(detail.wer).toBeCloseTo(2 / 2, 10);
    expect(detail.insertions).toBe(2);
    expect(detail.deletions).toBe(0);
    expect(detail.substitutions).toBe(0);
  });

  it("returns zero counts for identical input", () => {
    const detail = werDetail("tere hommikust", "tere hommikust");
    expect(detail).toEqual({
      wer: 0,
      insertions: 0,
      deletions: 0,
      substitutions: 0,
      refTokens: ["tere", "hommikust"],
    });
  });
});
