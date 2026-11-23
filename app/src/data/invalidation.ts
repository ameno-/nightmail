import { useEffect, useRef } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'

// Query keys are ['nightmail', resource, ...args]; the resource names what a query reads.
export const resourceOf = (queryKey: readonly unknown[]) => String(queryKey[1])
// Lists and details backed by SES or other slow external reads: an ordinary write leaves them alone, and the
// mutations that change them (domains, regions) pass refreshSes to refresh everything.
const external = new Set(['regions', 'region-discovery', 'domain', 'domains', 'campaign-options'])
export const staleAfterWrite = (queryKey: readonly unknown[], refreshSes: boolean) => queryKey[0] === 'nightmail' && (refreshSes || !external.has(resourceOf(queryKey)))

// Resource groups invalidated by mutations. Each entry names queryKey[1] values under ['nightmail', ...].
// Audited writes include 'activity' so Settings -> Activity stays fresh when visited (never refetched unless mounted).
// When unsure, include the affected resource rather than risking stale data.
export const invalidate = {
  contactProfile: ['contacts', 'campaign-audience', 'activity'] as const,
  contactMembership: ['contacts', 'lists', 'newsletter', 'newsletters', 'campaign-audience', 'activity'] as const,
  contactConsent: ['contacts', 'consent-history', 'lists', 'newsletter', 'newsletters', 'campaign-audience', 'activity'] as const,
  audienceBulk: ['contacts', 'consent-history', 'lists', 'newsletter', 'newsletters', 'campaign-audience', 'activity'] as const,
  lists: ['lists', 'campaign-audience-options', 'campaign-audience', 'newsletter', 'newsletters', 'activity'] as const,
  segments: ['segments', 'campaign-audience-options', 'campaign-audience', 'activity'] as const,
  campaignArchive: ['campaign', 'campaigns', 'overview', 'activity'] as const,
  campaignTest: ['logs', 'emails', 'overview', 'overview-setup'] as const,
  campaignSend: ['campaign', 'campaigns', 'campaign-stats', 'campaign-audience', 'overview', 'overview-setup', 'logs', 'emails', 'sender-score', 'sending-limit', 'billing', 'usage', 'activity'] as const,
  campaignCreate: ['campaigns', 'templates', 'activity'] as const,
  templates: ['templates', 'template', 'template-preview', 'activity'] as const,
  scheduledEmail: ['logs', 'emails', 'email', 'overview', 'activity'] as const,
  webhooks: ['webhooks', 'webhook', 'overview-setup', 'activity'] as const,
  webhookDelivery: ['webhook', 'webhooks'] as const,
  apiKeys: ['keys', 'key-changes', 'overview-setup', 'activity'] as const,
  agents: ['agents', 'keys', 'inbound-overview', 'inbound-endpoints', 'routing', 'activity'] as const,
  appPasswords: ['app-passwords', 'activity'] as const,
  domains: ['domains', 'domain', 'mailbox-domains', 'mailbox-domain', 'inbound-overview', 'overview-setup', 'sender-score', 'campaign-options', 'activity'] as const,
  mailboxDomains: ['mailbox-domains', 'mailbox-domain', 'domains', 'domain', 'inbound-overview', 'activity'] as const,
  connection: ['connection', 'domains', 'domain', 'regions', 'region-discovery', 'overview-setup', 'sender-score', 'campaign-options', 'activity'] as const,
  workspace: ['workspace', 'workspace-settings', 'activity'] as const,
  postalAddress: ['workspace', 'activity'] as const,
  workspaceMembers: ['workspace-members', 'activity'] as const,
  workspaceInvitations: ['workspace-invitations', 'overview-setup', 'activity'] as const,
  inboundAddresses: ['inbound-addresses', 'inbound-address', 'inbound-overview', 'routing', 'inbound-threads', 'inbound-thread', 'activity'] as const,
  routing: ['routing', 'inbound-overview', 'inbound-addresses', 'inbound-address', 'activity'] as const,
  inboundWebhooks: ['inbound-webhooks', 'inbound-webhook', 'inbound-webhook-deliveries', 'inbound-overview', 'inbound-endpoints', 'routing', 'activity'] as const,
  inboundThreads: ['inbound-threads', 'inbound-thread', 'inbound-overview', 'inbound-addresses'] as const,
  inboundReply: ['inbound-threads', 'inbound-thread', 'inbound-message', 'inbound-overview', 'logs', 'emails', 'overview', 'activity'] as const,
  agentInboxes: ['agent-inboxes', 'agent-inbox', 'agent-inbox-folders', 'inbound-addresses', 'inbound-overview', 'routing', 'keys', 'app-passwords', 'activity'] as const,
  agentInboxSimulate: ['agent-inbox', 'agent-inbox-folders', 'agent-inbox-messages', 'agent-inboxes', 'logs'] as const,
  rules: ['inbound-overview', 'inbound-endpoints', 'inbound-addresses', 'inbound-address', 'inbound-webhooks', 'forward-endpoints', 'routing', 'rule-recipes', 'rule-recent', 'trace-recent', 'why-it-went-here', 'activity'] as const,
} as const

export type InvalidationTarget<TInput = unknown, TResult = unknown> =
  | boolean
  | readonly string[]
  | ((result: TResult, input: TInput) => readonly string[])

export function invalidateResources(client: QueryClient, resources: readonly string[]) {
  if (!resources.length) return Promise.resolve()
  const set = new Set(resources)
  const active = client.invalidateQueries({ predicate: query => query.queryKey[0] === 'nightmail' && set.has(resourceOf(query.queryKey)) })
  // Domain, list, and segment changes also mark cached campaign-options stale without refetching while unmounted.
  if (!set.has('campaign-options') && (set.has('domains') || set.has('lists') || set.has('segments'))) {
    void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'nightmail' && resourceOf(query.queryKey) === 'campaign-options', refetchType: 'none' }).catch(() => {})
  }
  return active
}

// A polled detail page learns of a status change (domain verified, campaign done) before any cached list of the same
// resource does; when the observed value changes, mark those lists stale so the next visit refetches them.
export function useRefreshListsOnChange(resource: string, value: string | undefined) {
  const client = useQueryClient()
  const previous = useRef(value)
  useEffect(() => {
    if (previous.current !== undefined && value !== undefined && previous.current !== value) void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'nightmail' && resourceOf(query.queryKey) === resource }).catch(() => {})
    if (value !== undefined) previous.current = value
  }, [client, resource, value])
}
