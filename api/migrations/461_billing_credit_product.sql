-- NULL for attempts created by older writers, including during a rolling deploy. Never backfill:
-- their Stripe invoice-item idempotency keys bind the original amount/currency request body.
ALTER TABLE billing_payment_attempts ADD COLUMN IF NOT EXISTS stripe_credit_product text;
