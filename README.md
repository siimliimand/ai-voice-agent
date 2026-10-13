# ai-voice-agent

An AI support worker that answers inbound client phone calls, listens and speaks
trilingually (**Estonian, Russian, English**), and automatically produces
structured call notes for staff. Built as a **custom voice orchestrator** —
our own Node.js service wires together Twilio telephony, speech-to-text,
an LLM brain, and text-to-speech — so prompts, data, latency, and future
tool integrations stay fully under our control.

> **Status:** design approved, implementation starting. The complete plan lives
> in [`openspec/changes/add-voice-agent-mvp/`](openspec/changes/add-voice-agent-mvp/)
> (proposal → design → specs → 27 tasks). Sections below describe the target
> system defined by that plan.

---

## What it does

1. A client calls the support line. Twilio answers and streams the call audio
   to this service over a WebSocket (Media Streams).
2. The caller's language (et / ru / en) is detected from the first utterance;
   speech recognition, the agent's voice, and the conversation prompt are then
   locked to that language for the call.
3. The agent converses naturally — it listens, answers questions, handles
   interruptions (barge-in), and speaks the caller's language.
4. Every utterance is transcribed and persisted live (crash-safe).
5. On hangup, an LLM turns the transcript into a **structured note**: summary,
   caller intent, actions taken, unresolved issues, follow-ups, urgency.
6. Staff review calls, transcripts, and notes in a small admin UI.

**Explicitly not in v1** (planned follow-up): actions such as appointment
booking via a pluggable *skills* framework, human call escalation, consent
announcement flow, and retention automation. See
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

### Key design decisions

| Area | Choice | Why |
|---|---|---|
| Build approach | Custom orchestrator (not ElevenLabs Conversational AI) | Full control of prompts, data, latency, and future tools |
| Transport | `CallTransport` interface: **TwilioMediaStream** (prod) + **Browser** (dev) | 100% of the pipeline is shared; dev needs no telephony |
| STT | ElevenLabs **Scribe v2 Realtime** (pluggable adapter; Soniox/Gladia alternatives) | Streaming, ~150 ms partials, et/ru/en — but Estonian is only in ElevenLabs' "good" WER tier, so a bake-off decides the final provider |
| TTS | ElevenLabs **Eleven v3** (Azure `et-EE` fallback) | Flash v2.5 does **not** support Estonian; v3 covers all three languages |
| LLM | **OpenRouter**, model per role (conversation / summarizer / utility) + per-language overrides | All AI models are configurable without code changes |
| Languages | Hybrid detect-then-lock: detect on first utterance, lock STT + voice + prompt, re-detect on switch | Continuous auto-detect misfires on short Estonian utterances |
| Data | Transcripts only — **no raw call audio stored** | GDPR-minimal by design |
| Barge-in | VAD on caller audio → playback flush (<150 ms); mark-based clear on Twilio | Precise mid-sentence interruption |

The full rationale (with alternatives and risks) is in
[`openspec/changes/add-voice-agent-mvp/design.md`](openspec/changes/add-voice-agent-mvp/design.md).

---

## Tech stack

- **Runtime:** Node.js 22, TypeScript (strict)
- **HTTP + WebSocket:** Fastify (single server for TwiML webhook, media WS, admin UI, API)
- **Database:** PostgreSQL 16 (typed client: drizzle or kysely)
- **Voice providers:** ElevenLabs (Scribe v2 Realtime STT, Eleven v3 TTS); Twilio (PSTN + Media Streams)
- **LLM gateway:** OpenRouter (OpenAI-compatible streaming API)
- **Deploy:** Docker Compose (app + Postgres), self-hosted in an **EU region**
- **Spec-driven development:** [OpenSpec](https://github.com/Fission-AI/OpenSpec)

---

## Repository layout (target)

```
ai-voice-agent/
├── src/
│   ├── server.ts           # Fastify app: webhooks, WS, admin, API
│   ├── config/             # typed config (env + file), model-per-role map
│   ├── telephony/          # CallTransport interface
│   │   ├── twilio/         # TwiML webhook + Media Stream transport
│   │   └── browser-transport.ts  # dev transport (no Twilio)
│   ├── audio/              # μ-law↔PCM, resampling, VAD, playback queue
│   ├── stt/                # SttProvider interface + adapters (scribe, soniox, gladia)
│   ├── tts/                # TtsProvider interface + adapters (elevenlabs, azure)
│   ├── llm/                # OpenRouter client, model-per-role resolution
│   ├── agent/              # conversation manager, language manager, prompts
│   ├── notes/              # incremental transcript writer, post-call summarizer
│   ├── db/                 # schema, migrations, queries
│   ├── api/                # admin REST API
│   ├── web/                # admin pages + /dev/call harness
│   └── observability/      # per-stage latency logging
├── migrations/
├── scripts/                # bake-off (STT providers), OpenRouter conformance
├── test/                   # unit (golden audio fixtures), language, e2e
├── public/                 # dev-call page assets, admin assets
├── openspec/               # specs + change proposals (source of truth for scope)
└── docker-compose.yml
```

---

## Getting started (development)

### Prerequisites

- Node.js 22+
- Docker (for Postgres)
- API keys: [ElevenLabs](https://elevenlabs.io), [OpenRouter](https://openrouter.ai)
- Optional: Twilio account (only for real-call testing), Soniox / Gladia keys (only for the STT bake-off)

### Run locally

```bash
# 1. Install dependencies
npm install

# 2. Start Postgres
docker compose up -d postgres

# 3. Configure
cp .env.example .env        # fill in keys

# 4. Apply migrations + start the dev server
npm run migrate && npm run dev
```

### Talk to the agent from your browser (no Twilio needed)

The dev harness replaces telephony entirely during development:

1. Open `http://localhost:3000/dev/call` (requires `DEV_BROWSER_CALLS=true`).
2. Optionally set a fake caller number, choose **Microphone** or **Replay wav**.
3. Press **Start call** and speak — the page streams your voice to the same
   pipeline Twilio would feed, plays the agent's replies, and shows the live
   transcript.

The replay mode streams a fixture `.wav` (et/ru/en samples under
`test/fixtures/`) instead of your mic — this is how STT providers are compared
and how e2e tests drive calls in CI.

---

## Configuration

Everything external is configurable via environment (see `.env.example`).
Model ids are OpenRouter model strings; every role can be swapped freely.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP + WS port |
| `PUBLIC_BASE_URL` | — | Public https base URL used in TwiML (`https://host`) |
| `DATABASE_URL` | — | Postgres connection string |
| `DEV_BROWSER_CALLS` | `false` | Enable `/dev/call` + `/media/browser` (dev only!) |
| **Twilio** | | |
| `TWILIO_ACCOUNT_SID` | — | Account SID |
| `TWILIO_AUTH_TOKEN` | — | Used for request signature validation on `/twiml` |
| **STT** | | |
| `STT_PROVIDER` | `scribe` | `scribe` \| `soniox` \| `gladia` |
| `ELEVENLABS_API_KEY` | — | STT (Scribe) + TTS (Eleven v3) |
| `SONIOX_API_KEY` / `GLADIA_API_KEY` | — | Only for bake-off / alternative providers |
| **TTS** | | |
| `TTS_PROVIDER` | `elevenlabs` | `elevenlabs` \| `azure` |
| `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` | — | Fallback TTS provider |
| `TTS_VOICE_ET` / `TTS_VOICE_RU` / `TTS_VOICE_EN` | — | Voice id per language |
| **LLM (OpenRouter)** | | |
| `OPENROUTER_API_KEY` | — | OpenRouter API key |
| `LLM_CONVERSATION_MODEL` | — | Live agent brain |
| `LLM_SUMMARIZER_MODEL` | — | Post-call note generation |
| `LLM_UTILITY_MODEL` | — | Language detection, cheap classification |
| `LLM_CONVERSATION_MODEL_ET` / `_RU` / `_EN` | — | Optional per-language overrides |
| **Admin** | | |
| `ADMIN_USER` / `ADMIN_PASSWORD` | — | Basic auth for `/admin` + `/api` |

---

## Twilio setup (real calls)

1. Buy/use a Twilio number (sandbox is fine for dev; for a public Estonian
   line, +372 availability in Twilio's catalog is uncertain — fallback is a
   DID from a provider such as DIDWW/Telnyx trunked via **Elastic SIP
   Trunking**; this does not change the architecture).
2. Point the number's **voice webhook** to `https://<your-host>/twiml`
   (HTTP POST). For local dev, expose the service with `ngrok http 3000` and
   set `PUBLIC_BASE_URL` accordingly.
3. Ensure `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` are set — incoming
   `/twiml` requests are signature-validated and rejected otherwise.
4. Call the number: you should hear the agent greeting, and the call appears
   in the admin console after hangup.

---

## Testing & verification

| Level | What | How |
|---|---|---|
| Unit | Audio codecs (μ-law/PCM/resampling) against golden fixtures | `npm test` |
| Language | Detection correctness et/ru/en + code-switching fixtures | `npm test` |
| E2E | Full pipeline: fixture wav → transcript + structured note in Postgres | `npm run test:e2e` (drives the browser transport, no phone needed) |
| STT bake-off | WER + latency of Scribe vs Soniox vs Gladia on the same fixtures | `npm run bakeoff` (report emitted to console/file) |
| LLM conformance | Configured OpenRouter models: streaming + tool-call readiness | `npm run conformance` |
| Latency budget | Per-turn stage timings logged: STT finalize / LLM first token / TTS first byte | read logs; target end-to-end < 1 s |

---

## Deployment

- `docker compose up -d` (app + Postgres 16) on an **EU-region** host —
  proximity to Twilio's EU media gateways (Ireland) and ElevenLabs EU
  inference is part of the latency budget.
- Single instance; sessions are in-memory with incremental DB persistence as
  the recovery point. Multi-instance scaling is a deliberate non-goal for now.
- Secrets via environment only; `.env` files are git-ignored.

### GDPR notes

- Only **transcripts** are stored, never raw call audio.
- Transcripts are personal data: host in the EU, restrict admin access
  (basic auth in v1), and plan retention before production launch
  (retention automation + consent announcement are the first M4 items).

---

## Project management (OpenSpec)

Scope and specifications live in OpenSpec artifacts — they are the source of
truth, not this README:

```bash
openspec list                    # active changes
openspec show add-voice-agent-mvp
openspec validate add-voice-agent-mvp
```

- `openspec/config.yaml` — project context and conventions shown to AI agents
- `openspec/changes/add-voice-agent-mvp/` — current change:
  `proposal.md` (why/what), `design.md` (how, D1–D12 decisions),
  `specs/*/spec.md` (testable requirements), `tasks.md` (27 annotated tasks)
- `openspec/specs/` — capabilities, populated as changes are archived

### Roadmap

| Milestone | Scope | Status |
|---|---|---|
| M1 | Pipeline skeleton, browser dev harness, STT bake-off, Twilio transport | planned |
| M2 | Trilingual detection/locking, per-language prompts + voices, barge-in | planned |
| M3 | Notes pipeline (live transcripts, post-call summaries), admin UI | planned |
| M4 | Skills framework + actions (booking), human escalation, consent announcement, retention, latency dashboards | future change |
