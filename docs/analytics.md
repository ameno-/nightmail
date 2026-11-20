# Dashboard analytics

Internal, first-party records of what people do in the dashboard: which pages they open, what they click, the dialogs and forms they use, the errors they see and the funnel steps they reach. Agents use it to find friction, not to show anyone a chart. It's separate from the request logs (`docs/ci.md`, Request logs) and never touches Postgres.

## On and off

| Installation | Default | Setting |
| --- | --- | --- |
| Hosted (`api/wrangler.<stage>.jsonc`) | On | `NIGHTMAIL_DASHBOARD_ANALYTICS=true`, the `ANALYTICS` bucket and the `ANALYTICS_INGEST` rate limiter |
| Self-hosted | **Off** | Set `NIGHTMAIL_DASHBOARD_ANALYTICS=true` to record into your own bucket under `analytics/` |

The browser only posts to its own installation (`POST /internal/v1/analytics`): a self-hosted dashboard never sends anything to Anomaly. Do Not Track and Global Privacy Control turn it off in the browser, and the API drops any batch that carries either header. There are no cookies and no third-party scripts.

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
| `sid` / `vid` | string | Session ID (a tab, ending after 30 minutes idle) / visitor ID (a browser) |
| `ws` / `uid` | string or null | Workspace ID and internal user ID, never an address |
| `app` | string or null | The dashboard build's commit |
| `vp` | `phone`, `tablet`, `desktop` | Viewport class at the shell's breakpoints (640 and 900 px) |
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
| `track` | A funnel step: `signed_up`, `domain_added`, `domain_verified`, `first_send`, `key_created`, `inbox_created`, `campaign_sent`, `byo_connected` |

## Storage

| Where | What |
| --- | --- |
| `analytics/v1/raw/dt=YYYY-MM-DD/h=HH/<ms>-<random>.ndjson` | One object per accepted batch (UTC hour of receipt) |
| `analytics/v1/events/dt=YYYY-MM-DD/h=HH/<digest>.ndjson.gz` | The hour's batches, compacted by the hourly upkeep once the hour has ended (up to 1,000 batches per object) |

Hosted installations use their own bucket, `nightmail-<stage>-analytics`, created by Pulumi (`infra/pulumi/index.ts`). Node and other installations use their configured bucket. The hourly upkeep deletes compacted days older than 400 days; hosted buckets also have lifecycle rules as a backstop (raw after 30 days, events after 400).

**Why R2 and not Analytics Engine or a database:** Workers Analytics Engine keeps three months, and the goal is a year. A second Postgres or ClickHouse would be a new database, credential and connection budget for a few thousand events a day, and the production Postgres's 25 connections belong to mail. Immutable NDJSON files in the bucket the installation already has cost almost nothing, work the same on Node and Workers, and any SQL engine can read them.

## Reading it

A row can appear twice (a compaction that was interrupted after writing), so deduplicate on `id`. The current hour is still under `raw/`; read both prefixes for recent data. Order a session's events by `seq`.
