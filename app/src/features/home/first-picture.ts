import desktopPoster from './factory/poster.jpg'
import desktopPoster1280 from './factory/poster-1280.jpg'
import phoneBare from './factory/phone/poster-bare.jpg'
import phoneBare828 from './factory/phone/poster-bare-828.jpg'
import phoneBoard0 from './factory/phone/board0.webp'
import phoneBoard1 from './factory/phone/board1.webp'
import phoneBoard2 from './factory/phone/board2.webp'
import type { Format } from './factory/manifest'

// The homepage's first picture, apart from the page's code so the app can start loading it before that code arrives
// (App.tsx, beside the session check): which frame a window gets, and its poster.

// Which homepage a window gets, by its shape alone (not its width, its pointer or what it is): an upright one (a phone,
// a tablet held upright, a tall narrow window) the factory in its tall frame, and every other the factory in its wide
// frame (factory-home.tsx), from a phone on its side to an ultrawide monitor. Upright is as upright as the tall frame
// covers with its boards and button in view, over the strip under the stage: a little less upright the shorter the
// window is. `?home=` shows one anywhere: `phone`, `desktop`, or `sorter` (sorter-home.tsx, the machine the page had
// before the renders; og.png is still its card).
export const UPRIGHT = '(max-aspect-ratio: 79/100) and (min-height: 1100px), (max-aspect-ratio: 77/100) and (min-height: 800px), (max-aspect-ratio: 3/4) and (min-height: 600px), (max-aspect-ratio: 7/10)'
export type Shown = Format | 'sorter'
const forced = () => { const home = new URLSearchParams(location.search).get('home'); return home === 'sorter' || home === 'phone' || home === 'desktop' ? home : null }
export const shown = (): Shown => forced() ?? (matchMedia(UPRIGHT).matches ? 'phone' : 'desktop')

// Each poster at two sizes, the smaller where the frame is shown no wider than it has pixels for: the frame is about the
// window's width (`sizes`), a little wider where it covers a squarer one.
export const POSTERS: Record<Format, { src: string; srcSet: string }> = {
  desktop: { src: desktopPoster, srcSet: `${desktopPoster1280} 1280w, ${desktopPoster} 1920w` },
  phone: { src: phoneBare, srcSet: `${phoneBare828} 828w, ${phoneBare} 1080w` },
}
export const POSTER_SIZES = '100vw'
/** A phone's boards, hung in turn (factory-home.tsx): the first is in the first picture. */
export const STILL_SPRITES = [phoneBoard0, phoneBoard1, phoneBoard2], STILL_BOARDS = [1, 2, 0]

/** Starts loading the first picture this window is shown, ahead of the page that shows it. */
export function preloadFirstPicture() {
  const format = shown()
  if (format === 'sorter') return
  const link = (href: string, srcSet?: string) => {
    const tag = document.createElement('link')
    tag.rel = 'preload'; tag.as = 'image'; tag.href = href; tag.fetchPriority = 'high'
    if (srcSet) { tag.setAttribute('imagesrcset', srcSet); tag.setAttribute('imagesizes', POSTER_SIZES) }
    document.head.append(tag)
  }
  link(POSTERS[format].src, POSTERS[format].srcSet)
  if (format === 'phone') link(STILL_SPRITES[STILL_BOARDS[0]])
}

/** Runs `then` once the hero's poster has loaded (or failed), so what is fetched for later does not slow it down; the
 *  returned function calls it off. */
export function afterFirstPicture(then: () => void) {
  const poster = document.querySelector<HTMLImageElement>('.fac-poster')
  if (!poster || poster.complete) { then(); return () => {} }
  const stop = new AbortController()
  for (const event of ['load', 'error']) poster.addEventListener(event, () => { stop.abort(); then() }, { signal: stop.signal })
  return () => stop.abort()
}
