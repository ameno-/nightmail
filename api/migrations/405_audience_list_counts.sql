-- A list's member counts by consent state, kept as its memberships and contacts change, so GET /v1/lists and
-- GET /v1/lists/{id} read a few rows instead of joining every membership to its contact on every load (src/audience.ts
-- readLists: 1.7 s for one list of 1,800,000). Exact, not cached: every change adds its difference in the transaction
-- that makes it, and a rollback takes the difference with it. Nothing that decides who receives an email reads this table.
--
-- audience_list_counts holds differences. A list's counts are the sums of its rows; its total is the four added up. Rows
-- are only ever inserted by writers, so no two transactions wait on a list's row (an import commit holds its transaction
-- for seconds); the hourly retention run folds each list's rows into one (src/maintenance.ts).
--
-- Three statement triggers write the differences, whatever issues the statement (the API, a job, a script, psql):
-- - audience_members_added, after INSERT on audience_list_members: +1 for each new membership, in its contact's state.
-- - audience_members_removed, after DELETE on audience_list_members: -1 each, in its contact's state. Nothing when the list
--   itself is gone (deleteContactList deletes the list first), so deleting a 2,000,000-member list reads no contact.
-- - audience_contacts_changed, after UPDATE on audience_contacts: each membership of a contact whose state changed moves
--   from the old state to the new one. Statements that change no state (opens, clicks, profile edits, re-imports) add
--   nothing.
-- A contact's state is deleted (counted nowhere), else suppressed, else its marketing consent, as readLists counted.
--
-- What keeps them exact under concurrency:
-- - A membership change reads its contact's state under FOR SHARE, and a state change holds its contact's row: the two
--   wait for each other, so neither can miss the other's uncommitted half. Whichever commits second sees the first.
-- - Lock order is contact, then membership, and several contacts in email order: the triggers lock theirs in that order,
--   as imports, SES feedback and lockContacts (src/audience.ts) do. The API takes the contact's lock before it changes
--   a membership, so the triggers' lock is one it already holds. A statement from outside the API that deletes a
--   membership while that contact is being deleted takes them the other way round and can be chosen as a deadlock
--   victim (40P01: rolled back whole, never miscounted).
-- - A trigger sees the other table as it is after its statement. The one statement that changes a contact's state and
--   adds its membership is the import (its upsert restores a deleted contact): the membership trigger counts the new
--   membership, and the contact trigger leaves out the memberships its own statement added (below). So the counts are
--   right with the release before this migration too, during a deploy and after a rollback.
-- - Not handled, because nothing does them: one statement that changes a contact's consent or suppression and adds or
--   removes that contact's memberships, an UPDATE of a membership's list or contact, a contact row deleted outright, a
--   membership written before its contact exists. The daily recount would report all of these.
-- - reconcile_audience_list_counts(workspace, list) counts a list the old way and stores the difference, if there is
--   one, in a single statement: both sides are read in one snapshot, so it is right at any moment, with writes running,
--   and it locks nothing a write waits for. The hourly upkeep runs it for every list once a day and logs
--   AUDIENCE_LIST_COUNTS_DRIFT at error level when it stored anything: a difference is a bug. Migration 406 fills the
--   table with the same difference.
--
-- The triggers' lookups are planned on each call and joined as audience_counts_join decides (below): PL/pgSQL would keep
-- the first plan for the session, and on tables whose statistics say they are empty the planner rates every index the
-- same and has picked ones that read a whole workspace per row.
--
-- On a live database: CREATE TRIGGER needs SHARE ROW EXCLUSIVE on audience_contacts and audience_list_members (writes to
-- them wait, reads do not) from here to COMMIT, which is milliseconds: nothing below reads either table. Taking the lock
-- waits for every transaction that has written to them, and an import commit holds its own for many seconds. So the
-- lock is asked for 2 s at a time, with a second's pause between, for up to 3 minutes: other writes never queue behind
-- this migration for more than 2 s, and it gets in between two commits of a running import. Contacts first, then
-- memberships, the order every write takes them.
DO $$
BEGIN
  FOR attempt IN 1..60 LOOP
    BEGIN
      SET LOCAL lock_timeout = '2s';
      LOCK TABLE audience_contacts, audience_list_members IN SHARE ROW EXCLUSIVE MODE;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_sleep(1);
    END;
  END LOOP;
  RAISE EXCEPTION 'audience_contacts and audience_list_members were busy for 3 minutes. Nothing was changed: run the migration again.' USING ERRCODE = 'lock_not_available';
END $$;
CREATE TABLE audience_list_counts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL, list_id text NOT NULL,
  subscribed integer NOT NULL DEFAULT 0, unsubscribed integer NOT NULL DEFAULT 0, unknown integer NOT NULL DEFAULT 0, suppressed integer NOT NULL DEFAULT 0
);
CREATE INDEX audience_list_counts_list ON audience_list_counts (workspace_id, list_id);

CREATE FUNCTION audience_contact_state(deleted_at timestamptz, suppressed boolean, marketing_consent text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN deleted_at IS NOT NULL THEN NULL WHEN suppressed THEN 'suppressed' ELSE marketing_consent END
$$;

-- How a trigger joins the rows a statement changed to the tables it looks them up in. With statistics that describe
-- tables more than ten times the statement, one index probe per row: time in proportion to the change, whatever the
-- tables' size. Otherwise the table is read once and joined by hash, for one of two reasons. The statement is a large
-- part of the table (a recount of a list most contacts are in: 9.4 s by probes, 3.2 s by hash at 2,000,000), and one
-- pass costs at most ten times the statement. Or the statistics predate the rows being looked up (a first import,
-- tables autovacuum last saw empty): the planner then rates every index the same and has picked one that reads the
-- whole workspace per row, minutes for 50,000 rows; the table is then no larger than what was loaded since its last
-- ANALYZE. The settings last until the calling trigger function returns (it names them in its SET clauses), and the
-- joins are planned on each call (EXECUTE), never from a plan kept from a statement of another size.
CREATE FUNCTION audience_counts_join(changed bigint, VARIADIC looked_up regclass[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE probe boolean := (SELECT min(reltuples) FROM pg_class WHERE oid = ANY (looked_up)) > 10 * changed;
BEGIN
  PERFORM set_config('enable_nestloop', probe::text, true), set_config('enable_hashjoin', (NOT probe)::text, true),
    set_config('enable_mergejoin', (NOT probe)::text, true), set_config('enable_seqscan', (NOT probe)::text, true);
END $$;

CREATE FUNCTION audience_members_added() RETURNS trigger LANGUAGE plpgsql
  SET enable_nestloop = on SET enable_hashjoin = on SET enable_mergejoin = on SET enable_seqscan = on AS $$
DECLARE added_rows bigint;
BEGIN
  SELECT count(*) INTO added_rows FROM added;
  IF added_rows = 0 THEN RETURN NULL; END IF;
  PERFORM audience_counts_join(added_rows, 'audience_contacts');
  -- The contact is found by its ID alone and locked, in email order, before its workspace and state are read. A deleted
  -- contact's membership (or one whose contact does not exist) is counted nowhere, as readLists never counted it.
  EXECUTE $q$WITH seen AS MATERIALIZED (
      SELECT a.workspace_id, a.list_id, c.workspace_id AS contact_workspace, audience_contact_state(c.deleted_at, c.suppressed, c.marketing_consent) AS state
      FROM added a JOIN audience_contacts c ON c.id = a.contact_id ORDER BY c.workspace_id, c.email FOR SHARE OF c
    ) INSERT INTO audience_list_counts (workspace_id, list_id, subscribed, unsubscribed, unknown, suppressed)
    SELECT workspace_id, list_id, count(*) FILTER (WHERE state = 'subscribed'), count(*) FILTER (WHERE state = 'unsubscribed'),
      count(*) FILTER (WHERE state = 'unknown'), count(*) FILTER (WHERE state = 'suppressed')
    FROM seen WHERE contact_workspace = workspace_id AND state IS NOT NULL GROUP BY workspace_id, list_id$q$;
  RETURN NULL;
END $$;

CREATE FUNCTION audience_members_removed() RETURNS trigger LANGUAGE plpgsql
  SET enable_nestloop = on SET enable_hashjoin = on SET enable_mergejoin = on SET enable_seqscan = on AS $$
DECLARE removed_rows bigint;
BEGIN
  -- A deleted list's counts go with it: nothing is subtracted, and no contact is read, for a list that is gone.
  SELECT count(*) INTO removed_rows FROM removed r WHERE EXISTS (SELECT FROM audience_lists l WHERE l.id = r.list_id AND l.workspace_id = r.workspace_id);
  IF removed_rows = 0 THEN RETURN NULL; END IF;
  PERFORM audience_counts_join(removed_rows, 'audience_contacts');
  EXECUTE $q$WITH seen AS MATERIALIZED (
      SELECT r.workspace_id, r.list_id, c.workspace_id AS contact_workspace, audience_contact_state(c.deleted_at, c.suppressed, c.marketing_consent) AS state
      FROM removed r JOIN audience_contacts c ON c.id = r.contact_id
      WHERE EXISTS (SELECT FROM audience_lists l WHERE l.id = r.list_id AND l.workspace_id = r.workspace_id)
      ORDER BY c.workspace_id, c.email FOR SHARE OF c
    ) INSERT INTO audience_list_counts (workspace_id, list_id, subscribed, unsubscribed, unknown, suppressed)
    SELECT workspace_id, list_id, 0 - count(*) FILTER (WHERE state = 'subscribed'), 0 - count(*) FILTER (WHERE state = 'unsubscribed'),
      0 - count(*) FILTER (WHERE state = 'unknown'), 0 - count(*) FILTER (WHERE state = 'suppressed')
    FROM seen WHERE contact_workspace = workspace_id AND state IS NOT NULL GROUP BY workspace_id, list_id$q$;
  RETURN NULL;
END $$;

CREATE FUNCTION audience_contacts_changed() RETURNS trigger LANGUAGE plpgsql
  SET enable_nestloop = on SET enable_hashjoin = on SET enable_mergejoin = on SET enable_seqscan = on AS $$
DECLARE workspaces text[]; contacts text[]; old_states text[]; new_states text[];
BEGIN
  -- Old and new rows are paired by grouping on the contact's ID: no join, so no plan to go wrong.
  SELECT array_agg(v.workspace_id), array_agg(v.id), array_agg(v.was), array_agg(v.became) INTO workspaces, contacts, old_states, new_states FROM (
    SELECT id, max(workspace_id) FILTER (WHERE NOT prior) AS workspace_id, max(state) FILTER (WHERE prior) AS was, max(state) FILTER (WHERE NOT prior) AS became FROM (
      SELECT id, workspace_id, true AS prior, audience_contact_state(deleted_at, suppressed, marketing_consent) AS state FROM before
      UNION ALL SELECT id, workspace_id, false, audience_contact_state(deleted_at, suppressed, marketing_consent) FROM after) versions
    GROUP BY id HAVING max(state) FILTER (WHERE prior) IS DISTINCT FROM max(state) FILTER (WHERE NOT prior)) v;
  IF contacts IS NULL THEN RETURN NULL; END IF;
  PERFORM audience_counts_join(cardinality(contacts), 'audience_list_members');
  -- Each changed contact's memberships as they are now, moved from its old state to its new one. A deleted contact's
  -- leave their state's count.
  EXECUTE $q$INSERT INTO audience_list_counts (workspace_id, list_id, subscribed, unsubscribed, unknown, suppressed)
    SELECT ch.workspace_id, m.list_id, count(*) FILTER (WHERE ch.became = 'subscribed') - count(*) FILTER (WHERE ch.was = 'subscribed'),
      count(*) FILTER (WHERE ch.became = 'unsubscribed') - count(*) FILTER (WHERE ch.was = 'unsubscribed'),
      count(*) FILTER (WHERE ch.became = 'unknown') - count(*) FILTER (WHERE ch.was = 'unknown'),
      count(*) FILTER (WHERE ch.became = 'suppressed') - count(*) FILTER (WHERE ch.was = 'suppressed')
    FROM unnest($1, $2, $3, $4) ch(workspace_id, id, was, became) JOIN audience_list_members m ON m.workspace_id = ch.workspace_id AND m.contact_id = ch.id
    WHERE ch.was IS NOT NULL GROUP BY ch.workspace_id, m.list_id$q$ USING workspaces, contacts, old_states, new_states;
  -- A restored contact's memberships enter its state's count, except the ones this same statement added: the membership
  -- trigger counts those. The import restores a deleted contact and adds its membership in one statement (and a release
  -- before this migration still does, during a deploy or after a rollback); a row that statement inserted carries the
  -- transaction and command (xmin, cmin) of the contact row it wrote.
  IF array_position(old_states, NULL) IS NOT NULL THEN
    PERFORM audience_counts_join(cardinality(contacts), 'audience_list_members', 'audience_contacts');
    EXECUTE $q$INSERT INTO audience_list_counts (workspace_id, list_id, subscribed, unsubscribed, unknown, suppressed)
      SELECT ch.workspace_id, m.list_id, count(*) FILTER (WHERE ch.became = 'subscribed'), count(*) FILTER (WHERE ch.became = 'unsubscribed'),
        count(*) FILTER (WHERE ch.became = 'unknown'), count(*) FILTER (WHERE ch.became = 'suppressed')
      FROM unnest($1, $2, $3, $4) ch(workspace_id, id, was, became) JOIN audience_contacts c ON c.id = ch.id
        JOIN audience_list_members m ON m.workspace_id = ch.workspace_id AND m.contact_id = ch.id
      WHERE ch.was IS NULL AND NOT (m.xmin = c.xmin AND m.cmin = c.cmin) GROUP BY ch.workspace_id, m.list_id$q$ USING workspaces, contacts, old_states, new_states;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER audience_members_added AFTER INSERT ON audience_list_members REFERENCING NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION audience_members_added();
CREATE TRIGGER audience_members_removed AFTER DELETE ON audience_list_members REFERENCING OLD TABLE AS removed FOR EACH STATEMENT EXECUTE FUNCTION audience_members_removed();
CREATE TRIGGER audience_contacts_changed AFTER UPDATE ON audience_contacts REFERENCING OLD TABLE AS before NEW TABLE AS after FOR EACH STATEMENT EXECUTE FUNCTION audience_contacts_changed();

-- The difference it stored, or no row when the counts were exact. One recount of a list at a time: two that read the
-- same difference would both store it. A list deleted meanwhile has nothing to correct (its rows wait for the hourly
-- fold): the same snapshot decides that. The memberships are joined to their contacts as audience_counts_join decides
-- for a list of this size, planned on each call, as the triggers' lookups are: left to the planner on statistics that
-- say the tables are empty, the join read the workspace's contacts once per membership.
CREATE FUNCTION reconcile_audience_list_counts(wid text, lid text) RETURNS TABLE (subscribed integer, unsubscribed integer, unknown integer, suppressed integer) LANGUAGE plpgsql
  SET enable_nestloop = on SET enable_hashjoin = on SET enable_mergejoin = on SET enable_seqscan = on AS $$
DECLARE members bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(275816, hashtext(wid || ':' || lid));
  SELECT count(*) INTO members FROM audience_list_members m WHERE m.workspace_id = wid AND m.list_id = lid;
  PERFORM audience_counts_join(members, 'audience_contacts');
  RETURN QUERY EXECUTE $q$WITH exact AS (
      SELECT count(*) FILTER (WHERE NOT c.suppressed AND c.marketing_consent = 'subscribed') AS subscribed, count(*) FILTER (WHERE NOT c.suppressed AND c.marketing_consent = 'unsubscribed') AS unsubscribed,
        count(*) FILTER (WHERE NOT c.suppressed AND c.marketing_consent = 'unknown') AS unknown, count(*) FILTER (WHERE c.suppressed) AS suppressed
      FROM audience_list_members m JOIN audience_contacts c ON c.id = m.contact_id
      WHERE m.workspace_id = $1 AND m.list_id = $2 AND c.workspace_id = $1 AND c.deleted_at IS NULL
    ), stored AS (
      SELECT coalesce(sum(n.subscribed), 0) AS subscribed, coalesce(sum(n.unsubscribed), 0) AS unsubscribed, coalesce(sum(n.unknown), 0) AS unknown, coalesce(sum(n.suppressed), 0) AS suppressed
      FROM audience_list_counts n WHERE n.workspace_id = $1 AND n.list_id = $2
    )
    INSERT INTO audience_list_counts AS n (workspace_id, list_id, subscribed, unsubscribed, unknown, suppressed)
    SELECT $1, $2, e.subscribed - s.subscribed, e.unsubscribed - s.unsubscribed, e.unknown - s.unknown, e.suppressed - s.suppressed FROM exact e, stored s
    WHERE (e.subscribed, e.unsubscribed, e.unknown, e.suppressed) IS DISTINCT FROM (s.subscribed, s.unsubscribed, s.unknown, s.suppressed)
      AND EXISTS (SELECT FROM audience_lists l WHERE l.workspace_id = $1 AND l.id = $2)
    RETURNING n.subscribed, n.unsubscribed, n.unknown, n.suppressed$q$ USING wid, lid;
END $$;
