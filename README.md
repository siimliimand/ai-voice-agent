# ai-voice-agent

An AI support worker that answers inbound client phone calls, listens and speaks
trilingually (**Estonian, Russian, English**), and automatically produces
structured call notes for staff. Built as a **custom voice orchestrator** —
our own Node.js service wires together Twilio telephony, speech-to-text,
an LLM brain, and text-to-speech — so prompts, data, latency, and future
tool integrations stay fully under our control.

> **Status:** implementation complete through **M4** —
> [`add-voice-agent-mvp`](openspec/changes/add-voice-agent-mvp/) (M1–M3) +
> [`add-m4-skills-compliance`](openspec/changes/add-m4-skills-compliance/)
> (see [roadmap](#roadmap)). Typecheck + lint clean, **515 tests in 59 suites
> green** with `DATABASE_URL` (incl. DB-backed suites + DB-backed e2e; 0
> skipped), production Docker build verified.
>
> **Operator-pending (needs real credentials/accounts):**
> 1. **STT bake-off + provider/model selection** — needs real API keys and
>    **real et/ru/en call recordings**; the committed fixture wavs are
>    synthetic placeholders ([`test/fixtures/README.md`](test/fixtures/README.md)).
> 2. **Real-call smoke test** over Twilio sandbox + ngrok (needs a Twilio
>    account; [checklist](#real-call-smoke-checklist-operator-pending) below).
> 3. **Set `RETENTION_HASH_SALT` before production** — the retention job
>    refuses to purge or anonymize anything until a salt is configured
>    (see [GDPR retention](#gdpr-retention)).

---

## What it does

1. A client calls the support line. Twilio answers and streams the call audio
   to this service over a WebSocket (Media Streams).
2. A spoken **consent notice** plays before anything is transcribed; only an
   affirmative reply unlocks transcription (a decline ends the call with
   nothing recorded).
3. The caller's language (et / ru / en) is detected from the first utterance;
   STT, voice, and prompt lock to it (re-detected on switch).
4. The agent converses naturally, handling interruptions (barge-in), can
   **call tools** ("skills" — e.g. book an appointment, with spoken
   confirmation before anything is executed), and can **hand over to a
   human** (escalation).
5. Every finalized utterance is transcribed and persisted live (crash-safe).
6. On hangup, an LLM turns the transcript into a **structured note**: summary,
   caller intent, actions taken, unresolved issues, follow-ups, urgency.
7. Staff review calls, transcripts, and notes in a small admin UI; a
   **retention job** purges aged transcripts/notes and anonymizes caller
   numbers ([GDPR retention](#gdpr-retention)); `/api/metrics` exposes
   latency/counters for scripts.

**Still out of scope:** outbound calling (see the
[Non-goals](openspec/changes/add-voice-agent-mvp/proposal.md) and the M4
[design non-goals](openspec/changes/add-m4-skills-compliance/design.md)).

---

## Architecture

```
                        ┌──────────────────────────────────────────────┐
Client call             │                Node/TS service               │
    │                   │                                              │
Twilio number           │  /twiml  ──► <Connect><Stream> wss://…/media │
    └──► PSTN ──Twilio──┤                                              │
                        │  Media Stream WS (μ-law 8kHz, bidirectional) │
                        │      │                                       │
                        │  ┌───▼────────┐   ┌──────────────────────┐  │
                        │  │ audio codec│   │  playback queue      │  │
                        │  │ μ-law↔PCM  │   │  + marks (barge-in)  │  │
                        │  └───┬────────┘   └──────────▲───────────┘  │
                        │      │ 16kHz PCM             │ sentences    │
                        │  ┌───▼────────┐         ┌────┴─────────┐    │
                        │  │ STT adapter│         │ TTS adapter  │    │
                        │  │ (pluggable)│         │ (pluggable)  │    │
                        │  └───┬────────┘         └────▲─────────┘    │
                        │      │ transcripts           │ audio        │
                        │  ┌───▼──────────────────────┴─────────┐    │
                        │  │  Conversation manager              │    │
                        │  │  · language detect / lock          │    │
                        │  │  · LLM streaming (OpenRouter)      │    │
                        │  │  · turn state, barge-in            │    │
                        │  └───┬────────────────────────────────┘    │
                        │      │ on hangup                           │
                        │  ┌───▼─────────────┐                       │
                        │  │ Notes pipeline  │──► Postgres           │
                        │  └─────────────────┘                       │
                        └──────────────────────────────────────────────┘
```

Twilio and the browser dev harness are both `CallTransport` implementations
feeding the same `VoicePipeline`; sessions are held in memory by
`CallSessionManager` with incremental persistence to Postgres as the
recovery point.

**M4 additions** (skills + compliance change):

- **Consent-gated call start** — with `consent.enabled`, a spoken notice
  plays before any transcription exists: the pipeline starts without the
  main STT stream and with the transcript tap locked; an ephemeral STT
  window classifies only the caller's reply (and feeds the language vote).
  An affirmative unlocks STT + transcription; a decline says goodbye and
  hangs up with nothing ever persisted; an unclear reply re-asks once, then
  fails closed. Without an LLM client the gate cannot classify replies, so
  the call runs the ungated flow (logged). The decision lands in
  `calls.consent` + `consent_granted`/`consent_declined` events.
- **Tool-calling loop + confirmation** — when skills are loaded, the
  conversation manager streams with tool definitions, dispatches the model's
  tool calls (arguments JSON-Schema-validated via ajv), appends tool
  results, and continues up to `skills.maxToolIterations`; every processed
  invocation is audited to `call_events` (`skill_invocation`). Skills with
  `requires_confirmation` refuse to execute until the caller explicitly
  confirms in the next turn; barge-in cancels pending dispatches.
- **Human escalation** — the built-in `escalate_to_human` tool sets
  `calls.escalated` + an `escalation_triggered` event and forces the stored
  note's urgency to high. On Twilio it first attempts a REST call update
  that `<Say>`s the announcement and `<Dial>`s the staff number
  (`ESCALATION_STAFF_NUMBER`); any REST failure falls back to announce +
  end the call (still escalated + audited).
- **GDPR retention** — an in-process job purges aged transcripts/notes and
  anonymizes caller numbers at startup and every 24 h
  (see [GDPR retention](#gdpr-retention)).
- **Metrics** — an in-process registry (bounded per-stage latency rings,
  call-status counters, error counters, active-session gauge) exposed as
  JSON at `GET /api/metrics` (see below).

### Key design decisions

| Area | Choice | Why |
|---|---|---|
| Build approach | Custom orchestrator (not ElevenLabs Conversational AI) | Full control of prompts, data, latency, and future tools |
| Transport | `CallTransport` interface: **TwilioMediaStream** (prod) + **Browser** (dev) | 100% of the pipeline is shared; dev needs no telephony |
| STT | ElevenLabs **Scribe v2 Realtime** default; Soniox/Gladia adapters ship too | Streaming, ~150 ms partials, et/ru/en — Estonian is only in ElevenLabs' "good" WER tier, so the bake-off (operator-pending) decides the final provider |
| TTS | ElevenLabs **Eleven v3** | Flash v2.5 does **not** support Estonian; v3 covers all three languages. The Azure `et-EE` fallback is a documented contingency — the adapter is **not implemented** (`TTS_PROVIDER=azure` throws) |
| LLM | **OpenRouter**, model per role (conversation / summarizer / utility) + per-language overrides | All AI models are configurable without code changes |
| Languages | Hybrid detect-then-lock: detect on first utterance, lock STT + voice + prompt, re-detect on switch | Continuous auto-detect misfires on short Estonian utterances |
| Data | Transcripts only — **no raw call audio stored** | GDPR-minimal by design |
| Barge-in | VAD on caller audio → playback flush (<150 ms); mark-based clear on Twilio | Precise mid-sentence interruption |

The full rationale (alternatives + risks) is in
[`openspec/changes/add-voice-agent-mvp/design.md`](openspec/changes/add-voice-agent-mvp/design.md) (D1–D12).

### Code map

```
src/
├── server.ts        # entrypoint: listen, graceful shutdown (drain calls ≤10 s, hard exit 15 s)
├── app.ts           # composition root: providers, sessions, routes, degradation to noop seams
├── logging.ts       # pino logger
├── types.ts         # shared types (Language, CallStatus, Speaker)
├── config/          # zod schema + loader (defaults ← CONFIG_FILE JSON ← env)
├── telephony/       # CallTransport interface; twilio/ (TwiML webhook, signature check, media WS), browser-transport
├── audio/           # μ-law↔PCM, resampling, PCM framing, VAD, playback queue
├── stt/             # SttProvider interface + scribe / soniox / gladia adapters
├── tts/             # TtsProvider interface, sentence chunker, ElevenLabs adapter
├── llm/             # OpenRouter streaming client + model-per-role resolution
├── agent/           # conversation manager, language detect/lock, prompts (et/ru/en), voice registry, tool loop + confirmation, escalation
├── skills/          # YAML manifests → tool definitions, dispatcher (ajv validation, confirmation policy, audit), http/db executors
├── pipeline/        # VoicePipeline: audio → STT → agent → TTS → transport, barge-in, latency marks, consent gate
├── notes/           # incremental transcript writer (live) + post-call summarizer → structured note
├── retention/       # GDPR retention job: batched purge + caller-number anonymization, 24 h scheduler
├── session/         # CallSession + CallSessionManager (active-call registry)
├── db/              # Kysely client, migrations, typed queries, migrate-cli
├── api/             # admin JSON API (/api/calls…, /api/metrics, /api/settings)
├── auth/            # basic auth (constant-time compare, fail-closed)
├── web/             # admin pages (server-rendered), dev-call routes, static dir
└── observability/   # metrics registry (latency rings p50/p95, counters, gauge) + per-turn latency tracking
```

Supporting: `migrations/` (SQL), `scripts/` (`bakeoff/`, `conformance/`,
`gen-fixtures.ts`), `test/` (unit + language + e2e), `public/` (dev-harness
assets served under `/static`).

---

## HTTP & WebSocket surface

One Fastify server hosts everything below (HTTP + WebSocket). Basic auth
credentials come from `ADMIN_USER` / `ADMIN_PASSWORD` — overridable at
runtime via the settings console (applies immediately); responses are `401`
when unset or wrong (no password configured ⇒ console locked, fail-closed
even against well-formed credentials).

| Endpoint | Auth | Description |
|---|---|---|
| `GET /health` | public | Liveness: `{ok, uptime_s}` (Docker healthcheck target) |
| `POST /twiml` | Twilio signature | Answers an inbound call with `<Connect><Stream>` TwiML pointing at the media WS. **Fail-closed:** `503` when `TWILIO_AUTH_TOKEN` is unset, `403` on signature mismatch — no session is ever started |
| `WS /media/twilio` | — | Twilio Media Streams (bidirectional μ-law 8 kHz). Path configurable via `TWILIO_MEDIA_WS_PATH` |
| `GET /dev/call` | dev flag | Browser call harness page. Only registered when `DEV_BROWSER_CALLS=true`; otherwise 404 |
| `WS /media/browser` | dev flag | Browser transport: PCM16 16 kHz in/out + JSON control messages |
| `GET /dev/fixtures` | dev flag | Lists `*.wav` files in `test/fixtures/` |
| `GET /dev/fixtures/:name` | dev flag | Serves one fixture wav (`400` bad name, `404` unknown) |
| `GET /admin` | basic auth | Call list (newest first, 100 rows). With no `DATABASE_URL`, renders a "disabled" page instead |
| `GET /admin/calls/:id` | basic auth | Call detail: metadata, full transcript, structured note (404 page for unknown ids) |
| `GET /api/calls?limit=&offset=` | basic auth | Paginated call list JSON (default 50, max 200) |
| `GET /api/calls/:id` | basic auth | `{call, transcript, note}` JSON (`400` bad id, `404` unknown) |
| `GET /api/metrics` | basic auth | JSON metrics (D10): process snapshot (latency p50/p95 per stage, counters, `activeSessions`, boot `since`) + DB-backed `callsByStatusDb`. `503 {error}` if the registry is not wired (should not happen) — shape below |
| `GET /api/settings` | basic auth | Runtime settings: `{values, overrides, sections}` — effective config, dotted paths with a DB override, editable-field contract. Secret fields masked as `{set, hint:"…last4"}`. Needs `DATABASE_URL` |
| `PUT /api/settings` | basic auth | Save `{values, reset[]}`: infra paths (`port`/`host`/`databaseUrl`/`publicBaseUrl`) rejected `400`; merged candidate re-validated with the zod schema → `400` + issue list; blank secret = keep current; `reset[]` drops per-field overrides |
| `GET /admin/settings` | basic auth | Server-rendered settings form (grouped sections, override badges, per-field reset, read-only infra display); save POSTs and redirects back with `?saved=1` |
| `GET /static/*` | public | Static assets from `public/` |

### Metrics (`GET /api/metrics`)

Same basic-auth gate as the other `/api` routes. One JSON document per
request, design D10 — no Prometheus exposition, made for scripts:

```json
{
  "since": "2026-10-13T10:00:00.000Z",
  "latency": {
    "stt_finalize":    { "count": 120, "p50": 210, "p95": 340 },
    "llm_first_token": { "count": 120, "p50": 480, "p95": 900 },
    "tts_first_byte":  { "count": 120, "p50": 150, "p95": 260 },
    "end_to_end":      { "count": 120, "p50": 980, "p95": 1600 }
  },
  "callsByStatus":   { "in_progress": 42, "completed": 40, "failed": 2 },
  "callsByStatusDb": { "in_progress": 1,  "completed": 1180, "failed": 39 },
  "activeSessions": 1,
  "errors":  { "pipeline": 0, "llm": 1, "stream": 0, "skill": 2 },
  "counters": { "skills_invoked": 17, "skills_refused": 3 },
  "process": { "since": "2026-10-13T10:00:00.000Z" }
}
```

Two layers, two semantics:

- **Process layer** (`since`, `latency`, `callsByStatus`, `errors`,
  `counters`, `activeSessions`) — lives in memory only and **resets on
  restart**. `since` is the registry boot timestamp and makes every scrape's
  reset window explicit (`process.since` echoes it for scrapers that read one
  key). `latency` holds per-stage nearest-rank p50/p95 over a bounded 500
  -sample ring (`p50`/`p95` are `null` until a stage has samples). In
  `callsByStatus`, `in_progress` is a *started-calls counter* — it is never
  decremented when a call ends; live-ness is `activeSessions`.
- **DB layer** (`callsByStatusDb`) — `SELECT status, count(*) … GROUP BY`
  over the persisted `calls` table; survives restarts and is authoritative
  for final status counts. Its `in_progress` counts call rows still open in
  the database. Kept under a separate key so it can't be confused with the
  process counters; needs `DATABASE_URL`.

| Process key | Meaning |
|---|---|
| `latency.<stage>` | `{count, p50, p95}` ms per turn stage (ring of 500) |
| `callsByStatus` | calls **started** since boot by status (finals accumulate) |
| `errors` | pipeline / llm / stream / skill error counters since boot |
| `counters` | generic named counters (e.g. skills framework), starts empty |
| `activeSessions` | live gauge of non-finalized sessions |

---

## Configuration

Everything external is configurable without code changes. Layering:
**schema defaults ← optional JSON file ← environment** (later wins; deep
merged), plus a fourth layer at runtime — **DB settings overrides** from the
admin console (see [Runtime settings](#runtime-settings-admin-ui) below).
The JSON file path is `CONFIG_FILE` (default `./config.json` if
present) and uses the same field names as the zod schema in
`src/config/schema.ts`. `.env.example` documents the common variables.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP + WS listen port (also used by compose + Docker healthcheck) |
| `HOST` | `0.0.0.0` | Listen interface |
| `LOG_LEVEL` | `info` | `fatal` `error` `warn` `info` `debug` `trace` |
| `PUBLIC_BASE_URL` | — | Accepted but currently unused: `/twiml` derives the media WS URL from the incoming request's Host header |
| `CONFIG_FILE` | `config.json` | JSON config file path (layered under env) |
| `DATABASE_URL` | — | Postgres connection string. Absent (or unreachable) ⇒ degraded: no persistence, no notes, admin disabled |
| `DEV_BROWSER_CALLS` | `false` | `true`/`1` enables `/dev/call`, `/media/browser`, `/dev/fixtures` (dev only!) |
| `DEV_FAKE_CALLER_NUMBER` | `+37200000000` | Caller number recorded for browser-originated sessions |
| **Twilio** | | |
| `TWILIO_ACCOUNT_SID` | — | Account SID (reference) |
| `TWILIO_AUTH_TOKEN` | — | `/twiml` signature validation; unset ⇒ route answers `503` to everything |
| `TWILIO_MEDIA_WS_PATH` | `/media/twilio` | Media WS path referenced from TwiML |
| **STT** | | |
| `STT_PROVIDER` | `scribe` | `scribe` \| `soniox` \| `gladia` |
| `STT_MODEL` | `scribe_v2_realtime` | ElevenLabs Scribe model id |
| `STT_SAMPLE_RATE_HZ` | `16000` | PCM sample rate fed into the pipeline core |
| **TTS** | | |
| `TTS_PROVIDER` | `elevenlabs` | `elevenlabs` (the `azure` fallback is a documented contingency — adapter not implemented) |
| `TTS_MODEL` | `eleven_turbo_v2_5` | ElevenLabs model id |
| `TTS_VOICE_ET` / `_RU` / `_EN` | `pqHfZKP75CvOlQylNhV4` / `pFZP5JQG7iQjIQuC4Bku` / `21m00Tcm4TlvDq8ikWAM` | Voice id per language (must support the language) |
| `TTS_OUTPUT_SAMPLE_RATE_HZ` | `16000` | Synthesized-audio sample rate |
| **Provider keys** | | |
| `ELEVENLABS_API_KEY` | — | Required by Scribe STT **and** Eleven v3 TTS |
| `SONIOX_API_KEY` | — | Alternative STT (bake-off) |
| `SONIOX_MODEL` | `stt-rt-preview` | Soniox model id |
| `GLADIA_API_KEY` | — | Alternative STT (bake-off) |
| `GLADIA_MODEL` | `solaria-1` | Gladia model id |
| `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` | — | Reserved for the Azure TTS fallback (not implemented) |
| `AZURE_VOICE_ET` / `_RU` / `_EN` | `et-EE-AnuNeural` / `ru-RU-SvetlanaNeural` / `en-US-JennyNeural` | Reserved (Azure fallback voices) |
| **LLM (OpenRouter)** | | |
| `OPENROUTER_API_KEY` | — | Absent ⇒ no greeting/replies; sessions get `llm_not_configured` |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible gateway |
| `LLM_CONVERSATION_MODEL` | `openai/gpt-4o-mini` | Live agent brain |
| `LLM_SUMMARIZER_MODEL` | `openai/gpt-4o-mini` | Post-call note generation |
| `LLM_UTILITY_MODEL` | `openai/gpt-4o-mini` | Language detection, cheap classification |
| `LLM_CONVERSATION_MODEL_ET` / `_RU` / `_EN` | — | Per-language conversation overrides (the JSON file can also override summarizer/utility per language) |
| **VAD (barge-in)** | | |
| `VAD_THRESHOLD` | `0.015` | RMS threshold in [0..1] for speech detection |
| `VAD_HANGOVER_FRAMES` | `15` | 20 ms frames speech stays alive after the last hit |
| `VAD_ONSET_FRAMES` | `2` | Consecutive frames required to trigger speech start |
| **Notes** | | |
| `NOTES_ENABLED` | `true` | Post-call note generation on/off |
| **Admin** | | |
| `ADMIN_USER` | `admin` | Basic-auth username |
| `ADMIN_PASSWORD` | — | Basic-auth password; unset ⇒ admin locked (fail-closed `401`) |
| **Skills (tool calling)** | | |
| `SKILLS_DIR` | `./skills` | Directory of `*.yaml` skill manifests (read once at startup; see [Skills](#skills-tool-calling)) |
| `SKILLS_MAX_TOOL_ITERATIONS` | `5` | Max LLM tool-call round-trips per utterance (1–10) |
| `SKILLS_HTTP_BOOKING_URL` | — | `booking` endpoint URL; unset ⇒ the skill answers with a clear "not configured" tool result |
| `SKILLS_HTTP_BOOKING_METHOD` | `POST` | `booking` endpoint HTTP method |
| `SKILLS_HTTP_BOOKING_TIMEOUT_MS` | `10000` | `booking` endpoint request timeout (ms) |
| `SKILLS_AUTH_CALENDAR_HEADER` / `_VALUE` | — | Auth header name + secret sent with `booking` requests (the value is a secret) |
| **Consent notice** | | |
| `CONSENT_ENABLED` | `true` | Spoken consent notice before transcription; a decline ends the call untranscribed (live-editable via `/admin/settings`) |
| `CONSENT_INITIAL_LANGUAGE` | `et` | Notice language until the caller's reply vote: `et` \| `ru` \| `en` (live-editable) |
| **Escalation** | | |
| `ESCALATION_STAFF_NUMBER` | — | Staff number for the escalation `<Dial>` transfer; empty ⇒ announce + end call instead (live-editable) |
| **GDPR retention** | | |
| `RETENTION_ENABLED` | `true` | Retention job on/off (live-editable) |
| `RETENTION_DAYS` | `90` | Transcripts/notes older than this are purged and caller numbers anonymized (live-editable) |
| `RETENTION_HASH_SALT` | — | Secret salt for caller-number anonymization; **set before production** — while empty (and retention enabled) every run is skipped with an error. Write-only, live-editable (see [GDPR retention](#gdpr-retention)) |

### Runtime settings (admin UI)

The editable surface (STT/TTS providers and models, voices, provider and LLM
keys, LLM model ids, VAD, notes, consent, escalation, retention, Twilio
credentials, admin credentials, and the dev-call options) can also be
overridden at runtime from `/admin/settings`, making the layering four deep:
**schema defaults ← `config.json` ← environment ← DB settings overrides**
(later wins; deep merged). Overrides are stored as one nested JSON document
in the `settings` table (`key='global'`), deep-merged over the startup config
and re-validated against the full zod schema on every resolve; an unreadable
or invalid stored document fails safe to the base config. A 2 s-TTL resolver
(invalidated on save) keeps per-call resolution cheap; with no
`DATABASE_URL` there are no overrides and the base config is used.

- **Infra values stay startup-only:** the env table above remains
  authoritative for `PORT`, `HOST`, `DATABASE_URL`, and `PUBLIC_BASE_URL` —
  they are not stored in the settings document and `PUT /api/settings`
  rejects them with `400`.
- **Live-apply:** overrides take effect for **new calls** without a restart —
  each call is wired from its resolved effective config (STT/TTS/LLM, voices,
  VAD, notes settings); admin-credential changes (`admin.user` /
  `admin.password`) apply immediately. Fields that only bind at startup are
  flagged in the UI: `devBrowserCalls` and `twilio.mediaWsPath`. (The stored
  `logLevel` does not change the process log level — that is read at startup.)
- **Secrets are write-only:** `GET` returns `{set, hint:"…last4"}` instead of
  the value; leaving a secret blank on save keeps the current value.
- **Per-field reset** removes an override from the stored document, so the
  environment/default value applies again.

### Degradation matrix

The app **always boots** and serves `/health` with zero external credentials;
missing pieces become noop providers with a single pipeline code path
(`src/app.ts`):

| Missing | Behavior |
|---|---|
| `ELEVENLABS_API_KEY` (STT = scribe) | Calls run **without transcription** |
| `ELEVENLABS_API_KEY` (TTS = elevenlabs) | Calls run **without speech** |
| `OPENROUTER_API_KEY` | Calls run **without greeting or replies**; each session announces `llm_not_configured` |
| `DATABASE_URL` | **No persistence, no notes**; skills disabled, no retention job, no metrics DB layer; `/api/*` not registered, `/admin` renders a "disabled" page |
| Skills + no `DATABASE_URL` | Skills stay **disabled** (every invocation is audited to the db); calls run the tool-free conversation path (warn logged at boot) |
| `RETENTION_HASH_SALT` empty (retention enabled) | Retention job **skips every run** with an error log — no purge, no anonymization — until a salt is set (fail-safe) |
| `ESCALATION_STAFF_NUMBER` empty | Escalation **announces and ends the call** instead of a `<Dial>` transfer (no REST attempt); the escalated flag + events are still recorded — same fallback as a failed Twilio REST transfer |
| Metrics registry not wired | `GET /api/metrics` answers `503 {error}` (the composed app always wires the registry, so this only guards direct route reuse) |
| `TWILIO_AUTH_TOKEN` | `/twiml` answers `503` to every request (fail-closed) |
| `ADMIN_PASSWORD` | `/admin` + `/api/*` answer `401` even to well-formed credentials (fail-closed) |

---

## Skills (tool calling)

The conversation agent can call tools ("skills") mid-call. A skill is one
declarative YAML manifest describing a callable tool; manifests are loaded
**once at startup** from `SKILLS_DIR` (default `./skills`) — restart the
service to pick up changes. Invalid manifests are skipped with a logged
error (the service still boots). Tool calling needs a **tool-capable
conversation model** (`LLM_CONVERSATION_MODEL`; `npm run conformance`
reports whether a model emits tool calls).

### Manifest format (`<skills.dir>/*.yaml`)

| Field | Required | Description |
|---|---|---|
| `name` | yes | Lowercase tool id, `^[a-z][a-z0-9_-]{1,63}$` — shown verbatim to the LLM |
| `description` | yes | LLM-facing: what the tool does and when to call it |
| `parameters` | yes | JSON Schema for the arguments object; validated with ajv at dispatch, invalid calls become error tool-results |
| `execution` | yes | `http` \| `db` \| `rag` |
| `endpoint` | for `http` | Name of the endpoint template in config `skills.http.<name>` |
| `sql` | for `db` | A single read-only `SELECT`/`WITH` statement; `{param}` slots bind as query parameters (writes rejected at load) |
| `auth` | no | Reference to a header credential in config `skills.auth.<ref>` |
| `policies.requires_confirmation` | no | `true` ⇒ dispatch refuses until the caller explicitly confirms (see below) |

Execution types: **http** calls the configured endpoint template
(`{param}` slots are URI-encoded into the URL, the validated arguments go
out as the JSON body); **db** runs the manifest SQL against Postgres;
**rag** is a stub that returns a clear not-implemented tool result.

Secrets never live in manifests — the `auth` field only names a credential
configured via env or the JSON config file.

### Shipped `booking` skill

`skills/booking.yaml` books an appointment (date, time, service, patient
name) over the `booking` HTTP endpoint and requires confirmation before
dispatch. Its config keys:

| Key | Default | Description |
|---|---|---|
| `SKILLS_HTTP_BOOKING_URL` | — | Booking endpoint URL; unset ⇒ booking answers with a clear "not configured" tool result |
| `SKILLS_HTTP_BOOKING_METHOD` | `POST` | HTTP method for the booking request |
| `SKILLS_HTTP_BOOKING_TIMEOUT_MS` | `10000` | Booking request timeout (ms) |
| `SKILLS_AUTH_CALENDAR_HEADER` / `_VALUE` | — | Auth header name + secret sent with every booking request |

Additional endpoints/auth refs have no generic env naming — define them in
the JSON config file under `skills.http.<name>` / `skills.auth.<ref>`. The
whole `skills.*` config section is intentionally **not** editable from the
admin settings UI: it is file/env-only and read at startup.

### Confirmation flow (operator view)

1. The model calls `booking`; the dispatcher sees
   `requires_confirmation: true`, refuses, and the agent asks the caller to
   confirm. Audited as `confirmation_required` — the calendar endpoint is
   not touched.
2. On the caller's affirmative reply the dispatch re-runs with the
   confirmation flag; only then is the HTTP request sent. Audited as
   `executed`.
3. Every invocation — success, validation error, refusal, execution error —
   writes a `skill_invocation` row to `call_events` with the skill name,
   arguments, and outcome (arguments are tool arguments, never secrets).

A reusable mock calendar server for tests lives at
`test/fixtures/mock-calendar.ts`.

---

## Development

### Quick start

```bash
npm install                       # Node.js 22+
docker compose up -d postgres     # Postgres 16 with healthcheck
cp .env.example .env              # fill in ELEVENLABS_API_KEY + OPENROUTER_API_KEY
npm run migrate                   # apply SQL migrations
npm run dev                       # tsx watch on http://localhost:3000
```

Without any keys the server still boots — see the degradation matrix above.
Useful checks: `npm run typecheck`, `npm run lint`, `npm run build` +
`npm start` (compiled).

### Browser call harness (no Twilio needed)

1. Set `DEV_BROWSER_CALLS=true`, open `http://localhost:3000/dev/call`.
2. Optionally set a fake caller number (`DEV_FAKE_CALLER_NUMBER` by default),
   choose **Microphone** or **Replay wav**, press **Start call**.
3. The page streams audio to `/media/browser` — the same pipeline Twilio
   feeds — plays the agent's replies, and shows the live transcript.

Replay mode streams a fixture `.wav` (et/ru/en under `test/fixtures/`) at
16 kHz PCM16; this is also how e2e tests drive calls.

### Fixtures

```bash
npm run fixtures   # regenerate test/fixtures/fixture-*.wav (deterministic, seeded)
```

**These wavs are synthetic structural placeholders** (speech-like tones, not
speech): they exercise the pipeline, but no STT provider will transcribe them
into the reference `.txt` transcripts. Before the bake-off decides a provider,
swap in real et/ru/en recordings (same filenames, 16 kHz mono PCM16) — see
[`test/fixtures/README.md`](test/fixtures/README.md).

### STT bake-off

```bash
npm run bakeoff
```

Streams every `fixture-*.wav` through each configured provider (Scribe /
Soniox / Gladia — providers without keys are skipped) and scores WER +
latency against the sibling `.txt` references. Prints a table and writes a
full JSON report to `reports/bakeoff-<timestamp>.json`. **Numbers are only
meaningful with real recordings** (see above); with no keys the script exits
0 after reporting the skips.

### LLM conformance

```bash
npm run conformance
```

Checks every configured model id (conversation / summarizer / utility +
per-language overrides, deduplicated): streaming works, and whether the model
emits tool calls. Exits 1 if any model fails to stream; skips cleanly without
`OPENROUTER_API_KEY`.

### Testing

Current state: **515 tests green across 59 suites, 0 skipped** (unit,
language, and e2e) with `DATABASE_URL` set; without it, 48 tests in 8
DB-backed suites skip cleanly (exit still 0).

| Level | What | Command | Notes |
|---|---|---|---|
| Unit | Audio codecs vs golden fixtures, STT/TTS/LLM adapters, agent (incl. tool loop, confirmation, prompts), notes, Twilio routes/WS, admin API/DB queries | `npm test` | hermetic, no network |
| Runtime settings | Effective-config merge precedence + fail-safe fallback, secret masking, `400` validation (incl. infra-path rejection), per-field reset, dynamic basic-auth (live-apply + fail-closed), settings-doc read/merge/unset | `npm test` | `test/config/effective`, `test/api/settings`, `test/api/settings-page`, `test/auth/basic-auth-dynamic`, `test/db/settings`; Postgres-backed parts skip without `DATABASE_URL` |
| M4 suites | Skills (loader, dispatcher, http/db executors, shipped `booking` skill), consent gate + call-start flow, escalation (builtin + Twilio REST transfer + fallback), retention job + settings **live-apply**, metrics registry (percentile/counter math, ring bounding, pipeline feeds) + `/api/metrics` | `npm test` | `test/skills`, `test/app`, `test/pipeline`, `test/agent`, `test/retention`, `test/observability`, `test/api/metrics`; Postgres-backed parts skip without `DATABASE_URL` |
| Language | Detection et/ru/en + et↔ru code-switching fixtures | `npm test` | part of the suite |
| E2E | Fixture calls through the real browser transport: booking with spoken confirmation against the mock calendar, consent grant/decline, browser-path escalation — transcripts, structured notes, `skill_invocation`/consent/escalation audit rows asserted in Postgres | `npm run test:e2e` | needs Postgres; **skips cleanly without `DATABASE_URL`** |
| STT bake-off | WER + latency per provider × fixture | `npm run bakeoff` | keys + real recordings; JSON report to `reports/` |
| LLM conformance | Streaming + tool-call readiness per configured model | `npm run conformance` | exit 1 on stream failure |
| Latency budget | Per-turn `stt_finalize` / `llm_first_token` / `tts_first_byte` / end-to-end timings | read logs | target end-to-end < 1 s (`TURN_LATENCY_TARGET_MS`) |

E2E setup (compose does not publish the Postgres port; use the container IP):

```bash
docker compose up -d postgres
export DATABASE_URL="postgres://voice:voice@$(docker inspect \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
  $(docker compose ps -q postgres)):5432/voice"
npm run test:e2e
```

---

## Twilio setup (real calls)

1. Buy/use a Twilio number (sandbox is fine for dev; for a public Estonian
   line, +372 availability in Twilio's catalog is uncertain — fallback is a
   DID from a provider such as DIDWW/Telnyx trunked via **Elastic SIP
   Trunking**; this does not change the architecture).
2. Point the number's **voice webhook** to `https://<your-host>/twiml`
   (HTTP POST); for local dev, `ngrok http 3000`. The returned TwiML points
   the media stream at `wss://<request-host>/media/twilio`, and signature
   validation uses the full request URL — so Twilio must reach `/twiml` on
   the public host directly (no path rewriting behind the tunnel).
3. Set `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` — without them `/twiml`
   rejects everything with `503` (fail-closed); with them, requests whose
   `X-Twilio-Signature` doesn't match get `403`.
4. Call the number.

### Real-call smoke checklist (operator-pending)

- [ ] Caller hears the greeting; language locks after the first utterance (try et / ru / en)
- [ ] Consent notice is audible **before** any transcription starts; a decline ends the call untranscribed
- [ ] Booking request triggers the spoken confirmation; only the affirmative reply books against the calendar endpoint
- [ ] Asking for a human escalates: Twilio `<Dial>` transfers to `ESCALATION_STAFF_NUMBER` (or the announce + end fallback fires)
- [ ] Replies are audible and per-turn latency lands near the < 1 s budget (check per-stage log lines)
- [ ] Barge-in: speaking over the agent stops playback promptly mid-sentence
- [ ] Transcript rows appear in Postgres **during** the call (crash-safe persistence)
- [ ] After hangup: `calls` row finalized (status / duration / language / consent / escalated) and a structured note is generated; both visible in `/admin`

---

## Deployment

> **Production runbook for the live server** (this host): see
> [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

```bash
docker compose up -d --build
```

- The `app` service builds from the multi-stage `Dockerfile`
  (node:22-alpine, non-root user, `HEALTHCHECK` against `/health`) and runs
  `node dist/db/migrate-cli.js && node dist/server.js` — migrations apply
  before the server starts (the app also self-migrates at boot when
  `DATABASE_URL` is set).
- Startup configuration comes from environment only: compose injects
  `DATABASE_URL` for the bundled `postgres:16-alpine` service and loads the
  optional `.env` via `env_file`. Secrets never go into the image.
- **EU region:** host in an EU datacenter — proximity to Twilio's EU media
  gateways (Ireland) and ElevenLabs EU inference is part of the latency
  budget, and it keeps personal data in-jurisdiction.
- **Single instance:** sessions are in-memory with incremental DB persistence
  as the recovery point; multi-instance scaling is a deliberate non-goal.
- Graceful shutdown on `SIGTERM`/`SIGINT`: stop listening, hang up active
  calls (`server_shutdown`), drain ≤ 10 s, close the DB, exit.

Runtime settings live in the `settings` Postgres table (migration
`0002_settings.sql`), so they are included in normal database backups and
survive container restarts — no extra state to snapshot. Precedence is
unchanged on boot: the environment still wins for infra values, while DB
overrides win for the editable surface (models, voices, VAD, provider keys,
admin credentials, consent/escalation/retention).

### GDPR notes

- Only **transcripts** are stored, never raw call audio.
- Transcripts are personal data: host in the EU, restrict admin access
  (basic auth in v1), and complete the pre-production items — set the
  retention salt (below) and run the real-call smoke checklist.

### GDPR retention

The retention job (`src/retention/job.ts`) runs in-process at startup and
then every 24 h (single-instance by design; overlapping runs are guarded;
re-runs are idempotent — a call anonymized once is never selected again).
Each run processes, in transactional batches of 1000, every call started
before `now − retention.days` that is not yet anonymized:

- **Deleted:** the call's `call_transcripts` and `call_notes` rows.
- **Kept:** the `calls` row (the call-history record), with `from_number`
  replaced by `anon:<12 hex chars of sha256(number + hashSalt)>` — the
  per-deployment secret salt is what prevents reconstructing caller numbers
  from a candidate list once hashed.
- **Audit trail:** one small `retention_purged` row in `call_events` per
  purged call (`{retentionDays, purgedAt}`), plus a summary log line per run.

Fail-safe: with retention **enabled** and an **empty**
`retention.hashSalt`, every run is skipped with an error log — nothing is
ever deleted or anonymized without the salt.
**Set the salt before production** (`RETENTION_HASH_SALT` env, or the
settings console below).

`retention.enabled` / `retention.days` / `retention.hashSalt` are editable
live via `PUT /api/settings` or `/admin/settings`: the job re-reads the
effective config on every run, so changes apply on the next run without a
restart (covered by a dedicated live-apply test). The salt is write-only —
`GET` returns `{set, hint:"…last4"}`, never the value.

---

## Project management (OpenSpec)

Scope and specifications live in OpenSpec artifacts — they are the source of
truth, not this README:

```bash
openspec list                    # active changes
openspec show add-voice-agent-mvp
openspec validate add-voice-agent-mvp
```

- `openspec/changes/add-voice-agent-mvp/` — this change: `proposal.md`
  (why/what), `design.md` (D1–D12), `specs/*/spec.md`, `tasks.md`
  (37 annotated tasks)
- `openspec/config.yaml` — project context shown to AI agents
- `openspec/specs/` — capabilities, populated as changes are archived

### Roadmap

| Milestone | Scope | Status |
|---|---|---|
| M1 | Pipeline skeleton, browser dev harness, STT bake-off script, Twilio transport | **implemented** (bake-off run pending real keys + real recordings) |
| M2 | Trilingual detection/locking, per-language prompts + voices, barge-in | **implemented** |
| M3 | Notes pipeline (live transcripts, post-call summaries), admin UI | **implemented** |
| M4 | Skills framework + actions (booking), human escalation, consent announcement, retention automation, latency dashboards | **implemented** (real-call Twilio smoke pending; outbound calling is a recorded [non-goal](openspec/changes/add-m4-skills-compliance/design.md)) |
