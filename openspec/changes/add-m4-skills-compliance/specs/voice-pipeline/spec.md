# Spec Delta

## ADDED Requirements

### Requirement: Consent-gated transcription
When the consent announcement is enabled, the pipeline SHALL start in a gated state in which caller audio is not transcribed into the call transcript and not persisted. The sole pre-consent recognition SHALL be the consent-reply detection, which runs in an isolated, ephemeral stream used only for the consent decision (and the caller-language vote); its output SHALL be discarded afterwards. The main STT stream SHALL start only after consent is granted, and a declined consent SHALL leave the call untranscribed for its entire duration.

#### Scenario: Audio before the consent outcome is not transcribed
- **WHEN** caller audio arrives before consent is decided
- **THEN** it is not transcribed into the call transcript nor persisted (the ephemeral consent-reply detection output is discarded once the decision is made)

#### Scenario: Consent granted unlocks transcription
- **WHEN** consent is granted
- **THEN** the main STT stream starts and subsequent caller audio is transcribed and persisted as usual

#### Scenario: Consent declined keeps the call untranscribed
- **WHEN** the caller declines consent
- **THEN** no audio from that call is ever transcribed into the call transcript or persisted
