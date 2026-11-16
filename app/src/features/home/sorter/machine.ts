// The sorting machine, built once from the plan as solids. It stands on a slab with a lip along its front. Its
// cabinet's front is, from the floor up: the base (the page's button stands in it), the band with the sentence, the
// sorting frame whose thousand filled pigeonholes spell the price between two manifolds and eight glass tubes, with the
// wordmark in lights at its head, the label rail, the works behind glass (a line of rollers with a drop gate and a
// chute for each lane, a scanner over the middle) and a fascia with the readout and the pressure gauge. On the roof:
// the hopper letters fall into; either side of it a slot scams are thrown out of, and at each end a laser on a pedestal
// to burn them; two chimneys, a hatch and a beacon. The tubes leave the cabinet at the floor, cross the slab and go
// over its lip. Everything that moves or can be blown off is a part.
import { ALL, Builder, unit, type V3 } from './mesh'
import { MAT as M } from './tones'
import { COLS, PRICE } from './price'
import { DX, DY, type Plan } from './plan'
import { LETTER_FLOATS } from './gl'
import { nameOn } from './name'

export type Machine = ReturnType<typeof buildMachine>

const ccw = (points: [number, number][]) => { let area = 0; points.forEach((a, i) => { const b = points[(i + 1) % points.length]; area += a[0] * b[1] - b[0] * a[1] }); return area < 0 ? points.slice().reverse() : points }

export function buildMachine(p: Plan) {
  const b = new Builder()
  // The tower is put together a floor at a time (engine.ts): its foot and the price's frame are there from the first;
  // the sorting floor and then the console are slid in under the roof, which is hung up out of their way meanwhile.
  // Everything built here says which of those it belongs to (mesh.ts `floor`). (A phone's cannon stands on the roof.)
  const CORE = 0, SORT = 1, DESK = 2, ROOF = 3, GUN = p.phone ? ROOF : CORE
  const { U, V, Xw, Xc, Xb, D, yBand, yWall, yMan, ySlot, yCav, yFas, yTop, P, lanes, lw, lh, zL, cavD, tubeR, zt } = p
  const px = U / 9, wallRows = PRICE.length + p.over + p.under, r = tubeR, count = lanes.length

  // The slab: its top, its lip, the end that is seen.
  b.box(-p.slabX, -p.lip, p.zLip, p.slabX, 0, p.zBack, M.slab)
  b.box(-p.slabX, -1.2 * px, p.zLip - .1, p.slabX, 0, p.zLip, M.trim, 'f')

  // The cabinet: its roof and side, then its front floor by floor; a lit edge down its near corner.
  // (Each floor has its own top and side: a floor is seen from above until the next is on it.)
  b.box(-Xc, 0, 0, Xc, ySlot - .2, D, M.body, 'tl')
  b.floor(SORT); b.box(-Xc, ySlot, 0, Xc, yFas - .2, D, M.body, 'tl')
  b.floor(DESK); b.box(-Xc, yFas, 0, Xc, yTop - .2, D, M.body, 'tl')
  b.floor(ROOF); b.quad([-Xc, yTop, 0], [Xc, yTop, 0], [Xc, yTop, D], [-Xc, yTop, D], M.body, [0, 1, 0], 1)
  b.floor(CORE)
  b.box(-Xc - 2 * px, 0, -3 * px, Xc + 2 * px, 1.5 * V, 0, M.plinth)
  b.mark(-Xc, 1.5 * V, Xc, yWall, 0, M.plinth)
  if (!p.phone) b.box(-Xc, yBand - px, -1.5 * px, Xc, yBand + px, 0, M.trim)
  // Relief: a post proud of the front at each corner, a cornice under the roof, a rail over the base (a phone's
  // headline, button and facts stand on one face, evenly apart, with no rail between them).
  if (p.post) for (const [level, y0, y1] of [[CORE, 1.5 * V, ySlot], [SORT, ySlot, yFas], [DESK, yFas, yTop]]) { b.floor(level); for (const x of [-Xc, Xc - p.post]) b.box(x, y0, -2.5 * px, x + p.post, y1, 0, M.body); b.mark(-Xc, y0, -Xc + 1.2 * px, y1, -2.5 * px - .1, M.trim) }
  b.floor(DESK); b.box(-Xc - px, yTop - 2.2 * px, -3.5 * px, Xc + px, yTop, 0, M.trim)
  b.floor(CORE)
  // The button's bay in the base: a faceplate screwed to the wall, on it a frame, dark inside until the page's button
  // paints over it. Either side of it, on a wide page, the two instruments: a window each, in a thin bezel. (Stacked,
  // the two facts are the page's own type under the button.)
  const c = p.cta, f = 2.5 * px, pl = p.plate
  b.box(c.x - pl, c.y - pl, -1.2 * px, c.x + c.w + pl, c.y + c.h + pl, 0, M.body)
  for (const x of [c.x - pl * .5 - f * .5, c.x + c.w + pl * .5 + f * .5]) for (const y of [c.y - pl * .5 - f * .5, c.y + c.h + pl * .5 + f * .5]) b.cyl([x, y, 0], 2, -2.2 * px, -1.2 * px, 1.2 * px, M.steel, 8, 1)
  if (!p.phone) for (const w of p.facts) {
    const e = 1.5 * px
    b.mark(w.x, w.y, w.x + w.w, w.y + w.h, -.3, M.screen, -1)
    b.box(w.x - e, w.y + w.h, -1.4 * px, w.x + w.w + e, w.y + w.h + e, 0, M.trim); b.box(w.x - e, w.y - e, -1.4 * px, w.x + w.w + e, w.y, 0, M.trim)
    b.box(w.x - e, w.y, -1.4 * px, w.x, w.y + w.h, 0, M.trim); b.box(w.x + w.w, w.y, -1.4 * px, w.x + w.w + e, w.y + w.h, 0, M.trim)
  }
  b.mark(c.x, c.y, c.x + c.w, c.y + c.h, -1.2 * px - .3, M.slot, -1)
  if (p.tally) { const t = p.tally, e = 1.2 * px; b.box(t.x - e, t.y - e, t.z - px, t.x + t.w + e, t.y + t.h + e, t.z, M.steel); b.mark(t.x, t.y, t.x + t.w, t.y + t.h, t.z - px - .1, M.screen, -1) }
  b.box(c.x - f, c.y + c.h, -3.2 * px, c.x + c.w + f, c.y + c.h + f, 0, M.trim); b.box(c.x - f, c.y - f, -3.2 * px, c.x + c.w + f, c.y, 0, M.trim)
  b.box(c.x - f, c.y, -3.2 * px, c.x, c.y + c.h, 0, M.trim); b.box(c.x + c.w, c.y, -3.2 * px, c.x + c.w + f, c.y + c.h, 0, M.trim)

  // What the page writes on the tower is set in it. The sentence under the price stands on a board let into the band,
  // as wide as the price and a little more, in a thin frame (the page gives its letters their depth and their light);
  // a phone's two facts, which are its own type under the button, are on a plate riveted to the base, as a machine's
  // rating is.
  { const half = COLS * U / 2 + 1.3 * U, y0 = yBand + (p.phone ? .09 : .15) * p.band, y1 = yBand + (p.phone ? .91 : .85) * p.band, e = 1.2 * px
    b.mark(-half, y0, half, y1, -.2, M.plinth, -1)
    for (const [xa, ya, xb, yb] of [[-half - e, y1, half + e, y1 + e], [-half - e, y0 - e, half + e, y0], [-half - e, y0, -half, y1], [half, y0, half + e, y1]]) b.box(xa, ya, -1.1 * px, xb, yb, 0, M.trim)
    if (p.phone) { const f = p.facts, xa = f[0].x - 1.3 * U, xb = f[1].x + f[1].w + 1.3 * U, ya = f[0].y - 10, yb = f[0].y + f[0].h + 9
      b.box(xa, ya, -.9 * px, xb, yb, 0, M.plinth)
      for (const x of [xa + .8 * U, xb - .8 * U]) for (const y of [ya + .8 * U, yb - .8 * U]) b.cyl([x, y, 0], 2, -1.6 * px, -.9 * px, .26 * U, M.trim, 8, 1) } }
  // The sorting frame: every pigeonhole, the empty ones a step off the wall; the thousand full ones are letters.
  b.mark(-Xw, yWall, Xw, yMan, 0, M.wall); b.mark(-Xc, yWall, -Xw, yMan, 0, M.body); b.mark(Xw, yWall, Xc, yMan, 0, M.body)
  const wall = new Float32Array(1000 * LETTER_FLOATS), g = U * .085
  let lit = 0
  for (let row = 0; row < wallRows; row++) for (let col = 0; col < COLS + 2 * p.side; col++) {
    const x = -Xw + col * U, y = yWall + (wallRows - 1 - row) * V
    if (PRICE[row - p.over]?.[col - p.side] === '#') wall.set([x + U / 2, y + V / 2, -.5, 0, 0, 0, 1, U - 2 * g, V - 2 * g, .4, (lit * .6180339887) % 1, 0, 2, 0], lit++ * LETTER_FLOATS)
    else b.mark(x + g, y + g, x + U - g, y + V - g, -.2, (col * 7 + row * 13) % 5 === 0 ? M.cell2 : M.cell, -1)
  }
  // At the frame's head, over the price and as wide as it: the wordmark, in lit letters proud of the pigeonholes.
  nameOn(b, p.name, M.lit, M.rim)

  // Two manifolds, bolted on, with the tubes between them; the label rail; the fascia.
  const lower = phone(p) ? 0 : 1.7 * V, zBlock = p.zProud, lean = DX * zBlock
  for (const [y0, y1] of [[yMan, yMan + p.manifold], ...(lower ? [[yWall - .3 * V, yWall + lower]] : [])]) {
    b.box(-Xc - px, y0, -5 * px, Xc + px, y1, 0, M.trim)
    for (let x = -Xw + 1.5 * U; x < Xw; x += 3 * U) b.cyl([x, (y0 + y1) / 2, 0], 2, -6.2 * px, -5 * px, 1.25 * px, M.steel, 8, 1)
    // At each end it stands out past the tubes, which go into it: a block the width of the four, bolted at its corners.
    // (Its front is seen `lean` to the right of where it stands: it is kept clear of the frame on the left and the
    // post on the right. The lower one goes on past the cabinet's corner to the riser.)
    if (p.tubes.length) for (const s of [-1, 1]) {
      const round = lower && y0 !== yMan
      const x0 = s < 0 ? (round ? -Xc - p.riser - .2 * U : -Xc + p.post + .1 * U) : Xw + .12 * U, x1 = s < 0 ? -Xw - .12 * U - lean : round ? Xc + p.riser + .2 * U : Xc - p.post - .1 * U - lean
      b.box(x0, y0, zBlock, x1, y1, 0, M.trim)
      for (const x of [x0 + .7 * U, x1 - .7 * U]) b.cyl([x, (y0 + y1) / 2, 0], 2, zBlock - 1.1 * px, zBlock, 1.25 * px, M.steel, 8, 1)
    }
  }
  if (!lower) b.box(-Xc - px, yWall - 1.5 * px, -3 * px, Xc + px, yWall + 1.5 * px, 0, M.trim)
  b.floor(SORT)
  b.mark(-Xc, ySlot, Xc, yCav, 0, M.body)
  for (const x of lanes) b.mark(x - p.label / 2 * P, ySlot + .14 * p.slot, x + p.label / 2 * P, ySlot + .86 * p.slot, -.2, M.plinth, 1)
  b.mark(-Xc, yCav, -Xb, yFas, 0, M.body); b.mark(Xb, yCav, Xc, yFas, 0, M.body)
  // The works' bay: back wall, floor and the one side wall that is seen, with a frame round the opening.
  b.quad([-Xb, yCav, cavD], [Xb, yCav, cavD], [Xb, yFas, cavD], [-Xb, yFas, cavD], M.dark, [0, 0, -1])
  b.quad([-Xb, yCav, 0], [Xb, yCav, 0], [Xb, yCav, cavD], [-Xb, yCav, cavD], M.bay, [0, 1, 0])
  b.quad([Xb, yCav, 0], [Xb, yCav, cavD], [Xb, yFas, cavD], [Xb, yFas, 0], M.bay, [-1, 0, 0])
  // Ribs up the bay's back wall, a lane apart, and a skirting where it meets the floor.
  for (let i = 1; i < count; i++) b.box((i - count / 2) * P - px, yCav, cavD - 2 * px, (i - count / 2) * P + px, yFas - 5 * px, cavD, M.bay)
  b.box(-Xb, yCav, cavD - 3 * px, Xb, yCav + 3 * px, cavD, M.bay)
  b.box(-Xb - 2 * px, yFas, -2 * px, Xb + 2 * px, yFas + 2 * px, 0, M.trim); b.box(-Xb - 2 * px, yCav - 2 * px, -2 * px, Xb + 2 * px, yCav, 0, M.trim)
  b.box(-Xb - 2 * px, yCav, -2 * px, -Xb, yFas, 0, M.trim); b.box(Xb, yCav, -2 * px, Xb + 2 * px, yFas, 0, M.trim)
  // A cable tray along the back of the bay, on brackets.
  b.box(-Xb, yFas - 5 * px, cavD - 4 * px, Xb, yFas - 3 * px, cavD, M.rubber)
  for (let x = -Xb + P / 2; x < Xb; x += P) b.box(x - px, yFas - 3 * px, cavD - 3 * px, x + px, yFas, cavD, M.plinth)

  // The readout, set back in its bezel; the gauge with its ticks and red zone; three lamps; a vent; the fascia's screws.
  const ro = p.readout, ga = p.gauge
  b.floor(DESK)
  b.mark(-Xc, yFas, Xc, yTop, 0, M.body)
  b.mark(ro.x, ro.y, ro.x + ro.w, ro.y + ro.h, -.2, M.screen, -1)
  b.mark(ro.x, ro.y + ro.h - 2 * px, ro.x + ro.w, ro.y + ro.h, -.25, M.slot); b.mark(ro.x, ro.y, ro.x + 1.5 * px, ro.y + ro.h, -.25, M.slot)
  b.box(ro.x - 2 * px, ro.y + ro.h, -1.6 * px, ro.x + ro.w + 2 * px, ro.y + ro.h + 2 * px, 0, M.trim); b.box(ro.x - 2 * px, ro.y - 2 * px, -1.6 * px, ro.x + ro.w + 2 * px, ro.y, 0, M.trim)
  b.box(ro.x - 2 * px, ro.y, -1.6 * px, ro.x, ro.y + ro.h, 0, M.trim); b.box(ro.x + ro.w, ro.y, -1.6 * px, ro.x + ro.w + 2 * px, ro.y + ro.h, 0, M.trim)
  b.cyl([ga.x, ga.y, 0], 2, -3.5 * px, 0, ga.r + 2.5 * px, M.trim, 28, 1)
  b.cyl([ga.x, ga.y, 0], 2, -3.9 * px, -3.6 * px, ga.r, M.dial, 28, 1)
  const radial = (angle: number, r0: number, r1: number, half: number, mat: number) => {
    const cos = Math.cos(angle), sin = Math.sin(angle), z = -4.1 * px
    b.quad([ga.x + cos * r0 + sin * half, ga.y + sin * r0 - cos * half, z], [ga.x + cos * r1 + sin * half, ga.y + sin * r1 - cos * half, z], [ga.x + cos * r1 - sin * half, ga.y + sin * r1 + cos * half, z], [ga.x + cos * r0 - sin * half, ga.y + sin * r0 + cos * half, z], mat, [0, 0, -1])
  }
  for (let i = 0; i <= 10; i++) radial((225 - 27 * i) * Math.PI / 180, ga.r * (i % 5 ? .78 : .68), ga.r * .9, (i % 5 ? .45 : .7) * px, i >= 8 ? M.redzone : M.ink)
  for (let i = 0; i < 12; i++) radial((225 - 27 * 8 - 4.5 * i - 2.25) * Math.PI / 180, ga.r * .9, ga.r * .99, ga.r * .045, M.redzone)
  const lampR = Math.min(4 * px, p.fascia * .1), lampLeft = Math.min(...p.lamps.map(lamp => lamp.x))
  for (const { x, y } of p.lamps) { b.cyl([x, y, 0], 2, -2 * px, 0, lampR + 1.2 * px, M.trim, 14, 1); b.cyl([x, y, 0], 2, -2.4 * px, -2.1 * px, lampR, M.lampOff, 14, 1) }
  const ventX = (ro.x + ro.w + lampLeft) / 2, ventW = Math.min(4 * U, (lampLeft - ro.x - ro.w) * .5 - 1.4 * U), ventH = Math.min(2.6 * V, p.fascia * .3)
  if (ventW > 1.2 * U) {
    b.mark(ventX - ventW, ga.y - ventH, ventX + ventW, ga.y + ventH, -.2, M.slot, -1)
    for (let i = 0; i < 5; i++) b.box(ventX - ventW, ga.y - ventH + i * ventH * .4 + ventH * .08, -1.6 * px, ventX + ventW, ga.y - ventH + i * ventH * .4 + ventH * .29, 0, M.trim)
  }
  const screwX = Xc - (p.post ? p.post / 2 : .65 * U)
  for (const y of [yFas + V, yTop - 1.4 * V, ...(p.post ? [yMan - 2 * V, yWall + 3 * V, yBand + p.band / 2] : [])]) { b.floor(y > yFas ? DESK : CORE); for (const x of [-screwX, screwX]) b.cyl([x, y, 0], 2, -3.7 * px, -2.5 * px, 1.3 * px, M.steel, 8, 1) }
  b.floor(ROOF)

  // The roof: a kerb round it, seams, a laser's pedestal at each end, a slot scams leave by each side of the hopper, a beacon.
  b.box(-Xc, yTop, 0, Xc, yTop + 2 * px, 2.5 * px, M.trim); b.box(-Xc, yTop, D - 2.5 * px, Xc, yTop + 2 * px, D, M.trim)
  b.box(-Xc, yTop, 2.5 * px, -Xc + 2.5 * px, yTop + 2 * px, D - 2.5 * px, M.trim); b.box(Xc - 2.5 * px, yTop, 2.5 * px, Xc, yTop + 2 * px, D - 2.5 * px, M.trim)
  for (const x of [-Xw, Xw]) b.quad([x - .5 * px, yTop + .1, 2.5 * px], [x + .5 * px, yTop + .1, 2.5 * px], [x + .5 * px, yTop + .1, D - 2.5 * px], [x - .5 * px, yTop + .1, D - 2.5 * px], M.line, [0, 1, 0])
  b.quad([-Xw, yTop + .1, D * .5 - .5 * px], [Xw, yTop + .1, D * .5 - .5 * px], [Xw, yTop + .1, D * .5 + .5 * px], [-Xw, yTop + .1, D * .5 + .5 * px], M.line, [0, 1, 0])
  // (A phone's roof is kept to what it needs: the hopper, the two lasers, the slot scams leave by, the cannon, the beacon.)
  const vents: V3[] = p.phone ? [] : [[-Xw * .84, yTop + 13 * px, D * .7], [Xw * .88, yTop + 13 * px, D * .66]]
  // The lasers stand on brackets at the roof's front corners, ahead of the front and (where the page is wide) out
  // past the side: whatever they fire at, in front of the machine, beside it or over it, the beam is clear of it.
  const tz = -5 * px, turrets: V3[] = [-1, 1].map(s => [s * (p.phone ? Xc - 2.4 * U : Xc + 1.15 * U), yTop + 16 * px, tz]), ejects: V3[] = [-1, 1].map(s => [s * p.eject.x, yTop + 5 * px, p.eject.z])
  turrets.forEach((t, k) => {
    const s = k ? 1 : -1, in0 = s * (p.phone ? Xc - 4.2 * U : Xc - 1.6 * U), out0 = t[0] + s * 1.05 * U, a = Math.min(in0, out0), e = Math.max(in0, out0)
    b.box(a, yTop + 2 * px, tz - 6 * px, e, yTop + 4.4 * px, 7 * px, M.trim, ALL)
    for (const x of [in0 + s * .6 * U, in0 + s * 1.5 * U]) b.cyl([x, 0, 3.4 * px], 1, yTop + 4.4 * px, yTop + 5.4 * px, 1.2 * px, M.steel, 8, 2)
    // (Under what overhangs the side, a gusset against the wall.)
    if (!p.phone) b.prism(ccw([[s * Xc, yTop + 2 * px], [out0, yTop + 2 * px], [s * Xc, yTop - 1.9 * U]]), -1.4 * px, 0, M.trim, 'fks', M.steel)
    b.cyl([t[0], 0, tz], 1, yTop + 4.4 * px, yTop + 6.4 * px, 5.6 * px, M.trim, 16, 2); b.cyl([t[0], 0, tz], 1, yTop + 6.4 * px, yTop + 16 * px, 3.2 * px, M.steel, 12, 2)
  })
  // (Stacked, the cannon stands behind the right-hand slot: scams leave by the left one only, and there is no other.)
  for (const e of p.phone ? ejects.slice(0, 1) : ejects) {
    b.box(e[0] - .62 * lw, yTop, e[2] - 6 * px, e[0] + .62 * lw, yTop + 5 * px, e[2] + 6 * px, M.steel)
    b.quad([e[0] - .54 * lw, yTop + 5 * px + .1, e[2] - 2 * px], [e[0] + .54 * lw, yTop + 5 * px + .1, e[2] - 2 * px], [e[0] + .54 * lw, yTop + 5 * px + .1, e[2] + 2 * px], [e[0] - .54 * lw, yTop + 5 * px + .1, e[2] + 2 * px], M.slot, [0, 1, 0])
  }
  // (A phone's stands clear of the right-hand laser, between it and the cannon.)
  const beacon: V3 = [Xc - (p.phone ? 4.5 : 3) * U, yTop + 12 * px, D * .82]
  b.cyl([beacon[0], 0, beacon[2]], 1, yTop, yTop + 8 * px, 1.2 * px, M.steel, 8, 0); b.cyl([beacon[0], 0, beacon[2]], 1, yTop + 8 * px, yTop + 9.5 * px, 3.6 * px, M.trim, 12, 2); b.cyl([beacon[0], 0, beacon[2]], 1, yTop + 9.5 * px, yTop + 14 * px, 2.8 * px, M.lampOff, 12, 2)
  // Each laser's cable runs back to a junction box by the kerb. (Not on a phone's roof: there is little enough of it.)
  if (!p.phone) turrets.forEach((t, k) => { const s = k ? 1 : -1, x = s * (Xc - 2.6 * U); b.tube([[x, yTop + 1.4 * px, 7 * px], [x, yTop + 1.4 * px, D * .52], [x - s * 2.2 * U, yTop + 1.4 * px, D * .52]], 1.3 * px, M.rubber, 6, 5 * px); b.box(x - s * 2.2 * U - 4 * px, yTop, D * .52 - 4 * px, x - s * 2.2 * U + 4 * px, yTop + 4 * px, D * .52 + 4 * px, M.plinth) })
  // What the hopper and the chimneys stand over: holes, seen once they are gone.
  b.quad([-lw * .5, yTop + .15, zL - lw * .26], [lw * .5, yTop + .15, zL - lw * .26], [lw * .5, yTop + .15, zL + lw * .26], [-lw * .5, yTop + .15, zL + lw * .26], M.slot, [0, 1, 0])
  for (const v of vents) b.cyl([v[0], 0, v[2]], 1, yTop + .1, yTop + .2, 3.6 * px, M.slot, 12, 2)

  // The roller line and, under it, a chute for each lane: two plates that lean together.
  const rr = P / 8 * .4, yR = yCav + p.cavity * .4, z0 = zL - 12 * px, z1 = zL + 12 * px, rideY = yR + rr + lh / 2, scanY = Math.min(yFas - lh / 2 - 8 * px, rideY + lh * (p.phone ? .78 : .92))
  // (Each lane's own works, its deck of rollers and the chute under it, are parts further down: they are fitted one
  // lane at a time.)
  // The scanner hangs from the bay's ceiling over the middle lane.
  b.floor(SORT)
  b.box(-lw * .6, yFas - 6 * px, zL - 7 * px, lw * .6, yFas, zL + 7 * px, M.steel); b.mark(-lw * .5, yFas - 6 * px - .1, lw * .5, yFas - 4.5 * px, zL - 7 * px - .1, M.red)

  b.floor(CORE)
  // The tubes' fittings on the front: a socket in each manifold, a dark channel behind each run, and brackets that
  // hold each four to the wall (a bar across them, bolted between). One length of bracket, round the tube the burst
  // will tear out, is that tube's own.
  const yLow = lower ? yWall + lower : r + px, bentTube = p.tubes.length ? 5 : -1, bentY = yLow + (yMan - yLow) * .42
  const sockets: number[] = []
  for (const x of p.tubes) {
    b.mark(x - r - px, lower ? yLow : yWall + 1.5 * px, x + r + px, yMan, -.15, M.dark)
    if (!lower) b.mark(x - r - px, 1.5 * V, x + r + px, yWall - 1.5 * px, -.15, M.slot)
    b.cyl([x, 0, zt], 1, yMan - 2.8 * px, yMan, r + 1.4 * px, M.steel, 14, 0)
    if (lower) sockets.push(x)
  }
  const pitch = Math.abs(p.tubes[1] - p.tubes[0]), bracketH = 1.5 * px, zB = zt - r - 1.2 * px, reach = r + 1.5 * px, ahead = DX * (zB - zt)
  const bracketY: number[] = []
  if (lower) { const n = 3; for (let i = 1; i <= n; i++) bracketY.push(yLow + (yMan - yLow) * i / (n + 1)) }
  // (A bracket's face is seen a little to the right of the tubes it holds: it is set back by as much, and ends at the
  // tubes.)
  const bracket = (x0: number, x1: number, y: number) => b.box(x0 - ahead, y - bracketH, zB, x1 - ahead, y + bracketH, 0, M.trim)
  if (p.tubes.length) for (const y of bracketY) for (const first of [0, 4]) {
    const a = Math.min(p.tubes[first], p.tubes[first + 3]) - reach, e = Math.max(p.tubes[first], p.tubes[first + 3]) + reach
    if (first === 4 && lower && y > bentY) { bracket(a, p.tubes[bentTube] - pitch / 2, y); bracket(p.tubes[bentTube] + pitch / 2, e, y) } else bracket(a, e, y)
    for (let k = 0; k < 3; k++) b.cyl([p.tubes[first] + (first ? 1 : -1) * (k + .5) * pitch - ahead, y, 0], 2, zB - .8 * px, zB, .9 * px, M.steel, 6, 1)
  }

  // Where the tubes cross the slab. A wide page: the lower manifold's block goes on round each corner of the cabinet;
  // a riser comes down from it to a header on the slab, a trunk with a flanged outlet for each tube in its front
  // (block, riser and header are one face); each tube runs straight forward from its outlet over a sleeper, held to
  // it by a U-bolt, and over the lip.
  // Where a tube turns down over the lip it wears a collar.
  const yc = r + 3.5 * px, seat = yc - r
  const strap = (x: number, z: number) => { const w = r + 1.3 * px, path: V3[] = [[x - w, 0, z], [x - w, yc, z]]; for (let i = 1; i < 8; i++) { const a = Math.PI - i / 8 * Math.PI; path.push([x + Math.cos(a) * w, yc + Math.sin(a) * w, z]) } path.push([x + w, yc, z], [x + w, 0, z]); b.tube(path, 1.1 * px, M.steel, 6, .5 * px) }
  const umbra: [V3, V3, V3, V3][] = []
  const shade = (x: number, z0: number, z1: number) => { umbra.push([[x - r - .3 * (yc + r), .12, z0 + .69 * yc], [x + r - .3 * yc, .12, z0 + .69 * yc], [x + r - .3 * yc, .12, z1], [x - r - .3 * (yc + r), .12, z1]]) }
  const sleeperZ = p.heads.length ? (p.heads[0].z0 + p.zLip) / 2 - .6 * U : 0
  p.heads.forEach((head, side) => {
    const s = side ? 1 : -1
    b.box(head.x0, 0, head.z0, head.x1, head.h, head.z1, M.trim)
    b.box(head.x0 - px, 0, head.z0 - px, head.x1 + px, 1.8 * px, head.z1, M.plinth)
    b.box(head.x0 + 2 * px, head.h, head.z0 + 2 * px, head.x1 - 2 * px, head.h + 1.2 * px, head.z1 - 2 * px, M.body)
    // The riser, from the header up to the block that came round the corner.
    const rx0 = s < 0 ? -Xc - p.riser - .2 * U : Xc + .2 * U
    b.box(rx0, head.h, zBlock, rx0 + p.riser, yWall + lower, zBlock + 3 * U, M.trim)
    for (const y of [head.h + 1.2 * U, yWall - 1.4 * U]) b.cyl([rx0 + p.riser / 2, y, 0], 2, zBlock - 1.1 * px, zBlock, 1.25 * px, M.steel, 8, 1)
    const xs = [0, 1, 2, 3].map(k => p.fan[side * 4 + k].x), a = Math.min(...xs), e = Math.max(...xs)
    for (const x of xs) { b.cyl([x, yc, 0], 2, head.z0 - 2.6 * px, head.z0, r + 2 * px, M.steel, 16, 1); b.cyl([x, yc, 0], 2, head.z0 - 4.8 * px, head.z0 - 2.6 * px, r + 1 * px, M.steel, 14, 0) }
    for (let x = head.x0 + 1.6 * U; x < head.x1 - U; x += 3.2 * U) if (xs.every(at => Math.abs(at - x) > r + 4 * px) && (x < rx0 - U || x > rx0 + p.riser + U)) b.cyl([x, head.h - .9 * U, 0], 2, head.z0 - 1.1 * px, head.z0, 1.2 * px, M.steel, 8, 1)
    b.box(a - 1.9 * U, 0, sleeperZ - .8 * U, e + 1.9 * U, seat, sleeperZ + .8 * U, M.plinth); for (const x of xs) strap(x, sleeperZ)
    for (const x of xs) b.cyl([x, 0, p.zOver], 1, -p.lip * .5 - 1.4 * px, -p.lip * .5 + 1.4 * px, r + 1.2 * px, M.steel, 14, 3)
    for (const x of xs) shade(x, p.zLip + 1, head.z0)
  })

  // The send cannon, the sending half of the machine: a pneumatic gun. What is to be sent comes up the page in the
  // outbound tube and over the slab's lip as the eight lanes go down over it. On a wide page it then turns along
  // the front of the cabinet and goes into the trunk at the foot of the right riser; out of the trunk's back a tube
  // runs across the slab into the chest the gun stands on, and a glass feed goes up from the chest into the breech.
  // On a phone the tube goes into the cabinet's base, and the feed comes up through the roof under the gun. The gun
  // fires what reaches it off the page as a letter. A chest (or a plate) bolted down, two cheeks, and between them
  // a cradle the barrel slides back through as it fires. The barrel and the cradle are parts of their own, built
  // lying level and turned to the gun's elevation by their pose.
  const C = p.cannon, cu = C.cs, cz = C.z, pivot: V3 = [C.x, C.y + C.pivot, cz], ce = Math.cos(C.el), se = Math.sin(C.el), cr = C.r, cheek = cr + 2.2 * px
  const along = (a: number, c = 0): V3 => [pivot[0] + a * ce - c * se, pivot[1] + a * se + c * ce, cz]
  // (A phone's chest stands behind the right-hand port: it is no deeper than the cheeks need.)
  const kink = along(-C.back - 1.6 * cu), baseTop = C.y + C.chest, x0 = kink[0] - 1.7 * cu, x1 = C.x + 3.4 * cu, lap = (p.phone ? .3 : 1.1) * cu, chestZ = cz - cheek - lap
  b.floor(GUN)
  b.box(x0, C.y, chestZ, x1, baseTop, cz + cheek + lap, M.plinth)
  if (!p.phone) { b.box(x0 - px, C.y, chestZ - px, x1 + px, C.y + 1.8 * px, cz + cheek + lap, M.trim); b.box(x0 - px, baseTop - 1.6 * px, chestZ - px, x1 + px, baseTop, cz + cheek + lap, M.trim) }
  if (!p.phone) for (const x of [x0 + .6 * cu, x1 - .6 * cu]) for (const z of [cz - cheek - .55 * cu, cz + cheek + .55 * cu]) b.cyl([x, 0, z], 1, baseTop, baseTop + 1.1 * px, 1.4 * px, M.steel, 8, 2)
  // (The cheeks stand a little over the barrel's middle, so the far one's top edge is seen behind it.)
  for (const z of [cz - cheek - 2.4 * px, cz + cheek]) b.prism(ccw([[C.x - 2.5 * cu, baseTop], [C.x + 2.9 * cu, baseTop], [C.x + .95 * cu, pivot[1] + .95 * cu], [C.x - .95 * cu, pivot[1] + .95 * cu]]), z, z + 2.4 * px, M.trim, 'fks', M.steel)
  // A ring round a tube where it goes through something: a low steel wall and, on top, a flat ring the tube passes
  // through (not a disc over it).
  const collar = (x: number, y: number, z: number, h: number, out = tubeR + 1.8 * px, r = tubeR) => {
    b.cyl([x, 0, z], 1, y, y + h, out, M.steel, 16, 0)
    for (let i = 0; i < 16; i++) { const a0 = i / 16 * Math.PI * 2, a1 = (i + 1) / 16 * Math.PI * 2; b.quad([x + Math.cos(a0) * r, y + h, z + Math.sin(a0) * r], [x + Math.cos(a1) * r, y + h, z + Math.sin(a1) * r], [x + Math.cos(a1) * out, y + h, z + Math.sin(a1) * out], [x + Math.cos(a0) * out, y + h, z + Math.sin(a0) * out], M.steel, [0, 1, 0]) }
  }
  // The feed tube: out of the chest through a collar, and round into the breech.
  collar(kink[0], baseTop, cz, 2.2 * px)
  b.floor(CORE)
  // The outbound tube's fittings: its collar at the lip, as the others wear; then (wide) two saddles under its run
  // along the cabinet's front, its flange in the trunk, and behind the trunk the tube to the chest: a strap over it,
  // a flange where it goes in; or (stacked) its flange in the cabinet's base. (A phone's comes up under the slab, unseen.)
  const outX = p.out - DX * p.zOver, zJ = p.zLip * .46, trunk = p.heads[1], portX = Xc + .2 * U + p.riser / 2
  const flange = (x: number, z: number) => { b.cyl([x, yc, 0], 2, z - 2.6 * px, z, r + 2 * px, M.steel, 16, 1); b.cyl([x, yc, 0], 2, z - 4.8 * px, z - 2.6 * px, r + 1 * px, M.steel, 14, 0) }
  if (!p.phone) b.cyl([outX, 0, p.zOver], 1, -p.lip * .5 - 1.4 * px, -p.lip * .5 + 1.4 * px, r + 1.2 * px, M.steel, 14, 3)
  // (Where the outbound tube goes in it wears a square plate, bolted at its corners: in is not out.)
  const inlet = (x: number, z: number) => { const w = r + 3.4 * px, top = yc + w; b.box(x - w, .4, z - 1.8 * px, x + w, top, z, M.steel); for (const bx of [x - w + 1.5 * px, x + w - 1.5 * px]) for (const by of [1.9 * px, top - 1.5 * px]) b.cyl([bx, by, 0], 2, z - 2.8 * px, z - 1.8 * px, .9 * px, M.trim, 6, 1); b.cyl([x, yc, 0], 2, z - 3.6 * px, z - 1.8 * px, r + 1 * px, M.trim, 14, 0) }
  if (trunk) {
    inlet(portX, trunk.z0)
    for (const f of [.3, .72]) { const x = outX + (portX - outX) * f; b.box(x - .8 * U, 0, zJ - r - 1.5 * px, x + .8 * U, seat, zJ + r + 1.5 * px, M.plinth); b.box(x - .25 * U, seat, zJ - r - 1.5 * px, x + .25 * U, yc + r + 1.2 * px, zJ - r - .2 * px, M.steel); b.box(x - .25 * U, seat, zJ + r + .2 * px, x + .25 * U, yc + r + 1.2 * px, zJ + r + 1.5 * px, M.steel); b.box(x - .25 * U, yc + r, zJ - r - 1.5 * px, x + .25 * U, yc + r + 1.2 * px, zJ + r + 1.5 * px, M.steel, ALL) }
    shade(outX, p.zLip + 1, zJ - r); shade(portX, zJ + r, trunk.z0)
    umbra.push([[outX - .3 * yc, .12, zJ - r + .69 * yc], [portX - .3 * yc, .12, zJ - r + .69 * yc], [portX - .3 * yc, .12, zJ + r + .69 * yc], [outX - .3 * yc, .12, zJ + r + .69 * yc]])
    flange(kink[0], chestZ - px); strap(kink[0], (trunk.z1 + chestZ) / 2 + 1.2 * U); shade(kink[0], trunk.z1, chestZ - px)
  }
  for (const x of sockets) collar(x, yLow, zt, 2.6 * px, r + 1.4 * px)
  // (A phone's three tubes: a collar where each comes up out of the slab, and one where it turns down over the lip.)
  for (const pipe of p.hung) { const over = p.zLip - pipe.r - 3 * px, x = pipe.x - p.ox - DX * over; collar(x, 0, p.zLip + 2.6 * pipe.r, 2.2 * px, pipe.r + 1.8 * px, pipe.r); b.cyl([x, 0, over], 1, -p.lip * .5 - 1.4 * px, -p.lip * .5 + 1.4 * px, pipe.r + 1.2 * px, M.steel, 14, 3) }

  // Two relief valves on the columns beside the works, of the kind a boiler has: a body on a flange, fed from the
  // manifold below, a nozzle up, and a weighted lever that the pressure lifts. Under the right one, the recess a
  // service panel covers.
  const vs = p.phone ? .58 * U : U, colX = (Xb + 2 * px + Xc - p.post) / 2, valveY = yCav + p.cavity * .62, vz = -3.4 * px
  const valves = [-1, 1].map(side => ({ side, x: side * colX, y: valveY, nozzle: [side * colX, valveY + 2.2 * vs, vz] as V3 }))
  b.floor(SORT)
  for (const v of valves) {
    b.cyl([v.x, 0, vz], 1, ySlot, v.y, .3 * vs, M.steel, 10, 0)
    b.cyl([v.x, 0, vz], 1, ySlot, ySlot + .5 * vs, .5 * vs, M.trim, 10, 2)
    b.cyl([v.x, v.y, 0], 2, -1.6 * px, 0, 1.15 * vs, M.trim, 18, 1)
    b.cyl([v.x, v.y, 0], 2, vz - .78 * vs * .4, -1.6 * px, .8 * vs, M.steel, 16, 1)
    b.cyl([v.x, 0, vz], 1, v.y + .6 * vs, v.y + 1.9 * vs, .4 * vs, M.steel, 10, 0)
    b.cyl([v.x, 0, vz], 1, v.y + 1.9 * vs, v.y + 2.2 * vs, .56 * vs, M.trim, 12, 2, M.slot)
  }
  const panel = { x0: Xb + (p.phone ? .45 : .7) * U, x1: p.phone ? Xc - .45 * U : colX - 1.6 * vs, y0: yCav + p.cavity * .1, y1: yCav + p.cavity * .4 }, panelX = (panel.x0 + panel.x1) / 2
  b.mark(panel.x0 + px, panel.y0 + px, panel.x1 - px, panel.y1 - px, -.15, M.slot, -1)
  b.mark(panel.x0 + px, panel.y0 + px, panel.x1 - px, panel.y0 + 2.2 * px, -.2, M.bay)

  // ── Parts ──
  const idx = { decks: [] as number[], chutes: [] as number[], glass: 0, tubes: 0, soot: 0, shards: 0, hole: 0, bent: 0, bentHeld: 0, barrel: 0, cradle: 0, needle: 0, turrets: [] as number[], scan: 0, hopper: 0, hatch: -1, panel: 0, beaconOn: 0, levers: [] as number[], vents: [] as number[], panes: [] as number[], cracks: [] as number[], lamps: [] as number[], flaps: [] as number[], rollers: [] as number[], caps: [] as number[], bolts: [] as number[] }

  b.floor(DESK)
  idx.needle = b.part('needle', [ga.x, ga.y, 0])
  b.prism(ccw([[ga.x - 1.1 * px, ga.y - ga.r * .22], [ga.x + 1.1 * px, ga.y - ga.r * .22], [ga.x + .4 * px, ga.y + ga.r * .8], [ga.x - .4 * px, ga.y + ga.r * .8]]), -4.8 * px, -4.4 * px, M.ink, 'f')
  b.cyl([ga.x, ga.y, 0], 2, -5.6 * px, -4.4 * px, 2.2 * px, M.steel, 12, 1)

  p.lamps.forEach(({ x, y }, i) => { idx.lamps.push(b.part(`lamp${i}`)); b.cyl([x, y, 0], 2, -2.7 * px, -2.5 * px, lampR, i === 0 ? M.red : M.lampOn, 14, 1) })
  b.floor(ROOF)
  idx.beaconOn = b.part('beacon'); b.cyl([beacon[0], 0, beacon[2]], 1, yTop + 9.5 * px, yTop + 14.2 * px, 3 * px, M.red, 12, 2)

  // The lasers: a barrel in a yoke, cooling rings round it, a red lens. Round, so it looks right aimed any way.
  turrets.forEach((t, k) => {
    idx.turrets.push(b.part(`turret${k}`, t))
    b.cyl([0, t[1], t[2]], 0, t[0] - 8 * px, t[0] + 17 * px, 4.4 * px, M.plinth, 14, 1)
    b.cyl([0, t[1], t[2]], 0, t[0] + 17 * px, t[0] + 22 * px, 3.4 * px, M.steel, 12, 2, M.red)
    b.cyl([0, t[1], t[2]], 0, t[0] - 10.5 * px, t[0] - 8 * px, 3.4 * px, M.trim, 12, 1)
    for (let i = 0; i < 4; i++) b.cyl([0, t[1], t[2]], 0, t[0] - 5 * px + i * 4.4 * px, t[0] - 3.2 * px + i * 4.4 * px, 6.2 * px, M.trim, 14, 3)
    b.cyl([t[0], t[1], 0], 2, t[2] - 6.4 * px, t[2] + 6.4 * px, 2.6 * px, M.steel, 10, 3)
  })

  b.floor(SORT)
  idx.scan = b.part('scan', [0, scanY, zL]); b.mark(-lw * .56, scanY - .7 * px, lw * .56, scanY + .7 * px, zL - 2.5 * px, M.red)

  // The hopper: a funnel of four plates on a collar, its front lower than its back so the letters are seen going in.
  const hh = p.hopper * .82, ht = lw * 1.3, hb = lw * .62, hd = lw * .36, t = 1.3 * px
  b.floor(ROOF)
  idx.hopper = b.part('hopper', [0, yTop + hh / 2, zL])
  b.prism(ccw([[-hb, yTop], [hb, yTop], [ht, yTop + hh], [-ht, yTop + hh]]), zL + hd, zL + hd + t, M.trim, 'fks', M.steel)
  for (const s of [-1, 1]) b.prism(ccw([[s * hb, yTop], [s * (hb + t), yTop], [s * (ht + t), yTop + hh], [s * ht, yTop + hh]]), zL - hd, zL + hd, M.trim, 'fks', M.steel)
  b.prism(ccw([[-hb, yTop], [hb, yTop], [hb + (ht - hb) * .62, yTop + hh * .62], [-hb - (ht - hb) * .62, yTop + hh * .62]]), zL - hd - t, zL - hd, M.steel, 'fks', M.trim)
  b.box(-hb - 3 * px, yTop, zL - hd - 3 * px, hb + 3 * px, yTop + 2.4 * px, zL + hd + 3 * px, M.plinth, ALL)

  // The chimneys and the hatch: on the roof until the burst. (The hatch's hinge: two knuckles on the roof at its back edge.)
  b.part('static2')
  if (!p.phone) for (const x of [-Xw * .41, -Xw * .19]) b.cyl([0, yTop + 2.6 * px, D * .89], 0, x - 3.4 * px, x + 3.4 * px, 3.1 * px, M.steel, 10, 3)
  vents.forEach((v, i) => { idx.vents.push(b.part(`vent${i}`, [v[0], yTop + 6 * px, v[2]])); b.cyl([v[0], 0, v[2]], 1, yTop, yTop + 11 * px, 4.5 * px, M.steel, 14, 1); b.cyl([v[0], 0, v[2]], 1, yTop + 11 * px, yTop + 13 * px, 6 * px, M.trim, 14, 3, M.slot) })
  if (!p.phone) {
  idx.hatch = b.part('hatch', [-Xw * .3, yTop + px, D * .76])
  b.box(-Xw * .46, yTop, D * .64, -Xw * .14, yTop + 4.4 * px, D * .88, M.steel, ALL, M.body); b.box(-Xw * .33, yTop + 4.4 * px, D * .73, -Xw * .27, yTop + 6.2 * px, D * .79, M.steel, ALL)
  // (Its underside, seen once it is thrown back: the cabinet's steel, sooted at its middle, two ribs across it.)
  b.quad([-Xw * .46, yTop - .05, D * .64], [-Xw * .14, yTop - .05, D * .64], [-Xw * .14, yTop - .05, D * .88], [-Xw * .46, yTop - .05, D * .88], M.trim, [0, -1, 0])
  b.quad([-Xw * .4, yTop - .12, D * .69], [-Xw * .2, yTop - .12, D * .69], [-Xw * .2, yTop - .12, D * .83], [-Xw * .4, yTop - .12, D * .83], M.plinth, [0, -1, 0])
  for (const z of [D * .7, D * .82]) b.box(-Xw * .45, yTop - 1.4 * px, z - .7 * px, -Xw * .15, yTop - .1, z + .7 * px, M.steel, ALL)
  }

  // The cannon's barrel: a reinforced breech with the feed tube's coupling behind it, a chase that tapers a little, two
  // bands and a muzzle swell. And its cradle: a sleeve round the barrel, on the trunnions the cheeks carry.
  b.floor(GUN)
  idx.barrel = b.part('barrel', pivot)
  { const [x, y] = pivot, ring = (a0: number, a1: number, r0: number, mat: number, r1 = r0, caps = 3) => b.cyl([0, y, cz], 0, x + a0, x + a1, r0, mat, 16, caps, mat, r1)
    ring(-C.back, -C.back + .3 * (C.back + C.fore), cr + 1.5 * px, M.trim); ring(-C.back + .3 * (C.back + C.fore), C.fore, cr + .6 * px, M.trim, cr - .3 * px)
    ring(-C.back - 1.6 * px, -C.back + 1.4 * px, cr + 3 * px, M.steel); ring(-C.back - 4.2 * px, -C.back - 1.6 * px, r + 2.4 * px, M.steel)
    for (const a of [-C.back + .3 * (C.back + C.fore), C.fore * .56]) ring(a - 1.1 * px, a + 1.1 * px, cr + 2.6 * px, M.steel)
    ring(C.fore - 4.4 * px, C.fore, cr + 2.4 * px, M.steel); b.cyl([0, y, cz], 0, x + C.fore, x + C.fore + .7, C.bore - .6 * px, M.slot, 16, 2, M.slot); ring(C.fore - 6 * px, C.fore - 4.4 * px, cr + 1.2 * px, M.steel, cr + 2.4 * px, 0) }
  idx.cradle = b.part('cradle', pivot)
  b.cyl([0, pivot[1], cz], 0, pivot[0] - .75 * cu, pivot[0] + .75 * cu, cr + 3.4 * px, M.plinth, 16, 3, M.plinth)
  b.cyl([0, pivot[1], cz], 0, pivot[0] - .24 * cu, pivot[0] + .24 * cu, cr + 4.4 * px, M.steel, 16, 3)
  b.cyl([pivot[0], pivot[1], 0], 2, cz - cheek - 4.6 * px, cz + cheek + 4.6 * px, .36 * cu, M.steel, 12, 3)

  // The valves' levers, hinged on the body's centre, and the service panel on its four screws.
  b.floor(SORT)
  for (const v of valves) {
    idx.levers.push(b.part(`lever${idx.levers.length}`, [v.x, v.y, vz]))
    const z0 = vz - .78 * vs * .4 - 1.4 * px, z1 = z0 + 1.2 * px, tip = v.x + v.side * 2.3 * vs
    b.box(Math.min(v.x - v.side * .3 * vs, tip), v.y - .15 * vs, z0, Math.max(v.x - v.side * .3 * vs, tip), v.y + .15 * vs, z1, M.trim, ALL)
    b.box(Math.min(tip - v.side * .75 * vs, tip), v.y - .78 * vs, z0 - .6 * px, Math.max(tip - v.side * .75 * vs, tip), v.y - .15 * vs, z1 + .6 * px, M.steel, ALL)
    b.cyl([v.x, v.y, 0], 2, z0 - 1.2 * px, z0, .34 * vs, M.steel, 10, 1)
  }
  idx.panel = b.part('panel', [panelX, (panel.y0 + panel.y1) / 2, -.7 * px])
  b.box(panel.x0, panel.y0, -1.4 * px, panel.x1, panel.y1, 0, M.plinth, ALL)
  for (const x of [panel.x0 + 2.2 * px, panel.x1 - 2.2 * px]) for (const y of [panel.y0 + 2.2 * px, panel.y1 - 2.2 * px]) b.cyl([x, y, 0], 2, -2.2 * px, -1.4 * px, .9 * px, M.steel, 8, 1)
  b.box(panelX - .9 * px, (panel.y0 + panel.y1) / 2 - .9 * vs, -2.6 * px, panelX + .9 * px, (panel.y0 + panel.y1) / 2 + .9 * vs, -1.4 * px, M.trim, ALL)

  // Rollers: eight to a lane, the middle four on that lane's drop gate. Each has a mark on its end so its turning shows.
  const rollerLane: number[] = [], rollerHome: V3[] = []
  for (let j = 0; j < 8 * count; j++) {
    const x = lanes[0] - P / 2 + (j + .5) * P / 8
    idx.rollers.push(b.part(`roller${j}`, [x, yR, zL])); rollerLane.push(Math.floor(j / 8)); rollerHome.push([x, yR, zL])
    b.parts[b.parts.length - 1].plain = true
    b.cyl([x, yR, 0], 2, z0, z1, rr, M.steel, 12, 3, M.trim)
    b.cyl([x + rr * .5, yR, 0], 2, z0 - .3, z0 - .1, rr * .28, M.ink, 6, 1)
  }
  // The gates: a frame under four rollers, hinged at its upstream end (a middle lane's at its left).
  const hinge: V3[] = [], swing: number[] = []
  lanes.forEach((x, i) => {
    const dir = x < -1 ? -1 : 1, hx = x - dir * P / 4
    hinge.push([hx, yR, zL]); swing.push(dir)
    idx.flaps.push(b.part(`flap${i}`, [hx, yR, zL]))
    for (const z of [z0 - 1.5 * px, z1]) b.box(x - P / 4, yR - rr - 2.5 * px, z, x + P / 4, yR - rr * .2, z + 1.5 * px, M.steel, ALL)
    b.cyl([hx, yR - rr - 1.2 * px, 0], 2, z0 - 2.4 * px, z0 - 1.5 * px, 1.6 * px, M.trim, 8, 1)
  })

  // Each lane's works are a thing that is fitted: its deck (the eight rollers and the gate above, on a bearing block
  // at each end, the blocks joined by two rails) and, under it, its chute, which stands up out of the bay's floor
  // once a deck is over it.
  lanes.forEach((x, i) => {
    idx.decks.push(b.part(`deck${i}`, [x, yR, zL]))
    for (const z of [z0 - 1.5 * px, z1]) {
      for (const s of [-1, 1]) b.box(x + (s < 0 ? -.5 : .34) * P, yR - rr - 4.5 * px, z, x + (s < 0 ? -.34 : .5) * P, yR - rr * .2, z + 1.5 * px, M.plinth, ALL)
      b.box(x - .34 * P, yR - rr - 4.5 * px, z, x + .34 * P, yR - rr - 3 * px, z + 1.5 * px, M.plinth, ALL)
    }
    idx.chutes.push(b.part(`chute${i}`, [x, yCav, zL]))
    for (const s of [-1, 1]) b.prism(ccw([[x + s * .48 * P, yR - rr - 3 * px], [x + s * .48 * P - s * 1.6 * px, yR - rr - 3 * px], [x + s * .4 * P - s * 1.6 * px, yCav], [x + s * .4 * P, yCav]]), z0, z1, M.trim, 'fs')
  })

  // The fitters. Over the outermost lane each side there is a port in the roof, under a cover: on a wide page a plate
  // that draws back over the roof; a phone's roof has no room behind its ports (its cannon, its slot, its beacon), and
  // its cover is a plate that sinks into the port. Beyond the port, at the roof's end, an arm on a short column: an
  // upper arm and a forearm, jointed, working in the plane the column is turned to, and a hand that a wrist keeps level
  // and square to the page: a bar with a finger down at each end, the fingers closing on a deck's bearing blocks. It
  // takes each deck from where it waits, lifts it clear of whatever it is to pass over, carries it round to over the
  // port (round the back on a wide page; on a phone, whose cannon stands at the back, round the front and close in)
  // and lowers it in.
  const au = (p.phone ? .7 : .82) * U, deckH = 2 * rr + 4.5 * px, grip = 2.3 * au, hw = P / 2 + .3 * au + .25 * U, pd = (z1 - z0) / 2 + 3.5 * px, rb = 1.5 * au, half = P / 2 + .3 * au
  const pageL = -p.ox - DX * zL, pageR = p.W - p.ox - DX * zL
  // (How high the wrist carries a deck: the deck's underside a little over the tallest thing under its way, on a wide
  // page the chimney and the beacon behind the ports, on a phone the lasers in front, hanging as they do until the
  // machine is fitted out.)
  const travel = (p.phone ? yTop + 27.5 * px : yTop + 14.2 * px) + 3 * px + deckH + grip
  const arms = [-1, 1].map((s, k) => {
    const portX = s * Math.abs(lanes[0]), bx = s * Math.min(Xc - 2.5 * px - rb - .1 * U, Math.abs(portX) + hw + rb + 1.5 * U), shoulder: V3 = [bx, yTop + 2.7 * au, zL]
    const mine = p.fit.slice(1).filter(i => (lanes[i] < 0 ? -1 : 1) === s), front = p.phone
    // Where the deck it takes next waits (its pivot, the middle of its roller line): on a wide page at the top of a
    // magazine on the console's side, the rest stacked under it on a lift that brings the next up once it is taken;
    // on a phone just off the page's side.
    const top: V3 = p.phone ? [s < 0 ? Math.min(pageL, -Xc) - P / 2 - .5 * U : Math.max(pageR, Xc) + P / 2 + .5 * U, yTop - 2 * U - rr, zL] : [s * (Xc + .8 * U + P / 2), yTop - 1.3 * U - rr, zL]
    // Which way the arm points over the port (`inn`) and over the deck (`out`), set so that turning from the one to the
    // other goes round the side it should; how far out the wrist is over each, and half way round; and how high.
    const inn = s < 0 ? 0 : front ? -Math.PI : Math.PI, out = s < 0 ? (front ? -Math.PI : Math.PI) : 0
    // (Round the front the wrist is drawn in to no nearer than over the port: the deck stays clear of the lasers and,
    // on the page, over the roof's front edge, and the elbow stays over the column, out of the cannon's way.)
    const rw = Math.abs(top[0] - bx), rp = Math.abs(portX - bx), rMid = front ? rp : (rw + rp) / 2
    const yw = top[1] + rr + grip, low = yTop - .3 * U + grip, rest: [number, number, number] = [inn, rp, travel + .2 * U]
    const reach = Math.max(...[[rw, yw], [rw, travel], [rp, travel], [rp, low], [rMid, travel], [rest[1], rest[2]]].map(([r, y]) => Math.hypot(r, y - shoulder[1]))), L = reach / 1.9
    b.part('static3'); b.floor(ROOF)
    // The port: a kerb round it, the dark inside; the well the arm's column stands in.
    for (const [x0, x1, za, zb] of [[portX - hw - 1.4 * px, portX + hw + 1.4 * px, zL - pd - 1.4 * px, zL - pd], [portX - hw - 1.4 * px, portX + hw + 1.4 * px, zL + pd, zL + pd + 1.4 * px], [portX - hw - 1.4 * px, portX - hw, zL - pd, zL + pd], [portX + hw, portX + hw + 1.4 * px, zL - pd, zL + pd]]) b.box(x0, yTop, za, x1, yTop + 1.3 * px, zb, M.trim)
    b.quad([portX - hw, yTop + .14, zL - pd], [portX + hw, yTop + .14, zL - pd], [portX + hw, yTop + .14, zL + pd], [portX - hw, yTop + .14, zL + pd], M.slot, [0, 1, 0])
    b.cyl([bx, 0, zL], 1, yTop, yTop + .8 * px, rb + 1.2 * px, M.trim, 18, 2, M.slot)
    // The magazine (a wide page): a back plate on two posts, bolted to the console's side over a gusset, and the lift
    // the decks stand on, which rides up between the posts. Its front and top are open: the hand comes down from over
    // it, its fingers outside the deck's ends.
    let lift = -1
    const pitch = deckH, count = mine.length, foot = top[1] + rr - deckH - (count - 1) * pitch
    if (!p.phone) {
      b.floor(DESK)
      const xa = s < 0 ? -Xc - P - 1.5 * U : Xc, xb = s < 0 ? -Xc : Xc + P + 1.5 * U, zp = z1 + 2 * px, head = top[1] + rr
      b.box(xa, foot - .9 * U, zp, xb, head, zp + 1.4 * px, M.plinth)
      for (const x of [xa, xb - .3 * U]) b.box(x, foot - .9 * U, z1 - .6 * px, x + .3 * U, head + .3 * U, zp + 1.4 * px, M.steel, ALL)
      b.box(xa, foot - 1.25 * U, z1 - .6 * px, xb, foot - .9 * U, zp + 1.4 * px, M.trim, ALL)
      b.prism(ccw([[s * Xc, foot - 1.25 * U], [s * (Xc + .6 * P), foot - 1.25 * U], [s * Xc, foot - 2.5 * U]]), zp, zp + 1.4 * px, M.trim, 'fks', M.steel)
      for (const y of [foot + .4 * U, head - .8 * U]) b.cyl([s * (Xc + .55 * U), y, 0], 2, zp - .9 * px, zp, .9 * px, M.steel, 8, 1)
      lift = b.part(`lift${k}`, [top[0], foot, zL])
      b.box(top[0] - P / 2 - .2 * U, foot - .45 * U, z0 - 3 * px, top[0] + P / 2 + .2 * U, foot, z1 + 1.6 * px, M.trim, ALL)
      b.box(top[0] - P / 2 - .2 * U, foot, z0 - 3 * px, top[0] + P / 2 + .2 * U, foot + .25 * U, z0 - 2.2 * px, M.steel, ALL)
    }
    b.floor(ROOF)
    const cover = b.part(`port${k}`, [portX, yTop, zL])
    b.box(portX - hw + .5 * px, yTop + .3, zL - pd + .5 * px, portX + hw - .5 * px, yTop + 1.1 * px, zL + pd - .5 * px, M.steel, ALL, M.plinth)
    b.box(portX - .2 * P, yTop + 1.1 * px, zL - 1.2 * px, portX + .2 * P, yTop + 2 * px, zL + 1.2 * px, M.steel, ALL)
    const base = b.part(`arm${k}`, [bx, yTop, zL])
    b.cyl([bx, 0, zL], 1, yTop, yTop + .7 * au, rb, M.trim, 18, 2)
    b.cyl([bx, 0, zL], 1, yTop + .7 * au, shoulder[1] - .1 * au, .85 * au, M.arm, 14, 0)
    b.cyl([bx, shoulder[1], 0], 2, zL - 1.25 * au, zL + 1.25 * au, 1.05 * au, M.steel, 16, 3)
    const upper = b.part(`upper${k}`, shoulder)
    b.box(bx, shoulder[1] - .5 * au, zL - .55 * au, bx + L, shoulder[1] + .5 * au, zL + .55 * au, M.arm, ALL)
    b.box(bx + L * .62, shoulder[1] - .52 * au, zL - .57 * au, bx + L * .7, shoulder[1] + .52 * au, zL + .57 * au, M.brand, ALL)
    const fore = b.part(`fore${k}`, shoulder)
    b.cyl([bx, shoulder[1], 0], 2, zL - .85 * au, zL + .85 * au, .8 * au, M.steel, 14, 3)
    b.box(bx, shoulder[1] - .38 * au, zL - .42 * au, bx + L, shoulder[1] + .38 * au, zL + .42 * au, M.arm, ALL)
    b.cyl([bx + L, shoulder[1], 0], 2, zL - .62 * au, zL + .62 * au, .56 * au, M.steel, 12, 3)
    // (The hand: the wrist's pin, the bar, and on the bar's ends the two fingers, each a part: they open and close.)
    const hand = b.part(`hand${k}`, shoulder)
    b.cyl([bx, 0, zL], 1, shoulder[1] - .9 * au, shoulder[1], .26 * au, M.steel, 8, 0)
    b.box(bx - half - .25 * au, shoulder[1] - 1.35 * au, zL - .5 * au, bx + half + .25 * au, shoulder[1] - .9 * au, zL + .5 * au, M.trim, ALL)
    const fingers = [-1, 1].map(e => { const part = b.part(`finger${k}${e}`, shoulder); b.parts[part].plain = true; b.box(bx + (e < 0 ? -half : half - .3 * au), shoulder[1] - grip - deckH * .62, zL - .4 * au, bx + (e < 0 ? -half + .3 * au : half), shoulder[1] - 1.35 * au, zL + .4 * au, M.steel, ALL); return part })
    b.floor(SORT)
    return { s, portX, shoulder, L, lanes: mine, top, pitch, foot, count, inn, out, rw, rp, rMid, yw, low, travel, rest, front, hw, pd, rb, open: .45 * au, parts: { cover, base, upper, fore, hand, fingers, lift }, slide: 2 * pd + 2 * px, sink: 2.6 * px }
  })
  // The roof hangs from two cables while the floors under it are slid in: they come down out of the night to an eye
  // each side of it, a hook on the end of each, and are drawn up out of sight once it stands on the console.
  b.floor(ROOF)
  const eyes: V3[] = [-1, 1].map(s => [s * .74 * Xc, yTop, D * (p.phone ? .62 : .5)])
  b.part('static4')
  for (const e of eyes) { b.box(e[0] - 2.4 * px, yTop, e[2] - 2.4 * px, e[0] + 2.4 * px, yTop + 1.6 * px, e[2] + 2.4 * px, M.trim); b.cyl([e[0], yTop + 3.4 * px, 0], 2, e[2] - .8 * px, e[2] + .8 * px, 1.9 * px, M.steel, 10, 3) }
  const cables = b.part('cables')
  for (const e of eyes) { b.box(e[0] - .7 * px, yTop + 9 * px, e[2] - .7 * px, e[0] + .7 * px, yTop + 6000, e[2] + .7 * px, M.steel, ALL); b.box(e[0] - 1.5 * px, yTop + 5.4 * px, e[2] - 1.2 * px, e[0] + 1.5 * px, yTop + 9 * px, e[2] + 1.2 * px, M.trim, ALL) }

  // Capsules for the tubes, and bolts that can pop.
  const capH = r * 1.5, capR = r * .68
  // The units on the tower's sides (a wide page): one to each lane fitted after the first, plugged on as its lane is
  // fitted. Each is of the machine's own make: a box with a cap and a foot, on a bracket against the tower's side and
  // plugged in by a collar, a window in a bezel on its front, a plate for its name and a lamp. In the window, what
  // that part of the product does: a thread's tape deck, its reels turning as mail comes; an inbox's pigeonholes, a
  // letter put in one; a ritual's clock, its hand stepping round, and four lamps that step with it; an agent's
  // printer, the aerial it listens on; a mail app's screen, a new line on it; a campaign's horn over a stack of what
  // it sends. (Each is a floor of its own, so it is carried in whole; what moves on it is a part, and moves only while
  // the machine works.)
  const pods = p.pods.map((pod, k) => {
    const { x, y, z, w, h, d, s } = pod, x1 = x + w, y1 = y + h, route = p.routes[pod.lane], cx = x + w / 2, f0 = y + 2.9 * U, f1 = y1 - 1.1 * U, cy = (f0 + f1) / 2, wx0 = x + .55 * U, wx1 = x1 - .55 * U
    b.floor(4 + k); b.part(`static-pod${k}`)
    b.box(x, y, z, x1, y1, z + d, M.plinth)
    b.box(x - .25 * U, y1 - .5 * U, z - .25 * U, x1 + .25 * U, y1, z + d, M.trim); b.box(x - .25 * U, y, z - .25 * U, x1 + .25 * U, y + .5 * U, z + d, M.trim)
    // (Its bracket under it, against the tower's side; the collar it plugs in by.)
    b.prism(ccw(s < 0 ? [[x1, y], [x1, y - 2.2 * U], [x1 - 2.6 * U, y]] : [[x, y], [x + 2.6 * U, y], [x, y - 2.2 * U]]), z + .6 * U, z + 1.2 * U, M.trim, 'fks', M.steel)
    b.box(s < 0 ? x1 - .5 * U : x, y + .28 * h, z - .4 * U, s < 0 ? x1 : x + .5 * U, y + .72 * h, z, M.steel)
    for (const bx of [x + .7 * U, x1 - .7 * U]) for (const by of [y + .25 * U, y1 - .25 * U]) b.cyl([bx, by, 0], 2, z - .25 * U - 1.1 * px, z - .25 * U, 1.1 * px, M.steel, 8, 1)
    b.mark(x + .5 * U, y + .9 * U, x1 - 1.7 * U, y + 2.3 * U, z - .2, M.dark, 1)
    b.cyl([x1 - .95 * U, y + 1.6 * U, 0], 2, z - 1.6 * px, z, .38 * U + 1.2 * px, M.trim, 14, 1); b.cyl([x1 - .95 * U, y + 1.6 * U, 0], 2, z - 2 * px, z - 1.7 * px, .38 * U, M.lampOff, 14, 1)
    // The window and its bezel (an inbox's is the rack its pigeonholes are let into).
    b.mark(wx0, f0, wx1, f1, z - .2, route === 3 ? M.trim : M.screen, -1)
    for (const [a0, b0, a1, b1] of [[wx0 - .25 * U, f1, wx1 + .25 * U, f1 + .25 * U], [wx0 - .25 * U, f0 - .25 * U, wx1 + .25 * U, f0], [wx0 - .25 * U, f0, wx0, f1], [wx1, f0, wx1 + .25 * U, f1]]) b.box(a0, b0, z - .3 * U, a1, b1, z, M.trim)
    const moving: { reels: number[]; reelAt: V3[]; hand: number; handAt: V3; step: number; steps: V3[]; tip: number; letter: number; unread: number } = { reels: [], reelAt: [], hand: -1, handAt: [0, 0, 0], step: -1, steps: [], tip: -1, letter: -1, unread: -1 }
    if (route === 0) {
      // A tape deck: two reels, the tape from the one over a head and its two guides to the other.
      const ry = cy + .5 * U, zt = z - .5 * U
      b.box(cx - .55 * U, f0 + .35 * U, z - .7 * U, cx + .55 * U, f0 + 1.05 * U, z - .2, M.trim, ALL)
      for (const e of [-1, 1]) b.cyl([cx + e * .85 * U, f0 + 1.1 * U, 0], 2, z - .8 * U, z - .2, .2 * U, M.steel, 8, 1)
      b.tube([[cx - 1.95 * U, ry - 1.22 * U, zt], [cx - .85 * U, f0 + 1.32 * U, zt], [cx + .85 * U, f0 + 1.32 * U, zt], [cx + 1.95 * U, ry - 1.22 * U, zt]], .07 * U, M.ink, 4, .3 * U)
      for (const e of [-1, 1]) {
        const rx = cx + e * 1.95 * U, at: V3 = [rx, ry, z], part = b.part(`reel${k}${e}`, at)
        b.parts[part].plain = true; moving.reels.push(part); moving.reelAt.push(at)
        // (A reel: the tape wound on its hub, seen through the three windows of its flange: a steel rim, and three
        // broad spokes out from the hub to it.)
        b.cyl([rx, ry, 0], 2, z - .55 * U, z - .25 * U, 1.2 * U, M.rubber, 20, 1)
        const zf = z - .62 * U, arc = (r0: number, r1: number, a0: number, a1: number) => { const n = Math.max(1, Math.round((a1 - a0) / .3)); for (let j = 0; j < n; j++) { const p0 = a0 + (a1 - a0) * j / n, p1 = a0 + (a1 - a0) * (j + 1) / n; b.quad([rx + Math.cos(p0) * r0, ry + Math.sin(p0) * r0, zf], [rx + Math.cos(p0) * r1, ry + Math.sin(p0) * r1, zf], [rx + Math.cos(p1) * r1, ry + Math.sin(p1) * r1, zf], [rx + Math.cos(p1) * r0, ry + Math.sin(p1) * r0, zf], M.steel, [0, 0, -1]) } }
        arc(1.28 * U, 1.5 * U, 0, Math.PI * 2)
        for (let i = 0; i < 3; i++) { const a = (i / 3 + e * .05) * Math.PI * 2; arc(.42 * U, 1.28 * U, a - .42, a + .42) }
        b.cyl([rx, ry, 0], 2, z - .8 * U, z - .25 * U, .42 * U, M.steel, 12, 1); b.cyl([rx, ry, 0], 2, z - .84 * U, z - .8 * U, .16 * U, M.slot, 8, 1)
      }
    } else if (route === 3) {
      // Pigeonholes, three by two, a letter in most: its stamp in the corner. One more is put in as mail comes.
      for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
        const hx = cx - 3.7 * U + c * 2.55 * U, hy = cy - 2.55 * U + r * 2.75 * U, n = r * 3 + c
        b.mark(hx, hy, hx + 2.3 * U, hy + 2.35 * U, z - .25, M.slot, -1)
        if (n === 4) { moving.letter = b.part(`pod-letter${k}`); b.parts[moving.letter].plain = true }
        if (n !== 1) { b.box(hx + .3 * U, hy + .25 * U, z - .5 * U, hx + 2 * U, hy + 1.45 * U, z - .25, n % 2 ? M.dim : M.paper, ALL); b.mark(hx + 1.45 * U, hy + .95 * U, hx + 1.85 * U, hy + 1.35 * U, z - .5 * U - .05, M.brand) }
        if (n === 4) b.part(`static-pod${k}`)
      }
    } else if (route === 5) {
      // A clock, its hand stepped round once for each letter, and four lamps that step with it.
      const dx = x + 3.05 * U, r0 = 2.1 * U
      b.cyl([dx, cy, 0], 2, z - .4 * U, z - .2, r0 + .3 * U, M.trim, 24, 1); b.cyl([dx, cy, 0], 2, z - .45 * U, z - .4 * U, r0, M.dial, 24, 1)
      for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a), l0 = i % 3 ? .76 : .6, wd = (i % 3 ? .05 : .09) * U; b.prism(ccw([[dx + c * r0 * l0 - sn * wd, cy + sn * r0 * l0 + c * wd], [dx + c * r0 * l0 + sn * wd, cy + sn * r0 * l0 - c * wd], [dx + c * r0 * .9 + sn * wd, cy + sn * r0 * .9 - c * wd], [dx + c * r0 * .9 - sn * wd, cy + sn * r0 * .9 + c * wd]]), z - .47 * U, z - .46 * U, M.ink, 'f') }
      for (let i = 0; i < 4; i++) { const at: V3 = [x1 - 1.75 * U, cy + (1.5 - i) * 1.25 * U, z]; moving.steps.push(at); b.cyl([at[0], at[1], 0], 2, z - 2 * px, z - .2, .42 * U + 1 * px, M.trim, 12, 1); b.cyl([at[0], at[1], 0], 2, z - 2.3 * px, z - 2 * px, .42 * U, M.lampOff, 12, 1) }
      moving.handAt = [dx, cy, z]; moving.hand = b.part(`pod-hand${k}`, moving.handAt); b.parts[moving.hand].plain = true
      b.prism(ccw([[dx - .1 * U, cy - .3 * U], [dx + .1 * U, cy - .3 * U], [dx + .04 * U, cy + 1.7 * U], [dx - .04 * U, cy + 1.7 * U]]), z - .6 * U, z - .55 * U, M.ink, 'f'); b.cyl([dx, cy, 0], 2, z - .65 * U, z - .45 * U, .22 * U, M.steel, 8, 1)
      moving.step = b.part(`pod-step${k}`, moving.steps[0]); b.parts[moving.step].plain = true; b.cyl([moving.steps[0][0], moving.steps[0][1], 0], 2, z - 2.5 * px, z - 2.35 * px, .42 * U, M.lampOn, 12, 1)
    } else if (route === 2) {
      // A printer, the paper it prints hanging out of its slot; on its top an aerial, its tip lit when a message comes.
      b.cyl([x + 1.6 * U, 0, z + d * .5], 1, y1, y1 + 3.4 * U, .14 * U, M.steel, 6, 0); b.cyl([x + 1.6 * U, 0, z + d * .5], 1, y1, y1 + .4 * U, .45 * U, M.trim, 10, 2)
      b.cyl([x + 1.6 * U, 0, z + d * .5], 1, y1 + 3.4 * U, y1 + 4 * U, .36 * U, M.lampOff, 10, 3)
      for (let r = 0; r < 3; r++) b.mark(cx - 2.9 * U, f0 + .45 * U + r * .5 * U, cx + 2.9 * U, f0 + .7 * U + r * .5 * U, z - .25, M.slot, -1)
      b.box(cx - 2.8 * U, f1 - 1.6 * U, z - .7 * U, cx + 2.8 * U, f1 - .9 * U, z - .2, M.trim, ALL); b.mark(cx - 2.4 * U, f1 - 1.35 * U, cx + 2.4 * U, f1 - 1.15 * U, z - .7 * U - .05, M.slot)
      b.box(cx - 2.1 * U, cy - 1.2 * U, z - .9 * U, cx + 2.1 * U, f1 - 1.25 * U, z - .8 * U, M.paper, ALL)
      for (let r = 0; r < 3; r++) b.mark(cx - 1.7 * U, cy - .7 * U + r * .55 * U, cx + (r === 1 ? .9 : 1.5) * U, cy - .58 * U + r * .55 * U, z - .9 * U - .05, M.ink)
      moving.tip = b.part(`pod-tip${k}`); b.parts[moving.tip].plain = true; b.cyl([x + 1.6 * U, 0, z + d * .5], 1, y1 + 3.38 * U, y1 + 4.02 * U, .37 * U, M.red, 10, 3)
    } else if (route === 4) {
      // A mail app's screen: a list, each line a dot and a subject; a new one lit at its head as mail comes.
      for (let r = 0; r < 4; r++) { const ly = f1 - .95 * U - r * 1.15 * U; b.mark(wx0 + .55 * U, ly - .17 * U, wx0 + .9 * U, ly + .17 * U, z - .3, r ? M.dim : M.rim); b.mark(wx0 + 1.25 * U, ly - .12 * U, wx0 + (r % 2 ? 5.3 : 6.6) * U, ly + .12 * U, z - .3, r ? M.rim : M.dim) }
      moving.unread = b.part(`pod-unread${k}`); b.parts[moving.unread].plain = true; b.mark(wx0 + .5 * U, f1 - 1.17 * U, wx0 + .95 * U, f1 - .73 * U, z - .4, M.lampOn)
    } else if (route === 6) {
      // A horn on a bracket, turned outwards, over a stack of what it sends.
      const hy = f1 - 1.5 * U, hz = z - 1.4 * U, throat = cx - s * .9 * U, mouth = cx + s * 3.25 * U
      b.box(cx - .25 * U, hy - .2 * U, hz, cx + .25 * U, hy + .2 * U, z - .2, M.steel, ALL)
      b.cyl([0, hy, hz], 0, Math.min(throat, mouth), Math.max(throat, mouth), s < 0 ? 1.2 * U : .32 * U, M.trim, 18, 3, M.slot, s < 0 ? .32 * U : 1.2 * U)
      b.cyl([0, hy, hz], 0, throat - s * .5 * U, throat, .38 * U, M.steel, 10, 3)
      for (let r = 0; r < 4; r++) b.box(x + 1.4 * U + r * .12 * U, f0 + .2 * U + r * .42 * U, z - 1.3 * U, x1 - 1.4 * U - r * .1 * U, f0 + .2 * U + r * .42 * U + .32 * U, z - .25, r % 2 ? M.dim : M.paper, ALL)
    }
    const lamp = b.part(`pod-lamp${k}`); b.cyl([x1 - .95 * U, y + 1.6 * U, 0], 2, z - 2.3 * px, z - 2.1 * px, .38 * U, M.lampOn, 14, 1)
    return { lamp, lane: pod.lane, route, ...moving }
  })

  b.floor(CORE)
  for (let i = 0; i < 28; i++) { idx.caps.push(b.part(`cap${i}`)); b.cyl([0, 0, 0], 1, -capH, capH, capR, M.paper, 8, 0); b.cyl([0, 0, 0], 1, capH, capH + capR * .7, capR, M.brand, 8, 2); b.cyl([0, 0, 0], 1, -capH - capR * .7, -capH, capR, M.paper, 8, 1) }
  b.floor(SORT)
  for (const [x, y] of [[-Xb - px, yFas + px], [Xb + px, yFas + px], [-Xb - px, yCav - px], [Xb + px, yCav - px], [0, yFas + px], [-Xb / 2, yCav - px], [Xb / 2, yCav - px], [-Xb / 2, yFas + px], [Xb / 2, yFas + px]] as [number, number][]) {
    idx.bolts.push(b.part(`bolt${idx.bolts.length}`, [x, y, -2.6 * px])); b.cyl([x, y, 0], 2, -3.2 * px, -2 * px, 1.5 * px, M.steel, 8, 3)
  }

  // What the burst leaves: soot and a torn hole in the roof where the hopper stood, splinters of glass in the frame.
  const ch = p.cavity
  // (Where the hopper stood the roof is torn open: an uneven hole, the sheet round it bent up and out in flaps, their
  // undersides to the hole; soot on the roof all round. Seen from the front, the far flaps show their dark undersides
  // and the near ones their backs.)
  const rim: [number, number][] = [[-1.2, -.95], [-.2, -1.1], [.95, -.9], [1.35, .1], [1.05, 1.45], [-.1, 1.7], [-1.1, 1.4], [-1.45, .2]].map(([x, z]) => [x * hb, zL + z * hd])
  const fan = (points: [number, number][], y: number, mat: number, grow = 1) => { for (let i = 0; i < points.length; i++) { const [ax, az] = points[i], [bx, bz] = points[(i + 1) % points.length]; b.tri([0, y, zL + .3 * hd], [ax * grow, y, zL + .3 * hd + (az - zL - .3 * hd) * grow], [bx * grow, y, zL + .3 * hd + (bz - zL - .3 * hd) * grow], [0, 1, 0], mat) } }
  b.floor(ROOF)
  idx.soot = b.part('soot', [0, 0, 0], true)
  fan(rim, yTop + .2, M.scorch, 1.75)
  idx.hole = b.part('hole')
  fan(rim, yTop + .3, M.slot)
  rim.forEach(([ax, az], i) => {
    const [bx, bz] = rim[(i + 1) % rim.length], mx = (ax + bx) / 2, mz = (az + bz) / 2, ox = mx, oz = mz - zL - .3 * hd, l = Math.hypot(ox, oz) || 1, nx = ox / l, nz = oz / l
    // Each a torn four-sided piece standing on the hole's rim and leaning out over the roof; every other one short.
    const h = (i % 2 ? 8 : 12.5) * px, outBy = (i % 2 ? 5 : 7.5) * px, skew = (i % 3 - 1) * 2.6 * px, grow = 1.12
    const a: V3 = [ax * grow, yTop + .3, zL + .3 * hd + (az - zL - .3 * hd) * grow], c: V3 = [bx * grow, yTop + .3, zL + .3 * hd + (bz - zL - .3 * hd) * grow]
    const tip: V3 = [mx * grow + nx * outBy - nz * skew, yTop + h, zL + .3 * hd + (mz - zL - .3 * hd) * grow + nz * outBy + nx * skew], tip2: V3 = [tip[0] + (bx - ax) * .3, tip[1] - 2.6 * px, tip[2] + (bz - az) * .3]
    // Its back (the roof's own face, turned outwards and lit), its underside (to the hole, dark), and the sheet's
    // torn edge along its top, bright.
    b.quad(a, c, tip2, tip, M.body, unit([nx, .9, nz]))
    b.quad([a[0] - nx * .5, a[1], a[2] - nz * .5], [c[0] - nx * .5, c[1], c[2] - nz * .5], [tip2[0] - nx * .5, tip2[1], tip2[2] - nz * .5], [tip[0] - nx * .5, tip[1], tip[2] - nz * .5], M.plinth, [0, -1, 0])
    b.tube([tip, tip2], .55 * px, M.steel, 4)
  })
  b.floor(SORT)
  idx.shards = b.part('shards', [0, 0, 0], true)
  const shard = (points: [number, number][]) => { b.prism(ccw(points), -1.3 * px, -1.2 * px, M.sheen, 'f'); b.prism(ccw(points), -1.25 * px, -1.2 * px, M.glass, 'f') }
  shard([[-Xb, yFas], [-Xb + Xb * .2, yFas], [-Xb + Xb * .08, yFas - ch * .3], [-Xb, yFas - ch * .46]]); shard([[-Xb, yCav], [-Xb + Xb * .26, yCav], [-Xb + Xb * .1, yCav + ch * .16], [-Xb, yCav + ch * .3]])
  shard([[Xb, yFas], [Xb - Xb * .14, yFas], [Xb - Xb * .18, yFas - ch * .18], [Xb, yFas - ch * .38]]); shard([[Xb, yCav], [Xb - Xb * .3, yCav], [Xb - Xb * .09, yCav + ch * .24], [Xb, yCav + ch * .2]])
  shard([[-Xb * .3, yFas], [-Xb * .1, yFas], [-Xb * .17, yFas - ch * .22]]); shard([[Xb * .2, yCav], [Xb * .4, yCav], [Xb * .33, yCav + ch * .14]]); shard([[Xb * .34, yFas], [Xb * .5, yFas], [Xb * .46, yFas - ch * .13]])
  // The panes the glass breaks into: thrown by the burst.
  for (let i = 0; i < 8; i++) {
    const cx = (i - 3.5) * Xb * .24 + ((i * 37) % 9 - 4) * px, cy = yCav + ch * (.3 + ((i * 53) % 5) * .1), w = Xb * (.09 + ((i * 29) % 4) * .02), h = ch * (.22 + ((i * 17) % 3) * .08)
    idx.panes.push(b.part(`pane${i}`, [cx, cy, -1.2 * px], true))
    const points = ccw([[cx - w, cy - h * .6], [cx + w * .7, cy - h], [cx + w, cy + h * .4], [cx - w * .3, cy + h]])
    b.prism(points, -1.6 * px, -.8 * px, M.pane, 'fk')
  }
  // Before it goes, the glass cracks: twice, each a star of hairlines from where it gave.
  const hair = (x0: number, y0: number, x1: number, y1: number) => { const l = Math.hypot(x1 - x0, y1 - y0) || 1, nx = -(y1 - y0) / l * .45 * px, ny = (x1 - x0) / l * .45 * px; b.quad([x0 - nx, y0 - ny, -1.5 * px], [x1 - nx, y1 - ny, -1.5 * px], [x1 + nx, y1 + ny, -1.5 * px], [x0 + nx, y0 + ny, -1.5 * px], M.crack, [0, 0, -1]) }
  const crackAt: [number, number][] = [[-Xb * .34, yCav + ch * .62], [Xb * .46, yCav + ch * .4]]
  crackAt.forEach(([cx, cy], n) => {
    idx.cracks.push(b.part(`crack${n}`, [0, 0, 0], true))
    for (let i = 0; i < 9; i++) {
      const a = i / 9 * Math.PI * 2 + n * .5 + ((i * 7) % 5) * .09, l1 = (.16 + ((i * 13 + n * 5) % 7) * .035) * Xb, a2 = a + (((i * 11) % 5) - 2) * .16, l2 = l1 * (.5 + ((i * 3) % 4) * .16)
      const clampY = (y: number) => Math.min(yFas - px, Math.max(yCav + px, y)), clampX = (x: number) => Math.min(Xb - px, Math.max(-Xb + px, x))
      const mx = clampX(cx + Math.cos(a) * l1), my = clampY(cy + Math.sin(a) * l1 * .7), ex = clampX(mx + Math.cos(a2) * l2), ey = clampY(my + Math.sin(a2) * l2 * .7)
      hair(cx, cy, mx, my); hair(mx, my, ex, ey)
      if (i % 3 === 0) hair(mx, my, clampX(mx + Math.cos(a2 + 1.1) * l2 * .6), clampY(my + Math.sin(a2 + 1.1) * l2 * .5))
    }
  })
  idx.glass = b.part('glass', [0, (yCav + yFas) / 2, -1.2 * px], true)
  b.mark(-Xb, yCav, Xb, yFas, -1.2 * px, M.glass)

  // The tubes themselves. Each is one or two runs: down the front between the manifolds, and (on a wide page) from
  // its outlet in the header forward across the slab, over the lip and down. One of the front runs is its own part:
  // the burst bends it out of its socket.
  const lines: V3[][][] = [], drop = -(p.floor + 20) - DY * p.zOver
  // (Glass throws no shadow in the renderer's map; what each tube throws on the slab is laid there: a strip of dark
  // veil, to the left of the tube and behind it, as the light falls.)
  b.floor(CORE)
  b.part('umbra', [0, 0, 0], true)
  for (const [a0, a1, a2, a3] of umbra) b.quad(a0, a1, a2, a3, M.umbra, [0, 1, 0], 1)
  idx.tubes = b.part('tubes', [0, 0, 0], true)
  p.tubes.forEach((x, t) => {
    const leg = p.fan[t]
    // (A capsule's way begins a capsule's length inside the block or the header it comes out of, and ends as far
    // inside the block it goes into.)
    if (t !== bentTube) b.tube([[x, yMan, zt], [x, yLow, zt]], r, M.tube, 12)
    else b.tube([[x, bentY, zt], [x, yLow, zt]], r, M.tube, 12)
    lines.push([[[x, yMan + 2 * r, zt], [x, yLow - 2 * r, zt]], [[leg.x, yc, p.heads[0].z0 + 2 * r + 2], ...b.tube([[leg.x, yc, p.heads[0].z0 - 4 * px], [leg.x, yc, p.zOver], [leg.x, drop, p.zOver]], r, M.tube, 12, r * 3)]])
  })
  // The outbound tube, a ninth, and its capsules' way up it: over the lip, along the cabinet's front and into the
  // trunk; out of the trunk's back and into the chest; up the feed and into the breech. (A phone's comes up under
  // the slab, unseen: only the feed.)
  b.floor(GUN); b.part('feed', [0, 0, 0], true)
  const feed = b.tube([[kink[0], baseTop, cz], kink, along(-C.back + 2 * px)], r, M.tube, 12, r * 1.5), feedRun: V3[] = [[kink[0], baseTop - 2 * r, cz], ...feed, along(-C.back + 3 * r)]
  b.floor(CORE); b.part('mains', [0, 0, 0], true)
  if (trunk) {
    const up = b.tube([[outX, drop, p.zOver], [outX, yc, p.zOver], [outX, yc, zJ], [portX, yc, zJ], [portX, yc, trunk.z0 - 4 * px]], r, M.tube, 12, r * 2.4)
    const link = b.tube([[kink[0], yc, trunk.z1 - 2 * px], [kink[0], yc, chestZ - 4 * px]], r, M.tube, 12)
    lines.push([[...up, [portX, yc, trunk.z0 + 2 * r]], [[kink[0], yc, trunk.z1 - 2 * r], ...link, [kink[0], yc, chestZ + 2 * r]], feedRun])
  } else lines.push([feedRun])
  // (A phone's three tubes come up out of the slab by its front edge, each through a collar, turn over the lip as the
  // wide page's do, wearing a collar there too, and run on down the page.)
  for (const pipe of p.hung) {
    const over = p.zLip - pipe.r - 3 * px, x = pipe.x - p.ox - DX * over, back = p.zLip + 2.6 * pipe.r, lie = pipe.r + 1.5 * px
    b.tube([[x, 0, back], [x, lie, back], [x, lie, over], [x, -(p.floor + 20) - DY * over, over]], pipe.r, M.tube, 12, pipe.r * 1.5)
  }
  idx.bent = b.part('bent', [p.tubes[bentTube] ?? 0, p.fan.length ? bentY : yWall, zt], true)
  if (p.fan.length) b.tube([[p.tubes[bentTube], yMan - 3 * px, zt], [p.tubes[bentTube], bentY, zt]], r, M.tube, 12)
  // The lengths of bracket that go with it.
  idx.bentHeld = b.part('bentHeld', [p.tubes[bentTube] ?? 0, p.fan.length ? bentY : yWall, zt])
  if (p.fan.length) for (const y of bracketY) if (y > bentY) bracket(p.tubes[bentTube] - pitch / 2, p.tubes[bentTube] + pitch / 2, y)

  const data = b.finish()
  return { data, parts: b.parts, idx, arms, pods, cables, grip, deckH, half, wall, lines, rollerLane, rollerHome, hinge, swing, rr, yR, rideY, scanY, z0, z1, turrets, ejects, beacon, vents, valves, panel, cannon: { pivot, ce, se }, hole: { x: 0, z: zL + .3 * hd, r: 1.5 * Math.max(hb, hd) + 7 * px }, hatchHinge: [-Xw * .3, yTop, D * .88] as V3, crackAt, ventFront: [ventX, ga.y, -3 * px] as V3, hopperTop: yTop + hh, hopperWide: ht, px }
}
const phone = (p: Plan) => p.phone

export type Fitter = Machine['arms'][number]
const smooth = (t: number) => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)
/** A fitter's arm bent so its wrist is `r` out from its column and `dy` over its shoulder: the upper arm's angle from
 *  level and the forearm's, into `out` (the elbow is always up). */
export function bend(L: number, r: number, dy: number, out: Float32Array) {
  const reach = Math.min(Math.max(Math.hypot(r, dy), .2 * L), 1.98 * L), t1 = Math.atan2(dy, r) + Math.acos(reach / (2 * L))
  out[0] = t1; out[1] = Math.atan2(dy - Math.sin(t1) * L, r - Math.cos(t1) * L)
}
// One deck's fitting, as moments of the job (0 to 1): round to over the deck, down on it, the fingers close, up clear
// of everything, round to over the port, down into it, the fingers open, up, and back to rest. (Each swing round its
// column eases in, and the one out to the deck runs a little past and settles back, as a heavy arm does; the one in
// to the port stops dead: a phone's cannon stands just behind it.)
export const JOB = { out: .15, down: .22, shut: .26, lift: .35, round: .55, low: .66, open: .71, up: .83, cover: [.38, .52, .8, .92] as const }
/** Where a fitter's hand is at `u` through a job that began with it at `from` (which way, how far out, how high):
 *  into `out` with how far its fingers are closed and its port's cover open. */
export function fitterAt(A: Fitter, from: ArrayLike<number>, u: number, out: Float32Array) {
  const J = JOB
  let yaw: number, r: number, y: number
  const swing = (t: number, y0: number, r0: number, h0: number, y1: number, r1: number, h1: number, settle: boolean) => {
    const e = smooth(t), turn = settle ? 1 + 2.2 * (e - 1) ** 3 + 1.2 * (e - 1) ** 2 : e, bump = Math.max(0, (r0 + r1) / 2 - A.rMid)
    yaw = y0 + (y1 - y0) * turn; r = r0 + (r1 - r0) * e - bump * 4 * e * (1 - e); y = h0 + (h1 - h0) * e
  }
  const move = (t: number, r0: number, h0: number, r1: number, h1: number, at: number) => { const e = smooth(t); yaw = at; r = r0 + (r1 - r0) * e; y = h0 + (h1 - h0) * e }
  if (u < J.out) swing(u / J.out, from[0], from[1], from[2], A.out, A.rw, A.travel, true)
  else if (u < J.down) move((u - J.out) / (J.down - J.out), A.rw, A.travel, A.rw, A.yw, A.out)
  else if (u < J.lift) move(u < .27 ? 0 : (u - .27) / (J.lift - .27), A.rw, A.yw, A.rw, A.travel, A.out)
  else if (u < J.round) swing((u - J.lift) / (J.round - J.lift), A.out, A.rw, A.travel, A.inn, A.rp, A.travel, false)
  else if (u < J.low) move((u - J.round) / (J.low - J.round), A.rp, A.travel, A.rp, A.low, A.inn)
  else if (u < J.up) move(u < .73 ? 0 : (u - .73) / (J.up - .73), A.rp, A.low, A.rp, A.travel, A.inn)
  else move((u - J.up) / (1 - J.up), A.rp, A.travel, A.rest[1], A.rest[2], A.inn)
  out[0] = yaw!; out[1] = r!; out[2] = y!
  out[3] = smooth((u - J.down) / (J.shut - J.down)) * (1 - smooth((u - J.low - .01) / (J.open - J.low - .01)))
  out[4] = smooth((u - J.cover[0]) / (J.cover[1] - J.cover[0])) * (1 - smooth((u - J.cover[2]) / (J.cover[3] - J.cover[2])))
}
