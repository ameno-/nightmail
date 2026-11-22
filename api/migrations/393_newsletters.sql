-- Newsletters (src/newsletters.ts): a newsletter is a contact list with a sender, and its issues are the campaigns sent to
-- that list. A list is one while newsletter_from is set; newsletter_readers is the background count of a large list's
-- readers (src/newsletters.ts readersJob). sending_campaigns.list_id is the campaign's draft.audience.listId, written by
-- a trigger on every write of draft, so filtering campaigns by list never detoasts a draft (drafts hold the HTML).
--
-- What it costs on a live database, all inside one transaction whose locks give up after 2 s rather than queue behind
-- a long transaction:
-- - The four ADD COLUMNs are nullable without a default: catalog changes, no rewrite, under ACCESS EXCLUSIVE locks on
--   audience_lists and sending_campaigns held to COMMIT.
-- - audience_lists_newsletters scans audience_lists (one row per list) and starts empty: no list is a newsletter yet.
-- - The backfill reads each campaign's draft once (one row per campaign) and writes list_id on those with a list;
--   sending_campaigns_list_page is built from the same rows. Measured on a tmpfs PostgreSQL 17.11: 5,000 campaigns with
--   40 KB drafts (200 MB with their TOAST) take 145-180 ms for the backfill and 4 ms for the index; every other statement
--   takes under 1 ms. audience_list_members, audience_contacts and sending_emails are never read.
SET LOCAL lock_timeout='2s';
ALTER TABLE audience_lists ADD COLUMN newsletter_from text, ADD COLUMN newsletter_from_name text, ADD COLUMN newsletter_readers jsonb;
CREATE INDEX audience_lists_newsletters ON audience_lists (workspace_id, created_at, id) WHERE newsletter_from IS NOT NULL;
ALTER TABLE sending_campaigns ADD COLUMN list_id text;
CREATE FUNCTION sending_campaigns_list_id() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.list_id := NEW.draft #>> '{audience,listId}';
  RETURN NEW;
END $$;
CREATE TRIGGER sending_campaigns_list_id BEFORE INSERT OR UPDATE OF draft ON sending_campaigns FOR EACH ROW EXECUTE FUNCTION sending_campaigns_list_id();
UPDATE sending_campaigns SET list_id = draft #>> '{audience,listId}' WHERE draft #>> '{audience,listId}' IS NOT NULL;
CREATE INDEX sending_campaigns_list_page ON sending_campaigns (workspace_id, list_id, created_at DESC, id DESC) WHERE list_id IS NOT NULL;
