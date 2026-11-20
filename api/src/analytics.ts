import { z } from 'zod';
import { ApiError, digest, log, type App, type Runtime, type Storage } from './core.js';
import { clientIpHeader } from './brand.js';
import { ANALYTICS_EVENT_TYPES, ANALYTICS_LIMITS, ANALYTICS_PATH, FUNNEL_STEPS, VALIDITY_REASONS, VIEWPORTS, analyticsId, analyticsName, fieldName, operationTemplate, routeTemplate, scrubLabel } from './analytics-events.js';

// Dashboard usage analytics (docs/analytics.md). The dashboard keeps nothing on the device: its session ID lives in the
// page's memory, and a signed-in page names the account and workspace. It posts batches here with sendBeacon; each accepted batch
// becomes one NDJSON object under raw/, and the hourly upkeep compacts every settled hour into one gzip object under
// events/. Nothing here reads or writes Postgres: the analytics bucket (Workers: ANALYTICS, else the installation's own
// bucket under analytics/) is the whole store, so a burst of clicks never spends a database connection.

export const ANALYTICS_ROOT = 'analytics/v1/';
/** Compacted days older than this are deleted by the hourly upkeep (hosted buckets also have a lifecycle backstop). */
export const ANALYTICS_RETENTION_DAYS = 400;
/** Batches a minute from one client address: a tab flushes at most every five seconds, plus once when it hides. */
export const ANALYTICS_BATCHES_PER_MINUTE = 60;
// A batch is written before its 204, so an hour is complete a few minutes after it ends.
const SETTLE_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

const id = z.string().regex(/^[A-Za-z0-9_-]{8,40}$/);
const Envelope = z.object({
  v: z.literal(1),
  sid: id,
  ws: z.string().max(64).nullish(), uid: z.string().max(64).nullish(),
  app: z.string().max(40).nullish(), vp: z.enum(VIEWPORTS),
  events: z.array(z.unknown()).min(1).max(ANALYTICS_LIMITS.events),
});
const text = (max: number) => z.string().max(max).nullish();
const Event = z.object({
  id, seq: z.number().int().min(0).max(10_000_000), t: z.number().int().min(0), type: z.enum(ANALYTICS_EVENT_TYPES),
  route: z.string().max(300), ref: text(300),
  name: text(80), role: text(24), label: text(200), field: text(120), reason: z.enum(VALIDITY_REASONS).nullish(),
  code: text(64), op: text(300), status: z.number().int().min(100).max(599).nullish(),
  ms: z.number().int().min(0).max(7 * DAY_MS).nullish(), step: z.enum(FUNNEL_STEPS).nullish(),
});
export type AnalyticsRow = {
  v: 1; id: string; received: string; t: string; seq: number; sid: string; ws: string | null; uid: string | null; app: string | null; vp: typeof VIEWPORTS[number] | null;
  type: typeof ANALYTICS_EVENT_TYPES[number]; route: string; ref: string | null; target: string | null; name: string | null; role: string | null; label: string | null;
  field: string | null; reason: string | null; code: string | null; op: string | null; status: number | null; ms: number | null; step: string | null;
};
const ELEMENT_EVENTS = new Set(['click', 'dialog_open', 'dialog_close', 'form_submit', 'form_invalid']);

/**
 * The stored rows of one batch: every value is checked again here, whatever the dashboard did. Unknown fields are
 * stripped, an event that fails its schema is dropped (a newer or older dashboard keeps the rest of its batch), labels are
 * scrubbed, paths become route templates, and IDs that aren't Nightmail's own shapes become null.
 */
export function analyticsRows(body: unknown, now: number): { rows: AnalyticsRow[]; dropped: number } {
  const envelope = Envelope.safeParse(body);
  if (!envelope.success) throw new ApiError(422, 'VALIDATION_FAILED', 'The analytics batch is invalid.');
  const { sid, ws, uid, app, vp, events } = envelope.data, received = new Date(now).toISOString();
  const base = { v: 1 as const, received, sid, vp, ws: workspaceId(ws), uid: userId(uid), app: app && /^[0-9a-z]{1,40}$/.test(app) ? app : null };
  const rows: AnalyticsRow[] = [];
  for (const raw of events) {
    const parsed = Event.safeParse(raw), event = parsed.success ? parsed.data : null;
    const route = event && routeTemplate(event.route);
    if (!event || !route || event.type === 'sign_in' || (event.type === 'track' && !event.step) || (event.type === 'api_error' && !event.code)) continue;
    const name = analyticsName(event.name), role = typeof event.role === 'string' && /^[a-z]{1,16}$/.test(event.role) ? event.role : null;
    const label = name ? null : scrubLabel(event.label);
    rows.push({ ...base, id: event.id, t: new Date(Math.abs(event.t - now) > DAY_MS ? now : event.t).toISOString(), seq: event.seq, type: event.type, route,
      ref: routeTemplate(event.ref), target: name ?? (ELEMENT_EVENTS.has(event.type) && (role || label) ? (role ?? 'element') + ':' + (label ?? '') : null), name, role, label,
      field: fieldName(event.field), reason: event.reason ?? null, code: event.code && /^[A-Z][A-Z0-9_]{0,63}$/.test(event.code) ? event.code : null,
      op: operationTemplate(event.op), status: event.status ?? null, ms: event.ms ?? null, step: event.step ?? null });
  }
  return { rows, dropped: events.length - rows.length };
}

const workspaceId = (value: unknown) => typeof value === 'string' && /^(?:ws_[0-9a-f]{32}|default)$/.test(value) ? value : null;
const userId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(value) ? value : null;

/** Where analytics objects live: the Worker's ANALYTICS bucket, else the installation's own bucket. */
export const analyticsStore = (runtime: Runtime): Storage => runtime.analyticsStorage ?? runtime.storage;
const hourPath = (ms: number) => { const iso = new Date(ms).toISOString(); return 'dt=' + iso.slice(0, 10) + '/h=' + iso.slice(11, 13); };
const encoder = new TextEncoder(), decoder = new TextDecoder();
async function writeBatch(runtime: Runtime, rows: AnalyticsRow[], now: number) {
  const key = ANALYTICS_ROOT + 'raw/' + hourPath(now) + '/' + now + '-' + crypto.randomUUID().replaceAll('-', '').slice(0, 16) + '.ndjson';
  await analyticsStore(runtime).put(key, encoder.encode(rows.map(row => JSON.stringify(row)).join('\n') + '\n'), 'application/x-ndjson');
}

/**
 * The one event that links a signed-out page's session (its events carry no account) to the account that signed in
 * from it: written by the sign-in callback, which knows both, with the session ID the page put in its return URL.
 * Best-effort: a failure here never fails the sign-in.
 */
export async function recordSignIn(runtime: Runtime, session: unknown, user: string, route: string) {
  const sid = analyticsId(session), uid = userId(user);
  if (!runtime.config.dashboardAnalytics || !sid || !uid) return;
  const now = Date.now(), at = new Date(now).toISOString();
  try {
    await writeBatch(runtime, [{ v: 1, id: crypto.randomUUID().replaceAll('-', ''), received: at, t: at, seq: 0, sid, ws: null, uid, app: null, vp: null, type: 'sign_in',
      route: routeTemplate(route) ?? '/', ref: null, target: null, name: null, role: null, label: null, field: null, reason: null, code: null, op: null, status: null, ms: null, step: null }], now);
  } catch { log('warn', { code: 'ANALYTICS_SIGN_IN_UNRECORDED' }); }
}

// A per-process cap in front of the Workers rate-limit binding (runtime.allowAnalytics), which Node doesn't have.
const counts = new Map<string, number>();
let countMinute = 0;
async function allowBatch(runtime: Runtime, peer: string) {
  const minute = Math.floor(Date.now() / 60_000);
  if (minute !== countMinute) { counts.clear(); countMinute = minute; }
  const count = (counts.get(peer) ?? 0) + 1;
  if (counts.size < 4096 || counts.has(peer)) counts.set(peer, count);
  if (count > ANALYTICS_BATCHES_PER_MINUTE) return false;
  return runtime.allowAnalytics ? runtime.allowAnalytics(peer) : true;
}

export function registerAnalytics(app: App) {
  // Internal: not in the OpenAPI document, the SDK or MCP. Anyone can post, so it answers only the dashboard's own
  // origin, counts batches per client address before reading a byte, and stores nothing it hasn't checked.
  app.post(ANALYTICS_PATH, async c => {
    const runtime = c.env, { config } = runtime;
    // Off (DASHBOARD_ANALYTICS): the dashboard sends nothing, and anything that arrives anyway is discarded unread.
    if (!config.dashboardAnalytics) return c.body(null, 204);
    const origin = c.req.header('origin');
    if (!origin || ![config.publicUrl, ...config.previousOrigins ?? []].includes(origin)) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Analytics are accepted only from this installation’s dashboard.');
    // Do Not Track and Global Privacy Control: the dashboard sends nothing then, and a batch that says so is dropped.
    if (c.req.header('dnt') === '1' || c.req.header('sec-gpc') === '1') return c.body(null, 204);
    if (!(await allowBatch(runtime, await digest(c.req.header(clientIpHeader) ?? 'unknown')))) throw new ApiError(429, 'ANALYTICS_RATE_LIMITED', 'Too many analytics batches from this connection. Retry after one minute.', undefined, true);
    if (Number(c.req.header('content-length')) > ANALYTICS_LIMITS.bodyBytes) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'Request exceeds the 32 KiB limit.');
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > ANALYTICS_LIMITS.bodyBytes) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'Request exceeds the 32 KiB limit.');
    let body: unknown;
    try { body = JSON.parse(decoder.decode(bytes)); } catch { throw new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON.'); }
    const now = Date.now(), { rows, dropped } = analyticsRows(body, now);
    if (dropped) log('warn', { requestId: c.get('requestId'), code: 'ANALYTICS_EVENTS_DROPPED', dropped, accepted: rows.length });
    // A bucket that can't take the batch loses it: the dashboard never retries, and this isn't a database outage.
    if (rows.length) await writeBatch(runtime, rows, now).catch(() => { throw new ApiError(503, 'ANALYTICS_UNAVAILABLE', 'Analytics storage is unavailable.', undefined, true); });
    return c.body(null, 204);
  });
}

async function eachLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const index = next++; results[index] = await work(items[index]!); } }));
  return results;
}
async function gzip(bytes: Uint8Array) {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}

/**
 * Hourly: each settled hour's raw batches become one gzip NDJSON object under events/ (per 1,000 batches), then the
 * batches are deleted; compacted days past the retention go too. The object's name is a digest of the batches in it, so
 * two runs at once write the same object. A batch whose delete failed is compacted again later; readers deduplicate
 * by event ID (docs/analytics.md).
 */
export async function compactAnalytics(runtime: Runtime, now = Date.now()) {
  const store = analyticsStore(runtime), result = { hours: 0, batches: 0, expired: 0 };
  if (!runtime.config.dashboardAnalytics || !store.list) return result;
  const raw = ANALYTICS_ROOT + 'raw/', settled = hourPath(now - SETTLE_MS), hours = new Map<string, string[]>();
  let after: string | undefined, pages = 0;
  do {
    const page = await store.list(raw, after);
    for (const { key } of page.objects) {
      const hour = key.slice(raw.length).split('/', 2).join('/');
      if (/^dt=\d{4}-\d{2}-\d{2}\/h=\d{2}$/.test(hour) && hour < settled) { const keys = hours.get(hour); if (keys) keys.push(key); else hours.set(hour, [key]); }
    }
    after = page.cursor;
  } while (after && ++pages < 20);
  for (const [hour, keys] of hours) {
    for (let start = 0; start < keys.length; start += 1000) {
      const part = keys.slice(start, start + 1000);
      const bodies = await eachLimit(part, 8, key => store.get(key));
      const lines = bodies.map(object => object ? decoder.decode(object.body) : '').filter(Boolean).map(body => body.endsWith('\n') ? body : body + '\n').join('');
      if (lines) await store.put(ANALYTICS_ROOT + 'events/' + hour + '/' + (await digest(part.join('\n'))).slice(0, 16) + '.ndjson.gz', await gzip(encoder.encode(lines)), 'application/gzip');
      await eachLimit(part, 8, key => store.delete(key));
      result.batches += part.length;
    }
    result.hours++;
  }
  // The days just past the retention, a week of them, so a few missed runs still catch up.
  for (let back = 0; back < 7; back++) {
    const day = new Date(now - (ANALYTICS_RETENTION_DAYS + back) * DAY_MS).toISOString().slice(0, 10);
    let cursor: string | undefined;
    do {
      const page = await store.list(ANALYTICS_ROOT + 'events/dt=' + day + '/', cursor);
      await eachLimit(page.objects, 8, object => store.delete(object.key));
      result.expired += page.objects.length; cursor = page.cursor;
    } while (cursor);
  }
  if (result.hours || result.expired) log('info', { code: 'ANALYTICS_COMPACTED', ...result });
  return result;
}
