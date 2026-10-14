# Spec Delta

## ADDED Requirements

### Requirement: Metrics endpoint
The system SHALL expose `GET /api/metrics`, protected by admin basic authentication, returning a JSON document with in-process counters, per-stage latency percentiles (p50/p95) for STT, LLM, TTS, and end-to-end turn time, call counts by status, error counts, and the number of active sessions.

#### Scenario: Authenticated metrics read
- **WHEN** an authenticated client requests `GET /api/metrics`
- **THEN** the response is JSON containing latency percentiles for all four stages, per-status call counts, error counts, and the active session count

#### Scenario: Unauthenticated metrics request
- **WHEN** a request without valid admin credentials hits `GET /api/metrics`
- **THEN** it is rejected with 401
