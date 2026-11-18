import { errorCodeOf } from '../../api/src/log.js';
import { BaneError } from './bane.js';
import { MissingSecret } from './tokens.js';
import { log } from './log.js';

export type WorkState = 'pending' | 'blocked' | 'parked' | 'done' | 'held' | 'dead';
export type NewWork = { id: string; kind: string; payload: object; state?: 'pending' | 'parked' };
export type WorkRow = { id: string; kind: string; payload: string; result: string; attempts: number; created_at: number };
export type Outcome = { state?: 'done' | 'held' | 'parked'; result?: object; children?: NewWork[] };

class BindingError extends Error {}
/** A rejected storage, network or RPC operation is retryable. Don't persist its exception text. */
export async function external<T>(p: Promise<T>): Promise<T> {
  try { return await p; }
  catch (e) { if (e instanceof BaneError || e instanceof MissingSecret) throw e; throw new BindingError(); }
}

const permanent = new Set(['INBOUND_RECIPIENTS_CHANGED', 'REPLY_TO_AUTOMATED', 'REPLY_TO_NO_REPLY', 'SELF_SEND', 'RECIPIENT_REQUIRED']);
function failure(e: unknown, attempts: number, now: number) {
  const api = e instanceof BaneError ? e : null;
  const code = api ? errorCodeOf(api.code) : e instanceof MissingSecret ? 'MISSING_SECRET' : e instanceof BindingError ? 'BINDING_ERROR' : 'UNKNOWN_ERROR';
  const config = api && ([401, 403, 404].includes(api.status) || ['SUPPORT_NOT_CONFIGURED', 'IDEMPOTENCY_OUTCOME_UNKNOWN', 'IDEMPOTENCY_CONFLICT'].includes(code));
  const transient = e instanceof BindingError || (!config && api && (api.status >= 500 || api.status === 429 ||
    (api.status === 409 && ['IDEMPOTENCY_IN_PROGRESS', 'REPLY_TARGET_NOT_ACCEPTED'].includes(code))));
  const state = !config && !transient && api && api.status >= 400 && api.status < 500 && permanent.has(code) ? 'dead' : transient ? 'pending' : 'blocked';
  const delays = state === 'pending' ? [1, 2, 5, 15, 30, 60] : [5, 15, 60];
  const minutes = delays[Math.min(attempts, delays.length) - 1]!;
  const due = Math.max(now + 60_000, now + Math.round(minutes * 60_000 * (0.9 + Math.random() * 0.2)), api?.retryAt ?? 0);
  const request = api?.requestId && /^req_[a-f0-9]{32}$/.test(api.requestId) ? `:${api.requestId}` : '';
  return { state, due, error: `${state === 'dead' ? 'permanent' : transient ? 'transient' : 'config'}:${api?.status ?? 0}:${code}${request}` } as const;
}

const runnable = "state IN ('pending','blocked')";
export class WorkQueue {
  private readonly sql: SqlStorage;
  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS _support_work (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending'
        CHECK(state IN ('pending','blocked','parked','done','held','dead')),
      due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL,
      result TEXT NOT NULL DEFAULT '{}', parent TEXT, last_error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, mirrored_at INTEGER);
      CREATE INDEX IF NOT EXISTS _support_work_due ON _support_work(state,due_at)`);
  }

  insert(item: NewWork, parent: string | null = null) {
    const now = Date.now();
    this.sql.exec('INSERT INTO _support_work(id,kind,state,payload,parent,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
      item.id, item.kind, item.state ?? 'pending', JSON.stringify(item.payload), parent, now, now, now);
  }

  checkpoint(id: string, result: object) {
    this.sql.exec('UPDATE _support_work SET result=?, updated_at=? WHERE id=?', JSON.stringify(result), Date.now(), id);
  }

  /** Whether any item still has to run (parked items wait for someone else and don't count). */
  open() {
    return this.sql.exec(`SELECT 1 FROM _support_work WHERE ${runnable} LIMIT 1`).toArray().length > 0;
  }

  /** The alarm: the earliest due item, or the owner's next deadline (null: none) if sooner. Never in the past. */
  arm(deadline: number | null = null) {
    const { due } = this.sql.exec<{ due: number | null }>(`SELECT min(due_at) AS due FROM _support_work WHERE ${runnable}`).one();
    const next = due === null ? deadline : deadline === null ? due : Math.min(due, deadline);
    return next === null ? this.storage.deleteAlarm() : this.storage.setAlarm(Math.max(Date.now(), next));
  }

  /** Only called from alarm(): workerd runs at most one alarm handler per object. RPCs can enqueue during I/O. */
  async drain(run: (item: WorkRow) => Promise<Outcome>, transitioned: (item: WorkRow, state: WorkState) => void, deadline: () => number | null = () => null) {
    const end = Date.now() + 30_000;
    for (let i = 0; i < 20 && Date.now() < end; i++) {
      const item = this.sql.exec<WorkRow>(`UPDATE _support_work SET attempts=attempts+1, updated_at=? WHERE id=(
        SELECT id FROM _support_work WHERE ${runnable} AND due_at<=? ORDER BY due_at,created_at,rowid LIMIT 1)
        RETURNING id,kind,payload,result,attempts,created_at`, Date.now(), Date.now()).toArray()[0];
      if (!item) break;
      try {
        const { state = 'done', result = {}, children = [] } = await run(item);
        this.storage.transactionSync(() => {
          for (const child of children) this.insert(child, item.id);
          this.sql.exec('UPDATE _support_work SET state=?, result=?, last_error=NULL, updated_at=? WHERE id=?', state, JSON.stringify(result), Date.now(), item.id);
          transitioned(item, state);
        });
      } catch (e) {
        const now = Date.now(), { state, due, error } = failure(e, item.attempts, now);
        this.storage.transactionSync(() => {
          this.sql.exec('UPDATE _support_work SET state=?, due_at=?, last_error=?, updated_at=? WHERE id=?', state, due, error, now, item.id);
          transitioned(item, state);
        });
        log('warn', { event: 'work', kind: item.kind, state, attempts: item.attempts, error });
      }
    }
    await this.arm(deadline());
  }
}
