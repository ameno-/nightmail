// The machine's sound. Off until asked for (the header's button): the first press makes the audio context, as a
// browser requires, and fetches the one file every effect is in (sounds.mp3: about 290 KB, mono, never loaded
// otherwise). The effects were made with ElevenLabs' sound model and packed by a script (the takes, the script and
// its table are kept outside the repository, with the page's other plans).
import url from './sounds.mp3?url'

/** Where each effect is in the file: its start and its length, in seconds. (`hum` and `strain` loop.) */
const AT = { hum: [0.200, 7.750], strain: [8.470, 5.750], drop: [14.540, 0.599], scan: [15.259, 0.251], tube: [15.631, 1.000], chute: [16.751, 0.364], slide: [17.235, 1.862], land: [19.217, 0.530], cable: [19.867, 1.181], arm: [21.168, 1.200], seat: [22.488, 0.680], dock: [23.288, 0.698], wake: [24.106, 0.880], laser: [25.106, 0.458], cannon: [25.684, 0.407], steam: [26.211, 1.268], burst: [27.600, 2.103], paper: [29.823, 2.715], rebuild: [32.659, 1.585], lamp: [34.363, 0.680], switch: [35.164, 0.106], press: [35.390, 0.299] } as const
export type Cue = keyof typeof AT
// How loud each is against the rest (the file has every one at full level), and the least time between two of the
// same, in seconds: a machine that sorts ten letters a second must not play ten scans a second.
const LEVEL: Record<Cue, number> = { hum: .5, strain: .3, drop: .3, scan: .16, tube: .22, chute: .22, slide: .55, land: .7, cable: .35, arm: .3, seat: .4, dock: .5, wake: .35, laser: .32, cannon: .45, steam: .28, burst: 1, paper: .7, rebuild: .55, lamp: .3, switch: .45, press: .5 }
const APART: Partial<Record<Cue, number>> = { drop: .09, scan: .11, tube: .16, chute: .11, steam: .3, laser: .09, cannon: .12, seat: .1 }
/** No more than this many effects at once: past it, new ones are dropped (the burst and its paper always play). */
const VOICES = 14

export function createSound() {
  let ctx: AudioContext | null = null, buffer: AudioBuffer | null = null, out: GainNode | null = null, on = false, shown = true, voices = 0
  const last: Partial<Record<Cue, number>> = {}, loops: Partial<Record<Cue, { source: AudioBufferSourceNode; gain: GainNode }>> = {}, wanted: Partial<Record<Cue, number>> = {}
  const level = () => on && shown && !document.hidden ? .8 : 0
  /** Up or down over a fifth of a second, never a click. */
  const fade = () => { if (ctx && out) out.gain.setTargetAtTime(level(), ctx.currentTime, .06) }
  const onHidden = () => { fade(); if (ctx && on) void (document.hidden ? ctx.suspend() : ctx.resume()) }

  function play(name: Cue, x = 0, gain = 1) {
    if (!ctx || !buffer || !out || !on || !shown || ctx.state !== 'running') return
    const now = ctx.currentTime, gapped = APART[name]
    if (gapped && now - (last[name] ?? -1) < gapped) return
    if (voices >= VOICES && name !== 'burst' && name !== 'paper') return
    last[name] = now
    const [start, length] = AT[name], source = ctx.createBufferSource(), level = ctx.createGain(), pan = ctx.createStereoPanner()
    // (No two of the same sound quite alike: a few per cent either way in pitch and level.)
    source.buffer = buffer; source.playbackRate.value = gapped ? .94 + Math.random() * .12 : 1
    level.gain.value = LEVEL[name] * Math.min(1, Math.max(0, gain)) * (gapped ? .8 + Math.random() * .2 : 1); pan.pan.value = Math.max(-1, Math.min(1, x)) * .7
    source.connect(level).connect(pan).connect(out)
    voices++; source.onended = () => { voices--; pan.disconnect() }
    source.start(now, start, length)
  }
  /** A loop's level, 0 for off: it comes and goes over `over` seconds. */
  function loop(name: 'hum' | 'strain', gain: number, over = .5) {
    wanted[name] = gain
    if (!ctx || !buffer || !out) return
    let held = loops[name]
    if (!held) {
      if (!gain) return
      const [start, length] = AT[name], source = ctx.createBufferSource(), level = ctx.createGain()
      source.buffer = buffer; source.loop = true; source.loopStart = start; source.loopEnd = start + length; level.gain.value = 0
      source.connect(level).connect(out); source.start(ctx.currentTime, start)
      held = loops[name] = { source, gain: level }
    }
    held.gain.gain.setTargetAtTime(LEVEL[name] * gain, ctx.currentTime, over / 3)
    if (!gain) { const gone = held; delete loops[name]; gone.source.stop(ctx.currentTime + over * 2); gone.source.onended = () => gone.gain.disconnect() }
  }

  return {
    play, loop,
    /** Switch the sound on or off. On, the first time: from the press itself (a browser makes no sound before one). */
    async set(next: boolean) {
      on = next
      if (!next) { fade(); return }
      if (!ctx) {
        ctx = new AudioContext({ latencyHint: 'interactive' })
        // (Everything goes through one limiter: the burst is many things at once.)
        const limit = ctx.createDynamicsCompressor(); limit.threshold.value = -10; limit.knee.value = 8; limit.ratio.value = 8; limit.attack.value = .003; limit.release.value = .2
        out = ctx.createGain(); out.gain.value = 0; out.connect(limit).connect(ctx.destination)
        document.addEventListener('visibilitychange', onHidden)
      }
      void ctx.resume(); fade()
      if (!buffer) {
        const context = ctx, data = await (await fetch(url)).arrayBuffer(), decoded = await context.decodeAudioData(data)
        if (ctx !== context) return
        buffer = decoded
        for (const name of ['hum', 'strain'] as const) if (wanted[name]) loop(name, wanted[name]!)
      }
      if (on) play('switch')
    },
    /** Whether the machine is on the screen: off it, it makes no sound. */
    setShown(next: boolean) { shown = next; fade() },
    destroy() { document.removeEventListener('visibilitychange', onHidden); void ctx?.close(); ctx = null; buffer = null; out = null },
  }
}
