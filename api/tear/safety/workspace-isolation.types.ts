export type WorkspaceSlot = "A" | "B" | "C";

export type Principal =
  | "ownerA"
  | "adminA"
  | "memberA"
  | "dualA"
  | "dualB"
  | "dualC"
  | "keyA"
  | "dkeyA"
  | "mcpA"
  | "mcpDual"
  | "supportA"
  | "supportDualA"
  | "supportDualAB"
  | "anon";

export type OpenApiPrincipal =
  | "ownerA"
  | "adminA"
  | "memberA"
  | "dualA"
  | "dualB"
  | "dualC"
  | "keyA"
  | "dkeyA"
  | "anon";

export type SupportPrincipal =
  | "supportA"
  | "supportDualA"
  | "supportDualAB"
  | "ownerA"
  | "keyA"
  | "anon";

export type SupportScopeMode = "core" | "audience-health";

export type DualMismatchFocus = "core" | "campaign-audience" | "inbound-webhook-addresses";

export type McpPrincipal = "mcpA" | "mcpDual" | "keyA" | "dkeyA" | "anon";

export type McpChunk = "auth-ops" | "audience" | "sending" | "routing-inboxes" | "inbound";

export type AggregatePrincipal =
  | "ownerA"
  | "adminA"
  | "memberA"
  | "dualA"
  | "dualB"
  | "keyA"
  | "supportA";

export type RouteGroup =
  | "auth"
  | "audience"
  | "templates"
  | "emails"
  | "campaigns"
  | "domains"
  | "webhooks"
  | "ops"
  | "routing-rules"
  | "inboxes"
  | "inbound-mail"
  | "inbound-webhooks-write"
  | "inbound-config"
  | "workspaces"
  | "billing"
  | "other";

export type WorkspaceIsolationAction =
  | { op: "ProbeGroup"; group: RouteGroup; principal: OpenApiPrincipal; target: WorkspaceSlot }
  | { op: "ProbeSupport"; principal: SupportPrincipal; scope: SupportScopeMode; target: WorkspaceSlot }
  | { op: "ProbeMcp"; principal: McpPrincipal; chunk: McpChunk; target: WorkspaceSlot }
  | { op: "CheckAggregates"; principal: AggregatePrincipal }
  | { op: "DualMismatch"; header: WorkspaceSlot; target: WorkspaceSlot; focus: DualMismatchFocus }
  | { op: "ConcurrentDualSwitch" };

export interface WorkspaceIsolationObs {
  routesDriven: number;
  leaks: string[];
  foreignMutations: string[];
  probeOracles: string[];
  aggregateMismatches: string[];
  dualViolations: string[];
  unexpectedErrors: string[];
}

export interface WorkspaceIsolationSnapshot {
  totalRoutesDriven: number;
  uniqueOpenApiRoutesDriven: number;
  totalOpenApiRoutes: number;
  uniqueSupportRoutesDriven: number;
  uniqueMcpToolsDriven: number;
  leaks: string[];
  foreignMutations: string[];
  probeOracles: string[];
  aggregateMismatches: string[];
  dualViolations: string[];
  unexpectedErrors: string[];
  leakedErrors: string[];
}
