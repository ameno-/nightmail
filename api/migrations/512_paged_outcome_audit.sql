SET LOCAL lock_timeout='2s';
-- A single cursor traverses the retained email primary key. No tenant's raw history is scanned as one statement.
CREATE TABLE sending_outcome_audit_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  after_id text NOT NULL DEFAULT '',
  page_size integer NOT NULL DEFAULT 2048 CHECK (page_size BETWEEN 1 AND 2048),
  pass_started_at timestamptz,
  next_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO sending_outcome_audit_state(singleton) VALUES (true);

-- Same bits as the full manual verifier (407). Raw sending events take precedence over their public mirrors;
-- an orphan public event still counts. All sources and the stamp are read in one snapshot per page.
CREATE FUNCTION check_sending_event_outcome_page(after_id text, page_size integer)
RETURNS TABLE(workspace_id text, last_id text, checked integer, drifted integer, in_campaigns integer, extra_bits smallint, missing_bits smallint)
LANGUAGE sql STABLE AS $$
  WITH page AS MATERIALIZED (
    SELECT e.id,e.workspace_id,e.campaign_id,e.event_outcomes FROM sending_emails e
    WHERE e.id > after_id ORDER BY e.id LIMIT least(2048,greatest(1,page_size))
  ), compared AS MATERIALIZED (
    SELECT p.*,v.bits FROM page p CROSS JOIN LATERAL (
      SELECT coalesce(bit_or(x.bits),0)::smallint AS bits FROM (
        SELECT CASE v.type
          WHEN 'send' THEN 1 WHEN 'accepted' THEN 1 WHEN 'delivery' THEN 3
          WHEN 'bounce' THEN CASE WHEN v.data->>'bounceSubType' = 'EmailValidationSuppressed' THEN 0 ELSE 5 END
          WHEN 'non_permanent_bounce' THEN 129 WHEN 'complaint' THEN 9 WHEN 'delivery_delay' THEN 129
          WHEN 'open' THEN 16 WHEN 'click' THEN 32 WHEN 'reject' THEN 64 WHEN 'rendering_failure' THEN 64
          ELSE 0 END AS bits
        FROM sending_email_events v WHERE v.workspace_id=p.workspace_id AND v.email_id=p.id
        UNION ALL
        SELECT CASE n.type
          WHEN 'email.sent' THEN 1 WHEN 'email.delivered' THEN 3
          WHEN 'email.bounced' THEN CASE WHEN n.data->>'bounceSubType' = 'EmailValidationSuppressed' THEN 0
            WHEN n.data->>'bounceType' = 'Permanent' THEN 5 ELSE 129 END
          WHEN 'email.complained' THEN 9 WHEN 'email.delivery_delayed' THEN 129 WHEN 'email.opened' THEN 16
          WHEN 'email.clicked' THEN 32
          WHEN 'email.rejected' THEN CASE WHEN n.data->>'status' IN ('suppressed','canceled','acceptance_unknown') THEN 0 ELSE 64 END
          WHEN 'email.rendering_failed' THEN 64 ELSE 0 END AS bits
        FROM operation_events n WHERE n.workspace_id=p.workspace_id AND n.data ? 'emailId' AND n.data->>'emailId'=p.id
          AND NOT EXISTS (SELECT FROM sending_email_events v WHERE v.workspace_id=n.workspace_id AND v.id=n.id)
      ) x
    ) v
  )
  SELECT c.workspace_id,(SELECT max(id) FROM page),count(*)::int,
    count(*) FILTER (WHERE c.event_outcomes<>c.bits)::int,
    count(*) FILTER (WHERE c.event_outcomes<>c.bits AND c.campaign_id IS NOT NULL)::int,
    bit_or(c.event_outcomes & ~c.bits)::smallint,bit_or(c.bits & ~c.event_outcomes)::smallint
  FROM compared c GROUP BY c.workspace_id;
$$;
