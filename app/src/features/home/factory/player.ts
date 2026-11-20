// The factory's player: the hall (bg, opaque) and the machine standing in it (fg, with alpha) are two videos of one
// segment, and between them the billboards ride their rail. The hall's video is the one clock: the machine's follows
// it frame for frame (its rate nudged a few percent, or a seek where it has fallen far behind), and either one
// waiting for data holds both. A segment plays to its end and the next starts as it ends; every segment starts and
// ends on the poster's picture, so the cut is not seen. The next segment's two videos load in a second pair of
// elements while this one plays; one that will play again straight away loops instead. The boards keep their own,
// slower time and move on the compositor. Where the hall dims the boards dim with it, and where the plinth does the
// page's tags on its labels. Nothing here makes a sound.
import type { Manifest, Segment } from './manifest'

export type AlphaFormat = 'hevc' | 'webm'

/** The foreground file this browser shows with its alpha: WebKit (Safari, and every browser on iOS) decodes HEVC's
 *  alpha and draws a WebM's as black; every other engine shows VP9's. Null where neither plays (the poster stays). */
export function alphaFormat(): AlphaFormat | null {
  const probe = document.createElement('video')
  if (navigator.vendor.startsWith('Apple')) return probe.canPlayType('video/mp4; codecs="hvc1"') ? 'hevc' : null
  return probe.canPlayType('video/webm; codecs="vp09.00.10.08"') || probe.canPlayType('video/webm; codecs="vp9"') ? 'webm' : null
}

/** The order segments play in. The first loop segment is the machine's ordinary running, and plays between every two
 *  others; those are the other loop segments in a shuffled turn, with a rare one in place of every fourth (each rare
 *  one once before any comes round again). A segment's `then` always comes straight after it, and it and any
 *  segment marked `after` are never picked on their own. */
export function schedule(segments: Segment[], random = Math.random) {
  const named = new Map(segments.map(segment => [segment.name, segment]))
  const followers = new Set(segments.flatMap(segment => [...segment.then && named.has(segment.then) ? [segment.then] : [], ...segment.after ? [segment.name] : []]))
  const free = segments.filter(segment => !followers.has(segment.name))
  const home = free.find(segment => segment.kind === 'loop') ?? free[0] ?? segments[0]
  const events = free.filter(segment => segment.kind === 'loop' && segment !== home), rares = free.filter(segment => segment.kind === 'rare' && segment !== home)
  const shuffled = (list: Segment[]) => { const out = [...list]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]] } return out }
  let turn: Segment[] = [], rareTurn: Segment[] = [], count = 0
  return {
    first: home,
    after(segment: Segment): Segment {
      const then = segment.then ? named.get(segment.then) : undefined
      if (then) return then
      if (segment !== home) return home
      count++
      if (rares.length && (count % 4 === 0 || !events.length)) { if (!rareTurn.length) rareTurn = shuffled(rares); return rareTurn.pop()! }
      if (!events.length) return home
      if (!turn.length) turn = shuffled(events)
      return turn.pop()!
    },
  }
}

type Deck = { bg: HTMLVideoElement; fg: HTMLVideoElement; segment: Segment | null; ready: boolean; loading: AbortController | null }
export type Player = { setShown(shown: boolean): void; destroy(): void }
export type Layers = { stage: HTMLElement; bg: HTMLElement; boards: HTMLElement; fg: HTMLElement; tags?: HTMLElement }

/** Starts the factory in `layers` once the first segment and the boards can play; until then (and for good, where
 *  they cannot: `failed` is called) the page's poster is what is seen. `base` is where the renders are, ending in a
 *  slash; `height` which of their sizes. With `rail: false` the boards aren't put on the rail: the page hangs its own
 *  in `layers.boards`, which only dims with the hall. The stage gets `data-playing` when the videos are up. */
export function mountPlayer(layers: Layers, { base, manifest: m, format, height, failed, rail: onRail = true }: { base: string; manifest: Manifest; format: AlphaFormat; height: 720 | 1080; failed?: () => void; rail?: boolean }): Player {
  const order = schedule(m.segments), frame = 1 / m.fps
  // (A layer one segment shares with another is the other's file: rush's hall is steady's bg-1080.mp4, so it is
  // downloaded once.)
  const url = (segment: Segment, layer: 'bg' | 'fg') => new URL(layer === 'bg' ? `${segment.bg ?? segment.name}/bg-${height}.mp4`
    : `${segment.fg ?? segment.name}/${format === 'hevc' ? `fg-${height}-hevc.mov` : `fg-${height}.webm`}`, new URL(base, location.href)).href
  const video = (parent: HTMLElement) => {
    const v = document.createElement('video')
    v.muted = true; v.defaultMuted = true; v.playsInline = true; v.preload = 'auto'; v.disablePictureInPicture = true; v.tabIndex = -1
    v.setAttribute('playsinline', ''); v.setAttribute('aria-hidden', 'true'); v.className = 'fac-video'
    parent.append(v)
    return v
  }
  const decks: Deck[] = [0, 1].map(() => ({ bg: video(layers.bg), fg: video(layers.fg), segment: null, ready: false, loading: null }))
  const both = (deck: Deck) => [deck.bg, deck.fg]
  let active = 0, upcoming: Segment | null = null, started = false, shown = true, destroyed = false, swapping = false, raf = 0, last = 0, light = 1, labelLight = 1
  // A layer lit `level` (1 is as lit as ever), set only when it changes.
  const dim = (layer: HTMLElement | undefined, level: number, was: number) => { if (layer && level !== was) layer.style.filter = level === 1 ? '' : `brightness(${level})`; return level }

  // The boards: each a sprite on a rail as wide as the frame, slid by the rail's transform from just off the frame's
  // left edge across it and off its right (`gapPx` times the number of boards in all), the next one `gapPx` behind.
  // The first picture is the poster's: board k starts k gaps along.
  const W = m.width, H = m.height, { speedPxPerSec: speed, gapPx: gap } = m.boards, period = m.boards.periodPx ?? gap * m.boards.y.length
  const boards = (onRail ? m.boards.y : []).map((y, k) => {
    const rail = document.createElement('div'), img = document.createElement('img')
    rail.className = 'fac-rail'; img.className = 'fac-board'; img.alt = ''; img.decoding = 'async'; img.src = `${base}${m.boards.files?.[k] ?? `boards/board${k}.png`}`
    rail.append(img); layers.boards.append(rail)
    return { rail, img, y, k, motion: null as Animation | null }
  })
  const boardsReady = Promise.all(boards.map(board => board.img.decode().then(() => true, () => false))).then(loaded => {
    if (destroyed || !loaded.every(Boolean)) return false
    for (const board of boards) {
      // (A sprite is drawn at twice the frame's resolution.)
      const w = m.boards.w?.[board.k] ?? board.img.naturalWidth / 2
      board.img.style.top = `${board.y / H * 100}%`; board.img.style.width = `${w / W * 100}%`
      board.motion = board.rail.animate([{ transform: `translateX(${-w / W * 100}%)` }, { transform: `translateX(${(period - w) / W * 100}%)` }],
        { duration: period / speed * 1000, delay: -board.k * gap / speed * 1000, iterations: Infinity, easing: 'linear' })
      board.motion.pause()
    }
    return true
  })

  // A pair is ready once both can play through without waiting for data: on a slow connection the poster stays
  // rather than the videos starting and stalling.
  const playable = (v: HTMLVideoElement, signal: AbortSignal) => new Promise<boolean>(resolve => {
    if (v.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) return resolve(true)
    v.addEventListener('canplaythrough', () => resolve(true), { once: true, signal })
    v.addEventListener('error', () => resolve(false), { once: true, signal })
    signal.addEventListener('abort', () => resolve(false), { once: true })
  })
  // A video that already has the file (steady coming round again in the same pair, or the hall a segment shares with
  // the last one there) is wound back to its start rather than loaded again.
  const rewound = (v: HTMLVideoElement, signal: AbortSignal) => new Promise<boolean>(resolve => {
    v.addEventListener('seeked', () => resolve(playable(v, signal)), { once: true, signal })
    signal.addEventListener('abort', () => resolve(false), { once: true })
    v.currentTime = 0
  })
  const load = (deck: Deck, segment: Segment) => {
    deck.loading?.abort()
    const loading = deck.loading = new AbortController()
    deck.segment = segment; deck.ready = false
    return Promise.all(both(deck).map(v => {
      const src = url(segment, v === deck.bg ? 'bg' : 'fg')
      v.loop = false
      if (v.src === src && v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !v.error) return rewound(v, loading.signal)
      v.src = src
      return playable(v, loading.signal)
    })).then(ok => {
      if (loading.signal.aborted) return false
      deck.loading = null; deck.ready = ok.every(Boolean)
      return deck.ready
    })
  }
  // Resolves once `v` has put a frame up (or soon after, where it cannot say).
  const presented = (v: HTMLVideoElement) => new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 400)
    const done = () => { clearTimeout(timer); resolve() }
    if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(done)
    else requestAnimationFrame(() => requestAnimationFrame(done))
  })
  // Once a pair is shown: both its videos have put a frame up and the page has painted since. (A video turned from
  // transparent to shown can take a frame to reach the screen: until this resolves, whatever is under it shows.)
  const painted = async (deck: Deck) => {
    await Promise.all(both(deck).map(presented))
    await new Promise(next => requestAnimationFrame(() => requestAnimationFrame(next)))
  }
  // A pair is shown over the other one (`data-top`), so the one going is only uncovered by the one coming.
  const show = (deck: Deck, on: boolean) => { for (const v of both(deck)) { v.toggleAttribute('data-on', on); v.toggleAttribute('data-top', on) } }
  const hold = (deck: Deck) => { for (const v of both(deck)) if (!v.paused) v.pause() }
  const go = (deck: Deck) => {
    if (Math.abs(deck.fg.currentTime - deck.bg.currentTime) > frame) deck.fg.currentTime = deck.bg.currentTime
    for (const v of both(deck)) if (v.paused) v.play().catch(() => {})
  }

  // At the start of each time through a segment: what comes after it. The same one again loops; another is loaded
  // into the other pair. (One that has not loaded by the end is waited for while this one goes round once more.)
  const plan = () => {
    const deck = decks[active], other = decks[1 - active]
    upcoming = upcoming && upcoming !== deck.segment ? upcoming : order.after(deck.segment!)
    const again = upcoming === deck.segment
    for (const v of both(deck)) v.loop = again
    if (!again && other.segment !== upcoming) void load(other, upcoming)
    last = deck.bg.currentTime
  }
  const turn = async () => {
    const from = decks[active], to = decks[1 - active]
    if (!to.ready) {
      for (const v of both(from)) v.loop = true
      if (from.bg.ended) { for (const v of both(from)) v.currentTime = 0; go(from) }
      return
    }
    swapping = true
    to.fg.playbackRate = 1
    // The coming pair goes on over the going one (which holds the same picture), starts, and the going pair is
    // hidden only once the coming one is on the screen: there is never a frame with neither, which would show the
    // stage (or, before the poster is hidden, its boards) through.
    for (const v of both(from)) v.removeAttribute('data-top')
    show(to, true)
    await Promise.all(both(to).map(v => v.play().catch(() => {})))
    await painted(to)
    if (destroyed) return
    for (const v of both(from)) v.removeAttribute('data-on')
    hold(from)
    if (!shown) hold(to)
    active = 1 - active
    // (The pair just left is free: it loads whatever follows this segment.)
    from.segment = null; from.ready = false; upcoming = null
    swapping = false
    plan()
  }

  const tick = () => {
    raf = requestAnimationFrame(tick)
    if (!started || !shown || swapping) return
    const deck = decks[active], { bg, fg } = deck, end = deck.segment!.frames / m.fps
    // Where the hall dims, the boards dim with it, and where the plinth dims, the tags on its labels: frame by frame.
    const at = (lights: number[] | undefined) => lights ? lights[Math.min(lights.length - 1, Math.floor(bg.currentTime * m.fps))] ?? 1 : 1
    light = dim(layers.boards, at(deck.segment!.boardLight), light)
    labelLight = dim(layers.tags, at(deck.segment!.labelLight), labelLight)
    if (bg.loop) {
      // Round again: the next time through has begun.
      if (bg.currentTime < last - end / 2) plan()
      last = bg.currentTime
    } else if (bg.ended || bg.currentTime >= end - 1.5 * frame) { void turn(); return }
    if (bg.readyState < HTMLMediaElement.HAVE_FUTURE_DATA || fg.readyState < HTMLMediaElement.HAVE_FUTURE_DATA || fg.seeking) { if (!fg.seeking) hold(deck); return }
    if (bg.paused || fg.paused) { go(deck); return }
    // The machine follows the hall: how far it is ahead (across the loop's seam, the short way round).
    let drift = fg.currentTime - bg.currentTime
    if (bg.loop && Math.abs(drift) > end / 2) drift -= Math.sign(drift) * end
    if (Math.abs(drift) > .25) { fg.currentTime = (bg.currentTime + .04) % end; return }
    const rate = Math.abs(drift) < frame / 3 ? 1 : Math.min(1.08, Math.max(.92, 1 - drift * 1.5))
    if (fg.playbackRate !== rate) fg.playbackRate = rate
  }

  void (async () => {
    const first = decks[0]
    const [ok, boardsOk] = await Promise.all([load(first, order.first), boardsReady])
    if (destroyed) return
    if (!ok || !boardsOk) { failed?.(); return }
    // Muted, inline video may start by itself; where it may not (a browser's setting, a phone's low power mode), the
    // poster stays.
    const played = await Promise.all(both(first).map(v => v.play().then(() => true, () => false)))
    if (destroyed) return
    if (!played.every(Boolean)) { hold(first); failed?.(); return }
    await presented(first.bg)
    if (destroyed) return
    // The first pair and the boards come on over the poster (where the poster has the boards, so nothing moves);
    // once the pair is on the screen the poster is hidden, so its baked boards can never show through again, and
    // the boards set off.
    show(first, true)
    layers.stage.toggleAttribute('data-playing', true)
    await painted(first)
    if (destroyed) return
    layers.stage.toggleAttribute('data-live', true)
    started = true
    if (shown) for (const board of boards) board.motion?.play()
    else hold(first)
    plan()
    raf = requestAnimationFrame(tick)
  })()

  return {
    // Off screen, or in a hidden tab, everything stands still.
    setShown(next) {
      shown = next
      if (!started) return
      for (const board of boards) next ? board.motion?.play() : board.motion?.pause()
      if (!next) hold(decks[active])
    },
    destroy() {
      destroyed = true
      cancelAnimationFrame(raf)
      for (const deck of decks) { deck.loading?.abort(); for (const v of both(deck)) { v.pause(); v.removeAttribute('src'); v.load(); v.remove() } }
      for (const board of boards) { board.motion?.cancel(); board.rail.remove() }
      layers.boards.style.filter = ''
      if (layers.tags) layers.tags.style.filter = ''
      layers.stage.removeAttribute('data-playing'); layers.stage.removeAttribute('data-live')
    },
  }
}
