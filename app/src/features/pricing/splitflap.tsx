import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flap } from './sound'

// The board's split-flap tiles (board.tsx) and how they turn: as a real split-flap board's do. Each tile carries one
// drum (DRUM) and only ever turns forward: when its character changes it flips through the few flaps before its new
// one, each flap in two halves either side of the hinge (the old character's upper half falls over, then the new one's
// lower half falls onto the stop), and settles on its own, the board rippling left to right. A change while a tile is
// turning only retargets it, so a fader dragged fast never queues up turns. Each flap that lands asks for its own tick
// (sound.ts, flap): a big price tile's fall is a little slower and its tick lower and fuller than a small one's. The
// page opens on one settle from blank; with reduced motion a changed tile fades to its new character instead. The tiles
// are decorative (aria-hidden): the board's own text reads out what they say.

/** A tile's drum, in the order its flaps come round: the blank, the letters, the figures, the signs. */
const DRUM = ` ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890!@#$()-+&=;:'"%,./?`
const N = DRUM.length
const at = (ch: string) => Math.max(0, DRUM.indexOf(ch))
const ahead = (from: string, to: string) => (at(to) - at(from) + N) % N
const rnd = (n: number) => Math.random() * n

/** A tile's size: how long a flap takes to fall (ms, and how much it varies) and the pitch of its tick. */
export type Size = 'small' | 'name' | 'big'
const SIZES: Record<Size, { fall: number; vary: number; pitch: number }> = { small: { fall: 56, vary: 18, pitch: 1 }, name: { fall: 64, vary: 18, pitch: .86 }, big: { fall: 78, vary: 18, pitch: .7 } }

/** A half's face. (Its text node is kept and only its text changes: adding and removing nodes would have the page's
 *  :has() rules look again at everything above it, every frame.) */
function paint(half: HTMLElement, ch: string) {
  const node = half.firstChild!.firstChild as Text, blank = ch === ' '
  if ((half.dataset.blank !== undefined) !== blank) { if (blank) half.dataset.blank = ''; else delete half.dataset.blank }
  if (node.data !== ch) node.data = ch
}
const Half = ({ k, ch }: { k: string; ch: string }) => <span className={`fl-h ${k}`} data-blank={ch === ' ' || undefined}><b>{ch}</b></span>

type Tile = { el: HTMLElement; t: HTMLElement; b: HTMLElement; f: HTMLElement; k: HTMLElement; x: number
  shown: string; target: string; left: number; next: number; land: number; lap: boolean; loud: boolean; anim: Animation[] | null }
type How = 'change' | 'settle' | 'refresh'
// A flap's fall in its two halves, each turned about the hinge in its own perspective (about five characters away), so
// nothing is 3D while the tiles are still; both gather speed as they fall.
const DOWN: Keyframe[] = [{ transform: 'perspective(5em) rotateX(0deg)' }, { transform: 'perspective(5em) rotateX(-90deg)' }]
const LAND: Keyframe[] = [{ transform: 'perspective(5em) rotateX(90deg)' }, { transform: 'perspective(5em) rotateX(0deg)' }]

/** A row's tiles and their clock (a frame loop that runs only while a tile is turning). `x`: where the row's first
 *  and last tiles are across the board (0 to 1), and `row` how far down, for the ripple. */
class Drums {
  tiles: Tile[]
  frame = 0
  constructor(root: HTMLElement, shown: string[], x: [number, number], readonly row: number, readonly size: Size) {
    const els = [...root.querySelectorAll<HTMLElement>('.fl')]
    this.tiles = els.map((el, i) => {
      const [t, b, f, k] = el.children as unknown as HTMLElement[]
      return { el, t: t!, b: b!, f: f!, k: k!, x: x[0] + (x[1] - x[0]) * (els.length > 1 ? i / (els.length - 1) : 0),
        shown: shown[i]!, target: shown[i]!, left: 0, next: 0, land: 0, lap: false, loud: false, anim: null }
    })
  }
  aim(chars: string[], how: How, loud: boolean, reduced: boolean) {
    const now = performance.now()
    chars.forEach((ch, i) => {
      const s = this.tiles[i]
      if (!s) return
      if ((s.el.dataset.blank !== undefined) !== (ch === ' ')) { if (ch === ' ') s.el.dataset.blank = ''; else delete s.el.dataset.blank }
      const turning = s.anim !== null || s.shown !== s.target || s.lap
      if (how !== 'refresh' && ch === s.target) return
      s.target = ch; s.loud = loud
      if (reduced) {
        if (s.shown === s.target && how !== 'refresh') return
        this.stop(s); s.shown = s.target; paint(s.t, s.shown); paint(s.b, s.shown)
        for (const half of [s.t, s.b]) half.animate([{ opacity: .25 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' })
        if (loud) flap(rnd(120), SIZES[this.size].pitch)
        return
      }
      if (turning) { s.left = 2 + Math.floor(rnd(3)); return }
      if (s.shown === s.target && how !== 'refresh') return
      // How many flaps it shows on the way (a real drum turns through every one; this is the board in miniature), and
      // when it starts: left to right across the board, a row a little after the one above, with a little chance.
      s.left = how === 'change' ? 3 + Math.floor(rnd(3)) : 4 + Math.floor(rnd(6))
      s.lap = s.shown === s.target
      s.next = now + (how === 'change' ? s.x * 130 + this.row * 16 + rnd(45) : how === 'settle' ? s.x * 380 + this.row * 60 + rnd(160) : s.x * 300 + this.row * 40 + rnd(90))
    })
    if (!reduced) this.run()
  }
  stop(s: Tile) { this.land(s); s.left = 0; s.lap = false }
  land(s: Tile) { if (!s.anim) return; for (const a of s.anim) a.cancel(); s.anim = null; s.f.style.visibility = s.k.style.visibility = '' }
  // One flap over: the old character's upper half falls away over the new one's, and the new one's lower half falls
  // down over the old one's.
  step(s: Tile, now: number) {
    const d = ahead(s.shown, s.target) || (s.lap ? N : 0)
    s.lap = false
    if (!d) return
    const left = Math.max(1, s.left), next = d <= left ? DRUM[(at(s.shown) + 1) % N]! : DRUM[(at(s.target) - left + 1 + N) % N]!
    s.left = Math.min(left - 1, ahead(next, s.target))
    paint(s.t, next); paint(s.b, s.shown); paint(s.f, s.shown); paint(s.k, next)
    s.f.style.visibility = s.k.style.visibility = 'visible'
    const { fall, vary } = SIZES[this.size], half = (fall + rnd(vary)) / 2
    s.anim = [s.f.animate(DOWN, { duration: half, easing: 'cubic-bezier(.55, 0, 1, .7)', fill: 'forwards' }),
      s.k.animate(LAND, { duration: half, delay: half, easing: 'cubic-bezier(.45, 0, 1, 1)', fill: 'both' })]
    s.land = now + half * 2; s.shown = next
  }
  run() { if (!this.frame) this.frame = requestAnimationFrame(this.tick) }
  tick = () => {
    this.frame = 0
    const now = performance.now()
    let busy = false
    for (const s of this.tiles) {
      if (s.anim && now >= s.land) { paint(s.b, s.shown); this.land(s) }
      if (!s.anim && (s.shown !== s.target || s.lap) && now >= s.next) { this.step(s, now); if (s.loud && s.anim) flap(s.land - now, SIZES[this.size].pitch) }
      if (s.anim || s.shown !== s.target || s.lap) busy = true
    }
    if (busy) this.run()
  }
  dispose() { cancelAnimationFrame(this.frame); this.frame = 0; for (const s of this.tiles) this.land(s) }
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** A row of tiles: `text` padded to `width` (at its end with `end`), so nothing changes size. It opens blank and
 *  settles (`settle`; heard only with `sound`, when the reader brought this board up), or opens on its text; a new
 *  `text` turns the tiles that change, with their sound, and a new `refresh` turns every one, as if the board were sent
 *  its message again. Styled by board.css (.fl). */
export const FlapRow = memo(function FlapRow({ text, width, end, className, size = 'small', x = [0, 1], row = 0, settle, refresh, sound }: {
  text: string; width: number; end?: boolean; className: string; size?: Size; x?: [number, number]; row?: number; settle?: boolean; refresh?: number; sound?: boolean }) {
  const chars = useMemo(() => (end ? text.padStart(width) : text.padEnd(width)).toUpperCase().split(''), [text, width, end])
  const ref = useRef<HTMLSpanElement>(null), drums = useRef<Drums | null>(null), opened = useRef(false), refreshed = useRef(refresh)
  // (The tiles are drawn once, as they open; after that the drums own what they show.)
  const [first] = useState(() => chars.map(ch => settle ? ' ' : ch))
  useLayoutEffect(() => {
    const board = new Drums(ref.current!, first, x, row, size)
    drums.current = board
    return () => board.dispose()
  }, [first]) // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    drums.current!.aim(chars, opened.current ? 'change' : 'settle', opened.current || !!sound, reducedMotion())
    opened.current = true
  }, [chars])
  useEffect(() => {
    if (refresh === refreshed.current) return
    refreshed.current = refresh
    drums.current?.aim(chars, 'refresh', true, reducedMotion())
  }, [refresh, chars])
  const drawn = useMemo(() => first.map((ch, i) => <span key={i} className="fl" data-blank={ch === ' ' || undefined}>
    <Half k="fl-t" ch={ch} /><Half k="fl-b" ch={ch} /><Half k="fl-f" ch={ch} /><Half k="fl-k" ch={ch} />
  </span>), [first])
  return <span ref={ref} className={`cb-flaps ${className}`} aria-hidden="true">{drawn}</span>
})
