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

export type FieldProbeFocus =
  | "body-writes"
  | "query-reads"
  | "pr614-bug-iso-04"
  | "nearby-foreign-ended"
  | "nearby-own-ended";

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
  | "inbound-config"
  | "workspaces"
  | "billing"
  | "other";

export type WorkspaceIsolationAction =
  | { op: "ProbeGroup"; group: RouteGroup; principal: OpenApiPrincipal; target: WorkspaceSlot }
  | { op: "ProbeSupport"; principal: SupportPrincipal; target: WorkspaceSlot }
  | { op: "ProbeMcp"; principal: McpPrincipal; chunk: McpChunk; target: WorkspaceSlot }
  | { op: "ProbeFields"; principal: "ownerA" | "dualA" | "dualB" | "keyA"; target: WorkspaceSlot; focus: FieldProbeFocus }
  | { op: "CheckAggregates"; principal: AggregatePrincipal }
  | { op: "DualMismatch"; header: WorkspaceSlot; target: WorkspaceSlot }
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
