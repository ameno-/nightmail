import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useNavigate, useLocation } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, ChevronRight, CreditCard } from 'lucide-react'
import { Alert, Button, ConfirmDialog, ControlSkeleton, DataTable, Dialog, DropdownMenu, EmptyState, ErrorState, Input, Pagination, SectionHeader, Skeleton, StatusBadge, Switch, Tabs, useToast, type Column } from '../../components/ui'
import { useApiDef, useApiQuery, useSession } from '../../data/context'
import { queries } from '../../data/queries'
import { ApiError, errorText } from '../../data/types'
import { balanceState, billingApi, cardBrand, centsUsd, declineText, fullDay, monthDay, parseDollars, priceUc, total, usd, type AutoRechargeInput, type BillingSummary, type LedgerEntry, type Payment } from '../../data/billing'
import { useCursorPagination } from '../../lib/pagination'
import { date } from '../../lib/format'
import './billing.css'
import { productName } from '../../../../api/src/brand'
import { resourceOf } from '../../data/invalidation'

type RowProps = { title: ReactNode; error?: ReactNode; children: ReactNode }
const cardLabel = (card: { brand: string; last4: string }) => `${cardBrand(card.brand)}\u00a0••••\u00a0${card.last4}`
const final = (payment: Payment | undefined) => !!payment && !['created', 'pending', 'requires_action'].includes(payment.status)

/** Every billing read refreshes together after money moves, and the session's banner state with them. */
function useBillingRefresh() {
  const client = useQueryClient()
  return () => {
    void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'nightmail' && resourceOf(query.queryKey).startsWith('billing') })
    void client.invalidateQueries({ queryKey: ['identity'] })
  }
}

// Settings → Billing (owners and admins): the balance and Add credit first, then the card, auto-recharge and the
// history. How billing works and the balance's parts open from the balance; auto-recharge's amounts from its row; the
// free allowances and prices behind this month's usage from Plan & usage. Rows are 53px like every settings row and
// each value has a skeleton of its own width, so nothing moves as data arrives.
export function BillingSection({ row: Row }: { row: (props: RowProps) => ReactNode }) {
  const query = useApiDef(queries.billing())
  // The state comes with the session (GET /v1/me) on the first frame: which alerts show is decided from it, so the
  // balance arriving fills reserved space instead of inserting lines above the rows. The banner says what an empty
  // balance stops; the badge says where it stands.
  const state = useSession()?.identity?.billing
  const [adding, setAdding] = useState(false)
  const [about, setAbout] = useState(false)
  const b = query.data
  useCheckoutReturn()
  if (query.isError && !b) return <><SectionHeader title="Billing" /><ErrorState error={query.error} onRetry={() => void query.refetch()} /></>
  if (state?.free) return <FreePlan summary={b} Row={Row} />
  return <>
    <SectionHeader title="Billing" actions={<Button variant="primary" disabled={!b?.balance} onClick={() => setAdding(true)}>Add credit</Button>} />
    {state && <BillingAlerts state={state} summary={b} />}
    <div className="settings-rows billing-rows">
      <div className="billing-balance">
        <span className="billing-balance__label">Balance{b && <StatusBadge status={state?.enforcement === 'enforce' ? balanceState(b).label : 'Not charged yet'} tone={state?.enforcement === 'enforce' ? balanceState(b).tone : 'neutral'} />}</span>
        {b?.balance ? <button type="button" className="billing-balance__amount" aria-haspopup="dialog" aria-label={`Balance ${usd(total(b.balance))}: details`} onClick={() => setAbout(true)}>{usd(total(b.balance))}<ChevronRight size={20} aria-hidden="true" /></button>
          : <span className="billing-balance__amount"><Skeleton width={136} height={36} /></span>}
      </div>
      <Row title="Usage this month">{b?.monthToDate ? <MonthLink>{usd(b.monthToDate.cost)}</MonthLink> : <Skeleton width={80} height={20} />}</Row>
      <Row title="Payment method"><CardControl summary={b} /></Row>
      <AutoRecharge summary={b} Row={Row} />
    </div>
    <History />
    {b && <AddCredit open={adding} onOpenChange={setAdding} summary={b} />}
    {b?.balance && <BalanceDetails open={about} onOpenChange={setAbout} balance={b.balance} enforced={state?.enforcement === 'enforce'} />}
  </>
}
// This month's cost opens Plan & usage, where the free allowances it comes after and the prices are.
const MonthLink = ({ children }: { children: ReactNode }) => <Link to="/settings#usage" replace className="settings-score"><span>{children}</span><ArrowUpRight size={14} aria-hidden="true" /></Link>

// The balance's parts and how billing works, opened from the balance.
function BalanceDetails({ open, onOpenChange, balance, enforced }: { open: boolean; onOpenChange: (open: boolean) => void; balance: NonNullable<BillingSummary['balance']>; enforced: boolean }) {
  const paid = BigInt(balance.paid)
  const parts: [string, string][] = [paid < 0n ? ['Unpaid usage', usd(-paid)] : ['Paid credit', usd(paid)], ...BigInt(balance.promo) > 0n ? [['Promotional credit', usd(balance.promo)] as [string, string]] : [], ...BigInt(balance.unsettled) !== 0n ? [['Usage not yet settled', usd(balance.unsettled)] as [string, string]] : []]
  return <Dialog open={open} onOpenChange={onOpenChange} title={`Balance ${usd(total(balance))}`} className="billing-about" footer={<Button onClick={() => onOpenChange(false)}>Close</Button>}>
    <dl className="billing-facts">{parts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <ul className="billing-rules">{enforced ? <>
      <li>Usage is taken from it every hour.</li>
      <li>At $0, sending pauses and received mail is accepted for 7 more days.</li>
      <li>Credit you add pays off a negative balance first.</li>
    </> : <li>Credit you add now is kept until billing starts.</li>}</ul>
    <p className="muted billing-add__terms">{TERMS}</p>
  </Dialog>
}

// A workspace Anomaly made free: the plan instead of a balance, no Add credit, card or auto-recharge, and what its usage
// would cost, since it is still measured. The history keeps its $0 usage rows.
function FreePlan({ summary: b, Row }: { summary: BillingSummary | undefined; Row: (props: RowProps) => ReactNode }) {
  return <>
    <SectionHeader title="Billing" />
    <div className="settings-rows billing-rows">
      <div className="billing-balance">
        <span className="billing-balance__label">Plan</span>
        <span className="billing-balance__amount billing-balance__amount--plan">Free plan</span>
      </div>
      <Row title="Until">{b ? b.freePlan?.until ? fullDay(b.freePlan.until) : 'No end date' : <Skeleton width={96} height={20} />}</Row>
      <Row title="Usage this month">{b?.monthToDate ? <MonthLink>{usd(b.monthToDate.cost)}</MonthLink> : <Skeleton width={80} height={20} />}</Row>
    </div>
    <History />
  </>
}

/** What the banner doesn't say, where the fix is: the date received mail starts being held, and why auto-recharge
 *  turned off (the banner leaves that to this page). Held mail and paused sending are the banner's, on every page. Which
 *  alert shows comes from the session's state; the date fills a fixed-width slot when the summary arrives. */
function BillingAlerts({ state, summary: b }: { state: NonNullable<ReturnType<typeof useBillingState>>; summary: BillingSummary | undefined }) {
  if (state.enforcement !== 'enforce') return null
  // The date ends its line, so the text replacing the skeleton moves nothing.
  const slot = (ready: string | null | undefined, width: number) => ready ? <span>{ready}</span> : <span className="billing-slot"><Skeleton width={width} height={14} /></span>
  return <>
    {state.receiving === 'grace' && <Alert tone="warning" title={<>Received mail is accepted until {slot(b?.grace.receiveHoldAt ? monthDay(b.grace.receiveHoldAt) : null, 44)}</>}>Then it’s held until you add credit.</Alert>}
    {state.autoRecharge === 'failed' && <Alert tone="warning" title="Auto-recharge is off">{['dispute', 'early_fraud_warning'].includes(b?.autoRecharge?.disabledReason ?? '') ? `Your card was blocked after a ${b?.autoRecharge?.disabledReason === 'dispute' ? 'dispute' : 'fraud warning'}. Add a different card, then turn auto-recharge back on.` : `${productName} couldn’t charge your card. Update the card, then turn auto-recharge back on.`}</Alert>}
  </>
}
const useBillingState = () => useSession()?.identity?.billing

function CardControl({ summary: b }: { summary: BillingSummary | undefined }) {
  const refresh = useBillingRefresh(), toast = useToast()
  const [removing, setRemoving] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!b) return <ControlSkeleton width={140} />
  async function setup() {
    setBusy(true)
    try { window.location.assign((await billingApi.setupCard()).checkoutUrl) } catch (error) { toast(errorText(error), 'error'); setBusy(false) }
  }
  const card = b.paymentMethod
  if (!card) return <Button size="sm" loading={busy} onClick={() => void setup()}><CreditCard size={14} aria-hidden="true" />Add a card</Button>
  return <span className="cluster settings-inline">
    <span>{cardLabel(card)}</span><span className="muted">{String(card.expMonth).padStart(2, '0')}/{String(card.expYear).slice(-2)}</span>
    <DropdownMenu label="Card actions" title={cardLabel(card)} items={[{ label: 'Replace card', onSelect: () => void setup() }, { label: 'Remove card', destructive: true, onSelect: () => setRemoving(true) }]} />
    <ConfirmDialog open={removing} onOpenChange={setRemoving} danger title="Remove this card?" description={`${cardLabel(card)} is removed from Stripe. Auto-recharge turns off; add credit with Stripe Checkout until you save another card.`} confirmLabel="Remove card"
      onConfirm={async () => { try { await billingApi.removeCard() } catch (cause) { throw new Error(errorText(cause)) } refresh(); toast('Card removed. Auto-recharge is off.', 'success') }} />
  </span>
}

// Every way credit is added names the terms it is sold under: refunds and the 12-month expiry (Terms §5.7).
const TERMS = <>By adding credit you agree to the <Link to="/legal/terms#refunds-and-credit-expiry">refund and expiry terms</Link>.</>
const added = (cents: number) => `${centsUsd(cents)} added to your balance`
const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`

// Auto-recharge: one row with its setting as the value ("$25 below $10", or where it stands) and its switch. The amounts,
// how it works and the terms open from Edit, and from turning it on, which asks before the card is charged; turning it
// off is one click. Without a card the switch is off: the card row above it has Add a card.
function AutoRecharge({ summary: b, Row }: { summary: BillingSummary | undefined; Row: (props: RowProps) => ReactNode }) {
  const refresh = useBillingRefresh(), toast = useToast()
  const [editing, setEditing] = useState<'edit' | 'enable' | null>(null)
  const [pending, setPending] = useState(false)
  const settings = b?.autoRecharge
  if (!b || !settings) return <Row title="Auto-recharge"><Skeleton width={96} height={20} /><ControlSkeleton width={104} /></Row>
  const hasCard = !!b.paymentMethod
  const status = b.state.autoRecharge === 'capped' ? <StatusBadge status="Limit reached" tone="warning" /> : settings.pending ? <StatusBadge status="Adding credit" tone="info" />
    : <span className="billing-recharge__amounts">{dollars(settings.amountCents)} below {dollars(settings.thresholdCents)}</span>
  async function turnOff() {
    setPending(true)
    try { await billingApi.autoRecharge({ enabled: false, thresholdCents: settings!.thresholdCents, amountCents: settings!.amountCents, monthlyCapCents: settings!.monthlyCapCents }); refresh(); toast('Auto-recharge is off', 'success') }
    catch (cause) { toast(errorText(cause), 'error') } finally { setPending(false) }
  }
  return <Row title="Auto-recharge">
    <span className="cluster settings-inline billing-recharge">
      {status}
      <Button size="sm" onClick={() => setEditing('edit')}>Edit</Button>
      <Switch label={<span className="sr-only">Auto-recharge</span>} checked={settings.enabled} disabled={pending || !hasCard} onCheckedChange={on => { if (on) setEditing('enable'); else void turnOff() }} />
    </span>
    {editing && <RechargeDialog key={JSON.stringify(settings)} settings={settings} hasCard={hasCard} enable={editing === 'enable'} capped={b.state.autoRecharge === 'capped'} Row={Row} onClose={() => setEditing(null)} />}
  </Row>
}
function RechargeDialog({ settings, hasCard, enable, capped, Row, onClose }: { settings: NonNullable<BillingSummary['autoRecharge']>; hasCard: boolean; enable: boolean; capped: boolean; Row: (props: RowProps) => ReactNode; onClose: () => void }) {
  const refresh = useBillingRefresh(), toast = useToast()
  const initial = { threshold: (settings.thresholdCents / 100).toString(), amount: (settings.amountCents / 100).toString(), cap: (settings.monthlyCapCents / 100).toString() }
  const [form, setForm] = useState(initial)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const cents = { threshold: parseDollars(form.threshold), amount: parseDollars(form.amount), cap: parseDollars(form.cap) }
  const invalid = { threshold: cents.threshold === null || cents.threshold < 500 || cents.threshold > 100_000, amount: cents.amount === null || cents.amount < 2000 || cents.amount > 100_000,
    cap: cents.cap === null || cents.cap < (cents.amount ?? 0) || cents.cap > 1_000_000 }
  const valid = !invalid.threshold && !invalid.amount && !invalid.cap
  const changed = form.threshold !== initial.threshold || form.amount !== initial.amount || form.cap !== initial.cap
  // Each amount's range shows once the value is outside it.
  const rows = [['threshold', 'When balance falls below', '$5 to $1,000'], ['amount', 'Add', '$20 to $1,000 each time'], ['cap', 'Monthly limit', '$20 to $10,000, at least the Add amount']] as const
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!valid || !hasCard || (!enable && !changed)) return
    const input: AutoRechargeInput = { enabled: enable || settings.enabled, thresholdCents: cents.threshold!, amountCents: cents.amount!, monthlyCapCents: cents.cap! }
    setPending(true); setError(null)
    try { await billingApi.autoRecharge(input); refresh(); toast(enable ? 'Auto-recharge is on' : 'Auto-recharge saved', 'success'); onClose() }
    catch (cause) { setError(cause) } finally { setPending(false) }
  }
  return <Dialog open onOpenChange={next => { if (!next && !pending) onClose() }} title={enable ? 'Turn on auto-recharge' : 'Auto-recharge'} className="billing-recharge-dialog"
    description="Charges your saved card when the balance runs low, up to a monthly limit."
    footer={<><Button disabled={pending} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="billing-recharge" loading={pending} disabled={!valid || !hasCard || (!enable && !changed)}>{enable ? 'Turn on' : 'Save'}</Button></>}>
    <form id="billing-recharge" className="settings-rows billing-rows" onSubmit={submit} noValidate>
      {rows.map(([key, title, range]) => <Row key={key} title={title} error={invalid[key] ? range : undefined}>
        <span className="billing-dollars"><span aria-hidden="true">$</span><Input aria-label={`${title}, in dollars`} aria-invalid={invalid[key] || undefined} inputMode="decimal" value={form[key]} disabled={pending || !hasCard} onChange={event => setForm({ ...form, [key]: event.target.value })} /></span>
      </Row>)}
    </form>
    <dl className="billing-facts"><div><dt>Added this month</dt><dd>{centsUsd(settings.monthTotalCents)}{capped ? ' · limit reached' : settings.pending ? ' · adding credit now' : ''}</dd></div></dl>
    <p className="muted billing-add__terms">{hasCard ? 'A failed charge turns it off.' : 'Add a card to turn it on.'} {TERMS}</p>
    {error ? <Alert tone="danger">{errorText(error)}</Alert> : null}
  </Dialog>
}

// History: the balance's ledger and the card payments, a page at a time. Both are cursor lists with card slots on phones.
const ledgerText = (e: LedgerEntry) => `${e.description}${e.kind === 'topup' && e.expiresAt ? ` · Expires ${fullDay(e.expiresAt)}` : ''}`
const ledgerDescription = (e: LedgerEntry) => <span className="billing-desc" title={ledgerText(e)}>{e.description}{e.kind === 'topup' && e.expiresAt && <span className="muted"> · Expires {fullDay(e.expiresAt)}</span>}</span>
const ledgerColumns: Column<LedgerEntry>[] = [
  { key: 'description', label: 'Description', render: e => <span className="billing-cell">{ledgerDescription(e)}{e.invoiceUrl && <InvoiceLink href={e.invoiceUrl} label="Invoice" />}</span>, cardRender: ledgerDescription, card: 'title' },
  { key: 'at', label: 'Date', width: 124, render: e => date(e.at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }), card: 'line' },
  { key: 'amount', label: 'Amount', width: 104, align: 'right', render: e => <span className="billing-amount" data-sign={BigInt(e.amount) < 0n ? 'out' : 'in'}>{usd(e.amount, { sign: true })}</span>, card: 'aside' },
  { key: 'after', label: 'Balance after', width: 124, align: 'right', render: e => usd(e.balanceAfter), cardRender: e => <>{usd(e.balanceAfter)}{e.invoiceUrl && <> · <InvoiceLink href={e.invoiceUrl} label="Invoice" /></>}</>, card: 'field' },
]
function InvoiceLink({ href, label }: { href: string; label: string }) {
  return <a className="billing-link" href={href} target="_blank" rel="noreferrer">{label}<ArrowUpRight size={12} aria-hidden="true" /></a>
}
const PaymentLinks = ({ payment: p }: { payment: Payment }) => <>{p.invoiceUrl && <InvoiceLink href={p.invoiceUrl} label="Invoice" />}{p.receiptUrl && <InvoiceLink href={p.receiptUrl} label="Receipt" />}</>
const PaymentStatusBadge = ({ payment: p }: { payment: Payment }) => <StatusBadge status={p.status === 'succeeded' ? 'Paid' : p.status === 'requires_action' ? 'Needs action' : p.status}
  tone={p.status === 'succeeded' ? 'success' : p.status === 'failed' ? 'danger' : ['canceled', 'expired'].includes(p.status) ? 'neutral' : 'warning'} />
const KIND: Record<Payment['kind'], string> = { checkout: 'Top-up · Checkout', saved_card: 'Top-up · saved card', recharge: 'Auto-recharge', setup: 'Card saved' }
const paymentNote = (p: Payment) => p.status === 'failed' && p.failure ? declineText(p.failure.code) : p.card ? cardLabel(p.card) : null
const paymentColumns: Column<Payment>[] = [
  { key: 'kind', label: 'Payment', render: p => <span className="billing-stack"><span>{KIND[p.kind]}</span>{paymentNote(p) && <span className="muted billing-stack__note">{paymentNote(p)}</span>}</span>, cardRender: p => KIND[p.kind], card: 'title' },
  { key: 'at', label: 'Date', width: 124, render: p => date(p.at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }), card: 'line' },
  { key: 'amount', label: 'Amount', width: 104, align: 'right', render: p => p.kind === 'setup' ? '—' : centsUsd(p.totalCents ?? p.amountCents), card: 'aside' },
  { key: 'status', label: 'Status', width: 248, render: p => <span className="cluster billing-links"><PaymentStatusBadge payment={p} /><PaymentLinks payment={p} /></span>, card: 'line' },
]
function History() {
  const [view, setView] = useState<'ledger' | 'payments'>('ledger')
  return <section className="billing-section" aria-labelledby="billing-history-title">
    <SectionHeader title={<span id="billing-history-title">History</span>} />
    <Tabs label="History" value={view} onValueChange={value => setView(value as typeof view)} items={[{ value: 'ledger', label: 'Balance' }, { value: 'payments', label: 'Payments' }]} />
    {view === 'ledger' ? <LedgerTable /> : <PaymentsTable />}
  </section>
}
// Ledger IDs are sequence numbers: prefixed, so no row shares a React key with a skeleton row (keyed 0–4) and takes over
// its element, which the browser then counts as that row moving.
function LedgerTable() {
  const pagination = useCursorPagination(), query = useApiDef(queries.billingLedger(pagination.cursorForPage(pagination.page)), { keepPrevious: true })
  return <HistoryList query={query} pagination={pagination} columns={ledgerColumns} rowKey={e => `entry-${e.id}`} empty={<EmptyState title="No balance changes yet" />} />
}
function PaymentsTable() {
  const pagination = useCursorPagination(), query = useApiDef(queries.billingPayments(pagination.cursorForPage(pagination.page)), { keepPrevious: true })
  return <HistoryList query={query} pagination={pagination} columns={paymentColumns} rowKey={p => p.id} empty={<EmptyState title="No payments yet" />} />
}
type PageQuery<T> = { data?: { data: T[]; nextCursor: string | null }; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown }
function HistoryList<T>({ query, pagination, columns, rowKey, empty }: { query: PageQuery<T>; pagination: ReturnType<typeof useCursorPagination>; columns: Column<T>[]; rowKey: (row: T) => string; empty: ReactNode }) {
  if (query.isError && !query.data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />
  return <>
    <DataTable className="billing-table" columns={columns} rows={query.data?.data ?? []} rowKey={rowKey} loading={query.isPending} skeletonRows={5} minRows={5} empty={empty} />
    {query.data && <Pagination page={pagination.page} pageSize={20} count={query.data.data.length} nextCursor={query.data.nextCursor} onPageChange={next => pagination.onPageChange(next, query.data?.nextCursor)} />}
  </>
}

// Add credit: an amount, then how to pay. The saved card is charged now; otherwise Stripe Checkout opens. Above $200
// a second step confirms the amount.
const PRESETS = [2000, 5000, 10_000, 25_000]
/** A radiogroup's keyboard model: one tab stop, and arrows, Home and End select and focus the next choice. */
function radioKeys<T>(values: T[], current: T, select: (value: T) => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
    const index = values.indexOf(current), last = values.length - 1
    const next = ['ArrowRight', 'ArrowDown'].includes(event.key) ? (index >= last ? 0 : index + 1) : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? (index <= 0 ? last : index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : null
    if (next === null) return
    event.preventDefault()
    select(values[next])
    event.currentTarget.querySelectorAll<HTMLElement>('[role=radio]')[next]?.focus()
  }
}
function AddCredit({ open, onOpenChange, summary: b }: { open: boolean; onOpenChange: (open: boolean) => void; summary: BillingSummary }) {
  const card = b.paymentMethod, toast = useToast(), refresh = useBillingRefresh()
  const [preset, setPreset] = useState<number | 'custom'>(5000)
  const [custom, setCustom] = useState('')
  const [method, setMethod] = useState<'saved_card' | 'checkout'>(card ? 'saved_card' : 'checkout')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [charging, setCharging] = useState<string | null>(null)
  useEffect(() => { if (open) { setConfirming(false); setError(null); setMethod(card ? 'saved_card' : 'checkout') } }, [open, card])
  const amount = preset === 'custom' ? parseDollars(custom) : preset
  const invalid = amount === null || amount < 2000 || amount > 1_000_000
  const charge = usePaymentPoll(charging, payment => {
    setCharging(null); setBusy(false); refresh()
    if (payment?.status === 'succeeded') { toast(added(payment.amountCents), 'success'); onOpenChange(false) }
    else setError(new Error(payment?.failure ? `${declineText(payment.failure.code)}.` : 'The charge didn’t finish. Check Payments in a minute.'))
  })
  async function pay() {
    if (invalid) return
    if (amount! > 20_000 && !confirming) { setConfirming(true); return }
    setBusy(true); setError(null)
    try {
      const result = await billingApi.topUp({ amountCents: amount!, method })
      if (result.checkoutUrl) { window.location.assign(result.checkoutUrl); return }
      if (result.status === 'succeeded' || result.status === 'failed') { setCharging(null); setBusy(false); refresh(); if (result.status === 'succeeded') { toast(added(amount!), 'success'); onOpenChange(false) } else setError(new Error('The card was declined.')); return }
      setCharging(result.attemptId)
    } catch (cause) { setError(cause); setBusy(false) }
  }
  const working = busy || charge.waiting
  return <Dialog open={open} onOpenChange={next => { if (!working) onOpenChange(next) }} title="Add credit" className="billing-add"
    description={`Pays for email at ${usd(priceUc(b.prices.emailPerThousand))} per 1,000 sent or received, plus any tax.`}
    footer={<><Button disabled={working} onClick={() => confirming ? setConfirming(false) : onOpenChange(false)}>{confirming ? 'Back' : 'Cancel'}</Button>
      <Button variant="primary" loading={working} disabled={invalid} onClick={() => void pay()}>{confirming ? `Add ${centsUsd(amount ?? 0)}` : method === 'checkout' ? 'Continue to Stripe' : `Charge ${amount !== null && !invalid ? centsUsd(amount) : ''}`.trim()}</Button></>}>
    {confirming ? <p className="billing-add__confirm">Add <b>{centsUsd(amount ?? 0)}</b> to this workspace’s balance? {method === 'saved_card' && card ? `${cardLabel(card)} is charged now.` : 'You pay in Stripe Checkout, where any tax is added.'}</p> : <>
      <div className="billing-choice" role="radiogroup" aria-label="Amount" onKeyDown={working ? undefined : radioKeys<number | 'custom'>([...PRESETS, 'custom'], preset, setPreset)}>
        {[...PRESETS, 'custom' as const].map(value => <button key={value} type="button" role="radio" aria-checked={preset === value} tabIndex={preset === value ? 0 : -1} className="billing-choice__item" disabled={working} onClick={() => setPreset(value)}>{value === 'custom' ? 'Custom' : centsUsd(value).replace('.00', '')}</button>)}
      </div>
      {preset === 'custom' && <span className="billing-dollars billing-add__custom"><span aria-hidden="true">$</span><Input autoFocus aria-label="Amount in dollars, $20 to $10,000" inputMode="decimal" placeholder="75" value={custom} disabled={working} onChange={event => setCustom(event.target.value)} /></span>}
      {preset === 'custom' && custom && invalid && <p className="ui-field__error" role="alert">Add $20 to $10,000 at a time.</p>}
      <div className="billing-methods" role="radiogroup" aria-label="Pay with" onKeyDown={working ? undefined : radioKeys<typeof method>(card ? ['saved_card', 'checkout'] : ['checkout'], method, setMethod)}>
        {card && <button type="button" role="radio" aria-checked={method === 'saved_card'} tabIndex={method === 'saved_card' ? 0 : -1} className="billing-method" disabled={working} onClick={() => setMethod('saved_card')}><CreditCard size={16} aria-hidden="true" /><span>Charge {cardLabel(card)}</span></button>}
        <button type="button" role="radio" aria-checked={method === 'checkout'} tabIndex={method === 'checkout' ? 0 : -1} className="billing-method" disabled={working} onClick={() => setMethod('checkout')}><ArrowUpRight size={16} aria-hidden="true" /><span>Pay with Stripe Checkout</span></button>
      </div>
    </>}
    <p className="muted billing-add__terms">{TERMS}</p>
    {charge.waiting && <p className="muted" role="status">Charging {card ? cardLabel(card) : 'your card'}…</p>}
    {error ? <Alert tone="danger">{errorText(error)}</Alert> : null}
  </Dialog>
}

/** Polls a payment every 2 seconds for up to a minute, then calls done once with its final state (or undefined). */
function usePaymentPoll(id: string | null, done: (payment: Payment | undefined) => void) {
  const started = useRef(0), finished = useRef<string | null>(null)
  const [expired, setExpired] = useState(false)
  useEffect(() => { started.current = Date.now(); finished.current = null; setExpired(false) }, [id])
  const query = useApiQuery(['billing-payment', id], (_api, signal) => billingApi.payment(id!, signal), { enabled: !!id && !expired, interval: data => final(data) ? false : 2000 })
  useEffect(() => {
    if (!id || finished.current === id) return
    const timedOut = Date.now() - started.current > 60_000
    if (final(query.data) || timedOut || (query.isError && query.error instanceof ApiError && query.error.status === 404)) {
      finished.current = id
      if (timedOut) setExpired(true)
      done(final(query.data) ? query.data : undefined)
    }
  })
  return { waiting: !!id && finished.current !== id, payment: query.data }
}

// Back from Stripe Checkout (?billing=success&attempt=… or ?billing=canceled): say so, wait for the payment to settle,
// then refresh. The query string is cleared so a reload doesn't repeat it.
function useCheckoutReturn() {
  const { search } = useLocation(), navigate = useNavigate(), toast = useToast(), refresh = useBillingRefresh()
  const params = new URLSearchParams(search), outcome = params.get('billing'), attempt = params.get('attempt')
  const [watching, setWatching] = useState<string | null>(null)
  useEffect(() => {
    if (!outcome) return
    if (outcome === 'success' && attempt && /^[\w-]{1,100}$/.test(attempt)) { toast('Payment received; your credit appears in a few seconds.', 'info'); setWatching(attempt) }
    else if (outcome === 'canceled') toast('Checkout canceled.', 'info')
    navigate({ pathname: '/settings', search: '', hash: '#billing' }, { replace: true })
  }, [outcome, attempt, navigate, toast])
  usePaymentPoll(watching, payment => {
    setWatching(null); refresh()
    if (payment?.status === 'succeeded') toast(payment.kind === 'setup' ? 'Card saved.' : added(payment.amountCents), 'success')
    else if (payment) toast(payment.failure ? `${declineText(payment.failure.code)}.` : 'The payment didn’t go through.', 'error')
  })
}
