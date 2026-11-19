# Nightmail · the commercial, and Doug

A concept for Nightmail's landing page, served at `/commercial/` (public, linked from nowhere,
`noindex`). The whole page is one 1970s television set in a concrete wall. Turn the dial and a loud
pitchman sells Nightmail's real features to businesses, in saturated colour. Intercut with him is
black-and-white footage of Doug, who bought one garden gnome from Gnome Depot, and on whom Gnome
Depot then uses every feature the pitchman names.

It is not a dashboard page: it shares no code, styles or sign-in with the dashboard, and
[In this repository](#in-this-repository) says how it is built and served.

## The show

Rules of the story:

- **The pitchman never mentions Doug.** It is just a commercial. The one fourth-wall break is in
  beat 4: in the pause he turns to the footage and says, softly, "We saw you open that."
- **One storyline.** Every email is Gnome Depot's, about the one gnome. The gnome (red hat, the
  only red thing besides the badge) turns up in every shot after it is delivered.
- **It only gets worse.** Earlier emails never stop: they keep arriving as one-line banners under
  the ones Doug is meant to read. The badge on his mail app only goes up
  (0 → 1 → 5 → 37 → 212 → ~400 → 1,040 → 9,000 → 99,999+). The dings go from one, to a rhythm, to
  constant, to a roar. Everything Doug tries makes more.

The commercial is the master clock (about 55 seconds of it; the show runs about 65 with the fight
and the test card). Its clips play back to back and never wait for Doug; every beat cuts to a new
shot as its clip starts.

| beat | the pitchman says | the footage | badge |
| --- | --- | --- | --- |
| standby | (test card) "PLEASE STAND BY" | Doug on his couch with his phone | |
| 0 | "Folks! Got customers? Then you send email! Meet NIGHTMAIL!" | on "customers?" the set's monitor rolls in: the couch. Over the jingle Doug boops his phone, "Order placed ✓ · 1 × Garden Gnome", and does a happy hop. | 0 |
| 1 | "One line of code: receipt, SENT! Accepted in a TENTH of a second!" | one ding: "Your receipt · $84.00". He smiles. It is the only email he is glad to get. | 1 |
| 2 | "Twenty cents per thousand! At that price, why send just ONE?" | ding, ding, ding, ding: shipped, out for delivery, delivered (the gnome pops up beside the couch), "How are you enjoying your gnome?" His smile goes. He flips the phone face down. | 5 |
| 3 | "No per-contact pricing! Put EVERYBODY on the newsletter! Schedule it for any time!" | the bedroom, 3:00 AM. The face-down phone has been buzzing. "Gnome Depot Weekly · Hi DOUG!" whites out the room and two eyes open; DAILY has him bolt upright; then HOURLY. | 37 |
| 4 | "And you see EVERYTHING! Delivered! Opened! Clicked! … We saw you open that." | the bathroom. Doug, chin-deep in bubbles with a rubber duck, opens the newsletter to hunt for the unsubscribe link: he scrolls all the way down and gets it with his forehead. ✓ DELIVERED ✓ OPENED ✓ CLICKED are stamped on the tub. In the pause everything stops (the only 3.5 s in the show with no mail), the pitchman turns to the footage and says it. Doug freezes; his eyes and the duck go to the pitchman; he sinks to his eyes. | 212 |
| 5 | "But wait, there's MORE! Customers write back? Answer them, INSTANTLY!" | a first date. "Unsubscribed from HOURLY ✓. You've been moved to Gnome Depot MINUTELY." His date finds the ceiling interesting while he pecks out "please stop" with his forehead. The message leaves his phone, crosses out of the footage and lands on the INBOX board over the pitchman's head ("1 NEW · FROM: A CUSTOMER"), which the pitchman could not be prouder of. On "INSTANTLY!" the answers shoot back the other way into his phone: 10% off his next gnome, and "You might also like: Gnome (Large)". | ~400 |
| 6 | "Post every reply to Slack! The WHOLE TEAM can answer!" | the board becomes #CUSTOMER-REPLIES with his "please stop" posted in it. The footage splits: six of Gnome Depot's staff, in company gnome hats, each answer in their own picture ("lol", "who's Doug?", "Doug!! 👋", "+1 please stop", "can we add him to VIP?", "Reply-all: please stop replying all."), and each answer flies out of its picture to his phone. His date leaves, sideways. | 1,040 |
| 7 | "Angry customer? The AI knows! NINETY-SEVEN PERCENT! Send them MORE coupons!" | a funeral; he brought the gnome. The phone buzzes, muffled, under a hymn book. He throws the book, drums "STOP EMAILING ME" with his forehead, and the AI boxes everyone: SAD 99%, SAD 98%, CALM 100% (the gnome), ANGRY 97%. A moment of silence, then three coupons at once at full volume. He notices the "via NIGHTMAIL" in the corner of every one, and looks at the pitchman. | 9,000 |
| 8 | "Plug in your AI agents! Hundreds of robots, sending email, ALL NIGHT LONG! NIGHTMAIL! Call n—" | still at the funeral: a robot (a metal bean with an antenna and a screen for a face) pops up from behind the casket and sends him "Doug, I'm an AI agent. I'll be in touch." Then another ("A haiku about your gnome"), then one in the pew right next to him ("Re: Re: Re: please stop"), then two rows of them at the back, every one of them sending. That does it: he leaves. He drives, eyes narrowed, past NIGHTMAIL STUDIOS 2 MI, 1 MI, EXIT NOW, with robots in the back seat, on the roof and running behind, slapping mail onto the windshield. He screeches up to a building with a red ON AIR sign; the car door does not survive, and the horde pours in behind him. Back in the commercial at full tilt, the door at the back of the set bursts open: "DOUG — ACTUAL RECIPIENT". On "Call n—" he launches (no arms) and takes the pitchman out of frame. | 99,999+ |
| after | (the audio has cut dead) | an empty set. Just past the left edge of the frame, a cartoon fight cloud: POW, BONK, OOF, stars, envelopes. The bowler sails across. The camera gets knocked, and goes over. PLEASE STAND BY. Silence. One ding: "That looked stressful, Doug. Here's 40% off your next gnome!" Then it resets to standby. | 99,999+ |

No arms on anyone: Doug works his phone by leaning over and putting his forehead on it.

The band along the bottom only ever shows the line being spoken, with the fine print that keeps
that line honest under it (accepted means queued; $0.20 per 1,000 sent or received, prepaid, 3,000
+ 3,000 free a month; new workspaces start at 100 recipients a day; open tracking isn't always
accurate; forwarding needs the recipient's OK; AI scores can be wrong, opt-in, $0.10 per 1,000;
hosted limits apply).

## How it's built

Everything is drawn live in WebGPU on one canvas; the DOM holds only the wordmark, the sound
toggle and two invisible click targets (the glass and the dial).

- `src/gpu.js`: the renderer, four layers back to front. (1) Each shot of Doug draws its scene
  into its own tile of one feed texture. (2) The broadcast: the studio, then the footage tiles
  through the `FEED` shader (cover crop, zoom, black-and-white stock with grain, line noise and a
  hum bar, a moonlit tint for night, a flicker of static on every cut; only red survives), then
  the pitchman and the type. (3) The page: concrete, the TV housing, and the broadcast on the tube
  through the `CRT` shader (curved glass, overscan, scanlines, chroma fringe, and a tilt for when
  the camera gets knocked). (4) Bloom, grain and shake.
- `src/shaders.js`: the instanced SDF "uber" shader from Hex: flat and glossy
  shapes, glows, starbursts, atlas sprites and the glossy bean characters. Doug is exactly Hex's
  bean; the pitchman is the same bean in a brown bowler with a red band.
- `src/show.js`: the timeline, the broadcast layouts (`solo`, `monitor`, `big`, `split`,
  `takeover`, `studio`, each with a portrait version where the pitchman sits under the footage),
  cuts, the six-up office grid, the last shot (the door, the tackle, the fight cloud, the hat), the
  band of kinetic type, the studio's amber readout, and Doug's phone: the banners at the top left
  of the footage (the ones he is meant to read pinned on top, the ones that never stop piling up
  beneath), the mail app and its badge at the top right, and the stream of dings.
- `src/scenes.js`: what each shot shows, in a 640×480 space, in greys: Doug, his phone, the gnome
  and one prop or setting made of a shape or two.
- `src/atlas.js`: every email Gnome Depot sends, Bungee kinetic type, fine print and glyph sets,
  drawn once with Canvas 2D into one texture.
- `src/audio.js`: Web Audio. The broadcast bus (announcer, jingle, bed, studio audience; the
  announcer ducks the bed and drives the pitchman's mouth) and the footage bus.

### Timing is data

Cues are looked up by the word the announcer says, not by a time: `w("s4", s4, "we")` is when he
says "We" in clip `s4`, from the Scribe timings in `public/commercial/audio/manifest.json`. The
band's lines are `[word, chyron]` pairs, so a new recording of the same script retimes the whole
show through its manifest. Events that depend on each other are clamped in order (he can't click
before he opens). `bun run commercial:smoke` (from `app/`) runs the whole show without a GPU, wide
and tall, and fails on an exception, a NaN, an overflowing list or a missing sprite.

WebGPU only; without it the page says so.

## Audio

The announcer is the v3 script: clips `s0`–`s8`, with ElevenLabs Scribe word timings in the
manifest. The clips play with a 0.2 s breath between them and the jingle (cut to 3.3 s) after
`s0`. `s4` has the pause and the quiet line in it; `s8` is cut off on the "n" of "Call now". The
cut click, the dial, the car's engine and the phone under the hymn book are made with ffmpeg; a
chapel organ, a studio audience, a tire screech, a door bang and five seconds of cartoon fight are
ElevenLabs sound effects. At "Call n—" everything stops dead; the fight is the only sound until
the test card, which is silent until its one ding.

## In this repository

| | |
| --- | --- |
| `app/commercial/index.html` | the page |
| `app/commercial/src/` | the engine: plain JavaScript modules and two stylesheets |
| `app/commercial/scripts/` | `smoke.ts` and `marks.ts` (when each beat starts), run with bun |
| `app/public/commercial/audio/` | the clips and `manifest.json` |
| `app/public/commercial/fonts/` | Inter, Bungee and IBM Plex Mono (Latin, SIL OFL; licences alongside, Inter's in `app/public/fonts`) |
| `app/public/commercial/brand/` | the wordmark in the corner |

```sh
cd app
bun run dev                    # http://127.0.0.1:5173/commercial/ (?autoplay starts without a click, ?t=24 jumps in)
bun run commercial:smoke       # the whole show, no GPU; CI's build job runs it
bun commercial/scripts/marks.ts
```

`?autoplay&freeze&t=NN` freezes the show at NN seconds for screenshots and `?debug` writes state to
`body[data-dbg]`. A headless browser without a GPU shows only the "needs WebGPU" line, so look at
it in a real browser.

**Build.** `app/vite.config.ts` takes `src/main.js` as a second entry next to the dashboard's and
writes `dist/commercial/index.html` with the built names (`assets/commercial-<hash>.js` and
`.css`). No dashboard page loads either file, and the dashboard's own files are byte for byte what
they are without it. Everything else is served as written from `public/commercial`, so the engine
names those files by their full path (`/commercial/audio/…`).

**Serving.** Workers Assets and the Node server both answer `/commercial/` with the page (the
preview smoke checks it under workerd). It gets the dashboard's security headers from
`public/_headers`: no inline script, and same-origin audio, fonts and images. The two built files
are immutable like every file in `assets/`; the audio and fonts revalidate, because Cloudflare
reads only 100 cache rules and the dashboard's chunks need them (`asset-headers.ts`).

**Checks.** The copy lint and the density and CLS gates read the dashboard (`app/src` and its
pages), so none of them reads the show: its copy is a script, shouted on purpose.

**Changing the show.** It is developed as a standalone project and copied here: `src/`, the audio
and its manifest. Three lines of `src/main.js` differ from the standalone copy: it imports
`./fonts.css` instead of the `@fontsource` packages, `BASE` is `/commercial/`, and the mute choice
is stored as `nightmail.commercial.muted`. Run the smoke after copying.
