import { useSyncExternalStore } from 'react'
import { Link } from 'react-router'
import { ArrowRight, Copy, Send, X } from 'lucide-react'
import { Button, ErrorText, IconButton, useCopy } from '../../components/ui'
import { usePublicOrigin, useSession, useWorkspaceAccess } from '../../data/context'
import { setDomainStep } from '../../data/onboarding'
import type { Domain } from '../../data/types'
import { PrivateAddress } from '../../components/PrivateAddress'
import { sendSnippets, useTestSend } from '../docs/first-send'
import { productName } from '../../../../api/src/brand'
import './onboarding-card.css'

// Overview's one onboarding card, first in the main column, for a hosted owner or admin:
// - no domain at all (onboarding's domain step skipped or never reached): "Add your domain to start sending", which opens
//   that step in one click. The API's no-domain email says the same (api/src/domain-setup.ts, NO_DOMAIN_REMINDER).
// - a verified domain but no email sent yet: "You're verified. Send your first email", with a test to yourself from the
//   domain (POST /v1/domains/{id}/test-send, as the setup steps' test button), Create an API key (its dialog shows the
//   examples with the new key) and the cURL example to copy.
// Which one is decided from the session's own counts (GET /v1/me: domains, sent), so the card is there from the first
// frame; on a desktop each has one fixed height, which Latest emails fits its rows under (latest.ts). Dismissed, a card
// stays away for a day in this browser, then comes back while it still applies.

export type OnboardingCardKind = 'no-domain' | 'first-send'
/** What each card takes above the figures on a desktop: its fixed height (onboarding-card.css) and the main column's 20px gap. */
export const ONBOARDING_CARD_SPACE: Record<OnboardingCardKind, number> = { 'no-domain': 76 + 20, 'first-send': 120 + 20 }

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
  if (connection.domains?.total === 0) return setup.hasDomain || noDomainDismissed ? null : 'no-domain'
  if ((connection.domains?.verified ?? 0) > 0 && connection.sent === false) return setup.sent || firstSendDismissed ? null : 'first-send'
  return null
}

function DismissButton({ kind }: { kind: OnboardingCardKind }) {
  const workspaceId = useSession()?.identity?.workspaceId ?? ''
  return <IconButton className="ov-onboarding__dismiss" label="Dismiss for a day" onClick={() => dismiss(dismissedKey(kind, workspaceId))} data-analytics={`overview/${kind}/dismiss`}><X size={16} aria-hidden /></IconButton>
}

const noDomainWhy = `${productName} sends from your own domain. Setting one up takes about 5 minutes of DNS.`
function NoDomainCard() {
  const workspaceId = useSession()?.identity?.workspaceId ?? ''
  return <section className="ov-onboarding" data-kind="no-domain" aria-labelledby="ov-onboarding-title">
    <div className="ov-onboarding__text">
      <h2 id="ov-onboarding-title">Add your domain to start sending</h2>
      <p title={noDomainWhy}>{noDomainWhy}</p>
    </div>
    {/* The onboarding domain step: an empty step opens it, and the dashboard's gate goes there. */}
    <Button variant="primary" className="ov-onboarding__action" onClick={() => setDomainStep(workspaceId, '')} data-analytics="overview/no-domain/add">Add domain<ArrowRight size={16} aria-hidden /></Button>
    <DismissButton kind="no-domain" />
  </section>
}

/** `domain`: the newest verified domain in the setup read, undefined while it loads. `onSent`: Latest emails and the figures read again. */
function FirstSendCard({ domain, onSent }: { domain?: Domain; onSent?: () => void }) {
  const identity = useSession()?.identity, origin = usePublicOrigin(), { copy } = useCopy()
  const to = identity?.email ?? null
  const test = useTestSend(domain, () => onSent?.())
  const from = domain ? `hello@${domain.name}` : null
  const curl = origin && from ? sendSnippets({ origin, apiKey: null, from, to: to ?? 'you@example.com' }).curl : ''
  const line = test.isSuccess && to ? <>Test email queued to <PrivateAddress value={to} />{test.data.simulated ? ' (simulated)' : ''}. <Link to={`/logs/${encodeURIComponent(test.data.id)}`}>View in Logs</Link></>
    : test.error ? <ErrorText error={test.error} />
    : domain ? `${domain.name} can send now. Try it on yourself, or create a key and send from your code.` : 'Your domain can send now.'
  return <section className="ov-onboarding" data-kind="first-send" aria-labelledby="ov-onboarding-title">
    <div className="ov-onboarding__text">
      <h2 id="ov-onboarding-title">You’re verified. Send your first email</h2>
      <p data-tone={test.error ? 'danger' : undefined} role="status">{line}</p>
    </div>
    <div className="ov-onboarding__actions">
      <Button variant="primary" loading={test.isPending} disabled={!domain || !to || test.isSuccess} onClick={() => test.mutate()} data-analytics="overview/first-send/test"><Send size={14} aria-hidden />Send a test to yourself</Button>
      <Link className="ui-button ui-button--secondary ui-button--md" to={domain ? `/api-keys?create=send&domain=${encodeURIComponent(domain.name)}` : '/api-keys?create=send'} data-analytics="overview/first-send/key">Create an API key</Link>
      <Button variant="ghost" disabled={!curl} onClick={() => void copy(curl, 'Copied the cURL example')} data-analytics="overview/first-send/copy"><Copy size={14} aria-hidden />Copy cURL</Button>
    </div>
    <DismissButton kind="first-send" />
  </section>
}

export function OnboardingCard({ kind, domain, onSent }: { kind: OnboardingCardKind; domain?: Domain; onSent?: () => void }) {
  return kind === 'no-domain' ? <NoDomainCard /> : <FirstSendCard domain={domain} onSent={onSent} />
}
