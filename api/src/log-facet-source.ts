import { z } from '@hono/zod-openapi';
import { eq, sql, type SQLWrapper } from 'drizzle-orm';
import type { DbExecutor } from './core.js';
import { mailMessages as messages, mailboxMessages as links, mailboxes } from './db/mailbox.js';
import { emails } from './db/sending.js';
import { EmailStatusFilter } from './sending.js';

export type LogFacetCut = {
  asOf: string;
  sent: { kind: 'transactional' | 'marketing'; status: string; n: number }[];
  admin: { total: number; spam: number };
  member: { total: number };
};

const Kind = z.enum(['transactional', 'marketing']);
const Count = z.int().nonnegative();
const Cut = z.strictObject({
  asOf: z.iso.datetime({ precision: 6 }),
  sent: z.array(z.strictObject({ kind: Kind, status: EmailStatusFilter, n: Count }))
    .max(Kind.options.length * EmailStatusFilter.options.length),
  admin: z.strictObject({ total: Count, spam: Count }),
  member: z.strictObject({ total: Count }),
});

/** Exact, unfiltered cross-tab for the two unrestricted dashboard viewer bands. */
export async function readLogFacetCut(db: DbExecutor, workspaceId: string, from: string, region: string | null): Promise<LogFacetCut> {
  const scopedRange = (date: SQLWrapper, regionColumn: typeof emails.region | typeof messages.region) =>
    sql`${date} >= ${from}::timestamptz${region === null ? sql`` : sql` AND ${eq(regionColumn, region)}`}`;
  // Group sent rows in one pass. Unknown kinds collapse to one excluded bucket, exactly as the
  // public two-kind count excludes them; an invalid status in a counted kind fails validation.
  // For incoming messages, group the eligible message's links once by PK. The administrator's
  // retainedMail test requires a real live box unless lifecycle is default. The member's
  // visibleLinks test requires a workspace link, no hold, and no expired box (liveBox).
  const live = sql`(${mailboxes.deleteAfter} IS NULL OR ${mailboxes.deleteAfter}>statement_timestamp())`;
  const { rows } = await db.execute(sql`
    WITH grouped AS MATERIALIZED (
      SELECT CASE ${emails.snapshot}->>'kind' WHEN 'transactional' THEN 'transactional' WHEN 'marketing' THEN 'marketing' END AS kind,
        CASE WHEN ${emails.status}=ANY(${sql.param(EmailStatusFilter.options)}::text[]) THEN ${emails.status} END AS status,count(*) AS n
      FROM ${emails} WHERE ${eq(emails.workspaceId, workspaceId)} AND ${scopedRange(emails.createdAt, emails.region)}
      GROUP BY 1,2
    ), witness AS (
      SELECT ${messages.id},${messages.spam} AS spam,
        ${messages.lifecycle}='default' OR coalesce(bool_or(${mailboxes.id} IS NOT NULL AND ${live}),false) AS adm,
        coalesce(bool_or(${eq(links.workspaceId, workspaceId)} AND ${links.heldReason} IS NULL AND ${live}),false) AS mem
      FROM ${messages} LEFT JOIN ${links} ON ${links.messageId}=${messages.id}
        LEFT JOIN ${mailboxes} ON ${mailboxes.id}=${links.mailboxId}
      WHERE ${eq(messages.workspaceId, workspaceId)} AND ${messages.direction}='inbound' AND ${scopedRange(messages.receivedAt, messages.region)}
      GROUP BY ${messages.id}
    )
    SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "asOf",
      (SELECT coalesce(jsonb_agg(to_jsonb(grouped) ORDER BY kind,status),'[]'::jsonb) FROM grouped WHERE kind IS NOT NULL) AS sent,
      jsonb_build_object('total',count(*) FILTER(WHERE adm),'spam',count(*) FILTER(WHERE adm AND spam)) AS admin,
      jsonb_build_object('total',count(*) FILTER(WHERE mem)) AS member FROM witness`);
  const cut = Cut.safeParse(rows.length === 1 ? rows[0] : undefined);
  if (!cut.success || cut.data.admin.spam > cut.data.admin.total || cut.data.member.total > cut.data.admin.total
    || new Set(cut.data.sent.map(row => `${row.kind}:${row.status}`)).size !== cut.data.sent.length) {
    throw new Error('Invalid log facet source result');
  }
  return cut.data;
}
