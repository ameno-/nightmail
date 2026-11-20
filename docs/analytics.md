# Dashboard analytics

Internal, first-party records of what people do in the dashboard: which pages they open, what they click, the dialogs and forms they use, the errors they see and the funnel steps they reach. Agents use it to find friction, not to show anyone a chart. It's separate from the request logs (`docs/ci.md`, Request logs) and never touches Postgres.

## On and off

| Installation | Default | Setting |
| --- | --- | --- |
| Hosted, dev and production (`api/wrangler.<stage>.jsonc`) | On | `DASHBOARD_ANALYTICS=on`, the `ANALYTICS` bucket and the `ANALYTICS_INGEST` rate limiter |
| Self-hosted | **Off** | Set `DASHBOARD_ANALYTICS=on` to record into your own bucket under `analytics/` |

Off, the dashboard sends nothing (`/v1/me` and `/health` answer `analytics: false`), and the ingest answers 204 to anything that arrives and keeps none of it. The browser only posts to its own installation (`POST /internal/v1/analytics`): a self-hosted dashboard never sends anything to Anomaly. Do Not Track and Global Privacy Control turn it off in the browser, and the API drops any batch that carries either header. There are no third-party scripts.

## Nothing on the device

No cookie, `localStorage`, `sessionStorage` or IndexedDB entry, and no visitor ID. The session ID is random and lives in the page's memory, so each page load is a new session. A signed-in page's events carry the account and workspace IDs from its session. A signed-out page (the homepage and sign-in) carries neither. When someone signs in from it, the page puts its session ID in the sign-in return URL (`analyticsSession`), which the API keeps with the sign-in for up to 10 minutes. The callback then writes one `sign_in` event with that session ID and the account ID, and removes the parameter before it redirects, so the browser never opens a URL that carries it (`api/src/account-login.ts`).

## What is never recorded

Typed values, email addresses, message content, subjects, recipients, names, keys and secrets. The dashboard identifies an element by its `data-analytics` name, else by its role and a label of at most 40 characters. The label is scrubbed in the browser and again by the API (`scrubLabel` in `api/src/analytics-events.ts`): addresses, links, domains, IDs, long tokens and every digit are replaced. Paths become route templates (`/receiving/addresses/:id`) without query strings. The API strips unknown fields and drops events that fail the schema. IP addresses aren't stored: a digest of the client address is used only for the rate limit.

## Event schema (v1)

One JSON object per line. Every row has the batch's envelope and one event:

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | `1` | Schema version |
| `id` | string | Event ID, unique; deduplicate on it |
| `received` | ISO time | When the API accepted the batch (partitions use this) |
| `t` | ISO time | When it happened in the browser (replaced by `received` when more than a day off) |
| `seq` | int | Order within the session |
| `sid` | string | Session ID: one page load |
| `ws` / `uid` | string or null | Workspace ID and internal user ID, never an address; null on a signed-out page |
| `app` | string or null | The dashboard build's commit |
| `vp` | `phone`, `tablet`, `desktop` or null | Viewport class at the shell's breakpoints (640 and 900 px); null on `sign_in` |
| `type` | string | One of the event types below |
| `route` | template | The dashboard route the event happened on |
| `ref` | template or null | `page_view`: the route before it |
| `target` | string or null | Element ID: `name`, else `role:label` |
| `name` / `role` / `label` | string or null | The `data-analytics` name; the element's role (`button`, `link`, `tab`, `none` for a click on nothing interactive); its scrubbed label |
| `field` / `reason` | string or null | `form_invalid`: the field's name and its ValidityState flag (`valueMissing`, `typeMismatch`…); `api_error`: the error's field path (`to.#.email`) |
| `code` / `op` / `status` | string, string, int | `api_error`: the API's error code, `METHOD /v1/route/:id` and the HTTP status |
| `ms` | int or null | `page_view`: time spent on `ref`; `page_hide`: time on `route`; `dialog_close`: time the dialog was open |
| `step` | string or null | `track`: the funnel step |

| `type` | When |
| --- | --- |
| `page_view` | A route change, and the first page of a session |
| `page_hide` | The tab is hidden or closed |
| `click` | A click or tap, on anything |
| `dialog_open` / `dialog_close` | A dialog or sheet opens or closes |
| `form_submit` / `form_invalid` | A form is submitted / a field fails the browser's validation |
| `api_error` | An API request the dashboard made failed |
| `track` | A funnel step: `signed_up`, `domain_added`, `domain_verified`, `first_send`, `key_created`, `inbox_created`, `campaign_sent`, `byo_connected` (see below) |
| `sign_in` | Written by the API at the sign-in callback: the signed-out session (`sid`) and the account that signed in from it (`uid`) |

Funnel steps come from the API's answers to the dashboard (`apiResult` in `app/src/lib/analytics.ts`), so each is something the server confirmed. `domain_added`, `key_created`, `inbox_created` and `campaign_sent` fire on the create, send or schedule response. The others are states the dashboard reads, reported once per page and workspace, so take the earliest: `signed_up` (a hosted workspace with no sending connection yet), `byo_connected` (its own AWS connection is ready), `domain_verified` (a verify or domain read says ready) and `first_send` (Overview's setup says the workspace has sent mail). These are first *seen* times, at most a page load after the fact.

`data-analytics` names are lowercase words joined by `-` and `/` (`onboarding/domain/add`, `domains/check`, `campaigns/send`). Name the controls of a flow you want to measure; anything unnamed is recorded by its role and label. Text in table cells, cards, masked addresses, editors and `[data-private]` is never read.

## Storage

| Where | What |
| --- | --- |
| `analytics/v1/raw/dt=YYYY-MM-DD/h=HH/<ms>-<random>.ndjson` | One object per accepted batch (UTC hour of receipt) |
| `analytics/v1/events/dt=YYYY-MM-DD/h=HH/<digest>.ndjson.gz` | The hour's batches, compacted by the hourly upkeep once the hour has ended (up to 1,000 batches per object) |

Hosted installations use their own bucket, `nightmail-<stage>-analytics`, created by Pulumi (`infra/pulumi/index.ts`). Node and other installations use their configured bucket. The hourly upkeep deletes compacted days older than 400 days; hosted buckets also have lifecycle rules as a backstop (raw after 30 days, events after 400).

**Why R2 and not Analytics Engine or a database:** Workers Analytics Engine keeps three months, and the goal is a year. A second Postgres or ClickHouse would be a new database, credential and connection budget for a few thousand events a day, and the production Postgres's 25 connections belong to mail. Immutable NDJSON files in the bucket the installation already has cost almost nothing, work the same on Node and Workers, and any SQL engine can read them.

## Reading it

A row can appear twice (a compaction that was interrupted after writing), so deduplicate on `id`. The current hour is still under `raw/`; read both prefixes for recent data. Order a session's events by `seq`.
