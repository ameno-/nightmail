import { useEffect, useId, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useApi, useApiDef, useApiQuery, useWorkspaceAccess } from '../../data/context'
import { usePrefetchQueries } from '../../data/prefetch'
import { queries } from '../../data/queries'
import { campaignEditable, errorText, type Campaign, type Newsletter, type NewsletterReaders } from '../../data/types'
import { Button, DataTable, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, SkeletonText, StatusBadge, type Column } from '../../components/ui'
import { date, number, percent } from '../../lib/format'
import { NamedAddress } from '../../components/PrivateAddress'
import { AdminOnlyPage } from '../settings/admin-only'
import { CampaignSenderInput } from '../campaigns/CampaignSenderInput'
import { campaignDisplayStatus, campaignPollInterval } from '../campaigns/CampaignProgress'
import { composer } from '../campaigns/composer-chunk'
import { issuesRequest, newIssuePath, newsletterPath, readersPath, rememberIssuesShape, useNewsletters, useRememberNewsletter } from './shared'
import { IssuesSkeleton, ReadersSkeleton, issueColumns, newsletterColumns } from './skeletons'
import './newsletters.css'

const day = (value: string) => date(value, { month: 'short', day: 'numeric', ...(new Date(value).getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) })

// ---------------------------------------------------------------- readers
const DAY_MS = 86_400_000
// The readers who joined in each week (seven UTC days, oldest first) of the days the API counts.
function weeks(readers: NewsletterReaders) {
  const first = Date.parse(readers.since), result: { start: string; joined: number }[] = []
  for (let i = readers.daily.length % 7; i < readers.daily.length; i += 7) result.push({ start: new Date(first + i * DAY_MS).toISOString(), joined: readers.daily.slice(i, i + 7).reduce((sum, n) => sum + n, 0) })
  return result
}
function Growth({ readers }: { readers: NewsletterReaders }) {
  const bars = weeks(readers), most = Math.max(1, ...bars.map(week => week.joined))
  const month = readers.daily.slice(-30).reduce((sum, n) => sum + n, 0)
  const span = (value: number) => date(new Date(value).toISOString(), { month: 'short', timeZone: 'UTC' })
  return <figure className="newsletter-growth">
    <div className="newsletter-growth__bars" role="img" aria-label={`Readers who joined each week since ${day(readers.since)}`}>{bars.map(week => <span key={week.start} title={`${number(week.joined)} joined the week of ${date(week.start, { month: 'short', day: 'numeric', timeZone: 'UTC' })}`} style={{ height: `${Math.max(3, week.joined / most * 100)}%` }} />)}</div>
    <figcaption className="newsletter-growth__caption"><span>{number(month)} joined in 30 days</span><span>{span(Date.parse(readers.since))} – {span(Date.parse(readers.since) + (readers.daily.length - 1) * DAY_MS)}</span></figcaption>
  </figure>
}
// The count opens the list the readers are on, where they are added, imported and removed.
function Readers({ newsletter }: { newsletter: Newsletter }) {
  const readers = newsletter.readers
  return <section className="newsletter-readers">
    <div className="newsletter-readers__count">
      <Link to={readersPath(newsletter.id)}><strong>{readers ? number(readers.count) : '—'}</strong> {readers?.count === 1 ? 'reader' : 'readers'}</Link>
      {readers?.count === 0 && <Link className="ui-button ui-button--secondary ui-button--md" to={readersPath(newsletter.id)}>Add readers</Link>}
    </div>
    {readers && readers.daily.some(Boolean) ? <Growth readers={readers} /> : <div className="newsletter-growth" />}
  </section>
}

// ---------------------------------------------------------------- issues
const sentAt = (issue: Campaign) => issue.scheduledAt || issue.updatedAt
const rate = (issue: Campaign, key: 'opened' | 'clicked') => issue.stats?.tracking && issue.stats.delivered > 0 ? percent(issue.stats[key] / issue.stats.delivered, 0) : ''
const launched = (issue: Campaign) => !campaignEditable(issue)
function Sent({ issue }: { issue: Campaign }) {
  const status = campaignDisplayStatus(issue)
  if (status === 'done') return <>{day(sentAt(issue))}</>
  if (status === 'draft') return <span className="muted">Draft</span>
  if (status === 'scheduled' && issue.scheduledAt) return <span className="muted">Sends {day(issue.scheduledAt)}</span>
  return <StatusBadge status={status} />
}
// A phone's card says the same on one line: when, to how many, and how many opened it.
function sentLine(issue: Campaign) {
  const status = campaignDisplayStatus(issue)
  if (status !== 'done') return <Sent issue={issue} />
  return [day(sentAt(issue)), `${number(issue.recipients)} ${issue.recipients === 1 ? 'reader' : 'readers'}`, rate(issue, 'opened') && `${rate(issue, 'opened')} opened`].filter(Boolean).join(' · ')
}
const issuePath = (issue: Campaign) => `/campaigns/${encodeURIComponent(issue.id)}/${campaignEditable(issue) ? 'edit' : 'review'}`
const renders: Record<string, Pick<Column<Campaign>, 'render' | 'cardRender'>> = {
  subject: { render: issue => <span className="newsletter-issue" title={issue.subject.trim() || issue.name}>{issue.subject.trim() || issue.name}</span> },
  sent: { render: issue => <Sent issue={issue} />, cardRender: sentLine },
  recipients: { render: issue => launched(issue) ? number(issue.recipients) : '' },
  opened: { render: issue => rate(issue, 'opened') },
  clicked: { render: issue => rate(issue, 'clicked') },
}

export function NewsletterPage() {
  return useWorkspaceAccess().canAdminister ? <NewsletterView /> : <AdminOnlyPage title="Newsletter" backTo="/campaigns" />
}
function NewsletterView() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const warm = usePrefetchQueries()
  const [params, setParams] = useSearchParams()
  const requested = Number(params.get('page')), page = Number.isSafeInteger(requested) && requested > 0 ? requested : 1
  const named = useNewsletters().find(item => item.id === id)?.name
  // A large list is counted in the background: until its first count is stored, look again.
  const newsletter = useApiDef(queries.newsletter(id), { interval: data => data && data.readers === null ? 5_000 : false })
  const issues = useApiDef(queries.campaigns(issuesRequest(id, page)), { keepPrevious: previous => (previous[1] as { listId?: string } | undefined)?.listId === id, interval: data => {
    const intervals = (data?.items ?? []).map(campaignPollInterval).filter((value): value is number => value !== false)
    return intervals.length ? Math.max(15_000, Math.min(...intervals)) : false
  } })
  const rows = issues.data?.items ?? []
  const engagement = rows.some(issue => rate(issue, 'opened') !== '')
  useEffect(() => { if (issues.data && page === 1) rememberIssuesShape(id, { rows: issues.data.items.length, engagement }) }, [id, page, issues.data, engagement])
  if (newsletter.isError) return <><PageHeader title={named ?? 'Newsletter'} backTo="/campaigns" /><ErrorState error={newsletter.error} onRetry={() => void newsletter.refetch()} /></>
  return <div className="stack newsletter">
    <PageHeader title={newsletter.data?.name ?? named ?? <SkeletonText width={140} lineHeight={24} />} actions={<Button variant="primary" onPointerEnter={() => void composer.preload().catch(() => {})} onClick={() => navigate(newIssuePath(id))}>New issue</Button>} />
    {newsletter.data ? <Readers newsletter={newsletter.data} /> : <ReadersSkeleton />}
    {issues.isError ? <ErrorState error={issues.error} onRetry={() => void issues.refetch()} /> : issues.isPending ? <IssuesSkeleton id={id} />
      : <DataTable className="newsletter-issues" rows={rows} rowKey={issue => issue.id} rowHref={issuePath} onRowIntent={issue => { void warm([queries.campaign(issue.id)]); if (campaignEditable(issue)) void composer.preload().catch(() => {}) }}
          empty={<EmptyState title="No issues yet" />} columns={issueColumns(engagement).map(column => ({ ...column, ...renders[column.key]! }))} />}
    {issues.data && <Pagination page={issues.data.page} pageSize={issues.data.pageSize} total={issues.data.total} nextCursor={issues.data.nextCursor} count={issues.data.items.length} onPageChange={value => setParams(previous => { const next = new URLSearchParams(previous); next.set('page', String(value)); return next })} />}
  </div>
}

// ---------------------------------------------------------------- new newsletter
// A name and a From address. Creating it makes the list its readers go on and remembers the sender for every issue.
export function NewNewsletterPage() {
  return useWorkspaceAccess().canAdminister ? <NewNewsletter /> : <AdminOnlyPage title="New newsletter" backTo="/campaigns" />
}
function NewNewsletter() {
  const api = useApi(), navigate = useNavigate(), remember = useRememberNewsletter(), nameId = useId()
  const [name, setName] = useState(''), [sender, setSender] = useState({ name: '', email: '' })
  const [pending, setPending] = useState(false), [error, setError] = useState('')
  // The workspace's domains: verified ones complete the address as it is typed, and decide where creating leads.
  const domains = useApiQuery(['domains', 'newsletter-sender'], (client, signal) => client.domains.list({ pageSize: 100, refresh: false }, signal))
  const verified = (domains.data?.items ?? []).filter(domain => domain.status === 'verified').map(domain => domain.name)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) { setError('Enter a name.'); return }
    if (!sender.email) { setError('Enter the address issues are sent from.'); return }
    setPending(true); setError('')
    try {
      const created = await api.newsletters.create({ name: name.trim(), from: sender.email, fromName: sender.name || name.trim() })
      remember({ id: created.id, name: created.name })
      // Sending needs the address's domain verified: when it isn't, its setup comes next, and Back returns here.
      const domain = sender.email.split('@')[1]!.toLowerCase(), back = newsletterPath(created.id)
      const all = domains.data?.items ?? (await api.domains.list({ pageSize: 100, refresh: false }).catch(() => ({ items: [] }))).items
      const covers = (parent: string) => domain === parent || domain.endsWith(`.${parent}`)
      const known = all.find(item => item.name === domain)
      if (all.some(item => item.status === 'verified' && covers(item.name))) navigate(back, { replace: true })
      else navigate(known ? `/domains/${encodeURIComponent(known.id)}?then=${encodeURIComponent(back)}` : `/domains?add=${encodeURIComponent(domain)}&then=${encodeURIComponent(back)}`, { replace: true })
    } catch (cause) { setError(errorText(cause)); setPending(false) }
  }
  return <form className="stack newsletter-new" onSubmit={submit} noValidate>
    {/* The button is in the header: the From field's suggestions open below it, where a button would sit under them. */}
    <PageHeader title="New newsletter" backTo="/campaigns" actions={<Button type="submit" variant="primary" loading={pending}>Create newsletter</Button>} />
    <Field label="Name" htmlFor={nameId}><Input id={nameId} value={name} maxLength={120} autoFocus onChange={event => setName(event.target.value)} /></Field>
    <Field label="From" htmlFor="campaign-from-email" error={error || undefined}><CampaignSenderInput name={sender.name} email={sender.email} domains={verified} anyDomain disabled={pending} onChange={setSender} /></Field>
  </form>
}

// ---------------------------------------------------------------- the list, past three
export function NewslettersPage() {
  return useWorkspaceAccess().canAdminister ? <NewslettersList /> : <AdminOnlyPage title="Newsletters" />
}
function NewslettersList() {
  const query = useApiDef(queries.newsletters())
  return <div className="stack">
    <PageHeader title="Newsletters" />
    {query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : <DataTable className="newsletters-table" loading={query.isPending} skeletonRows={4} rows={query.data ?? []} rowKey={row => row.id} rowHref={row => newsletterPath(row.id)}
      empty={<EmptyState title="No newsletters yet" />} columns={[
        { ...newsletterColumns[0]!, render: row => row.name },
        { ...newsletterColumns[1]!, render: row => <NamedAddress name={row.fromName ?? ''} address={row.from} /> },
      ]} />}
  </div>
}
