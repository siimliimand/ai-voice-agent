# voice-pipeline Specification

## Purpose
TBD - created by archiving change add-voice-agent-mvp. Update Purpose after archive.

## Requirements

### Requirement: Pluggable STT adapter
The system SHALL convert caller audio to transcripts through an `SttProvider` interface; the default provider SHALL be ElevenLabs Scribe v2 Realtime, selectable via configuration, supporting partial and final transcript events and pinned languages (et, ru, en).

#### Scenario: Caller speech becomes a final transcript
- **WHEN** the caller finishes an utterance and the STT provider emits a final transcript
- **THEN** the pipeline forwards the utterance (text, language, timing) to the conversation manager and persists it

### Requirement: Streaming TTS output
The system SHALL synthesize agent replies through a `TtsProvider` interface (default ElevenLabs Eleven v3), streaming sentence-sized chunks so playback begins before full-reply synthesis completes.

#### Scenario: Agent reply is spoken
- **WHEN** the LLM produces reply text
- **THEN** sentences are synthesized incrementally and audio plays on the transport before the full reply has finished synthesizing

### Requirement: Barge-in
The system SHALL detect caller speech while agent audio is playing and flush pending playback immediately (target < 150 ms from detection), using mark-based clearing on Twilio and a flush control message on the browser transport.

#### Scenario: Caller interrupts agent speech
- **WHEN** the caller starts speaking while the agent's audio is playing
- **THEN** remaining playback is flushed, the transport stops audible output, and the agent listens; the interrupted reply is not continued

### Requirement: Per-stage latency logging
The system SHALL log, for every conversational turn, the elapsed time of STT finalization, LLM first token, and TTS first audio byte, plus the end-to-end total.

#### Scenario: Turn completes
- **WHEN** a turn finishes (from end of caller speech to first audio byte back)
- **THEN** a log entry records the three stage durations and the end-to-end total
