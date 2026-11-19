import { useEffect, useRef, type CSSProperties } from 'react'
import { Link } from 'react-router'
import { Button, Dialog, Disclosure, ErrorState, SkeletonText } from '../../components/ui'
import type { SenderScore, SenderScoreFactor } from '../../data/types'
import { closeScoreAbout, useScoreAbout } from '../../lib/score-about'
import { number, relativeTime } from '../../lib/format'
import { gradeKey } from '../../lib/standing'
import { GOOD_STANDING, GRADE_BANDS } from '../../../../api/src/standing-model'

const percent = (digits: number) => (value: number) => `${(value * 100).toFixed(digits)}%`
// Engagement is the marketing unsubscribe rate.
export const factorFormats: Record<SenderScoreFactor['key'], (value: number) => string> = { complaints: percent(2), content: percent(1), bounces: percent(1), hygiene: percent(1), auth: value => `${Math.round(value * 100)}%`, engagement: percent(2) }
const grades = `${GRADE_BANDS.map((band, i) => band.min ? `${band.grade} from ${band.min}` : `${band.grade} below ${GRADE_BANDS[i - 1].min}`).join(', ')}.`
// A time in the viewer's own time zone, with the day when it isn't today.
function clock(value: string) {
  const at = new Date(value), today = new Date().toDateString() === at.toDateString()
  return new Intl.DateTimeFormat('en-US', { ...(today ? {} : { month: 'short', day: 'numeric' }), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
}
/** What the evaluation still needs before the first grade: real emails, or their delivery results and when they are due. */
export function evaluationLeft(report: SenderScore, now = Date.now()) {
  const left = report.needed - report.emails.firstEmails
  if (left > 0) return `${number(left)} more real ${left === 1 ? 'email' : 'emails'} to the first grade`
  if (!report.gradedBy || Date.parse(report.gradedBy) <= now) return 'Waiting for delivery results: graded within minutes'
  return `Waiting for delivery results: graded by ${clock(report.gradedBy)} (${relativeTime(report.gradedBy, now)})`
}

// What the sender score is and where each part stands: one dialog for the whole app, opened from the score card
// (lib/score-about.ts). The status, the 14-day trend and (Hosted) the limit the score sets come first, then the six
// parts, one line each (its weight and where it stands), then how it is graded, with what each part measures.
export function ScoreAbout({ report, error, onRetry }: { report: SenderScore | undefined; error: unknown; onRetry: () => void }) {
  const { open, focus } = useScoreAbout()
  const list = useRef<HTMLUListElement>(null)
  // Opened for one part: that part is in view and marked.
  useEffect(() => { if (open && focus) requestAnimationFrame(() => list.current?.querySelector(`[data-key="${focus}"]`)?.scrollIntoView({ block: 'nearest' })) }, [open, focus])
  const graded = report?.state === 'graded'
  const days = graded ? report.history.slice(-14) : [], offset = 14 - days.length
  const low = days.length ? Math.min(...days.map(day => day.score)) - 4 : 0, high = days.length ? Math.max(...days.map(day => day.score)) : 1
  const moved = graded && report.history.length ? Math.round(report.score! - report.history[0].score) : 0
  const limit = report?.limit
  const limitLine = !limit ? null : [limit.daily === null ? 'No daily limit' : `Daily limit ${number(limit.daily)}${limit.source === 'override' ? ' (override)' : ''}`,
    limit.growth ? `growing: up to ${number(limit.growth.hourly)} this hour` : null,
    graded && limit.next ? limit.next.unlimited ? `none from ${limit.next.atScore}` : `next ${number(limit.next.limit)} at ${limit.next.atScore}` : null, `${number(limit.perMinute)} a minute`, limit.transactionalReserve ? `${number(limit.transactionalReserve)} kept for receipts` : null].filter(Boolean).join(' · ')
  return <Dialog open={open} onOpenChange={next => { if (!next) closeScoreAbout() }} className="score-about" title="Sender score"
    footer={<><Link className="ui-button ui-button--ghost ui-button--md" to="/docs/api/getSenderScore" onClick={closeScoreAbout}>API reference</Link><Button variant="primary" onClick={closeScoreAbout}>Done</Button></>}>
    {!report ? error ? <ErrorState error={error} onRetry={onRetry} /> : <div className="score-about__status"><SkeletonText width="60%" /></div> : <>
      <div className="score-about__status" data-grade={graded && report.grade ? gradeKey(report.grade) : undefined}>
        <b>{graded ? Math.round(report.score!) : '—'}</b>
        <div className="score-about__status-text">
          <span>{graded ? <>Grade <strong className="score-about__grade">{report.grade}</strong> · {report.next ? `${Math.ceil(report.next.at - report.score!)} points to ${report.next.grade}` : 'Top grade'}</> : 'Not graded yet'}</span>
          <span className="muted">{graded ? `From ${number(report.emails.last30Days)} real emails in 30 days${report.history.length ? ` · ${moved > 0 ? '+' : moved < 0 ? '−' : '±'}${Math.abs(moved)} in 14 days` : ''}` : `${number(report.emails.firstEmails)} of ${number(report.needed)} real emails. ${evaluationLeft(report)}.`}</span>
        </div>
        {graded && <div className="score-about__history" role="img" aria-label={days.length ? `Daily score over ${days.length} days, from ${Math.round(days[0].score)} to ${Math.round(report.score!)}.` : 'No history yet.'}>
          {Array.from({ length: 14 }, (_, i) => { const day = days[i - offset]; return <span key={i} data-last={i === 13 || undefined} style={{ transform: `scaleY(${day ? Math.max(.1, (day.score - low) / Math.max(1, high - low)) : .1})` }} /> })}
        </div>}
        {!graded && <span className="score-about__progress" role="meter" aria-label="Real emails before the first grade" aria-valuemin={0} aria-valuemax={report.needed} aria-valuenow={report.emails.firstEmails} style={{ '--share': `${Math.min(100, report.emails.firstEmails / Math.max(1, report.needed) * 100)}%` } as CSSProperties}><i /></span>}
        {limitLine && <span className="score-about__limit muted">{limitLine}</span>}
      </div>
      <ul ref={list} className="score-about__factors" aria-label="The six parts">{report.factors.map(factor => <li key={factor.key} data-key={factor.key} data-focus={focus === factor.key || undefined}>
        <div className="score-about__factor-name"><span>{factor.label}</span><span className="muted">{factor.weight}%</span></div>
        <span className="score-about__factor-now">{graded && factor.source === 'measured' ? <>{factorFormats[factor.key](factor.value!)}<span className="muted"> · {Math.round(factor.score!)}/100</span></> : <span className="muted">{graded ? 'No data, left out' : '—'}</span>}</span>
      </li>)}</ul>
      <Disclosure className="score-about__section" title="How it’s graded">
        <dl className="score-about__bases">{report.factors.map(factor => <div key={factor.key}><dt>{factor.label}</dt><dd>{factor.basis}</dd></div>)}</dl>
        <ul>
          <li>Each part scores 0–100. Parts with no data are left out and the rest count more.</li>
          <li>Recent days count most (30-day half-life). It updates hourly.</li>
          <li>Your first {number(report.needed)} real emails set it once their results are in.{report.limit ? ` ${GOOD_STANDING} and up has no daily limit.` : ''}</li>
          <li>Counts every email you send except simulated sends. Mail only to <code>…@simulator.amazonses.com</code> uses your daily limit but not the score.</li>
          <li>{grades}</li>
        </ul>
      </Disclosure>
    </>}
  </Dialog>
}
