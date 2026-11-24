// The comparison pages' sounds (board.tsx, features.tsx, splitflap.tsx): small, physical, made here with the Web Audio
// API from short bursts of filtered noise and decaying tones, so there are no files to load. Nothing plays until the visitor
// does something: the context is made on the first press or key, and only the handlers of a press, a key or the fader
// call play(); scrolling, loading and things coming into view never do. Nothing plays in a hidden tab. Every sound
// goes through one master level and a soft clipper (transparent below about -6 dBFS), at most VOICES at once, each
// name no faster than its own minimum gap and each new one quieter by how many are already sounding, so a dragged
// fader is a soft riffle, not a pile-up. The board's flaps have their own voice (flap, below). The switch (SoundSwitch, board.tsx) is remembered; it
// starts off for someone who asks for reduced motion, and the first sound after a load is played softer.

export type Sound = 'tick' | 'bump' | 'key' | 'cord' | 'creak' | 'bolt' | 'drop' | 'tags' | 'stamp' | 'paper'

const KEY = 'nightmail-sound', VOICES = 12, LEVEL = .9
/** The least time between two of one sound, in seconds. */
const GAP: Partial<Record<Sound, number>> = { tick: .03, creak: .4, tags: .15, paper: .12 }
/** Each sound's level, in dB, so they peak alike (measured, rendered offline): about -16 dBFS for the key, the stamp,
 *  the drop and the stops, -18 to -20 for the little ones, the detent tick lower at -26. */
const TRIM: Record<Sound, number> = { tick: -1, bump: -12, key: -13, cord: 0, creak: 20, bolt: 2, drop: -12, tags: 1, stamp: -12, paper: 0 }

type Listener = (on: boolean) => void
let ctx: AudioContext | null = null, out: GainNode | null = null, noise: AudioBuffer | null = null
let voices = 0, softUntil = -1
const last = new Map<Sound, number>(), listeners = new Set<Listener>()

const stored = () => { try { return localStorage.getItem(KEY) } catch { return null } }
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
/** Whether sounds are on: as the visitor last left the switch, else on, unless they ask for reduced motion. */
export function soundOn() {
  if (typeof window === 'undefined') return false
  const value = stored()
  return value === 'on' || (value !== 'off' && !reduced())
}
export function setSoundOn(on: boolean) {
  try { localStorage.setItem(KEY, on ? 'on' : 'off') } catch { /* The switch still works for this visit. */ }
  for (const listener of listeners) listener(on)
}
export function onSoundChange(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener) } }

// The context, its limiter and a second of noise, made in the first gesture (a browser allows sound from then on).
function context() {
  if (ctx) return ctx
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Context) return null
  ctx = new Context()
  // (A soft clipper, not a compressor: a compressor's automatic make-up gain would lift everything.)
  const clip = ctx.createWaveShaper(), curve = new Float32Array(1025)
  for (let i = 0; i < curve.length; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * 1.2) / Math.tanh(1.2) }
  clip.curve = curve
  out = ctx.createGain(); out.gain.value = LEVEL
  out.connect(clip); clip.connect(ctx.destination)
  noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
  const data = noise.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  document.addEventListener('visibilitychange', () => { if (document.hidden) void ctx?.suspend(); else void ctx?.resume() })
  return ctx
}
/** The context is made just after the first press is painted, not in the press itself (opening the audio device can
 *  hold the page up for a moment), then what asked for it plays. */
let waking = false
function later(then?: () => void) {
  if (waking || typeof requestAnimationFrame !== 'function') return
  waking = true
  requestAnimationFrame(() => setTimeout(() => { waking = false; if (context()?.state === 'suspended') void ctx!.resume(); then?.() }, 0))
}
/** Have the sound ready for what a press sets off a frame or two later (board.tsx: the board's flaps). */
export function wake() { if (!soundOn()) return; if (ctx) void ctx.resume(); else later() }

// The two things every sound is made of. A burst: noise through a band-pass filter at `freq`, rising in a millisecond
// and dying away over `decay` seconds. A tone: a sine falling from `from` to `to` Hz, dying away the same way.
type Voice = { at: number; gain: number }
function envelope(c: AudioContext, at: number, gain: number, decay: number) {
  const g = c.createGain()
  g.gain.setValueAtTime(0, at)
  g.gain.linearRampToValueAtTime(gain, at + .0015)
  g.gain.exponentialRampToValueAtTime(.0001, at + decay)
  return g
}
function burst(c: AudioContext, bus: AudioNode, { at, gain }: Voice, freq: number, q: number, decay: number) {
  const src = c.createBufferSource(), filter = c.createBiquadFilter(), g = envelope(c, at, gain, decay)
  src.buffer = noise; filter.type = 'bandpass'; filter.frequency.value = freq; filter.Q.value = q
  src.connect(filter).connect(g).connect(bus)
  src.start(at, Math.random() * .8, decay + .02)
}
function tone(c: AudioContext, bus: AudioNode, { at, gain }: Voice, from: number, to: number, decay: number) {
  const osc = c.createOscillator(), g = envelope(c, at, gain, decay)
  osc.frequency.setValueAtTime(from, at); osc.frequency.exponentialRampToValueAtTime(to, at + decay)
  osc.connect(g).connect(bus)
  osc.start(at); osc.stop(at + decay + .02)
}
const jitter = (n: number, spread = .25) => n * (1 - spread + Math.random() * 2 * spread)
/** The first sound after a load, and whatever sounds with it in its first half second, is softer, so it doesn't startle. */
const first = (t: number) => { if (softUntil < 0) softUntil = t + .5; return t < softUntil ? .5 : 1 }

/** Each sound: what it is made of, and how long it lasts (for the voice count). */
const SOUNDS: Record<Sound, (c: AudioContext, bus: AudioNode, t: number) => number> = {
  // A detent: one tiny click.
  tick: (c, bus, t) => { burst(c, bus, { at: t, gain: .22 }, 4200, 3, .006); return .02 },
  // The fader's cap on its end stop: a soft, low knock.
  bump: (c, bus, t) => { tone(c, bus, { at: t, gain: .55 }, 150, 70, .09); burst(c, bus, { at: t, gain: .25 }, 700, .9, .05); return .1 },
  // The paper key going down: a low, padded thump and the paper under the finger.
  key: (c, bus, t) => { tone(c, bus, { at: t, gain: .6 }, 120, 62, .13); burst(c, bus, { at: t, gain: .22 }, 1300, .8, .05); burst(c, bus, { at: t + .07, gain: .1 }, 2400, 1.2, .03); return .15 },
  // The lamp's pull cord: the switch going over and back, with a little ring of its metal.
  cord: (c, bus, t) => {
    burst(c, bus, { at: t, gain: .45 }, 2600, 4, .01); tone(c, bus, { at: t, gain: .06 }, 3300, 3200, .07)
    burst(c, bus, { at: t + .055, gain: .3 }, 3100, 4, .008)
    return .1
  },
  // The shade on its cord as it swings: a short, dry creak (a fast run of tiny ticks through a resonant filter).
  creak: (c, bus, t) => {
    const ticks = 14
    for (let i = 0; i < ticks; i++) burst(c, bus, { at: t + i * (.012 + i * .0009), gain: .09 * Math.sin(Math.PI * (i + .5) / ticks) }, 900 + i * 25, 9, .012)
    return .27
  },
  // A bolt a quarter turn: a gritty little ratchet, two clicks.
  bolt: (c, bus, t) => { burst(c, bus, { at: t, gain: .3 }, 3600, 5, .008); burst(c, bus, { at: t + .03, gain: .22 }, 3300, 5, .008); tone(c, bus, { at: t, gain: .04 }, 5200, 4800, .05); return .08 },
  // A panel slipping on its last bolt: a scrape of concrete and a heavy knock.
  drop: (c, bus, t) => { burst(c, bus, { at: t, gain: .22 }, 520, .7, .16); tone(c, bus, { at: t + .1, gain: .65 }, 95, 48, .2); burst(c, bus, { at: t + .1, gain: .28 }, 380, .8, .09); return .32 },
  // Paper tags swinging against each other: three soft flicks.
  tags: (c, bus, t) => { for (let i = 0; i < 3; i++) burst(c, bus, { at: t + i * .045 + Math.random() * .01, gain: .12 }, jitter(2600), 1, .025); return .16 },
  // A rubber stamp coming down: a short thump and a tap.
  stamp: (c, bus, t) => { tone(c, bus, { at: t, gain: .55 }, 140, 80, .08); burst(c, bus, { at: t, gain: .3 }, 1600, 1.2, .03); return .1 },
  // An envelope sliding off and landing: a brush of paper.
  paper: (c, bus, t) => { burst(c, bus, { at: t, gain: .14 }, 1900, .6, .12); burst(c, bus, { at: t + .1, gain: .2 }, 1200, 1, .04); return .16 },
}

/** Play a sound now, if sounds are on, the tab is shown, there is a free voice and it isn't too soon after the last
 *  of its kind. Returns whether it played. */
export function play(name: Sound) {
  if (typeof window === 'undefined' || !soundOn() || document.hidden) return false
  if (!ctx) { later(() => play(name)); return false }
  const c = ctx
  if (!out) return false
  if (c.state === 'suspended') void c.resume()
  const now = c.currentTime, gap = GAP[name] ?? .06
  if (voices >= VOICES || now - (last.get(name) ?? -1) < gap) return false
  // (A tick close on the heels of the last is lighter: a fader dragged fast is a soft riffle.)
  const busy = name === 'tick' && now - (last.get(name) ?? -1) < .16
  last.set(name, now)
  const bus = c.createGain()
  bus.gain.value = first(now) * (busy ? .4 : 1) / Math.sqrt(1 + voices) * 10 ** (TRIM[name] / 20)
  bus.connect(out)
  const length = SOUNDS[name](c, bus, now + .005)
  voices++
  window.setTimeout(() => { voices--; bus.disconnect() }, (length + .1) * 1000)
  return true
}

// The board's flaps (splitflap.tsx): one tick for each flap that lands, at the moment it lands, so a change sounds as it
// moves: a patter as many tiles start, thinning to the last few clicks as they settle. A bigger tile's tick is played
// lower and slower, so it is fuller (the price tiles' at 0.7 of the small figures' pitch, the name's at 0.86), and a
// little louder. A tick is one of a handful of
// flaps made once, when the first is needed, from three layers of noise, each through its own resonant filter and
// envelope: the leaf's edge striking its stop (a 2.5 to 4 kHz click, 2 ms), the leaf itself (around 1 kHz, 10 ms, the
// loudest) and a faint low body under them (around 280 Hz, 16 ms), so it is papery rather than clicky, with no motor; some flaps
// bounce once. Each tick takes one at random at a slightly different pitch and level. They are at most one each 4 ms
// (flaps landing together are one tick, a little louder) and FLAP_VOICES at once, each quieter as the board gets busier
// (by a running count of ticks a second), and they sit under the other sounds.
const FLAP_VOICES = 40, FLAP_LEVEL = .035, FLAP_SLOT = .004
/** The flaps: [click Hz, leaf Hz, body Hz, bounce s (0: none)]. */
const FLAPS: [number, number, number, number][] = [[3300, 1150, 290, .008], [2800, 980, 250, 0], [3800, 1350, 330, .007], [2500, 900, 230, .011], [3500, 1250, 270, 0], [3050, 1080, 310, .009]]
let flapSounds: AudioBuffer[] | null = null, flapVoices = 0, rate = 0, rateAt = 0
/** The ticks to come, by their 4 ms slot: their level, and how many flaps land in them. */
const slots = new Map<number, { gain: GainNode; level: number; n: number }>()

function flapSound(c: BaseAudioContext, [click, leaf, body, bounce]: (typeof FLAPS)[number]) {
  const sr = c.sampleRate, n = Math.round(sr * .07), buffer = c.createBuffer(1, n, sr), data = buffer.getChannelData(0), layer = new Float32Array(n)
  // Noise through a state-variable filter (its band-pass or its low-pass), in an envelope that rises in half a
  // millisecond and decays over `decay`, normalised and added in at `gain`.
  const add = (fc: number, damping: number, decay: number, gain: number, delay: number, low = false) => {
    const f = 2 * Math.sin(Math.PI * fc / sr)
    let lo = 0, bp = 0, peak = 0
    for (let i = 0; i < n; i++) {
      lo += f * bp
      const hi = Math.random() * 2 - 1 - lo - damping * bp
      bp += f * hi
      const t = i / sr - delay
      layer[i] = t < 0 ? 0 : (low ? lo : bp) * Math.exp(-t / decay) * Math.min(1, t / .0005)
      peak = Math.max(peak, Math.abs(layer[i]!))
    }
    for (let i = 0; i < n; i++) data[i]! += layer[i]! / (peak || 1) * gain
  }
  add(click, .8, .0022, .55, 0)
  add(leaf, 1.5, .01, .8, .0006)
  add(body, 1.3, .016, .2, .001, true)
  if (bounce) add(click * 1.08, .9, .0018, .18, bounce)
  // (All of it through a gentle low-pass at 4.5 kHz: no hiss above the knock.)
  const f = 2 * Math.sin(Math.PI * 4500 / sr)
  let lo = 0, bp = 0, peak = 0
  for (let i = 0; i < n; i++) { lo += f * bp; bp += f * (data[i]! - lo - 1.2 * bp); data[i] = lo }
  for (const v of data) peak = Math.max(peak, Math.abs(v))
  for (let i = 0; i < n; i++) data[i]! *= .9 / peak
  return buffer
}

/** A flap of the board landing `ms` from now, on a tile whose tick is at `pitch` (1 for the small tiles, lower for
 *  bigger ones). Returns whether it ticks. */
export function flap(ms: number, pitch = 1) {
  if (typeof window === 'undefined' || !soundOn() || document.hidden) return false
  if (!ctx) { later(); return false }
  const c = ctx
  if (!out) return false
  if (c.state === 'suspended') void c.resume()
  const t = c.currentTime + .01 + Math.max(0, ms) / 1000, slot = Math.round(t / FLAP_SLOT), same = slots.get(slot)
  if (same) { same.n++; same.gain.gain.value = same.level * Math.min(1.6, Math.sqrt(same.n)); return true }
  if (flapVoices >= FLAP_VOICES) return false
  flapSounds ??= FLAPS.map(f => flapSound(c, f))
  // How busy the board is: ticks a second, over the last tenth of a second or so.
  rate = rate * Math.exp(-Math.max(0, t - rateAt) / .15) + 1 / .15; rateAt = Math.max(rateAt, t)
  const src = c.createBufferSource(), g = c.createGain()
  src.buffer = flapSounds[Math.floor(Math.random() * flapSounds.length)]!
  src.playbackRate.value = pitch * (.9 + Math.random() * .22)
  const level = FLAP_LEVEL * first(t) * (.7 + Math.random() * .3) * (2 - pitch) / Math.sqrt(1 + rate / 30)
  g.gain.value = level
  src.connect(g).connect(out)
  src.start(t)
  flapVoices++
  slots.set(slot, { gain: g, level, n: 1 })
  src.onended = () => { flapVoices--; g.disconnect(); slots.delete(slot) }
  return true
}
