import { sql } from 'drizzle-orm';
import { ApiError, budgetedRead, log, rowId, type DbExecutor, type JobHandler, type Runtime } from './core.js';
import { readLogFacetCut, type LogFacetCut } from './log-facet-source.js';

// A view waits for a complete source statement that STARTS after its demand was enrolled. Never serve
// an earlier cut as a new view's live count. A current fold is sealed; later arrivals share its successor.
const TYPE = 'logs.facetFold';
const SLOTS = Array.from({ length: 4 }, (_, n) => 'job_logfacets_slot_' + n);
const MAX_PER_WORKSPACE = 3, SOURCE_SECONDS = 12;
export const LOG_FACET_TICK_MS = 1_000, LOG_FACET_WAIT_MS = 30_000;
const HOLD_SECONDS = 45, LEASE_SECONDS = 18;
export type FacetTicket = { slot: string; run: string; workspaceId: string; generation: number; wake: boolean };
type Payload = { run: string; from: string; region: string | null; wanted: number; sealed: number; published: number; cut?: LogFacetCut };
const unavailable = () => new ApiError(503, 'FACET_CATCHUP_UNAVAILABLE', 'Exact Logs counts are temporarily unavailable.', undefined, true);
const capacity = () => new ApiError(503, 'FACET_FOLD_CAPACITY', 'The exact Logs count slots are busy.', undefined, true);

// Four short, indexed control rows across the installation. The only table used is the existing
// durable jobs table. Admission and publication never lock a source mail row or a sender queue.
export async function enrollLogFacet(runtime: Runtime, workspaceId: string, from: string, region: string | null): Promise<FacetTicket> {
  return runtime.db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('lock_timeout','200ms',true),set_config('statement_timeout','1000ms',true)`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(712006, 1)`);
    const { rows } = await tx.execute<{ id:string; workspace_id:string; type:string; status:string; payload:Payload; cold:boolean }>(sql`
      SELECT id,workspace_id,type,status,payload,status IN ('completed','failed') AND created_at < statement_timestamp() - ${HOLD_SECONDS} * interval '1 second' AS cold
      FROM jobs WHERE id=ANY(${sql.param(SLOTS)}::text[]) ORDER BY id`);
    if (rows.some(r => r.type !== TYPE)) throw unavailable();
    const match = rows.find(r => r.workspace_id === workspaceId && r.payload.from === from && r.payload.region === region);
    if (match) {
      // Evaluate these fields on the current row, not on the earlier SELECT: a worker can have
      // sealed/published in between. No reader advances a generation that is already waiting.
      const { rows:[ticket] } = await tx.execute<{ run:string; generation:number; wake:boolean }>(sql`
        WITH prior AS MATERIALIZED (
          SELECT id AS chosen,status AS old_status FROM jobs WHERE id=${match.id} AND workspace_id=${workspaceId}
            AND type=${TYPE} AND payload->>'run'=${match.payload.run} FOR NO KEY UPDATE
        )
        UPDATE jobs SET payload=jsonb_set(payload,'{wanted}',to_jsonb(greatest((payload->>'wanted')::int,(payload->>'sealed')::int+1))),
          created_at=statement_timestamp(),status=CASE WHEN old_status IN ('completed','failed') THEN 'pending' ELSE old_status END,
          available_at=CASE WHEN old_status IN ('completed','failed') THEN statement_timestamp() ELSE available_at END,
          attempts=CASE WHEN old_status IN ('completed','failed') THEN 0 ELSE attempts END,
          last_error=CASE WHEN old_status IN ('completed','failed') THEN NULL ELSE last_error END
        FROM prior WHERE id=prior.chosen
        RETURNING payload->>'run' AS run,(payload->>'wanted')::int AS generation,old_status IN ('completed','failed') AS wake`);
      if (!ticket) throw unavailable();
      return {slot:match.id,run:ticket.run,workspaceId,generation:ticket.generation,wake:ticket.wake};
    }
    if (rows.filter(r => !r.cold && r.workspace_id === workspaceId).length >= MAX_PER_WORKSPACE) throw capacity();
    const slot = SLOTS.find(id => !rows.some(r => r.id === id)) ?? rows.find(r => r.cold)?.id;
    if (!slot) throw capacity();
    const run = rowId('fold'), payload:Payload={ run,from,region,wanted:1,sealed:0,published:0 };
    const write=await tx.execute(sql`INSERT INTO jobs(id,workspace_id,type,payload,status) VALUES(${slot},${workspaceId},${TYPE},${JSON.stringify(payload)}::jsonb,'pending')
      ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,payload=excluded.payload,status='pending',attempts=0,
        last_error=NULL,lease_until=NULL,created_at=statement_timestamp(),available_at=statement_timestamp()
      WHERE jobs.type=${TYPE} AND jobs.status IN ('completed','failed') AND jobs.created_at < statement_timestamp()-${HOLD_SECONDS}*interval '1 second'
      RETURNING id`);
    if (!write.rowCount) throw capacity();
    return {slot,run,workspaceId,generation:1,wake:true};
  });
}

// The same fenced worker is callable both by the normal job runner and a dedicated slot nudge.
// The seal commits BEFORE taking the actual source snapshot. A writer, reader, or other workspace
// cannot extend that snapshot. Publication preserves any already-enrolled next generation atomically.
async function runSealed(runtime:Runtime, slot:string, workspaceId:string, fence:string) {
  const own = sql`id=${slot} AND type=${TYPE} AND workspace_id=${workspaceId} AND status='running' AND lease_until=${fence}::timestamptz`;
  const { rows:[sealed] }=await runtime.db.execute<{ run:string; g:number; from:string; region:string|null }>(sql`
    UPDATE jobs SET payload=jsonb_set(payload,'{sealed}',payload->'wanted') WHERE ${own}
    RETURNING payload->>'run' AS run,(payload->>'sealed')::int AS g,payload->>'from' AS "from",payload->>'region' AS region`);
  if (!sealed) return false;
  const still = sql`${own} AND payload->>'run'=${sealed.run} AND (payload->>'sealed')::int=${sealed.g}`;
  try {
    const cut = await budgetedRead(runtime.db, tx => readLogFacetCut(tx,workspaceId,sealed.from,sealed.region),
      { seconds:SOURCE_SECONDS,refusal:unavailable });
    const { rows:[published] }=await runtime.db.execute<{ status:string }>(sql`UPDATE jobs SET
      payload=payload || jsonb_build_object('published',${sealed.g}::int,'cut',${JSON.stringify(cut)}::jsonb),
      status=CASE WHEN (payload->>'wanted')::int>${sealed.g} THEN 'pending' ELSE 'completed' END,
      lease_until=NULL,available_at=statement_timestamp(),last_error=NULL,attempts=0 WHERE ${still} RETURNING status`);
    return published?.status === 'pending';
  } catch (error) {
    // This is a failure to produce a number, never a success deadline or an exact zero.
    await runtime.db.execute(sql`UPDATE jobs SET status='failed',lease_until=NULL,last_error='FACET_SOURCE_UNAVAILABLE' WHERE ${still}`);
    log('warn',{code:'LOG_FACET_FOLD_FAILED',workspaceId,jobId:slot});
    throw error;
  }
}
export const logFacetJob:JobHandler=async(runtime,_payload,job)=>{
  if(!SLOTS.includes(job.id)||!job.leaseFence) throw unavailable();
  if (await runSealed(runtime,job.id,job.workspaceId,job.leaseFence)) await foldLogFacetSlot(runtime,job.id);
};

// At most one source reader per reserved slot. The lease fence protects restarts/late workers. In
// normal service a ticket is covered by this cut or its one successor; ongoing mail needs no drain.
export async function foldLogFacetSlot(runtime:Runtime, slot:string) {
  if(!SLOTS.includes(slot)) return;
  for(let pass=0;pass<2;pass++){
    const {rows:[claim]}=await runtime.db.execute<{workspace_id:string;fence:string}>(sql`UPDATE jobs SET status='running',attempts=attempts+1,
      lease_until=clock_timestamp()+${LEASE_SECONDS}*interval '1 second'
      WHERE id=${slot} AND type=${TYPE} AND (status='pending' OR (status='running' AND lease_until<=clock_timestamp()))
      RETURNING workspace_id,lease_until::text AS fence`);
    if(!claim || !await runSealed(runtime,slot,claim.workspace_id,claim.fence)) break;
  }
}
export async function dueLogFacetSlots(db:DbExecutor) {
  const {rows}=await db.execute<{id:string}>(sql`SELECT id FROM jobs WHERE id=ANY(${sql.param(SLOTS)}::text[]) AND type=${TYPE}
    AND (status='pending' OR (status='running' AND lease_until<=clock_timestamp())) ORDER BY id`);
  return rows.map(r=>r.id);
}
export async function readTicketCut(db:DbExecutor,t:FacetTicket):Promise<LogFacetCut|null> {
  const {rows:[r]}=await db.execute<{status:string;cut:LogFacetCut|null}>(sql`SELECT status,
    CASE WHEN (payload->>'published')::int>=${t.generation} THEN payload->'cut' END AS cut FROM jobs
    WHERE id=${t.slot} AND type=${TYPE} AND workspace_id=${t.workspaceId} AND payload->>'run'=${t.run}`);
  if(!r) throw unavailable();
  if(r.cut) return r.cut;
  if(r.status==='failed') throw unavailable();
  return null;
}
