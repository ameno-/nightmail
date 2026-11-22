SET LOCAL lock_timeout='2s';
-- Better Auth's sessions, accounts and MCP OAuth tables. Sign-in moved to OIDC (270, 272) and MCP approvals
-- to nightmail_resource_grants (273, 275, 276); no code has read them since, and they are empty.
-- Each references only the others or auth_user, so no CASCADE is needed.
DROP TABLE IF EXISTS oauth_access_token, oauth_refresh_token, oauth_consent, oauth_client_resource, oauth_client_assertion,
  oauth_client, oauth_resource, auth_jwks, auth_session, auth_account, auth_verification;
