// Runs the whole show without a GPU: every cue, and every draw call into real display lists, at
// 30 fps, wide and tall. Fails on an exception, a NaN in a list, an overflowing list, or a sprite
// the atlas doesn't have, or a pitchman with anything in front of him. CI's build job runs it;
// from app/: bun run commercial:smoke
import { CARDS, BUBBLES, FINE, LINES, TEAM, TV_TEXT } from "../src/atlas.js"
import { List } from "../src/list.js"
import { Show } from "../src/show.js"

const m = await Bun.file(new URL("../../public/commercial/audio/manifest.json", import.meta.url)).json()
const names = [
  ...Object.keys(CARDS).map((k) => "card:" + k),
  ...BUBBLES.map((s) => "bub:" + s),
  ...TV_TEXT.map((s) => "tv:" + s),
  ...Object.keys(FINE).map((k) => "fine:" + k),
  ...Object.values(LINES).flat().map((s) => "line:" + s),
  ...TEAM.map((_, i) => "team:" + i),
  "mini", "mail", "email", "slack", "dot", "logo", "logo:flat",
]
// (sizes as in atlas.js, near enough: the pitchman check below measures against them)
const size = (n: string) => (n.startsWith("team:") ? [190, 60] : n.startsWith("bub:") ? [200, 46] : n === "mail" ? [44, 44] : n === "mini" ? [78, 20] : n.startsWith("tv:") ? [26 + n.length * 46, 94] : [312, 70])
const items = new Map(names.map((n) => [n, { u0: 0, v0: 0, u1: 1, v1: 1, w: size(n)[0], h: size(n)[1] }]))
const glyph = new Proxy({}, { get: (_, ch) => ({ name: "g:" + String(ch), adv: 17 }) })
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789×,") items.set("g:" + ch, { u0: 0, v0: 0, u1: 1, v1: 1, w: 20, h: 34 })
const atlas = { items, glyphs: { mono: { set: glyph, size: 26 }, badge: { set: glyph, size: 16 } } }

let worst = { feed: 0, beans: 0, fg: 0 }
// what was in the pitchman's way, and for how long: "size name" → [first, last] seconds
const covered = new Map<string, [number, number]>()
for (const [w, h] of [[1238, 720], [1050, 720], [900, 720], [600, 1200], [600, 900], [600, 732]]) {
  const show = new Show({ atlas, audio: null })
  show.size(w, h)
  show.start(m.dur, m.words)
  const lists = { feed: new List(12000, 420), bg: new List(600, 4), fg: new List(3000, 8) }
  for (const l of Object.values(lists)) l.atlas = atlas
  const quads = new Float32Array(16 * 24)
  while (!show.ended) {
    show.step(1 / 30)
    for (const l of Object.values(lists)) l.reset()
    show.feed(lists.feed)
    const nq = show.quads(quads)
    show.bg(lists.bg)
    show.fg(lists.fg)
    if (nq > 16) throw new Error(`too many camera quads at ${show.t.toFixed(2)}`)
    for (const [k, l] of Object.entries(lists)) {
      if (l.n >= l.cap || l.nb >= l.beanCap) throw new Error(`${k} list is full at ${show.t.toFixed(2)}`)
      for (let i = 0; i < l.n * 24; i++) if (Number.isNaN(l.data[i])) throw new Error(`NaN in ${k} at ${show.t.toFixed(2)} (instance ${Math.floor(i / 24)}, field ${i % 24})`)
      for (let i = 0; i < l.nb * 44; i++) if (Number.isNaN(l.beans[i])) throw new Error(`NaN in ${k} beans at ${show.t.toFixed(2)}`)
    }
    worst = { feed: Math.max(worst.feed, lists.feed.n), beans: Math.max(worst.beans, lists.feed.nb), fg: Math.max(worst.fg, lists.fg.n) }
    // The pitchman is whole and nothing is in front of him: not the footage, the band, the type,
    // the readout, the board or anything flying past. (Not checked while he rises into frame at
    // the start, in his circle in the corner, or once Doug is on top of him.)
    if (show.G.in > 0.999 && show.L.pip < 0.01 && !show.atk) {
      const [x0, y0, x1, y1] = show.box
      const hits = show.clear.filter(([, a0, b0, a1, b1]) => a0 < x1 && a1 > x0 && b0 < y1 && b1 > y0).map(([name]) => name)
      if (x0 < 0 || y0 < 0 || x1 > w) hits.push("the edge of the picture")
      for (const name of hits) {
        const key = `${w}×${h} ${name}`
        covered.set(key, [covered.get(key)?.[0] ?? show.t, show.t])
      }
    }
  }
  console.log(`${w}×${h}: ran ${show.t.toFixed(1)} s`)
}
const missing = [...List.missing].filter((n) => !n.startsWith("g:"))
if (missing.length) throw new Error("not in the atlas: " + missing.join(", "))
if (covered.size) throw new Error("the pitchman is covered:\n" + [...covered].map(([k, [a, b]]) => `  ${k}: ${a.toFixed(2)}–${b.toFixed(2)} s`).join("\n"))
console.log("ok", worst)
