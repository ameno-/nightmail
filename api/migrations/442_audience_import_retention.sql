SET LOCAL lock_timeout = '2s';

-- Support's audienceHealth import view reads up to 2,000 opaque contact IDs (no addresses/PII) per committed import
-- for 90 days, letting maintenance scrub raw 50,000-row CSV payloads (rows JSONB) after the retention window without
-- losing first-send bounce/complaint diagnosis or leaving legacy imports without a sample before backfill completes.
ALTER TABLE audience_imports
  ADD COLUMN IF NOT EXISTS sample_contact_ids text[],
  ADD COLUMN IF NOT EXISTS consent_linked_at timestamptz,
  ADD COLUMN IF NOT EXISTS rows_scrubbed_at timestamptz,
  ADD COLUMN IF NOT EXISTS errors_scrubbed_at timestamptz;

ALTER TABLE audience_consent_audit
  ADD COLUMN IF NOT EXISTS import_id text;
