-- bane:batched
-- Contract step for migration 321 (one forward rule). Ingest decides whether a message may be forwarded once and stores
-- it as verdicts.forwardEligible; the Worker before 321 stored verdicts.forwardSafe instead, so 321 added
-- forwardEligible to older mail and kept forwardSafe for that Worker, and a forward decided a message stored without
-- forwardEligible on read. That Worker is gone. This gives every inbound message that still lacks forwardEligible the
-- answer that read would have given (321's rule over its stored columns, where an earlier forwardSafe refusal stands:
-- the rows that Worker stored while 321 ran), then removes forwardSafe, which forwardEligible now holds. After it, a
-- forward reads forwardEligible only.
--
-- The Worker running meanwhile stores forwardEligible with every message it ingests, never forwardSafe; its sandbox
-- and IMAP-append rows carry neither and stay without it: the rule refuses them (no virus verdict), and so does a
-- missing forwardEligible. Its decide-on-read fallback writes forwardEligible only where it is missing: if it holds a
-- row this page wants, the page waits (lock_timeout), then keeps the answer it wrote.
--
-- Shapes the column allows but the rule doesn't expect (verdicts is any JSON, headers any JSON):
--   verdicts not an object (array, string, number, boolean, JSON null): left exactly as stored. The read returned false
--     for each (it has no virus verdict) and threw for JSON null; the forward reads the same way now.
--   headers not an array of objects with a string name: forwardEligible false. The read threw on them unless
--     forwardSafe was false (then false), so such a message was never forwarded.
-- Only ingest ever wrote forwardSafe, but it is removed from any object that has it.
--
-- Batched (migrate.ts): each page walks the next 2,000 messages by primary key after the cursor, updates only the
-- ones that need it, commits, and returns the last ID it walked (NULL after the last page). Row locks last one
-- page. A row it has updated no longer matches, so a rerun after any interruption walks from the start again and
-- changes only what it had not reached.
WITH page AS MATERIALIZED (SELECT id FROM mail_messages WHERE id > $1 ORDER BY id LIMIT 2000),
changed AS (
  UPDATE mail_messages m SET verdicts = CASE WHEN m.direction <> 'inbound' OR m.verdicts ? 'forwardEligible' THEN m.verdicts ELSE m.verdicts || jsonb_build_object('forwardEligible',
      m.verdicts->'forwardSafe' IS DISTINCT FROM 'false'::jsonb AND CASE
        WHEN jsonb_typeof(m.headers) <> 'array' THEN false
        WHEN EXISTS (SELECT FROM jsonb_array_elements(m.headers) h WHERE jsonb_typeof(h->'name') IS DISTINCT FROM 'string') THEN false
        ELSE m.status = 'received' AND NOT m.automated AND NOT m.spam
          AND m.verdicts->>'virus' IS NOT DISTINCT FROM 'PASS' AND m.verdicts->>'dmarc' IS DISTINCT FROM 'FAIL'
          AND jsonb_array_length(m.headers) < 200
          AND NOT EXISTS (SELECT FROM jsonb_array_elements(m.headers) h WHERE lower(h->>'name') IN
            ('x-nightmail-loop', 'x-bane-loop', 'x-opensend-loop', 'auto-submitted', 'x-autoreply', 'x-autorespond', 'list-id', 'precedence'))
          AND (SELECT count(*) FROM jsonb_array_elements(m.headers) h WHERE lower(h->>'name') = 'received') < 25 END) END - 'forwardSafe'
  FROM page p WHERE m.id = p.id AND jsonb_typeof(m.verdicts) = 'object'
    AND (m.direction = 'inbound' AND NOT m.verdicts ? 'forwardEligible' OR m.verdicts ? 'forwardSafe')
)
SELECT CASE WHEN count(*) = 2000 THEN max(id) END AS cursor FROM page;
