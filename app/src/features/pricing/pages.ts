// (With extensions: the build's config imports this file, price-pages.ts.)
import { COMPARISONS, OFFERS } from './compare/index.ts'
import type { CardWords } from '../../../link-card.ts'
import { formatCount, lastChecked, listOf, nightmail, opening, type Comparison } from './prices.ts'
import type { Doc } from './docs/doc.ts'
import { DOCS } from './docs/index.ts'

/** A comparison's link-preview card: both bills at the size the page opens at, and the day the vendor's prices were read. */
export function verdictCard(c: Comparison): CardWords {
  const u = c.sizes[1]!, m = c.model, { ours, theirs, day } = opening(c, u)
  const at = m.per === 'contact' ? `For ${formatCount(u.contacts)} contacts emailed ${m.sendsPerContact} times a month`
    : m.per === 'inbox' ? `For ${formatCount(u.inboxes ?? 0)} inboxes, ${m.receivedPerInbox} in and ${m.sentPerInbox} out each a month`
      : m.per === 'received' ? `Per ${formatCount(u.received)} emails received a month` : `Per ${formatCount(u.sent)} emails a month`
  return { name: `compare-${c.slug}`, lines: [`Nightmail ${ours}.`, `${c.offer.vendor} ${theirs}.`], caption: `${at}, checked ${day}.` }
}

/** A vendor's pricing page's link-preview card: its card words (docs/doc.ts), drawn in the cards' one style. */
const docCard = (doc: Doc): CardWords => ({ name: doc.path.slice(1).replaceAll('/', '-'), ...doc.cardWords })

export type PricePage = { path: string; file: string; title: string; searchTitle: string; description: string; card: CardWords; comparison: Comparison | null; doc?: Doc; modified: string }
const vendors = listOf([...new Set(OFFERS.map(offer => offer.vendor))])
const free = `${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received free a month`
/** Each page's address, the HTML file the build writes for it (served at that address by Workers Assets and by
 *  api/src/server.ts), its name on the site (title), and its title, description and card in the browser tab, search
 *  results and link previews (searchTitle, at most 60 characters, and description, at most 160: price-pages.ts checks
 *  both), and the last day any figure on it was read (modified: the sitemap's lastmod and the page's dateModified). The
 *  calculator, then a page for every comparison (compare/index.ts; prices.ts, searchWords), then a pricing page for some
 *  vendors (docs/index.ts: /pricing/<vendor>), each made from one data object (docs/doc.ts). */
export const PRICE_PAGES: PricePage[] = [
  { path: '/pricing', file: 'pricing.html', title: 'Price calculator', comparison: null, modified: OFFERS.map(offer => offer.checked).sort().at(-1)!,
    searchTitle: `Nightmail pricing: ${nightmail.perThousand} per 1,000 emails, sent or received`,
    description: [`${nightmail.perThousand} per 1,000 emails, sent or received, after ${free}. Contacts and teammates are free. Compare ${vendors}.`,
      `${nightmail.perThousand} per 1,000 emails, sent or received, after ${free}. Contacts and teammates are free.`].find(text => text.length <= 160)!,
    card: { name: 'pricing', lines: [`${nightmail.perThousand} per 1,000 emails.`, 'Sent or received.'], caption: `Free every month: ${formatCount(nightmail.freeSent)} sent and ${formatCount(nightmail.freeReceived)} received.` } },
  ...COMPARISONS.map(c => ({ path: c.path, file: `compare/${c.slug}.html`, title: c.title, searchTitle: c.searchTitle, description: c.description, card: verdictCard(c), comparison: c, modified: lastChecked(c) })),
  ...DOCS.map(doc => ({ path: doc.path, file: `${doc.path.slice(1)}.html`, title: doc.title, searchTitle: doc.searchTitle, description: doc.description, card: docCard(doc), comparison: null, doc, modified: doc.modified })),
]
