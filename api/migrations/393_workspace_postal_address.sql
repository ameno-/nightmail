-- A workspace's postal address (src/outbound-content.ts PostalAddress): US law (CAN-SPAM) requires one in every
-- marketing email, so every campaign footer and marketing send shows it under the Unsubscribe link, and a campaign is
-- not sent or scheduled without it. Hosted keeps it beside the workspace's name, self-hosted in its settings row, as
-- each keeps the name. Nullable columns without a default and NOT VALID checks: catalog changes only, no rewrite or
-- scan, under a short lock that gives up rather than queue behind a long transaction.
SET LOCAL lock_timeout='2s';
ALTER TABLE workspaces ADD COLUMN postal_address text;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_postal_address_length CHECK (char_length(postal_address) <= 300) NOT VALID;
ALTER TABLE operation_settings ADD COLUMN postal_address text;
ALTER TABLE operation_settings ADD CONSTRAINT operation_settings_postal_address_length CHECK (char_length(postal_address) <= 300) NOT VALID;
