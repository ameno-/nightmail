import type { RoutingResult } from './routing-match.js';

// Wake-on-store for inbox long polls (GET /v1/inboxes/{id}/messages?wait=…, auth.ts longPoll). A poll reads once a
// second; watching its inbox, it reads again as soon as mail it may be waiting for is stored. Ingest says so right after the
// write that stores the mail commits: the store #756's receipt drain runs (mailbox-ingest.ts) and a sandbox's simulated
// message (sandbox-inbox.ts). The once-a-second read stays as the fallback, so a lost wake costs only the old wait.
// - Workers: one object per workspace in the DISPATCHER namespace holds each poll's watch and ends it on a wake, as it
//   already wakes a dispatch run (dispatcher-do.ts).
// - Node: this process's waiters at once, and the others (the runner stores, the API serves the poll) by a pg_notify in
//   the statement that stores the mail (storeNotice), heard at its commit and costing no statement of its own:
//   adapters/node.ts nodeInboxWake.

export type InboxWatch = {
  /** Resolves when mail for this inbox (or for all of the workspace's) is stored; never on its time running out or an error. */
  woken: Promise<void>;
  /** Stops watching. */
  cancel(): void;
};
export type InboxWake = {
  /** Watches for ms at most. */
  watch(workspaceId: string, inboxId: string, ms: number): InboxWatch;
  /** After mail is stored: the inboxes it went to, or null when that isn't known (every inbox of the workspace). Never throws. */
  notify(workspaceId: string, inboxIds: readonly string[] | null): Promise<void>;
  /** Node: the channel the statement that stores mail notifies on (storeNotice), for the polls of the other processes. */
  channel?: string;
};
/** What the statement that stores mail notifies on its commit (mailbox-ingest-store.ts): a channel and its payload. */
export type StoreNotice = readonly [channel: string, payload: string];

/** The store statement's notice for these inboxes, when the wake has a channel. */
export function storeNotice(wake: InboxWake | undefined, workspaceId: string, inboxIds: readonly string[] | null): StoreNotice | null {
  if (!wake?.channel) return null;
  const ids = inboxIds?.join(',') ?? '*';
  // A payload must stay under 8,000 bytes: past that, wake every inbox of the workspace.
  return [wake.channel, `${workspaceId}:${ids.length > 7000 ? '*' : ids}`];
}
/** A notice's payload: its workspace and inboxes (null: every inbox), or null when it is not one. */
export function readNotice(payload: string): { workspaceId: string; inboxIds: string[] | null } | null {
  const at = payload.indexOf(':'), ids = payload.slice(at + 1);
  return at > 0 ? { workspaceId: payload.slice(0, at), inboxIds: ids === '*' ? null : ids.split(',').filter(Boolean) } : null;
}

/** One workspace's watching polls. */
export class InboxWaiters {
  private waiting = new Set<{ inbox: string; end: (woken: boolean) => void }>();
  get size() { return this.waiting.size; }
  /** True when woken, false when ms ran out or the signal aborted. */
  wait(inbox: string, ms: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
      const stop = () => entry.end(false);
      const entry = { inbox, end: (woken: boolean) => { clearTimeout(timer); this.waiting.delete(entry); signal?.removeEventListener('abort', stop); resolve(woken); } };
      const timer = setTimeout(stop, Math.max(0, ms));
      this.waiting.add(entry);
      if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
    });
  }
  wake(inboxes: readonly string[] | null) {
    for (const entry of [...this.waiting]) if (!inboxes || inboxes.includes(entry.inbox)) entry.end(true);
  }
}

/** The longest watch: a poll's longest wait (30 s) and a little. */
export const MAX_WATCH_MS = 31_000;
/** A promise that resolves only when `woken` says so. */
export const onlyWhenWoken = (woken: Promise<boolean>) => new Promise<void>(resolve => { void woken.then(yes => { if (yes) resolve(); }, () => {}); });

/** The inboxes routed messages reached; null when an inbox may be made for one as it is stored (a catch-all), or one is
 *  unrouted (no rules: the store finds its inboxes). */
export function wakeTargets(plans: readonly (RoutingResult | null | undefined)[]): string[] | null {
  if (plans.some(plan => !plan || plan.recipients.some(r => r.tier === 'default' && !r.dropped))) return null;
  return [...new Set(plans.flatMap(plan => plan!.recipients.flatMap(r => r.inboxes)))];
}

/** The object's side (dispatcher-do.ts): GET /inbox/wait?inbox=&ms= answers 200 on a wake, 204 when ms ran out; POST /inbox/wake {inboxes}. */
export async function serveInboxWake(waiters: InboxWaiters, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/inbox/wait' && request.method === 'GET') {
    const inbox = url.searchParams.get('inbox') ?? '', ms = Math.min(MAX_WATCH_MS, Math.max(0, Number(url.searchParams.get('ms')) || 0));
    if (!inbox) return new Response('inbox required', { status: 400 });
    return new Response(null, { status: await waiters.wait(inbox, ms, request.signal) ? 200 : 204 });
  }
  if (url.pathname === '/inbox/wake' && request.method === 'POST') {
    const body = await request.json().catch(() => null) as { inboxes?: unknown } | null;
    const inboxes = Array.isArray(body?.inboxes) ? body.inboxes.filter((id): id is string => typeof id === 'string') : null;
    waiters.wake(inboxes);
    return new Response(null, { status: 204 });
  }
  return new Response('Not found', { status: 404 });
}

type Namespace = { getByName(name: string): { fetch(input: string, init?: RequestInit): Promise<Response> } };
const objectName = (workspaceId: string) => `inbox-wake:${workspaceId}`;

/** Workers: the workspace's object holds the watch. One out of reach never wakes it, so the poll keeps its second's read. */
export function durableInboxWake(namespace: Namespace): InboxWake {
  return {
    watch(workspaceId, inboxId, ms) {
      const controller = new AbortController(), wait = Math.min(MAX_WATCH_MS, Math.max(0, Math.round(ms)));
      const woken = namespace.getByName(objectName(workspaceId))
        .fetch(`https://inbox-wake/inbox/wait?inbox=${encodeURIComponent(inboxId)}&ms=${wait}`, { signal: controller.signal })
        .then(response => { void response.body?.cancel(); return response.status === 200; });
      return { woken: onlyWhenWoken(woken), cancel: () => controller.abort() };
    },
    async notify(workspaceId, inboxIds) {
      try {
        const response = await namespace.getByName(objectName(workspaceId)).fetch('https://inbox-wake/inbox/wake',
          { method: 'POST', body: JSON.stringify({ inboxes: inboxIds }), headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(1000) });
        void response.body?.cancel();
      } catch { /* The watching polls still read on their second. */ }
    },
  };
}
