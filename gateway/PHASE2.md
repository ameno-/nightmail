# Real-store integration

The Rust gateway uses HMAC-signed internal Bane API calls for data, not a second set of table grants or R2 credentials. The API resolves the credential, not a caller-supplied workspace or bucket. Body handles authorize an immutable object for five minutes. A separate Postgres connection listens for `bane_inbox_changed` and `bane_protocol_auth`. Give this role CONNECT only, not table access or membership in the API role. Remote TLS verifies the database certificate and hostname. On listener loss, disconnect existing sessions, clear credential caches and refuse logins until LISTEN is re-established.

## Measured SQL budgets

`cd gateway && python3 e2e.py --real` counts PostgreSQL statements using `pg_stat_statements`. Its observer is separate from the API role. LOGIN: **1 cold, 0 cached**. SELECT: **1** for folder/UID metadata. FETCH UID/FLAGS and BODY.PEEK[]: **0** after selection; body PEEK still reads object storage. Non-PEEK FETCH of an unread message additionally persists Seen and refreshes the selected view. IDLE: **1** shared snapshot query for two sessions using the same credential and folder on one task. Snapshots are scoped by credential; simultaneous sessions using different credentials don't share authorization results. Inbound API acceptance separately counts **1** admission and **2–3** ingest statements on real PostgreSQL.

## Data and migration order

All fourteen unreleased gateway migrations were renamed from `150–163` to `170–183` without reordering. The migrator tracks filenames. Start with dev's `150_attachment_uploader`, `151_inbox_mutation_visibility` and `152_inbox_fence_unread`. Recreate disposable fixtures that ran the old PR migrations rather than applying both sets of filenames.

1. `170` keeps the existing `(inbox_id,role)` key and UIDs; for custom folders its second field is an opaque immutable ID. The mutable path lives on the folder. No PK/FK rebuild. A non-cycling sequence assigns fresh custom UIDVALIDITY. New inboxes immediately seed Drafts; `171` backfills existing inboxes in restartable 250-row pages. Folder mutations lock inbox state; removing memberships takes the ingest lane first, as in phase 2. Existing paths remain valid; folder APIs and dashboard use the same IDs, counts and subscriptions.
2. `172–173` keep protocol credentials separate from inbound API keys. Only workspace managers can issue them, only on persistent inboxes. Store a peppered hash; return the 128-bit secret once. A short login cache is bound to username, protocol and secret. Revoke and logical inbox deletion close access and notify open sessions. Protocol access is free: migration 244 removed the per-inbox daily charge (`inbox_protocol_periods`, `inbox_protocol_daily_usage`); downloads are bounded by a fair-use throttle instead (246).
3. `174–176` use authoritative phase-2 mutations, durable calendar send counts, and the normal Bane sending pipeline. The SMTP daily limit is the workspace sender-score cap; an inbox has no daily or monthly cap of its own (`inbox_state.protocol_daily` and `protocol_monthly` are no longer read, and `MAILGW_DAILY`/`MAILGW_MONTHLY` only size the fixture backend). Compose permission exists only at the signed, credential-rechecked submit endpoint. Existing inbox API keys remain reply-only. SES uses its structured sending path (including attachment policy); the sender’s Sent folder retains the Bcc-scrubbed MIME. A message signed or encrypted as a whole (its top-level type) would not survive reserializing, so it goes out as written (SES Raw content, at most 8 MiB; on Hosted only from a sender past its evaluation). IMAP APPEND preserves the client's private draft bytes. When an inbox's own quota has no room for the Sent copy, the message is still sent, without the copy, and the `250` reply says so.

## Operator handoff (no deployment performed)

Pre-auth admission allows 8 sockets per address, 16 per IPv4 /24 or IPv6 /48, and 128 per task. Unauthenticated clients have 4 s between commands and 15 s from accept to authenticate (`MAILGW_AUTH_SECONDS`, maximum 20 s). After login, work queues acquire credential, inbox, workspace and sponsoring-account permits before task-wide permits. The account is the workspace's stable `quota_sponsor`; unsponsored workspaces share a fallback lane. Open sessions are shared the same way: next to the 10 per inbox (`MAILGW_LOGIN_LIMIT`), a workspace and the account sponsoring it each hold at most `MAILGW_TENANT_SESSIONS` (256) of the task's 1,024 connections, and a login past any of them answers `BYE [LIMIT]` or `421`. The fallback lane has no account share, so an unsponsored workspace is bounded on its own.

Build with `docker buildx build --platform linux/arm64 --load -t bane-mailgw:local gateway` from the repository root. Task secrets: `DATABASE_URL`, `MAILGW_CERT_PEM`, `MAILGW_KEY_PEM`, `MAILGW_API_TOKEN`. The same API token must be independently bound to the Bane API. `MAILGW_API_URL` is required with the token (the binary refuses to start without it); the Pulumi task definition sets the stack's own origin and the program fails without one. The image binds TCP 143/993/465/587 and HTTP `GET /health` on 8080. Never provide `MAILGW_FIXTURE_PASSWORD` in real mode. Apply migrations and deploy the matching API **before** any gateway rollout.

**Limits of the verification:** local MinIO exercises the Node private object-store adapter, not a hosted Worker or real SES delivery. Large-folder refreshes page entries and tombstones; the real-store gate exercises 50,001 entries. Local counts do not measure hosted object-store latency, maximum-literal Worker memory, or Fargate capacity. Strict Dovecot `\Recent` expectations remain different by design; see [the compliance ledger](VERIFICATION.md).

## Send-only SMTP for apps

An app that only sends signs in to SMTP with the username `apikey` and, as the password, an API key that can do nothing but send: a workspace key with `send` alone, limited to sender domains, or a key for receiving addresses with `send` alone (`api/src/protocol-relay.ts`). There is no credential type of its own. The key never opens a mailbox: IMAP refuses it, and every folder operation refuses its ID. A key that can also read or manage, or a workspace key for every domain, is refused like a wrong password.

- **Sign-in.** The API's login returns the key's ID as both `kid` and `inbox`, with its domains (`domains`) or addresses (`addresses`, or `anySender` past 1,000) and no folders. The gateway checks MAIL FROM, From and Sender against them, keys the per-credential session limit and cached sign-ins by the key's ID, and counts failed sign-ins under `apikey` and the key's shown prefix, so one app's revoked key doesn't lock out another app on the same network.
- **Submission.** The API checks the envelope sender, the one From and any Sender again, then sends the message as `POST /v1/emails/send` with that key would: attachments uploaded by the key, headers the API accepts as custom headers passed through (threading and list headers first), recipients from the envelope (To, then Cc from the headers, the rest Bcc), up to 100, sent as emails of up to 50 admitted together. The key is authenticated, charged against its minute budget and admitted in one statement, so limits, screening, billing, suppression, events and dispatch's recheck are sendEmail's. There is no Sent folder.
- **Revocation.** Revoking a key, or changing its permissions, domains or addresses, notifies `bane_protocol_auth` with its ID (migration 346): open sessions end with `421`, cached sign-ins go, the next submission is refused, and mail it queued is not sent.

## Dev turn-on runbook

Dev: AWS `905840579680`, Worker `bane-dev`, `dev.bane.mx`. Production follows the [production runbook](#production-turn-on-runbook) below. DNS stays on Spectrum: leave `bane:mailGatewayDns` off and test through the stack output `mailGatewayEndpoint` with the stage hostnames as SNI.

**The switch is `bane:mailGatewayEnabled` in `infra/pulumi/Pulumi.<stage>.yaml`.** Pulumi and the Worker deploy (`.github/scripts/deploy-worker.sh`) both read the committed value, so there is no third state:

- **True:** the deploy reads `bane/<stage>/MAILGW_API_TOKEN` inside its "Deploy the Worker" step and binds it to the Worker. If the token is missing, pending deletion, unreadable or malformed, the deploy stops.
- **False (default):** the deploy removes the Worker's `MAILGW_API_TOKEN` binding if one exists, before deploying, and checks that it's gone. `/internal/v1/mail` then answers 403 `PROTOCOL_DENIED`.

Every deploy ends by checking that the Worker's binding matches the flag. Pulumi refuses a positive `bane:mailGatewayDesired` while the flag is false.

**Before starting:** the dev stack has applied the gateway at zero tasks (needs [Dax's one-time IAM](../infra/pulumi/README.md#dax-one-time-iam-for-the-gateway); already true on 2026-11-12, when the dev deploy's Pulumi step printed `mailGatewayEndpoint`), migrations `170–183` are applied on dev, and the dev Worker is deployed from a commit that contains this runbook.

### 1. Secrets Dax fills

Set every value out of band: never in stack config, argv, the image or logs. Pulumi created the four `mail-gateway/` containers in the dev account (`us-east-2`) as metadata only. The Worker's copy of the token lives in the secrets account (`604439173067`, `us-east-1`).

| Secret | Becomes | Value |
|---|---|---|
| `bane/dev/mail-gateway/db-url` | gateway `DATABASE_URL` | `postgresql://bane_mailgw_listen:<url-encoded password>@<host>:5432/<database>?sslmode=verify-full&sslrootcert=system`. Same host and database as `bane/dev/DATABASE_URL`, over a direct session connection: LISTEN doesn't work through a transaction pooler such as PgBouncer. The gateway refuses plaintext to any non-localhost host and verifies the server certificate chain (public WebPKI roots) and hostname. |
| `bane/dev/mail-gateway/tls-cert` | `MAILGW_CERT_PEM` | PEM full chain, leaf first, from a public CA, with SANs `imap.dev.bane.mx` and `smtp.dev.bane.mx`. |
| `bane/dev/mail-gateway/tls-key` | `MAILGW_KEY_PEM` | The matching private key, PEM (PKCS#8, SEC1 or PKCS#1). |
| `bane/dev/mail-gateway/api-token` | gateway `MAILGW_API_TOKEN` | One random token, at least 32 characters from `[A-Za-z0-9._~+/=-]`. `openssl rand -hex 32` gives 64. |
| `bane/dev/MAILGW_API_TOKEN` (secrets account) | Worker `MAILGW_API_TOKEN` | **The same token, byte for byte.** Read only while `bane:mailGatewayEnabled` is true, and only inside "Deploy the Worker". It is never written to `$GITHUB_ENV`. |

Create the listener role as the database owner in `psql`. `\password` keeps the password out of history:

```sql
CREATE ROLE bane_mailgw_listen LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 2;
GRANT CONNECT ON DATABASE <database> TO bane_mailgw_listen;
\password bane_mailgw_listen
```

Grant nothing else. LISTEN needs only a connection, and two connections cover one task plus its replacement during a rolling deploy. Connected as the role, check that `LISTEN bane_inbox_changed` succeeds, `SELECT 1 FROM workspaces LIMIT 1` fails with `permission denied`, and `SELECT rolname FROM pg_roles WHERE pg_has_role('bane_mailgw_listen', oid, 'MEMBER')` returns only `bane_mailgw_listen`.

Write one token to both places without putting it in argv:

```sh
umask 077; token=$(openssl rand -hex 32)
# As a dev-account (905840579680) administrator:
printf %s "$token" | aws secretsmanager put-secret-value --region us-east-2 --secret-id bane/dev/mail-gateway/api-token --secret-string file:///dev/stdin
# From an anomalyco/secrets checkout, signed in to the anomaly SSO session:
printf %s "$token" | bun set bane dev MAILGW_API_TOKEN
unset token
```

Before uploading the certificate, check that the key matches: `openssl x509 -noout -pubkey -in fullchain.pem | openssl sha256` must equal `openssl pkey -pubout -in privkey.pem | openssl sha256`. Then upload `tls-cert`, `tls-key` and `db-url` the same way, with `--secret-string file://fullchain.pem`, `file://privkey.pem` and `file:///dev/stdin`.

### 2. Enable dev and give the Worker the token

Once both copies of the token exist, open a PR to `dev` that adds one line to `infra/pulumi/Pulumi.dev.yaml` and nowhere else:

```yaml
  bane:mailGatewayEnabled: "true"
```

Merge it before any task starts; without the Worker's token every gateway login is refused. If the CI copy is missing or malformed, the deploy stops in "Deploy the Worker" and the Worker stays closed: fix the secret and re-run the job. Check:

- "Deploy the Worker" ends with `Mail gateway: bane:mailGatewayEnabled=true; Worker MAILGW_API_TOKEN bound=true.`
- From `api/`, `bunx wrangler secret list --config wrangler.dev.jsonc` lists `MAILGW_API_TOKEN`.
- An unsigned `curl -sX POST https://dev.bane.mx/internal/v1/mail` still returns 403 `PROTOCOL_DENIED`. Only signed calls pass.

### 3. Publish the image

As a dev-account administrator, from a `dev` commit (CI can't push to ECR):

```sh
repo=905840579680.dkr.ecr.us-east-2.amazonaws.com/bane-mail-gateway tag=$(git rev-parse --short=12 HEAD)
aws ecr get-login-password --region us-east-2 | docker login --username AWS --password-stdin "${repo%%/*}"
docker buildx build --platform linux/arm64 --provenance=false --push -t "$repo:$tag" gateway
aws ecr describe-images --region us-east-2 --repository-name bane-mail-gateway --image-ids imageTag="$tag" --query 'imageDetails[0].imageDigest' --output text
```

### 4. Start one dev task

In a PR to `dev`, add these two lines to `infra/pulumi/Pulumi.dev.yaml` and nowhere else:

```yaml
  bane:mailGatewayImage: 905840579680.dkr.ecr.us-east-2.amazonaws.com/bane-mail-gateway@sha256:<digest>
  bane:mailGatewayDesired: "1"
```

Leave `Pulumi.production.yaml` unchanged, and don't set `bane:mailGatewayDns`. Pulumi refuses this change unless step 2's `bane:mailGatewayEnabled: "true"` is already in the file. Merging runs Pulumi for the dev stack, which waits up to 30 minutes for a steady service. If the task never becomes healthy, the ECS circuit breaker rolls it back, and that deploy fails before it reaches the Worker. One task is enough for dev: the NLB is cross-zone, and every task holds its own LISTEN connection.

### 5. Verify

Take `mailGatewayEndpoint` from the Pulumi step's output and set `NLB` to it.

1. All four target groups report one `healthy` target: `for p in 993 143 465 587; do aws elbv2 describe-target-health --region us-east-2 --target-group-arn "$(aws elbv2 describe-target-groups --region us-east-2 --names bane-mail-gateway-$p --query 'TargetGroups[0].TargetGroupArn' --output text)" --query 'TargetHealthDescriptions[].TargetHealth.State' --output text; done`.
2. TLS verifies on all four paths. Each command must end with `Verify return code: 0 (ok)`:
   ```sh
   openssl s_client -connect "$NLB:993" -servername imap.dev.bane.mx -verify_hostname imap.dev.bane.mx -verify_return_error </dev/null
   openssl s_client -connect "$NLB:143" -starttls imap -servername imap.dev.bane.mx -verify_hostname imap.dev.bane.mx -verify_return_error </dev/null
   openssl s_client -connect "$NLB:465" -servername smtp.dev.bane.mx -verify_hostname smtp.dev.bane.mx -verify_return_error </dev/null
   openssl s_client -connect "$NLB:587" -starttls smtp -servername smtp.dev.bane.mx -verify_hostname smtp.dev.bane.mx -verify_return_error </dev/null
   ```
3. A real login works. In the E2E workspace, issue an app password on a persistent inbox with `POST /v1/inboxes/{id}/app-passwords` and `{"name":"gateway turn-on","protocols":["imap","smtp"]}`. Then run `curl --connect-to "imap.dev.bane.mx:993:$NLB:993" --user '<inbox address>' 'imaps://imap.dev.bane.mx/INBOX'`; curl prompts for the password.

### 6. Measure

Run each phase on its own: one client address gets at most 8 sockets. One workspace's lanes allow 2 SMTP submissions, 3 APPENDs and 3 large responses in flight. The per-task ceiling of 4, 8 and 6 needs workspaces with different `quota_sponsor`s.

| What | How | Pass |
|---|---|---|
| Low ports | `/ecs/bane-mail-gateway` logs show `IMAPS 993`, `IMAP 143`, `SMTPS 465` and `SMTP 587`, then `READY`. Fargate keeps the 1024 floor for nonroot binds, so the task definition lowers `net.ipv4.ip_unprivileged_port_start` to 143 for the distroless nonroot user. | All four lines, no `Permission denied (os error 13)`, four healthy target groups. |
| Worker memory | From `api/`, run `bunx wrangler tail --config wrangler.dev.jsonc --format json` while sending 36 MiB messages and 40 MiB APPENDs (the SMTP `SIZE` and IMAP `APPENDLIMIT` maximums; both stream to the API): first one at a time, then at the lane limits above. Cover SMTP submission on 587, IMAP APPEND, and `BODY.PEEK[]` of the stored message. | No `exceededMemory` or `exceededCpu` outcome and no 5xx on `/internal/v1/mail`. An isolate has 128 MB and can serve several of these calls at once. |
| R2 latency | The Worker's `worker-runtime` log lines carry `runtimeMs` for each `/internal/v1/mail` call. On the client, run `curl -w '%{time_total}\n'` on `imaps://imap.dev.bane.mx/INBOX;UID=<n>` for 10 KiB, 1 MiB and 8 MiB messages, 20 runs each, both warm and after 5 idle minutes. The Worker is placed in `aws:us-east-2` and `bane-dev-mail` is in ENAM. | Record p50 and p95. Investigate a p95 above 2 s at 1 MiB or less. Calls near 20 s fail, because the gateway's API client times out there (an APPEND or submission upload after 120 s). |
| Pool saturation | Run `SELECT usename, state, count(*) FROM pg_stat_activity GROUP BY 1, 2` during the live dev E2E plus the load above, and again during `aws ecs update-service --region us-east-2 --cluster bane-mail-gateway --service bane-mail-gateway --force-new-deployment`. Dev's database allows 22 non-superuser connections. Hyperdrive opens up to 10 per pool and can run two pools, the listener adds 1 (2 while rolling), and `bun run migrate` adds 1. Also watch the service's `CPUUtilization` and `MemoryUtilization` (0.5 vCPU, 1 GiB). | No `too many connections` or `remaining connection slots are reserved` errors, no Worker 503 `RUNTIME_UNAVAILABLE` or 429 `ADMISSION_RATE_LIMITED`, and no `protocol notification connection unavailable` in the gateway logs. If fewer than 2 connections remain free at peak, lower Hyperdrive or raise the database limit before production. |

Record the numbers in this file next to the SQL budgets, then revoke the test app passwords.

### Rollback

1. **Disable in one PR.** In `Pulumi.dev.yaml`, set `bane:mailGatewayEnabled: "false"` and `bane:mailGatewayDesired: "0"` (keep the image line), then merge. Pulumi scales the service to zero. "Deploy the Worker" then deletes the Worker's `MAILGW_API_TOKEN`, checks that it's gone and ends with `bane:mailGatewayEnabled=false; Worker MAILGW_API_TOKEN bound=false`. The Worker is back to 403 `PROTOCOL_DENIED`, and later deploys keep it that way. The NLB, the secrets, the image and the rest of dev stay unchanged. The CI copy of the token can stay, because it isn't read while the flag is false.
2. **If it can't wait for the pipeline** (urgent, or a failing service blocks the dev deploy), act directly as a dev administrator and still land step 1 right after:
   - Run `aws ecs update-service --region us-east-2 --cluster bane-mail-gateway --service bane-mail-gateway --desired-count 0`.
   - From `api/`, run `bunx wrangler secret delete MAILGW_API_TOKEN --config wrangler.dev.jsonc`.

   Until step 1 merges, a deploy with the flag still true binds the CI copy again. If you deleted the CI copy, that deploy stops instead.
3. **Close the database role.** Run `ALTER ROLE bane_mailgw_listen NOLOGIN;`, then `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'bane_mailgw_listen';`.
4. **Revoke test app passwords** with `DELETE /v1/inboxes/{id}/app-passwords/{passwordId}`. DNS never changed, so there's nothing to restore.

## Production turn-on runbook

Production: AWS `009882681002` (`us-east-2`), Worker `bane-production`. The gateway that runs is the stack's `nightmail-mail-gateway` (`bane:nightmailGateway*`), as on dev. Mail apps use `imap.nightmail.dev` and `smtp.nightmail.dev` (`MAILGW_PUBLIC_DOMAIN` in `api/wrangler.prod.jsonc`, shown only while the Worker has its token); tasks call the API at `https://bane.mx` (`MAILGW_API_URL`, the stack's origin).

Production stays off (`bane:mailGatewayEnabled` unset in `infra/pulumi/Pulumi.production.yaml`) until steps 1–4 are done: once the flag is committed, every production deploy stops in "Deploy the Worker" while `nightmail/production/MAILGW_API_TOKEN` is missing, which would hold every other release.

1. **Secrets**, as for dev (§1), with production names:
   - One token, written byte for byte to `nightmail/production/mail-gateway/api-token` (production account, `us-east-2`) and to `nightmail/production/MAILGW_API_TOKEN` (secrets account `604439173067`, `us-east-1`).
   - `nightmail/production/mail-gateway/tls-cert` and `tls-key`: a public-CA certificate with SANs `imap.nightmail.dev` and `smtp.nightmail.dev`, and its key (check they match; allow the CA in any `nightmail.dev` CAA record).
2. **Database role.** Create `bane_mailgw_listen` as for dev with `CONNECTION LIMIT 4` (two tasks and their replacements), grant it only CONNECT, and put a direct session connection (not a pooler) with `sslmode=verify-full` in `nightmail/production/mail-gateway/db-url`. Check the database has 4 connections to spare at peak.
3. **Image** from a `dev` commit that contains send-only SMTP, as a production-account administrator: §3 with `repo=009882681002.dkr.ecr.us-east-2.amazonaws.com/nightmail-mail-gateway`. Note its digest.
4. **DNS.** In the `nightmail.dev` zone, add DNS-only CNAMEs `imap` and `smtp` to the Pulumi output `nightmailGatewayEndpoint`, TTL 300 (the stack writes only the `bane.mx` zone, so it refuses `bane:nightmailGatewayDns` here). Nothing answers behind them yet.
5. **Turn it on in one PR**, opened only once 1–4 are approved and done. In `Pulumi.production.yaml` add `bane:mailGatewayEnabled: "true"` and `bane:nightmailGatewayImage: 009882681002.dkr.ecr.us-east-2.amazonaws.com/nightmail-mail-gateway@sha256:<digest>`, and change `bane:nightmailGatewayDesired` to `"2"`; nothing else. Promoting it runs Pulumi first (two tasks, waiting for a steady service), then "Deploy the Worker", which ends with `Mail gateway: bane:mailGatewayEnabled=true; Worker MAILGW_API_TOKEN bound=true.` Between the two, sign-ins are refused for a few minutes. The dashboard then shows the IMAP and SMTP settings and offers SMTP logins.
6. **Verify** as in §5, with `NLB` set to `nightmailGatewayEndpoint`, target groups `nightmail-mail-gateway-<port>` and the production hostnames as SNI, and again through the hostnames. An unsigned `curl -sX POST https://nightmail.dev/internal/v1/mail` still answers 403 `PROTOCOL_DENIED`. Sign in with an app password, and send one message through an SMTP login (`apikey`) to an address you own.

**Rollback:** set `bane:mailGatewayEnabled: "false"` and `bane:nightmailGatewayDesired: "0"` (keep the image line) and promote; urgently, §Rollback 2 with `--cluster nightmail-mail-gateway --service nightmail-mail-gateway` and `--config wrangler.prod.jsonc`. Remove the two CNAMEs.
