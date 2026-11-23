import { choice, exact, model, prop, sel, type Choice, type IdleRule, type Step } from "@tear/mbt";
import {
  findGrantShape,
  GRANT_SHAPES,
  restGetsMap,
  visibleMap,
  type AccessAction,
  type AccessObs,
  type AccessPreset,
  type AccessSnapshot,
  type BodyName,
  type CreateWhat,
  type CredName,
  type EvalActor,
  type GrantName,
  type IdemKeyName,
  type ProbeHow,
  type ProbeTarget,
  type SlotName,
} from "./access.types.ts";

const WINDOW = 600_000;
const TOKEN_TTL = 60_000;
const ACCESS_TTL_S = 300;

interface CredState {
  revoked: boolean;
  exp: number;
}

interface GrantState {
  revoked: boolean;
  at: number;
}

type Outcome = "pending" | "stored" | "withheld" | "unknown";

interface ResState {
  hash: string;
  outcome: Outcome;
  created: number;
}

type Checkpoint = "start" | "auth" | "claim" | "handler" | "record" | "release";

interface ReqState {
  what: CreateWhat;
  cred: CredName | "grant";
  key: IdemKeyName;
  body: BodyName;
  lost: boolean;
  at: Checkpoint;
  status: number | null;
  code: string | null;
  outcome: Outcome | null;
  hash: string | null;
  access: number | null;
}

export interface AccessState {
  configured: boolean;
  preset: AccessPreset | null;
  t: number;
  creds: Record<string, CredState>;
  grants: Record<string, GrantState>;
  member: "member" | "admin" | "removed";
  keyNarrowed: boolean;
  boxDeleted: boolean;
  res: Record<string, ResState>;
  ids: Record<string, boolean>;
  lists: number;
  keys: number;
  inboxes: number;
  slots: Record<string, ReqState>;
}

function accessExp(t: number): number {
  return (Math.floor(t / 1000) + ACCESS_TTL_S) * 1000;
}

function isMinted(s: AccessState, c: string): boolean {
  return c in s.creds;
}

function grantLive(s: AccessState, g: string): boolean {
  const gs = s.grants[g];
  if (!gs || gs.revoked) return false;
  const sh = findGrantShape(g);
  if (sh?.byMember && s.member === "removed") return false;
  return true;
}

function accessOk(s: AccessState, g: string): boolean {
  return grantLive(s, g) && s.t < s.grants[g]!.at;
}

function credLive(s: AccessState, c: string): boolean {
  const x = s.creds[c];
  if (!x || x.revoked) return false;
  switch (c) {
    case "gkey":
    case "gikey":
      return grantLive(s, "grant");
    case "token":
    case "token3":
      // Commit 516521cf: agent tokens authenticate via externalMcpGrant(..., 'request'), so they
      // stop working once the parent grant's newest 5-minute access token expires.
      return accessOk(s, "grant") && s.t < x.exp;
    case "bkey":
      return !s.boxDeleted;
    default:
      return true;
  }
}

function canUse(s: AccessState, c: string): boolean {
  return findGrantShape(c) ? c in s.grants : isMinted(s, c);
}

function evalActorFor(s: AccessState, who: ProbeTarget): EvalActor {
  const sh = findGrantShape(who);
  if (sh) {
    const member = sh.byMember && s.member === "member";
    return {
      kind: "mcp",
      read: sh.read,
      send: sh.send,
      manage: sh.manage && !member,
      member,
      receivingConsent: !member,
      domainLimited: false,
    };
  }
  switch (who) {
    case "ikey":
    case "gikey":
      return {
        kind: "inboxKey",
        read: false,
        send: false,
        manage: false,
        member: false,
        receivingConsent: false,
        domainLimited: false,
        inboxPerms: ["read", "create"],
      };
    case "bkey":
      return {
        kind: "inboxKey",
        read: false,
        send: false,
        manage: false,
        member: false,
        receivingConsent: false,
        domainLimited: false,
        inboxPerms: ["read"],
      };
    case "token":
    case "token3":
      return {
        kind: "agentToken",
        read: true,
        send: true,
        manage: true,
        member: false,
        receivingConsent: false,
        domainLimited: false,
      };
    case "dkey":
      return {
        kind: "apiKey",
        read: true,
        send: true,
        manage: true,
        member: false,
        receivingConsent: false,
        domainLimited: true,
      };
    default:
      // key, legacy, gkey: unrestricted workspace API keys with read, send, manage
      return {
        kind: "apiKey",
        read: true,
        send: true,
        manage: true,
        member: false,
        receivingConsent: false,
        domainLimited: false,
      };
  }
}

function identityOf(r: ReqState): string {
  return `${r.what}|${r.cred}|${r.key}`;
}

function hashOf(s: AccessState, r: ReqState): string {
  const body = r.what === "list" ? r.body : "fixed";
  // Mirrors api/src/idempotency.ts:174 — request hash covers body AND caller authority
  // (permissions, domain/inbox scope, and receivingConsent). I7: changing authority between
  // retries with the same Idempotency-Key produces 409 IDEMPOTENCY_CONFLICT.
  const actor = evalActorFor(s, r.cred);
  const perms =
    r.cred === "key"
      ? s.keyNarrowed
        ? "sm"
        : "rsm"
      : `${actor.read ? "r" : ""}${actor.send ? "s" : ""}${actor.manage ? "m" : ""}`;
  return `${body}|${perms}|${actor.domainLimited ? "dom" : "-"}|${actor.receivingConsent ? "receiving" : "-"}`;
}

function countFor(s: AccessState, what: CreateWhat): [string, number] {
  if (what === "list") return ["lists", s.lists];
  if (what === "apikey") return ["keys", s.keys];
  return ["inboxes", s.inboxes];
}

function finishReq(
  s: AccessState,
  r: ReqState,
  status: number | null,
  code: string | null,
  replay: boolean,
): AccessObs {
  const mcp = r.cred === "grant";
  const success = status !== null && status < 300;
  const id = identityOf(r);
  let same: boolean | null = null;
  if (success) {
    if (s.ids[id]) same = true;
    else s.ids[id] = true;
  }
  if (replay) same = true;
  const secret = success && !replay && r.what === "apikey";
  const [name, n] = countFor(s, r.what);
  return {
    status,
    code,
    replayed: mcp ? null : replay,
    same,
    secret,
    [name]: n,
  };
}

function keyValid(k: IdemKeyName): boolean {
  return k !== "klong" && k !== "kbad" && k !== "kempty";
}

function mcpAuthStatus(s: AccessState, g: string, tokenExp?: number): 200 | 401 | 403 {
  // Note (review-599 finding 9): revoked approvals with an unexpired JWT currently answer 403
  // (oidc-resource.ts:250, since d6355639/5975cc31) rather than RFC 6750 401; update here if changed.
  const exp = tokenExp ?? s.grants[g]!.at;
  if (s.t >= exp) return 401;
  if (!grantLive(s, g)) return 403;
  return 200;
}

function authOk(s: AccessState, r: ReqState): boolean {
  if (r.cred === "grant") {
    return mcpAuthStatus(s, "grant", r.access ?? undefined) === 200;
  }
  if (r.cred === "token" || r.cred === "token3") {
    // Token expiry was already verified at start (verifyAgentToken); DB auth checks !revoked and externalMcpGrant(..., 'request').
    const x = s.creds[r.cred];
    return !!x && !x.revoked && accessOk(s, "grant");
  }
  return credLive(s, r.cred);
}

function advanceReq(s: AccessState, r: ReqState): AccessObs | null {
  const mcp = r.cred === "grant";
  switch (r.at) {
    case "start": {
      if ((r.cred === "token" || r.cred === "token3") && s.creds[r.cred] && s.t >= s.creds[r.cred]!.exp) {
        return finishReq(s, r, 401, "AUTH_INVALID", false);
      }
      if (mcp) {
        if (s.t >= s.grants["grant"]!.at) {
          return finishReq(s, r, 401, null, false);
        }
        r.access = s.grants["grant"]!.at;
      }
      r.at = "auth";
      return null;
    }
    case "auth": {
      if (mcp) {
        const st = mcpAuthStatus(s, "grant", r.access ?? undefined);
        if (st !== 200) {
          // If the request started before JWT expiry (validateJwtAccessToken passed at start) and clock
          // later ticked past exp before mcpConnection ran, mcpConnection rejects with 403.
          const actualSt = r.access !== null && s.t >= r.access ? 403 : st;
          return finishReq(s, r, actualSt, null, false);
        }
      } else if (!authOk(s, r)) {
        return finishReq(s, r, 401, "AUTH_INVALID", false);
      }
      if (r.what === "list" && r.cred === "dkey") {
        return finishReq(s, r, 403, "UNRESTRICTED_KEY_REQUIRED", false);
      }
      if (!keyValid(r.key) || (mcp && r.body === "bad")) {
        return finishReq(s, r, mcp ? null : 422, mcp ? "INVALID_ARGUMENTS" : "INVALID_IDEMPOTENCY_KEY", false);
      }
      r.hash = hashOf(s, r);
      r.at = "claim";
      return null;
    }
    case "claim": {
      // Atomic idempotency_claim (migration 317 / commit 9d9ae337): claims if absent, else evaluates replay immediately.
      const id = identityOf(r);
      const existing = s.res[id];
      if (existing) {
        if (existing.hash !== r.hash) return finishReq(s, r, 409, "IDEMPOTENCY_CONFLICT", false);
        if (existing.outcome === "unknown") return finishReq(s, r, 409, "IDEMPOTENCY_OUTCOME_UNKNOWN", false);
        if (existing.outcome === "pending") {
          return finishReq(
            s,
            r,
            409,
            s.t - existing.created >= WINDOW ? "IDEMPOTENCY_OUTCOME_UNKNOWN" : "IDEMPOTENCY_IN_PROGRESS",
            false,
          );
        }
        if (existing.outcome === "withheld") return finishReq(s, r, 409, "IDEMPOTENT_SECRET_WITHHELD", false);
        return finishReq(s, r, 201, null, true);
      }
      s.res[id] = { hash: r.hash!, outcome: "pending", created: s.t };
      if (r.what === "list" && r.body === "bad") {
        r.status = 422;
        r.code = "VALIDATION_FAILED";
        r.at = "release";
        return null;
      }
      if (r.what === "apikey" && r.cred === "token") {
        r.status = 403;
        r.code = "CREDENTIAL_DELEGATION_FORBIDDEN";
        r.at = "release";
        return null;
      }
      r.at = "handler";
      return null;
    }
    case "handler": {
      // Commit 39338fb3: holdKeyAdmin re-checks externalMcpGrant(..., 'request') against clock_timestamp()
      // inside createApiKey's transaction, refusing both revoked and expired approvals with 401 -> release.
      if (r.what === "apikey" && r.cred === "grant" && !accessOk(s, "grant")) {
        r.status = 401;
        r.code = "AUTH_INVALID";
        r.at = "release";
        return null;
      }
      if (r.what === "list") s.lists += 1;
      else if (r.what === "apikey") s.keys += 1;
      else s.inboxes += 1;

      if (r.lost) {
        r.status = 503;
        r.code = "DATABASE_UNAVAILABLE";
        r.outcome = "unknown";
      } else {
        r.status = 201;
        r.code = null;
        r.outcome = r.what === "apikey" ? "withheld" : "stored";
      }
      r.at = "record";
      return null;
    }
    case "record": {
      const id = identityOf(r);
      if (s.res[id]) s.res[id]!.outcome = r.outcome!;
      return finishReq(s, r, r.status, r.code, false);
    }
    case "release": {
      delete s.res[identityOf(r)];
      return finishReq(s, r, r.status, r.code, false);
    }
  }
}

function focusedChoices(s: AccessState): Choice<AccessAction>[] {
  const race = s.preset === "race";
  const setup: ("key" | "grant" | "token")[] = race ? ["key"] : ["grant", "token"];
  for (const c of setup) {
    if (!canUse(s, c)) return [choice({ op: "Mint", target: c })];
  }
  const out: Choice<AccessAction>[] = [];
  const slots: SlotName[] = race ? ["A", "B"] : ["A"];
  for (const sl of slots) {
    if (s.slots[sl]) {
      out.push(choice({ op: "SlotStep", slot: sl }, 4));
      out.push(choice({ op: "SlotCrash", slot: sl }, 1));
    } else if (race) {
      for (const body of ["b1", "b2", "bad"] as const) {
        out.push(choice({ op: "SlotBegin", slot: sl, what: "list", cred: "key", key: "k1", body }, 2));
      }
      out.push(choice({ op: "SlotBegin", slot: sl, what: "list", cred: "key", key: "k1", body: "b1", lost: true }, 1));
    } else {
      out.push(choice({ op: "SlotBegin", slot: sl, what: "list", cred: "token", key: "k1", body: "b1" }, 2));
      if (s.t < s.grants["grant"]!.at) {
        out.push(choice({ op: "SlotBegin", slot: sl, what: "apikey", cred: "grant", key: "k1", body: "fixed" }, 2));
      }
    }
  }
  if (race) {
    out.push(choice({ op: "Create", what: "list", cred: "key", key: "k1", body: "b1" }, 2));
    const pendingTimes = Object.values(s.res)
      .filter((r) => r.outcome === "pending")
      .map((r) => r.created);
    if (pendingTimes.length) {
      const min = Math.min(...pendingTimes);
      for (const ms of [min + WINDOW - 1, min + WINDOW]) {
        if (ms > s.t) out.push(choice({ op: "Tick", ms }, 2));
      }
    }
  } else {
    out.push(
      choice({ op: "Revoke", target: "token" }, 2),
      choice({ op: "Revoke", target: "grant" }, 2),
      choice({ op: "Probe", who: "token", how: "rest" }, 2),
    );
  }
  return out;
}

function generalChoices(s: AccessState, full: boolean): Choice<AccessAction>[] {
  const out: Choice<AccessAction>[] = [];
  const add = (a: AccessAction, w = 1) => out.push(choice(a, w));

  for (const c of ["key", "dkey", "legacy"] as const) {
    if (!isMinted(s, c)) add({ op: "Mint", target: c }, 3);
    else {
      add({ op: "Revoke", target: c }, 1);
      add({ op: "Probe", who: c, how: "rest" }, 2);
    }
  }
  if (isMinted(s, "dkey")) add({ op: "Probe", who: "dkey", how: "lists" }, 2);
  if (isMinted(s, "key")) {
    if (credLive(s, "key") && !s.keyNarrowed) add({ op: "NarrowKey" }, 1);
    add({ op: "Probe", who: "key", how: "mcp" }, 2);
    if (full) add({ op: "Probe", who: "key", how: "audit" }, 1);
  }
  if (isMinted(s, "dkey") && full) {
    add({ op: "Probe", who: "dkey", how: "mcp" }, 1);
    add({ op: "Probe", who: "dkey", how: "audit" }, 1);
  }

  if (!("grant" in s.grants)) {
    add({ op: "Mint", target: "grant" }, 3);
  } else {
    add({ op: "Revoke", target: "grant" }, 1);
    add({ op: "Refresh", grant: "grant" }, 2);
    for (const how of ["code", "plain", "call", "delegate", "query"] as const) {
      add({ op: "Probe", who: "grant", how }, 2);
    }
    if (full) add({ op: "Probe", who: "grant", how: "audit" }, 1);
    for (const c of ["token", "token3", "gkey", "gikey"] as const) {
      if (!isMinted(s, c)) add({ op: "Mint", target: c }, 2);
    }
  }

  for (const c of ["token", "token3", "gkey"] as const) {
    if (isMinted(s, c)) {
      add({ op: "Revoke", target: c }, 1);
      add({ op: "Probe", who: c, how: "rest" }, 2);
    }
  }
  if (isMinted(s, "token")) {
    add({ op: "Probe", who: "token", how: "mcp" }, 2);
    if (full) add({ op: "Probe", who: "token", how: "audit" }, 1);
  }

  if (s.member !== "removed") {
    if (!("grant2" in s.grants)) add({ op: "Mint", target: "grant2" }, 2);
    add({ op: "RemoveMember" }, 1);
    if (s.member === "member") add({ op: "PromoteMember" }, 1);
  }
  if ("grant2" in s.grants) {
    add({ op: "Revoke", target: "grant2" }, 1);
    add({ op: "Refresh", grant: "grant2" }, 1);
    for (const how of ["code", "plain", "call", "delegate", "query"] as const) {
      add({ op: "Probe", who: "grant2", how }, 2);
    }
    if (full) add({ op: "Probe", who: "grant2", how: "audit" }, 1);
  }

  if (!("grant3" in s.grants)) {
    add({ op: "Mint", target: "grant3" }, 2);
  } else {
    add({ op: "Revoke", target: "grant3" }, 1);
    add({ op: "Refresh", grant: "grant3" }, 1);
    for (const how of ["code", "plain", "call", "delegate", "query"] as const) {
      add({ op: "Probe", who: "grant3", how }, 2);
    }
    if (full) add({ op: "Probe", who: "grant3", how: "audit" }, 1);
  }

  if (full) {
    for (const sh of GRANT_SHAPES.slice(3)) {
      if (!(sh.name in s.grants)) {
        if (!sh.byMember || s.member !== "removed") add({ op: "Mint", target: sh.name }, 2);
        continue;
      }
      add({ op: "Revoke", target: sh.name }, 1);
      add({ op: "Refresh", grant: sh.name }, 1);
      for (const how of ["code", "plain", "call", "delegate", "query", "audit"] as const) {
        add({ op: "Probe", who: sh.name, how }, 1);
      }
    }
  }

  if (isMinted(s, "key")) {
    if (!isMinted(s, "ikey")) add({ op: "Mint", target: "ikey" }, 2);
    if (!isMinted(s, "bkey")) add({ op: "Mint", target: "box" }, 2);
  }
  for (const c of ["ikey", "gikey"] as const) {
    if (isMinted(s, c)) {
      add({ op: "Revoke", target: c }, 1);
      add({ op: "Probe", who: c, how: "rest" }, 2);
      add({ op: "Probe", who: c, how: "mcp" }, 2);
      if (full) add({ op: "Probe", who: c, how: "audit" }, 1);
    }
  }
  if (isMinted(s, "bkey")) {
    add({ op: "DeleteBox" }, 1);
    add({ op: "Probe", who: "bkey", how: "rest" }, 2);
    add({ op: "Probe", who: "bkey", how: "mcp" }, 2);
    if (full) add({ op: "Probe", who: "bkey", how: "audit" }, 1);
  }

  const createCreds: (CredName | "grant")[] = full ? ["key", "grant", "token", "dkey", "legacy"] : ["key", "grant"];
  const keys: IdemKeyName[] = full ? ["k1", "k2", "kmax", "klong", "kbad", "kempty"] : ["k1", "k2"];
  for (const c of createCreds) {
    if (!canUse(s, c)) continue;
    for (const k of keys) {
      for (const b of ["b1", "b2", "bad"] as const) {
        if (!full && k === "k2" && b !== "b1") continue;
        add({ op: "Create", what: "list", cred: c, key: k, body: b }, 2);
      }
    }
  }
  if (!full && canUse(s, "key")) {
    for (const k of ["kmax", "klong", "kempty"] as const) {
      add({ op: "Create", what: "list", cred: "key", key: k, body: "b1" }, 1);
    }
  }
  for (const c of ["key", "grant", "token"] as const) {
    if (canUse(s, c)) add({ op: "Create", what: "apikey", cred: c, key: "k1", body: "fixed" }, 2);
  }
  for (const c of ["ikey", "key"] as const) {
    if (canUse(s, c)) add({ op: "Create", what: "inbox", cred: c, key: "k1", body: "fixed" }, 2);
  }
  for (const [what, c] of [
    ["list", "key"],
    ["list", "grant"],
    ["apikey", "key"],
    ["inbox", "ikey"],
  ] as const) {
    if (canUse(s, c) && (full || what !== "apikey")) {
      add({ op: "Create", what, cred: c, key: "k1", body: "b1", lost: true }, 1);
    }
  }

  for (const sl of ["A", "B"] as const) {
    if (s.slots[sl]) {
      add({ op: "SlotStep", slot: sl }, 4);
      add({ op: "SlotCrash", slot: sl }, 1);
    } else {
      if (canUse(s, "key")) {
        for (const body of ["b1", "b2", "bad"] as const) {
          add({ op: "SlotBegin", slot: sl, what: "list", cred: "key", key: "k1", body }, 1);
        }
        add({ op: "SlotBegin", slot: sl, what: "list", cred: "key", key: "k1", body: "b1", lost: true }, 1);
      }
      if (canUse(s, "grant") && s.t < s.grants["grant"]!.at) {
        add({ op: "SlotBegin", slot: sl, what: "list", cred: "grant", key: "k1", body: "b1" }, 1);
        add({ op: "SlotBegin", slot: sl, what: "apikey", cred: "grant", key: "k1", body: "fixed" }, 1);
      }
      if (canUse(s, "token")) {
        add({ op: "SlotBegin", slot: sl, what: "list", cred: "token", key: "k1", body: "b1" }, 1);
      }
      if (full && canUse(s, "ikey")) {
        add({ op: "SlotBegin", slot: sl, what: "inbox", cred: "ikey", key: "k1", body: "fixed" }, 1);
      }
    }
  }

  const ticks = new Set<number>();
  const pendingTimes = Object.values(s.res)
    .filter((r) => r.outcome === "pending")
    .map((r) => r.created);
  if (pendingTimes.length) {
    const min = Math.min(...pendingTimes);
    ticks.add(min + WINDOW - 1);
    ticks.add(min + WINDOW);
  }
  for (const c of ["token", "token3"]) {
    const x = s.creds[c];
    if (x) {
      ticks.add(x.exp - 1);
      ticks.add(x.exp);
    }
  }
  if (s.grants["grant"]) {
    ticks.add(s.grants["grant"]!.at - 1);
    ticks.add(s.grants["grant"]!.at);
  }
  for (const ms of [...ticks].sort((a, b) => a - b)) {
    if (ms > s.t) add({ op: "Tick", ms }, 1);
  }
  return out;
}

const accessIdleRules: IdleRule<AccessSnapshot>[] = [
  {
    id: "access.no-leaked-errors",
    description: "no unhandled rejections or exceptions in the host",
    when: (s) => s.configured,
    check: (s) => (s.leakedErrors.length ? s.leakedErrors.join("; ") : undefined),
  },
  {
    id: "access.no-secret-replay",
    description: "a secret-bearing create never returns a secret on any replay",
    when: (s) => s.configured,
    check: (s) => (s.secretReplays.length ? `secret leaked on replay: ${s.secretReplays.join(", ")}` : undefined),
  },
  {
    id: "access.no-duplicate-create",
    description: "replaying an idempotency key never returns a different created resource id",
    when: (s) => s.configured,
    check: (s) => (s.duplicateCreates.length ? `duplicate create: ${s.duplicateCreates.join(", ")}` : undefined),
  },
];

export const access = model<AccessState, AccessAction, AccessObs, AccessSnapshot>({
  id: "access",
  description: "Nightmail idempotency reservations, grant/key revocation, and MCP vs REST authorization parity",
  maxSteps: 24,
  bug: "canary_leak_secret",

  initial: (): AccessState => ({
    configured: false,
    preset: null,
    t: 0,
    creds: {},
    grants: {},
    member: "member",
    keyNarrowed: false,
    boxDeleted: false,
    res: {},
    ids: {},
    lists: 0,
    keys: 0,
    inboxes: 0,
    slots: {},
  }),

  choices(s): Choice<AccessAction>[] {
    if (!s.configured) {
      return [
        choice({ op: "Configure", preset: "core" }, 3),
        choice({ op: "Configure", preset: "full" }, 3),
        choice({ op: "Configure", preset: "race" }, 3),
        choice({ op: "Configure", preset: "revoke" }, 2),
      ];
    }
    if (s.preset === "race" || s.preset === "revoke") return focusedChoices(s);
    return generalChoices(s, s.preset === "full");
  },

  step(s, a): Step<AccessState, AccessObs> {
    if (a.op === "Configure") {
      return {
        next: { ...structuredClone(s), configured: true, preset: a.preset },
        expect: exact({ configured: true }),
      };
    }

    const next = structuredClone(s);
    let expected: AccessObs;

    switch (a.op) {
      case "Mint": {
        const c = a.target;
        const sh = findGrantShape(c);
        if (c === "key" || c === "dkey" || c === "legacy") {
          next.creds[c] = { revoked: false, exp: 0 };
          next.keys += 1;
          expected = { status: 201 };
        } else if (sh) {
          next.grants[c] = { revoked: false, at: accessExp(next.t) };
          expected = { status: "ok" };
        } else if (c === "token") {
          const st = mcpAuthStatus(next, "grant");
          if (st !== 200) {
            expected = { status: st, code: null };
          } else {
            next.creds[c] = { revoked: false, exp: next.t + TOKEN_TTL };
            expected = { status: 201, code: null };
          }
        } else if (c === "token3") {
          next.creds[c] = { revoked: false, exp: next.t + TOKEN_TTL };
          expected = { status: 201 };
        } else if (c === "gkey") {
          const st = mcpAuthStatus(next, "grant");
          if (st !== 200) {
            expected = { status: st, code: null };
          } else {
            next.creds[c] = { revoked: false, exp: 0 };
            next.keys += 1;
            expected = { status: 201, code: null };
          }
        } else if (c === "gikey") {
          const st = mcpAuthStatus(next, "grant");
          if (st !== 200) {
            expected = { status: st, code: null };
          } else {
            // Owner grants hold receivingConsent=true; limited address keys live in mailbox_keys, not api_keys.
            next.creds[c] = { revoked: false, exp: 0 };
            expected = { status: 201, code: null };
          }
        } else if (c === "ikey" || c === "box") {
          if (!credLive(next, "key")) {
            expected = { status: 401, code: "AUTH_INVALID" };
          } else if (c === "box") {
            next.inboxes += 1;
            next.creds["bkey"] = { revoked: false, exp: 0 };
            expected = { status: 201, code: null };
          } else {
            // Limited address keys live in mailbox_keys, not api_keys.
            next.creds["ikey"] = { revoked: false, exp: 0 };
            expected = { status: 201, code: null };
          }
        } else {
          throw new Error(`unknown mint target ${c}`);
        }
        break;
      }
      case "Revoke": {
        const c = a.target;
        if (findGrantShape(c)) {
          const sh = findGrantShape(c)!;
          const g = next.grants[c]!;
          let status: number;
          if (sh.byMember && next.member === "removed") {
            // Removed member's dashboard session is no longer in the workspace, so owner tries revoking
            // member's agent tokens (404 if none exist).
            status = 404;
          } else {
            // Note (review-599 finding 9): revokeApproval (mcp-auth.ts:41-49) updates without AND NOT revoked,
            // returning 200 on repeat (and writing an audit row). Update here if contract changes to 404.
            status = 200;
            g.revoked = true;
            if (c === "grant") {
              for (const d of ["token", "token3", "gkey", "gikey"]) {
                if (next.creds[d]) next.creds[d]!.revoked = true;
              }
            }
          }
          expected = { status };
        } else {
          const x = next.creds[c]!;
          const isApiKey = ["key", "dkey", "legacy", "gkey", "ikey", "gikey"].includes(c);
          const status = x.revoked && !isApiKey ? 404 : 200;
          x.revoked = true;
          expected = { status };
        }
        break;
      }
      case "DeleteBox": {
        const status = next.boxDeleted ? 404 : 202;
        next.boxDeleted = true;
        expected = { status };
        break;
      }
      case "Refresh": {
        if (grantLive(next, a.grant)) {
          next.grants[a.grant]!.at = accessExp(next.t);
          expected = { status: "ok" };
        } else {
          expected = { status: "denied" };
        }
        break;
      }
      case "RemoveMember":
        next.member = "removed";
        expected = { status: 200 };
        break;
      case "PromoteMember":
        next.member = "admin";
        expected = { status: 200 };
        break;
      case "NarrowKey":
        next.keyNarrowed = true;
        expected = { status: 200 };
        break;
      case "Tick":
        next.t = a.ms;
        expected = {};
        break;
      case "Probe": {
        const { who, how } = a;
        const sh = findGrantShape(who);
        if (sh) {
          const actor = evalActorFor(next, who);
          const st = mcpAuthStatus(next, who);
          if (how === "call" || how === "delegate" || how === "query") {
            const op = how === "call" ? "getCurrentIdentity" : how === "delegate" ? "createAgentToken" : "queryAudience";
            const okStatus = how === "delegate" ? 201 : 200;
            if (st !== 200) {
              expected = { status: st, code: null };
            } else if (visibleMap(actor)[op]) {
              expected = { status: okStatus, code: null };
            } else {
              expected = { status: null, code: "TOOL_UNAVAILABLE" };
            }
          } else if (how === "audit") {
            expected = accessOk(next, who) ? { status: 200, rest: restGetsMap(actor) } : { status: 401 };
          } else {
            // code or plain
            expected = st === 200 ? { status: 200, visible: visibleMap(actor) } : { status: st };
          }
        } else {
          const actor = evalActorFor(next, who);
          if (how === "audit") {
            expected = credLive(next, who) ? { status: 200, rest: restGetsMap(actor) } : { status: 401 };
          } else if (how === "mcp") {
            // Commit 6ecf1076: /mcp accepts workspace API keys, agent tokens, and inbox keys.
            // Open product bug BUG-ACCESS-01 (plans/tear/bugs.md): /mcp advertises these exact 9
            // workspace-only template/attachment write tools to domain-limited keys (dkey) even though
            // REST refuses them with 403. Listed explicitly with NO mask so all other 234 operations
            // stay strictly checked in every run, and fixing BUG-ACCESS-01 fails loudly to remove this list.
            const BUG_ACCESS_01_EXTRA = [
              "createCampaignTemplate",
              "updateCampaignTemplate",
              "publishCampaignTemplate",
              "setCampaignTemplateArchived",
              "deleteCampaignTemplate",
              "uploadTemplateAsset",
              "importTemplateImage",
              "deleteTemplateAsset",
              "deleteAttachment",
            ];
            if (credLive(next, who)) {
              const vis = visibleMap(actor);
              if (who === "dkey") {
                for (const name of BUG_ACCESS_01_EXTRA) vis[name] = true;
              }
              expected = { status: 200, visible: vis };
            } else {
              expected = { status: 401 };
            }
          } else if (who === "dkey" && how === "lists") {
            expected = credLive(next, who)
              ? { status: 403, code: "UNRESTRICTED_KEY_REQUIRED" }
              : { status: 401, code: "AUTH_INVALID" };
          } else {
            expected = { status: credLive(next, who) ? 200 : 401 };
          }
        }
        break;
      }
      case "Create": {
        const req: ReqState = {
          what: a.what,
          cred: a.cred,
          key: a.key,
          body: a.body,
          lost: !!a.lost,
          at: "start",
          status: null,
          code: null,
          outcome: null,
          hash: null,
          access: null,
        };
        let done: AccessObs | null = null;
        while (done === null) done = advanceReq(next, req);
        expected = done;
        break;
      }
      case "SlotBegin": {
        const req: ReqState = {
          what: a.what,
          cred: a.cred,
          key: a.key,
          body: a.body,
          lost: !!a.lost,
          at: "start",
          status: null,
          code: null,
          outcome: null,
          hash: null,
          access: null,
        };
        const done = advanceReq(next, req);
        if (done !== null) {
          expected = { ...done, at: "done" };
        } else {
          next.slots[a.slot] = req;
          expected = { at: req.at };
        }
        break;
      }
      case "SlotStep": {
        const req = next.slots[a.slot]!;
        delete next.slots[a.slot];
        const done = advanceReq(next, req);
        if (done !== null) {
          expected = { ...done, at: "done" };
        } else {
          next.slots[a.slot] = req;
          expected = { at: req.at };
        }
        break;
      }
      case "SlotCrash": {
        delete next.slots[a.slot];
        expected = { crashed: true };
        break;
      }
    }

    return { next, expect: exact(expected) };
  },

  idle: accessIdleRules,

  temporal: [
    {
      id: "access.no-secret-replay",
      title: "a secret-bearing create never returns a secret again under the same idempotency key",
      prop: prop.optional(
        prop.forEach(
          { name: "idem", discover: sel.event("apikey.created"), key: "/idem" },
          (idem) => [prop.never(sel.event("apikey.secret_returned", { "/idem": idem }))],
        ),
      ),
    },
  ],
});
