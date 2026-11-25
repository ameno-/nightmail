-- List hygiene (src/list-hygiene.ts): a contact's risk (invalid, disposable, typo_domain, role or dead; NULL when none), whether
-- its owner allowed it anyway, an import's risk summary, and the state of the hourly pass that classifies existing contacts.
-- Nullable columns and a constant default: metadata only, no rewrite of audience_contacts.
SET LOCAL lock_timeout = '2s';
ALTER TABLE audience_contacts ADD COLUMN IF NOT EXISTS risk text, ADD COLUMN IF NOT EXISTS risk_allowed boolean NOT NULL DEFAULT false;
ALTER TABLE audience_imports ADD COLUMN IF NOT EXISTS risk_summary jsonb;
CREATE TABLE IF NOT EXISTS audience_hygiene_state (
  id text PRIMARY KEY,
  version text NOT NULL,
  cursor text,
  started_at timestamptz,
  finished_at timestamptz,
  lease_until timestamptz
);
