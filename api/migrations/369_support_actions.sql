-- Support actions (src/support-actions.ts, api/README.md "Support integration"). Internal: customers never call the
-- routes that write these rows, except to confirm or decline their own.
--
-- The support platform proposes one of a few fixed changes for a conversation's person (retry or redeliver webhook mail,
-- test a webhook, pause a campaign). Nightmail checks the target is in the conversation's scope and writes the summary
-- itself from its own rows. Only that person, signed in to the dashboard, confirms or declines it; confirming runs the
-- same function as the change's public route, once. A proposal is open for 24 hours.
CREATE TABLE support_actions (
  id text PRIMARY KEY CHECK (id ~ '^sac_[0-9a-f]{32}$'),
  conversation_id text NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  -- Copied from the conversation when it was proposed: only this person confirms, in this workspace.
  user_id text NOT NULL,
  workspace_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('retry_webhook_delivery','retry_inbound_delivery','redeliver_message','test_webhook','test_inbound_webhook','pause_campaign')),
  -- The IDs it acts on (webhookId, deliveryId, messageId, campaignId), as the public route takes them.
  target jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object' AND octet_length(target::text) <= 1000),
  -- What the person approves, in Nightmail's words from its own rows; never the support platform's text.
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 1000),
  -- proposed until the person decides; running only while a test posts outside the transaction that claimed it.
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','running','done','failed','declined')),
  -- What the public route answered: its body when it succeeded, its error code and message when it refused.
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 4000)),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  resolved_at timestamptz,
  CHECK ((status IN ('proposed','running')) = (resolved_at IS NULL))
);
-- At most 3 open proposals per conversation; the propose route counts them.
CREATE INDEX support_actions_open ON support_actions (conversation_id) WHERE status = 'proposed';
