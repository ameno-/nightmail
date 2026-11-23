// (With extensions: the build's config imports this file, price-pages.ts.)
import { CHECKED, claim, comparisons, dayOf, formatCount, money, nightmail, nightmailBill, OFFERS, quote, theirPrice } from './prices.ts'

const list = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items.join('')
const sizes = (id: keyof typeof comparisons, of: 'contacts' | 'sent') => list(comparisons[id].sizes.map(size => formatCount(size[of])))

/** A page's link-preview card: a picture of the page as it opens (scripts/price-cards.mjs makes it), named by a hash of
 *  every figure and claim on it, so when a price changes the build asks for a new card (price-pages.ts) rather than
 *  sharing an old one. */
const hash = (text: string) => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193); return (h >>> 0).toString(36) }
const card = (slug: string, alt: string, shown: string[]) => ({ file: `og/${slug}-${hash([alt, ...shown].join('|'))}.jpg`, alt })
// What each page opens on: the calculator at its middle size (content.tsx), a comparison at its middle size (board.tsx).
const opening = comparisons.mailchimp.sizes[1]!, bill = nightmailBill(opening.sent, opening.received).text
function boardCard(id: keyof typeof comparisons) {
  const c = comparisons[id], u = c.sizes[1]!, ours = nightmailBill(u.sent, u.received).text, theirs = money(theirPrice(c.offer, u)!.cents)
  const at = c.offer.unit === 'contacts' ? `${formatCount(u.contacts)} contacts` : `${formatCount(u.sent)} emails`
  return card(`compare-${id}`, `The Nightmail vs ${c.offer.vendor} board under the headline “${claim(c).replaceAll('\u00a0', ' ')}”: a month at ${at}, Nightmail ${ours} and ${c.offer.vendor} ${theirs}.`, [ours, theirs])
}

/** Each page's address, the HTML file the build writes for it (served at that address by Workers Assets and by
 *  api/src/server.ts) and its title, description and card: the browser tab, search results and link previews. */
export const PRICE_PAGES = [
  { path: '/pricing', file: 'pricing.html', title: 'Price calculator',
    description: `What your email costs on Nightmail, beside Mailchimp and Resend. ${nightmail.perThousand} per 1,000 emails; contacts and teammates are free.`,
    card: card('pricing', `The Nightmail price calculator: ${formatCount(opening.sent)} emails sent a month to ${formatCount(opening.contacts)} contacts cost ${bill} a month on Nightmail, beside Mailchimp and Resend.`,
      [bill, ...OFFERS.flatMap(offer => { const q = quote(offer, opening); return q.kind === 'price' ? [money(q.cents)] : [] })]) },
  { path: '/compare/mailchimp', file: 'compare/mailchimp.html', title: 'Nightmail vs Mailchimp',
    description: `Mailchimp prices by contacts, Nightmail by email. Monthly prices at ${sizes('mailchimp', 'contacts')} contacts, checked ${dayOf(CHECKED)}.`,
    card: boardCard('mailchimp') },
  { path: '/compare/resend', file: 'compare/resend.html', title: 'Nightmail vs Resend',
    description: `Monthly prices at ${sizes('resend', 'sent')} emails, checked ${dayOf(CHECKED)}, and what each one includes.`,
    card: boardCard('resend') },
] as const
