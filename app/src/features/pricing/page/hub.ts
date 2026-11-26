// (With extensions: the build's config imports this file, app/price-pages.ts.)
import { productName, publicOrigin } from '../../../../../api/src/brand.ts'
import { dayOf, formatCount, type Comparison } from '../prices.ts'
import { billAt, GROUPS, ORDERED } from './comparison.ts'
import type { CardWords } from '../../../../link-card.ts'
import { plain, type PageDoc, type Table, type Text } from './shape.ts'

// /compare, every comparison on one page (shape.ts, drawn by page.tsx like a comparison): a line, then each group's
// services in a table at three sizes, Nightmail's row first and the rest by their price at the middle size, each a link
// to its comparison. What it says of Nightmail is what the tables show (Ryan, 26 Nov: only providers it costs less than,
// and never "the cheapest"): it costs less than each, at every size shown, which the build checks cell by cell.

/** A table's services: one way of counting, its three sizes, and the comparisons that count that way. A group can hold
 *  two (the developer APIs: sending, and CloudMailin's receiving). */
const TABLES: { group: (typeof GROUPS)[number]['id']; per: Comparison['model']['per']; unit: string; sizes: number[] }[] = [
  { group: 'developer', per: 'email', unit: 'Emails sent a month', sizes: [10_000, 100_000, 1_000_000] },
  { group: 'developer', per: 'received', unit: 'Emails received a month', sizes: [20_000, 100_000, 2_000_000] },
  // (Not below 5,000 contacts: beehiiv, EmailOctopus and Loops are free there too, so Nightmail costs no less.)
  { group: 'newsletter', per: 'contact', unit: 'Contacts, 4 emails each a month', sizes: [5_000, 10_000, 100_000] },
  { group: 'agents', per: 'inbox', unit: 'Agent inboxes, 100 in and 50 out each a month', sizes: [10, 50, 100] },
]

function table(spec: (typeof TABLES)[number]): Table {
  const priced = ORDERED.filter(c => c.model.per === spec.per).map(c => ({ c, bills: spec.sizes.map(size => billAt(c, size)) }))
  const mid = (row: (typeof priced)[number]) => row.bills[1]!.theirsCents ?? Infinity
  priced.sort((a, b) => mid(a) - mid(b))
  // The page says Nightmail costs less than each service at every size it shows: the build stops where that isn't so.
  for (const { c, bills } of priced) for (const b of bills) if (b.theirsCents !== null && !(b.oursUc < BigInt(b.theirsCents) * 1_000_000n))
    throw new Error(`/compare's ${spec.unit} column at ${formatCount(b.size)} shows Nightmail at ${b.ours} and ${c.offer.vendor} at ${b.theirs}: pick sizes where Nightmail costs less (page/hub.ts, TABLES).`)
  const ours: Text[] = priced[0]!.bills.map(b => [{ ours: b.ours, sent: b.u.sent, received: b.u.received }])
  return {
    kind: 'table', numeric: [1, 2, 3],
    caption: [`By the price at ${formatCount(spec.sizes[1]!)}. A dash: no plan priced at that size.`],
    head: [spec.unit, ...spec.sizes.map(formatCount)],
    rows: [{ cells: [[productName], ...ours] }, ...priced.map(({ c, bills }) => ({ cells: [[{ text: c.offer.vendor, href: c.path }], ...bills.map(b => [b.theirs ?? '—'])] }))],
  }
}

export function hubDoc(): PageDoc {
  const modified = ORDERED.map(c => c.offer.checked).sort().at(-1)!
  const counts = GROUPS.map(group => `${ORDERED.filter(c => c.focus === group.focus).length} ${group.noun}`)
  const sections = GROUPS.map(group => ({ id: group.id, title: group.title, blocks: TABLES.filter(spec => spec.group === group.id).map(table) }))
  return {
    path: '/compare', title: 'Compare', searchTitle: 'Email API alternatives and pricing compared',
    description: `${productName} beside ${ORDERED.length} email services, developer APIs, newsletters and agent inboxes: a month at three sizes on each, read ${dayOf(modified)}.`,
    h1: [[`${productName} costs less`], [`than each of these ${ORDERED.length}.`]],
    answer: [[`At every size shown · checked ${dayOf(modified).replaceAll(' ', '\u00a0')}`]],
    sections,
    questions: [], sources: [], related: [],
    crumbs: [{ name: productName, path: '/' }, { name: 'Compare', path: '/compare' }],
    modified,
    llms: `What a month costs on ${productName} and on ${counts.join(', ')}, at three sizes each, read ${dayOf(modified)}.`,
    card: { alt: `${productName} costs less than each of these ${ORDERED.length}. At every size shown, checked ${dayOf(modified)}.`, shown: sections.flatMap(section => section.blocks.flatMap(block => block.kind === 'table' ? block.rows.flatMap(row => row.cells.map(plain)) : [])) },
  }
}

/** /compare in Markdown (/compare.md): its heading and caption, then each group's tables with every service linked to its
 *  comparison's twin. */
export function hubMarkdown(doc = hubDoc()): string {
  const cell = (text: Text) => text.map(part => typeof part === 'string' ? part : 'href' in part ? `[${part.text}](${publicOrigin}${part.href}.md)` : part.ours).join('').replaceAll('|', '\\|')
  return [
    `# ${(typeof doc.h1 === 'string' ? [[doc.h1]] : doc.h1).map(plain).join(' ')}`, `> ${doc.answer.map(plain).join(' ')}`, `Canonical page: ${publicOrigin}${doc.path}`,
    ...doc.sections.flatMap(section => [`## ${section.title}`, ...section.blocks.flatMap(block => block.kind !== 'table' ? [] : [plain(block.caption), [
      `| Service | ${block.head.slice(1).join(' | ')} |`, `| --- | ${block.head.slice(1).map(() => '---:').join(' | ')} |`, ...block.rows.map(row => `| ${row.cells.map(cell).join(' | ')} |`),
    ].join('\n')])]),
    'Each comparison names the pages its prices were read on. Product names belong to their owners and only identify their products. Nightmail isn’t affiliated with them.',
  ].join('\n\n') + '\n'
}

/** /compare's link-preview card (link-card.ts draws it): how many services it prices, and the day the newest was read. */
export function hubCard(): CardWords {
  const modified = ORDERED.map(c => c.offer.checked).sort().at(-1)!
  return { name: 'compare', lines: [`${ORDERED.length} email services,`, 'priced side by side.'], caption: `Each price from its own pricing page, checked ${dayOf(modified)}.` }
}
