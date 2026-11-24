import { SLOW_REQUEST_MS } from './log.js';

// Every number the health alerts (src/health.ts), the Health page and the evidence logs decide by, and why. Each was set
// from the incidents of 23 November 2026 (docs/operations.md): low enough that the system would have said so within
// minutes, high enough that a busy hour is not an alert. "Falling behind" means work is waiting longer than it should
// and keeps doing so; a deep queue that drains on time is only busy, and never alerts.
//
// An alert fires once its condition has held for `sustain` ticks in a row (one tick a minute), posts again every
// `remindMinutes` while it lasts, and posts "All clear" once it has been gone for `clearMinutes`.

/** The tick itself. */
export const TICK = {
  /** One tick per minute across every process: a second cron or runner within this window does nothing. */
  everySeconds: 45,
  /** Each probe's statement_timeout. A probe that runs out is skipped (its alerts neither fire nor clear) and logged. */
  statementMs: 3_000,
  /** Cards posted per tick, together, each given this long: Slack being slow costs the minute cron five seconds at most. */
  cards: 6, postMs: 5_000,
  /** The Health page calls the rollup stale after this: three missed ticks. */
  staleSeconds: 180,
  /** Gone this long before "All clear": one quiet minute between two bad ones is not a recovery. */
  clearMinutes: 3,
  /** health_minutes is kept this long; the page shows 15 minutes and no rule looks further back. */
  keepMinutes: 120,
} as const;

/**
 * Cloudflare queues, by the name the minute cron reads them under (src/worker.ts). `oldestSeconds`: the oldest message
 * has waited this long. Consumers take a batch every few seconds, so a healthy queue's oldest message is seconds old
 * however deep it is; minutes old means the consumers are not keeping up. On the 23rd the feedback queue reached 20
 * minutes; at these numbers the card comes in the fourth minute.
 */
export const QUEUES: Record<string, { oldestSeconds: number; sustain: number; remindMinutes: number }> = {
  // Bounces and complaints ride here: a campaign's bounce rate reads low while they are late, and the list probe and
  // auto-pause decide on them.
  feedback: { oldestSeconds: 120, sustain: 2, remindMinutes: 30 },
  // The safety lane (#619) for bounces and complaints of mail already under watch: it should never wait.
  priority: { oldestSeconds: 60, sustain: 2, remindMinutes: 30 },
  // Wake messages for the jobs table: each is consumed within seconds, and the cron sends one a minute regardless.
  work: { oldestSeconds: 180, sustain: 2, remindMinutes: 30 },
  // Customers' endpoints can be slow, and one slow endpoint must not page anyone: five minutes.
  webhooks: { oldestSeconds: 300, sustain: 2, remindMinutes: 30 },
};
/** A dead-letter queue (a name ending in -dlq) alerts on its first message: each one is an event Nightmail gave up on. */
export const DLQ = { depth: 1, sustain: 1, remindMinutes: 360 } as const;

/**
 * The jobs table, by class (migration job_class): a due job (available now, or its lease ran out) has waited this long.
 * On the 23rd, 1,883 mailbox.ingest jobs were 13 minutes late. Jobs scheduled for later are not late and never count.
 */
export const JOBS_LATE: Record<string, { oldestSeconds: number }> = {
  ingest: { oldestSeconds: 180 },     // Received mail should be in the inbox within a minute.
  feedback: { oldestSeconds: 180 },   // As the feedback queue.
  campaign: { oldestSeconds: 300 },   // A release is due every 10 to 20 seconds; five minutes late is a stalled campaign.
  publish: { oldestSeconds: 300 },
  hook: { oldestSeconds: 900 },       // Webhook posts wait on customers' endpoints and each owner's turn.
  other: { oldestSeconds: 600 },
};
export const JOBS = {
  sustain: 2, remindMinutes: 30,
  /** At most this many due and this many failed jobs are read per tick, newest failures first: the count shows "5,000+". */
  read: 5_000,
  /**
   * Failed jobs of one type. A pile this large is a bug, not a customer's bad day: on the 23rd, 1,639
   * mailbox.recoverStaging jobs had sat failed for twelve days. So is this many more within `failedWindowMinutes`,
   * however small the pile. It reminds once a day while either holds.
   */
  failed: 25, failedNew: 5, failedWindowMinutes: 30, failedRemindMinutes: 1_440,
  /** A failed campaign job strands a customer's send: the first one alerts. */
  failedCampaign: 1,
  /** Webhook posts fail when a customer's endpoint is down; the customer sees that on their own page. Never an alert. */
  failedIgnored: ['operation.webhook', 'mailbox.webhook', 'mailbox.fanout'],
} as const;

/**
 * Running campaigns. A campaign's rate is what happened: recipients released per second, measured from its own cursor
 * over `windowMinutes` of minute samples (and accepted per second from its stored counts, where those move). It is
 * compared with what the campaign is entitled to: the provider account's send rate, times the share of it a workspace
 * of its kind gets (`share`), times the campaign's own rate share. Never with the rate the release planner reads for
 * itself: on the 23rd the planner's number was the quartered one, so every line that quoted it looked right.
 */
export const CAMPAIGNS = {
  windowMinutes: 10,
  /**
   * The share of the account's rate a workspace's campaigns get, as the product means it: a workspace on the shared
   * pool a quarter (migration 047, so one customer's campaign never takes the pool), an exempt first-party workspace
   * and a workspace on its own account all of it (migration 422). Stated here, not read from the planner's view.
   */
  share: { shared: 0.25, exempt: 1, own: 1 },
  /**
   * Releasing below this share of what it is entitled to for the whole window, with nothing it is waiting for: the
   * planner, the dispatcher or the provider is holding it back. Or releasing nothing at all for `stalledMinutes`.
   */
  slowShare: 0.5, stalledMinutes: 5,
  /** Rules about rate need this much left to send, in seconds at the planned rate: the last stretch always slows. */
  tailSeconds: 600,
  /**
   * Time left at the measured rate, for a campaign without a daily pace. On the 23rd a 1.8M send planned at a quarter
   * of the account's rate would have taken 15 hours instead of 3; the card names all three rates. After five samples.
   */
  etaHours: 6, etaSamples: 5,
  /** Preparing this long since launch (on the 23rd: 6.5 minutes for 1.8M recipients). */
  preparingSeconds: 300,
  /** Waiting on a quota, the balance or a hold this long. A list probe waits ten minutes by design, so it gets thirty. */
  waitingSeconds: 900, probeSeconds: 1_800,
  /** Waiting on its own daily pace is the customer's choice: never an alert. */
  waitingIgnored: ['pacing_window'],
  remindMinutes: 60,
  /**
   * Bounces and complaints on settled mail (delivered + bounced), once this much has settled: the lines Amazon's own
   * review starts at (5% and 0.1%). While feedback is late the rate on everything sent reads low; this one does not.
   */
  settled: 1_000, bounceRate: 0.05, complaintRate: 0.001,
} as const;

/** Requests, from health_minutes. */
export const REQUESTS = {
  /**
   * A storm: one read route, or one workspace's reads, at this many a minute for three minutes in a row (20 a second).
   * On the 23rd one page asked for /stats 50 times a second for hours. Only GET and HEAD count: a customer sending
   * mail at 20 a second is a customer sending mail, and the send limits govern that. 1,200 is also the default budget
   * of one API key a minute (API_RATE_LIMIT_PER_MINUTE): a key held at its limit for three minutes is a storm, and
   * what it asks beyond the limit is answered 429 and still counted for its route.
   */
  stormPerMinute: 1_200, stormMinutes: 3, stormRemindMinutes: 60,
  /** A request this slow is always logged in full (src/log.ts), whatever the sampling. */
  slowMs: SLOW_REQUEST_MS,
  /**
   * A slow route: any request over `verySlowMs` in five minutes (the 45-second "Send now" of the 23rd), or a p95 over
   * `p95Ms` across at least `p95Requests` requests.
   */
  verySlowMs: 30_000, p95Ms: 5_000, p95Requests: 20, slowRemindMinutes: 60,
  /** Server errors in five minutes: this many and this share of all requests, or `errorsAlways` whatever the share. */
  errors: 10, errorShare: 0.02, errorsAlways: 50, errorRemindMinutes: 30,
  /**
   * Error-level log lines of one code in five minutes, outside request lines (those are the server errors above): a job
   * type that keeps failing, a sweep that keeps throwing. One or two happen; five in five minutes is a run.
   */
  errorLines: 5,
  /** Lines every minute already says on its own, and the health tick's own. */
  errorLinesIgnored: /^(?:QUEUE_BACKLOG_ALERT|HEALTH_[A-Z_]+)$/,
  /**
   * A dispatcher shard's run failing (DISPATCHER_RUN_FAILED and its kin) this often in fifteen minutes. One failure
   * heals itself: the shard runs again 15 seconds later and its leased mail is taken back within three minutes. On the
   * 23rd one shard failed 11 times in two hours; three in a quarter of an hour is a shard that keeps failing.
   */
  dispatcherFailures: 3,
  /** A client is counted on its own from this many requests in one 20-second flush (one a second). */
  clientFlush: 20,
} as const;

/**
 * Database errors by SQLSTATE in five minutes, from requests and jobs. Read-only and disk full alert at the first one;
 * the others happen singly in normal running (a client that gave up, two imports of one list) and alert as a run.
 */
export const SQLSTATES: Record<string, { label: string; count: number }> = {
  '25006': { label: 'read-only', count: 1 },
  '53100': { label: 'disk full', count: 1 },
  '53300': { label: 'too many connections', count: 3 },
  '57014': { label: 'statement timeouts', count: 5 },
  '40P01': { label: 'deadlocks', count: 5 },
  '55P03': { label: 'lock timeouts', count: 10 },
};
export const DATABASE = {
  remindMinutes: 15,
  /** Connections in use, of max_connections. Above this a burst gets "too many connections" (53300). */
  connectionShare: 0.8, sustain: 2,
  /** A transaction open this long holds back vacuum and may hold locks; migrations and retention finish well inside it. */
  transactionSeconds: 600,
  /** Queries running over 30 seconds, and sessions waiting on a lock: each for two ticks. One long report is not an alert; three at once is a pile-up. */
  slowQueries: 3, lockWaits: 10,
  /**
   * With DATABASE_DISK_GB set: the database's size as a share of the disk. PlanetScale makes the cluster read-only near
   * 95%, as on the 23rd; its own webhook (#586) is the earlier, finer alert, and this one needs nothing from outside.
   */
  diskShare: 0.75, diskRemindMinutes: 360,
} as const;
