/**
 * Post-call structured notes: load the persisted transcript, ask the
 * summarizer LLM for a JSON note, validate it against noteSchema and store
 * it. One corrective retry is made when the model output is invalid; a final
 * failure is recorded as a "note_failed" call event and rethrown (callers —
 * e.g. attachNotesPipeline — are expected to isolate that error).
 */

import type { Kysely } from "kysely";
import type { AppConfig } from "../config/schema.js";
import { getTranscript, insertCallEvent, upsertNote } from "../db/queries.js";
import type { Database } from "../db/schema.js";
import { resolveModel } from "../llm/resolve-model.js";
import type { ChatMessage, ChatOptions } from "../llm/openrouter.js";
import { logger as rootLogger, type Logger } from "../logging.js";
import type { Note } from "./note-schema.js";
import { noteSchema } from "./note-schema.js";

/** Structural LLM client so tests can mock without OpenRouter. */
export interface SummarizerLlm {
  chat(opts: ChatOptions): Promise<string>;
}

export interface SummarizeCallOptions {
  db: Kysely<Database>;
  llm: SummarizerLlm;
  config: AppConfig;
  callId: number;
  logger?: Logger;
}

const NOTE_SYSTEM_PROMPT = `You are a call-notes summarizer for a multilingual support line.
You receive a transcript with "caller:" and "agent:" lines.

Respond with ONLY a JSON object — no prose, no markdown, no code fences — with EXACTLY these fields:

{
  "summary": string,                              // 2-4 sentence neutral summary of the call
  "language": "et" | "ru" | "en",                 // dominant language the CALLER spoke
  "client": string | null,                        // caller's name / company if identifiable, else null
  "intents": string[],                            // what the caller wanted; one entry per distinct intent
  "actions_taken": string[],                      // what the agent did or promised during the call
  "unresolved_issues": string[],                  // issues still open when the call ended
  "follow_ups": string[],                         // agreed next steps (who does what)
  "urgency": "low" | "normal" | "high" | "urgent",// judged from the caller's tone and request
  "sentiment": "positive" | "neutral" | "negative" // the caller's overall tone
}

Rules:
- "language" MUST reflect the dominant CALLER language, not the agent's.
- Judge "urgency" and "sentiment" from the caller's tone and words.
- Arrays may be empty; every string present must be non-empty.
- Output only the JSON object.`;

const MAX_SUMMARY_TOKENS = 800;
const SUMMARY_TEMPERATURE = 0.2;

/**
 * Summarize a finished call into a structured note and persist it.
 * Throws a clear error when the transcript is empty or the model keeps
 * producing invalid output (after recording a "note_failed" call event).
 */
export async function summarizeCall(options: SummarizeCallOptions): Promise<Note> {
  const { db, llm, config, callId } = options;
  const log = options.logger ?? rootLogger;

  const transcript = await getTranscript(db, callId);
  if (transcript.length === 0) {
    throw new Error(`Cannot summarize call ${callId}: transcript is empty`);
  }

  const model = resolveModel(config, "summarizer");
  const baseMessages: ChatMessage[] = [
    { role: "system", content: NOTE_SYSTEM_PROMPT },
    { role: "user", content: renderTranscript(transcript) },
  ];

  const chat = (messages: ChatMessage[]): Promise<string> =>
    llm.chat({ model, messages, temperature: SUMMARY_TEMPERATURE, maxTokens: MAX_SUMMARY_TOKENS });

  let note: Note;
  let firstRaw = "";
  try {
    firstRaw = await chat(baseMessages);
    note = parseNote(firstRaw);
  } catch (firstError) {
    // ONE corrective retry: show the model its own (invalid) output plus what
    // went wrong. Without raw output (the call itself failed) just retry once.
    const retryMessages: ChatMessage[] = [...baseMessages];
    if (firstRaw !== "") retryMessages.push({ role: "assistant", content: firstRaw });
    retryMessages.push({
      role: "user",
      content:
        `Your previous response was invalid: ${errorMessage(firstError)}\n` +
        "Respond again with ONLY the JSON object matching the required schema — " +
        "no prose, no markdown, no code fences.",
    });
    try {
      note = parseNote(await chat(retryMessages));
    } catch (finalError) {
      await recordNoteFailure(db, callId, finalError);
      throw finalError instanceof Error ? finalError : new Error(String(finalError));
    }
  }

  await upsertNote(db, { callId, note, model });
  await insertCallEvent(db, { callId, type: "note_generated", detail: { model } });
  log.info({ callId, model }, "note generated");
  return note;
}

/** Render persisted transcript rows as "caller: ..." / "agent: ..." lines. */
function renderTranscript(transcript: Array<{ speaker: string; text: string }>): string {
  return transcript.map((row) => `${row.speaker}: ${row.text}`).join("\n");
}

/**
 * Parse model output into a Note: strip an optional code fence, locate the
 * JSON object, JSON.parse it and zod-validate against noteSchema.
 */
export function parseNote(raw: string): Note {
  const value = extractJsonObject(raw);
  const parsed = noteSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`model output does not match the note schema: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Extract the first JSON object from raw model output. Tolerates markdown
 * code fences and surrounding prose; throws when no parseable object exists.
 */
export function extractJsonObject(raw: string): unknown {
  let text = raw.trim();
  const fenced = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?\s*```$/.exec(text);
  if (fenced) text = (fenced[1] ?? "").trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("no JSON object found in model output");
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch (err) {
    throw new Error(`model output is not valid JSON: ${errorMessage(err)}`);
  }
}

/** Record a "note_failed" event; never masks the original error. */
async function recordNoteFailure(
  db: Kysely<Database>,
  callId: number,
  err: unknown,
): Promise<void> {
  try {
    await insertCallEvent(db, {
      callId,
      type: "note_failed",
      detail: { error: errorMessage(err) },
    });
  } catch {
    // The rethrown original error is what matters.
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
