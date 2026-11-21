// Billing rates, apart from money.ts so a package without its dependencies can read them (the support Worker checks its
// prompt's prices against these). It imports nothing.

// The current rate version, from November 2026. The database prices each UTC month at its own version (billing_rates_in,
// migrations 367 and 380): months before it had 3,000 sent and 3,000 received free and charged $0.10 per 1,000 AI
// decisions. AI decisions are free (omenUc 0): still metered and counted, never charged.
export const RATES = { version: 3, emailUc: 20_000n, omenUc: 0n, storageUcPerGbMonth: 25_000_000n, freeSentEmails: 5000, freeReceivedEmails: 5000, freeStorageBytes: 1_000_000_000n } as const;

/** A per-unit rate in micro-cents as US dollars per 1,000 units, as GET /v1/billing and the homepage show it ("0.20"). */
export const perThousandUsd = (uc: bigint) => (Number(uc) * 1000 / 100_000_000).toFixed(2);
