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
-- - Lock order is contact, then membership, and several contacts in email order. The API takes the contact's lock before
--   it changes a membership (lockContacts in src/audience.ts), so the triggers' own lock is one it already holds. A
--   statement from outside the API that deletes a membership while that contact is being deleted takes them the other
--   way round and can be chosen as a deadlock victim (40P01: rolled back whole, never miscounted).
-- - Each statement changes memberships or contacts' states, not both for the same contact: a trigger sees the table it
--   looks up as it is after its statement, so a membership added in the statement that changes its contact's state
--   would be counted by both triggers. The import was the one such statement (its upsert restores a deleted contact, and
--   added its membership); it now adds memberships in a statement of their own. A contact inserted with its membership
--   in one statement is fine: inserting a contact changes no state.
-- - Not handled, because nothing does them: an UPDATE of a membership's list or contact, a contact row deleted
--   outright, a membership written before its contact exists. The daily recount would report all of these.
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

-- How a trigger joins the rows a statement changed to the table it looks them up in. With statistics that describe a
-- table larger than the statement, one index probe per row: time in proportion to the change, whatever the table's size.
-- Otherwise the statistics predate the rows being looked up (a first import, tables autovacuum last saw empty): the
-- planner then rates every index the same and has picked one that reads the whole workspace per row, minutes for 50,000
-- rows. So that statement reads the table once and joins by hash; the table is no larger than what was loaded since its
-- last ANALYZE. The settings last until the calling trigger function returns (it names them in its SET clauses), and the
-- joins are planned on each call (EXECUTE), never from a plan kept from a statement of another size.
CREATE FUNCTION audience_counts_join(looked_up regclass, changed bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT reltuples FROM pg_class WHERE oid = looked_up) > changed THEN
    PERFORM set_config('enable_hashjoin', 'off', true), set_config('enable_mergejoin', 'off', true), set_config('enable_seqscan', 'off', true);
  ELSE
    PERFORM set_config('enable_nestloop', 'off', true);
  END IF;
END $$;

CREATE FUNCTION audience_members_added() RETURNS trigger LANGUAGE plpgsql
  SET enable_nestloop = on SET enable_hashjoin = on SET enable_mergejoin = on SET enable_seqscan = on AS $$
DECLARE added_rows bigint;
BEGIN
  SELECT count(*) INTO added_rows FROM added;
  IF added_rows = 0 THEN RETURN NULL; END IF;
  PERFORM audience_counts_join('audience_contacts', added_rows);
  -- The contact is found by its ID alone and locked before its workspace and state are read. A deleted contact's
  -- membership (or one whose contact does not exist) is counted nowhere, as readLists never counted it.
  EXECUTE $q$WITH seen AS MATERIALIZED (
      SELECT a.workspace_id, a.list_id, c.workspace_id AS contact_workspace, audience_contact_state(c.deleted_at, c.suppressed, c.marketing_consent) AS state
      FROM added a JOIN audience_contacts c ON c.id = a.contact_id FOR SHARE OF c
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
  PERFORM audience_counts_join('audience_contacts', removed_rows);
  EXECUTE $q$WITH seen AS MATERIALIZED (
      SELECT r.workspace_id, r.list_id, c.workspace_id AS contact_workspace, audience_contact_state(c.deleted_at, c.suppressed, c.marketing_consent) AS state
      FROM removed r JOIN audience_contacts c ON c.id = r.contact_id
      WHERE EXISTS (SELECT FROM audience_lists l WHERE l.id = r.list_id AND l.workspace_id = r.workspace_id) FOR SHARE OF c
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
  PERFORM audience_counts_join('audience_list_members', cardinality(contacts));
  -- Each changed contact's memberships as they are now, moved from its old state to its new one. A deleted contact's
  -- leave their state's count, and a restored contact's enter it.
  EXECUTE $q$INSERT INTO audience_list_counts (workspace_id, list_id, subscribed, unsubscribed, unknown, suppressed)
    SELECT ch.workspace_id, m.list_id, count(*) FILTER (WHERE ch.became = 'subscribed') - count(*) FILTER (WHERE ch.was = 'subscribed'),
      count(*) FILTER (WHERE ch.became = 'unsubscribed') - count(*) FILTER (WHERE ch.was = 'unsubscribed'),
      count(*) FILTER (WHERE ch.became = 'unknown') - count(*) FILTER (WHERE ch.was = 'unknown'),
      count(*) FILTER (WHERE ch.became = 'suppressed') - count(*) FILTER (WHERE ch.was = 'suppressed')
    FROM unnest($1, $2, $3, $4) ch(workspace_id, id, was, became) JOIN audience_list_members m ON m.workspace_id = ch.workspace_id AND m.contact_id = ch.id
    GROUP BY ch.workspace_id, m.list_id$q$ USING workspaces, contacts, old_states, new_states;
  RETURN NULL;
END $$;

CREATE TRIGGER audience_members_added AFTER INSERT ON audience_list_members REFERENCING NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION audience_members_added();
CREATE TRIGGER audience_members_removed AFTER DELETE ON audience_list_members REFERENCING OLD TABLE AS removed FOR EACH STATEMENT EXECUTE FUNCTION audience_members_removed();
CREATE TRIGGER audience_contacts_changed AFTER UPDATE ON audience_contacts REFERENCING OLD TABLE AS before NEW TABLE AS after FOR EACH STATEMENT EXECUTE FUNCTION audience_contacts_changed();

-- The difference it stored, or no row when the counts were exact. One recount of a list at a time: two that read the
-- same difference would both store it. A plan for this list's size each time, not one kept from a list of another size.
CREATE FUNCTION reconcile_audience_list_counts(wid text, lid text) RETURNS TABLE (subscribed integer, unsubscribed integer, unknown integer, suppressed integer) LANGUAGE plpgsql
  SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(275816, hashtext(wid || ':' || lid));
  RETURN QUERY WITH exact AS (
    SELECT count(*) FILTER (WHERE NOT c.suppressed AND c.marketing_consent = 'subscribed') AS subscribed, count(*) FILTER (WHERE NOT c.suppressed AND c.marketing_consent = 'unsubscribed') AS unsubscribed,
      count(*) FILTER (WHERE NOT c.suppressed AND c.marketing_consent = 'unknown') AS unknown, count(*) FILTER (WHERE c.suppressed) AS suppressed
    FROM audience_list_members m JOIN audience_contacts c ON c.workspace_id = m.workspace_id AND c.id = m.contact_id
    WHERE m.workspace_id = wid AND m.list_id = lid AND c.deleted_at IS NULL
  ), stored AS (
    SELECT coalesce(sum(n.subscribed), 0) AS subscribed, coalesce(sum(n.unsubscribed), 0) AS unsubscribed, coalesce(sum(n.unknown), 0) AS unknown, coalesce(sum(n.suppressed), 0) AS suppressed
    FROM audience_list_counts n WHERE n.workspace_id = wid AND n.list_id = lid
  )
  INSERT INTO audience_list_counts AS n (workspace_id, list_id, subscribed, unsubscribed, unknown, suppressed)
  SELECT wid, lid, e.subscribed - s.subscribed, e.unsubscribed - s.unsubscribed, e.unknown - s.unknown, e.suppressed - s.suppressed FROM exact e, stored s
  WHERE (e.subscribed, e.unsubscribed, e.unknown, e.suppressed) IS DISTINCT FROM (s.subscribed, s.unsubscribed, s.unknown, s.suppressed)
  RETURNING n.subscribed, n.unsubscribed, n.unknown, n.suppressed;
END $$;
