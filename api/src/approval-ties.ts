import { z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { isoTime, type Runtime } from './core.js';
import { receivingPolicy } from './mailbox-ingest-input.js';

// What an MCP approval made is tied to it (mail_grant_objects): a key it created works, and a webhook it set up or changed
// delivers, only while the approval is active, and removing the approval revokes the key and holds the webhook. These say
// so where the object is created and read, so nobody finds out when it stops.
export type TiedKind = 'api_key' | 'key' | 'webhook' | 'endpoint';
export const ApprovalTie = z.object({
  id: z.string().describe('The agent sign-in (mcp_…) it is tied to, as listAgents lists it.'),
  endsAt: z.string().describe('When the approval ends unless its agent connects again: each new sign-in token moves it later. It also ends when it is revoked.'),
  active: z.boolean().describe('False once the approval has ended, lost the manage scope, or its person is no longer an owner or admin here: a key is refused and a webhook is not delivered to until it is active again.'),
}).openapi('ApprovalTie');
export const approvalField = ApprovalTie.nullable().describe('Set when this is tied to an MCP approval: created, or for a webhook set up or changed, over MCP with a person’s sign-in or with a key that is tied. It works only while that approval is active. Null: it lasts, not tied to any approval.');
export type Tie = z.infer<typeof ApprovalTie>;

/** The ties of the given objects in one workspace, by object ID. Untied objects are missing. */
export async function approvalTies(runtime: Runtime, w: string, kinds: TiedKind[], ids: string[]): Promise<Map<string, Tie>> {
  if (!ids.length) return new Map();
  // The same rule a tied key's requests and a tied webhook's deliveries are checked against (mail_management_grant).
  const { rows } = await runtime.db.execute<{ resource: string; id: string; ends_at: string; active: boolean }>(sql`
    SELECT o.resource, g.id, g.expires_at::text AS ends_at, mail_management_grant(o.workspace_id, o.grant_id, ${receivingPolicy(runtime.config)}::jsonb, false) AS active
    FROM mail_grant_objects o JOIN nightmail_resource_grants g ON g.grant_key = o.grant_id
    WHERE o.workspace_id = ${w} AND o.kind = ANY(${sql.param(kinds)}::text[]) AND o.resource = ANY(${sql.param(ids)}::text[])`);
  return new Map(rows.map(r => [r.resource, { id: r.id, endsAt: isoTime(r.ends_at)!, active: r.active }]));
}
export const approvalTie = async (runtime: Runtime, w: string, kinds: TiedKind[], id: string) => (await approvalTies(runtime, w, kinds, [id])).get(id) ?? null;

/** The create result's nextStep for a tied object: what it depends on, until when, and how to make a lasting one. */
export const tiedNextStep = (what: 'key' | 'webhook', tie: Tie) =>
  `This ${what} is tied to the MCP approval ${tie.id}: it ${what === 'key' ? 'works' : 'delivers'} only while that approval is active (now until ${tie.endsAt}, moved later each time the agent connects again), and revoking the approval ${what === 'key' ? 'revokes the key' : 'pauses the webhook until its URL is sent again'}. For a lasting ${what}, create it in the dashboard or with a workspace API key with manage that was not created over MCP.`;
