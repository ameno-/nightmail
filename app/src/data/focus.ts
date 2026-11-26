import { useQueryClient } from '@tanstack/react-query'
import { WORKSPACE_FOCUS, type WorkspaceFocus } from '../../../api/src/workspace-focus.js'
import { analytics } from '../lib/analytics'
import { useToast } from '../components/ui'
import { request } from './live'
import type { LandingFocus } from './landing-focus'
import { ApiError, type Identity, type WorkspaceSettings } from './types'

// What the workspace is here for (api/src/workspace-focus.ts): Settings sets it, or a landing link's focus as onboarding
// opens, and the first pick leads Overview's first card and its Get started steps.
export { WORKSPACE_FOCUS, type WorkspaceFocus }
export const focusLabels: Record<WorkspaceFocus, string> = { marketing: 'Marketing emails', newsletter: 'Newsletter', developer: 'Developer emails', agents: 'Agent inboxes', personal: 'An inbox for myself' }
/** The leading focus; developer (the agent prompt and a test send) when none was chosen or it was skipped. */
export const leadFocus = (identity: Pick<Identity, 'focus'> | null | undefined): WorkspaceFocus => identity?.focus?.[0] ?? 'developer'

/**
 * Saves a focus in the background: the session and Settings show it at once, PATCH /v1/settings/workspace follows, and
 * the picks go to analytics (focus_chosen, lead first; focus/skip for none; landing/<focus>[/<comparison page>] for one a
 * landing link brought, data/landing-focus.ts). A failed save says so and keeps the choice for this visit.
 */
export function useSaveFocus() {
  const client = useQueryClient(), toast = useToast()
  return (focus: WorkspaceFocus[], landing?: Pick<LandingFocus, 'from'>) => {
    client.setQueryData<Identity>(['identity'], identity => identity && { ...identity, focus })
    client.setQueryData<WorkspaceSettings>(['nightmail', 'workspace-settings'], settings => settings && { ...settings, focus })
    analytics().track('focus_chosen', landing ? ['landing', ...focus, ...landing.from ? [landing.from] : []].join('/') : focus.length ? ['focus', ...focus].join('/') : 'focus/skip')
    void request<WorkspaceSettings>('/v1/settings/workspace', { method: 'PATCH', body: { focus } })
      .catch(() => toast('Couldn’t save what you want to focus on. You can set it in Settings.', 'error'))
  }
}

// The agent inboxes focus: onboarding's step and Overview's card share one inbox read.
export type Inbox = { id: string; address: string }
/** agent@ on the domain: the inbox already there, else a persistent one made for it (once: clientId). */
export async function ensureAgentInbox(domain: string, signal?: AbortSignal): Promise<Inbox> {
  const address = `agent@${domain}`
  const existing = async () => (await request<{ data: Inbox[] }>(`/v1/inboxes?q=${encodeURIComponent(address)}&limit=5`, { signal })).data.find(inbox => inbox.address === address)
  const found = await existing()
  if (found) return found
  try {
    return await request<Inbox>('/v1/inboxes', { method: 'POST', signal, body: { type: 'persistent', domain, localPart: 'agent', name: 'Agent', clientId: `onboarding-agent-${domain}` } })
  } catch (error) {
    // Made meanwhile, by another tab or the agent.
    if (error instanceof ApiError && error.code === 'ADDRESS_TAKEN') { const made = await existing(); if (made) return made }
    throw error
  }
}
export const agentInboxQuery = (domain: string) => ({ queryKey: ['nightmail', 'agent-inbox', domain], queryFn: ({ signal }: { signal?: AbortSignal }) => ensureAgentInbox(domain, signal), staleTime: Infinity, retry: 1 })

