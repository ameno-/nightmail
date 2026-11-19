import "./fonts.css"
import "./style.css"
import { buildAtlas } from "./atlas.js"
import { AudioEngine } from "./audio.js"
import { Gpu, QF } from "./gpu.js"
import { List } from "./list.js"
import { Show } from "./show.js"
import { E, clamp } from "./tween.js"

const params = new URLSearchParams(location.search)
// The show's audio, fonts and wordmark are served as written from public/commercial.
const BASE = "/commercial/"
const $ = (id) => document.getElementById(id)
const page = $("page")
const canvas = $("gl")
const glass = $("glass")
const dial = $("dial")
const soundBtn = $("sound")
const MUTE_KEY = "nightmail.commercial.muted"
let muted = localStorage.getItem(MUTE_KEY) === "1"
// Whoever has seen how it ends gets a different pitchman next time. ?take=1 and ?take=2 pick one.
const SEEN_KEY = "nightmail.commercial.seen"
const understudy = () => (params.has("take") ? params.get("take") !== "1" : localStorage.getItem(SEEN_KEY) === "1")

// Where the television sits on the page, and how big the broadcast inside it is. Wide windows
// get a wide tube; a phone gets a tall one with the pitchman under the feed.
function place(W, H) {
  const small = W < 560
  const m = small ? 8 : clamp(W * 0.025, 14, 36)
  const b = small ? 9 : 18 // bezel
  const strip = small ? 62 : 70 // the controls under the glass
  const top = small ? 50 : 56
  const aw = W - 2 * m - 2 * b
  const ah = H - top - (small ? 10 : 20) - b - strip
  const raw = aw / ah
  const a = raw >= 0.9 ? clamp(raw, 1.25, 1.72) : clamp(raw, 0.5, 0.82)
  const sw = Math.min(aw, ah * a)
  const sh = sw / a
  const sx = (W - sw) / 2
  const sy = top + b + (ah - sh) / 2
  const BW = a >= 1 ? Math.round(720 * a) : 600
  const BH = a >= 1 ? 720 : Math.round(600 / a)
  const knobR = small ? 21 : 26
  return { sx, sy, sw, sh, b, strip, BW, BH, small, knob: { x: sx + sw - knobR - 12, y: sy + sh + b * 0.4 + strip / 2, r: knobR } }
}

async function boot() {
  let gpu
  try {
    gpu = await Gpu.create(canvas)
  } catch {
    $("nogpu").hidden = false
    return
  }
  const atlas = await buildAtlas()
  const lists = { feed: new List(12000, 420), bg: new List(600, 4), fg: new List(3000, 8), page: new List(400, 2), over: new List(100, 2) }
  for (const l of Object.values(lists)) l.atlas = atlas
  gpu.setAtlas(atlas.canvas, { feed: { list: lists.feed, ubos: 9 }, bg: { list: lists.bg }, fg: { list: lists.fg }, page: { list: lists.page }, over: { list: lists.over } })
  const manifest = await fetch(`${BASE}audio/manifest.json`).then((r) => r.json())
  const audio = new AudioEngine(BASE)
  const show = new Show({ atlas, audio })
  show.to(show.tube, "power", 1, 1.1, E.out, 0.2)

  let ctx = null
  let analyser = null
  const level = new Float32Array(512)
  let state = "idle" // idle | playing | outro
  let outroAt = 0
  let knob = { a: -0.7, v: 0 }

  const start = async (from = 0) => {
    if (state !== "idle") return
    if (!ctx) {
      try {
        ctx = new AudioContext({ latencyHint: "interactive" })
        audio.attach(ctx, muted)
        analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        audio.voice.connect(analyser)
      } catch {
        ctx = null
      }
    }
    void ctx?.resume()
    state = "playing"
    page.dataset.phase = "playing"
    knob.v += 14
    if (ctx) await Promise.race([audio.preload(Object.keys(manifest.dur)), new Promise((r) => setTimeout(r, 2500))])
    show.understudy = understudy()
    show.start(manifest.dur, manifest.words, from)
  }
  const go = () => void start(Number(params.get("t") || 0))
  glass.addEventListener("click", go)
  dial.addEventListener("click", go)
  soundBtn.setAttribute("aria-pressed", String(!muted))
  soundBtn.addEventListener("click", () => {
    muted = !muted
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0")
    soundBtn.setAttribute("aria-pressed", String(!muted))
    soundBtn.setAttribute("aria-label", muted ? "Unmute" : "Mute")
    audio.setMuted(muted)
  })
  if (params.has("autoplay")) go()

  const u32 = () => new Float32Array(32)
  const bgU = u32()
  const fgU = u32()
  const pageU = u32()
  const overU = u32()
  const feedU = new Float32Array(4)
  const quads = new Float32Array(16 * QF)
  const crtU = new Float32Array(16)
  const postU = new Float32Array(16)
  // view, then a clip rect (x, y, w, h, corner radius) for anything drawn with the CLIP flag
  const plain = (w, h, t, c = [0, 0, w, h, 0]) => [w, h, 1, t, c[0], c[1], c[2], c[3], c[4], 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1]
  let last = performance.now()
  let acc = 0
  let visible = true
  let placed = ""
  document.addEventListener("visibilitychange", () => {
    visible = !document.hidden
    if (visible) last = performance.now()
    if (ctx) visible ? ctx.resume() : ctx.suspend()
  })

  window.__show = show
  const frame = (now) => {
    requestAnimationFrame(frame)
    if (!visible) return
    try {
      tick(now)
    } catch (e) {
      window.__err = String(e.stack || e)
      if (!window.__errLogged) console.error((window.__errLogged = window.__err))
    }
  }
  const tick = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const W = window.innerWidth
    const H = window.innerHeight
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const p = place(W, H)
    const k = Math.min(2, (p.sw * dpr) / p.BW, 2200 / p.BW)
    gpu.resize(W, H, dpr, Math.round(p.BW * k), Math.round(p.BH * k))
    show.size(p.BW, p.BH)
    const key = [p.sx, p.sy, p.sw, p.sh].join()
    if (key !== placed) {
      placed = key
      Object.assign(glass.style, { left: p.sx + "px", top: p.sy + "px", width: p.sw + "px", height: p.sh + "px" })
      const d = p.knob.r + 12
      Object.assign(dial.style, { left: p.knob.x - d + "px", top: p.knob.y - d + "px", width: d * 2 + "px", height: d * 2 + "px" })
    }
    if (params.has("debug")) document.body.dataset.dbg = JSON.stringify({ t: show.t.toFixed(2), err: window.__err, feed: lists.feed.n, beans: lists.feed.nb, fg: lists.fg.n, scene: show.cams[0].scene, take: show.understudy ? 2 : 1, lay: show.lay.to, BW: p.BW, BH: p.BH, missing: [...List.missing] })

    // the voice drives the pitchman's mouth
    if (analyser && show.t < show.talkUntil) {
      analyser.getFloatTimeDomainData(level)
      let s = 0
      for (let i = 0; i < level.length; i++) s += level[i] * level[i]
      show.voice = Math.sqrt(s / level.length)
    } else if (show.t < show.talkUntil) show.voice = 0.18 + 0.12 * Math.sin(now / 55)
    else show.voice = 0

    acc += dt
    if (params.has("freeze") && show.started) acc = 0
    while (acc > 1 / 60) {
      show.step(1 / 60)
      acc -= 1 / 60
    }
    if (state === "playing" && show.ended) {
      state = "outro"
      outroAt = now
      audio.stopAll(1.2)
      if (!params.has("freeze")) localStorage.setItem(SEEN_KEY, "1")
    }
    if (state === "outro") {
      const o = (now - outroAt) / 1000
      show.fade = clamp(o / 1.2, 0, 1)
      if (o > 1.6) {
        show.reset()
        show.fade = 1
        show.tw.to(show, "fade", 0, 1.2, E.io, 0, 0)
        state = "idle"
        page.dataset.phase = "idle"
      }
    }
    const t = show.t

    // 1. the footage  2. the broadcast
    lists.feed.reset()
    const cams = show.feed(lists.feed)
    const nQuads = show.quads(quads)
    lists.bg.reset()
    show.bg(lists.bg)
    lists.fg.reset()
    show.fg(lists.fg)
    bgU.set(plain(p.BW, p.BH, t))
    fgU.set(plain(p.BW, p.BH, t, show.fgClip || undefined))
    feedU.set([p.BW, p.BH, t, 0])

    // 3. the page: concrete, and a television
    const pl = lists.page
    pl.reset()
    pl.concrete(W / 2, H / 2, W / 2, H / 2, 0.082, { s: 1, ox: 0, oy: 0 }, 1)
    const hx = p.sx + p.sw / 2
    const hy0 = p.sy - p.b
    const hy1 = p.sy + p.sh + p.b * 0.4 + p.strip
    const hw = p.sw / 2 + p.b
    const on = show.tube.power
    pl.glow(hx, (hy0 + hy1) / 2 + 18, hw * 1.12, (hy1 - hy0) * 0.6, [0, 0, 0, 0.55], false)
    if (on > 0.1) pl.glow(hx, p.sy + p.sh / 2, hw * 1.25, p.sh * 0.8, [1, 0.72, 0.45, 0.05 * on])
    pl.rbox(hx, (hy0 + hy1) / 2, hw, (hy1 - hy0) / 2, 5, { ink: true, rim: [0.62, 0.59, 0.54, 1] })
    pl.rbox(hx, p.sy + p.sh / 2, p.sw / 2 + 4, p.sh / 2 + 4, 30, { col: [0, 0, 0, 1] })
    pl.rbox(hx, p.sy + p.sh / 2, p.sw / 2 + 4, p.sh / 2 + 4, 30, { col: [0.3, 0.29, 0.27, 1], stroke: 0.8 })
    // the controls: a label, a speaker, and the dial
    const cy = p.knob.y
    const dimc = [0.72, 0.69, 0.63, 1]
    const ts = p.small ? 0.36 : 0.42
    pl.text("mono", "NIGHTMAIL BROADCAST SYSTEM", p.sx + 4, cy - 8, ts, 0, dimc)
    pl.text("mono", "CH 03 · COLOUR", p.sx + 4, cy + 9, ts * 0.82, 0, [0.48, 0.46, 0.42, 1])
    if (!p.small) for (let i = 0; i < 9; i++) pl.seg(hx - 36 + i * 9, cy - 13, hx - 36 + i * 9, cy + 13, 1.2, { col: [0, 0, 0, 0.9] })
    const kx = p.knob.x
    const kr = p.knob.r
    knob.v += (((state === "idle" ? -0.7 + Math.sin(now / 420) * 0.07 : 0.85) - knob.a) * 190 - knob.v * 16) * dt
    knob.a += knob.v * dt
    const pulse = state === "idle" ? 0.6 + 0.4 * Math.sin(now / 300) : 1
    const lab = state === "idle" ? "TUNE IN" : "ON AIR"
    const ls = ts * 1.3
    const lw = pl.measure("mono", lab, ls)
    pl.text("mono", lab, kx - kr - 22, cy, ls, 1, [1, 0.65, 0.19, 1])
    pl.ellipse(kx - kr - 34 - lw, cy, 3.6, 3.6, { col: [1, 0.55, 0.15, pulse] })
    pl.glow(kx - kr - 34 - lw, cy, 18, 18, [1, 0.55, 0.15, 0.6 * pulse])
    for (let i = 0; i < 9; i++) {
      const a = -2.3 + (i / 8) * 2.9
      pl.seg(kx + Math.cos(a) * (kr + 5), cy + Math.sin(a) * (kr + 5), kx + Math.cos(a) * (kr + 9), cy + Math.sin(a) * (kr + 9), 0.8, { col: [0.6, 0.57, 0.52, 1] })
    }
    pl.ellipse(kx, cy, kr, kr, { ink: true, rim: [0.8, 0.76, 0.7, 1], pad: 6 })
    pl.ellipse(kx, cy, kr * 0.62, kr * 0.62, { col: [0.1, 0.1, 0.1, 1] })
    pl.seg(kx + Math.cos(knob.a) * kr * 0.2, cy + Math.sin(knob.a) * kr * 0.2, kx + Math.cos(knob.a) * kr * 0.86, cy + Math.sin(knob.a) * kr * 0.86, 1.8, { col: [1, 0.65, 0.19, 1] })
    lists.over.reset()
    pageU.set(plain(W, H, t))
    overU.set(plain(W, H, t))

    const tube = show.tube
    crtU.set([p.sx, p.sy, p.sw, p.sh, W, H, t, tube.power, tube.tilt, tube.tracking, tube.warp, 0, tube.bright, tube.roll, tube.static, 30])
    const P = show.post
    const sh = P.shake * 9
    postU.set([gpu.pw, gpu.ph, t, dpr, Math.sin(t * 73) * sh, Math.cos(t * 59) * sh, P.shake * 2.5, P.flash, 0, 0, 0, 0, 0.85, 0.035, 0.3, 0])

    gpu.frame({
      feed: { list: lists.feed, cams },
      bg: { list: lists.bg, uniforms: bgU },
      fg: { list: lists.fg, uniforms: fgU },
      page: { list: lists.page, uniforms: pageU },
      over: { list: lists.over, uniforms: overU },
      quads,
      nQuads,
      feedU,
      crt: crtU,
      post: postU,
      bloomThreshold: 0.62,
    })
  }
  requestAnimationFrame(frame)
}

boot().catch((e) => {
  window.__bootErr = String(e.stack || e)
  console.error(e)
})
