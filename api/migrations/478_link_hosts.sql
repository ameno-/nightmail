SET LOCAL lock_timeout='2s';
-- A domain's own link host (src/link-domains.ts): links.<domain>, a CNAME to edge.<NIGHTMAIL_LINK_DOMAIN> that Cloudflare
-- for SaaS serves as a custom hostname (custom_hostname_id) with its own certificate. Once active, the unsubscribe and
-- other links in campaign and marketing mail from the domain use it instead of the shared link domain. One row per
-- workspace and domain name, written by the domain's check (verifyDomain) and removed with the domain.
CREATE TABLE link_hosts (
  workspace_id text NOT NULL,
  domain text NOT NULL CHECK (domain = lower(domain) AND length(domain) <= 253),
  hostname text NOT NULL CHECK (hostname = lower(hostname) AND length(hostname) <= 253),
  custom_hostname_id text CHECK (length(custom_hostname_id) <= 64),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
  detail text CHECK (length(detail) <= 500),
  checked_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  PRIMARY KEY (workspace_id, domain)
);
CREATE INDEX link_hosts_custom_hostname ON link_hosts(custom_hostname_id) WHERE custom_hostname_id IS NOT NULL;
