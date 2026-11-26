import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { ApiError, wrapModuleLoad, type Config, type Ctx, type DbExecutor } from './core.js';
import type { OperatorIdentity } from './operator.js';

// Approvals: a decision staff make with one click from an email, never by the click alone. Something proposes an
// action on a support conversation (Nightmail's staff email, or the agent for a risky action), and the email
// carries a signed link to the conversation with that action ready to confirm. Mail scanners follow links, so opening
// the link does nothing: an operator signed in to the dashboard (the operator role) confirms or declines it there, once,
// before it expires. Each kind says in fixed words what it does, and runs through the same code as the dashboard's own
// button for it. A new kind is a new entry in KINDS (its words and its run), nothing else.

/** How long a proposal can be approved. */
export const APPROVAL_HOURS = 72;

/**
 * What a kind runs with: the same code as the dashboard's own buttons, inside the decision's transaction, as the operator
 * who approved it. wake: Retry now; sendDraft: Send on a held answer, as the agent wrote it (refused when it needs a fresh
 * reply, or a newer reply reached the customer first). A risky kind runs the operator console's own change (operator.ts
 * operatorChanges, billing grantPromoCredit) with tx, c and operator, and writes the console's audit row; userId is the
 * conversation's person, whose own workspace the target must still be when it runs.
 */
type Deps = { wake: (conversationId: string) => Promise<boolean>; sendDraft: (messageId: string) => Promise<{ id: string }>;
  tx: DbExecutor; c: Ctx; operator: OperatorIdentity; userId: string | null; approvalId: string };
export type ApprovalKind = {
  /** The button and the confirm step's title: what approving does, in a few words. */
  label: string;
  /** What happens, in one sentence, for the confirm step. Fixed words: nothing a proposer or customer wrote. */
  effect: string;
  /** Risky actions (limits, pauses, money, deleting, access) are proposed by the agent and only ever run from here. */
  risky: boolean;
  /** An agent proposal's payload: its workspace (the conversation's own, checked when proposed and again when it runs) and the exact target. */
  payload?: z.ZodObject<{ workspaceId: z.ZodString } & z.ZodRawShape>;
  /** The exact target in Nightmail's words, from the payload (IDs and numbers only), shown with the effect in the email and on the confirm step. */
  summary?(payload: Record<string, unknown>): string;
  run(deps: Deps, conversationId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
};
const Workspace = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const count = (n: unknown) => Number(n).toLocaleString('en-US');
/**
 * The target workspace, still the conversation's person's to manage (owner or admin) now that it runs: a role changed or
 * a membership ended since the proposal refuses it, as the customer's own session would be refused.
 */
async function ownWorkspace(d: Deps, payload: Record<string, unknown>) {
  const wid = String(payload.workspaceId ?? '');
  const { rows: [member] } = d.userId ? await d.tx.execute<{ role: string }>(sql`SELECT role FROM workspace_members WHERE workspace_id = ${wid} AND user_id = ${d.userId} FOR SHARE`) : { rows: [] };
  if (!member || (member.role !== 'owner' && member.role !== 'admin'))
    throw new ApiError(409, 'SUPPORT_APPROVAL_TARGET_CHANGED', 'The customer no longer manages this workspace (owner or admin), so this can’t run for them.');
  return wid;
}
/** How an approved proposal is recorded where the console records its reason: fixed words and the conversation, never the agent's. */
const recorded = (d: Deps, conversationId: string) => ({ reason: `Support proposal ${d.approvalId}, approved in the support inbox.`, ticketRef: conversationId });
/** Runs one of the console's operator changes and writes its operator audit row, as its route's mutate() would. */
async function byConsole<T extends Record<string, unknown>>(d: Deps, wid: string, change: (ops: typeof import('./operator.js')) => Promise<{ result: T; audit: import('./operator.js').OperatorAudit }>, hosted = true) {
  const ops = await wrapModuleLoad(() => import('./operator.js'));
  if (hosted) await ops.hostedWorkspaceOf(d.tx, wid);
  const { result, audit } = await change(ops);
  await ops.writeOperatorAudit(d.tx, d.c, d.operator, wid, audit);
  return result;
}
type Name = 'retry_work' | 'send_held_answer' | 'raise_daily_limit' | 'raise_domain_limit' | 'lift_growth_pace' | 'pause_sending' | 'resume_sending' | 'release_marketing' | 'release_campaign' | 'grant_credit';
export const KINDS: Record<Name, ApprovalKind> = {
  retry_work: {
    label: 'Retry the stuck work', risky: false,
    effect: 'The support platform is woken for this conversation and tries the work it could not finish again, as Retry now does.',
    run: async (deps, conversationId) => ({ woken: await deps.wake(conversationId) }),
  },
  // payload: { messageId } of the held answer. Only proposed for one held by the output check or a pause; one held
  // because access shrank or written by an earlier build needs a fresh reply, and sendDraft refuses it anyway.
  send_held_answer: {
    label: 'Send the held answer', risky: false,
    effect: 'The answer the agent wrote goes to the customer as written, as a staff reply in your name (by email as plain text). It isn’t sent if a newer reply reached them first.',
    run: async (deps, _conversationId, payload) => ({ replyId: (await deps.sendDraft(String(payload.messageId ?? ''))).id }),
  },
  // Risky: proposed by the agent only (support-actions.ts POST /v1/support/approvals), each the operator console's own change.
  raise_daily_limit: {
    label: 'Set the daily sending limit', risky: true, payload: z.object({ workspaceId: Workspace, daily: z.number().int().min(1).max(10_000_000) }).strict(),
    effect: 'The workspace’s daily sending limit is set to the number shown, with no end date, as Set limit on its operator page does. Its score no longer lowers it until an operator clears it.',
    summary: p => `Daily limit ${count(p.daily)} for workspace ${String(p.workspaceId)}`,
    run: async (d, conversationId, p) => { const wid = await ownWorkspace(d, p); return byConsole(d, wid, ops => ops.operatorChanges.limit(d.tx, d.operator, wid, { daily: Number(p.daily), expiresAt: null, ...recorded(d, conversationId) })); },
  },
  raise_domain_limit: {
    label: 'Set the domain limit', risky: true, payload: z.object({ workspaceId: Workspace, limit: z.number().int().min(1).max(10_000) }).strict(),
    effect: 'The number of domains the workspace may add is set to the number shown, as Domain limit on its operator page does.',
    summary: p => `Domain limit ${count(p.limit)} for workspace ${String(p.workspaceId)}`,
    run: async (d, conversationId, p) => { const wid = await ownWorkspace(d, p); return byConsole(d, wid, ops => ops.operatorChanges.domainLimit(d.tx, wid, { limit: Number(p.limit), ...recorded(d, conversationId) }), false); },
  },
  lift_growth_pace: {
    label: 'Lift the growth pace', risky: true, payload: z.object({ workspaceId: Workspace }).strict(),
    effect: 'The workspace’s growth pace after its evaluation ends now, and it sends at its usual pace, as Lift growth on its operator page does.',
    summary: p => `Growth pace of workspace ${String(p.workspaceId)}`,
    run: async (d, conversationId, p) => { const wid = await ownWorkspace(d, p); return byConsole(d, wid, ops => ops.operatorChanges.liftGrowth(d.tx, d.operator, wid, recorded(d, conversationId))); },
  },
  pause_sending: {
    label: 'Pause the workspace’s sending', risky: true, payload: z.object({ workspaceId: Workspace }).strict(),
    effect: 'All of the workspace’s Hosted sending stops until an operator resumes it, as Pause on its operator page does. The customer sees that it was paused after a review.',
    summary: p => `Sending of workspace ${String(p.workspaceId)}`,
    run: async (d, conversationId, p) => { const wid = await ownWorkspace(d, p); return byConsole(d, wid, ops => ops.operatorChanges.pause(d.tx, d.operator, wid, recorded(d, conversationId))); },
  },
  resume_sending: {
    label: 'Resume the workspace’s sending', risky: true, payload: z.object({ workspaceId: Workspace }).strict(),
    effect: 'The workspace’s paused sending resumes at half its daily limit, on a warning, as Resume on its operator page does by default.',
    summary: p => `Sending of workspace ${String(p.workspaceId)}`,
    run: async (d, conversationId, p) => { const wid = await ownWorkspace(d, p); return byConsole(d, wid, ops => ops.operatorChanges.resume(d.tx, d.operator, wid, { restore: 50, ...recorded(d, conversationId) }, d.c.env.config.hostedSendCaps)); },
  },
  release_marketing: {
    label: 'Release the marketing hold', risky: true, payload: z.object({ workspaceId: Workspace }).strict(),
    effect: 'The workspace may send marketing again, on a warning if it was restricted, as Release marketing on its operator page does.',
    summary: p => `Marketing of workspace ${String(p.workspaceId)}`,
    run: async (d, conversationId, p) => { const wid = await ownWorkspace(d, p); return byConsole(d, wid, ops => ops.operatorChanges.marketing(d.tx, d.operator, wid, { held: false, ...recorded(d, conversationId) })); },
  },
  release_campaign: {
    label: 'Release the paused campaign', risky: true, payload: z.object({ workspaceId: Workspace, campaignId: Id }).strict(),
    effect: 'The paused campaign sends again from where it stopped (or waits for its schedule), as Release on the operator queue does after a quarantine’s review.',
    summary: p => `Campaign ${String(p.campaignId)} of workspace ${String(p.workspaceId)}`,
    run: async (d, conversationId, p) => { const wid = await ownWorkspace(d, p); return byConsole(d, wid, ops => ops.operatorChanges.releaseCampaign(d.tx, d.operator, String(p.campaignId), recorded(d, conversationId), wid), false); },
  },
  grant_credit: {
    label: 'Grant promotional credit', risky: true, payload: z.object({ workspaceId: Workspace, amountCents: z.number().int().min(1).max(100_000) }).strict(),
    effect: 'Promotional credit of the amount shown is added to the workspace’s balance (spent first, never refunded), as Grant credit on its billing page does. Once only.',
    summary: p => `${(Number(p.amountCents) / 100).toFixed(2)} of promotional credit for workspace ${String(p.workspaceId)}`,
    run: async (d, conversationId, p) => {
      const wid = await ownWorkspace(d, p), billing = await wrapModuleLoad(() => import('./billing/routes.js'));
      const { result, audit } = await billing.grantPromoCredit(d.tx, d.operator, wid, { amountCents: Number(p.amountCents), ...recorded(d, conversationId) }, `approval:${d.approvalId}`);
      await billing.billingAudit(d.tx, d.c, d.operator, wid, audit);
      return { applied: result.applied ?? true, entryId: result.entryId ?? null };
    },
  },
};
/** What the agent may propose: the risky kinds, each with its payload. */
export const AGENT_KINDS = (Object.keys(KINDS) as Name[]).filter(k => KINDS[k].risky && KINDS[k].payload);
export type KindName = keyof typeof KINDS;
export const isKind = (kind: string): kind is KindName => Object.hasOwn(KINDS, kind);

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const approvalId = () => `apr_${Array.from(crypto.getRandomValues(new Uint8Array(26)), b => BASE32[b & 31]).join('')}`;
const key = (secret: string) => hkdfSync('sha256', secret, 'opensend:keys:v1', 'support-approval:v1', 32);
/** An approval's expiry as the link signs it: milliseconds since the epoch. */
export const EXPIRES_MS = sql`(extract(epoch FROM expires_at) * 1000)::float8 AS expires_ms`;
/** The link's signature: this approval, for this conversation, until it expires. */
export const approvalToken = (secret: string, a: { id: string; conversationId: string; expiresAt: Date }) =>
  createHmac('sha256', Buffer.from(key(secret))).update(`${a.id}.${a.conversationId}.${a.expiresAt.getTime()}`).digest('base64url');
export function validToken(secret: string, a: { id: string; conversationId: string; expiresAt: Date }, token: string) {
  const want = Buffer.from(approvalToken(secret, a)), got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}
/** The dashboard link an email carries: the conversation, with this approval ready to confirm after sign-in. */
export const approvalLink = (config: Pick<Config, 'publicUrl' | 'authSecret'>, a: { id: string; conversationId: string; expiresAt: Date }) =>
  `${new URL(config.publicUrl).origin}/support/${a.conversationId}?approval=${a.id}&token=${approvalToken(config.authSecret, a)}`;

/**
 * Proposes an action on a conversation, or answers the one of the same kind already waiting there (unexpired), so a
 * repeated proposal never stacks. The caller holds the conversation's transaction.
 */
export async function propose(tx: DbExecutor, p: { conversationId: string; kind: KindName; reason: string; proposedBy: 'nightmail' | 'agent'; payload?: Record<string, unknown> }) {
  const { rows: [open] } = await tx.execute<{ id: string; expires_ms: number }>(sql`SELECT id, ${EXPIRES_MS} FROM support_approvals
    WHERE conversation_id = ${p.conversationId} AND kind = ${p.kind} AND payload = ${JSON.stringify(p.payload ?? {})}::jsonb AND state = 'proposed' AND expires_at > now() + interval '1 hour' ORDER BY created_at DESC LIMIT 1`);
  if (open) return { id: open.id, conversationId: p.conversationId, expiresAt: new Date(Number(open.expires_ms)), created: false };
  const { rows: [made] } = await tx.execute<{ id: string; expires_ms: number }>(sql`INSERT INTO support_approvals(id, conversation_id, kind, payload, proposed_by, reason, expires_at)
    VALUES (${approvalId()}, ${p.conversationId}, ${p.kind}, ${JSON.stringify(p.payload ?? {})}::jsonb, ${p.proposedBy}, ${p.reason.slice(0, 400)}, date_trunc('milliseconds', now() + make_interval(hours => ${APPROVAL_HOURS})))
    RETURNING id, ${EXPIRES_MS}`);
  return { id: made!.id, conversationId: p.conversationId, expiresAt: new Date(Number(made!.expires_ms)), created: true };
}
