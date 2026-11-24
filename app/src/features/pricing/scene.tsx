import { BoardEnd, ComparisonBelow, ComparisonBoard, Hall, type Start } from './board'
import { PricingBoard } from './calculator'
import type { Comparison } from './prices'

// The price pages' scene: the hall (board.tsx) with the page's board in it, the calculator's (calculator.tsx) or a
// comparison's. The hall stays as the reader moves between the three; the board is drawn anew for each page and its
// tiles settle into place, heard when the reader moved there. (No styles imported here, so the pre-merge check can
// render it: board-page.tsx brings board.css.)
export function Scene({ comparison: c, start, frame }: { comparison?: Comparison | null; start?: Start; frame?: string | null }) {
  const page = c ? c.offer.id : 'pricing'
  return <Hall page={page} frame={frame} below={c && <ComparisonBelow key={page} comparison={c} start={start} />}>
    {c ? <ComparisonBoard key={page} comparison={c} start={start} /> : <PricingBoard key={page} start={start} />}
  </Hall>
}
export { BoardEnd }
