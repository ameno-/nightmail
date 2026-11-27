import { sql } from 'drizzle-orm';
import type { Ctx, Database } from './core.js';
import { log } from './log.js';
import { WRITE_LIMITS } from './health-counters.js';

// Only this notice has a removal date. Earlier, undated deprecations stay as they are.
export const retiringOperations = new Map<string, string | null>([
  ['inviteWorkspaceMember', 'createWorkspaceInvitation'],
  ['createSegment', null], ['getSegment', null], ['updateSegment', null],
  ['deleteSegment', null], ['previewSegment', null],
  ['queryAudience', null], ['planAudienceMutation', null], ['applyAudiencePlan', null],
  ['updateInboundScanPolicy', null],
]);
const sunset = new Date('2027-02-25T23:59:59Z');
export const noticeText = (replacement: string | null) => replacement
  ? `Deprecated: use \`${replacement}\`. Removed after 25 February 2027.`
  : 'Deprecated, with no replacement. Removed after 25 February 2027. Tell support if you rely on it.';

let pending = 0;
export function noticeResponse(c: Ctx, operation: string, workspace: string | undefined, day: string) {
  c.header('Deprecation', '@' + sunset.getTime() / 1000);
  c.header('Sunset', sunset.toUTCString());
  const replacement = retiringOperations.get(operation);
  if (replacement) c.header('Link', `</docs/operations/${replacement}.md>; rel="successor-version"`, { append: true });

  const lost = () => log('error', { code: 'DEPRECATED_CALL_WRITE_LOST', operation, deprecationDay: day, deprecationEvent: 'loss', lostWrites: 1 });
  // Don't let a stalled database build a queue on this process or postpone the response.
  if (pending >= 2) { lost(); return; }
  pending++;
  const write = async (db: Database) => {
    await db.transaction(async tx => {
      await tx.execute(WRITE_LIMITS);
      await tx.execute(sql`INSERT INTO deprecated_call_days (day,operation,workspace_id,calls)
        VALUES (${day},${operation},${workspace ?? ''},1)
        ON CONFLICT (day,operation,workspace_id) DO UPDATE SET calls=deprecated_call_days.calls+1`);
    });
  };
  const runtime = c.env;
  void Promise.resolve().then(() => {
    if (runtime.detach) return runtime.detach(background => write(background.db));
    if (runtime.deprecatedCallDb) return write(runtime.deprecatedCallDb);
    lost();
  }).catch(lost).finally(() => { pending--; });
}
