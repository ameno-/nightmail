# tear: `campaign-lifecycle`

End-to-end model-based checker for one campaign's entire lifecycle against the real Nightmail API, job runner, dispatcher, SES feedback ingestion, and PostgreSQL views:

- **Lifecycle:** `draft` → preview/review → launch (`send` / `schedule` / `reschedule` / `unschedule`) → `preparing` → Hosted list probe (100–500, 10-minute wait, pass/quarantine, clean-list skip ≤ 10,000) → `sending` in releases → `done`.
- **Controls from every state:** `Pause`, `Resume`, `Cancel`, `EditDraft`, second `SendNow`, `Archive`.
- **System transitions & faults:** automatic pause on bounces/complaints (`BOUNCE_RATE_HIGH`, `LIST_QUALITY`), `pacing_window`, `ses_daily_quota` & `hosted_daily_quota` holds, `regional_workspace_limits` rate parity (shared ÷ 4 vs exempt full rate, migration 422), `ORIGIN_KEY_REVOKED`, `REQUIRED_NOTICES_OFF`, `SES_MODE_CHANGED`, temporary DB read-only (`25006`), job lease crash & redelivery, and mid-campaign deploy.

## Named invariants (8 + temporal once-per-recipient)

1. `lifecycle.accounting-exact` + `lifecycle.once-per-recipient`
2. `lifecycle.validate-before-send-and-stop-bounds`
3. `lifecycle.pre-release-suppression-wins`
4. `lifecycle.controls-responsive`
5. `lifecycle.probe-enforced`
6. `lifecycle.never-stuck`
7. `lifecycle.rate-matches-view`
8. `lifecycle.stats-monotonic-bounded`

Each of the 8 invariants has a real 1-line product mutation in `plants.json` proving the rule catches real product faults.

## Branch companion campaigns

- `campaigns/campaign-lifecycle.json` — runs on `dev` (default in `api/tear/run.sh`).
- `campaigns/campaign-lifecycle-pr618.json` — expected on PR #618 (`opt/campaigns-fast-launch`: async >5,000 capture, `s1:` static hashes, late `EMPTY_AUDIENCE`).
- `campaigns/campaign-lifecycle-pr619.json` — expected on PR #619 (`opt/feedback-throughput`: priority-only `feedback_lag` release hold vs routine lag).

## Running

```sh
# Per-PR (cases + rotating guided seeds)
bash api/tear/run.sh campaign-lifecycle

# Scheduled (cases + rotating seeds + BFS edges to depth 2 + 20 deep walks)
TEAR_EDGES=1 TEAR_DEEP_RUNS=20 bash api/tear/run.sh campaign-lifecycle
```
