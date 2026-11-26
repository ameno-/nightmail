import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode, type RefObject } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Bot, Check, ChevronRight, Clock, Hand, Image as ImageIcon, Lock, Paperclip, X } from 'lucide-react'
import { Button, Dialog, DropdownMenu, EmptyState, ErrorState, KeyValues, StatusBadge, Textarea, useToast } from '../../components/ui'
import { useKeyboardInset } from '../../components/ui/sheet'
import { PrivateAddress } from '../../components/PrivateAddress'
import { ReceivedEmailPreview } from '../../components/EmailPreview'
import { productName } from '../../../../api/src/brand'
import { useSession } from '../../data/context'
import { ApiError } from '../../data/types'
import { channelLabels, detailQuery, inboxDraft, inboxKeys, listQuery, prefetchConversation, subscribeInboxDrafts, supportInboxApi, updateInboxDraft, type Channel, type HeldReason, type SupportBrief, type SupportConversation, type SupportDetail, type SupportEmail, type SupportEvent, type SupportMessage } from '../../data/support-inbox'
import { ago, label, number, shortDateTime } from '../../lib/format'
import { useTouch } from '../../lib/media'
import { StaffOnly } from '../operator/skeletons'
import { Markdown } from '../support/markdown'
import { cached, CONVERSATION, ConfirmAction, failedText, flatten, freshOnly, isSendKey, listPath, memory, menuItems, ShortcutsDialog, titleOf, useInboxActions, useRole, useShortcuts, when, type Actions, type Confirming } from './actions'
import { ConversationHeader, ThreadSkeleton, triageOf, whoOf } from './skeletons'
import './conversation.css'

// One support conversation (/support/:id), as a chat: one column, the newest message at the bottom and the reply box
// docked under it, always in view (above the tab bar and the keyboard on a phone). The customer's words are bubbles;
// ours (the agent's and staff's) are plain text under a small mark and name; a note or the agent's held answer is a card.
// Events are quiet centred lines, days are separated, and a message's time sits beside its name. The customer's details
// and the agent's summary are behind Details (a panel from the right, a sheet on a phone).

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
  const client = useQueryClient(), navigate = useNavigate(), location = useLocation()
  const detail = useQuery({ ...detailQuery(id), enabled: Boolean(role && valid), refetchInterval: query => query.state.status === 'error' ? false : 30_000 })
  const list = useInfiniteQuery({ ...listQuery(memory.list.view, memory.list.q, memory.list.channel), enabled: Boolean(role), staleTime: 5_000 })
  const rows = flatten(list.data?.pages)
  const { next, previous } = useNeighbors(id, rows)
  const conversation = detail.data?.conversation ?? rows.find(c => c.id === id) ?? (valid ? cached(client, id) : undefined)
  const actions = useInboxActions()
  const [confirming, setConfirming] = useState<Confirming | null>(null), [keysOpen, setKeysOpen] = useState(false), [details, setDetails] = useState(false)
  const composer = useRef<ComposerHandle>(null)
  // On a phone the page ends where the keyboard begins, so the reply box rises with it.
  useKeyboardInset()
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
  useEffect(() => { if (wantsReply && detail.data) composer.current?.focus('reply') }, [Boolean(detail.data), wantsReply])
  const go = (to: string | undefined) => { if (to) navigate(`/support/${to}`, { replace: true }) }
  const back = () => { if (location.key !== 'default') navigate(-1); else navigate(listPath()) }
  // Done (e, the button): marks this conversation done if it needs you, then opens the next one, or goes back to the
  // list after the last.
  const finish = () => {
    if (!conversation) return
    const after = next ?? previous
    if (canAct && conversation.needsYou) void actions.done(conversation)
    if (after) go(after); else back()
  }
  // Details belong to the conversation they were opened on: another one closes them.
  useEffect(() => { setDetails(false) }, [id])
  useShortcuts({
    j: () => go(next), k: () => go(previous), Escape: back, r: () => composer.current?.focus('reply'), n: () => composer.current?.focus('note'), '?': () => setKeysOpen(true), e: finish,
    h: () => { if (conversation && canAct && conversation.agentState === 'paused' && conversation.status !== 'closed') setConfirming({ action: 'resume', conversation }) },
    u: () => conversation && void actions.read(conversation, conversation.unread, conversation.unread ? conversation.messageCount : undefined),
  }, Boolean(role && valid))
  if (!role) return <StaffOnly />
  if (!valid) return <EmptyState headingAs="h1" title="Page not found" action={<Link to="/support">Return to support</Link>} />
  const status = conversation && triageOf(conversation)
  const marks = canAct && conversation?.needsYou != null
  return <div className="sinbox-chat">
    <ConversationHeader who={conversation && whoOf(conversation)} status={status && <StatusBadge status={status.text} tone={status.tone} />}
      onDetails={detail.data ? () => setDetails(true) : undefined}
      done={conversation ? { onClick: finish, title: `${marks ? 'Mark done and open' : 'Open'} ${next ?? previous ? 'the next conversation' : 'the list'} (e)` } : undefined}
      menu={conversation && <DropdownMenu label="Conversation actions" title={titleOf(conversation)} items={menuItems(conversation, { canAct, actions, onConfirm: setConfirming, done: false })} />} />
    {detail.data ? <Thread key={id} detail={detail.data} canAct={canAct} actions={actions} composer={composer} onConfirm={setConfirming} />
      : detail.isError ? <div className="sinbox-chat__scroll"><div className="sinbox-chat__column sinbox-chat__thread"><ErrorState error={detail.error} onRetry={() => void detail.refetch()} /></div></div>
      : <ThreadSkeleton />}
    {detail.data && <Dialog open={details} onOpenChange={setDetails} title="Details" size="lg" className="sinbox-details">
      {detail.data.brief && <div className="sinbox-details__brief"><AiSummary brief={detail.data.brief} subject={titleOf(detail.data.conversation)} /></div>}
      <CustomerPanel detail={detail.data} />
    </Dialog>}
    <ConfirmAction confirming={confirming} onClose={() => setConfirming(null)} actions={actions} />
    <ApprovalPrompt conversationId={id} canAct={canAct} />
    <ShortcutsDialog open={keysOpen} onClose={() => setKeysOpen(false)} />
  </div>
}

/**
 * A decision a staff email linked to (?approval=…&token=…, api/src/support-approvals.ts), ready to confirm. Opening the
 * link did nothing: only Approve here (the operator role) runs it. Not now leaves it waiting; Decline closes it.
 */
function ApprovalPrompt({ conversationId, canAct }: { conversationId: string; canAct: boolean }) {
  const [params, setParams] = useSearchParams(), approvalId = params.get('approval'), token = params.get('token')
  const client = useQueryClient(), toast = useToast(), key = useRef(crypto.randomUUID()), [busy, setBusy] = useState<'approve' | 'decline' | null>(null)
  const linked = Boolean(approvalId && token)
  const approval = useQuery({ queryKey: ['support-inbox', 'approval', conversationId, approvalId], queryFn: ({ signal }) => supportInboxApi.approval(conversationId, approvalId!, token!, signal), enabled: linked, retry: false, staleTime: Infinity })
  const close = () => setParams(previous => { const next = new URLSearchParams(previous); next.delete('approval'); next.delete('token'); return next }, { replace: true })
  useEffect(() => { if (linked && approval.isError) { toast('That approval link isn’t valid any more. The conversation is open as it is.', 'error'); close() } }, [linked, approval.isError])
  const a = approval.data
  if (!linked || !a) return null
  async function decide(decision: 'approve' | 'decline') {
    setBusy(decision)
    try {
      const decided = await supportInboxApi.decideApproval(conversationId, a!.id, token!, decision, key.current)
      const why = typeof decided.result?.message === 'string' ? decided.result.message : 'Try it from the conversation.'
      toast(decided.state === 'approved' ? `Done: ${decided.label.toLowerCase()}.` : decided.state === 'failed' ? `${decided.label} didn’t go through. ${why}` : 'Declined.', decided.state === 'failed' ? 'error' : 'success')
      void client.invalidateQueries({ queryKey: inboxKeys.detail(conversationId) })
      close()
    } catch (error) { toast(error instanceof ApiError ? error.message : failedText, 'error') }
    finally { setBusy(null) }
  }
  const waiting = a.state === 'proposed', by = a.decidedBy?.name ?? 'Staff', blocked = waiting ? a.preview?.blocked ?? null : null
  const status = a.state === 'expired' ? 'Expired. Act on it from the conversation if it still needs doing.'
    : a.state === 'approved' ? `${by} approved it${a.decidedAt ? ` ${shortDateTime(a.decidedAt)}` : ''}.` : a.state === 'declined' ? `${by} declined it.` : a.state === 'failed' ? `${by} approved it, and it failed.` : null
  return <Dialog open onOpenChange={open => { if (!open && !busy) close() }} title={a.label} description={a.effect}
    footer={waiting && canAct ? <><Button variant="ghost" disabled={busy !== null} loading={busy === 'decline'} onClick={() => void decide('decline')}>Decline</Button>
      <Button disabled={busy !== null} onClick={close}>Not now</Button><Button variant="primary" disabled={busy !== null || blocked !== null} loading={busy === 'approve'} onClick={() => void decide('approve')}>Approve</Button></>
      : <Button onClick={close}>Close</Button>}>
    {/* Why: for a held answer, why it was held as stored now ("Held by the output check"), above what would go; the reason it was proposed with once it is gone. */}
    <KeyValues items={[...(a.summary ? [['What', a.summary]] as [string, string][] : []), ...(waiting && a.change ? [['Now', a.change.now], ['After', a.change.after]] as [string, string][] : []), ['Why', waiting && a.preview?.held ? a.preview.held : a.reason], ['Proposed by', a.proposedBy === 'agent' ? 'The support agent' : `${productName}, in the email to staff`],
      [waiting ? 'Expires' : 'State', status ?? shortDateTime(a.expiresAt)], ...(!canAct && waiting ? [['Who can approve', 'Staff with the operator role']] as [string, string][] : [])]} />
    {waiting && a.preview?.text && <blockquote className="sinbox-approval__preview" aria-label="What would be sent">{a.preview.text}</blockquote>}
    {blocked && <p className="sinbox-approval__blocked" role="status">{blocked}</p>}
  </Dialog>
}


// ---------------------------------------------------------------- the thread

/** Who wrote a message, as the chat shows them: the customer's words, the agent's or staff's, a note (staff's, or the
 *  triage agent's on an agent report), or the agent's held answer, a draft until someone decides. */
type Role = 'customer' | 'agent' | 'staff' | 'note' | 'draft'
type ChatMessage = { type: 'message'; key: string; m: SupportMessage; role: Role; author: string; via: string | null; first: boolean; last: boolean }
type ChatRow = { type: 'day'; key: string; label: string } | { type: 'event'; key: string; at: string; text: string; kind: string } | ChatMessage

const day = (iso: string) => new Date(iso).toISOString().slice(0, 10)
const dayFormat = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
const dayFormatYear = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
function dayLabel(iso: string, now = Date.now()) {
  const d = day(iso)
  if (d === day(new Date(now).toISOString())) return 'Today'
  if (d === day(new Date(now - 86_400_000).toISOString())) return 'Yesterday'
  return (new Date(iso).getUTCFullYear() === new Date(now).getUTCFullYear() ? dayFormat : dayFormatYear).format(new Date(iso))
}
const clockFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })
const Time = ({ at }: { at: string }) => <time className="sinbox-chat__time" dateTime={at} title={when(at)}>{clockFormat.format(new Date(at))}</time>
const initials = (name: string) => name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('') || '?'
/** Our sender's mark: the agent's bot, a person's initials. */
const Mark = ({ name, agent }: { name: string; agent: boolean }) => <span className="sinbox-mark" data-agent={agent || undefined} aria-hidden="true">{agent ? <Bot size={12} /> : initials(name)}</span>

export function describe(m: SupportMessage, c: SupportConversation) {
  const note = m.kind === 'note' && (m.author === 'staff' || m.author === 'agent')
  const author = m.author === 'customer' ? c.customer?.name ?? m.email?.from.name ?? (c.channel === 'agent_feedback' ? 'Agent’s report' : 'Customer') : m.author === 'agent' ? note ? 'Triage agent' : 'Nightmail AI' : m.staff?.name ?? m.emailFrom ?? 'Staff'
  const role: Role = note ? 'note' : held(m) ? 'draft' : m.author === 'customer' ? 'customer' : m.author === 'agent' ? 'agent' : 'staff'
  const via = note ? (m.emailFrom ? 'Note by email' : null) : m.author === 'customer' ? (m.email ? 'Email' : c.channel === 'agent_feedback' ? channelLabels[c.channel] : null) : null
  return { author, role, via }
}
const GROUP_MS = 10 * 60_000
/**
 * The conversation as chat rows, oldest first, by time (an event before a message written in the same moment: a
 * take-over comes before the reply that made it): a day separator where the day changes, events as lines, and each run
 * of messages from one sender (within ten minutes, nothing between them) marked first and last; a draft and an email
 * stand alone. Events eventText leaves out are not shown.
 */
function chatRows(detail: SupportDetail): ChatRow[] {
  const c = detail.conversation, rows: ChatRow[] = []
  const events = detail.events.flatMap(event => { const text = eventText(event); return text === null ? [] : [{ event, text }] })
  const entries = [
    ...events.map(({ event, text }, order) => ({ key: event.id, at: event.at, event, text, message: undefined, rank: event.kind === 'closed' ? 2 : 0, order })),
    ...detail.messages.map(message => ({ key: message.id, at: message.at, event: undefined, text: '', message, rank: 1, order: message.seq })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.rank - b.rank || a.order - b.order)
  let lastDay = '', previous: ChatMessage | null = null
  for (const entry of entries) {
    if (day(entry.at) !== lastDay) { lastDay = day(entry.at); rows.push({ type: 'day', key: `day:${lastDay}`, label: dayLabel(entry.at) }); previous = null }
    if (entry.event) { rows.push({ type: 'event', key: entry.key, at: entry.at, text: entry.text, kind: entry.event.kind }); previous = null; continue }
    const m = entry.message!
    // The support platform's own notices (a fixed reply, an agent report's notice) are a line, like an event.
    if (m.author === 'system') { rows.push({ type: 'event', key: entry.key, at: entry.at, text: m.text, kind: 'system' }); previous = null; continue }
    const { author, role, via } = describe(m, c)
    const row: ChatMessage = { type: 'message', key: entry.key, m, role, author, via, first: true, last: true }
    if (previous && previous.author === author && previous.role === role && role !== 'draft' && !m.email && !previous.m.email && Date.parse(m.at) - Date.parse(previous.m.at) < GROUP_MS) { previous.last = false; row.first = false }
    rows.push(row)
    previous = row
  }
  return rows
}

/**
 * The thread's scroller: it opens at the newest message, and while it is at the bottom it stays there (a message
 * arriving, the reply box growing, the keyboard opening). Scrolled up to read, nothing moves. Staff's own reply or note
 * scrolls down to it. The scroll event a pin itself causes arrives a frame later, after the box may have grown again, so
 * it never counts as scrolling away.
 */
function useStickToBottom(scroller: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>, count: number, mine: boolean) {
  const atBottom = useRef(true), pinned = useRef(-1)
  const pin = () => { const el = scroller.current; if (!el) return; el.scrollTop = el.scrollHeight; pinned.current = el.scrollTop; atBottom.current = true }
  useLayoutEffect(pin, [])
  useEffect(() => {
    const el = scroller.current, inner = content.current
    if (!el || !inner) return
    const onScroll = () => { atBottom.current = el.scrollTop === pinned.current || el.scrollHeight - el.scrollTop - el.clientHeight < 32 }
    el.addEventListener('scroll', onScroll, { passive: true })
    const observer = new ResizeObserver(() => { if (atBottom.current) pin() })
    observer.observe(el); observer.observe(inner)
    return () => { el.removeEventListener('scroll', onScroll); observer.disconnect() }
  }, [])
  useLayoutEffect(() => { if (atBottom.current || mine) pin() }, [count])
}

function Thread({ detail, canAct, actions, composer, onConfirm }: { detail: SupportDetail; canAct: boolean; actions: Actions; composer: RefObject<ComposerHandle | null>; onConfirm: (confirming: Confirming) => void }) {
  const c = detail.conversation, user = useSession()?.identity?.id ?? ''
  const scroller = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null)
  const rows = chatRows(detail), last = rows.at(-1)
  useStickToBottom(scroller, content, rows.length, last?.type === 'message' && last.m.id.startsWith('pending:'))
  // Edit and send: the held answer goes into the reply box, marked as that draft, so sending it decides the draft.
  // A fresh reply starts from an empty box: nothing of the held answer is carried over.
  const edit = (m: SupportMessage, fresh: boolean) => { updateInboxDraft(user, c.id, () => ({ text: fresh ? '' : m.text.trim(), key: crypto.randomUUID(), mode: 'reply', draftOf: m.id, failed: null })); composer.current?.focus('reply') }
  const facts = [channelLabels[c.channel], c.ticket && [c.ticket.severity, c.ticket.type && c.ticket.type !== 'agent_feedback' ? label(c.ticket.type) : null].filter(Boolean).join(' '), `started ${shortDateTime(c.createdAt)}`].filter(Boolean).join(' · ')
  return <>
    <div className="sinbox-chat__scroll" ref={scroller}>
      <div className="sinbox-chat__column sinbox-chat__thread" ref={content}>
        <div className="sinbox-chat__intro">{c.subject && c.channel !== 'agent_feedback' && <p className="sinbox-chat__subject">{c.subject}</p>}<p className="sinbox-chat__facts">{facts}</p></div>
        {detail.earlierMessages > 0 && <p className="sinbox-chat__event">{number(detail.earlierMessages)} earlier {detail.earlierMessages === 1 ? 'message isn’t' : 'messages aren’t'} shown.</p>}
        {rows.map(row => row.type === 'day' ? <p key={row.key} className="sinbox-chat__day">{row.label}</p>
          : row.type === 'event' ? <p key={row.key} className="sinbox-chat__event" data-kind={row.kind}><span>{row.text} · <Time at={row.at} /></span></p>
          : <Message key={row.key} row={row} c={c} canAct={canAct} actions={actions} onEdit={edit} />)}
        {!rows.some(row => row.type === 'message') && <p className="sinbox-chat__empty">No messages yet</p>}
      </div>
    </div>
    <footer className="sinbox-chat__dock sinbox-chat__column">
      <DockStatus c={c} canAct={canAct} actions={actions} onConfirm={onConfirm} />
      {canAct && <Composer ref={composer} detail={detail} actions={actions} />}
    </footer>
  </>
}

/** One message. The customer's in a bubble; ours as text under the mark; a note or a held answer as a card. Delivery
 *  shows only when it isn't plain: Queued while a reply waits to go, Not sent when it failed. */
function Message({ row, c, canAct, actions, onEdit }: { row: ChatMessage; c: SupportConversation; canAct: boolean; actions: Actions; onEdit: (m: SupportMessage, fresh: boolean) => void }) {
  const { m, role } = row, customer = role === 'customer', pending = m.id.startsWith('pending:')
  const queued = m.author === 'staff' && m.kind !== 'note' && (m.delivery === 'queued' || pending)
  return <div className="sinbox-msg" data-role={role} data-first={row.first || undefined} data-last={row.last || undefined} data-email={m.email ? '' : undefined} data-pending={pending || undefined}>
    {row.first && <p className="sinbox-msg__meta">
      {!customer && <Mark name={row.author} agent={m.author === 'agent'} />}
      <span className="sinbox-msg__author">{row.author}</span>
      {m.email && <span className="sinbox-msg__from"><PrivateAddress value={m.email.from.address} /></span>}
      {row.via && <span>{row.via}</span>}
      {role === 'note' && <span className="sinbox-msg__note"><Lock size={12} aria-hidden="true" />Internal note · only staff see it</span>}
      <Time at={m.at} />
    </p>}
    {customer ? <div className="sinbox-msg__bubble sinbox-raised"><Body m={m} c={c} /></div>
      : role === 'draft' ? <div className="sinbox-msg__card sinbox-raised" data-draft=""><DraftLabel m={m} /><Body m={m} c={c} /><DraftFoot m={m} c={c} canAct={canAct} actions={actions} onEdit={onEdit} /></div>
      : role === 'note' ? <div className="sinbox-msg__card sinbox-raised"><Body m={m} c={c} /></div>
      : <div className="sinbox-msg__prose"><Body m={m} c={c} /></div>}
    {(m.tools.length > 0 || m.delivery === 'failed' || queued) && <div className="sinbox-msg__below">
      {m.tools.length > 0 && <ul className="sinbox-tools" aria-label="What the agent checked">{m.tools.map((tool, index) => <li key={index}>{tool.ok ? <Check size={12} aria-label="Done" /> : <X size={12} aria-label="Failed" />}{tool.label}</li>)}</ul>}
      {m.delivery === 'failed' ? <span className="sinbox-delivery" data-state="failed"><AlertCircle size={12} aria-hidden="true" />Not sent</span>
        : queued && <span className="sinbox-delivery"><Clock size={12} aria-hidden="true" />Queued</span>}
    </div>}
  </div>
}
/** What a message says: a customer email as it arrived, the agent's Markdown, or the words as written, then its screenshots. */
function Body({ m, c }: { m: SupportMessage; c: SupportConversation }) {
  return <>
    {m.email ? <EmailBody conversationId={c.id} email={m.email} subject={c.subject} />
      : m.author === 'agent' && m.kind !== 'note' ? <div className="sinbox-text"><Markdown text={m.text} /></div> : <div className="sinbox-plain">{m.text}</div>}
    {m.files.length > 0 && !m.email && <Files conversationId={c.id} files={m.files} />}
  </>
}
const DraftLabel = ({ m }: { m: SupportMessage }) => <p className="sinbox-draft__label" data-decided={m.draft ? '' : undefined}><span aria-hidden="true" />{m.draft ? (m.draft.outcome === 'discarded' ? 'Draft, discarded' : 'Draft, sent by staff') : 'Draft, not sent'}</p>
function DraftFoot({ m, c, canAct, actions, onEdit }: { m: SupportMessage; c: SupportConversation; canAct: boolean; actions: Actions; onEdit: (m: SupportMessage, fresh: boolean) => void }) {
  return <>
    {!m.draft && <p className="sinbox-held">{m.heldReason ? freshOnly[m.heldReason] ?? heldWhy[m.heldReason] : 'Not sent.'}</p>}
    {m.draft && <p className="sinbox-held">{decidedText[m.draft.outcome]} {m.draft.by.name ?? 'staff'} · <time dateTime={m.draft.at} title={when(m.draft.at)}>{shortDateTime(m.draft.at)}</time></p>}
    {!m.draft && canAct && c.status !== 'closed' && !m.id.startsWith('pending:') && <DraftActions m={m} c={c} actions={actions} onEdit={onEdit} />}
  </>
}
const heldWhy: Record<HeldReason, string> = {
  paused: 'Not sent: staff took over after the agent wrote it.', gate: 'Not sent: the output check held it.', access: 'Not sent: the customer’s access changed before it went out.',
  closed: 'Not sent: the conversation ended first.', earlier: 'Not sent: an earlier version of the agent wrote it.',
}
const held = (m: SupportMessage) => m.author === 'agent' && (m.delivery === 'held' || m.kind === 'held')
const size = (bytes: number | null) => bytes === null ? '' : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

const decidedText = { sent: 'Sent as written by', edited: 'Edited and sent by', replaced: 'Replaced with a fresh reply by', discarded: 'Discarded by' }
/** A held answer's choices: send it as the agent wrote it, edit it in the reply box first, or discard it (in place, asked
 *  once more). One that can't be sent offers only a fresh reply, from an empty reply box, or discarding it. */
function DraftActions({ m, c, actions, onEdit }: { m: SupportMessage; c: SupportConversation; actions: Actions; onEdit: (m: SupportMessage, fresh: boolean) => void }) {
  const [confirming, setConfirming] = useState(false)
  const fresh = m.heldReason ? freshOnly[m.heldReason] : undefined
  return <div className="sinbox-draft" onKeyDown={event => { if (event.key === 'Escape' && confirming) { event.stopPropagation(); setConfirming(false) } }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setConfirming(false) }}>
    <span className="cluster sinbox-draft__actions">
      {fresh ? <Button size="sm" onClick={() => { setConfirming(false); onEdit(m, true) }}>Write a fresh reply</Button> : <>
        <Button size="sm" onClick={() => { setConfirming(false); void actions.sendDraft(c, m.id, undefined, crypto.randomUUID()).catch(() => {}) }}>Send as written</Button>
        <Button size="sm" onClick={() => { setConfirming(false); onEdit(m, false) }}>Edit and send</Button></>}
      <Button size="sm" variant={confirming ? 'danger' : 'ghost'} onClick={() => { if (!confirming) setConfirming(true); else { setConfirming(false); void actions.discardDraft(c, m.id) } }}>{confirming ? 'Discard it' : 'Discard'}</Button>
    </span>
    {confirming && <span className="sinbox-draft__warn" role="status">It’s never sent. The customer isn’t told.</span>}
  </div>
}

/** A customer email as it arrived: its reply first, the quoted history on request, its formatting (sandboxed, remote images off until asked) and the full text when it was longer, and its attachments. */
function EmailBody({ conversationId, email, subject }: { conversationId: string; email: SupportEmail; subject: string | null }) {
  const [quoted, setQuoted] = useState(false), [formatted, setFormatted] = useState(false), [full, setFull] = useState(false)
  const loaded = useQuery({ queryKey: [...inboxKeys.detail(conversationId), 'email', email.id], queryFn: ({ signal }) => supportInboxApi.email(conversationId, email.id, signal), enabled: formatted || full, staleTime: Infinity })
  const toast = useToast()
  const text = full && loaded.data ? loaded.data.text : email.text, reply = (full && loaded.data ? loaded.data.replyText : email.replyText).trim() || text
  const hasQuote = reply.trim() !== text.trim()
  const html = formatted ? loaded.data?.html ?? null : null
  async function open(attachmentId: string) {
    try { window.open((await supportInboxApi.emailAttachment(conversationId, email.id, attachmentId)).url, '_blank', 'noopener') }
    catch (error) { toast(error instanceof ApiError ? error.message : 'The attachment couldn’t be opened.', 'error') }
  }
  return <div className="sinbox-email">
    {email.subject && email.subject !== subject && <p className="sinbox-email__subject">{email.subject}</p>}
    {html ? <ReceivedEmailPreview html={html} tooComplex={loaded.data?.htmlTooComplex} title={`Email from ${email.from.name ?? email.from.address}`} className="sinbox-email__html" />
      : <div className="sinbox-plain">{(quoted ? text : reply) || <span className="sinbox-faint">(no text)</span>}</div>}
    {(hasQuote || email.hasHtml || email.textTruncated) && <div className="cluster sinbox-email__toggles">
      {hasQuote && !html && <Button variant="ghost" size="sm" onClick={() => setQuoted(value => !value)}>{quoted ? 'Hide quoted text' : 'Show quoted text'}</Button>}
      {email.hasHtml && <Button variant="ghost" size="sm" loading={formatted && loaded.isFetching && !loaded.data} onClick={() => setFormatted(value => !value)}>{formatted ? 'Show plain text' : 'Show formatted'}</Button>}
      {email.textTruncated && !(full && loaded.data) && <Button variant="ghost" size="sm" loading={full && loaded.isFetching} onClick={() => { setFull(true); setQuoted(true) }}>Show the full message</Button>}
    </div>}
    {email.attachments.length > 0 && <ul className="sinbox-files" aria-label="Attachments">{email.attachments.map(file => <li key={file.id}>
      <button type="button" disabled={!file.available} title={file.available ? `Open ${file.filename}` : 'Not scanned clean, so it can’t be opened'} onClick={() => void open(file.id)}>
        <Paperclip size={14} aria-hidden="true" /><span className="sinbox-files__name">{file.filename}</span><span className="sinbox-files__size">{size(file.size)}</span></button>
    </li>)}</ul>}
  </div>
}
/** A chat's screenshots: opened from the support service on request, never loaded into the page. */
function Files({ conversationId, files }: { conversationId: string; files: SupportMessage['files'] }) {
  const toast = useToast()
  async function open(attachmentId: string) {
    try { window.open((await supportInboxApi.file(conversationId, attachmentId)).url, '_blank', 'noopener') }
    catch (error) { toast(error instanceof ApiError ? error.message : 'The screenshot couldn’t be opened.', 'error') }
  }
  return <ul className="sinbox-files" aria-label="Screenshots">{files.map(file => <li key={file.id}>
    <button type="button" title={`Open ${file.name ?? 'the screenshot'}`} onClick={() => void open(file.id)}><ImageIcon size={14} aria-hidden="true" />
      <span className="sinbox-files__name">{file.name ?? 'Screenshot'}</span><span className="sinbox-files__size">{size(file.size)}</span></button>
  </li>)}</ul>
}

// What happened besides the messages, as one quiet line each.
/** A safe action the agent took on its own (api/src/support-actions.ts), in words, with what it acted on. */
const actionWords: Record<string, string> = { verify_domain: 'The agent re-checked DNS for', recheck_receiving_host: 'The agent re-checked the MX of', resend_forward: 'The agent resent the forward confirmation for' }
// Not shown (null): the opening (the first message says it) and a pause a staff reply made (the reply says it).
function eventText(e: SupportEvent): string | null {
  const who = e.by ? e.by.name ?? 'Staff' : null, d = e.details as Record<string, string | boolean | null | undefined>
  switch (e.kind) {
    case 'opened': return null
    case 'ticket': return d.by === 'nightmail' ? `Ticket opened: this needs a person${d.severity ? ` · ${d.severity}` : ''}` : `The agent filed a ticket${d.type ? ` · ${label(String(d.type))}` : ''}${d.severity ? ` · ${d.severity}` : ''}`
    case 'priority': return `Priority ${d.from ?? '—'} → ${d.to ?? '—'}`
    case 'paused': return d.by === 'ticket' ? 'Handed to you: the agent stopped for the ticket' : d.reply ? null : `${who ?? 'Staff'} paused the agent`
    case 'resumed': return `${who ?? 'Staff'} handed back to the agent`
    case 'resolved': return `${who ?? 'Staff'} resolved the ticket`
    case 'done': return `${who ?? 'Staff'} marked it done`
    case 'undone': return `${who ?? 'Staff'} undid Done`
    case 'closed': return 'Conversation closed'
    case 'approved': return d.failed ? `${who ?? 'Staff'} approved ${approvalWords(d)}, and it failed` : `${who ?? 'Staff'} approved ${approvalWords(d)}`
    case 'declined': return `${who ?? 'Staff'} declined ${approvalWords(d)}`
    case 'action': return `${actionWords[String(d.kind)] ?? 'The agent acted on'} ${d.host ?? d.domain ?? d.endpoint ?? 'its target'}`
    case 'proposed': return `The agent asked staff to approve: ${d.label ?? 'a change'}${d.summary ? ` · ${d.summary}` : ''}`
  }
}
const approvalWords = (d: Record<string, unknown>) => d.kind === 'retry_work' ? 'retrying the stuck work' : typeof d.label === 'string' ? `“${d.label}”` : 'a proposed action'

/** Over the reply box: what needs staff before they write. The agent's work stuck (Retry now), a customer who got no
 *  reply, and a paused agent with who paused it (Hand back). */
function DockStatus({ c, canAct, actions, onConfirm }: { c: SupportConversation; canAct: boolean; actions: Actions; onConfirm: (confirming: Confirming) => void }) {
  const feedback = c.channel === 'agent_feedback', open = c.status !== 'closed' && !feedback
  const blocked = !feedback && c.blockedWork > 0, noReply = c.needsYou?.reasons.includes('no_reply') ?? false, paused = open && c.agentState === 'paused'
  if (!blocked && !noReply && !paused) return null
  const by = c.pausedBy?.kind === 'ticket' ? ' for the ticket' : c.pausedBy?.name ? ` by ${c.pausedBy.name}` : ''
  return <div className="sinbox-chat__status">
    {blocked && <p data-tone="warning"><AlertCircle size={14} aria-hidden="true" /><span>The agent’s work here is stuck.</span>{canAct && <Button size="sm" variant="ghost" onClick={() => void actions.wake(c)}>Retry now</Button>}</p>}
    {noReply && <p data-tone="danger"><AlertCircle size={14} aria-hidden="true" /><span>No reply sent: the customer is still waiting for one.</span></p>}
    {paused && <p><Hand size={14} aria-hidden="true" /><span>Agent paused{by}.</span>{canAct && <Button size="sm" variant="ghost" onClick={() => onConfirm({ action: 'resume', conversation: c })}>Hand back</Button>}</p>}
  </div>
}

export type ComposerHandle = { focus: (mode?: ComposeMode) => void }
type ComposeMode = 'reply' | 'note'
// The staff reply, or an internal note, always ready: typing changes nothing; sending a reply pauses the agent if it is
// active, and says so. A note changes nothing for the customer or the agent, and says inside the box that it's one, so a
// key never sends a note as a reply. Enter sends (isSendKey: not on a touch keyboard, not mid-composition), never an
// empty box or while the last one is still sending. What is typed, and a reply that failed with why, stay with the
// conversation until sent or discarded, wherever staff go meanwhile. The box grows with what is typed, then scrolls.
const Composer = forwardRef<ComposerHandle, { detail: SupportDetail; actions: Actions }>(function Composer({ detail, actions }, ref) {
  const c = detail.conversation, identity = useSession()?.identity, user = identity?.id ?? ''
  const draft = useSyncExternalStore(subscribeInboxDrafts, () => inboxDraft(user, c.id)), text = draft?.text ?? ''
  // Closed, or agent feedback (api/src/feedback.ts, filed by an agent's credential): nobody to reply to, so notes only.
  const feedback = c.channel === 'agent_feedback', closed = c.status === 'closed' || feedback, mode: ComposeMode = closed ? 'note' : draft?.mode ?? 'reply'
  const field = useRef<HTMLTextAreaElement>(null), composing = useRef(false), touch = useTouch()
  const setMode = (next: ComposeMode) => updateInboxDraft(user, c.id, () => ({ mode: next }))
  const focus = (next: ComposeMode = 'reply') => { if (next !== mode && !closed) setMode(next); requestAnimationFrame(() => field.current?.focus()) }
  useImperativeHandle(ref, () => ({ focus }), [mode, closed])
  // The field is as tall as what is typed (the stylesheet caps it, then it scrolls).
  useLayoutEffect(() => { const el = field.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` }, [text])
  const handling = c.agentState === 'active'
  const note = mode === 'note', offline = !note && !detail.replyAvailable
  function send(event?: FormEvent) {
    event?.preventDefault()
    const body = text.trim()
    if (!body || offline || !draft || draft.sending) return
    const sent = { text: body, key: draft.key }
    updateInboxDraft(user, c.id, () => ({ text: '', key: crypto.randomUUID(), failed: null, sending: sent }))
    // Sent: the keys are the inbox's again (e marks it done, j moves on).
    field.current?.blur()
    // A failure puts the text back in this conversation's box (before anything typed since), with its own key.
    const draftOf = !note ? draft.draftOf ?? null : null
    if (draftOf) updateInboxDraft(user, c.id, () => ({ draftOf: null }))
    ;(note ? actions.note(c, body, sent.key) : draftOf ? actions.sendDraft(c, draftOf, body, sent.key) : actions.reply(c, body, sent.key)).then(() => updateInboxDraft(user, c.id, () => ({ sending: null })),
      error => updateInboxDraft(user, c.id, now => ({ sending: null, mode, draftOf, failed: error instanceof ApiError ? error.message : failedText,
        ...now.text ? { text: `${sent.text}\n\n${now.text}`, key: crypto.randomUUID() } : { text: sent.text, key: sent.key } })))
  }
  const name = c.customer?.name ?? 'the customer', me = identity?.name ?? 'you', target = detail.replyTarget
  const editing = !note && draft?.draftOf ? detail.messages.find(m => m.id === draft.draftOf && !m.draft) : undefined
  const hint = feedback ? 'An agent filed this report: there’s nobody to reply to. Mark it done when handled; notes are for staff.' : note ? 'Only staff see notes. The customer and the agent never do.'
    : offline ? 'The support service is offline, so replies are off.'
    : c.channel === 'email' ? <>Replying as {me} · an email in this thread{target.address ? <> to <PrivateAddress value={target.address} /></> : ''}, from {productName} support{!target.verified && '. Their email didn’t pass DMARC, so it may not be delivered'}{handling ? '. Sending pauses the agent.' : '.'}</>
    : <>Replying as {me} in their chat{target.address ? <> (emailed to <PrivateAddress value={target.address} /> if it’s closed)</> : ''}{handling ? '. Sending pauses the agent.' : '.'}</>
  return <form className="sinbox-composer" data-mode={mode} data-filled={text ? true : undefined} data-unavailable={offline || undefined} onSubmit={send}>
    <div className="sinbox-composer__box sinbox-raised">
      {note && <p className="sinbox-composer__note"><Lock size={12} aria-hidden="true" />Internal note · only staff see it</p>}
      {editing && <p className="sinbox-composer__editing">{editing.heldReason && freshOnly[editing.heldReason] ? 'A fresh reply instead of the agent’s held answer, which can’t be sent.' : 'Editing the agent’s held answer: sending it goes out as your reply.'} <button type="button" onClick={() => updateInboxDraft(user, c.id, () => ({ draftOf: null }))}>Keep it separate</button></p>}
      <Textarea ref={field} aria-label={note ? 'Internal note' : 'Reply'} placeholder={note ? 'Add an internal note' : `Reply to ${name}`} value={text} maxLength={8000} disabled={offline} rows={1}
        onChange={event => { const value = event.target.value; updateInboxDraft(user, c.id, () => ({ text: value, key: crypto.randomUUID(), mode })) }}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
        onKeyDown={event => { if (!composing.current && isSendKey(event, touch)) { event.preventDefault(); send() } else if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.blur() } }} />
      <div className="sinbox-composer__bar">
        {!closed && <div className="sinbox-composer__modes" role="group" aria-label="Write">
          <button type="button" aria-pressed={!note} onClick={() => focus('reply')}>Reply</button>
          <button type="button" aria-pressed={note} onClick={() => focus('note')}>Note</button>
        </div>}
        {!touch && <span className="sinbox-composer__keys">Enter to {note ? 'add' : 'send'}, Shift+Enter for a new line</span>}
        <span className="cluster sinbox-composer__buttons">{draft?.failed && <Button variant="ghost" onClick={() => updateInboxDraft(user, c.id, () => null)}>Discard</Button>}
          <Button type="submit" variant="primary" disabled={!text.trim() || offline || Boolean(draft?.sending)}>{note ? 'Add note' : 'Send reply'}</Button></span>
      </div>
    </div>
    {draft?.failed ? <p className="sinbox-composer__failed" role="alert">Not sent: {draft.failed}</p> : <p className="sinbox-composer__hint">{hint}</p>}
  </form>
})

// ---------------------------------------------------------------- details

/** The agent's ticket brief, folded: its own summary, in Details and never in place of the messages. */
function AiSummary({ brief, subject }: { brief: SupportBrief; subject: string }) {
  return <details className="sinbox-summary">
    <summary><Bot size={14} aria-hidden="true" /><span className="sinbox-summary__label">AI summary</span>{brief.title !== subject && <span className="sinbox-summary__title">{brief.title}</span>}<ChevronRight size={14} aria-hidden="true" className="sinbox-summary__chevron" /></summary>
    <dl className="sinbox-summary__body">
      <div><dt>Summary</dt><dd>{brief.summary}</dd></div>
      {brief.ask && <div><dt>What they asked</dt><dd>{brief.ask}</dd></div>}
      {brief.recommendation && <div><dt>Recommendation</dt><dd>{brief.recommendation}</dd></div>}
    </dl>
    <p className="sinbox-summary__note">Written by the agent when it filed the ticket. The conversation is what was actually said.</p>
  </details>
}


// A ticket Nightmail opened because the conversation needed a person (api/src/support-staff-mail.ts) is type staff.
const ticketText = (c: SupportConversation) => !c.ticket ? null : `${[c.ticket.severity, c.ticket.type && (c.ticket.type === 'staff' ? 'needs a person' : label(c.ticket.type))].filter(Boolean).join(' ') || 'Ticket'}${c.ticket.resolvedAt ? ' · resolved' : ''}`
/** One line for how the person was verified (keeps read-only and unverified states unmistakable without repeating Proof, Access and DMARC). */
function verifiedRow(c: SupportDetail['conversation'], hasUser: boolean): ReactNode {
  if (c.verification === 'none') return <StatusBadge status={c.mode === 'pending_signin' ? 'Waiting for sign-in' : 'Not verified'} tone="warning" />
  if (c.verification === 'handoff') return c.mode === 'non_member' ? 'Signed in (chat) · no workspace' : 'Signed in (chat)'
  if (c.verification === 'signin') return 'Signed in to claim · read only'
  if (c.verification === 'dmarc') {
    const dkim = c.evidence.dkimAligned === false ? ', DKIM unaligned' : ''
    return hasUser ? `Email (DMARC${dkim}) · read only` : `Email (DMARC${dkim}) · no account`
  }
  return 'Workspace credential'
}
// The customer panel (Signal Log): each section a small caps label with its rule over muted keys and mono values, or a short list.
const Label = ({ children }: { children: ReactNode }) => <h3 className="ui-label ui-label--rule">{children}</h3>
function CustomerPanel({ detail }: { detail: SupportDetail }) {
  const { conversation: c, customer } = detail, user = customer.user, evidence = c.evidence
  const others = customer.conversations
  const extra: [string, ReactNode][] = [
    ...c.ticket ? [['Ticket', <span title={c.ticket.id}>{ticketText(c)}</span>] as [string, ReactNode]] : [],
    ...c.page ? [['Opened from', c.page] as [string, ReactNode]] : [],
  ]
  const customerRows: [string, ReactNode][] = user ? [
    ...user.name ? [['Name', user.name] as [string, ReactNode]] : [],
    ...user.email ? [['Email', <span className="sinbox-address"><PrivateAddress value={user.email} />{!user.emailVerified && <StatusBadge status="Unverified" tone="warning" />}</span>] as [string, ReactNode]] : [],
    ['Verified', verifiedRow(c, true)],
    ...extra,
  ] : [
    ['Sender', c.sender ? <span className="sinbox-address"><PrivateAddress value={c.sender} /></span> : '—'],
    ['Verified', verifiedRow(c, false)],
    ...extra,
  ]
  return <div className="sinbox-panel__body">
    {c.channel === 'agent_feedback' ? <section><Label>Filed by</Label>
      <KeyValues className="sinbox-kv" items={[
        ['Workspace', c.workspace ? <Link to={`/operator/workspaces/${encodeURIComponent(c.workspace.id)}`} title={c.workspace.id}>{c.workspace.name}</Link> : '—'],
        ['Credential', evidence.filedBy ? <span title={evidence.credentialId ?? undefined}>{evidence.filedBy}</span> : '—'],
        ...extra,
      ]} />
    </section> : <section><Label>Customer</Label>
      <KeyValues className="sinbox-kv" items={customerRows} />
    </section>}
    {user && customer.workspaces.length > 0 && <section><Label>Workspaces</Label>
      <ul className="sinbox-list">{customer.workspaces.map(w => <li key={w.id}>
        <Link to={`/operator/workspaces/${encodeURIComponent(w.id)}`} className="sinbox-list__main">{w.name}</Link>
        <span className="sinbox-list__meta">{[w.role, w.standing && w.standing !== 'ok' ? w.standing : null, w.sending?.paused ? 'paused' : null, w.inScope ? 'in scope' : null].filter(Boolean).join(' · ')}</span>
      </li>)}</ul>
    </section>}
    {user && customer.notes.length > 0 && <section><Label>Notes</Label>
      <ul className="sinbox-notes">{customer.notes.map(n => <li key={n.id}><p>{n.text}</p><span className="sinbox-list__meta">{n.author} · {when(n.createdAt)}</span></li>)}</ul>
    </section>}
    {others.length > 0 && <section><Label>Other conversations</Label>
      <ul className="sinbox-list">{others.map(o => <li key={o.id}>
        <Link to={`/support/${o.id}`} className="sinbox-list__main">{o.subject ?? channelLabels[o.channel as Channel] ?? 'Chat'}</Link>
        <span className="sinbox-list__meta">{[o.status, o.ticket?.severity, ago(o.lastMessageAt ?? o.createdAt)].filter(Boolean).join(' · ')}</span>
      </li>)}</ul>
    </section>}
  </div>
}
