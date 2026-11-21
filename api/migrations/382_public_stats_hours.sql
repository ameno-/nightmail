-- The public stats refresh (public-stats.ts) read all 43,200 minute buckets four times a minute: the 30-day aggregate,
-- the search for minutes due their day-old recompute (twice) and the completeness count. It now reads hour totals,
-- which these triggers keep equal to the minute buckets on every insert, update and delete (whoever writes them), and
-- finds due minutes through a partial index of the buckets not yet recomputed a day after their minute.
CREATE TABLE public_stats_hours (
  hour timestamptz PRIMARY KEY,
  minutes integer NOT NULL,
  accepted bigint NOT NULL, delivered bigint NOT NULL, bounced bigint NOT NULL,
  regions text[] NOT NULL, workspaces text[] NOT NULL
);

-- Rebuilds the given UTC hours (distinct) from their minute buckets: the totals, how many buckets there are, and the
-- distinct regions and sender IDs (a bucket keeps at most 10 IDs, so an hour at most 600). An hour without buckets has no row.
CREATE FUNCTION public_stats_roll_up(changed timestamptz[]) RETURNS void LANGUAGE sql AS $$
  DELETE FROM public_stats_hours h WHERE h.hour = ANY (changed)
    AND NOT EXISTS (SELECT FROM public_stats_minutes m WHERE m.minute >= h.hour AND m.minute < h.hour + interval '1 hour');
  INSERT INTO public_stats_hours AS h (hour, minutes, accepted, delivered, bounced, regions, workspaces)
  SELECT u.hour, s.minutes, s.accepted, s.delivered, s.bounced,
    ARRAY(SELECT DISTINCT r FROM public_stats_minutes m, unnest(m.regions) AS r WHERE m.minute >= u.hour AND m.minute < u.hour + interval '1 hour' ORDER BY r),
    ARRAY(SELECT DISTINCT w FROM public_stats_minutes m, unnest(m.workspaces) AS w WHERE m.minute >= u.hour AND m.minute < u.hour + interval '1 hour' ORDER BY w)
  FROM unnest(changed) AS u(hour)
  CROSS JOIN LATERAL (SELECT count(*)::int AS minutes, sum(m.accepted) AS accepted, sum(m.delivered) AS delivered, sum(m.bounced) AS bounced
    FROM public_stats_minutes m WHERE m.minute >= u.hour AND m.minute < u.hour + interval '1 hour') s
  WHERE s.minutes > 0
  ON CONFLICT (hour) DO UPDATE SET minutes = excluded.minutes, accepted = excluded.accepted, delivered = excluded.delivered,
    bounced = excluded.bounced, regions = excluded.regions, workspaces = excluded.workspaces;
$$;

CREATE FUNCTION public_stats_minutes_roll_up() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed timestamptz[];
BEGIN
  -- One writer at a time, so a concurrent rebuild can't overwrite an hour with totals missing the other's buckets. The
  -- lock is taken before the statement locks any bucket, so writers queue on it instead of deadlocking.
  IF TG_WHEN = 'BEFORE' THEN
    LOCK TABLE public_stats_hours IN SHARE ROW EXCLUSIVE MODE;
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN changed := ARRAY(SELECT DISTINCT date_trunc('hour', minute, 'UTC') FROM new_minutes);
  ELSIF TG_OP = 'DELETE' THEN changed := ARRAY(SELECT DISTINCT date_trunc('hour', minute, 'UTC') FROM old_minutes);
  ELSE changed := ARRAY(SELECT date_trunc('hour', minute, 'UTC') FROM new_minutes UNION SELECT date_trunc('hour', minute, 'UTC') FROM old_minutes);
  END IF;
  IF changed <> '{}' THEN PERFORM public_stats_roll_up(changed); END IF;
  RETURN NULL;
END $$;

-- Creating the triggers locks the minute buckets against writes until this migration commits, so the backfill below
-- and the triggers see every change once.
CREATE TRIGGER public_stats_minutes_writing BEFORE INSERT OR UPDATE OR DELETE ON public_stats_minutes
  FOR EACH STATEMENT EXECUTE FUNCTION public_stats_minutes_roll_up();
CREATE TRIGGER public_stats_minutes_inserted AFTER INSERT ON public_stats_minutes REFERENCING NEW TABLE AS new_minutes
  FOR EACH STATEMENT EXECUTE FUNCTION public_stats_minutes_roll_up();
CREATE TRIGGER public_stats_minutes_updated AFTER UPDATE ON public_stats_minutes REFERENCING OLD TABLE AS old_minutes NEW TABLE AS new_minutes
  FOR EACH STATEMENT EXECUTE FUNCTION public_stats_minutes_roll_up();
CREATE TRIGGER public_stats_minutes_deleted AFTER DELETE ON public_stats_minutes REFERENCING OLD TABLE AS old_minutes
  FOR EACH STATEMENT EXECUTE FUNCTION public_stats_minutes_roll_up();
SELECT public_stats_roll_up(ARRAY(SELECT DISTINCT date_trunc('hour', minute, 'UTC') FROM public_stats_minutes));

-- About a day of buckets (43,200 rows in all, built in well under a second): the ones whose minute ended less than a
-- day before they were last computed. The refresh's due-minute search reads one entry instead of 30 days of buckets.
CREATE INDEX public_stats_minutes_due ON public_stats_minutes (minute) WHERE computed_at - minute < interval '1 day 1 minute';
