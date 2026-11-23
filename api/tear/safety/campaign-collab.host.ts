import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { host, type HostEvent, type Observed } from "@tear/mbt";
import { campaignCollab } from "./campaign-collab.model.ts";
import type { CollabAction, CollabActor, CollabObs, CollabSnapshot, DraftFields } from "./campaign-collab.types.ts";

for (const level of ["log", "info", "warn", "debug"] as const) {
  console[level] =
    process.env.TEAR_HOST_LOG === "1"
      ? (...a: unknown[]) => process.stderr.write(a.map(String).join(" ") + "\n")
      : () => {};
}

const leaked: string[] = [];
process.on("unhandledRejection", (err) => {
  leaked.push(String(err instanceof Error ? err.message : err).slice(0, 120));
});

const { disposableUrl, assertDisposable } = await import("../disposable.ts");
const url = disposableUrl(process.env.TEAR_DATABASE_URL ?? process.env.DATABASE_URL, "TEAR_DATABASE_URL");
const PUBLIC = "http://127.0.0.1:8797";

const env: Record<string, string> = {
  DATABASE_URL: url,
  BANE_ROOT_SECRET: "tear-collab-".repeat(6),
  PUBLIC_URL: PUBLIC,
  API_BASE_URL: PUBLIC,
  MULTI_TENANT: "true",
  ACCOUNT_REQUIRED_ACR: "urn:anomaly:acr:google",
  ACCOUNT_ISSUER: "https://tear-issuer.invalid",
  ACCOUNT_CLIENT_ID: "tear",
  ACCOUNT_CLIENT_PRIVATE_KEY: "unused",
  ENABLE_LIVE_SES: "false",
  AWS_EC2_METADATA_DISABLED: "true",
  S3_BUCKET: "tear",
  S3_ACCESS_KEY_ID: "tear",
  S3_SECRET_ACCESS_KEY: "tear",
  S3_ENDPOINT: "http://127.0.0.1:9",
  API_RATE_LIMIT_PER_MINUTE: "100000",
  DEFAULT_SES_REGION: "us-east-1",
  SIMULATED_SES_LATENCY_MS: "0",
  SIMULATED_SES_DELIVERY_DELAY_MS: "0",
};

const pool = new pg.Pool({ connectionString: url, max: 16 });
pool.on("error", () => {});
await assertDisposable((text) => pool.query(text));

const [{ createApp }, { loadConfig }, { s3Storage }, { ensureRegionSettings }] = await Promise.all([
  import("../../src/app.ts"),
  import("../../src/config.ts"),
  import("../../src/adapters/storage.ts"),
  import("../../src/ses-region-state.ts"),
]);

const runtime: any = { db: drizzle(pool), storage: s3Storage(env), config: loadConfig(env) };
const app = createApp();

interface ActorSession {
  auth: { cookie?: string; bearer?: string };
  baseRev: number;
  base: DraftFields;
  dirty: Partial<DraftFields>;
}

interface Trial {
  bug?: string;
  w: string;
  listId: string;
  campaignId: string;
  userIds: string[];
  actors: Record<CollabActor, ActorSession>;
  staleOverwrites: string[];
  lostDisjointEdits: string[];
  leakedErrors: string[];
  pendingEvents: HostEvent[];
}

const INITIAL: DraftFields = {
  subject: "Initial subject",
  previewText: "Initial preview",
  html: "<p>Initial body</p>",
};

async function seedDashboardUser(w: string): Promise<{ id: string; cookie: string }> {
  const id = `tear-user-${randomUUID()}`;
  const token = randomBytes(32).toString("base64url");
  await pool.query("INSERT INTO nightmail_users(id,name,email,email_verified) VALUES ($1,'tear',$2,true)", [id, `${id}@example.com`]);
  await pool.query("INSERT INTO nightmail_oidc_identities VALUES ($1,$2,$2)", ["https://tear-issuer.invalid", id]);
  await pool.query("INSERT INTO nightmail_sessions(token_hash,user_id,issuer,subject,expires_at) VALUES ($1,$2,$3,$2,now()+interval '1 day')", [
    createHash("sha256").update(token).digest("hex"),
    id,
    "https://tear-issuer.invalid",
  ]);
  await pool.query("INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES ($1,$2,$3,'owner')", [randomUUID(), w, id]);
  return { id, cookie: `bane.session_token=${token}` };
}

async function req(t: Trial, auth: { cookie?: string; bearer?: string }, method: string, path: string, body?: unknown) {
  const h = new Headers();
  if (auth.cookie) {
    h.set("cookie", auth.cookie);
    h.set("origin", PUBLIC);
    h.set("x-bane-workspace", t.w);
  }
  if (auth.bearer) h.set("authorization", `Bearer ${auth.bearer}`);
  if (body !== undefined) h.set("content-type", "application/json");
  const r = await app.fetch(
    new Request(PUBLIC + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }),
    runtime,
  );
  const text = await r.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // non-json
  }
  return { status: r.status, body: parsed };
}

async function readServer(t: Trial): Promise<{ revision: number; server: DraftFields }> {
  const r = await req(t, t.actors.API.auth, "GET", `/v1/campaigns/${t.campaignId}`);
  if (r.status !== 200) throw new Error(`GET campaign failed: ${r.status}`);
  const d = r.body.draft;
  return {
    revision: r.body.revision as number,
    server: {
      subject: d.subject ?? "",
      previewText: d.previewText ?? "",
      html: d.html ?? "",
    },
  };
}

function payloadFor(t: Trial, revision: number, fields: DraftFields) {
  return {
    revision,
    draft: {
      name: "Tear Collab",
      from: "sender@example.com",
      subject: fields.subject,
      previewText: fields.previewText,
      html: fields.html,
      audience: { listId: t.listId },
    },
  };
}

export const campaignCollabHost = host(campaignCollab, {
  rounds: true,

  async open(reqInit): Promise<Trial> {
    await assertDisposable((text) => pool.query(text));
    const w = `tear_collab_${randomBytes(6).toString("hex")}`;
    const listId = `list_${randomBytes(6).toString("hex")}`;
    const secret = "nm_" + randomBytes(32).toString("hex");
    await pool.query("INSERT INTO workspaces(id,name,slug,postal_address) VALUES ($1,$1,$1,'123 Tear Way')", [w]);
    await pool.query(
      'INSERT INTO api_keys(id,workspace_id,name,hash,prefix,permissions,domains) VALUES ($1,$2,\'tear\',$3,$4,\'["read","send","manage"]\',\'[]\')',
      [`key_${w}`, w, createHash("sha256").update(secret).digest("hex"), secret.slice(0, 14)],
    );
    await pool.query("INSERT INTO audience_lists(id,workspace_id,name) VALUES ($1,$2,'tear')", [listId, w]);
    await ensureRegionSettings(runtime.db, { workspaceId: w, regions: ["us-east-1"] });
    const e1 = await seedDashboardUser(w);
    const e2 = await seedDashboardUser(w);
    const trial: Trial = {
      bug: reqInit.bug,
      w,
      listId,
      campaignId: "",
      userIds: [e1.id, e2.id],
      actors: {
        E1: { auth: { cookie: e1.cookie }, baseRev: 1, base: { ...INITIAL }, dirty: {} },
        E2: { auth: { cookie: e2.cookie }, baseRev: 1, base: { ...INITIAL }, dirty: {} },
        API: { auth: { bearer: secret }, baseRev: 1, base: { ...INITIAL }, dirty: {} },
      },
      staleOverwrites: [],
      lostDisjointEdits: [],
      leakedErrors: [],
      pendingEvents: [],
    };
    const created = await req(trial, trial.actors.API.auth, "POST", "/v1/campaigns", {
      name: "Tear Collab",
      from: "sender@example.com",
      subject: INITIAL.subject,
      previewText: INITIAL.previewText,
      html: INITIAL.html,
      audience: { listId },
    });
    if (created.status !== 201) throw new Error(`create campaign failed: ${created.status} ${JSON.stringify(created.body)}`);
    trial.campaignId = created.body.id;
    return trial;
  },

  async act(t: Trial, a: CollabAction): Promise<CollabObs> {
    const actor = t.actors[a.actor];
    switch (a.op) {
      case "Load": {
        const res = await req(t, actor.auth, "GET", `/v1/campaigns/${t.campaignId}`);
        const cur = {
          revision: res.body.revision as number,
          server: {
            subject: res.body.draft.subject ?? "",
            previewText: res.body.draft.previewText ?? "",
            html: res.body.draft.html ?? "",
          },
        };
        actor.baseRev = cur.revision;
        actor.base = { ...cur.server };
        actor.dirty = {};
        return { status: res.status, code: null, revision: cur.revision, server: cur.server };
      }
      case "EditLocal": {
        actor.dirty[a.field] = a.val;
        const cur = await readServer(t);
        return { status: 200, code: null, revision: cur.revision, server: cur.server };
      }
      case "Save": {
        const draft: DraftFields = {
          subject: actor.dirty.subject ?? actor.base.subject,
          previewText: actor.dirty.previewText ?? actor.base.previewText,
          html: actor.dirty.html ?? actor.base.html,
        };
        let revToSend = actor.baseRev;
        // Planted canary: silently fetch latest revision and overwrite on stale save (the lost-work bug!).
        if (t.bug === "canary_stale_overwrite") {
          const latest = await readServer(t);
          if (latest.revision !== actor.baseRev) {
            revToSend = latest.revision;
            t.staleOverwrites.push(`${a.actor}@rev${actor.baseRev}->${latest.revision}`);
          }
        }
        const res = await req(t, actor.auth, "PATCH", `/v1/campaigns/${t.campaignId}`, payloadFor(t, revToSend, draft));
        if (res.status === 200) {
          const nextRev = res.body.revision as number;
          const nextDraft: DraftFields = {
            subject: res.body.draft.subject ?? "",
            previewText: res.body.draft.previewText ?? "",
            html: res.body.draft.html ?? "",
          };
          actor.baseRev = nextRev;
          actor.base = { ...nextDraft };
          actor.dirty = {};
          t.pendingEvents.push({ name: "campaign.saved", data: { actor: a.actor, revision: nextRev } });
          return { status: 200, code: null, revision: nextRev, server: nextDraft };
        }
        const cur = await readServer(t);
        return { status: res.status, code: res.body?.error?.code ?? null, revision: cur.revision, server: cur.server };
      }
      case "ReloadMergeSave": {
        const before = await readServer(t);
        const merged: DraftFields = {
          subject: actor.dirty.subject ?? before.server.subject,
          previewText: actor.dirty.previewText ?? before.server.previewText,
          html: actor.dirty.html ?? before.server.html,
        };
        const res = await req(t, actor.auth, "PATCH", `/v1/campaigns/${t.campaignId}`, payloadFor(t, before.revision, merged));
        if (res.status !== 200) {
          const cur = await readServer(t);
          return { status: res.status, code: res.body?.error?.code ?? null, revision: cur.revision, server: cur.server };
        }
        const nextRev = res.body.revision as number;
        const nextDraft: DraftFields = {
          subject: res.body.draft.subject ?? "",
          previewText: res.body.draft.previewText ?? "",
          html: res.body.draft.html ?? "",
        };
        for (const f of ["subject", "previewText", "html"] as const) {
          if (actor.dirty[f] === undefined && nextDraft[f] !== before.server[f]) {
            t.lostDisjointEdits.push(`${a.actor} dropped ${f}`);
          }
        }
        actor.baseRev = nextRev;
        actor.base = { ...nextDraft };
        actor.dirty = {};
        t.pendingEvents.push({ name: "campaign.saved", data: { actor: a.actor, revision: nextRev } });
        return { status: 200, code: null, revision: nextRev, server: nextDraft };
      }
      case "RaceSave": {
        const runOne = async (who: CollabActor) => {
          const ac = t.actors[who];
          const draft: DraftFields = {
            subject: ac.dirty.subject ?? ac.base.subject,
            previewText: ac.dirty.previewText ?? ac.base.previewText,
            html: ac.dirty.html ?? ac.base.html,
          };
          return req(t, ac.auth, "PATCH", `/v1/campaigns/${t.campaignId}`, payloadFor(t, ac.baseRev, draft));
        };
        const [r1, r2] = await Promise.all([runOne(a.a), runOne(a.b)]);
        const statuses = [r1.status, r2.status].sort((x, y) => x - y);
        const loser = r1.status === 409 ? r1 : r2.status === 409 ? r2 : null;
        const okPair = statuses[0] === 200 && statuses[1] === 409 && loser?.body?.error?.code === "STALE_CAMPAIGN_REVISION";
        const cur = await readServer(t);
        t.actors[a.a].baseRev = 0;
        t.actors[a.b].baseRev = 0;
        if (okPair) t.pendingEvents.push({ name: "campaign.saved", data: { actor: "race", revision: cur.revision } });
        return {
          status: okPair ? 200 : 500,
          code: okPair ? "RACE_200_409" : `BAD_RACE:${statuses.join(",")}`,
          revision: cur.revision,
          server: cur.server,
        };
      }
    }
  },

  async observe(t: Trial): Promise<Observed> {
    if (leaked.length) t.leakedErrors.push(...leaked.splice(0));
    const cur = await readServer(t);
    const events = t.pendingEvents;
    t.pendingEvents = [];
    const snap: CollabSnapshot = {
      revision: cur.revision,
      server: cur.server,
      staleOverwrites: [...t.staleOverwrites],
      lostDisjointEdits: [...t.lostDisjointEdits],
      leakedErrors: [...t.leakedErrors],
    };
    return { snapshot: snap, events };
  },

  async close(t: Trial): Promise<void> {
    await pool.query("DELETE FROM nightmail_users WHERE id = ANY($1)", [t.userIds]);
  },
});
