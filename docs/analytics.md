# First-party page analytics

The public site and dashboard post to one same-origin endpoint. Raw events stay in the installation’s object store. Hourly upkeep writes queryable Postgres aggregates; page loads and clicks never write analytics into Postgres. These records are separate from request logs.

## On and off

| Installation | Default | Setting |
| --- | --- | --- |
| Hosted, dev and production (`api/wrangler.<stage>.jsonc`) | On | `DASHBOARD_ANALYTICS=on`, the `ANALYTICS` bucket and the `ANALYTICS_INGEST` rate limiter |
| Self-hosted | **Off** | Set `DASHBOARD_ANALYTICS=on` to record into your own bucket under `analytics/` |

Off, the dashboard sends nothing (`/v1/me` and `/health` answer `analytics: false`), and the ingest answers 204 to anything that arrives and keeps none of it. The browser only posts to its own installation (`POST /internal/v1/analytics`): a self-hosted dashboard never sends anything to Anomaly. Do Not Track and Global Privacy Control turn it off in the browser, and the API drops any batch that carries either header. There are no third-party scripts.

## Nothing on the device

No cookie, `localStorage`, `sessionStorage` or IndexedDB entry. The server computes a visitor code; the browser never receives it. The session ID is random and lives in the page's memory, so each page load is a new session. The dashboard’s own signed-in events carry the account and workspace IDs from its session; public-hook events do not. A signed-out page (the homepage and sign-in) carries neither. When someone signs in from it, the page puts its session ID in the sign-in return URL (`analyticsSession`), which the API keeps with the sign-in for up to 10 minutes. The callback then writes one `sign_in` event with that session ID and the account ID, and removes the parameter before it redirects, so the browser never opens a URL that carries it (`api/src/account-login.ts`).

## What is never recorded

Typed values, email addresses, message content, subjects, recipients, names, keys and secrets. The dashboard identifies an element by its `data-analytics` name, else by its role and a label of at most 40 characters. The label is scrubbed in the browser and again by the API (`scrubLabel` in `api/src/analytics-events.ts`): addresses, links, domains, IDs, long tokens and every digit are replaced. Paths become route templates (`/receiving/addresses/:id`) without query strings. The API strips unknown fields and drops events that fail the schema. The analytics store never receives a raw IP or user agent.

## Public pages and daily visitors

`app/public-beacon.js` is inlined by `publicBeacon.transformIndexHtml` in `app/vite.config.ts`, before the build copies the shell to home.html and the price/compare pages. A standalone static page generated separately should include exactly the same script at the end of its body. Both CSP policies allow only its exact SHA-256. The build checks the hash and the 1 KiB budget. `app/src/components/Analytics.tsx` calls the hook on React Router navigation, so hydration does not cause a second view.

On `/`, pricing, compare, HTML docs and legal pages, the hook sends views and link/CTA clicks after load and idle, once `/health` enables collection. Link targets are public paths, external DNS hostnames, or fixed labels; `data-cta="sign-in"` identifies the shared sign-in control. No link text, query string, fragment, form input or full referrer is collected. These public events carry no account or workspace. Markdown documents, assets and crawlers that do not run JavaScript produce no beacon.

Each UTC date gets a new random 256-bit salt in `analytics/v1/salts/YYYY-MM-DD` (atomic create-if-absent across isolates). HMAC-SHA256 of the date, trusted client IP and user agent yields a 128-bit daily visitor code. Old salts are deleted by hourly upkeep; hosted R2 also expires salt objects after one day. Configure the same one-day prefix lifecycle on self-hosted S3, particularly if turning collection off. Do not version or back up salts. Missing IP or UA means a view with no unique. Shared networks can merge visitors, IP or UA changes can split them, and counts do not identify or link people across dates.

Cloudflare’s verified-bot signal or score of 1, and known crawler UA signatures on either runtime, turn page views into separate `bot_view` rows. All other events in a bot batch are dropped. Cloudflare country and bot signals come from the request’s edge metadata, never client-supplied fields. Node uses its socket peer and has no country; behind a reverse proxy it will see the proxy’s address.

## Event schema (v1)

One JSON object per line. Human rows have the batch's envelope and one event. A bot counter keeps only `v, id, received, type, route`.

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | `1` | Schema version |
| `id` | string | Event ID, unique; deduplicate on it |
| `received` | ISO time | When the API accepted the batch (partitions use this) |
| `t` | ISO time | Public hook: receipt time. Dashboard: when it happened in the browser (replaced by `received` when more than a day off) |
| `seq` | int | Dashboard event order within the session; use receipt time for public events |
| `sid` | string | Session ID: one page load |
| `ws` / `uid` | string or null | Workspace ID and internal user ID, never an address; null on a signed-out page |
| `app` | string or null | The dashboard build's commit |
| `vp` | `phone`, `tablet`, `desktop` or null | Viewport class at the shell's breakpoints (640 and 900 px); null on `sign_in` |
| `type` | string | One of the event types below |
| `vid`, `device`, `country` | string or null | Server-derived UTC-day visitor code, UA device class, Cloudflare country |
| `referrer`, `source`, `medium`, `campaign` | string or null | DNS host and the three UTM slugs (at most 48 letters, digits, underscores or hyphens); unsafe values dropped |
| `public`, `width` | boolean, int | On public-hook events, true and the CSS viewport width in pixels |
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
| `bot_view` | A recognized bot posted a view; excluded from all human metrics |
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
| `analytics/v1/events/dt=YYYY-MM-DD/h=HH/<digest>.ndjson.gz` | The hour's batches, compacted by the hourly upkeep once the hour has ended (up to 64 batches per object) |

Hosted installations use their own bucket, `nightmail-<stage>-analytics`, created by Pulumi (`infra/pulumi/index.ts`). Node and other installations use their configured bucket. The hourly upkeep deletes compacted days older than 400 days; hosted buckets also have lifecycle rules as a backstop (raw after 30 days, events after 400).

Compaction and rollup use the UTC hour of **receipt**, settled five minutes after it ends. Upkeep rereads all parts for a changed hour, deduplicates event IDs, replaces its SQL groups atomically, and only then deletes those raw batches. A failure leaves the raw objects for retry. Older, already compacted hours from before this migration remain available in R2. For direct object reads, deduplicate on `id` across both prefixes.

## SQL and export

- `analytics_hourly`: `hour, metric, dimensions, events, visitors`. Dimensions are JSONB. Internal `visitor_ids` holds the per-group daily codes for exact daily unions; they never leave the export.
- `analytics_funnel_first`: earliest observed hour per workspace and milestone (`signed_up`, `domain_verified`, `first_send`) within retention. Refreshing the dashboard does not create new conversions. `visit` counts views with site-wide distinct visitors for the same bucket. These are aggregate stages, not a cross-day visitor-to-workspace attribution model.
- `analytics_hours`: source snapshot digest, monotonic revision and durable push retry state. SQL and compacted event retention are 400 days.

```sql
SELECT hour, dimensions->>'path' AS path, events, visitors
FROM analytics_hourly WHERE metric = 'page_view' ORDER BY hour DESC;
```

`GET /internal/v1/analytics/export?from=2026-11-20&to=2026-11-21&grain=day` requires a hosted staff dashboard session with `operator:read` or `operator`. Workspace ownership or an API key is insufficient. UTC dates or ISO UTC timestamps, inclusive from/exclusive to, both aligned to grain (`hour` default, or `day`), max 31 days. Only settled rows are returned. Missing periods have no rows.

```json
{"v":1,"from":"2026-11-20T00:00:00.000Z","to":"2026-11-21T00:00:00.000Z","grain":"day","rows":[{"bucket":"2026-11-20T00:00:00.000Z","metric":"visit","dimensions":{},"events":12,"visitors":9}]}
```

`page_view` dimensions: path × referrer × source × medium × campaign × country × device × viewport class. `cta`: path × target (public links and named dashboard controls). `bot_view`: path only. Milestones: counts of workspaces, no identifier. Bot and milestone rows have null visitors. Don't sum distincts across groups; the `visit` row is the site-wide distinct.

## Optional hourly push

Set **both** `ANALYTICS_PUSH_URL` (HTTPS; HTTP permitted only on loopback) and `ANALYTICS_PUSH_SECRET` (32–256 characters, server secret). With neither, no data leaves the installation. Upkeep POSTs the same hourly JSON export plus integer `revision` to this URL, including an empty latest settled hour when appropriate. Headers: `Content-Type: application/json`, `X-Nightmail-Timestamp` (Unix seconds), `X-Nightmail-Signature: sha256=<lowercase hex>`.

Verify HMAC-SHA256 with the shared UTF-8 secret over **timestamp + "." + exact request body bytes** before parsing. Compare in constant time and reject timestamps outside your replay window (e.g. five minutes). Atomically replace the hour identified by `from` only for a newer revision. Return a 2xx after saving; repeated or older revisions should also return 2xx. A timeout, redirect or non-2xx retries after 1, 2, 4, 8, 16, then 24 hours, until delivered or expired. A corrected hour gets a newer revision. Only aggregates are posted, never visitor codes, session IDs, workspace IDs, raw events or salt.
