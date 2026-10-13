import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config/schema.js";
import type { CallListItem, CallRow, NoteRow, TranscriptRow } from "../db/queries.js";
import { basicAuthScope } from "../auth/basic-auth.js";
import type { AdminDb } from "./db.js";

export interface AdminApiDeps {
  db: AdminDb;
  config: AppConfig;
}

/** Default page size of GET /api/calls. */
export const DEFAULT_CALLS_LIMIT = 50;
/** Hard upper bound for the `limit` query parameter. */
export const MAX_CALLS_LIMIT = 200;

/** One row of GET /api/calls. */
export interface CallListItemDto {
  id: number;
  callSid: string;
  fromNumber: string;
  toNumber: string | null;
  language: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationS: number | null;
  noteExcerpt: string | null;
}

/** The `call` object of GET /api/calls/:id (no note excerpt, with provider). */
export interface CallDto {
  id: number;
  callSid: string;
  fromNumber: string;
  toNumber: string | null;
  provider: string;
  language: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationS: number | null;
}

export interface TranscriptEntryDto {
  id: number;
  speaker: string;
  text: string;
  language: string | null;
  atMs: number;
  /** getTranscript does not select created_at; always null for now. */
  createdAt: string | null;
}

export interface NoteDto {
  model: string;
  createdAt: string;
  updatedAt: string;
  /** Raw structured note JSON as stored (open shape; see src/notes). */
  note: unknown;
}

/**
 * Admin JSON API: GET /api/calls (paginated, newest first) and
 * GET /api/calls/:id (call + transcript + note). Both require basic auth.
 */
export function registerAdminApi(app: FastifyInstance, deps: AdminApiDeps): void {
  basicAuthScope(app, "/api", (api) => {
    api.get("/calls", async (req, reply) => {
      const query = req.query as Record<string, string | undefined>;
      const limit = clampInt(query.limit, {
        min: 1,
        max: MAX_CALLS_LIMIT,
        fallback: DEFAULT_CALLS_LIMIT,
      });
      const offset = clampInt(query.offset, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });

      const rows = await deps.db.listCalls({ limit, offset });
      // The query layer exposes no full COUNT; `total` is the number of rows
      // known through the end of this page.
      return reply.send({
        calls: rows.map(toListItemDto),
        total: offset + rows.length,
      });
    });

    api.get("/calls/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!isCallId(id)) {
        return reply.code(400).send({ error: "call id must be a positive integer" });
      }
      const callId = Number(id);
      const call = await deps.db.getCallById(callId);
      if (!call) return reply.code(404).send({ error: "call not found" });

      const [transcriptRows, noteRow] = await Promise.all([
        deps.db.getTranscript(callId),
        deps.db.getNote(callId),
      ]);
      return reply.send({
        call: toCallDto(call),
        transcript: transcriptRows.map(toTranscriptDto),
        note: noteRow ? toNoteDto(noteRow) : null,
      });
    });
  });
}

/** Strict positive decimal-integer check for :id route params. */
function isCallId(raw: string): boolean {
  return /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) >= 1;
}

function clampInt(
  raw: string | undefined,
  opts: { min: number; max: number; fallback: number },
): number {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(n)) return opts.fallback;
  return Math.min(opts.max, Math.max(opts.min, Math.trunc(n)));
}

function toListItemDto(row: CallListItem): CallListItemDto {
  return {
    id: row.id,
    callSid: row.callSid,
    fromNumber: row.from,
    toNumber: row.to,
    language: row.language,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    durationS: row.durationS,
    noteExcerpt: row.noteSummary,
  };
}

function toCallDto(row: CallRow): CallDto {
  return {
    id: row.id,
    callSid: row.callSid,
    fromNumber: row.from,
    toNumber: row.to,
    provider: row.provider,
    language: row.language,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    durationS: row.durationS,
  };
}

function toTranscriptDto(row: TranscriptRow): TranscriptEntryDto {
  return {
    id: row.id,
    speaker: row.speaker,
    text: row.text,
    language: row.language,
    atMs: row.atMs,
    createdAt: null,
  };
}

function toNoteDto(row: NoteRow): NoteDto {
  return {
    model: row.model,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    note: row.note,
  };
}
