import { useQuery } from '@tanstack/react-query'
import { ErrorState, PageHeader, StatusBadge, type Tone } from '../../components/ui'
import { useSession } from '../../data/context'
import { usd } from '../../data/billing'
import { operatorApi, type Glass, type GlassCount, type GlassGrade } from '../../data/operator'
import { ago, number, percent, time } from '../../lib/format'
import { GlassAsOf, GlassGroups, StaffOnly, type GlassFill } from './skeletons'

// Glass (/glass): everything going on in Nightmail on one page, for operators only (anyone else gets the app's "Page
// not found", and the API the 404 of a route that doesn't exist). One read (api/src/glass.ts), again every 30 seconds;
// the rows are fixed in ./skeletons, so a refresh replaces figures in place. Each group links to the page with the detail.
const grades: GlassGrade[] = ['A+', 'A', 'B', 'C', 'D', 'F']
// The lines the Overview's gauges end at (features/overview): 5% bounces, 0.1% complaints.
const BOUNCE_LINE = 0.05, COMPLAINT_LINE = 0.001
const count = (c: GlassCount) => `${number(c.n)}${c.atLeast ? '+' : ''}`
const share = (part: number, whole: number) => whole > 0 ? part / whole : 0
const rateText = (rate: number) => rate > 0 && rate < 0.0001 ? percent(rate, 3) : percent(rate)
const compact = (n: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
const since = (at: string | null) => { const text = ago(at); return text === null ? null : text === '0m' ? 'just now' : `${text} ago` }
const zone = (rate: number, line: number): Tone | undefined => rate >= line ? 'danger' : rate >= line / 2 ? 'warning' : undefined
const health: Record<Glass['system']['status'], [string, Tone]> = { ok: ['OK', 'success'], warning: ['Warning', 'warning'], critical: ['Critical', 'danger'], stale: ['Not measured', 'danger'] }
const split = (s: { open: number; waitlist: number }) => `${number(s.waitlist)} waitlist`
const empty = (shown: boolean, text: string): GlassFill => ({ label: shown ? text : '', value: '', empty: true })

function fill(g: Glass) {
  const { signups, sending: s, delivery, receiving, money, system, visitors } = g
  const day = s.hourly.reduce((sum, h) => ({ accepted: sum.accepted + h.accepted, delivered: sum.delivered + h.delivered, bounced: sum.bounced + h.bounced, complained: sum.complained + h.complained }), { accepted: 0, delivered: 0, bounced: 0, complained: 0 })
  const bounced = share(day.bounced, day.accepted), complained = share(day.complained, day.accepted), perSecond = s.perMinute / 60, alerts = system.alerts.critical + system.alerts.warning
  const f = signups.funnel, ses = system.ses
  const rows: Record<string, Record<string, GlassFill>> = {
    sending: {
      minute: { spark: s.minutes, value: number(s.perMinute) },
      transactional: { hint: 'today', spark: s.hourly.map(h => h.accepted - h.marketing), value: number(s.today.transactional) },
      marketing: { hint: 'today', spark: s.hourly.map(h => h.marketing), value: number(s.today.marketing) },
      queued: { value: count(s.queued) },
      held: { value: count(s.held), tone: s.held.n ? 'warning' : undefined },
      api: s.sendApi ? { hint: `p95 ≤ ${number(s.sendApi.p95Ms)}`, value: `≤ ${number(s.sendApi.p50Ms)}`, unit: 'ms' } : { hint: 'idle', value: '—' },
      ...Object.fromEntries([0, 1].map(i => { const c = s.campaigns[i]; return [`campaign:${i}`, c ? { label: c.name, hint: c.workspace, value: percent(share(c.released, c.total), 0),
        meter: { value: c.released, max: Math.max(1, c.total), label: `${c.name}: ${number(c.released)} of ${number(c.total)} released` } } : empty(i === 0, 'No campaign sending')] })),
    },
    delivery: {
      delivered: { hint: number(day.delivered), spark: s.hourly.map(h => h.delivered), value: day.accepted ? percent(share(day.delivered, day.accepted), 1) : '—' },
      bounced: { hint: number(day.bounced), spark: s.hourly.map(h => h.bounced), value: day.accepted ? rateText(bounced) : '—', tone: zone(bounced, BOUNCE_LINE),
        meter: { value: bounced, max: BOUNCE_LINE * 2, mark: BOUNCE_LINE, tone: zone(bounced, BOUNCE_LINE), label: `Bounced ${rateText(bounced)} of a ${percent(BOUNCE_LINE, 0)} line` } },
      complained: { hint: number(day.complained), spark: s.hourly.map(h => h.complained), value: day.accepted ? rateText(complained) : '—', tone: zone(complained, COMPLAINT_LINE),
        meter: { value: complained, max: COMPLAINT_LINE * 2, mark: COMPLAINT_LINE, tone: zone(complained, COMPLAINT_LINE), label: `Complained ${rateText(complained)} of a ${percent(COMPLAINT_LINE, 1)} line` } },
      grades: { value: null, grades: [...grades.map(grade => ({ grade, count: number(delivery.grades[grade]) })), { grade: 'Warmup', count: number(delivery.calibrating) }] },
      paused: { value: number(delivery.paused), tone: delivery.paused ? 'danger' : undefined },
      held: { value: number(delivery.held), tone: delivery.held ? 'warning' : undefined },
    },
    system: {
      health: { hint: alerts ? `${number(alerts)} ${alerts === 1 ? 'alert' : 'alerts'}` : system.measuredAt ? `measured ${since(system.measuredAt)}` : 'never measured',
        value: <StatusBadge status={health[system.status][0]} tone={health[system.status][1]} /> },
      ...Object.fromEntries([0, 1, 2].map(i => { const a = system.alerts.top[i]; return [`alert:${i}`, a ? { label: a.label, hint: a.words, value: ago(a.since), tone: a.severity === 'critical' ? 'danger' : 'warning' } : empty(i === 0, 'No open alerts')] })),
      rate: ses ? { hint: `${ses.regions} ${ses.regions === 1 ? 'region' : 'regions'}`, value: `${perSecond < 10 ? perSecond.toFixed(1) : Math.round(perSecond)} / ${number(ses.maxSendRate)}`, unit: '/s',
        meter: { value: perSecond, max: Math.max(1, ses.maxSendRate), label: 'Sending rate of the SES limit' } } : { hint: 'No pool region', value: '—' },
      day: ses ? { hint: percent(share(ses.sentLast24Hours, ses.max24HourSend), 0), value: `${compact(ses.sentLast24Hours)} / ${compact(ses.max24HourSend)}`,
        meter: { value: ses.sentLast24Hours, max: Math.max(1, ses.max24HourSend), label: 'Sent in 24 hours of the SES limit' } } : { value: '—' },
      deploy: { hint: system.deploy.at ? since(system.deploy.at) : undefined, value: system.deploy.sha?.slice(0, 7) ?? '—' },
    },
    signups: {
      today: { hint: split(signups.today), spark: signups.daily, value: number(signups.today.open + signups.today.waitlist) },
      week: { hint: split(signups.week), value: number(signups.week.open + signups.week.waitlist) },
      open: { hint: `of ${number(signups.places.limit)}`, value: number(signups.places.open) },
      waiting: { hint: signups.places.held ? `${number(signups.places.held)} held` : undefined, value: number(signups.places.waiting) },
    },
    funnel: Object.fromEntries((['signedUp', 'domainAdded', 'domainVerified', 'keyCreated', 'firstSend'] as const).map((step, i) => [step, {
      hint: i && f.signedUp ? percent(share(f[step], f.signedUp), 0) : undefined, value: number(f[step]), meter: { value: f[step], max: Math.max(1, f.signedUp) } }])),
    money: {
      creditToday: { value: usd(money.creditToday) },
      creditMonth: { spark: money.creditDaily, value: usd(money.creditMonth) },
      owed: { hint: money.owing ? `${number(money.owing)} ${money.owing === 1 ? 'workspace' : 'workspaces'}` : undefined, value: usd(money.owed), tone: BigInt(money.owed) > 0n ? 'warning' : undefined },
      usage: { value: usd(money.usageMonth) },
    },
    receiving: {
      today: { spark: receiving.hourly, value: `${number(receiving.today)}${receiving.atLeast ? '+' : ''}` },
      spam: { hint: receiving.today ? percent(share(receiving.spam, receiving.today), 1) : undefined, value: number(receiving.spam) },
    },
    visitors: {
      views: { hint: 'today', spark: visitors.hourly, value: number(visitors.views) },
      visitors: { hint: 'today', value: count(visitors.visitors) },
      ...Object.fromEntries([0, 1, 2].map(i => { const r = visitors.referrers[i]; return [`referrer:${i}`, r ? { label: r.host, value: number(r.views) } : empty(i === 0, 'No referrers yet')] })),
    },
  }
  return (group: string, row: string) => rows[group]?.[row] ?? { value: '—' }
}

export function GlassPage() {
  const operator = useSession()?.identity?.operator
  return operator ? <GlassView /> : <StaffOnly />
}
function GlassView() {
  const query = useQuery({ queryKey: ['operator', 'glass'], queryFn: ({ signal }) => operatorApi.glass(signal), staleTime: 10_000,
    refetchInterval: current => current.state.status === 'error' ? false : 30_000, refetchIntervalInBackground: false })
  const glass = query.data
  return <>
    <PageHeader title="Glass" actions={<GlassAsOf at={glass && `${time(glass.generatedAt)} UTC`} />} />
    {query.isError && !glass ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : <GlassGroups fill={glass && fill(glass)} />}
  </>
}
