import { lazy, Suspense, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Mail, Send, Upload, X } from 'lucide-react'
import { Button, ErrorText, IconButton } from '../../components/ui'
import { CopyAction } from '../../components/motion'
import { usePublicOrigin, useSession, useWorkspaceAccess } from '../../data/context'
import { setDomainStep } from '../../data/onboarding'
import type { Domain, SetupProgress } from '../../data/types'
import { agentInboxQuery, leadFocus, type WorkspaceFocus } from '../../data/focus'
import { newIssuePath } from '../newsletters/shared'
import { PrivateAddress } from '../../components/PrivateAddress'
import { TestSentLine, useTestSend } from '../docs/first-send'
import { agentInboxPrompt, agentPrompt, signupFormPrompt, useAgentSetup } from '../docs/agent-setup'
import { productName } from '../../../../api/src/brand'
import { builtinSending, sendsFromBuiltin } from '../settings/builtin-domain'
import './onboarding-card.css'

// Overview's one onboarding card, first in the main column, for a hosted owner or admin:
// - no domain at all (onboarding's domain step skipped or never reached): "Add your domain to start sending", which opens
//   that step in one click, or "Add your own domain" while its built-in domain sends, which opens Domains' add form (the
//   built-in domain is onboarding's domain step already done). The API's no-domain email says the same
//   (api/src/domain-setup.ts, NO_DOMAIN_REMINDER).
// - nothing sent yet and a domain that sends, its own or its built-in one: "You're verified. Send your first email", with
//   a test to yourself from the domain (POST /v1/domains/{id}/test-send, as the setup steps' test button) and the agent
//   prompt to copy, as onboarding's last step has them. It comes first, before the no-domain card, until the first send.
//   A workspace that focuses on something else (onboarding's question, Settings) gets that focus's first step in its
//   place, in the same space: its agent inbox until mail arrives, its contacts and a template until a campaign goes, its
//   newsletter until an issue goes.
// Which one is decided from the session's own counts (GET /v1/me: domains, sent), so the card is there from the first
// frame; on a desktop each has one fixed height, which Latest emails fits its rows under (latest.ts). Dismissed, a card
// stays away for a day in this browser, then comes back while it still applies.

export type OnboardingCardKind = 'no-domain' | 'first-send'
/** What each card takes above the figures on a desktop: its fixed height (onboarding-card.css) and its .ov-lead row's 4 + 12px padding. */
export const ONBOARDING_CARD_SPACE: Record<OnboardingCardKind, number> = { 'no-domain': 76 + 16, 'first-send': 120 + 16 }

const DAY_MS = 24 * 3600_000
const dismissedKey = (kind: OnboardingCardKind, workspaceId: string) => `nightmail.overview.${kind}.${workspaceId}`
const listeners = new Set<() => void>(), memory = new Set<string>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
function dismissedAt(key: string) { try { return Number(localStorage.getItem(key)) || 0 } catch { return 0 } }
function dismiss(key: string) {
  try { localStorage.setItem(key, String(Date.now())) } catch { /* Then it stays dismissed until a reload. */ }
  memory.add(key)
  listeners.forEach(listener => listener())
}
const useDismissed = (key: string) => useSyncExternalStore(subscribe, () => memory.has(key) || Date.now() - dismissedAt(key) < DAY_MS)

/**
 * Which card shows, if any. `setup` is the setup read once it lands (overview/setup.tsx): a domain or an email it finds
 * hides a card the session's counts still asked for.
 */
export function useOnboardingCard(setup: { hasDomain?: boolean; sent?: boolean; progress?: SetupProgress | null }): OnboardingCardKind | null {
  const identity = useSession()?.identity, { multiTenant, canAdminister } = useWorkspaceAccess()
  const workspaceId = identity?.workspaceId ?? '', connection = identity?.connection
  const noDomainDismissed = useDismissed(dismissedKey('no-domain', workspaceId)), firstSendDismissed = useDismissed(dismissedKey('first-send', workspaceId))
  if (!multiTenant || !canAdminister || !workspaceId || connection?.state !== 'ready') return null
  // The built-in domain counts as verified: a new workspace can send its first email before it has a domain of its own.
  const sends = (connection.domains?.verified ?? 0) > 0 || connection.builtinDomain?.sending === 'ready'
  const lead = leadFocus(identity)
  // An agent inbox's first step is mail arriving, not mail sent; the session says whether any has, from the first frame.
  const receives = sends || (!!connection.builtinDomain && connection.builtinDomain.sending !== 'off')
  if (lead === 'agents' && receives && connection.received === false && !setup.progress?.received && !firstSendDismissed) return 'first-send'
  if (sends && connection.sent === false && !setup.sent && !(lead === 'marketing' && setup.progress?.campaignSent) && !(lead === 'newsletter' && setup.progress?.issueSent) && !firstSendDismissed) return 'first-send'
  if (connection.domains?.total === 0) return setup.hasDomain || noDomainDismissed ? null : 'no-domain'
  return null
}

function DismissButton({ kind }: { kind: OnboardingCardKind }) {
  const workspaceId = useSession()?.identity?.workspaceId ?? ''
  return <IconButton className="ov-onboarding__dismiss" label="Dismiss for a day" onClick={() => dismiss(dismissedKey(kind, workspaceId))} data-analytics={`overview/${kind}/dismiss`}><X size={16} aria-hidden /></IconButton>
}

const noDomainWhy = `${productName} sends from your own domain. Setting one up takes about 5 minutes of DNS.`
function NoDomainCard() {
  const identity = useSession()?.identity, workspaceId = identity?.workspaceId ?? ''
  // With a built-in domain the workspace already sends: the card asks for its own domain to send more, and says to whom it sends now.
  const builtin = identity?.connection?.builtinDomain, sends = sendsFromBuiltin(builtin)
  const text = sends ? `You can send from ${builtin.name} now. ${builtinSending(builtin)} Your own domain lifts the limit.` : noDomainWhy
  return <section className="ov-onboarding" data-kind="no-domain" aria-labelledby="ov-onboarding-title">
    <div className="ov-onboarding__text">
      <h2 id="ov-onboarding-title">{sends ? 'Add your own domain' : 'Add your domain to start sending'}</h2>
      <p title={text}>{text}</p>
    </div>
    {/* Without a domain, the onboarding domain step: an empty step opens it, and the dashboard's gate goes there. */}
    {sends ? <Link className="ui-button ui-button--primary ui-button--md ov-onboarding__action" to="/domains?add" data-analytics="overview/no-domain/add">Add domain<ArrowRight size={16} aria-hidden /></Link>
      : <Button variant="primary" className="ov-onboarding__action" onClick={() => setDomainStep(workspaceId, '')} data-analytics="overview/no-domain/add">Add domain<ArrowRight size={16} aria-hidden /></Button>}
    <DismissButton kind="no-domain" />
  </section>
}

/** `domain`: the newest verified domain in the setup read (its own, else the built-in one), undefined while it loads.
 * `onSent`: Latest emails and the figures read again. */
function FirstSendCard({ domain, onSent }: { domain?: Domain; onSent?: () => void }) {
  const identity = useSession()?.identity, origin = usePublicOrigin(), { canAdminister } = useWorkspaceAccess()
  const to = identity?.email ?? null
  const test = useTestSend(domain, () => onSent?.())
  // The prompt onboarding copies: a one-time setup token in it gets the agent its own key.
  const setup = useAgentSetup(canAdminister)
  const promptFor = (setupToken: string | null | undefined) => agentPrompt({ origin: origin!, domain: domain ?? null, email: to, multiTenant: true, setupToken })
  const line = test.isSuccess && to ? <TestSentLine id={test.data.id} to={to} simulated={test.data.simulated} />
    : test.error ? <ErrorText error={test.error} />
    : domain ? `${domain.name} can send now: try it on yourself, or copy the prompt for your coding agent.` : 'Your domain can send now.'
  return <section className="ov-onboarding" data-kind="first-send" aria-labelledby="ov-onboarding-title">
    <div className="ov-onboarding__text">
      <h2 id="ov-onboarding-title">You’re verified. Send your first email</h2>
      <p data-tone={test.error ? 'danger' : undefined} role="status">{line}</p>
    </div>
    <div className="ov-onboarding__actions">
      <Button variant="primary" loading={test.isPending} disabled={!domain || !to || test.isSuccess} onClick={() => test.mutate()} data-analytics="overview/first-send/test"><Send size={14} aria-hidden />Send it to yourself</Button>
      <span className="ov-onboarding__copy" data-pending={!origin || !domain || undefined} inert={!origin || !domain}>
        <CopyAction value={origin && domain ? setup ? setup.copy(promptFor) : promptFor(undefined) : ''} label="Copy agent prompt" text="Copy agent prompt" />
      </span>
    </div>
    <DismissButton kind="first-send" />
  </section>
}

/** The setup steps whose actions the card already has, for each focus (Overview leaves them out of the steps beside it). */
export const cardActions: Record<WorkspaceFocus, string[]> = { developer: ['send'], agents: ['inbox', 'connect'], marketing: ['contacts', 'campaign'], newsletter: ['newsletter', 'issue'] }

const ImportContactsDialog = lazy(() => import('../audience/import').then(module => ({ default: module.ImportContactsDialog })))

function Card({ kind, title, line, children }: { kind: OnboardingCardKind; title: string; line: ReactNode; children: ReactNode }) {
  return <section className="ov-onboarding" data-kind="first-send" aria-labelledby="ov-onboarding-title">
    <div className="ov-onboarding__text"><h2 id="ov-onboarding-title">{title}</h2><p role="status">{line}</p></div>
    <div className="ov-onboarding__actions">{children}</div>
    <DismissButton kind={kind} />
  </section>
}

/** Agent inboxes: agent@ on the built-in domain, made on the first copy, and the prompt that gives an agent it and its own key. */
function AgentInboxCard() {
  const identity = useSession()?.identity, origin = usePublicOrigin(), { canAdminister } = useWorkspaceAccess()
  const domain = identity?.connection?.builtinDomain?.name ?? null
  const address = domain ? `agent@${domain}` : null
  const inbox = useQuery({ ...agentInboxQuery(domain ?? ''), enabled: false })
  const setup = useAgentSetup(canAdminister)
  const copy = async () => {
    const made = inbox.data ?? (await inbox.refetch()).data
    const promptFor = (setupToken: string | null | undefined) => agentInboxPrompt({ origin: origin!, address: made?.address ?? address!, inboxId: made?.id, setupToken })
    return setup ? setup.copy(promptFor)() : promptFor(undefined)
  }
  return <Card kind="first-send" title="Give your agent an inbox" line={address ? <>Mail to <PrivateAddress value={address} /> lands in it: copy the prompt for your coding agent, then email it.</> : 'Copy the prompt for your coding agent: it gets an inbox and its own key.'}>
    <span className="ov-onboarding__copy" data-pending={!origin || !address || undefined} inert={!origin || !address}>
      <CopyAction value={copy} label="Copy agent prompt" text="Copy agent prompt" variant="primary" />
    </span>
    {address ? <a className="ui-button ui-button--secondary ui-button--md" href={`mailto:${address}`} data-analytics="overview/agent-inbox/write"><Mail size={14} aria-hidden />Write to it</a>
      : <Link className="ui-button ui-button--secondary ui-button--md" to="/receiving/inboxes">Open inboxes</Link>}
  </Card>
}

/** Marketing: contacts in (the import shows what list hygiene flagged), then a campaign. Nothing sends from here. */
function MarketingCard({ progress }: { progress?: SetupProgress | null }) {
  const [importing, setImporting] = useState(false), client = useQueryClient()
  const imported = progress?.contacts === true, drafted = progress?.campaign === true
  return <Card kind="first-send" title="Send your first campaign" line={drafted ? 'Your draft is under Campaigns: pick its audience, then send it.' : imported ? 'Your contacts are in. Start a campaign from a template.' : 'Import your contacts, then start a campaign. Risky addresses are flagged and skipped.'}>
    <Button variant={imported ? 'secondary' : 'primary'} onClick={() => setImporting(true)} data-analytics="overview/marketing/import"><Upload size={14} aria-hidden />{imported ? 'Import more' : 'Import contacts'}</Button>
    <Link className={`ui-button ui-button--${imported ? 'primary' : 'secondary'} ui-button--md`} to={drafted ? '/campaigns' : '/campaigns/new'} data-analytics="overview/marketing/campaign">{drafted ? 'Open Campaigns' : 'Start a campaign'}</Link>
    <Suspense fallback={null}>{importing && <ImportContactsDialog onClose={() => { setImporting(false); void client.invalidateQueries({ queryKey: ['nightmail', 'overview-setup'] }) }} />}</Suspense>
  </Card>
}

/** Newsletter: make it, then a signup form your agent adds to your site, then the first issue. */
function NewsletterCard() {
  const identity = useSession()?.identity, origin = usePublicOrigin(), { canAdminister } = useWorkspaceAccess()
  const newsletter = identity?.newsletters?.[0] ?? null
  const setup = useAgentSetup(canAdminister)
  const promptFor = (setupToken: string | null | undefined) => signupFormPrompt({ origin: origin!, newsletter: newsletter!, setupToken })
  return <Card kind="first-send" title={newsletter ? `Send the first issue of ${newsletter.name}` : 'Start your newsletter'} line={newsletter ? 'Copy the signup form prompt for your coding agent, then write the first issue.' : 'Name it and pick its sender; readers sign up with a form on your site.'}>
    {newsletter ? <Link className="ui-button ui-button--primary ui-button--md" to={newIssuePath(newsletter.id)} data-analytics="overview/newsletter/issue">Write the first issue</Link>
      : <Link className="ui-button ui-button--primary ui-button--md" to="/newsletters/new" data-analytics="overview/newsletter/create">Create newsletter</Link>}
    {newsletter && <span className="ov-onboarding__copy" data-pending={!origin || undefined} inert={!origin}>
      <CopyAction value={origin ? setup ? setup.copy(promptFor) : promptFor(undefined) : ''} label="Copy signup form prompt" text="Copy signup form prompt" />
    </span>}
  </Card>
}

export function OnboardingCard({ kind, domain, onSent, progress }: { kind: OnboardingCardKind; domain?: Domain; onSent?: () => void; progress?: SetupProgress | null }) {
  const lead = leadFocus(useSession()?.identity)
  if (kind === 'no-domain') return <NoDomainCard />
  return lead === 'agents' ? <AgentInboxCard /> : lead === 'marketing' ? <MarketingCard progress={progress} /> : lead === 'newsletter' ? <NewsletterCard /> : <FirstSendCard domain={domain} onSent={onSent} />
}
