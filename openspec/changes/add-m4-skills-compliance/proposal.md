# Proposal

## Why

The MVP agent can talk and take notes, but it cannot *do* anything: no actions (booking), no escape hatch to a human, no consent notice, and no retention or metrics story. Milestone M4 closes exactly these gaps — and two of them (spoken consent, GDPR retention) are **hard prerequisites for production launch**.

## What Changes

- **Skills framework**: YAML skill manifests (name, LLM-facing description, JSON Schema parameters, execution type `http|db|rag`, auth ref, policies like `requires_confirmation`); a registry loads manifests from a configurable directory and generates the OpenAI-compatible tools array; a dispatcher validates arguments against the JSON Schema and executes `http` (configurable endpoint templates) or `db` (parameterized read-only SQL views) skills, audit-logging every invocation to `call_events`. First skill: appointment booking via `http` against a configurable calendar endpoint (mockable, no vendor integration).
- **Tool-calling loop** in the conversation manager: multi-step, max-iteration bound, aborts on barge-in; `requires_confirmation` skills ask the caller and are dispatched only after an affirmative reply (enforced by the loop, not the model).
- **Consent announcement**: per-language spoken consent notice at call start, *before* any audio reaches STT; result stored as a `call_events` row; decline → polite goodbye + hangup with the session marked `consent_declined`. Trilingual notice text; config toggle (on by default).
- **Human escalation**: on caller request or agent judgment (prompt guidance). Twilio path speaks an announcement then `<Dial>`s a configurable staff number via TwiML redirect; browser/dev path announces, marks the session escalated, and ends the call. Escalation is recorded on the session/note and forces note urgency to `high`.
- **GDPR retention automation**: config-driven (enabled, days; default 90); in-process scheduled job (startup + daily tick) deleting `call_transcripts` + `call_notes` past retention while keeping anonymized `calls` rows (caller number hashed/prefixed); runs logged to `call_events`; retention settings editable via the runtime settings system.
- **Observability**: `GET /api/metrics` (admin basic-auth) exposing in-process counters, per-stage latency percentiles (p50/p95) for STT/LLM/TTS/end-to-end, call counts by status, error counts, and active sessions — JSON only.

Milestone: **M4** (skills + actions, escalation, consent, observability, retention).

## Capabilities

### New Capabilities
- `skills`: YAML skill manifests, registry → OpenAI tools array generation, argument validation, http/db dispatch, confirmation policy, audit logging, and the shipped booking skill.

### Modified Capabilities
- `conversation-agent`: adds the tool-calling loop (tool call/argument streaming, dispatch, tool result feed-back, confirmation turn enforcement, iteration bound, barge-in abort).
- `voice-pipeline`: adds consent-gated audio — the pipeline must not feed caller audio to STT before consent is granted.
- `telephony-transport`: adds the consent announcement at call start (decline → goodbye + hangup) and the escalation call flow (TwiML `<Dial>` redirect on Twilio; announce + end on browser/dev).
- `call-notes`: adds consent/escalation recording on calls and notes, forced `high` urgency on escalation, and GDPR retention deletion/anonymization of stored call data.
- `admin-console`: adds the metrics endpoint.

## Impact

- **Code**: new `src/skills/**` (manifest schema, registry, dispatcher); `src/agent/**` (tool loop, escalation prompt guidance, confirmation turn); `src/pipeline/**` (consent gate); `src/telephony/**` (consent + escalation call flow, TwiML `<Dial>`); `src/notes/**` (escalation/urgency); `src/observability/**` + `src/api/routes.ts` (metrics endpoint); `src/config/**` (consent, escalation, retention, skills, calendar settings; new editable fields); `src/db/**` + migration `0003` (retention job helpers; prefer reusing `call_events`).
- **External services**: an HTTP calendar endpoint (config-driven; mocked in tests) for booking; a configurable staff phone number for escalation.
- **Data**: `call_events` gains consent, escalation, skill-invocation, and retention-run entries; transcripts/notes become deletable with anonymized `calls` rows retained.
- **Ops**: single-instance scheduling constraint (in-process job); consent toggle must stay on for production.

## Non-goals

Outbound calling; Prometheus exposition format or dashboards UI (JSON only); `rag` skill *execution* (manifest field + clear not-implemented error only); multi-instance scheduling (single-instance job is accepted); external queue systems; real calendar vendor integrations (config-driven HTTP endpoint, mockable). Deferred beyond M4: skills auth secret rotation, per-skill rate limiting.
