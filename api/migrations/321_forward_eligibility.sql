-- Expand step: ingest now records verdicts.forwardEligible for every inbound message (forwardEligibility in
-- src/mailbox-ingest.ts) and a forward reads it. This adds it to the messages stored before, from their stored columns,
-- by the same rule (storedForwardEligibility): an earlier forwardSafe refusal stands, and stored headers (capped at 200)
-- count only when there are fewer than 200. It removes nothing: the Worker this release replaces still reads
-- forwardSafe until it is gone, and a message it stores meanwhile is decided when it is first forwarded.
-- Idempotent: it only touches inbound rows without forwardEligible.
UPDATE mail_messages m SET verdicts = m.verdicts || jsonb_build_object('forwardEligible',
    m.verdicts->'forwardSafe' IS DISTINCT FROM 'false'::jsonb
    AND m.status = 'received' AND NOT m.automated AND NOT m.spam
    AND m.verdicts->>'virus' IS NOT DISTINCT FROM 'PASS' AND m.verdicts->>'dmarc' IS DISTINCT FROM 'FAIL'
    AND jsonb_array_length(m.headers) < 200
    AND NOT EXISTS (SELECT FROM jsonb_array_elements(m.headers) h WHERE lower(h->>'name') IN
      ('x-nightmail-loop', 'x-bane-loop', 'x-opensend-loop', 'auto-submitted', 'x-autoreply', 'x-autorespond', 'list-id', 'precedence'))
    AND (SELECT count(*) FROM jsonb_array_elements(m.headers) h WHERE lower(h->>'name') = 'received') < 25)
WHERE m.direction = 'inbound' AND NOT m.verdicts ? 'forwardEligible';
