import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config/schema.js";
import type { CallListItem, NoteRow, TranscriptRow } from "../../db/queries.js";
import { basicAuthScope } from "../../auth/basic-auth.js";
import type { AdminDb } from "../../api/db.js";

export interface AdminPageDeps {
  db: AdminDb;
  config: AppConfig;
}

/** Max characters of the note summary shown in the list view. */
export const NOTE_EXCERPT_MAX = 120;
/** Rows shown on the /admin list page. */
const LIST_PAGE_LIMIT = 100;

const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape any interpolated value for safe use in HTML text and attributes. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch] ?? ch);
}

/**
 * Server-rendered admin console (no frontend framework):
 *   GET /admin           — call list, newest first
 *   GET /admin/calls/:id — call detail with transcript + structured note
 * Both scopes require basic auth; unknown call ids render a 404 page.
 */
export function registerAdminPages(app: FastifyInstance, deps: AdminPageDeps): void {
  basicAuthScope(app, "/admin", (scope) => {
    scope.get("/", async (_req, reply) => {
      const rows = await deps.db.listCalls({ limit: LIST_PAGE_LIMIT, offset: 0 });
      return reply.type("text/html; charset=utf-8").send(renderPage("Calls", renderList(rows)));
    });

    scope.get("/calls/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const callId = Number(id);
      const html =
        /^\d+$/.test(id) && Number.isSafeInteger(callId) && callId >= 1
          ? await renderDetail(deps.db, callId)
          : null;
      if (html === null) {
        return reply
          .code(404)
          .type("text/html; charset=utf-8")
          .send(renderPage("Not found", renderNotFound(id)));
      }
      return reply.type("text/html; charset=utf-8").send(html);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Call list                                                           */
/* ------------------------------------------------------------------ */

function renderList(rows: CallListItem[]): string {
  if (rows.length === 0) {
    return `<div class="empty"><p><strong>No calls yet.</strong></p><p>Calls appear here as soon as the first caller hangs up.</p></div>`;
  }
  const body = rows
    .map((row) => {
      const href = `/admin/calls/${row.id}`;
      const link = (content: string) => `<a href="${escapeHtml(href)}">${content}</a>`;
      const started = formatDate(row.startedAt);
      return `<tr class="row">
  <td>${link(`<span class="dt" title="${escapeHtml(started.iso)}">${escapeHtml(started.text)}</span>`)}</td>
  <td>${link(escapeHtml(row.from))}</td>
  <td>${link(escapeHtml(row.language ?? "—"))}</td>
  <td>${link(escapeHtml(formatDuration(row.durationS)))}</td>
  <td>${link(statusBadge(row.status))}</td>
  <td class="excerpt">${link(escapeHtml(truncate(row.noteSummary)))}</td>
</tr>`;
    })
    .join("\n");
  return `<table>
  <thead>
    <tr><th>Time</th><th>Caller</th><th>Language</th><th>Duration</th><th>Status</th><th>Note</th></tr>
  </thead>
  <tbody>
${body}
  </tbody>
</table>`;
}

/* ------------------------------------------------------------------ */
/* Call detail                                                         */
/* ------------------------------------------------------------------ */

async function renderDetail(db: AdminDb, callId: number): Promise<string | null> {
  const call = await db.getCallById(callId);
  if (!call) return null;
  const [transcript, noteRow] = await Promise.all([db.getTranscript(callId), db.getNote(callId)]);

  const started = formatDate(call.startedAt);
  const ended = call.endedAt ? formatDate(call.endedAt) : null;
  const meta = `<dl class="meta">
  <dt>Caller</dt><dd>${escapeHtml(call.from)}</dd>
  <dt>Destination</dt><dd>${escapeHtml(call.to ?? "—")}</dd>
  <dt>Provider</dt><dd>${escapeHtml(call.provider)}</dd>
  <dt>Status</dt><dd>${statusBadge(call.status)}</dd>
  <dt>Language</dt><dd>${escapeHtml(call.language ?? "—")}</dd>
  <dt>Started</dt><dd><span title="${escapeHtml(started.iso)}">${escapeHtml(started.text)}</span></dd>
  <dt>Ended</dt><dd>${ended ? `<span title="${escapeHtml(ended.iso)}">${escapeHtml(ended.text)}</span>` : "—"}</dd>
  <dt>Duration</dt><dd>${escapeHtml(formatDuration(call.durationS))}</dd>
</dl>`;

  const transcriptHtml =
    transcript.length === 0
      ? `<div class="empty">No transcript recorded for this call.</div>`
      : `<ol class="transcript">
${transcript.map(renderTranscriptEntry).join("\n")}
</ol>`;

  return `${meta}
<h2 class="section-title">Transcript</h2>
${transcriptHtml}
${renderNote(callId, noteRow)}`;
}

function renderTranscriptEntry(entry: TranscriptRow): string {
  const speaker = entry.speaker === "agent" ? "Agent" : "Caller";
  const lang = entry.language ? ` <span class="lang">(${escapeHtml(entry.language)})</span>` : "";
  return `<li class="${escapeHtml(entry.speaker)}">
  <span class="speaker ${escapeHtml(entry.speaker)}">${escapeHtml(speaker)}</span>
  <span class="ts" title="at ${escapeHtml(entry.atMs)} ms">${escapeHtml(formatAtMs(entry.atMs))}</span>${lang}
  <div class="text">${escapeHtml(entry.text)}</div>
</li>`;
}

/* ------------------------------------------------------------------ */
/* Structured note                                                     */
/* ------------------------------------------------------------------ */

interface NoteView {
  summary: string | null;
  client: string | null;
  intents: string[];
  actionsTaken: string[];
  unresolvedIssues: string[];
  followUps: string[];
  urgency: string | null;
  sentiment: string | null;
}

/**
 * Defensively normalize the stored note JSONB into the known display shape.
 * Accepts camelCase or snake_case keys; anything missing stays empty.
 */
function toNoteView(raw: unknown): NoteView {
  const obj =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    summary: firstString(obj, ["summary"]),
    client: firstString(obj, ["client", "client_name", "clientName"]),
    intents: firstList(obj, ["intents"]),
    actionsTaken: firstList(obj, ["actions_taken", "actionsTaken", "actions"]),
    unresolvedIssues: firstList(obj, ["unresolved_issues", "unresolvedIssues", "unresolved"]),
    followUps: firstList(obj, ["follow_ups", "followUps", "followups", "follow_up", "followUp"]),
    urgency: firstString(obj, ["urgency"]),
    sentiment: firstString(obj, ["sentiment"]),
  };
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

function firstList(obj: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) {
      return value.map((v) => String(v)).filter((v) => v.trim() !== "");
    }
    if (typeof value === "string" && value.trim() !== "") return [value];
  }
  return [];
}

function renderNote(callId: number, noteRow: NoteRow | null): string {
  if (!noteRow) {
    return `<section class="note empty">
  <h2>Note</h2>
  <p>No note yet — the note is generated after the call ends (call #${callId}).</p>
</section>`;
  }
  const note = toNoteView(noteRow.note);
  const generated = `Generated by ${escapeHtml(noteRow.model)} · updated ${escapeHtml(formatDate(noteRow.updatedAt).text)}`;

  const isEmpty =
    note.summary === null &&
    note.client === null &&
    note.intents.length === 0 &&
    note.actionsTaken.length === 0 &&
    note.unresolvedIssues.length === 0 &&
    note.followUps.length === 0 &&
    note.urgency === null &&
    note.sentiment === null;

  const body = isEmpty
    ? `<p class="muted">The stored note has no readable content.</p>`
    : `${section("Summary", note.summary ? `<p>${escapeHtml(note.summary)}</p>` : null)}
${section("Client", note.client ? `<p>${escapeHtml(note.client)}</p>` : null)}
${section("Intents", listHtml(note.intents))}
${section("Actions taken", listHtml(note.actionsTaken))}
${section("Unresolved issues", listHtml(note.unresolvedIssues))}
${section("Follow-ups", listHtml(note.followUps))}
${section("Urgency", note.urgency ? pillHtml(note.urgency) : null)}
${section("Sentiment", note.sentiment ? pillHtml(note.sentiment) : null)}`;

  return `<section class="note">
  <h2>Note</h2>
  <p class="muted">${generated}</p>
${body}
</section>`;
}

function section(title: string, content: string | null): string {
  if (content === null) return "";
  return `<h3>${escapeHtml(title)}</h3>
${content}`;
}

function listHtml(items: string[]): string | null {
  if (items.length === 0) return null;
  return `<ul>
${items.map((item) => `  <li>${escapeHtml(item)}</li>`).join("\n")}
</ul>`;
}

function pillHtml(value: string): string {
  return `<p><span class="pill">${escapeHtml(value)}</span></p>`;
}

/* ------------------------------------------------------------------ */
/* Shared snippets + formatting helpers                                */
/* ------------------------------------------------------------------ */

function renderNotFound(id: string): string {
  return `<div class="empty">
  <h1>404</h1>
  <p>Call <code>${escapeHtml(id)}</code> was not found.</p>
  <p><a href="/admin">&larr; Back to the call list</a></p>
</div>`;
}

function statusBadge(status: string): string {
  const label = status.replaceAll("_", " ");
  return `<span class="badge badge-${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

/** Truncate a note summary to NOTE_EXCERPT_MAX characters ("…" included). */
export function truncate(value: string | null, max: number = NOTE_EXCERPT_MAX): string {
  if (!value) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function formatDate(date: Date): { text: string; iso: string } {
  const iso = date.toISOString();
  return { text: `${iso.slice(0, 16).replace("T", " ")} UTC`, iso };
}

/** Seconds as m:ss (e.g. 150 → "2:30"). */
function formatDuration(durationS: number | null): string {
  if (durationS === null || !Number.isFinite(durationS)) return "—";
  const total = Math.max(0, Math.round(durationS));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Milliseconds into the call as m:ss (e.g. 90_000 → "1:30"). */
function formatAtMs(atMs: number): string {
  const total = Math.max(0, Math.floor(atMs / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Voice Agent Admin</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f6f7f9; color: #1c2733;
         font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  h1 .sub { color: #5b6b7b; font-weight: 400; font-size: .95rem; }
  .topnav { font-size: .88rem; margin: 0 0 14px; }
  .section-title { font-size: 1.1rem; margin: 28px 0 10px; }
  .muted { color: #5b6b7b; font-size: .88rem; }
  a { color: #2563eb; }
  table { width: 100%; border-collapse: collapse; background: #fff;
          border: 1px solid #e2e7ec; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #eef1f4;
           font-size: .92rem; vertical-align: top; }
  th { background: #f0f3f6; font-size: .74rem; text-transform: uppercase;
       letter-spacing: .05em; color: #52616f; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr.row:hover { background: #f8fafc; }
  tr.row a { display: block; color: inherit; text-decoration: none; }
  td.excerpt { color: #52616f; max-width: 300px; }
  .dt { white-space: nowrap; }
  .badge { display: inline-block; padding: 2px 9px; border-radius: 999px;
           font-size: .74rem; font-weight: 600; white-space: nowrap; }
  .badge-completed { background: #e3f5e9; color: #1c7c3d; }
  .badge-in_progress { background: #fdf2d7; color: #8a6116; }
  .badge-failed { background: #fde5e5; color: #b02a2a; }
  .empty { background: #fff; border: 1px dashed #cbd5de; border-radius: 8px;
           padding: 28px; text-align: center; color: #52616f; margin: 16px 0; }
  .empty h1 { color: #b02a2a; }
  .meta { background: #fff; border: 1px solid #e2e7ec; border-radius: 8px;
          padding: 14px 18px; margin: 14px 0 0; }
  .meta { display: grid; grid-template-columns: max-content 1fr; column-gap: 16px; }
  .meta dt { font-size: .72rem; text-transform: uppercase; letter-spacing: .05em;
             color: #52616f; align-self: center; }
  .meta dd { margin: 7px 0; font-size: .95rem; }
  ol.transcript { list-style: none; margin: 0; padding: 0; }
  ol.transcript li { background: #fff; border: 1px solid #e2e7ec; border-radius: 8px;
                     padding: 10px 14px; margin-bottom: 10px; }
  ol.transcript li.caller { border-left: 3px solid #94a3b8; }
  ol.transcript li.agent { border-left: 3px solid #2563eb; }
  .speaker { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
  .speaker.caller { color: #64748b; }
  .speaker.agent { color: #2563eb; }
  .ts { color: #94a3b8; font-size: .78rem; margin-left: 8px; }
  .lang { color: #94a3b8; font-size: .78rem; margin-left: 8px; }
  ol.transcript .text { margin-top: 4px; white-space: pre-wrap; }
  section.note { background: #fff; border: 1px solid #e2e7ec; border-radius: 8px;
                 padding: 16px 20px; margin-top: 28px; }
  section.note h2 { font-size: 1.05rem; margin: 0; }
  section.note h3 { font-size: .74rem; text-transform: uppercase; letter-spacing: .05em;
                    color: #52616f; margin: 16px 0 4px; }
  section.note h2 + p { margin: 4px 0 0; }
  section.note p { margin: 4px 0; white-space: pre-wrap; }
  section.note ul { margin: 4px 0; padding-left: 20px; }
  .pill { display: inline-block; background: #eef2f6; border-radius: 999px;
          padding: 2px 10px; font-size: .8rem; }
</style>
</head>
<body>
<main>
<h1>Voice Agent Admin <span class="sub">· ${escapeHtml(title)}</span></h1>
<p class="topnav"><a href="/admin">Calls</a> · <a href="/admin/settings">Settings</a></p>
${body}
</main>
</body>
</html>`;
}
