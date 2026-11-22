// Where the page ends: the wordmark across its whole width, enormous, cut off by the page's own edge, as a poster's
// is. It is nine solids in the machine's make, seen as the machine is seen: each letter's face is the brand's outline
// itself (lib/marks.ts: unchanged, in the brand's ink by day and its paper by night), given depth, with its top and the
// side that is seen in the machine's tones. A few of the machine's letters have come to rest on top of them.
import { DX, DY, type Inset } from './plan'
import { WORDMARK } from '../../lib/marks'
import { contours, edges } from './outline'

// Towards the machine's light, across and up the page.
const LIGHT = [.24, .8]
/** How much of the cap height stands over the page's edge. (More, and it is not cut; less, and the L loses its foot.) */
const SEEN = .86

/** The band's measures for a page `W` wide: where the wordmark begins (the page's margin, or a phone's safe area where
 * that is more), its cap height (it ends as far from the page's other side), how deep the solids are (a third of the
 * cap height and a little; on a phone, where that would leave their tops too shallow for a letter to lie on, up to six
 * tenths), where the caps' tops are, and how high the band is. */
export function endBand(W: number, phone: boolean, inset: Inset) {
  const margin = phone ? 16 : 32, left = Math.max(margin, inset.left), cap = (W - left - Math.max(margin, inset.right)) / (WORDMARK.w / WORDMARK.h), depth = Math.max(.36 * cap, Math.min(.6 * cap, 21)), over = 4
  return { left, cap, depth, top: over + DY * depth, h: Math.round(over + DY * depth + SEEN * cap) }
}

// The letters at rest on the solids: which solid's top (the G's and the T's are wide enough for two or three, the M's
// for one), how far along it and how far back (0 to 1), its turn in degrees, and which side is up. Each lies wholly
// on its top, clear of every edge of it: one that would not (a narrow page's tops are small) is left out.
const RESTING: { on: number; along: number; back: number; turn: number; face: 'flap' | 'address' }[] = [
  { on: 3, along: .2, back: .55, turn: 7, face: 'address' }, { on: 3, along: .74, back: .4, turn: -11, face: 'flap' },
  { on: 6, along: .16, back: .42, turn: -8, face: 'flap' }, { on: 6, along: .44, back: .62, turn: 12, face: 'address' }, { on: 6, along: .86, back: .5, turn: 3, face: 'flap' },
  { on: 7, along: .5, back: .5, turn: -4, face: 'address' },
]

export function EndBand({ W, phone, inset }: { W: number; phone: boolean; inset: Inset }) {
  const { left: margin, cap, depth, top, h } = endBand(W, phone, inset), k = cap / WORDMARK.h, sx = DX * depth, sy = -DY * depth
  const outline = edges(contours(WORDMARK.d, WORDMARK.h, 5))
  // The sides that are seen (the tops, and what faces left), each in the tone its facing takes from the machine's light.
  const tones = ['', '', '', '']
  for (const { a, b, n } of outline) {
    if (n[0] * DX + n[1] * DY <= 0) continue
    const nl = n[0] * LIGHT[0] + n[1] * LIGHT[1], tone = nl > .62 ? 0 : nl > .3 ? 1 : nl > .04 ? 2 : 3
    const ax = margin + a[0] * k, ay = top + cap - a[1] * k, bx = margin + b[0] * k, by = top + cap - b[1] * k
    tones[tone] += `M${ax.toFixed(2)} ${ay.toFixed(2)}L${bx.toFixed(2)} ${by.toFixed(2)}L${(bx + sx).toFixed(2)} ${(by + sy).toFixed(2)}L${(ax + sx).toFixed(2)} ${(ay + sy).toFixed(2)}Z`
  }
  // Each solid's flat top, left to right: where a letter can lie. A letter is a little over half as deep as the top.
  const tops = outline.filter(({ a, b }) => a[1] === WORDMARK.h && b[1] === WORDMARK.h).map(({ a, b }) => [Math.min(a[0], b[0]) * k, Math.max(a[0], b[0]) * k]).sort((a, b) => a[0] - b[0])
  const lh = .55 * depth, lw = lh / .7, edge = 3
  const resting = lh < 9 ? [] : RESTING.flatMap(({ on, along, back, turn, face }) => {
    const [x0, x1] = tops[on], rad = turn * Math.PI / 180, across = (lw * Math.abs(Math.cos(rad)) + lh * Math.abs(Math.sin(rad))) / 2 + edge, deep = (lw * Math.abs(Math.sin(rad)) + lh * Math.abs(Math.cos(rad))) / 2 + edge
    if (2 * across > x1 - x0 || 2 * deep > depth) return []
    return [{ x: Math.min(x1 - across, Math.max(x0 + across, x0 + along * (x1 - x0))), z: Math.min(depth - deep, Math.max(deep, back * depth)), turn, face }]
  })
  // (Two on one top never lie over one another's middle: the later of a pair that would is left out.)
  const lying = resting.filter((letter, i) => resting.slice(0, i).every(other => Math.hypot(other.x - letter.x, other.z - letter.z) > lw * .72))
  return <>
    <svg className="srt-band-end" style={{ bottom: inset.bottom }} width={W} height={h} viewBox={`0 0 ${W} ${h}`} role="img" aria-label="Nightmail">
      {[3, 2, 1, 0].map(tone => <path key={tone} className={`srt-solid srt-solid-${tone}`} d={tones[tone]} />)}
      <path className="srt-solid-face" d={WORDMARK.d} transform={`translate(${margin} ${top}) scale(${k})`} />
      {lying.map(({ x, z, turn, face }, i) =>
        // Drawn lying flat (across the page, and back from the solid's front edge), then seen as the machine's roof is seen.
        <g key={i} className="srt-rest" transform={`matrix(1 0 ${DX} ${-DY} ${(margin + x).toFixed(2)} ${top.toFixed(2)}) translate(0 ${z.toFixed(2)}) rotate(${turn})`}>
          <rect className="srt-rest-shade" x={-lw / 2 - 2} y={-lh / 2 + 1.5} width={lw} height={lh} />
          <rect x={-lw / 2} y={-lh / 2} width={lw} height={lh} />
          {face === 'flap' ? <path d={`M${-lw / 2} ${lh / 2}L0 ${-lh * .08}L${lw / 2} ${lh / 2}`} />
            : <><rect className="srt-rest-stamp" x={lw * .24} y={lh * .1} width={lh * .3} height={lh * .3} /><path d={`M${-lw * .36} ${-lh * .02}H${lw * .02}M${-lw * .36} ${-lh * .16}H${-lw * .06}M${-lw * .36} ${-lh * .3}H${-lw * .12}`} /></>}
        </g>)}
    </svg>
    {/* Where a phone keeps a strip along its bottom for itself (its home indicator), the solids stand behind a sill as
        high as that strip, in the machine's make, and are cut by its top instead. */}
    {inset.bottom > 0 && <span className="srt-band-sill" style={{ height: inset.bottom }} aria-hidden="true" />}
  </>
}
