import type { CSSProperties } from 'react'
// (With its extension: the build's config imports this file too, home-shell.ts.)
import type { Format, Manifest } from './factory/manifest.ts'

// Which frame a window gets, where it stands on its stage and the button on it: the numbers factory-home.css places them
// from, for the page (factory-home.tsx) and for its first screen before the page's code (home-shell.ts, home.html).

// Which homepage a window gets, by its shape alone (not its width, its pointer or what it is): an upright one (a phone,
// a tablet held upright, a tall narrow window) the factory in its tall frame, and every other the factory in its wide
// frame, from a phone on its side to an ultrawide monitor. Upright is as upright as the tall frame covers with its
// boards and button in view, over the strip under the stage: a little less upright the shorter the window is.
export const UPRIGHT = '(max-aspect-ratio: 79/100) and (min-height: 1100px), (max-aspect-ratio: 77/100) and (min-height: 800px), (max-aspect-ratio: 3/4) and (min-height: 600px), (max-aspect-ratio: 7/10)'

// What must be seen at any window's shape, in the frame's pixels (factory-home.css places the frame from these).
// Desktop: from the top of the boards' faces (a sprite's top third is its hanger) to a little under the button, and
// across, the boards where the poster has them (the sprites, about the middle), so a board is never cut off while it
// stands still. The frame covers the stage, cropped about the middle of that, and the stage is never taller than the
// frame shows that whole width: a window more upright than that has the page under the hero, not bands over and under
// the picture. Only a window wider than the frame can cover (an ultrawide, or a phone on its side) shows it smaller,
// on the page's own floor either side. And the stage's foot is never below the floor line, where the plinth's pipes go
// into the hall's floor (`--fac-floor`), so the picture never ends on bare floor.
// Phone: the button stands on its own console on the floor in front of the plinth, below the floor line. The stage's
// foot (`--fac-cut`) is a strip of floor under the console: as much as burst's letters land on (they pile up there and
// fly home in rebuild); the rest of the floor is cut off (the renders allow the bottom tenth). What signing in agrees to
// stands directly under it. Seen from just over the boards' faces (a phone sprite's hanger is its top seventh) down to
// that foot, and the middle 76% of the width (all the renders keep what must be read inside it); a window a little
// less upright than that covers keeps the frame as large and has less of the strip, down to just under the console,
// before it is shown smaller.
export const pct = (value: number, of: number) => `${value / of * 100}%`
export function frameOf(m: Manifest, format: Format) {
  const faces = Math.min(...m.boards.y.map((y, k) => y + (m.boards.h?.[k] ?? 0) / (format === 'phone' ? 7 : 3)))
  const button = { left: pct(m.button.x, m.width), top: pct(m.button.y, m.height), width: pct(m.button.w, m.width), height: pct(m.button.h, m.height) }
  // (The button's label, in the frame's pixels: as tall as the plate is made for; and the plate's width, which it never overruns.)
  const label = { '--fac-label': format === 'phone' ? 40 : 19, '--fac-plate': m.button.w }
  if (format === 'phone') {
    const safeTop = faces - 8, cut = m.button.y + m.button.h + 72, cutMin = m.button.y + m.button.h + 24
    return { button, vars: { '--fac-w': m.width, '--fac-h': m.height, '--fac-safe-top': safeTop, '--fac-safe-h': cutMin - safeTop, '--fac-safe-w': m.width * .76, '--fac-cut': cut, ...label } as CSSProperties }
  }
  // (Board k stands k gaps along its rail in the poster: factory/player.ts.)
  const safeTop = faces - 16, safeBottom = m.button.y + m.button.h + 40, floor = Math.min(m.height, ...(m.pipes ?? []).map(pipe => pipe.yEnd))
  const still = m.boards.y.map((_, k) => [k * m.boards.gapPx - (m.boards.w?.[k] ?? 0), k * m.boards.gapPx]).filter(([from, to]) => to > 0 && from < m.width)
  const safeW = Math.max(1120, ...still.map(([from, to]) => 2 * Math.max(m.width / 2 - from, to - m.width / 2)))
  return { button, vars: { '--fac-w': m.width, '--fac-h': m.height, '--fac-safe-h': safeBottom - safeTop, '--fac-safe-w': safeW, '--fac-mid': (safeTop + safeBottom) / 2, '--fac-floor': floor, ...label } as CSSProperties }
}
