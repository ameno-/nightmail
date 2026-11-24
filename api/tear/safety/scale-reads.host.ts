import { createHash } from "node:crypto";
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

const { disposableUrl, assertDisposable } = await import("../disposable.ts");
const url = disposableUrl(process.env.TEAR_DATABASE_URL ?? process.env.DATABASE_URL, "TEAR_DATABASE_URL");
const PUBLIC = "http://127.0.0.1:8794";

const SEED_COUNT = Math.min(2_000_000, Math.max(1_000, Number(process.env.TEAR_SCALE_CONTACTS ?? 200_000)));
// Fixed budgets (independent of TEAR_SCALE_CONTACTS): indexed reads must stay O(log N + page) as data grows.
// Small multiples (~3-5x) of measured exos timings (25ms, 14ms, 155ms, 110ms, 78ms), never scaling with row count.
const BUDGETS_MS: Record<ScaleReadKind, number> = {
  ContactsPage: 120,
  ContactsBigList: 100,
  ContactsSmallList: 120,
  ContactsSearchHit: 450,
  ListsWithCounts: 350,
  CampaignAudienceCount: 250,
};

// Reads whose primary audience_contacts SELECT must use an index scan without sorting or scanning the workspace.
const INDEXED_PAGE_READS = new Set<ScaleReadKind>(["ContactsPage", "ContactsBigList", "ContactsSmallList"]);

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

interface CapturedQuery {
  text: string;
  values: unknown[];
}

let captureBucket: CapturedQuery[] | null = null;

class CapturingPool extends pg.Pool {
  override query(...args: any[]): any {
    if (captureBucket && typeof args.at(-1) !== "function") {
      const q = args[0];
      const text = typeof q === "string" ? q : q?.text;
      const values = Array.isArray(q?.values) ? q.values : Array.isArray(args[1]) ? args[1] : [];
      if (typeof text === "string" && /^\s*select\b/i.test(text) && /\baudience_contacts\b/i.test(text)) {
        captureBucket.push({ text, values });
      }
    }
    return (super.query as any)(...args);
  }
}

const pool = new CapturingPool({ connectionString: url, max: 8 });
pool.on("error", () => {});
await assertDisposable((text) => pool.query(text));

const leaked: string[] = [];
process.on("unhandledRejection", (err) => {
  leaked.push(String(err instanceof Error ? err.message : err).slice(0, 120));
});

const explainPool = new pg.Pool({ connectionString: url, max: 2 });
explainPool.on("error", () => {});

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
  const { rows: existing } = await explainPool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM audience_contacts WHERE workspace_id=$1",
    [w],
  );
  if ((existing[0]?.n ?? 0) !== SEED_COUNT) {
    await explainPool.query("INSERT INTO workspaces(id,name,slug,postal_address) VALUES ($1,$1,$1,'123 Scale Way') ON CONFLICT (id) DO NOTHING", [w]);
    await explainPool.query(
      'INSERT INTO api_keys(id,workspace_id,name,hash,prefix,permissions,domains) VALUES ($1,$2,\'tear\',$3,$4,\'["read","send","manage"]\',\'[]\') ON CONFLICT (id) DO NOTHING',
      [`key_${w}`, w, createHash("sha256").update(secret).digest("hex"), secret.slice(0, 14)],
    );
    await explainPool.query("DELETE FROM audience_list_members WHERE workspace_id=$1", [w]);
    await explainPool.query("DELETE FROM audience_contacts WHERE workspace_id=$1", [w]);
    await explainPool.query("DELETE FROM audience_lists WHERE workspace_id=$1", [w]);
    await explainPool.query(
      "INSERT INTO audience_lists(id,workspace_id,name) VALUES ($1,$3,'Big list'),($2,$3,'Small list')",
      [bigListId, smallListId, w],
    );
    await explainPool.query(
      `INSERT INTO audience_contacts(id,workspace_id,email,name,marketing_consent)
       SELECT $1 || '_c' || lpad(g::text, 7, '0'), $1, 'contact-' || g || '@example.com', 'Contact ' || g, 'subscribed'
       FROM generate_series(1, $2) g`,
      [w, SEED_COUNT],
    );
    await explainPool.query(
      `INSERT INTO audience_list_members(workspace_id,list_id,contact_id)
       SELECT $1, $2, $1 || '_c' || lpad(g::text, 7, '0')
       FROM generate_series(1, $3) g`,
      [w, bigListId, SEED_COUNT],
    );
    await explainPool.query(
      `INSERT INTO audience_list_members(workspace_id,list_id,contact_id)
       SELECT $1, $2, $1 || '_c' || lpad(g::text, 7, '0')
       FROM generate_series(1, 3) g`,
      [w, smallListId],
    );
    await explainPool.query("ANALYZE audience_contacts; ANALYZE audience_list_members; ANALYZE audience_lists;");
  }
  await ensureRegionSettings(runtime.db, { workspaceId: w, regions: ["us-east-1"] });
  const { rows: camps } = await explainPool.query<{ id: string }>(
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

function inspectPlanNode(node: any, thresholdRows: number): string | null {
  if (!node || typeof node !== "object") return null;
  const type = String(node["Node Type"] ?? "");
  const rel = String(node["Relation Name"] ?? "");
  const planRows = Number(node["Plan Rows"] ?? 0);
  const actualRows = Number(node["Actual Rows"] ?? 0);
  const removed = Number(node["Rows Removed by Filter"] ?? 0);
  if (type === "Seq Scan" && rel === "audience_contacts" && Math.max(planRows, actualRows) > thresholdRows) {
    return `Seq Scan on audience_contacts (rows=${Math.max(planRows, actualRows)})`;
  }
  if (type === "Sort") {
    const child = node.Plans?.[0];
    const childRows = Math.max(Number(child?.["Actual Rows"] ?? 0), Number(child?.["Plan Rows"] ?? 0));
    if (Math.max(planRows, actualRows, childRows) > thresholdRows) {
      return `Sort over ${Math.max(planRows, actualRows, childRows)} rows`;
    }
  }
  if (removed > thresholdRows) {
    return `${type} removed ${removed} rows by filter`;
  }
  for (const child of (node.Plans ?? []) as any[]) {
    const sub = inspectPlanNode(child, thresholdRows);
    if (sub) return sub;
  }
  return null;
}

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (Array.isArray(v)) return `ARRAY[${v.map(sqlLiteral).join(",")}]`;
  if (v instanceof Date) return `'${v.toISOString().replace(/'/g, "''")}'::timestamptz`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function checkIndexedPlans(queries: CapturedQuery[], seedCount: number): Promise<string | null> {
  const threshold = Math.min(5_000, Math.floor(seedCount / 10));
  const client = await explainPool.connect();
  try {
    await client.query("SET plan_cache_mode = force_custom_plan");
    for (const q of queries) {
      await client.query("DEALLOCATE ALL");
      await client.query(`PREPARE tear_exp AS ${q.text}`);
      const args = q.values.length ? `(${q.values.map(sqlLiteral).join(", ")})` : "";
      const { rows } = await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) EXECUTE tear_exp${args}`);
      await client.query("DEALLOCATE tear_exp");
      const plan = rows[0]?.["QUERY PLAN"]?.[0]?.Plan;
    if (!plan) continue;
    // Also detect SmallList full scan (inList OFFSET 0 causes a Hash/Semi Join or Materialize scanning > threshold rows).
    const bad = inspectPlanNode(plan, threshold);
    if (bad) return bad;
    // Detect unindexed/full-workspace scan under Limit via Actual Rows when EXPLAIN shows a Hash Join/SubPlan/Filter on audience_contacts.
    const planText = JSON.stringify(plan);
    if (planText.includes("audience_contacts") && plan["Node Type"] === "Limit") {
      const child = plan.Plans?.[0];
      if (child && child["Node Type"] === "Hash Join" && Number(child["Plan Rows"] ?? 0) > threshold) {
        return `Hash Join over ${child["Plan Rows"]} rows`;
      }
      if (child && child["Node Type"] === "Subquery Scan") {
        return `Subquery Scan fence (${child["Plan Rows"]} rows)`;
      }
      if (child && child["Node Type"] === "Sort") {
        // Even top-N heapsort reports Limit rows on Sort node if child is large: check child Plan Rows!
        const grand = child.Plans?.[0];
        if (grand && Number(grand["Plan Rows"] ?? 0) > threshold) {
          return `Sort over ${grand["Plan Rows"]} rows (${grand["Node Type"]})`;
        }
      }
    }
    }
    return null;
  } finally {
    await client.query("DEALLOCATE ALL").catch(() => {});
    client.release();
  }
}

interface Trial {
  bug?: string;
  fx: SeededFixture;
  slowReads: string[];
  leakedErrors: string[];
}

async function timedGet(t: Trial, path: string, budgetMs: number, kind: ScaleReadKind): Promise<ScaleReadObs> {
  const queries: CapturedQuery[] = [];
  captureBucket = INDEXED_PAGE_READS.has(kind) ? queries : null;
  const t0 = performance.now();
  let r: Response;
  try {
    r = await app.fetch(
      new Request(PUBLIC + path, { headers: { authorization: `Bearer ${t.fx.secret}` } }),
      runtime,
    );
  } finally {
    captureBucket = null;
  }
  const body = (await r.json().catch(() => null)) as any;
  let elapsedMs = Math.round(performance.now() - t0);
  let badPlan: string | null = null;
  if (r.status === 200 && INDEXED_PAGE_READS.has(kind)) {
    badPlan = await checkIndexedPlans(queries, t.fx.count);
  }
  if (t.bug === "canary_slow_read" && kind === "ContactsPage") {
    elapsedMs = budgetMs + 250;
  }
  if (elapsedMs > budgetMs || badPlan) {
    t.slowReads.push(`${kind}:${elapsedMs}ms>${budgetMs}ms${badPlan ? `(${badPlan})` : ""}`);
  }
  const rows = Array.isArray(body?.data) ? body.data.length : typeof body?.matched === "number" ? body.matched : 0;
  return { status: r.status, elapsedMs, budgetMs, badPlan, rows, seededContacts: t.fx.count };
}

export const scaleReadsHost = host(scaleReads, {
  async open(req): Promise<Trial> {
    await assertDisposable((text) => explainPool.query(text));
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
