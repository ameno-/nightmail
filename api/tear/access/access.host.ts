import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import type { PoolClient } from "pg";
import { host, type HostEvent, type Observed } from "@tear/mbt";
import { access } from "./access.model.ts";
import type { AccessAction, AccessObs, AccessSnapshot } from "./access.types.ts";

// ---------- frozen clock (before any app module loads) ----------
const RealDate: DateConstructor = Date;
let clock = Math.floor(RealDate.now() / 1000) * 1000;
const at = (ms: number) => new RealDate(ms);
class FrozenDate extends (RealDate as new (...args: unknown[]) => Date) {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(clock);
    else super(...args);
  }
  static override now() {
    return clock;
  }
}
globalThis.Date = FrozenDate as DateConstructor;

// Silence routine app logs unless TEAR_HOST_LOG=1; keep console.error visible.
for (const level of ["log", "info", "warn", "debug"] as const) {
  console[level] =
    process.env.TEAR_HOST_LOG === "1"
      ? (...a: unknown[]) => process.stderr.write(a.map(String).join(" ") + "\n")
      : () => {};
}

const leaked: string[] = [];
process.on("unhandledRejection", (error) => {
  const msg = error instanceof Error ? error.message : String(error);
  leaked.push(`unhandled-rejection:${msg.slice(0, 120)}`);
});

const { disposableUrl, assertDisposable } = await import("../disposable.ts");
const url = disposableUrl(process.env.TEAR_DATABASE_URL ?? process.env.DATABASE_URL, "TEAR_DATABASE_URL");

const PUBLIC = "http://127.0.0.1:8799";
const fixtureIssuer = "https://tear-issuer.invalid";
const signer = generateKeyPairSync("ec", { namedCurve: "P-256" });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = new URL(input instanceof Request ? input.url : String(input));
  if (u.origin !== fixtureIssuer) return originalFetch(input, init);
  if (u.pathname === "/.well-known/openid-configuration") {
    return Response.json({ issuer: fixtureIssuer, jwks_uri: fixtureIssuer + "/keys" });
  }
  if (u.pathname === "/keys") {
    return Response.json({ keys: [{ ...signer.publicKey.export({ format: "jwk" }), alg: "ES256", kid: "tear" }] });
  }
  return new Response(null, { status: 404 });
};

const env: Record<string, string> = {
  DATABASE_URL: url,
  BANE_ROOT_SECRET: process.env.BANE_ROOT_SECRET ?? "bane-tear: fixed secret for disposable test databases only",
  PUBLIC_URL: PUBLIC,
  API_BASE_URL: PUBLIC,
  MULTI_TENANT: "true",
  ACCOUNT_REQUIRED_ACR: "urn:anomaly:acr:google",
  ACCOUNT_ISSUER: fixtureIssuer,
  ACCOUNT_CLIENT_ID: "tear",
  ACCOUNT_CLIENT_PRIVATE_KEY: "unused-by-session-fixture",
  ENABLE_LIVE_SES: "false",
  AWS_EC2_METADATA_DISABLED: "true",
  S3_BUCKET: "tear-fixture",
  S3_ACCESS_KEY_ID: "tear",
  S3_SECRET_ACCESS_KEY: "tear",
  S3_ENDPOINT: "http://127.0.0.1:9",
  API_RATE_LIMIT_PER_MINUTE: "100000",
  DEFAULT_SES_REGION: "us-east-1",
  SIMULATED_SES_LATENCY_MS: "0",
  SIMULATED_SES_DELIVERY_DELAY_MS: "0",
};

const pg = (await import("pg")).default;
const { drizzle } = await import("drizzle-orm/node-postgres");
const { createApp, createOpenApiApp } = await import("../../src/app.ts");
const { loadConfig } = await import("../../src/config.ts");
const { s3Storage } = await import("../../src/adapters/storage.ts");
const { resourceInventory } = await import("../../src/mcp-resources.ts");
const { buildMcpCatalog } = await import("../../src/mcp-catalog.ts");
const { dispatchAsActor } = await import("../../src/auth.ts");
const { getMcpGrantActor } = await import("../../src/mcp-auth.ts");

// ---------- gated pool ----------
type Label = "auth" | "claim" | "handler" | "record" | "release";
type SlotEvent = { at: Label } | { done: true };
type Slot = {
  name: string;
  gating: boolean;
  fault: "lost" | null;
  crashed: boolean;
  first: boolean;
  claimed: boolean;
  handler: boolean;
  lostArmed: boolean;
  pending: (() => void) | null;
  at: Label | null;
  next: ((e: SlotEvent) => void) | null;
  clients: Set<PoolClient>;
  result: Promise<AccessObs> | null;
  obs: AccessObs | null;
};

const als = new AsyncLocalStorage<Slot>();
const hang = () => new Promise<never>(() => {});
const textOf = (q: unknown) => (typeof q === "string" ? q : (q as { text?: string })?.text ?? "");

function classify(text: string): Label | null {
  const t = text.trimStart().toLowerCase();
  if (t.includes("idempotency_claim(")) return "claim";
  if (t.startsWith("update sending_idempotency") || t.startsWith('update "sending_idempotency"')) return "record";
  if (t.startsWith("delete from sending_idempotency") || t.startsWith('delete from "sending_idempotency"')) return "release";
  return null;
}

const traceSql = process.env.TEAR_HOST_SQL === "1";

async function checkpoint(slot: Slot, label: Label) {
  if (slot.crashed) return hang();
  if (!slot.gating) return;
  await new Promise<void>((resolve) => {
    slot.pending = resolve;
    slot.at = label;
    const n = slot.next;
    slot.next = null;
    n?.({ at: label });
  });
  if (slot.crashed) return hang();
}

function labelFor(slot: Slot, text: string): Label | null {
  const kind = classify(text);
  if (!slot.first) {
    slot.first = true;
    return "auth";
  }
  if (kind === "claim") {
    slot.claimed = true;
    return "claim";
  }
  if (kind) return kind;
  if (slot.claimed && !slot.handler) {
    slot.handler = true;
    if (slot.fault === "lost") slot.lostArmed = true;
    return "handler";
  }
  return null;
}

const lostError = () => Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });

class GatedPool extends pg.Pool {
  override query(...args: any[]): any {
    const slot = als.getStore();
    if (!slot || typeof args.at(-1) === "function") return (super.query as any)(...args);
    const text = textOf(args[0]);
    return (async () => {
      if (slot.crashed) return hang();
      const label = labelFor(slot, text);
      if (traceSql) process.stderr.write(`[${slot.name}] ${label ?? "-"} ${text.slice(0, 120).replace(/\s+/g, " ")}\n`);
      if (label) await checkpoint(slot, label);
      const result = await (super.query as any)(...args);
      if (label === "claim" && result.rows?.[0]?.state === null) await stampClaim(args);
      if (slot.lostArmed && label === "handler") {
        slot.lostArmed = false;
        throw lostError();
      }
      return result;
    })();
  }
  override connect(...args: any[]): any {
    if (typeof args[0] === "function") return (super.connect as any)(...args);
    const slot = als.getStore();
    return (super.connect() as Promise<PoolClient>).then((client) => {
      const c = client as PoolClient & { __tear?: true };
      if (!c.__tear) {
        c.__tear = true;
        const query = c.query.bind(c);
        const release = c.release.bind(c);
        (c as any).query = (...q: any[]) => {
          const s = als.getStore();
          if (!s || typeof q.at(-1) === "function") return (query as any)(...q);
          const text = textOf(q[0]);
          return (async () => {
            if (s.crashed) return hang();
            if (traceSql) process.stderr.write(`[${s.name}] tx ${text.slice(0, 120).replace(/\s+/g, " ")}\n`);
            if (/^\s*begin\b/i.test(text)) {
              const label = labelFor(s, text);
              if (label) await checkpoint(s, label);
            }
            const result = await (query as any)(...q);
            if (s.lostArmed && /^\s*commit\b/i.test(text)) {
              s.lostArmed = false;
              throw lostError();
            }
            return result;
          })();
        };
        (c as any).release = (err?: unknown) => {
          als.getStore()?.clients.delete(c);
          return release(err as Error);
        };
      }
      slot?.clients.add(c);
      return c;
    });
  }
}

const withClock = `${url}?options=${encodeURIComponent("-c search_path=tear_clock,pg_catalog,public")}`;
const admin = new pg.Pool({ connectionString: url, max: 4 });
await assertDisposable((text) => admin.query(text));
await admin.query(`
  CREATE SCHEMA IF NOT EXISTS tear_clock;
  DROP TABLE IF EXISTS tear_clock.state;
  CREATE TABLE tear_clock.state(singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), ts timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp());
  INSERT INTO tear_clock.state DEFAULT VALUES ON CONFLICT DO NOTHING;
  CREATE OR REPLACE FUNCTION tear_clock.clock_timestamp() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT ts FROM tear_clock.state $$;
  CREATE OR REPLACE FUNCTION tear_clock.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT ts FROM tear_clock.state $$;
  CREATE OR REPLACE FUNCTION tear_clock.statement_timestamp() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT ts FROM tear_clock.state $$;
`);
async function freezeClock(ms: number) {
  clock = ms;
  await admin.query("UPDATE tear_clock.state SET ts = to_timestamp($1::float8 / 1000.0)", [clock]);
}
const pool = new GatedPool({ connectionString: withClock, max: 20, idleTimeoutMillis: 30000 });
pool.on("error", () => {});

async function stampClaim(args: any[]) {
  const values = (args[0]?.values ?? args[1]) as unknown[] | undefined;
  if (!values || values.length < 4) return;
  const [workspace, actor, path, key] = values;
  await admin.query(
    "UPDATE sending_idempotency SET created_at=to_timestamp($5::float8/1000) WHERE workspace_id=$1 AND actor_key_id=$2 AND path=$3 AND request_key=$4 AND result IS NULL",
    [workspace, actor, path, key, clock],
  );
}

const config = loadConfig(env);
const objects = new Map<string, Uint8Array>();
const bucket = {
  async put(key: string, value: ArrayBuffer | Uint8Array | string) {
    objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value as ArrayBuffer));
    return { key };
  },
  async get(key: string) {
    const v = objects.get(key);
    return v
      ? {
          body: new Blob([new Uint8Array(v)]).stream(),
          size: v.byteLength,
          async arrayBuffer() {
            return new Uint8Array(v).buffer;
          },
        }
      : null;
  },
  async head(key: string) {
    const v = objects.get(key);
    return v ? { key, size: v.byteLength } : null;
  },
  async delete(keys: string | string[]) {
    for (const k of [keys].flat()) objects.delete(k);
  },
  async list() {
    return { objects: [...objects.keys()].map((key) => ({ key })), truncated: false };
  },
};
const runtime: any = {
  db: drizzle(pool),
  storage: s3Storage(env),
  config,
  mailR2: { bucket, name: "tear-mail", write: true },
  webhookFetch: async () => {
    throw new Error("tear: no network");
  },
};
const app = createApp();
const INVENTORY = new Map(resourceInventory().map((x) => [`${x.name}.${x.action}`, x.operation]));

const GETS = [...buildMcpCatalog(await createOpenApiApp()).entries()]
  .filter(([, op]) => op.method === "get")
  .map(([name, op]) => {
    const params = (op.tool.inputSchema.properties ?? {}) as Record<
      string,
      { enum?: string[]; format?: string; type?: string | string[]; pattern?: string }
    >;
    const value = (field: string) => {
      const p = params[field] ?? {};
      return (
        p.enum?.[0] ??
        (p.format === "email"
          ? "tear@example.com"
          : [p.type].flat().includes("integer")
            ? "1"
            : p.pattern?.includes("-\\d")
              ? "us-east-1"
              : "tear-missing")
      );
    };
    const aliases: Record<string, string> = {
      connectionId: "id", tokenId: "id", keyId: "id", contactId: "id", listId: "id",
      segmentId: "id", importId: "id", templateId: "id", assetId: "id", emailId: "id",
      attachmentId: "id", campaignId: "id", domainId: "id", webhookId: "id",
      routeId: "id", inboxId: "id", version: "v", newsletterId: "id", paymentId: "id",
    };
    const path = op.path.replace(/\{([^}]+)\}/g, (_, field: string) => {
      const mcp = Object.entries(aliases).find(([m, api]) => api === field && params[m])?.[0] ?? field;
      return encodeURIComponent(value(mcp));
    });
    return { name, path: op.path === "/v1/inboxes/{id}/changes" ? `${path}?since=0` : path };
  });

// ---------- fixture ----------
type User = { id: string; cookie: string; memberId: string };
type Cred = { id: string; secret: string };
type Grant = { access: string; clientId: string; consentId: string; keyId: string; scope: string; user: User };
interface Fixture {
  configured: boolean;
  bug?: string;
  w: string;
  owner: User;
  member: User;
  creds: Map<string, Cred>;
  slots: Record<string, Slot>;
  firstIds: Map<string, string>;
  box?: string;
  grants: Map<string, Grant>;
  start: number;
  leakedErrors: string[];
  secretReplays: string[];
  duplicateCreates: string[];
  pendingEvents: HostEvent[];
}

const SHAPES: Record<string, ["owner" | "member", string]> = {
  grant: ["owner", "nightmail:read nightmail:send nightmail:manage"],
  grant2: ["member", "nightmail:read nightmail:send"],
  grant3: ["owner", "nightmail:read"],
  "g-s": ["owner", "nightmail:send"],
  "g-m": ["owner", "nightmail:manage"],
  "g-rm": ["owner", "nightmail:read nightmail:manage"],
  "g-sm": ["owner", "nightmail:send nightmail:manage"],
  "m-r": ["member", "nightmail:read"],
  "m-s": ["member", "nightmail:send"],
};

async function seedUser(w: string, role: "owner" | "member"): Promise<User> {
  const id = `tear-user-${randomUUID()}`;
  const token = randomBytes(32).toString("base64url");
  const memberId = randomUUID();
  const email = `${id}@example.com`;
  await admin.query(`INSERT INTO nightmail_users (id,name,email,email_verified) VALUES ($1,'tear',$2,true)`, [id, email]);
  await admin.query(`INSERT INTO nightmail_oidc_identities VALUES ($1,$2,$2)`, [fixtureIssuer, id]);
  await admin.query(
    `INSERT INTO nightmail_sessions(token_hash,user_id,issuer,subject,expires_at) VALUES ($1,$2,$3,$2,$4)`,
    [createHash("sha256").update(token).digest("hex"), id, fixtureIssuer, at(clock + 7 * 86_400_000)],
  );
  await admin.query(`INSERT INTO workspace_members (id,workspace_id,user_id,role) VALUES ($1,$2,$3,$4)`, [memberId, w, id, role]);
  return { id, memberId, cookie: `bane.session_token=${token}` };
}

type Reply = { status: number; body: any; headers: Headers };

function newSlot(name: string, gating: boolean, fault: Slot["fault"] = null): Slot {
  return {
    name, gating, fault, crashed: false, first: false, claimed: false, handler: false,
    lostArmed: false, pending: null, at: null, next: null, clients: new Set(), result: null, obs: null,
  };
}

function crashSlot(slot: Slot) {
  slot.crashed = true;
  for (const c of slot.clients) {
    try {
      c.release(new Error("tear: crashed slot"));
    } catch {
      // already gone
    }
  }
  slot.clients.clear();
  slot.pending?.();
}

async function sendReq(
  f: Fixture,
  slot: Slot | null,
  method: string,
  path: string,
  auth: { cookie?: string; bearer?: string },
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const h = new Headers({ ...headers });
  if (auth.cookie) {
    h.set("cookie", auth.cookie);
    h.set("origin", PUBLIC);
    h.set("x-bane-workspace", f.w);
  }
  if (auth.bearer) h.set("authorization", `Bearer ${auth.bearer}`);
  if (body !== undefined && !h.has("content-type")) h.set("content-type", "application/json");
  const request = new Request(PUBLIC + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    redirect: "manual",
  });
  const run = async () => {
    const r = await app.fetch(request, slot ? { ...runtime, jwksCacheScope: {} } : runtime);
    const text = await r.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // HTML
    }
    return { status: r.status, body: parsed, headers: r.headers };
  };
  return slot ? als.run(slot, run) : run();
}

const ownerAuth = (f: Fixture) => ({ cookie: f.owner.cookie });

async function rpc(f: Fixture, bearer: string, method: string, params: object, codemode: boolean, slot: Slot | null = null): Promise<Reply> {
  // Plain /mcp (no ?codemode= query) lists grouped resource tools; ?codemode=true lists per-operation tools (mcp.ts:179).
  const path = codemode ? "/mcp?codemode=true" : "/mcp";
  return sendReq(
    f,
    slot,
    "POST",
    path,
    { bearer },
    { jsonrpc: "2.0", id: 1, method, params },
    { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
  );
}

function toolObs(r: Reply) {
  if (r.status !== 200 || r.body?.error) return { status: r.status === 200 ? 500 : r.status, code: null, mcp: true };
  const res = r.body.result;
  return {
    status: res?._meta?.status ?? null,
    code: res?.isError ? res.structuredContent?.error?.code ?? "MCP_ERROR" : null,
    body: res?.structuredContent,
    mcp: true,
  };
}

async function callTool(f: Fixture, g: string, name: string, args: object, slot: Slot | null = null) {
  const grant = f.grants.get(g)!;
  return toolObs(await rpc(f, grant.access, "tools/call", { name, arguments: args }, true, slot));
}

async function mintGrant(f: Fixture, name: string, user: User, scope: string, existingClientId?: string) {
  const jti = randomUUID();
  const clientId = existingClientId ?? "tear-" + randomUUID();
  const now = Math.floor(clock / 1000);
  const claims = {
    iss: fixtureIssuer,
    sub: user.id,
    aud: PUBLIC + "/mcp",
    client_id: clientId,
    scope,
    acr: "urn:anomaly:acr:google",
    jti,
    iat: now,
    exp: now + 300,
  };
  const body = [{ alg: "ES256", typ: "at+jwt", kid: "tear" }, claims]
    .map((p) => Buffer.from(JSON.stringify(p)).toString("base64url"))
    .join(".");
  const access =
    body +
    "." +
    Buffer.from(sign("sha256", Buffer.from(body), { key: signer.privateKey, dsaEncoding: "ieee-p1363" })).toString("base64url");
  const consentId = "at_" + createHash("sha256").update(JSON.stringify([user.id, clientId])).digest("hex");
  const result = await rpc(f, access, "tools/list", {}, true);
  if (result.status !== 200) return { status: result.status };
  f.grants.set(name, { access, clientId, consentId, keyId: "mcp_" + consentId, scope, user });
  return { status: "ok" };
}

async function refreshGrant(f: Fixture, name: string) {
  const g = f.grants.get(name)!;
  const active = await admin.query(
    "SELECT 1 FROM nightmail_resource_grants g JOIN workspace_members m ON m.workspace_id=$2 AND m.user_id=g.user_id WHERE g.id=$1 AND NOT g.revoked",
    [g.keyId, f.w],
  );
  if (!active.rowCount) return { status: "denied" };
  return mintGrant(f, name, g.user, g.scope, g.clientId);
}

async function legacyToken(f: Fixture, grant: Grant) {
  const id = `agt_${randomBytes(16).toString("hex")}`;
  const exp = clock + 60_000;
  const permissions = ["read", "send", "manage"];
  await admin.query(
    "INSERT INTO agent_tokens (id,workspace_id,grant_id,permissions,domains,purpose,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [id, f.w, grant.keyId, JSON.stringify(permissions), "[]", "tear legacy", at(exp).toISOString()],
  );
  const payload = Buffer.from(
    JSON.stringify({ v: 3, id, grant: grant.keyId, permissions, domains: [], exp, nonce: randomBytes(16).toString("hex") }),
  ).toString("base64url");
  const signature = createHmac("sha256", env.BANE_ROOT_SECRET!)
    .update(`opensend-agent-token-v1:${payload}`)
    .digest("base64url");
  return { id, secret: `os_agent_${payload}.${signature}` };
}

async function legacyKey(f: Fixture) {
  const secret = `os_live_${randomBytes(32).toString("hex")}`;
  const id = `key_${randomBytes(12).toString("hex")}`;
  await admin.query(
    `INSERT INTO api_keys (id,workspace_id,name,permissions,domains,hash,prefix) VALUES ($1,$2,'tear legacy',$3,'[]',$4,$5)`,
    [id, f.w, JSON.stringify(["read", "send", "manage"]), createHash("sha256").update(secret).digest("hex"), secret.slice(0, 14)],
  );
  return { id, secret };
}

async function counts(f: Fixture) {
  const {
    rows: [r],
  } = await admin.query(
    `SELECT (SELECT count(*)::int FROM audience_lists WHERE workspace_id=$1) AS lists, (SELECT count(*)::int FROM api_keys WHERE workspace_id=$1) AS keys, (SELECT count(*)::int FROM mailboxes WHERE workspace_id=$1 AND kind='inbox') AS inboxes`,
    [f.w],
  );
  return r as { lists: number; keys: number; inboxes: number };
}

const SECRET = /(?:nm|bane|os)_(?:live_|mbx_|agent_)?[0-9a-f]{20,}|whsec_|Bearer (?:nm|bane)/;
const KEYS: Record<string, string> = {
  k1: "tear-key-1",
  k2: "tear-key-2",
  kmax: "k".repeat(200),
  klong: "k".repeat(201),
  kbad: "tear key",
  kempty: "",
};
const BODIES: Record<string, unknown> = {
  b1: { name: "tear list one" },
  b2: { name: "tear list two" },
  bad: { name: "" },
};

function bearerOf(f: Fixture, name: string) {
  const c = f.creds.get(name);
  if (!c) throw new Error(`credential ${name} was not minted`);
  return c.secret;
}

function createObs(f: Fixture, r: Reply, idem: string, what: string, mcp = false) {
  const body = r.body;
  const id = typeof body?.id === "string" ? body.id : null;
  let same: boolean | null = null;
  const hadFirst = f.firstIds.has(idem);
  if (id && r.status < 300) {
    const first = f.firstIds.get(idem);
    if (first) {
      same = first === id;
      if (!same) f.duplicateCreates.push(`${idem}: ${first} vs ${id}`);
    } else {
      f.firstIds.set(idem, id);
    }
  }
  const hasSecret = SECRET.test(JSON.stringify(body ?? null));
  const replayed = mcp ? null : r.headers?.get("idempotent-replayed") === "true";
  if (what === "apikey") {
    if (!hadFirst && r.status < 300 && hasSecret) {
      f.pendingEvents.push({ name: "apikey.created", data: { idem } });
    } else if (hadFirst && hasSecret) {
      f.secretReplays.push(idem);
      f.pendingEvents.push({ name: "apikey.secret_returned", data: { idem } });
    }
    if (f.bug === "canary_leak_secret" && hadFirst && r.status === 409) {
      f.pendingEvents.push({ name: "apikey.secret_returned", data: { idem } });
    }
  }
  return {
    status: r.status,
    code: r.status >= 400 ? body?.error?.code ?? null : null,
    replayed,
    same,
    secret: hasSecret,
  };
}

async function runCreate(f: Fixture, slot: Slot | null, what: string, cred: string, key: string, bodyName: string): Promise<AccessObs> {
  const idem = `${what}|${cred}|${key}`;
  const k = KEYS[key]!;
  const headers = { "idempotency-key": k };
  const callToolObs = async (g: string, name: string, args: object) => {
    const o = await callTool(f, g, name, args, slot);
    const r = { status: o.status ?? 0, body: o.body ?? { error: { code: o.code } }, headers: new Headers() } as Reply;
    const base = createObs(f, r, idem, what, true);
    return { ...base, status: o.status, code: o.code };
  };
  if (what === "list") {
    const body = BODIES[bodyName];
    if (cred === "grant") {
      return { ...(await callToolObs("grant", "createContactList", { confirm: true, idempotencyKey: k, body })), lists: (await counts(f)).lists };
    }
    const r = await sendReq(f, slot, "POST", "/v1/lists", { bearer: bearerOf(f, cred) }, body, headers);
    return { ...createObs(f, r, idem, what), lists: (await counts(f)).lists };
  }
  if (what === "apikey") {
    const body = { name: "tear derived", permissions: ["read"] };
    if (cred === "grant") {
      return { ...(await callToolObs("grant", "createApiKey", { confirm: true, idempotencyKey: k, body })), keys: (await counts(f)).keys };
    }
    const r = await sendReq(f, slot, "POST", "/v1/api-keys", { bearer: bearerOf(f, cred) }, body, headers);
    return { ...createObs(f, r, idem, what), keys: (await counts(f)).keys };
  }
  if (what === "inbox") {
    const r = await sendReq(f, slot, "POST", "/v1/inboxes", { bearer: bearerOf(f, cred) }, { type: "sandbox", name: "tear" }, headers);
    return { ...createObs(f, r, idem, what), inboxes: (await counts(f)).inboxes };
  }
  throw new Error(`unknown create ${what}`);
}

async function listing(f: Fixture, bearerToken: string, codemode: boolean) {
  const r = await rpc(f, bearerToken, "tools/list", {}, codemode);
  if (r.status !== 200 || !Array.isArray(r.body?.result?.tools)) return { status: r.status };
  const tools = r.body.result.tools as { name: string; inputSchema?: { properties?: { action?: { enum?: string[] } } } }[];
  const ops = new Set<string>();
  for (const t of tools) {
    if (codemode) {
      if (t.name !== "workspaces" && t.name !== "setDefaultWorkspace") ops.add(t.name);
    } else {
      for (const action of t.inputSchema?.properties?.action?.enum ?? []) {
        const op = INVENTORY.get(`${t.name}.${action}`);
        if (op) ops.add(op);
      }
    }
  }
  return { status: 200, visible: Object.fromEntries([...ops].sort().map((op) => [op, true])) };
}

async function auditActor(f: Fixture, who: string) {
  let call: (path: string) => Promise<number>;
  if (f.grants.has(who)) {
    const actor = await getMcpGrantActor(runtime, f.grants.get(who)!.keyId, f.w);
    if (!actor) return { status: 401 };
    call = async (path) =>
      (await dispatchAsActor(app, new Request(PUBLIC + path, { headers: { accept: "application/json" } }), runtime, actor)).status;
  } else {
    const secret = bearerOf(f, who);
    const probePath = who === "ikey" || who === "gikey" || who === "bkey" ? "/v1/inboxes" : "/v1/me";
    if ((await sendReq(f, null, "GET", probePath, { bearer: secret })).status === 401) return { status: 401 };
    call = async (path) => (await sendReq(f, null, "GET", path, { bearer: secret })).status;
  }
  const rest: Record<string, boolean> = {};
  for (const { name, path } of GETS) {
    const status = await call(path);
    rest[name] = status !== 401 && status !== 403;
  }
  return { status: 200, rest };
}

async function within(p: Promise<SlotEvent>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SlotEvent>((_, reject) => {
    timer = setTimeout(() => reject(new Error("slot did not reach a checkpoint within 5 s")), 5000);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function reportSlot(f: Fixture, slot: Slot, e: SlotEvent): AccessObs {
  if ("at" in e) return { at: e.at };
  delete f.slots[slot.name];
  return { at: "done", ...slot.obs };
}

export const accessHost = host(access, {
  async open(req): Promise<Fixture> {
    await assertDisposable((text) => admin.query(text));
    const w = `tear_${randomBytes(8).toString("hex")}`;
    await freezeClock(Math.floor(RealDate.now() / 1000) * 1000);
    await admin.query("INSERT INTO workspaces (id,name,slug) VALUES ($1,$1,$1)", [w]);
    const owner = await seedUser(w, "owner");
    const member = await seedUser(w, "member");
    return {
      configured: false,
      bug: req.bug,
      w,
      owner,
      member,
      creds: new Map(),
      slots: {},
      firstIds: new Map(),
      grants: new Map(),
      start: clock,
      leakedErrors: [],
      secretReplays: [],
      duplicateCreates: [],
      pendingEvents: [],
    };
  },

  async act(f: Fixture, a: AccessAction): Promise<AccessObs> {
    switch (a.op) {
      case "Configure":
        f.configured = true;
        return { configured: true };
      case "Mint": {
        const c = a.target;
        if (c === "key" || c === "dkey") {
          const r = await sendReq(f, null, "POST", "/v1/api-keys", ownerAuth(f), {
            name: `tear ${c}`,
            permissions: ["read", "send", "manage"],
            domains: c === "dkey" ? ["allowed.example"] : [],
          });
          if (r.status === 201) f.creds.set(c, { id: r.body.id, secret: r.body.secret });
          return { status: r.status };
        }
        if (c === "legacy") {
          f.creds.set("legacy", await legacyKey(f));
          return { status: 201 };
        }
        if (c in SHAPES) {
          const [by, scopes] = SHAPES[c]!;
          return mintGrant(f, c, by === "member" ? f.member : f.owner, `${scopes} offline_access`);
        }
        if (c === "token") {
          const o = await callTool(f, "grant", "createAgentToken", {
            confirm: true,
            body: { permissions: ["read", "send", "manage"], expiresInSeconds: 60, purpose: "tear" },
          });
          if (o.status === 201) f.creds.set("token", { id: o.body.id, secret: o.body.token });
          return { status: o.status, code: o.code };
        }
        if (c === "token3") {
          f.creds.set("token3", await legacyToken(f, f.grants.get("grant")!));
          return { status: 201 };
        }
        if (c === "gkey") {
          const o = await callTool(f, "grant", "createApiKey", {
            confirm: true,
            body: { name: "tear gkey", permissions: ["read", "send", "manage"] },
          });
          if (o.status === 201) f.creds.set("gkey", { id: o.body.id, secret: o.body.secret });
          return { status: o.status, code: o.code };
        }
        if (c === "ikey") {
          const r = await sendReq(f, null, "POST", "/v1/api-keys", { bearer: bearerOf(f, "key") }, {
            name: "tear provisioning",
            access: { type: "addresses", addressIds: [], mail: ["read", "create"] },
          });
          if (r.status === 201) f.creds.set("ikey", { id: r.body.id, secret: r.body.secret });
          return { status: r.status, code: r.body?.error?.code ?? null };
        }
        if (c === "gikey") {
          const o = await callTool(f, "grant", "createApiKey", {
            confirm: true,
            body: { name: "tear gikey", access: { type: "addresses", addressIds: [], mail: ["read", "create"] } },
          });
          if (o.status === 201) f.creds.set("gikey", { id: o.body.id, secret: o.body.secret });
          return { status: o.status, code: o.code };
        }
        if (c === "box") {
          const r = await sendReq(f, null, "POST", "/v1/inboxes", { bearer: bearerOf(f, "key") }, {
            type: "sandbox",
            name: "tear box",
            credential: { name: "tear bkey", permissions: ["read"] },
          });
          if (r.status === 201) {
            f.box = r.body.id;
            f.creds.set("bkey", { id: r.body.credential.id, secret: r.body.credential.secret });
          }
          return { status: r.status, code: r.body?.error?.code ?? null };
        }
        throw new Error(`unknown mint ${c}`);
      }
      case "Revoke": {
        const c = a.target;
        if (c in SHAPES) {
          const g = f.grants.get(c)!;
          // Each user revokes their own MCP sign-in; if member was removed, fall back to ownerAuth.
          const memberPresent = (await admin.query("SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [f.w, g.user.id])).rowCount! > 0;
          const auth = memberPresent ? { cookie: g.user.cookie } : ownerAuth(f);
          return { status: (await sendReq(f, null, "POST", `/v1/agents/${g.keyId}/revoke`, auth)).status };
        }
        if (c === "token" || c === "token3") {
          return { status: (await sendReq(f, null, "POST", `/v1/agent-tokens/${f.creds.get(c)!.id}/revoke`, ownerAuth(f))).status };
        }
        return { status: (await sendReq(f, null, "POST", `/v1/api-keys/${f.creds.get(c)!.id}/revoke`, ownerAuth(f))).status };
      }
      case "DeleteBox":
        return { status: (await sendReq(f, null, "DELETE", `/v1/inboxes/${f.box}`, ownerAuth(f))).status };
      case "Refresh":
        return refreshGrant(f, a.grant);
      case "RemoveMember":
        return { status: (await sendReq(f, null, "DELETE", `/v1/workspaces/current/members/${f.member.memberId}`, ownerAuth(f))).status };
      case "PromoteMember":
        return { status: (await sendReq(f, null, "PATCH", `/v1/workspaces/current/members/${f.member.memberId}`, ownerAuth(f), { role: "admin" })).status };
      case "Tick":
        await freezeClock(f.start + a.ms);
        return {};
      case "Probe": {
        const { who, how } = a;
        if (how === "audit") return auditActor(f, who);
        if (f.grants.has(who)) {
          const g = f.grants.get(who)!;
          if (how === "call") {
            const o = await callTool(f, who, "getCurrentIdentity", {});
            return { status: o.status, code: o.code };
          }
          if (how === "delegate") {
            const o = await callTool(f, who, "createAgentToken", {
              confirm: true,
              body: { permissions: ["read"], expiresInSeconds: 60, purpose: "tear read delegation" },
            });
            return { status: o.status, code: o.code };
          }
          if (how === "query") {
            const o = await callTool(f, who, "queryAudience", { body: { statement: "SELECT count(*) FROM contacts" } });
            return { status: o.status, code: o.code };
          }
          return listing(f, g.access, how === "code");
        }
        const secret = bearerOf(f, who);
        if (how === "mcp") return listing(f, secret, true);
        if (how === "lists") {
          const r = await sendReq(f, null, "GET", "/v1/lists", { bearer: secret });
          return { status: r.status, code: r.body?.error?.code ?? null };
        }
        if (who === "bkey") return { status: (await sendReq(f, null, "GET", `/v1/inboxes/${f.box}`, { bearer: secret })).status };
        if (who === "ikey" || who === "gikey") return { status: (await sendReq(f, null, "GET", "/v1/inboxes", { bearer: secret })).status };
        return { status: (await sendReq(f, null, "GET", "/v1/me", { bearer: secret })).status };
      }
      case "Create": {
        const slot = a.lost ? newSlot("lost", false, "lost") : null;
        return runCreate(f, slot, a.what, a.cred, a.key, a.body);
      }
      case "SlotBegin": {
        const s = newSlot(a.slot, true, a.lost ? "lost" : null);
        f.slots[a.slot] = s;
        const events = new Promise<SlotEvent>((resolve) => {
          s.next = resolve;
        });
        s.result = runCreate(f, s, a.what, a.cred, a.key, a.body).then((o) => {
          s.obs = o;
          const n = s.next;
          s.next = null;
          n?.({ done: true });
          return o;
        });
        return reportSlot(f, s, await within(events));
      }
      case "SlotStep": {
        const slot = f.slots[a.slot];
        if (!slot || !slot.pending) throw new Error(`slot ${a.slot} is not parked`);
        const events = new Promise<SlotEvent>((resolve) => {
          slot.next = resolve;
        });
        const release = slot.pending;
        slot.pending = null;
        slot.at = null;
        release();
        return reportSlot(f, slot, await within(events));
      }
      case "SlotCrash": {
        const slot = f.slots[a.slot];
        if (!slot) throw new Error(`slot ${a.slot} is idle`);
        crashSlot(slot);
        delete f.slots[a.slot];
        return { crashed: true };
      }
    }
  },

  async observe(f: Fixture): Promise<Observed> {
    if (leaked.length) f.leakedErrors.push(...leaked.splice(0));
    const events = f.pendingEvents;
    f.pendingEvents = [];
    const snap: AccessSnapshot = {
      configured: f.configured,
      leakedErrors: [...f.leakedErrors],
      secretReplays: [...f.secretReplays],
      duplicateCreates: [...f.duplicateCreates],
    };
    return { snapshot: snap, events };
  },

  async close(f: Fixture): Promise<void> {
    for (const slot of Object.values(f.slots)) crashSlot(slot);
    await admin.query("DELETE FROM nightmail_users WHERE id = ANY($1)", [[f.owner.id, f.member.id]]);
  },
});
