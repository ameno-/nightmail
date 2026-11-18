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
// that the page writes its button on.
import data from './manifest.json'

export type Segment = { name: string; kind: 'loop' | 'rare'; frames: number; bg?: string; fg?: string; then?: string; after?: string; boardLight?: number[] }
export type Box = { x: number; y: number; w: number; h: number }
export type Manifest = {
  fps: number; loopFrames: number; width: number; height: number
  boards: { speedPxPerSec: number; gapPx: number; y: number[]; w?: number[]; h?: number[]; files?: string[]; periodPx?: number }
  button: Box
  segments: Segment[]
}

export const MANIFEST = data as Manifest
