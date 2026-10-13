# Tasks: add-voice-agent-mvp

<!-- Agent note: only `fullstack-engineer` exists in .opencode/agents/ (no specialists yet), so all tasks use it with a tier suffix. Operator dependencies: task 3.5 needs Soniox/Gladia API keys for the bake-off; task 8.3 needs a Twilio account + sandbox number + tunnel. -->

## 1. Foundation (M1)

- [x] 1.1 Scaffold Node 22 + TypeScript project: package.json, strict tsconfig, ESLint + Prettier, src/ layout, Fastify server with /health, typed config loader (env + file; every model/provider reference overridable) <!-- agent: fullstack-engineer.build, depends_on: [], touches: [package.json, tsconfig.json, eslint.config.js, .prettierrc, src/server.ts, src/config/**] -->
- [x] 1.2 Dockerfile + docker-compose.yml (app + Postgres 16), .env.example with all keys/model refs, README quick-start <!-- agent: fullstack-engineer.fast, depends_on: [1.1], touches: [Dockerfile, docker-compose.yml, .env.example, README.md] -->

## 2. Audio + dev call harness (M1)

- [x] 2.1 Audio codec utilities: μ-law↔PCM decode/encode, 8k↔16k resampler, PCM framing helpers, with golden-fixture unit tests <!-- agent: fullstack-engineer.build, depends_on: [1.1], touches: [src/audio/**, test/audio/**] -->
- [x] 2.2 CallTransport interface + CallSession lifecycle (session metadata, inbound audio in, synth audio + flush out, session events) <!-- agent: fullstack-engineer.build, depends_on: [1.1], touches: [src/telephony/transport.ts, src/session/**] -->
- [x] 2.3 BrowserTransport: /media/browser WebSocket (binary PCM in/out, JSON control messages), synthetic CallSid + fake caller number from config <!-- agent: fullstack-engineer.build, depends_on: [2.2], touches: [src/telephony/browser-transport.ts, src/config/**] -->
- [x] 2.4 /dev/call page (DEV_BROWSER_CALLS-gated): mic capture via AudioWorklet (48k→16k), WS streaming, Web Audio playback, call/hangup controls, fake-number field, live transcript panel <!-- agent: fullstack-engineer.build, depends_on: [2.3], touches: [src/web/dev-call/**, public/dev/**] -->
- [x] 2.5 Wav replay mode in dev page + et/ru/en fixture recordings committed under test/fixtures <!-- agent: fullstack-engineer.build, depends_on: [2.4], touches: [public/dev/**, test/fixtures/**] -->

## 3. Voice pipeline (M1)

- [x] 3.1 SttProvider interface + ElevenLabs Scribe v2 Realtime adapter (streaming partials/finals, auto-detect then pinned language) <!-- agent: fullstack-engineer.build, depends_on: [1.1], touches: [src/stt/**] -->
- [x] 3.2 TtsProvider interface + ElevenLabs Eleven v3 streaming adapter (sentence chunking, first-byte timing) <!-- agent: fullstack-engineer.build, depends_on: [1.1], touches: [src/tts/**] -->
- [x] 3.3 Playback queue with mark tracking and flush() support <!-- agent: fullstack-engineer.build, depends_on: [2.2, 3.2], touches: [src/audio/playback-queue.ts] -->
- [x] 3.4 Pipeline assembly: caller audio → STT → utterance events; reply text → TTS → transport playback <!-- agent: fullstack-engineer.build, depends_on: [3.1, 3.3], touches: [src/pipeline/**] -->
- [x] 3.5 STT bake-off script: run fixtures through Scribe v2 Realtime / Soniox / Gladia adapters, emit WER + latency report (needs provider keys) <!-- agent: fullstack-engineer.build, depends_on: [2.5, 3.1], touches: [scripts/bakeoff/**, src/stt/**] -->
- [x] 3.6 Per-stage latency logging on every turn (STT finalize, LLM first token, TTS first byte, end-to-end) <!-- agent: fullstack-engineer.fast, depends_on: [3.4], touches: [src/pipeline/**, src/observability/**] -->

## 4. Conversation agent (M1)

- [x] 4.1 OpenRouter client (OpenAI-compatible streaming) + model-per-role config: conversation / summarizer / utility, with per-language overrides <!-- agent: fullstack-engineer.build, depends_on: [1.1], touches: [src/llm/**, src/config/**] -->
- [x] 4.2 Conversation manager: per-call history, support-worker persona system prompt, streaming replies fed sentence-wise into TTS <!-- agent: fullstack-engineer.build, depends_on: [3.4, 4.1], touches: [src/agent/**] -->
- [x] 4.3 OpenRouter conformance script: verify streaming + tool-call readiness of every configured model id <!-- agent: fullstack-engineer.fast, depends_on: [4.1], touches: [scripts/conformance/**] -->
- [ ] 4.4 Verify English-only round trip in browser harness: speak → spoken reply; end-to-end latency within the 1 s budget <!-- agent: fullstack-engineer.fast, depends_on: [4.2], touches: [] -->

## 5. Trilingual operation (M2)

- [x] 5.1 LanguageManager: detect language on first utterance (STT auto-detect + utility-model vote), lock STT language + voice + prompt variant, re-detect on switch or low confidence <!-- agent: fullstack-engineer.build, depends_on: [4.2], touches: [src/agent/language-manager.ts, src/llm/**, src/stt/**] -->
- [x] 5.2 Per-language system prompt variants (et/ru/en) + trilingual opening greeting <!-- agent: fullstack-engineer.build, depends_on: [5.1], touches: [src/agent/prompts/**] -->
- [x] 5.3 Per-language TTS voice mapping in config + voice hot-swap on lock/re-lock <!-- agent: fullstack-engineer.fast, depends_on: [5.1], touches: [src/config/**, src/tts/**] -->
- [x] 5.4 Language tests with fixtures: detection correctness for et/ru/en + et↔ru code-switching samples <!-- agent: fullstack-engineer.build, depends_on: [5.1, 2.5], touches: [test/language/**] -->

## 6. Barge-in (M2)

- [x] 6.1 VAD on caller audio + speech-while-playing detection triggering playback queue flush <!-- agent: fullstack-engineer.build, depends_on: [3.3], touches: [src/audio/vad.ts, src/pipeline/**] -->
- [x] 6.2 Browser flush control message: stop Web Audio playback immediately on flush <!-- agent: fullstack-engineer.build, depends_on: [6.1], touches: [src/web/dev-call/**, public/dev/**] -->

## 7. Notes + persistence (M3)

- [x] 7.1 Postgres schema + migrations (calls, call_transcripts, call_notes, call_events) + typed DB client (drizzle or kysely) <!-- agent: fullstack-engineer.build, depends_on: [1.1], touches: [src/db/**, migrations/**, docker-compose.yml] -->
- [x] 7.2 Incremental transcript writer: persist each finalized utterance during the call (crash-safe) <!-- agent: fullstack-engineer.build, depends_on: [7.1, 3.4], touches: [src/notes/**, src/pipeline/**] -->
- [x] 7.3 Post-call summarizer: on hangup, summarizer model → structured note JSON (summary, language, intents, actions, unresolved, follow-ups, urgency) → call_notes <!-- agent: fullstack-engineer.build, depends_on: [7.1, 4.1], touches: [src/notes/summarizer.ts, src/llm/**] -->
- [x] 7.4 Session lifecycle wiring: create calls row on session start; finalize status/duration on hangup; trigger note job <!-- agent: fullstack-engineer.build, depends_on: [7.2, 7.3], touches: [src/session/**] -->
- [x] 7.5 E2E test: fixture wav call through browser transport → assert transcript rows + structured note in DB <!-- agent: fullstack-engineer.build, depends_on: [7.4, 2.5], touches: [test/e2e/**] -->

## 8. Twilio transport

<!-- Placed after the pipeline is proven in the browser, per the agreed M1 sequence. -->

- [x] 8.1 POST /twiml webhook returning <Connect><Stream> TwiML + Twilio signature validation (403 on mismatch) <!-- agent: fullstack-engineer.build, depends_on: [2.2], touches: [src/telephony/twilio/**] -->
- [x] 8.2 TwilioMediaStreamTransport: connected/start/media/mark/stop events, μ-law↔PCM via 2.1, outbound audio + marks, mark-based barge-in clear <!-- agent: fullstack-engineer.build, depends_on: [8.1, 2.1, 3.3, 6.1], touches: [src/telephony/twilio/media-stream.ts] -->
- [ ] 8.3 Real-call smoke test via Twilio sandbox + ngrok: audio round trip, barge-in, hangup finalization (needs Twilio account) <!-- agent: fullstack-engineer.fast, depends_on: [8.2, 4.2], touches: [] -->

## 9. Admin console (M3)

- [x] 9.1 Admin REST API: GET /api/calls (paginated list), GET /api/calls/:id (transcript + note) <!-- agent: fullstack-engineer.build, depends_on: [7.1], touches: [src/api/**] -->
- [x] 9.2 Admin UI pages: call list (time, number, language, duration, note excerpt) + call detail (transcript + structured note) <!-- agent: fullstack-engineer.build, depends_on: [9.1], touches: [src/web/admin/**, public/admin/**] -->
- [x] 9.3 Basic auth on /admin and /api from env credentials (401 otherwise) <!-- agent: fullstack-engineer.fast, depends_on: [9.1], touches: [src/server.ts, src/auth/**] -->

## 10. Hardening + docs

- [x] 10.1 Graceful shutdown (drain active sessions), WS drop recovery, per-call error isolation (one failing call must not affect others) <!-- agent: fullstack-engineer.build, depends_on: [8.2], touches: [src/telephony/**, src/session/**, src/server.ts] -->
- [x] 10.2 Run full verification: typecheck + lint + unit tests + e2e test green; fix all findings <!-- agent: fullstack-engineer.fast, depends_on: [8.3, 9.2, 10.1], touches: [] -->
- [x] 10.3 README final: architecture overview, full config reference, dev workflow (browser call + bake-off), deploy guide (Compose, EU region), Twilio setup <!-- agent: fullstack-engineer.fast, depends_on: [1.2, 10.2], touches: [README.md, docs/**] -->

## 11. Admin config page (added post-review — DB-backed live-apply per operator decision)

- [x] 11.1 Settings persistence: settings table migration + typed DB access + effective-config resolution (defaults/file/env ← DB overrides, zod-validated) wired into session start + notes pipeline + basic-auth (live-apply to new calls; infra vars read-only) <!-- agent: fullstack-engineer.build, touches: [migrations/**, src/db/**, src/config/**, src/app.ts, src/notes/**, src/auth/**] -->
- [x] 11.2 Settings API: GET /api/settings (sanitized view: secrets masked, per-field source annotation) + PUT /api/settings (zod-validated partial, infra fields rejected) + shared editable-fields contract module <!-- agent: fullstack-engineer.build, touches: [src/api/**, src/config/**] -->
- [x] 11.3 Admin settings UI: server-rendered /admin/settings form (grouped sections, typed inputs, write-only secret fields, DB-override badges + per-field reset, restart-required flags) <!-- agent: fullstack-engineer.build, touches: [src/web/admin/**] -->
- [x] 11.4 Verification + docs: full gates green (typecheck, lint, all tests incl. new settings tests), README config/settings section update <!-- agent: fullstack-engineer.fast, touches: [README.md] -->
