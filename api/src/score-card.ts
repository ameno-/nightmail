import { gradeOf } from './standing-model.js';
import { INDEX, MASKS, SCALE } from './score-card-masks.js';

// The sender score card as a picture, for the first grade's email (src/notices.ts): the dashboard's graded card
// (app/src/features/score: the score's colour, Arc's film grain, Inter figures) drawn here, so it looks the same in
// every mail app, Gmail and Outlook included, which draw no web font. One picture per score, grade, daily-limit state and
// theme, and nothing else: the address names no workspace and no recipient, so one workspace can't read another's
// card and loading it says nothing about who opened which email. 101 scores (each with its one grade), four states and
// two themes: anything else is 404. The same bytes every time, cached a year by browsers and an hour by the Worker's
// colo (src/worker.ts, the /i/ cache): each picture is drawn at most once an hour per colo.
//
// The type comes from app/scripts/score-card-masks.mjs: Chromium sets each string the card can show in Inter at 3×
// and keeps its coverage, so this file only fills, blends and encodes a PNG (zlib through CompressionStream, on Node
// and Workers alike). The `v1` in the address is the design's version: a new design takes a new one.

export const SCORE_CARD_VERSION = 'v1';
/** CSS pixels: the email shows the picture at this size (drawn at SCALE×). */
export const SCORE_CARD = { width: 340, height: 184 } as const;
const STATES = ['none', '100', '200', '500'] as const;
type State = (typeof STATES)[number];
type Theme = 'light' | 'dark';

// The score's colours: the dashboard's ramp (app/src/styles/tokens.css, --score-*), a hue from red through amber to green
// as the score rises at one lightness and chroma per theme, as hex because mail clients don't read oklch.
const SCORE_HUE = { poor: 25, mid: 75, high: 150 };
const SCORE_TONES = { light: { tile: [0.88, 0.055], ink: [0.29, 0.05], soft: [0.42, 0.05] }, dark: { tile: [0.34, 0.065], ink: [0.97, 0.01], soft: [0.84, 0.035] } } as const;
const unit = (v: number) => Math.min(1, Math.max(0, v));
const scoreHue = (score: number) => SCORE_HUE.poor + unit((score - 25) / 50) * (SCORE_HUE.mid - SCORE_HUE.poor) + unit((score - 75) / 20) * (SCORE_HUE.high - SCORE_HUE.mid);
/** An OKLCH colour as sRGB, clipped to the gamut (Björn Ottosson's OKLab matrices). */
function rgb([l, c]: readonly [number, number], hue: number): [number, number, number] {
  const a = c * Math.cos(hue * Math.PI / 180), b = c * Math.sin(hue * Math.PI / 180);
  const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3, M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3, S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S, -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S, -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S]
    .map(v => { const x = unit(v); return Math.round((x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055) * 255); }) as [number, number, number];
}
const hex = (c: [number, number, number]) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
/** The card's tile, ink and label colours for a score, as hex: the email's live-text fallback uses the same. */
export function scoreTones(score: number, theme: Theme) {
  const t = SCORE_TONES[theme], h = scoreHue(score);
  return { tile: hex(rgb(t.tile, h)), ink: hex(rgb(t.ink, h)), soft: hex(rgb(t.soft, h)) };
}

const slug = (grade: string) => grade === 'A+' ? 'a-plus' : grade.toLowerCase();
/** The picture's path for a score and its daily limit then, or null when the card has no picture for it (a limit no band sets). */
export function scoreCardPath(score: number, daily: number | null, theme: Theme) {
  const state = daily === null ? 'none' : String(daily);
  if (!Number.isInteger(score) || score < 0 || score > 100 || !(STATES as readonly string[]).includes(state)) return null;
  return `/i/score-card/${SCORE_CARD_VERSION}/${score}-${slug(gradeOf(score))}-${state}-${theme}.png`;
}
const FILE = /^(0|[1-9][0-9]?|100)-(a-plus|a|b|c|d|f)-(none|100|200|500)-(light|dark)\.png$/;
/** What a picture's file name asks for, or null when it is not one of the cards (a grade that isn't its score's included). */
export function parseScoreCard(version: string, file: string) {
  const m = version === SCORE_CARD_VERSION ? FILE.exec(file) : null;
  if (!m) return null;
  const score = Number(m[1]);
  return slug(gradeOf(score)) === m[2] ? { score, grade: gradeOf(score), state: m[3] as State, theme: m[4] as Theme } : null;
}

let masks: Promise<Uint8Array> | undefined;
const inflate = async (b64: string) => new Uint8Array(await new Response(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());

/** The card as a PNG: the score's tile with rounded corners, the dashboard's grain, then the type. */
export async function drawScoreCard(card: { score: number; grade: string; state: State; theme: Theme }) {
  const atlas = await (masks ??= inflate(MASKS));
  const W = SCORE_CARD.width * SCALE, H = SCORE_CARD.height * SCALE, px = new Uint8ClampedArray(W * H * 4);
  const t = SCORE_TONES[card.theme], hue = scoreHue(card.score), tile = rgb(t.tile, hue), ink = rgb(t.ink, hue), soft = rgb(t.soft, hue);
  // The tile: corners rounded at 16 CSS px, their edge antialiased by its distance to the arc.
  const R = 16 * SCALE, noise = INDEX.noise!, grain = 2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const cx = x < R ? R - x - 0.5 : x >= W - R ? x - (W - R) + 0.5 : 0, cy = y < R ? R - y - 0.5 : y >= H - R ? y - (H - R) + 0.5 : 0;
    // Steps of 1/16, and the edge without grain: with the grain's six steps and the type's sixteen, the whole card
    // fits a 256-colour palette (encodePng), about a third of the bytes of full colour.
    const cover = cx && cy ? Math.round(unit(R - Math.hypot(cx, cy) + 0.5) * 16) / 16 : 1;
    // The grain: the dashboard's tile, white at its own alpha (0 to 41, in steps of 8), one tile pixel to a 2 × 2 block
    // (about two device pixels to a grain on a 3× phone, as the dashboard's 110 px tile there; 1.3 on a 2× screen).
    const g = cover < 1 ? 0 : Math.round(atlas[noise.at + (Math.floor(y / grain) % noise.h) * noise.w + (Math.floor(x / grain) % noise.w)]! / 8) * 8 / 255, i = (y * W + x) * 4;
    px[i] = tile[0] + (255 - tile[0]) * g; px[i + 1] = tile[1] + (255 - tile[1]) * g; px[i + 2] = tile[2] + (255 - tile[2]) * g; px[i + 3] = 255 * cover;
  }
  const stamp = (id: string, penX: number, baseY: number, color: [number, number, number]) => {
    const m = INDEX[id]!;
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      const a = Math.round(atlas[m.at + y * m.w + x]! / 17) / 15, X = penX + m.dx + x, Y = baseY + m.dy + y;
      if (!a || X < 0 || Y < 0 || X >= W || Y >= H) continue;
      const i = (Y * W + X) * 4;
      px[i] = px[i]! + (color[0] - px[i]!) * a; px[i + 1] = px[i + 1]! + (color[1] - px[i + 1]!) * a; px[i + 2] = px[i + 2]! + (color[2] - px[i + 2]!) * a;
    }
    return m.advance ?? m.w;
  };
  // Layout in CSS px, as the dashboard's card: the label and the wordmark on one line, the score with its grade, then
  // what it means for sending now. 22 px in from the edges; baselines at 36, 112 and 156.
  const s = (v: number) => Math.round(v * SCALE), left = s(22);
  stamp('label', left, s(36), soft);
  const wm = INDEX.wordmark!; stamp('wordmark', W - s(22) - wm.w, s(36), soft);
  let pen = left;
  for (const digit of String(card.score)) pen += stamp(`digit-${digit}`, pen, s(112), ink);
  stamp(`grade-${card.grade}`, pen + s(8), s(112), ink);
  stamp(`state-${card.state}`, left, s(156), ink);
  return encodePng(px, W, H);
}

// ----- PNG: a 256-colour palette when the picture has no more colours than that (the card never does), else 8-bit RGBA;
// each row filtered (None, Sub or Up, whichever sums smallest); one zlib stream ---------------------------------------
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (bytes: Uint8Array) => { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
  view.setUint32(0, data.length); out.set([...type].map(c => c.charCodeAt(0)), 4); out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function palette(px: Uint8ClampedArray) {
  const words = new Uint32Array(px.buffer, px.byteOffset, px.length / 4), index = new Map<number, number>(), indexed = new Uint8Array(words.length);
  for (let i = 0; i < words.length; i++) {
    let n = index.get(words[i]!);
    if (n === undefined) { if (index.size === 256) return null; index.set(words[i]!, n = index.size); }
    indexed[i] = n;
  }
  const colours = [...index.keys()], plte = new Uint8Array(colours.length * 3), trns = new Uint8Array(colours.length);
  colours.forEach((word, n) => { const c = new Uint8Array(new Uint32Array([word]).buffer); plte.set([c[0]!, c[1]!, c[2]!], n * 3); trns[n] = c[3]!; });
  return { indexed, plte, trns };
}
async function encodePng(px: Uint8ClampedArray, W: number, H: number) {
  const pal = palette(px), bpp = pal ? 1 : 4, source = pal ? pal.indexed : px;
  const stride = W * bpp, raw = new Uint8Array((stride + 1) * H), rows = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
  for (let y = 0; y < H; y++) {
    const at = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = source[at + x]!, left = x >= bpp ? source[at + x - bpp]! : 0, up = y ? source[at - stride + x]! : 0;
      rows[0]![x] = v; rows[1]![x] = (v - left) & 0xff; rows[2]![x] = (v - up) & 0xff;
    }
    const cost = (row: Uint8Array) => { let sum = 0; for (const b of row) sum += b < 128 ? b : 256 - b; return sum; };
    const best = [0, 1, 2].reduce((a, b) => cost(rows[b]!) < cost(rows[a]!) ? b : a);
    raw[y * (stride + 1)] = best; raw.set(rows[best]!, y * (stride + 1) + 1);
  }
  const idat = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const ihdr = new Uint8Array(13), view = new DataView(ihdr.buffer);
  view.setUint32(0, W); view.setUint32(4, H); ihdr.set([8, pal ? 3 : 6, 0, 0, 0], 8);
  const parts = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...pal ? [chunk('PLTE', pal.plte), chunk('tRNS', pal.trns)] : [], chunk('IDAT', idat), chunk('IEND', new Uint8Array())];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { png.set(p, at); at += p.length; }
  return png;
}
