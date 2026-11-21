import type { ReactNode } from 'react'
import { Disclosure } from '../../components/ui'
import type { SenderLimit } from '../../data/types'
import { number } from '../../lib/format'
import { EVALUATION, FREEZE_FLOOR, GRADE_BANDS, GROWTH, LADDER, LIMIT_BANDS, PACE, SCORE, burstFor, pct } from '../../../../api/src/standing-model'
import './limits.css'

// How sending limits work: the published score → limit table, the warning lines as one table (a rate and a count for
// each step) with what each step does, and the campaign list probe. The public docs (/docs#sending-limits) and
// Overview's explainer render this one copy. Detection internals stay out.
// The published numbers (api/src/standing-model.ts) behind each table, so the copy follows the API when they change.
// The score and its grade in one cell; `source` and `band` pick out the row a workspace is on (SenderLimit).
const scoreBands = [...LIMIT_BANDS].reverse().map((band, i, all) => ({ limit: band.limit, from: band.min, to: i + 1 < all.length ? all[i + 1].min - 1 : Infinity }))
// The grades a score range spans: the one at its closed end, then the others with where they start or stop.
function gradeSpan(from: number, to: number) {
  const spans = GRADE_BANDS.map((band, i) => ({ grade: band.grade, from: band.min, to: i ? GRADE_BANDS[i - 1].min - 1 : Infinity })).filter(band => band.from <= to && band.to >= from)
  if (from === -Infinity) return [spans[0].grade, ...spans.slice(1).map(band => `${band.grade} under ${band.to + 1}`)].join(', ')
  const [first, ...rest] = spans.reverse()
  return [first.grade, ...rest.map(band => `${band.grade} from ${band.from}`)].join(', ')
}
const scoreRange = (from: number, to: number) => from === -Infinity ? `Under ${to + 1}` : to === Infinity ? `${from} and up` : `${from}–${to}`
// null is no daily limit: good standing, paced by the pool (at least PACE.uncappedFloor a minute). `cell` replaces the
// limit's figure: the evaluation is the first recipients once, not a daily limit.
const bands: [score: string, limit: number | null, current: (limit: SenderLimit) => boolean, cell?: string][] = [
  ['Evaluation', EVALUATION.limit, l => l.source === 'calibrating', `First ${EVALUATION.recipients}, once`],
  ...scoreBands.map(({ limit, from, to }): (typeof bands)[number] => [`${scoreRange(from, to)} · ${gradeSpan(from, to)}`, limit, l => l.source === 'score' && (limit === null ? l.unlimited : !l.unlimited && l.band === limit)]),
]
// Each cell is the rate and the count that must both be reached; a dash where the step has no line for it. A line
// with the rate of the one before it gives only its count. `window` adds the period a line counts over.
type Line = { rate: number; count: number; window?: string }
const at = (lines: readonly Line[], window = true) => lines.map((line, i) => `${i && line.rate === lines[i - 1].rate ? '' : `${pct(line.rate)} and `}${line.count}${window ? ` in ${line.window === '7d' ? '7 days' : '24 h'}` : ''}`).join(', or ')
const lines: [what: string, warn: string, restrict: string, pause: string][] = [
  ['Complaints', at(LADDER.complaints.warn), at(LADDER.complaints.restrict), at(LADDER.complaints.pause)],
  ['Hard bounces', at(LADDER.bounces.warn), `Marketing ${at(LADDER.marketingBounces.restrict, false)}; any mail ${at(LADDER.anyBounces.restrict, false)}`, `Transactional ${at(LADDER.transactionalBounces.pause, false)}`],
  ['Spam-screen rejections', at(LADDER.screen.warn), at(LADDER.screen.restrict, false), at(LADDER.screen.pause, false)],
  ['Other', '–', '–', 'AWS paused sending, or confirmed abuse'],
]
// What each step does, then how it ends.
const ladder: { step: string; mark: string; tone: string; does: string; recovery: string }[] = [
  { step: 'Notice', mark: '·', tone: 'neutral', does: 'A first complaint or a few bounces adds a dashboard note.', recovery: 'It clears by itself.' },
  { step: 'Warn', mark: '1', tone: 'warning', does: `The limit is frozen (without one, at the last 24 hours’ accepted mail, at least ${FREEZE_FLOOR.toLocaleString('en-US')}). Owners and admins get an email.`, recovery: 'Clears after 24 hours under 80% of the line.' },
  { step: 'Restrict', mark: '2', tone: 'warning', does: 'Marketing is held; receipts and resets still send.', recovery: 'After 24 hours owners and admins can release it from Overview: 50% for 48 hours, once per 14 days.' },
  { step: 'Pause', mark: '3', tone: 'danger', does: 'Sending stops. Queued mail is canceled after 72 hours.', recovery: 'A pause from transactional bounces alone: owners can resume it at 50% for 48 hours, once per 30 days. Others need a review.' },
]

// `limit` marks the row the workspace is on. `compact` (Overview's dialog) leads with the limit table and opens the
// warning lines and the campaign probe from their headings; the docs show every section open.
export function SendingLimitsGuide({ headings = 'h3', limit, compact = false }: { headings?: 'h2' | 'h3'; limit?: SenderLimit | null; compact?: boolean }) {
  const H = headings
  return <div className="limits-guide" data-compact={compact || undefined}>
    <section aria-label="Score and daily limit">
      <H>Score and daily limit</H>
      {/* Overview's dialog is Hosted's only; what the limit counts is in the docs it links to. */}
      {!compact && <p>Hosted only: recipients per rolling 24 hours, set by the sender score. Good standing has none.</p>}
      <div className="limits-table-scroll"><table className="limits-table">
        <thead><tr><th scope="col">Score</th><th scope="col">Daily limit</th><th scope="col">Per minute</th></tr></thead>
        <tbody>{bands.map(([score, cap, current, cell]) => <tr key={score} aria-current={limit && current(limit) ? 'true' : undefined}><td>{limit && current(limit) && <span className="limits-table__now">Now</span>}{score}</td><td>{cell ?? (cap === null ? 'None' : number(cap))}</td><td>{cap === null ? `${number(PACE.uncappedFloor)}+` : number(burstFor(cap))}</td></tr>)}</tbody>
      </table></div>
      <ul className="limits-notes">
        <li>The first {EVALUATION.recipients} wait for their results, about an hour. Then sending grows from {number(GROWTH.start)} an hour for {GROWTH.hours} hours.</li>
        <li>Under a limit, 100 or 10% is kept for receipts. A band drops {SCORE.hysteresis} points under its floor.</li>
      </ul>
    </section>
    <Part title="Warnings and holds" H={H} compact={compact}>
      <p>Checked every 10 minutes. A line needs its rate and its count; any one line is enough.</p>
      <div className="limits-table-scroll"><table className="limits-table limits-table--lines">
        <thead><tr><th scope="col"><span className="sr-only">Signal</span></th><th scope="col">Warn</th><th scope="col">Restrict</th><th scope="col">Pause</th></tr></thead>
        <tbody>{lines.map(([what, ...steps]) => <tr key={what}><th scope="row">{what}</th>{steps.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody>
      </table></div>
      <ol className="limits-ladder">{ladder.map(step => <li key={step.step} className={`ui-tone--${step.tone}`}>
        <div className="limits-ladder__head"><span className="limits-ladder__mark" aria-hidden="true">{step.mark}</span><strong>{step.step}</strong></div>
        <p>{step.does}</p><p className="muted">{step.recovery}</p>
      </li>)}</ol>
    </Part>
    <Part title="Campaign list probe" H={H} compact={compact}>
      <ul className="limits-notes limits-notes--plain">
        <li>Campaigns to over 100 recipients go to 10% first (100 to 500). In good standing, lists you mailed cleanly skip it.</li>
        <li>Over 3% hard bounces or 2 complaints pause it and suppress the bounces.</li>
        <li>Clean the list and resume; a second quarantine needs a review.</li>
      </ul>
    </Part>
  </div>
}

function Part({ title, H, compact, children }: { title: string; H: 'h2' | 'h3'; compact: boolean; children: ReactNode }) {
  return compact ? <Disclosure title={title} headingAs={H}>{children}</Disclosure> : <section aria-label={title}><H>{title}</H>{children}</section>
}
