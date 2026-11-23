# tear: preventative safety models (`safety/`)

Five preventative models built directly from the 2026-11-23 incidents (`incident-2026-11-23.md`, `db-safety-audit-2026-11-23.md`, `review-582.md`) and PRs #583/#584:

| Model | Invariant | Canary | Run time |
|---|---|---|---|
| `campaign-collab` | Two editors and an API caller on one draft: no committed edit is silently lost and every stale save returns `409 STALE_CAMPAIGN_REVISION`. | `canary_stale_overwrite` | ~30 s (campaign + 40 `--rounds 2` seeds) |
| `campaign-attachments` | Every attachment delivered by SES matches the draft at launch, with matching `cid:` references and no stray removed inline images. | `canary_keep_removed_inline` | ~10 s (campaign + 40 seeds) |
| `db-faults` | Under read-only (`XX000`/`25006`), timeout (`57014`/`55P03`), or connection exhaustion (`53300`), every API reply is 2xx or `retryable: true`, and recovery loses/duplicates zero accepted mail. | `canary_double_send` + `BUG-DB-01` + `BUG-DB-02` | ~5 s (campaign + 40 seeds) |
| `scale-reads` | On a workspace seeded with `TEAR_SCALE_CONTACTS` (default `200000`, up to `2000000`), every dashboard read answers 200 within its stated latency budget (`satisfies("within-budget")`). | `canary_slow_read` + `BUG-SCALE-01` | ~3.5 s warm (~5.3 s first seed of 200k) |
| `tenant-isolation` | While workspace A runs 1,500-row contact import commits or a marketing flood, workspace B's transactional sends return 202 promptly and dispatch ahead of A's marketing backlog. | `canary_block_victim` | ~9.5 s (campaign + 15 `--rounds 2` seeds) |

## Tool-fit notes

- **`scale-reads` (numeric latency budgets):** Tear is not the best primary tool for wall-clock latency budgets because timings fluctuate with buffer-cache warmth and shared CPU load, making counterexample shrinking noisy. Use a standalone `EXPLAIN (FORMAT JSON)` plan-shape + p95 benchmark script as the primary performance gate; keep `scale-reads` here as an on-demand host-timed sanity check.
- **`tenant-isolation` (physical vs logical isolation):** Tear proves logical, lock-order, and dispatcher-priority isolation under concurrent rounds. Physical resource saturation (filling a 10 GB disk with WAL, exhausting PgBouncer's 25 connections, or CPU/IOPS starvation) needs a resource-capped Docker Postgres load harness, not tear.
- **`campaign-collab` & `campaign-attachments` (React UI vs API):** Tear has no browser driver. These models prove the API's optimistic locking, attachment-link replacement, review freeze, and MIME assembly; pure client helpers (`mergeCampaign`, `draftAttachments`) belong in `@tear/pbt` property tests.
