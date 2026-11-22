import { productName } from './brand.js'
// Sender standing: the pure model behind the ten-minute standing job (standing.ts), GET /v1/sender-score and the
// published thresholds (docs/sending-limits.md). No I/O here, so the job, the route and the tests share it.
//
//   factor score  s = 100 × clamp((bad − x) ÷ (bad − good), 0, 1), x a rate decayed with a 30-day half-life
//   quality       Q = Σ weight·s ÷ Σ weight over measured factors (neutral ones drop out, the rest re-weigh)
//   evaluation    a new workspace's first EVALUATION.recipients real recipients, at most that many in 24 hours, until
//                 they were accepted and their delivery results are in (90% of them, or an hour after the last), then
//                 the score is their quality alone
//   score         Q, recomputed from all the evidence (counted hourly; no prior, no daily movement limit): complaints
//                 that arrive days after the evaluation move it as soon as they are counted
//   growth        for GROWTH.hours clean hours after a new sender's evaluation, a sponsor's growing workspaces may send at
//                 most 1,000 recipients in a rolling hour, then twice the distinct recipients of its last mature, clean hour; a
//                 workspace with a clean track record from before the pace existed, or an operator override, skips it
//   limit         none at 75 and up (good standing); under it the bands below, dropping only 2 points under a band
//   ladder        notice → warn → restrict (marketing held) → pause (all sending), each line a count and a rate; a
//                 step from warn up, a pause or a resume freezes the limit (none becomes what SES accepted in 24 hours,
//                 at least 10,000), and it stays frozen until the step and any strike reduction are over

export const GRADES = ['A+', 'A', 'B', 'C', 'D', 'F'] as const;
export type Grade = (typeof GRADES)[number];
export const GRADE_BANDS: { grade: Grade; min: number }[] = [{ grade: 'A+', min: 95 }, { grade: 'A', min: 90 }, { grade: 'B', min: 80 }, { grade: 'C', min: 70 }, { grade: 'D', min: 60 }, { grade: 'F', min: 0 }];
export const gradeOf = (score: number): Grade => GRADE_BANDS.find(b => score >= b.min)!.grade;

/** Score → daily limit (rolling 24 hours, recipients); null is no daily limit: good standing. Published. */
export const GOOD_STANDING = 75;
export const LIMIT_BANDS: readonly { min: number; limit: number | null }[] = [
  { min: GOOD_STANDING, limit: null }, { min: 70, limit: 500 }, { min: 65, limit: 200 }, { min: -Infinity, limit: 100 },
];
/** The bottom band's limit: a second strike halves a limit no lower than this. */
const LOWEST_BAND = LIMIT_BANDS[LIMIT_BANDS.length - 1]!.limit!;
/**
 * The evaluation: a new workspace's first 500 real recipients go at the normal pace and it can send no more until their
 * delivery results are in (90% of them delivered or bounced, or an hour after the last was accepted). Hard bounces and
 * the spam screen, the signs of a bad list, arrive within minutes, so this is the smallest wait that has them. 500 lets a
 * launch to a few hundred users through without a stop; the ladder's bounce and complaint lines apply to them as to any
 * mail. The one definition: config's hostedSendCaps, the job and the API's and dashboard's copy read it from here.
 */
export const EVALUATION = { recipients: 500, limit: 500, resolved: 0.9, waitMinutes: 60 } as const;
/** prior: the score with nothing measured at all (no real mail in 180 days). */
export const SCORE = { prior: 60, halfLifeDays: 30, hysteresis: 2, historyDays: 180 };
/**
 * From warn up the limit is frozen: a workspace without one gets what SES accepted from it in the last 24 hours
 * (hosted_accepted_day: never queued or unsent mail), at least this.
 */
export const FREEZE_FLOOR = 10_000;
/**
 * Growth after the evaluation, so a clean evaluation cannot be followed by a full-pace blast before any feedback exists.
 * For 24 clean hours (a ladder step from warn up starts them again) a sponsor's growing workspaces share one rolling-hour
 * allowance, enforced in the dispatch claim for every stream (hosted_burst_ok): 1,000 recipients, and after each
 * completed hour that is feedback-mature (90% of its accepted recipients delivered or bounced) and clean (hard bounces
 * under 2%, no complaints, quality no more than 2 points below the last growth), twice that hour's distinct real
 * recipients if that is more. Stale feedback, a notice or worse, or worsening quality stop the growth; nothing lowers
 * it. An operator can lift it for a workspace. A good sender doubles every hour: about a million an hour after ten.
 */
export const GROWTH = { start: 1_000, factor: 2, hours: 24, resolved: 0.9, bounceRate: 0.02, qualityDrop: 2 } as const;
/**
 * The growth pace is for new senders only. A workspace skips it (and leaves it, if it is on it) with an active operator
 * daily-limit override, or with a clean track record from before the pace existed: SES acceptances before its baseline
 * (the pace's rollout, for workspaces that existed then; none for later ones) and before its evaluation, in the 30
 * completed UTC days before that, leaving out its evaluation's recipients (its seeds). The record needs mail on 3 days, 300
 * distinct real recipients at more than one domain, 90% of them resolved, hard bounces under 2% and no complaints, and the
 * workspace in good standing at ok. Mail accepted later, or without an acceptance event, never counts.
 */
export const ESTABLISHED = { days: 3, recipients: 300, domains: 2, windowDays: 30, resolved: 0.9, bounceRate: 0.02 } as const;
/** Pre-baseline history per recipient: `accepted` recipient rows, how many resolved, bounced or complained. */
export type TrackRecord = { days: number; recipients: number; domains: number; accepted: number; resolved: number; bounces: number; complaints: number };
export function establishedBy(o: { override: boolean; history: TrackRecord | null; score: number | null; step: Step }): 'OPERATOR_OVERRIDE' | 'TRACK_RECORD' | null {
  if (o.override) return 'OPERATOR_OVERRIDE';
  const h = o.history;
  if (!h || o.score === null || o.score < GOOD_STANDING || o.step !== 'ok') return null;
  const clean = h.days >= ESTABLISHED.days && h.recipients >= ESTABLISHED.recipients && h.domains >= ESTABLISHED.domains
    && h.resolved >= ESTABLISHED.resolved * h.accepted && h.bounces < ESTABLISHED.bounceRate * h.accepted && h.complaints === 0;
  return clean ? 'TRACK_RECORD' : null;
}
/**
 * Pacing protects the shared pool; it is not a customer limit. With a daily limit: clamp(limit ÷ 20, 50, 500) a minute.
 * Without one: a quarter of the pool's SES rate (the share campaign planning already uses), at least 500 a minute. Half
 * of it per sending domain (at least 50). The dispatcher also gives every workspace with queued mail a slot before any
 * gets a second, under the pool's own rate (docs/dispatch-scaling.md). hosted_minute_cap (migration 348) applies it.
 */
export const PACE = { floor: 50, ceiling: 500, perDay: 20, uncappedFloor: 500, poolShare: 4 } as const;
export const bandFor = (score: number) => LIMIT_BANDS.find(b => score >= b.min)!;
export const nextBand = (score: number) => [...LIMIT_BANDS].reverse().find(b => b.min > score) ?? null;
/**
 * Per minute for a daily limit (null: the uncapped floor; the API reports the pool-based figure); marketing per hour
 * max(25, limit ÷ 4); the transactional reserve max(100, 10%), none during the evaluation: it lifts within about an hour
 * of its last recipient, and a sender of newsletters alone must be able to finish it (hosted_allowance_read, migration 400).
 */
export const burstFor = (limit: number | null) => limit === null ? PACE.uncappedFloor : Math.min(PACE.ceiling, Math.max(PACE.floor, Math.floor(limit / PACE.perDay)));
export const marketingHourFor = (limit: number) => Math.max(25, Math.floor(limit / 4));
export const reserveFor = (limit: number, evaluating = false) => evaluating ? 0 : Math.max(Math.min(100, limit), Math.ceil(limit * 0.1));

// No daily limit ranks above every number.
const rank = (limit: number | null) => limit ?? Infinity;
const looser = (a: number | null, b: number | null) => rank(a) >= rank(b) ? a : b;
const tighter = (a: number | null, b: number | null) => rank(a) <= rank(b) ? a : b;
/** The band a score holds: rises at the band floor, drops only `hysteresis` points under it. null: no daily limit. */
export function bandLimit(score: number, current: number | null) {
  const up = bandFor(score).limit;
  if (rank(up) >= rank(current)) return up;
  return looser(up, tighter(current, bandFor(score + SCORE.hysteresis).limit));
}

export const FACTOR_KEYS = ['complaints', 'content', 'bounces', 'hygiene', 'auth', 'engagement'] as const;
export type FactorKey = (typeof FACTOR_KEYS)[number];
export const FACTORS: Record<FactorKey, { label: string; weight: number; good: number; bad: number; basis: string }> = {
  complaints: { label: 'Complaints', weight: 30, good: 0.0001, bad: 0.003, basis: 'Spam complaints ÷ delivered emails. 0.3% is the line mailbox providers enforce.' },
  content: { label: 'Spam screen', weight: 20, good: 0.001, bad: 0.03, basis: 'Emails the content screen rejected as spam ÷ emails it screened. Neutral when the workspace is not screened.' },
  bounces: { label: 'Bounces', weight: 15, good: 0.005, bad: 0.05, basis: 'Hard bounces to known recipients ÷ accepted emails to them. Mail sent through the API counts as known.' },
  hygiene: { label: 'List quality', weight: 15, good: 0.02, bad: 0.10, basis: 'Campaign mail only: hard bounces of first sends plus campaign emails to suppressed addresses ÷ those emails. First sends are expected to bounce more. Neutral without campaign mail.' },
  auth: { label: 'Authentication', weight: 10, good: 1, bad: 0, basis: 'By sending volume: DKIM signing 40%, a verified custom MAIL FROM (aligned SPF) 30%, DMARC enforcing 30% (p=none 15%). Neutral without verified domains.' },
  engagement: { label: 'Engagement', weight: 10, good: 0.002, bad: 0.02, basis: 'Marketing unsubscribes ÷ delivered marketing email, lifted up to 10 points by tracked clicks. Opens are ignored. Neutral without marketing mail.' },
};

/** One UTC day of a workspace's real mail. first_sends, first_bounced and suppressed count campaign mail only (list quality). */
export type DayEvidence = { day: string; emails: number; accepted: number; delivered: number; bounced: number; first_sends: number; first_bounced: number;
  complained: number; screened: number; rejected: number; suppressed: number; marketing_delivered: number; unsubscribed: number; clicked: number };
export type DomainAuth = { name: string; dkim: boolean; mailFrom: boolean; dmarc: string | null; emails: number };
export type Factor = { key: FactorKey; label: string; weight: number; value: number | null; score: number | null; points: number | null; source: 'measured' | 'neutral'; basis: string };
export type Quality = { quality: number; volume: number; target: number; factors: Factor[] };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const round = (v: number, digits = 1) => Math.round(v * 10 ** digits) / 10 ** digits;
const DAY_MS = 86_400_000;
const subscore = (key: FactorKey, x: number) => { const { good, bad } = FACTORS[key]; return 100 * clamp((bad - x) / (bad - good), 0, 1); };
// DKIM 40 + aligned SPF 30 + DMARC 30 (p=none half), weighted by each domain's mail, or evenly when there is none.
export function authShare(domains: DomainAuth[]): number | null {
  if (!domains.length) return null;
  const share = (d: DomainAuth) => (d.dkim ? 0.4 : 0) + (d.mailFrom ? 0.3 : 0) + (d.dmarc === 'quarantine' || d.dmarc === 'reject' ? 0.3 : d.dmarc === 'none' ? 0.15 : 0);
  const volume = domains.reduce((sum, d) => sum + d.emails, 0);
  return volume ? domains.reduce((sum, d) => sum + share(d) * d.emails, 0) / volume : domains.reduce((sum, d) => sum + share(d), 0) / domains.length;
}

/** Quality, decayed volume and target (the quality itself) from daily evidence (30-day half-life) and the domains' authentication. */
export function quality(days: DayEvidence[], domains: DomainAuth[], screened: boolean, today: string): Quality {
  const end = Date.parse(today + 'T00:00:00Z'), t = { accepted: 0, delivered: 0, bounced: 0, known: 0, campaign: 0, firstSends: 0, firstBad: 0, complained: 0, screened: 0, rejected: 0, mDelivered: 0, unsub: 0, clicked: 0 };
  for (const d of days) {
    const age = Math.max(0, (end - Date.parse(d.day + 'T00:00:00Z')) / DAY_MS);
    if (age > SCORE.historyDays) continue;
    const w = 2 ** (-age / SCORE.halfLifeDays);
    t.accepted += w * d.accepted; t.delivered += w * d.delivered; t.complained += w * d.complained;
    t.known += w * (d.accepted - d.first_sends); t.bounced += w * (d.bounced - d.first_bounced);
    t.campaign += w * d.first_sends; t.firstSends += w * (d.first_sends + d.suppressed); t.firstBad += w * (d.first_bounced + d.suppressed);
    t.screened += w * d.screened; t.rejected += w * d.rejected;
    t.mDelivered += w * d.marketing_delivered; t.unsub += w * d.unsubscribed; t.clicked += w * d.clicked;
  }
  const values: Record<FactorKey, number | null> = {
    complaints: t.delivered >= 1 ? t.complained / t.delivered : null,
    content: screened && t.screened >= 1 ? t.rejected / t.screened : null,
    bounces: t.known >= 1 ? t.bounced / t.known : null,
    // A list is campaign mail: without a campaign email sent there is no list to judge, whatever was suppressed.
    hygiene: t.campaign > 0 && t.firstSends >= 1 ? t.firstBad / t.firstSends : null,
    auth: authShare(domains),
    engagement: t.mDelivered >= 1 ? t.unsub / t.mDelivered : null,
  };
  const factors: Factor[] = FACTOR_KEYS.map(key => {
    const spec = FACTORS[key], value = values[key];
    if (value === null) return { key, label: spec.label, weight: spec.weight, value: null, score: null, points: null, source: 'neutral', basis: spec.basis };
    let score = subscore(key, value);
    if (key === 'engagement') score = Math.min(100, score + Math.min(10, 500 * (t.clicked / t.mDelivered)));
    return { key, label: spec.label, weight: spec.weight, value: round(value, 6), score: round(score), points: round(spec.weight * score / 100, 2), source: 'measured', basis: spec.basis };
  });
  const measured = factors.filter(f => f.source === 'measured'), weight = measured.reduce((s, f) => s + f.weight, 0);
  const q = weight ? measured.reduce((s, f) => s + f.weight * f.score! / 100, 0) / weight * 100 : SCORE.prior;
  // No volume prior: the evaluation's recipients establish the score on their own, and later mail moves it as it comes.
  return { quality: round(q, 2), volume: round(t.accepted, 2), target: round(q, 2), factors };
}

export type ScoreState = { phase: 'seed' | 'calibrating' | 'graded'; firstRecipients: number; calibratedAt: string | null; score: number | null; dayScore: number | null; scoreDay: string | null };
/** Real mail counted so far: accepted emails, and how many of them have a delivery result (delivered or bounced). */
export type Evaluated = { accepted: number; resolved: number };
/** Days of evidence as the evaluation reads them. */
export const evaluated = (days: Pick<DayEvidence, 'accepted' | 'delivered' | 'bounced'>[]): Evaluated =>
  days.reduce((n, d) => ({ accepted: n.accepted + Number(d.accepted), resolved: n.resolved + Math.min(Number(d.accepted), Number(d.delivered) + Number(d.bounced)) }), { accepted: 0, resolved: 0 });
/** Moves the published score: the evaluation, then the target itself on every run. */
export function moveScore(prev: ScoreState, target: number, mail: Evaluated, now: Date): ScoreState {
  const today = now.toISOString().slice(0, 10), recipients = Math.min(EVALUATION.recipients, Math.max(prev.firstRecipients, mail.accepted)), score = round(target, 2);
  if (prev.phase === 'seed') {
    // Existing senders already have evidence: graded at once.
    if (recipients < EVALUATION.recipients) return { phase: 'calibrating', firstRecipients: recipients, calibratedAt: null, score: null, dayScore: null, scoreDay: null };
    return { phase: 'graded', firstRecipients: recipients, calibratedAt: prev.calibratedAt ?? now.toISOString(), score, dayScore: score, scoreDay: today };
  }
  if (prev.phase === 'calibrating') {
    // calibratedAt: when the job first counted the evaluation's last accepted recipient.
    const calibratedAt = prev.calibratedAt ?? (recipients >= EVALUATION.recipients ? now.toISOString() : null);
    const resultsIn = mail.accepted > 0 && mail.resolved >= EVALUATION.resolved * mail.accepted;
    if (!calibratedAt || (!resultsIn && now.getTime() - Date.parse(calibratedAt) < EVALUATION.waitMinutes * 60_000)) return { ...prev, firstRecipients: recipients, calibratedAt };
    return { phase: 'graded', firstRecipients: recipients, calibratedAt, score, dayScore: score, scoreDay: today };
  }
  return { ...prev, firstRecipients: recipients, score, dayScore: score, scoreDay: today };
}

// ---------- the ladder ----------
export const STEPS = ['ok', 'notice', 'warn', 'restrict', 'pause'] as const;
export type Step = (typeof STEPS)[number];
export const stepRank = (s: Step) => STEPS.indexOf(s);
export type Window = { accepted: number; bounces: number; complaints: number; marketingAccepted: number; marketingBounces: number; marketingComplaints: number };
export type LadderInput = { day: Window; week: Window; screened: number; rejected: number };
export type Reason = { code: string; metric: 'complaints' | 'bounces' | 'marketing_bounces' | 'transactional_bounces' | 'screen' | 'external'; value: number; count: number; threshold: number; minimum: number; window: '24h' | '7d' | null; step: Step; message: string };
/** Ladder lines. Every line is a count and a rate together, so a few events never trip a small sender. Published. */
export const LADDER = {
  complaints: { warn: [{ rate: 0.0005, count: 2, window: '24h' }, { rate: 0.0005, count: 3, window: '7d' }], restrict: [{ rate: 0.001, count: 3, window: '24h' }], pause: [{ rate: 0.003, count: 5, window: '24h' }, { rate: 0.0015, count: 10, window: '7d' }] },
  bounces: { warn: [{ rate: 0.02, count: 10, window: '24h' }, { rate: 0.015, count: 10, window: '7d' }] },
  marketingBounces: { restrict: [{ rate: 0.04, count: 25, window: '24h' }] },
  // The pool-emergency line: any mail at 8%. Bounces alone hold marketing; they stop transactional mail only below.
  anyBounces: { restrict: [{ rate: 0.08, count: 50, window: '24h' }] },
  transactionalBounces: { pause: [{ rate: 0.05, count: 50, window: '24h' }] },
  screen: { warn: [{ rate: 0.02, count: 3 }], restrict: [{ rate: 0.05, count: 10 }], pause: [{ rate: 0.1, count: 25 }] },
  notice: { complaints: 1, bounces: 3, bounceRate: 0.01 },
} as const;
/** A rate as the published lines write it: 0.0005 is 0.05%. */
export const pct = (v: number) => `${(100 * v).toFixed(2).replace(/\.?0+$/, '')}%`;

/** The highest ladder line the windows cross, and every line crossed. `pause_kind` says what a pause is for. */
export function evaluateLadder(input: LadderInput): { level: Step; reasons: Reason[]; pauseKind: 'bounce' | 'full' | null } {
  const reasons: Reason[] = [];
  const check = (metric: Reason['metric'], step: Step, lines: readonly { rate: number; count: number; window?: string }[], count: (w: '24h' | '7d') => number, total: (w: '24h' | '7d') => number, what: string) => {
    for (const line of lines) {
      const w = (line.window ?? '24h') as '24h' | '7d', n = count(w), d = total(w), rate = d > 0 ? n / d : n > 0 ? 1 : 0;
      if (n >= line.count && rate >= line.rate) {
        reasons.push({ code: `${metric.toUpperCase()}_${step.toUpperCase()}`, metric, value: round(rate, 6), count: n, threshold: line.rate, minimum: line.count, window: metric === 'screen' ? '24h' : w, step,
          message: `${n.toLocaleString('en-US')} of ${d.toLocaleString('en-US')} ${what} in ${w === '24h' ? '24 hours' : '7 days'} (${pct(rate)}; the ${step} line is ${pct(line.rate)} and ${line.count}).` });
        return;
      }
    }
  };
  const win = (w: '24h' | '7d') => w === '24h' ? input.day : input.week;
  for (const step of ['pause', 'restrict', 'warn'] as const) {
    const lines = LADDER.complaints[step as keyof typeof LADDER.complaints];
    if (lines) check('complaints', step, lines, w => win(w).complaints, w => win(w).accepted, 'accepted emails were marked as spam');
    const screen = LADDER.screen[step];
    check('screen', step, screen, () => input.rejected, () => input.screened, 'screened emails were rejected as spam');
  }
  check('transactional_bounces', 'pause', LADDER.transactionalBounces.pause, w => win(w).bounces - win(w).marketingBounces, w => win(w).accepted - win(w).marketingAccepted, 'transactional emails hard-bounced');
  check('marketing_bounces', 'restrict', LADDER.marketingBounces.restrict, w => win(w).marketingBounces, w => win(w).marketingAccepted, 'marketing emails hard-bounced');
  check('bounces', 'restrict', LADDER.anyBounces.restrict, w => win(w).bounces, w => win(w).accepted, 'emails hard-bounced');
  check('bounces', 'warn', LADDER.bounces.warn, w => win(w).bounces, w => win(w).accepted, 'emails hard-bounced');
  const top = reasons.reduce<Step>((s, r) => stepRank(r.step) > stepRank(s) ? r.step : s, 'ok');
  // Keep only the highest line per metric.
  const kept = reasons.filter(r => !reasons.some(o => o !== r && o.metric === r.metric && stepRank(o.step) > stepRank(r.step)));
  if (top === 'ok') {
    const d = input.day;
    if (d.complaints >= LADDER.notice.complaints) kept.push({ code: 'COMPLAINT_NOTICE', metric: 'complaints', value: d.accepted ? round(d.complaints / d.accepted, 6) : 1, count: d.complaints, threshold: 0, minimum: 1, window: '24h', step: 'notice', message: `${d.complaints} accepted ${d.complaints === 1 ? 'email was' : 'emails were'} marked as spam in 24 hours.` });
    else if (d.bounces >= LADDER.notice.bounces && d.accepted && d.bounces / d.accepted >= LADDER.notice.bounceRate) kept.push({ code: 'BOUNCE_NOTICE', metric: 'bounces', value: round(d.bounces / d.accepted, 6), count: d.bounces, threshold: LADDER.notice.bounceRate, minimum: LADDER.notice.bounces, window: '24h', step: 'notice', message: `${d.bounces} of ${d.accepted} accepted emails hard-bounced in 24 hours (${pct(d.bounces / d.accepted)}).` });
    return { level: kept.length ? 'notice' : 'ok', reasons: kept, pauseKind: null };
  }
  const pauseKind = top !== 'pause' ? null : kept.some(r => r.step === 'pause' && r.metric !== 'transactional_bounces') ? 'full' : 'bounce';
  return { level: top, reasons: kept, pauseKind };
}

export type StandingState = { step: Step; reasons: Reason[]; since: string; clearSince: string | null; pauseKind: 'bounce' | 'full' | null };
/**
 * The next step. Steps rise as soon as a line is crossed. A warn clears by itself once every metric stayed under 80%
 * of its warn line for 24 hours; a notice clears as soon as nothing triggers it. A restrict or pause never clears by
 * itself: an owner releases it (bounce-only) or an operator does. A pause is applied by the caller (it stops mail).
 */
export function nextStanding(prev: StandingState, input: LadderInput, now: Date): StandingState {
  const at = now.toISOString(), evaluation = evaluateLadder(input);
  if (stepRank(evaluation.level) > stepRank(prev.step) && stepRank(evaluation.level) >= stepRank('warn'))
    return { step: evaluation.level, reasons: evaluation.reasons, since: at, clearSince: null, pauseKind: evaluation.pauseKind };
  if (prev.step === 'pause' || prev.step === 'restrict') {
    // A transactional bounce problem during a restrict still escalates (handled above); otherwise keep the reasons.
    return { ...prev, reasons: stepRank(evaluation.level) >= stepRank(prev.step) ? evaluation.reasons : prev.reasons };
  }
  if (prev.step === 'warn') {
    const under = belowClearLine(input);
    if (stepRank(evaluation.level) >= stepRank('warn') || !under) return { ...prev, reasons: stepRank(evaluation.level) >= stepRank('warn') ? evaluation.reasons : prev.reasons, clearSince: null };
    const clearSince = prev.clearSince ?? at;
    if (now.getTime() - Date.parse(clearSince) < 24 * 3600_000) return { ...prev, clearSince };
    return { step: evaluation.level, reasons: evaluation.reasons, since: at, clearSince: null, pauseKind: null };
  }
  if (evaluation.level !== prev.step) return { step: evaluation.level, reasons: evaluation.reasons, since: at, clearSince: null, pauseKind: null };
  return { ...prev, reasons: evaluation.reasons };
}
/** Every metric under 80% of its warn line (rate and count alike). */
export function belowClearLine(input: LadderInput) {
  const f = 0.8, d = input.day, w = input.week;
  const rate = (n: number, total: number) => total > 0 ? n / total : n > 0 ? 1 : 0;
  const under = (n: number, total: number, line: { rate: number; count: number }) => n < line.count * f || rate(n, total) < line.rate * f;
  return under(d.complaints, d.accepted, LADDER.complaints.warn[0]) && under(w.complaints, w.accepted, LADDER.complaints.warn[1])
    && under(d.bounces, d.accepted, LADDER.bounces.warn[0]) && under(w.bounces, w.accepted, LADDER.bounces.warn[1])
    && under(input.rejected, input.screened, LADDER.screen.warn[0]);
}

// ---------- asking for more ----------
/**
 * Whether "a higher limit" means anything now. A workspace in good standing has no daily limit, and one capped by its
 * score (or frozen by a ladder step) has that cap lifted by the job as soon as it recovers, so nothing is approved
 * automatically any more (the old rule, a score of 90 for 14 days, only ever matched workspaces that are now uncapped).
 * A person can still review a capped workspace and set an operator override.
 */
export type LimitRequest = { eligibleForAutoApproval: false; reasons: { code: string; message: string }[]; maxAuto: 0 };
export function limitRequest(o: { phase: ScoreState['phase'] | null; step: Step | null; daily: number | null }): LimitRequest {
  const reason = o.phase === null ? { code: 'NO_STANDING', message: `This workspace has no sender standing (${productName} Hosted sending only), so a limit request goes to a person.` }
    : o.phase !== 'graded' ? { code: 'EVALUATING', message: `The evaluation lifts the limit by itself once the first ${EVALUATION.recipients} real recipients' delivery results are in.` }
    : o.daily === null ? { code: 'NO_DAILY_LIMIT', message: 'This workspace has no daily limit: there is nothing to raise. Only the per-minute pace applies.' }
    : o.step !== null && stepRank(o.step) >= stepRank('warn') ? { code: 'LADDER_STEP', message: `The limit is frozen while the workspace is at ${o.step}. It lifts once the step clears and the score is ${GOOD_STANDING} or more; a person can review it sooner.` }
    : { code: 'SCORE_CAP', message: `The score sets this limit. It lifts by itself at ${GOOD_STANDING} or more; a person can review it sooner.` };
  return { eligibleForAutoApproval: false, reasons: [reason], maxAuto: 0 };
}

/**
 * The limit admission enforces from the standing (before an operator override or a resume's restore); null is none.
 * `band` is the stored band, `acceptedDay` what SES accepted in the last 24 hours (what a freeze keeps).
 */
export function dailyLimit(o: { phase: ScoreState['phase']; score: number | null; band: number | null; step: Step; strikeCapped: boolean; acceptedDay: number }) {
  if (o.phase !== 'graded' || o.score === null) return { band: EVALUATION.limit as number | null, limit: EVALUATION.limit as number | null };
  let band = bandLimit(o.score, o.band);
  // From warn up, and for as long as a strike halves it, the limit is frozen: no rises, and no limit becomes the last
  // 24 hours' accepted volume. The stored band is the reference, so the halving cannot drift between runs.
  if (stepRank(o.step) >= stepRank('warn') || o.strikeCapped) band = tighter(band, o.band ?? Math.max(FREEZE_FLOOR, o.acceptedDay));
  const limit = o.strikeCapped && band !== null ? Math.max(LOWEST_BAND, Math.floor(band / 2)) : band;
  return { band, limit };
}

/** One completed hour of a sponsor's growing workspaces: real recipients SES accepted, distinct ones, and their results. */
export type GrowthHour = { accepted: number; distinct: number; resolved: number; bounces: number; complaints: number };
export type Growth = { until: string | null; cap: number | null; hour: string | null; quality: number | null };
export const NO_GROWTH: Growth = { until: null, cap: null, hour: null, quality: null };
/**
 * The next growth state. `graduated`: the evaluation ended in this run. `hour` is the last completed hour (its start)
 * and `evidence` its figures, when the caller counted them (null: not counted, nothing to learn from it).
 */
export function nextGrowth(prev: Growth, o: { graduated: boolean; established?: boolean; step: Step; quality: number; hour: string; evidence: GrowthHour | null; now: Date }): Growth {
  if (o.established) return NO_GROWTH;
  const later = new Date(o.now.getTime() + GROWTH.hours * 3600_000).toISOString();
  if (o.graduated) return { until: later, cap: GROWTH.start, hour: o.hour, quality: o.quality };
  if (!prev.until || Date.parse(prev.until) <= o.now.getTime() || prev.cap === null) return NO_GROWTH;
  // A ladder step from warn up starts the clean hours again; nothing grows meanwhile.
  if (stepRank(o.step) >= stepRank('warn')) return { ...prev, until: Date.parse(prev.until) < Date.parse(later) ? later : prev.until };
  const e = o.evidence;
  if (o.step !== 'ok' || !e || (prev.hour !== null && Date.parse(o.hour) <= Date.parse(prev.hour))) return prev;
  if (!e.accepted) return { ...prev, hour: o.hour };
  // Stale feedback: wait for the hour's results (the next run counts it again).
  if (e.resolved < GROWTH.resolved * e.accepted) return prev;
  const clean = e.bounces < GROWTH.bounceRate * e.accepted && e.complaints === 0 && o.quality >= (prev.quality ?? 0) - GROWTH.qualityDrop;
  if (!clean) return { ...prev, hour: o.hour };
  return { ...prev, hour: o.hour, quality: o.quality, cap: Math.max(prev.cap, GROWTH.factor * e.distinct) };
}
