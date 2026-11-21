-- Leave 15% of each new sending_emails heap page free, so an email's later versions (the dispatch lease, the outcome
-- bits) fit on its page and stay HOT instead of writing an entry into every index. SHARE UPDATE EXCLUSIVE: reads and
-- writes continue. Nothing is rewritten; pages filled from now on keep the room, and rows retire after 30 days.
SET LOCAL lock_timeout='2s';
ALTER TABLE sending_emails SET (fillfactor=85);
