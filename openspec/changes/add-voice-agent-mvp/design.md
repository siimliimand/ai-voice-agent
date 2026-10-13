## Context

voiceservice is a greenfield service: an AI support worker for inbound client calls, trilingual (Estonian, Russian, English), notes-first. Stakeholder decisions already fixed (see `openspec/config.yaml` context): custom orchestrator over Twilio Media Streams (not ElevenLabs Conversational AI); ElevenLabs Scribe v2 Realtime for STT and Eleven v3 for TTS; all LLMs via OpenRouter with configurable model-per-role; transcripts only, no audio storage; simple admin UI; self-hosted Docker Compose in an EU region.

Constraints that shaped the design:
- Estonian STT accuracy is the highest technical risk (ElevenLabs' own benchmarks place Estonian in its 10–25% WER "good" tier, not "excellent").
- Flash-class TTS does not support Estonian; Eleven v3 does but with higher latency.
- OpenRouter model behavior (streaming, tool calling) varies per model.
- Estonian–Russian code-switching is common among clients; language detection must be robust.
- Voice latency budget: end-of-speech → first audio byte back < 1 s.

## Goals / Non-Goals

**Goals:**
- A working end-to-end loop: caller speaks → agent replies, in et/ru/en, on both the browser dev transport and Twilio.
- Provider-swappable STT, TTS, and LLM behind narrow interfaces; every model reference configurable.
- Crash-safe live transcripts and post-call structured notes in Postgres.
- Browser dev mode that requires no telephony to iterate on prompts, languages, and notes.
- Per-stage latency timings logged on every turn.

**Non-Goals:**
- Skills framework / actions (booking), human escalation, consent announcement, retention automation, outbound calls, multi-instance scaling (all M4+).
- Raw call audio recording or storage (transcripts only).
- WebRTC (plain WebSocket over localhost is sufficient for dev).

## Decisions

### D1: Transport abstraction (`CallTransport`)
Both transports feed an identical `CallSession`. The interface carries session metadata (callSid, from number), inbound caller audio (16 kHz PCM frames), and outbound synth audio plus flush; Twilio-specific framing (μ-law 8 kHz base64 JSON events, marks, start/stop lifecycle) stays inside `TwilioMediaStreamTransport`.
*Why*: the browser harness (dev iteration + bake-off + e2e tests) and production telephony share 100% of the pipeline; codec and protocol differences stay isolated per transport.
*Alternatives*: Twilio-only first (slower iteration, no test rig); ElevenLabs Conversational AI (rejected: less control over prompts, data, and latency).

### D2: Audio format strategy
Telephony audio is 8 kHz μ-law (Twilio); the pipeline core runs on 16 kHz signed PCM. Conversion lives at the transport edge (μ-law↔PCM + resample). The browser captures 48 kHz mic audio and downsamples to 16 kHz in an AudioWorklet.
*Why*: STT/TTS providers accept PCM; keeping the core in PCM avoids double conversion, and isolating μ-law at the edge keeps codecs out of the agent path.

### D3: STT — pluggable adapter, default Scribe v2 Realtime
`SttProvider` interface: stream PCM in, receive partial/final transcript events out (+ language hints when available). The first utterance runs in auto-detect mode; after language lock, the adapter is (re)started pinned to the detected language. A bake-off script (`scripts/bakeoff`) runs fixture wavs through Scribe v2 Realtime vs Soniox vs Gladia and reports WER + latency; the default provider is configuration.
*Why*: Estonian accuracy is "good", not "excellent" — the adapter plus bake-off turns provider choice into a measured decision rather than a bet.

### D4: TTS — ElevenLabs Eleven v3, Azure fallback
`TtsProvider` interface: stream text (sentence-chunked) → PCM audio out. Eleven v3 (Conversational variant first) is the default since Flash v2.5 lacks Estonian. Latency is measured in M1; if first byte is consistently > ~500 ms, implement an Azure adapter (et-EE neural voices: less expressive, faster).
*Why*: v3 is the only ElevenLabs model family covering all three languages; a second adapter de-risks the latency budget.

### D5: LLM — OpenRouter, model per role
One OpenAI-compatible client; roles: `conversation`, `summarizer`, `utility` (language detection, cheap classification), each mapped to an OpenRouter model id via config/env, with optional per-language overrides for the conversation role. A conformance script asserts streaming (and later tool-call) behavior for every configured model.
*Why*: stakeholders require all models to be configurable; OpenRouter provides provider freedom without code changes, and the conformance script guards against per-model quirks.

### D6: Language handling — hybrid detect-then-lock
Turn 1: STT in auto/multilingual mode; the utility model classifies the first final transcript (et/ru/en, code-switch aware). The result locks STT language, TTS voice, and prompt variant. A rolling monitor watches for clear language switches or STT confidence collapse and re-locks. The agent always replies in the caller's language.
*Why*: continuous auto-detection misfires on short Estonian utterances; detect-once-then-lock is the robust standard pattern.

### D7: Barge-in — VAD + playback flush
While the playback queue is active, a lightweight VAD on caller audio detects speech; on trigger the queue flushes immediately (target < 150 ms from detection): Twilio via mark-based clear, browser via a `flush` control message. Mark events track playback boundaries.
*Why*: marks are Twilio's mechanism for precise mid-stream truncation; the same flush semantic maps trivially onto the browser transport.

### D8: Conversation manager
Per-call session state: locked language, message history, language-specific prompt variant (support-worker persona), streaming responses fed sentence-wise into TTS. No tool/function-calling loop in this change (skills are M4), but messages stay OpenAI-compatible so the tool loop drops in later.
*Why*: notes-first scope; keeping shapes OpenAI-compatible avoids rework when actions arrive.

### D9: Persistence — Postgres, incremental writes
Tables: `calls` (call_sid, from_number, language, status, started_at, ended_at, duration_s), `call_transcripts` (one row per utterance: call_id, speaker, text, language, at_ms), `call_notes` (call_id, note jsonb, model, created_at), `call_events` (audit of state transitions and provider errors). Utterances are written as they finalize (crash-safe); on hangup the summarizer runs as an in-process async job (no external queue at this scale) and upserts `call_notes`.
*Why*: transcripts-only storage is the stakeholder GDPR-minimality decision; per-utterance rows make crash recovery trivial; a job queue is unjustified for one in-process job.

### D10: Admin console — server-rendered, minimal
Fastify-served pages (call list + call detail) over a small JSON API, basic auth from env credentials, no frontend framework.
*Why*: staff only need to read notes; a framework is overhead at this scope.

### D11: Dev call harness
`/dev/call` page (served only when `DEV_BROWSER_CALLS=true`): mic capture (AudioWorklet 48k→16k), binary WS frames to `/media/browser`, Web Audio playback, fake CallSid/caller number, live transcript panel, and a wav-replay mode streaming fixture audio instead of mic input. Localhost exception covers mic permissions in dev.
*Why*: fastest iteration loop; doubles as bake-off rig (fixtures) and CI e2e harness.

### D12: Deployment
Docker Compose: app + Postgres 16. Single instance; sessions in memory with incremental DB persistence as the recovery point. EU-region host.
*Why*: matches stakeholder choice; proximity to Twilio EU media gateways and ElevenLabs EU inference keeps the latency budget reachable.

## Risks / Trade-offs

- [Estonian STT WER higher than desired] → adapter interface + M1 bake-off with real fixtures before committing; Soniox/Gladia as fallbacks; keyterm boosting where supported.
- [Eleven v3 TTS latency over budget] → sentence-chunked streaming; measure in M1; Azure et-EE adapter as fallback (less expressive).
- [OpenRouter per-model streaming/tool quirks] → conformance script in the workflow; pin model ids in config; per-language overrides.
- [et↔ru code-switching breaks detection] → fixture-based tests in M2; rolling-window utility-model classification; manual language pinning via dev harness for testing.
- [WS drop mid-call loses conversation state] → per-utterance persistence bounds loss; session rebuild on reconnect is best-effort — a graceful apology + hangup is acceptable for MVP.
- [In-memory sessions limit scale] → accepted for MVP (single instance); Redis-backed sessions deferred to M4+.
- [μ-law/PCM conversion bugs are hard to spot] → golden-fixture unit tests; the dev harness makes the whole path audible early.

## Migration Plan

Greenfield — no migration. Deploy: `docker compose up` on an EU host; point the Twilio number's voice webhook at `POST {BASE_URL}/twiml`; secrets via env. Rollback = stop containers; Postgres persists independently.

## Open Questions

- +372 number acquisition (Twilio catalog vs DID provider + Elastic SIP Trunking) — decided at launch; no architectural impact.
- Final STT provider and OpenRouter model ids — resolved by the M1 bake-off/conformance runs.
- Per-language voice selection (Eleven v3 library voices vs a recorded brand voice) — stakeholder taste, tunable in config.
