/**
 * Workspace data-isolation safety model: nothing crosses between workspaces, on any route.
 *
 * Invariants verified across 3 workspaces (A, B, C), all 14 principal kinds (owner, admin, member,
 * dual-workspace user, unrestricted API key, domain-limited API key, MCP OAuth sessions,
 * support conversations, unauthenticated), all 276 OpenAPI routes (enumerated dynamically from
 * api/openapi.json), all 31 support routes (28 hidden /v1/support/* + 3 /v1/support-actions/*),
 * all 242 MCP catalog tools, and every ID-carrying body, query, and path field:
 *   1. No response ever contains another workspace's recognisable data, IDs, names, or counts.
 *   2. No write ever changes another workspace's state (full DB + storage snapshot before/after).
 *   3. "Not yours" and "doesn't exist" are indistinguishable (same status, code, message, shape).
 *   4. Aggregate and count endpoints equal a direct SQL recount over the caller's own workspace only.
 *   5. For a user who belongs to two workspaces (A and B, not C), each request acts only in the
 *      workspace named by X-Nightmail-Workspace, and cross-workspace path/body IDs never land across.
 */
import { choice, model, prop, satisfies, sel, type Choice, type IdleRule, type Step } from "@tear/mbt";
import type {
  AggregatePrincipal,
  FieldProbeFocus,
  McpChunk,
  McpPrincipal,
  OpenApiPrincipal,
  RouteGroup,
  SupportPrincipal,
  WorkspaceIsolationAction,
  WorkspaceIsolationObs,
  WorkspaceIsolationSnapshot,
  WorkspaceSlot,
} from "./workspace-isolation.types.ts";

export interface WorkspaceIsolationState {
  steps: number;
  seenGroups: string[];
}

const ROUTE_GROUPS: readonly RouteGroup[] = [
  "auth",
  "audience",
  "templates",
  "emails",
  "campaigns",
  "domains",
  "webhooks",
  "ops",
  "routing-rules",
  "inboxes",
  "inbound-mail",
  "inbound-config",
  "workspaces",
  "billing",
  "other",
] as const;

const OPENAPI_PRINCIPALS: readonly OpenApiPrincipal[] = [
  "ownerA",
  "adminA",
  "memberA",
  "dualA",
  "dualB",
  "dualC",
  "keyA",
  "dkeyA",
  "anon",
] as const;

const SUPPORT_PRINCIPALS: readonly SupportPrincipal[] = [
  "supportA",
  "supportDualA",
  "supportDualAB",
  "ownerA",
  "keyA",
  "anon",
] as const;

const MCP_PRINCIPALS: readonly McpPrincipal[] = ["mcpA", "mcpDual", "keyA", "dkeyA", "anon"] as const;
const MCP_CHUNKS: readonly McpChunk[] = ["auth-ops", "audience", "sending", "routing-inboxes", "inbound"] as const;

const AGGREGATE_PRINCIPALS: readonly AggregatePrincipal[] = [
  "ownerA",
  "adminA",
  "memberA",
  "dualA",
  "dualB",
  "keyA",
  "supportA",
] as const;

const FIELD_FOCUSES: readonly FieldProbeFocus[] = [
  "body-writes",
  "query-reads",
  "pr614-bug-iso-04",
  "nearby-foreign-ended",
  "nearby-own-ended",
] as const;

const TARGETS: readonly WorkspaceSlot[] = ["A", "B", "C"] as const;

const isolationIdleRules: IdleRule<WorkspaceIsolationSnapshot>[] = [
  {
    id: "wiso.no-leaks",
    description: "no response ever contains another workspace's recognisable data, IDs, names, or counts",
    check: (s) => (s.leaks.length ? `cross-workspace leaks (${s.leaks.length}): ${s.leaks.slice(0, 5).join("; ")}` : undefined),
  },
  {
    id: "wiso.no-foreign-mutations",
    description: "no write ever changes another workspace's database or object storage state",
    check: (s) =>
      s.foreignMutations.length
        ? `foreign workspace mutations (${s.foreignMutations.length}): ${s.foreignMutations.slice(0, 5).join("; ")}`
        : undefined,
  },
  {
    id: "wiso.no-id-probing",
    description: "foreign resource IDs and nonexistent resource IDs produce indistinguishable responses",
    check: (s) =>
      s.probeOracles.length
        ? `ID probe oracles (${s.probeOracles.length}): ${s.probeOracles.slice(0, 5).join("; ")}`
        : undefined,
  },
  {
    id: "wiso.aggregates-exact",
    description: "every aggregate and count endpoint equals a direct recount over the caller's workspace only",
    check: (s) =>
      s.aggregateMismatches.length
        ? `aggregate mismatches (${s.aggregateMismatches.length}): ${s.aggregateMismatches.slice(0, 5).join("; ")}`
        : undefined,
  },
  {
    id: "wiso.dual-isolated",
    description: "for a dual-workspace user, mismatched header vs path/body IDs never cross between workspaces",
    check: (s) =>
      s.dualViolations.length
        ? `dual-workspace violations (${s.dualViolations.length}): ${s.dualViolations.slice(0, 5).join("; ")}`
        : undefined,
  },
  {
    id: "wiso.no-leaked-errors",
    description: "no unhandled rejections or unexpected 5xx server failures",
    check: (s) => {
      const all = [...s.unexpectedErrors, ...s.leakedErrors];
      return all.length ? `unexpected errors (${all.length}): ${all.slice(0, 5).join("; ")}` : undefined;
    },
  },
];

function summarizeViolations(obs: WorkspaceIsolationObs): string | true {
  const problems: string[] = [];
  if (obs.leaks.length) problems.push(`LEAK: ${obs.leaks.slice(0, 3).join(" | ")}`);
  if (obs.foreignMutations.length) problems.push(`MUTATION: ${obs.foreignMutations.slice(0, 3).join(" | ")}`);
  if (obs.probeOracles.length) problems.push(`ORACLE: ${obs.probeOracles.slice(0, 3).join(" | ")}`);
  if (obs.aggregateMismatches.length) problems.push(`AGGREGATE: ${obs.aggregateMismatches.slice(0, 3).join(" | ")}`);
  if (obs.dualViolations.length) problems.push(`DUAL: ${obs.dualViolations.slice(0, 3).join(" | ")}`);
  if (obs.unexpectedErrors.length) problems.push(`ERROR: ${obs.unexpectedErrors.slice(0, 3).join(" | ")}`);
  return problems.length ? problems.join(" ;; ") : true;
}

function maskFor(a: WorkspaceIsolationAction): string | undefined {
  // BUG-ISO-01 (#591), BUG-ISO-02 (#611), and BUG-ISO-03 (#612) are fixed on dev — NO masks!
  // BUG-ISO-04 (PR #614, approved & waiting to merge onto dev): PUT /v1/rules & /v1/rules/decisions
  // accept foreign evaluateRoutes / unowned evaluateDomains; PATCH /v1/api-keys/{id} on all-addresses
  // keys accepts foreign addAddressIds; ended inboxes not excluded on key/webhook addressIds.
  if (a.op === "ProbeFields" && a.focus === "pr614-bug-iso-04") {
    return "BUG-ISO-04";
  }
  // Reviewer-noted nearby cases (own workspace only, nothing crosses between workspaces):
  // PUT /v1/rules/attachments and POST /v1/routing/routes accept a just-deleted own ephemeral inbox until GC cleanup.
  if (a.op === "ProbeFields" && a.focus === "nearby-own-ended") {
    return "NEARBY-OWN-ENDED";
  }
  return undefined;
}

export const workspaceIsolation = model<
  WorkspaceIsolationState,
  WorkspaceIsolationAction,
  WorkspaceIsolationObs,
  WorkspaceIsolationSnapshot
>({
  id: "workspace-isolation",
  description:
    "Workspace data isolation: nothing crosses between workspaces on any OpenAPI route, hidden /v1/support/* route, or MCP tool",
  maxSteps: 8,
  rounds: 2,
  bug: "canary_cross_workspace_leak",
  roundRoles: {
    ProbeGroup: "call",
    ProbeSupport: "call",
    ProbeMcp: "call",
    ProbeFields: "call",
    CheckAggregates: "read",
    DualMismatch: "call",
    ConcurrentDualSwitch: "sequential",
  },

  initial: (): WorkspaceIsolationState => ({ steps: 0, seenGroups: [] }),

  choices(s): Choice<WorkspaceIsolationAction>[] {
    const out: Choice<WorkspaceIsolationAction>[] = [];
    for (const group of ROUTE_GROUPS) {
      const weight = group === "other" ? 1 : s.seenGroups.includes(group) ? 1 : 3;
      for (const principal of OPENAPI_PRINCIPALS) {
        const target: WorkspaceSlot = principal === "dualB" ? "A" : "B";
        out.push(choice({ op: "ProbeGroup", group, principal, target }, weight));
        if (principal === "ownerA" || principal === "dualA" || principal === "keyA" || principal === "dualC") {
          out.push(choice({ op: "ProbeGroup", group, principal, target: "C" }, 1));
        }
      }
    }
    for (const principal of SUPPORT_PRINCIPALS) {
      for (const target of TARGETS) {
        if (principal === "supportA" && target === "A") continue;
        out.push(choice({ op: "ProbeSupport", principal, target }, 2));
      }
    }
    for (const principal of MCP_PRINCIPALS) {
      for (const chunk of MCP_CHUNKS) {
        out.push(choice({ op: "ProbeMcp", principal, chunk, target: "B" }, 2));
        if (principal === "mcpDual") out.push(choice({ op: "ProbeMcp", principal, chunk, target: "C" }, 1));
      }
    }
    for (const focus of FIELD_FOCUSES) {
      const w = focus === "pr614-bug-iso-04" || focus === "nearby-own-ended" ? 1 : 3;
      out.push(choice({ op: "ProbeFields", principal: "ownerA", target: "B", focus }, w));
      out.push(choice({ op: "ProbeFields", principal: "dualA", target: "B", focus }, w));
      if (focus === "body-writes" || focus === "query-reads") {
        out.push(choice({ op: "ProbeFields", principal: "dualB", target: "A", focus }, 2));
        out.push(choice({ op: "ProbeFields", principal: "keyA", target: "B", focus }, 2));
        out.push(choice({ op: "ProbeFields", principal: "ownerA", target: "C", focus }, 1));
      }
    }
    for (const principal of AGGREGATE_PRINCIPALS) {
      out.push(choice({ op: "CheckAggregates", principal }, 2));
    }
    out.push(
      choice({ op: "DualMismatch", header: "A", target: "B" }, 3),
      choice({ op: "DualMismatch", header: "B", target: "A" }, 3),
      choice({ op: "DualMismatch", header: "A", target: "C" }, 2),
      choice({ op: "DualMismatch", header: "C", target: "A" }, 2),
      choice({ op: "ConcurrentDualSwitch" }, 3),
    );
    return out;
  },

  step(s, a): Step<WorkspaceIsolationState, WorkspaceIsolationObs> {
    const next = structuredClone(s);
    next.steps += 1;
    if (a.op === "ProbeGroup" && !next.seenGroups.includes(a.group)) {
      next.seenGroups.push(a.group);
    }
    const expect = satisfies("no-cross-workspace-violation", summarizeViolations);
    const mask = maskFor(a);
    return mask ? { next, expect, mask } : { next, expect };
  },

  idle: isolationIdleRules,

  temporal: [
    {
      id: "wiso.never-leaked",
      title: "no response ever leaks another workspace's data",
      prop: prop.never(sel.event("isolation.leak")),
    },
    {
      id: "wiso.never-mutated-foreign",
      title: "no write ever mutates another workspace's state",
      prop: prop.never(sel.event("isolation.foreign_mutation")),
    },
    {
      id: "wiso.never-probed",
      title: "no route leaks existence of foreign resource IDs",
      prop: prop.never(sel.event("isolation.id_oracle")),
    },
  ],
});
