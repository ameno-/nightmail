SET LOCAL lock_timeout = '2s';
-- SMTP refusals (src/smtp-refusals.ts): each time the API refused a mail app's submission through the SMTP gateway, the
-- workspace of the credential that signed in, the reply the gateway gave the app (its SMTP code and text) with the API's
-- error code, and the recipients' domains. Never an address, a subject or message content. The support agent and staff
-- read them (GET /v1/support/smtp/refusals); the hourly retention deletes rows older than 7 days.
CREATE TABLE smtp_refusals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  reply_code text NOT NULL CHECK (reply_code ~ '^[45][0-9]{2} [45]\.[0-9]{1,3}\.[0-9]{1,3}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 400),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9_]{1,64}$'),
  recipient_domains text[] NOT NULL DEFAULT '{}' CHECK (cardinality(recipient_domains) <= 100)
);
CREATE INDEX smtp_refusals_workspace ON smtp_refusals (workspace_id, at DESC);
CREATE INDEX smtp_refusals_at ON smtp_refusals (at);
