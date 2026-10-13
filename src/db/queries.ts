import { sql, type Kysely } from "kysely";
import type { CallStatus, Language, Speaker } from "../types.js";
import type { Database } from "./schema.js";

/** Row shape of the calls table (ids/dates normalized to number/Date). */
export interface CallRow {
  id: number;
  callSid: string;
  from: string;
  to: string | null;
  provider: string;
  language: Language | null;
  status: CallStatus;
  startedAt: Date;
  endedAt: Date | null;
  durationS: number | null;
}

/** Row shape of call_transcripts. */
export interface TranscriptRow {
  id: number;
  callId: number;
  speaker: Speaker;
  text: string;
  language: Language | null;
  atMs: number;
}

/** Row shape of call_notes. */
export interface NoteRow {
  callId: number;
  note: unknown;
  model: string;
  createdAt: Date;
  updatedAt: Date;
}

/** calls row joined with a note excerpt for list views. */
export interface CallListItem extends CallRow {
  /** Value of the note JSONB's `summary` field, when present. */
  noteSummary: string | null;
  noteModel: string | null;
}

export interface InsertCallInput {
  callSid: string;
  from: string;
  to?: string;
  provider?: "twilio" | "browser";
}

export interface FinalizeCallInput {
  status: CallStatus;
  durationS?: number;
  language?: Language;
}

export interface InsertUtteranceInput {
  callId: number;
  speaker: Speaker;
  text: string;
  language?: Language;
  atMs: number;
}

export interface UpsertNoteInput {
  callId: number;
  note: unknown;
  model: string;
}

export interface InsertCallEventInput {
  callId: number;
  type: string;
  detail?: unknown;
}

/** Insert a call; on duplicate call_sid returns the existing row's id. */
export async function insertCall(db: Kysely<Database>, input: InsertCallInput): Promise<number> {
  const values = {
    call_sid: input.callSid,
    from_number: input.from,
    to_number: input.to,
    provider: input.provider ?? "twilio",
  };
  const inserted = await db
    .insertInto("calls")
    .values(values)
    .onConflict((oc) => oc.column("call_sid").doNothing())
    .returning("id")
    .executeTakeFirst();
  if (inserted) return Number(inserted.id);

  const existing = await db
    .selectFrom("calls")
    .select("id")
    .where("call_sid", "=", input.callSid)
    .executeTakeFirstOrThrow();
  return Number(existing.id);
}

/** Mark a call finished: status, ended_at, duration and final language. */
export async function finalizeCall(
  db: Kysely<Database>,
  callId: number,
  input: FinalizeCallInput,
): Promise<void> {
  const values: {
    status: CallStatus;
    ended_at: Date;
    duration_s?: number;
    language?: Language;
  } = { status: input.status, ended_at: new Date() };
  if (input.durationS !== undefined) values.duration_s = input.durationS;
  if (input.language !== undefined) values.language = input.language;

  await db.updateTable("calls").set(values).where("id", "=", callId).execute();
}

/** Append one transcript utterance for a call. */
export async function insertUtterance(
  db: Kysely<Database>,
  input: InsertUtteranceInput,
): Promise<number> {
  const inserted = await db
    .insertInto("call_transcripts")
    .values({
      call_id: input.callId,
      speaker: input.speaker,
      text: input.text,
      language: input.language,
      at_ms: input.atMs,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return Number(inserted.id);
}

/** Insert or replace the note for a call (idempotent, crash-safe). */
export async function upsertNote(db: Kysely<Database>, input: UpsertNoteInput): Promise<void> {
  await db
    .insertInto("call_notes")
    .values({
      call_id: input.callId,
      note: input.note,
      model: input.model,
    })
    .onConflict((oc) =>
      oc.column("call_id").doUpdateSet({
        note: input.note,
        model: input.model,
        updated_at: new Date(),
      }),
    )
    .execute();
}

/** Append a structured event for a call. */
export async function insertCallEvent(
  db: Kysely<Database>,
  input: InsertCallEventInput,
): Promise<number> {
  const base = { call_id: input.callId, type: input.type };
  const inserted = await db
    .insertInto("call_events")
    .values(input.detail !== undefined ? { ...base, detail: input.detail } : base)
    .returning("id")
    .executeTakeFirstOrThrow();
  return Number(inserted.id);
}

/** List calls newest first, joined with a note excerpt. */
export async function listCalls(
  db: Kysely<Database>,
  opts: { limit?: number; offset?: number } = {},
): Promise<CallListItem[]> {
  const rows = await db
    .selectFrom("calls as c")
    .leftJoin("call_notes as n", "n.call_id", "c.id")
    .select((eb) => [
      "c.id as id",
      "c.call_sid as call_sid",
      "c.from_number as from_number",
      "c.to_number as to_number",
      "c.provider as provider",
      "c.language as language",
      "c.status as status",
      "c.started_at as started_at",
      "c.ended_at as ended_at",
      "c.duration_s as duration_s",
      sql<string | null>`${eb.ref("n.note")} ->> 'summary'`.as("note_summary"),
      "n.model as note_model",
    ])
    .orderBy("c.started_at", "desc")
    .orderBy("c.id", "desc")
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0)
    .execute();

  return rows.map((r) => ({
    id: Number(r.id),
    callSid: r.call_sid,
    from: r.from_number,
    to: r.to_number ?? null,
    provider: r.provider,
    language: r.language ?? null,
    status: r.status,
    startedAt: new Date(r.started_at),
    endedAt: r.ended_at ? new Date(r.ended_at) : null,
    durationS: r.duration_s ?? null,
    noteSummary: r.note_summary,
    noteModel: r.note_model,
  }));
}

/** Get a call by provider call SID, or null. */
export async function getCallBySid(db: Kysely<Database>, sid: string): Promise<CallRow | null> {
  const r = await db.selectFrom("calls").selectAll().where("call_sid", "=", sid).executeTakeFirst();
  return r ? toCallRow(r) : null;
}

/** Get a call by internal id, or null. */
export async function getCallById(db: Kysely<Database>, id: number): Promise<CallRow | null> {
  const r = await db.selectFrom("calls").selectAll().where("id", "=", id).executeTakeFirst();
  return r ? toCallRow(r) : null;
}

/** Full transcript of a call, ordered by insertion. */
export async function getTranscript(
  db: Kysely<Database>,
  callId: number,
): Promise<TranscriptRow[]> {
  const rows = await db
    .selectFrom("call_transcripts")
    .selectAll()
    .where("call_id", "=", callId)
    .orderBy("id", "asc")
    .execute();
  return rows.map((r) => ({
    id: Number(r.id),
    callId: Number(r.call_id),
    speaker: r.speaker,
    text: r.text,
    language: r.language ?? null,
    atMs: r.at_ms,
  }));
}

/** The note stored for a call, or null. */
export async function getNote(db: Kysely<Database>, callId: number): Promise<NoteRow | null> {
  const r = await db
    .selectFrom("call_notes")
    .selectAll()
    .where("call_id", "=", callId)
    .executeTakeFirst();
  if (!r) return null;
  return {
    callId: Number(r.call_id),
    note: r.note,
    model: r.model,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

function toCallRow(r: {
  id: number | string;
  call_sid: string;
  from_number: string;
  to_number: string | null | undefined;
  provider: string;
  language: Language | null | undefined;
  status: CallStatus;
  started_at: Date;
  ended_at: Date | null | undefined;
  duration_s: number | null | undefined;
}): CallRow {
  return {
    id: Number(r.id),
    callSid: r.call_sid,
    from: r.from_number,
    to: r.to_number ?? null,
    provider: r.provider,
    language: r.language ?? null,
    status: r.status,
    startedAt: new Date(r.started_at),
    endedAt: r.ended_at ? new Date(r.ended_at) : null,
    durationS: r.duration_s ?? null,
  };
}
