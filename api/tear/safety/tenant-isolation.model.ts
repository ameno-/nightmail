/**
 * Preventative property (e): Multi-tenant isolation — one workspace's import commit or marketing backlog
 * must not block or starve another workspace's transactional send.
 * Invariant: While workspace A commits a contact import or floods marketing mail in the shared database
 * and sending region, workspace B's transactional sends return 202 within budget (no cross-workspace lock
 * or deadlock) and dispatch ahead of workspace A's marketing backlog.
 *
 * Tool-fit note: tear verifies lock/error isolation during commit overlap and dispatcher priority across
 * workspaces. Physical resource exhaustion (WAL disk fill, PgBouncer pool saturation, IOPS starvation)
 * belongs in a resource-capped Docker Postgres load script.
 */
import { choice, model, satisfies, type Choice, type IdleRule, type Step } from "@tear/mbt";
import type { TenantAction, TenantObs, TenantSnapshot } from "./tenant-isolation.types.ts";

export interface TenantState {
  heavyImports: number;
  previewReady: boolean;
  heavyMarketingQueued: number;
  victimQueued: number;
}

const VICTIM_SEND_BUDGET_MS = 2000;

const tenantIdleRules: IdleRule<TenantSnapshot>[] = [
  {
    id: "tenant.victim-never-failed",
    description: "workspace B's transactional sends are never refused or deadlocked by workspace A's heavy work",
    check: (s) => (s.victimFailures.length ? `victim send failures: ${s.victimFailures.join("; ")}` : undefined),
  },
  {
    id: "tenant.victim-never-starved",
    description: "after draining, every accepted workspace B transactional email was delivered",
    check: (s) => (s.starvedVictim.length ? `starved victim mail: ${s.starvedVictim.join(", ")}` : undefined),
  },
  {
    id: "tenant.no-leaked-errors",
    description: "no unhandled rejections or host errors",
    check: (s) => (s.leakedErrors.length ? s.leakedErrors.join("; ") : undefined),
  },
];

export const tenantIsolation = model<TenantState, TenantAction, TenantObs, TenantSnapshot>({
  id: "tenant-isolation",
  description: "Multi-tenant isolation: workspace A's import commits and marketing floods never lock out or starve workspace B's sends",
  maxSteps: 10,
  rounds: 2,
  bug: "canary_block_victim",
  roundRoles: {
    PreviewImport: "sequential",
    CommitImport: "call",
    HeavyMarketingFlood: "call",
    VictimSend: "call",
    OverlapImportAndVictimSend: "sequential",
    DrainVictim: "sequential",
  },

  initial: (): TenantState => ({ heavyImports: 0, previewReady: false, heavyMarketingQueued: 0, victimQueued: 0 }),

  choices(s): Choice<TenantAction>[] {
    const out: Choice<TenantAction>[] = [];
    if (!s.previewReady && s.heavyImports < 3) out.push(choice({ op: "PreviewImport" }, 2));
    if (s.previewReady) out.push(choice({ op: "CommitImport" }, 3));
    if (s.heavyMarketingQueued < 40) out.push(choice({ op: "HeavyMarketingFlood" }, 2));
    out.push(choice({ op: "VictimSend" }, 3));
    if (s.heavyImports < 3) out.push(choice({ op: "OverlapImportAndVictimSend" }, 2));
    if (s.victimQueued > 0) out.push(choice({ op: "DrainVictim" }, 3));
    return out;
  },

  step(s, a): Step<TenantState, TenantObs> {
    const next = structuredClone(s);
    switch (a.op) {
      case "PreviewImport":
        next.previewReady = true;
        return {
          next,
          expect: satisfies("preview-import-ok", (obs) =>
            obs.status === 201 ? true : `preview import failed: status=${obs.status} code=${obs.code}`,
          ),
        };
      case "CommitImport":
        next.previewReady = false;
        next.heavyImports += 1;
        return {
          next,
          expect: satisfies("commit-import-ok", (obs) =>
            obs.status === 200 ? true : `commit import failed: status=${obs.status} code=${obs.code}`,
          ),
        };
      case "HeavyMarketingFlood":
        next.heavyMarketingQueued += 20;
        return {
          next,
          expect: satisfies("heavy-flood-ok", (obs) =>
            obs.status === 202 ? true : `heavy marketing flood failed: status=${obs.status} code=${obs.code}`,
          ),
        };
      case "VictimSend":
        next.victimQueued += 1;
        return {
          next,
          expect: satisfies("victim-send-not-blocked", (obs) => {
            if (obs.victimStatus !== 202) {
              return `victim transactional send refused: status=${obs.victimStatus} code=${obs.code}`;
            }
            if ((obs.victimElapsedMs ?? 0) > VICTIM_SEND_BUDGET_MS) {
              return `victim send took ${obs.victimElapsedMs}ms > ${VICTIM_SEND_BUDGET_MS}ms budget`;
            }
            return true;
          }),
        };
      case "OverlapImportAndVictimSend":
        next.heavyImports += 1;
        next.victimQueued += 1;
        return {
          next,
          expect: satisfies("overlap-victim-not-blocked", (obs) => {
            if (obs.status !== 200) return `overlapping heavy import commit failed: status=${obs.status} code=${obs.code}`;
            if (obs.victimStatus !== 202) {
              return `victim send blocked during import commit: status=${obs.victimStatus} code=${obs.code}`;
            }
            if ((obs.victimElapsedMs ?? 0) > VICTIM_SEND_BUDGET_MS) {
              return `victim send delayed during import commit: ${obs.victimElapsedMs}ms > ${VICTIM_SEND_BUDGET_MS}ms`;
            }
            return true;
          }),
        };
      case "DrainVictim":
        next.victimQueued = 0;
        next.heavyMarketingQueued = 0;
        return {
          next,
          expect: satisfies("victim-delivered-priority", (obs) => {
            if (obs.status !== 200) return `drain failed: status=${obs.status} code=${obs.code}`;
            if (obs.victimDeliveredBeforeMarketing === false) {
              return "victim transactional email was starved behind heavy workspace's marketing queue";
            }
            return true;
          }),
        };
    }
  },

  idle: tenantIdleRules,
});
