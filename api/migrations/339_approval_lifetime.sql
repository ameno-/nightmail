SET LOCAL lock_timeout='2s';
-- How long an MCP approval lasts, for what it made: its keys, webhooks, endpoints, routes and rules. An approval's
-- expires_at follows its newest access token, which the account service issues for 5 minutes, and mail_management_grant
-- ended the approval there (273), so what an agent made with a person's sign-in stopped working minutes after the
-- agent last connected. It now lasts like the account service's refreshable approval behind it: until it is removed,
-- 30 days after its newest token was issued, and at most 90 days after Nightmail first saw its current account-service
-- grant, while its person keeps the role it needs. The request an access token carries is still checked against that
-- token (externalMcpGrant).
--
-- issuer_grant_seen_at: when Nightmail first saw the current issuer_grant. Existing approvals take created_at: insert
-- and revival set it with issuer_grant, and a later consent change kept it, so it is never later than the real first
-- sighting and their 90 days can only end early, by at most the days since the 2026-11-12 cutover.
ALTER TABLE nightmail_resource_grants ADD COLUMN issuer_grant_seen_at timestamptz;
UPDATE nightmail_resource_grants SET issuer_grant_seen_at=created_at;
ALTER TABLE nightmail_resource_grants ALTER COLUMN issuer_grant_seen_at SET DEFAULT now(), ALTER COLUMN issuer_grant_seen_at SET NOT NULL;

CREATE FUNCTION nightmail_approval_ends(g nightmail_resource_grants) RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT least(to_timestamp(g.issued_at) + interval '30 days', g.issuer_grant_seen_at + interval '90 days')
$$;
-- The one definition of an approval that is active for what it made.
CREATE FUNCTION nightmail_approval_active(g nightmail_resource_grants) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT g.revoked AND now() < nightmail_approval_ends(g)
$$;

CREATE OR REPLACE FUNCTION mail_management_grant(w text, gid text, policy jsonb, needs_receiving boolean) RETURNS boolean LANGUAGE sql AS $$
  -- The approval is active (nightmail_approval_active), and its subject (admitted, and on self-hosted installations
  -- allowlisted) is an owner or admin of w with manage. Receiving needs nothing more. The address is not an input.
  SELECT EXISTS(SELECT FROM nightmail_resource_grants g
    JOIN nightmail_oidc_identities i USING(issuer,subject) JOIN nightmail_users u ON u.id=i.user_id
    JOIN workspace_members m ON m.user_id=i.user_id AND m.workspace_id=w
    WHERE g.grant_key=gid AND g.issuer=policy->>'issuer' AND nightmail_approval_active(g)
    AND (coalesce((policy->>'hosted')::boolean,false) OR coalesce(policy->'subjects','[]'::jsonb) ? i.subject)
    AND m.role IN ('owner','admin') AND 'manage'=ANY(g.permissions) FOR SHARE OF g,i,u,m);
$$;
