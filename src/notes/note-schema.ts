/**
 * Zod schema for the structured post-call note stored in call_notes (JSONB).
 * The summarizer LLM is asked to emit exactly this shape; the schema is the
 * source of truth for both validation and the prompt in summarizer.ts.
 */
import { z } from "zod";

export const noteSchema = z.object({
  /** 2-4 sentence neutral summary of the call. */
  summary: z.string().min(1),
  /** Dominant language the CALLER spoke. */
  language: z.enum(["et", "ru", "en"]),
  /** Caller name / company when identifiable, else null. */
  client: z.string().nullable(),
  /** What the caller wanted; one entry per distinct intent. */
  intents: z.array(z.string()),
  /** What the agent did or promised during the call. */
  actions_taken: z.array(z.string()),
  /** Issues still open when the call ended. */
  unresolved_issues: z.array(z.string()),
  /** Agreed next steps (who does what). */
  follow_ups: z.array(z.string()),
  /** Judged from the caller's tone and the content of the request. */
  urgency: z.enum(["low", "normal", "high", "urgent"]),
  /** Caller's overall tone. */
  sentiment: z.enum(["positive", "neutral", "negative"]),
});

/** Validated structured note, as stored in call_notes.note. */
export type Note = z.infer<typeof noteSchema>;
