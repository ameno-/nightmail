SET LOCAL lock_timeout='2s';
-- Required notices (src/sending.ts requiredNotice): a campaign that goes to everyone in its audience who is not
-- suppressed, people who unsubscribed from marketing included, and carries no unsubscribe link. It ignores an opt-out,
-- so it is off for every workspace until an operator turns it on (scripts/set-required-notices.ts, audited here).
ALTER TABLE workspaces ADD COLUMN required_notices boolean NOT NULL DEFAULT false;
-- Our own first-party workspaces (exempt_hosted_quotas, set only by an operator) start with it on.
WITH changed AS (UPDATE workspaces SET required_notices=true WHERE exempt_hosted_quotas RETURNING id)
INSERT INTO hosted_operator_audit(workspace_id,action,details)
  SELECT id,'set-required-notices',jsonb_build_object('old',false,'new',true,'reason','First-party workspace: on from the start.','via','migration 402') FROM changed;
