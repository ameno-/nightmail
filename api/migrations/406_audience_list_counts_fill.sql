-- Fills audience_list_counts (migration 405) with every list's counts. Its triggers are already committed, so writes made
-- while this runs add their own rows; this statement stores, for each list, the difference between its memberships
-- counted and what is stored, both read in one snapshot. So it is right whatever commits while it runs, it locks
-- nothing a write waits for, and running it again stores nothing.
--
-- Between 405 and this, the table holds only the differences made since the triggers exist. Nothing reads it yet: the
-- release that does is deployed after both migrations, and the one before it counts members itself.
--
-- On a live database this reads audience_list_members and audience_contacts once each (one hash join): 2 s for
-- 2,150,000 memberships on PostgreSQL 18.7 with 2 CPUs and production's memory settings.
INSERT INTO audience_list_counts (workspace_id, list_id, subscribed, unsubscribed, unknown, suppressed)
SELECT workspace_id, list_id, sum(subscribed), sum(unsubscribed), sum(unknown), sum(suppressed) FROM (
  SELECT m.workspace_id, m.list_id, count(*) FILTER (WHERE NOT c.suppressed AND c.marketing_consent = 'subscribed') AS subscribed, count(*) FILTER (WHERE NOT c.suppressed AND c.marketing_consent = 'unsubscribed') AS unsubscribed,
    count(*) FILTER (WHERE NOT c.suppressed AND c.marketing_consent = 'unknown') AS unknown, count(*) FILTER (WHERE c.suppressed) AS suppressed
  FROM audience_list_members m JOIN audience_contacts c ON c.workspace_id = m.workspace_id AND c.id = m.contact_id
  WHERE c.deleted_at IS NULL AND EXISTS (SELECT FROM audience_lists l WHERE l.workspace_id = m.workspace_id AND l.id = m.list_id) GROUP BY 1, 2
  UNION ALL SELECT workspace_id, list_id, -subscribed, -unsubscribed, -unknown, -suppressed FROM audience_list_counts
) difference GROUP BY 1, 2 HAVING sum(subscribed) <> 0 OR sum(unsubscribed) <> 0 OR sum(unknown) <> 0 OR sum(suppressed) <> 0;
