SET LOCAL lock_timeout='2s';
-- List quality counts campaign mail only (src/standing-model.ts, hygiene): sender_score_daily.suppressed now counts
-- campaign emails to suppressed addresses, not every suppressed email. A day with no campaign mail had only other
-- suppressions, so it drops to 0; mail older than the 30 days sending_emails keeps cannot be recounted. Clearing
-- evidence_at makes the next standing run recount every workspace's retained 30 days and store the corrected score.
UPDATE sender_score_daily SET suppressed=0 WHERE suppressed>0 AND first_sends=0 AND first_bounced=0;
UPDATE sender_standing SET evidence_at=NULL WHERE evidence_at IS NOT NULL;
