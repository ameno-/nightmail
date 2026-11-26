import { useSyncExternalStore } from 'react'
import type { Identity } from './types'

// Onboarding's steps, stored per workspace so a reload returns to the same one: '' for the first (Hosted: Get started on the
// built-in domain; otherwise Add domain), an own domain's ID while it verifies, then `agent:<ID>` for Get started on that
// domain, and `done` once they finish. Hosted runs them while its account is still being provisioned, before the ID is
// known: then it is ''.
// Without a stored step (another browser, cleared storage) the server decides: no domain yet opens Add domain, unless the
// workspace has sent mail already (from its built-in domain): then setup is done and the dashboard opens.
const stepKey = (workspaceId: string) => `nightmail.onboarding.domain.${workspaceId}`
const listeners = new Set<() => void>()
const memory = new Map<string, string | null>()
export function readDomainStep(workspaceId: string) {
  if (memory.has(workspaceId)) return memory.get(workspaceId)!
  try { return localStorage.getItem(stepKey(workspaceId)) } catch { return null }
}
export function setDomainStep(workspaceId: string, value: string | null) {
  try { if (value === null) localStorage.removeItem(stepKey(workspaceId)); else localStorage.setItem(stepKey(workspaceId), value) } catch { /* Step can remain in memory only. */ }
  memory.set(workspaceId, value)
  listeners.forEach(listener => listener())
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function useDomainStep(workspaceId: string | undefined) {
  return useSyncExternalStore(subscribe, () => workspaceId ? readDomainStep(workspaceId) : null)
}

// A domain added while a connected AWS account sets up a region: the add-domain step opens its records once it exists.
const regionalKey = (workspaceId: string) => `nightmail.onboarding.aws-domain.${workspaceId}`
export function readRegionalDomain(workspaceId: string) { try { return localStorage.getItem(regionalKey(workspaceId)) } catch { return null } }
export function setRegionalDomain(workspaceId: string, name: string | null) {
  try { if (name === null) localStorage.removeItem(regionalKey(workspaceId)); else localStorage.setItem(regionalKey(workspaceId), name) } catch { /* Then the add-domain step asks again. */ }
}

// Hosted workspaces need a ready sending connection (summarised in /v1/me) before the dashboard opens for an owner or
// admin, who sets it up. Members open the dashboard at once, with a banner until it is ready (SetupBanner).
export type OnboardingStage = { step: 'sending' } | { step: 'domain'; domainId: string } | { step: 'start'; domainId: string } | null
// `focus:<ID>` is what a browser stored on the "What do you want to do?" step, which Get started replaced: it opens Get started.
const startPrefixes = ['agent:', 'focus:']
export const startStep = (domainId: string) => `${startPrefixes[0]}${domainId}`
export const finishedStep = 'done'
/** The stage a stored step opens; null for `done`. */
export function storedStage(domainStep: string): OnboardingStage {
  if (domainStep === finishedStep) return null
  const prefix = startPrefixes.find(value => domainStep.startsWith(value))
  return prefix ? { step: 'start', domainId: domainStep.slice(prefix.length) } : { step: 'domain', domainId: domainStep }
}
export function onboardingStage(identity: Identity | null | undefined, domainStep: string | null): OnboardingStage {
  if (!identity?.multiTenant) return null
  if (identity.role !== 'owner' && identity.role !== 'admin') return null
  if (identity.connection?.state !== 'ready') return { step: 'sending' }
  if (domainStep === finishedStep) return null
  if (domainStep === null) return identity.connection.domains?.total === 0 && !identity.connection.sent ? { step: 'domain', domainId: '' } : null
  return storedStage(domainStep)
}
export const identityOnboardingStage = (identity: Identity | null | undefined) => onboardingStage(identity, identity ? readDomainStep(identity.workspaceId) : null)

// Remembers which workspace last opened the dashboard, so boot only prefetches dashboard data
// alongside /v1/me when that workspace is unlikely to need onboarding.
const readyKey = 'nightmail.dashboard-ready'
const readyValue = (workspaceId: string | null) => workspaceId ?? '*'
export function rememberDashboardReady(workspaceId: string | null, ready: boolean) {
  try { if (ready) localStorage.setItem(readyKey, readyValue(workspaceId)); else if (localStorage.getItem(readyKey) === readyValue(workspaceId)) localStorage.removeItem(readyKey) } catch { /* Boot then waits for /v1/me. */ }
}
export function dashboardLikelyReady(workspaceId: string | null) {
  try { return localStorage.getItem(readyKey) === readyValue(workspaceId) } catch { return false }
}
