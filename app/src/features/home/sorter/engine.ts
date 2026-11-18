// The sorter at work. Letters fall into the hopper, are read under the scanner, ride the rollers to their lane's gate
// and drop down a chute; a capsule then leaves by that lane's tube. Scams are tossed out of the roof and burnt in the
// air by the laser on that side. The pace climbs until the machine cannot keep up: letters pile on the roof, the gauge
// goes into the red, its valves blow steam, bolts and a panel pop, the hatch stands open, and it bursts in smoke.
// Nothing ever shakes the page: strain is shown by the mechanism itself. Steam and smoke are billows of their own
// (emit, and the field that stirs them), drawn by gl.ts; how many, and at what size, follows the device (LEVELS).
// After the burst every letter and every blown-off part is a rigid body: gravity, spin,
// contact with the floor and the cabinet through its corners, friction, and sleep once it lies still (a sleeping letter
// raises the floor under it, so the next one comes to rest on top: piles). Nothing runs once everything is asleep.
import { createRenderer, FX_FLOATS, LETTER_FLOATS, MATS, SMOKE_FLOATS, type Part } from './gl'
import { bend as bendArm, buildMachine, fitterAt, JOB, type Machine } from './machine'
import { FLOORS, pose, type V3 } from './mesh'
import { MAT as M, oklch, paletteBytes } from './tones'
import { DX, DY, type Plan } from './plan'

export type Letter = { subject: string; from: string; addr: string; snippet: string; route: number; scam: boolean }
/** The lanes, left to right, by the dataset's route names; a scam's route is 7. */
export const LANES = ['thread', 'webhook', 'agent', 'inbox', 'imap', 'ritual', 'campaign'] as const
/** How many letters the page's name for each has (Threads, Endpoints, Agents, Inbox, IMAP, Rules, Campaigns). */
const NAMED = [7, 9, 6, 5, 4, 5, 9]
export type Phase = 'boot' | 'run' | 'overload' | 'boom' | 'rest' | 'rebuild'
/** What the page may play a sound for, each at the moment it happens (`Hooks.sound`). */
export type Sound = 'drop' | 'scan' | 'tube' | 'chute' | 'slide' | 'land' | 'cable' | 'arm' | 'seat' | 'dock' | 'wake' | 'laser' | 'cannon' | 'steam' | 'burst' | 'paper' | 'rebuild' | 'lamp' | 'press'
export type Hooks = { scan: (letter: Letter | null, verdict: 'read' | 'junk' | 'jam' | 'idle') => void; count: (sorted: number, burnt: number) => void; phase: (phase: Phase) => void; hover: (letter: Letter | null, x: number, y: number) => void; veil: (zone: number, clear: number) => void; fit: (lanes: boolean[]) => void; floors: (count: number, whole: boolean) => void; units?: (docked: boolean[]) => void; sound?: (name: Sound, x?: number, gain?: number) => void }
export type Sorter = ReturnType<typeof mountSorter>

const MAX = 760, FREE = 0, SCRIPT = 1, DYN = 2, ASLEEP = 3, HELD = 4, HOME = 5
const CELL = 8, GX0 = -1300, GZ0 = -700, GW = 325, GD = 420, VOID = -9000
const rnd = (a = 1, b = 0) => b + Math.random() * (a - b)
const clamp = (x: number, a = 0, b = 1) => x < a ? a : x > b ? b : x
const ease = (t: number) => t * t * (3 - 2 * t), out = (t: number) => 1 - (1 - t) ** 3

type Bodies = { cap: number; pos: Float32Array; vel: Float32Array; quat: Float32Array; ang: Float32Array; half: Float32Array; state: Uint8Array; still: Float32Array; thin: boolean }
const bodies = (cap: number, thin: boolean): Bodies => ({ cap, pos: new Float32Array(cap * 3), vel: new Float32Array(cap * 3), quat: new Float32Array(cap * 4), ang: new Float32Array(cap * 3), half: new Float32Array(cap * 3), state: new Uint8Array(cap), still: new Float32Array(cap), thin })
const THIN = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0, 0, -1, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 0], BOX = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]
// (What a frame poses things with is written into these, never made anew: no turn, the origin, and scratch turns and places.)
const NONE = new Float32Array([0, 0, 0, 1]), ORIGIN = new Float32Array(3), Q = new Float32Array(4), Q2 = new Float32Array(4), AT = new Float32Array(3), AT2 = new Float32Array(3)
/** A turn of `angle` about z (the page's own plane), into `q`. */
const turnZ = (angle: number, q = Q) => { q[0] = 0; q[1] = 0; q[2] = Math.sin(angle / 2); q[3] = Math.cos(angle / 2); return q }
/** A turn about the upright, into `q`. */
const turnY = (yaw: number, q = Q) => { q[0] = 0; q[1] = -Math.sin(yaw / 2); q[2] = 0; q[3] = Math.cos(yaw / 2); return q }
/** A turn about the page's own axis (a pitch), then one about the upright, into `q`. */
const turnYZ = (yaw: number, turn: number, q = Q) => { const ay = -Math.sin(yaw / 2), aw = Math.cos(yaw / 2), bz = Math.sin(turn / 2), bw = Math.cos(turn / 2); q[0] = ay * bz; q[1] = ay * bw; q[2] = aw * bz; q[3] = aw * bw; return q }
const put = (v: Float32Array, x: number, y: number, z: number) => { v[0] = x; v[1] = y; v[2] = z; return v }

type Script = { stage: number; t: number; lane: number; x0: number; y0: number; ax: number; ay: number; az: number; turn: number; data: number; x: number }
type Fx = { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number; size: number; grow: number; rot: number; spin: number; r: number; g: number; b: number; a: number; shape: number; gravity: number; drag: number; glow: boolean; len: number }

export function mountSorter(canvas: HTMLCanvasElement, options: { plan: Plan; over: number; dark: boolean; reduced: boolean; quick: boolean; letters: Letter[]; hooks: Hooks }) {
  const renderer = createRenderer(canvas)
  if (!renderer) return null
  const { hooks, reduced } = options
  // (A machine with fewer lanes is given only the letters it has a lane for: `routes` says which of the seven its lanes are.)
  // And only those whose sender's name and subject its readout holds whole (while that leaves it enough of them): a
  // sender has as many letters more as the name of where it goes (LANES, or "Scam") is shorter than seven.
  const routed = (letters: Letter[], plan: Plan) => {
    const fit = letters.filter(letter => letter.scam || plan.routes.includes(letter.route)), room = (letter: Letter) => plan.fromMax + Math.floor((7 - (letter.scam ? 4 : NAMED[letter.route])) * .92)
    // (A subject is set on two lines at most, broken between words.)
    const lines = (text: string, most: number) => { let n = 1, at = 0; for (const word of text.split(' ')) { if (at && at + 1 + word.length > most) { n++; at = word.length } else at += (at ? 1 : 0) + word.length } return n }
    const short = fit.filter(letter => letter.from.length <= room(letter) && lines(letter.subject, plan.subjectMax) <= 2)
    return short.length >= 6 && short.some(letter => letter.scam) ? short : fit.length ? fit : letters
  }
  let p = options.plan, over = options.over, dark = options.dark, all = options.letters, pool = routed(all, p), cursor = Math.floor(Math.random() * pool.length)
  let m!: Machine, parts!: Part[], px = 1, G = 1500, oyc = 0
  const L = bodies(MAX, true), kind = new Uint8Array(MAX), data = new Int32Array(MAX), seed = new Float32Array(MAX), burn = new Float32Array(MAX), burning = new Uint8Array(MAX), delay = new Float32Array(MAX), from = new Float32Array(MAX * 7)
  const scripts = new Map<number, Script>(), scale = new Float32Array(MAX).fill(1), tilt = new Float32Array(MAX)
  let Dn = bodies(0, false), debrisPart: number[] = [], debrisHome: V3[] = [], selfPosed = new Set<number>(), boltBody = 0, hatchBody = 0, panelBody = 0, paneBody = 0, deckHome: V3[] = [], away0 = new Float32Array(0), sides = -Infinity, clearX = 0
  const instances = new Float32Array(MAX * LETTER_FLOATS), fxData = new Float32Array(700 * FX_FLOATS), glowData = new Float32Array(64 * FX_FLOATS), airData = new Float32Array(4 * FX_FLOATS)
  // Quality, chosen for the device and lowered if frames come slowly: the canvas's pixel ratio, the shadow map, the size
  // of the smoke's buffer against the page, how many billows may be in the air, how much of the burst's mail is thrown.
  const LEVELS = [{ dpr: 1, shadow: 512, smoke: .25, puffs: 40, mail: .45 }, { dpr: 1.5, shadow: 1024, smoke: .3, puffs: 64, mail: .62 }, { dpr: 2, shadow: 1024, smoke: .4, puffs: 110, mail: .8 }, { dpr: 2, shadow: 2048, smoke: .5, puffs: 240, mail: 1 }]
  const cores = navigator.hardwareConcurrency || 4, memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8
  let quality = options.plan.phone || matchMedia('(pointer: coarse)').matches ? (cores <= 4 || memory <= 4 ? 1 : 2) : cores <= 4 ? 2 : 3, pace = 16, strikes = 0
  // The ladder goes back up too: frames on time for a while, and the level it was built for is tried again. A climb
  // that does not hold (down again within a few seconds) doubles the wait before the next, so it never see-saws.
  const best = quality
  let steady = 0, climbAfter = 300, climbedAt = -1e9
  // Smoke and steam: each billow a point with a velocity, an age and a size that swells.
  const SM = 256, S = { head: 0, live: 0, pos: new Float32Array(SM * 3), vel: new Float32Array(SM * 3), age: new Float32Array(SM), life: new Float32Array(SM), size: new Float32Array(SM), grow: new Float32Array(SM), rot: new Float32Array(SM), spin: new Float32Array(SM), seed: new Float32Array(SM), dens: new Float32Array(SM), kind: new Float32Array(SM), heat: new Float32Array(SM), drag: new Float32Array(SM), lift: new Float32Array(SM) }
  const smokeData = new Float32Array(SM * SMOKE_FLOATS)
  let fx: Fx[] = []
  const heights = new Float32Array(GW * GD), ground = new Float32Array(GW * GD)
  // What a body cannot be inside of: boxes on the floor, each pushed out of through its nearest side below `y` (its
  // top is the floor grid's business); and boxes that hang in the air on the tower's sides (`y0` their underside: a
  // unit, a magazine), pushed out of through their nearest face, and whatever lands on one carried off it (`side`:
  // which way, away from the tower).
  let solids: { x0: number; x1: number; z0: number; z1: number; y: number; y0: number; side: number }[] = []
  const colour = { steam: [1, 1, 1], smoke: [0, 0, 0], ember: [1, .6, .2], red: [1, .2, .2], paper: [1, 1, 1], spark: [1, .9, .6] }

  let phase: Phase = 'boot', clock = 0, runT = 0, heat = 0, speed = 1, feed = 1, spawnIn = .3, sorted = 0, burnt = 0, flash = 0, needle = 0, needleV = 0, time = 0, boomAt = -100
  let scanning = -1, spawned = 0, sparkIn = 0, ejectSide = 0, rainLeft = 0, bend = 0, ventIn = [1.2, 2], ventFor = [0, 0], popIn = 1, hatch = 0, hatchV = 0, smokeLeft = 0, panelOff = false
  const lever = [0, 0], jetIn = [0, 0, 0, 0, 0, 0], leaks: V3[] = []
  // The send cannon: when the next capsule sets off for it, its recoil (1 as it fires, dying away), how long before
  // it will fire for a click again, and what is left of its last volley.
  let sendIn = 2.4, recoil = 0, cool = 0, volley = 0, volleyIn = 0
  // The page is told of each sound (`cue`) as the thing happens: only from a frame of the machine at work, or straight
  // from what the visitor does (`heard` is on for just those), never from a build done at once, a new size or the
  // still. `ears`: the page's own time, unslowed, to keep the busiest few from coming thicker than a few a second;
  // `paperDue`: the burst's falling paper, still to be heard. `pan`: where across the page a place is seen, -1 to 1.
  let heard = false, ears = 0, dropAt = -1, tubeAt = -1, steamAt = -1, paperDue = false
  const cue = (name: Sound, x?: number, gain?: number) => { if (heard && hooks.sound) hooks.sound(name, x, gain) }
  const pan = (x: number, z = 0) => clamp((p.ox + x + DX * z) / p.W * 2 - 1, -1, 1)
  // Where nothing may come to rest (it is carried off): round each laser, and the cannon.
  let keepClear: { x: number; z: number; y: number; r: number }[] = [], base = 1
  const fading: number[] = []
  // What is written on the machine is the page's, over the canvas: where smoke hangs in front of it, it is veiled.
  // Each zone is a rectangle on the front (centre, half size); `cover` is how much smoke is over it now.
  let zones: number[][] = []
  const through = new Float32Array(40), veil = new Float32Array(8).fill(1), veilSent = new Float32Array(8).fill(1), SAMPLE = [0, 0, -.7, -.5, .7, -.5, -.7, .5, .7, .5]
  // The hatch after the burst: thrown back, hanging by one hinge.
  let hatchHang = 0
  // The lasers, left and right: where each points (an angle on the page, from due right), where it means to, how long it
  // holds that, and the beams being fired. (Until the machine is fitted out they hang free, muzzle down, and swing a
  // little when the roof is lifted or set down: `swingV`.)
  const turretAngle = [2.7, .45], turretAim = [2.7, .45], aimHold = [0, 0], swingV = [0, 0], beams: { id: number; k: number; until: number }[] = []
  const queue: number[] = [], QUEUE = 5
  const flapAngle = new Float32Array(7), flapWant = new Float32Array(7), rollerSpin = new Float32Array(56)
  const caps = Array.from({ length: 28 }, () => ({ tube: 0, run: 0, s: 0, wait: 0, on: false }))
  let runLength: number[][][] = []
  // A capsule on a front run is seen only between the two blocks: it slides out of the one and into the other.
  const frontClip = new Float32Array([0, 1, 0, 0, 0, -1, 0, 0])
  // (The day's pace once the machine is whole; before that it is being fitted out, at the pace `B` gives: how long it
  // runs with its one lane, how long between one deck's fitting beginning and the next's, how long a fitting takes.)
  const T = options.quick ? { calm: .8, ramp: 7.6, over: 1.4 } : { calm: 1.4, ramp: 11.5, over: 1.7 }
  const B = options.quick ? { core: 1.2, floor: 1.5, between: .35, gap: 1.2, job: 2.1 } : { core: 2.6, floor: 2.1, between: .7, gap: 1.9, job: 2.9 }
  // The building. The tower begins small: its foot and the frame the price is in, the roof straight on that with the
  // hopper on it, and one tube out (`B.core`: for how long). Then it is built up: the roof is drawn up on its cables,
  // the sorting floor is slid in under it from the page's left and the roof let down on that; then the console from
  // the right, the same way (`B.floor`: how long each takes; `floors`: how many are in; `floorT`: how far through the
  // next is; `SEAT`: how far through it the floor stops in its place). `shifts`: where each floor now is, off its
  // place (gl.ts moves all that belongs to a floor by it).
  // (And the units a wide page's tower takes on its sides, one with each lane: `pod`, how far in each is.)
  const shifts = new Float32Array(3 * FLOORS), pod = new Float32Array(6), rests = new Float32Array(3)
  /** Which of the side units (in the order of `p.pods`) are seated on the tower, for the page's `units` hook. */
  const docked = () => m.pods.map((_, k) => pod[k] >= 1)
  // (`bayOn`: how far the works' lamp has come on, from the moment the roof lands on the sorting floor.)
  let floors = 0, floorT = -1, cableT = 0, bayOn = 0
  const SEAT = .68
  // The fitting out. Once its floors are in, the machine has one lane and is given the rest a lane at a time
  // (plan.ts `fit`), as the product is: each lane's deck waits (in its side's magazine, or off the page's side), is
  // taken by its side's arm, carried round over the port and lowered in; inside it goes down to the roller line and
  // along it to its place, and its chute stands up under it. `deck`: each lane's, where its pivot is and its stage.
  // `arm`: each fitter's, how far it is up out of its well (and whether it is going down into it), the lane it is
  // fitting and how far through, where its hand is (which way it points, how far out, how high), how far its fingers
  // are closed and its port's cover open. `taken`, `lift`: how many decks each side's magazine has given, and how far
  // its lift has come up for them.
  const AWAIT = 0, CARRIED = 1, LOWERED = 2, ALONG = 3, RISING = 4, FITTED = 5
  const deck = Array.from({ length: 7 }, () => ({ stage: FITTED, t: 0, x: 0, y: 0, z: 0, chute: 1, from: 0 }))
  const arm = [0, 1].map(() => ({ pop: 0, down: false, job: -1, t: 0, yaw: 0, r: 1, y: 0, cover: 0, grip: 0, from: new Float32Array(3) }))
  const taken = new Float32Array(2), lift = new Float32Array(2), liftV = new Float32Array(2), hand = new Float32Array(5), angles = new Float32Array(2)
  let fitNext = 1, fitIn = 0, buildT = 0, built = false, screenOn = false, sendOn = false, scamDue = false, begun = false
  // Pressed mid-build, the gauge hurries the build (`rush`: how much faster it goes) and overloads it once it is whole.
  let rush = 1
  // Mail coming to each lane (1 as a letter goes down its chute, dying away): its unit on the tower's side shows it.
  // `reel`, `dial`, `stepAt`: a thread's reels, a rule's clock hand, and which of its lamps is lit.
  // (`got`: whether an inbox's unit has had its letter; `podOf`: which unit each lane has, if any; `armOf`: which
  // fitter fits each lane.)
  const arrived = new Float32Array(7), reel = new Float32Array(6), dial = new Float32Array(6), dialV = new Float32Array(6), dialTo = new Float32Array(6), stepAt = new Uint8Array(6), got = new Uint8Array(6), podOf = new Int8Array(7), armOf = new Int8Array(7)
  let raf = 0, last = 0, visible = true, dead = false
  const pointer = { x: 0, y: 0, in: false, down: false, moved: 0, held: -1, hover: -1, dirty: false, mouse: true, holdY: 0, fromX: 0, fromY: 0 }

  // ── Building ──
  function build() {
    px = p.U / 9; G = 1500 * px; oyc = p.oy + over; pool = routed(all, p); cursor %= pool.length
    size()
    m = buildMachine(p); parts = m.parts
    renderer!.setMesh(m.data); renderer!.setWall(m.wall, 1000)
    renderer!.setMaterials({ paper: M.paper, ink: M.ink, stamp: M.brand, red: M.red, ember: M.ember, char: M.char, dim: M.dim, slab: M.slab })
    frontClip[3] = p.ySlot - .5; frontClip[7] = p.heads.length ? -(p.yWall - .3 * p.V) : 1e6
    runLength = m.lines.map(runs => runs.map(line => { const s = [0]; for (let i = 1; i < line.length; i++) s.push(s[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1], line[i][2] - line[i - 1][2])); return s }))
    // What can be blown off: the hopper, the chimneys, the hatch, the service panel, the glass in panes, every roller,
    // gate and bolt. (The lasers are bolted to the roof's ends, and stay.)
    debrisPart = [m.idx.hopper, ...m.idx.vents, ...(m.idx.hatch < 0 ? [] : [m.idx.hatch]), m.idx.panel, ...m.idx.panes, ...m.idx.rollers, ...m.idx.flaps, ...m.idx.bolts]
    selfPosed = new Set([m.idx.hatch, ...m.idx.rollers, ...m.idx.flaps]); boltBody = debrisPart.length - m.idx.bolts.length; hatchBody = debrisPart.indexOf(m.idx.hatch); panelBody = debrisPart.indexOf(m.idx.panel); paneBody = debrisPart.indexOf(m.idx.panes[0])
    deckHome = p.lanes.map(x => [x, m.yR, p.zL] as V3); m.arms.forEach((A, k) => { for (const lane of A.lanes) armOf[lane] = k }); podOf.fill(-1); m.pods.forEach((unit, k) => { podOf[unit.lane] = k })
    // (How high what hangs on the tower's sides reaches, and how far out: what flies home from under it goes out first.)
    sides = Math.max(-Infinity, ...p.pods.map(at => at.y + at.h), ...m.arms.filter(A => A.parts.lift >= 0).map(A => A.top[1] + m.rr + .3 * p.U)); clearX = p.Xc + Math.max(9.3 * p.U, p.P + 1.5 * p.U) + .7 * p.lw
    Dn = bodies(debrisPart.length, false); away0 = new Float32Array(Dn.cap * 7)
    debrisHome = debrisPart.map((index, i) => {
      const part = m.parts[index], c: V3 = [(part.lo[0] + part.hi[0]) / 2, (part.lo[1] + part.hi[1]) / 2, (part.lo[2] + part.hi[2]) / 2]
      for (let k = 0; k < 3; k++) Dn.half[i * 3 + k] = Math.max(1, (part.hi[k] - part.lo[k]) / 2)
      return c
    })
    // The cabinet; what stands out in front of it either side of the frame (tubes, blocks, brackets); on a wide page
    // the headers and the risers.
    const reach = p.heads.length ? p.riser + .2 * p.U : 0, C = p.cannon, U = p.U
    const floored = (x0: number, x1: number, z0: number, z1: number, y: number) => ({ x0, x1, z0, z1, y, y0: -Infinity, side: 0 })
    solids = [floored(-p.Xc, p.Xc, 0, p.D, p.yTop - 14), ...(p.tubes.length ? [floored(-p.Xc - reach, -p.Xw, p.zProud, 0, p.ySlot), floored(p.Xw, p.Xc + reach, p.zProud, 0, p.ySlot)] : []),
      ...p.heads.map(h => floored(h.x0, h.x1, h.z0, h.z1, h.h - 5 * px)),
      ...(p.heads.length ? [-1, 1].map(side => floored(side < 0 ? -p.Xc - reach : p.Xc + .2 * U, side < 0 ? -p.Xc - .2 * U : p.Xc + reach, p.zProud, p.zProud + 3 * U, p.yWall + 1.7 * p.V - 5 * px)) : []),
      ...(p.phone ? [] : [floored(C.x - C.back, C.x + 3 * C.cs, C.z - C.r - 3 * px, C.z + C.r + 3 * px, C.y + C.pivot + C.r)]),
      // (The units on the tower's sides, each with its bracket under it and what stands out of its front; the magazines.)
      ...p.pods.map(at => ({ x0: at.x - .3 * U, x1: at.x + at.w + .3 * U, z0: at.z - 2.7 * U, z1: at.z + at.d, y: at.y + at.h, y0: at.y - 2.2 * U, side: at.s })),
      ...m.arms.filter(A => A.parts.lift >= 0).map(A => ({ x0: A.s < 0 ? -p.Xc - p.P - 1.5 * U : p.Xc, x1: A.s < 0 ? -p.Xc : p.Xc + p.P + 1.5 * U, z0: m.z0 - 3 * px, z1: m.z1 + 3.4 * px, y: A.top[1] + m.rr + .3 * U, y0: A.foot - 2.5 * U, side: A.s }))]
    // (And on the roof the beacon, and each fitter's column.)
    keepClear = [{ x: C.x - C.cs, z: C.z, y: C.y, r: C.back + 2 * C.cs }, ...(p.tally ? [{ x: p.tally.x + p.tally.w / 2, z: p.tally.z - 12 * px, y: 0, r: 16 * px }] : []), { x: m.beacon[0], z: m.beacon[2], y: p.yTop, r: 4 * px }, ...m.arms.filter(A => !A.crane).map(A => ({ x: A.shoulder[0], z: p.zL, y: p.yTop, r: A.rb + 2 * px }))]
    base = keepClear.length
    zones = [p.readout, { x: -p.Xw, y: p.ySlot, w: 2 * p.Xw, h: p.slot }, { x: -p.Xw, y: p.yBand, w: 2 * p.Xw, h: p.band }, ...p.facts].map(r => [r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2])
    recoil = 0; sendIn = 2.4; volley = 0
    // (A machine built again for a page of another size keeps what has been fitted; what was on its way is home.)
    if (!begun) { begun = true; p.lanes.forEach((_, i) => { deck[i].stage = reduced || i === p.fit[0] ? FITTED : AWAIT; deck[i].chute = deck[i].stage === FITTED ? 1 : 0 }); if (reduced) fitAll() }
    else { if (floorT >= 0) { floors++; floorT = -1 } bayOn = floors ? 1 : 0; for (let k = 0; k < 6; k++) pod[k] = built || k < fitNext - 1 ? 1 : 0; const done = p.fit.slice(0, fitNext); p.lanes.forEach((_, i) => { const on = built || done.includes(i); deck[i].stage = on ? FITTED : AWAIT; deck[i].chute = on ? 1 : 0 }); for (const a of arm) { a.job = -1; a.cover = 0; a.grip = 0 } }
    // (Each magazine has given as many decks as its side has had fitted.)
    m.arms.forEach((A, k) => { taken[k] = lift[k] = A.lanes.filter(i => deck[i].stage === FITTED).length; liftV[k] = 0 })
    hooks.fit(p.lanes.map((_, i) => floors > 0 && deck[i].stage === FITTED)); hooks.floors(floors, built); hooks.units?.(docked())
    stand()
    m.arms.forEach((A, k) => { arm[k].yaw = A.rest[0]; arm[k].r = A.rest[1]; arm[k].y = A.rest[2] })
    if (!screenOn) { turretAngle[0] = turretAim[0] = Math.PI + 1.35; turretAngle[1] = turretAim[1] = -1.35; swingV[0] = swingV[1] = 0 }
    L.state.fill(FREE); scripts.clear(); fx = []; S.head = S.live = 0; S.life.fill(0); layGround(); resetHeights(true); queue.length = 0; spawned = 0; bend = 0; calm()
    for (const cap of caps) cap.on = false
    for (const index of m.idx.caps) parts[index].on = false
    parts[m.idx.scan].on = false; parts[m.idx.beaconOn].on = false; parts[m.idx.soot].on = parts[m.idx.shards].on = parts[m.idx.hole].on = false
    for (const index of [...m.idx.cracks, ...m.idx.panes]) parts[index].on = false
    for (const index of m.idx.lamps) parts[index].on = false
    theme(dark)
  }
  /** Nothing under pressure: the valves shut, the hatch down, no leaks. */
  function calm() { hatchHang = 0; popIn = 1; ventIn = [1.2, 2]; ventFor = [0, 0]; smokeLeft = 0; panelOff = false; leaks.length = 0; lever[0] = lever[1] = 0 }
  function size() { const level = LEVELS[quality]; canvas.dataset.quality = String(quality); if (m) lighting(); renderer!.resize(p.W, p.H + over + p.ext, Math.min(window.devicePixelRatio || 1, level.dpr), p.ox, oyc, { shadow: level.shadow, smoke: level.smoke }, { y0: -p.lip - 8, y1: p.yTop + 300 * (p.U / 9), z0: p.zLip - 50, z1: p.zBack + 50 }) }
  // How the place is lit (gl.ts), from the plan, the theme and what the device can afford. By night the lamp over the
  // machine leaves the slab's ends in the dark, and the price's windows and the button are lights of their own; by
  // day the room is bright and they are paper and paint. A soft shadow costs looks at the map: fewer on a phone, and
  // a plain edge where frames are short.
  function lighting() {
    const U = p.U, lin = (v: number) => { const x = v / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4 }
    const page = (dark ? oklch(.158, .014, 268) : oklch(.948, .01, 262)).map(lin), half = -p.name.x, y0 = p.yWall + p.under * p.V, y1 = p.name.y + p.name.cap
    const far = [1e6, 1e6, 1e6, 1e6], heads = p.heads.map(h => [h.x0, h.z0, h.x1, h.z1])
    renderer!.setLook({
      soft: [0, 1.5, 2, 2.5][quality], far: 7 * U,
      pool: [0, p.D * .2, 2.5 * p.Xc, 1.3 * p.D - p.zLip], dim: dark ? .2 : .82,
      fog: [p.D * .35, p.D * 1.5, dark ? .72 : .3], fogTo: page,
      rects: [[0, (y0 + y1) / 2, half, (y1 - y0) / 2], [p.cta.x + p.cta.w / 2, p.cta.y + p.cta.h / 2, p.cta.w / 2, p.cta.h / 2]],
      lights: dark ? [[2.3, 1.95, 1.4, -.5], [1.3, 1.2, .95, -1.2 * px]] : [[0, 0, 0, -1e6], [0, 0, 0, -1e6]],
      boxes: [[-p.Xc, 0, p.Xc, p.D], heads[0] ?? far, heads[1] ?? far], reachK: [1 / (.15 * p.yTop), 1 / (1.3 * (p.heads[0]?.h ?? 1)), 1 / (1.3 * (p.heads[0]?.h ?? 1))],
      unit: U, roof: p.yTop, own: dark ? 1 : 0, edge: .8 * px, grime: dark ? .24 : .1, grain: (dark ? 1.6 : 1) / 255, env: dark ? [1, .1, .32] : [.5, .25, .3],
      gain: dark ? [.8, 1.45] : [1, 1], bay: [p.yFas - 2 * px, p.cavD * .1, p.Xb, p.cavity * .8, p.yCav], bayLight: (dark ? [2.1, 2.35, 2.7] : [.25, .25, .25]).map(v => v * ease(bayOn)),
    })
  }
  function theme(next: boolean) {
    dark = next
    lighting()
    renderer!.setPalette(paletteBytes(dark, MATS))
    const page = dark ? oklch(.158, .014, 268) : oklch(.948, .01, 262); renderer!.setClear(page[0] / 255, page[1] / 255, page[2] / 255)
    const set = (name: keyof typeof colour, l: number, c: number, h: number) => { colour[name] = oklch(l, c, h).map(v => v / 255) }
    if (dark) { set('steam', .8, .008, 268); set('smoke', .33, .012, 268) } else { set('steam', .995, .003, 262); set('smoke', .7, .008, 262) }
    const rgb01 = (l: number, c: number, h: number) => oklch(l, c, h).map(v => v / 255)
    renderer!.setSmoke(dark ? { lit0: rgb01(.86, .006, 268), shade0: rgb01(.4, .014, 268), lit1: rgb01(.5, .01, 268), shade1: rgb01(.2, .014, 268), hot: rgb01(.66, .15, 52) } : { lit0: rgb01(.97, .004, 262), shade0: rgb01(.76, .014, 262), lit1: rgb01(.74, .008, 262), shade1: rgb01(.5, .014, 262), hot: rgb01(.7, .16, 52) })
    set('ember', .78, .17, 58); set('red', .64, .21, 27); set('paper', .955, .014, 92); set('spark', .93, .09, 85)
  }
  /** The floor as the machine is built (worked out once for a plan, and copied back when the floor is cleared). */
  function layGround() {
    // The slab, and the cabinet's roof standing on it; everywhere else there is nothing to land on. On the slab the
    // headers, the risers and the tubes that cross it are floor too (a letter lies on a tube, not through it).
    const yc = p.tubeR * 2 + 3.5 * px
    for (let iz = 0; iz < GD; iz++) for (let ix = 0; ix < GW; ix++) {
      const x = GX0 + (ix + .5) * CELL, z = GZ0 + (iz + .5) * CELL
      ground[iz * GW + ix] = x > -p.Xc && x < p.Xc && z > 0 && z < p.D ? p.yTop
        : p.heads.length && Math.abs(x) > p.Xc + .2 * p.U && Math.abs(x) < p.Xc + .2 * p.U + p.riser && z > p.zProud && z < p.zProud + 3 * p.U ? p.yWall + 1.7 * p.V
        : p.heads.some(h => x > h.x0 && x < h.x1 && z > h.z0 && z < h.z1) ? p.heads[0].h
        : !p.phone && x > p.cannon.x - p.cannon.back - 3.3 * p.cannon.cs && x < p.cannon.x + 3.4 * p.cannon.cs && Math.abs(z - p.cannon.z) < p.cannon.r + 1.4 * p.cannon.cs ? p.cannon.chest
        : z > p.zLip + 22 * px && z < p.zProud && p.fan.some(leg => Math.abs(x - leg.x) < p.tubeR + 2) ? yc
        : Math.abs(x) < p.slabX && z > p.zLip + 22 * px && z < p.zBack ? 0 : VOID
    }
    // On the roof, what stands on it low enough to lie on is floor too: the ports' kerbs and covers, the slots scams
    // leave by, the wells the fitters stand in, the lasers' pedestals, (on a wide page) the cables back to their
    // junction boxes, and the eyes the roof hung from. (What is taller is kept clear: the beacon, a fitter's column.)
    const raise = (x0: number, x1: number, z0: number, z1: number, y: number) => { for (let z = z0; z < z1 + CELL / 2; z += CELL / 2) for (let x = x0; x < x1 + CELL / 2; x += CELL / 2) { const c = cell(Math.min(x, x1), Math.min(z, z1)); if (c >= 0 && ground[c] >= p.yTop && ground[c] < y) ground[c] = y } }
    for (const A of m.arms) { raise(A.portX - A.hw - 1.4 * px, A.portX + A.hw + 1.4 * px, p.zL - A.pd - 1.4 * px, p.zL + A.pd + 1.4 * px, p.yTop + 2 * px); if (!A.crane) raise(A.shoulder[0] - A.wellX - 1.4 * px, A.shoulder[0] + A.wellX + 1.4 * px, A.wellZ[0] - 1.4 * px, A.wellZ[1] + 1.4 * px, p.yTop + 1.3 * px) }
    for (const e of p.phone ? m.ejects.slice(0, 1) : m.ejects) raise(e[0] - .62 * p.lw, e[0] + .62 * p.lw, e[2] - 6 * px, e[2] + 6 * px, p.yTop + 5 * px)
    for (const s of [-1, 1]) {
      const in0 = s * (p.phone ? p.Xc - 2.4 * p.U : p.Xc - 1.6 * p.U), ex = p.hang[s < 0 ? 0 : 1], ez = p.hangZ, ep = (p.phone ? 1.6 : 1) * px
      raise(Math.min(in0, s * p.Xc), Math.max(in0, s * p.Xc), 0, 7 * px, p.yTop + 4.4 * px); raise(ex - 2.4 * ep, ex + 2.4 * ep, ez - 2.4 * ep, ez + 2.4 * ep, p.yTop + 5.3 * ep)
      if (!p.phone) { const x = s * (p.Xc - 2.6 * p.U), jx = x - s * 2.2 * p.U, jz = p.D * .52; raise(x - 1.3 * px, x + 1.3 * px, 7 * px, jz, p.yTop + 2.7 * px); raise(Math.min(jx, x), Math.max(jx, x), jz - 1.3 * px, jz + 1.3 * px, p.yTop + 2.7 * px); raise(jx - 4 * px, jx + 4 * px, jz - 4 * px, jz + 4 * px, p.yTop + 4 * px) }
    }
  }
  function resetHeights(hopper = false) {
    heights.set(ground)
    if (!hopper) return
    // While the hopper stands its mouth is floor too: what overflows it lies in it and round it, not through its plates.
    const hh = p.hopper * .82 * .5, ht = p.lw * 1.1, hd = p.lw * .36
    for (let z = p.zL - hd; z < p.zL + hd; z += CELL) for (let x = -ht; x < ht; x += CELL) { const c = cell(x, z); if (c >= 0 && heights[c] === p.yTop) heights[c] = p.yTop + hh }
  }
  const cell = (x: number, z: number) => { const ix = Math.floor((x - GX0) / CELL), iz = Math.floor((z - GZ0) / CELL); return ix < 0 || iz < 0 || ix >= GW || iz >= GD ? -1 : iz * GW + ix }

  // ── The fitting out ──
  /** Everything fitted at once: for a visitor who will not wait, and a page shown without motion. */
  function fitAll() {
    p.lanes.forEach((_, i) => { deck[i].stage = FITTED; deck[i].chute = 1 })
    for (const a of arm) { a.pop = 1; a.down = false; a.job = -1; a.cover = 0; a.grip = 0 }
    fitNext = p.fit.length; built = screenOn = sendOn = true; rush = 1; floors = 2; floorT = -1; cableT = 1; bayOn = 1; pod.fill(1)
    if (m) m.arms.forEach((A, k) => { taken[k] = lift[k] = A.count; liftV[k] = 0 })
    hooks.fit(p.lanes.map(() => true)); hooks.floors(2, true); hooks.units?.(docked())
    if (m) stand()
  }
  /** Where the floors stand now: the sorting floor and the console off to the side until they are slid in, the roof
   *  on whatever is under it (or drawn up over the floor that is coming in, and let down on it). */
  function stand() {
    const U = p.U, gap = 2.4 * U, far = p.W + 2 * p.Xc + 30 * U
    rests[0] = p.ySlot - p.yTop; rests[1] = p.yFas - p.yTop; rests[2] = 0
    let lid = rests[floors], sort = floors >= 1 ? 0 : -far, desk = floors >= 2 ? 0 : far
    if (floorT >= 0) {
      // The roof is drawn up on its cables, slow to get going as a weight is, and bobs as they take it; the floor is
      // slid in under it, braking hard, running on a hair past its place and back; and the roof is let down on it,
      // gathering way and then at a steady rate, until the floor stops it dead.
      const next = floors + 1, u = floorT, up = ease(clamp(u / .26)), held = u - .26, bob = held > 0 ? .14 * U * Math.sin(held * 24) * Math.exp(-held * 10) : 0
      const s = clamp((u - .18) / (SEAT - .18)), q = clamp((s - .75) / .25), slide = far * (1 - s) ** 4 - .5 * U * Math.sin(Math.PI * q) * (1 - q)
      const t = clamp((u - .74) / .24), down = t < .3 ? t * t / .51 : (t - .15) / .85
      lid = rests[floors] + (rests[next] + gap - rests[floors]) * up + bob - gap * down
      if (next === 1) sort = -slide; else desk = slide
    }
    shifts[3] = sort; shifts[6] = desk; shifts[10] = lid
    // (A side unit comes in from its own side of the page, braking to a stop a hand short of the tower; then it is
    // pushed home, gathering way, and gives a little as it seats.)
    for (let k = 0; k < m.pods.length; k++) {
      const u = clamp(pod[k]), push = clamp((u - .7) / .2), q = clamp((u - .9) / .1)
      shifts[3 * (4 + k)] = p.pods[k].s * (far * (1 - clamp(u / .6)) ** 4 + 1.2 * U * (1 - push * push) + .3 * U * Math.sin(Math.PI * q) * (1 - q))
    }
    // (The cables are unhooked once the roof stands on the console: they go slack for a moment, then are drawn up,
    // gathering way, out of the top of the page in about .4 s, and on out of the night's way.)
    const dip = -(p.phone ? 4.8 : 3) * px * Math.sin(Math.PI * clamp((cableT - .1) / .3)), pull = cableT > .3 ? (p.oy - p.yTop + 20 * px) * ((cableT - .3) / .4) ** 2 : 0
    parts[m.cables].on = cableT < 1; pose(parts[m.cables].m, ORIGIN, put(AT, 0, dip + pull, 0), NONE)
  }
  /** How far the roof now stands under where it will. */
  const lid = () => shifts[10]
  let tailT = 0, dueRoute = -1
  function fitting(dt: number) {
    // (Pressed mid-build, the gauge hurries it: everything still to come comes faster, the fitters both at once.)
    const building = !built && (phase === 'run' || phase === 'overload')
    if (building) dt *= rush
    // (The works' lamp comes on over .3 s as the roof lands on the sorting floor, not in one frame.)
    if (floors && bayOn < 1) { if (bayOn === 0) cue('lamp'); bayOn = Math.min(1, bayOn + dt / .3); lighting() }
    if (building && floors < 2) {
      buildT += dt
      // (Not while a letter is in the throat or at the scanner: with the floor over it away it would hang in the air.)
      if (floorT < 0) { if (buildT > (floors ? B.between : B.core) && scanning === -1) { floorT = 0; swingV[0] -= .5; swingV[1] += .5; cue('slide', floors ? .9 : -.9) } }
      else {
        const before = floorT; floorT += dt / B.floor
        // (The page is told a floor is in as it seats, at the end of its slide, not once the roof is back down on it:
        // the console's screen comes on as the console stops. Its lanes' names wait for the roof, through `fit`.)
        if (before < SEAT && floorT >= SEAT) hooks.floors(floors + 1, false)
        // (As the roof comes down on the new floor: dust along the join, the needle jumps, the hanging lasers swing.)
        if (before < .97 && floorT >= .97) { const y = p.yTop + rests[floors + 1]; for (let k = 0; k < 7; k++) { const x = (k / 6 - .5) * 2 * p.Xc; dust(x, y, -3 * px); if (k % 3 === 0) sparks(x, y, -4 * px, 2, 110) } needleV += 2.2; swingV[0] += 1.3; swingV[1] -= 1.1; cue('land') }
        if (floorT >= 1) { floors++; floorT = -1; buildT = 0; lighting(); hooks.fit(p.lanes.map((_, i) => deck[i].stage === FITTED)); spawnIn = Math.min(spawnIn, .3) }
      }
      stand()
    } else if (building && cableT < 1) { const was = cableT; cableT = Math.min(1, cableT + dt); if (was < .3 && cableT >= .3) cue('cable'); stand(); buildT = 0 }
    else if (building) {
      buildT += dt
      // First the fitters themselves: up out of their wells, the left one and then the right.
      for (let k = 0; k < m.arms.length; k++) if (!m.arms[k].crane && buildT > .3 + k * .32 && arm[k].pop < 1) { if (arm[k].pop === 0) { const A = m.arms[k]; jet(A.shoulder[0], p.yTop + 2 * px, p.zL, 0, 1, 110, 3, .8); cue('arm', pan(A.shoulder[0], p.zL)) } arm[k].down = false; arm[k].pop = Math.min(1, arm[k].pop + dt / .6) }
      // Then a deck at a time, each side's arm in turn; a new one begins before the last is home.
      let ready = true
      for (let k = 0; k < m.arms.length; k++) ready &&= m.arms[k].crane || arm[k].pop >= 1
      if (ready && fitNext < p.fit.length) {
        fitIn -= dt
        const i = p.fit[fitNext], k = armOf[i], a = arm[k]
        // (A crane's hook comes down from out of sight over the page, with the deck already on it.)
        if ((fitIn <= 0 || rush > 1) && a.job < 0) { a.job = i; a.t = 0; if (m.arms[k].crane) { put(a.from, 0, 0, oyc - DY * p.zL + m.grip + m.deckH + 10 * px); deck[i].stage = CARRIED } else put(a.from, a.yaw, a.r, a.y); fitNext++; fitIn = B.gap; cue('arm', pan(m.arms[k].crane ? m.arms[k].portX : m.arms[k].shoulder[0], p.zL)) }
      }
      // (Each lane's unit is plugged onto the tower's side while its deck is on its way in.)
      for (let k = 0; k < m.pods.length; k++) if (pod[k] < 1 && p.fit.indexOf(m.pods[k].lane) < fitNext) {
        const before = pod[k]; pod[k] = Math.min(1, pod[k] + dt / (options.quick ? .9 : 1.25))
        if (before < .9 && pod[k] >= .9) { const at = p.pods[k], x = at.s < 0 ? at.x + at.w : at.x; sparks(x, at.y + at.h * .5, at.z - 2 * px, 6, 150); dust(x, at.y + at.h * .2, at.z - 2 * px); cue('dock', pan(x, at.z)) }
        if (pod[k] >= 1) hooks.units?.(docked())
        stand()
      }
      // And once every lane is in: the lasers come up, the cannon is given something to send, and the day begins
      // (or, hurried, it overloads).
      let done = fitNext >= p.fit.length
      for (let k = 0; k < m.arms.length; k++) done &&= arm[k].job < 0
      for (let i = 0; i < p.lanes.length && done; i++) done = deck[i].stage === FITTED
      if (done) {
        tailT += dt
        if (!screenOn && tailT > .35) { screenOn = true; scamDue = true; spawnIn = Math.min(spawnIn, .3); cue('wake') }
        if (!sendOn && tailT > 1) { sendOn = true; sendIn = .2 }
        if (tailT > 1.7) { built = true; rush = 1; hooks.floors(2, true) }
      }
    }
    for (let k = 0; k < m.arms.length; k++) {
      const A = m.arms[k], a = arm[k]
      // Once the machine is whole the fitters stand by over their ports; as it overloads they fold down into their
      // wells, out of the way of what is to come, and once it is put back together they come up again.
      if (built && !A.crane) {
        if (phase === 'overload' || phase === 'boom' || phase === 'rest' || phase === 'rebuild') { if (a.pop > 0) { a.down = true; a.pop = Math.max(0, a.pop - dt / .5) } }
        else if (a.pop < 1 && clock > .25 + .3 * k) { if (a.pop === 0) { jet(A.shoulder[0], p.yTop + 2 * px, p.zL, 0, 1, 110, 3, .8); cue('arm', pan(A.shoulder[0], p.zL)) } a.down = false; a.pop = Math.min(1, a.pop + dt / .6) }
      }
      if (a.job < 0 && A.crane) continue
      if (a.job < 0) { const e = Math.min(1, dt * 5); a.yaw += (A.rest[0] - a.yaw) * e; a.r += (A.rest[1] - a.r) * e; a.y += (A.rest[2] - a.y) * e; a.cover -= a.cover * Math.min(1, dt * 9); a.grip -= a.grip * Math.min(1, dt * 9); continue }
      a.t += dt / B.job
      const u = Math.min(1, a.t), i = a.job, d = deck[i], n = A.lanes.indexOf(i)
      fitterAt(A, a.from, u, hand)
      a.yaw = hand[0]; a.r = hand[1]; a.y = hand[2]; a.grip = hand[3]; a.cover = hand[4]
      // (The deck is the hand's once its fingers have closed on it, and the port's once they open; the magazine lifts
      // the next up once this one is clear of it.)
      if (d.stage === AWAIT && u >= JOB.shut) d.stage = CARRIED
      if (u >= JOB.lift && taken[k] < n + 1) taken[k] = n + 1
      if (d.stage === CARRIED) {
        d.x = A.crane ? A.portX : A.shoulder[0] + Math.cos(a.yaw) * a.r; d.y = a.y - m.grip - m.rr; d.z = A.crane ? p.zL : p.zL + Math.sin(a.yaw) * a.r
        if (u >= JOB.open) { d.stage = LOWERED; d.t = 0; d.from = d.y }
      }
      if (u >= 1) a.job = -1
    }
    // (A magazine's lift comes up a deck at a time, a little past, and settles.)
    for (let k = 0; k < m.arms.length; k++) { liftV[k] += ((taken[k] - lift[k]) * 90 - liftV[k] * 12) * dt; lift[k] += liftV[k] * dt; if (Math.abs(taken[k] - lift[k]) < 1e-3 && Math.abs(liftV[k]) < 1e-3) { lift[k] = taken[k]; liftV[k] = 0 } }
    // A deck let go of: down inside to the roller line, along it to its place, and its chute up under it.
    for (let i = 0; i < p.lanes.length; i++) {
      const x = p.lanes[i], d = deck[i]
      if (d.stage === AWAIT) { const k = armOf[i], A = m.arms[k], n = A.lanes.indexOf(i); if (n >= 0) { d.x = A.top[0] + shifts[6] - shifts[3]; d.y = A.top[1] - (n - lift[k]) * A.pitch + shifts[7] - shifts[4]; d.z = A.top[2] } }
      else if (d.stage === LOWERED) { d.t += dt / (options.quick ? .3 : .42); d.y = d.from + (m.yR - d.from) * ease(clamp(d.t)); if (d.t >= 1) { d.stage = ALONG; d.t = 0; d.from = d.x } }
      else if (d.stage === ALONG) {
        const far = Math.abs(x - d.from) / p.P; d.t += far < .1 ? 1 : dt / (.16 + .11 * far)
        // (It comes up to its neighbour, a hair past where it belongs, and settles back.)
        const u = clamp(d.t), back = 1 + 2.2 * (u - 1) ** 3 + 1.2 * (u - 1) ** 2; d.x = d.from + (x - d.from) * back
        if (d.t >= 1) { d.stage = RISING; d.t = 0; d.x = x; d.y = m.yR; sparks(x - p.P / 2, m.yR, m.z0 - 2 * px, 3, 90); sparks(x + p.P / 2, m.yR, m.z0 - 2 * px, 3, 90); cue('seat', pan(x, p.zL)) }
      } else if (d.stage === RISING) {
        d.t += dt / .28; d.chute = out(clamp(d.t))
        if (d.t >= 1) { d.stage = FITTED; d.chute = 1; dueRoute = p.routes[i]; spawnIn = Math.min(spawnIn, .25); hooks.fit(p.lanes.map((_, n) => deck[n].stage === FITTED)); parts[m.idx.lamps[1]].on = false; lampIn = .12 }
      }
    }
  }
  let lampIn = 0

  // ── Letters ──
  function alloc() {
    for (let i = 0; i < MAX; i++) if (L.state[i] === FREE) return i
    // Full: take one that has long been lying still.
    let pick = 0
    for (let i = 0; i < MAX; i++) if (L.state[i] === ASLEEP && L.still[i] > L.still[pick]) pick = i
    return pick
  }
  function place(i: number, x: number, y: number, z: number) {
    L.pos[i * 3] = x; L.pos[i * 3 + 1] = y; L.pos[i * 3 + 2] = z
    L.quat.set([0, 0, 0, 1], i * 4); L.vel.fill(0, i * 3, i * 3 + 3); L.ang.fill(0, i * 3, i * 3 + 3)
    L.half[i * 3] = p.lw / 2; L.half[i * 3 + 1] = p.lh / 2; L.half[i * 3 + 2] = .7
    L.still[i] = 0; burn[i] = 0; burning[i] = 0; seed[i] = Math.random(); scale[i] = 1; tilt[i] = 0
  }
  // (Only what the machine can yet deal with comes: mail for the lanes it has, and scams once its lasers are up.)
  const wanted = (letter: Letter) => letter.scam ? screenOn : deck[Math.max(0, p.routes.indexOf(letter.route))].stage === FITTED
  function nextLetter(i: number) { for (let tries = 0; tries < pool.length; tries++) { cursor = (cursor + 1223) % pool.length; if (wanted(pool[cursor])) break } data[i] = cursor; kind[i] = pool[cursor].scam ? 1 : 0 }
  function spawn() {
    const i = alloc(); nextLetter(i)
    // The first letter after the lasers come up is a scam, so they are seen at work at once.
    spawned++
    if (scamDue) { scamDue = false; for (let tries = 0; tries < pool.length && !pool[cursor].scam; tries++) nextLetter(i) }
    // And the first after a lane is fitted is mail for that lane.
    else if (dueRoute >= 0) { for (let tries = 0; tries < pool.length && (pool[cursor].scam || pool[cursor].route !== dueRoute); tries++) nextLetter(i); dueRoute = -1 }
    const x0 = rnd(-1, 1) * p.lw * 1.8, y0 = oyc + p.lh
    place(i, x0, y0, p.zL); L.state[i] = SCRIPT
    const letter = pool[data[i]]
    scripts.set(i, { stage: 0, t: 0, lane: letter.scam ? 7 : Math.max(0, p.routes.indexOf(letter.route)), x0, y0, ax: rnd(-1, 1), ay: rnd(-1, 1), az: rnd(-1, 1), turn: rnd(3, 7) * (Math.random() < .5 ? -1 : 1), data: data[i], x: 0 })
  }
  function loose(i: number, vx: number, vy: number, vz: number, spin = 6) {
    scripts.delete(i); L.state[i] = DYN; L.still[i] = 0
    L.vel[i * 3] = vx; L.vel[i * 3 + 1] = vy; L.vel[i * 3 + 2] = vz
    L.ang[i * 3] = rnd(-spin, spin); L.ang[i * 3 + 1] = rnd(-spin, spin); L.ang[i * 3 + 2] = rnd(-spin, spin)
    if (scanning === i) scanning = -1
    const at = queue.indexOf(i); if (at >= 0) queue.splice(at, 1)
  }
  const setQuat = (i: number, ax: number, ay: number, az: number, angle: number) => { const l = Math.hypot(ax, ay, az) || 1, s = Math.sin(angle / 2) / l; L.quat[i * 4] = ax * s; L.quat[i * 4 + 1] = ay * s; L.quat[i * 4 + 2] = az * s; L.quat[i * 4 + 3] = Math.cos(angle / 2) }

  // A letter's way through the works, a stage at a time. `rate` is how much faster than calm the machine is running.
  function script(i: number, s: Script, dt: number, roll: number) {
    // The hopper and the scanner quicken faster than the rollers do: the works fill up.
    const P = L.pos, o = i * 3, rate = s.stage >= 5 && s.stage <= 7 ? roll : feed
    s.t += dt
    if (s.stage === 0) {
      // Falling out of the night, tumbling, into the hopper; turned square by the time it is there.
      const d = .85 / Math.sqrt(rate), u = clamp(s.t / d), topY = m.hopperTop + lid() + p.lh * .2
      P[o] = s.x0 * (1 - out(u)); P[o + 1] = s.y0 + (topY - s.y0) * (u * u * .7 + u * .3); P[o + 2] = p.zL
      setQuat(i, s.ax, s.ay, s.az, s.turn * (1 - u) ** 1.6)
      if (u >= 1) {
        if (queue.length < QUEUE && (phase !== 'overload' || !built)) { queue.push(i); s.stage = 1; s.t = 0; if (ears - dropAt >= 1 / 6) { dropAt = ears; cue('drop', pan(P[o])) } }
        // (While the tower is going up, what the hopper has no room for is not thrown about: it is not taken.)
        else if (!built) { scripts.delete(i); L.state[i] = FREE }
        else loose(i, rnd(-1, 1) * 170 * px, rnd(140, 320) * px, rnd(-60, 150) * px, 5)
      }
    } else if (s.stage === 1) {
      // In the hopper, in a heap: each lying back against the funnel's back wall, the next to go lowest and nearest,
      // the rest over and behind it, each a little askew; settling into its place as it lands. (It rides with the
      // roof as the roof is drawn up or let down.)
      const j = queue.indexOf(i), k = Math.min(1, dt * 16), roll = j ? (j % 2 ? .22 : -.18) : .06, back = (.95 + .1 * j) * ease(clamp(s.t / .2))
      P[o] += ((j % 2 ? 1 : -1) * Math.min(j, 1) * p.lw * .08 - P[o]) * k; P[o + 1] += lidMoved; P[o + 1] += (p.yTop + lid() + p.hopper * (.3 + .09 * j) - P[o + 1]) * k; P[o + 2] += (p.zL + (j - 1) * p.lh * .09 - P[o + 2]) * k
      setQuat(i, 1, 0, roll, back); s.ax = back; s.az = roll
      // (While the roof is drawn up off the tower the line waits: down its throat now would be out of its underside.)
      if (j === 0 && scanning === -1 && floorT < 0 && s.t > .1 / rate) { queue.shift(); scanning = i; s.stage = 10; s.t = 0; s.y0 = P[o + 1] }
    } else if (s.stage === 10) {
      // Down the throat and out of sight.
      const u = clamp(s.t / (.16 / rate))
      P[o] *= 1 - u; P[o + 1] = s.y0 + (p.yTop + lid() - p.lh - s.y0) * u * u; P[o + 2] += (p.zL - P[o + 2]) * Math.min(1, dt * 20); setQuat(i, 1, 0, s.az, s.ax * (1 - ease(clamp(u * 2))))
      // (Before there is a sorting floor the tower does one thing: what goes in at the top leaves by the one tube.)
      if (u >= 1 && !floors) { scripts.delete(i); L.state[i] = FREE; scanning = -1; sorted++; hooks.count(sorted, burnt); launch(tubeOf(p.fit[0])); launch(7) }
      else if (u >= 1) { s.stage = 2; s.t = 0; s.y0 = Math.min(p.yFas + p.lh * .6, p.yTop + lid() - p.lh) }
    } else if (s.stage === 2) {
      const u = clamp(s.t / (.22 / rate))
      P[o] = 0; P[o + 1] = s.y0 + (m.scanY - s.y0) * out(u)
      if (u >= 1) { s.stage = 3; s.t = 0; hooks.scan(pool[s.data], pool[s.data].scam ? 'junk' : 'read'); cue('scan') }
    } else if (s.stage === 3) {
      const d = Math.max(.09, .62 / rate), u = clamp(s.t / d), scan = parts[m.idx.scan]
      scan.on = true; pose(scan.m, put(AT2, 0, m.scanY, p.zL), put(AT, 0, m.scanY + Math.cos(u * Math.PI * 2) * p.lh * .42, p.zL), NONE)
      if (u >= 1) { scan.on = false; s.stage = s.lane === 7 ? 20 : 4; s.t = 0; if (s.lane !== 7) scanning = -1 }
    } else if (s.stage === 4) {
      const u = clamp(s.t / (.14 / rate))
      P[o + 1] = m.scanY + (m.rideY - m.scanY) * u * u
      if (u >= 1) { s.stage = Math.abs(p.lanes[s.lane]) < 1 ? 6 : 5; s.t = 0; s.x = 0 }
    } else if (s.stage === 5) {
      // On the rollers, out to its lane's gate.
      const dir = p.lanes[s.lane] < 0 ? -1 : 1, target = p.lanes[s.lane] - dir * p.P * .12
      s.x += dir * 120 * px * rate * dt
      if ((s.x - target) * dir >= 0) { s.x = target; s.stage = 6; s.t = 0 }
      P[o] = s.x; P[o + 1] = m.rideY + Math.sin(s.x * .9) * .5 * px
      if ((p.lanes[s.lane] - s.x) * dir < p.P * .5) flapWant[s.lane] = 1
    } else if (s.stage === 6) {
      // The gate drops away under it: it tips with the gate and slides off into the chute.
      const u = clamp(s.t / (.3 / rate)), dir = m.swing[s.lane], hinge = m.hinge[s.lane], a = -dir * 1.02 * ease(clamp(u * 1.4))
      flapWant[s.lane] = 1
      const lx = s.x - hinge[0] + dir * u * u * p.P * .3, ly = m.rr + p.lh / 2
      P[o] = hinge[0] + lx * Math.cos(a) - ly * Math.sin(a); P[o + 1] = hinge[1] + lx * Math.sin(a) + ly * Math.cos(a)
      setQuat(i, 0, 0, 1, a)
      if (u >= 1) { s.stage = 7; s.t = 0; s.x0 = P[o]; s.y0 = P[o + 1]; s.turn = a; cue('chute', pan(p.lanes[s.lane])) }
    } else if (s.stage === 7) {
      const u = clamp(s.t / (.34 / rate)), endY = p.yCav - p.lh * .9
      P[o] = s.x0 + (p.lanes[s.lane] - s.x0) * out(u); P[o + 1] = s.y0 + (endY - s.y0) * u * u
      setQuat(i, 0, 0, 1, s.turn * (1 - out(u)))
      if (u > .35) flapWant[s.lane] = 0
      if (u >= 1) {
        scripts.delete(i); L.state[i] = FREE; sorted++; hooks.count(sorted, burnt); launch(tubeOf(s.lane)); launch(7)
        arrived[s.lane] = 1; const k = podOf[s.lane]; if (k >= 0) { dialTo[k] += Math.PI / 2; stepAt[k] = (stepAt[k] + 1) % 4; got[k] = 1 }
      }
    } else if (s.stage === 20) {
      // A scam: back up behind the fascia, then thrown out of the roof for the laser.
      const u = clamp(s.t / (.2 / rate))
      P[o + 1] = m.scanY + (p.yFas + p.lh - m.scanY) * u * u
      if (u >= 1) {
        scanning = -1
        // Out of the slot on one side or the other in turn, tossed in an arc over the end of the roof to where the
        // page is empty beside the machine. (Stacked, where it isn't: out of the left slot, clear of the cannon, and
        // straight up, as high as leaves it under the header; the two lasers take it in turn.)
        const k = ejectSide ^= 1, side = p.phone ? -1 : k ? 1 : -1, from = m.ejects[p.phone ? 0 : k]
        place(i, from[0], from[1] + p.lh * .2, from[2]); L.state[i] = SCRIPT; seed[i] = Math.random()
        s.stage = 21; s.t = 0; s.lane = k; s.x0 = from[0]; s.y0 = from[1] + p.lh * .2; s.turn = -side
        s.ax = p.phone ? from[0] + side * 14 * px : side * (p.Xc + 118 * px); s.ay = p.phone ? p.yTop + Math.max(p.lh * 2, Math.min(122 * px, p.oy - p.yTop - DY * p.zL - p.lw * .66)) : p.yTop - 44 * px; s.az = 104 * px
        jet(from[0], from[1], from[2], side * .3, .95, 120, 3)
      }
    } else if (s.stage === 31) {
      // Sent: out of the muzzle and off the page's right edge in an arc.
      const c = m.cannon, C = p.cannon, mx = c.pivot[0] + C.fore * c.ce, my = c.pivot[1] + C.fore * c.se, inBore = (C.fore - s.y0) / s.az
      let a = C.el
      if (s.t < inBore) { const at = s.y0 + s.az * s.t; P[o] = c.pivot[0] + at * c.ce; P[o + 1] = c.pivot[1] + at * c.se }
      else { const dx = (s.t - inBore) * s.az * c.ce, slope = c.se / c.ce - 2 * s.x * dx; P[o] = mx + dx; P[o + 1] = my + c.se / c.ce * dx - s.x * dx * dx; a = Math.atan(slope) }
      P[o + 2] = c.pivot[2]; setQuat(i, 0, 0, 1, a)
      // (Smoke at the muzzle as the letter clears it.)
      if (!s.turn && s.t >= inBore) {
        s.turn = 1
        jet(mx, my, c.pivot[2], c.ce, c.se, 300, quality > 1 ? 6 : 4, 1.4, .25)
        if (room()) for (let k = 0; k < 3; k++) emit(mx + c.ce * 6 * px, my + c.se * 6 * px, c.pivot[2], (c.ce * 60 + rnd(-30, 30)) * px, (c.se * 60 + rnd(0, 40)) * px, 0, .25, rnd(5, 7) * px, rnd(18, 28) * px, rnd(.9, 1.4), .36, 0, 2.4, 22 * px)
  }
      if (P[o] + DX * P[o + 2] > p.W - p.ox + C.shot.w || P[o + 1] + DY * P[o + 2] < -p.floor) { scripts.delete(i); L.state[i] = FREE }
    } else if (s.stage === 21) {
      // In the air; that side's laser follows it, and where the toss ends it fires.
      const T = p.phone ? .42 : .72, u = clamp(s.t / T), at = m.turrets[s.lane]
      P[o] = s.x0 + (s.ax - s.x0) * u; P[o + 1] = p.phone ? s.y0 + (s.ay - s.y0) * (1 - (1 - u) ** 2) : s.y0 + (s.ay - s.y0) * u + 4 * s.az * u * (1 - u)
      setQuat(i, 0, 0, 1, s.turn * s.t * 7)
      turretAim[s.lane] = Math.atan2(P[o + 1] - at[1], P[o] - at[0]); aimHold[s.lane] = .3
      if (u >= 1) { loose(i, (s.ax - s.x0) / T, p.phone ? 0 : (s.ay - s.y0 - 4 * s.az) / T, 0, 0); L.ang[i * 3 + 2] = s.turn * 7; fire(i) }
    }
  }

  // ── Rigid bodies ──
  const R = new Float32Array(9), tmp = new Float32Array(3)
  function matrix(q: Float32Array, o: number) {
    const x = q[o], y = q[o + 1], z = q[o + 2], w = q[o + 3]
    R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y - z * w); R[2] = 2 * (x * z + y * w)
    R[3] = 2 * (x * y + z * w); R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z - x * w)
    R[6] = 2 * (x * z - y * w); R[7] = 2 * (y * z + x * w); R[8] = 1 - 2 * (x * x + y * y)
  }
  // Inverse inertia (a unit mass, a box of the body's half sizes) times a world vector.
  function invInertia(x: number, y: number, z: number, ix: number, iy: number, iz: number) {
    const lx = (R[0] * x + R[3] * y + R[6] * z) * ix, ly = (R[1] * x + R[4] * y + R[7] * z) * iy, lz = (R[2] * x + R[5] * y + R[8] * z) * iz
    tmp[0] = R[0] * lx + R[1] * ly + R[2] * lz; tmp[1] = R[3] * lx + R[4] * ly + R[5] * lz; tmp[2] = R[6] * lx + R[7] * ly + R[8] * lz
  }
  function step(B: Bodies, i: number, dt: number) {
    const o = i * 3, q = i * 4, { pos, vel, ang, quat, half } = B, pts = B.thin ? THIN : BOX
    const hx = half[o], hy = half[o + 1], hz = Math.max(half[o + 2], B.thin ? 2.2 : 1.5)
    const ix = 3 / (hy * hy + hz * hz), iy = 3 / (hx * hx + hz * hz), iz = 3 / (hx * hx + hy * hy)
    vel[o + 1] -= G * dt
    matrix(quat, q)
    if (B.thin) {
      // Paper: the air resists a letter moving face on far more than edge on.
      const nx = R[2], ny = R[5], nz = R[8], vn = vel[o] * nx + vel[o + 1] * ny + vel[o + 2] * nz, k = Math.min(1, .7 * dt) * vn
      vel[o] -= nx * k; vel[o + 1] -= ny * k; vel[o + 2] -= nz * k
      const d = 1 - .22 * dt, da = 1 - .9 * dt
      vel[o] *= d; vel[o + 1] *= d; vel[o + 2] *= d; ang[o] *= da; ang[o + 1] *= da; ang[o + 2] *= da
    }
    pos[o] += vel[o] * dt; pos[o + 1] += vel[o + 1] * dt; pos[o + 2] += vel[o + 2] * dt
    const wx = ang[o], wy = ang[o + 1], wz = ang[o + 2], qx = quat[q], qy = quat[q + 1], qz = quat[q + 2], qw = quat[q + 3], h = dt / 2
    let nqx = qx + h * (wx * qw + wy * qz - wz * qy), nqy = qy + h * (wy * qw + wz * qx - wx * qz), nqz = qz + h * (wz * qw + wx * qy - wy * qx), nqw = qw - h * (wx * qx + wy * qy + wz * qz)
    const nl = 1 / Math.hypot(nqx, nqy, nqz, nqw); quat[q] = nqx *= nl; quat[q + 1] = nqy *= nl; quat[q + 2] = nqz *= nl; quat[q + 3] = nqw *= nl
    matrix(quat, q)
    const rad = B.thin ? .8 : 0
    let touching = 0, cx = 0, cy = 0, cz = 0, ledge = 0
    for (let k = 0; k < pts.length; k += 3) {
      const lx = pts[k] * hx, ly = pts[k + 1] * hy, lz = pts[k + 2] * half[o + 2]
      const rx = R[0] * lx + R[1] * ly + R[2] * lz, ry = R[3] * lx + R[4] * ly + R[5] * lz, rz = R[6] * lx + R[7] * ly + R[8] * lz
      const x = pos[o] + rx, y = pos[o + 1] + ry, z = pos[o + 2] + rz
      let nx = 0, ny = 1, nz = 0, pen = 0
      let inside = null
      for (let b = 0; b < solids.length; b++) { const box = solids[b]; if (x > box.x0 && x < box.x1 && z > box.z0 && z < box.z1 && y < box.y && y > box.y0) { inside = box; break } }
      if (inside) {
        // Inside a solid's walls: out through the nearest one (or, where it hangs in the air, its top or its underside).
        const front = z - inside.z0, back = inside.z1 - z, left = x - inside.x0, right = inside.x1 - x, top = inside.y0 > -Infinity ? inside.y - y : Infinity, under = y - inside.y0, least = Math.min(front, back, left, right, top, under)
        ny = 0; pen = least
        if (least === top) { ny = 1; ledge = inside.side } else if (least === under) ny = -1; else if (least === front) nz = -1; else if (least === left) nx = -1; else if (least === right) nx = 1; else nz = 1
      } else if (B.thin && z < 0 && z > -40 * px && x > -p.Xc - 8 && x < p.Xc + 8 && y < 40 * px) {
        // A kick plate that isn't drawn: nothing comes to rest against the foot of the front, where the page's small print is.
        ny = .743; nz = -.669; pen = rad - (y * ny + (z + 40 * px) * nz)
      } else { const c = cell(x, z); pen = (c < 0 ? VOID : heights[c]) + rad - y }
      if (pen <= 0) continue
      touching++
      const vx = vel[o] + ang[o + 1] * rz - ang[o + 2] * ry, vy = vel[o + 1] + ang[o + 2] * rx - ang[o] * rz, vz = vel[o + 2] + ang[o] * ry - ang[o + 1] * rx
      const vn = vx * nx + vy * ny + vz * nz
      if (vn < 0) {
        // An impulse along the normal that stops the point (and bounces it a little if it came in fast), then friction.
        const ax = ry * nz - rz * ny, ay = rz * nx - rx * nz, az = rx * ny - ry * nx
        invInertia(ax, ay, az, ix, iy, iz)
        const kn = 1 + (tmp[1] * rz - tmp[2] * ry) * nx + (tmp[2] * rx - tmp[0] * rz) * ny + (tmp[0] * ry - tmp[1] * rx) * nz
        const j = -(1 + (vn < -90 * px ? .28 : 0)) * vn / kn
        if (!B.thin && ny > .5 && vn < -260 * px && hx + hy > 16 * px) dust(x, y, z)
        vel[o] += j * nx; vel[o + 1] += j * ny; vel[o + 2] += j * nz; ang[o] += tmp[0] * j; ang[o + 1] += tmp[1] * j; ang[o + 2] += tmp[2] * j
        const tx = vx - vn * nx, ty = vy - vn * ny, tz = vz - vn * nz, tl = Math.hypot(tx, ty, tz)
        if (tl > 1e-3) {
          const ux = tx / tl, uy = ty / tl, uz = tz / tl, bx = ry * uz - rz * uy, by = rz * ux - rx * uz, bz = rx * uy - ry * ux
          invInertia(bx, by, bz, ix, iy, iz)
          const kt = 1 + (tmp[1] * rz - tmp[2] * ry) * ux + (tmp[2] * rx - tmp[0] * rz) * uy + (tmp[0] * ry - tmp[1] * rx) * uz
          const jt = Math.min(.55 * j, tl / kt)
          vel[o] -= jt * ux; vel[o + 1] -= jt * uy; vel[o + 2] -= jt * uz; ang[o] -= tmp[0] * jt; ang[o + 1] -= tmp[1] * jt; ang[o + 2] -= tmp[2] * jt
        }
      }
      const push = Math.min(pen, 6) * .5; cx += nx * push; cy += ny * push; cz += nz * push
    }
    // Nothing rests on the roof's front edge, where it would hang over the readout and the gauge, nor against a
    // laser, which it would lie through: it is carried off.
    if (touching && pos[o + 1] > p.yTop - 2 && Math.abs(pos[o]) < p.Xc && pos[o + 2] > -2 && pos[o + 2] < p.D) {
      const reach = Math.hypot(hx, hy)
      if (pos[o + 2] < reach + 2 * px) { vel[o + 2] = Math.min(vel[o + 2], -190 * px); touching = 0; pos[o + 1] += cy }
    }
    // Nor on top of what hangs on the tower's sides (a unit, a magazine): it slides off, away from the tower.
    if (touching && ledge) { vel[o] = ledge * 170 * px; vel[o + 2] = Math.min(vel[o + 2], -40 * px); touching = 0; pos[o + 1] += cy }
    // Nor up against the cabinet's front, where it would stand over what is written on the base: it is moved forward.
    if (touching && pos[o + 1] < p.base && Math.abs(pos[o]) < p.Xc + hx && pos[o + 2] < 0 && pos[o + 2] > -(Math.hypot(hx, hy) + 10 * px)) { vel[o + 2] = Math.min(vel[o + 2], -150 * px); touching = 0; pos[o + 1] += cy }
    // Nor half off the side of the page, cut by its edge: it is moved in. (The page's edges as the plan has them: a
    // phone's machine need not stand in its middle.)
    if (touching) { const sx = pos[o] + DX * pos[o + 2], reach = Math.hypot(hx, hy), side = sx < (p.W / 2 - p.ox) ? -1 : 1, edge = side < 0 ? -p.ox : p.W - p.ox; if (side * (sx - edge) > -reach - 2 * px && side * (sx - edge) < reach) { vel[o] = -side * 150 * px; touching = 0; pos[o + 1] += cy } }
    // Nor on the slab's front edge, where it would hang over the lip: it is moved back on to the slab. (Nothing goes
    // over the lip into the page below, to be cut off where the canvas ends.)
    if (touching && pos[o + 1] < p.lh && pos[o + 1] > -2 && pos[o + 2] < p.zLip + 22 * px + Math.hypot(hx, hy) * .8) { vel[o + 2] = Math.max(vel[o + 2], 170 * px); touching = 0; pos[o + 1] += cy }
    // (And what comes at the lip low, sliding or skimming, is turned back by it, as by a kerb.)
    if (pos[o + 2] < p.zLip + Math.hypot(hx, hy) * .5 && pos[o + 1] < 26 * px && pos[o + 1] > -2 && vel[o + 2] < 0) { vel[o + 2] *= -.3; pos[o + 2] = p.zLip + Math.hypot(hx, hy) * .5 }
    if (touching) for (const zone of keepClear) if (pos[o + 1] > zone.y - 2 && pos[o + 1] < zone.y + 70 * px) { const dx = pos[o] - zone.x, dz = pos[o + 2] - zone.z, d = Math.hypot(dx, dz); if (d < Math.hypot(hx, hy) + zone.r) { const k = 170 * px / (d || 1); vel[o] = dx * k || 170 * px; vel[o + 2] = dz * k; touching = 0; pos[o + 1] += cy; break } }
    if (touching) {
      pos[o] += cx / touching; pos[o + 1] += cy / touching; pos[o + 2] += cz / touching
      const slow = Math.hypot(vel[o], vel[o + 1], vel[o + 2]) < 26 * px && Math.hypot(ang[o], ang[o + 1], ang[o + 2]) < 1.1
      B.still[i] = slow ? B.still[i] + dt : 0
      if (slow && B.thin && tilt[i] < 1.6) { matrix(quat, i * 4); const ny = R[5]; if (Math.abs(ny) < .985) { const side = ny < 0 ? -1 : 1, k = 30 * dt; tilt[i] += dt; ang[o] -= R[8] * side * k; ang[o + 2] += R[2] * side * k; B.still[i] = 0 } }
      if (slow) { const d = 1 - 6 * dt; vel[o] *= d; vel[o + 2] *= d; ang[o] *= d; ang[o + 1] *= d; ang[o + 2] *= d }
      if (B.still[i] > .3) sleep(B, i)
    } else B.still[i] = 0
    if (pos[o + 1] + DY * pos[o + 2] < -(p.floor + p.ext + 60)) B.state[i] = B.thin ? FREE : ASLEEP
  }
  function sleep(B: Bodies, i: number) {
    const o = i * 3
    B.state[i] = ASLEEP; B.still[i] = 0; B.vel.fill(0, o, o + 3); B.ang.fill(0, o, o + 3)
    if (!B.thin) return
    // The floor under a sleeping letter is now that letter: the next one rests on it. (One that could not be laid flat,
    // on its edge or propped up, dwindles away where it stands.)
    matrix(B.quat, i * 4)
    // (So does one that stops on a ledge half way up the machine: a riser's top, a block, a bracket.)
    // And one that has stopped half off the side of the page.
    const sx = B.pos[o] + DX * B.pos[o + 2], reach = Math.hypot(B.half[o], B.half[o + 1]), off = Math.min(Math.abs(sx + p.ox), Math.abs(sx - p.W + p.ox))
    if (Math.abs(R[5]) < .8 || (B.pos[o + 1] > (p.heads.length ? p.heads[0].h : 0) + 46 * px && B.pos[o + 1] < p.yTop - 6) || off < reach) { fading.push(i); return }
    // (One that lies all but flat is laid flat, its face as it was, turned as it was, on whatever is under it.)
    if (Math.abs(R[5]) > .984) {
      const up = R[5] > 0 ? -1 : 1, yaw = Math.atan2(R[6], R[0]), qy = Math.sin(-yaw / 2), qw = Math.cos(-yaw / 2), fx = up * Math.SQRT1_2, fw = Math.SQRT1_2, q = i * 4
      B.quat[q] = qw * fx; B.quat[q + 1] = qy * fw; B.quat[q + 2] = -qy * fx; B.quat[q + 3] = qw * fw
      matrix(B.quat, q)
      let floor = -Infinity
      for (let a = -1; a <= 1; a += .5) for (let b = -1; b <= 1; b += .5) { const lx = a * B.half[o], ly = b * B.half[o + 1], c = cell(B.pos[o] + R[0] * lx + R[1] * ly, B.pos[o + 2] + R[6] * lx + R[7] * ly); if (c >= 0 && heights[c] > floor && heights[c] < B.pos[o + 1] + 4) floor = heights[c] }
      if (floor > VOID) B.pos[o + 1] = floor + .8
    }
    for (let a = -1; a <= 1; a += .4) for (let b = -1; b <= 1; b += .5) {
      const lx = a * B.half[o], ly = b * B.half[o + 1], c = cell(B.pos[o] + R[0] * lx + R[1] * ly, B.pos[o + 2] + R[6] * lx + R[7] * ly), y = B.pos[o + 1] + R[3] * lx + R[4] * ly + 1.5
      if (c >= 0 && heights[c] > VOID && y > heights[c] && y < heights[c] + 30) heights[c] = y
    }
  }
  function wake(i: number) { if (L.state[i] === ASLEEP) { L.state[i] = DYN; L.still[i] = 0 } }

  // ── Effects ──
  // (One is taken from those that have gone out, and made only when there are none: a frame makes nothing.)
  const spent: Fx[] = []
  function add(x: number, y: number, z: number, vx: number, vy: number, vz: number, max: number, size: number, len: number, rot: number, c: number[], shape: number, gravity = 0, drag = 0, glow = false) {
    if (fx.length > 620) return
    const f = spent.pop() ?? { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, size: 4, grow: 0, rot: 0, spin: 0, r: 1, g: 1, b: 1, a: 1, shape: 0, gravity: 0, drag: 0, glow: false, len: 0 }
    f.x = x; f.y = y; f.z = z; f.vx = vx; f.vy = vy; f.vz = vz; f.life = 0; f.max = max; f.size = size; f.grow = 0; f.rot = rot; f.spin = 0; f.r = c[0]; f.g = c[1]; f.b = c[2]; f.a = 1; f.shape = shape; f.gravity = gravity; f.drag = drag; f.glow = glow; f.len = len
    fx.push(f)
  }
  // Steam and smoke. A billow is thrown with a velocity, slows in the air, rises by its own heat, swells and thins;
  // the renderer gives it its body (gl.ts). When the air holds all it may, the oldest gives way.
  function emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, kind: number, size0: number, grow: number, life: number, dens: number, heat = 0, drag = 1.4, lift = 34 * px) {
    const i = S.head++ % SM
    S.pos[i * 3] = x; S.pos[i * 3 + 1] = y; S.pos[i * 3 + 2] = z; S.vel[i * 3] = vx; S.vel[i * 3 + 1] = vy; S.vel[i * 3 + 2] = vz
    S.age[i] = 0; S.life[i] = life; S.size[i] = size0; S.grow[i] = grow; S.rot[i] = rnd(0, 6.28); S.spin[i] = rnd(-.5, .5); S.seed[i] = Math.random(); S.dens[i] = dens; S.kind[i] = kind; S.heat[i] = heat; S.drag[i] = drag; S.lift[i] = lift
  }
  /** Room in the air for more: what is only atmosphere waits its turn. */
  const room = () => S.live < LEVELS[quality].puffs
  /** Steam let out under pressure: fast and narrow at the nozzle, slowing and swelling into a cloud. */
  function jet(x: number, y: number, z: number, dx: number, dy: number, power: number, n = 1, wide = 1, smoke = 0) {
    if (room()) for (let k = 0; k < n; k++) { const v = rnd(.55, 1) * power * px, a = rnd(-.16, .16), c = Math.cos(a), sn = Math.sin(a); emit(x, y, z, (dx * c - dy * sn) * v, (dx * sn + dy * c) * v, rnd(-12, 12) * px, smoke, rnd(3.6, 5) * wide * px, rnd(26, 38) * wide * px, rnd(.7, 1.1), .46, 0, 3.2, 26 * px) }
  }
  /** What rises by itself from something hot: `kind` 0 steam, 1 smoke. */
  function wisp(x: number, y: number, z: number, kind: number, size = 4, dens = .42) { if (room()) emit(x + rnd(-1, 1) * size * px, y, z, rnd(-8, 8) * px, rnd(22, 46) * px, 0, kind, Math.max(5, rnd(.9, 1.3) * size) * px, rnd(12, 20) * px, rnd(1.2, 2), dens, 0, .8, 18 * px) }
  /** Dust knocked up where something heavy lands. */
  function dust(x: number, y: number, z: number) { if (room()) for (let k = 0; k < 2; k++) emit(x, y + 2 * px, z, rnd(-70, 70) * px, rnd(8, 36) * px, rnd(-20, 20) * px, .6, rnd(2.5, 4) * px, rnd(18, 26) * px, rnd(.6, 1), .3, 0, 3.2, 6 * px) }
  function sparks(x: number, y: number, z: number, n: number, power = 240, c = colour.spark) {
    for (let i = 0; i < n; i++) { const a = rnd(0, Math.PI * 2), s = rnd(.3, 1) * power * px; add(x, y, z - 2, Math.cos(a) * s, Math.sin(a) * s + power * .3 * px, rnd(-40, 40), rnd(.25, .6), 1.1 * px, rnd(3, 7) * px, 0, c, 1, 1, 1.5) }
  }
  // The laser on the letter's side of the page turns to it and holds a beam on it for a quarter of a second (two flat
  // bars, red and a paler core, redrawn each frame from the muzzle to wherever the letter now is); the letter burns.
  function fire(i: number) {
    if (L.state[i] === FREE || burning[i]) return
    const o = i * 3, k = L.pos[o] + DX * L.pos[o + 2] >= 0 ? 1 : 0
    beams.push({ id: i, k, until: time + .3 }); cue('laser', pan(m.turrets[k][0], m.turrets[k][2]))
    sparks(L.pos[o], L.pos[o + 1], L.pos[o + 2], 7, 200, colour.ember)
    burning[i] = 1; wake(i)
    if (L.state[i] === SCRIPT) loose(i, 0, 0, 0, 1)
    L.vel[o] *= .25; L.vel[o + 1] = L.vel[o + 1] * .2 + 70 * px; L.vel[o + 2] *= .25
  }
  function beam(b: { id: number; k: number; until: number }) {
    const i = b.id, o = i * 3, from = m.turrets[b.k], tx = L.pos[o], ty = L.pos[o + 1], tz = L.pos[o + 2]
    const sx = tx - from[0] + DX * (tz - from[2]), sy = ty - from[1] + DY * (tz - from[2]), angle = Math.atan2(sy, sx), tip = 22 * px
    turretAim[b.k] = turretAngle[b.k] = angle; aimHold[b.k] = .5
    const bx = from[0] + Math.cos(angle) * tip, by = from[1] + Math.sin(angle) * tip, length = Math.hypot(sx, sy) - tip, thin = Math.min(1, (b.until - time) / .09)
    // Drawn in the laser's own plane of depth, towards the page: a beam is never behind what it crosses.
    const mx = (bx + tx + DX * (tz - from[2])) / 2, my = (by + ty + DY * (tz - from[2])) / 2
    add(mx, my, from[2], 0, 0, 0, .02, length / 2, 2.3 * thin, angle, colour.red, 4)
    add(mx, my, from[2] - 1, 0, 0, 0, .02, length / 2, 1.05 * thin, angle, colour.spark, 4)
    if (Math.random() < .3) sparks(tx, ty, tz, 1, 160, colour.ember)
  }
  /** The tube a lane's mail leaves by (plan.ts has the eight in their own order: inbox, agents, endpoints, threads; IMAP, rules, campaigns, logs). */
  const tubeOf = (lane: number) => [3, 2, 1, 0, 4, 5, 6][p.routes[lane]]
  function launch(tube: number) {
    if (tube >= p.tubes.length) return
    const cap = caps.find(c => !c.on)
    if (cap) { cap.on = true; cap.tube = tube; cap.run = 0; cap.s = 0; cap.wait = 0; if (ears - tubeAt >= .2) { tubeAt = ears; cue('tube', pan(p.tubes[tube], p.zt)) } }
  }

  // ── The send cannon ──
  /** A capsule sets off for the breech: from down the page, or (in a hurry) from just under the gun. */
  function capsuleOut(quick: boolean) {
    const cap = caps.find(c => !c.on)
    if (cap) { cap.on = true; cap.tube = p.tubes.length; cap.run = quick ? m.lines[p.tubes.length].length - 1 : 0; cap.s = 0; cap.wait = 0 } else cannonFire()
  }
  /** What reached the breech goes: a letter along the bore and off the page, the barrel back in its cradle, smoke at the muzzle. */
  function cannonFire() {
    if (reduced) return
    const c = m.cannon, C = p.cannon, i = alloc(), mx = c.pivot[0] + C.fore * c.ce, my = c.pivot[1] + C.fore * c.se, range = p.W - p.ox + C.shot.w * 1.2 - (mx + DX * c.pivot[2])
    for (let tries = 0; tries < 60; tries++) { nextLetter(i); if (!pool[data[i]].scam) break }
    place(i, c.pivot[0], c.pivot[1], c.pivot[2]); L.state[i] = SCRIPT; scale[i] = .8; kind[i] = 0
    // Its arc: off along the bore, and by the page's edge a little below where it left.
    scripts.set(i, { stage: 31, t: 0, lane: 8, x0: 0, y0: C.fore - C.shot.w * .52, ax: 0, ay: 0, az: (p.phone ? 560 : 780) * px, turn: 0, data: data[i], x: (c.se / c.ce + .1) / Math.max(60, range) })
    recoil = 1; cue('cannon', pan(c.pivot[0], c.pivot[2]))
  }

  // ── The burst ──
  function boom() {
    if (!built) fitAll()
    hatchHang = 1; hatchV = 14
    // (Nothing comes to rest over the hole in the roof, or through the flaps round it.)
    keepClear.length = base; keepClear.push({ x: m.hole.x, z: m.hole.z, y: p.yTop, r: m.hole.r }, ...(hatchBody < 0 ? [] : [{ x: m.hatchHinge[0], z: m.hatchHinge[2] - 4 * px, y: p.yTop, r: p.Xw * .14 }]))
    setPhase('boom'); cue('burst'); paperDue = true; flash = 1; needleV = -9; bend = 1; boomAt = time; smokeLeft = 5.6; volley = 3; volleyIn = .1; leaks.length = 0; ventFor[0] = ventFor[1] = 0
    const cx = 0, cy = (p.yCav + p.yFas) / 2
    resetHeights()
    // Light, as an effect and only here: a hot core for two frames. The page behind is never lightened.
    add(cx, cy, -10, 0, 0, 0, .075, 88 * px, 0, 0, colour.spark, 2, 0, 0, true)
    // Every letter in the works, and the hundreds the machine had swallowed, out through the front and the roof.
    for (const [i, s] of scripts) if (s.stage < 30) { L.pos[i * 3 + 2] = -6 * px; if (L.pos[i * 3 + 1] > p.yFas) L.pos[i * 3 + 1] = p.yTop + p.lh }
    // Each is thrown at a place: most onto the slab (heaped by the machine's sides, thinning out towards the slab's
    // ends, a strip along the front), some clean off it into the dark. Thrown a little long, for the air.
    const seen = Math.min(p.slabX - 24, p.W / 2 + 20), zA = p.zLip + 16 * px, zB = p.zBack - 16 * px
    const want = Math.round((p.phone ? 170 : 300) * LEVELS[quality].mail), launchOne = (i: number, roof: boolean) => {
      // (A scam is never thrown down in front of the cabinet: a laser's beam to it there would cross the page's words.)
      const o = i * 3, pick = Math.random(), where = kind[i] && pick >= .26 && pick < .44 ? .6 : kind[i] && pick >= .8 && pick < .9 ? .5 : pick, side = Math.random() < .5 ? -1 : 1
      if (roof && Math.random() < .24) return loose(i, rnd(-1, 1) * 190 * px, rnd(260, 620) * px, rnd(-40, 190) * px, 9)
      let tx: number, tz: number
      if (where < .26) { tx = side * (p.Xc + 14 * px + rnd(0, 1) ** 1.8 * 150 * px); tz = rnd(-30 * px, p.D * .95) }
      else if (where < .44) { tx = rnd(-1, 1) * (p.Xc + 50 * px); tz = rnd(zA + 22 * px, -48 * px) }
      else if (where < .8) { tx = side * rnd(Math.min(p.Xc + 30 * px, seen), seen); tz = zA + (zB - zA) * rnd(0, 1) ** 1.25 }
      else if (where < .9) { tx = rnd(-1, 1) * seen; tz = zA + rnd(0, 40) * px }
      else { tx = side * (seen + rnd(40, 320)); tz = rnd(zA, zB + 200) }
      const T = rnd(.75, 1.3), k = .46, far = k / (1 - Math.exp(-k * T))
      loose(i, (tx - L.pos[o]) * far, G * T / 2 * 1.06 - L.pos[o + 1] / T, (tz - L.pos[o + 2]) * far, 10)
    }
    for (const [i, s] of [...scripts]) if (s.stage < 30) launchOne(i, L.pos[i * 3 + 1] > p.yFas)
    let live = 0
    for (let i = 0; i < MAX; i++) if (L.state[i] !== FREE && scripts.get(i)?.stage !== 31) { live++; if (L.state[i] === ASLEEP) { wake(i); L.vel[i * 3] = rnd(-1, 1) * 380 * px; L.vel[i * 3 + 1] = rnd(300, 760) * px; L.vel[i * 3 + 2] = rnd(-160, 300) * px; L.ang[i * 3] = rnd(-8, 8); L.ang[i * 3 + 2] = rnd(-8, 8) } }
    for (; live < want; live++) {
      const i = alloc(), roof = Math.random() < .22; nextLetter(i)
      if (roof) place(i, rnd(-1, 1) * p.Xw * .7, p.yTop + rnd(4, 30) * px, rnd(.1, .9) * p.D)
      else place(i, rnd(-1, 1) * p.Xw * .9, rnd(p.yCav + p.lh, p.yFas - p.lh * .4), -rnd(3, 14) * px)
      setQuat(i, rnd(-1, 1), rnd(-1, 1), rnd(-1, 1), rnd(0, 6)); launchOne(i, roof)
    }
    scanning = -1; queue.length = 0; beams.length = 0; hooks.scan(null, 'jam')
    // The works come apart, each part with its own weight: the hopper and the chimneys go up off the roof and
    // come down on the slab; the hatch skims away; the glass leaves in panes; rollers, gates and bolts spray forward.
    debrisPart.forEach((index, i) => {
      const home = debrisHome[i], o = i * 3, roof = index === m.idx.hopper || index === m.idx.hatch || m.idx.vents.includes(index), pane = m.idx.panes.includes(index)
      // (What the pressure had already thrown off, a bolt or the service panel, lies where it fell.)
      if (Dn.state[i] !== FREE || index === m.idx.hatch) return
      Dn.state[i] = DYN; Dn.still[i] = 0; Dn.pos.set(home, o); Dn.quat.set([0, 0, 0, 1], i * 4); parts[index].on = true
      if (i === hatchBody) { const c = Math.cos(hatch), sn = Math.sin(hatch), y = home[1] - m.hatchHinge[1], z = home[2] - m.hatchHinge[2]; Dn.pos[o + 1] = m.hatchHinge[1] + y * c - z * sn; Dn.pos[o + 2] = m.hatchHinge[2] + y * sn + z * c; Dn.quat.set([Math.sin(hatch / 2), 0, 0, Math.cos(hatch / 2)], i * 4) }
      if (roof) { const side = home[0] === 0 ? (Math.random() < .5 ? -1 : 1) : Math.sign(home[0]); Dn.vel[o] = side * rnd(160, 420) * px; Dn.vel[o + 1] = rnd(620, 900) * px; Dn.vel[o + 2] = -rnd(60, 260) * px - home[2] * .9 }
      else { Dn.pos[o + 2] = -5 * px; Dn.vel[o] = (home[0] / p.Xw + rnd(-.5, .5)) * (pane ? 380 : 600) * px; Dn.vel[o + 1] = rnd(120, pane ? 520 : 740) * px; Dn.vel[o + 2] = -rnd(160, pane ? 420 : 600) * px
        // (Thrown no further forward than it comes down on the slab: it lands short of the lip.)
        const vy = Dn.vel[o + 1], fall = (vy + Math.sqrt(vy * vy + 2 * G * home[1])) / G; Dn.vel[o + 2] = Math.max(Dn.vel[o + 2], (p.zLip + 40 * px + 5 * px) / fall) }
      const spin = roof ? 5 : pane ? 6 : 12
      Dn.ang[o] = rnd(-spin, spin); Dn.ang[o + 1] = rnd(-spin, spin); Dn.ang[o + 2] = rnd(-spin, spin)
    })
    for (const index of m.idx.cracks) parts[index].on = false
    parts[m.idx.glass].on = false; parts[m.idx.scan].on = false; parts[m.idx.soot].on = parts[m.idx.shards].on = parts[m.idx.hole].on = true
    for (const index of m.idx.caps) parts[index].on = false
    for (const cap of caps) cap.on = false
    sparks(cx, cy, -8, 70, 760); sparks(0, p.yTop, p.zL, 30, 600)
    // The plume: dense smoke thrown out of the bay and up through the roof, lit from under by the fire for a moment,
    // then rising, drifting and thinning for a few seconds. A third of it is steam.
    const billows = Math.round(LEVELS[quality].puffs * .44)
    for (let i = 0; i < billows; i++) {
      const roof = i % 3 === 0, a = rnd(0, Math.PI * 2), far = Math.sqrt(Math.random()), out = rnd(110, 430) * px
      emit(roof ? rnd(-1, 1) * p.lw : Math.cos(a) * p.Xw * .8 * far, roof ? p.yTop + rnd(0, 12) * px : cy + Math.sin(a) * p.cavity * .4 * far, roof ? p.zL : -10 * px,
        Math.cos(a) * out * (roof ? .45 : 1), Math.abs(Math.sin(a)) * out * .45 + rnd(60, 230) * px, -rnd(0, 60) * px, i % 3 === 1 ? .3 : 1, rnd(9, 17) * px, rnd(22, 40) * px, rnd(2.4, 4.6), rnd(.72, .92), 1, 2.6, (roof ? 150 : 70) * px)
    }
  }

  // Back together: the letters are drawn up into the hopper, the parts fly home, the gauge falls to zero.
  function rebuild() {
    if (phase !== 'rest' && phase !== 'boom') return
    setPhase('rebuild'); hooks.scan(null, 'idle'); paperDue = false
    if (!reduced) hooks.sound?.('rebuild')
    for (let i = 0; i < MAX; i++) if (L.state[i] !== FREE) {
      const o = i * 3, d = Math.hypot(L.pos[o], L.pos[o + 2])
      L.state[i] = HOME; scripts.delete(i); delay[i] = .05 + d * .00075 / px + rnd(0, .3); from.set([L.pos[o], L.pos[o + 1], L.pos[o + 2], L.quat[i * 4], L.quat[i * 4 + 1], L.quat[i * 4 + 2], L.quat[i * 4 + 3]], i * 7); L.still[i] = 0
    }
    // (Only what was blown off flies home: the hatch hangs on its hinge and swings back down by itself.)
    debrisPart.forEach((index, i) => { if (Dn.state[i] === FREE) return; Dn.state[i] = HOME; Dn.still[i] = -(i >= paneBody && i < paneBody + m.idx.panes.length ? .25 + (i - paneBody) * .05 : i >= boltBody ? 1.1 + (i - boltBody) * .03 : index === m.idx.hopper || m.idx.vents.includes(index) ? 1.5 + i * .05 : index === m.idx.panel ? 1.2 : .6 + i * .006) * 1.1; for (let k = 0; k < 3; k++) away0[i * 3 + k] = Dn.pos[i * 3 + k]; const sg = Dn.quat[i * 4 + 3] < 0 ? -1 : 1; for (let k = 0; k < 4; k++) away0[Dn.cap * 3 + i * 4 + k] = sg * Dn.quat[i * 4 + k] })
    for (let i = 0; i < SM; i++) if (S.age[i] < S.life[i]) S.life[i] = Math.min(S.life[i], S.age[i] + rnd(.3, .8))
    calm(); resetHeights(true); pointer.held = -1; setHover(-1); volley = 0; sendIn = 2.4; keepClear.length = base
  }

  function setPhase(next: Phase) { phase = next; clock = 0; hooks.phase(next) }

  // Strain, shown by the mechanism and nowhere else: nothing shakes. The needle climbs, trembles, and dips each time a
  // relief valve lifts; the valves' levers chatter, then lift and blow steam, oftener as the pressure rises; the
  // chimneys steam; the roof hatch rattles on its hinge; bolts work loose and leak; the scanner spits sparks. In the
  // last second the glass cracks, the service panel is blown off its screws, both valves blow without stopping and
  // the hatch stands open.
  function strain(dt: number) {
    const hot = Math.min(1, heat), over = phase === 'overload' && built, rate = Math.sqrt(LEVELS[quality].puffs / 240)
    const tremble = (.003 + .015 * hot * hot) * (Math.sin(time * 31) + .6 * Math.sin(time * 53.3 + 1)) + (over ? Math.sin(time * 87) * .012 : 0)
    needleV += ((Math.min(1.04, hot * .84 + (over ? .12 + clock * .05 : 0)) + tremble - needle) * 60 - needleV * 9) * dt; needle += needleV * dt
    parts[m.idx.lamps[0]].on = hot > .45 && Math.sin(time * (8 + hot * 22)) > 0
    parts[m.idx.beaconOn].on = hot > .8 && Math.sin(time * 26) > 0
    jetIn[2] -= dt * Math.max(0, hot - .22) * (over ? 22 : 12) * rate
    // (From the chimneys; on a roof that has none, from its back seam.)
    while (jetIn[2] < 0) { jetIn[2] += 1; const v = m.vents.length ? m.vents[Math.random() < .5 ? 0 : 1] : put(AT, (Math.random() < .5 ? -1 : 1) * p.Xw * rnd(.3, .7), p.yTop + 2 * px, p.D * .92); wisp(v[0], v[1], v[2], hot > .9 ? .3 : 0, 3 + hot * 2.5, .34 + hot * .16) }
    for (let k = 0; k < m.valves.length; k++) {
      const v = m.valves[k], was = ventFor[k] > 0
      if (over && clock > T.over * .28) ventFor[k] = 1
      if (ventFor[k] > 0) ventFor[k] -= dt
      else if (hot > .4) { ventIn[k] -= dt; if (ventIn[k] <= 0) { ventFor[k] = rnd(.3, .5) + hot * .45; ventIn[k] = rnd(.75, 1.25) * (3 - 2.5 * hot); needleV -= .9 } }
      const open = ventFor[k] > 0
      if (open && !was && ears - steamAt >= 1 / 3) { steamAt = ears; cue('steam', pan(v.x, v.nozzle[2])) }
      lever[k] += ((open ? .5 + Math.sin(time * 61 + k * 2) * .07 : hot > .3 ? Math.max(0, Math.sin(time * (29 + k * 7))) * .09 * hot : 0) - lever[k]) * Math.min(1, dt * 34)
      if (open) { jetIn[k] -= dt * 62 * rate; while (jetIn[k] < 0) { jetIn[k] += 1; jet(v.nozzle[0], v.nozzle[1], v.nozzle[2], v.side * .2, .98, 230 + hot * 130, 1, p.phone ? .8 : 1.15) } }
    }
    if (over && clock > T.over * .45) hatchV += ((1.05 - hatch) * 130 - hatchV * 9) * dt
    else { if (hatch < .01 && hot > .5 && Math.random() < dt * (hot - .45) * 7) hatchV = rnd(1.6, 3.6); hatchV -= 30 * dt }
    hatch += hatchV * dt
    if (hatch < 0) { hatch = 0; hatchV = hatchV < -1 ? -hatchV * .32 : 0 }
    if (hatch > .06 && hatchBody >= 0) { jetIn[3] -= dt * 18 * rate * Math.min(1, hatch * 3); while (jetIn[3] < 0) { jetIn[3] += 1; wisp(m.hatchHinge[0] + rnd(-1, 1) * p.Xw * .12, p.yTop + 2 * px, m.hatchHinge[2] - p.D * .2, 0, 3.4, .36) } }
    sparkIn -= dt * Math.max(0, hot - .66) * 26
    while (sparkIn < 0) { sparkIn += 1; const lane = Math.floor(rnd(0, p.lanes.length)); sparks(p.lanes[lane] + rnd(-1, 1) * p.P * .3, m.yR, -2, 3, 130) }
    popIn -= dt * (over ? 7 : Math.max(0, hot - .74) * 2.6)
    if (popIn <= 0) {
      popIn = 1
      const i = Math.floor(rnd(0, m.idx.bolts.length)), k = boltBody + i
      if (Dn.state[k] === FREE) { const home = debrisHome[k]; Dn.state[k] = DYN; Dn.pos.set(home, k * 3); Dn.quat.set([0, 0, 0, 1], k * 4); Dn.vel.set([rnd(-1, 1) * 150 * px, rnd(160, 380) * px, -rnd(240, 520) * px], k * 3); Dn.ang.set([rnd(-20, 20), rnd(-20, 20), rnd(-20, 20)], k * 3); sparks(home[0], home[1], -4, 4, 160); if (leaks.length < 4) leaks.push([home[0], home[1], -3 * px]) }
    }
    if (over && !panelOff && clock > T.over * .55) {
      panelOff = true
      const k = panelBody, home = debrisHome[k], h = m.panel.y1 - m.panel.y0
      if (ears - steamAt >= 1 / 3) { steamAt = ears; cue('steam', pan(home[0])) }
      // (A phone's panel is a strip too narrow to read once it is off, only a dark slot beside the pipe: it holds,
      // and the steam blows out at its top and its foot instead.)
      if (p.phone) { sparks(home[0], home[1] + h / 2, -4, 5, 160); jet(home[0], home[1] + h / 2, -2 * px, .1, .9, 200, 3, 1.1); leaks.push([home[0], home[1] + h * .5, -1.6 * px], [home[0], home[1] - h * .5, -1.6 * px]) }
      else {
        Dn.state[k] = DYN; Dn.pos.set(home, k * 3); Dn.quat.set([0, 0, 0, 1], k * 4); Dn.vel.set([rnd(30, 120) * px, rnd(180, 300) * px, -rnd(380, 520) * px], k * 3); Dn.ang.set([rnd(4, 9), rnd(-5, 5), rnd(-6, 6)], k * 3)
        sparks(home[0], home[1], -4, 10, 220); jet(home[0], home[1], -4 * px, .1, .6, 260, 5, 1.4); leaks.push([home[0], home[1] - h * .2, -2 * px], [home[0], home[1] + h * .2, -2 * px])
      }
    }
    if (leaks.length) { jetIn[4] -= dt * 9 * rate * leaks.length; while (jetIn[4] < 0) { jetIn[4] += 1; const at = leaks[Math.floor(rnd(0, leaks.length))]; jet(at[0], at[1], at[2], rnd(-.35, .35), .94, 100, 1, .62) } }
  }
  // After the burst the wreck smokes for a while, less and less: out of the top of the works' bay, up through the hole
  // in the roof, a little steam from the tube that was torn from its socket.
  function smoulder(dt: number) {
    if (smokeLeft <= 0) return
    smokeLeft -= dt
    const u = clamp(smokeLeft / 5.6)
    jetIn[2] -= dt * (3 + 24 * u * u) * Math.sqrt(LEVELS[quality].puffs / 240)
    while (jetIn[2] < 0) {
      jetIn[2] += 1
      const r = Math.random()
      if (!room()) continue
      if (r < .5) emit(rnd(-1, 1) * p.Xw * .85, p.yFas - rnd(2, 12) * px, -6 * px, rnd(-12, 12) * px, rnd(30, 60) * px, 0, 1, rnd(7, 11) * px, rnd(12, 20) * px, rnd(2.4, 3.8), .34 + .3 * u, u * .25, .9, 34 * px)
      else if (r < .86) emit(rnd(-1, 1) * p.lw * .5, p.yTop + 2 * px, p.zL, rnd(-10, 10) * px, rnd(60, 120) * px, 0, 1, rnd(7, 12) * px, rnd(16, 24) * px, rnd(2.8, 4.4), .4 + .32 * u, u * .25, .9, 66 * px)
      else if (p.tubes.length) wisp(p.tubes[5], p.yMan - 4 * px, p.zt, 0, 3, .3)
    }
  }

  // ── A frame ──
  let scriptDt = 0, lidMoved = 0
  const runScript = (s: Script, i: number) => script(i, s, scriptDt, speed)
  function advance(dt: number) {
    time += dt; clock += dt
    if (phase === 'boot') { needle = Math.sin(clamp(clock / .7) * Math.PI) * .9; parts[m.idx.lamps[2]].on = clock > .15; parts[m.idx.lamps[1]].on = clock > .3; if (clock > .75) { setPhase('run'); runT = 0; needle = 0 } }
    const lidWas = shifts[10]; fitting(dt); lidMoved = shifts[10] - lidWas
    if (lampIn > 0) { lampIn -= dt; if (lampIn <= 0) parts[m.idx.lamps[1]].on = true }
    if (phase === 'run') {
      if (built) runT += dt
      const e = clamp((runT - T.calm) / T.ramp); heat = e ** 1.3
      if (e >= 1) setPhase('overload')
    }
    if (phase === 'overload') {
      // (Hurried to it mid-build, it strains while the build is finished, and its last seconds begin once it is whole.)
      if (!built) clock = 0
      heat = 1 + clock * .12
      // The glass gives twice before it goes; the gates chatter.
      for (let n = 0; n < m.idx.cracks.length; n++) { const index = m.idx.cracks[n], at = T.over * (.22 + n * .4); if (built && !parts[index].on && clock >= at) { parts[index].on = true; needleV += 1.4; sparks(m.crackAt[n][0], m.crackAt[n][1], -4, 12, 260, colour.steam) } }
      if (Math.random() < dt * 14) flapWant[Math.floor(rnd(0, p.lanes.length))] = Math.random() < .5 ? 1 : 0
      if (built && clock > T.over) boom()
    }
    const running = phase === 'run' || phase === 'overload'
    // The rollers quicken, the scanner more, but never as fast as the mail arrives: that is what backs up.
    speed = running ? 1 + 1.9 * Math.min(1, heat) ** 1.5 + (phase === 'overload' ? .4 : 0) : 1
    feed = running ? 1 + 4.4 * Math.min(1, heat) ** 1.2 : 1
    for (let i = 0; i < 7; i++) arrived[i] = Math.max(0, arrived[i] - dt * 1.6)
    if (running) {
      spawnIn -= dt
      // (While it is being fitted out it has little to do; each lane more brings it more mail.)
      if (spawnIn <= 0) { spawn(); spawnIn = !built ? 1.52 * (1.5 - .5 * fitNext / p.fit.length) : phase === 'overload' ? .05 : 1.45 * (1 - heat) ** 3.4 + .07 }
      strain(dt)
    } else {
      parts[m.idx.lamps[0]].on = phase === 'rest' || phase === 'boom'
      parts[m.idx.beaconOn].on = false
      if (phase === 'boom' || phase === 'rest') { needleV += ((-.38 - needle) * 26 - needleV * 2.2) * dt; needle += needleV * dt }
      for (let k = 0; k < 2; k++) lever[k] -= lever[k] * Math.min(1, dt * 9)
      smoulder(dt)
    }
    flash = Math.max(0, flash - dt * 4.2)
    // (The paper comes down half a second after the blast, as the machine's own slowed time has it.)
    if (paperDue && phase === 'boom' && time - boomAt >= .5) { paperDue = false; cue('paper') }
    for (let k = fading.length - 1; k >= 0; k--) { const i = fading[k]; scale[i] -= dt * 3.2; if (scale[i] <= 0 || L.state[i] !== ASLEEP) { if (L.state[i] === ASLEEP) L.state[i] = FREE; fading.splice(k, 1) } }
    if (!running) { hatchV += (((hatchHang ? 2.3 : 0) - hatch) * (hatchHang ? 46 : 90) - hatchV * (hatchHang ? 3.4 : 14)) * dt; hatch += hatchV * dt; if (hatch < 0) { hatch = 0; hatchV = 0 } if (Math.abs(hatchV) < .004 && Math.abs((hatchHang ? 2.3 : 0) - hatch) < .002) hatchV = 0 }
    // The cannon sends as the machine sorts, oftener as the pace climbs (a capsule comes up the outbound tube and
    // into the breech, and is fired off the page as a letter); as the machine bursts it gets off a last volley.
    if (running && sendOn) { sendIn -= dt; if (sendIn <= 0) { capsuleOut(false); sendIn = phase === 'overload' ? .34 : 3.2 - 2.4 * Math.min(1, heat) } }
    else if (volley > 0 && phase === 'boom') { volleyIn -= dt; if (volleyIn <= 0) { cannonFire(); volley--; volleyIn = .14 } }
    cool = Math.max(0, cool - dt); recoil += (0 - recoil) * Math.min(1, dt * 6.5); if (recoil < .004) recoil = 0

    scriptDt = dt; scripts.forEach(runScript)
    if (rainLeft > 0) { const n = Math.min(rainLeft, Math.ceil(dt * 140)); rainLeft -= n; for (let k = 0; k < n; k++) { const i = alloc(), x = rnd(-.5, .5) * p.W * 1.1 - DX * 600, z = rnd(p.zLip + 30 * px, (oyc - 120) / DY); nextLetter(i); place(i, x, oyc + rnd(20, 500), z); if (ears - dropAt >= 1 / 8) { dropAt = ears; cue('drop', pan(x, z), .5) } setQuat(i, rnd(-1, 1), rnd(-1, 1), rnd(-1, 1), rnd(0, 6)); loose(i, rnd(-60, 60), -rnd(200, 500), rnd(-40, 40), 6) } }
    // Rigid bodies, in steps of a 120th of a second or less: two a frame at full rate, more when frames come slowly.
    const passes = Math.max(2, Math.ceil(dt * 120)), h = dt / passes
    for (let pass = 0; pass < passes; pass++) {
      for (let i = 0; i < MAX; i++) if (L.state[i] === DYN) step(L, i, h)
      for (let i = 0; i < Dn.cap; i++) if (Dn.state[i] === DYN) step(Dn, i, h)
    }
    // Scams in the air meet the laser; what burns, burns away.
    for (let k = beams.length - 1; k >= 0; k--) { if (time >= beams[k].until || L.state[beams[k].id] === FREE) beams.splice(k, 1); else beam(beams[k]) }
    for (let i = 0; i < MAX; i++) if (burning[i] && L.state[i] !== FREE) {
      burn[i] += dt * 1.3
      if (Math.random() < dt * 12) add(L.pos[i * 3] + rnd(-1, 1) * p.lw * .4, L.pos[i * 3 + 1], L.pos[i * 3 + 2] - 1, rnd(-30, 30) * px, rnd(20, 110) * px, 0, rnd(.3, .8), rnd(.8, 1.6) * px, rnd(.8, 1.6) * px, 0, colour.ember, 1, -.12, 1)
      if (burn[i] > .25 && Math.random() < dt * 5) wisp(L.pos[i * 3], L.pos[i * 3 + 1] + p.lh * .3, L.pos[i * 3 + 2], 1, 9, .26)
      if (burn[i] >= 1.1) { for (let k = 0; k < 2; k++) wisp(L.pos[i * 3], L.pos[i * 3 + 1], L.pos[i * 3 + 2], 1, 11, .3); L.state[i] = FREE; burning[i] = 0; scripts.delete(i); burnt++; hooks.count(sorted, burnt); if (pointer.hover === i) setHover(-1) }
    }
    // Letters going home: up in an arc to the hopper, small as they go in.
    if (phase === 'rebuild') {
      let left = 0
      for (let i = 0; i < MAX; i++) if (L.state[i] === HOME) {
        left++; delay[i] -= dt
        if (delay[i] > 0) continue
        L.still[i] += dt / .7
        // Up first, then across over the roof, then down into the hopper: never through the cabinet. (One lying beside
        // the tower, under what hangs on its sides, first slides out from under it.)
        const u = clamp(L.still[i]), e = ease(u), o = i * 3, f = i * 7, over = m.hopperTop + p.lh * 2.2, under = from[f + 2] > -p.lw && from[f + 1] < sides && Math.abs(from[f]) > p.Xc - p.lw && Math.abs(from[f]) < clearX
        const rise = out(clamp((u - (under ? .14 : 0)) / .5)), across = ease(clamp((u - .3) / .55)), down = ease(clamp((u - .78) / .22)), x0 = under ? from[f] + (Math.sign(from[f]) * clearX - from[f]) * ease(clamp(u / .22)) : from[f]
        L.pos[o] = x0 * (1 - across); L.pos[o + 1] = from[f + 1] + (Math.max(over, from[f + 1]) - from[f + 1]) * rise + (m.hopperTop + p.lh - Math.max(over, from[f + 1])) * down; L.pos[o + 2] = from[f + 2] + (p.zL - from[f + 2]) * across
        for (let k = 0; k < 4; k++) L.quat[i * 4 + k] = from[f + 3 + k] * (1 - e) + (k === 3 ? e : 0)
        const ql = 1 / Math.hypot(L.quat[i * 4], L.quat[i * 4 + 1], L.quat[i * 4 + 2], L.quat[i * 4 + 3]); for (let k = 0; k < 4; k++) L.quat[i * 4 + k] *= ql
        if (u >= 1) L.state[i] = FREE
      }
      let away = 0
      for (let i = 0; i < Dn.cap; i++) if (Dn.state[i] === HOME) {
        Dn.still[i] += dt / .55
        // (Out in front of the machine first, from under whatever hangs on the tower's side, and over the roof if it
        // belongs on it; then in to its place: never through the cabinet.)
        const u = clamp(Dn.still[i]), o = i * 3, q = i * 4
        if (u > 0) {
          // (It runs a little past its place as it seats, and settles back.)
          const t = 1 + 2 * (ease(u) - 1) ** 3 + 1 * (ease(u) - 1) ** 2, s = 1 - t, b0 = s * s * s, b1 = 3 * t * s * s, b2 = 3 * t * t * s, b3 = t * t * t, h = debrisHome[i], fx = away0[o], fy = away0[o + 1], fz = away0[o + 2]
          const roof = h[1] > p.yTop - 1, under = fz > -p.lw && fy < sides && Math.abs(fx) > p.Xc - p.lw && Math.abs(fx) < clearX, up = Math.max(fy, h[1]) + (roof ? 3 * p.lh : 0), zf = Math.min(fz, -1.2 * p.lw)
          Dn.pos[o] = b0 * fx + b1 * (under ? Math.sign(fx) * clearX : fx) + (b2 + b3) * h[0]; Dn.pos[o + 1] = b0 * fy + b1 * up + b2 * (roof ? up : h[1]) + b3 * h[1]; Dn.pos[o + 2] = b0 * fz + (b1 + b2) * zf + b3 * h[2]
          let l = 0; for (let k = 0; k < 4; k++) { Dn.quat[q + k] = away0[Dn.cap * 3 + q + k] * s + (k === 3 ? t : 0); l += Dn.quat[q + k] ** 2 } l = 1 / Math.sqrt(l); for (let k = 0; k < 4; k++) Dn.quat[q + k] *= l
        }
        if (u >= 1) Dn.state[i] = FREE; else away++
      }
      needleV += ((0 - needle) * 40 - needleV * 8) * dt; needle += needleV * dt
      const glass = parts[m.idx.glass]
      if (clock > .75) { glass.on = true; glass.fade = clamp((clock - .75) / .35); parts[m.idx.soot].fade = parts[m.idx.shards].fade = 1 - glass.fade; parts[m.idx.hole].on = glass.fade < .5; bend = 1 - glass.fade }
      if (!left && !away && clock > 1.5) { glass.fade = 1; bend = 0; parts[m.idx.soot].on = parts[m.idx.shards].on = parts[m.idx.hole].on = false; parts[m.idx.soot].fade = parts[m.idx.shards].fade = 1; spawned = 0; sorted = 0; burnt = 0; hooks.count(0, 0); heat = 0; runT = 0; spawnIn = .2; setPhase('run') }
    }
    // After the burst: at rest once all but a few letters lie still; whatever has not settled a little later is made to
    // (or, if it has nothing under it, removed).
    if ((phase === 'boom' && clock > 1.2) || (phase === 'rest' && time - boomAt < 5.2)) {
      const late = time - boomAt > 4.4
      let moving = 0
      for (let i = 0; i < MAX; i++) if (L.state[i] === DYN) { moving++; if (late) { const c = cell(L.pos[i * 3], L.pos[i * 3 + 2]), edge = L.pos[i * 3 + 1] > p.yTop - 2 && L.pos[i * 3 + 2] > -2 && Math.abs(L.pos[i * 3]) < p.Xc && (L.pos[i * 3 + 2] < p.lw * .7) || (L.pos[i * 3 + 1] < p.lh && L.pos[i * 3 + 2] < p.zLip + 22 * px + p.lw * .5) || (L.pos[i * 3 + 1] < p.base && Math.abs(L.pos[i * 3]) < p.Xc && L.pos[i * 3 + 2] < 0 && L.pos[i * 3 + 2] > -p.lw * .6) || keepClear.some(zone => Math.abs(L.pos[i * 3 + 1] - zone.y) < 40 * px && Math.hypot(L.pos[i * 3] - zone.x, L.pos[i * 3 + 2] - zone.z) < p.lw * .62 + zone.r); if (c < 0 || heights[c] === VOID || edge || L.pos[i * 3 + 1] > heights[c] + 30 * px) L.state[i] = FREE; else sleep(L, i) } }
      for (let i = 0; i < Dn.cap; i++) if (Dn.state[i] === DYN && late) sleep(Dn, i)
      if (phase === 'boom' && moving <= 4) setPhase('rest')
    }

    // Capsules down the tubes: down the front between the manifolds, a moment out of sight inside the cabinet, then
    // out of its wall, across the slab and over the lip.
    for (let k = 0; k < caps.length; k++) {
      const cap = caps[k], part = parts[m.idx.caps[k]]
      part.on = cap.on && cap.wait <= 0; part.clip = cap.run === 0 && cap.tube < p.tubes.length ? frontClip : undefined
      if (!cap.on) continue
      if (cap.wait > 0) { cap.wait -= dt * Math.sqrt(speed); continue }
      cap.s += dt * 540 * px * Math.sqrt(speed)
      const line = m.lines[cap.tube][cap.run], s = runLength[cap.tube][cap.run]
      if (cap.s >= s[s.length - 1]) { if (cap.run + 1 < m.lines[cap.tube].length) { cap.run++; cap.s = 0; cap.wait = .16 } else { cap.on = false; if (cap.tube === p.tubes.length) cannonFire() } part.on = false; continue }
      let i = 1; while (s[i] < cap.s) i++
      const a = line[i - 1], b = line[i], u = (cap.s - s[i - 1]) / (s[i] - s[i - 1]), tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2], tl = Math.hypot(tx, ty, tz), angle = Math.acos(clamp(ty / tl, -1, 1)), al = Math.hypot(tz, tx) || 1, sn = Math.sin(angle / 2)
      Q2[0] = tz / al * sn; Q2[1] = 0; Q2[2] = -tx / al * sn; Q2[3] = Math.cos(angle / 2)
      pose(part.m, ORIGIN, put(AT, a[0] + tx * u, a[1] + ty * u, a[2] + tz * u), Q2)
    }

    // Gates, rollers, needle, laser.
    for (let i = 0; i < 7; i++) { flapAngle[i] += (flapWant[i] - flapAngle[i]) * Math.min(1, dt * 22 * Math.sqrt(speed)); if (!scripts.size) flapWant[i] = 0 }
    const spin = running ? 120 * px * speed / m.rr * dt : 0
    // (A deck that is not yet in its place is wherever its fitting has it, its rollers and its gate with it; one
    // still waiting off a narrow page's side is not drawn.)
    for (let j = 0; j < m.idx.rollers.length; j++) {
      const lane = m.rollerLane[j], k = j % 8, home = m.rollerHome[j], part = parts[m.idx.rollers[j]], d = deck[lane]
      if (d.stage !== FITTED) { part.on = d.stage !== AWAIT || !p.phone; pose(part.m, home, put(AT, d.x + home[0] - p.lanes[lane], d.y, d.z), NONE); continue }
      rollerSpin[j] += spin * (p.lanes[lane] < -1 ? 1 : p.lanes[lane] > 1 ? -1 : .4)
      if (k >= 2 && k <= 5) {
        const a = -m.swing[lane] * 1.02 * flapAngle[lane], hinge = m.hinge[lane], dx = home[0] - hinge[0]
        pose(part.m, home, put(AT, hinge[0] + dx * Math.cos(a), hinge[1] + dx * Math.sin(a), home[2]), turnZ(a + rollerSpin[j]))
      } else pose(part.m, home, home, turnZ(rollerSpin[j]))
    }
    for (let i = 0; i < m.idx.flaps.length; i++) {
      const d = deck[i], home = deckHome[i], flap = parts[m.idx.flaps[i]], body = parts[m.idx.decks[i]], rise = m.yR - m.rr - p.yCav
      if (d.stage !== FITTED) { flap.on = body.on = d.stage !== AWAIT || !p.phone; pose(flap.m, m.hinge[i], put(AT, d.x + m.hinge[i][0] - home[0], d.y, d.z), NONE); pose(body.m, home, put(AT, d.x, d.y, d.z), NONE) }
      else { flap.on = body.on = true; pose(flap.m, m.hinge[i], m.hinge[i], turnZ(-m.swing[i] * 1.02 * flapAngle[i])); pose(body.m, home, home, NONE) }
      pose(parts[m.idx.chutes[i]].m, ORIGIN, put(AT, 0, -(1 - d.chute) * rise, 0), NONE)
    }
    // The fitters: the column turned to where the hand is, the two arms bent to reach it, the hand level and square
    // to the page, its fingers open or closed; the port's cover; the magazine's lift.
    for (let k = 0; k < m.arms.length; k++) {
      const A = m.arms[k], a = arm[k], S = A.shoulder, P = A.parts, on = A.crane ? a.job >= 0 : a.pop > 0
      parts[P.hand].on = parts[P.fingers[0]].on = parts[P.fingers[1]].on = on
      pose(parts[P.cover].m, ORIGIN, A.crane ? put(AT, 0, -a.cover * A.sink, 0) : put(AT, 0, 0, a.cover * A.slide), NONE)
      if (P.lift >= 0) pose(parts[P.lift].m, ORIGIN, put(AT, 0, Math.min(lift[k], A.count - 1) * A.pitch, 0), NONE)
      if (A.crane) {
        // (A crane: the hand and its cable straight over the port, at the height its job has it.)
        parts[P.cable].on = on
        if (on) { const dy = a.y - S[1], open = (1 - a.grip) * A.open; pose(parts[P.cable].m, ORIGIN, put(AT, 0, dy, 0), NONE); pose(parts[P.hand].m, ORIGIN, AT, NONE); pose(parts[P.fingers[0]].m, ORIGIN, put(AT2, -open, dy, 0), NONE); pose(parts[P.fingers[1]].m, ORIGIN, put(AT2, open, dy, 0), NONE) }
        continue
      }
      parts[P.base].on = parts[P.upper].on = parts[P.fore].on = on
      if (!on) continue
      // (It rises out of its well folded, the upper arm straight up, the forearm hanging back down beside it and the
      // hand turned along the well, then unfolds over the port, the elbow running a little past and settling back. It
      // goes down the same way, folding first and then sinking, gathering way. It is never drawn larger or smaller.)
      const u = a.pop, rise = a.down ? 1 - (1 - clamp(u / .45)) ** 2 : 1 - (1 - clamp(u / .4)) ** 3, f = a.down ? ease(clamp((u - .4) / .6)) : clamp((u - .28) / .72)
      const e1 = a.down ? f : ease(f), e2 = a.down ? f : 1 + 2.4 * (f - 1) ** 3 + 1.4 * (f - 1) ** 2
      bendArm(A.L, a.r, a.y - S[1], angles)
      const back = Math.PI / 2, dyaw = Math.atan2(Math.sin(a.yaw - back), Math.cos(a.yaw - back)), yaw = back + dyaw * e1, turn = (1 - e1) * back
      const t1 = back + (angles[0] - back) * e1, t2 = A.foldT2 + (angles[1] - A.foldT2) * e2, er = Math.cos(t1) * A.L, ey = Math.sin(t1) * A.L, cy = Math.cos(yaw), sn = Math.sin(yaw), bx = S[0], by = p.yTop - (1 - rise) * A.sunk, bz = S[2], sy = by + S[1] - p.yTop
      const wr = er + Math.cos(t2) * A.L, wy = sy + ey + Math.sin(t2) * A.L, wx = bx + cy * wr, wz = bz + sn * wr, open = (1 - a.grip) * A.open * e1, ox = Math.cos(turn) * open, oz = Math.sin(turn) * open
      put(AT2, bx, p.yTop, bz); pose(parts[P.base].m, AT2, put(AT, bx, by, bz), turnY(yaw))
      pose(parts[P.upper].m, S, put(AT, bx, sy, bz), turnYZ(yaw, t1))
      pose(parts[P.fore].m, S, put(AT, bx + cy * er, sy + ey, bz + sn * er), turnYZ(yaw, t2))
      pose(parts[P.hand].m, S, put(AT, wx, wy, wz), turnY(turn))
      pose(parts[P.fingers[0]].m, S, put(AT, wx - ox, wy, wz - oz), turnY(turn)); pose(parts[P.fingers[1]].m, S, put(AT, wx + ox, wy, wz + oz), turnY(turn))
    }
    // The units on the tower's sides: each lit once its lane works, and blinking off for a moment as a letter comes
    // to it; a thread's reels turned as its mail comes, a rule's hand stepped round and its lamps along, an agent's
    // aerial lit, an inbox given its letter, a mail app's new line lit.
    for (let k = 0; k < m.pods.length; k++) {
      const unit = m.pods[k], a = arrived[unit.lane], working = deck[unit.lane].stage === FITTED && pod[k] >= 1
      parts[unit.lamp].on = working && a < .82
      reel[k] -= dt * 9 * a; dialV[k] += ((dialTo[k] - dial[k]) * 160 - dialV[k] * 15) * dt; dial[k] += dialV[k] * dt
      for (let e = 0; e < unit.reels.length; e++) pose(parts[unit.reels[e]].m, unit.reelAt[e], unit.reelAt[e], turnZ(reel[k] * (e ? .78 : 1)))
      if (unit.hand >= 0) { pose(parts[unit.hand].m, unit.handAt, unit.handAt, turnZ(-dial[k])); const at = unit.steps[stepAt[k]]; parts[unit.step].on = working; pose(parts[unit.step].m, ORIGIN, put(AT, at[0] - unit.steps[0][0], at[1] - unit.steps[0][1], 0), NONE) }
      if (unit.tip >= 0) parts[unit.tip].on = a > .4
      if (unit.letter >= 0) parts[unit.letter].on = got[k] === 1
      if (unit.unread >= 0) parts[unit.unread].on = a > .25
    }
    put(AT, p.gauge.x, p.gauge.y, 0); pose(parts[m.idx.needle].m, AT, AT, turnZ((135 - 270 * needle) * Math.PI / 180))
    for (let k = 0; k < 2; k++) {
      // At ease a laser sweeps the sky on its own side. (Until the machine is fitted out they hang muzzle down, free
      // to swing; once it is, they are driven, and come up to their work.)
      aimHold[k] -= dt; if (!screenOn) turretAim[k] = k ? -1.35 : Math.PI + 1.35; else if (aimHold[k] <= 0) { const up = .5 + Math.sin(time * .7 + k * 2.1) * .28; turretAim[k] = k ? up : Math.PI - up }
      if (!screenOn) { swingV[k] += ((turretAim[k] - turretAngle[k]) * 70 - swingV[k] * 3.4) * dt; turretAngle[k] += swingV[k] * dt; if (Math.abs(swingV[k]) < 1e-3 && Math.abs(turretAim[k] - turretAngle[k]) < 1e-4) swingV[k] = 0 }
      else turretAngle[k] += (turretAim[k] - turretAngle[k]) * Math.min(1, dt * 10)
      pose(parts[m.idx.turrets[k]].m, m.turrets[k], m.turrets[k], turnZ(turretAngle[k]))
    }
    { const c = m.cannon, back = recoil * 8 * px; pose(parts[m.idx.barrel].m, c.pivot, put(AT, c.pivot[0] - c.ce * back, c.pivot[1] - c.se * back, c.pivot[2]), turnZ(p.cannon.el)); pose(parts[m.idx.cradle].m, c.pivot, c.pivot, turnZ(p.cannon.el)) }
    for (let k = 0; k < m.valves.length; k++) { const at = m.parts[m.idx.levers[k]].pivot; pose(parts[m.idx.levers[k]].m, at, at, turnZ(m.valves[k].side * lever[k])) }
    // (Thrown back by the burst it hangs by one hinge, askew: a turn about the hinge line, then a slew.)
    if (Dn.state[hatchBody] === FREE) { const slew = clamp((hatch - 1.1) / 1.1) * .42, sx = Math.sin(hatch / 2), cx = Math.cos(hatch / 2), sy = Math.sin(slew / 2), cy = Math.cos(slew / 2); Q2[0] = cy * sx; Q2[1] = sy * cx; Q2[2] = -sy * sx; Q2[3] = cy * cx; pose(parts[m.idx.hatch].m, m.hatchHinge, m.hatchHinge, Q2) }
    // Blown-off parts follow their bodies; at home they stand where they were built.
    for (let i = 0; i < debrisPart.length; i++) {
      const index = debrisPart[i]
      if (Dn.state[i] !== FREE) pose(parts[index].m, debrisHome[i], Dn.pos, Dn.quat, dwindle(Dn.pos[i * 3 + 1], Dn.pos[i * 3 + 2]), i * 3, i * 4)
      else if (!selfPosed.has(index)) { pose(parts[index].m, debrisHome[i], debrisHome[i], NONE); if (i >= paneBody && i < paneBody + m.idx.panes.length) parts[index].on = false }
    }
    // The tube the burst tore from its socket stays bent: out of the wall towards the page and over to its own side,
    // in front of the tubes beside it, and short of the corner post. (A turn forward about the page's level, then one
    // in its plane.)
    { const fwd = -.24 * bend, over = -.15 * bend, sz = Math.sin(over / 2), cz = Math.cos(over / 2), sx = Math.sin(fwd / 2), cx = Math.cos(fwd / 2); Q2[0] = cz * sx; Q2[1] = sz * sx; Q2[2] = sz * cx; Q2[3] = cz * cx
      pose(parts[m.idx.bent].m, m.parts[m.idx.bent].pivot, m.parts[m.idx.bent].pivot, Q2); pose(parts[m.idx.bentHeld].m, m.parts[m.idx.bentHeld].pivot, m.parts[m.idx.bentHeld].pivot, Q2) }

    // Effects.
    for (let k = fx.length - 1; k >= 0; k--) {
      const f = fx[k]; f.life += dt
      if (f.life >= f.max) { spent.push(f); fx[k] = fx[fx.length - 1]; fx.pop(); continue }
      f.vy -= G * f.gravity * dt; const d = 1 - f.drag * dt; f.vx *= d; f.vy *= d; f.vz *= d
      f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt; f.size += f.grow * dt; f.rot += f.spin * dt
      if (f.gravity > 0 && f.y < 1 && f.z < 0) { f.y = 1; f.vy *= -.3; f.vx *= .5 }
    }
    // Steam and smoke: each billow keeps its own speed (the air slows it, its heat lifts it) and is carried besides by
    // a slow field that has no sources or sinks, the curl of a drifting potential: plumes roll, shear and curl over.
    {
      const k = 1 / (62 * px), t1 = time * .42, t2 = time * .31, amp = 34 * px
      let live = 0
      through.fill(1)
      for (let n = Math.max(0, S.head - SM); n < S.head; n++) {
        const i = n % SM
        if (S.age[i] >= S.life[i]) continue
        // (By day steam shows dark on the pale page: it is gone sooner, nearer the machine.)
        S.age[i] += dark ? dt : S.kind[i] > .5 ? (S.dens[i] < .5 ? dt * 2.2 : dt) : dt * 1.7; live++
        const o = i * 3, f = S.age[i] / S.life[i], a = S.pos[o] * k, b = (S.pos[o + 1] + DY * S.pos[o + 2]) * k
        const cx = -Math.sin(a + t1) * Math.sin(b - t2) - 1.15 * Math.sin(2.1 * a - t2 + 1.7) * Math.sin(2.3 * b + t1)
        const cy = -Math.cos(a + t1) * Math.cos(b - t2) - 1.05 * Math.cos(2.1 * a - t2 + 1.7) * Math.cos(2.3 * b + t1)
        const stir = amp * Math.min(1, f * 3 + .12), d = Math.max(0, 1 - S.drag[i] * dt)
        S.vel[o] *= d; S.vel[o + 1] = S.vel[o + 1] * d + S.lift[i] * dt; S.vel[o + 2] *= d
        S.pos[o] += (S.vel[o] + cx * stir) * dt; S.pos[o + 1] += (S.vel[o + 1] + cy * stir) * dt; S.pos[o + 2] += S.vel[o + 2] * dt
        S.size[i] += S.grow[i] * dt * (1 - f * .55); S.rot[i] += S.spin[i] * dt; S.heat[i] *= Math.max(0, 1 - 3 * dt)
        // (How much of each piece of text this billow hides: its opacity as the renderer draws it, at five points of the text.)
        const sx = S.pos[o] + DX * S.pos[o + 2], sy = S.pos[o + 1] + DY * S.pos[o + 2], reach = S.size[i], fade = (f < .1 ? f * 10 : 1) * (f < .45 ? 1 : 1 - ((f - .45) / .55) ** 2 * (3 - 2 * (f - .45) / .55)), thick = S.dens[i] * Math.max(0, fade)
        if (thick > .02) for (let z = 0; z < zones.length; z++) {
          const zone = zones[z]
          if (Math.abs(sx - zone[0]) > zone[2] + reach || Math.abs(sy - zone[1]) > zone[3] + reach) continue
          for (let k = 0; k < 5; k++) { const dx = sx - zone[0] - SAMPLE[k * 2] * zone[2], dy = sy - zone[1] - SAMPLE[k * 2 + 1] * zone[3], r2 = (dx * dx + dy * dy) / (reach * reach); if (r2 < 1) through[z * 5 + k] *= 1 - thick * (1 - r2) ** 2 }
        }
      }
      S.live = live
      for (let z = 0; z < zones.length; z++) {
        // (Clear is the text seen through the smoke, averaged over its five points; what the burst leaves over the
        // readout thins on a clock of its own, so "Jammed" is back within a second and a half.)
        let clear = (through[z * 5] + through[z * 5 + 1] + through[z * 5 + 2] + through[z * 5 + 3] + through[z * 5 + 4]) / 5
        clear = Math.max(clear * clear, phase === 'run' || phase === 'overload' ? .7 : clamp((time - boomAt - .9) / 1.1) * .82)
        veil[z] += (clear - veil[z]) * Math.min(1, dt * 12); if (Math.abs(veil[z] - veilSent[z]) > .02 || (veil[z] > .995 && veilSent[z] < 1)) { veilSent[z] = veil[z] > .995 ? 1 : veil[z]; hooks.veil(z, veilSent[z]) }
      }
    }
    if (pointer.held >= 0) hold(dt)
    if (pointer.dirty) { pointer.dirty = false; if (pointer.held < 0) setHover(pointer.in && pointer.mouse ? pick(pointer.x, pointer.y) : pointer.hover) }
    if (pointer.hover >= 0) { const i = pointer.hover; if (L.state[i] === FREE) setHover(-1); else hooks.hover(pool[data[i]], p.ox + L.pos[i * 3] + DX * L.pos[i * 3 + 2], oyc - over - L.pos[i * 3 + 1] - DY * L.pos[i * 3 + 2]) }
  }

  /** What falls past the slab dwindles over the last of the canvas, so nothing is cut off where the canvas ends. */
  // (And anything that does go over the lip, in front of it and below the slab, is gone within a short fall.)
  const dwindle = (y: number, z: number) => Math.min(clamp((p.floor + p.ext + y + DY * z - 30) / (p.ext * .5)), z < p.zLip ? clamp(1 + (y + p.lip) / (40 * px)) : 1)
  // (What is drawn, handed to the renderer in the same object every frame.)
  const scene = { parts: [] as Part[], letters: instances, letterCount: 0, fx: fxData, fxCount: 0, shifts, glow: glowData, glowCount: 0, air: airData, airCount: 0, smoke: smokeData, smokeCount: 0, flash: 0, flashAt: [0, 0, 0], flashR: 0, wallOn: true }
  function render() {
    let n = 0
    for (let i = 0; i < MAX; i++) if (L.state[i] !== FREE) {
      const o = n * LETTER_FLOATS, shrink = (L.state[i] === HOME ? 1 - clamp(L.still[i]) ** 3 * .7 : 1) * dwindle(L.pos[i * 3 + 1], L.pos[i * 3 + 2])
      instances[o] = L.pos[i * 3]; instances[o + 1] = L.pos[i * 3 + 1]; instances[o + 2] = L.pos[i * 3 + 2]
      instances[o + 3] = L.quat[i * 4]; instances[o + 4] = L.quat[i * 4 + 1]; instances[o + 5] = L.quat[i * 4 + 2]; instances[o + 6] = L.quat[i * 4 + 3]
      const curl = burning[i] ? 1 - Math.min(1, burn[i]) * .3 : 1
      instances[o + 7] = p.lw * shrink * curl * scale[i]; instances[o + 8] = p.lh * shrink * curl * scale[i]; instances[o + 9] = 1.4
      instances[o + 10] = seed[i]; instances[o + 11] = burn[i]; instances[o + 12] = kind[i]; instances[o + 13] = i === pointer.hover || i === pointer.held ? 1 : 0
      n++
    }
    let a = 0, g = 0
    for (const f of fx) {
      const u = f.life / f.max, target = f.glow ? glowData : fxData, o = (f.glow ? g++ : a++) * FX_FLOATS
      if (f.glow ? g > 64 : a > 700) { if (f.glow) g--; else a--; continue }
      // Puffs thin out as they swell; sparks lie along their flight; a bar (the laser's beam) lies where it is put.
      const size = f.size, bar = f.shape === 4
      target[o] = f.x; target[o + 1] = f.y; target[o + 2] = f.z
      target[o + 3] = f.shape === 1 || f.shape === 3 ? Math.max(f.len, size) : size; target[o + 4] = f.shape === 3 ? f.len : size
      target[o + 5] = f.shape === 1 && !f.spin ? Math.atan2(f.vy + DY * f.vz, f.vx + DX * f.vz) : f.rot
      if (bar) { target[o + 3] = f.size; target[o + 4] = f.len }
      target[o + 6] = f.r; target[o + 7] = f.g; target[o + 8] = f.b; target[o + 9] = f.a * (f.shape === 0 ? Math.min(1, u * 8) * (1 - u) ** 1.3 : bar ? 1 : f.shape === 2 ? Math.sqrt(1 - u) : Math.min(1, (1 - u) * 2.5)); target[o + 10] = bar ? 1 : f.shape
    }
    // By night, where the page is wide enough to show it, the air behind the machine takes a little of the lamp's
    // light: what the machine stands out against. (One faint slope of light, drawn first, behind everything.)
    let air = 0
    if (dark && !p.phone) { airData[0] = 0; airData[1] = p.yTop * .62; airData[2] = p.D * .5; airData[3] = p.Xc * 2.4; airData[4] = p.yTop * .9; airData[5] = 0; airData[6] = .62; airData[7] = .68; airData[8] = 1; airData[9] = .07; airData[10] = 2; air = 1 }
    // Billows, the oldest first: a new one comes out in front of what is already in the air. (Each thins out as it
    // rises towards the page's header, gone before it reaches its controls; and after the burst what hangs over the
    // readout thins away from it, between about 1.9 and 2.9 s of the page's time (the burst's slowed time runs .6 to
    // 1.2 s then), before the readout's instruction comes back.)
    let sn = 0
    const R = zones[0], told = phase === 'boom' || phase === 'rest' ? clamp((time - boomAt - .6) / .6) : 0
    for (let k = Math.max(0, S.head - SM); k < S.head; k++) {
      const i = k % SM
      if (S.age[i] >= S.life[i]) continue
      const o = sn++ * SMOKE_FLOATS, sx = S.pos[i * 3] + DX * S.pos[i * 3 + 2], sy = S.pos[i * 3 + 1] + DY * S.pos[i * 3 + 2], size = S.size[i]
      let thin = clamp((p.oy - sy - .7 * size - 56) / 60)
      if (told > 0) { const d = Math.hypot(Math.max(0, Math.abs(sx - R[0]) - R[2]), Math.max(0, Math.abs(sy - R[1]) - R[3])); thin *= 1 - .9 * told * (1 - clamp(d / (size + 10 * px)) ** 2) }
      smokeData[o] = S.pos[i * 3]; smokeData[o + 1] = S.pos[i * 3 + 1]; smokeData[o + 2] = S.pos[i * 3 + 2]; smokeData[o + 3] = size; smokeData[o + 4] = S.rot[i]
      smokeData[o + 5] = S.age[i] / S.life[i]; smokeData[o + 6] = S.seed[i]; smokeData[o + 7] = thin * (dark || S.kind[i] > .5 ? S.dens[i] : S.dens[i] * clamp(1 - (Math.abs(sx) - p.Xc) / (70 * px))); smokeData[o + 8] = S.kind[i]; smokeData[o + 9] = S.heat[i]
    }
    // (The burst's light reaches as far as the works' window is big; a phone's window is small, and so much light in
    // so little room lit the readout's screen alone in a pool with the console dark round it: there it reaches across
    // the tower's whole face.)
    scene.parts = parts; scene.letterCount = n; scene.fxCount = a; scene.glowCount = g; scene.airCount = air; scene.smokeCount = sn; scene.flash = flash; scene.flashAt[1] = (p.yCav + p.yFas) / 2; scene.flashR = p.phone ? Math.max(p.cavity * 1.25, .85 * p.Xc) : p.cavity * 1.25
    renderer!.draw(scene)
  }

  // ── The pointer: read a letter, drag it, burn a scam ──
  function pick(sx: number, sy: number) {
    const wx = sx - p.ox, wy = oyc - over - sy
    let best = -1, depth = Infinity
    for (let i = 0; i < MAX; i++) {
      const state = L.state[i]
      if (state === FREE || state === HOME || burning[i] || (state === SCRIPT && scripts.get(i)!.stage >= 30)) continue
      const o = i * 3, x = L.pos[o], y = L.pos[o + 1], z = L.pos[o + 2]
      if (Math.abs(x + DX * z - wx) > p.lw || Math.abs(y + DY * z - wy) > p.lw) continue
      matrix(L.quat, i * 4)
      // The letter's plane cut by the line of sight through the pointer: inside its outline, and nearest wins.
      const nx = R[2], ny = R[5], nz = R[8], denom = -DX * nx - DY * ny + nz
      if (Math.abs(denom) < .04) continue
      const t = ((x - wx) * nx + (y - wy) * ny + z * nz) / denom, hx = wx - DX * t - x, hy = wy - DY * t - y, hz = t - z
      const u = hx * R[0] + hy * R[3] + hz * R[6], v = hx * R[1] + hy * R[4] + hz * R[7]
      if (Math.abs(u) <= p.lw / 2 + 2 && Math.abs(v) <= p.lh / 2 + 2 && t < depth) { depth = t; best = i }
    }
    // Behind the fascia or the label rail a letter is out of sight.
    if (best >= 0 && L.state[best] === SCRIPT) { const y = L.pos[best * 3 + 1]; if ((y > p.yFas - p.lh * .2 && y < p.yTop) || y < p.yCav) return -1 }
    return best
  }
  function setHover(i: number) { if (i === pointer.hover) return; pointer.hover = i; hooks.hover(i < 0 ? null : pool[data[i]], 0, 0); canvas.style.cursor = i < 0 ? '' : kind[i] ? 'crosshair' : 'grab'; kick() }
  function hold(dt: number) {
    const i = pointer.held, o = i * 3, wx = pointer.x - p.ox, wy = oyc - over - pointer.y, z = L.pos[o + 2], y = pointer.holdY
    // The pointer's line of sight meets the height the letter is carried at.
    let tz = clamp((wy - y) / DY, -((p.floor - p.lh) / DY), p.zBack), tx = wx - DX * tz, ty = y
    // Over the cabinet it is carried up its front, a little clear of it, or over its roof: never inside it.
    if (Math.abs(tx) < p.Xc + p.lw * .6 + (p.heads.length ? p.riser : 0) && tz > p.zProud - p.lw * .6 && tz < p.D + p.lw * .6) {
      const front = p.zProud - p.lw * .7, up = wy - DY * front
      if (up < p.yTop + p.lh) { tz = front; tx = wx - DX * tz; ty = Math.max(y, up) } else { ty = p.yTop + 46 * px; tz = clamp((wy - ty) / DY, p.lw * .8, p.D - p.lw * .5); tx = wx - DX * tz }
    }
    const vx = (tx - L.pos[o]) * 16, vy = (ty - L.pos[o + 1]) * 16, vz = (tz - z) * 16
    L.vel[o] = vx; L.vel[o + 1] = vy; L.vel[o + 2] = vz
    L.pos[o] += vx * dt; L.pos[o + 1] += vy * dt; L.pos[o + 2] += vz * dt
    // Carried face up.
    const want = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]
    const dot = L.quat[i * 4] * want[0] + L.quat[i * 4 + 1] * want[1] + L.quat[i * 4 + 2] * want[2] + L.quat[i * 4 + 3] * want[3], sign = dot < 0 ? -1 : 1
    let l = 0; for (let k = 0; k < 4; k++) { L.quat[i * 4 + k] += (want[k] * sign - L.quat[i * 4 + k]) * Math.min(1, dt * 12); l += L.quat[i * 4 + k] ** 2 }
    l = 1 / Math.sqrt(l); for (let k = 0; k < 4; k++) L.quat[i * 4 + k] *= l
  }
  const local = (event: PointerEvent) => { const box = canvas.getBoundingClientRect(); pointer.x = event.clientX - box.left; pointer.y = event.clientY - box.top - over; pointer.mouse = event.pointerType === 'mouse'; pointer.dirty = true }
  const onMove = (event: PointerEvent) => {
    local(event); pointer.in = true
    if (pointer.down) { pointer.moved = Math.max(pointer.moved, Math.abs(pointer.x - pointer.fromX) + Math.abs(pointer.y - pointer.fromY)); if (pointer.moved > 6 && pointer.held < 0 && pointer.hover >= 0 && pointer.mouse && L.state[pointer.hover] !== SCRIPT && !kind[pointer.hover]) { pointer.held = pointer.hover; pointer.holdY = L.pos[pointer.held * 3 + 1] + 46 * px; L.state[pointer.held] = HELD; canvas.style.cursor = 'grabbing'; canvas.setPointerCapture(event.pointerId) } }
    kick()
  }
  const onDown = (event: PointerEvent) => { local(event); pointer.down = true; pointer.moved = 0; pointer.fromX = pointer.x; pointer.fromY = pointer.y; if (!pointer.mouse) setHover(pick(pointer.x, pointer.y)); kick() }
  const onUp = (event: PointerEvent) => {
    local(event); pointer.down = false
    // (A press the browser took for a scroll is not a tap.)
    if (event.type === 'pointercancel') pointer.moved = 99
    if (pointer.held >= 0) { const i = pointer.held; pointer.held = -1; L.state[i] = DYN; L.still[i] = 0; for (let k = 0; k < 3; k++) L.vel[i * 3 + k] = clamp(L.vel[i * 3 + k], -1400, 1400); L.ang[i * 3 + 1] = rnd(-3, 3); canvas.style.cursor = 'grab' }
    else if (pointer.moved <= 6) {
      const i = pointer.mouse ? pointer.hover : pick(pointer.x, pointer.y)
      if (i >= 0 && kind[i]) { heard = !reduced; fire(i); heard = false }
      else if (i >= 0 && L.state[i] !== SCRIPT) { wake(i); L.vel[i * 3 + 1] = 330 * px; L.vel[i * 3] += rnd(-60, 60) * px; L.ang[i * 3] += rnd(-7, 7); L.ang[i * 3 + 2] += rnd(-7, 7) }
    }
    kick()
  }
  const onLeave = () => { pointer.in = false; if (pointer.held < 0) setHover(-1) }
  canvas.addEventListener('pointermove', onMove); canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', onUp); canvas.addEventListener('pointerleave', onLeave)

  const veiled = (v: number) => v < 1
  const busy = () => phase !== 'rest' || fx.length > 0 || S.live > 0 || smokeLeft > 0 || pointer.held >= 0 || rainLeft > 0 || L.state.includes(DYN) || Dn.state.includes(DYN) || burning.includes(1) || beams.length > 0 || recoil > 0 || scripts.size > 0 || Math.abs(needleV) > .02 || hatchV !== 0 || veilSent.some(veiled) || fading.length > 0
  function frame(now: number) {
    raf = 0
    if (dead) return
    const gap = now - last, dt = Math.min(.1, gap / 1000 || .016); last = now
    // The burst is seen slowed: the blast at its own speed, then a second and a half in which everything it threw hangs
    // in the air at a quarter speed, and the fall let go again.
    const since = time - boomAt, slow = phase !== 'boom' && phase !== 'rest' ? 1 : since < .07 ? 1 : since < .46 ? .26 : since < 1.2 ? .26 + .74 * ease((since - .46) / .74) : 1
    // Frames coming slowly for most of a second: one level of quality down (fewer pixels, a smaller shadow map, a
    // smaller buffer for smoke and less of it). Frames on time for some seconds: one level back up. (Before the frame
    // is drawn: resizing the canvas clears it, and one resized after drawing is shown empty.)
    if (gap > 0 && gap < 250) {
      pace = pace * .9 + gap * .1; strikes = pace > 21 ? strikes + 1 : Math.max(0, strikes - 2); steady = pace < 17.6 ? steady + 1 : 0
      if (strikes > 40 && quality > 0) { quality--; strikes = steady = 0; pace = 16; if (now - climbedAt < 8000) climbAfter = Math.min(climbAfter * 2, 4800); size() }
      else if (steady > climbAfter && quality < best) { quality++; strikes = steady = 0; climbedAt = now; size() }
    }
    ears += dt; heard = true; advance(dt * slow); heard = false; render()
    if (visible && !document.hidden && busy()) raf = requestAnimationFrame(frame)
  }
  function kick() { if (!raf && !dead && visible && !document.hidden && !reduced) { last = performance.now(); raf = requestAnimationFrame(frame) } }
  // A tab that is not being looked at does no work at all.
  const onShown = () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0 } else kick() }
  document.addEventListener('visibilitychange', onShown)

  build()
  if (reduced) still(); else { advance(0); render(); kick() }

  // With reduced motion: one frame of the machine at work, nothing moving.
  function still() {
    setPhase('run'); needle = .22
    const freeze = (lane: number, set: (i: number) => void) => { const i = alloc(); for (let tries = 0; tries < 80; tries++) { nextLetter(i); if (pool[data[i]].scam === (lane === 7)) break } place(i, 0, 0, p.zL); L.state[i] = SCRIPT; set(i) }
    freeze(3, i => { L.pos[i * 3 + 1] = m.scanY; hooks.scan(pool[data[i]], 'read') })
    const seven = p.lanes.length === 7
    freeze(1, i => { L.pos[i * 3] = seven ? p.lanes[1] + p.P * .7 : p.lanes[0] + p.P * .3; L.pos[i * 3 + 1] = m.rideY })
    freeze(5, i => { L.pos[i * 3] = seven ? p.lanes[5] - p.P * .4 : p.lanes[p.lanes.length - 1] - p.P * .25; L.pos[i * 3 + 1] = m.rideY })
    freeze(2, i => { L.pos[i * 3 + 1] = p.yTop + p.hopper * .34 })
    freeze(0, i => { L.pos[i * 3] = p.lw * .5; L.pos[i * 3 + 1] = m.hopperTop + p.lh * (p.phone ? 1.1 : 2); setQuat(i, .3, .2, 1, .5) })
    // (A scam in the air: on a phone over the left of the roof, clear of the cannon on its right.)
    freeze(7, i => { const k = p.phone ? 0 : 1, side = k ? 1 : -1; L.pos[i * 3] = m.ejects[k][0] + side * p.lw * .9; L.pos[i * 3 + 1] = m.ejects[k][1] + p.lh * (p.phone ? 1.3 : 2.2); setQuat(i, .2, .1, 1, -.6 * side) })
    parts[m.idx.lamps[1]].on = parts[m.idx.lamps[2]].on = true
    if (p.tubes.length) [[0, 0, .5], [6, 0, .3], [2, m.lines[2].length - 1, .35], [5, m.lines[5].length - 1, .6]].forEach(([tube, run, at], k) => { const cap = caps[k]; cap.on = true; cap.tube = tube; cap.run = run; cap.wait = 0; cap.s = runLength[tube][run].at(-1)! * at })
    scripts.clear(); advance(0); render()
  }

  return {
    setTheme(next: boolean) { theme(next); if (reduced) render(); else { render(); kick() } },
    setPlan(next: Plan, nextOver: number) { p = next; over = nextOver; phase = 'boot'; clock = 0; heat = 0; needle = 0; needleV = 0; sorted = burnt = 0; scanning = -1; beams.length = 0; hooks.count(0, 0); hooks.scan(null, 'idle'); build(); hooks.phase('boot'); if (reduced) still(); else { advance(0); render(); kick() } },
    setLetters(next: Letter[]) { if (next.length) { all = next; pool = routed(all, p); cursor = Math.floor(Math.random() * pool.length); for (let i = 0; i < MAX; i++) data[i] %= pool.length } },
    setVisible(next: boolean) { visible = next; if (next) kick() },
    /** The gauge: pressed while the machine runs it overloads it at once; pressed afterwards it puts it back together. */
    gauge() { if (reduced) return; hooks.sound?.('press'); if (phase === 'run' || phase === 'boot') { if (!built) { rush = 3.5; needleV += 4 } setPhase('overload'); heat = 1 } else rebuild(); kick() },
    rebuild() { rebuild(); kick() },
    /** The cannon fires one for a click, if it is not still recovering from the last. */
    send() { if (reduced || !sendOn || cool > 0 || phase === 'boot' || phase === 'rebuild') return false; cool = .8; heard = true; capsuleOut(true); heard = false; kick(); return true },
    /** The flood: a few hundred more letters out of the night, wherever the machine is in its day. */
    rain() { if (reduced || !built) return; const more = p.phone ? 140 : 280; rainLeft = Math.min(rainLeft + more, 2 * more); kick() },
    get phase() { return phase },
    destroy() { dead = true; cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', onShown); canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp); canvas.removeEventListener('pointerleave', onLeave); renderer.destroy() },
  }
}
