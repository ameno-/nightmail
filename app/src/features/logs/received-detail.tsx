import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { Download, Paperclip } from 'lucide-react'
import { useApiDef, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import type { ReceivedEmailDetail } from '../../data/types'
import { Alert, Button, CopyButton, ErrorState, Identifier, PageHeader, Sheet, Tooltip, type Fact, type Tone } from '../../components/ui'
import { useEmailDocument } from '../../components/EmailPreview'
import { EmailViews, type InsightSource } from '../../components/EmailInsight'
import { AddressList, PrivateAddress, Sender } from '../../components/PrivateAddress'
import { mentionsRemoteImage } from '../../lib/html-scan'
import { fileSize, label, shortDateTime } from '../../lib/format'
import { EmailBar, EmailDetailSkeleton, EmailFactsStrip } from './skeletons'
import { useDetailLayout } from './detail-layout'
import { ThreadChip, ThreadRows, ThreadTimeline, threaded, threadItems, useThreadPrefetch } from './thread'
import { StatusCue, StatusLine, Subject, shortWhen } from './email-detail'

// A received message, in the same layout as a sent email (email-detail.tsx, detail-layout.ts), so the two read alike: on a
// desktop the 44px bar (back, the kind, the subject, Received or Spam and the ID), one 36px strip of facts, then the
// message on its matte with the same view switcher, beside a 320px column with its thread, its checks (SPF, DKIM, DMARC,
// spam and virus), the details a sent email has no use for (Cc, Reply-To, Message-ID) and its attachments. Between 900
// and 1200 px that column opens from the preview's toolbar; a phone reads the message first and opens the rest in sheets.
// Only what the data holds differs: no delivery, no client previews (they answer how a client shows mail you send), and
// the message's remote images wait for Load images so its sender can't tell when it was opened (L14).
// Delivery details (envelope, region, verdicts, headers, the raw .eml) are for owners and admins; members read the message.

export function ReceivedEmailDetailPage() {
  const { id = '' } = useParams()
  const { canAdminister } = useWorkspaceAccess()
  // Moving to another message of its thread keeps this one up until that one arrives, as a sent email does.
  const query = useApiDef(queries.receivedEmail(id, canAdminister), { keepPrevious: true })
  if (query.isPending) return <EmailDetailSkeleton kind="received" />
  if (query.isError) return <><PageHeader title="Received email" backTo="/logs" /><ErrorState error={query.error} onRetry={() => query.refetch()} /></>
  return <ReceivedEmail key={query.data.id} email={query.data} focus={id} />
}

const checkTone = (value?: string): Tone => value === 'PASS' ? 'success' : value === 'FAIL' ? 'danger' : value === 'GRAY' ? 'warning' : 'neutral'
// NONE is a sender without the record to check, not a failure, and GRAY is a check that didn't run: the verdict says so.
const verdictLabel = (value: string) => value.toUpperCase() === 'NONE' ? 'No record' : value.toUpperCase() === 'GRAY' ? 'Not checked' : label(value.toLowerCase())
const checkName = { spf: 'SPF', dkim: 'DKIM', dmarc: 'DMARC', spam: 'Spam', virus: 'Virus' } as const
const more = (count: number) => count > 0 && <span className="muted"> +{count} more</span>

// Who it was for. To is the envelope when the API has it; a receiving address links to its inbox at this message. When
// every recipient is one of the receiving addresses, an Address fact would only repeat them (routed).
function recipientsOf(email: ReceivedEmailDetail) {
  const envelope = Boolean(email.envelopeTo?.length)
  const to = envelope ? email.envelopeTo! : email.to.map(item => item.address)
  const extra = envelope ? Math.max(0, (email.envelopeToCount ?? to.length) - to.length) : Math.max(0, (email.toCount ?? email.to.length) - email.to.length)
  const inbox = (address: string) => email.addresses?.find(mailbox => mailbox.address.toLowerCase() === address.toLowerCase())
  const routed = Boolean(email.addresses?.length) && extra === 0 && to.every(address => inbox(address))
  return { to, extra, inbox, routed }
}
const inboxHref = (email: ReceivedEmailDetail, addressId: string) => '/receiving/inbox?address=' + encodeURIComponent(addressId) + '&thread=' + encodeURIComponent(email.threadId) + '&message=' + encodeURIComponent(email.id)
function Recipients({ email }: { email: ReceivedEmailDetail }) {
  const { to, extra, inbox } = recipientsOf(email)
  return <span>{to.map((address, index) => { const mailbox = inbox(address); return <Fragment key={index + ':' + address}>{index > 0 && ', '}{mailbox ? <Link className="email-facts__contact" to={inboxHref(email, mailbox.id)}><PrivateAddress value={address} /></Link> : <PrivateAddress value={address} />}</Fragment> })}{more(extra)}</span>
}
function Mailboxes({ email }: { email: ReceivedEmailDetail }) {
  return <>{email.addresses?.length ? email.addresses.map((mailbox, index) => <Fragment key={mailbox.id}>{index > 0 && ', '}<Link to={inboxHref(email, mailbox.id)}><PrivateAddress value={mailbox.address} /></Link></Fragment>) : 'Unrouted'}</>
}
const isSpam = (email: ReceivedEmailDetail) => Boolean(email.spam) || email.status === 'spam'

function ReceivedEmail({ email, focus }: { email: ReceivedEmailDetail; focus: string }) {
  const { mode } = useDetailLayout()
  const { multiTenant, canAdminister } = useWorkspaceAccess()
  const [panel, setPanel] = useState(false)
  // A phone or tablet opens the facts and checks, and the thread, in sheets; each returns focus to its opener.
  const [sheet, setSheet] = useState<'details' | 'thread' | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const openSheet = (which: 'details' | 'thread') => (from: HTMLElement) => { opener.current = from; setSheet(which) }
  const thread = threaded(email.thread) ? email.thread : null
  const items = threadItems(thread, focus)
  const open = { warm: useThreadPrefetch(items), onNavigate: () => setSheet(null) }
  const panelId = useId()
  const panelRef = useRef<HTMLElement>(null)
  useEffect(() => { if (panel) panelRef.current?.focus() }, [panel])
  // Markup past the API's parsing budget isn't parsed here either: the message shows as its plain text.
  const html = email.htmlTooComplex ? '' : email.html ?? ''
  const hasHtml = html.trim().length > 0
  // Inline images reference attachments by Content-ID: the preview swaps in the signed link only for an exact
  // img[src="cid:…"] after sanitizing, never by text replacement in sender-controlled HTML (L15).
  const inlineImages = useMemo(() => Object.fromEntries(email.attachments.flatMap(file => file.contentId && file.url ? [[file.contentId, file.url]] : [])), [email.attachments])
  const [imagesFor, setImagesFor] = useState<string | null>(null)
  const remote = useMemo(() => mentionsRemoteImage(html), [html]), loadImages = imagesFor === html
  const original = useEmailDocument({ html, inlineImages, remoteImages: loadImages, respectStyles: true, asSent: true, dark: true })
  const source = useMemo<InsightSource>(() => ({ kind: 'email', id: email.id, html: hasHtml }), [email.id, hasHtml])
  const headers = canAdminister && email.headers ? email.headers.map(header => header.name + ': ' + header.value).join('\n') : undefined
  const images = remote && !loadImages && <Tooltip content="Remote images are hidden so the sender can’t tell when you open this message.">
    <Button variant="ghost" size="sm" onClick={() => setImagesFor(html)}>Load images</Button>
  </Tooltip>
  const compact = mode === 'stack'
  const spam = isSpam(email)
  const subject = email.subject || '(no subject)'
  const close = () => { setPanel(false); document.querySelector<HTMLElement>('[aria-controls="' + panelId + '"]')?.focus() }
  const notices = <>
    {spam && <Alert tone="warning">Marked as spam or a virus.</Alert>}
    {email.htmlTooComplex && <Alert tone="info">This message’s formatting is too complex to show, so it shows as plain text.</Alert>}
    {email.bodyTruncated && <Alert tone="info">Part of this message was too large to store. Download the original for the full content.</Alert>}
  </>
  const noticed = spam || email.htmlTooComplex || email.bodyTruncated
  const side = <ReceivedSide email={email} />
  return <div className="email-detail" data-mode={mode}>
    {compact ? <PageHeader title={<Subject text={subject} />} backTo="/logs" subtitle={<StatusLine tone={spam ? 'danger' : 'success'} onOpen={openSheet('details')} chip={thread && <ThreadChip count={thread.count} onOpen={openSheet('thread')} />}>{spam ? 'Spam' : 'Received'} <time dateTime={email.receivedAt}>{shortWhen(email.receivedAt)}</time></StatusLine>} />
      : <><EmailBar kind="received" title={subject} end={<><StatusCue tone={spam ? 'danger' : 'success'}>{spam ? 'Spam' : 'Received'}</StatusCue>{email.rawUrl && <a className="ui-button ui-button--ghost ui-button--sm email-bar__download" href={email.rawUrl}><Download size={14} aria-hidden="true" />Download .eml</a>}<Identifier value={email.id} copyLabel="Copy message ID" /></>} /><ReceivedFacts email={email} /></>}
    {noticed && <div className="email-detail__notices">{notices}</div>}
    <div className="email-detail__body">
      <section className="email-detail__preview" aria-label="Preview">
        {thread && mode === 'panel' && <ThreadRows items={items} part="before" open={open} />}
        <EmailViews source={source} previewSource={null} original={{ doc: original.complete ? original.doc : null, dark: original.darkDoc === undefined ? undefined : original.complete ? original.darkDoc : null, error: original.error, html, text: email.text, headers }}
          fill={!compact} wide={!compact} compact={compact}
          toolbarEnd={<>{images}{mode === 'panel' && <button type="button" className="ev-details" aria-expanded={panel} aria-controls={panelId} onClick={() => setPanel(!panel)}>Details</button>}</>} />
        {thread && mode === 'panel' && <ThreadRows items={items} part="after" open={open} />}
        {compact && email.attachments.length > 0 && <Attachments email={email} />}
      </section>
      {mode === 'column' && <aside className="email-detail__side ui-scroll-fade" aria-label="Details">
        {thread && <ThreadTimeline thread={thread} items={items} open={open} />}
        {side}
      </aside>}
      {/* Its toggle, on the toolbar's row, heads it: the panel starts at the preview's top. */}
      {mode === 'panel' && <aside ref={panelRef} id={panelId} className="email-detail__side ui-scroll-fade" aria-label="Details" tabIndex={-1} hidden={!panel} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}>{side}</aside>}
    </div>
    {compact && <>
      <Sheet open={sheet === 'details'} onOpenChange={open => setSheet(open ? 'details' : null)} title="Details" className="email-detail-sheet" returnFocus={opener}>
        <Checks email={email} />
        <FactList email={email} multiTenant={multiTenant} />
        {email.rawUrl && <a className="ui-button ui-button--secondary ui-button--md email-detail-sheet__download" href={email.rawUrl}><Download size={16} aria-hidden="true" />Download .eml</a>}
      </Sheet>
      {thread && <Sheet open={sheet === 'thread'} onOpenChange={open => setSheet(open ? 'thread' : null)} title={'Thread · ' + thread.count} className="email-detail-sheet" returnFocus={opener}>
        <ThreadTimeline thread={thread} items={items} open={open} titled={false} />
      </Sheet>}
    </>}
  </div>
}

// A desktop's facts under the bar (EmailDetailSkeleton draws the same strip): from whom and to whom over the preview,
// then over the details column when it arrived and the region (the ID is in the bar).
function ReceivedFacts({ email }: { email: ReceivedEmailDetail }) {
  const { multiTenant } = useWorkspaceAccess()
  const facts: Record<string, Omit<Fact, 'label'>> = {
    From: { value: <Sender name={email.from.name} address={email.from.address} /> },
    To: { value: <Recipients email={email} /> },
    Received: { value: <time dateTime={email.receivedAt}>{shortDateTime(email.receivedAt)} UTC</time>, mono: true },
    Region: { value: email.region ?? '—', mono: true },
  }
  return <EmailFactsStrip kind="received" multiTenant={multiTenant} label="Email details" fact={name => facts[name]!} />
}

// The checks the receiving side ran, a row each with its verdict, as a sent email's delivery lists its steps.
function Checks({ email, titled = true }: { email: ReceivedEmailDetail; titled?: boolean }) {
  const id = useId()
  const verdicts = email.verdicts ?? {}
  const keys = (['spf', 'dkim', 'dmarc', 'spam', 'virus'] as const).filter(key => verdicts[key])
  if (!keys.length) return null
  return <section className="email-detail__section" aria-labelledby={titled ? id : undefined} aria-label={titled ? undefined : 'Checks'}>
    {titled && <h2 id={id} className="ss__title">Checks</h2>}
    <ul className="received-checks">{keys.map(key => { const value = String(verdicts[key]); return <li key={key}>
      <span className={'delivery__dot ui-tone--' + checkTone(value.toUpperCase())} aria-hidden="true" /><span>{checkName[key]}</span><span className="received-checks__verdict">{verdictLabel(value)}</span>
    </li> })}</ul>
  </section>
}

// What a sent email has no use for: where it was routed (when To doesn't already say), when its sender dated it, Cc,
// Reply-To, its size and its Message-ID.
function detailRows(email: ReceivedEmailDetail): [string, ReactNode][] {
  const { routed } = recipientsOf(email)
  return [
    ...email.addresses && !routed ? [['Address', <Mailboxes email={email} />] as [string, ReactNode]] : [],
    ...email.sentAt ? [['Sent', <time dateTime={email.sentAt}>{shortDateTime(email.sentAt)} UTC</time>] as [string, ReactNode]] : [],
    ...email.cc.length ? [['Cc', <><AddressList values={email.cc.map(cc => cc.address)} />{more(Math.max(0, (email.ccCount ?? email.cc.length) - email.cc.length))}</>] as [string, ReactNode]] : [],
    ...email.replyTo.length ? [['Reply-To', <><AddressList values={email.replyTo.map(item => item.address)} />{more(Math.max(0, (email.replyToCount ?? email.replyTo.length) - email.replyTo.length))}</>] as [string, ReactNode]] : [],
    ...email.sizeBytes != null ? [['Size', fileSize(email.sizeBytes)] as [string, ReactNode]] : [],
    ...email.messageId ? [['Message-ID', <span className="received-facts__id"><code className="identifier" title={email.messageId}>{email.messageId}</code><CopyButton value={email.messageId} label="Copy Message-ID header" /></span>] as [string, ReactNode]] : [],
  ]
}
function Details({ email }: { email: ReceivedEmailDetail }) {
  const id = useId()
  const rows = detailRows(email)
  if (!rows.length) return null
  return <section className="email-detail__section" aria-labelledby={id}><h2 id={id} className="ss__title">Details</h2>
    <dl className="received-facts">{rows.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
  </section>
}
function Attachments({ email }: { email: ReceivedEmailDetail }) {
  const id = useId()
  return <section className="email-detail__section received-attachments-section" aria-labelledby={id}><h2 id={id} className="ss__title">Attachments</h2>
    <ul className="received-attachments">{email.attachments.map(file => <li key={file.id}>
      <Paperclip size={14} aria-hidden="true" />{file.url ? <a href={file.url} target="_blank" rel="noreferrer">{file.filename}</a> : <span>{file.filename}</span>}<span className="muted">{fileSize(file.size)}{file.disposition === 'inline' ? ' · inline' : ''}</span>
    </li>)}</ul>
  </section>
}
/** The details column (or the panel it opens as): checks, details and attachments. */
function ReceivedSide({ email }: { email: ReceivedEmailDetail }) {
  return <><Checks email={email} /><Details email={email} />{email.attachments.length > 0 && <Attachments email={email} />}</>
}

// A phone's facts, in the Details sheet under the checks: who, from whom, when, the rest of the details and the ID.
function FactList({ email, multiTenant }: { email: ReceivedEmailDetail; multiTenant: boolean }) {
  return <dl className="email-fact-list">
    <div><dt>From</dt><dd><Sender name={email.from.name} address={email.from.address} /></dd></div>
    <div><dt>To</dt><dd><Recipients email={email} /></dd></div>
    <div><dt>Received</dt><dd><time dateTime={email.receivedAt}>{shortDateTime(email.receivedAt)} UTC</time></dd></div>
    {detailRows(email).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
    {!multiTenant && email.region && <div><dt>Region</dt><dd>{email.region}</dd></div>}
    <div><dt>ID</dt><dd className="email-fact-list__id"><code className="identifier">{email.id}</code><CopyButton value={email.id} label="Copy message ID" /></dd></div>
  </dl>
}
