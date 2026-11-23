# tear: preventative safety models (`safety/`)

Five preventative models built from the 2026-11-23 incidents and PRs #582/#583/#584/#593:

| Model | What is checked | Canary / known bugs |
|---|---|---|
| `campaign-collab` | API optimistic locking for two editors + API caller on one draft: stale saves always `409 STALE_CAMPAIGN_REVISION`; concurrent `--rounds 2` races allow at most one winner. | `canary_stale_overwrite` (host-side) |
| `campaign-attachments` | Real PNG/PDF uploads, add/remove inline `cid:` images and files, `postal-mime` verification of every MIME part delivered by SES. | `canary_keep_removed_inline` (host-side) |
| `db-faults` | Under read-only (`XX000`/`25006`), timeouts (`57014`/`55P03`), mid-request `57014` after first write, or pool exhaustion (`53300`), API replies are 2xx or `retryable: true`, one `Idempotency-Key` produces at most one email id and one SES send, and healthy recovery drains all accepted mail. | `canary_double_send` (`BUG-DB-01` & `BUG-DB-02` fixed by #593, now ordinary passing cases) |
| `scale-reads` | On `TEAR_SCALE_CONTACTS` (default `200000`, up to `2000000`), 6 dashboard reads return 200 within fixed (data-size-independent) latency caps AND indexed pagination reads pass `EXPLAIN (ANALYZE, FORMAT JSON)` with no full-table `Seq Scan`, large `Sort`, or full-workspace filter scan. | `canary_slow_read` + `BUG-SCALE-01` (open until #596) |
| `tenant-isolation` | Deterministic commit-phase overlap (preview runs first, `VictimSend` fires inside workspace A's commit transaction) + `--rounds 2` concurrency: workspace B's transactional sends return 202 within 2 s and dispatch ahead of A's marketing backlog. Import size configurable via `TEAR_TENANT_IMPORT_ROWS` (default `1500`). | `canary_block_victim` (host-side) |

## Tool-fit notes & honest limits

- **Host-side canaries vs planted product bugs:** Each model's built-in `canary_*` proves one rule/predicate fires on a host-injected event. For end-to-end proof against real product mutations, run `api/tear/verify-plants.ts` against the 21 planted product bugs in `api/tear/plants.json`.
- **`scale-reads`:** Combines fixed latency caps with deterministic `EXPLAIN (ANALYZE, FORMAT JSON)` plan checks so regressions fail regardless of CPU speed. Full multi-million-row p95 benchmarking and no-match search audits remain in the standalone scale budget scripts.
- **`tenant-isolation`:** Proves lock/error isolation across an overlapping import commit and dispatcher priority across workspaces. Physical exhaustion (WAL disk fill, PgBouncer pool saturation, IOPS starvation) needs a resource-capped Docker Postgres load harness.
- **`campaign-collab` & `campaign-attachments`:** Proves API optimistic locking, attachment-link replacement, and SES MIME assembly; pure client merge helpers (`app/src/features/campaigns/merge.ts`) belong in `@tear/pbt` property tests.
