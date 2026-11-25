-- List hygiene's synced lists and domain checks (src/list-hygiene.ts).
-- hygiene_lists: the nightly sync's last good copy of each open source ('source:<name>') and the lists built from them
-- ('built': the disposable domains in body, the providers, roles and disposable MX hosts in meta). A few MB in all.
CREATE TABLE IF NOT EXISTS hygiene_lists (
  name text PRIMARY KEY,
  version text NOT NULL,
  body text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- hygiene_mail_domains: each recipient domain's mail verdict from DNS (src/mail-dns.ts), a day at a time: one row per
-- domain, never per address. pending rows are the resolver's queue; listed: the domain was on the disposable list when it
-- was checked, so its mail servers count toward the disposable MX hosts.
CREATE TABLE IF NOT EXISTS hygiene_mail_domains (
  domain text PRIMARY KEY,
  verdict text NOT NULL DEFAULT 'pending' CHECK (verdict IN ('pending', 'ok', 'no_mail', 'unknown')),
  detail text,
  mx text[] NOT NULL DEFAULT '{}',
  listed boolean NOT NULL DEFAULT false,
  checked_at timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hygiene_mail_domains_due ON hygiene_mail_domains (requested_at) WHERE verdict IN ('pending', 'unknown');
CREATE INDEX IF NOT EXISTS hygiene_mail_domains_checked ON hygiene_mail_domains (checked_at);
