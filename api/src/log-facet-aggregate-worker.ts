import { sql } from 'drizzle-orm';
import type { Database, DbExecutor } from './core.js';
import { logFacetPeriod, snapshotId } from './log-facet-fold.js';
import { advanceInboundFacetClock, drainDirtyFacetMessages, seedInboundFacetPage } from './log-facet-aggregate-inbound.js';
import { captureFacetSignature, ensureFacetGeneration, facetGenerationIntact } from './log-facet-aggregate-retention.js';
import { expandFacetBoxPage, routeInboundFacetChanges } from './log-facet-aggregate-routing.js';
import { drainSentFacetPackets, seedSentFacetPage, retireSentSeedWitnesses } from './log-facet-aggregate-sent.js';
import { publishFacetBucketView, rollingFacetFrom, utcFacetStamp } from './log-facet-aggregate-view.js';

const TURN_MS=180, BATCHES=8, VIEWS=4;
/** Current inputs visible in THIS snapshot. Late commits are intentionally not included in the
 * stamp. An unrouted foreign link or mailbox-lifetime page cannot be assumed to belong elsewhere. */
const noMissing=(workspace:string,generation:string,sourceTime:string)=>sql`
  NOT EXISTS(SELECT 1 FROM log_facet_changes WHERE workspace_id=${workspace} AND source='sent')
  AND NOT EXISTS(SELECT 1 FROM log_facet_changes WHERE source IN ('message','link','box'))
  AND NOT EXISTS(SELECT 1 FROM log_facet_box_work)
  AND NOT EXISTS(SELECT 1 FROM log_facet_dirty_messages WHERE workspace_id=${workspace} AND generation=${generation})
  AND NOT EXISTS(SELECT 1 FROM log_facet_deadlines WHERE workspace_id=${workspace} AND generation=${generation}
    AND deadline<=${sourceTime}::timestamptz AND n<>0)`;

/** The upkeep transaction is the certificate fence. Its FIRST statement takes the RR snapshot
 * and saves that statement's native UTC microsecond clock. All bounded mutations, proof, and
 * publications then commit together. A partial turn explicitly withdraws the mutable generation
 * certificate, while previously published immutable view cuts stay readable at their old as-of. */
export async function runFacetAggregateTurn(db:Database,workspace:string) {
  const generation=await ensureFacetGeneration(db,workspace);if(!generation)return null;
  return db.transaction(async tx=>{
    const began=performance.now();
    const {rows:[first]}=await tx.execute<{stamp:string;held:boolean}>(sql`SELECT
      set_config('lock_timeout','150ms',true),set_config('statement_timeout','2s',true),
      ${utcFacetStamp(sql`statement_timestamp()`)} AS stamp,pg_current_snapshot(),
      pg_try_advisory_xact_lock(712008,hashtext(${workspace})) AS held`);
    if(!first?.held)return null;
    const signature=await captureFacetSignature(tx);if(!signature)return null;
    const state=(await tx.execute<{sd:boolean;md:boolean;floor:string}>(sql`SELECT c.sent_done AS sd,p.seeded AS md,
      c.covered_from::text AS floor FROM log_facet_coverage c JOIN log_facet_generations g USING(workspace_id,generation)
      JOIN log_facet_inbound_progress p USING(workspace_id,generation) WHERE c.workspace_id=${workspace} AND c.generation=${generation}
      AND g.capture_signature=${signature} AND ${facetGenerationIntact(workspace)}`)).rows[0];
    if(!state)return null;
    const work={seedSent:0,seedMail:0,packets:0,messages:0,routed:0,boxKeys:0,deadlines:0,published:0};
    // At most one legacy page per direction per turn; an already certified view never reads source
    // history for being opened or polled. New work is consumed in bounded, independently retryable slices.
    if(!state.sd)work.seedSent=(await seedSentFacetPage(tx,workspace))?.read??0;
    if(!state.md && performance.now()-began<TURN_MS)work.seedMail=(await seedInboundFacetPage(tx,workspace))?.read??0;
    let clockDone:boolean=false;
    for(let pass=0;pass<BATCHES && (pass===0||performance.now()-began<TURN_MS);pass++){
      const routed=await routeInboundFacetChanges(tx),box=await expandFacetBoxPage(tx);
      const time:{expired:number;done:boolean}|null=clockDone?null:await advanceInboundFacetClock(tx,workspace,512,first.stamp);
      clockDone ||= time?.done===true;
      const messages=await drainDirtyFacetMessages(tx,workspace),packets=await drainSentFacetPackets(tx,workspace);
      work.routed+=routed??0;work.boxKeys+=box?.read??0;work.deadlines+=time?.expired??0;
      work.messages+=messages??0;work.packets+=packets?.packets??0;
      if(!routed&&!box&&!time?.expired&&!messages&&!packets?.packets)break;
    }
    const {rows:[checked]}=await tx.execute<{ok:boolean}>(sql`SELECT c.sent_done AND p.seeded AND p.advancing_to IS NULL
      AND p.visibility_clock<=${first.stamp}::timestamptz AND ${noMissing(workspace,generation,first.stamp)} AS ok
      FROM log_facet_coverage c JOIN log_facet_inbound_progress p USING(workspace_id,generation)
      WHERE c.workspace_id=${workspace} AND c.generation=${generation}`);
    const ready=checked?.ok===true && Date.parse(rollingFacetFrom(first.stamp,'30d'))>=Date.parse(state.floor);
    if(ready){
      const {rows:views}=await tx.execute<{region:string;period:string;anchor:string}>(sql`SELECT d.region,d.period,
        to_char(d.anchor AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS anchor FROM log_facet_demands d
        LEFT JOIN log_facet_results r ON (r.workspace_id,r.region,r.period,r.anchor)=(d.workspace_id,d.region,d.period,d.anchor)
          AND r.generation=${generation}
        WHERE d.workspace_id=${workspace} AND d.expires_at>statement_timestamp() AND d.anchor>=${state.floor}::timestamptz
          AND (r.as_of IS NULL OR r.as_of<d.wanted_at)
        ORDER BY coalesce(r.as_of,d.created_at),d.region,d.period,d.anchor LIMIT ${VIEWS}`);
      let defaultServed=false;
      for(const view of views){
        const period=logFacetPeriod(view.period);if(!period)throw new Error('Invalid Logs aggregate period');
        await publishFacetBucketView(tx,workspace,generation,view.region||null,period,view.anchor,first.stamp);
        defaultServed ||= !view.region&&period==='30d';work.published++;
      }
      if(!defaultServed){
        // A large workspace with no viewers still gets the default prior certificate. An idle
        // browser doesn't cause repeated scans of history; renew stale bootstrap views from buckets.
        const {rowCount}=await tx.execute(sql`SELECT 1 FROM jobs WHERE id=${await snapshotId(workspace,null,'30d')}
          AND workspace_id=${workspace} AND type='logs.facetSnapshot' AND status='completed'
          AND created_at>statement_timestamp()-interval '5 minutes'`);
        if(!rowCount)await publishFacetBucketView(tx,workspace,generation,null,'30d',rollingFacetFrom(first.stamp,'30d'),first.stamp,false);
      }
      await retireSentSeedWitnesses(tx,workspace);
    }
    // Do not let an unrelated enrollment overwrite the result or reset an in-flight source turn.
    // Pending inputs/wanted cuts also wake the scheduler independently of the idle check.
    await tx.execute(sql`UPDATE log_facet_generations SET certified_at=${ready?first.stamp:null}::timestamptz,
      next_at=clock_timestamp()+${ready&&work.published<VIEWS?'10 seconds':'200 milliseconds'}::interval
      WHERE workspace_id=${workspace} AND generation=${generation}`);
    return {generation,stamp:ready?first.stamp:null,ready,work,ms:performance.now()-began};
  },{isolationLevel:'repeatable read'});
}

/** Discovery is one workspace PK page, never a mail-volume count. Both raw existence probes
 * stop at the first recent row on their workspace/date indexes, including for very large tenants. */
export async function discoverFacetWorkspaces(db:DbExecutor,after:string) {
  const {rows}=await db.execute<{id:string;mail:boolean}>(sql`WITH page AS MATERIALIZED (
    SELECT id FROM workspaces WHERE id>${after} ORDER BY id LIMIT 16)
    SELECT p.id,EXISTS(SELECT 1 FROM sending_emails WHERE workspace_id=p.id
      AND created_at>=date_trunc('minute',statement_timestamp(),'UTC')-interval '720 hours'
      ORDER BY created_at DESC,id DESC LIMIT 1 OFFSET 0) OR EXISTS(SELECT 1 FROM mail_messages WHERE workspace_id=p.id
      AND direction='inbound' AND received_at>=date_trunc('minute',statement_timestamp(),'UTC')-interval '720 hours'
      ORDER BY received_at DESC,id DESC LIMIT 1 OFFSET 0) AS mail FROM page p ORDER BY p.id`);
  return rows;
}
