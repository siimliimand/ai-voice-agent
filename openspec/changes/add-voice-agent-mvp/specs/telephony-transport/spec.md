## ADDED Requirements

### Requirement: Inbound call answering
The system SHALL expose a `POST /twiml` endpoint that returns TwiML instructing Twilio to connect the inbound call as a bidirectional Media Stream to the service's WebSocket endpoint.

#### Scenario: Twilio requests TwiML for an inbound call
- **WHEN** Twilio POSTs to `/twiml` for an inbound voice call with a valid Twilio signature
- **THEN** the service responds with TwiML containing `<Connect><Stream>` pointing at the service's media WebSocket

#### Scenario: Request with invalid Twilio signature
- **WHEN** a request to `/twiml` fails Twilio signature validation
- **THEN** the service responds with 403 and does not start a call session

### Requirement: Media stream session lifecycle
The system SHALL create a call session on the Twilio `start` event (keyed by CallSid) and deliver all `media` events to the pipeline; on `stop` or socket close, the session SHALL be finalized.

#### Scenario: Call starts and audio flows
- **WHEN** a Twilio media WebSocket connects and sends `start` followed by `media` events
- **THEN** a session is created with the CallSid and caller number, and inbound audio is decoded and delivered to the pipeline

#### Scenario: Caller hangs up
- **WHEN** Twilio sends the `stop` event or the WebSocket closes
- **THEN** the session is finalized, playback ceases, and the post-call flow (note generation) is triggered

### Requirement: Browser dev transport
When `DEV_BROWSER_CALLS=true`, the system SHALL serve a `/dev/call` page and a `/media/browser` WebSocket carrying 16 kHz PCM binary frames and JSON control messages, creating sessions with a synthetic CallSid and a configurable fake caller number.

#### Scenario: Developer starts a fake call from the browser
- **WHEN** the developer presses "Start call" on `/dev/call` and grants microphone access
- **THEN** a session is created with a synthetic CallSid and mic audio streams into the pipeline exactly as telephony audio would

#### Scenario: Browser transport disabled
- **WHEN** `DEV_BROWSER_CALLS` is not `true`
- **THEN** `/dev/call` and `/media/browser` return 404 and no browser sessions can be created

### Requirement: Wav replay mode
The dev call page SHALL offer a replay mode that streams a selected fixture .wav file into the pipeline in place of microphone input.

#### Scenario: Replaying a fixture call
- **WHEN** the developer selects a fixture wav and starts a call in replay mode
- **THEN** the fixture audio streams frame-by-frame at real-time pace and produces transcripts and agent replies like live speech
