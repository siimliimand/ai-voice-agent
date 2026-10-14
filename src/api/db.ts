import type { Kysely } from "kysely";
import {
  countCallsByStatus,
  getCallById,
  getCallBySid,
  getNote,
  getTranscript,
  listCalls,
  type CallListItem,
  type CallRow,
  type NoteRow,
  type TranscriptRow,
} from "../db/queries.js";
import type { Database } from "../db/schema.js";
import type { CallStatus } from "../types.js";

/**
 * Read-side data source of the admin console. The shape mirrors the query
 * functions in ../db/queries.ts (with the Kysely instance pre-bound) so that
 * tests can substitute a plain object of stubs and the server wiring can pass
 * kyselyAdminDb(db) once for both the API and the admin pages.
 */
export interface AdminDb {
  listCalls(opts?: { limit?: number; offset?: number }): Promise<CallListItem[]>;
  getCallById(id: number): Promise<CallRow | null>;
  getCallBySid(sid: string): Promise<CallRow | null>;
  getTranscript(callId: number): Promise<TranscriptRow[]>;
  getNote(callId: number): Promise<NoteRow | null>;
  /** Per-status call counts for GET /api/metrics (DB layer, design D10). */
  countCallsByStatus(): Promise<Record<CallStatus, number>>;
}

/** Bind the read-only admin queries to a Kysely instance. */
export function kyselyAdminDb(db: Kysely<Database>): AdminDb {
  return {
    listCalls: (opts) => listCalls(db, opts),
    getCallById: (id) => getCallById(db, id),
    getCallBySid: (sid) => getCallBySid(db, sid),
    getTranscript: (callId) => getTranscript(db, callId),
    getNote: (callId) => getNote(db, callId),
    countCallsByStatus: () => countCallsByStatus(db),
  };
}
