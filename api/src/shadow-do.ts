import { DurableObject } from 'cloudflare:workers';
import type { Pool } from 'pg';
import type { ComparisonRow, ShadowItem, ShadowRunner, ShadowSettings } from './screen-shadow.js';

function initDeps() {
  return Promise.all([import('pg'), import('drizzle-orm/node-postgres'), import('./config.js'), import('./core.js'), import('./screen-shadow.js')])
    .then(([{ Pool }, { drizzle }, { loadConfig }, { log, logError, setLogContext }, { ShadowRunner, writeComparisons }]) => ({ Pool, drizzle, loadConfig, log, logError, setLogContext, ShadowRunner, writeComparisons }));
}
let depsPromise: ReturnType<typeof initDeps> | undefined;
function loadDeps() {
  return depsPromise ??= initDeps().catch(async error => {
    depsPromise = undefined;
    const core = await import('./core.js').catch(() => null);
    throw core ? (error instanceof core.ModuleLoadError ? error : new core.ModuleLoadError(error)) : error;
  });
}

// The one object that calls the second classifier on Cloudflare (src/screen-shadow.ts). A dispatcher shard or a job
// consumer hands it the requests the screen made, when its own run or drain has ended; this object repeats them and
// writes the screen_comparisons rows. So no call to the second classifier, which may take seconds, ever shares an
// invocation (and its six connections) with SES sends or the screen's own requests, and being one object its cap on calls
// in flight, its Retry-After pause and its breaker are the installation's.
//
// Requests wait in memory only: a deploy or an eviction loses the ones not yet repeated, and nothing is stored but rows.
// Calls are made only in alarm(), and, as on a dispatcher shard (src/dispatcher-do.ts), not once a request has landed
// during it: Cloudflare labels an object's outbound calls with the visitor of its current request, a hand-over is a
// request, and the alarm that follows it has none. A hand-over only queues and arms the alarm; a hand-over that lands
// mid-alarm stops new calls, the alarm waits out the ones in flight and ends, and the follow-up alarm goes on.

const RUN_MS = 45000; // Re-arm well inside the alarm's wall-clock budget.
// An invocation waits on at most six connections: five calls and the one database connection.
const MAX_CALLS = 5;

export class ScreenShadow extends DurableObject<Env> {
  private pool?: Pool;
  private runner?: ShadowRunner | null;
  private alarmActive = false;
  private landed = false;
  private until = 0;

  /** The second classifier's settings and where rows are written, or null when it is not configured. */
  private async parts(): Promise<{ settings: ShadowSettings; write: (rows: ComparisonRow[]) => Promise<void> } | null> {
    const { Pool, drizzle, loadConfig, setLogContext, writeComparisons } = await loadDeps();
    setLogContext({ service: 'worker', deploy: (this.env as unknown as Record<string, unknown>).DEPLOY_SHA });
    const settings = loadConfig({ ...this.env }).shadow;
    if (!settings) return null;
    return { settings, write: async rows => {
      if (!this.pool) {
        this.pool = new Pool({ connectionString: this.env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 10000, max: 1, idleTimeoutMillis: 30000 });
        this.pool.on('error', () => { /* Idle client errors surface on the next write, which recreates the pool. */ });
      }
      try { await writeComparisons(drizzle(this.pool), rows); }
      catch (error) { const pool = this.pool; this.pool = undefined; try { await pool?.end(); } catch { /* already closed */ } throw error; }
    } };
  }
  private async shadow(): Promise<ShadowRunner | null> {
    if (this.runner !== undefined) return this.runner;
    const { ShadowRunner } = await loadDeps(), parts = await this.parts();
    // Calls start only inside an alarm, before any request has landed on it, within its run budget.
    return this.runner = parts ? new ShadowRunner(parts.settings, parts.write, { limit: MAX_CALLS, may: () => this.alarmActive && !this.landed && Date.now() < this.until }) : null;
  }

  async fetch(request: Request): Promise<Response> {
    // First, before anything can await: this request is now the current one (see the top of this file).
    if (this.alarmActive) this.landed = true;
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/items') return new Response('Not found', { status: 404 });
    try {
      const runner = await this.shadow();
      if (!runner) { await request.body?.cancel(); return new Response(null, { status: 204 }); } // Not configured: nothing is kept.
      const body = await request.json() as { items?: unknown };
      if (Array.isArray(body?.items)) runner.accept(body.items as ShadowItem[]);
      // Idle, the alarm starts now. Mid-alarm, getAlarm is null unless something set one since it began, so this arms the follow-up.
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > Date.now()) await this.ctx.storage.setAlarm(Date.now());
      return new Response(null, { status: 202 });
    } catch (error) {
      const deps = await loadDeps().catch(() => undefined);
      deps?.logError(error, { code: 'SCREEN_SHADOW_FAILED' }, 'warn');
      return new Response(null, { status: 500 });
    }
  }

  async alarm(): Promise<void> {
    this.alarmActive = true; this.landed = false; this.until = Date.now() + RUN_MS;
    let waiting = 0;
    try {
      const runner = await this.shadow();
      if (runner) { runner.pump(); await runner.settled(); waiting = runner.waiting; }
    } catch (error) {
      // Never throws: the platform would retry the alarm, and there is nothing durable to retry.
      const deps = await loadDeps().catch(() => undefined);
      deps?.logError(error, { code: 'SCREEN_SHADOW_FAILED' }, 'warn');
    } finally { this.alarmActive = false; }
    // Requests still waiting (the run budget ended, or a hand-over landed): the next alarm goes on, unless one is set.
    try { if (waiting && await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now()); } catch { /* The next hand-over arms it. */ }
  }
}
