// (With extensions: the build's config imports this file, app/price-pages.ts.)
import { productName } from '../../../../../api/src/brand.ts'
import { COMPARISONS } from '../compare/index.ts'
import { comparisonQuestions } from '../questions.ts'
import { dayOf, formatCount, lastChecked, money, nightmail, nightmailBill, sourcesOf, theirPrice, type Comparison, type Usage } from '../prices.ts'
import type { PageDoc, Text } from './shape.ts'

// A comparison (/compare/<slug>) as a page (shape.ts): the verdict first, both prices at the comparison's middle size and
// the day they were read; then the price table, every size the vendor's own page prices; the questions (questions.ts);
// what the figures assume and Nightmail's terms; the other comparisons of its kind; the pages read. Every figure is the
// price pages' arithmetic (prices.ts), Nightmail's from the billing code.

/** The comparison's three groups, as /compare lists them and each page's More comparisons and breadcrumb name them. */
export const GROUPS = [
  { focus: 'developer', id: 'developer', title: 'Developer email APIs', noun: 'developer email APIs' },
  { focus: 'newsletter', id: 'newsletter', title: 'Newsletter and marketing', noun: 'newsletter and marketing services' },
  { focus: 'agents', id: 'agents', title: 'Agent inboxes', noun: 'services for agent inboxes' },
] as const
export const groupOf = (c: Comparison) => GROUPS.find(group => group.focus === c.focus)!
/** The comparisons in the groups' order (each group as compare/index.ts lists it). */
export const ORDERED = GROUPS.flatMap(group => COMPARISONS.filter(c => c.focus === group.focus))

/** A size in the comparison's own unit: its middle one, as the page opens on it. */
export const middle = (c: Comparison) => sizeOf(c, c.sizes[1]!)
const sizeOf = (c: Comparison, u: Usage) => c.offer.unit === 'contacts' ? u.contacts : c.offer.unit === 'inboxes' ? u.inboxes ?? 0 : c.model.per === 'received' ? u.received : u.sent
/** Both bills at a size; theirs null where the vendor's page prices no plan there. */
export function billAt(c: Comparison, size: number) {
  const u = c.use(size), ours = nightmailBill(u.sent, u.received), theirs = theirPrice(c.offer, u)
  return { size, u, ours: ours.text, oursUc: ours.uc, theirs: theirs ? money(theirs.cents) : null, theirsCents: theirs?.cents ?? null, plan: theirs?.plan ?? null }
}
/** What a size is, with the emails it means where the unit isn't emails: "Per 100,000 emails a month", "Per 25,000
 *  contacts, 100,000 emails a month", "Per 100 agent inboxes, 10,000 received and 5,000 sent a month". */
export function perSize(c: Comparison, size: number) {
  const u = c.use(size), n = formatCount(size)
  return c.model.per === 'contact' ? `Per ${n} contacts, ${formatCount(u.sent)} emails a month`
    : c.model.per === 'inbox' ? `Per ${n} agent inboxes, ${formatCount(u.received)} received and ${formatCount(u.sent)} sent a month`
      : c.model.per === 'received' ? `Per ${n} emails received a month` : `Per ${n} emails a month`
}
/** The verdict: Nightmail's bill and the vendor's at the middle size, and that size with the day read. */
export function verdictOf(c: Comparison) {
  const b = billAt(c, middle(c))
  // (The day's words don't break apart: "25 Nov 2026" stays on one line.)
  return { ours: b.ours, theirs: b.theirs!, u: b.u, at: `${perSize(c, b.size)} · checked ${dayOf(c.offer.checked).replaceAll(' ', '\u00a0')}` }
}
const unitHead = (c: Comparison) => c.model.per === 'contact' ? 'Contacts' : c.model.per === 'inbox' ? 'Inboxes' : c.model.per === 'received' ? 'Received a month' : 'Emails a month'

export function comparisonDoc(c: Comparison): PageDoc {
  const vendor = c.offer.vendor, v = verdictOf(c), opening = middle(c)
  const terms: Text = [`${c.assume} Monthly billing, no promotions. ${productName}: ${nightmail.perThousand} per 1,000 emails, sent or received, after ${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free a month. Top-ups start at ${nightmail.minTopUp} and expire ${nightmail.expiresAfterMonths} months after purchase; received mail kept past ${nightmail.storageAfterDays} days is ${nightmail.storagePerGb} per GB a month after ${nightmail.freeStorageGb} GB free.`]
  return {
    path: c.path, title: c.title, searchTitle: c.searchTitle, description: c.description,
    h1: [[`${productName} `, { ours: v.ours, sent: v.u.sent, received: v.u.received }, '.'], [`${vendor} ${v.theirs}.`]],
    answer: [[v.at]],
    sections: [{ id: 'sizes', title: `A month at each size ${vendor} prices`, blocks: [{
      kind: 'table', caption: terms, head: [unitHead(c), productName, vendor, `${vendor} plan`], numeric: [1, 2],
      rows: c.steps.map(size => { const b = billAt(c, size); return { mark: size === opening, cells: [[formatCount(size)], [b.ours], [b.theirs ?? '—'], [b.plan ?? '']] } }),
    }] }],
    questions: comparisonQuestions(c),
    sources: sourcesOf(c),
    related: ORDERED.filter(other => other.focus === c.focus && other.slug !== c.slug).map(other => {
      const o = verdictOf(other)
      return { title: other.title, path: other.path, line: `${o.at.replaceAll('\u00a0', ' ').replace(/^Per/, 'At')}: ${productName} ${o.ours}, ${other.offer.vendor} ${o.theirs}.` }
    }),
    crumbs: [{ name: productName, path: '/' }, { name: 'Compare', path: '/compare' }, { name: vendor, path: c.path }],
    about: { name: vendor, url: c.offer.pricing }, modified: lastChecked(c), focus: c.focus,
    llms: `${productName} ${v.ours}, ${vendor} ${v.theirs}: ${v.at.replaceAll('\u00a0', ' ').toLowerCase()}.`,
  }
}
