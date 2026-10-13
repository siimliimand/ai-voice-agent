# ai-voice-agent

An AI support worker that answers inbound client phone calls, listens and speaks
trilingually (**Estonian, Russian, English**), and automatically produces
structured call notes for staff. Built as a **custom voice orchestrator** —
our own Node.js service wires together Twilio telephony, speech-to-text,
an LLM brain, and text-to-speech — so prompts, data, latency, and future
tool integrations stay fully under our control.

> **Status:** implementation complete for the
> [`add-voice-agent-mvp`](openspec/changes/add-voice-agent-mvp/) change
> (M1–M3 scope; see [roadmap](#roadmap)). Typecheck + lint clean, **321 tests
> in 39 suites green** (incl. DB-backed suites + a DB-backed e2e), production
> Docker build verified.
>
> **Operator-pending (needs real credentials/accounts):**
> 1. **STT bake-off + provider/model selection** — needs real API keys and
>    **real et/ru/en call recordings**; the committed fixture wavs are
>    synthetic placeholders ([`test/fixtures/README.md`](test/fixtures/README.md)).
> 2. **Real-call smoke test** over Twilio sandbox + ngrok (needs a Twilio
>    account; [checklist](#real-call-smoke-checklist-operator-pending) below).
>
> Consent announcement + retention automation are **M4** — required before
> production launch (see [GDPR notes](#gdpr-notes)).

---

## What it does

1. A client calls the support line. Twilio answers and streams the call audio
   to this service over a WebSocket (Media Streams).
2. The caller's language (et / ru / en) is detected from the first utterance;
   STT, voice, and prompt lock to it (re-detected on switch).
3. The agent converses naturally, handling interruptions (barge-in).
4. Every finalized utterance is transcribed and persisted live (crash-safe).
5. On hangup, an LLM turns the transcript into a **structured note**: summary,
   caller intent, actions taken, unresolved issues, follow-ups, urgency.
6. Staff review calls, transcripts, and notes in a small admin UI.

**Not in this scope** (M4 follow-up change): skills/actions (appointment
booking), human escalation, consent announcement, retention automation,
outbound calling. See
[Non-goals](openspec/changes/add-voice-agent-mvp/proposal.md).

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
├── agent/           # conversation manager, language detect/lock, prompts (et/ru/en), voice registry
├── pipeline/        # VoicePipeline: audio → STT → agent → TTS → transport, barge-in, latency marks
├── notes/           # incremental transcript writer (live) + post-call summarizer → structured note
├── session/         # CallSession + CallSessionManager (active-call registry)
├── db/              # Kysely client, migrations, typed queries, migrate-cli
├── api/             # admin JSON API (/api/calls…)
├── auth/            # basic auth (constant-time compare, fail-closed)
├── web/             # admin pages (server-rendered), dev-call routes, static dir
└── observability/   # per-turn latency tracking (STT finalize / LLM first token / TTS first byte / e2e)
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
| `GET /api/settings` | basic auth | Runtime settings: `{values, overrides, sections}` — effective config, dotted paths with a DB override, editable-field contract. Secret fields masked as `{set, hint:"…last4"}`. Needs `DATABASE_URL` |
| `PUT /api/settings` | basic auth | Save `{values, reset[]}`: infra paths (`port`/`host`/`databaseUrl`/`publicBaseUrl`) rejected `400`; merged candidate re-validated with the zod schema → `400` + issue list; blank secret = keep current; `reset[]` drops per-field overrides |
| `GET /admin/settings` | basic auth | Server-rendered settings form (grouped sections, override badges, per-field reset, read-only infra display); save POSTs and redirects back with `?saved=1` |
| `GET /static/*` | public | Static assets from `public/` |

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
| `TTS_MODEL` | `eleven_v3` | ElevenLabs model id |
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

### Runtime settings (admin UI)

The editable surface (STT/TTS providers and models, voices, provider and LLM
keys, LLM model ids, VAD, notes, Twilio credentials, admin credentials, and
the dev-call options) can also be overridden at runtime from
`/admin/settings`, making the layering four deep:
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
| `DATABASE_URL` | **No persistence, no notes**; `/api/*` not registered, `/admin` renders a "disabled" page |
| `TWILIO_AUTH_TOKEN` | `/twiml` answers `503` to every request (fail-closed) |
| `ADMIN_PASSWORD` | `/admin` + `/api/*` answer `401` even to well-formed credentials (fail-closed) |

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

Current state: **321 tests green across 39 suites** (unit, language, and e2e)
with `DATABASE_URL` set; without it, 18 tests in 4 DB-backed suites skip
cleanly.

| Level | What | Command | Notes |
|---|---|---|---|
| Unit | Audio codecs vs golden fixtures, STT/TTS/LLM adapters, agent, notes, Twilio routes/WS, admin API/DB queries | `npm test` | hermetic, no network |
| Runtime settings | Effective-config merge precedence + fail-safe fallback, secret masking, `400` validation (incl. infra-path rejection), per-field reset, dynamic basic-auth (live-apply + fail-closed), settings-doc read/merge/unset | `npm test` | `test/config/effective`, `test/api/settings`, `test/api/settings-page`, `test/auth/basic-auth-dynamic`, `test/db/settings`; Postgres-backed parts skip without `DATABASE_URL` |
| Language | Detection et/ru/en + et↔ru code-switching fixtures | `npm test` | part of the suite |
| E2E | Fixture wav through the real browser transport → transcript + structured note asserted in Postgres | `npm run test:e2e` | needs Postgres; **skips cleanly without `DATABASE_URL`** |
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
- [ ] Replies are audible and per-turn latency lands near the < 1 s budget (check per-stage log lines)
- [ ] Barge-in: speaking over the agent stops playback promptly mid-sentence
- [ ] Transcript rows appear in Postgres **during** the call (crash-safe persistence)
- [ ] After hangup: `calls` row finalized (status / duration / language) and a structured note is generated; both visible in `/admin`

---

## Deployment

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
admin credentials).

### GDPR notes

- Only **transcripts** are stored, never raw call audio.
- Transcripts are personal data: host in the EU, restrict admin access
  (basic auth in v1), and complete the M4 items **before production
  launch** — consent announcement flow and GDPR retention automation.

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
| M4 | Skills framework + actions (booking), human escalation, consent announcement, retention automation, latency dashboards, outbound calling | future change — consent + retention are pre-production requirements |
