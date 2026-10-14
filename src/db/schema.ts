import type { ColumnType } from "kysely";
import type { CallStatus, Language, Speaker } from "../types.js";

/**
 * Column types as stored in Postgres. Generated columns are Insert-only /
 * Select-only via ColumnType's three parameters.
 *
 * Note: pg returns int8 (BIGSERIAL / BIGINT) values as strings at runtime, so
 * the query helpers in queries.ts normalize ids to `number` at the boundary.
 * The same helpers normalize optional columns to `null`.
 */
export type Generated<T> = ColumnType<T, T | undefined, T>;

/** DB-generated timestamp: selected as Date, insertable as Date or string. */
export type Timestamp = ColumnType<Date, Date | string | undefined, Date | string | undefined>;

/** DB-generated nullable timestamp (e.g. ended_at). */
export type NullableTimestamp = ColumnType<
  Date | undefined,
  Date | string | undefined,
  Date | string | undefined
>;

/** Outcome of the spoken consent check, stored in calls.consent. */
export type Consent = "granted" | "declined";

/**
 * calls — one row per telephony call, keyed by the provider's call SID.
 * Column names are snake_case to match the SQL schema directly.
 */
export interface CallsTable {
  id: Generated<number>;
  call_sid: ColumnType<string, string, string>;
  from_number: ColumnType<string, string, string>;
  to_number: ColumnType<string | undefined, string | undefined, string | undefined>;
  provider: Generated<string>;
  language: ColumnType<Language | undefined, Language | undefined, Language | undefined>;
  status: Generated<CallStatus>;
  started_at: Timestamp;
  ended_at: NullableTimestamp;
  duration_s: ColumnType<number | undefined, number | undefined, number | undefined>;
  /** null until the consent flow records a decision. */
  consent: ColumnType<Consent | undefined, Consent | undefined, Consent | undefined>;
  /** DB default false; flipped when the call is handed to a human. */
  escalated: Generated<boolean>;
}

/** call_transcripts — per-utterance transcript rows in call order. */
export interface CallTranscriptsTable {
  id: Generated<number>;
  call_id: ColumnType<number, number, number>;
  speaker: ColumnType<Speaker, Speaker, Speaker>;
  text: ColumnType<string, string, string>;
  language: ColumnType<Language | undefined, Language | undefined, Language | undefined>;
  at_ms: ColumnType<number, number, number>;
  created_at: Timestamp;
}

/** call_notes — one JSONB note per call (upserted; crash-safe). */
export interface CallNotesTable {
  call_id: ColumnType<number, number, number>;
  note: ColumnType<unknown, unknown, unknown>;
  model: ColumnType<string, string, string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** call_events — append-only structured events for debugging/analytics. */
export interface CallEventsTable {
  id: Generated<number>;
  call_id: ColumnType<number, number, number>;
  type: ColumnType<string, string, string>;
  detail: ColumnType<unknown | undefined, unknown | undefined, unknown | undefined>;
  created_at: Timestamp;
}

/** settings — runtime-editable settings documents (key='global'). */
export interface SettingsTable {
  key: ColumnType<string, string, string>;
  value: ColumnType<unknown, unknown, unknown>;
  updated_at: Timestamp;
}

export interface Database {
  calls: CallsTable;
  call_transcripts: CallTranscriptsTable;
  call_notes: CallNotesTable;
  call_events: CallEventsTable;
  settings: SettingsTable;
}
