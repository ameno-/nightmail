/**
 * Preventative property (e): Multi-tenant isolation — one workspace's heavy work must not stop another's send.
 * Invariant: While workspace A runs heavy contact import commits or a marketing send flood in the shared
 * database and sending region, workspace B's transactional sends always return 202 promptly (no lock/quota
 * spillover or deadlock) and dispatch ahead of workspace A's marketing backlog.
 *
 * Tool-fit note: tear verifies logical, lock-order, and dispatcher-fairness isolation (including concurrent
 * rounds). Physical resource exhaustion (filling a 10 GB disk with WAL, exhausting PgBouncer's 25 connections,
 * or CPU/IOPS starvation as in incident-2026-11-23.md) is outside tear's scope; the simpler tool for physical
 * saturation is a resource-capped Docker Postgres load script.
 */
import { choice, model, satisfies, type Choice, type IdleRule, type Step } from "@tear/mbt";
import type { TenantAction, TenantObs, TenantSnapshot } from "./tenant-isolation.types.ts";

export interface TenantState {
  heavyImports: number;
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
  description: "Multi-tenant isolation: workspace A's heavy imports and marketing floods never block or starve workspace B's sends",
  maxSteps: 10,
  rounds: 2,
  bug: "canary_block_victim",
  roundRoles: {
    HeavyImport: "call",
    HeavyMarketingFlood: "call",
    VictimSend: "call",
    OverlapImportAndVictimSend: "sequential",
    DrainVictim: "sequential",
  },

  initial: (): TenantState => ({ heavyImports: 0, heavyMarketingQueued: 0, victimQueued: 0 }),

  choices(s): Choice<TenantAction>[] {
    const out: Choice<TenantAction>[] = [];
    if (s.heavyImports < 3) out.push(choice({ op: "HeavyImport" }, 2));
    if (s.heavyMarketingQueued < 40) out.push(choice({ op: "HeavyMarketingFlood" }, 2));
    out.push(choice({ op: "VictimSend" }, 3));
    if (s.heavyImports < 3) out.push(choice({ op: "OverlapImportAndVictimSend" }, 2));
    if (s.victimQueued > 0) out.push(choice({ op: "DrainVictim" }, 3));
    return out;
  },

  step(s, a): Step<TenantState, TenantObs> {
    const next = structuredClone(s);
    switch (a.op) {
      case "HeavyImport":
        next.heavyImports += 1;
        return {
          next,
          expect: satisfies("heavy-import-ok", (obs) =>
            obs.status === 200 ? true : `heavy import failed: status=${obs.status} code=${obs.code}`,
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
            if (obs.status !== 200) return `overlapping heavy import failed: status=${obs.status} code=${obs.code}`;
            if (obs.victimStatus !== 202) {
              return `victim send blocked during heavy import: status=${obs.victimStatus} code=${obs.code}`;
            }
            if ((obs.victimElapsedMs ?? 0) > VICTIM_SEND_BUDGET_MS) {
              return `victim send delayed during import: ${obs.victimElapsedMs}ms > ${VICTIM_SEND_BUDGET_MS}ms`;
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
