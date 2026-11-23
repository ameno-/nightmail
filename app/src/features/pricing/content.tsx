import { ArrowUpRight } from 'lucide-react'
import { comparisons, dayOf, nightmail, type Source, type Usage } from './prices'

// The price pages' shared pieces (board.tsx, calculator.tsx): where a figure was read, Nightmail's figures marked with
// the usage they price (data-nightmail-sent and -received, which api/scripts/check-premerge.ts reads back), the
// calculator's sizes and address, and Nightmail's pricing terms.

/** The calculator's numbers, as its address names them. */
export type Field = 'sent' | 'received' | 'contacts' | 'teammates'
export const sizeOf = (u: Usage): Record<Field, number> => ({ sent: u.sent, received: u.received, contacts: u.contacts, teammates: u.seats })
/** Small, medium and large: the sizes of the Mailchimp comparison, so the calculator opens on figures that were checked. */
export const PRESETS = (['Small', 'Medium', 'Large'] as const).map((name, i) => ({ name, size: sizeOf(comparisons.mailchimp.sizes[i]!) }))
/** A calculator address for a usage: /pricing?sent=…&received=…&contacts=…&teammates=… */
export const calculatorPath = (u: Usage) => `/pricing?${new URLSearchParams(Object.entries(sizeOf(u)).map(([k, v]) => [k, String(v)]))}`

const host = (url: string) => new URL(url).hostname.replace(/^www\./, '')
/** Where and when a figure was read: the date, and a link to the vendor's page. */
export function Checked({ source: { checked, url } }: { source: Pick<Source, 'checked' | 'url'> }) {
  return <span className="price-checked">Checked {dayOf(checked)} on <a href={url} target="_blank" rel="noopener noreferrer">{host(url)}<ArrowUpRight size={12} aria-hidden="true" /></a></span>
}
/** A claim's source, after it: a link to the page it was read on (the list's note says when). */
export function Cite({ source: { checked, url } }: { source: Source }) {
  const label = `${host(url)}, checked ${dayOf(checked)}`
  return <a className="price-cite" href={url} target="_blank" rel="noopener noreferrer" title={label} aria-label={`Source: ${label}`}><ArrowUpRight size={14} aria-hidden="true" /></a>
}
/** The days a list of claims was read on, and where, said once under it. */
export function CheckedOn({ facts }: { facts: { source?: Source }[] }) {
  const sources = facts.flatMap(fact => fact.source ? [fact.source] : [])
  const days = [...new Set(sources.map(source => dayOf(source.checked)))], hosts = [...new Set(sources.map(source => host(source.url)))]
  return days.length ? <p className="price-note">Checked {days.join(', ')} on {hosts.length === 1 ? hosts[0] : 'each vendor’s own page'}.</p> : null
}
/** A Nightmail figure, marked with the usage it prices. */
export function Ours({ sent, received, children }: { sent: number; received: number; children: string }) {
  return <span data-nightmail-sent={sent} data-nightmail-received={received}>{children}</span>
}

/** Nightmail's pricing terms, in each page's small print: what a buyer is told before paying. */
export function Terms({ floor }: { floor: string | null }) {
  return <ul className="price-terms">
    <li>Paid from prepaid credit. Top-ups start at {nightmail.minTopUp} and expire {nightmail.expiresAfterMonths} months after purchase.{floor && ` At this size that’s at least ${floor} a year.`}</li>
    <li>Received mail kept past {nightmail.storageAfterDays} days: {nightmail.storagePerGb} per GB a month after {nightmail.freeStorageGb} GB free.</li>
  </ul>
}
