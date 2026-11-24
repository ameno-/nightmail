# tear: SES event processing (`ses`)

TypeScript `@tear/mbt` model and host for Hosted Nightmail SES feedback: SNS HTTP route (`POST /v1/events/ses`, signed with a pinned self-signed cert), feedback-queue consumer (`ingestFeedbackBatch`), `operation.ses` recovery jobs paused at statement gates (`record`, `suppress`, `mark`), two concurrent held consumer transactions (`Q`, `P`), pre-migration-153 mixed-version rank checks (`old: true`), migration-154 repair, campaign stats, sender-score factors, hosted health totals, and webhook fan-out.

- `ses.types.ts` — shared types, synthetic notifications (`d1..x9`), and pairs.
- `ses.model.ts` — pure reference model, 8 model-free idle rules, and declarative temporal property `ses.suppression-monotonic`.
- `ses.host.ts` — Bun host driving real `app.fetch`, `ingestFeedbackBatch`, `operation.ses`, and `recordEmailEvent` across 4 concurrent Postgres connections plus `auto` and `checker`.
- `campaigns/ses.json` — control, `ses.suppression-monotonic` canary, and all 10 historical bug/boundary regressions.

## Run

From `api/tear/` (after `./setup.sh` and with `TEAR_DATABASE_URL` set to a migrated, disposable-marked loopback Postgres database):

```sh
# Regression campaign (control + canary + 10 regressions, ~0.8 s)
tear test ses/ses.model.ts ses --campaign ses/campaigns/ses.json

# Campaign + 50 seeded guided runs (~19 s)
tear test ses/ses.model.ts ses --campaign ses/campaigns/ses.json --seeds 1..50

# Deep exploration with novelty guidance (~99 s for 150 runs x 30 steps)
tear test ses/ses.model.ts --runs 150 --max-steps 30 --novelty --keep-going
```
