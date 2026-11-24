import { choice, exact, model, prop, sel, type Choice, type IdleRule, type Step } from "@tear/mbt";
import {
  COST,
  EMAILS,
  ENVELOPE,
  HELD,
  MSGS,
  PAIRS,
  RECIPS,
  WORKERS,
  type EmailLabel,
  type HeldName,
  type MsgKind,
  type MsgLabel,
  type MsgSpec,
  type SesAction,
  type SesObs,
  type SesSnapshot,
  type SesView,
  type WorkerName,
} from "./ses.types.ts";

const MAX_ATTEMPTS = 6;

type St =
  | "attempting"
  | "acceptance_unknown"
  | "accepted"
  | "delayed"
  | "suppressed"
  | "delivered"
  | "bounced"
  | "rejected"
  | "rendering_failed"
  | "complained";

type Reason = "hard_bounce" | "email_validation" | "complaint";
type JobSt = "pending" | "running" | "completed" | "failed";
type Gate = "record" | "suppress" | "mark";

interface ContactState {
  suppressed: boolean;
  reason: Reason | null;
  opened: boolean;
}

interface EmailState {
  status: St;
  provider: boolean;
  bits: number;
  lost: boolean;
  accepted: boolean;
  dispatched: boolean;
  kinds: MsgKind[];
}

interface JobState {
  st: JobSt;
  attempts: number;
  holder: number | null;
  expired: boolean;
}

interface WorkerState {
  msg: number;
  gate: Gate;
  blocked: boolean;
}

interface HeldState {
  msg: number;
  blocked: boolean;
  seen: boolean[];
  result: string | null;
}

interface DbState {
  emails: EmailState[];
  contacts: (ContactState | null)[];
  receipts: Record<number, boolean>;
  jobs: Record<number, JobState>;
  events: number[];
  deliveries: [string[], string[]];
  paused: boolean;
}

export interface SesState {
  db: DbState;
  workers: [WorkerState | null, WorkerState | null];
  held: [HeldState | null, HeldState | null];
  used: number;
}

function stRank(st: St): number {
  switch (st) {
    case "attempting":
      return 1;
    case "acceptance_unknown":
      return 2;
    case "accepted":
      return 3;
    case "delayed":
      return 4;
    case "suppressed":
      return 5;
    case "delivered":
      return 6;
    case "bounced":
    case "rejected":
    case "rendering_failed":
      return 7;
    case "complained":
      return 8;
  }
}

function kindEvent(k: MsgKind): string {
  switch (k) {
    case "delivery":
      return "delivery";
    case "bounce":
      return "bounce";
    case "transient":
      return "non_permanent_bounce";
    case "validation":
      return "validation_suppressed";
    case "complaint":
      return "complaint";
    case "not_spam":
      return "complaint_feedback";
    case "delay":
      return "delivery_delay";
    case "reject":
      return "reject";
    case "render":
      return "rendering_failure";
    case "open":
      return "open";
  }
}

function kindStatus(k: MsgKind): St | null {
  switch (k) {
    case "delivery":
      return "delivered";
    case "bounce":
      return "bounced";
    case "transient":
    case "delay":
      return "delayed";
    case "validation":
      return "suppressed";
    case "complaint":
      return "complained";
    case "not_spam":
      return "accepted";
    case "reject":
      return "rejected";
    case "render":
      return "rendering_failed";
    case "open":
      return null;
  }
}

function kindPublic(k: MsgKind): string | null {
  switch (k) {
    case "delivery":
      return "email.delivered";
    case "bounce":
    case "transient":
    case "validation":
      return "email.bounced";
    case "complaint":
      return "email.complained";
    case "not_spam":
      return null;
    case "delay":
      return "email.delivery_delayed";
    case "reject":
      return "email.rejected";
    case "render":
      return "email.rendering_failed";
    case "open":
      return "email.opened";
  }
}

function kindBits(k: MsgKind): number {
  switch (k) {
    case "delivery":
      return 3;
    case "bounce":
      return 5;
    case "transient":
    case "delay":
      return 129;
    case "validation":
    case "not_spam":
      return 0;
    case "complaint":
      return 9;
    case "reject":
    case "render":
      return 64;
    case "open":
      return 16;
  }
}

function kindSuppress(k: MsgKind): Reason | null {
  switch (k) {
    case "bounce":
      return "hard_bounce";
    case "validation":
      return "email_validation";
    case "complaint":
      return "complaint";
    default:
      return null;
  }
}

function kindReports(k: MsgKind): boolean {
  return (
    k === "bounce" ||
    k === "transient" ||
    k === "validation" ||
    k === "complaint" ||
    k === "not_spam"
  );
}

function kindRoutine(k: MsgKind): boolean {
  return k === "delivery";
}

function msgIndex(label: MsgLabel): number {
  const i = MSGS.findIndex((m) => m.label === label);
  if (i < 0) throw new Error(`unknown msg label ${label}`);
  return i;
}

function emailIndex(label: EmailLabel): 0 | 1 {
  return label === "e1" ? 0 : 1;
}

function workerIndex(w: WorkerName): 0 | 1 {
  return w === "J" ? 0 : 1;
}

function heldIndex(h: HeldName): 0 | 1 {
  return h === "Q" ? 0 : 1;
}

function addUnique<T>(arr: T[], val: T): boolean {
  if (arr.includes(val)) return false;
  arr.push(val);
  return true;
}

function recipientsOf(m: MsgSpec): number[] {
  const env = ENVELOPE[m.email]!;
  if (kindReports(m.kind)) {
    return m.recips.filter((r) => env.includes(r));
  }
  return env.length === 1 ? [...env] : [];
}

function hasEffects(m: MsgSpec): boolean {
  return recipientsOf(m).length > 0 && (kindSuppress(m.kind) !== null || m.kind === "open");
}

function dbReady(db: DbState, e: number): boolean {
  const em = db.emails[e]!;
  return em.provider || em.status === "acceptance_unknown";
}

function dbRecord(db: DbState, i: number): boolean {
  const m = MSGS[i]!;
  if (!addUnique(db.events, i)) return false;
  const em = db.emails[m.email]!;
  em.kinds.push(m.kind);
  const st = kindStatus(m.kind);
  if (st !== null && stRank(st) >= stRank(em.status)) {
    em.status = st;
    em.provider = true;
  }
  const pub = kindPublic(m.kind);
  if (pub !== null) {
    em.bits |= kindBits(m.kind);
    addUnique(db.deliveries[0], m.label);
    if (!db.paused && (pub === "email.bounced" || pub === "email.complained")) {
      addUnique(db.deliveries[1], m.label);
    }
  }
  return true;
}

function dbApplyEffects(db: DbState, i: number, seen: boolean[] | null): void {
  const m = MSGS[i]!;
  for (const r of recipientsOf(m)) {
    const visible = seen === null || seen[r]!;
    const c = db.contacts[r];
    const reason = kindSuppress(m.kind);
    if (reason !== null) {
      if (!c) {
        db.contacts[r] = { suppressed: true, reason, opened: false };
      } else if (!c.suppressed) {
        c.suppressed = true;
        c.reason = reason;
      } else {
        const reversible = c.reason === "hard_bounce" || c.reason === "email_validation";
        if (reversible && reason !== "email_validation") {
          c.reason = reason;
        }
      }
    } else if (m.kind === "open" && visible && c) {
      c.opened = true;
    }
  }
}

function dbNewJob(db: DbState, i: number): void {
  db.jobs[i] = { st: "pending", attempts: 0, holder: null, expired: false };
}

function dbBatchSeen(db: DbState, items: number[], seen: boolean[] | null): string[] {
  const out: string[] = [];
  const done: number[] = [];
  for (const i of items) {
    const m = MSGS[i]!;
    if (m.email === 2) {
      out.push("e:SES_FEEDBACK_UNMATCHED");
      continue;
    }
    const dup = done.includes(i);
    done.push(i);
    const ready = dbReady(db, m.email);
    if (!dup) {
      const rec = db.receipts[i];
      if (rec === undefined && ready) {
        db.receipts[i] = true;
        dbRecord(db, i);
        dbApplyEffects(db, i, seen);
      } else if (rec === undefined) {
        db.receipts[i] = false;
        dbNewJob(db, i);
      } else if (rec === false && ready) {
        db.receipts[i] = true;
        dbRecord(db, i);
        dbApplyEffects(db, i, seen);
      }
    }
    out.push(ready || kindRoutine(m.kind) ? "ok" : "e:SES_EMAIL_NOT_FOUND");
  }
  return out;
}

function dbHttp(db: DbState, i: number): string {
  const m = MSGS[i]!;
  if (m.email === 2) return "e:SES_EMAIL_NOT_FOUND";
  const inline = kindRoutine(m.kind) && dbReady(db, m.email);
  const rec = db.receipts[i];
  if (rec === undefined && inline) {
    db.receipts[i] = true;
    dbRecord(db, i);
  } else if (rec === undefined) {
    db.receipts[i] = false;
    dbNewJob(db, i);
  } else if (rec === false && inline) {
    db.receipts[i] = true;
    dbRecord(db, i);
  }
  return "ok";
}

function dbDispatch(db: DbState, e: 0 | 1, lost: boolean): void {
  const em = db.emails[e]!;
  em.dispatched = true;
  const st: St = lost ? "acceptance_unknown" : "accepted";
  if (stRank(st) >= stRank(em.status)) {
    em.status = st;
    if (!lost) em.provider = true;
  }
  if (lost) {
    em.lost = true;
  } else {
    em.accepted = true;
    em.bits |= 1;
  }
  addUnique(db.deliveries[0], `A:${EMAILS[e]}`);
}

function dbRead(db: DbState, i: number): "processed" | "missing" | "found" {
  if (db.receipts[i] === true) return "processed";
  return dbReady(db, MSGS[i]!.email) ? "found" : "missing";
}

function dbSettle(db: DbState, i: number, k: number, st: JobSt): void {
  const j = db.jobs[i];
  if (j && j.st === "running" && j.holder === k && !j.expired) {
    j.st = st;
    j.holder = null;
  }
}

function dbClaimable(db: DbState, i: number): boolean {
  const j = db.jobs[i];
  if (!j) return false;
  return j.st === "pending" || (j.st === "running" && j.expired && j.attempts < MAX_ATTEMPTS);
}

function storyOk(s: SesState, i: number): boolean {
  const m = MSGS[i]!;
  if (m.story === 0) return true;
  for (let j = 0; j < MSGS.length; j++) {
    const o = MSGS[j]!;
    if ((s.used & (1 << j)) !== 0 && o.email === m.email && o.story !== m.story) {
      return false;
    }
  }
  return true;
}

function openHeld(s: SesState): number | null {
  if (s.held[0] !== null) return 0;
  if (s.held[1] !== null) return 1;
  return null;
}

function lockedEmail(s: SesState): number | null {
  for (const h of s.held) {
    if (h && !h.blocked) {
      const e = MSGS[h.msg]!.email;
      return e < 2 ? e : null;
    }
  }
  return null;
}

function blockedAny(s: SesState): boolean {
  return s.workers.some((w) => w?.blocked) || s.held.some((h) => h?.blocked);
}

function isEnabled(s: SesState, a: SesAction): boolean {
  const busy = openHeld(s) !== null;
  switch (a.op) {
    case "Queue":
    case "Http":
      return !busy && storyOk(s, msgIndex(a.msg));
    case "Pair":
      return !busy && storyOk(s, msgIndex(a.a)) && storyOk(s, msgIndex(a.b));
    case "Forge":
    case "Stray":
    case "Alien":
    case "Cross":
    case "Pause":
      return !busy;
    case "Accept":
    case "Lost":
      return !busy && !s.db.emails[emailIndex(a.email)]!.dispatched;
    case "Expire":
      return Object.values(s.db.jobs).some((j) => j.st === "running" && !j.expired);
    case "Claim": {
      const k = workerIndex(a.worker);
      return s.workers[k] === null && dbClaimable(s.db, msgIndex(a.msg));
    }
    case "Go": {
      const w = s.workers[workerIndex(a.worker)];
      if (!w || w.blocked) return false;
      if (busy) {
        return w.gate === "record" && lockedEmail(s) === MSGS[w.msg]!.email && !blockedAny(s);
      }
      return true;
    }
    case "Crash": {
      const w = s.workers[workerIndex(a.worker)];
      return w !== null && !w.blocked;
    }
    case "Hold": {
      const k = heldIndex(a.conn);
      const i = msgIndex(a.msg);
      if (s.held[k] !== null || !storyOk(s, i)) return false;
      if (openHeld(s) === null) return !blockedAny(s);
      return lockedEmail(s) === MSGS[i]!.email && !blockedAny(s);
    }
    case "Commit": {
      const h = s.held[heldIndex(a.conn)];
      return h !== null && !h.blocked;
    }
    case "Repair":
      return !busy && !blockedAny(s);
  }
}

function advanceWorker(s: SesState, k: 0 | 1): string {
  const w = s.workers[k]!;
  const m = MSGS[w.msg]!;
  if (w.gate === "record") {
    dbRecord(s.db, w.msg);
    if (kindRoutine(m.kind)) {
      s.db.receipts[w.msg] = true;
      dbSettle(s.db, w.msg, k, "completed");
      s.workers[k] = null;
      return "done";
    }
    const gate: Gate = hasEffects(m) ? "suppress" : "mark";
    s.workers[k] = { ...w, gate };
    return `at:${gate}`;
  }
  if (w.gate === "suppress") {
    dbApplyEffects(s.db, w.msg, null);
    s.workers[k] = { ...w, gate: "mark" };
    return "at:mark";
  }
  s.db.receipts[w.msg] = true;
  dbSettle(s.db, w.msg, k, "completed");
  s.workers[k] = null;
  return "done";
}

function round6(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

function buildView(s: SesState): SesView {
  const db = s.db;
  const emails: SesView["emails"] = {};
  for (let i = 0; i < db.emails.length; i++) {
    const e = db.emails[i]!;
    const error = e.lost
      ? "SES_ACCEPTANCE_UNKNOWN"
      : e.status === "suppressed"
        ? "EMAIL_VALIDATION_SUPPRESSED"
        : null;
    const reason = e.status === "suppressed" ? "email_validation" : null;
    emails[EMAILS[i]!] = [e.status, e.provider, e.bits, error, reason];
  }
  const contacts: SesView["contacts"] = {};
  for (let r = 0; r < db.contacts.length; r++) {
    const c = db.contacts[r];
    if (c) contacts[RECIPS[r]!] = [c.suppressed, c.reason, c.opened];
  }
  const eventMap = new Map<string, [string, string, string, number]>();
  const pubMap = new Map<string, [string, string]>();
  for (let i = 0; i < db.emails.length; i++) {
    const e = db.emails[i]!;
    if (e.dispatched) {
      const l = `A:${EMAILS[i]}`;
      const t = e.lost ? "acceptance_unknown" : "accepted";
      const p = e.lost ? "email.rejected" : "email.sent";
      eventMap.set(l, [l, t, EMAILS[i]!, 0]);
      pubMap.set(l, [l, p]);
    }
  }
  for (const i of db.events) {
    const m = MSGS[i]!;
    const hashes = m.kind === "bounce" || m.kind === "complaint" ? recipientsOf(m).length : 0;
    eventMap.set(m.label, [m.label, kindEvent(m.kind), EMAILS[m.email]!, hashes]);
    const p = kindPublic(m.kind);
    if (p !== null) pubMap.set(m.label, [m.label, p]);
  }
  const sortKey = (a: [string, ...unknown[]], b: [string, ...unknown[]]) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  const events = [...eventMap.values()].sort(sortKey);
  const published = [...pubMap.values()].sort(sortKey);
  const deliveries: [string[], string[]] = [
    [...db.deliveries[0]].sort(),
    [...db.deliveries[1]].sort(),
  ];
  const receipts: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(db.receipts)) {
    receipts[MSGS[Number(k)]!.label] = v;
  }
  const jobs: [string, string, string, number][] = Object.entries(db.jobs)
    .map(([k, j]): [string, string, string, number] => ["ses", MSGS[Number(k)]!.label, j.st, j.attempts])
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

  const has = (e: EmailState, ks: MsgKind[]) => e.kinds.some((x) => ks.includes(x));
  const cnt = (f: (e: EmailState) => boolean) => db.emails.filter(f).length;
  const stats: SesView["stats"] = [
    cnt(
      (e) =>
        e.status !== "suppressed" &&
        (e.provider ||
          ["accepted", "delivered", "bounced", "complained", "delayed"].includes(e.status) ||
          has(e, ["delivery", "bounce", "complaint", "delay", "transient"])),
    ),
    cnt((e) => e.status === "delivered" || has(e, ["delivery"])),
    cnt((e) => e.status === "bounced" || has(e, ["bounce"])),
    cnt((e) => e.status === "complained" || has(e, ["complaint"])),
    cnt((e) => e.status === "rejected" || e.status === "rendering_failed" || has(e, ["reject", "render"])),
    cnt((e) => e.status === "delayed" || has(e, ["delay", "transient"])),
  ];

  // Sender-score inputs (GET /v1/sender-score, standing-model.ts commits 5c33ebb4/b06d18d0):
  // Both fixture emails e1 and e2 belong to campaign c, so campaign first_sends = accepted campaign emails
  // and hygiene = (first_bounced + suppressed) / (first_sends + suppressed) when first_sends > 0.
  const accepted = cnt(
    (e) =>
      e.status !== "suppressed" &&
      (e.provider ||
        ["accepted", "delivered", "bounced", "complained", "delayed"].includes(e.status) ||
        (e.bits & 1) !== 0),
  );
  const delivered = cnt((e) => e.status === "delivered" || (e.bits & 2) !== 0);
  const bounced = cnt((e) => e.status === "bounced" || (e.bits & 4) !== 0);
  const complained = cnt((e) => e.status === "complained" || (e.bits & 8) !== 0);
  const firstSends = cnt((e) => e.status !== "suppressed" && (e.provider || (e.bits & 1) !== 0));
  const firstBounced = bounced;
  const suppressed = cnt((e) => e.status === "suppressed");
  const known = accepted - firstSends;
  const bouncedKnown = bounced - firstBounced;
  const score: SesView["score"] = [
    known >= 1 ? round6(bouncedKnown / known) : null,
    delivered >= 1 ? round6(complained / delivered) : null,
    firstSends > 0 && firstSends + suppressed >= 1
      ? round6((firstBounced + suppressed) / (firstSends + suppressed))
      : null,
  ];

  const hosted: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < db.emails.length; i++) {
    const e = db.emails[i]!;
    if (e.status === "suppressed") continue;
    if (e.accepted) hosted[0] += COST[i]!;
    for (const [slot, kind] of [
      [1, "bounce"],
      [2, "complaint"],
    ] as const) {
      const dest = new Set<number>();
      for (const mIdx of db.events) {
        const m = MSGS[mIdx]!;
        if (m.email === i && m.kind === kind) {
          for (const r of recipientsOf(m)) dest.add(r);
        }
      }
      hosted[slot] += dest.size;
    }
  }

  return { emails, contacts, events, published, deliveries, receipts, jobs, hosted, stats, score };
}

function actionWeight(a: SesAction): number {
  const base = (): number => {
    switch (a.op) {
      case "Go":
      case "Commit":
        return a.op === "Commit" && !a.commit ? 6 : 30;
      case "Crash":
        return 6;
      case "Hold":
        return 3;
      case "Claim":
        return 12;
      case "Queue":
        return 6;
      case "Pair":
        return 2;
      case "Http":
        return 5;
      case "Accept":
        return 20;
      case "Lost":
      case "Expire":
        return 4;
      case "Repair":
        return 2;
      default:
        return 1;
    }
  };
  const w = base();
  return "old" in a && a.old ? Math.ceil(w / 2) : w;
}

const ALL_ACTIONS: SesAction[] = (() => {
  const out: SesAction[] = [];
  for (const m of MSGS) {
    out.push({ op: "Queue", msg: m.label });
    out.push({ op: "Http", msg: m.label });
    out.push({ op: "Queue", msg: m.label, old: true });
    out.push({ op: "Http", msg: m.label, old: true });
    for (const w of WORKERS) {
      out.push({ op: "Claim", worker: w, msg: m.label });
      out.push({ op: "Claim", worker: w, msg: m.label, old: true });
    }
    for (const h of HELD) {
      out.push({ op: "Hold", conn: h, msg: m.label });
    }
  }
  for (const [a, b] of PAIRS) out.push({ op: "Pair", a, b });
  out.push(
    { op: "Forge" },
    { op: "Stray" },
    { op: "Alien" },
    { op: "Cross", via: "queue" },
    { op: "Cross", via: "http" },
    { op: "Pause", paused: true },
    { op: "Pause", paused: false },
  );
  for (const e of EMAILS) {
    out.push({ op: "Accept", email: e });
    out.push({ op: "Lost", email: e });
  }
  out.push({ op: "Expire" }, { op: "Repair" });
  for (const w of WORKERS) {
    out.push({ op: "Go", worker: w });
    out.push({ op: "Crash", worker: w });
  }
  for (const h of HELD) {
    out.push({ op: "Commit", conn: h, commit: true });
    out.push({ op: "Commit", conn: h, commit: false });
  }
  return out;
})();

const sesIdleRules: IdleRule<SesSnapshot>[] = [
  {
    id: "ses.outcome-bits-recount",
    description: "sending_emails.event_outcomes equals a recount of published events",
    check: (s) => (s.outcomeBitsMismatches.length ? s.outcomeBitsMismatches.join("; ") : undefined),
  },
  {
    id: "ses.single-stored-event",
    description: "each SNS notification is stored at most once in sending_email_events",
    check: (s) => (s.duplicateStoredEvents.length ? s.duplicateStoredEvents.join("; ") : undefined),
  },
  {
    id: "ses.published-has-stored",
    description: "every published operation_event has a matching stored email event for the same email",
    check: (s) => (s.orphanPublishedEvents.length ? s.orphanPublishedEvents.join("; ") : undefined),
  },
  {
    id: "ses.single-delivery-per-endpoint",
    description: "each webhook endpoint gets at most one delivery per published event, with matching payload",
    check: (s) => (s.deliveryInconsistencies.length ? s.deliveryInconsistencies.join("; ") : undefined),
  },
  {
    id: "ses.hosted-credits-projection",
    description: "hosted_health_credits equals hosted_health_projection",
    check: (s) => s.creditsProjectionMismatch ?? undefined,
  },
  {
    id: "ses.hosted-hourly-recount",
    description: "hosted_health_hourly equals the sum of hosted_health_credits",
    check: (s) => s.hourlyCreditsMismatch ?? undefined,
  },
  {
    id: "ses.no-quarantined",
    description: "no feedback item is quarantined into operation_feedback_failures",
    check: (s) => (s.quarantinedCount > 0 ? `${s.quarantinedCount} quarantined feedback items` : undefined),
  },
  {
    id: "ses.suppression-never-lifted",
    description: "once a contact is suppressed by feedback, suppression is never lifted",
    check: (s) => (s.suppressionLifted.length ? `suppression lifted: ${s.suppressionLifted.join(", ")}` : undefined),
  },
];

export const ses = model<SesState, SesAction, SesObs, SesSnapshot>({
  id: "ses",
  description: "Nightmail Hosted SES feedback processing: SNS route, feedback queue, recovery jobs, rank guards, stats and health",
  maxSteps: 30,
  bug: "canary_lift_suppression",

  initial: (): SesState => {
    const emptyEmail = (): EmailState => ({
      status: "attempting",
      provider: false,
      bits: 0,
      lost: false,
      accepted: false,
      dispatched: false,
      kinds: [],
    });
    return {
      db: {
        emails: [emptyEmail(), emptyEmail()],
        contacts: [null, { suppressed: false, reason: null, opened: false }],
        receipts: {},
        jobs: {},
        events: [],
        deliveries: [[], []],
        paused: false,
      },
      workers: [null, null],
      held: [null, null],
      used: 0,
    };
  },

  choices(s): Choice<SesAction>[] {
    const out: Choice<SesAction>[] = [];
    for (const a of ALL_ACTIONS) {
      if (isEnabled(s, a)) out.push(choice(a, actionWeight(a)));
    }
    return out;
  },

  step(s, a): Step<SesState, SesObs> {
    const next = structuredClone(s);
    const woke: Record<string, unknown> = {};
    let r: unknown;

    switch (a.op) {
      case "Repair":
        r = "ok";
        break;
      case "Queue": {
        const i = msgIndex(a.msg);
        next.used |= 1 << i;
        r = dbBatchSeen(next.db, [i], null);
        break;
      }
      case "Pair": {
        const i = msgIndex(a.a);
        const j = msgIndex(a.b);
        next.used |= (1 << i) | (1 << j);
        r = dbBatchSeen(next.db, [i, j], null);
        break;
      }
      case "Http": {
        const i = msgIndex(a.msg);
        next.used |= 1 << i;
        r = dbHttp(next.db, i);
        break;
      }
      case "Forge":
        r = "e:SNS_INVALID_SIGNATURE";
        break;
      case "Stray":
        r = "e:SNS_TOPIC_NOT_ALLOWED";
        break;
      case "Alien":
        r = "e:SES_ACCOUNT_MISMATCH";
        break;
      case "Cross":
        r = a.via === "queue" ? ["e:SES_FEEDBACK_UNMATCHED"] : "e:SES_EMAIL_NOT_FOUND";
        break;
      case "Accept":
      case "Lost":
        dbDispatch(next.db, emailIndex(a.email), a.op === "Lost");
        r = "ok";
        break;
      case "Expire":
        for (const j of Object.values(next.db.jobs)) {
          if (j.st === "running") j.expired = true;
        }
        r = "ok";
        break;
      case "Pause":
        next.db.paused = a.paused;
        r = "ok";
        break;
      case "Claim": {
        const k = workerIndex(a.worker);
        const i = msgIndex(a.msg);
        const j = next.db.jobs[i]!;
        j.st = "running";
        j.attempts += 1;
        j.holder = k;
        j.expired = false;
        const rd = dbRead(next.db, i);
        if (rd === "processed") {
          dbSettle(next.db, i, k, "completed");
          r = "done";
        } else if (rd === "missing") {
          const retry = j.attempts < MAX_ATTEMPTS;
          dbSettle(next.db, i, k, retry ? "pending" : "failed");
          r = `${retry ? "retry" : "failed"}:SES_EMAIL_NOT_FOUND`;
        } else {
          next.workers[k] = { msg: i, gate: "record", blocked: false };
          r = "at:record";
        }
        break;
      }
      case "Go": {
        const k = workerIndex(a.worker);
        if (openHeld(next) !== null) {
          next.workers[k]!.blocked = true;
          r = "blocked";
        } else {
          r = advanceWorker(next, k);
        }
        break;
      }
      case "Crash": {
        const k = workerIndex(a.worker);
        const w = next.workers[k]!;
        next.workers[k] = null;
        const j = next.db.jobs[w.msg];
        if (j && j.holder === k) j.holder = null;
        r = "ok";
        break;
      }
      case "Hold": {
        const k = heldIndex(a.conn);
        const i = msgIndex(a.msg);
        next.used |= 1 << i;
        const seen = next.db.contacts.map((c) => c !== null);
        if (openHeld(next) !== null) {
          next.held[k] = { msg: i, blocked: true, seen, result: null };
          r = "blocked";
        } else {
          const copy = structuredClone(next.db);
          const res = dbBatchSeen(copy, [i], null);
          next.held[k] = { msg: i, blocked: false, seen, result: res[0]! };
          r = res;
        }
        break;
      }
      case "Commit": {
        const k = heldIndex(a.conn);
        const h = next.held[k]!;
        next.held[k] = null;
        if (a.commit) {
          dbBatchSeen(next.db, [h.msg], h.seen);
        }
        for (let slot = 0; slot < 2; slot++) {
          const x = next.held[slot];
          if (x && x.blocked) {
            const copy = structuredClone(next.db);
            const res = dbBatchSeen(copy, [x.msg], x.seen);
            x.blocked = false;
            x.result = res[0]!;
            woke[HELD[slot]!] = res;
          }
        }
        for (let w = 0; w < 2; w++) {
          const wk = next.workers[w];
          if (wk && wk.blocked && openHeld(next) === null) {
            wk.blocked = false;
            woke[WORKERS[w]!] = advanceWorker(next, w as 0 | 1);
          }
        }
        r = "ok";
        break;
      }
    }

    return { next, expect: exact({ r, woke, view: buildView(next) }) };
  },

  idle: sesIdleRules,

  temporal: [
    {
      id: "ses.suppression-monotonic",
      title: "a suppressed contact is never unsuppressed",
      prop: prop.optional(
        prop.forEach(
          { name: "contact", discover: sel.event("contact.suppressed"), key: "/contact" },
          (contact) => [prop.never(sel.event("contact.unsuppressed", { "/contact": contact }))],
        ),
      ),
    },
  ],
});
