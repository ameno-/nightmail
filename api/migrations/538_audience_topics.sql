-- Topics (src/topics.ts): the kinds of marketing mail a workspace sends ("Product updates", "Events"). A marketing send or
-- campaign may name one, and its one-click unsubscribe then opts the person out of that topic alone; a contact's global
-- marketing_consent stays the switch for everything ("Unsubscribe from all").
-- - audience_topics: subscribed_by_default is what a contact who never chose gets, fixed when the topic is made. A topic is
--   archived (archived_at), never deleted, so sends launched with it keep honoring its opt-outs and it can come back.
-- - audience_contact_topics: one row per choice a contact made or was given; no row means the topic's default. Keyed by
--   topic before contact, so one contact's choices are found by the whole key and one topic's by its prefix (a campaign's
--   audience reads a topic's choices whole, src/audience.ts).
-- - audience_consent_audit.topic_id: the topic a consent decision was about; NULL is all marketing, as every row so far.
-- - operation_unsubscribe_tokens.topic_id: the topic of the mail an unsubscribe link came in; NULL is all marketing.
--
-- On a live database: two new empty tables, and two nullable ADD COLUMNs without a default (catalog changes, no rewrite,
-- no scan) whose ACCESS EXCLUSIVE locks give up after 2 s rather than queue behind a long transaction. Nothing is
-- backfilled and no index is built on an existing table: until a workspace makes a topic, no row is read or written.
SET LOCAL lock_timeout='2s';
CREATE TABLE audience_topics (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  name text NOT NULL CONSTRAINT audience_topics_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '' CONSTRAINT audience_topics_description_length CHECK (char_length(description) <= 300),
  subscribed_by_default boolean NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audience_topics_page ON audience_topics (workspace_id, id);
CREATE UNIQUE INDEX audience_topics_active_name ON audience_topics (workspace_id, lower(name)) WHERE archived_at IS NULL;
CREATE TABLE audience_contact_topics (
  workspace_id text NOT NULL,
  contact_id text NOT NULL,
  topic_id text NOT NULL,
  subscribed boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, topic_id, contact_id)
);
ALTER TABLE audience_consent_audit ADD COLUMN topic_id text;
ALTER TABLE operation_unsubscribe_tokens ADD COLUMN topic_id text;
