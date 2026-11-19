// Prints when each beat starts (seconds), from the clip durations in the manifest.
import { Show } from "../src/show.js"
const m = await Bun.file(new URL("../../public/commercial/audio/manifest.json", import.meta.url)).json()
const s = new Show({ atlas: null, audio: null })
s.started = true
s.build(m.dur, m.words)
console.log(Object.entries(s.marks).map(([k, v]) => `${k}=${(v as number).toFixed(1)}`).join(" "), "end=" + s.length.toFixed(1))
