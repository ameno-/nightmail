import { useState, type CSSProperties } from 'react'
import { Ours } from './content'
import { headline, ROWS, SmallPrint, Sourced, TryNumbers, type Row } from './mailchimp'
import { comparisons, formatCount, money } from './prices'

// Three compositions of the Mailchimp page, for one to be chosen: /compare/mailchimp?take=1, 2 and 3 (without the
// parameter the page is mailchimp.tsx). The same facts in each: the comparison's three sizes, Mailchimp's price and
// Nightmail's at each, the emails a month behind them, the dated source line and the closed small print. Headings and
// words are Inter; figures in a picture stay in the data font. Mailchimp is named in text and drawn in the product's
// second data colour, Nightmail in the data navy.
//   1. the number as the hero: one size's two prices, huge, on one scale, and the three sizes as a row to choose from;
//   2. three panels, one a size: two columns each, the prices on top;
//   3. a headline beside horizontal bars, a size to a group, the price at the end of each bar.
// In 2 and 3 each size is drawn to its own scale (Mailchimp's bar is the whole, Nightmail's its share), so no size is a
// sliver beside the largest, and the line under the picture says so.

const c = comparisons.mailchimp
/** Nightmail's price as a share of Mailchimp's at the same size. */
const share = (row: Row) => ({ '--share': Number(row.ours.uc) / (row.cents * 1_000_000) }) as CSSProperties
const ours = (row: Row) => <Ours sent={row.usage.sent} received={row.usage.received}>{row.ours.text}</Ours>
/** A size and the emails a month behind its prices. (Where three sit side by side on a phone, each line breaks after its number.) */
const size = (row: Row) => <><strong>{formatCount(row.usage.contacts)} <br />contacts</strong><span>{formatCount(row.usage.sent)} emails <br />a month</span></>

/** What Nightmail has, as one sentence beside the way into the calculator. */
function Band() {
  return <div className="tk-band">
    <p className="tk-has"><strong>Nightmail has</strong> {c.summary}.</p>
    <TryNumbers />
  </div>
}

function Poster() {
  const [at, setAt] = useState(1)
  const row = ROWS[at]!
  return <>
    <h1 className="tk1-title">{headline()}</h1>
    <div className="tk1-pair" data-offer="mailchimp" aria-live="polite">
      <div>
        <p className="tk1-name"><i className="tk-key" aria-hidden="true" />Mailchimp<small>{row.plan}</small></p>
        <p className="tk1-figure">{money(row.cents)}<small>a month</small></p>
        <i className="tk1-bar" aria-hidden="true" />
      </div>
      <div>
        <p className="tk1-name"><i className="tk-key tk-key--ours" aria-hidden="true" />Nightmail</p>
        <p className="tk1-figure">{ours(row)}<small>a month</small></p>
        <i className="tk1-bar tk1-bar--ours" style={share(row)} aria-hidden="true" />
      </div>
    </div>
    <div className="tk1-sizes" role="group" aria-label="List size">
      {ROWS.map((option, index) => <button key={option.usage.contacts} type="button" aria-pressed={index === at} onClick={() => setAt(index)}>
        {size(option)}
        <span className="tk1-sizes__pair"><span className="sr-only">Mailchimp </span>{money(option.cents)}<i aria-hidden="true">→</i><span className="sr-only">Nightmail </span>{ours(option)}</span>
      </button>)}
    </div>
    <Sourced />
    <Band />
  </>
}

function Panels() {
  return <>
    <h1 className="tk-title">{headline()}</h1>
    <p className="tk2-legend" aria-hidden="true"><span><i className="tk-key" />Mailchimp</span><span><i className="tk-key tk-key--ours" />Nightmail</span></p>
    <ol className="tk2-panels">
      {ROWS.map(row => <li key={row.usage.contacts} data-offer="mailchimp">
        <p className="tk2-size">{size(row)}</p>
        <div className="tk2-cols" style={share(row)}>
          <p><b>{money(row.cents)}</b><small>{row.plan}</small><i aria-hidden="true" /><span>Mailchimp</span></p>
          <p className="tk2-cols__ours"><b>{ours(row)}</b><i aria-hidden="true" /><span>Nightmail</span></p>
        </div>
      </li>)}
    </ol>
    <Sourced>Each panel is drawn to its own scale.</Sourced>
    <Band />
  </>
}

function Bars() {
  return <>
    <div className="tk3-hero">
      <h1 className="tk-title">{headline()}</h1>
      <p className="tk-lede">For four campaigns a month to your whole list, with three teammates.</p>
      <div className="tk3-chart">
        <ol className="tk3-groups">
          {ROWS.map(row => <li key={row.usage.contacts} data-offer="mailchimp">
            <p className="tk3-size">{size(row)}</p>
            <p className="tk3-bar"><span>Mailchimp</span><i aria-hidden="true" /><b>{money(row.cents)}</b><small>{row.plan}</small></p>
            <p className="tk3-bar tk3-bar--ours" style={share(row)}><span>Nightmail</span><i aria-hidden="true" /><b>{ours(row)}</b></p>
          </li>)}
        </ol>
        <Sourced>Each size is drawn to its own scale.</Sourced>
      </div>
      <TryNumbers />
    </div>
    <section className="tk3-has" aria-labelledby="tk3-has">
      <h2 id="tk3-has">Nightmail has</h2>
      <ul>{c.ours.map(fact => <li key={fact.text}><strong>{fact.short}</strong>{fact.note && <span>{fact.note}</span>}</li>)}</ul>
    </section>
  </>
}

export function MailchimpTake({ take }: { take: '1' | '2' | '3' }) {
  return <div className={`tk tk${take}`}>
    {take === '1' ? <Poster /> : take === '2' ? <Panels /> : <Bars />}
    <SmallPrint />
  </div>
}
