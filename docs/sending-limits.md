# How sending limits work (Hosted)

Hosted Nightmail gives each workspace a **sender score** (0–100) from the quality of what it sends. A sender in good standing has **no daily limit**: only a per-minute pace that protects the shared pool. A daily limit appears only when the signals go bad, and tightens as the score falls. Nightmail stays out of the way unless something goes wrong: it **warns** first, then **holds marketing**, and **pauses** only for problems that put the shared pool at risk. These thresholds are public; how Nightmail detects abuse is not.

Everything here is in the API: `GET /v1/sender-score` (score, factors, `limit`, `standing`, and `standing.probation` for the checks below), the `account.standing.changed` webhook event, and `connection.standing` on `GET /v1/me`. Self-hosted and bring-your-own-AWS installations get the score for display only.

## Score → daily limit

| Score | Grade | Daily limit (rolling 24 h, recipients) | Per minute | Marketing per hour |
| --- | --- | --- | --- | --- |
| evaluation (first 500 recipients) | – | 500, until their results are in | 50 | 125 |
| 75 and up | A+, A, B, upper C | **none** | Full pool SES rate past growth (¼ during growth), at least 500; ½ per domain | no separate limit |
| 70–74 | C | 500 | 50 | 125 |
| 65–69 | D | 200 | 50 | 50 |
| under 65 | D, F | 100 | 50 | 25 |

- **The evaluation:** a new workspace's first 500 real recipients (simulator mail never counts) go at the normal pace, transactional or marketing, and it can send no more until their delivery results are in: 90% of them delivered or bounced, or an hour after the 500th was accepted, whichever comes first (the ten-minute job grades it at its next run; `gradedBy` is the latest). Hard bounces and the spam screen, the signs of a bad list, arrive within minutes, so that is the shortest wait that has them. The score is then those 500 recipients' quality alone: a clean evaluation lands at its real score at once (500 perfect emails are 100) and has no daily limit; a bad one starts capped. `gradedBy` in `GET /v1/sender-score` says when the first grade comes at the latest.
- **After it, the score is live:** it is recomputed from all the evidence, recounted hourly, with no daily limit on how far it moves. Complaints arrive days later; when they do, they lower the score at once, measured against the mail actually sent, and the ladder's count-and-rate lines (below) catch them in the 24-hour and 7-day windows. There is no separate provisional mode.
- **Good standing** is a score of 75 or more and no ladder step from warn up. A sender that delivers about 99% of its mail, bounces under 2% and draws almost no complaints scores around 90.
- **Hysteresis:** a limit appears, or drops a band, only when the score is 2 points under the band's floor (73 for good standing). Recovering to the floor lifts it again.
- **Growth after the evaluation:** for 24 clean hours a new sender's volume grows instead of jumping to the full pace, so a clean evaluation cannot be followed at once by a blast before any feedback exists. A sponsor's growing workspaces (an account's workspaces share one) may have at most **1,000 recipients sent in any rolling hour**, every stream, enforced in the dispatch claim. After each completed hour whose results are in (90% of its accepted recipients delivered or bounced) and that was clean (hard bounces under 2%, no complaints, quality at most 2 points below the last growth), the allowance becomes twice that hour's **distinct** real recipients if that is more. Stale feedback, a notice or worse, or worsening quality stop the growth; nothing lowers it; a step from warn up starts the 24 hours again. A good sender doubles every hour (about a million an hour after ten). Mail over it waits in the queue. `limit.growth` shows it, and the dashboard says "Growing: up to N this hour". An operator can lift it for a known launch.
- **Only new senders grow:** a workspace skips the growth pace, or leaves it at the next standing run (on its timeline and in the operator audit), with an operator daily-limit override, or with a clean track record SES accepted before the pace existed: in the 30 days before, after its first 500, mail on 3 days to 300 distinct real recipients at more than one domain, 90% resolved, hard bounces under 2% and no complaints, in good standing. Mail accepted later never counts.
- **Frozen by a step:** from warn up, and on any pause or resume, the limit cannot rise. A workspace without one gets one at once: what SES accepted from it in the last 24 hours (never queued or unsent mail), at least 10,000. The 50% after a resume and a second strike's half are taken from that number, and the limit stays frozen until the step and the strike's 7 days are over. A falling score still tightens it. When the step clears and the score is 75 or more, the limit is gone again.
- **Pacing** is platform protection, not a customer limit. In good standing (no daily limit and past the 24-hour growth pace) a workspace plans and paces at the full pool SES rate (at least 500 a minute; a quarter of the pool rate while in the growth pace), with half of it per sending domain (at least 50) as a softer guard; with a daily limit, `clamp(limit ÷ 20, 50, 500)` a minute. In good standing past the growth pace, transactional mail has its own per-workspace and per-domain minute allowance (¼ of the pool SES rate: 3,000 a minute and 1,500 per domain at 200 a second), separate from marketing's, so a campaign never uses up a workspace's transactional allowance and transactional stays bounded; otherwise both streams share the one minute cap above. Under the pool's own rate, the dispatcher always prioritizes transactional mail first (with a reserved slice lent to marketing whenever unused) and shares marketing work-conservingly round-robin across active workspaces ([dispatch scaling](dispatch-scaling.md)). At a pool rate of 200 a second a good sender past growth paces up to 12,000 a minute (6,000 per sending domain).
- **Queued mail** is a queue bound, not a daily limit: in good standing a day of the pace may wait to be sent, at most 200,000 emails, and during the evaluation, the growth pace or under a daily limit 10,000. Past that a send is refused with a retryable 429 `PENDING_EMAIL_LIMIT_EXCEEDED` until the queue drains. Scheduled sends wait separately: up to 100,000 per workspace.
- **Transactional reserve:** after the evaluation, under a daily limit, marketing may use at most `limit − max(100, 10% of limit)`, so a small sender always keeps 100 a day for receipts and password resets. During the evaluation there is no reserve: its 500 may all be marketing, so a sender of newsletters alone can send its first campaign and finish the evaluation; the evaluation lifts within about an hour of its last recipient. Without a daily limit there is nothing to reserve.
- **Grades:** A+ ≥ 95, A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F below.
- **Overrides:** an operator can still set a workspace's daily limit (after a review, or to cap one). There are no limit requests to approve: a workspace in good standing has nothing to raise, and a capped one is lifted by the job as it recovers.
- Lowering a limit applies to new mail at once. Mail already accepted is never recalled.
- **Scheduled sends** (`sendEmail` with `scheduledAt`) count when they go, not when they are scheduled: at its time an email is checked against the limit, the balance and the standing of that moment. One they refuse is rejected with the same code a send would get (`SEND_LIMIT_REACHED`, `BALANCE_EXHAUSTED`, …) and the `email.rejected` webhook; it is never sent late.

In `GET /v1/sender-score`, no daily limit is `limit.daily: null` with `limit.unlimited: true`; `limit.band` and `limit.marketingPerHour` are then what the pace allows in a day and an hour, and `limit.transactionalReserve` is 0. `connection.sendingLimit.cap` on `GET /v1/me` and `daily.cap` on `GET /v1/usage` are null too.

## What the score is made of

| Factor | Weight | Good (100) | Bad (0) |
| --- | --- | --- | --- |
| Complaints ÷ delivered | 30 | ≤ 0.01% | ≥ 0.3% |
| Spam screen rejections ÷ screened | 20 | ≤ 0.1% | ≥ 3% |
| Hard bounces to known recipients ÷ accepted | 15 | ≤ 0.5% | ≥ 5% |
| List quality (campaign mail): first-send bounces and suppression hits | 15 | ≤ 2% | ≥ 10% |
| Authentication: DKIM 40%, aligned SPF 30%, DMARC enforcing 30% | 10 | all three | none |
| Engagement: marketing unsubscribes ÷ delivered, lifted by clicks | 10 | ≤ 0.2% | ≥ 2% |

- A factor with nothing to measure is neutral: it drops out and the others are re-weighted.
- Evidence fades with a **30-day half-life**. The score is the weighted result itself (no volume prior): 100 perfect emails give 100. With nothing measured at all (no real mail in 180 days) it is 60.
- Opens are ignored (mail privacy features inflate them).

## When something goes wrong: the ladder

Nightmail checks every 10 minutes. Every feedback or screen line needs **both** the minimum event count and the minimum rate. Feedback rates use accepted mail in the same stream, with one extra day to allow for late feedback (24 hours of events against 48 hours of accepted mail, or 7 days against 8). Screen rates use screened mail in 24 hours. Without volume there is no measured rate.

| Signal | ① Warn | ② Restrict | ③ Pause |
| --- | --- | --- | --- |
| Complaints | ≥ 0.05% and ≥ 2 in 24 h, or ≥ 0.05% and ≥ 3 in 7 days | ≥ 0.1% and ≥ 3 in 24 h | ≥ 0.3% and ≥ 5 in 24 h, or ≥ 0.15% and ≥ 10 in 7 days |
| Hard bounces | ≥ 2% and ≥ 10 in 24 h, or ≥ 1.5% and ≥ 10 in 7 days | marketing ≥ 4% and ≥ 25, or any mail ≥ 8% and ≥ 50, in 24 h | **transactional** mail ≥ 5% and ≥ 50 in 24 h |
| Spam screen rejections ÷ screened | ≥ 2% and ≥ 3 in 24 h | ≥ 5% and ≥ 10 in 24 h | ≥ 10% and ≥ 25 in 24 h |
| External | – | – | AWS paused the workspace's SES tenant; confirmed abuse |

A **notice** sits below Warn: in 24 hours, at least 2 complaints at 0.01% or higher, or at least 3 hard bounces at 1% or higher. It adds a dashboard note, with no email or sending hold.

| Step | You see | Mail | Limit |
| --- | --- | --- | --- |
| Notice | A note on the score card | unchanged | unchanged |
| ① Warn | Overview card, a dot on the score, an email to owners and admins | unchanged | frozen (no rises; none becomes the last 24 hours, at least 10,000) |
| ② Restrict | A banner on every page, an email | Campaigns pause and new marketing is refused (409 `MARKETING_HELD`). Transactional mail keeps flowing. | frozen |
| ③ Pause | A red banner on every page, an email | All sending stops (409 `HOSTED_SENDING_PAUSED`) and the workspace's SES tenants are disabled. Receiving, inboxes and the dashboard keep working. Queued mail is held for 72 hours, then canceled (`ACCOUNT_PAUSED`). | 0 |

Bounces alone hold marketing; they stop everything only when **transactional mail itself** bounces at 5% (and 50). Complaints, the spam screen, abuse and an AWS tenant pause stop everything.

## Getting back

| Step | By itself | Owner (dashboard, after the fix checklist) | Nightmail |
| --- | --- | --- | --- |
| ① Warn | clears after 24 hours under 80% of its line | – | – |
| ② Restrict | – | 24 hours after it started, once every 14 days, when the last 24 hours are under the warn line: marketing resumes at 50% of its allowance for 48 hours | a second restrict within 14 days |
| ③ Pause from transactional bounces | – | once every 30 days: the limit is 50% for 48 hours and marketing stays held for 24 hours | otherwise |
| ③ Any other pause | – | – | review only |

- A resume never restarts the limit at 100 a day. The 50% is of the limit before the resume (the frozen one), for 48 hours, even if the score has meanwhile earned no limit; another resume in that window keeps it there. Each pause leaves a **strike** for 90 days; the second caps the limit at 50% for 7 days, and the third needs a review for any resume.
- The owner action is `POST /v1/sender-score/release` (dashboard sessions, owners and admins); `standing.selfService` in `GET /v1/sender-score` says whether it is available, and when.

## What Nightmail emails you

Owners and admins get one short email for each of these, and at most one a day of each: a **warning**, **marketing put on hold**, **sending paused** and **sending resumed**, a **campaign that paused itself**, the **daily limit reached** (when a send is refused at it, never during the evaluation) and the **evaluation's end**. One problem sends one email, the most serious: a campaign's pause is not emailed when the workspace is held or paused for it, and a warning is not when a campaign's pause says the same. The email says what happened, what it means for your mail and what to do; the reasons and numbers are on the dashboard and in `account.standing.changed`.

## Checks for new senders

A workspace in its evaluation, in the growth pace, or below good standing (a daily limit set by the score, a freeze or a strike, or a step from warn up) is on **probation**: `standing.probation` in `GET /v1/sender-score` is `evaluation`, `growth` or `standing`. Until then Hosted adds these checks; they end by themselves on good standing, with nothing to request:

- **Delivered as screened.** Each message goes out as the copy the content screen read: style sheet rules are inlined, `@media`, dark-mode and other rules a client applies only sometimes are left out, and blocks the light, desktop rendering hides are dropped. Responsive emails arrive in their desktop layout.
- **Attachments of a standard type** whose name, declared type and bytes agree (422 `ATTACHMENT_TYPE_UNSCREENABLE` or `ATTACHMENT_CONTENT_MISMATCH`).
- **The list probe** below, on every campaign over 100 recipients.

Every message is screened either way. In good standing it goes out as written, and the screen reads all of it: text that CSS hides or that only a media query, dark mode or Outlook shows, what style sheets draw (generated content, with its `var()` and `attr()` values, however escaped), and elements that CSS displays though clients hide them by default. CSS too complex to read within the screen's budget is refused (422 `CONTENT_TOO_LARGE_TO_SCREEN`).

The screen reads no picture, so every sender keeps the picture rules, in good standing too:

- **Words beside images.** A 200 × 200 logo needs none; every further 600 × 300 px of images needs 25 words (422 `CONTENT_IMAGE_ONLY`). For a message delivered as written, every picture it can show counts, including images that are hidden, only some clients show, backgrounds and images its style sheets draw; an image whose size its CSS could change (its own `style`, or any style sheet rule, media queries included, that could select it) counts at full size, at least 600 × 400.
- **No SVG**, and inline images only as PNG, JPEG, GIF, WebP or BMP whose bytes match (422 `ATTACHMENT_TYPE_UNSCREENABLE`).

## Campaign list probe

A Hosted campaign with more than 100 recipients sends a **probe** first: the first `min(500, 10%)` recipients, at least 100. Release waits until the probe has gone out and ten more minutes for its feedback (`delivery.waiting.reason` is `list_probe`). More than 3% hard bounces or 2 complaints **quarantines** the campaign (paused, `LIST_QUALITY`); bounced addresses are suppressed and owners get an email. The owner can resume a quarantined campaign once; a second quarantine needs a review (409 `QUARANTINE_REVIEW_REQUIRED`). A quarantine never pauses the account.

A sender in good standing skips the probe when its recipients were **mailed cleanly**: one of its last three campaigns finished in the last 90 days without a quarantine and, judged by recipient address (any list or segment):

- delivered to at least 90% of this campaign's recipients (an address it bounced, drew a complaint from, never mailed or has no result for counts against it);
- has mature feedback for them: at least 90% delivered or bounced, and ten minutes since the last result;
- stayed within 3% hard bounces and 0.08% complaints for them.

A campaign over 10,000 recipients is always probed. This is decided once, before the first recipient is released. If the sender falls below good standing while such a campaign is sending, release stops: what was already released is checked as a probe (it leaves the queue, ten minutes pass, then the same lines) before the rest goes out.

Every campaign, probed or not, still pauses at more than 2% bounces after 1,000 accepted or more than 0.08% complaints after 2,000.

## Campaign ramp

A Hosted sender's first large campaigns **ramp**: they release in hourly steps of 1,000, 2,500, 5,000, 10,000, 20,000, 40,000, 75,000, 150,000 and 300,000 recipients (`RAMP` in `api/src/standing-model.ts`), then at their other limits only. It applies to every Hosted workspace, exempt and first-party ones included, and to its marketing only: campaigns, and `kind: "marketing"` sent through `POST /v1/emails/send` and `/v1/emails/batch`, which share the step's hourly ceiling with them. Transactional mail never waits for it. Each step lasts at least an hour. Then, once its batch has left the queue and 90% of what SES accepted has a delivery result (or an hour after the step ended), the batch is checked: more than 3% hard bounces of at least 100 accepted, or more than 0.08% complaints counting at least 2, pause the campaign as a quarantine (`BOUNCE_RATE_HIGH` or `COMPLAINT_RATE_HIGH`, the message says which ramp step); a resume starts that step's hour again. A clean batch that released at least half its step's ceiling moves the campaign to the next step. Release waits meanwhile with `delivery.waiting.reason` `ramp`. Where a sender starts depends on its largest clean, mature hour of marketing mail in the last 30 days: every step that hour would have proven is skipped, so a sender with a clean hour of 150,000 or more skips the ramp. `sendEstimate` on `GET /v1/campaigns/{id}` shows the campaign's step and when its last recipient should go out.

Marketing sent through the API is on the step a ramping campaign of the workspace is on, or where its history starts it. Its hour is the clock hour, and it shares it with what the ramping campaigns released in their current hours, so a campaign launched after a burst of API marketing releases only what is left, and the other way round. A send that would cross the ceiling is refused whole, with nothing queued: a retryable 429 `RAMP_LIMIT_REACHED` whose `Retry-After` is the seconds until more room opens and whose `error.details[0]` holds `step`, `steps`, `ceilingPerHour`, `usedThisHour`, `fitsNow`, `requested` and `stepOpensAt`. While a campaign of the workspace is stopped by the automatic pause, the list probe or the ramp's check (`LIST_QUALITY`, `BOUNCE_RATE_HIGH`, `COMPLAINT_RATE_HIGH`) and not yet resumed or canceled, its marketing is paused too: a send or a schedule is refused with 409 `RAMP_PAUSED`, not retryable, whose `error.details[0]` names the campaign (`campaignId`, `pauseCode`). Review and resume that campaign first. A scheduled marketing send is refused with `RAMP_LIMIT_REACHED` when it is scheduled if it is larger than the step's whole ceiling, or if, with the marketing already scheduled within 24 hours either side of its time, it is more than the step sends in 24 hours; `error.details[0]` then adds `scheduledBacklog` and `dailyBudget`. One that fits is held at its time, never rejected for the ramp: it stays scheduled, its `scheduledAt` moving to when it tries again, with a Waiting (`dispatch_deferred`) event, and goes when its hour has room. After 24 hours held it goes anyway, since it fit when it was scheduled, except while the workspace is paused (`RAMP_PAUSED`, a standing step or hold that holds marketing, `MARKETING_HELD`, or a Hosted sending pause, `HOSTED_SENDING_PAUSED`). Then it stays held until the owner resumes or cancels it, and its 24 hours count again from the last check that found the pause. For a large list, a campaign is the way: it is paced automatically.

**Send readiness.** Before a marketing campaign goes out, its review (`readiness` on `GET /v1/campaigns/{id}/audience` and in the launch response) looks at the From domain (when it was added here, DMARC, MAIL FROM), what the workspace and the domain sent before, the list (risky addresses skipped, who was never mailed, its last import) and how much larger this send is, and recommends daily batches when it should go out gradually: the first the larger of 10,000 and twice the domain's largest clean campaign, each next four times the last, at most five days, the most engaged recipients first and those never mailed last. On Hosted, a send of 50,000 or more from a domain added under 30 days ago, or over 100 times the largest campaign its domain sent in 90 days, goes out with that plan (`pacing.plan: "recommended"`), a daily limit no larger than its first day, or a consent source its sender confirms (`consent`, kept with the campaign and in Activity); otherwise launching it answers 422 `RAMP_REQUIRED`. The list probe stays a uniform sample of the whole audience.

## Content screen: how much text

Hosted mail is screened for smuggled advertising and scams before it is delivered. The screen reads the HTML's text (with its `alt` and `title` text, form values and what its style sheets draw), then the text part, then any raw MIME, each in full, and the hosts the message links to or loads from. It reads long mail in overlapping windows of about 5 to 8 KB, every window with the message's link hosts, so a 64 KiB message is read whole in at most 14 classifier requests and a 128 KiB campaign copy in at most 28.

| What | Limit | When it is checked |
| --- | --- | --- |
| A message (`POST /v1/emails/send`, each item of `/v1/emails/batch`, replies and inbox sends) | **65,536 UTF-8 bytes** of screened text (64 KiB), 150 distinct link hosts (3,000 bytes of host names) | On submission |
| A campaign's own copy, placeholders unresolved, and a campaign test | **131,072 UTF-8 bytes** (128 KiB) | On send, schedule or test |
| Each recipient's copy of a campaign | 131,072 bytes; a copy over it is refused alone | Before it is released |

Every recipient's copy of a campaign is screened before it is released, exactly as a single message is, but each distinct copy only once: recipients whose personalized copies are exactly the same as delivered share one verdict, and a copy is sent only under a verdict for its exact content. A campaign personalized with first names costs one screen per distinct first name; one with a unique value per recipient costs one per recipient, as a single message would. The campaign's own copy is screened first: if it is refused, the campaign fails before anyone is sent to. A copy the screen refuses is never sent (`CONTENT_REJECTED_SPAM`, counted in the score like any refused message), and when refused copies pass 5% and 10 recipients the campaign pauses once for you to review.

Over a limit, the request is refused at once with 422 `CONTENT_TOO_LARGE_TO_SCREEN` and `error.details[0]` set to `{ screenedBytes, limitBytes }` (or `{ linkHosts, linkHostLimit }`); in a batch, `index` names the message and nothing in the batch is queued. `POST /v1/emails/check` reports the measured size as the `screen-bytes` finding. Self-hosted installations set the limits with `JEV_MESSAGE_LIMIT_BYTES` and `JEV_CAMPAIGN_LIMIT_BYTES`.

## The `account.standing.changed` event

Subscribe a webhook to `account.standing.changed` to hear about every change of step, a campaign quarantine, and an owner's or Nightmail's release. `data` has `step`, `previousStep`, `reasons` (code, metric, value, count, threshold, minimum, window, message), `since`, `version`, `sequence` (per workspace, always increasing: ignore a sequence you have already seen), `marketingHeld`, `change` and `actor.kind` (`system`, `owner` or `operator`).
