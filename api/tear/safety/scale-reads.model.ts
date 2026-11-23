/**
 * Preventative property (d): Large-workspace dashboard read latency budgets (review-582.md class).
 * Invariant: On a workspace seeded with N contacts (default 200,000 via TEAR_SCALE_CONTACTS, up to
 * 2,000,000), every dashboard read answers HTTP 200 within its stated latency budget.
 *
 * Tool-fit note: tear is NOT the ideal primary tool for numeric latency budgets (wall-clock times vary
 * with buffer-cache warmth and shared CPU load, making counterexample shrinking noisy). A standalone
 * EXPLAIN-plan + p95 benchmark script is the simpler tool; this model demonstrates a host-timed named
 * `satisfies("within-budget")` check inside tear.
 */
import { choice, model, satisfies, type Choice, type IdleRule, type Step } from "@tear/mbt";
import type { ScaleReadAction, ScaleReadKind, ScaleReadObs, ScaleReadSnapshot } from "./scale-reads.types.ts";

export interface ScaleReadState {
  done: ScaleReadKind[];
}

const ALL_READS: readonly ScaleReadKind[] = [
  "ContactsPage",
  "ContactsBigList",
  "ContactsSmallList",
  "ContactsSearchHit",
  "ListsWithCounts",
  "CampaignAudienceCount",
] as const;

const scaleIdleRules: IdleRule<ScaleReadSnapshot>[] = [
  {
    id: "scale.no-leaked-errors",
    description: "no unhandled rejections or host errors",
    check: (s) => (s.leakedErrors.length ? s.leakedErrors.join("; ") : undefined),
  },
];

export const scaleReads = model<ScaleReadState, ScaleReadAction, ScaleReadObs, ScaleReadSnapshot>({
  id: "scale-reads",
  description: "Large-workspace (200k–2M contacts) dashboard read latency budgets checked via named satisfies predicate",
  maxSteps: 6,
  bug: "canary_slow_read",

  initial: (): ScaleReadState => ({ done: [] }),

  choices(s): Choice<ScaleReadAction>[] {
    const out: Choice<ScaleReadAction>[] = [];
    for (const op of ALL_READS) {
      if (!s.done.includes(op)) out.push(choice({ op }, 1));
    }
    return out;
  },

  step(s, a): Step<ScaleReadState, ScaleReadObs> {
    const next: ScaleReadState = { done: [...s.done, a.op] };
    const expect = satisfies("within-budget", (obs) => {
      if (obs.status !== 200) {
        return `${a.op} returned HTTP ${obs.status} (expected 200) at ${obs.seededContacts} contacts`;
      }
      if (obs.elapsedMs > obs.budgetMs) {
        return `${a.op} took ${obs.elapsedMs}ms > budget ${obs.budgetMs}ms at ${obs.seededContacts} contacts`;
      }
      return true;
    });
    // Known product bug BUG-SCALE-01 (review-582.md B1): GET /v1/contacts?listId=<small> scans every
    // contact in the workspace because inList() uses OFFSET 0 (audience.ts:103).
    return a.op === "ContactsSmallList" ? { next, expect, mask: "BUG-SCALE-01" } : { next, expect };
  },

  idle: scaleIdleRules,
});
