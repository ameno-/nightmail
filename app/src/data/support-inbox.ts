import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import { request } from './live'

// The support inbox (/v1/operator/support-inbox, api/src/support-inbox.ts): every support conversation, for Nightmail
// staff. Like the rest of the operator API it is left out of the public SDK, so the inbox calls it with the dashboard's
// own request helper. Its views: Needs you (what only a person can move forward, most urgent first), Agent handling and All.
export type InboxView = 'needs_you' | 'agent' | 'all'
export type Channel = 'chat' | 'email'
export type SupportAuthor = 'customer' | 'agent' | 'staff' | 'system'
export type TriageReason = 'ticket' | 'blocked' | 'failed' | 'paused'
export interface SupportTicket { id: string; type: string | null; severity: string | null; resolvedAt: string | null }
export interface SupportConversation {
  id: string; channel: 'chat' | 'email'; mode: 'member' | 'non_member' | 'pending_signin' | 'unverified'; verification: 'handoff' | 'dmarc' | 'signin' | 'none'
  status: 'open' | 'ticketed' | 'closed'; subject: string | null; customer: { userId: string; name: string | null; email: string | null } | null; sender: string | null
  workspace: { id: string; name: string } | null; ticket: SupportTicket | null; agentState: 'active' | 'paused'
  pausedBy: { kind: 'staff' | 'ticket'; userId: string | null; name: string | null } | null; pausedAt: string | null
  lastAuthor: SupportAuthor | null; needsReply: boolean; messageCount: number; queuedReplies: number; turns: number; costUsd: number; blockedWork: number
  firstLine: string | null; needsYou: { reasons: TriageReason[]; urgent: boolean; since: string } | null; done: { at: string; userId: string; name: string | null } | null; unread: boolean
  createdAt: string; lastMessageAt: string | null; closedAt: string | null
}
export interface SupportMessage {
  id: string; seq: number; author: SupportAuthor; kind: string | null; text: string; tools: { label: string; ok: boolean }[]; attachments: string[]
  staff: { userId: string; name: string | null } | null; delivery: 'queued' | 'sent' | 'failed' | 'held' | null; deliveredAt: string | null; at: string
}
export interface SupportWorkspace { id: string; name: string; role: string; joinedAt: string; createdAt: string; members: number; inScope: boolean; contentShared: boolean; sending: { kind: string; region: string | null; paused: boolean } | null; standing: string | null }
export interface SupportDetail {
  conversation: SupportConversation & { threadId: string | null; page: string | null; contentWorkspaceId: string | null
    evidence: { handoff: string | null; message: string | null; dmarc: string | null; dkimAligned: boolean | null; claimedAt: string | null } }
  messages: SupportMessage[]; earlierMessages: number
  customer: {
    user: { id: string; name: string | null; email: string | null; emailVerified: boolean; createdAt: string } | null
    workspaces: SupportWorkspace[]
    conversations: { id: string; channel: string; mode: string; verification: string; status: string; subject: string | null; ticket: SupportTicket | null; createdAt: string; lastMessageAt: string | null }[]
    activity: { id: string; at: string; action: string; workspaceId: string | null; actorType: string; via: string; internal: boolean; summary: Record<string, unknown> }[]
    notes: { id: string; text: string; author: 'agent' | 'staff'; workspaceId: string | null; conversationId: string; createdAt: string }[]
  }
  replyAvailable: boolean
}
export interface SupportInboxPage { data: SupportConversation[]; nextCursor: string | null; replyAvailable: boolean; counts: { needsYou: number; agent: number } }
export type SupportAction = 'pause' | 'resume' | 'resolve' | 'done'

const base = '/v1/operator/support-inbox', id = encodeURIComponent
export const supportInboxApi = {
  list: ({ view, q, channel, cursor }: { view: InboxView; q?: string; channel?: Channel; cursor?: string }, signal?: AbortSignal) => {
    const params = new URLSearchParams({ view, limit: '50' })
    if (q) params.set('q', q)
    if (channel) params.set('channel', channel)
    if (cursor) params.set('cursor', cursor)
    return request<SupportInboxPage>(`${base}?${params}`, { signal })
  },
  detail: (conversationId: string, signal?: AbortSignal) => request<SupportDetail>(`${base}/${id(conversationId)}`, { signal }),
  reply: (conversationId: string, text: string, idempotencyKey: string) => request<SupportMessage>(`${base}/${id(conversationId)}/replies`, { method: 'POST', body: { text }, idempotencyKey }),
  act: (conversationId: string, action: SupportAction, idempotencyKey: string) => request<SupportConversation>(`${base}/${id(conversationId)}/${action}`, { method: 'POST', idempotencyKey }),
  wake: (conversationId: string) => request<{ id: string; woken: boolean }>(`${base}/${id(conversationId)}/wake`, { method: 'POST' }),
  read: (conversationId: string, read: boolean, seq?: number) => request<{ id: string; unread: boolean }>(`${base}/${id(conversationId)}/read`, { method: 'PUT', body: seq === undefined ? { read } : { read, seq } }),
}

export const inboxKeys = {
  all: ['support-inbox'] as const,
  lists: ['support-inbox', 'list'] as const,
  list: (view: InboxView, q: string, channel: Channel | '') => ['support-inbox', 'list', view, q, channel] as const,
  detail: (conversationId: string) => ['support-inbox', 'detail', conversationId] as const,
}
export const listQuery = (view: InboxView, q: string, channel: Channel | '' = '') => ({
  queryKey: inboxKeys.list(view, q, channel), initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) => supportInboxApi.list({ view, q: q || undefined, channel: channel || undefined, cursor: pageParam }, signal),
  getNextPageParam: (page: SupportInboxPage) => page.nextCursor ?? undefined,
})
// A conversation stays fresh for 15 seconds: hovering it, opening it and moving past it read it once.
export const DETAIL_FRESH = 15_000
export const detailQuery = (conversationId: string) => ({ queryKey: inboxKeys.detail(conversationId), queryFn: ({ signal }: { signal: AbortSignal }) => supportInboxApi.detail(conversationId, signal), staleTime: DETAIL_FRESH })
export const prefetchConversation = (client: QueryClient, conversationId: string) => client.prefetchQuery(detailQuery(conversationId))

// ---------- what the inbox shows before the API answers (optimistic updates) ----------

// The API's rule (api/src/support-inbox.ts "Needs you"), for the change a click predicts; the next read replaces it.
export function triage(c: SupportConversation): SupportConversation['needsYou'] {
  if (c.done) return null
  const ticket = Boolean(c.ticket && !c.ticket.resolvedAt), blocked = c.blockedWork > 0, failed = c.needsYou?.reasons.includes('failed') ?? false
  const paused = c.agentState === 'paused' && c.status !== 'closed' && c.lastAuthor !== 'staff'
  const reasons = ([['ticket', ticket], ['blocked', blocked], ['failed', failed], ['paused', paused]] as const).filter(([, on]) => on).map(([reason]) => reason)
  if (!reasons.length) return null
  return { reasons, urgent: (ticket && c.ticket?.severity === 'P1') || failed || (c.lastAuthor === 'customer' && (paused || blocked)), since: c.needsYou?.since ?? new Date().toISOString() }
}
export const inView = (c: SupportConversation, view: InboxView) => view === 'all' ? true : view === 'needs_you' ? c.needsYou !== null : c.status !== 'closed' && c.agentState === 'active' && c.needsYou === null
const inList = (c: SupportConversation, key: readonly unknown[]) => inView(c, key[2] as InboxView) && (!key[4] || c.channel === key[4])

type ListData = InfiniteData<SupportInboxPage, string | undefined>
/** Every cached list and the conversation's own page, after `change`: rows that leave a view leave it, and the counts follow. */
export function patchConversation(client: QueryClient, conversationId: string, change: (c: SupportConversation) => SupportConversation) {
  let before: SupportConversation | undefined
  const detail = client.getQueryData<SupportDetail>(inboxKeys.detail(conversationId))
  for (const [, data] of client.getQueriesData<ListData>({ queryKey: inboxKeys.lists })) before ??= data?.pages.flatMap(page => page.data).find(c => c.id === conversationId)
  before ??= detail?.conversation
  if (!before) return
  const predicted = change(before), changed = { ...predicted, needsYou: triage(predicted) }
  const delta = { needsYou: Number(inView(changed, 'needs_you')) - Number(inView(before, 'needs_you')), agent: Number(inView(changed, 'agent')) - Number(inView(before, 'agent')) }
  for (const [key, data] of client.getQueriesData<ListData>({ queryKey: inboxKeys.lists })) {
    if (!data) continue
    client.setQueryData<ListData>(key, {
      ...data,
      pages: data.pages.map(page => ({
        ...page, counts: { needsYou: Math.max(0, page.counts.needsYou + delta.needsYou), agent: Math.max(0, page.counts.agent + delta.agent) },
        data: page.data.flatMap(c => c.id !== conversationId ? [c] : inList(changed, key) ? [changed] : []),
      })),
    })
  }
  if (detail) client.setQueryData<SupportDetail>(inboxKeys.detail(conversationId), { ...detail, conversation: { ...detail.conversation, ...changed } })
}
/** A snapshot of every inbox query, to put back when a change the inbox predicted fails. */
export function snapshotInbox(client: QueryClient) {
  const saved = client.getQueriesData({ queryKey: inboxKeys.all })
  return () => { for (const [key, data] of saved) client.setQueryData(key, data) }
}
