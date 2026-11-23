// (With extensions: the build's config imports this file, price-pages.ts.)
import { CHECKED, comparisons, dayOf, formatCount, nightmail } from './prices.ts'

const list = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items.join('')
const sizes = (id: keyof typeof comparisons, of: 'contacts' | 'sent') => list(comparisons[id].sizes.map(size => formatCount(size[of])))

/** Each page's address, the HTML file the build writes for it (served at that address by Workers Assets and by
 *  api/src/server.ts) and its title and description: the browser tab, search results and link previews. */
export const PRICE_PAGES = [
  { path: '/pricing', file: 'pricing.html', title: 'Price calculator',
    description: `What your email costs on Nightmail, beside Mailchimp and Resend. ${nightmail.perThousand} per 1,000 emails; contacts and teammates are free.` },
  { path: '/compare/mailchimp', file: 'compare/mailchimp.html', title: 'Nightmail vs Mailchimp',
    description: `Mailchimp prices by contacts, Nightmail by email. Monthly prices at ${sizes('mailchimp', 'contacts')} contacts, checked ${dayOf(CHECKED)}.` },
  { path: '/compare/resend', file: 'compare/resend.html', title: 'Nightmail vs Resend',
    description: `Monthly prices at ${sizes('resend', 'sent')} emails, checked ${dayOf(CHECKED)}, and what each one includes.` },
] as const
