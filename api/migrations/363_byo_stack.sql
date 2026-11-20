SET LOCAL lock_timeout='1s';
-- The connected account's CloudFormation stack, as its own requests report it (byo-regional.ts, stackNotification), and
-- why Nightmail last refused it, shown in setup.
ALTER TABLE provider_connections ADD COLUMN stack_id text, ADD COLUMN stack_template_version text, ADD COLUMN stack_deleted_at timestamptz, ADD COLUMN stack_error text;
