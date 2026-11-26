# The commercial's sound and fonts: where they came from

The files are in `public/` (served at `/commercial/` in a build that has the television). None of the sound is a
recording or a sample of someone else's work.

## Sound (`public/audio`)

| Files | What they are | Made with |
| --- | --- | --- |
| `s0`–`s8`, `callnow`, `now` | the announcer's lines; `callnow` and `now` are cut from the full take of `s8` | ElevenLabs text to speech |
| `manifest.json` | each clip's length, and when each word of the announcer's is said | ElevenLabs Scribe (the word timings) |
| `organ`, `laugh`, `ooh`, `screech`, `doorbang`, `crunch`, `thud0`–`thud3` | a chapel organ, the studio audience, a tire screech, a door, a hat being crushed, four heavy thuds | ElevenLabs Sound Effects |
| `cut`, `engine`, `muffle` | the click as the sound cuts, a car's engine, a phone buzzing under a hymn book | ffmpeg (synthesised, or filtered from another clip here) |
| `bed`, `jingle`, `bots`, `buzz`, `buzz_storm`, `cheer`, `ding`, `kaching`, `pager`, `pop`, `sent`, `snore`, `sparkle`, `tap`, `typing`, `whoosh` | the music bed, the jingle and the small effects | made for the first version of the commercial, before it was in this repository; its history here does not say with which tool |

Terms for the ElevenLabs files: they were generated on Anomaly's account, and ElevenLabs' terms of use
(https://elevenlabs.io/terms-of-use) govern what its tools generate; they are in the repository for the commercial on
those terms.

## Fonts (`public/fonts`)

Bungee and IBM Plex Mono, Latin subsets, under the SIL Open Font License: their licences are beside them
(`bungee-LICENSE.txt`, `ibm-plex-mono-LICENSE.txt`). Inter, also under the SIL Open Font License: its licence is in
`app/public/fonts`.
