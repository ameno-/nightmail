import { COMPARISONS } from '../../pricing/compare'
import { PANEL_IDS, PANELS } from '../../pricing/panels'
import { nightmail } from '../../pricing/prices'
import { ASSUME, MONTHS, NOTICE, OPENING, PER_THOUSAND, SOURCES, VOLUMES, count, usd } from './data'
import { HEADING, LEAD, QUESTIONS } from './said'

// The homepage in words. The page is a picture: its facts are drawn on the television's screen, a channel each, where a
// search engine, an agent or a screen reader can't read them. These say the same things as text, out of sight
// (.chy-sr): the heading and what it is before the set, and after the way in everything the channels show (the month's
// comparison at every volume the tape plays, what is free, what is charged, the price per 1,000 and a year beside the
// others, what keeping mail costs), what it does, the questions people ask (said.ts) and where the rest is. Every
// figure is the one the picture draws (data.ts, pricing/prices.ts). Its links are out of the Tab order, since nobody
// tabbing can see them; a screen reader's own keys still reach them.

/** Before the set: the page's heading and what it is. */
export const Heading = () => <>
  <h1 className="chy-sr">{HEADING}</h1>
  <p className="chy-sr">{LEAD}</p>
</>

const order = MONTHS[OPENING]
const at = (volume: (typeof VOLUMES)[number], slug: string) => MONTHS[volume].find(line => line.slug === slug)!.dollars
const cents = (dollars: number) => usd(Math.round(dollars * 100) / 100)
const out = { tabIndex: -1 }

/** After the way in: everything else. */
export const Words = () => <section className="chy-sr chy-words" aria-label="Prices, in words">
  <h2>What sending email costs a month</h2>
  <table>
    <caption>The monthly cost of sending email on Nightmail and on {order.length - 1} other email APIs, by emails sent a month, in US dollars. {ASSUME}</caption>
    <thead><tr><th scope="col">Emails a month</th>{order.map(line => <th key={line.slug} scope="col">{line.path ? <a href={line.path} {...out}>{line.name}</a> : line.name}</th>)}</tr></thead>
    <tbody>{VOLUMES.map(volume => <tr key={volume}><th scope="row">{count(volume)}</th>{order.map(line => <td key={line.slug}>{usd(at(volume, line.slug))}</td>)}</tr>)}</tbody>
  </table>
  <p>{SOURCES} {NOTICE}</p>

  <h2>Free every month</h2>
  <ul>
    <li>{count(nightmail.freeSent)} emails sent</li>
    <li>{count(nightmail.freeReceived)} emails received</li>
    <li>{nightmail.freeStorageGb} GB of stored mail</li>
  </ul>

  <h2>After the free ones</h2>
  <ul>
    <li>{PER_THOUSAND} per {count(1000)} emails sent</li>
    <li>{PER_THOUSAND} per {count(1000)} emails received</li>
    <li>Contacts: no charge</li>
    <li>Teammates: no charge</li>
    <li>Received mail is kept {nightmail.storageAfterDays} days at no charge; after that, {nightmail.storagePerGb} per GB a month beyond {nightmail.freeStorageGb} GB free</li>
    <li>Paid from prepaid credit: top-ups start at {nightmail.minTopUp} and expire {nightmail.expiresAfterMonths} months after purchase</li>
  </ul>

  <h2>The price per {count(1000)} emails, at {count(OPENING)} a month</h2>
  <ul>{order.map(line => <li key={line.slug}>{line.name}: {line.ours ? PER_THOUSAND : cents(line.dollars / (OPENING / 1000))}</li>)}</ul>

  <h2>A year at {count(OPENING)} emails a month</h2>
  <ul>{order.map(line => <li key={line.slug}>{line.name}: {cents(line.dollars * 12)}</li>)}</ul>

  <h2>What Nightmail does</h2>
  <ul>{PANEL_IDS.map(id => <li key={id}>{PANELS[id].title} {PANELS[id].line}</li>)}</ul>

  <h2>Questions</h2>
  {QUESTIONS.map(item => <div key={item.question}><h3>{item.question}</h3><p>{item.answer}</p></div>)}

  <h2>More</h2>
  <ul>
    <li><a href="/pricing" {...out}>Price calculator</a>: what your own month costs, sent and received</li>
    <li><a href="/docs" {...out}>API documentation</a></li>
    <li><a href="/index.md" {...out}>This page in Markdown</a>, with the steps for an agent setting up sending</li>
    <li><a href="/llms.txt" {...out}>Index for agents</a> (llms.txt)</li>
    {COMPARISONS.map(c => <li key={c.slug}><a href={c.path} {...out}>{c.title}</a>: {c.description}</li>)}
  </ul>
</section>
