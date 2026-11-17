SET LOCAL lock_timeout='2s';
-- Contract step for migration 323 (send_admission). 323 kept the direct-send admission it replaced callable so the Worker
-- deployed before it kept working while it migrated. That Worker is gone: send_admission decides every send, and no
-- code, function or trigger calls key_admission_decision or direct_admission_state (the second was only ever called by
-- the first). Every helper they shared (billing_gate, direct_pending_load, hosted_allowance, idempotency_claim,
-- regional_sender) stays: send_admission calls each one. They hold no data. Each signature is dropped by OID, so a
-- database that still has an older overload loses it too.
DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('key_admission_decision','direct_admission_state') ORDER BY p.proname DESC LOOP
    EXECUTE format('DROP FUNCTION %s', f);
  END LOOP;
END $$;
