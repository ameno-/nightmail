// Where everything on the sorter is, in CSS pixels, from the size of the page. The machine is drawn in one oblique
// projection: its front is a true rectangle (so the page's own text sits on it), and depth runs up the page and a
// little to the left. World x is right of the machine's middle, y is up from the floor, z is back from its front.
// The machine stands on a slab with a lip along its front; the tubes cross the slab, go over the lip and on down the
// page. The page's boxes (sorter-home.css) are placed from these numbers; the engine builds the machine from them.
import { COLS, ROWS } from './price'

/** Depth on screen per unit of world depth. */
export const DX = -0.26, DY = 0.42

export type Rect = { x: number; y: number; w: number; h: number }
export type Plan = ReturnType<typeof plan>
/** What the page keeps clear at its sides and its foot: a phone's safe areas. */
export type Inset = { left: number; right: number; bottom: number }

const mix = (a: number, b: number, t: number) => a + (b - a) * t

/** `fold` is how much of the page is seen under the header before any scrolling; `agree`, whether the visitor has yet to
 *  sign in (someone signed in has nothing to agree to: no consent under the button). */
export function plan(W: number, fold: number, inset: Inset = { left: 0, right: 0, bottom: 0 }, agree = true) {
  // Below 900 px there is no room beside the machine for the headers and their tubes: the page is a phone's (or a
  // tablet's), and the machine is composed for it: four lanes whose names fit their plates (`routes`: which of the
  // seven), no tubes down its front (its mail goes down through the slab, and the tubes begin at its lip), a cabinet
  // as wide as the page less a gutter each side, and everything on its front between the price's own two edges.
  const phone = W < 900
  // The machine is built up as the product is, a part at a time: it begins with one lane, the middle one, and the
  // others are fitted outwards from it in turn, left then right (`fit`: the lanes in that order). So the lanes stand,
  // left to right, in the order that fitting them from the middle brings the product's own: endpoints first, then
  // threads, agents, inboxes, IMAP, rituals, campaigns. (A phone's roof has room for one port only, on the left, clear
  // of its cannon: it begins with its rightmost lane, threads, and is fitted from the right to the left, each new deck
  // running along the roller line to stop short of the last: agents, inboxes, rituals.)
  const routes = phone ? [5, 3, 2, 0] : [5, 3, 0, 1, 2, 4, 6], fit = phone ? [3, 2, 1, 0] : [3, 2, 4, 1, 5, 0, 6], count = routes.length, per = phone ? 0 : 4
  // In cells: the unlit columns and rows round the price, the strip the tubes run down (a phone: the cabinet's stile),
  // and each floor of the machine. (Over the price the frame is ten rows high, not two: the wordmark stands in them.)
  const side = 2, over = 10, under = 2, strip = phone ? .6 : 9.8
  const rows = { base: 14, band: 7.5, manifold: 2, slot: 3.4, cavity: 19, fascia: 11 }
  // The slab in front of the machine, its lip, and the page under the lip.
  const depth = phone ? 8 : 20, hopperU = 4.2, skyU = 1.5, frontU = phone ? 4.6 : 5.75, lipU = phone ? 1.6 : 2, belowU = 7.6
  const wallRows = ROWS + over + under, wide = 2 * (COLS / 2 + side + strip) + depth * -DX + (phone ? 0 : 9)
  const edgeL = Math.max(16, inset.left), edgeR = Math.max(16, inset.right)
  // The send cannon: the sending half. On a wide page it stands on the slab to the right of the cabinet, behind the
  // header; stacked, on the roof at the back, sized to the roof. `pivot` is how high its barrel turns, `el` its
  // elevation, `cs` its unit; the letter it fires is smaller than a sorted one. `rise`: how far over the roof's front
  // edge its muzzle is seen.
  const gun = (U: number, lw: number, lh: number, tubeR: number) => {
    const cs = phone ? .8 * U : 1.3 * U, el = .54, part = phone ? .42 : .8, shot = { w: lw * part, h: lh * part }, bore = shot.h / 2 + .2 * cs, r = bore + .22 * cs, long = (phone ? 2.7 : 2.9) * shot.w, back = .31 * long
    // (On a wide page it stands on a chest the mail comes into along the slab; stacked, it is fed up through the roof.)
    const z = phone ? depth * U * .76 : 15 * U, chest = phone ? .5 * cs : 2 * tubeR + .6 * cs, pivot = chest + back * Math.sin(el) + r * Math.cos(el) + cs
    return { z, pivot, chest, el, cs, shot, bore, r, back, fore: long - back, rise: pivot + (long - back) * Math.sin(el) + r + z * DY }
  }
  // A cell is 18 wide for every 13 high, the shape of an envelope; as large as the page allows.
  // Stacked, what is on the machine's front is measured in pixels where it holds the page's own words, and the page
  // need not hold all of it at once: the button must be seen without scrolling, what is under it need not be. `t` is
  // how closely it is set, 0 (at ease) to 1: the page is first set closer, and only then is the machine made smaller.
  const stack = (U: number, t: number, sky = 0, apart = 0, slab = 0) => {
    const V = U * 13 / 18, k = Math.min(1.5, Math.max(1, U / 7)), lw = COLS * U / count * .46, lh = lw * .7
    // (The headline's two lines stand as far under the price as over the button's bay: no rail parts them from it.)
    const fascia = mix(96, 80, t) * Math.min(k, 1.1), pad = mix(10, 7, t) * Math.min(k, 1.1), cavity = mix(3.5, 3, t) * lh, slot = mix(30, 26, t) * Math.min(k, 1.2), manifold = 2 * V, band = 2.32 * COLS * U / 11 + 2 * mix(19, 13, t) * k
    // The base, from the floor up: the two facts; what signing in agrees to (one line where the button is wide enough
    // for it, two where it is not; none signed in); and directly over that the button in its bay. (On a narrow phone what is free
    // takes two lines.) `sky` is more room over the roof, `apart` more between the consent and the facts, `slab` more
    // slab in front of the machine.
    const ctaW = COLS * U, ctaH = U > 8 ? 60 : Math.round(mix(54, 50, t)), plate = 6, tight = ctaW - 88 < 192, factsH = tight ? 56 : 38, factsY = mix(34, 26, t)
    const consentH = !agree ? 0 : ctaW < 392 ? 32 : 16, consentY = factsY + factsH + Math.max(apart, mix(22, 18, t)), ctaY = consentY + consentH + mix(12, 8, t) + plate
    const base = ctaY + ctaH + plate, below = Math.max(3.6 * U, 24), front = frontU * U + slab
    const top = sky + mix(30, 10, t) + Math.max(gun(U, lw, lh, .42 * U).rise, (depth * DY + hopperU) * U), over = top + fascia + cavity + slot + manifold + wallRows * V + band
    // (`toConsent`, `toFacts`: how far down the hero the consent ends, and the facts.)
    return { V, k, fascia, pad, cavity, slot, manifold, band, base, below, front, ctaW, ctaH, ctaY, plate, tight, factsH, factsY, consentH, consentY, toConsent: over + base - consentY, toFacts: over + base - factsY, tall: over + base + front + lipU * U + below }
  }
  // Wide: every floor is so many cells, and the whole machine is seen at once (the page is at least 600 high).
  const sized = (U: number) => {
    const V = U * 13 / 18, base = Math.max(rows.base * V, 64), fascia = rows.fascia * V, below = Math.max(belowU * U, 40)
    return { V, base, fascia, below, band: rows.band * V, manifold: rows.manifold * V, slot: rows.slot * V, cavity: rows.cavity * V, tall: base + fascia + (rows.band + wallRows + rows.manifold + rows.slot + rows.cavity) * V + (depth * DY + hopperU + skyU + frontU + lipU) * U + below }
  }
  let U: number, H: number, short = false, set: ReturnType<typeof stack> | null = null
  if (phone) {
    // (The button and, directly under it, what signing in agrees to are seen before any scrolling: the consent ends
    // 12 px over the fold, or more. A short page takes its height from the machine before it takes much from the
    // gaps: the machine may be a fifth smaller than the page's width allows, and a little more.)
    const most = Math.max(4.6, Math.min(12, Math.floor((W - edgeL - edgeR) / wide / .05) * .05)), least = Math.max(4.6, .76 * most), room = fold - 12 - inset.bottom
    U = most
    search: {
      // The fold falls somewhere plain, never through something: over it are the whole page (where it fits), or the
      // two facts whole with room under them and the slab's bare top at the fold. The page is set as closely as gives
      // one of those; where none does, the machine stands a little lower (the consent just over the fold, the facts
      // beginning under it), or the slab runs on a little further forward (its lip under the fold).
      const edge = (made: ReturnType<typeof stack>) => made.tall - made.below - lipU * U - 18
      for (let u = most; u >= least - 1e-6; u = Math.round((u - .05) * 20) / 20) {
        const fits = [0, .25, .5, .75, 1].filter(t => stack(u, t).toConsent <= room)
        if (!fits.length) continue
        const clean = fits.find(t => { const made = stack(u, t); return made.tall + inset.bottom <= fold || (made.toFacts + 12 + inset.bottom <= fold && fold <= edge(made)) })
        U = u; set = stack(u, clean ?? fits[0])
        if (clean === undefined) set = fold > set.toFacts - set.factsH - 6 && fold < set.toFacts + 12 + inset.bottom ? stack(u, fits[0], room - set.toConsent, 26 + inset.bottom) : fold > edge(set) ? stack(u, fits[0], 0, 0, fold - edge(set) + 4) : set
        break search
      }
      // Too short a page for the button to be seen on the machine at any size worth having: the machine is as it
      // would be on a tall page (on a phone held on its side, small enough that the wordmark and half the price under
      // it are seen), and the header carries a button of its own.
      // (Under the header's button, at the hero's top, stands what signing in agrees to: the sky is higher by it.)
      short = true; U = Math.min(most, Math.max(4.9, fold / 68)); set = stack(U, fold < 520 ? 1 : .5, W < 700 ? 40 : 0)
    }
    H = Math.ceil(Math.max(fold, set.tall))
  } else {
    // Where the tubes fan out they need room beside the cabinet too: on a narrow page the machine gives it up.
    H = Math.max(fold, 600)
    U = Math.max(4, Math.min(12, Math.floor(W / wide / .25) * .25))
    while (U > 4 && (sized(U).tall > H || W / 2 - (COLS / 2 + side + strip) * U - 26 < 4.05 * 32)) U = Math.round((U - .25) / .25) * .25
  }
  const { V, base, fascia, below, band, manifold, slot, cavity } = set ?? sized(U)
  const Xw = (COLS / 2 + side) * U, Xc = Xw + strip * U, D = depth * U, wall = wallRows * V
  /** Half the works' bay: on a phone it is as wide as the price, with a column either side of it. */
  const Xb = phone ? COLS / 2 * U : Xw
  const yBand = base, yWall = yBand + band, yMan = yWall + wall, ySlot = yMan + manifold, yCav = ySlot + slot, yFas = yCav + cavity, yTop = yFas + fascia
  // The lanes across the works (seven; a phone's four); a letter is most of a lane wide (half of one of a phone's).
  const P = 2 * Xb / count, lanes = Array.from({ length: count }, (_, i) => (i - (count - 1) / 2) * P), lw = P * (phone ? .46 : .7), lh = lw * .7
  /** How much of a lane its name's plate is across. */
  const label = phone ? .96 : .92
  const cavD = (phone ? 5.2 : 6.6) * U, zL = cavD / 2
  // On the roof: the slot scams are thrown out of, each side of the hopper (a phone's one, on the left, stands back
  // of the works: the roof's front is the ports'); and over the outermost lane each side a port, with a fitter's arm
  // beyond it at the roof's end, that lowers each new lane's deck in (machine.ts).
  const eject = { x: (phone ? .6 : .5) * Xw, z: phone ? zL + 3.3 * U : zL }
  // Eight tubes, four each side of the price, the nearest the price first: inbox, agent inbox, endpoint, thread;
  // mailbox, ritual, campaign, logs. They run down the front between two manifolds, into a block at each end of the
  // lower one. On a wide page that block goes on round the cabinet's corner, a riser comes down from it to a header on
  // the slab beside the cabinet (`heads`: a trunk with an outlet for each tube in its front), and the tubes run
  // straight forward from the header side by side (`fan`: where each lies, and where on the page it goes over the
  // lip) and over the lip; stacked they keep to the front, down to the floor and straight over the lip. (A phone has
  // none: `tubes` is empty.)
  // What stands out in front of the wall is seen a little to the right of where it is (depth leans): a tube's place
  // here is where it is seen.
  // (Each four stands centred in its strip, between the frame and the cabinet's corner post; a stacked cabinet has no posts.)
  const post = phone ? 0 : U, tubeR = (phone ? .42 : .85) * U, pitch = (phone ? 1.06 : 2.14) * U, first = (strip * U - post - 3 * pitch) / 2
  // (Stacked, it is what is seen of the cabinet, its front and its side, that stands in the middle of the page.)
  const front = set ? set.front : frontU * U, lip = lipU * U, floor = front + lip + below, ox = phone ? Math.round(edgeL + (W - edgeL - edgeR + depth * -DX * U) / 2) : Math.round(W / 2), oy = Math.round(H - floor)
  const zLip = -front / DY, zOver = zLip - tubeR - 3 * U / 9, zBack = D * (phone ? 1.4 : 1.5), zt = -(tubeR + 1.5 * U / 9), zProud = zt - tubeR - 4 * U / 9
  const tubes = per ? [0, 1, 2, 3].map(k => -(Xw + first + k * pitch)).concat([0, 1, 2, 3].map(k => Xw + first + k * pitch)).map(x => x - DX * zt) : []
  // A tube that runs straight forward leans across the page as depth does: the right-hand four must still come out
  // clear of the riser at the cabinet's corner, so the nearest stands at least that far out (and its twin on the left
  // the same). The header's front, the riser's and the blocks' are one plane. (And the outermost, where it leaves its
  // header, which is further left as it is seen than where it goes over the lip, stays its radius and 12 px more
  // inside the page's edge: on a narrow page the four close up.)
  const riser = 2.4 * U, headD = 4.4 * U, headH = 2 * tubeR + 1.6 * U, clear0 = DX * zOver + riser + tubeR + 1.2 * U, edge = 2 * tubeR + 12 + DX * (zOver - zProud)
  const spread = Math.max(24, Math.min(13.5 * U, (W / 2 - Xc - 26) / 4.05, (W / 2 - Xc - clear0 - edge) / 3, (W / 2 - Xc - edge) / 3.6)), clear = Math.max(.6 * spread, clear0)
  const fan = phone ? [] : [0, 1, 2, 3, 4, 5, 6, 7].map(t => { const at = (t < 4 ? -1 : 1) * (Xc + clear + (t % 4) * spread); return { at, x: at - DX * zOver } })
  const heads = phone ? [] : [{ x0: fan[3].x - 2.2 * U, x1: -Xc }, { x0: Xc, x1: fan[7].x + 2.2 * U }].map(head => ({ ...head, z0: zProud, z1: zProud + headD, h: headH }))
  // The column the appliances stand in under the machine: its middle (a phone's is the page's own) and its width.
  const sx = phone ? Math.round((edgeL + W - edgeR) / 2) : ox, inner = phone ? Math.min(W - edgeL - edgeR - 8, 520) : 2 * (Xc + clear)
  /** Where each tube goes under the lip, across the page from its left edge. (A phone: the two that begin there, a wide one down each edge of the page.) */
  const drops = phone ? [sx - inner / 2 - 5, sx + inner / 2 + 5] : tubes.map((_, t) => ox + fan[t].at)
  // (The slab runs on past both of the page's edges, its far corners too: it never ends just inside the page.)
  const slabX = phone ? W : Math.max(Xc + clear + 4.3 * spread, W / 2 + 12 - DX * Math.max(D * 1.5, front / DY))
  // What is sent comes back up the page in one more tube (`out`: where across the page, from the middle of the column
  // under the machine, `sx`), into the slab under the machine, and up a ramp out of the floor (or the roof) into the
  // cannon's breech. `x, y, z` is where the cannon's base stands.
  // (On a wide page it stands clear of the riser as it is seen.)
  const made = gun(U, lw, lh, tubeR), cannon = { x: phone ? .64 * Xw : Xc + .2 * U + riser + 12 + 5.4 * made.cs - DX * made.z, y: phone ? yTop : 0, ...made }
  // (The outbound tube runs up the page behind the appliances that lean right and beside those that lean left;
  // sorter-stations.tsx places them from the same numbers.)
  const room = inner - 2 * (phone ? 20 : 74), widest = Math.min(446, room), lean = phone ? 0 : Math.min(46, Math.max(0, (room - widest) / 2)), boxDx = -DX * (phone ? 40 : 60)
  let out = -widest / 2 + lean + boxDx / 2 + Math.min(408, room) - (phone ? 10 : 26)
  if (!phone) for (const w of [446, 430, 420, 384]) { const edge = -widest / 2 - lean + boxDx / 2 + Math.min(w, room); if (Math.abs(out - edge) < 18) out = edge - 18 }
  // The renderer's canvas runs on this far below the hero, under the top of the next section: what the burst throws
  // past the slab falls on down the page and dwindles there (it is gone before it reaches the first appliance), and
  // is never cut off at the hero's edge.
  const ext = phone ? 84 : 260
  // A phone's three tubes hang from under the slab's lip: the two wide ones the mail goes down, and the outbound main
  // coming up. `x` is where across the page, `r` the tube's radius.
  const hung = phone ? [{ x: drops[0], r: 5 }, { x: drops[1], r: 5 }, { x: sx + Math.round(out), r: tubeR }] : []
  // The button, and beside it (under it, stacked) the two facts. `tight`: too little room for the longer fact on one line.
  // The button's faceplate (`plate`: how far it stands round the button), and the two facts. Wide, they are
  // instruments in the base: a display each, as tall as the button and narrower (the button is the largest thing in
  // its row), the one to the left of the button and the other to its right, each window wide enough for its longest
  // line (118 px). On a narrow cabinet the gaps between them close up first, and then the button gives way, down to
  // a faceplate still a little wider than a window in its bezel. Stacked, they are two columns of the page's own type
  // under the button, between its two edges.
  const plate = set ? set.plate : Math.max(6, Math.min(9, .9 * U)), ctaH = set ? set.ctaH : Math.min(Math.max(50, 8.6 * V), base - 2 * plate - 1.5 * V - 5)
  let ctaW = set ? set.ctaW : Math.max(18.5 * U, 150), margin = 2.4 * U, apart = 1.5 * U
  const room2 = () => 2 * (Xc - margin - apart - plate), longest = Math.max(17 * U, 128)
  if (!set && (room2() - ctaW) / 2 < 118) { margin = 1.5 * U; apart = .9 * U; if ((room2() - ctaW) / 2 < 118) ctaW = Math.max(room2() / 3, room2() - 236) }
  const cta: Rect = set ? { x: -ctaW / 2, y: set.ctaY, w: ctaW, h: ctaH } : { x: -ctaW / 2, y: 1.5 * V + (base - 1.5 * V - ctaH) / 2, w: ctaW, h: ctaH }
  const tight = set ? set.tight : (2 * Xc - 2 * margin - ctaW) / 2 < 206
  const fw = Math.min((room2() - ctaW) / 2, longest)
  const facts: Rect[] = set ? [{ x: cta.x, y: set.factsY, w: 88, h: set.factsH }, { x: cta.x + 88, y: set.factsY, w: ctaW - 88, h: set.factsH }]
    : [{ x: -Xc + margin, y: cta.y, w: fw, h: cta.h }, { x: Xc - margin - fw, y: cta.y, w: fw, h: cta.h }]
  // The tally: a counter in the right header's front, in the gap between the last two outlets (Campaigns and Logs):
  // everything sorted is on record. (Where that gap is too narrow for it, the header has none.)
  const tallyW = 38, tallyRoom = spread - 2 * (tubeR + 2 * U / 9) - 2 * 1.2 * U / 9 - 8
  const tally = phone || tallyRoom < tallyW ? null : { x: (fan[6].x + fan[7].x) / 2 - tallyW / 2, y: (headH - 14) / 2 + 1, w: tallyW, h: 14, z: zProud }
  /** How much room each tube's mouth has for its name beside it, to its right as the page sees it: to the next mouth
   *  (or the outbound tube), less both tubes, or to 12 px short of the page's edge. In the order of `drops`. */
  const mouthRoom = phone ? [] : tubes.map((_, t) => { const x = ox + fan[t].at, outX = ox + out - DX * zOver, next = [...tubes.map((__, u) => ox + fan[u].at), outX].filter(n => n > x + 1).sort((a, b) => a - b)[0]; return (next === undefined ? W - 12 : next - tubeR) - x - tubeR })
  // On the fascia: the gauge at its right, three lamps beside it (a phone: one over another), and the readout from
  // its left as far as the lamps. Stacked, they stand between the two edges of the works' bay.
  const gaugeR = set ? 19 * Math.min(set.k, 1.2) : Math.min(fascia * .36, 24)
  const gauge = { x: phone ? Xb - gaugeR - 3 : Xw - 4.2 * U, y: yFas + fascia / 2, r: gaugeR }
  const lamps = [0, 1, 2].map(i => phone ? { x: gauge.x - gaugeR - 14, y: gauge.y + (1 - i) * 12 } : { x: gauge.x - gaugeR - (2 + 1.7 * i) * U, y: gauge.y })
  const readout: Rect = set ? { x: -Xb, y: yFas + set.pad, w: lamps[2].x - 15 + Xb, h: fascia - 2 * set.pad } : { x: -Xw + 2.2 * U, y: yFas + (fascia - 8.4 * V) / 2, w: 27.5 * U, h: 8.4 * V }
  // (A phone's readout is narrow: `fromMax` is how many letters of a sender's name it holds beside a lane's name,
  // `subjectMax` how many of a subject each of its two lines holds, and the machine is given only the letters that fit whole.
  // The page sets them at 12.5 px or a little more, in a face six tenths of its size wide.)
  const inside = readout.w - 2 * Math.min(18, Math.max(12, 1.6 * U)), wide1 = .6 * Math.min(15, Math.max(12.5, 1.5 * U))
  const fromMax = set ? Math.floor((inside - 64) / (.96 * wide1)) : Infinity, subjectMax = set ? Math.floor(inside / wide1) - 1 : Infinity
  // What signing in agrees to, directly under a phone's button, between its two edges. (A wide page has it under the slab's lip.)
  const consent: Rect | null = set && agree ? { x: cta.x, y: set.consentY, w: ctaW, h: set.consentH } : null
  // (Whether the button is seen before any scrolling: where it is not, the header carries one.)
  short ||= oy - cta.y > fold - inset.bottom
  // On a wide page each lane fitted after the first brings a unit of its own, plugged onto the tower's side beside
  // the price: three up each side in the order they come, each slid in from its own side of the page over the one
  // before (the left's: threads, inboxes, rituals; the right's: agents, IMAP, campaigns). `pods`: each one's lane and
  // side, its place (its left edge, its foot, how far back its front stands), its size, and the plate its name is on
  // (its left edge, its foot, its size: never under 12 px tall).
  const podW = 9 * U, podH = 9.6 * U, pods = phone ? [] : fit.slice(1).map(lane => {
    const s = lanes[lane] < 0 ? -1 : 1, mine = fit.slice(1).filter(other => (lanes[other] < 0 ? -1 : 1) === s), n = mine.indexOf(lane), y = yMan - 1.5 * U - mine.length * podH - (mine.length - 1) * 2 * U + n * (podH + 2 * U)
    const x = s < 0 ? -Xc - podW : Xc, plateH = Math.max(1.4 * U, 12)
    return { lane, s, x, y, z: 1.4 * U, w: podW, h: podH, d: 5.6 * U, plate: { x: x + .5 * U, y: y + .55 * U, w: podW - 2.2 * U, h: plateH } }
  })
  // The roof hangs from two cables while the tower is built up under it (`hang`: across it, where its two eyes are,
  // left and right, `hangZ` back from its front). On a wide page they are well out towards its ends. A phone's rise
  // past the page's header, and each is clear of everything in it: the mark on the left and, from the right edge, a
  // 16 px margin, the theme and sound buttons (44 px each) and "API docs" in a box about 78 wide, so the header is clear
  // from x 48 to W - 190. The two are symmetrical about the machine where that leaves the right one clear of the
  // header's links (a tablet's page); on a phone the pair is moved left, as far apart as before, until it is, the left
  // one, where it would stand on the slot scams leave by, beyond it, and no nearer the mark than 16 px.
  const hangZ = D * (phone ? .78 : .5), mid = ox + DX * hangZ, eyes = (phone ? .38 : .74) * Xc
  const right = phone ? Math.min(eyes, W - 198 - mid) : eyes, slotL = -eject.x - .62 * lw, slotR = -eject.x + .62 * lw, off = 8 * U / 9, l0 = right - 2 * eyes
  const left = phone ? Math.max(56 - mid, l0 > slotL - off && l0 < slotR + off ? slotL - off : l0) : -eyes, hang = [left, right] as const
  // The wordmark, in lights at the head of the sorting frame: exactly as wide as the price, its two edges the
  // price's, and half way between the price and the frame's top. `x, y` is its left end on its baseline, `cap` its cap
  // height (its width is 10.8 of them: lib/marks.ts), `z` the plane its face is in, proud of the frame by `depth`.
  const name = { x: -COLS * U / 2, y: yMan - over * V / 2 - COLS * U / 21.6, cap: COLS * U / 10.8, z: -.6 * U, depth: .6 * U }
  return { phone, routes, fit, pods, eject, tight, short, name, W, H, fold, inset, ext, cannon, out: Math.round(out), room, widest, lean, ox, oy, sx, U, V, side, over, under, Xw, Xc, Xb, D, base, band, wall, manifold, slot, cavity, fascia, yBand, yWall, yMan, ySlot, yCav, yFas, yTop, P, lanes, label, lw, lh, cavD, zL, hang, hangZ, tubeR, tubes, post, zt, zProud, riser, fan, heads, drops, mouthRoom, hung, front, lip, floor, zLip, zOver, zBack, slabX, hopper: hopperU * U, cta, consent, plate, facts, tally, readout, fromMax, subjectMax, gauge, lamps }
}

/** A box on the machine's front, as the page places it: left and top in the scene, width and height. */
export const onFront = (p: Plan, r: Rect) => ({ left: p.ox + r.x, top: p.oy - r.y - r.h, width: r.w, height: r.h })
