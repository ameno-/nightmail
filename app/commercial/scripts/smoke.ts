// Runs the whole show without a GPU: every cue, and every draw call into real display lists, at
// 30 fps, wide and tall. Fails on an exception, a NaN in a list, an overflowing list, or a sprite
// the atlas doesn't have. CI's build job runs it; from app/: bun run commercial:smoke
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
const items = new Map(names.map((n) => [n, { u0: 0, v0: 0, u1: 1, v1: 1, w: 300, h: 70 }]))
const glyph = new Proxy({}, { get: (_, ch) => ({ name: "g:" + String(ch), adv: 17 }) })
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789×,") items.set("g:" + ch, { u0: 0, v0: 0, u1: 1, v1: 1, w: 20, h: 34 })
const atlas = { items, glyphs: { mono: { set: glyph, size: 26 }, badge: { set: glyph, size: 16 } } }

let worst = { feed: 0, beans: 0, fg: 0 }
for (const [w, h] of [[1238, 720], [600, 1200]]) {
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
  }
  console.log(`${w}×${h}: ran ${show.t.toFixed(1)} s`)
}
const missing = [...List.missing].filter((n) => !n.startsWith("g:"))
if (missing.length) throw new Error("not in the atlas: " + missing.join(", "))
console.log("ok", worst)
