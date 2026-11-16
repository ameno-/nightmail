// The machine before its engine has loaded: its cabinet, the sorting frame with the price in it and the wordmark at
// its head, the works' bay and its roller line, the hopper and chimneys, the manifolds, tubes and headers, drawn flat
// on a 2D canvas in the same places and tones the renderer will use (machine.ts is the measure of every number here).
// It is on the page from the first paint; the renderer's first frame is laid over it and comes up through it.
import { COLS, PRICE } from './price'
import { DX, DY, type Plan } from './plan'
import { glass, tone, type Mat } from './tones'
import { WORDMARK } from '../../../lib/marks'

/** `whole`: the tower as it ends up, every floor and every lane's works in (a page shown without motion). Otherwise
 *  as it begins: its foot and the price's frame, and the roof straight on those with the hopper on it. */
export function drawStill(canvas: HTMLCanvasElement, p: Plan, over: number, dark: boolean, whole = false) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2), c = canvas.getContext('2d')!
  canvas.width = Math.round(p.W * dpr); canvas.height = Math.round((p.H + over) * dpr)
  c.setTransform(dpr, 0, 0, dpr, 0, 0)
  const X = (x: number, z = 0) => p.ox + x + DX * z, Y = (y: number, z = 0) => p.oy + over - y - DY * z
  const fill = (mat: Mat, t: 0 | 1 | 2 | 3) => { c.fillStyle = tone(mat, t, dark) }
  const face = (points: [number, number, number][]) => { c.beginPath(); points.forEach(([x, y, z], i) => i ? c.lineTo(X(x, z), Y(y, z)) : c.moveTo(X(x, z), Y(y, z))); c.fill() }
  const front = (x0: number, y0: number, x1: number, y1: number) => c.fillRect(X(x0), Y(y1), x1 - x0, y1 - y0)
  const { Xc, Xw, Xb, D, U, V, yTop, yWall, yMan, ySlot, yCav, yFas } = p
  // The slab: its top, its lip.
  fill('slab', dark ? 1 : 0); face([[-p.slabX, 0, p.zLip], [p.slabX, 0, p.zLip], [p.slabX, 0, p.zBack], [-p.slabX, 0, p.zBack]])
  fill('slab', 1); face([[-p.slabX, 0, p.zLip], [p.slabX, 0, p.zLip], [p.slabX, -p.lip, p.zLip], [-p.slabX, -p.lip, p.zLip]])
  // (How high the tower stands for now, and how far down the roof and what is on it are drawn for that.)
  const head = whole ? yTop : ySlot, drop = yTop - head
  const roof = (draw: () => void) => { c.save(); c.translate(0, drop); draw(); c.restore() }
  fill('body', 3); face([[-Xc, 0, 0], [-Xc, 0, D], [-Xc, head, D], [-Xc, head, 0]])
  fill('body', 0); face([[-Xc, head, 0], [Xc, head, 0], [Xc, head, D], [-Xc, head, D]])
  fill('body', 1); front(-Xc, yWall, Xc, head)
  fill('plinth', 1); front(-Xc, 0, Xc, yWall)
  fill('wall', 1); front(-Xw, yWall, Xw, yMan)
  fill('trim', 1); front(-Xc, yMan, Xc, ySlot)
  if (whole) { fill('dark', 1); front(-Xb, yCav, Xb, yFas) }
  // The board the sentence stands on, in its frame; a wide page's rail over the base; a phone's plate the two facts
  // are on, riveted to the base.
  { const e = 1.2 * U / 9, half = COLS * U / 2 + 1.3 * U, right = half + (p.phone ? 0 : .017 * COLS * U), y0 = p.yBand + (p.phone ? .09 : .15) * p.band, y1 = p.yBand + (p.phone ? .91 : .85) * p.band
    fill('plinth', dark ? 2 : 1); front(-half, y0, right, y1); fill('trim', 1); front(-half - e, y1, right + e, y1 + e); front(-half - e, y0 - e, right + e, y0); front(-half - e, y0, -half, y1); front(right, y0, right + e, y1)
    if (!p.phone) { fill('trim', 1); front(-Xc, p.yBand - U / 9, Xc, p.yBand + U / 9) }
    else { const f = p.facts, xa = f[0].x - 1.3 * U, xb = f[1].x + f[1].w + 1.3 * U, ya = f[0].y - 10, yb = f[0].y + f[0].h + 9; fill('plinth', dark ? 2 : 1); front(xa, ya, xb, yb); fill('plinth', 0); front(xa, yb - e, xb, yb); fill('trim', 1); for (const x of [xa + .8 * U, xb - .8 * U]) for (const y of [ya + .8 * U, yb - .8 * U]) { c.beginPath(); c.arc(X(x), Y(y), .26 * U, 0, Math.PI * 2); c.fill() } } }
  fill('body', 1); front(p.cta.x - p.plate, p.cta.y - p.plate, p.cta.x + p.cta.w + p.plate, p.cta.y + p.cta.h + p.plate)
  // (The button's frame and the faceplate's four bolts; under the page's button, its own face, so no dark edge of the
  // bay shows round it.)
  { const c0 = p.cta, f = 2.5 * U / 9, pl = p.plate; fill('trim', 1); front(c0.x - f, c0.y + c0.h, c0.x + c0.w + f, c0.y + c0.h + f); front(c0.x - f, c0.y - f, c0.x + c0.w + f, c0.y); front(c0.x - f, c0.y, c0.x, c0.y + c0.h); front(c0.x + c0.w, c0.y, c0.x + c0.w + f, c0.y + c0.h)
    fill('steel', 1); for (const x of [c0.x - pl * .5 - f * .5, c0.x + c0.w + pl * .5 + f * .5]) for (const y of [c0.y - pl * .5 - f * .5, c0.y + c0.h + pl * .5 + f * .5]) { c.beginPath(); c.arc(X(x), Y(y), 1.2 * U / 9, 0, Math.PI * 2); c.fill() } }
  fill('lit', 1); front(p.cta.x, p.cta.y, p.cta.x + p.cta.w, p.cta.y + p.cta.h)
  if (!p.phone) { fill('screen', 1); for (const w of p.facts) front(w.x, w.y, w.x + w.w, w.y + w.h) }
  if (whole) { fill('screen', 1); front(p.readout.x, p.readout.y, p.readout.x + p.readout.w, p.readout.y + p.readout.h) }
  // The tubes' channels down the front, and the gauge's face.
  fill('dark', 1); for (const x of p.tubes) front(x - p.tubeR - U / 9, yWall + 1.7 * V, x + p.tubeR + U / 9, yMan)
  if (whole) { fill('trim', 1); c.beginPath(); c.arc(X(p.gauge.x), Y(p.gauge.y), p.gauge.r + 2.5 * U / 9, 0, Math.PI * 2); c.fill()
    fill('dial', 1); c.beginPath(); c.arc(X(p.gauge.x), Y(p.gauge.y), p.gauge.r, 0, Math.PI * 2); c.fill() }
  // A box as the page sees one: its left side, its top, its front.
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: Mat, top: Mat = mat) => {
    fill(mat, 3); face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]])
    fill(top, 0); face([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]])
    fill(mat, 1); face([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]])
  }
  const px = U / 9, r = p.tubeR, zt = p.zt, lower = p.phone ? 0 : 1.7 * V, yLow = lower ? yWall + lower : r + px, zBlock = p.zProud, lean = DX * zBlock, zL = p.zL
  // A level ring on the roof (a well, an eye's ring seen from above): its outline as the page sees it.
  const disc = (x: number, y: number, z: number, radius: number) => { c.beginPath(); for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; const qx = X(x + Math.cos(a) * radius, z + Math.sin(a) * radius), qy = Y(y, z + Math.sin(a) * radius); i ? c.lineTo(qx, qy) : c.moveTo(qx, qy) } c.fill() }
  // On the roof (as the renderer has it before the build): its seams and kerb; two chimneys and the hatch; a laser
  // on its pedestal at each end, hanging muzzle down (pointing up once the machine is whole); the slots scams leave by;
  // the fitters' ports under their covers and the wells they come up out of; the cables back to their junction boxes;
  // the beacon; the eyes the roof hangs from, and the cables down to them; the hopper.
  roof(() => {
  fill('line', 0); for (const x of [-Xw, Xw]) face([[x - .5 * px, yTop, 2.5 * px], [x + .5 * px, yTop, 2.5 * px], [x + .5 * px, yTop, D - 2.5 * px], [x - .5 * px, yTop, D - 2.5 * px]])
  face([[-Xw, yTop, D * .5 - .5 * px], [Xw, yTop, D * .5 - .5 * px], [Xw, yTop, D * .5 + .5 * px], [-Xw, yTop, D * .5 + .5 * px]])
  box(-Xc, yTop, D - 2.5 * px, Xc, yTop + 2 * px, D, 'trim'); box(-Xc, yTop, 0, -Xc + 2.5 * px, yTop + 2 * px, D, 'trim'); box(Xc - 2.5 * px, yTop, 0, Xc, yTop + 2 * px, D, 'trim'); box(-Xc, yTop, 0, Xc, yTop + 2 * px, 2.5 * px, 'trim')
  if (!p.phone) {
    for (const [x, z] of [[-Xw * .84, D * .7], [Xw * .88, D * .66]]) { box(x - 4.5 * px, yTop, z, x + 4.5 * px, yTop + 11 * px, z + .1, 'steel'); box(x - 6 * px, yTop + 11 * px, z - 4 * px, x + 6 * px, yTop + 13 * px, z + 4 * px, 'trim', 'slot') }
    box(-Xw * .46, yTop, D * .64, -Xw * .14, yTop + 4.4 * px, D * .88, 'steel', 'body'); box(-Xw * .33, yTop + 4.4 * px, D * .73, -Xw * .27, yTop + 6.2 * px, D * .79, 'steel')
    for (const s of [-1, 1]) { const x = s * (Xc - 2.6 * U), jx = x - s * 1.6 * U; box(x - 1.3 * px, yTop, 7 * px, x + 1.3 * px, yTop + 2.7 * px, D * .52, 'rubber'); box(Math.min(x, jx), yTop, D * .52 - 1.3 * px, Math.max(x, jx), yTop + 2.7 * px, D * .52 + 1.3 * px, 'rubber'); box(jx - 4 * px, yTop, D * .52 - 4 * px, jx + 4 * px, yTop + 4 * px, D * .52 + 4 * px, 'plinth') }
  }
  const beacon = Xc - (p.phone ? 4.5 : 3) * U
  box(beacon - 1.2 * px, yTop, D * .82, beacon + 1.2 * px, yTop + 8 * px, D * .82 + .1, 'steel'); box(beacon - 3.6 * px, yTop + 8 * px, D * .82 - 3.6 * px, beacon + 3.6 * px, yTop + 9.5 * px, D * .82 + 3.6 * px, 'trim'); box(beacon - 2.8 * px, yTop + 9.5 * px, D * .82 - 2.8 * px, beacon + 2.8 * px, yTop + 14 * px, D * .82 + 2.8 * px, 'lampOff')
  // (The fitters' ports and wells: machine.ts has the same numbers.)
  const au = (p.phone ? .7 : .82) * U, hw = p.P / 2 + .3 * au + .25 * U, pd = 15.5 * px, rb = 1.5 * au
  for (const s of p.phone ? [-1] : [-1, 1]) {
    const portX = s * Math.abs(p.lanes[0]), bx = s * Math.min(Xc - 2.5 * px - rb - .1 * U, Math.abs(portX) + hw + rb + 1.5 * U)
    box(portX - hw - 1.4 * px, yTop, zL - pd - 1.4 * px, portX + hw + 1.4 * px, yTop + 1.3 * px, zL + pd + 1.4 * px, 'trim')
    box(portX - hw + .5 * px, yTop + .3, zL - pd + .5 * px, portX + hw - .5 * px, yTop + 1.1 * px, zL + pd - .5 * px, 'steel', 'plinth'); box(portX - .2 * p.P, yTop + 1.1 * px, zL - 1.2 * px, portX + .2 * p.P, yTop + 2 * px, zL + 1.2 * px, 'steel')
    if (!p.phone) { const half = p.P / 2 + .3 * au, wx = rb + 1.2 * px, z0 = zL - wx, z1 = zL + 2 * half + .5 * au + 3 * px - rb - 1.2 * px
      box(bx - wx - 1.4 * px, yTop, z0 - 1.4 * px, bx + wx + 1.4 * px, yTop + 1.3 * px, z1 + 1.4 * px, 'trim'); fill('slot', 0); face([[bx - wx, yTop + .14, z0], [bx + wx, yTop + .14, z0], [bx + wx, yTop + .14, z1], [bx - wx, yTop + .14, z1]]) }
  }
  for (const s of [-1, 1]) {
    const tx = s * (p.phone ? Xc - .7 * U : Xc + 1.15 * U), tz = -5 * px, a = whole ? (s > 0 ? .5 : Math.PI - .5) : s > 0 ? -1.35 : Math.PI + 1.35, in0 = s * (p.phone ? Xc - 2.4 * U : Xc - 1.6 * U), out0 = tx + s * 1.05 * U
    box(Math.min(in0, out0), yTop + 2 * px, tz - 6 * px, Math.max(in0, out0), yTop + 4.4 * px, 7 * px, 'trim')
    box(tx - 5.6 * px, yTop + 4.4 * px, tz - 5.6 * px, tx + 5.6 * px, yTop + 6.4 * px, tz + 5.6 * px, 'trim'); box(tx - 3.2 * px, yTop + 6.4 * px, tz, tx + 3.2 * px, yTop + 16 * px, tz + .1, 'steel')
    c.save(); c.translate(X(tx, tz), Y(yTop + 16 * px, tz)); c.rotate(-a)
    fill('plinth', 1); c.fillRect(-8 * px, -4.4 * px, 25 * px, 8.8 * px); fill('steel', 1); c.fillRect(17 * px, -3.4 * px, 5 * px, 6.8 * px); fill('trim', 1); c.fillRect(-10.5 * px, -3.4 * px, 2.5 * px, 6.8 * px)
    for (let i = 0; i < 4; i++) c.fillRect((-5 + i * 4.4) * px, -6.2 * px, 1.8 * px, 12.4 * px)
    fill('red', 1); c.fillRect(22 * px - .7, -2.6 * px, 1.4, 5.2 * px); c.restore()
    if (s < 0 || !p.phone) box(s * p.eject.x - .62 * p.lw, yTop, p.eject.z - 6 * px, s * p.eject.x + .62 * p.lw, yTop + 5 * px, p.eject.z + 6 * px, 'steel')
    // (The eye each side, the hook on it, and the cable up out of sight. A whole machine has been unhooked.)
    const ex = s * (p.phone ? .38 : .74) * Xc, ez = D * (p.phone ? .62 : .5), ep = (p.phone ? 1.6 : 1) * px
    box(ex - 2.4 * ep, yTop, ez - 2.4 * ep, ex + 2.4 * ep, yTop + 1.6 * ep, ez + 2.4 * ep, 'trim'); fill('steel', 1); c.beginPath(); c.arc(X(ex, ez - .8 * ep), Y(yTop + 3.4 * ep, ez - .8 * ep), 1.9 * ep, 0, Math.PI * 2); c.fill(); fill('slot', 1); c.beginPath(); c.arc(X(ex, ez - .85 * ep), Y(yTop + 3.4 * ep, ez - .85 * ep), .9 * ep, 0, Math.PI * 2); c.fill()
    if (!whole) { box(ex - 1.5 * ep, yTop + 5.4 * ep, ez - 1.2 * ep, ex + 1.5 * ep, yTop + 9 * ep, ez + 1.2 * ep, 'trim'); fill('trim', 1); for (const x of [-1.3, 1.1]) c.fillRect(X(ex + x * ep, ez - 1.2 * ep), Y(yTop + 5.4 * ep, ez - 1.2 * ep), .2 * ep, 2 * ep); fill('steel', 1); c.fillRect(X(ex - .7 * ep, ez - .7 * ep), -drop, 1.4 * ep, Y(yTop + 9 * ep, ez - .7 * ep) + drop) }
  }
  const hh = p.hopper * .82, ht = p.lw * 1.3, hb = p.lw * .62, hd = p.lw * .36
  box(-hb - 3 * px, yTop, zL - hd - 3 * px, hb + 3 * px, yTop + 2.4 * px, zL + hd + 3 * px, 'plinth')
  // (By day the renderer's lamp leaves the hopper's plates nearly white.)
  fill('trim', dark ? 1 : 0); face([[-hb, yTop, zL + hd], [hb, yTop, zL + hd], [ht, yTop + hh, zL + hd], [-ht, yTop + hh, zL + hd]])
  fill('trim', dark ? 2 : 1); for (const s of [-1, 1]) face([[s * hb, yTop, zL - hd], [s * hb, yTop, zL + hd], [s * ht, yTop + hh, zL + hd], [s * ht, yTop + hh, zL - hd]])
  fill('steel', dark ? 1 : 0); face([[-hb, yTop, zL - hd], [hb, yTop, zL - hd], [hb + (ht - hb) * .62, yTop + hh * .62, zL - hd], [-hb - (ht - hb) * .62, yTop + hh * .62, zL - hd]])
  })
  // In the bay: its floor, each lane's chute, the roller line (fifty-six rollers, seen end on and from above).
  const yR = yCav + p.cavity * .4, rr = p.P / 8 * .4, z0 = zL - 12 * px, z1 = zL + 12 * px
  if (whole) {
  c.save(); c.beginPath(); c.rect(X(-Xb), Y(yFas), 2 * Xb, yFas - yCav); c.clip()
  fill('bay', 0); face([[-Xb, yCav, 0], [Xb, yCav, 0], [Xb, yCav, p.cavD], [-Xb, yCav, p.cavD]])
  fill('bay', 3); face([[Xb, yCav, 0], [Xb, yCav, p.cavD], [Xb, yFas, p.cavD], [Xb, yFas, 0]])
  const fitted = p.lanes
  fill('trim', 1); for (const x of fitted) for (const s of [-1, 1]) face([[x + s * .48 * p.P, yR - rr - 3 * px, z0], [x + s * .48 * p.P - s * 1.6 * px, yR - rr - 3 * px, z0], [x + s * .4 * p.P - s * 1.6 * px, yCav, z0], [x + s * .4 * p.P, yCav, z0]])
  for (const lane of fitted) for (let j = 0; j < 8; j++) { const x = lane - p.P / 2 + (j + .5) * p.P / 8; fill('steel', 0); face([[x - rr, yR + rr * .3, z0], [x + rr, yR + rr * .3, z0], [x + rr, yR + rr * .3, z1], [x - rr, yR + rr * .3, z1]]); fill('steel', 1); c.beginPath(); c.arc(X(x, z0), Y(yR, z0), rr, 0, Math.PI * 2); c.fill() }
  c.restore()
  // On the fascia: three lamps, the gauge's ticks, red zone and needle. Under the bay: the lanes' plates.
  fill('lampOff', 1); for (const lamp of p.lamps) { c.beginPath(); c.arc(X(lamp.x), Y(lamp.y), Math.min(4 * px, p.fascia * .1), 0, Math.PI * 2); c.fill() }
  const gx = X(p.gauge.x), gy = Y(p.gauge.y), gr = p.gauge.r
  for (let i = 0; i <= 10; i++) { const a = (225 - 27 * i) * Math.PI / 180; c.strokeStyle = tone(i >= 8 ? 'redzone' : 'ink', 1, dark); c.lineWidth = (i % 5 ? .9 : 1.4) * px; c.beginPath(); c.moveTo(gx + Math.cos(a) * gr * (i % 5 ? .78 : .68), gy - Math.sin(a) * gr * (i % 5 ? .78 : .68)); c.lineTo(gx + Math.cos(a) * gr * .9, gy - Math.sin(a) * gr * .9); c.stroke() }
  c.strokeStyle = tone('redzone', 1, dark); c.lineWidth = gr * .09; c.beginPath(); c.arc(gx, gy, gr * .945, -(225 - 216) * Math.PI / 180, -(225 - 270) * Math.PI / 180); c.stroke()
  c.strokeStyle = tone('ink', 1, dark); c.lineWidth = 1.6 * px; c.beginPath(); c.moveTo(gx, gy); c.lineTo(gx + Math.cos(135 * Math.PI / 180) * gr * .8, gy - Math.sin(135 * Math.PI / 180) * gr * .8); c.stroke()
  fill('steel', 1); c.beginPath(); c.arc(gx, gy, 2.2 * px, 0, Math.PI * 2); c.fill()
  fill('plinth', 1); for (const x of p.lanes) front(x - p.label / 2 * p.P, ySlot + .14 * p.slot, x + p.label / 2 * p.P, ySlot + .86 * p.slot)
  // The relief valves on the columns beside the bay.
  const vs = p.phone ? .58 * U : U, colX = (Xb + 2 * px + Xc - p.post) / 2, valveY = yCav + p.cavity * .62
  for (const s of [-1, 1]) { fill('steel', 1); front(s * colX - .3 * vs, ySlot, s * colX + .3 * vs, valveY + 1.9 * vs); fill('trim', 1); c.beginPath(); c.arc(X(s * colX), Y(valveY), 1.15 * vs, 0, Math.PI * 2); c.fill(); fill('steel', 1); c.beginPath(); c.arc(X(s * colX, -3 * px), Y(valveY, -3 * px), .8 * vs, 0, Math.PI * 2); c.fill() }
  }
  // The tubes between their manifolds, the blocks they go into, the brackets across them; on a wide page the lower
  // block goes on round the corner, and a riser comes down from it to the header on the slab.
  const ends = (s: number, round: boolean) => [s < 0 ? (round ? -Xc - p.riser - .2 * U : -Xc + p.post + .1 * U) : Xw + .12 * U, s < 0 ? -Xw - .12 * U - lean : round ? Xc + p.riser + .2 * U : Xc - p.post - .1 * U - lean]
  const yc = r + 3.5 * px
  for (const head of p.heads) box(head.x0, 0, head.z0, head.x1, head.h, head.z1, 'trim')
  for (const s of p.heads.length ? [-1, 1] : []) { const x0 = s < 0 ? -Xc - p.riser - .2 * U : Xc + .2 * U; box(x0, p.heads[0].h, zBlock, x0 + p.riser, yWall + lower, zBlock + 3 * U, 'trim') }
  box(-Xc - px, yMan, -5 * px, Xc + px, ySlot, 0, 'trim')
  if (lower) box(-Xc - px, yWall - .3 * V, -5 * px, Xc + px, yWall + lower, 0, 'trim')
  if (p.tubes.length) for (const s of [-1, 1]) { const [a, e] = ends(s, false); box(a, yMan, zBlock, e, ySlot, 0, 'trim') }
  for (const x of p.tubes) { c.fillStyle = glass(1, dark, dark ? 'floor' : 'dark'); c.fillRect(X(x - r, zt), Y(yMan, zt), 2 * r, yMan - yLow); c.fillStyle = glass(2, dark, dark ? 'floor' : 'dark'); c.fillRect(X(x - r, zt), Y(yMan, zt), r * .5, yMan - yLow) }
  if (lower) {
    const reach = r + 1.5 * px, zB = zt - r - 1.2 * px, ahead = DX * (zB - zt)
    for (const first of [0, 4]) { const a = Math.min(p.tubes[first], p.tubes[first + 3]) - reach - ahead, e = Math.max(p.tubes[first], p.tubes[first + 3]) + reach - ahead; for (let i = 1; i <= 3; i++) { const y = yLow + (yMan - yLow) * i / 4; box(a, y - 1.5 * px, zB, e, y + 1.5 * px, 0, 'trim') } }
    for (const s of [-1, 1]) { const [a, e] = ends(s, true); box(a, yWall - .3 * V, zBlock, e, yWall + lower, 0, 'trim') }
  }
  // On the slab: each tube forward from its outlet in the header, over the lip and down.
  // (A tube's line as it is seen: forward along the slab, round over the lip, and down.)
  const leg = (x: number, zFrom: number) => { c.strokeStyle = glass(1, dark); c.lineWidth = 2 * r; c.lineCap = 'butt'; c.beginPath(); c.moveTo(X(x, zFrom), Y(yc, zFrom)); c.arcTo(X(x, p.zOver), Y(yc, p.zOver), X(x, p.zOver), Y(yc, p.zOver) + 200, r * 2.6); c.lineTo(X(x, p.zOver), Y(-p.floor - over, 0)); c.stroke() }
  // The saddle under each tube, each tube's flange in the trunk, and the collar where it turns down over the lip.
  const sleeperZ = p.fan.length ? (p.heads[0].z0 + p.zLip) / 2 - .6 * U : (zt + p.zLip) / 2
  p.heads.forEach((_, side) => { for (let k = 0; k < 4; k++) { const x = p.fan[side * 4 + k].x; box(x - r - .9 * U, 0, sleeperZ - .8 * U, x + r + .9 * U, yc - r, sleeperZ + .8 * U, 'plinth') } })
  const lipCollar = (x: number) => { const w = r + 1.2 * px; fill('steel', 1); c.fillRect(X(x - w, p.zOver), Y(-p.lip * .5 + 1.4 * px, p.zOver), 2 * w, 2.8 * px); fill('steel', 0); c.beginPath(); c.ellipse(X(x, p.zOver), Y(-p.lip * .5 + 1.4 * px, p.zOver), w, w * .42, 0, 0, Math.PI * 2); c.fill() }
  p.fan.forEach(at => { leg(at.x, zBlock); fill('steel', 1); c.beginPath(); c.arc(X(at.x, zBlock), Y(yc, zBlock), r + 2 * px, 0, Math.PI * 2); c.fill(); lipCollar(at.x) })
  // The outbound tube: up over the lip, along the cabinet's front and into the plate at the riser's foot (a phone:
  // into the plate in the base). The tally by the last outlet.
  if (!p.phone) { const x = p.out - DX * p.zOver, trunk = p.heads[1], w = r + 3.4 * px, zJ = p.zLip * .46, portX = Xc + .2 * U + p.riser / 2, into = trunk ? trunk.z0 : -3 * px, px0 = trunk ? portX : x
    fill('steel', 1); c.fillRect(X(px0 - w, into), Y(yc + w, into), 2 * w, yc + w)
    c.strokeStyle = glass(1, dark); c.lineWidth = 2 * r; c.beginPath(); c.moveTo(X(x, p.zOver), Y(-p.floor - over, 0))
    if (trunk) { c.arcTo(X(x, p.zOver), Y(yc, p.zOver), X(x, zJ), Y(yc, zJ), r * 2.4); c.arcTo(X(x, zJ), Y(yc, zJ), X(portX, zJ), Y(yc, zJ), r * 2.2); c.arcTo(X(portX, zJ), Y(yc, zJ), X(portX, into), Y(yc, into), r * 2.2) } else c.arcTo(X(x, p.zOver), Y(yc, p.zOver), X(x, into), Y(yc, into), r * 2.6)
    c.lineTo(X(px0, into), Y(yc, into)); c.stroke(); lipCollar(x) }
  for (const pipe of p.hung) { c.fillStyle = glass(1, dark); c.fillRect(pipe.x - pipe.r, p.oy + over + p.front - 2, 2 * pipe.r, p.H - p.oy - p.front + 2) }
  if (p.tally) { fill('screen', 1); c.fillRect(X(p.tally.x, p.tally.z), Y(p.tally.y + p.tally.h, p.tally.z), p.tally.w, p.tally.h) }
  // The send cannon: the tube from the trunk into its chest, the chest, the glass feed up into the breech, its barrel
  // at its elevation, the cheek in front of it.
  const gun = () => { const C = p.cannon, cu = C.cs, cheek = C.r + 2.2 * px, ce = Math.cos(C.el), se = Math.sin(C.el), kx = C.x - (C.back + 1.6 * cu) * ce, ky = C.y + C.pivot - (C.back + 1.6 * cu) * se, top = C.y + C.chest, lap = (p.phone ? .3 : 1.1) * cu, chestZ = C.z - cheek - lap, zc = C.z - cheek - 2.4 * px, trunk = p.heads[1]
    c.strokeStyle = glass(1, dark); c.lineWidth = 2 * r
    if (trunk) { const from = trunk.z1 + (trunk.h - yc - r) / DY; c.beginPath(); c.moveTo(X(kx, from), Y(yc, from)); c.lineTo(X(kx, chestZ), Y(yc, chestZ)); c.stroke() }
    box(kx - 1.7 * cu, C.y, chestZ, C.x + 3.4 * cu, top, C.z + cheek + lap, 'plinth')
    if (trunk) { fill('steel', 1); c.beginPath(); c.arc(X(kx, chestZ), Y(yc, chestZ), r + 2 * px, 0, Math.PI * 2); c.fill() }
    c.beginPath(); c.moveTo(X(kx, C.z), Y(top, C.z)); c.arcTo(X(kx, C.z), Y(ky, C.z), X(C.x - C.back * ce, C.z), Y(C.y + C.pivot - C.back * se, C.z), r * 1.5); c.lineTo(X(C.x - C.back * ce, C.z), Y(C.y + C.pivot - C.back * se, C.z)); c.stroke()
    c.save(); c.translate(X(C.x, C.z), Y(C.y + C.pivot, C.z)); c.rotate(-C.el)
    fill('trim', 1); c.fillRect(-C.back, -C.r, C.back + C.fore, 2 * C.r); fill('trim', 0); c.fillRect(-C.back, -C.r, C.back + C.fore, C.r * .5); fill('trim', 3); c.fillRect(-C.back, C.r * .5, C.back + C.fore, C.r * .5)
    fill('steel', 1); c.fillRect(C.fore - 4.4 * px, -C.r - 2.4 * px, 4.4 * px, 2 * C.r + 4.8 * px); c.fillRect(-C.back - 1.6 * px, -C.r - 3 * px, 3 * px, 2 * C.r + 6 * px); fill('plinth', 1); c.fillRect(-.75 * cu, -C.r - 3.4 * px, 1.5 * cu, 2 * C.r + 6.8 * px); fill('steel', 1); c.fillRect(-.24 * cu, -C.r - 4.4 * px, .48 * cu, 2 * C.r + 8.8 * px)
    c.restore()
    fill('trim', 1); face([[C.x - 2.5 * cu, top, zc], [C.x + 2.9 * cu, top, zc], [C.x + .95 * cu, C.y + C.pivot + .95 * cu, zc], [C.x - .95 * cu, C.y + C.pivot + .95 * cu, zc]]) }
  // (A phone's stands on the roof, wherever the roof is.)
  if (p.phone) roof(gun); else gun()
  const g = U * .085, rows = PRICE.length + p.over + p.under
  for (let r = 0; r < rows; r++) for (let col = 0; col < COLS + 2 * p.side; col++) {
    const lit = PRICE[r - p.over]?.[col - p.side] === '#'
    if (lit) fill('paper', 0); else fill((col * 7 + r * 13) % 5 === 0 ? 'cell2' : 'cell', 1)
    c.fillRect(X(-Xw + col * U + g), Y(yWall + (rows - r) * V - g), U - 2 * g, V - 2 * g)
  }
  // The wordmark at the frame's head, where the renderer has it (sorter/name.ts): its faces, flat.
  const n = p.name, k = n.cap / WORDMARK.h
  c.save(); c.translate(X(n.x, n.z), Y(n.y + n.cap, n.z)); c.scale(k, k); fill('paper', 0); c.fill(new Path2D(WORDMARK.d)); c.restore()
}
