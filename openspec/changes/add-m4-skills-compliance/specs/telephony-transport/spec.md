# Spec Delta

## ADDED Requirements

### Requirement: Consent announcement at call start
When consent is enabled (default on), the system SHALL play a spoken consent notice at the start of the call — before any transcription — using per-language notice text (et/ru/en), and SHALL interpret the caller's spoken reply as granting or declining. The outcome SHALL be recorded for the call; a decline SHALL be answered with a polite goodbye and the call ended with the session marked `consent_declined`.

#### Scenario: Caller grants consent
- **WHEN** the caller affirmatively answers the consent notice
- **THEN** the call proceeds normally and the granted outcome is recorded

#### Scenario: Caller declines consent
- **WHEN** the caller answers the consent notice negatively
- **THEN** the agent says a polite goodbye, hangs up, and the session is marked `consent_declined`

#### Scenario: Consent announcement disabled
- **WHEN** the consent toggle is off in configuration
- **THEN** no notice is played and the call starts transcribing immediately

### Requirement: Escalation call flow
On escalation the flow SHALL follow the transport: the Twilio path SHALL speak an announcement to the caller and then redirect the media-stream call via TwiML to `<Dial>` a configurable staff number; the browser/dev path SHALL speak the announcement, mark the session escalated, and end the call.

#### Scenario: Twilio call is transferred to staff
- **WHEN** escalation triggers on a Twilio call
- **THEN** the caller hears the announcement and the call is handed to the configured staff number via a TwiML `<Dial>` redirect

#### Scenario: Browser call escalates
- **WHEN** escalation triggers on a browser/dev call
- **THEN** the announcement plays, the session is marked escalated, and the call ends
