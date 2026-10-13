## Why

Clients of the support line need answers outside staffed hours, and staff need every call documented without manual note-taking. An AI support worker that answers inbound calls, speaks the client's language (Estonian, Russian, English), and automatically produces structured call notes removes both gaps. We build it as our own orchestrator (not a managed agent platform) to keep full control of prompts, data, latency, and future tool integrations.

## What Changes

- New greenfield Node.js 22 + TypeScript service orchestrating the full voice loop: Twilio Media Streams → STT → LLM → TTS → caller.
- `CallTransport` abstraction with two implementations: production Twilio Media Streams transport and a dev-only browser transport (mic → WebSocket → pipeline, no Twilio), which also serves as the STT bake-off rig and e2e test harness.
- Pluggable STT (default ElevenLabs Scribe v2 Realtime) and TTS (default ElevenLabs Eleven v3) adapters behind provider interfaces.
- LLM access via OpenRouter with model-per-role configuration (conversation / summarizer / utility) and optional per-language overrides.
- Trilingual operation: hybrid language detection on the first utterance, then lock STT, voice, and prompt variant for the call; re-detect on language switch.
- Barge-in: caller speech interrupts agent playback (VAD + playback flush; mark-based on Twilio).
- Notes pipeline: incrementally persisted live transcripts (crash-safe), post-call LLM summarization into a structured note (summary, intents, actions, follow-ups, urgency), stored in Postgres. No raw call audio is stored.
- Simple staff-facing admin UI: call list, call detail with transcript and note, basic auth.
- Docker Compose deployment (app + Postgres).

## Capabilities

### New Capabilities
- `telephony-transport`: Answering inbound calls via Twilio (TwiML + Media Streams WebSocket) and the transport abstraction, including the dev-only browser transport with wav replay.
- `voice-pipeline`: Audio format handling (μ-law/PCM), streaming STT and TTS adapters, playback queue, barge-in, per-stage latency logging.
- `conversation-agent`: LLM conversation loop over OpenRouter, model-per-role configuration, language detection/locking, trilingual prompts and voices.
- `call-notes`: Live transcript persistence and post-call structured note generation with storage in Postgres.
- `admin-console`: Staff web UI for reviewing calls, transcripts, and notes.

### Modified Capabilities

(none — greenfield project, no existing specs)

## Impact

- **Code**: entire repo is new (`src/` split into server, config, telephony, audio, stt, tts, llm, agent, notes, db, api, web; plus migrations, test, scripts, Dockerfile, docker-compose.yml).
- **External services**: requires Twilio account (number + Media Streams), ElevenLabs API key (Scribe v2 Realtime + Eleven v3), OpenRouter API key; optional Soniox/Gladia keys for the STT bake-off; Postgres 16.
- **Data**: new Postgres schema (`calls`, `call_transcripts`, `call_notes`, `call_events`); transcripts are personal data (GDPR) — EU hosting required.
- **Ops**: single self-hosted instance; dev needs ngrok (or equivalent tunnel) for Twilio sandbox testing.

## Non-goals

Deferred to a follow-up change (milestone M4): skills framework and actions (e.g. appointment booking), human call escalation, consent announcement flow (**required before production launch**), GDPR retention automation, latency dashboards/metrics endpoint, outbound calling.

Milestones covered: M1 (pipeline + dev harness + bake-off + Twilio transport), M2 (trilingual + barge-in), M3 (notes + admin UI).
