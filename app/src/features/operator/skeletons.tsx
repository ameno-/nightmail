import { forwardRef, type ReactNode } from 'react'
import { ArrowUpRight, ChevronDown, Download } from 'lucide-react'
import { Link, useLocation } from 'react-router'
import { useSession } from '../../data/context'
import { Button, type ButtonProps, EmptyState, FacetRail, LoadingRegion, Meter, MetricRow, PageHeader, SearchField, SectionHeader, Select, Skeleton, Sparkline, SplitPane, TableSkeleton, Tabs, type FacetGroup, type SkeletonColumn, type Tone } from '../../components/ui'
import type { AbuseBand } from '../../data/operator'
import './operator.css'

// Not an operator: no such page. An operator signed in with GitHub: staff tools need this account's Google sign-in
// (api/src/account-policy.ts), one button away.
export function StaffOnly() {
  const session = useSession()
  return session?.identity?.staffSignIn
    ? <EmptyState headingAs="h1" title="Sign in with Google to use staff tools" action={<Button variant="primary" onClick={session.signInForStaff}>Sign in with Google</Button>} />
    : <EmptyState headingAs="h1" title="Page not found" action={<Link to="/overview">Return to overview</Link>} />
}

// The operator console's column definitions (card slots included), shared by the route skeleton and the loaded tables.
export const queueColumnDefs: SkeletonColumn[] = [
  { key: 'name', label: 'Workspace', width: '25%' },
  { key: 'step', label: 'Step', width: 112, card: 'aside' },
  { key: 'reason', label: 'Why', card: 'line' },
  { key: 'score', label: 'Score', width: 72, align: 'right', card: 'line' },
  { key: 'limit', label: 'Daily limit', width: 104, align: 'right', card: 'inline' },
  { key: 'since', label: 'Since', width: 160, card: 'inline' },
]
export const actionColumnDefs: SkeletonColumn[] = [
  { key: 'action', label: 'Action', width: '20%' },
  { key: 'at', label: 'When', width: 160, card: 'aside' },
  { key: 'workspace', label: 'Workspace', width: '18%', card: 'line' },
  { key: 'reason', label: 'Reason', card: 'line' },
  { key: 'ticket', label: 'Ticket', width: 140, card: 'inline' },
]
export const factorColumnDefs: SkeletonColumn[] = [
  { key: 'factor', label: 'Factor', width: '30%' },
  { key: 'score', label: 'Score', width: 80, align: 'right', card: 'aside' },
  { key: 'value', label: 'Value', width: 96, align: 'right', card: 'line' },
  { key: 'weight', label: 'Weight', width: 80, align: 'right', card: 'inline' },
  { key: 'points', label: 'Points', width: 80, align: 'right', card: 'inline' },
]
export const domainColumnDefs: SkeletonColumn[] = [
  { key: 'name', label: 'Domain', width: '30%' },
  { key: 'pool', label: 'Pool', width: 112, card: 'aside' },
  { key: 'region', label: 'Region', width: 112, card: 'line' },
  { key: 'dkim', label: 'DKIM', width: 80, card: 'inline' },
  { key: 'mailFrom', label: 'MAIL FROM', width: 104, card: 'inline' },
  { key: 'dmarc', label: 'DMARC', width: 112, card: 'line' },
]
export const memberColumnDefs: SkeletonColumn[] = [
  { key: 'email', label: 'Email', width: '46%' },
  { key: 'role', label: 'Role', width: 120, card: 'aside' },
  { key: 'user', label: 'User', card: 'line' },
  { key: 'billing', label: 'Billing', width: 180, card: 'line' },
  { key: 'actions', label: '', width: 48, card: 'end' },
]
export const campaignColumnDefs: SkeletonColumn[] = [
  { key: 'name', label: 'Campaign', width: '30%' },
  { key: 'state', label: 'State', width: 112, card: 'aside' },
  { key: 'pause', label: 'Pause reason', card: 'line' },
  { key: 'quarantines', label: 'Quarantines', width: 112, align: 'right', card: 'inline' },
  { key: 'actions', label: '', width: 56, align: 'right', card: 'end' },
]
export const timelineColumnDefs: SkeletonColumn[] = [
  { key: 'title', label: 'Event', width: '40%' },
  { key: 'kind', label: 'Kind', width: 112, card: 'aside' },
  { key: 'detail', label: 'Detail', card: 'line' },
  { key: 'at', label: 'When', width: 160, card: 'line' },
]
// The waitlist (?view=waitlist): a phone's card shows the address, its latest attempt, the name and the count, then
// whether a raise of the sign-up limit let it in and its email went.
export const waitlistColumnDefs: SkeletonColumn[] = [
  { key: 'email', label: 'Email', width: '28%', card: 'title' },
  { key: 'name', label: 'Name', card: 'line' },
  { key: 'first', label: 'First attempt', width: 176, card: 'inline' },
  { key: 'last', label: 'Last attempt', width: 176, card: 'aside' },
  { key: 'attempts', label: 'Attempts', width: 96, align: 'right', card: 'inline' },
  { key: 'letIn', label: 'Let in', width: 216, card: 'line' },
]

// Sign-ups (?view=signups): the limit and what fills it, then every workspace, newest first. A phone's card shows the
// name and standing, the owner and when it joined, then its verified domain and what it sent.
export const signupFacts = ['Signed up', 'Held for the waitlist', 'Open', 'Waiting'] as const
export function SignupFacts({ values }: { values?: Record<(typeof signupFacts)[number], ReactNode> }) {
  return <dl className="op-facts op-facts--four">{signupFacts.map(title => <div key={title}><dt>{title}</dt><dd>{values ? values[title] : <Skeleton width={72} height={14} />}</dd></div>)}</dl>
}
export const signupColumnDefs: SkeletonColumn[] = [
  { key: 'name', label: 'Workspace', width: '24%', card: 'title' },
  { key: 'owner', label: 'Owner', card: 'line' },
  { key: 'joined', label: 'Joined', width: 160, card: 'inline' },
  { key: 'domain', label: 'Domain', width: '18%', card: 'line' },
  { key: 'sent', label: 'Sent', width: 104, align: 'right', card: 'inline' },
  { key: 'standing', label: 'Standing', width: 112, card: 'aside' },
]
// Health (?view=health; the whole page on a self-hosted installation): six facts, then one table of what the minute
// tick measured, alerts first. A phone's card shows what it is and its state, the area, then the figures.
export const healthFacts = ['Measured', 'Open alerts', 'Feedback lag', 'Jobs due', 'Connections', 'Database'] as const
export function HealthFacts({ values }: { values?: Record<(typeof healthFacts)[number], ReactNode> }) {
  return <dl className="op-facts">{healthFacts.map(title => <div key={title}><dt>{title}</dt><dd>{values ? values[title] : <Skeleton width={72} height={14} />}</dd></div>)}</dl>
}
export const healthColumnDefs: SkeletonColumn[] = [
  { key: 'area', label: 'Area', width: 112, card: 'inline' },
  { key: 'what', label: 'What', width: '24%', card: 'title' },
  { key: 'state', label: 'State', width: 112, card: 'aside' },
  { key: 'now', label: 'Now', card: 'line' },
  { key: 'detail', label: 'Detail', width: '24%', card: 'line' },
]
export const HealthSkeleton = () => <><HealthFacts /><TableSkeleton className="op-table" columns={healthColumnDefs} rows={8} /></>
// A self-hosted installation has no operator area: Health is its whole page.
export function SelfHostedHealthSkeleton() {
  return <><PageHeader title="Health" /><LoadingRegion label="Loading health"><div className="op-page"><HealthSkeleton /></div></LoadingRegion></>
}
// The Sign-ups tab's header action, for the operator role: it opens the limit's dialog.
export const SetLimitTrigger = (props: ButtonProps) => <Button {...props}>Set limit…</Button>

// UI notes (/operator/notes): staff's design and bug notes on the dashboard. The screenshot column is for the table; a
// phone's card shows the note, its status, page, type and age, with its selection checkbox at the end for the bulk menu.
export const noteColumnDefs: SkeletonColumn[] = [
  { key: 'select', label: '', width: 40, card: 'end' },
  { key: 'shot', label: 'Screenshot', width: 96, card: 'hide' },
  { key: 'note', label: 'Note', card: 'title' },
  { key: 'status', label: 'Status', width: 124, card: 'aside' },
  { key: 'page', label: 'Page', width: '20%', card: 'line' },
  { key: 'kind', label: 'Type', width: 104, card: 'inline' },
  { key: 'created', label: 'Left', width: 168, card: 'inline' },
  { key: 'actions', label: '', width: 48, align: 'right', card: 'end' },
]
export const noteStatusOptions = [{ value: '', label: 'Open and in progress' }, { value: 'open', label: 'Open' }, { value: 'in_progress', label: 'In progress' }, { value: 'fixed', label: 'Fixed' }, { value: 'wontfix', label: 'Won’t fix' }, { value: 'all', label: 'All notes' }]
export const noteKindOptions = [{ value: '', label: 'All types' }, ...['alignment', 'spacing', 'copy', 'bug', 'motion', 'mobile', 'other'].map(kind => ({ value: kind, label: kind[0]!.toUpperCase() + kind.slice(1) }))]
export function NotesToolbar({ search = '', status = '', kind = '', onSearch, onStatus, onKind, actions, disabled = false }: { search?: string; status?: string; kind?: string; onSearch?: (value: string) => void; onStatus?: (value: string) => void; onKind?: (value: string) => void; actions?: ReactNode; disabled?: boolean }) {
  return <div className="data-toolbar"><div className="cluster">
    <SearchField className="search-box--list" aria-label="Search notes and pages" placeholder="Search notes and pages" value={search} disabled={disabled} onChange={event => onSearch?.(event.target.value)} />
    <Select aria-label="Filter by status" value={status} onValueChange={value => onStatus?.(value)} disabled={disabled} options={noteStatusOptions} />
    <Select aria-label="Filter by type" value={kind} onValueChange={value => onKind?.(value)} disabled={disabled} options={noteKindOptions} />
  </div>{actions ?? <Button className="op-bulk" disabled>Select notes <ChevronDown size={14} aria-hidden="true" /></Button>}</div>
}
export function OperatorNotesSkeleton() {
  return <>
    <PageHeader title="Operator" actions={<Button disabled>Agent keys</Button>} />
    <LoadingRegion label="Loading UI notes"><div className="op-page">
      <Tabs value="notes" onValueChange={() => {}} disabled items={notesTabs} label="Operator views" />
      <NotesToolbar disabled />
      <TableSkeleton className="op-notes" columns={noteColumnDefs} rows={6} />
    </div></LoadingRegion>
  </>
}

// Abuse (?view=abuse): clusters of related accounts by risk, and the alert outbox (&show=alerts). A phone's card shows
// the reasons, the risk beside them, then the counts and when it last changed.
export const clusterColumnDefs: SkeletonColumn[] = [
  { key: 'risk', label: 'Risk', width: 132, card: 'aside' },
  { key: 'why', label: 'Why', card: 'title' },
  { key: 'accounts', label: 'Accounts', width: 96, align: 'right', card: 'inline' },
  { key: 'workspaces', label: 'Workspaces', width: 112, align: 'right', card: 'inline' },
  { key: 'changed', label: 'Changed', width: 168, card: 'line' },
]
export const alertColumnDefs: SkeletonColumn[] = [
  { key: 'alert', label: 'Alert', card: 'title' },
  { key: 'status', label: 'Slack', width: 132, card: 'aside' },
  { key: 'workspaces', label: 'Workspaces', width: 112, align: 'right', card: 'inline' },
  { key: 'created', label: 'Created', width: 168, card: 'line' },
]
// One cluster (/operator/abuse/:id): its workspaces with this month's free use, and its accounts.
export const clusterWorkspaceColumnDefs: SkeletonColumn[] = [
  { key: 'name', label: 'Workspace', width: '26%', card: 'title' },
  { key: 'account', label: 'Account', width: 88, card: 'aside' },
  { key: 'plan', label: 'Plan', width: 88, card: 'inline' },
  { key: 'sent', label: 'Sent', width: 128, align: 'right', card: 'line' },
  { key: 'received', label: 'Received', width: 128, align: 'right', card: 'line' },
  { key: 'step', label: 'Step', width: 112, card: 'inline' },
  { key: 'actions', label: '', width: 48, align: 'right', card: 'end' },
]
export const clusterAccountColumnDefs: SkeletonColumn[] = [
  { key: 'key', label: 'Account', width: 88, card: 'aside' },
  { key: 'who', label: 'Sign-in', card: 'title' },
  { key: 'user', label: 'User', width: '34%', card: 'line' },
]
export const bandLabel: Record<AbuseBand, string> = { high: 'High', review: 'Review', watch: 'Watch', low: 'Low' }
export const bandTone: Record<AbuseBand, Tone> = { high: 'danger', review: 'warning', watch: 'info', low: 'neutral' }
export const abuseBands: AbuseBand[] = ['high', 'review', 'watch', 'low']
/** What the Abuse tab shows: ?band=high narrows the clusters; ?show=alerts is the alert outbox. */
export const abuseView = (search: string) => { const params = new URLSearchParams(search), band = params.get('band'); return { alerts: params.get('show') === 'alerts', band: abuseBands.includes(band as AbuseBand) ? band as AbuseBand : null } }
// The rail beside the list: risk levels with their counts, and the outbox. Counts arrive with the list (a dash until then).
export function abuseFacets({ band, alerts, counts, outbox, onBand, onAlerts }: { band: AbuseBand | null; alerts: boolean; counts?: Record<AbuseBand, number>; outbox?: number; onBand?: (band: AbuseBand | null) => void; onAlerts?: () => void }): FacetGroup[] {
  const pick = (value: AbuseBand | null) => onBand ? () => onBand(value) : undefined
  return [
    { key: 'risk', title: 'Risk', items: [{ key: 'all', label: 'All', count: counts ? abuseBands.reduce((sum, key) => sum + counts[key], 0) : null, selected: !alerts && band === null, onSelect: pick(null) },
      ...abuseBands.map(key => ({ key, label: bandLabel[key], tone: bandTone[key], count: counts ? counts[key] : null, selected: !alerts && band === key, onSelect: pick(key) }))] },
    { key: 'outbox', title: 'Outbox', items: [{ key: 'alerts', label: 'Alerts', count: outbox ?? null, selected: alerts, onSelect: onAlerts }] },
  ]
}
export function AbuseSkeleton({ search }: { search: string }) {
  const view = abuseView(search)
  return <SplitPane className="op-abuse" collapse="row" rail={<FacetRail label="Abuse views" groups={abuseFacets(view)} />}><TableSkeleton className="op-table" columns={view.alerts ? alertColumnDefs : clusterColumnDefs} rows={6} /></SplitPane>
}
export const dailyLimitError = 'A whole number from 1 to 10,000,000.'
export const clusterFacts = ['Risk', 'Score', 'Accounts', 'Workspaces', 'First seen', 'Changed'] as const
// The cluster's rail on a wide window: the other clusters, to step through them. Rows are 32px in every state.
export function ClusterRailSkeleton() {
  return <ul className="op-cluster-rail" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <li key={i}><span className="op-cluster-rail__row"><Skeleton width={72} height={12} /><Skeleton width={96} height={12} /></span></li>)}</ul>
}
export function ClusterBodySkeleton() {
  return <div className="op-page" aria-hidden="true">
    <dl className="op-facts">{clusterFacts.map(title => <div key={title}><dt>{title}</dt><dd><Skeleton width={88} height={14} /></dd></div>)}</dl>
    <div className="op-grid"><section className="op-section"><SectionHeader title="Why" /><Skeleton height={224} /></section><section className="op-section"><SectionHeader title="Links" /><Skeleton height={224} /></section></div>
    <section className="op-section"><SectionHeader title="Workspaces" /><TableSkeleton className="op-table" columns={clusterWorkspaceColumnDefs} rows={3} /></section>
  </div>
}
export function OperatorClusterSkeleton() {
  return <>
    <PageHeader title="Related accounts" backTo="/operator?view=abuse" />
    <LoadingRegion label="Loading the cluster"><SplitPane className="op-cluster" rail={<ClusterRailSkeleton />}><ClusterBodySkeleton /></SplitPane></LoadingRegion>
  </>
}

const baseTabs = [{ value: 'queue', label: 'Review queue' }, { value: 'signups', label: 'Sign-ups' }, { value: 'abuse', label: 'Abuse' }, { value: 'actions', label: 'Actions' }, { value: 'waitlist', label: 'Waitlist' }, { value: 'health', label: 'Health' }]
/** The tab a /operator address opens: ?view=signups, ?view=abuse, ?view=actions, ?view=waitlist or ?view=health, else the review queue. */
export const operatorView = (search: string) => { const view = new URLSearchParams(search).get('view'); return view === 'actions' || view === 'waitlist' || view === 'abuse' || view === 'signups' || view === 'health' ? view : 'queue' }
const notesTabs = [...baseTabs, { value: 'notes', label: 'UI notes' }]
/** UI notes has a tab only for the people the API allows (GET /v1/me uiNotes). */
export const useOperatorTabs = () => useSession()?.identity?.uiNotes === true ? notesTabs : baseTabs
export const facts = ['Step', 'Score', 'Daily limit', 'Since', 'Strikes', 'Connection'] as const

export const stepOptions = [{ value: '', label: 'Needs review' }, { value: 'pause', label: 'Paused' }, { value: 'restrict', label: 'Restricted' }, { value: 'warn', label: 'Warned' }, { value: 'notice', label: 'Notice' }]
// Search spans every workspace (by ID or name); the step filter narrows the queue.
export function QueueToolbar({ search = '', step = '', onSearch, onStep, disabled = false }: { search?: string; step?: string; onSearch?: (value: string) => void; onStep?: (value: string) => void; disabled?: boolean }) {
  return <div className="data-toolbar"><div className="cluster">
    <SearchField className="search-box--list" aria-label="Search all workspaces" placeholder="Search all workspaces" value={search} disabled={disabled} onChange={event => onSearch?.(event.target.value)} />
    <Select aria-label="Filter by step" value={step} onValueChange={value => onStep?.(value)} disabled={disabled || search.trim() !== ''} options={stepOptions} />
  </div></div>
}
// Search spans addresses and names; the export downloads everyone the search lists, addresses in full.
export function WaitlistToolbar({ search = '', onSearch, onExport, exporting = false, exportable = false, disabled = false }: { search?: string; onSearch?: (value: string) => void; onExport?: () => void; exporting?: boolean; exportable?: boolean; disabled?: boolean }) {
  return <div className="data-toolbar op-waitlist-tools"><div className="cluster">
    <SearchField className="search-box--list" aria-label="Search the waitlist" placeholder="Search addresses and names" value={search} disabled={disabled} onChange={event => onSearch?.(event.target.value)} />
  </div><Button className="op-export" aria-label="Export as CSV" title="Download everyone listed as a CSV file" disabled={disabled || !exportable} loading={exporting} onClick={onExport}><Download size={16} aria-hidden="true" /><span>Export CSV</span></Button></div>
}
export function OperatorQueueSkeleton({ view = 'queue', search = '', canAct = false }: { view?: string; search?: string; canAct?: boolean }) {
  return <>
    <PageHeader title="Operator" actions={view === 'signups' && canAct ? <SetLimitTrigger disabled /> : undefined} />
    <LoadingRegion label={view === 'waitlist' ? 'Loading the waitlist' : view === 'abuse' ? 'Loading related accounts' : view === 'signups' ? 'Loading sign-ups' : view === 'health' ? 'Loading health' : 'Loading the review queue'}><div className="op-page">
      <Tabs value={view} onValueChange={() => {}} disabled items={useOperatorTabs()} label="Operator views" />
      {view === 'queue' && <QueueToolbar disabled />}
      {view === 'waitlist' && <WaitlistToolbar disabled />}
      {view === 'signups' && <SignupFacts />}
      {view === 'abuse' ? <AbuseSkeleton search={search} /> : view === 'health' ? <HealthSkeleton /> : <TableSkeleton columns={view === 'queue' ? queueColumnDefs : view === 'waitlist' ? waitlistColumnDefs : view === 'signups' ? signupColumnDefs : actionColumnDefs} rows={6} />}
    </div></LoadingRegion>
  </>
}
export function WorkspaceBodySkeleton() {
  return <div className="op-page" aria-hidden="true">
    <dl className="op-facts">{facts.map(title => <div key={title}><dt>{title}</dt><dd><Skeleton width={88} height={14} /></dd></div>)}</dl>
    <div className="op-grid"><section className="op-section"><SectionHeader title="Standing" /><Skeleton height={168} /></section><section className="op-section"><SectionHeader title="Limit" /><Skeleton height={168} /></section></div>
    <section className="op-section"><SectionHeader title="Factors" /><TableSkeleton columns={factorColumnDefs} rows={6} /></section>
  </div>
}
// The workspace's actions menu trigger. It forwards its props and ref, so the menu (or a phone's action sheet) can open from it.
export const ActionsTrigger = forwardRef<HTMLButtonElement, ButtonProps>(function ActionsTrigger(props, ref) {
  return <Button {...props} ref={ref}>Actions <ChevronDown size={14} aria-hidden="true" /></Button>
})
export function OperatorWorkspaceSkeleton({ actions }: { actions: boolean }) {
  return <>
    <PageHeader title="Workspace" backTo="/operator" actions={actions ? <ActionsTrigger disabled /> : undefined} />
    <LoadingRegion label="Loading the workspace"><WorkspaceBodySkeleton /></LoadingRegion>
  </>
}
// Glass (/glass): groups of metric rows, each row a label, a trend and a figure. The layout is fixed here, rows and all
// (a slot's label comes with the figures), so the route's placeholder, the page's loading state and every 30-second
// refresh draw the same rows in the same places. glass.tsx fills them.
export type GlassRowDef = { key: string; label?: string; spark?: true; meter?: true; grades?: true }
export type GlassFill = { label?: ReactNode; hint?: ReactNode; spark?: readonly number[]; value: ReactNode; unit?: ReactNode; tone?: Tone; empty?: boolean
  meter?: { value: number; max: number; mark?: number; tone?: Tone; label?: string }; grades?: { grade: string; count: ReactNode }[] }
const slots = (prefix: string, n: number, extra: Omit<GlassRowDef, 'key'> = {}) => Array.from({ length: n }, (_, i): GlassRowDef => ({ key: `${prefix}:${i}`, ...extra }))
export const glassGroups: { key: string; title: string; to?: [href: string, label: string]; rows: GlassRowDef[] }[] = [
  { key: 'sending', title: 'Sending now', to: ['/operator?view=health', 'Health'], rows: [{ key: 'minute', label: 'Per minute', spark: true }, { key: 'transactional', label: 'Transactional', spark: true }, { key: 'marketing', label: 'Marketing', spark: true },
    { key: 'queued', label: 'Queued' }, { key: 'held', label: 'Held for screening' }, { key: 'api', label: 'Send API' }, ...slots('campaign', 2, { meter: true })] },
  { key: 'delivery', title: 'Delivery · 24 h', to: ['/operator', 'Queue'], rows: [{ key: 'delivered', label: 'Delivered', spark: true }, { key: 'bounced', label: 'Bounced', spark: true, meter: true },
    { key: 'complained', label: 'Complained', spark: true, meter: true }, { key: 'grades', grades: true }, { key: 'paused', label: 'Paused' }, { key: 'held', label: 'Marketing held' }] },
  { key: 'system', title: 'System', to: ['/operator?view=health', 'Health'], rows: [{ key: 'health', label: 'Health' }, ...slots('alert', 3),
    { key: 'rate', label: 'SES rate', meter: true }, { key: 'day', label: 'SES 24 h', meter: true }, { key: 'deploy', label: 'Deploy' }] },
  { key: 'signups', title: 'Sign-ups', to: ['/operator?view=signups', 'Sign-ups'], rows: [{ key: 'today', label: 'Today', spark: true }, { key: 'week', label: '7 days' }, { key: 'open', label: 'Open places' }, { key: 'waiting', label: 'Waiting' }] },
  { key: 'funnel', title: 'Funnel · 30 days', to: ['/operator?view=signups', 'Workspaces'], rows: [{ key: 'signedUp', label: 'Signed up', meter: true }, { key: 'domainAdded', label: 'Added a domain', meter: true },
    { key: 'domainVerified', label: 'Verified it', meter: true }, { key: 'keyCreated', label: 'Created a key', meter: true }, { key: 'firstSend', label: 'Sent mail', meter: true }] },
  { key: 'money', title: 'Money', rows: [{ key: 'creditToday', label: 'Credit today' }, { key: 'creditMonth', label: 'Credit this month', spark: true }, { key: 'owed', label: 'Owed' }, { key: 'usage', label: 'Usage this month' }] },
  { key: 'receiving', title: 'Receiving', to: ['/logs?view=received', 'Logs'], rows: [{ key: 'today', label: 'Today', spark: true }, { key: 'spam', label: 'Spam-flagged' }] },
  { key: 'visitors', title: 'Visitors', rows: [{ key: 'views', label: 'Page views', spark: true }, { key: 'visitors', label: 'Visitors' }, ...slots('referrer', 3)] },
]
const GRADE_SLOTS = ['A+', 'A', 'B', 'C', 'D', 'F', 'Warmup']
/** The groups, filled by `fill`; without it, every figure is a placeholder of its own size. */
export function GlassGroups({ fill }: { fill?: (group: string, row: string) => GlassFill }) {
  return <div className="glass">{glassGroups.map(group => <section key={group.key} className="glass-group" aria-label={group.title}>
    <SectionHeader title={group.title} actions={group.to && <Link className="ui-button ui-button--ghost ui-button--sm" to={group.to[0]}>{group.to[1]} <ArrowUpRight size={16} aria-hidden="true" /></Link>} />
    {group.rows.map(def => {
      const row = fill?.(group.key, def.key)
      if (def.grades) return <div key={def.key} className="glass-grades" role="list" aria-label="Sender scores">{GRADE_SLOTS.map((grade, i) =>
        <span key={grade} role="listitem"><span>{grade}</span><b>{row?.grades?.[i]?.count ?? <Skeleton width={16} height={12} />}</b></span>)}</div>
      return <MetricRow key={def.key} className={row?.empty ? 'glass-empty' : undefined} label={row ? row.label ?? def.label : def.label ?? <Skeleton width={112} height={12} />} hint={row?.hint}
        spark={def.spark && <Sparkline values={row?.spark ?? []} />} value={row ? row.value : <Skeleton width={56} height={14} />} unit={row?.unit} tone={row?.tone}
        meter={def.meter && <Meter value={row?.meter?.value ?? 0} max={row?.meter?.max ?? 1} mark={row?.meter?.mark} tone={row?.meter?.tone} label={row?.meter?.label} />} />
    })}
  </section>)}</div>
}
/** When the figures are from: the clock, in a box as wide as its placeholder. */
export const GlassAsOf = ({ at }: { at?: ReactNode }) => <span className="glass-asof">{at ?? <Skeleton width={96} height={14} />}</span>
export function GlassSkeleton() {
  return <><PageHeader title="Glass" actions={<GlassAsOf />} /><LoadingRegion label="Loading glass"><GlassGroups /></LoadingRegion></>
}

// The route-level placeholder while the operator chunk loads.
export function OperatorRouteSkeleton({ operator }: { operator: 'operator' | 'operator:read' | null | undefined }) {
  const { pathname, search } = useLocation(), identity = useSession()?.identity, uiNotes = identity?.uiNotes === true
  if (!operator) return identity && identity.multiTenant !== true && pathname === '/operator' ? <SelfHostedHealthSkeleton /> : null
  if (pathname === '/operator/notes') return uiNotes ? <OperatorNotesSkeleton /> : null
  if (pathname.startsWith('/operator/abuse/')) return <OperatorClusterSkeleton />
  return pathname.startsWith('/operator/workspaces/') ? <OperatorWorkspaceSkeleton actions={operator === 'operator'} /> : <OperatorQueueSkeleton view={operatorView(search)} search={search} canAct={operator === 'operator'} />
}
