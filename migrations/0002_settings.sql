-- 0002_settings: DB-backed runtime settings for the admin console.
-- One row per settings document; the admin surface uses key='global'. The
-- value is a nested JSON object of config overrides (dotted paths merged),
-- deep-merged over the startup config for every NEW call (live-apply).

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
