/**
 * Preventative property (c): Database fault resilience (incident-2026-11-23 / PR #582 class).
 * Invariant: When the database rejects writes (read-only), stalls (statement/lock timeout), or
 * exhausts connections mid-run, every API answer is either a success or marked retryable
 * (retryable === true), and once the database recovers, no accepted email is lost and none is sent twice.
 */
import { choice, exact, model, prop, satisfies, sel, type Choice, type IdleRule, type Step } from "@tear/mbt";
import type { DbFaultAction, DbFaultObs, DbFaultSnapshot, FaultMode, SendKey } from "./db-faults.types.ts";

export interface DbFaultState {
  fault: FaultMode;
  keysAccepted: SendKey[];
}

const FAULT_MODES: readonly FaultMode[] = [
  "none",
  "readonly_pg_readonly",
  "readonly_25006",
  "stall_57014",
  "lock_55P03",
  "pool_exhausted_53300",
] as const;

const dbFaultIdleRules: IdleRule<DbFaultSnapshot>[] = [
  {
    id: "dbfault.no-double-send",
    description: "no accepted email is ever sent to SES more than once across database faults and retries",
    check: (s) => (s.doubleSentIds.length ? `double-sent: ${s.doubleSentIds.join(", ")}` : undefined),
  },
  {
    id: "dbfault.no-lost-email",
    description: "after draining with a healthy database, every accepted email has been delivered to SES",
    check: (s) => (s.lostAfterDrain.length ? `lost after drain: ${s.lostAfterDrain.join(", ")}` : undefined),
  },
  {
    id: "dbfault.no-leaked-errors",
    description: "no unhandled rejections or host errors",
    check: (s) => (s.leakedErrors.length ? s.leakedErrors.join("; ") : undefined),
  },
];

export const dbFaults = model<DbFaultState, DbFaultAction, DbFaultObs, DbFaultSnapshot>({
  id: "db-faults",
  description: "Database faults (read-only, timeout stall, pool exhaustion): retryable answers, no lost or double-sent mail",
  maxSteps: 16,
  bug: "canary_double_send",

  initial: (): DbFaultState => ({ fault: "none", keysAccepted: [] }),

  choices(s): Choice<DbFaultAction>[] {
    const out: Choice<DbFaultAction>[] = [];
    for (const mode of FAULT_MODES) {
      if (mode !== s.fault) {
        out.push(choice({ op: "SetFault", mode }, mode === "none" ? 4 : 1));
      }
    }
    out.push(
      choice({ op: "Send", key: "k1" }, 3),
      choice({ op: "Send", key: "k2" }, 3),
      choice({ op: "CreateList" }, 2),
      choice({ op: "ReadMe" }, 2),
      choice({ op: "Drain" }, 3),
    );
    return out;
  },

  step(s, a): Step<DbFaultState, DbFaultObs> {
    const next = structuredClone(s);
    if (a.op === "SetFault") {
      next.fault = a.mode;
      return {
        next,
        expect: exact({ status: 200, code: null, retryable: null, emailId: null, drained: false }),
      };
    }

    if (a.op === "Drain") {
      return {
        next,
        expect: satisfies("drain-safe", (obs) => {
          if (s.fault === "none" && !obs.drained) {
            return `drain failed while DB was healthy: status=${obs.status} code=${obs.code}`;
          }
          return true;
        }),
      };
    }

    // Known product bugs on dev (24333f2c, prior to PR #582):
    // - BUG-DB-01: read-only errors (XX000 pg_readonly, 25006) return 500 INTERNAL_ERROR (retryable: false).
    // - BUG-DB-02: statement/lock timeouts (57014, 55P03) return 500 INTERNAL_ERROR (retryable: false).
    const mask =
      s.fault === "readonly_pg_readonly" || s.fault === "readonly_25006"
        ? "BUG-DB-01"
        : s.fault === "stall_57014" || s.fault === "lock_55P03"
          ? "BUG-DB-02"
          : undefined;

    if (a.op === "Send" && s.fault === "none" && !next.keysAccepted.includes(a.key)) {
      next.keysAccepted.push(a.key);
    }

    const expect = satisfies("success-or-retryable", (obs) => {
      if (s.fault === "none") {
        if (obs.status >= 200 && obs.status < 300) return true;
        return `expected 2xx while DB is healthy, got ${obs.status} ${obs.code} (retryable=${obs.retryable})`;
      }
      if (obs.status >= 200 && obs.status < 300) return true;
      if ((obs.status === 503 || obs.status === 409) && obs.retryable === true) return true;
      return `under DB fault ${s.fault}, expected 2xx or retryable 503/409, got status=${obs.status} code=${obs.code} retryable=${obs.retryable}`;
    });

    return mask ? { next, expect, mask } : { next, expect };
  },

  idle: dbFaultIdleRules,

  temporal: [
    {
      id: "dbfault.once",
      title: "an accepted email is never sent to SES more than once",
      prop: prop.optional(
        prop.forEach(
          { name: "email", discover: sel.event("ses.committed"), key: "/emailId" },
          (emailId) => [prop.never(sel.event("ses.call", { "/emailId": emailId }))],
        ),
      ),
    },
  ],
});
