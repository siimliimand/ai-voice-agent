/** Default minimum length before a completed sentence is released to TTS. */
export const DEFAULT_MIN_SENTENCE_LENGTH = 40;

/**
 * Safety valve: if formatting (e.g. an unclosed quote) suppresses every
 * boundary, release the buffered text once it exceeds this length instead of
 * delaying all audio until flush().
 */
const MAX_BUFFER_CHARS = 500;

/** Characters that terminate a sentence. */
const SENTENCE_TERMINATORS: ReadonlySet<string> = new Set([".", "!", "?", "…"]);
/** Hard separators: newlines always end the current sentence. */
const NEWLINES: ReadonlySet<string> = new Set(["\n", "\r"]);
/** Characters that may directly follow a terminator and stay inside the sentence (e.g. `!"`). */
const CLOSING_QUOTES: ReadonlySet<string> = new Set(['"', "'", "”", "’", ")", "]", "}", "»"]);

/**
 * Buffers streaming text and releases complete sentences once they exceed a
 * minimum length, so TTS starts early without chattering on short fragments.
 * Sentences shorter than the minimum are merged into the following one.
 *
 * Terminators inside an open double quote ("Go away!") do not split, so
 * quoted exclamations stay in their sentence.
 */
export class SentenceChunker {
  private buffer = "";
  /** Accumulated short sentences, waiting to be merged into a longer one. */
  private pending = "";

  constructor(private readonly minLength: number = DEFAULT_MIN_SENTENCE_LENGTH) {}

  /** Feed the next text token; returns every sentence completed by it. */
  feed(token: string): string[] {
    if (token.length > 0) this.buffer += token;
    const out = this.drain();

    if (this.buffer.length > MAX_BUFFER_CHARS) {
      const candidate = this.buffer.trim();
      this.buffer = "";
      if (candidate.length > 0) {
        const merged = this.pending.length > 0 ? `${this.pending} ${candidate}` : candidate;
        if (merged.length >= this.minLength) out.push(merged);
        else this.pending = merged;
      }
    }
    return out;
  }

  /** Signal end of text; releases any held-back remainder. */
  flush(): string[] {
    const out = this.drain();
    const remainder = [this.pending.trim(), this.buffer.trim()]
      .filter((part) => part.length > 0)
      .join(" ");
    this.pending = "";
    this.buffer = "";
    if (remainder.length > 0) out.push(remainder);
    return out;
  }

  /** Scan the buffer for sentence boundaries and apply the min-length policy. */
  private drain(): string[] {
    const out: string[] = [];
    let scan = 0;
    let boundary = 0; // start of the current candidate sentence
    let inDoubleQuote = false;

    while (scan < this.buffer.length) {
      const ch = this.buffer[scan];
      if (ch === undefined) break;

      // Track double-quote spans; terminators inside them are not boundaries.
      if (ch === '"') {
        inDoubleQuote = !inDoubleQuote;
        scan += 1;
        continue;
      }
      if (ch === "“") {
        inDoubleQuote = true;
        scan += 1;
        continue;
      }
      if (ch === "”") {
        inDoubleQuote = false;
        scan += 1;
        continue;
      }

      const isBreak = !inDoubleQuote && (SENTENCE_TERMINATORS.has(ch) || NEWLINES.has(ch));
      if (!isBreak) {
        scan += 1;
        continue;
      }
      // Absorb the whole boundary run: "?!", '."', "\r\n", '”' etc.
      let end = scan + 1;
      while (end < this.buffer.length) {
        const next = this.buffer[end];
        if (next === undefined) break;
        if (!SENTENCE_TERMINATORS.has(next) && !CLOSING_QUOTES.has(next) && !NEWLINES.has(next))
          break;
        end += 1;
      }
      const candidate = this.buffer.slice(boundary, end).trim();
      boundary = end;
      scan = end;
      if (candidate.length === 0) continue;

      const merged = this.pending.length > 0 ? `${this.pending} ${candidate}` : candidate;
      if (merged.length >= this.minLength) {
        out.push(merged);
        this.pending = "";
      } else {
        this.pending = merged;
      }
    }

    this.buffer = this.buffer.slice(boundary);
    return out;
  }
}

/** Split a whole string into sentences with the same min-length policy. */
export function chunkSentences(
  text: string,
  minLength: number = DEFAULT_MIN_SENTENCE_LENGTH,
): string[] {
  const chunker = new SentenceChunker(minLength);
  return [...chunker.feed(text), ...chunker.flush()];
}
