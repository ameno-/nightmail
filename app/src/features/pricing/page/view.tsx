import { useMemo } from 'react'
import type { Comparison } from '../prices'
import { comparisonDoc } from './comparison'
import { hubDoc } from './hub'
import { PriceCard, PricePageView } from './page'
import { Television } from './set'
import '../../home/tv/tv.css'
import './page.css'

// The public price pages drawn by page.tsx, as the app shows them at their addresses (index.tsx: reached from another
// of the app's pages; a page opened from its address is its own HTML, app/price-pages.ts), with their styles: page.css,
// and the television's (home/tv/tv.css) for the airmail label and the set. ?card draws the page's link-preview picture
// instead (scripts/price-cards.mjs photographs it).

export function ComparisonView({ comparison, card }: { comparison: Comparison; card?: boolean }) {
  const doc = useMemo(() => comparisonDoc(comparison), [comparison])
  return card ? <PriceCard doc={doc} /> : <PricePageView doc={doc} />
}
/** /compare: with the television over it (set), or without. */
export function HubView({ set, card }: { set?: boolean; card?: boolean }) {
  const doc = useMemo(hubDoc, [])
  return card ? <PriceCard doc={doc} /> : <PricePageView doc={doc} set={set ? <Television doc={doc} /> : undefined} />
}
