import { describe, expect, it } from "vitest";
import { SentenceChunker, chunkSentences } from "../../src/tts/sentence.js";

/** Feed a string through the chunker in small streaming tokens. */
function streamText(chunker: SentenceChunker, text: string, size = 7): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(...chunker.feed(text.slice(i, i + size)));
  }
  out.push(...chunker.flush());
  return out;
}

describe("SentenceChunker", () => {
  it("streams multi-sentence text out sentence-by-sentence", () => {
    const chunker = new SentenceChunker(20);
    const text =
      "The quick brown fox jumps over the lazy dog. Another fairly long sentence follows right here! Short tail";
    expect(streamText(chunker, text)).toEqual([
      "The quick brown fox jumps over the lazy dog.",
      "Another fairly long sentence follows right here!",
      "Short tail",
    ]);
  });

  it("holds short sentences until the combined text exceeds the minimum length", () => {
    const chunker = new SentenceChunker(40);
    expect(chunker.feed("Hi! ")).toEqual([]);
    expect(chunker.feed("How are you today? ")).toEqual([]);
    expect(chunker.flush()).toEqual(["Hi! How are you today?"]);
  });

  it("releases merged sentences as soon as the minimum length is reached", () => {
    const chunker = new SentenceChunker(20);
    expect(chunker.feed("Hi! ")).toEqual([]);
    expect(chunker.feed("That is wonderful news, thank you so much. ")).toEqual([
      "Hi! That is wonderful news, thank you so much.",
    ]);
    expect(chunker.flush()).toEqual([]);
  });

  it("flushes a short trailing fragment without a terminator on end()", () => {
    const chunker = new SentenceChunker(10);
    expect(chunker.feed("This sentence is long enough. ")).toEqual([
      "This sentence is long enough.",
    ]);
    expect(chunker.feed("tail fragment")).toEqual([]);
    expect(chunker.flush()).toEqual(["tail fragment"]);
  });

  it("splits on newlines, question marks and ellipses", () => {
    expect(chunkSentences("First line\nWhat is next? Well... done", 8)).toEqual([
      "First line",
      "What is next?",
      "Well... done",
    ]);
  });

  it("keeps closing quotes attached to their sentence", () => {
    expect(chunkSentences('He said "Go away!" and left the room quickly.', 10)).toEqual([
      'He said "Go away!" and left the room quickly.',
    ]);
  });

  it("releases the buffer via the safety valve when boundaries are suppressed", () => {
    const chunker = new SentenceChunker(10);
    const unclosed = `He said "and then kept talking without any terminator for a very long time ${"x".repeat(600)}`;
    const out = streamText(chunker, unclosed, 100);
    expect(out.length).toBeGreaterThan(0);
    // Nothing beyond the safety valve is left buffered.
    expect(chunker.flush().join("").length).toBeLessThan(500);
  });

  it("returns nothing for empty input", () => {
    const chunker = new SentenceChunker();
    expect(chunker.feed("")).toEqual([]);
    expect(chunker.flush()).toEqual([]);
    expect(chunkSentences("   ")).toEqual([]);
  });
});
