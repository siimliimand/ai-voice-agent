-- 0003_m4_skills_compliance: M4 compliance columns on calls.
-- consent: outcome of the spoken consent notice (null = not asked / flow off).
-- escalated: the call was handed off to a human. Both are denormalized onto
-- calls so they show in the existing call list without joining call_events
-- (the audit rows live there: consent_granted/declined, escalation_triggered).
-- Additive only; safe to re-run.

ALTER TABLE calls ADD COLUMN IF NOT EXISTS consent TEXT
    CHECK (consent IN ('granted', 'declined'));

ALTER TABLE calls ADD COLUMN IF NOT EXISTS escalated BOOLEAN NOT NULL DEFAULT false;
