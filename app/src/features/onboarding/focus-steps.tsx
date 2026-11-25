import { lazy, Suspense, useState, type CSSProperties, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Download, LayoutTemplate, Mail, Newspaper, PenLine, Upload } from 'lucide-react'
import { Button, ErrorText, Input, useToast } from '../../components/ui'
import { CopyAction, LiveStatus } from '../../components/motion'
import { FocusPicker } from '../../components/FocusPicker'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useApi, useApiDef, usePublicOrigin, useSession, useWorkspaceAccess } from '../../data/context'
import { request } from '../../data/live'
import { queries } from '../../data/queries'
import { agentInboxQuery, type WorkspaceFocus } from '../../data/focus'
import { errorText, type Newsletter } from '../../data/types'
import { AgentSetupStatus, agentInboxPrompt, downloadText, signupFormPrompt, useAgentSetup } from '../docs/agent-setup'
import { useRememberNewsletter } from '../newsletters/shared'
import { relativeTime } from '../../lib/format'
import { productSlug } from '../../../../api/src/brand'

// The focus step and the next step each focus leads to (onboarding/index.tsx). Each fits one 1440 × 900 screen, keeps its
// layout while its reads land (every slot is laid out from the first frame), and saves nothing it doesn't say it saves.
const rise = (index: number) => ({ '--i': index }) as CSSProperties
// The import's code (CSV parsing) loads only when it opens, not with onboarding.
const ImportContactsDialog = lazy(() => import('../audience/import').then(module => ({ default: module.ImportContactsDialog })))
function Back({ onBack }: { onBack: () => void }) {
  return <button type="button" className="onboarding-back" onClick={onBack}><ArrowLeft size={14} aria-hidden />Back</button>
}

/** "What do you want to focus on?": any of the four, the first leading; Continue saves them in the background, Skip saves none. */
export function FocusStep({ initial, onBack, onContinue }: { initial: WorkspaceFocus[]; onBack?: () => void; onContinue: (focus: WorkspaceFocus[]) => void }) {
  const [picked, setPicked] = useState(initial)
  return <div className="onboarding onboarding--narrow onboarding--focus">
    <div className="onboarding-intro onb-rise" style={rise(0)}>
      {onBack && <Back onBack={onBack} />}
      <h1 className="onboarding-title">What do you want to focus on?</h1>
      <p className="muted onboarding-builtin-copy">Pick any. The first leads, and you can change it in Settings.</p>
    </div>
    <FocusPicker value={picked} onChange={setPicked} rise={rise} />
    <div className="onboarding-connect-actions onb-rise" style={rise(5)}>
      <Button variant="primary" disabled={!picked.length} data-analytics="onboarding/focus/continue" onClick={() => onContinue(picked)}>Continue<ArrowRight size={16} aria-hidden /></Button>
      <button type="button" className="onboarding-skip" data-analytics="onboarding/focus/skip" onClick={() => onContinue([])}>Skip</button>
    </div>
  </div>
}

// A task row: its icon, title and one line, and its action on the right (under it on a phone).
function Task({ icon, title, line, done, children, index }: { icon: ReactNode; title: string; line: ReactNode; done?: boolean; children: ReactNode; index: number }) {
  return <li className="focus-task onb-rise" style={rise(index)} data-done={done || undefined}>
    <span className="focus-task__icon" aria-hidden="true">{done ? <Check size={16} strokeWidth={2.5} /> : icon}</span>
    <span className="focus-task__text"><span className="focus-task__title">{title}{done && <span className="sr-only"> (done)</span>}</span><span className="focus-task__line">{line}</span></span>
    <span className="focus-task__action">{children}</span>
  </li>
}

function Finish({ onFinish }: { onFinish: () => void }) {
  return <div className="onboarding-actions"><Button onClick={onFinish}>Go to dashboard<ArrowRight size={16} aria-hidden /></Button></div>
}

// ---- Agent inboxes -------------------------------------------------------------------------------------------------

type InboxMessage = { id: string; from: { name: string | null; address: string }; subject: string; receivedAt: string }

/** An inbox's three newest messages, read every 2.5 s while the page is visible. */
const SHOWN_MAIL = 3
function useArrivingMail(inboxId: string | undefined) {
  return useQuery({ queryKey: ['nightmail', 'agent-inbox-mail', inboxId], enabled: Boolean(inboxId), refetchInterval: 2500, refetchIntervalInBackground: false,
    queryFn: ({ signal }) => request<{ data: InboxMessage[] }>(`/v1/inboxes/${encodeURIComponent(inboxId!)}/messages?limit=50`, { signal }).then(page => [...page.data].sort((x, y) => Date.parse(y.receivedAt) - Date.parse(x.receivedAt)).slice(0, SHOWN_MAIL)) })
}

/**
 * Agent inboxes: agent@ on the domain, made as the step opens (or already, from the focus step), the prompt that gives a
 * coding agent its own key and this inbox (MCP or REST), and the inbox's mail as it arrives.
 */
export function AgentInboxStep({ domain, onBack, onFinish }: { domain: string; onBack: () => void; onFinish: () => void }) {
  const origin = usePublicOrigin(), { canAdminister } = useWorkspaceAccess()
  const address = `agent@${domain}`
  const inbox = useQuery(agentInboxQuery(domain))
  const mail = useArrivingMail(inbox.data?.id)
  const setup = useAgentSetup(canAdminister)
  const promptFor = (inboxId: string | undefined) => (setupToken: string | null | undefined) => agentInboxPrompt({ origin: origin!, address, inboxId, setupToken })
  // The prompt names the inbox: the one already read, else the copy waits for it to be found or made.
  const copy = async () => {
    const id = inbox.data?.id ?? (await inbox.refetch({ cancelRefetch: false }).catch(() => undefined))?.data?.id
    return setup ? setup.copy(promptFor(id))() : promptFor(id)(undefined)
  }
  const messages = mail.data ?? []
  return <div className="onboarding onboarding--narrow">
    <div className="onboarding-intro onb-rise" style={rise(0)}>
      <Back onBack={onBack} />
      <h1 className="onboarding-title">Your agent’s inbox</h1>
    </div>
    <ul className="onboarding-imported onb-rise" style={rise(1)}>
      <li><span className="onboarding-builtin-name"><code>{address}</code><CopyAction value={address} label="Copy address" variant="ghost" size="sm" compact /></span>
        {inbox.error ? <span className="onboarding-error focus-inline-error"><ErrorText error={inbox.error} /></span> : <LiveStatus state={inbox.data ? 'verified' : 'pending'} labels={{ pending: 'Creating', verified: 'Receiving' }} plain />}</li>
    </ul>
    <section className="onboarding-agent onb-rise" style={rise(2)} aria-label="Agent prompt">
      <div className="onboarding-connect-actions" data-pending={!origin || undefined} inert={!origin}>
        <CopyAction value={copy} label="Copy agent prompt" text="Copy agent prompt" variant="primary" />
        <a className="ui-button ui-button--ghost ui-button--md" href="/docs/inboxes" target="_blank" rel="noopener" data-analytics="onboarding/inbox/docs">Read the docs<ArrowUpRight size={16} aria-hidden /></a>
        <Button variant="ghost" data-analytics="onboarding/inbox/download" onClick={() => origin && downloadText(`${productSlug}-agent-inbox-prompt.txt`, promptFor(inbox.data?.id)(undefined))}><Download size={16} aria-hidden />Download</Button>
      </div>
      {setup ? <AgentSetupStatus setup={setup} idle="Paste it into your coding agent: it gets its own key and connects over MCP." /> : <p className="muted onboarding-agent-line">Paste it into your coding agent: it connects with a device code.</p>}
    </section>
    <section className="focus-mail onb-rise" style={rise(3)} aria-label="Mail to this inbox">
      <div className="focus-mail__head"><h2>Arriving mail</h2><a className="ui-button ui-button--secondary ui-button--sm" href={`mailto:${address}`} data-analytics="onboarding/inbox/write"><Mail size={14} aria-hidden />Write to it</a></div>
      <ol className="focus-mail__list" aria-live="polite">
        {messages.length ? messages.map(message => <li key={message.id}>
          <span className="focus-mail__from"><PrivateAddress value={message.from.address} /></span>
          <span className="focus-mail__subject">{message.subject || '(no subject)'}</span>
          <time className="muted" dateTime={message.receivedAt}>{relativeTime(message.receivedAt)}</time>
        </li>) : <li className="focus-mail__empty muted"><span className="connect-agent__pulse" aria-hidden="true" />Waiting for mail. Email it from any mail app; it shows up here.</li>}
      </ol>
    </section>
    <Finish onFinish={onFinish} />
  </div>
}

// ---- Marketing -----------------------------------------------------------------------------------------------------

// A new workspace has no templates of its own yet: the starter is a short announcement to rewrite. Its words are a draft's,
// never sent as they are.
const starter = (workspace: string) => ({ name: 'Announcement', subject: `What’s new at ${workspace}`, previewText: 'One thing worth knowing this week.',
  html: `<h1>What’s new at ${workspace}</h1><p>Say what changed in a sentence or two, and why it matters to the people reading.</p><p>One idea per email reads best. Link to the details instead of putting them all here.</p><p>The ${workspace} team</p>` })
// docs/sending-limits.md, Campaign ramp and Send readiness (#737).
const RAMP = 'Your first big campaigns ramp up: they go out in hourly steps from 1,000 recipients, each checked for bounces and complaints before the next.'

/** A draft from a published template (or a blank one) that stays put: the step shows it, nothing opens or sends. */
function useDraft() {
  const api = useApi(), client = useQueryClient(), toast = useToast()
  const [draft, setDraft] = useState<{ id: string; name: string } | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  async function start(input: { key: string; name: string; templateId?: string; fromEmail?: string; fromName?: string; listId?: string; subject?: string; previewText?: string; html?: string }) {
    setPending(input.key)
    try {
      const campaign = await api.campaigns.save({ templateId: input.templateId, idempotencyKey: crypto.randomUUID(), regionId: '', name: input.name, subject: input.subject ?? '', previewText: input.previewText ?? '', fromName: input.fromName ?? '', fromEmail: input.fromEmail ?? '', listId: input.listId ?? '', segmentId: null, html: input.html ?? '' })
      setDraft({ id: campaign.id, name: campaign.name })
      void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'nightmail' && ['campaigns', 'overview-setup'].includes(String(query.queryKey[1])) })
    } catch (error) { toast(errorText(error), 'error') }
    finally { setPending(null) }
  }
  return { draft, pending, start }
}

// A link that leaves onboarding: it finishes first, so the dashboard opens where it points.
function LeaveLink({ to, onLeave, children, primary }: { to: string; onLeave: () => void; children: ReactNode; primary?: boolean }) {
  return <Link className={`ui-button ui-button--${primary ? 'primary' : 'secondary'} ui-button--sm`} to={to} onClick={onLeave}>{children}</Link>
}

/** Marketing: import contacts (the import shows its list-hygiene summary), a draft from a template, and how sending ramps up. Nothing sends. */
export function MarketingStep({ domain, onBack, onFinish }: { domain: string | null; onBack: () => void; onFinish: () => void }) {
  const identity = useSession()?.identity
  const workspace = workspaceTitle(identity?.workspaces?.find(item => item.id === identity.workspaceId)?.name) || 'us'
  const setup = useApiDef(queries.overviewSetup())
  const [importing, setImporting] = useState(false)
  const { draft, pending, start } = useDraft()
  const imported = setup.data?.progress?.contacts === true
  return <div className="onboarding onboarding--narrow">
    <div className="onboarding-intro onb-rise" style={rise(0)}>
      <Back onBack={onBack} />
      <h1 className="onboarding-title">Send your first campaign</h1>
      <p className="muted onboarding-builtin-copy">Set it up here; nothing sends until you press Send.</p>
    </div>
    <ul className="focus-tasks">
      <Task index={1} icon={<Upload size={16} />} title="Import your contacts" done={imported} line="A CSV from anywhere. Risky addresses are flagged, and campaigns skip them.">
        <Button variant={imported ? 'secondary' : 'primary'} size="sm" data-analytics="onboarding/marketing/import" onClick={() => setImporting(true)}>Import contacts</Button>
      </Task>
      <Task index={2} icon={<LayoutTemplate size={16} />} title={draft ? `Draft ready: ${draft.name}` : 'Start from a template'} done={Boolean(draft)} line={draft ? 'Saved under Campaigns. Pick its audience and send when it’s right.' : 'A short announcement to rewrite, saved as a draft.'}>
        <span className="onboarding-slot focus-task__slot">
          <span data-active={!draft || undefined} aria-hidden={draft ? true : undefined}>
            <Button size="sm" loading={pending === 'starter'} disabled={pending !== null} data-analytics="onboarding/marketing/starter" onClick={() => void start({ key: 'starter', ...starter(workspace), fromEmail: domain ? `hello@${domain}` : '', fromName: workspace })}><PenLine size={14} aria-hidden />Announcement</Button>
          </span>
          <span data-active={draft ? true : undefined} aria-hidden={draft ? undefined : true}>{draft && <LeaveLink to={`/campaigns/${encodeURIComponent(draft.id)}/edit`} onLeave={onFinish}>Open draft</LeaveLink>}</span>
        </span>
      </Task>
    </ul>
    <p className="muted focus-ramp onb-rise" style={rise(3)}>{RAMP} <a href="/docs#sending-limits" target="_blank" rel="noopener">How limits work</a></p>
    {/* A link in the import's dialogs (Review them) leaves onboarding too. */}
    {importing && <div className="focus-portal" onClickCapture={event => { if ((event.target as Element).closest('a[href^="/"]')) onFinish() }}>
      <Suspense fallback={null}><ImportContactsDialog onClose={() => { setImporting(false); void setup.refetch() }} /></Suspense>
    </div>}
    <Finish onFinish={onFinish} />
  </div>
}

// ---- Newsletter ----------------------------------------------------------------------------------------------------

/** "Umber's workspace" → "Umber", "Umber Studio workspace" → "Umber Studio": what a starter draft and a newsletter are called. */
const workspaceTitle = (workspace: string | undefined) => (workspace ?? '').replace(/(?:’s|'s)?\s+workspace$/i, '').trim()

/** Newsletter: the newsletter itself (a list with a sender), a signup form your coding agent adds to your site, and a first issue drafted. */
export function NewsletterStep({ domain, onBack, onFinish }: { domain: string; onBack: () => void; onFinish: () => void }) {
  const api = useApi(), client = useQueryClient(), toast = useToast(), remember = useRememberNewsletter()
  const identity = useSession()?.identity, origin = usePublicOrigin(), { canAdminister } = useWorkspaceAccess()
  const existing = identity?.newsletters?.[0] ?? null
  const workspace = identity?.workspaces?.find(item => item.id === identity.workspaceId)?.name
  const [name, setName] = useState(() => workspaceTitle(workspace) || 'Newsletter')
  const [created, setCreated] = useState<Pick<Newsletter, 'id' | 'name'> & { from?: string } | null>(existing)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const setup = useAgentSetup(canAdminister)
  const { draft, pending, start } = useDraft()
  const from = `news@${domain}`
  async function create() {
    if (!name.trim()) return
    setCreating(true); setError(null)
    try {
      const made = await api.newsletters.create({ name: name.trim(), from, fromName: name.trim() })
      setCreated(made); remember({ id: made.id, name: made.name })
      void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'nightmail' && ['newsletters', 'lists', 'overview-setup'].includes(String(query.queryKey[1])) })
    } catch (failure) { setError(failure); toast(errorText(failure), 'error') }
    finally { setCreating(false) }
  }
  const promptFor = (setupToken: string | null | undefined) => signupFormPrompt({ origin: origin!, newsletter: created!, setupToken })
  const ready = Boolean(created && origin)
  return <div className="onboarding onboarding--narrow">
    <div className="onboarding-intro onb-rise" style={rise(0)}>
      <Back onBack={onBack} />
      <h1 className="onboarding-title">Start your newsletter</h1>
    </div>
    <ul className="focus-tasks">
      <Task index={1} icon={<Newspaper size={16} />} title={created ? created.name : 'Name it'} done={Boolean(created)} line={created ? <>Sends from <PrivateAddress value={created.from ?? from} />.</> : <>It sends from <PrivateAddress value={from} />.</>}>
        <span className="onboarding-slot focus-task__slot">
          <form data-active={!created || undefined} aria-hidden={created ? true : undefined} inert={Boolean(created)} className="focus-name" onSubmit={event => { event.preventDefault(); void create() }}>
            <Input aria-label="Newsletter name" value={name} maxLength={200} onChange={event => setName(event.target.value)} disabled={creating} aria-invalid={Boolean(error) || undefined} />
            <Button type="submit" variant="primary" size="sm" loading={creating} disabled={!name.trim()} data-analytics="onboarding/newsletter/create">Create</Button>
          </form>
          <span data-active={created ? true : undefined} aria-hidden={created ? undefined : true}>{created && <LeaveLink to={`/newsletters/${encodeURIComponent(created.id)}`} onLeave={onFinish}>Open</LeaveLink>}</span>
        </span>
      </Task>
      <Task index={2} icon={<PenLine size={16} />} title="Add a signup form" line={setup?.state === 'connected' ? 'Your agent connected and is adding the form.' : 'Copy the prompt for your coding agent: it adds a form to your site that subscribes readers.'}>
        <span data-pending={!ready || undefined} inert={!ready} className="focus-task__copy"><CopyAction value={ready ? setup ? setup.copy(promptFor) : promptFor(undefined) : ''} label="Copy signup form prompt" text="Copy prompt" size="sm" /></span>
      </Task>
      <Task index={3} icon={<Mail size={16} />} title={draft ? 'First issue drafted' : 'Draft the first issue'} done={Boolean(draft)} line={draft ? 'Saved under the newsletter. Write it and send when it’s ready.' : 'To everyone who signs up; nothing sends until you press Send.'}>
        <span className="onboarding-slot focus-task__slot" data-pending={!created || undefined} inert={!created}>
          <span data-active={!draft || undefined} aria-hidden={draft ? true : undefined}><Button size="sm" loading={pending === 'issue'} disabled={pending !== null || !created} data-analytics="onboarding/newsletter/issue"
            onClick={() => created && void start({ key: 'issue', name: 'Issue 1', fromEmail: created.from ?? from, fromName: created.name, listId: created.id, subject: `Welcome to ${created.name}`, previewText: 'What to expect, and how often.',
              html: `<h1>Welcome to ${created.name}</h1><p>Thanks for signing up. Say what each issue will bring and how often it comes.</p><p>Then the first thing worth reading.</p>` })}>Draft it</Button></span>
          <span data-active={draft ? true : undefined} aria-hidden={draft ? undefined : true}>{draft && <LeaveLink to={`/campaigns/${encodeURIComponent(draft.id)}/edit`} onLeave={onFinish}>Open draft</LeaveLink>}</span>
        </span>
      </Task>
    </ul>
    <Finish onFinish={onFinish} />
  </div>
}

/** Each focus's next step, warmed as the focus step continues: the agent inbox is made (or found), the setup read for marketing. */
export function useWarmFocus() {
  const client = useQueryClient(), api = useApi()
  return (lead: WorkspaceFocus, domain: string | null | undefined) => {
    if (lead === 'agents' && domain) void client.prefetchQuery(agentInboxQuery(domain)).catch(() => {})
    if (lead === 'marketing') void client.prefetchQuery({ queryKey: ['nightmail', ...queries.overviewSetup().key], queryFn: ({ signal }) => queries.overviewSetup().read(api, signal) }).catch(() => {})
  }
}
