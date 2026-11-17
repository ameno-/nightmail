import { sql, type SQL } from 'drizzle-orm';
import { ApiError, notFound, type DbExecutor } from './core.js';

declare const held: unique symbol, unlocked: unique symbol;
/**
 * Proof that this transaction holds a workspace's send locks, taken in the one order every path that sends, launches
 * a campaign or changes a sending connection uses: the campaign row (when one is named), then the admission row
 * (job_schedule), then the settings row; sender claims and attachments only after them. Only lockSendScope and
 * claimSendScope make one, and what reads settings or sender claims in those paths takes one, so the type checker
 * holds the order. Two paths that took them in other orders deadlocked (dev, Nov 12; launch against a BYO disconnect).
 */
export type SendScope = { readonly [held]: true; readonly workspaceId: string };
/**
 * A sender-claim read in a transaction that holds no admission or settings lock and takes none after it (dispatch, a
 * campaign's prepare step, a check outside a transaction): its claim locks come last there, so they close no cycle.
 */
export type ClaimsOnly = { readonly [unlocked]: true };
export const claimsOnly = {} as ClaimsOnly;
const scope = (workspaceId: string) => ({ workspaceId }) as SendScope;

// A workspace row lock serializes admission without Hyperdrive-unsupported advisory locks. It reuses the scheduler
// row without changing its rotation counter: ON CONFLICT locks the existing tuple even when its UPDATE predicate is
// false, so no dead tuple per send.
const admission = (workspaceId: string, from?: SQL) => sql`INSERT INTO job_schedule (workspace_id) SELECT ${workspaceId}::text ${from ?? sql``}
  ON CONFLICT (workspace_id) DO UPDATE SET turn = job_schedule.turn WHERE false`;

/**
 * Takes a workspace's send locks in order: the campaign row, the admission row, then (when asked) the settings row.
 * Paths that read settings with their sender claims in one statement lock it there instead (lockedSettings).
 */
export async function lockSendScope(db: DbExecutor, workspaceId: string, options: { campaignId?: string; settings?: 'share' | 'update' } = {}): Promise<SendScope> {
  // The admission insert reads the locked campaign row, so one statement takes them in order.
  if (options.campaignId && !(await db.execute(sql`WITH campaign AS MATERIALIZED (SELECT FROM sending_campaigns WHERE workspace_id=${workspaceId} AND id=${options.campaignId} FOR UPDATE),
    locked AS (${admission(workspaceId, sql`FROM campaign`)}) SELECT FROM campaign`)).rowCount) notFound('Campaign');
  if (!options.campaignId) await db.execute(admission(workspaceId));
  if (options.settings && !(await db.execute(sql`SELECT FROM ses_installation_settings WHERE workspace_id=${workspaceId} ${options.settings === 'update' ? sql`FOR UPDATE` : sql`FOR SHARE`}`)).rowCount)
    throw new ApiError(503, 'REGION_SETTINGS_NOT_INITIALIZED', 'Run database migrations to initialize SES region settings.');
  return scope(workspaceId);
}
/** A direct send's idempotency claim and its admission lock in one statement: only the winning claim takes the lock. */
export async function claimSendScope(db: DbExecutor, workspaceId: string, claim: SQL) {
  const claimed = (await db.execute(sql`WITH claim AS (${claim}), locked AS (${admission(workspaceId, sql`FROM claim`)}) SELECT 1 FROM claim`)).rows;
  return { claimed, scope: claimed.length ? scope(workspaceId) : null };
}
/**
 * The settings row, share-locked as the first CTE of a statement that reads sender claims after it: regional_sender
 * and verified_sending_domains lock the closest claim, and reservations and connection changes take settings before claims.
 */
export const lockedSettings = (held: SendScope) => sql`settings AS MATERIALIZED (SELECT workspace_id,default_region,enabled_regions FROM ses_installation_settings WHERE workspace_id=${held.workspaceId} FOR SHARE)`;
