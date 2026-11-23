import { forwardRef, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode, type RefObject } from 'react'
import { Link, useLocation, useNavigate, useNavigationType, useParams, useSearchParams } from 'react-router'
import { useInfiniteQuery, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { Check, Mail, MessageSquare, X } from 'lucide-react'
import { Button, ConfirmDialog, DataTable, Dialog, DropdownMenu, EmptyState, ErrorState, KeyValues, PageHeader, StatusBadge, StatusDot, Textarea, useToast, type Column, type MenuItem, type Tone } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useSession } from '../../data/context'
import { ApiError } from '../../data/types'
import { detailQuery, inboxDraft, inboxKeys, listQuery, patchConversation, prefetchConversation, snapshotInbox, subscribeInboxDrafts, supportInboxApi, updateInboxDraft, type Channel, type InboxView, type SupportAction, type SupportConversation, type SupportDetail, type SupportInboxPage, type SupportMessage } from '../../data/support-inbox'
import { ago, label, number, shortDateTime } from '../../lib/format'
import { useSearchDraft } from '../../lib/pagination'
import { usePhone } from '../../lib/media'
import { Markdown } from '../support/markdown'
import { ActionsTrigger, StaffOnly } from '../operator/skeletons'
import { channelOf, ConversationActions, ConversationBodySkeleton, InboxBody, InboxTabs, InboxToolbar, inboxColumnDefs, SupportConversationSkeleton, SupportInboxSkeleton, triageOf, viewOf } from './skeletons'

// The support inbox (lazy, /support): Nightmail staff triage every support conversation. Needs you (the default) is
// what only a person can move forward, most urgent first (api/src/support-inbox.ts); Agent handling is what the agent
// answers on its own; All is everything. Keyboard first: j and k move, Enter or o opens, Esc goes back, r replies,
// e marks done (and moves on; Undo on its toast), h hands back, u marks read or unread, / searches, ? lists the keys. In
// the list the selected row and the focused one are always the same, so a key acts on what is on screen. Lists and
// conversations come from the query cache at once and refresh behind it; a conversation is read ahead on hover, on
// selection and next to the open one, so moving between them never waits. Changes show before the API answers.

// What the inbox keeps between its pages in this visit: the list a conversation was opened from (j and k follow it) and
// the row selected in each view. Unsent replies are kept per conversation in this tab (data/support-inbox.ts).
const memory: { list: { view: InboxView; q: string; channel: Channel | '' }; selected: Partial<Record<InboxView, string>> } = { list: { view: 'needs_you', q: '', channel: '' }, selected: {} }
const CONVERSATION = /^conv_[a-z2-7]{26}$/
const listPath = () => { const params = new URLSearchParams(); if (memory.list.view !== 'needs_you') params.set('view', memory.list.view); if (memory.list.q) params.set('q', memory.list.q); if (memory.list.channel) params.set('channel', memory.list.channel); const query = params.toString(); return query ? `/support?${query}` : '/support' }
const useRole = () => useSession()?.identity?.operator ?? null
const def = (key: string) => inboxColumnDefs.find(column => column.key === key)!
const titleOf = (c: SupportConversation) => c.subject ?? c.firstLine ?? 'No messages yet'
const when = (value: string | null | undefined) => value ? `${shortDateTime(value)} UTC` : '—'
const lastActivity = (c: SupportConversation) => c.lastMessageAt ?? c.createdAt
const flatten = (pages: SupportInboxPage[] | undefined) => pages?.flatMap(page => page.data) ?? []
function cached(client: QueryClient, id: string) {
  for (const [, data] of client.getQueriesData<{ pages: SupportInboxPage[] }>({ queryKey: inboxKeys.lists })) { const found = flatten(data?.pages).find(c => c.id === id); if (found) return found }
  return client.getQueryData<SupportDetail>(inboxKeys.detail(id))?.conversation
}

// ---------------------------------------------------------------- keys

const typing = (target: EventTarget | null) => target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
/** The inbox's single-key shortcuts: never while typing, inside a dialog or menu, or with a modifier. Arrows move like j and k. */
function useShortcuts(keys: Record<string, () => void>, enabled = true) {
  const latest = useRef(keys)
  latest.current = keys
  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || event.isComposing || typing(event.target)) return
      if (document.querySelector('[role=dialog][data-state=open], [role=alertdialog], [role=menu]')) return
      const key = event.key === 'ArrowDown' ? 'j' : event.key === 'ArrowUp' ? 'k' : event.key
      // Enter on a focused link or button is that control's own (a view's tab only changes the view, so Enter opens).
      if (key === 'Enter' && event.target instanceof HTMLElement && event.target.closest('a, button:not([role=tab])')) return
      const run = latest.current[key]
      if (!run) return
      event.preventDefault()
      run()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [enabled])
}
const shortcuts: [string[], string][] = [[['j', 'k'], 'Next or previous conversation'], [['Enter', 'o'], 'Open'], [['Esc'], 'Back to the list'], [['r'], 'Reply'], [['e'], 'Mark done and move on (Undo on its toast)'],
  [['h'], 'Hand back to the agent'], [['u'], 'Mark read or unread'], [['/'], 'Search'], [['⌘', '↵'], 'Send a reply'], [['?'], 'These shortcuts']]
function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose() }} title="Keyboard shortcuts" className="sinbox-shortcuts">
    <dl className="sinbox-keys">{shortcuts.map(([keys, text]) => <div key={text}><dt>{keys.map(key => <kbd key={key}>{key}</kbd>)}</dt><dd>{text}</dd></div>)}</dl>
  </Dialog>
}

// ---------------------------------------------------------------- changes

type Confirming = { action: 'pause' | 'resume' | 'resolve'; conversation: SupportConversation }
const confirmCopy: Record<Confirming['action'], { title: string; description: string; confirm: string; done: string }> = {
  pause: { title: 'Pause the agent?', description: 'It stops answering this customer until someone hands back.', confirm: 'Pause agent', done: 'Agent paused' },
  resume: { title: 'Hand back to the agent?', description: 'It answers the customer’s next message.', confirm: 'Hand back', done: 'Handed back to the agent' },
  resolve: { title: 'Resolve this ticket?', description: 'The customer isn’t told.', confirm: 'Resolve ticket', done: 'Ticket resolved' },
}
const failedText = 'Couldn’t complete the action. Try again.'
/** Every change the inbox makes: shown at once in every list and the conversation, put back if the API refuses it, then read again. */
function useInboxActions() {
  const client = useQueryClient(), toast = useToast(), identity = useSession()?.identity
  const me = { userId: identity?.id ?? '', name: identity?.name ?? null }
  // reread: false for a change the prediction already shows exactly (a read marker), so nothing is fetched again.
  async function run<T>(c: SupportConversation, predict: (c: SupportConversation) => SupportConversation, call: () => Promise<T>, { done, quiet = false, after, reread = true }: { done?: string; quiet?: boolean; after?: (result: T) => void; reread?: boolean } = {}) {
    const restore = snapshotInbox(client)
    // A read in flight would land over the prediction; the conversations around it keep theirs (read ahead).
    await Promise.all([client.cancelQueries({ queryKey: inboxKeys.lists }), client.cancelQueries({ queryKey: inboxKeys.detail(c.id) })])
    patchConversation(client, c.id, predict)
    try {
      const result = await call()
      after?.(result)
      if (done) toast(done, 'success')
      return result
    } catch (error) {
      restore()
      if (!quiet) toast(error instanceof ApiError ? error.message : failedText, 'error')
      throw error
    } finally {
      if (reread) {
        void client.invalidateQueries({ queryKey: inboxKeys.lists })
        void client.invalidateQueries({ queryKey: inboxKeys.detail(c.id) })
      }
    }
  }
  const now = () => new Date().toISOString()
  const act = (c: SupportConversation, action: SupportAction, predict: (c: SupportConversation) => SupportConversation, options: { done?: string; quiet?: boolean } = {}) =>
    run(c, predict, () => supportInboxApi.act(c.id, action, crypto.randomUUID()), options)
  // Undo puts back what that Done changed: the conversation, and the ticket it resolved.
  const undo = (c: SupportConversation, ticketId: string | null) => run(c, x => ({ ...x, done: null, ticket: ticketId && x.ticket?.id === ticketId ? { ...x.ticket, resolvedAt: null } : x.ticket }),
    () => supportInboxApi.undoDone(c.id, crypto.randomUUID()), { done: 'Back in Needs you' }).catch(() => {})
  return {
    // Done is for this conversation and the ticket it showed when the key was pressed: one filed since refuses it.
    done: (c: SupportConversation) => {
      const ticketId = c.ticket && !c.ticket.resolvedAt ? c.ticket.id : null
      return run(c, x => ({ ...x, done: { at: now(), userId: me.userId, name: me.name }, ticket: ticketId && x.ticket ? { ...x.ticket, resolvedAt: now() } : x.ticket }),
        () => supportInboxApi.done(c.id, ticketId, crypto.randomUUID()),
        { after: () => toast(ticketId ? 'Marked done. Ticket resolved.' : 'Marked done', 'success', { action: { label: 'Undo', onSelect: () => void undo(c, ticketId) }, duration: 5000 }) }).catch(() => {})
    },
    confirm: ({ action, conversation }: Confirming) => act(conversation, action, action === 'pause' ? x => ({ ...x, agentState: 'paused', pausedBy: { kind: 'staff', userId: me.userId, name: me.name }, pausedAt: now(), done: null })
      : action === 'resume' ? x => ({ ...x, agentState: 'active', pausedBy: null, pausedAt: null }) : x => ({ ...x, ticket: x.ticket && { ...x.ticket, resolvedAt: now() } }), { done: confirmCopy[action].done, quiet: true }),
    read: (c: SupportConversation, read: boolean, seq?: number) => run(c, x => ({ ...x, unread: !read }), () => supportInboxApi.read(c.id, read, seq), { reread: false }).catch(() => {}),
    wake: (c: SupportConversation) => run(c, x => x, () => supportInboxApi.wake(c.id)).then(r => toast(r.woken ? 'Support service woken' : 'The support service didn’t answer', r.woken ? 'success' : 'error'), () => {}),
    reply: (c: SupportConversation, text: string, key: string) => {
      const pending: SupportMessage = { id: `pending:${key}`, seq: c.messageCount + 1, author: 'staff', kind: 'reply', text, tools: [], attachments: [], staff: me, delivery: 'queued', deliveredAt: null, at: now() }
      const messages = (change: (list: SupportMessage[]) => SupportMessage[]) => client.setQueryData<SupportDetail>(inboxKeys.detail(c.id), d => d && { ...d, messages: change(d.messages) })
      return run(c, x => { messages(list => [...list, pending]); return { ...x, agentState: 'paused', pausedBy: { kind: 'staff', userId: me.userId, name: me.name }, pausedAt: x.pausedAt ?? now(), lastAuthor: 'staff', lastMessageAt: now(), messageCount: x.messageCount + 1, queuedReplies: x.queuedReplies + 1, done: null, unread: false } },
        () => supportInboxApi.reply(c.id, text, key), { after: sent => messages(list => list.map(m => m.id === pending.id ? sent : m)), done: c.agentState === 'active' ? 'Reply queued. The agent is paused.' : 'Reply queued' })
    },
  }
}
type Actions = ReturnType<typeof useInboxActions>
/** onDone: a conversation's own Mark done, which also opens the next one. */
function menuItems(c: SupportConversation, { canAct, actions, onConfirm, open, onDone }: { canAct: boolean; actions: Actions; onConfirm: (confirming: Confirming) => void; open?: () => void; onDone?: () => void }): MenuItem[] {
  const items: (MenuItem | false)[] = [
    Boolean(open) && { label: 'Open', onSelect: open! },
    canAct && c.needsYou !== null && { label: c.ticket && !c.ticket.resolvedAt ? 'Mark done and resolve ticket' : 'Mark done', onSelect: onDone ?? (() => void actions.done(c)) },
    { label: c.unread ? 'Mark read' : 'Mark unread', onSelect: () => void actions.read(c, c.unread) },
    canAct && c.status !== 'closed' && (c.agentState === 'paused' ? { label: 'Hand back to the agent…', onSelect: () => onConfirm({ action: 'resume', conversation: c }) } : { label: 'Pause agent…', onSelect: () => onConfirm({ action: 'pause', conversation: c }) }),
    canAct && Boolean(c.ticket && !c.ticket.resolvedAt) && { label: 'Resolve ticket…', onSelect: () => onConfirm({ action: 'resolve', conversation: c }) },
    canAct && c.blockedWork > 0 && { label: 'Retry now', onSelect: () => void actions.wake(c) },
  ]
  return items.filter((item): item is MenuItem => Boolean(item))
}
function ConfirmAction({ confirming, onClose, actions }: { confirming: Confirming | null; onClose: () => void; actions: Actions }) {
  const last = useRef(confirming)
  if (confirming) last.current = confirming
  const shown = confirming ?? last.current, copy = shown ? confirmCopy[shown.action] : confirmCopy.pause
  return <ConfirmDialog open={confirming !== null} onOpenChange={open => { if (!open) onClose() }} title={copy.title} description={copy.description} confirmLabel={copy.confirm} onConfirm={() => shown ? actions.confirm(shown) : undefined} />
}

// ---------------------------------------------------------------- cells

const ticketText = (c: SupportConversation) => !c.ticket ? null : `${[c.ticket.severity, c.ticket.type && label(c.ticket.type)].filter(Boolean).join(' ') || 'Ticket'}${c.ticket.resolvedAt ? ' · resolved' : ''}`
function agentOf(c: SupportConversation): { text: string; by?: string; tone: Tone } {
  if (c.agentState === 'active') return { text: c.status === 'closed' ? 'Closed' : 'Active', tone: c.status === 'closed' ? 'neutral' : 'success' }
  return { text: 'Paused', by: c.pausedBy?.kind === 'ticket' ? 'the ticket' : c.pausedBy?.name ?? undefined, tone: 'warning' }
}
const ChannelIcon = ({ channel }: { channel: SupportConversation['channel'] }) => channel === 'email' ? <Mail size={14} aria-label="Email" /> : <MessageSquare size={14} aria-label="Chat" />
function Who({ c }: { c: SupportConversation }) {
  const address = c.customer?.email ?? c.sender
  return <span className="sinbox-who" data-unread={c.unread || undefined}>
    <span className="sinbox-unread" role={c.unread ? 'img' : undefined} aria-label={c.unread ? 'Unread' : undefined} />
    <span className="sinbox-channel"><ChannelIcon channel={c.channel} /></span>
    <span className="sinbox-who__name">{c.customer?.name ?? (address ? <PrivateAddress value={address} /> : 'Unknown sender')}</span>
  </span>
}
const Subject = ({ c }: { c: SupportConversation }) => <span className="sinbox-subject">
  <span className="sinbox-subject__text" data-placeholder={c.subject ? undefined : ''}>{titleOf(c)}</span>
  {c.messageCount > 0 && <span className="sinbox-count" title={`${number(c.messageCount)} ${c.messageCount === 1 ? 'message' : 'messages'}`}>↩ {number(c.messageCount)}</span>}
</span>

// ---------------------------------------------------------------- the list

export function SupportInboxPage() {
  const role = useRole(), canAct = role === 'operator'
  const location = useLocation(), navigate = useNavigate(), client = useQueryClient(), phone = usePhone()
  const [params, setParams] = useSearchParams()
  const view = viewOf(location.search), channel = channelOf(location.search), q = (params.get('q') ?? '').trim()
  const [search, setSearch] = useSearchDraft(params.get('q') ?? '', value => setParams(previous => { const next = new URLSearchParams(previous); if (value.trim()) next.set('q', value.trim()); else next.delete('q'); return next }, { replace: true }))
  useEffect(() => { memory.list = { view, q, channel } }, [view, q, channel])
  const setChannel = (next: Channel | '') => setParams(previous => { const params = new URLSearchParams(previous); if (next) params.set('channel', next); else params.delete('channel'); return params }, { replace: true })
  // A search keeps the rows it replaces until its answer arrives; another tab never shows this one's.
  const list = useInfiniteQuery({ ...listQuery(view, q, channel), enabled: Boolean(role), staleTime: 5_000, refetchInterval: query => query.state.status === 'error' ? false : 30_000,
    placeholderData: (previous, query) => query?.queryKey[2] === view ? previous : undefined })
  // The rail counts each channel before the channel filter (this view and search, every channel).
  const everyChannel = useInfiniteQuery({ ...listQuery(view, q, ''), enabled: Boolean(role && channel), staleTime: 5_000 })
  const rows = flatten(list.data?.pages), counts = list.data?.pages[0]?.counts ?? null
  // Each view keeps its own selected row.
  const [selection, setSelection] = useState(() => ({ ...memory.selected }))
  const setSelectedId = (id: string) => setSelection(current => ({ ...current, [view]: id }))
  const index = Math.max(0, rows.findIndex(c => c.id === selection[view])), selected = rows[index]
  useEffect(() => { if (selected) memory.selected[view] = selected.id }, [view, selected?.id])
  const [confirming, setConfirming] = useState<Confirming | null>(null), [keysOpen, setKeysOpen] = useState(false)
  const actions = useInboxActions()
  // The other views' first pages load once this one has, so switching tabs never waits.
  useEffect(() => {
    if (!list.data || !role) return
    for (const other of ['needs_you', 'agent', 'all'] as const) if (other !== view) void client.prefetchInfiniteQuery({ ...listQuery(other, ''), staleTime: 5_000 })
  }, [Boolean(list.data), role])
  // The selected row is read ahead (once it has stayed selected a moment), and kept in view.
  useEffect(() => {
    if (!selected || phone) return
    const timer = window.setTimeout(() => void prefetchConversation(client, selected.id), 120)
    document.querySelector('.sinbox-table tr[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
    return () => window.clearTimeout(timer)
  }, [selected?.id])
  const open = (c: SupportConversation, reply = false) => { memory.selected[view] = c.id; navigate(`/support/${c.id}`, { state: { reply } }) }
  // Selecting a row from inside the list takes focus with it, so the focused row is always the one a key acts on.
  const select = (id: string) => {
    setSelectedId(id)
    if (document.activeElement?.closest('.sinbox-table')) requestAnimationFrame(() => document.querySelector<HTMLElement>('.sinbox-table [data-selected="true"] .ui-row-link')?.focus({ preventScroll: true }))
  }
  const move = (step: number) => {
    const next = rows[index + step]
    if (next) select(next.id)
    if (step > 0 && index + step >= rows.length - 3 && list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage()
  }
  useShortcuts({
    j: () => move(1), k: () => move(-1), Enter: () => selected && open(selected), o: () => selected && open(selected), r: () => selected && canAct && open(selected, true),
    // e acts on the row on screen when it is pressed; with nothing to mark it only moves on.
    e: () => {
      if (!selected) return
      if (!canAct || !selected.needsYou) { move(1); return }
      const target = selected, after = rows[index + 1] ?? rows[index - 1]
      if (view === 'needs_you' && after) select(after.id)
      void actions.done(target)
    },
    h: () => { if (selected && canAct && selected.agentState === 'paused' && selected.status !== 'closed') setConfirming({ action: 'resume', conversation: selected }) },
    u: () => selected && void actions.read(selected, selected.unread), '?': () => setKeysOpen(true),
  }, Boolean(role))
  if (!role) return <StaffOnly />
  if (!list.data && !list.isError) return <SupportInboxSkeleton view={view} channel={channel} />
  const columns: Column<SupportConversation>[] = [
    { ...def('customer'), render: c => <Who c={c} /> },
    { ...def('subject'), render: c => <Subject c={c} /> },
    { ...def('status'), render: c => { const s = triageOf(c); return <StatusBadge status={s.text} tone={s.tone} /> }, cardRender: c => triageOf(c).text },
    { ...def('ticket'), render: c => <span className="sinbox-cell">{ticketText(c) ?? '—'}</span>, cardRender: c => c.ticket && !c.ticket.resolvedAt ? c.ticket.severity ?? 'Ticket' : null },
    { ...def('agent'), render: c => { const a = agentOf(c); return <StatusDot tone={a.tone} note={a.by}>{a.text}</StatusDot> }, cardRender: c => `Agent ${agentOf(c).text.toLowerCase()}` },
    { ...def('activity'), render: c => <time className="nowrap" dateTime={lastActivity(c)} title={when(lastActivity(c))}>{ago(lastActivity(c))}</time> },
    { ...def('actions'), render: c => <DropdownMenu label="Conversation actions" title={titleOf(c)} items={menuItems(c, { canAct, actions, onConfirm: setConfirming, open: () => open(c) })} /> },
  ]
  const empty = q || channel ? <EmptyState title="No conversation matches" action={<Button onClick={() => { setSearch(''); setChannel('') }}>Clear filters</Button>} />
    : <EmptyState title={view === 'needs_you' ? 'Nothing needs you' : view === 'agent' ? 'The agent has no open conversations' : 'No support conversations yet'} />
  return <>
    <PageHeader title="Support" />
    <div className="sinbox-page">
      <InboxTabs view={view} counts={counts} onChange={next => setParams(previous => { const params = new URLSearchParams(previous); if (next === 'needs_you') params.delete('view'); else params.set('view', next); return params }, { replace: true })} />
      <InboxToolbar search={search} onSearch={setSearch} channel={channel} onChannel={setChannel} onShortcuts={() => setKeysOpen(true)} />
      {list.isError && !list.data ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : <InboxBody rows={rows} everyChannel={channel ? everyChannel.data && flatten(everyChannel.data.pages) : rows} channel={channel} setChannel={setChannel}>
        <DataTable className="sinbox-table" rows={rows} rowKey={c => c.id} columns={columns} selectedId={phone ? undefined : selected?.id} empty={empty}
          rowHref={c => `/support/${c.id}`} rowLabel={titleOf} onRowIntent={c => void prefetchConversation(client, c.id)} onRowFocus={phone ? undefined : c => setSelectedId(c.id)} />
        {list.hasNextPage && <Button className="sinbox-more" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Load more</Button>}
      </InboxBody>}
    </div>
    <ConfirmAction confirming={confirming} onClose={() => setConfirming(null)} actions={actions} />
    <ShortcutsDialog open={keysOpen} onClose={() => setKeysOpen(false)} />
  </>
}

// ---------------------------------------------------------------- one conversation

/** The conversations around this one, in the list it was opened from. One that left the list (marked done, answered) keeps its place, so j and k still go on from it. */
function useNeighbors(id: string, rows: SupportConversation[]) {
  const order = useRef<string[]>([])
  const ids = rows.map(c => c.id)
  if (ids.length) {
    const at = order.current.indexOf(id)
    if (ids.includes(id) || at < 0) order.current = ids
    else { const before = order.current.slice(0, at).filter(other => ids.includes(other)); order.current = [...before, id, ...ids.filter(other => !before.includes(other))] }
  }
  const at = order.current.indexOf(id)
  return { next: at >= 0 ? order.current[at + 1] : undefined, previous: at > 0 ? order.current[at - 1] : undefined }
}

export function SupportConversationPage() {
  const role = useRole(), canAct = role === 'operator'
  const id = useParams().id ?? '', valid = CONVERSATION.test(id)
  const client = useQueryClient(), navigate = useNavigate(), location = useLocation(), phone = usePhone()
  const detail = useQuery({ ...detailQuery(id), enabled: Boolean(role && valid), refetchInterval: query => query.state.status === 'error' ? false : 30_000 })
  const list = useInfiniteQuery({ ...listQuery(memory.list.view, memory.list.q, memory.list.channel), enabled: Boolean(role), staleTime: 5_000 })
  const rows = flatten(list.data?.pages)
  const { next, previous } = useNeighbors(id, rows)
  const conversation = detail.data?.conversation ?? rows.find(c => c.id === id) ?? (valid ? cached(client, id) : undefined)
  const actions = useInboxActions()
  const [confirming, setConfirming] = useState<Confirming | null>(null), [keysOpen, setKeysOpen] = useState(false), [sheet, setSheet] = useState(false)
  const composer = useRef<ComposerHandle>(null)
  // The conversations either side are read ahead, so j and k open them at once.
  useEffect(() => { if (!detail.data) return; for (const other of [next, previous]) if (other) void prefetchConversation(client, other) }, [Boolean(detail.data), next, previous])
  // Shown is read: through the messages on screen, so one arriving later is still new. Once per transcript length, so
  // marking it unread here (u) stays unread.
  const unread = detail.data?.conversation.unread, seen = detail.data?.conversation.messageCount, marked = useRef('')
  useEffect(() => {
    if (!unread || !detail.data || marked.current === `${id}:${seen}`) return
    marked.current = `${id}:${seen}`
    void actions.read(detail.data.conversation, true, seen)
  }, [id, unread, seen])
  const wantsReply = (location.state as { reply?: boolean } | null)?.reply === true
  useEffect(() => { if (wantsReply && detail.data) composer.current?.focus() }, [Boolean(detail.data), wantsReply])
  const go = (to: string | undefined) => { if (to) navigate(`/support/${to}`, { replace: true }) }
  const back = () => { if (location.key !== 'default') navigate(-1); else navigate(listPath()) }
  // Done (e, the button, the menu's Mark done): marks this conversation done if it needs you, then opens the next one, or
  // goes back to the list after the last.
  const finish = () => {
    if (!conversation) return
    const after = next ?? previous
    if (canAct && conversation.needsYou) void actions.done(conversation)
    if (after) go(after); else back()
  }
  // The customer sheet belongs to the conversation it was opened on: another one (from its own links) closes it.
  useEffect(() => { setSheet(false) }, [id])
  useShortcuts({
    j: () => go(next), k: () => go(previous), Escape: back, r: () => composer.current?.focus(), '?': () => setKeysOpen(true), e: finish,
    h: () => { if (conversation && canAct && conversation.agentState === 'paused' && conversation.status !== 'closed') setConfirming({ action: 'resume', conversation }) },
    u: () => conversation && void actions.read(conversation, conversation.unread, conversation.unread ? conversation.messageCount : undefined),
  }, Boolean(role && valid))
  if (!role) return <StaffOnly />
  if (!valid) return <EmptyState headingAs="h1" title="Page not found" action={<Link to="/support">Return to support</Link>} />
  if (!conversation) return detail.isError ? <div className="sinbox-conversation-page"><PageHeader backTo="/support" title="Conversation" /><ErrorState error={detail.error} onRetry={() => void detail.refetch()} /></div> : <SupportConversationSkeleton panel={!phone} />
  const menu = <DropdownMenu label="Conversation actions" title={titleOf(conversation)} trigger={phone ? undefined : <ActionsTrigger />} items={menuItems(conversation, { canAct, actions, onConfirm: setConfirming, onDone: finish })} />
  const marks = canAct && conversation.needsYou !== null
  return <div className="sinbox-conversation-page">
    <PageHeader backTo="/support" title={<span className="sinbox-title" title={titleOf(conversation)}>{titleOf(conversation)}</span>} subtitle={<Facts c={conversation} />}
      actions={<ConversationActions panel={!phone} customer={detail.data ? () => setSheet(true) : undefined} menu={menu}
        done={{ onClick: finish, title: `${marks ? 'Mark done and open' : 'Open'} ${next ?? previous ? 'the next conversation' : 'the list'} (e)` }} />} />
    {detail.data ? <div className="sinbox-conversation">
      <Transcript key={id} detail={detail.data} canAct={canAct} actions={actions} composer={composer} />
      {!phone && <aside className="sinbox-panel" aria-label="Customer"><CustomerPanel detail={detail.data} /></aside>}
    </div> : detail.isError ? <ErrorState error={detail.error} onRetry={() => void detail.refetch()} /> : <ConversationBodySkeleton panel={!phone} />}
    {phone && detail.data && <Dialog open={sheet} onOpenChange={setSheet} title="Customer" className="sinbox-sheet"><CustomerPanel detail={detail.data} /></Dialog>}
    <ConfirmAction confirming={confirming} onClose={() => setConfirming(null)} actions={actions} />
    <ShortcutsDialog open={keysOpen} onClose={() => setKeysOpen(false)} />
  </div>
}

// The facts line under the title, in mono: the channel, why it is here (dot and word) and the agent.
function Facts({ c }: { c: SupportConversation }) {
  const status = triageOf(c), agent = agentOf(c)
  return <p className="sinbox-subtitle"><span className="sinbox-fact"><ChannelIcon channel={c.channel} />{c.channel === 'email' ? 'Email' : 'Chat'}</span>
    <span className="sinbox-fact"><StatusBadge status={status.text} tone={status.tone} /></span><span className="sinbox-fact"><span className="sinbox-fact__key">Agent</span>{agent.text.toLowerCase()}{agent.by ? ` by ${agent.by}` : ''}</span></p>
}

const deliveryBadge: Record<string, { text: string; tone: Tone } | undefined> = { queued: { text: 'Queued', tone: 'warning' }, failed: { text: 'Not sent', tone: 'danger' }, held: { text: 'Held', tone: 'neutral' } }
function Message({ m, c }: { m: SupportMessage; c: SupportDetail['conversation'] }) {
  const author = m.author === 'customer' ? c.customer?.name ?? 'Customer' : m.author === 'agent' ? 'Agent' : m.author === 'staff' ? m.staff?.name ?? 'Staff' : 'System'
  const badge = m.delivery ? deliveryBadge[m.delivery] : undefined
  return <li className="sinbox-message" data-author={m.author} data-pending={m.id.startsWith('pending:') || undefined}>
    <div className="sinbox-message__meta"><span className="sinbox-message__author">{author}</span>{m.author === 'staff' && <span className="sinbox-message__role">Staff</span>}{badge && <StatusBadge status={badge.text} tone={badge.tone} />}
      <time className="sinbox-message__time" dateTime={m.at}>{when(m.at)}</time></div>
    {m.author === 'agent' ? <div className="sinbox-text"><Markdown text={m.text} /></div> : <div className="sinbox-message__body">{m.text}</div>}
    {m.tools.length > 0 && <ul className="sinbox-tools" aria-label="What the agent checked">{m.tools.map((tool, index) => <li key={index}>{tool.ok ? <Check size={12} aria-label="Done" /> : <X size={12} aria-label="Failed" />}{tool.label}</li>)}</ul>}
  </li>
}
// A conversation opens at its newest message: a long transcript scrolls to its end (Back keeps where it was).
function useOpenAtEnd() {
  const navigation = useNavigationType()
  useEffect(() => {
    if (navigation === 'POP') return
    const main = document.getElementById('main-content'), scroller = main && main.scrollHeight > main.clientHeight ? main : document.scrollingElement
    if (scroller && scroller.scrollHeight > scroller.clientHeight) scroller.scrollTop = scroller.scrollHeight
  }, [])
}
function Transcript({ detail, canAct, actions, composer }: { detail: SupportDetail; canAct: boolean; actions: Actions; composer: RefObject<ComposerHandle | null> }) {
  useOpenAtEnd()
  return <div className="sinbox-transcript">
    {detail.earlierMessages > 0 && <p className="sinbox-earlier">{number(detail.earlierMessages)} earlier {detail.earlierMessages === 1 ? 'message isn’t' : 'messages aren’t'} shown.</p>}
    {detail.messages.length ? <ol className="sinbox-messages">{detail.messages.map(m => <Message key={m.id} m={m} c={detail.conversation} />)}</ol>
      : <EmptyState title="No messages yet" />}
    {canAct && <Composer ref={composer} detail={detail} actions={actions} />}
  </div>
}

type ComposerHandle = { focus: () => void }
// The staff reply. While the agent is handling the conversation it waits behind Take over (r), or, when the agent is
// blocked, behind Retry now; sending pauses the agent. What is typed, and a reply that failed with why, stay with the
// conversation until sent or discarded, wherever staff go meanwhile.
const Composer = forwardRef<ComposerHandle, { detail: SupportDetail; actions: Actions }>(function Composer({ detail, actions }, ref) {
  const c = detail.conversation, user = useSession()?.identity?.id ?? ''
  const draft = useSyncExternalStore(subscribeInboxDrafts, () => inboxDraft(user, c.id)), text = draft?.text ?? ''
  const [taken, setTaken] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const take = () => { setTaken(true); requestAnimationFrame(() => field.current?.focus()) }
  useImperativeHandle(ref, () => ({ focus: take }), [])
  if (c.status === 'closed') return null
  const handling = c.agentState === 'active'
  if (handling && !taken && !text && !draft?.failed) {
    const blocked = c.blockedWork > 0
    return <div className="sinbox-composer sinbox-composer--idle" data-blocked={blocked || undefined}>
      <span>{blocked ? 'The agent is blocked: its work here is waiting.' : 'The agent is handling this.'}</span>
      <span className="cluster">{blocked && <Button onClick={() => void actions.wake(c)}>Retry now</Button>}<Button onClick={take}>Take over</Button></span>
    </div>
  }
  function send(event?: FormEvent) {
    event?.preventDefault()
    const reply = text.trim()
    if (!reply || !detail.replyAvailable || !draft) return
    const sent = { text: reply, key: draft.key }
    updateInboxDraft(user, c.id, () => ({ text: '', key: crypto.randomUUID(), failed: null, sending: sent }))
    // Sent: the keys are the inbox's again (e marks it done, j moves on).
    field.current?.blur()
    // A failure puts the reply back in this conversation's box (before anything typed since), with its own key.
    actions.reply(c, reply, sent.key).then(() => updateInboxDraft(user, c.id, () => ({ sending: null })),
      error => updateInboxDraft(user, c.id, now => ({ sending: null, failed: error instanceof ApiError ? error.message : failedText,
        ...now.text ? { text: `${sent.text}\n\n${now.text}`, key: crypto.randomUUID() } : { text: sent.text, key: sent.key } })))
  }
  return <form className="sinbox-composer" data-filled={text ? true : undefined} data-unavailable={detail.replyAvailable ? undefined : true} onSubmit={send}>
    <Textarea ref={field} aria-label="Reply" placeholder={`Reply to ${c.customer?.name ?? 'the customer'}`} value={text} maxLength={8000} disabled={!detail.replyAvailable}
      onChange={event => { const value = event.target.value; updateInboxDraft(user, c.id, () => ({ text: value, key: crypto.randomUUID() })) }}
      onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send() } else if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.blur() } }} />
    <div className="sinbox-composer__actions">
      {draft?.failed ? <span className="sinbox-composer__failed" role="alert">Not sent: {draft.failed}</span>
        : <span className="sinbox-composer__hint">{!detail.replyAvailable ? 'The support service is offline, so replies are off.' : handling ? 'Sending pauses the agent.' : ''}</span>}
      <span className="cluster sinbox-composer__buttons">{draft?.failed && <Button variant="ghost" onClick={() => updateInboxDraft(user, c.id, () => null)}>Discard</Button>}
        <Button type="submit" variant="primary" disabled={!text.trim() || !detail.replyAvailable}>Send reply</Button></span></div>
  </form>
})

// ---------------------------------------------------------------- the customer panel

const verification: Record<SupportConversation['verification'], string> = { handoff: 'Signed in (chat)', dmarc: 'Email passed DMARC', signin: 'Signed in to claim it', none: 'Not verified' }
const mode: Record<SupportConversation['mode'], string> = { member: 'Member', non_member: 'No workspace', pending_signin: 'Waiting for sign-in', unverified: 'Unverified' }
// The customer panel (Signal Log): each section a small caps label with its rule over muted keys and mono values, or a short list.
const Label = ({ children }: { children: ReactNode }) => <h3 className="ui-label ui-label--rule">{children}</h3>
const None = ({ children }: { children: ReactNode }) => <p className="sinbox-none">{children}</p>
function CustomerPanel({ detail }: { detail: SupportDetail }) {
  const { conversation: c, customer } = detail, user = customer.user, evidence = c.evidence
  const others = customer.conversations
  const facts: [string, ReactNode][] = [
    ...c.workspace ? [['Workspace', c.workspace.name] as [string, ReactNode]] : [],
    ...c.page ? [['Opened from', c.page] as [string, ReactNode]] : [],
    ...evidence.dmarc ? [['DMARC', `${evidence.dmarc}${evidence.dkimAligned === null ? '' : evidence.dkimAligned ? ' · DKIM aligned' : ' · DKIM not aligned'}`] as [string, ReactNode]] : [],
    ['Ticket', c.ticket ? <span className="sinbox-ticket"><span>{ticketText(c)}</span><span className="sinbox-faint">{c.ticket.id}</span></span> : 'None'],
    ['Agent', `${number(c.turns)} ${c.turns === 1 ? 'turn' : 'turns'} · $${c.costUsd.toFixed(2)}`],
    ['Started', when(c.createdAt)],
  ]
  return <div className="sinbox-panel__body">
    <section><Label>Account</Label>
      <KeyValues className="sinbox-kv" items={user ? [
        ['Name', user.name ?? '—'],
        ['Email', user.email ? <span className="sinbox-address"><PrivateAddress value={user.email} />{user.emailVerified ? <StatusBadge status="Verified" tone="success" /> : <StatusBadge status="Unverified" tone="warning" />}</span> : '—'],
        ['Proof', verification[c.verification]], ['Access', mode[c.mode]], ['Signed up', when(user.createdAt)],
      ] : [['Sender', c.sender ? <span className="sinbox-address"><PrivateAddress value={c.sender} /></span> : '—'], ['Proof', verification[c.verification]], ['Access', 'No account linked']]} />
    </section>
    <section><Label>Conversation</Label><KeyValues className="sinbox-kv" items={facts} /></section>
    {user && <section><Label>Workspaces</Label>
      {customer.workspaces.length ? <ul className="sinbox-list">{customer.workspaces.map(w => <li key={w.id}>
        <Link to={`/operator/workspaces/${encodeURIComponent(w.id)}`} className="sinbox-list__main">{w.name}</Link>
        <span className="sinbox-list__meta">{[w.role, w.standing && w.standing !== 'ok' ? w.standing : null, w.sending?.paused ? 'paused' : null, w.inScope ? 'in scope' : null].filter(Boolean).join(' · ')}</span>
      </li>)}</ul> : <None>No workspaces</None>}
    </section>}
    {user && <section><Label>Notes</Label>
      {customer.notes.length ? <ul className="sinbox-notes">{customer.notes.map(n => <li key={n.id}><p>{n.text}</p><span className="sinbox-list__meta">{n.author} · {when(n.createdAt)}</span></li>)}</ul> : <None>No notes</None>}
    </section>}
    <section><Label>Other conversations</Label>
      {others.length ? <ul className="sinbox-list">{others.map(o => <li key={o.id}>
        <Link to={`/support/${o.id}`} className="sinbox-list__main">{o.subject ?? (o.channel === 'email' ? 'Email' : 'Chat')}</Link>
        <span className="sinbox-list__meta">{[o.status, o.ticket?.severity, ago(o.lastMessageAt ?? o.createdAt)].filter(Boolean).join(' · ')}</span>
      </li>)}</ul> : <None>No other conversations</None>}
    </section>
    {user && <section><Label>Recent activity</Label>
      {customer.activity.length ? <ul className="sinbox-list">{customer.activity.slice(0, 10).map(e => <li key={e.id}>
        <span className="sinbox-list__main">{label(e.action.replace(/[._]/g, ' '))}</span><time className="sinbox-list__meta" dateTime={e.at} title={when(e.at)}>{ago(e.at)}</time>
      </li>)}</ul> : <None>No activity yet</None>}
    </section>}
  </div>
}
