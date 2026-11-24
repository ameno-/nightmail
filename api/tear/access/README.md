# tear: idempotency and access control (`access`)

TypeScript `@tear/mbt` model and host for Nightmail's idempotency reservations, grant/key/token revocation and expiry, and MCP vs REST authorization parity across all 243 catalog operations.

- `access.rest.types.ts` — documented REST permission table extracted from `api/openapi.json` (`x-nightmail-permission`, pure data with zero `api/src` imports).
- `access.types.ts` — presets (`core`, `full`, `race`, `revoke`), grant shapes, credentials, and pure REST/MCP permission evaluation.
- `access.model.ts` — pure reference model covering all idempotency, concurrency, lost-commit, clock-boundary, revocation, deploy-overlap, and MCP/REST parity rules, 3 idle rules, declarative temporal property `access.no-secret-replay`, and known-bug mask `BUG-ACCESS-01`.
- `access.host.ts` — Bun host driving real `app.fetch` over a disposable PostgreSQL database (`../disposable.ts`) with a frozen clock (`FrozenDate` + `tear_clock.state`), two gated request slots (`A`, `B`), crash/lost-commit fault injection, and a full REST GET audit (`probe <actor> audit`).
- `campaigns/access.json` — control, `canary-secret-replay`, `known-bug-dkey-mcp-lists-refused-writes` (`BUG-ACCESS-01` canary), and 12 regression/audit cases covering all 9 grant shapes, API keys, domain-limited keys, agent tokens, address keys, and inbox keys.

## Run

From `api/tear/` (after `./setup.sh` and with `TEAR_DATABASE_URL` set to a migrated, disposable-marked loopback Postgres database):

```sh
# Regression campaign + 50 seeded guided runs (~8 s)
tear test access/access.model.ts access --campaign access/campaigns/access.json --seeds 1..50

# Deep exploration with novelty guidance (~66 s for 150 runs x 24 steps)
tear test access/access.model.ts --runs 150 --max-steps 24 --novelty --keep-going

# Reproduce BUG-ACCESS-01 unmasked (3 steps)
tear test access/access.model.ts access --masks run --replay tpbt1_VFBCVAEDAAAAAAAAAAEDAAEEAAAAAAABDgAAAAAABSQAAAAA_8Essg
```
