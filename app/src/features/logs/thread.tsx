import { useEffect, useId, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ChevronRight, Paperclip, Reply } from 'lucide-react'
import type { EmailThread, MailAddress } from '../../data/types'
import { Sender } from '../../components/PrivateAddress'
import { useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { usePrefetchQueries } from '../../data/prefetch'
import { date, label } from '../../lib/format'
import { isReceivedId } from './rows'

// An email's conversation, from its detail read (thread in getEmailDetail and getInboundMessage). Beside the preview it
// is the details column's first section, a message per step, oldest first, with this one marked; a phone opens it in a
// sheet from the status line. Between 900 and 1200 px a sent email gives the preview the width and has no column, so
// the other messages sit as one-line rows above and under it (ThreadRows). Each opens at /logs/<id>; the messages next
// to this one are read ahead, and any other on hover or touch, so moving through the conversation draws at once.

export type ThreadItem = { key: string; id: string; href: string; outbound: boolean; from: MailAddress; at: string; status: string; attachments: number; focused: boolean }
// A sent message opens as the sent email (its delivery and score); a received one as the received message.
export function threadItems(thread: EmailThread | null | undefined, focus: string): ThreadItem[] {
  if (!thread) return []
  return thread.messages.map(message => {
    const id = message.direction === 'outbound' && message.emailId ? message.emailId : message.id
    return { key: message.id, id, href: `/logs/${encodeURIComponent(id)}`, outbound: message.direction === 'outbound', from: message.from, at: message.at, status: message.direction === 'outbound' ? message.status : 'received', attachments: message.attachmentCount, focused: id === focus || message.id === focus }
  })
}
/** A conversation worth showing: this email and at least one other message. */
export const threaded = (thread: EmailThread | null | undefined): thread is EmailThread => !!thread && thread.count > 1

// The messages either side of this one are read once it shows; warm(item) reads another one about to open.
export function useThreadPrefetch(items: ThreadItem[]) {
  const prefetch = usePrefetchQueries()
  const { canAdminister } = useWorkspaceAccess()
  const read = (list: ThreadItem[]) => void prefetch(list.map(item => isReceivedId(item.id) ? queries.receivedEmail(item.id, canAdminister) : queries.email(item.id)))
  const at = items.findIndex(item => item.focused)
  const near = [items[at - 1], items[at + 1]].filter((item): item is ThreadItem => !!item).map(item => item.id).join()
  useEffect(() => { if (near) read(items.filter(item => near.split(',').includes(item.id))) }, [near]) // eslint-disable-line react-hooks/exhaustive-deps
  return (item: ThreadItem) => { if (!item.focused) read([item]) }
}

const when = (at: string) => date(at, at.slice(0, 10) === new Date().toISOString().slice(0, 10) ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' })
const Direction = ({ outbound }: { outbound: boolean }) => <span className="log-direction" data-direction={outbound ? 'sent' : 'received'}>{outbound ? 'Out' : 'In'}</span>
const Who = ({ item }: { item: ThreadItem }) => <bdi className="thread__who"><Sender name={item.from.name} address={item.from.address} nameOnly /></bdi>
const Time = ({ at }: { at: string }) => <time className="thread__time" dateTime={at} title={`${date(at)} UTC`}>{when(at)}</time>
const Clip = ({ count }: { count: number }) => count > 0 ? <Paperclip className="thread__clip" size={12} aria-label={`${count} attachment${count === 1 ? '' : 's'}`} /> : null
type Open = { warm: (item: ThreadItem) => void; onNavigate?: () => void }
// The message on screen is not a link: it is the page.
function Entry({ item, className, open, children }: { item: ThreadItem; className: string; open: Open; children: ReactNode }) {
  return item.focused ? <span className={className} aria-current="page" data-focused>{children}</span>
    : <Link className={className} to={item.href} onPointerEnter={() => open.warm(item)} onFocus={() => open.warm(item)} onTouchStart={() => open.warm(item)} onClick={open.onNavigate}>{children}</Link>
}

/** The conversation as a column of steps, each with its sender, time and status; titled "Thread N" beside the preview. */
export function ThreadTimeline({ thread, items, open, titled = true }: { thread: EmailThread; items: ThreadItem[]; open: Open; titled?: boolean }) {
  const title = useId()
  return <section className="thread-line" aria-label={titled ? undefined : 'Thread'} aria-labelledby={titled ? title : undefined}>
    {titled && <h2 id={title} className="ss__title thread-line__title">Thread <span className="thread__count">{thread.count}</span></h2>}
    <ol className="thread-line__steps">
      {items.map(item => <li key={item.key} className="thread-line__step">
        <Entry item={item} className="thread-line__entry" open={open}>
          <span className="thread-line__dot" data-outbound={item.outbound || undefined} aria-hidden="true" />
          <span className="thread-line__top"><Direction outbound={item.outbound} /><Who item={item} /><Clip count={item.attachments} /></span>
          <Time at={item.at} />
          <span className="thread-line__status">{label(item.status)}{item.focused && <span className="thread-line__here">Viewing</span>}</span>
        </Entry>
      </li>)}
    </ol>
  </section>
}
/** A phone's way in: one control on the status line with the message count, opening the thread in a sheet. */
export function ThreadChip({ count, onOpen }: { count: number; onOpen: (opener: HTMLElement) => void }) {
  return <button type="button" className="thread-chip" aria-haspopup="dialog" onClick={event => onOpen(event.currentTarget)}><Reply size={14} aria-hidden="true" /><span>{count}<span className="sr-only"> messages in this thread</span></span><ChevronRight size={14} aria-hidden="true" /></button>
}

/** Without a details column: the messages before this one as rows above the preview, the ones after it under the preview. */
export function ThreadRows({ items, part, open }: { items: ThreadItem[]; part: 'before' | 'after'; open: Open }) {
  const [unfolded, setUnfolded] = useState(false)
  const at = items.findIndex(item => item.focused)
  const list = part === 'before' ? items.slice(0, Math.max(0, at)) : items.slice(at + 1)
  if (!list.length) return null
  // A long conversation keeps its first message and the one just before this, with the rest behind one row.
  const folded = part === 'before' && list.length > 3 && !unfolded
  const rows: (ThreadItem | number)[] = folded ? [list[0]!, list.length - 2, list[list.length - 1]!] : list
  return <ol className="thread-rows" data-part={part} aria-label={part === 'before' ? 'Earlier in this thread' : 'Later in this thread'}>
    {rows.map(row => typeof row === 'number'
      ? <li key="more"><button type="button" className="thread-rows__row thread-rows__more" onClick={() => setUnfolded(true)}>{row} earlier</button></li>
      : <li key={row.key}><Entry item={row} className="thread-rows__row" open={open}><Direction outbound={row.outbound} /><Who item={row} /><span className="thread-rows__status">{label(row.status)}</span><Clip count={row.attachments} /><Time at={row.at} /></Entry></li>)}
  </ol>
}
