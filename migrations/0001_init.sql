-- 0001_init: calls, call_transcripts, call_notes, call_events.

CREATE TABLE IF NOT EXISTS calls (
    id BIGSERIAL PRIMARY KEY,
    call_sid TEXT NOT NULL UNIQUE,
    from_number TEXT NOT NULL,
    to_number TEXT,
    provider TEXT NOT NULL DEFAULT 'twilio',
    language TEXT,
    status TEXT NOT NULL DEFAULT 'in_progress'
        CHECK (status IN ('in_progress', 'completed', 'failed')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    duration_s INTEGER
);

CREATE TABLE IF NOT EXISTS call_transcripts (
    id BIGSERIAL PRIMARY KEY,
    call_id BIGINT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    speaker TEXT NOT NULL CHECK (speaker IN ('caller', 'agent')),
    text TEXT NOT NULL,
    language TEXT,
    at_ms INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS call_transcripts_call_id_id_idx
    ON call_transcripts (call_id, id);

CREATE TABLE IF NOT EXISTS call_notes (
    call_id BIGINT PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
    note JSONB NOT NULL,
    model TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS call_events (
    id BIGSERIAL PRIMARY KEY,
    call_id BIGINT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    detail JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS call_events_call_id_idx
    ON call_events (call_id);
