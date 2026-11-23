import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { host, type Observed } from "@tear/mbt";
import { scaleReads } from "./scale-reads.model.ts";
import type { ScaleReadAction, ScaleReadKind, ScaleReadObs, ScaleReadSnapshot } from "./scale-reads.types.ts";

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
const PUBLIC = "http://127.0.0.1:8794";

const SEED_COUNT = Math.min(2_000_000, Math.max(1_000, Number(process.env.TEAR_SCALE_CONTACTS ?? 200_000)));
// Budgets scaled conservatively for local Docker Postgres (default 200k contacts; scale proportionally up to 2M).
const scaleFactor = Math.max(1, SEED_COUNT / 200_000);
const BUDGETS_MS: Record<ScaleReadKind, number> = {
  ContactsPage: Math.round(500 * scaleFactor),
  ContactsBigList: Math.round(500 * scaleFactor),
  // An indexed 3-member list read should be comparable to ContactsBigList (~10–30 ms); 150 ms gives >5x headroom
  // while deterministically catching B1 (full workspace scan from inList's OFFSET 0 fence: ~300–600 ms at 200k).
  ContactsSmallList: Math.round(150 * scaleFactor),
  ContactsSearchHit: Math.round(1500 * scaleFactor),
  ListsWithCounts: Math.round(1500 * scaleFactor),
  CampaignAudienceCount: Math.round(1500 * scaleFactor),
};

const env: Record<string, string> = {
  DATABASE_URL: url,
  BANE_ROOT_SECRET: "tear-scale-".repeat(6),
  PUBLIC_URL: PUBLIC,
  API_BASE_URL: PUBLIC,
  MULTI_TENANT: "false",
  ACCOUNT_CLIENT_ID: "tear",
  ACCOUNT_CLIENT_PRIVATE_KEY: "unused",
  AUTH_ALLOWED_SUBJECTS: "tear-operator",
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

const pool = new pg.Pool({ connectionString: url, max: 8 });
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

interface SeededFixture {
  w: string;
  secret: string;
  bigListId: string;
  smallListId: string;
  campaignId: string;
  count: number;
}

let cachedFixture: SeededFixture | null = null;

async function ensureSeeded(): Promise<SeededFixture> {
  if (cachedFixture) return cachedFixture;
  const w = `tear_scale_${SEED_COUNT}`;
  const bigListId = `list_${w}_big`;
  const smallListId = `list_${w}_small`;
  const secret = "nm_" + createHash("sha256").update(w).digest("hex");
  const { rows: existing } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM audience_contacts WHERE workspace_id=$1",
    [w],
  );
  if ((existing[0]?.n ?? 0) !== SEED_COUNT) {
    await pool.query("INSERT INTO workspaces(id,name,slug,postal_address) VALUES ($1,$1,$1,'123 Scale Way') ON CONFLICT (id) DO NOTHING", [w]);
    await pool.query(
      'INSERT INTO api_keys(id,workspace_id,name,hash,prefix,permissions,domains) VALUES ($1,$2,\'tear\',$3,$4,\'["read","send","manage"]\',\'[]\') ON CONFLICT (id) DO NOTHING',
      [`key_${w}`, w, createHash("sha256").update(secret).digest("hex"), secret.slice(0, 14)],
    );
    await pool.query("DELETE FROM audience_list_members WHERE workspace_id=$1", [w]);
    await pool.query("DELETE FROM audience_contacts WHERE workspace_id=$1", [w]);
    await pool.query("DELETE FROM audience_lists WHERE workspace_id=$1", [w]);
    await pool.query(
      "INSERT INTO audience_lists(id,workspace_id,name) VALUES ($1,$3,'Big list'),($2,$3,'Small list')",
      [bigListId, smallListId, w],
    );
    // Bulk seed N synthetic contacts + bigList (all N) + smallList (3 members) in pure SQL.
    await pool.query(
      `INSERT INTO audience_contacts(id,workspace_id,email,name,marketing_consent)
       SELECT $1 || '_c' || lpad(g::text, 7, '0'), $1, 'contact-' || g || '@example.com', 'Contact ' || g, 'subscribed'
       FROM generate_series(1, $2) g`,
      [w, SEED_COUNT],
    );
    await pool.query(
      `INSERT INTO audience_list_members(workspace_id,list_id,contact_id)
       SELECT $1, $2, $1 || '_c' || lpad(g::text, 7, '0')
       FROM generate_series(1, $3) g`,
      [w, bigListId, SEED_COUNT],
    );
    await pool.query(
      `INSERT INTO audience_list_members(workspace_id,list_id,contact_id)
       SELECT $1, $2, $1 || '_c' || lpad(g::text, 7, '0')
       FROM generate_series(1, 3) g`,
      [w, smallListId],
    );
    await pool.query("ANALYZE audience_contacts; ANALYZE audience_list_members; ANALYZE audience_lists;");
  }
  await ensureRegionSettings(runtime.db, { workspaceId: w, regions: ["us-east-1"] });
  const { rows: camps } = await pool.query<{ id: string }>(
    "SELECT id FROM sending_campaigns WHERE workspace_id=$1 LIMIT 1",
    [w],
  );
  let campaignId = camps[0]?.id;
  if (!campaignId) {
    const r = await app.fetch(
      new Request(PUBLIC + "/v1/campaigns", {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Scale campaign",
          from: "sender@example.com",
          subject: "Scale test",
          html: "<p>Scale</p>",
          audience: { listId: bigListId },
        }),
      }),
      runtime,
    );
    const body = (await r.json()) as any;
    if (r.status !== 201) throw new Error(`create scale campaign failed: ${r.status} ${JSON.stringify(body)}`);
    campaignId = body.id;
  }
  cachedFixture = { w, secret, bigListId, smallListId, campaignId: campaignId!, count: SEED_COUNT };
  return cachedFixture;
}

interface Trial {
  bug?: string;
  fx: SeededFixture;
  slowReads: string[];
  leakedErrors: string[];
}

async function timedGet(t: Trial, path: string, budgetMs: number, kind: ScaleReadKind): Promise<ScaleReadObs> {
  const t0 = performance.now();
  const r = await app.fetch(
    new Request(PUBLIC + path, { headers: { authorization: `Bearer ${t.fx.secret}` } }),
    runtime,
  );
  const body = (await r.json().catch(() => null)) as any;
  let elapsedMs = Math.round(performance.now() - t0);
  if (t.bug === "canary_slow_read" && kind === "ContactsPage") {
    elapsedMs = budgetMs + 250;
  }
  if (elapsedMs > budgetMs) t.slowReads.push(`${kind}:${elapsedMs}ms>${budgetMs}ms`);
  const rows = Array.isArray(body?.data) ? body.data.length : typeof body?.matched === "number" ? body.matched : 0;
  return { status: r.status, elapsedMs, budgetMs, rows, seededContacts: t.fx.count };
}

export const scaleReadsHost = host(scaleReads, {
  async open(req): Promise<Trial> {
    await assertDisposable((text) => pool.query(text));
    const fx = await ensureSeeded();
    return { bug: req.bug, fx, slowReads: [], leakedErrors: [] };
  },

  async act(t: Trial, a: ScaleReadAction): Promise<ScaleReadObs> {
    const budget = BUDGETS_MS[a.op];
    switch (a.op) {
      case "ContactsPage":
        return timedGet(t, "/v1/contacts?limit=50", budget, a.op);
      case "ContactsBigList":
        return timedGet(t, `/v1/contacts?listId=${t.fx.bigListId}&limit=50`, budget, a.op);
      case "ContactsSmallList":
        return timedGet(t, `/v1/contacts?listId=${t.fx.smallListId}&limit=50`, budget, a.op);
      case "ContactsSearchHit":
        return timedGet(t, `/v1/contacts?search=contact-${Math.floor(t.fx.count / 2)}@example.com&limit=50`, budget, a.op);
      case "ListsWithCounts":
        return timedGet(t, "/v1/lists", budget, a.op);
      case "CampaignAudienceCount":
        return timedGet(t, `/v1/campaigns/${t.fx.campaignId}/audience`, budget, a.op);
    }
  },

  async observe(t: Trial): Promise<Observed> {
    if (leaked.length) t.leakedErrors.push(...leaked.splice(0));
    const snap: ScaleReadSnapshot = {
      seededContacts: t.fx.count,
      slowReads: [...t.slowReads],
      leakedErrors: [...t.leakedErrors],
    };
    return { snapshot: snap, events: [] };
  },
});
