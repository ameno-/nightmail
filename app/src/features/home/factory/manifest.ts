// What the factory's renders are (manifest.json, written with them: it is replaced, not edited, when they are made
// again). The frame is `width` × `height` pixels; every position here is in its pixels. The hall (bg) and the
// machine (fg) are one segment's two videos, `frames` long at `fps`, each starting and ending on the picture the
// poster is. `loop` segments make up the page's ordinary running, `rare` ones are the occasional event; a segment
// with `then` is always followed by that one, which has `after` and never plays alone (burst, then rebuild: one
// event). `bg` and `fg` name the segment whose files a layer is (rush's hall is steady's, convoy's machine is
// steady's). `boardLight`, where the hall dims, is the billboards' brightness frame by frame (1 is as lit as ever).
// The billboards are sprites at twice the frame's resolution that the page moves along their rail at
// `speedPxPerSec`, `gapPx` apart, each at its `y` (its top edge: the hanger on the rail, over the board's face) and
// `w` × `h` where the manifest says (else half its sprite's size); `button` is the blank plate on the machine's front
// that the page writes its button on; `pipes` are the plinth's pipes the section under the hero carries on (on a
// phone two are `offFrame`, just outside the picture's sides, and three `hidden` behind the button's console).
// There are two formats: a desktop's 1920 × 1080 frame and a phone's 1080 × 1920 (a camera and a front of its own).
import desktop from './manifest.json'
import phone from './phone/manifest.json'

export type Format = 'desktop' | 'phone'
export type Segment = { name: string; kind: 'loop' | 'rare'; frames: number; bg?: string; fg?: string; then?: string; after?: string; boardLight?: number[] }
export type Box = { x: number; y: number; w: number; h: number }
export type Pipe = { label: string; x: number; w: number; yEnd: number; hidden?: boolean; offFrame?: boolean }
export type Manifest = {
  fps: number; loopFrames: number; width: number; height: number
  boards: { speedPxPerSec: number; gapPx: number; y: number[]; w?: number[]; h?: number[]; files?: string[]; periodPx?: number }
  button: Box
  segments: Segment[]
  /** The plinth's labelled pipes, left to right: each one's centre and width, and the row where it goes into the floor. */
  pipes?: Pipe[]
}

/** The layouts bundled with the page: what its first paint is laid out from (frame, button, boards, pipes, poster). */
export const MANIFESTS: Record<Format, Manifest> = { desktop: desktop as Manifest, phone: phone as Manifest }

// What plays comes from the renders' host, not the bundle: each render set is uploaded under its own version, both
// formats in it (`<media>/<version>/desktop/...` and `.../phone/...`, never changed afterwards), and
// `<media>/current.json` names the version the page plays, with each format's manifest. Publishing or replacing
// segments is an upload and a new current.json (app/scripts/factory-media.mjs); only a set whose layout differs from the
// bundle's needs a deploy, and until it has one the page keeps its poster.
const layout = (m: Manifest) => JSON.stringify([m.fps, m.width, m.height, m.button, m.boards.speedPxPerSec, m.boards.gapPx, m.boards.y, m.boards.w, m.boards.h, m.boards.periodPx, (m.pipes ?? []).map(pipe => [pipe.x, pipe.w])])

/** The set to play from `media` (its base URL, ending in a slash) in `format`: where its files are and its manifest. Null
 *  where there is none, it cannot be read, or its layout is not the one this page was built with. */
export async function published(media: string, format: Format): Promise<{ base: string; manifest: Manifest } | null> {
  try {
    const root = new URL(media, location.href), response = await fetch(new URL('current.json', root), { credentials: 'omit' })
    if (!response.ok) return null
    const current = await response.json() as { version?: unknown; formats?: Partial<Record<Format, Manifest>> }, set = current.formats?.[format]
    if (typeof current.version !== 'string' || !/^[\w.-]+$/.test(current.version) || !set || !Array.isArray(set.segments) || !set.segments.length || layout(set) !== layout(MANIFESTS[format])) return null
    return { base: new URL(`${current.version}/${format}/`, root).href, manifest: set }
  } catch { return null }
}
