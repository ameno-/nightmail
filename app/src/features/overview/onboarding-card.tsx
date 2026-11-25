import { useSyncExternalStore } from 'react'
import { Link } from 'react-router'
import { ArrowRight, Send, X } from 'lucide-react'
import { Button, ErrorText, IconButton } from '../../components/ui'
import { CopyAction } from '../../components/motion'
import { usePublicOrigin, useSession, useWorkspaceAccess } from '../../data/context'
import { setDomainStep } from '../../data/onboarding'
import type { Domain } from '../../data/types'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useTestSend } from '../docs/first-send'
import { agentPrompt, useAgentSetup } from '../docs/agent-setup'
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
export function useOnboardingCard(setup: { hasDomain?: boolean; sent?: boolean }): OnboardingCardKind | null {
  const identity = useSession()?.identity, { multiTenant, canAdminister } = useWorkspaceAccess()
  const workspaceId = identity?.workspaceId ?? '', connection = identity?.connection
  const noDomainDismissed = useDismissed(dismissedKey('no-domain', workspaceId)), firstSendDismissed = useDismissed(dismissedKey('first-send', workspaceId))
  if (!multiTenant || !canAdminister || !workspaceId || connection?.state !== 'ready') return null
  // The built-in domain counts as verified: a new workspace can send its first email before it has a domain of its own.
  const sends = (connection.domains?.verified ?? 0) > 0 || connection.builtinDomain?.sending === 'ready'
  if (sends && connection.sent === false && !setup.sent && !firstSendDismissed) return 'first-send'
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
  const line = test.isSuccess && to ? <>Test email queued to <PrivateAddress value={to} />{test.data.simulated ? ' (simulated)' : ''}. <Link to={`/logs/${encodeURIComponent(test.data.id)}`}>View in Logs</Link></>
    : test.error ? <ErrorText error={test.error} />
    : domain ? `${domain.name} can send now: try it on yourself, or copy the prompt for your coding agent.` : 'Your domain can send now.'
  return <section className="ov-onboarding" data-kind="first-send" aria-labelledby="ov-onboarding-title">
    <div className="ov-onboarding__text">
      <h2 id="ov-onboarding-title">You’re verified. Send your first email</h2>
      <p data-tone={test.error ? 'danger' : undefined} role="status">{line}</p>
    </div>
    <div className="ov-onboarding__actions">
      <Button variant="primary" loading={test.isPending} disabled={!domain || !to || test.isSuccess} onClick={() => test.mutate()} data-analytics="overview/first-send/test"><Send size={14} aria-hidden />Send a test to yourself</Button>
      <span className="ov-onboarding__copy" data-pending={!origin || !domain || undefined} inert={!origin || !domain}>
        <CopyAction value={origin && domain ? setup ? setup.copy(promptFor) : promptFor(undefined) : ''} label="Copy agent prompt" text="Copy agent prompt" />
      </span>
    </div>
    <DismissButton kind="first-send" />
  </section>
}

export function OnboardingCard({ kind, domain, onSent }: { kind: OnboardingCardKind; domain?: Domain; onSent?: () => void }) {
  return kind === 'no-domain' ? <NoDomainCard /> : <FirstSendCard domain={domain} onSent={onSent} />
}
