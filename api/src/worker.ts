import {gatewayLane} from './protocol-admission.js';
import { getPath } from 'hono/utils/url';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Config, FeedbackItem, Runtime } from './core.js';
import { DispatcherShard, dispatcherName, shardCount } from './dispatcher-do.js';
import { CampaignRoom } from './campaign-room.js';
import { ROOM_PEER_HEADER } from './campaign-room-protocol.js';
import type { SupportPlatformApi } from './support-platform.js';
import { SECURITY_HEADERS } from './security-headers.js';
import { clientIpHeader, clientNetworkHeader, healthService, legacyClientIpHeaders, requestHeaderNames, setting } from './brand.js';
export { DispatcherShard, CampaignRoom };

// Keep top-level evaluation empty so cold-started isolates answer /health without
// loading OpenAPI/Zod schemas, Better Auth, MCP, Drizzle, pg or AWS SDK clients.
function fastSecure(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!headers.has(name)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function initRuntimeDeps() {
  return Promise.all([
    import('pg'), import('drizzle-orm/node-postgres'), import('drizzle-orm/sql'),
    import('./config.js'), import('./adapters/storage.js'),
    import('./jobs.js'), import('./core.js'),
    import('./adapters/browser-rendering.js'), import('./adapters/public-image.js'), import('./adapters/feedback-queue.js'), import('./screen-shadow.js'),
  ]).then(([{ Pool }, { drizzle }, { sql }, { CONFIG_KEYS, loadConfig }, { r2Storage }, { followDueJobs, jobConcurrency, WAKE_SCHEDULE_KEY }, core, { browserImageRenderer }, { publicImageImporter }, { feedbackSink, settleFeedbackBatch, legacyFeedbackCutover, workWake }, { enqueueShadow, consumeShadow, writeComparisons, writtenComparisons }]) => ({
    Pool, drizzle, sql, CONFIG_KEYS, loadConfig, r2Storage, followDueJobs, jobConcurrency, WAKE_SCHEDULE_KEY, core, browserImageRenderer, publicImageImporter, feedbackSink, settleFeedbackBatch, legacyFeedbackCutover, workWake, enqueueShadow, consumeShadow, writeComparisons, writtenComparisons,
  }));
}
async function toModuleLoadError(error: unknown): Promise<never> {
  const core = await import('./core.js').catch(() => null);
  throw core ? (error instanceof core.ModuleLoadError ? error : new core.ModuleLoadError(error)) : error;
}
let runtimeDepsPromise: ReturnType<typeof initRuntimeDeps> | undefined;
function loadRuntimeDeps() {
  return runtimeDepsPromise ??= initRuntimeDeps().catch(error => { runtimeDepsPromise = undefined; return toModuleLoadError(error); });
}
let appPromise: Promise<typeof import('./app.js')> | undefined;
function loadApp() {
  return appPromise ??= import('./app.js').catch(error => { appPromise = undefined; return toModuleLoadError(error); });
}
function loadHttpDeps() {
  return Promise.all([loadRuntimeDeps(), loadApp()]).then(([runtimeDeps, { app }]) => ({ ...runtimeDeps, app }));
}

// A provider group fits on one shard. Spread small sends across the pool without waking idle siblings.
let nextShard: number | undefined;
async function wakeDispatchers(env: Env, region: string, accountId?: string, emails?: number, kind?: 'shared' | 'byo', priority = false) {
  const count = kind === 'byo' ? 1 : shardCount('DISPATCH_SHARDS' in env ? env.DISPATCH_SHARDS : undefined);
  nextShard ??= Math.floor(Math.random() * 0x100000000);
  const indexes = emails !== undefined && emails <= 6 ? [nextShard++ % count] : Array.from({ length: count }, (_, i) => i);
  await Promise.all(indexes.map(index => {
    const identity = { accountId, region, shard: { index, count } };
    const stub = env.DISPATCHER.get(env.DISPATCHER.idFromName(dispatcherName(identity)), { locationHint: 'enam' });
    return stub.fetch(`https://dispatcher/wake?region=${encodeURIComponent(region)}&shard=${index}&count=${count}${accountId ? `&account=${encodeURIComponent(accountId)}` : ''}${priority ? '&priority=1' : ''}`);
  }));
}

// An agent's read or save, told to the campaign's room (src/campaign-room.ts) beside the request, never in its way. A
// room that says nobody is in it isn't asked again from this isolate for half a minute, so an agent polling a draft
// nobody has open wakes it at most twice a minute here and costs no query or storage. Names are kept for ten minutes,
// so a room with people in it takes one call; the first needs one lookup on a connection of its own. An agent the room
// heard from lately isn't reported again from here for a quarter of a minute (it stays on screen for two), unless it saved:
// a save (saved, its revision) always reaches a room with people in it, who read it at once.
const quietRooms = new Map<string, number>(), agentNames = new Map<string, { name: string; until: number }>(), reported = new Map<string, number>();
const QUIET_MS = 30_000, NAME_MS = 600_000, REPORTED_MS = 15_000;
async function roomVisit(env: Env, rooms: NonNullable<Env['CAMPAIGN_ROOMS']>, room: string, credential: string, lookup: (runtime: Runtime) => Promise<string | null>, saved?: number) {
  const now = Date.now(), visit = `${room}|${credential}`;
  if ((quietRooms.get(room) ?? 0) > now || (saved === undefined && (reported.get(visit) ?? 0) > now)) return;
  try {
    const stub = rooms.getByName(room);
    const id = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${room}:${credential}`))), n => n.toString(16).padStart(2, '0')).join('').slice(0, 16);
    let known = agentNames.get(credential);
    if (!known || known.until <= now) {
      if (!await stub.visit({ id })) { quiet(room, now); return; }
      known = { name: await withRuntime(env, lookup).catch(() => null) ?? 'An agent', until: now + NAME_MS };
      if (agentNames.size > 1000) agentNames.clear();
      agentNames.set(credential, known);
    }
    if (!await stub.visit({ id, name: known.name }, saved)) { quiet(room, now); return; }
    if (reported.size > 1000) reported.clear();
    reported.set(visit, now + REPORTED_MS);
  } catch { /* Presence is best-effort: the request it follows has already answered. */ }
}
function quiet(room: string, now: number) { if (quietRooms.size > 1000) quietRooms.clear(); quietRooms.set(room, now + QUIET_MS); }

// Every line names the Worker and the commit it runs (DEPLOY_SHA, set by .github/scripts/deploy-worker.sh).
function stampLogs(env: Env, core: typeof import('./core.js')) {
  core.setLogContext({ service: 'worker', deploy: (env as unknown as Record<string, unknown>).DEPLOY_SHA });
}

let cachedConfig: { key: string; config: Config } | undefined;
function configFor(env: Env, keys: readonly string[], loadConfig: (input: Record<string, unknown>) => Config): Config {
  const input: Record<string, unknown> = {};
  const record = env as unknown as Record<string, unknown>;
  for (const name of keys) if (name in record) input[name] = record[name];
  const key = JSON.stringify(input);
  if (cachedConfig?.key === key) return { ...cachedConfig.config };
  const config = loadConfig(input);
  cachedConfig = { key, config };
  return { ...config };
}

const queueName = (env: Env, key: 'FEEDBACK_QUEUE_NAME' | 'LEGACY_FEEDBACK_QUEUE_NAME' | 'FEEDBACK_DLQ_NAME' | 'LEGACY_FEEDBACK_DLQ_NAME' | 'WORK_QUEUE_NAME', fallback: string) => {
  const value: unknown = (env as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : fallback;
};
async function withRuntime<T>(env: Env, work: (runtime: Runtime) => Promise<T>, max = 1, ctx?: ExecutionContext): Promise<T> {
  const { Pool, drizzle, sql, CONFIG_KEYS, loadConfig, r2Storage, jobConcurrency, WAKE_SCHEDULE_KEY, core, browserImageRenderer, publicImageImporter, feedbackSink, workWake, enqueueShadow } = await loadRuntimeDeps();
  // Optional Worker variable, default two active jobs; six matches the platform's
  // simultaneous outbound-connection ceiling while the shared SES gate limits rate.
  const concurrency = jobConcurrency('JOB_CONCURRENCY' in env ? env.JOB_CONCURRENCY : undefined, 6);
  const config = configFor(env, CONFIG_KEYS, loadConfig);
  // The second classifier's calls are made by its queue's consumer (queue() below), never in this invocation: what a
  // job drain kept goes onto the queue when the drain has ended. With no queue bound there is nowhere to make them: off.
  const shadowQueue = env.JEVF_QUEUE, handovers: Promise<void>[] = [];
  if (!shadowQueue) config.shadow = undefined;
  // Defer Hyperdrive/Pool creation until a handler actually touches db: missing-auth,
  // validation and cached responses never allocate a pool or touch Hyperdrive.
  let client: InstanceType<typeof Pool> | undefined;
  let instance: Runtime['db'] | undefined;
  const getDb = () => {
    if (!instance) {
      client = new Pool({ connectionString: env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 10000, max });
      client.on('error', () => { /* An idle reset surfaces on the next query; teardown ignores it. */ });
      instance = drizzle(client);
    }
    return instance;
  };
  const db = new Proxy({} as Runtime['db'], {
    get(_target, prop) {
      const target = getDb();
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const nudges: ((runtime: Runtime) => Promise<void>)[] = [];
  const rooms = env.CAMPAIGN_ROOMS;
  try {
    const notify = workWake(env.WAKE_QUEUE, concurrency);
    return await work({ db, storage: r2Storage(env.ATTACHMENTS), config, shadow: shadowQueue && (items => { handovers.push(enqueueShadow(shadowQueue, items)); }), mailR2: env.MAIL && { bucket:env.MAIL,name:setting(env,'MAIL_BUCKET')!,write:setting(env,'MAIL_STORE')==='r2' }, jwksCacheScope: env.HYPERDRIVE,
      allowSnsCertMiss: async peer => (await env.SNS_CERT_MISSES.limit({key: `bane:sns-miss:${await core.digest(peer)}`})).success,
      allowMalformedSns: async peer => (await env.ADMISSION.limit({key:`bane:sns-malformed:${await core.digest(peer)}`})).success,
      // 6,000 units of 16 KiB a minute per workspace in each location: about 94 MiB of preview memory, eight previews at the limit.
      // The per-isolate budget is the memory bound, so a limiter that rejects the weight fails open.
      allowPreview:(workspaceId,bytes)=>env.ADMISSION.limit({key:`bane:preview:${workspaceId}`,delta:Math.max(1,Math.ceil(bytes/16384))} as RateLimitOptions).then(r=>r.success,()=>{core.log('warn',{code:'PREVIEW_RATE_LIMIT_UNAVAILABLE'});return true;}),
      allowFeedbackTopic:async arn=>(await env.ADMISSION.limit({key:`feedback:${arn}`})).success,
      // Dashboard analytics (src/analytics.ts): their own bucket and limiter where the config binds them. A limiter that
      // fails lets the batch through; the per-process cap still applies.
      analyticsStorage: env.ANALYTICS ? r2Storage(env.ANALYTICS) : undefined,
      allowAnalytics: env.ANALYTICS_INGEST ? peer => env.ANALYTICS_INGEST!.limit({ key: `analytics:${peer}` }).then(r => r.success, () => true) : undefined,
      // The database disk alert (src/disk-alert.ts): one card a minute per threshold. A limiter that fails lets the card through.
      allowDiskAlert: env.DISK_ALERT ? key => env.DISK_ALERT!.limit({ key: `disk-alert:${key}` }).then(r => r.success, () => true) : undefined,
      // Campaign rooms (src/campaign-room.ts). A room answers the upgrade itself; the person rides in a header only this builds.
      campaignRooms: rooms && {
        connect: (name, person) => { quietRooms.delete(name); return rooms.getByName(name).fetch('https://room/connect', { headers: { upgrade: 'websocket', [ROOM_PEER_HEADER]: encodeURIComponent(JSON.stringify(person)) } }); },
        visit: (name, credential, lookup, saved) => { const visit = roomVisit(env, rooms, name, credential, lookup, saved); if (ctx) ctx.waitUntil(visit); },
      },
      placementEdge:{probesPerJob:Math.min(3,Math.floor(6/concurrency))}, deferNudge: ctx ? pending => { nudges.push(pending); } : undefined, wake: async (readyJobs = 1, immediate) => {
      if (immediate === 'webhook' && env.WEBHOOK_QUEUE) return workWake(env.WEBHOOK_QUEUE,concurrency)(readyJobs);
      if (immediate || readyJobs > concurrency) return notify(readyJobs);
      // Only orchestration singletons coalesce. Delay past the window so the signal cannot
      // be consumed before a later coalesced commit; callback delivery never waits here.
      const reserved = await db.execute<{ wake_not_before: string }>(sql`INSERT INTO job_schedule(workspace_id, wake_not_before)
        VALUES (${WAKE_SCHEDULE_KEY}, clock_timestamp() + interval '1 second')
        ON CONFLICT (workspace_id) DO UPDATE SET wake_not_before = clock_timestamp() + interval '1 second'
        WHERE job_schedule.wake_not_before IS NULL OR job_schedule.wake_not_before <= clock_timestamp()
        RETURNING wake_not_before::text`);
      const fence = reserved.rows[0]?.wake_not_before;
      if (!fence) { core.log('info', { code: 'QUEUE_WAKE_COALESCED', readyJobs }); return; }
      try { await env.WAKE_QUEUE.send({ kind: 'wake' }, { delaySeconds: 1 }); }
      catch (error) {
        try { await db.execute(sql`UPDATE job_schedule SET wake_not_before = NULL WHERE workspace_id = ${WAKE_SCHEDULE_KEY} AND wake_not_before = ${fence}::timestamptz`); }
        catch { /* Preserve the send error; this reservation also expires on its own. */ }
        throw error;
      }
      core.log('info', { code: 'QUEUE_WAKE', readyJobs, messages: 1 });
    }, dispatch: (...args) => wakeDispatchers(env, ...args), feedback: feedbackSink(env.FEEDBACK_QUEUE, config.authSecret), renderHtmlImage: browserImageRenderer(env.BROWSER), importPublicImage: publicImageImporter() });
  } finally {
    if (client) {
      if (ctx) ctx.waitUntil(client.end().catch(() => {}));
      else await client.end();
    }
    // Sends to the second classifier's queue started when a job drain ended, already on their way.
    if (handovers.length) { if (ctx) ctx.waitUntil(Promise.all(handovers)); else await Promise.all(handovers); }
    // Dispatch and immediate webhook nudges open no database connection.
    if (ctx && nudges.length) ctx.waitUntil(withRuntime(env, async runtime => { for (const nudge of nudges) await nudge(runtime); }));
  }
}
/**
 * The support platform's service-binding entrypoint (api/README.md "Support integration"): the bane-support Worker in
 * the same account binds `{ service: "bane-production" | "bane-dev", entrypoint: "SupportPlatform" }` and calls these
 * methods over RPC. There is no token: only a Worker whose deployed config declares this binding can reach it. Every call
 * runs through the normal routes (validation, audit, budgets) as `service:bane-support`, on its own admission lane.
 */
/** Connections per support platform call: support reads (the context summary, a request's trace) run their queries in
 *  parallel. Within the six simultaneous outbound connections a Worker invocation may open (a trace also asks Workers Logs). */
const SUPPORT_POOL = 4;
export class SupportPlatform extends WorkerEntrypoint<Env> {
  private async platform(): Promise<SupportPlatformApi> {
    const [{ app, core }, { supportPlatform, platformRuntime }, { CONFIG_KEYS, loadConfig }] = await Promise.all([loadHttpDeps(), import('./support-platform.js'), import('./config.js')]);
    stampLogs(this.env, core);
    const config = () => configFor(this.env, CONFIG_KEYS, loadConfig);
    // The conversation of a request() call rides on the runtime, like the caller: no HTTP request can set either.
    return supportPlatform(async (request, conversation) => {
      if (!(await this.env.ADMISSION.limit({ key: 'bane:support-platform' })).success) return core.admissionDenied();
      return withRuntime(this.env, async runtime => app.fetch(request, { ...runtime, ...platformRuntime(conversation) }), SUPPORT_POOL, this.ctx);
    }, config);
  }
  async verifyHandoff(token: string) { return (await this.platform()).verifyHandoff(token); }
  async registerConversation(body: Parameters<SupportPlatformApi['registerConversation']>[0]) { return (await this.platform()).registerConversation(body); }
  async closeConversation(conversationId: string) { return (await this.platform()).closeConversation(conversationId); }
  async request(conversationId: string, method: string, path: string, body?: unknown) { return (await this.platform()).request(conversationId, method, path, body); }
  async mirrorMessages(conversationId: string, messages: Parameters<SupportPlatformApi['mirrorMessages']>[1]) { return (await this.platform()).mirrorMessages(conversationId, messages); }
  async mirrorState(conversationId: string, state: Parameters<SupportPlatformApi['mirrorState']>[1]) { return (await this.platform()).mirrorState(conversationId, state); }
  async inboxState(conversationId: string) { return (await this.platform()).inboxState(conversationId); }
  async pullOutbox(conversationId?: string) { return (await this.platform()).pullOutbox(conversationId); }
  async markDelivery(conversationId: string, messageId: string, status: 'sent' | 'failed') { return (await this.platform()).markDelivery(conversationId, messageId, status); }
  // A plain fetch to the entrypoint answers nothing: the methods above are the whole surface.
  override async fetch() { return new Response(null, { status: 404 }); }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      if (request.method === 'GET' || request.method === 'HEAD') { url.protocol = 'https:'; return fastSecure(Response.redirect(url.toString(), 301)); }
      return fastSecure(Response.json({ error: { code: 'HTTPS_REQUIRED', message: 'Use HTTPS.', retryable: false } }, { status: 403, headers: { 'cache-control': 'no-store' } }));
    }
    const pathname = getPath(request);
    // The events host (BYO_EVENTS_ORIGIN) takes AWS's signed notifications and nothing else.
    let eventsHost: string | undefined; try { eventsHost = new URL(String((env as { BYO_EVENTS_ORIGIN?: unknown }).BYO_EVENTS_ORIGIN)).host; } catch { eventsHost = undefined; }
    if (eventsHost && url.host === eventsHost && pathname !== '/health' && !(request.method === 'POST' && (pathname === '/v1/events/ses' || pathname === '/v1/events/cloudformation'))) return fastSecure(new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } }));
    if (pathname === '/health' && (request.method === 'GET' || request.method === 'HEAD') && !requestHeaderNames('environment').some(name => request.headers.has(name))) {
      const requestId = `req_${crypto.randomUUID().replaceAll('-', '')}`;
      const multiTenant = ('MULTI_TENANT' in env ? env.MULTI_TENANT : undefined) === 'true', analytics = (env as unknown as { DASHBOARD_ANALYTICS?: unknown }).DASHBOARD_ANALYTICS === 'on';
      // The installation's canonical origin (PUBLIC_URL), never the request's Host; omitted if PUBLIC_URL isn't a URL.
      let origin: string | undefined; try { origin = new URL(String((env as { PUBLIC_URL?: unknown }).PUBLIC_URL)).origin; if (origin === 'null') origin = undefined; } catch { origin = undefined; }
      return fastSecure(new Response(request.method==='HEAD'?null:JSON.stringify({status:'ok',service:healthService,multiTenant,...(origin ? { origin } : {}),analytics}), { headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store', 'x-request-id': requestId } }));
    }
    const staticDoc = (request.method === 'GET' || request.method === 'HEAD') && (['/openapi.json', '/docs.md', '/llms.txt'].includes(pathname) || pathname.startsWith('/docs/operations/') || pathname.startsWith('/docs/tags/'));
    const assets = (env as unknown as { ASSETS?: Fetcher }).ASSETS;
    if (assets && (request.method === 'GET' || request.method === 'HEAD') && !staticDoc && !/^\/(?:health|v1|api|mcp|\.well-known|unsubscribe|internal)(?:\/|$)/.test(pathname)) {
      // Existing files are served asset-first. Only dashboard routes get the shell on a miss. "/" on a hosted
      // installation is the homepage: home.html, the dashboard's shell with the homepage's first screen painted in it
      // (app/home-shell.ts); Workers Assets answers /home with it.
      if (pathname.startsWith('/assets/')) return fastSecure(new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } }));
      const home = pathname === '/' && ('MULTI_TENANT' in env ? env.MULTI_TENANT : undefined) === 'true';
      if (home) { const page = await assets.fetch(new Request(new URL('/home', url), request)); if (page.ok) return fastSecure(page); }
      return fastSecure(await assets.fetch(new Request(new URL('/', url), request)));
    }
    let deps: Awaited<ReturnType<typeof loadHttpDeps>> | undefined;
    try {
      deps = await loadHttpDeps();
      const { app, core } = deps;
      stampLogs(env, core);
      const admissionStarted = performance.now();
      const address = core.admissionPeer(request.headers.get('CF-Connecting-IP') ?? '127.0.0.1');
      const peer = await core.digest(core.admissionKey(address, request.headers.get('CF-Worker')));
      // SNS shares egress IPs across subscriptions. This byte-bounded route
      // verifies the signature before looking up a topic or queuing feedback.
      const feedbackIngress = core.snsIngress(pathname) && request.method === 'POST';
      const lane = gatewayLane(request.method,pathname,request.headers,'MAILGW_API_TOKEN' in env ? env.MAILGW_API_TOKEN : undefined);
      if (!feedbackIngress && !(await env.ADMISSION.limit({ key: lane ?? `bane:default:${peer}` })).success) return core.admissionDenied();
      const admissionMs = performance.now() - admissionStarted;
      const headers = new Headers(request.headers);
      for (const name of legacyClientIpHeaders) headers.delete(name);
      headers.set(clientIpHeader, address);
      // The network Cloudflare resolved the client to, never a value the request carried.
      headers.delete(clientNetworkHeader);
      // A browser's WebSocket can't send headers: the campaign room's upgrade names its account and workspace in the query,
      // which stand in for the headers the dashboard sends with every other request (sending.ts, the room route).
      if (/^\/v1\/campaigns\/[^/]+\/room$/.test(pathname) && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        for (const name of ['account', 'workspace']) { const value = url.searchParams.get(name); if (value && !requestHeaderNames(name).some(header => headers.has(header))) headers.set(requestHeaderNames(name)[0]!, value); }
      }
      const cf = (request as Request & { cf?: { asn?: unknown; country?: unknown } }).cf;
      if (typeof cf?.asn === 'number' || typeof cf?.country === 'string') headers.set(clientNetworkHeader, `${typeof cf.asn === 'number' ? `AS${cf.asn}` : ''};${typeof cf.country === 'string' ? cf.country : ''}`);
      const runtimeStarted = performance.now();
      const response = staticDoc
        ? await app.fetch(new Request(request, { headers }), {} as Runtime)
        : await core.guardPublicRequest(pathname, headers, peer, () => withRuntime(env, async runtime =>
          app.fetch(new Request(request, { headers }), runtime), 1, ctx));
      const runtimeMs = performance.now() - runtimeStarted;
      // The campaign room's accepted upgrade goes back as it is: a copy would drop its socket.
      if (response.webSocket) return response;
      const responseHeaders = new Headers(response.headers);
      const innerTiming = responseHeaders.get('server-timing');
      if(innerTiming) responseHeaders.set('server-timing', [innerTiming, `admission;dur=${admissionMs.toFixed(1)}`, `runtime;dur=${runtimeMs.toFixed(1)}`].join(', '));
      if (!(feedbackIngress && [400,429].includes(response.status))) core.log('info', { requestId: responseHeaders.get('x-request-id'), operation: 'worker-runtime', status: response.status, admissionMs: Number(admissionMs.toFixed(1)), runtimeMs: Number(runtimeMs.toFixed(1)) });
      return core.secureResponse(new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders }));
    }
    catch (error) {
      const requestId = `req_${crypto.randomUUID().replaceAll('-', '')}`;
      const known = deps && error instanceof deps.core.ApiError ? error : null;
      const code = known ? known.code : 'RUNTIME_UNAVAILABLE';
      if (deps) { stampLogs(env, deps.core); deps.core.logError(known ?? error, { event: 'request', requestId, route: 'worker-runtime', method: request.method, status: 503, code }); }
      else console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), service: 'worker', event: 'request', requestId, route: 'worker-runtime', method: request.method, status: 503, code, message: 'Unable to load the Worker runtime modules.' }));
      return fastSecure(Response.json({ error: { code, message: 'Server runtime is unavailable; use the request ID to inspect logs.', requestId, retryable: true } }, { status: 503, headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } }));
    }
  },
  // Queue/scheduled continuations preserve worker chains and retry due times.
  async queue(batch, env) {
    const { jobConcurrency, followDueJobs, core, settleFeedbackBatch, legacyFeedbackCutover } = await loadRuntimeDeps();
    stampLogs(env, core);
    const concurrency = jobConcurrency('JOB_CONCURRENCY' in env ? env.JOB_CONCURRENCY : undefined, 6);
    // Queue names differ per installation (wrangler config); an unrecognized queue is retried, never acknowledged as a wake.
    const feedbackLane = batch.queue === queueName(env, 'FEEDBACK_QUEUE_NAME', 'bane-feedback') ? 'tagged'
      : batch.queue === queueName(env, 'LEGACY_FEEDBACK_QUEUE_NAME', '') ? 'legacy'
      : batch.queue === queueName(env, 'FEEDBACK_DLQ_NAME', '') ? 'tagged-dlq'
      : batch.queue === queueName(env, 'LEGACY_FEEDBACK_DLQ_NAME', '') ? 'legacy-dlq' : undefined;
    if (feedbackLane) {
      const { ingestFeedbackBatch, archiveQueueFeedback, retainLegacyFeedback, completeLegacyFeedback } = await core.wrapModuleLoad(() => import('./operations.js'));
      // Each message is one verified callback; acknowledge and retry individually so one bad
      // payload never blocks a batch of routine deliveries. Only items this installation tagged at
      // /v1/events/ses are ingested. Only platform-dated, pre-cutover legacy items may drain unsigned;
      // newer ones are quarantined for review. Every replay is evaluated again.
      await withRuntime(env, async runtime => {
        const messages = batch.messages as readonly Message<FeedbackItem>[];
        const settled = await settleFeedbackBatch({ secrets: runtime.config, lane: feedbackLane, sourceQueue: batch.queue, messages,
          legacyCutover: legacyFeedbackCutover('LEGACY_FEEDBACK_CUTOVER' in env ? env.LEGACY_FEEDBACK_CUTOVER : undefined),
          ingest: items => ingestFeedbackBatch(runtime, items),
          promoteLegacy: async item => {
            if (await retainLegacyFeedback(runtime, item) === 'storage') return;
            try { await env.FEEDBACK_QUEUE.send(item); }
            catch { core.log('warn', { code: 'FEEDBACK_LEGACY_RECOVERY_PENDING', sourceQueue: item.source.queue, sourceId: item.source.id }); }
          }, completeLegacy: item => completeLegacyFeedback(runtime, item),
          archive: (source,body,error) => archiveQueueFeedback(runtime,source,body,error) });
        const { outcomes: _, ...counts } = settled, oldestMs=Math.max(0,...messages.map(m=>Date.now()-m.timestamp.getTime()));
        core.log(counts.failed || counts.untagged || counts.unauthenticated || counts.held || oldestMs>60000?'warn':'info', { code: 'FEEDBACK_BATCH', lane: feedbackLane, size: messages.length, ...counts, oldestMs });
      });
      return;
    }
    // The second classifier's queue (src/screen-shadow.ts): each message is one request the content screen made. Its
    // consumer is the only place on Cloudflare that calls the second classifier: wrangler gives it at most
    // max_batch_size 4 messages an invocation (four calls and the database's connection, of an invocation's six) and
    // max_concurrency 2 invocations, eight calls in all. A batch whose rows are written is acknowledged; one whose rows
    // could not be written is delivered again (max_retries, no dead-letter queue), and then only recorded as lost.
    if (env.JEVF_QUEUE_NAME && batch.queue === env.JEVF_QUEUE_NAME) {
      const { consumeShadow, writeComparisons, writtenComparisons } = await loadRuntimeDeps();
      await withRuntime(env, async runtime => {
        const settings = runtime.config.shadow;
        if (!settings) { batch.ackAll(); return; } // Turned off since they were queued: the messages are dropped.
        const done = await consumeShadow(settings, { write: rows => writeComparisons(runtime.db, rows), written: ids => writtenComparisons(runtime.db, ids) },
          batch.messages.map(message => ({ body: message.body, attempts: message.attempts })));
        if (done) batch.ackAll(); else batch.retryAll();
      });
      return;
    }
    const hooks = batch.queue === env.WEBHOOK_QUEUE_NAME, pool = hooks ? 'webhooks' : 'work';
    if (!hooks && batch.queue !== queueName(env, 'WORK_QUEUE_NAME', 'bane-work')) {
      core.log('error', { code: 'UNKNOWN_QUEUE', queue: batch.queue });
      batch.retryAll();
      return;
    }
    const { drainJobs } = await core.wrapModuleLoad(() => import('./dispatch.js'));
    await withRuntime(env, async runtime => {
      // Orchestration only (mail is dispatched by Durable Objects): a longer budget lets a campaign's
      // prepare → expand → finish chain run inside one invocation instead of one queue hop per step.
      // Wait in place up to 45 s for a job due soon (paced campaign releases), and schedule at most one follow-up.
      const outcome = await followDueJobs(runtime, () => drainJobs(runtime, 100, concurrency, 10000,pool), delaySeconds => (hooks?env.WEBHOOK_QUEUE:env.WAKE_QUEUE).send({ kind: 'wake' }, { delaySeconds }), 45000,pool);
      core.log('info', { code: 'QUEUE_FOLLOW', outcome });
    }, concurrency);
    batch.ackAll();
  },
  async scheduled(controller, env) {
    const { jobConcurrency, followDueJobs, core } = await loadRuntimeDeps();
    stampLogs(env, core);
    const [{ dispatchPartitions, drainJobs }, { reconcileSharedConnections }, { syncOutboundMessages }, { publicStatsTick }] = await core.wrapModuleLoad(() => Promise.all([
      import('./dispatch.js'), import('./provider-connections.js'), import('./mailbox-send.js'), import('./public-stats.js'),
    ]));
    const concurrency = jobConcurrency('JOB_CONCURRENCY' in env ? env.JOB_CONCURRENCY : undefined, 6);
    await withRuntime(env, async runtime => {
      if (controller.cron === '7 * * * *') {
        const [{ hourlyUpkeep }, { resolveRegionRuntime }] = await core.wrapModuleLoad(() => Promise.all([import('./maintenance.js'), import('./ses-region-state.js')]));
        // Each step is best-effort: a failing cleanup no longer skips upload reconciliation and receipt recovery.
        await hourlyUpkeep(runtime, () => resolveRegionRuntime(runtime));
      }
      // Minute ping: recovers dispatchers that missed a nudge and expired-lease or interrupted rows.
      // Mailbox outbound status and Message-IDs follow the sending pipeline; best-effort.
      if (controller.cron !== '* * * * *') return;
      // Independent of PostgreSQL: even a total DB outage must not hide DLQ growth.
      await Promise.all([['feedback',env.FEEDBACK_QUEUE],['feedback-dlq',env.FEEDBACK_DLQ],['legacy-feedback-dlq',env.LEGACY_FEEDBACK_DLQ],['work',env.WAKE_QUEUE],['webhooks',env.WEBHOOK_QUEUE]].map(async pair=>{
        const [name,q]=pair as [string,Queue]; if(!q?.metrics)return;
        try{const m=await q.metrics(),oldestMs=m.oldestMessageTimestamp?Math.max(0,Date.now()-m.oldestMessageTimestamp.getTime()):0;
          const alarm=(name.endsWith('feedback-dlq') && m.backlogCount>0) || oldestMs>60000;
          core.log(alarm?'error':'info',{code:alarm?'QUEUE_BACKLOG_ALERT':'QUEUE_BACKLOG',queue:name,depth:m.backlogCount,oldestMs});
        }catch{core.log('warn',{code:'QUEUE_METRICS_UNAVAILABLE',queue:name});}
      }));
      try { const { drainFeedbackRecovery } = await import('./operations.js'); await drainFeedbackRecovery(runtime); }
      catch { core.log('error',{code:'FEEDBACK_RECOVERY_DRAIN_FAILED'}); }
      await reconcileSharedConnections(runtime); // Installation work must not depend on a workspace or a successful queue drain.
      try { await syncOutboundMessages(runtime); } catch (error) { core.log('warn', { code: error instanceof core.ApiError ? error.code : 'MAILBOX_OUTBOUND_SYNC_FAILED' }); }
      // Received mail queued for the refilling budget comes due within minutes; the drain below runs its release.
      try { await (await core.wrapModuleLoad(() => import('./mailbox-staging.js'))).scheduleHoldRelease(runtime); } catch (error) { core.log('warn', { code: error instanceof core.ApiError ? error.code : 'MAILBOX_HOLD_RELEASE_FAILED' }); }
      await Promise.allSettled((await dispatchPartitions(runtime, true)).map(({ region, accountId, kind }) => wakeDispatchers(env, region, accountId, undefined, kind)));
      // Minute cron: recover orchestration jobs whose wake was lost.
      await followDueJobs(runtime, () => drainJobs(runtime, 100, concurrency, 10000,'work'), delaySeconds => env.WAKE_QUEUE.send({ kind: 'wake' }, { delaySeconds }),0,'work');
      if (env.WEBHOOK_QUEUE) await followDueJobs(runtime, async()=>{}, delaySeconds=>env.WEBHOOK_QUEUE.send({kind:'wake'},{delaySeconds}),0,'webhooks');
      // Last, after recovery: GET /v1/public/stats serves only what this writes. Best-effort and time-bounded.
      await publicStatsTick(runtime);
      // Sender standing: every ten minutes (elected), the score, limit and ladder of each Hosted workspace.
      if (runtime.config.multiTenant) await (await core.wrapModuleLoad(() => import('./standing.js'))).standingTick(runtime);
      // Billing: the auto-recharge sweep and Stripe reconciliation (elected every 5 minutes).
      if (runtime.config.multiTenant) try { await (await core.wrapModuleLoad(() => import('./billing/stripe-jobs.js'))).billingMinute(runtime); } catch (error) { core.log('warn', { code: error instanceof core.ApiError ? error.code : 'BILLING_MINUTE_FAILED' }); }
      // Last, as it can take minutes: retention of the sent-side tables (elected every 15 minutes).
      try { await (await core.wrapModuleLoad(() => import('./maintenance.js'))).retentionTick(runtime); } catch (error) { core.log('warn', { code: error instanceof core.ApiError ? error.code : 'RETENTION_TICK_FAILED' }); }
    }, concurrency);
  },
} satisfies ExportedHandler<Env>;
