# Nightmail tear model-based test suite

Model-based tests for Nightmail built on the reworked TypeScript `tear` (`@tear/mbt` + `@tear/host`). Run on demand against a throwaway local PostgreSQL database with simulated/fake SES and storage — never production or dev.

Because `anomalyco/tear` is a private repository, `api/package.json` does not depend on it and public GitHub Actions CI does not run tear. Install the `tear` CLI and local `api/tear/node_modules/@tear/{mbt,host}` once via `api/tear/setup.sh`.

## Suite layout

Each checker uses split files: `<name>.types.ts` (pure shared types), `<name>.model.ts` (pure reference model, idle rules, and temporal properties — never imports `api/src/`), `<name>.host.ts` (Bun host driving the real Nightmail API/SQL/jobs), and `campaigns/<name>.json` (concrete control, canary, and regression cases).

### Core checkers (6)

| Checker | Area | Campaign cases |
|---|---|---:|
| `dispatch/` | Send admission, campaigns, batch dispatcher, quotas, outage breaker, recovery, 5 timing/once rules | 34 |
| `ses/` | Hosted SES feedback (SNS route, queue consumer, recovery jobs, rank guards, stats, health) | 12 |
| `access/` | Idempotency reservations, grant/key/token revocation & expiry, 243-op MCP vs REST parity (`BUG-ACCESS-01` pinned) | 15 |
| `admission/` | Receive hourly window & backlog, hosted send caps & sponsor holds, upload quota reservations | 46 |
| `inbox/` | Inbox folders, UIDs, UIDVALIDITY, MODSEQ, flags, move/copy/expunge, tombstones, retention | 22 |
| `delivery/` | Routing, rules, endpoints, retries, backoff, rate limits, fences, pause/resume (`DLV-1` pinned) | 42 |

### Preventative safety models (`safety/`, 5)

| Model | Invariant |
|---|---|
| `campaign-collab` | Two editors + API caller on one draft: no committed edit silently lost; stale saves always `409 STALE_CAMPAIGN_REVISION`. |
| `campaign-attachments` | Every attachment delivered to SES matches the draft at launch with valid `cid:` references and zero stray removed inline images. |
| `db-faults` | Under DB read-only (`XX000`/`25006`), timeout (`57014`/`55P03`), or pool exhaustion (`53300`), every API reply is 2xx or `retryable: true`, and recovery loses/duplicates zero accepted mail (`BUG-DB-01`, `BUG-DB-02` pinned). |
| `scale-reads` | On a workspace seeded with `TEAR_SCALE_CONTACTS` (default `200000`, up to `2000000`), dashboard reads answer 200 within stated latency budgets (`BUG-SCALE-01` pinned). |
| `tenant-isolation` | Heavy workspace imports and marketing floods never block, deadlock, or starve another workspace's transactional sends. |

## Quickstart

From `api/` (with `bun install` done and Docker running):

```sh
# One-time setup (uses TEAR_DIR=/path/to/tear if you already have a checkout)
bash tear/setup.sh

# Run all 6 core checkers against a throwaway Docker Postgres (~2.5 min)
bun run tear:ci

# Run all 11 models (core + safety)
bun run tear:ci all

# Run a single checker against an existing disposable DB
TEAR_DATABASE_URL="postgresql://postgres:tear@127.0.0.1:55499/tear_dispatch" \
  bash tear/run.sh dispatch
```

## Direct `tear` commands

From `api/tear/` with `TEAR_DATABASE_URL` set to a migrated, disposable-marked loopback Postgres database (see `disposable.ts`):

```sh
# Discover all 11 models
tear mbt list

# Run one campaign + guided seeds
tear test dispatch/dispatch.model.ts dispatch --campaign dispatch/campaigns/dispatch.json --seeds 1..50

# Deep guided exploration with novelty bias
tear test access/access.model.ts --runs 150 --max-steps 24 --novelty --keep-going

# Replay a counterexample token (use --start ... --masks run for masked known bugs)
tear test dispatch/dispatch.model.ts dispatch --replay tpbt1_...
tear test delivery/delivery.model.ts delivery --start tpbt1_... --max-steps 0 --runs 1 --masks run
```

## Disposable database guard

Every host imports `disposable.ts` and refuses any URL that is not plain loopback (no query string) or lacks this exact `COMMENT ON DATABASE` marker (plus a foreign-data check):

```sql
COMMENT ON DATABASE tear_db IS 'bane-tear: disposable test database, every row may be changed or deleted';
```
