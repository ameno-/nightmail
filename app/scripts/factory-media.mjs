// Publishes the homepage's render sets to a stage's R2 media bucket (infra/pulumi: nightmail-<stage>-media, served at
// media.dev.nightmail.dev and media.nightmail.dev), so new or replacement segments go live without a deploy. A version
// holds both formats, the desktop's wide frame and the phone's tall one; the page reads factory/current.json there and
// plays its own format of the version it names (src/features/home/factory/manifest.ts).
//
//   node scripts/factory-media.mjs publish <dir> --stage dev [--dry-run] [--to <local dir>]
//     Uploads a web-layers folder as a new version: the desktop set at its top (manifest.json, boards/, a folder per
//     segment: the web-layers contract) and the phone set in its phone/ folder, each where there is one; then points
//     current.json at it. --to writes the same keys into a local folder instead (previews). Needs ffmpeg: each
//     segment's `labelLight` is measured from its foreground on the way (labelLights, below).
//   node scripts/factory-media.mjs promote <version> --stage production [--from <url>] [--dry-run]
//     Copies a version published on dev, read from dev's public host (--from, default media.dev.nightmail.dev) and
//     checked against its files.json, into the stage's bucket, then points current.json at it. Production is reached
//     only from CI: .github/workflows/media.yml.
//   node scripts/factory-media.mjs point <version> --stage <stage> [--dry-run]
//     Points current.json at a version already in the stage's bucket: rolling back is pointing at the previous one.
//
// Keys: factory/<version>/desktop/... and factory/<version>/phone/... (never written twice, cached for a year), with
// factory/<version>/files.json (every file's size and sha256) and each format's manifest.json; and factory/current.json
// (cached a minute): { version, formats: { desktop: <manifest>, phone: <manifest> } }. A version is the day and the start
// of a hash over its files' hashes and its manifests. Writes go through Wrangler (`r2 object put --remote`) in the
// stage's account: WRANGLER names the command (wwrangler on a machine logged in to the work account; CI passes
// api/node_modules/.bin/wrangler with its minted CLOUDFLARE_API_TOKEN). What still needs a deploy: a set whose frame,
// button, board or pipe geometry differs from the bundled manifest of its format, or whose first frame differs from the
// bundled poster (the page keeps its poster until then).
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// (infra/pulumi/index.ts creates these buckets and hosts.)
const STAGES = {
  dev: { account: 'd8e944f537ceef3f06a5bd3aec1d7a53', bucket: 'nightmail-dev-media', host: 'https://media.dev.nightmail.dev/' },
  production: { account: '15d29c8639fd3733b1b5486a2acfd968', bucket: 'nightmail-prod-media', host: 'https://media.nightmail.dev/' },
}
const IMMUTABLE = 'public, max-age=31536000, immutable', POINTER = 'public, max-age=60'
const TYPES = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.png': 'image/png', '.jpg': 'image/jpeg', '.m4a': 'audio/mp4', '.json': 'application/json' }
const type = path => TYPES[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream'
const VERSION = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/, NAME = /^[\w-]+$/

const [command, subject, ...rest] = process.argv.slice(2)
const flag = name => { const i = rest.indexOf(`--${name}`); return i < 0 ? undefined : rest[i + 1] }
const dry = rest.includes('--dry-run'), stage = STAGES[flag('stage')], to = flag('to')
const fail = message => { console.error(`factory-media: ${message}`); process.exit(1) }
if (!['publish', 'promote', 'point'].includes(command) || !subject) fail('usage: publish <dir> | promote <version> | point <version>, with --stage dev|production (see the top of this file)')
if (!stage && !to) fail('--stage dev|production')
const prefix = 'factory/'
/** Each format, and where its set is in a web-layers folder. */
const FORMATS = { desktop: '.', phone: 'phone' }
const PATH = /^(desktop|phone)\/[\w-]+\/[\w.-]+$/
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')

// The set's manifest, checked for what the page and this script rely on; and every file it needs, by its path in the set.
function check(manifest) {
  if (!Array.isArray(manifest?.segments) || !manifest.segments.length || !Array.isArray(manifest.boards?.y)) throw new Error('manifest.json has no segments or boards')
  for (const segment of manifest.segments) for (const name of [segment.name, segment.bg, segment.fg].filter(Boolean)) if (!NAME.test(name)) throw new Error(`bad segment name ${name}`)
  return manifest
}
function collect(dir) {
  const manifest = check(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')))
  const folders = new Set(manifest.segments.flatMap(segment => [segment.name, segment.bg ?? segment.name, segment.fg ?? segment.name]))
  const files = [...folders].sort().flatMap(folder => readdirSync(join(dir, folder)).filter(name => !name.startsWith('.') && statSync(join(dir, folder, name)).isFile()).sort().map(name => `${folder}/${name}`))
  for (const segment of manifest.segments) for (const need of [`${segment.bg ?? segment.name}/bg-1080.mp4`, `${segment.bg ?? segment.name}/bg-720.mp4`, ...['fg-1080.webm', 'fg-720.webm', 'fg-1080-hevc.mov', 'fg-720-hevc.mov'].map(file => `${segment.fg ?? segment.name}/${file}`)])
    if (!files.includes(need)) throw new Error(`${segment.name} needs ${need}`)
  const boards = manifest.boards.files ?? manifest.boards.y.map((_, k) => `boards/board${k}.png`)
  for (const board of boards) if (!existsSync(join(dir, board))) throw new Error(`missing ${board}`)
  labelLights(dir, manifest)
  return { manifest, files: [...files, ...boards].map(path => { const body = readFileSync(join(dir, path)); return { path, bytes: body.length, sha256: sha256(body) } }) }
}

// How lit the plinth's labels are in each segment, frame by frame. The page draws a tag of its own over each label it
// shows (factory-home.tsx) and dims it with the plinth: in x10's blackout the plinth goes dark while the hall's
// boardLight does not follow it, and in shift the hall dims while the plinth stays lit. Measured from the segment's
// foreground (fg-720.webm: the plinth is opaque there) over the labels the page tags, as a share of its first frame
// (every segment starts on the poster's picture); never above 1, and put on a segment only where the plinth dims.
function labelLights(dir, manifest) {
  const boxes = (manifest.pipes ?? []).flatMap(pipe => pipe.labelBox && pipe.visible !== false ? [pipe.labelBox] : [])
  if (!boxes.length) return
  // (The 720 files are the frame at 720 on its short side; the boxes' rows, and the columns they cover, at that size.)
  const scale = 720 / Math.min(manifest.width, manifest.height), width = Math.round(manifest.width * scale)
  const top = Math.round(Math.min(...boxes.map(box => box.y)) * scale), height = Math.round(Math.max(...boxes.map(box => box.y + box.h)) * scale) - top
  const columns = boxes.flatMap(box => { const from = Math.max(0, Math.round(box.x * scale)), to = Math.min(width, Math.round((box.x + box.w) * scale)); return Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i) })
  const measured = new Map()
  for (const segment of manifest.segments) {
    const fg = segment.fg ?? segment.name
    if (!measured.has(fg)) {
      let band
      try { band = execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, fg, 'fg-720.webm'), '-vf', `crop=${width}:${height}:0:${top},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }) }
      catch (error) { throw new Error(`measuring ${fg}/fg-720.webm's labels needs ffmpeg: ${error.message.split('\n')[0]}`) }
      const means = []
      for (let at = 0; at + width * height <= band.length; at += width * height) {
        let sum = 0
        for (let y = 0; y < height; y++) for (const x of columns) sum += band[at + y * width + x]
        means.push(sum / (columns.length * height))
      }
      const lights = means.map(mean => { const light = Math.round(mean / means[0] * 100) / 100; return light >= .97 ? 1 : light })
      measured.set(fg, lights.some(light => light < 1) ? lights : null)
    }
    const lights = measured.get(fg)
    if (lights) segment.labelLight = lights
    else delete segment.labelLight
  }
}

// Where writes go: the stage's bucket through Wrangler, or a local folder laid out like it.
const run = (args, env) => new Promise((done, failed) => {
  const [cmd, ...pre] = (process.env.WRANGLER ?? 'wrangler').split(/\s+/)
  const child = spawn(cmd, [...pre, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr.on('data', chunk => { err += chunk })
  child.on('error', failed)
  child.on('close', code => code === 0 ? done() : failed(new Error(err.trim().split('\n').slice(-3).join(' ') || `exit ${code}`)))
})
async function put(key, file, cache) {
  if (dry) return
  if (to) { const target = join(to, key); mkdirSync(dirname(target), { recursive: true }); copyFileSync(file, target); return }
  for (let attempt = 1; ; attempt++) {
    try { return await run(['r2', 'object', 'put', `${stage.bucket}/${key}`, '--file', file, '--content-type', type(key), '--cache-control', cache, '--remote'], { CLOUDFLARE_ACCOUNT_ID: stage.account }) }
    catch (error) { if (attempt === 3) throw new Error(`${key}: ${error.message}`); await new Promise(next => setTimeout(next, 2000 * attempt)) }
  }
}
async function putAll(list, from) {
  let next = 0, done = 0
  const total = list.reduce((sum, file) => sum + file.bytes, 0)
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < list.length) {
      const file = list[next++]
      await put(file.key, join(from, file.path), IMMUTABLE)
      if (!dry && ++done % 20 === 0) console.log(`  ${done} of ${list.length}`)
    }
  }))
  return total
}
// The pointer: which version it is, and each format's manifest. Written last, so the page never names files not yet there.
async function point(version, formats) {
  const work = mkdtempSync(join(tmpdir(), 'factory-media-')), file = join(work, 'current.json')
  writeFileSync(file, JSON.stringify({ version, formats }) + '\n')
  try { await put(`${prefix}current.json`, file, POINTER) } finally { rmSync(work, { recursive: true, force: true }) }
  console.log(`${dry ? 'would point' : 'pointed'} ${where()}${prefix}current.json at ${version} (${Object.keys(formats).join(' and ')})`)
}
const where = () => to ? `${resolve(to)}/` : `r2://${stage.bucket}/`
const fetchOk = async url => { const response = await fetch(url); if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`); return response }

// Writes a version's index (files.json) and each format's manifest beside its files.
async function writeIndex(version, files, formats) {
  const work = mkdtempSync(join(tmpdir(), 'factory-media-'))
  try {
    writeFileSync(join(work, 'files.json'), JSON.stringify({ files }, null, 1) + '\n')
    await put(`${prefix}${version}/files.json`, join(work, 'files.json'), IMMUTABLE)
    for (const [format, manifest] of Object.entries(formats)) {
      writeFileSync(join(work, `${format}.json`), JSON.stringify(manifest, null, 1) + '\n')
      await put(`${prefix}${version}/${format}/manifest.json`, join(work, `${format}.json`), IMMUTABLE)
    }
  } finally { rmSync(work, { recursive: true, force: true }) }
}
const formatsIn = files => [...new Set(files.map(file => file.path.split('/')[0]))].filter(format => format in FORMATS)

async function publish(dir) {
  const formats = {}, files = []
  for (const [format, sub] of Object.entries(FORMATS)) {
    if (!existsSync(join(resolve(dir), sub, 'manifest.json'))) continue
    const set = collect(join(resolve(dir), sub))
    formats[format] = set.manifest; files.push(...set.files.map(file => ({ ...file, path: `${format}/${file.path}`, from: join(resolve(dir), sub, file.path) })))
    console.log(`  ${format}: ${set.manifest.segments.length} segments, ${set.files.length} files, ${(set.files.reduce((sum, file) => sum + file.bytes, 0) / 1e6).toFixed(1)} MB`)
  }
  if (!files.length) fail(`no manifest.json in ${dir} or ${join(dir, 'phone')}`)
  const index = files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
  const version = `${new Date().toISOString().slice(0, 10)}-${sha256(JSON.stringify([index, formats])).slice(0, 8)}`
  const list = files.map(file => ({ ...file, key: `${prefix}${version}/${file.path}` }))
  console.log(`${dry ? 'would publish' : 'publishing'} ${Object.keys(formats).join(' and ')}, ${list.length} files, ${(list.reduce((sum, file) => sum + file.bytes, 0) / 1e6).toFixed(1)} MB as ${where()}${prefix}${version}/`)
  await putAll(list.map(file => ({ ...file, path: file.from })), '/')
  await writeIndex(version, index, formats)
  await point(version, formats)
}

async function promote(version) {
  if (!VERSION.test(version)) fail(`bad version ${version}`)
  const from = new URL(`${prefix}${version}/`, flag('from') ?? STAGES.dev.host)
  const { files } = await fetchOk(new URL('files.json', from)).then(r => r.json())
  for (const file of files) if (!PATH.test(file.path)) throw new Error(`bad path ${file.path}`)
  const formats = Object.fromEntries(await Promise.all(formatsIn(files).map(async format => [format, check(await fetchOk(new URL(`${format}/manifest.json`, from)).then(r => r.json()))])))
  const work = mkdtempSync(join(tmpdir(), 'factory-media-'))
  try {
    // Every file as published, byte for byte, before anything is written.
    let next = 0
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (next < files.length) {
        const file = files[next++]
        const body = Buffer.from(await (await fetchOk(new URL(file.path, from))).arrayBuffer())
        if (body.length !== file.bytes || sha256(body) !== file.sha256) throw new Error(`${file.path} differs from files.json`)
        mkdirSync(dirname(join(work, file.path)), { recursive: true }); writeFileSync(join(work, file.path), body)
      }
    }))
    const list = files.map(file => ({ ...file, key: `${prefix}${version}/${file.path}` }))
    console.log(`${dry ? 'would copy' : 'copying'} ${Object.keys(formats).join(' and ')}, ${files.length} files (${(files.reduce((sum, file) => sum + file.bytes, 0) / 1e6).toFixed(1)} MB, all matching files.json) from ${from} to ${where()}${prefix}${version}/`)
    await putAll(list, work)
  } finally { rmSync(work, { recursive: true, force: true }) }
  await writeIndex(version, files, formats)
  await point(version, formats)
}

async function repoint(version) {
  if (!VERSION.test(version)) fail(`bad version ${version}`)
  const read = async path => to ? JSON.parse(readFileSync(join(to, prefix, version, path), 'utf8')) : await (await fetchOk(new URL(`${prefix}${version}/${path}`, stage.host))).json()
  const { files } = await read('files.json')
  const formats = Object.fromEntries(await Promise.all(formatsIn(files).map(async format => [format, check(await read(`${format}/manifest.json`))])))
  await point(version, formats)
}

try {
  if (command === 'publish') await publish(subject)
  else if (command === 'promote') await promote(subject)
  else await repoint(subject)
} catch (error) { fail(error.message) }
