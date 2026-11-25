-- The built-in domains' circuit breaker (src/builtin-domain.ts builtinBreaker). All built-in domains sign with one parent
-- (nightmail.email), so their combined bounces and complaints are that domain's reputation. When they reach SES's own
-- warning lines the breaker trips: built-in sending stops everywhere (ok=false, problem='reputation', every built-in
-- claim back to pending, as when the parent identity fails its check) and stays stopped, whatever the identity's check
-- finds, until an operator resets it (scripts/builtin-domain.ts reset-breaker).
--   tripped_at, trip: when it tripped and the counts it saw. reset_at: the last reset; the breaker counts only mail
--   sent since, so the mail that tripped it can't trip it again. rates_checked_at: its last count (hourly).
ALTER TABLE builtin_parent ADD COLUMN tripped_at timestamptz, ADD COLUMN trip jsonb, ADD COLUMN reset_at timestamptz, ADD COLUMN rates_checked_at timestamptz;
