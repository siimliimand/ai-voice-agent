/**
 * Word Error Rate (WER) scoring for the STT bake-off.
 *
 * WER = (substitutions + insertions + deletions) / reference token count,
 * computed with Levenshtein alignment over normalized token arrays.
 */

/** Reference/hypothesis accepted as raw text or pre-normalized tokens. */
export type WerInput = string | readonly string[];

export interface WerDetail {
  /** Edits / reference tokens (0 when both sides are empty; 1 when only the reference is empty). */
  wer: number;
  insertions: number;
  deletions: number;
  substitutions: number;
  refTokens: string[];
}

/**
 * Normalize text into comparison tokens: lowercase, strip punctuation
 * (keeping letters/digits/apostrophes, Unicode-aware), collapse whitespace.
 */
export function normalizedTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "");
}

function toTokens(input: WerInput): string[] {
  return typeof input === "string" ? normalizedTokens(input) : [...input];
}

/** WER between a reference and a hypothesis (see werDetail). */
export function wer(reference: WerInput, hypothesis: WerInput): number {
  return werDetail(reference, hypothesis).wer;
}

/**
 * WER plus the raw edit counts and the normalized reference tokens.
 * Alignment is a standard Levenshtein backtrace; ties prefer substitutions
 * (matching classic edit-distance WER implementations).
 */
export function werDetail(reference: WerInput, hypothesis: WerInput): WerDetail {
  const ref = toTokens(reference);
  const hyp = toTokens(hypothesis);

  const ops = alignOperations(ref, hyp);
  let substitutions = 0;
  let insertions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op === "sub") substitutions++;
    else if (op === "ins") insertions++;
    else if (op === "del") deletions++;
  }

  const edits = substitutions + insertions + deletions;
  let score: number;
  if (ref.length === 0) {
    score = edits === 0 ? 0 : 1;
  } else {
    score = edits / ref.length;
  }
  return { wer: score, insertions, deletions, substitutions, refTokens: ref };
}

type EditOperation = "equal" | "sub" | "ins" | "del";

/** Levenshtein alignment of two token arrays as a sequence of operations. */
function alignOperations(ref: readonly string[], hyp: readonly string[]): EditOperation[] {
  const rows = ref.length + 1;
  const cols = hyp.length + 1;

  // distances[i][j] = edit distance between ref[0..i) and hyp[0..j)
  const distances: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 1; i < rows; i++) distances[i]![0] = i;
  for (let j = 1; j < cols; j++) distances[0]![j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      distances[i]![j] = Math.min(
        distances[i - 1]![j]! + 1, // deletion
        distances[i]![j - 1]! + 1, // insertion
        distances[i - 1]![j - 1]! + cost, // substitution / match
      );
    }
  }

  // Backtrace from (ref.length, hyp.length) to (0, 0).
  const ops: EditOperation[] = [];
  let i = ref.length;
  let j = hyp.length;
  while (i > 0 || j > 0) {
    if (
      i > 0 &&
      j > 0 &&
      distances[i]![j] === distances[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1)
    ) {
      ops.push(ref[i - 1] === hyp[j - 1] ? "equal" : "sub");
      i--;
      j--;
    } else if (i > 0 && distances[i]![j] === distances[i - 1]![j]! + 1) {
      ops.push("del");
      i--;
    } else {
      ops.push("ins");
      j--;
    }
  }
  return ops.reverse();
}
