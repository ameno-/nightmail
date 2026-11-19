import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router'
import { ArrowUpRight, Check, ChevronDown } from 'lucide-react'
import { ErrorState, SectionHeader, Skeleton, StatusBadge } from '../../components/ui'
import { useApiDef, useSession, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { monthEstimate } from '../../data/usage'
import { balanceState, priceUc, total, usd } from '../../data/billing'
import { date, number } from '../../lib/format'
import { GOOD_STANDING } from '../../../../api/src/standing-model'
import './usage.css'

const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2 }).format(value)

// Plan & usage (hosted): the daily sending limit first (the evaluation and good standing, with no limit, open from it), then whether billing
// charges yet, the free sent and received allowances (separate) used this month, and this month's counts and cost (the
// prices open from it). Every member can read it; members see sent mail only and no amounts (received mail includes
// messages they can't open). Each value has a skeleton of its own width in a 53px row, so nothing moves as the three
// reads land.
export function PlanUsage({ row: Row }: { row: (props: { title: ReactNode; children: ReactNode }) => ReactNode }) {
  const query = useApiDef(queries.usage(), { interval: 60_000 })
  const billing = useApiDef(queries.billing(), { interval: 60_000 })
  const { canAdminister } = useWorkspaceAccess()
  const month = useApiDef(queries.billingMonth(), { enabled: canAdminister })
  const usage = query.data, b = billing.data
  const free = useSession()?.identity?.billing?.free === true
  if (query.isError && !usage) return <><SectionHeader title="Plan & usage" /><ErrorState error={query.error} onRetry={() => void query.refetch()} /></>
  const value = (ready: unknown, render: () => ReactNode, width = 120) => ready ? render() : <Skeleton width={width} height={20} />
  const enforced = b?.enforcement === 'enforce', state = b ? balanceState(b) : null
  // The omen meter counts AI decisions; it keeps its name from before the rename in the API.
  const decisionCount = Number(month.data?.data.filter(p => p.meter === 'omen').reduce((sum, p) => sum + BigInt(p.quantity), 0n) ?? 0n)
  const aged = b ? Number(BigInt(b.free.storage.agedBytes)) : 0
  // The API's steps (the evaluation) reserve their space while loading; good standing, with no limit, follows them.
  const steps = usage ? usage.steps : [null]
  const daily = usage?.daily
  // Where the workspace is: a step, past them all (no daily limit), or on a limit no step has (set by its score, a
  // warning or the team), which the badge names.
  const at = !daily ? null : daily.cap === null ? steps.length : daily.step
  const custom = daily?.cap != null && daily.step === null
  const pricing = usage?.pricing
  return <>
    <SectionHeader title="Plan & usage" />
    <div className="settings-rows usage-rows">
      {/* The limit and where it is now first; the steps it grows through open from it. */}
      <details className="usage-limit">
        <summary className="settings-row">
          <span className="settings-row__label"><span className="usage-limit__title">Daily limit<ChevronDown size={14} aria-hidden="true" />{custom && <StatusBadge status="Limited" tone="neutral" />}</span></span>
          <span className="settings-row__control">{value(usage, () => !daily ? <span className="muted">Connect sending first</span> : daily.cap === null ? 'No daily limit' : <DailyMeter used={daily.used} cap={daily.cap} resetAt={daily.resetAt} />, 160)}</span>
        </summary>
        <div className="usage-steps-section">
          <ol className="usage-steps">{steps.map((step, index) => {
            const current = at === index, done = at != null && index < at
            return <li key={index} data-current={current || undefined} data-done={done || undefined} style={{ '--i': index } as CSSProperties}>
              <span className="usage-steps__mark" aria-hidden="true">{done ? <Check size={12} strokeWidth={2.75} /> : index + 1}</span>
              {step ? <span className="usage-steps__body"><span><b>{number(step.cap)}</b> recipients a day{current && <span className="usage-steps__badge">You’re here</span>}</span><span className="muted">{step.requires}</span></span> : <span className="usage-steps__body"><Skeleton width={160} height={20} /><Skeleton width={280} height={16} /><Skeleton width={200} height={16} /></span>}
            </li>
          })}
            <li data-current={at === steps.length || undefined} style={{ '--i': steps.length } as CSSProperties}>
              <span className="usage-steps__mark" aria-hidden="true">{steps.length + 1}</span>
              <span className="usage-steps__body"><span><b>No daily limit</b>{at === steps.length && <span className="usage-steps__badge">You’re here</span>}</span><span className="muted">{`Good standing: a sender score of ${GOOD_STANDING} or more, with no warning. Sending is paced per minute.`}</span></span>
            </li>
          </ol>
        </div>
      </details>
      <Row title="Balance">{value(b, () => <span className="cluster settings-inline">
        <StatusBadge status={enforced || free ? state!.label : 'Not charged yet'} tone={enforced || free ? state!.tone : 'neutral'} />
        {b!.balance && !free && <Link to="/settings#billing" replace className="settings-score"><span>{usd(total(b!.balance))}</span><ArrowUpRight size={14} aria-hidden="true" /></Link>}
      </span>, 160)}</Row>
      <Row title="Free sends">{value(b, () => <Meter used={b!.free.sent.used} cap={b!.free.sent.limit} label="Free sends used" />, 160)}</Row>
      <Row title="Free received">{value(b, () => b!.free.received ? <Meter used={b!.free.received.used} cap={b!.free.received.limit} label="Free received used" /> : <span className="muted">Owners and admins</span>, 160)}</Row>
      <Row title="Stored past 90 days">{value(b, () => `${gigabytes(aged)} of ${gigabytes(b!.free.storage.limitBytes)} free`, 140)}</Row>
      <Row title="This month">{value(usage && (!canAdminister || month.data || month.isError), () => [`${number(usage!.month.sent)}\u00a0sent`, usage!.month.received === null ? null : `${number(usage!.month.received)}\u00a0received`, canAdminister && !month.isError ? `${number(decisionCount)}\u00a0AI decisions` : null].filter(Boolean).join(' · '), 200)}</Row>
      {/* This month's cost; the prices it is worked out from open from it, like the limit's steps. */}
      <details className="usage-limit">
        <summary className="settings-row">
          <span className="settings-row__label"><span className="usage-limit__title">Estimated cost<ChevronDown size={14} aria-hidden="true" /></span></span>
          <span className="settings-row__control">{value(b && usage, () => b!.monthToDate ? usd(b!.monthToDate.cost) : money(monthEstimate(usage!)), 80)}</span>
        </summary>
        <div className="usage-prices">
          <dl>
            <div><dt>Email</dt><dd>{pricing ? `${money(pricing.perThousand)} per 1,000, sent or received` : <Skeleton width={200} height={16} />}</dd></div>
            <div><dt>Free each month</dt><dd>{pricing ? `${number(pricing.freeSentEmails)} sent, ${number(pricing.freeReceivedEmails)} received` : <Skeleton width={160} height={16} />}</dd></div>
            <div><dt>Stored past 90 days</dt><dd>{pricing && b ? `${gigabytes(pricing.freeStorageBytes)} free, then ${usd(priceUc(b.prices.storagePerGbMonth))} per GB-month` : <Skeleton width={220} height={16} />}</dd></div>
          </dl>
          <Link to="/legal/terms#prices">All prices</Link>
        </div>
      </details>
    </div>
  </>
}

const gigabytes = (bytes: number) => `${(bytes / 1e9).toLocaleString('en-US', { maximumFractionDigits: bytes > 0 && bytes < 1e8 ? 2 : 1 })} GB`
function Meter({ used, cap, label }: { used: number; cap: number; label: string }) {
  const share = Math.min(1, used / Math.max(1, cap))
  return <span className="usage-meter">
    <span className="usage-meter__track" data-full={share >= 0.9 || undefined} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={cap} aria-valuenow={used}><i style={{ transform: `scaleX(${share})` }} /></span>
    <span className="usage-meter__count">{number(used)} / {number(cap)}</span>
  </span>
}

function DailyMeter({ used, cap, resetAt }: { used: number; cap: number; resetAt: string | null }) {
  const share = Math.min(1, used / Math.max(1, cap))
  return <span className="usage-meter" title={resetAt ? `Capacity frees up from ${date(resetAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })} UTC` : undefined}>
    <span className="usage-meter__track" data-full={share >= 0.9 || undefined} role="meter" aria-label="Recipients used in the last 24 hours" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={used}><i style={{ transform: `scaleX(${share})` }} /></span>
    <span className="usage-meter__count">{number(used)} / {number(cap)}</span>
  </span>
}
