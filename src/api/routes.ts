import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config/schema.js";
import type { CallListItem, CallRow, NoteRow, TranscriptRow } from "../db/queries.js";
import type {
  ErrorCategory,
  LatencyStage,
  LatencyStageSnapshot,
  MetricsRegistry,
} from "../observability/metrics.js";
import type { CallStatus } from "../types.js";
import { basicAuthScope } from "../auth/basic-auth.js";
import type { AdminDb } from "./db.js";

export interface AdminApiDeps {
  db: AdminDb;
  config: AppConfig;
  /**
   * Process-local metrics registry (design D10). Wired by buildApp; when
   * absent, GET /api/metrics degrades to 503 instead of failing.
   */
  metrics?: MetricsRegistry;
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
  /** null | "granted" | "declined" (design D8). */
  consent: string | null;
  escalated: boolean;
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
  /** null | "granted" | "declined" (design D8). */
  consent: string | null;
  escalated: boolean;
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
 * The exact JSON body of GET /api/metrics (task 7.2, design D10): the
 * process-local MetricsSnapshot plus the DB-backed status counts. Keys:
 *
 * - `since` — registry boot time, ISO-8601 UTC, verbatim. Process counters
 *   and latency rings reset on restart; `since` makes that explicit.
 * - `latency` — per stage (stt_finalize | llm_first_token | tts_first_byte |
 *   end_to_end) the sample-ring view `{count, p50, p95}` in milliseconds;
 *   `p50`/`p95` are `null` while a stage has no samples (nearest-rank).
 * - `callsByStatus` — PROCESS counters since boot. `in_progress` is a
 *   started-calls counter (never decremented on end); finals accumulate
 *   under `completed`/`failed`.
 * - `callsByStatusDb` — DB layer, `SELECT status, count(*) … GROUP BY` over
 *   the calls table. Authoritative for final status counts (survives
 *   restarts); its `in_progress` counts rows still open in the database.
 * - `activeSessions` — live gauge of non-finalized sessions (the process
 *   `callsByStatus.in_progress` is a counter, NOT live-ness — use this).
 * - `errors` — process error counters by category (pipeline | llm | stream |
 *   skill) since boot.
 * - `counters` — process generic named counters since boot (starts empty).
 * - `process.since` — echo of `since`, for scrapers that read only this key.
 */
export interface MetricsResponseDto {
  since: string;
  latency: Record<LatencyStage, LatencyStageSnapshot>;
  callsByStatus: Record<CallStatus, number>;
  callsByStatusDb: Record<CallStatus, number>;
  activeSessions: number;
  errors: Record<ErrorCategory, number>;
  counters: Record<string, number>;
  process: { since: string };
}

/**
 * Admin JSON API: GET /api/calls (paginated, newest first),
 * GET /api/calls/:id (call + transcript + note) and GET /api/metrics
 * (process metrics + DB-backed status counts). All require basic auth.
 */
export function registerAdminApi(app: FastifyInstance, deps: AdminApiDeps): void {
  basicAuthScope(app, "/api", (api) => {
    api.get("/metrics", async (_req, reply) => {
      // Should not happen via buildApp (the registry is always constructed),
      // but the route must degrade, not 500 (same posture as the disabled
      // admin console / the fail-closed TwiML 503).
      const { metrics } = deps;
      if (!metrics) {
        return reply.code(503).send({ error: "metrics registry is not available" });
      }
      const snapshot = metrics.snapshot();
      const body: MetricsResponseDto = {
        since: snapshot.since,
        latency: snapshot.latency,
        callsByStatus: snapshot.callsByStatus,
        // DB layer (D10): authoritative per-status counts over all persisted
        // calls; survives restarts unlike the process counters.
        callsByStatusDb: await deps.db.countCallsByStatus(),
        activeSessions: snapshot.activeSessions,
        errors: snapshot.errors,
        counters: snapshot.counters,
        process: { since: snapshot.since },
      };
      return reply.send(body);
    });

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
    consent: row.consent,
    escalated: row.escalated,
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
    consent: row.consent,
    escalated: row.escalated,
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
