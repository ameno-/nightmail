import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.js';
import { platformBody, type FeedbackReport, type PlatformReply } from './nightmail.js';
import { createHarness } from './agent/opencode.js';
import { spentBy, type Harness, type Usage } from './agent/harness.js';
import { searchDocs } from './agent/docs.js';
import { ToolFailure } from './agent/tools.js';
import { NUDGE, reportMessage, TRIAGE, TRIAGE_TOOL_NAMES, type TriageHost } from './agent/triage.js';
import { log, logError } from './log.js';

// One agent feedback report while the triage agent reads it (agent/triage.ts): the sweep (ledger.ts) claims the report
// from Nightmail and hands it here, and the alarm runs the agent once, in this object's own OpenCode, then removes
// everything this object stored. The object is the report's (named by its conversation), so no report ever shares a
// session with another, or with a customer's conversation. A report that fails here simply has no note: Nightmail may
// hand it out once more after 30 minutes, and staff are emailed about it either way.
// What each reading cost is sent to Nightmail when it ends (feedbackUsage), so the support AI's spend counts it.

const REPORT = 'triage:report';
/** How long one reading may take. */
const TURN_MS = 4 * 60_000;

export class SupportTriage extends DurableObject<Env> {
  /** Takes one claimed report and starts reading it (the alarm). False while this object is still reading one. */
  async start(report: FeedbackReport): Promise<boolean> {
    if (await this.ctx.storage.get(REPORT)) return false;
    await this.ctx.storage.put(REPORT, report);
    await this.ctx.storage.setAlarm(Date.now());
    return true;
  }

  override async alarm() {
    const report = await this.ctx.storage.get<FeedbackReport>(REPORT);
    if (!report) return;
    let harness: Harness<TriageHost> | null = null;
    const spent = { turns: 0, costUsd: 0 };
    try {
      harness = await createHarness(this.env, this.ctx.storage, TRIAGE);
      const noted = await this.read(harness, report, spent);
      log(noted ? 'info' : 'warn', { event: 'triage', code: noted ? 'FEEDBACK_TRIAGED' : 'FEEDBACK_TRIAGE_NO_NOTE' });
    } catch (error) {
      logError(error, { event: 'triage', code: 'FEEDBACK_TRIAGE_FAILED' });
    } finally {
      await harness?.close().catch(() => {});
      // What reading it cost, with or without a note: Nightmail adds it to the support AI's spend (api/src/support-ai-cost.ts).
      if (spent.turns || spent.costUsd > 0) {
        const reply = await this.env.BANE.feedbackUsage(report.conversationId, { turns: spent.turns, costUsd: Math.round(spent.costUsd * 1e6) / 1e6 })
          .catch((error: unknown) => { logError(error, { event: 'triage', code: 'TRIAGE_USAGE_NOT_SENT' }, 'warn'); return null; });
        if (reply && reply.status !== 200) log('warn', { event: 'triage', code: 'TRIAGE_USAGE_NOT_SENT', status: reply.status });
      }
      await this.ctx.storage.deleteAll();
    }
  }

  /** One turn over the report, and one nudge when it ends without the note. True once the note is saved (or already was). */
  private async read(harness: Harness<TriageHost>, report: FeedbackReport, spent: { turns: number; costUsd: number }) {
    const bane = this.env.BANE, id = report.conversationId;
    let noted = false;
    const refused = (reply: PlatformReply) => (reply.body as { error?: { message?: string } } | null)?.error?.message?.slice(0, 300) ?? `Nightmail answered ${reply.status}.`;
    const host: TriageHost = {
      requestTrace: async requestId => {
        const reply = await bane.feedbackRequest(id, requestId);
        if (reply.status === 404) throw new ToolFailure('Not found: nothing is recorded for that request ID in this report’s workspace. It may be wrong, too old, or someone else’s: don’t guess what it did.');
        return platformBody(reply);
      },
      earlierReports: async () => platformBody(await bane.feedbackRelated(id)),
      searchDocs: query => searchDocs(query),
      writeNote: async note => {
        if (noted) throw new ToolFailure('The note is already saved. End your turn.');
        const reply = await bane.feedbackTriage(id, note);
        if (reply.status === 201) { noted = true; return 'Saved: the note is on the ticket. End your turn now.'; }
        if (reply.status === 409) { noted = true; throw new ToolFailure('This report already has its note. End your turn.'); }
        if (reply.status === 422) throw new ToolFailure(`Not saved: ${refused(reply)} Fix it and call write_triage_note again.`);
        throw new ToolFailure('Not saved: Nightmail could not take the note just now. End your turn.');
      },
      hidden: () => [id],
    };
    // Each turn's cost, including one that threw after its model calls began. The reading is one turn; its nudge isn't
    // another (as a conversation counts an email and its nudge).
    const count = (usage: Usage, turns: number) => { spent.turns += turns; spent.costUsd += usage.costUsd; };
    const turn = async (text: string, turns: number) => {
      try { const result = await harness.turn({ text, context: '', tools: TRIAGE_TOOL_NAMES }, host, () => {}, AbortSignal.timeout(TURN_MS)); count(result.usage, turns); return result; }
      catch (error) { const lost = spentBy(error); if (lost) count(lost, turns); throw error; }
    };
    const first = await turn(reportMessage(report), 1);
    if (!noted && !first.error && !first.refused && !first.aborted) await turn(NUDGE, 0);
    return noted;
  }
}
