// The wordmark at the head of the sorting frame: lit letters as wide as the price, built into the machine so its
// light, its shadows and whatever flies in front of them treat them as one more of its parts. A letter's face is the
// brand's outline itself (marks.ts), flat and in the letters' own paper; it stands a little proud of the frame, and the
// sides that are seen are in a second, darker material, so the face keeps the outline's exact shape by night and by day.
import type { Builder, V3 } from './mesh'
import { DX, DY, type Plan } from './plan'
import { WORDMARK } from '../marks'
import { contours, edges, triangles } from '../outline'

export function nameOn(b: Builder, at: Plan['name'], face: number, side: number) {
  const k = at.cap / WORDMARK.h, rings = contours(WORDMARK.d, WORDMARK.h, at.cap > 30 ? 4 : 3), flat = triangles(rings)
  const P = (x: number, y: number, z: number): V3 => [at.x + x * k, at.y + y * k, z]
  for (let i = 0; i < flat.length; i += 6) b.tri(P(flat[i], flat[i + 1], at.z), P(flat[i + 2], flat[i + 3], at.z), P(flat[i + 4], flat[i + 5], at.z), [0, 0, -1], face)
  for (const { a, b: e, n } of edges(rings)) if (n[0] * DX + n[1] * DY > 0) b.quad(P(a[0], a[1], at.z), P(e[0], e[1], at.z), P(e[0], e[1], at.z + at.depth), P(a[0], a[1], at.z + at.depth), side, [n[0], n[1], 0])
}
