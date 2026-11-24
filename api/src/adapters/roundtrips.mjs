// Lab only: imported by the acceptance preload, never by an application entrypoint.
// Observe the pinned pg driver's wire dispatch/completion, not Drizzle promises:
// checkout and the per-client queue can serialize queries the handler started together.
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { createHash } from 'node:crypto';

const samples = new AsyncLocalStorage();
export const observeSample = (label, run) => {
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(label)) throw Error('Use a fixed scenario label, never a request value');
  return samples.run(label, run);
};
const requests = new AsyncLocalStorage(), owners = new WeakMap(), active = new WeakMap();
let installed, submitting;

// Only verbs and schema names from checked-in migrations leave the driver. Never log params or SQL text.
function shapes(sql, relations) {
  const clean = sql.replace(/--[^\n\r]*|\/\*[\s\S]*?\*\/|(?:\$([a-z_]\w*|)\$)[\s\S]*?\$\1\$|(?:[eE])?'(?:''|\\[\s\S]|[^'])*'/gi, ' ? ');
  return clean.split(';').filter(s => s.trim()).map(s => {
    const tokens = s.toLowerCase().match(/[a-z_][a-z_0-9]*/g) ?? [];
    const verbs = tokens.filter(t => ['select','insert','update','delete','merge','begin','commit','rollback','savepoint','release','set','notify','with','copy','show','values','listen'].includes(t));
    const normalized = s.toLowerCase().replace(/\$\d+|\b\d+(?:\.\d+)?\b/g, '?').replace(/\s+/g, ' ').trim();
    const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
    return [tokens[0]==='rollback' && tokens[1]==='to' ? 'rollback-to' : verbs[0] ?? 'other', ...[...new Set(tokens.filter(t => relations.has(t)))].slice(0, 12), hash].join(' ');
  });
}
export function observePg(relations) {
  if (installed) return;
  installed = true;
  const poolConnect = pg.Pool.prototype.connect;
  pg.Pool.prototype.connect = function (cb) {
    // A pool waiter can be served in a different request's context when it releases a client.
    return poolConnect.call(this, typeof cb === 'function' ? AsyncLocalStorage.bind(cb) : cb);
  };
  const cq = pg.Client.prototype.query;
  pg.Client.prototype.query = function (...args) {
    const prev = submitting, frame = { trace: requests.getStore(), client: this };
    submitting = frame;
    try { return cq.apply(this, args); }
    finally {
      // An idle client submitted synchronously. A busy client's new Query is still queued.
      const q = this._queryQueue.at(-1);
      if (q && !owners.has(q)) owners.set(q, frame);
      submitting = prev;
    }
  };
  const proto = pg.Query.prototype, submit = proto.submit, complete = proto.handleCommandComplete;
  proto.submit = function (connection) {
    const frame = owners.get(this) ?? submitting;
    if (frame?.trace && !frame.trace.closed) {
      const sql = shapes(this.text ?? '', relations), observations = [];
      for (let trace = frame.trace; trace && !trace.closed; trace = trace.parent) {
        const wire = trace.clients.get(connection) ?? trace.clients.size + 1;
        trace.clients.set(connection, wire);
        const event = { wire, txBefore: frame.client.getTransactionStatus(), wave: trace.depth + 1, sql, commands: [] };
        trace.flights.push(event); observations.push([trace, event]);
      }
      active.set(this, observations);
    }
    return submit.call(this, connection);
  };
  proto.handleCommandComplete = function (msg, connection) {
    // One CommandComplete per SQL statement, even when a single exchange carries several.
    const verb = String(msg.text).split(' ', 1)[0];
    for (const [, e] of active.get(this) ?? []) e.commands.push(/^[A-Z]+$/.test(verb) ? verb : 'OTHER');
    return complete.call(this, msg, connection);
  };
  for (const name of ['handleReadyForQuery', 'handleError']) {
    const original = proto[name];
    proto[name] = function (...args) {
      for (const [trace, e] of active.get(this) ?? []) {
        trace.depth = Math.max(trace.depth, e.wave);
        if (name === 'handleError') e.commands.push('ERROR');
        e.done = true;
      }
      active.delete(this);
      return original.apply(this, args);
    };
  }
}
export async function observeRequest(c, next, emit) {
  const trace = { parent: requests.getStore(), clients: new Map(), flights: [], depth: 0, closed: false };
  return requests.run(trace, async () => {
    try { return await next(); }
    finally {
      trace.closed = true;
      const routes = c.req.matchedRoutes.filter(r => !r.path.endsWith('*'));
      const route = (routes.findLast(r => r.method !== 'ALL') ?? routes.findLast(r => r.handler.length < 2))?.path;
      // The router registered this template. Never use a raw URL (it can contain a credential).
      if (route && c.get('requestId') && c.res.status < 400) {
        const actor = c.get('actor'), support = c.get('support');
        const credential = c.get('principal')?.type ?? actor?.credential ?? (c.get('mailboxAccess') ? 'inboxKey' : support ? 'support' : 'anonymous');
        const auth = c.req.raw.headers.has('authorization') ? 'bearer' : c.req.raw.headers.has('cookie') ? 'cookie' : 'none';
        emit({ sample: samples.getStore(), requestId: c.get('requestId'), method: c.req.method, route, status: c.res.status, credential, auth,
          idem: c.req.raw.headers.has('idempotency-key'), firstPage: !c.req.query('cursor'), hosted: !!c.env?.config?.multiTenant, nested: !!trace.parent, depth: trace.depth, flights: trace.flights });
      }
    }
  });
}
