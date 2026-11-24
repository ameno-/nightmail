-- Attach sending_email_events_outcomes and update record_email_event_outcomes() in a separate transaction that locks
-- ONLY sending_email_events (never sending_emails), so applying this migration mid-send cannot deadlock with
-- recordOutcomes / ingestRoutineSesEvents / persistEmailEvent.
--
-- Both triggers skip UPDATE sending_emails entirely when no row's event_outcomes would change, avoiding empty statement
-- trigger invocations on sending_emails on the hot path.

DO $$
BEGIN
  FOR attempt IN 1..60 LOOP
    BEGIN
      SET LOCAL lock_timeout = '2s';
      LOCK TABLE sending_email_events IN SHARE ROW EXCLUSIVE MODE;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_sleep(1);
    END;
  END LOOP;
  RAISE EXCEPTION 'sending_email_events was busy for 3 minutes. Nothing was changed: run the migration again.' USING ERRCODE = 'lock_not_available';
END $$;

CREATE FUNCTION record_sending_event_outcomes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  eids text[];
  masks smallint[];
BEGIN
  WITH bits AS (
    SELECT n.workspace_id, n.email_id,
      bit_or(CASE n.type
        WHEN 'send' THEN 1
        WHEN 'accepted' THEN 1
        WHEN 'delivery' THEN 3
        WHEN 'bounce' THEN CASE WHEN n.data->>'bounceSubType' = 'EmailValidationSuppressed' THEN 0 ELSE 5 END
        WHEN 'non_permanent_bounce' THEN 129
        WHEN 'complaint' THEN 9
        WHEN 'delivery_delay' THEN 129
        WHEN 'open' THEN 16
        WHEN 'click' THEN 32
        WHEN 'reject' THEN 64
        WHEN 'rendering_failure' THEN 64
        ELSE 0 END) AS bits
    FROM new_events n
    GROUP BY 1, 2
  ), targets AS (
    SELECT e.id, b.bits::smallint AS bits
    FROM sending_emails e
    JOIN bits b ON e.id = b.email_id AND e.workspace_id = b.workspace_id
    WHERE b.bits <> 0 AND (e.event_outcomes | b.bits::smallint) <> e.event_outcomes
    ORDER BY e.id FOR UPDATE OF e
  )
  SELECT array_agg(id), array_agg(bits) INTO eids, masks FROM targets;

  IF eids IS NOT NULL THEN
    UPDATE sending_emails e
    SET event_outcomes = e.event_outcomes | t.bits
    FROM unnest(eids, masks) AS t(id, bits)
    WHERE e.id = t.id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER sending_email_events_outcomes AFTER INSERT ON sending_email_events
  REFERENCING NEW TABLE AS new_events FOR EACH STATEMENT EXECUTE FUNCTION record_sending_event_outcomes();

-- operation_events collapses bounce, non_permanent_bounce and validation_suppressed into one public type ('email.bounced'),
-- so migration 088's ELSE 129 fallback misclassified minimal bounce/validation_suppressed payloads as delivery_delayed.
-- When a matching sending_email_events row exists (same workspace_id + id), sending_email_events_outcomes already sets the
-- exact bit from the unambiguous event type; only orphan operation_events rows fall back to this trigger.
CREATE OR REPLACE FUNCTION record_email_event_outcomes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  eids text[];
  masks smallint[];
BEGIN
  WITH bits AS (
    SELECT n.workspace_id, n.data->>'emailId' AS email_id,
      bit_or(CASE n.type WHEN 'email.sent' THEN 1 WHEN 'email.delivered' THEN 3
        WHEN 'email.bounced' THEN CASE WHEN n.data->>'bounceSubType'='EmailValidationSuppressed' THEN 0
          WHEN n.data->>'bounceType'='Permanent' THEN 5 ELSE 129 END
        WHEN 'email.complained' THEN 9 WHEN 'email.delivery_delayed' THEN 129 WHEN 'email.opened' THEN 16
        WHEN 'email.clicked' THEN 32 WHEN 'email.rejected' THEN CASE WHEN n.data->>'status' IN ('suppressed','canceled','acceptance_unknown') THEN 0 ELSE 64 END
        WHEN 'email.rendering_failed' THEN 64 ELSE 0 END) AS bits
    FROM new_events n
    WHERE n.data ? 'emailId'
      AND NOT EXISTS (SELECT 1 FROM sending_email_events v WHERE v.workspace_id = n.workspace_id AND v.id = n.id)
    GROUP BY 1, 2
  ), targets AS (
    SELECT e.id, b.bits::smallint AS bits FROM sending_emails e JOIN bits b ON e.id = b.email_id AND e.workspace_id = b.workspace_id
    WHERE b.bits <> 0 AND (e.event_outcomes | b.bits::smallint) <> e.event_outcomes ORDER BY e.id FOR UPDATE OF e
  )
  SELECT array_agg(id), array_agg(bits) INTO eids, masks FROM targets;

  IF eids IS NOT NULL THEN
    UPDATE sending_emails e
    SET event_outcomes = e.event_outcomes | t.bits
    FROM unnest(eids, masks) AS t(id, bits)
    WHERE e.id = t.id;
  END IF;
  RETURN NULL;
END $$;
