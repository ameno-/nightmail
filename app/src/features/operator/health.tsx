import { useQuery } from '@tanstack/react-query'
import { DataTable, EmptyState, ErrorState, StatusBadge, type Column } from '../../components/ui'
import { operatorApi, type OperatorHealth } from '../../data/operator'
import { ago, label, number, shortDateTime } from '../../lib/format'
import { HealthFacts, healthColumnDefs } from './skeletons'

// Operator → Health (and a self-hosted installation's Health page): is anything falling behind right now? It reads the
// rollup the minute tick wrote (api/src/health.ts) and asks again every half minute; nothing here measures anything.
// The alerts that are open come first, then every queue, job type, running campaign, route, error code and the
// database as last measured. IDs and counts only.
type Row = { id: string; area: string; what: string; now: string; detail: string; state: 'critical' | 'warning' | 'ok' }
const span = (seconds: number) => seconds < 90 ? `${Math.round(seconds)} s` : seconds < 5_400 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds / 360) / 10} h`
const took = (ms: number) => ms < 1_000 ? `${Math.round(ms)} ms` : span(ms / 1000)
const perSecond = (rate: number) => `${rate >= 10 ? Math.round(rate) : Math.round(rate * 10) / 10}/s`
const size = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`
const behind = (is: boolean): Row['state'] => is ? 'warning' : 'ok'
const measuredAgo = (at: string) => { const text = ago(at); return !text || text === '0m' ? 'Just now' : `${text} ago` }
const errorKind = { code: 'Failed requests', sqlstate: 'Database', error: 'Log lines' } as const

function rows(health: OperatorHealth): Row[] {
  const critical = new Set(health.alerts.filter(alert => alert.severity === 'critical').map(alert => alert.key))
  // A measured row is as severe as its alert: a queue behind is "Behind" in the alert's own tone.
  const state = (is: boolean, ...keys: string[]): Row['state'] => !is ? 'ok' : keys.some(key => critical.has(key)) ? 'critical' : 'warning'
  const measured: Row[] = [
    ...health.queues.map(q => ({ id: `queue:${q.name}`, area: 'Queue', what: q.name, now: q.depth ? `${number(q.depth)} waiting` : 'Empty', detail: q.depth ? `oldest ${span(q.oldestSeconds)}` : '', state: state(q.behind, `queue-behind:${q.name}`) })),
    ...(health.jobs ?? []).map(job => ({ id: `jobs:${job.type}`, area: 'Jobs', what: job.type, now: job.pending ? `${number(job.pending)} due, oldest ${span(job.oldestSeconds)}` : 'None due',
      detail: job.failed ? `${number(job.failed)} failed${job.error ? ` · ${job.error}` : ''}` : '', state: state(job.behind, `jobs-behind:${job.type}`, `jobs-failed:${job.type}`) })),
    ...(health.campaigns ?? []).map(c => ({ id: `campaign:${c.id}`, area: 'Campaign', what: c.id,
      now: c.waiting ? label(c.waiting.toLowerCase()) : c.state !== 'sending' ? label(c.state) : c.rate === null ? 'Sending' : `${perSecond(c.rate)}${c.account ? ` of ${perSecond(c.account)}` : ''}`,
      detail: [`${number(c.released)} of ${number(c.total)}`, c.etaSeconds !== null && `${span(c.etaSeconds)} left`, c.bounceRate !== null && c.settled ? `${(c.bounceRate * 100).toFixed(1)}% bounced` : false].filter(Boolean).join(' · '),
      state: state(c.behind, `campaign-slow:${c.id}`, `campaign-bounces:${c.id}`) })),
    ...(health.routes ?? []).map(route => ({ id: `route:${route.route}`, area: 'Route', what: route.route, now: `p95 ${took(route.p95Ms)}`,
      detail: [`${number(route.count)} in 15 min`, `slowest ${took(route.slowestMs)}`, route.errors > 0 && `${number(route.errors)} failed`].filter(Boolean).join(' · '), state: behind(route.behind) })),
    ...(health.errors ?? []).map(error => ({ id: `error:${error.kind}:${error.code}`, area: 'Error', what: error.code, now: `${number(error.count)} in 15 min`, detail: errorKind[error.kind], state: 'ok' as const })),
    ...(health.database ? [
      { id: 'database:transactions', area: 'Database', what: 'Transactions', now: health.database.longTransactions ? `${number(health.database.longTransactions)} open over a minute` : 'None open over a minute',
        detail: health.database.longTransactions ? `oldest ${span(health.database.oldestTransactionSeconds)}` : '', state: state(critical.has('database-transaction')) },
      { id: 'database:queries', area: 'Database', what: 'Queries', now: `${number(health.database.slowQueries)} over 30 s`, detail: `${number(health.database.lockWaits)} waiting on a lock`, state: 'ok' as const },
    ] : []),
  ]
  const order = { critical: 0, warning: 1, ok: 2 }
  return [
    ...health.alerts.map(alert => ({ id: `alert:${alert.key}`, area: 'Alert', what: alert.label, now: alert.words, detail: `since ${shortDateTime(alert.since)} UTC`, state: alert.severity })),
    ...measured.map((row, index) => ({ row, index })).sort((a, b) => order[a.row.state] - order[b.row.state] || a.index - b.index).map(item => item.row),
  ]
}
const def = (key: string) => healthColumnDefs.find(column => column.key === key)!
const columns: Column<Row>[] = [
  { ...def('area'), render: row => <span className="muted">{row.area}</span> },
  { ...def('what'), render: row => <span className="op-cell op-health-what" title={row.what}>{row.what}</span> },
  { ...def('state'), render: row => row.state === 'ok' ? <span className="muted">OK</span> : <StatusBadge status={row.area === 'Alert' ? label(row.state) : 'Behind'} tone={row.state === 'critical' ? 'danger' : 'warning'} /> },
  { ...def('now'), render: row => <span className="op-cell" title={row.now}>{row.now}</span> },
  { ...def('detail'), render: row => row.detail ? <span className="op-cell muted" title={row.detail}>{row.detail}</span> : <span className="muted">—</span>, cardRender: row => row.detail || null },
]

export function HealthView() {
  const query = useQuery({ queryKey: ['operator', 'health'], queryFn: ({ signal }) => operatorApi.health(signal), staleTime: 10_000,
    refetchInterval: current => current.state.status === 'error' ? false : 30_000, refetchIntervalInBackground: false })
  const health = query.data, d = health?.database
  if (query.isError && !health) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />
  return <>
    <HealthFacts values={health ? {
      Measured: health.generatedAt ? <span className={health.stale ? 'op-health-stale' : undefined}>{measuredAgo(health.generatedAt)}</span> : <span className="op-health-stale">Never</span>,
      'Open alerts': number(health.alerts.length),
      'Feedback lag': health.feedbackLagSeconds === null ? '—' : span(health.feedbackLagSeconds),
      'Jobs due': health.jobs ? number(health.jobs.reduce((sum, job) => sum + job.pending, 0)) : '—',
      Connections: d ? `${number(d.connections)} of ${number(d.maxConnections)}` : '—',
      Database: d ? `${size(d.sizeBytes)}${d.diskBytes ? ` of ${size(d.diskBytes)}` : ''}` : '—',
    } : undefined} />
    <DataTable className="op-table" loading={query.isPending} skeletonRows={8} rows={health ? rows(health) : []} rowKey={row => row.id} columns={columns}
      empty={<EmptyState title={health?.generatedAt ? 'Nothing to show' : 'Nothing measured yet'} description={health?.generatedAt ? undefined : 'The first figures arrive within a minute of the job runner starting.'} />} />
  </>
}
