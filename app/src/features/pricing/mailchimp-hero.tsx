import { useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { Ours } from './content'
import { ROWS, SmallPrint, Sourced, TryNumbers, type Row } from './mailchimp'
import { comparisons, formatCount, money, price, ucOf } from './prices'

// Five iterations on take 1, the number as the hero: /compare/mailchimp?take=1a … 1e. The same facts as every take (the
// comparison's three sizes, both prices at each, the emails a month behind them, the dated source line, the closed small
// print) and one size shown at a time, chosen with a quiet switch. Every size is rendered and the shown one is visible
// (Stack), so the hero keeps its height whichever is chosen.
//   1a. one statement: the two prices as two lines of one sentence, Nightmail's in ink and Mailchimp's quieter;
//   1b. the gap as the hero: what Nightmail saves a month, over Mailchimp's price drawn as a bar with Nightmail's share;
//   1c. the ratio as area: Mailchimp's price a square field, Nightmail's a square in its corner, to scale;
//   1d. the ratio counted: one month of Mailchimp beside the months of Nightmail it pays for, to the same scale;
//   1e. Nightmail's price on a navy field, Mailchimp's beside it as what it is measured against.

const c = comparisons.mailchimp
export const HERO_TAKES = ['1a', '1b', '1c', '1d', '1e'] as const
export type HeroTake = (typeof HERO_TAKES)[number]

const ours = (row: Row) => <Ours sent={row.usage.sent} received={row.usage.received}>{row.ours.text}</Ours>
const theirs = (row: Row) => money(row.cents)
/** Nightmail's price as a share of Mailchimp's at the same size. */
const share = (row: Row) => Number(row.ours.uc) / Number(ucOf(row.cents))
const saved = (row: Row) => price(ucOf(row.cents) - row.ours.uc)
/** Whole months of Nightmail that one month of Mailchimp pays for. */
const months = (row: Row) => Number(ucOf(row.cents) / row.ours.uc)
const contacts = (row: Row) => formatCount(row.usage.contacts)
const emails = (row: Row) => `${formatCount(row.usage.sent)} emails a month`

/** The list size: three contact counts, as radios (arrow keys move between them). */
function Sizes({ at, onChange }: { at: number; onChange: (at: number) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const key = (event: KeyboardEvent, index: number) => {
    const next = ['ArrowRight', 'ArrowDown'].includes(event.key) ? (index + 1) % ROWS.length : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? (index + ROWS.length - 1) % ROWS.length : null
    if (next === null) return
    event.preventDefault(); onChange(next); refs.current[next]?.focus()
  }
  return <div className="hx-seg" role="radiogroup" aria-label="Contacts on the list">
    {ROWS.map((row, index) => <button key={row.usage.contacts} ref={node => { refs.current[index] = node }} type="button" role="radio" aria-checked={index === at} tabIndex={index === at ? 0 : -1}
      onClick={() => onChange(index)} onKeyDown={event => key(event, index)}>{contacts(row)}</button>)}
  </div>
}

/** Every size in one cell, only the chosen one visible: the cell is as large as the largest, so nothing moves. */
function Stack({ at, className, children }: { at: number; className?: string; children: (row: Row) => ReactNode }) {
  return <div className={`hx-stack${className ? ` ${className}` : ''}`}>
    {ROWS.map((row, index) => <div key={row.usage.contacts} className="hx-stack__item" data-on={index === at || undefined} data-offer="mailchimp">{children(row)}</div>)}
  </div>
}

/** The switch and what the chosen size means: the contacts, and the emails a month every price here is for. */
function Ask({ at, onChange }: { at: number; onChange: (at: number) => void }) {
  return <div className="hx-ask">
    <Sizes at={at} onChange={onChange} />
    <Stack at={at}>{row => <p>contacts, {emails(row)}</p>}</Stack>
  </div>
}

/** What Nightmail has, a few words each, and the way into the calculator. */
function Close() {
  return <section className="hx-close" aria-labelledby="hx-close">
    <h2 id="hx-close">Nightmail has</h2>
    <ul>{c.ours.map(fact => <li key={fact.text}><Check size={18} aria-hidden="true" />{fact.short}</li>)}</ul>
    <TryNumbers />
  </section>
}

function Statement() {
  const [at, setAt] = useState(1)
  return <>
    <Ask at={at} onChange={setAt} />
    <Stack at={at} className="hx1a-lines">{row => <h1>
      <span className="hx1a-theirs"><b>{theirs(row)}</b> on Mailchimp.</span>
      <span className="hx1a-ours"><b>{ours(row)}</b> on Nightmail.</span>
    </h1>}</Stack>
    <Sourced />
  </>
}

function Saving() {
  const [at, setAt] = useState(1)
  const row = ROWS[at]!
  return <>
    <Ask at={at} onChange={setAt} />
    <Stack at={at} className="hx1b-hero">{row => <h1><b>{saved(row)}</b><span>a month less than Mailchimp</span></h1>}</Stack>
    <div className="hx1b-bar" style={{ '--share': share(row) } as CSSProperties} aria-hidden="true"><i /></div>
    <Stack at={at} className="hx1b-ends">{row => <>
      <p className="hx1b-ours"><b>{ours(row)}</b>Nightmail</p>
      <p className="hx1b-theirs"><b>{theirs(row)}</b>Mailchimp {row.plan}</p>
    </>}</Stack>
    <Sourced />
  </>
}

function Area() {
  const [at, setAt] = useState(1)
  const row = ROWS[at]!
  return <div className="hx1c-hero">
    <h1>Under a tenth of Mailchimp’s price</h1>
    <Ask at={at} onChange={setAt} />
    <div className="hx1c-area" style={{ '--side': Math.sqrt(share(row)) } as CSSProperties} aria-hidden="true"><i /></div>
    <Stack at={at} className="hx1c-keys">{row => <dl>
      <div className="hx1c-ours"><dt><i aria-hidden="true" />Nightmail</dt><dd>{ours(row)}</dd></div>
      <div><dt><i aria-hidden="true" />Mailchimp {row.plan}</dt><dd>{theirs(row)}</dd></div>
    </dl>}</Stack>
    <Sourced>A month. Each square’s area is its price.</Sourced>
  </div>
}

function Months() {
  const [at, setAt] = useState(1)
  return <>
    <Ask at={at} onChange={setAt} />
    <Stack at={at} className="hx1d-hero">{row => <>
      <h1>One month of Mailchimp pays for <b>{months(row)} months</b> of Nightmail</h1>
      <div className="hx1d-plot" style={{ '--share': share(row) } as CSSProperties}>
        <p className="hx1d-theirs"><i aria-hidden="true" /><span>{theirs(row)}</span>a month on Mailchimp {row.plan}</p>
        <p className="hx1d-ours"><span className="hx1d-tiles" aria-hidden="true">{Array.from({ length: months(row) }, (_, month) => <i key={month} />)}</span><span>{ours(row)}</span>a month on Nightmail</p>
      </div>
    </>}</Stack>
    <Sourced />
  </>
}

function Field() {
  const [at, setAt] = useState(1)
  const row = ROWS[at]!
  return <>
    <div className="hx1e-field">
      <h1>Under a tenth of Mailchimp’s price</h1>
      <Stack at={at} className="hx1e-pair">{row => <>
        <p className="hx1e-ours"><b>{ours(row)}</b><span>a month on Nightmail</span></p>
        <p className="hx1e-theirs"><b>{theirs(row)}</b><span>on Mailchimp {row.plan}</span></p>
      </>}</Stack>
      <div className="hx1e-bar" style={{ '--share': share(row) } as CSSProperties} aria-hidden="true"><i /></div>
      <Ask at={at} onChange={setAt} />
    </div>
    <Sourced />
  </>
}

export function MailchimpHero({ take }: { take: HeroTake }) {
  return <div className={`hx hx${take}`}>
    {take === '1a' ? <Statement /> : take === '1b' ? <Saving /> : take === '1c' ? <Area /> : take === '1d' ? <Months /> : <Field />}
    <Close />
    <SmallPrint />
  </div>
}
