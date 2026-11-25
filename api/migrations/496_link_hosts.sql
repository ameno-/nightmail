SET LOCAL lock_timeout='2s';
-- A domain's link host (src/link-domains.ts): links.<domain>, a CNAME to the installation's Cloudflare for SaaS target
-- (edge.nightmail.dev on Hosted), served as a custom hostname of that zone (custom_hostname_id) with its own certificate.
-- Once active, the unsubscribe and other links in campaign and marketing mail from the domain use it. One row per
-- workspace and domain name, written by the domain's checks (with public_dns, what public DNS showed for the CNAME then)
-- and removed with the domain.
CREATE TABLE link_hosts (
  workspace_id text NOT NULL,
  domain text NOT NULL CHECK (domain = lower(domain) AND length(domain) <= 253),
  hostname text NOT NULL CHECK (hostname = lower(hostname) AND length(hostname) <= 253),
  custom_hostname_id text CHECK (length(custom_hostname_id) <= 64),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
  detail text CHECK (length(detail) <= 500),
  public_dns jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  PRIMARY KEY (workspace_id, domain)
);
CREATE INDEX link_hosts_custom_hostname ON link_hosts(custom_hostname_id) WHERE custom_hostname_id IS NOT NULL;
