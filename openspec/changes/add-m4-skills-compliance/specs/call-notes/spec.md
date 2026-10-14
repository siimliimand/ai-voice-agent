# Spec Delta

## ADDED Requirements

### Requirement: Consent and escalation status recording
The call record SHALL capture the consent outcome (granted or declined, when consent applies) and whether the call was escalated to a human, so both are visible on the stored call and in the admin console.

#### Scenario: Declined call is marked
- **WHEN** a caller declines consent and the call ends
- **THEN** the call's record shows `consent_declined` as its outcome

#### Scenario: Escalated call is marked
- **WHEN** a call is escalated to a human
- **THEN** the call's record shows it as escalated

### Requirement: Escalated note handling
For escalated calls the system SHALL record the escalation among the note's actions taken and SHALL force the note's urgency to high regardless of the summarizer's own judgment.

#### Scenario: Escalation forces high urgency
- **WHEN** an escalated call is summarized
- **THEN** the stored note lists the escalation among the actions taken and its urgency is high

### Requirement: GDPR retention automation
With retention enabled, the system SHALL run a scheduled in-process job (at startup and on a daily tick) that deletes `call_transcripts` and `call_notes` older than the configured retention period (default 90 days) while keeping the `calls` rows anonymized — caller number replaced by a hashed/prefixed value — and SHALL log each run's outcome to `call_events`. Retention settings SHALL be editable through the runtime settings system.

#### Scenario: Aged data is deleted and anonymized
- **WHEN** the retention job runs with data older than the retention period
- **THEN** those calls' transcripts and notes are deleted, their `calls` rows remain with anonymized caller numbers, and the run is logged to `call_events`

#### Scenario: Retention disabled
- **WHEN** retention is disabled in configuration
- **THEN** the job deletes nothing

#### Scenario: Operator changes the retention period
- **WHEN** the operator changes the retention days via the runtime settings
- **THEN** subsequent job runs apply the new period without a restart
