// Publishes the homepage's render sets to a stage's R2 media bucket (infra/pulumi: nightmail-<stage>-media, served at
// media.dev.nightmail.dev and media.nightmail.dev), so new or replacement segments go live without a deploy. The page
// reads <set>/current.json there and plays the version it names (src/features/home/factory/manifest.ts).
//
//   node scripts/factory-media.mjs publish <dir> --stage dev [--set desktop] [--dry-run] [--to <local dir>]
//     Uploads a layer set folder (manifest.json, boards/, a folder per segment: the web-layers contract) as a new
//     version, then points current.json at it. --to writes the same keys into a local folder instead (previews).
//   node scripts/factory-media.mjs promote <version> --stage production [--set desktop] [--from <url>] [--dry-run]
//     Copies a version published on dev, read from dev's public host (--from, default media.dev.nightmail.dev) and
//     checked against its files.json, into the stage's bucket, then points current.json at it. Production is reached
//     only from CI: .github/workflows/media.yml.
//   node scripts/factory-media.mjs point <version> --stage <stage> [--set desktop] [--dry-run]
//     Points current.json at a version already in the stage's bucket: rolling back is pointing at the previous one.
//
// Keys: factory/<set>/<version>/... (never written twice, cached for a year) and factory/<set>/current.json (cached a
// minute). A version is the day and the start of a hash over its files' hashes. Writes go through Wrangler
// (`r2 object put --remote`) in the stage's account: WRANGLER names the command (wwrangler on a machine logged in to the
// work account; CI passes api/node_modules/.bin/wrangler with its minted CLOUDFLARE_API_TOKEN). What still needs a
// deploy: a set whose frame, button or board geometry differs from the bundled manifest, or whose first frame differs
// from the bundled poster (the page keeps its poster until then).
import { spawn } from 'node:child_process'
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
const dry = rest.includes('--dry-run'), set = flag('set') ?? 'desktop', stage = STAGES[flag('stage')], to = flag('to')
const fail = message => { console.error(`factory-media: ${message}`); process.exit(1) }
if (!['publish', 'promote', 'point'].includes(command) || !subject) fail('usage: publish <dir> | promote <version> | point <version>, with --stage dev|production (see the top of this file)')
if (!stage && !to) fail('--stage dev|production')
if (!NAME.test(set)) fail(`bad set name ${set}`)
const prefix = `factory/${set}/`
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
  return { manifest, files: [...files, ...boards].map(path => { const body = readFileSync(join(dir, path)); return { path, bytes: body.length, sha256: sha256(body) } }) }
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
// The pointer: the version's manifest, and which version it is. Written last, so the page never names files not yet there.
async function point(version, manifest) {
  const work = mkdtempSync(join(tmpdir(), 'factory-media-')), file = join(work, 'current.json')
  writeFileSync(file, JSON.stringify({ version, ...manifest }) + '\n')
  try { await put(`${prefix}current.json`, file, POINTER) } finally { rmSync(work, { recursive: true, force: true }) }
  console.log(`${dry ? 'would point' : 'pointed'} ${where()}${prefix}current.json at ${version}`)
}
const where = () => to ? `${resolve(to)}/` : `r2://${stage.bucket}/`
const fetchOk = async url => { const response = await fetch(url); if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`); return response }

async function publish(dir) {
  const { manifest, files } = collect(resolve(dir))
  const version = `${new Date().toISOString().slice(0, 10)}-${sha256(JSON.stringify(files)).slice(0, 8)}`
  const list = files.map(file => ({ ...file, key: `${prefix}${version}/${file.path}` }))
  const bytes = list.reduce((sum, file) => sum + file.bytes, 0)
  console.log(`${dry ? 'would publish' : 'publishing'} ${manifest.segments.length} segments, ${list.length} files, ${(bytes / 1e6).toFixed(1)} MB as ${where()}${prefix}${version}/`)
  await putAll(list, resolve(dir))
  const work = mkdtempSync(join(tmpdir(), 'factory-media-'))
  try {
    writeFileSync(join(work, 'files.json'), JSON.stringify({ files }, null, 1) + '\n'); writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n')
    await put(`${prefix}${version}/files.json`, join(work, 'files.json'), IMMUTABLE); await put(`${prefix}${version}/manifest.json`, join(work, 'manifest.json'), IMMUTABLE)
  } finally { rmSync(work, { recursive: true, force: true }) }
  await point(version, manifest)
}

async function promote(version) {
  if (!VERSION.test(version)) fail(`bad version ${version}`)
  const from = new URL(`${prefix}${version}/`, flag('from') ?? STAGES.dev.host)
  const [{ files }, manifest] = await Promise.all([fetchOk(new URL('files.json', from)).then(r => r.json()), fetchOk(new URL('manifest.json', from)).then(r => r.json())])
  check(manifest)
  const work = mkdtempSync(join(tmpdir(), 'factory-media-'))
  try {
    // Every file as published, byte for byte, before anything is written.
    let next = 0
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (next < files.length) {
        const file = files[next++]
        if (!/^[\w-]+\/[\w.-]+$/.test(file.path)) throw new Error(`bad path ${file.path}`)
        const body = Buffer.from(await (await fetchOk(new URL(file.path, from))).arrayBuffer())
        if (body.length !== file.bytes || sha256(body) !== file.sha256) throw new Error(`${file.path} differs from files.json`)
        mkdirSync(dirname(join(work, file.path)), { recursive: true }); writeFileSync(join(work, file.path), body)
      }
    }))
    writeFileSync(join(work, 'files.json'), JSON.stringify({ files }, null, 1) + '\n'); writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n')
    const list = [...files, { path: 'files.json', bytes: 0 }, { path: 'manifest.json', bytes: 0 }].map(file => ({ ...file, key: `${prefix}${version}/${file.path}` }))
    console.log(`${dry ? 'would copy' : 'copying'} ${files.length} files (${(files.reduce((sum, file) => sum + file.bytes, 0) / 1e6).toFixed(1)} MB, all matching files.json) from ${from} to ${where()}${prefix}${version}/`)
    await putAll(list, work)
  } finally { rmSync(work, { recursive: true, force: true }) }
  await point(version, manifest)
}

async function repoint(version) {
  if (!VERSION.test(version)) fail(`bad version ${version}`)
  const manifest = check(to ? JSON.parse(readFileSync(join(to, prefix, version, 'manifest.json'), 'utf8')) : await (await fetchOk(new URL(`${prefix}${version}/manifest.json`, stage.host))).json())
  await point(version, manifest)
}

try {
  if (command === 'publish') await publish(subject)
  else if (command === 'promote') await promote(subject)
  else await repoint(subject)
} catch (error) { fail(error.message) }
