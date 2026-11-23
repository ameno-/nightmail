import type { CSSProperties } from 'react'

/** Split-flap tiles, as the comparison's feature cards (features.tsx) show figures: a tile a character, padded to a
 *  fixed count so nothing changes size; a tile whose character changes flips over to it. Styled by board.css
 *  (.cb-flap). The board's own tiles turn as a real split-flap board's do (splitflap.tsx). */
export function Flaps({ text, width, end, className }: { text: string; width: number; end?: boolean; className: string }) {
  const chars = (end ? text.padStart(width) : text.padEnd(width)).toUpperCase().split('')
  return <span className={`cb-flaps ${className}`} aria-hidden="true">{chars.map((ch, i) =>
    <span key={`${i}:${ch}`} className="cb-flap" style={{ '--i': i } as CSSProperties} data-blank={ch === ' ' || undefined}><span>{ch}</span></span>)}</span>
}
