## ADDED Requirements

### Requirement: LLM conversation loop
The system SHALL hold a per-call conversation with message history and a support-worker system prompt, streaming model responses into the TTS pipeline via an OpenRouter-compatible (OpenAI-compatible) API.

#### Scenario: Caller asks a question
- **WHEN** a final caller utterance arrives
- **THEN** the conversation manager appends it to history, streams a reply from the configured conversation model, and the reply is spoken in the caller's language

### Requirement: Model-per-role configuration
The system SHALL resolve every LLM usage (conversation, summarizer, utility) from configuration, with each role's model overridable via env/config, including per-language overrides for the conversation role.

#### Scenario: Operator changes the conversation model
- **WHEN** the operator sets a new model id for the conversation role in configuration
- **THEN** subsequent calls use that model without code changes

### Requirement: Language detection and locking
The system SHALL detect the caller's language (et, ru, en) from the first utterance using STT auto-detection plus utility-model classification, then lock STT language, TTS voice, and prompt variant for the call; the system SHALL re-detect when the caller switches language.

#### Scenario: First utterance determines call language
- **WHEN** the caller's first utterance is classified as Russian
- **THEN** the agent replies in Russian and subsequent STT runs pinned to ru

#### Scenario: Caller switches language mid-call
- **WHEN** the caller switches from Estonian to Russian and the switch is detected
- **THEN** the agent continues in Russian with the Russian prompt variant and voice
