# call-notes Specification

## Purpose
TBD - created by archiving change add-voice-agent-mvp. Update Purpose after archive.

## Requirements

### Requirement: Call records
The system SHALL persist a row per call (Twilio CallSid or synthetic id, caller number, status, started/ended timestamps, duration, detected language) in Postgres. The system MUST NOT store raw call audio.

#### Scenario: Call completes
- **WHEN** a call ends
- **THEN** its `calls` row shows final status, duration, and language, and no audio artifacts exist anywhere in storage

### Requirement: Live transcript persistence
The system SHALL persist each finalized utterance (speaker, text, language, offset) incrementally during the call so that a crash loses at most the utterance in progress.

#### Scenario: Service crashes mid-call
- **WHEN** the service restarts after a mid-call crash
- **THEN** all utterances finalized before the crash are present in the database

### Requirement: Post-call note generation
On call end, the system SHALL generate a structured note via the configured summarizer model — summary, detected language, caller intents, actions taken, unresolved issues, follow-ups, urgency/sentiment — and store it against the call.

#### Scenario: Note appears after hangup
- **WHEN** a call ends
- **THEN** a structured note (valid JSON with the required fields) is stored for that call and is visible in the admin console
