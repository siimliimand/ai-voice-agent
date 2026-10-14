# Design

## Context

The MVP (M1–M3, archived as `add-voice-agent-mvp`) is complete: VoicePipeline (STT→LLM→TTS with barge-in), ConversationManager with a single streaming LLM pass per turn (no tool loop, but `llm/openrouter.ts` already passes `tools` through and parses `toolCall` deltas; `ChatMessage` already has a `tool` role), notes pipeline with `call_events` audit table, admin UI + basic auth, and a four-layer config system (defaults ← file ← env ← DB settings overrides via `src/config/editable.ts`). See proposal.md for why M4 adds skills, escalation, consent, retention, and metrics.

Constraints that shape the design: spoken consent needs the caller's reply recognized before consent exists (so the gate cannot be absolute — see D5); `call_events.call_id` is NOT NULL, so events must attach to a call; the deployment is single-instance (accepted); OpenRouter tool-calling behavior varies per model (the conformance script already checks it).

## Goals / Non-Goals

**Goals:**
- Declarative skills (YAML) callable by the LLM with validation, confirmation policy, and a full audit trail; booking as the first shipped skill.
- A tool-calling conversation loop that degrades gracefully (iteration bound, barge-in, failed skills) and keeps spoken latency unaffected on tool-free turns.
- Consent notice before any transcript exists; decline = no transcript, ever.
- One-button escape to a human, recorded and reflected in the note.
- Automated GDPR retention and a JSON metrics endpoint.

**Non-Goals:** outbound calling; Prometheus format / dashboards UI; `rag` execution; multi-instance scheduling; external queues; real calendar vendor integrations; per-skill rate limiting; skills auth secret rotation.

## Decisions

### D1: Skill manifests — YAML files, zod-validated, loaded from a configurable directory
`skills.dir` (default `./skills`, editable+restart-required) holds `*.yaml` manifests. Each manifest: `name` (kebab/case-sensitive, must match `^[a-z][a-z0-9_-]{1,63}$`), `description` (LLM-facing), `parameters` (JSON Schema object), `execution: http|db|rag`, `auth` (reference into `skills.auth.<ref>`), `policies` (e.g. `requires_confirmation: true`), and execution payload (`http` skills reference a config endpoint by name; `db` skills carry their read-only SQL). A zod schema validates every manifest at load; invalid ones are logged (with file name) and skipped — the service still boots.
*Why*: YAML keeps skills editable by non-engineers and matches the stakeholder description; fail-soft loading keeps one bad manifest from taking the line down.
*Alternatives*: JSON manifests (no comments, no multi-line strings); DB-stored manifests (needs admin CRUD — unjustified now); TypeScript-registered skills (requires deploys to change a prompt description).

### D2: Registry generates the OpenAI tools array; dispatcher validates with ajv
The registry maps each valid manifest to the existing `ToolDefinition` shape (`llm/openrouter.ts`) — one new dependency, `ajv`, compiles each manifest's JSON Schema once at load. The dispatcher runs every invocation through the compiled validator before anything executes; failures return a descriptive error string as the tool result (never thrown into the audio path) and an audit event.
*Why*: ajv is the standard, auditable JSON Schema implementation; hand-rolling a subset validator invites silent acceptance bugs exactly where an LLM is the client.
*Alternatives*: zod (cannot consume JSON Schema directly); no validation / prompt-only discipline (unacceptable — the model is untrusted input).

### D3: HTTP execution is config-driven endpoint templates; DB execution is SELECT-only bound SQL
`skills.http.<name>` config carries `{url, method, timeoutMs}` with `{param}` substitution from validated arguments (substitution values are JSON-encoded; path params are URI-encoded); `skills.auth.<ref>` carries `{header, value}` (value is a secret). Execution is plain `fetch` with an AbortController timeout — no SDKs, so the booking "calendar" is any HTTP endpoint and tests stub it by pointing `skills.http.booking.url` at a local mock. For `db` skills, the manifest's SQL must be a single `SELECT`/`WITH` statement (enforced by a parser-level check: leading keyword, no semicolons, no write keywords) and runs through Kysely's parameter-binding `sql` template — values are always bound, never interpolated.
*Why*: config-driven endpoints keep "no vendor integration" literal; bound, read-only SQL keeps DB skills useful for lookups without a write path.
*Alternatives*: per-skill YAML for URL+secret (secrets in manifests = accidental commits); a generic SQL runner accepting any statement (rejected: write path).

### D4: Tool loop lives in ConversationManager, driven off the existing streaming client
`handleUtterance` becomes a loop: stream with `tools` (only when skills are loaded); accumulate `toolCall` deltas; on `finish_reason: "tool_calls"`, execute each call through the dispatcher, append the assistant tool-call message + `role: "tool"` results to history, and re-stream — up to `skills.maxToolIterations` (default 5). Spoken content streams to TTS exactly as today; tool phases are silent. The existing abort controller + pipeline epoch abort mid-loop on barge-in; exceeding the bound ends with a fixed spoken fallback ("let me note that and get back to you") that also becomes the tool-call refusal path. `ChatMessage`/`chatStream` gain optional `tool_calls` / `tool_call_id` passthrough (additive, OpenAI-compatible — the shapes were reserved for this in M1, D8 of the MVP design).
*Why*: the loop belongs with history ownership; reusing the streaming path keeps tool-free turns at unchanged latency.
*Alternatives*: a separate tool-agent module (splits history ownership); non-streaming turns while tools are attached (adds ~a full model round-trip of spoken latency).

### D5: Consent = spoken notice + ephemeral reply detection; the transcript gate is absolute
Flow when `consent.enabled` (default true): before the greeting, the notice is spoken in `consent.initialLanguage` (default `et`; texts for et/ru/en live with the other per-language strings). The caller's reply is recognized by a *separate, ephemeral STT stream* opened only for the consent window and closed immediately after the decision — its output feeds a grant/decline classifier (D6) and the normal language vote, and is never persisted; the main STT stream does not exist until consent is granted, and the transcript writer is not attached until then. Decline → per-language goodbye, `transport.hangup()`, session marked `consent_declined`. Outcome lands in `call_events` (`consent_granted`/`consent_declined`) and the new `calls.consent` column (D8). With the toggle off, today's flow runs unchanged.
*Why*: spoken consent cannot be detected without *some* recognition; isolating it in a discarded ephemeral stream honors the point of the gate — no transcript, no persistence, notice first — without touch-tone flows (Twilio Media Streams don't carry DTMF; `<Gather>` would replace `<Connect><Stream>` and fork the architecture).
*Alternatives*: play the notice in all three languages back-to-back then detect (10+ s before the caller can talk — abandonment risk); consent by continued presence (not affirmative consent); DTMF confirm (see above).

### D6: Confirmation and consent decisions — deterministic keywords first, utility model as fallback
Both grant/decline classification and `requires_confirmation` confirmation reuse one small `AffirmationClassifier`: per-language keyword lists (et: jah/oleks/palun/…; ru: да/хорошо/…; en: yes/sure/…) judged deterministically, with the utility model as a tiebreaker; "unclear" re-asks once, then cancels (fail-closed — ambiguity never dispatches). A pending confirmation is per-session state `{skill, args, askedAt}`; the loop dispatches only after an affirmative *next-turn* reply, carries an explicit `confirmation` flag to the dispatcher, and cancels on barge-in or a non-affirmative reply. Both outcomes are audit-logged.
*Why*: keywords cover the 95% case with zero latency and are unit-testable per language; the model tiebreaker catches polite variants; fail-closed matches the safety posture of the whole framework.
*Alternatives*: always ask the utility model (adds a round-trip inside the confirmation turn); let the LLM judge its own confirmation (violates "enforced by the loop").

### D7: Escalation is a built-in tool backed by a Twilio REST redirect
`escalate_to_human` is a built-in (code-owned, not from the skills directory) tool the loop recognizes. Effects: `calls.escalated` set + `escalation_triggered` event; then per transport — Twilio: update the live call via the Twilio REST API (`POST …/Calls/{CallSid}` with `<Response><Say>announcement</Say><Dial><Number>{staffNumber}</Number></Dial></Response>`, basic auth with the existing `twilio.accountSid/authToken`), then close the media session; browser/dev: speak the per-language announcement, mark escalated, end the call. Announcement text is per-language code constants like other agent speech; `escalation.staffNumber` is config (editable). REST failure → fallback to the browser-path behavior (announce + end + escalated flag) so the caller is never stranded mid-handoff; the failure is audit-logged.
*Why*: a REST-initiated redirect is the only way to leave a media-stream call; modeling escalation as a tool reuses D4's machinery and lets prompt guidance and caller request take the same path.
*Alternatives*: Twilio SDK (new dependency for one REST call); `<Enqueue>`/task queues (outbound/contact-center scope creep); keyword-spotting "agent" in the pipeline (prompt guidance already covers it, per the brief).

### D8: Persistence — migration 0003 adds two columns; everything else reuses `call_events`
Migration `0003_m4_skills_compliance.sql`: `ALTER TABLE calls ADD COLUMN consent TEXT` (null | `granted` | `declined`) and `ADD COLUMN escalated BOOLEAN NOT NULL DEFAULT false`. No new tables: skill invocations, consent, escalation, and retention runs are `call_events` rows (types: `skill_invocation`, `consent_granted`, `consent_declined`, `escalation_triggered`, `retention_purged`), matching the table's stated purpose ("audit log of tool invocations"). The retention purge event attaches to the purged call's row (which survives anonymized), so no nullable-`call_id` change is needed.
*Why*: the brief prefers reusing `call_events`; two denormalized columns make consent/escalation visible in the existing call list without joining events.
*Alternatives*: events-only (admin list can't show flags without a query change); a `skill_invocations` table (duplicates `call_events`).

### D9: Retention job — in-process scheduler, idempotent, settings-editable
`RetentionJob` runs at startup and then on a 24 h `setTimeout` tick (single instance accepted; overlapping runs prevented by a simple in-flight flag). Enabled via `retention.enabled` (default true), `retention.days` (default 90): delete `call_transcripts`/`call_notes` for calls older than the cutoff in batches (1 000 rows, transaction per batch), then `UPDATE calls SET from_number = 'anon:' || left(sha256(from_number || retention.hashSalt), 12)` for those rows (salt is a required secret when retention is on — a fixed salt prevents reconstructing numbers from a candidate list). One `retention_purged` event per purged call plus a summary log line (counts, duration). `retention.enabled`, `retention.days` (and `consent.enabled`, `escalation.staffNumber`) join `src/config/editable.ts` so operators manage them from `/admin/settings` with live-apply to the next run/call.
*Why*: at this volume a cron sidecar or pg_cron is more moving parts than the work itself; startup-run + idempotency means a crashed instance self-heals on restart.
*Alternatives*: pg_cron (DB-side, but hides the audit event + anonymization logic outside the app); node-cron (extra dep for one `setTimeout`).

### D10: Metrics — process-local registry behind the existing basic auth
`observability/metrics.ts` adds a `MetricsRegistry` fed from the existing `TurnLatencyTracker` hooks (per-stage samples in a bounded 500-sample ring per stage → p50/p95), counters (calls by final status, pipeline errors, skill failures/refusals, LLM/stream errors), and `CallSessionManager.activeCount` for active sessions; `GET /api/metrics` (registered alongside the other `/api` routes, same basic-auth gate) returns it as JSON, with DB-backed call counts by status (`SELECT status, count(*) … GROUP BY`). Counters reset on restart — stated in the response (`since` boot timestamp).
*Why*: JSON-only keeps the endpoint trivially consumable by scripts; process-local counters match the single-instance deployment and the existing per-turn latency logging.
*Alternatives*: prom-client / Prometheus exposition (explicit non-goal); scanning logs (not queryable).

## Risks / Trade-offs

- [Per-model tool-calling quirks on OpenRouter] → loop treats any malformed tool phase as a plain reply; dispatcher rejects bad args; `scripts/conformance` already flags models that can't tool-call; document that skills require a tool-capable conversation model.
- [Confirmation misfires in trilingual yes/no] → deterministic keyword lists + utility tiebreaker + one re-ask, fail-closed to cancel; language fixtures extend to affirmation tests.
- [Consent notice adds pre-greeting latency and abandonment] → notice is 1–2 sentences; gate is skippable by config (but documented as required for production); decline path is short by design.
- [Twilio REST transfer fails (auth/network)] → fallback announce + end call, escalated flag still recorded; audit event carries the error.
- [Retention job deletes data an admin is viewing] → deletes are batched and idempotent; admin reads are per-call; worst case is a 404 on a just-purged call — acceptable and correct.
- [Barge-in strands an in-flight skill execution] → executions are short and timeout-bounded; orphan results still append to history (context kept) but are never spoken.
- [Counters lost on restart] → `since` timestamp makes the reset explicit; DB-backed per-status counts survive restarts.
- [Hashed numbers are still deterministic] → per-deployment `hashSalt` secret required when retention is on; only prefix-length hashes are stored.

## Migration Plan

1. Ship migration `0003` (additive columns; safe against the old code — apply before or with the new build, compose already runs `migrate-cli` before start).
2. Deploy; defaults are conservative-but-on: consent on, retention on (90 d), skills directory present but only the booking skill (whose endpoint is unset → the skill is offered but its endpoint config must be set to actually book).
3. Rollback: previous image + config toggles (`consent.enabled=false`, `retention.enabled=false`, `skills.dir` emptied) revert behavior without code changes; migration is additive and needs no down-path.
4. Before production launch checklist: consent on, retention on with salt configured, escalation staff number set.

## Open Questions

- Exact booking endpoint request/response contract — defined by the shipped mock server + README section in this change; real calendar integration stays a non-goal.
- Whether skill manifests should hot-reload on change — deferred; restart-required (flagged in the settings UI) until an operator needs it.
