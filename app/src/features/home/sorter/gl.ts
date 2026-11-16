// The sorter's renderer: WebGL2, one oblique projection (fronts stay true rectangles, so the page's own text sits on the
// machine; depth runs up and a little to the left), drawn as a lit place and not as flat shapes. A material is still
// four tones of one colour, by how a surface faces the lamp over the machine (lit top, front, grazing, shade), and a
// face square to that lamp is exactly its tone. What makes it a place is the rest of what light does: the lamp's
// shadows are soft, and softer the further they fall; its light is a pool that dies away across the slab; surfaces
// darken where they meet; the price's lit windows and the button shed their own warm light on what stands before them
// and are mirrored in whatever shines; round steel and glass carry highlights; a machined edge catches the light; and
// what is far off is lost in the dark. All of it is worked out as each surface is drawn: nothing is done to the
// picture afterwards, so it costs no second pass. Letters are instanced thin boxes whose envelope art (edge, flap,
// stamp, address lines, burn) is drawn in the fragment shader, so it is sharp at any size.

import { DX, DY } from './plan'
import { STRIDE } from './mesh'
/** Towards the light: tops are lit most, fronts less, left sides not at all. */
export const LIGHT = norm([0.24, 0.8, -0.55])
export const TONES = 4, MATS = 48

function norm(v: number[]) { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l] }
const glsl = (v: number[]) => v.map(x => x.toFixed(5)).join(', ')
// What every solid thing shares: the palette (linear light; a tone's fourth number is, in turn, the material's alpha,
// its roughness, its shine and its own light), the lamp and its shadow, the pool, the two lit rectangles, the dark.
const LIGHTING = `
uniform sampler2D uPal, uNoise, uShadowZ; uniform sampler2DShadow uShadow;
uniform mat4 uLight; uniform vec3 uL, uLs, uFogC, uOccK, uEnv, uGround, uBayC; uniform vec4 uPool, uFog, uLook, uBay, uRectA[2], uRectB[2], uOcc[3]; uniform vec3 uSh; uniform vec2 uGain;
// Towards the eye: the one direction everything is seen from.
const vec3 VIEW = vec3(${glsl(norm([DX, DY, -1]))});
vec4 pal(float mat, int tone) { return texelFetch(uPal, ivec2(tone, int(mat + .5)), 0); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(.06711056, .00583715)))); }
// A material's tone for a facing, passing smoothly through its four: shade (turned away), grazing, front, lit.
vec3 ramp(vec3 t0, vec3 t1, vec3 t2, vec3 t3, float nl) {
  vec3 c = mix(t3, t2, clamp(nl / .24, 0., 1.)); c = mix(c, t1, clamp((nl - .24) / .31, 0., 1.));
  return mix(c, t0, clamp((nl - .55) / .25, 0., 1.));
}
// How much of the lamp reaches a point: nine looks at the map, uSh.x texels apart, each the card's own blend of four,
// so a shadow's edge is a slope some texels wide and not a line. The surface's own slope in the map goes with every
// look, so a surface is never taken for its own shadow. And where the point is itself in shadow, how far off what
// throws it is (one plain look: uSh.y turns the map's depth into distance) sets how steep that slope is: crisp where
// a thing stands on its shadow, at its softest uSh.z away from it. (uSh.x of nothing: the plain edge, in four looks.)
float shadowAt(vec3 world, vec3 n) {
  vec4 s = uLight * vec4(world + n * 1.4, 1.);
  vec3 p = s.xyz * .5 + .5;
  if (p.x < 0. || p.x > 1. || p.y < 0. || p.y > 1. || p.z > 1.) return 1.;
  vec2 t = 1. / vec2(textureSize(uShadow, 0));
  if (uSh.x <= 0.) {
    t *= 1.1; float z = p.z - .0009;
    float lit = texture(uShadow, vec3(p.xy + vec2(-t.x, -t.y), z)) + texture(uShadow, vec3(p.xy + vec2(t.x, -t.y), z)) + texture(uShadow, vec3(p.xy + vec2(-t.x, t.y), z)) + texture(uShadow, vec3(p.xy + t, z));
    return smoothstep(.2, .8, lit * .25);
  }
  t *= uSh.x;
  vec3 m = (mat3(uLight) * n) * uLs;
  vec2 g = clamp(-m.xy / min(m.z, -1e-5), -4., 4.) * t;
  float z = p.z - .0006, lit = 0.;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) lit += texture(uShadow, vec3(p.xy + vec2(i, j) * t, z + float(i) * g.x + float(j) * g.y));
  lit /= 9.;
  if (lit <= 0. || lit >= 1.) return lit;
  float off = (z - texture(uShadowZ, p.xy).r) * uSh.y, w = off > 0. ? clamp(off / uSh.z, .14, .5) : .5;
  return smoothstep(.5 - w, .5 + w, lit);
}
// The lamp's pool: full under it, dying away across the slab to what the room itself gives. (uGain: how much of a
// tone's shade the room gives, and how much of the rest the lamp: by night less of the one and more of the other.)
float pool(vec3 p) { vec2 d = p.xz - uPool.xy; return mix(uLook.x, 1., exp(-dot(d * d, uPool.zw))) * uGain.y; }
// How open to the room a point is. Ground beside something tall is closed in by it (the cabinet, the two headers);
// an upright face is closed in near the ground it stands on (the slab, or the roof).
float open(vec3 p, vec3 n) {
  float ao = 1.;
  if (n.y > .5) { for (int i = 0; i < 3; i++) { vec2 d = max(max(uOcc[i].xy - p.xz, p.xz - uOcc[i].zw), 0.); ao *= 1. - .5 * exp(-length(d) * uOccK[i]) * step(p.y, .45 / uOccK[i]); } }
  else if (n.y > -.5 && p.y > -1e-3) { float h = p.y > uGround.y + .5 && p.z > 1. ? (p.y - uGround.y) * 2.2 : p.y; ao *= mix(.66, 1., smoothstep(0., 5. * uGround.x, max(h, 0.))); }
  return ao;
}
// One of the two lit rectangles (they face the viewer: the price's windows, the button): what it sheds on a surface in
// front of it, and how it is mirrored in one that shines (blurred by that surface's roughness).
void lamp(vec4 at, vec4 light, vec3 p, vec3 n, vec3 r, float rough, inout vec3 shed, inout vec3 mirrored) {
  if (light.w <= p.z) return;
  vec3 near = vec3(clamp(p.xy, at.xy - at.zw, at.xy + at.zw), light.w), d = mix(vec3(at.xy, light.w), near, .6) - p;
  float r2 = dot(d, d), area = 4. * at.z * at.w; vec3 l = d * inversesqrt(r2);
  shed += light.rgb * (area / (area + 3.14159 * r2)) * max(dot(n, l) * .85 + .15, 0.) * smoothstep(0., .3, l.z);
  if (r.z > 1e-3) {
    vec2 hit = p.xy + r.xy * ((light.w - p.z) / r.z);
    vec3 e = normalize(vec3(clamp(hit, at.xy - at.zw, at.xy + at.zw), light.w) - p);
    mirrored += light.rgb * exp(-(1. - dot(e, r)) / (rough * rough * .5 + .002));
  }
}
// The works have a lamp of their own: a cold strip along the bay's ceiling, just behind the glass. It washes the back
// wall from the top down and lights whatever rides the rollers. (uBay: its height and depth, half its length, and one
// over the square of how far it carries.)
vec3 works(vec3 p, vec3 n) {
  if (p.z < -1. || abs(p.x) > uBay.z || p.y > uBay.x || p.y < uGround.z) return vec3(0.);
  vec2 d = uBay.xy - p.yz; float r2 = dot(d, d);
  return uBayC * max(dot(n.yz, d) * inversesqrt(r2) * .75 + .25, 0.) / (1. + r2 * uBay.w);
}
// Round steel and glass: the lamp itself, the room over it, and a tall light off to each side of the viewer (what
// puts a line down an upright pipe: the one on the lamp's side bright, the other a part as bright).
vec3 glint(vec3 n, vec3 r, float rough, float lit, float second) {
  float key = pow(max(dot(n, normalize(uL + VIEW)), 0.), 6. / (rough * rough + .02)) * lit, sky = smoothstep(.45, 1., r.y), wide = .012 + rough * .1;
  vec2 az = normalize(r.xz + 1e-5); float strip = max(smoothstep(1. - wide, 1., dot(az, vec2(.7690, -.6392))), second * smoothstep(1. - wide, 1., dot(az, vec2(-.6222, -.7828)))) * smoothstep(-.5, .1, r.y);
  return vec3(key * uEnv.x + sky * uEnv.y + strip * uEnv.z);
}
// Out: what is far back goes into the dark; the brightest of it rolls off (a lit window, paper in the burst's light)
// and the rest is exactly the tones as they are written; a grain's worth of noise keeps the dark from banding.
vec3 seen(vec3 c, vec3 p) {
  c = mix(c, uFogC, uFog.z * (1. - exp(-max(p.z - uFog.x, 0.) * uFog.y)));
  if (max(c.r, max(c.g, c.b)) > .8) c = mix(c, .8 + .2 * (1. - exp(-(c - .8) * 5.)), step(.8, c));
  c = mix(c * 12.92, 1.055 * pow(max(c, 1e-5), vec3(1. / 2.4)) - .055, step(.0031308, c));
  return c + (ign(gl_FragCoord.xy + 31.7) - .5) * uFog.w;
}`

const MESH_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm; layout(location=2) in float aMat; layout(location=3) in vec4 aFace;
uniform mat4 uProj, uModel; uniform vec3 uShift;
out vec3 vWorld, vNrm; out float vMat; out vec4 vFace;
void main() { vec4 w = uModel * vec4(aPos, 1.); w.xyz += uShift; vWorld = w.xyz; vNrm = mat3(uModel) * aNrm; vMat = aMat; vFace = aFace; gl_Position = uProj * w; }`
// Three of it: `solid` for what is opaque; `clip` the same with the two planes a capsule slides out from behind (only
// those parts are drawn with it: a shader that may throw a pixel away costs a phone's GPU its sorting of what is
// hidden); `glass` for glass and whatever is fading, over what is behind it. Each has only what it uses: the smaller a
// shader, the more of it a GPU runs at once.
const meshFs = (kind: 'solid' | 'clip' | 'glass') => `#version 300 es
precision highp float; precision highp sampler2DShadow;
in vec3 vWorld, vNrm; in float vMat; in vec4 vFace;
uniform vec3 uFlashAt; uniform float uFlash, uFade, uSlab, uFlashR; uniform vec4 uClipA, uClipB;
out vec4 o;
${LIGHTING}
void main() {
  ${kind === 'clip' ? 'if (dot(vWorld, uClipA.xyz) > uClipA.w || dot(vWorld, uClipB.xyz) > uClipB.w) discard;' : ''}
  vec3 n = normalize(vNrm); float nl = dot(n, uL);
  vec4 t0 = pal(vMat, 0), t1 = pal(vMat, 1), t2 = pal(vMat, 2), t3 = pal(vMat, 3);
  float alpha = t0.a${kind === 'glass' ? ' * uFade' : ''}, rough = t1.a, shine = t2.a, own = t3.a * uLook.y;
  vec3 c;${kind === 'glass' ? `
  if (t0.a < .995 && shine > 0.) {
    // Glass: clear where it is looked straight through, denser and brighter towards its edges, and carrying the
    // room's lights (and the price's, beside it) as lines down its length.
    vec3 g = dot(n, VIEW) < 0. ? -n : n, r = reflect(-VIEW, g), shed = vec3(0.), mirrored = vec3(0.);
    float edge = pow(1. - dot(g, VIEW), 2.5), a = min(1., alpha * (.55 + 2.4 * edge));
    lamp(uRectA[0], uRectB[0], vWorld, g, r, rough, shed, mirrored); lamp(uRectA[1], uRectB[1], vWorld, g, r, rough, shed, mirrored);
    vec3 lights = shine * (glint(g, r, rough, 1., .2) + mirrored * (.05 + .95 * edge));
    o = vec4(seen(ramp(t0.rgb, t1.rgb, t2.rgb, t3.rgb, nl) + t0.rgb * shed, vWorld) * a + sqrt(lights) * .6 * uFade, a);
    return;
  }
  // (What glass throws on the slab is laid there as a dark veil: soft at its edges, as the lamp's own shadows are.)
  if (t0.a < .995 && shine == 0. && abs(vFace.z) > 0.) { vec2 e = min(vFace.xy, vec2(abs(vFace.z), vFace.w) - vFace.xy) / (uLook.z * 3.); alpha *= smoothstep(0., 1., e.x) * smoothstep(0., 1., e.y) * pool(vWorld) / max(uGain.y, 1e-3); }` : ''}
  if (t3.a > 0. && own > 0.) c = t1.rgb * (1. + own * 1.5);
  else {
    // (A material of one tone takes nothing from the lamp: its shadow need not be looked for.)
    float lit = nl > 0. && dot(abs(t0.rgb - t3.rgb) + abs(t1.rgb - t3.rgb), vec3(1.)) > 1e-4 ? shadowAt(vWorld, n) : 0., ao = open(vWorld, n), lamped = lit * pool(vWorld);
    c = t3.rgb * ao * uGain.x + (ramp(t0.rgb, t1.rgb, t2.rgb, t3.rgb, nl) - t3.rgb) * lamped * (.55 + .45 * ao);
    // The face itself: never quite even (a broad unevenness, and streaks down it), the rougher the more.
    vec2 q = (abs(n.y) > .6 ? vWorld.xz : abs(n.x) > .6 ? vWorld.zy : vWorld.xy) / uGround.x;
    c *= 1. + ((texture(uNoise, q * .013).b - .5) * 1.2 + (texture(uNoise, q * vec2(.11, .012)).a - .5) * .8) * uLook.w * rough;
    // Its edges: a solid's are turned a little, so the one towards the lamp is a bright line and the one away a dark
    // one; what is let into a face is in its own rim's shadow at the top and the lit side, and lit along its sill.
    float w = abs(vFace.z), rise = 0.; bool curved = dot(fwidth(vNrm), vec3(1.)) > 1e-6;
    if (w > 0.) {
      vec2 uv = vFace.xy, far = vec2(w, vFace.w) - uv, dux = dFdx(uv), duy = dFdy(uv), fw = abs(dux) + abs(duy);
      float det = dux.x * duy.y - dux.y * duy.x, let = step(vFace.z, 0.);
      if (abs(det) > 1e-9) {
        vec3 dpx = dFdx(vWorld), dpy = dFdy(vWorld), tu = normalize((dpx * duy.y - dpy * dux.y) / det), tv = normalize((dpy * dux.x - dpx * duy.x) / det);
        vec2 wide = max(vec2(uLook.z * (1. + 1.4 * let)), .8 * fw), lo = 1. - smoothstep(wide * (.55 - .55 * let), wide * (1. + .5 * let), uv), hi = 1. - smoothstep(wide * (.55 - .55 * let), wide * (1. + .5 * let), far);
        float turnedTo = dot(normalize(n + (1. - 2. * let) * ((hi.x - lo.x) * tu + (hi.y - lo.y) * tv)), uL);
        rise = (turnedTo - nl) * min(1., uLook.z / max(fw.x, fw.y) + .35);
        c *= 1. + clamp(rise, -.8, .6) * mix(.5, .7, let);
      }
    }
    // (Only what stands in front of the two lit rectangles takes their light; only what is round carries a highlight.)
    vec3 r = reflect(-VIEW, n), shed = vec3(0.), mirrored = vec3(0.);
    if (vWorld.z < uRectB[0].w) { lamp(uRectA[0], uRectB[0], vWorld, n, r, rough, shed, mirrored); lamp(uRectA[1], uRectB[1], vWorld, n, r, rough, shed, mirrored); }
    c += t0.rgb * (shed * (.4 + .6 * ao) + works(vWorld, n));
    c += shine * (max(rise, 0.) * .2 * lamped + mirrored * (.05 + .95 * pow(1. - max(dot(n, VIEW), 0.), 5.)));
    if (curved) c += shine * glint(n, r, rough, lamped, .7);
  }
  // The burst's light, on the machine's own faces: strongest round the window, gone a little way off (sooner below it).
  if (uFlash > 0. && abs(vMat - uSlab) > .5) { vec3 d = vWorld - uFlashAt; if (d.y < 0.) d.y *= 1.9; float far = length(d) / uFlashR; c = mix(c, vec3(1., .85, .57), uFlash * (.2 + .5 * max(nl, 0.)) * exp(-far * far)); }
  o = vec4(seen(c, vWorld) * alpha, alpha);
}`

const LETTER_VS = `#version 300 es
layout(location=0) in vec3 aCorner; layout(location=1) in vec3 aFace;
layout(location=2) in vec3 iPos; layout(location=3) in vec4 iQuat; layout(location=4) in vec3 iSize; layout(location=5) in vec4 iA;
uniform mat4 uProj;
out vec3 vWorld, vNrm; out vec2 vUV; out float vFace; out vec4 vA; out vec2 vSize;
vec3 rot(vec4 q, vec3 v) { return v + 2. * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void main() {
  vec3 w = iPos + rot(iQuat, aCorner * iSize);
  vWorld = w; vNrm = rot(iQuat, aFace); vUV = aCorner.xy + .5; vFace = aFace.z; vA = iA; vSize = iSize.xy;
  gl_Position = uProj * vec4(w, 1.);
}`
// A burning letter is eaten from its middle out along a ragged line: what has gone is not drawn and throws no shadow.
const BURN = `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f); return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + 1.), f.x), f.y); }
float burnt(vec2 uv, float seed) { return length(uv - .5) * 1.1 + noise(uv * 7. + seed * 50.) * .45; }`
// iA: x seed (0..1), y burn (0..1.2), z kind (0 letter, 1 scam, 2 lodged in the price wall, 3 capsule slip), w highlight.
const LETTER_FS = `#version 300 es
precision highp float; precision highp sampler2DShadow;
in vec3 vWorld, vNrm; in vec2 vUV; in float vFace; in vec4 vA; in vec2 vSize;
uniform float uPaper, uInk, uStamp, uRed, uEmber, uChar, uDim;
out vec4 o;
${LIGHTING}
${BURN}
float seg(vec2 p, vec2 a, vec2 b) { vec2 d = b - a; return length(p - a - d * clamp(dot(p - a, d) / dot(d, d), 0., 1.)); }
void main() {
  float burn = vA.y, r = 0.;
  if (burn > 0.) { r = burnt(vUV, vA.x); if (r < burn * 1.3 - .14) discard; }
  vec3 n = normalize(vNrm); float nl = dot(n, uL);
  bool lodged = vA.z > 1.5 && vA.z < 2.5;
  float mat = vA.z > 2.5 ? uDim : uPaper;
  vec4 t0 = pal(mat, 0), t1 = pal(mat, 1), t2 = pal(mat, 2), t3 = pal(mat, 3);
  vec3 c;
  if (lodged) {
    // A lit window: by night each a little its own brightness and warmth, brightest at its middle.
    vec2 q = vUV - .5; float own = uLook.y, k = fract(vA.x * 13.7);
    c = t1.rgb * (1. + own * (.7 + 1.3 * k)) * (1. - own * 1.1 * dot(q, q)) * mix(vec3(1.), vec3(1.08, .95, .74), own * (.35 + .65 * fract(vA.x * 5.3)));
  } else {
    float lit = nl > 0. ? shadowAt(vWorld, n) : 0., ao = open(vWorld, n);
    c = t3.rgb * ao * uGain.x + (ramp(t0.rgb, t1.rgb, t2.rgb, t3.rgb, nl) - t3.rgb) * lit * pool(vWorld) * (.55 + .45 * ao);
    vec3 shed = vec3(0.), mirrored = vec3(0.);
    if (vWorld.z < uRectB[0].w) { lamp(uRectA[0], uRectB[0], vWorld, n, vec3(0.), 1., shed, mirrored); lamp(uRectA[1], uRectB[1], vWorld, n, vec3(0.), 1., shed, mirrored); }
    c += t0.rgb * (shed + works(vWorld, n) * .12);
  }
  // Lengths on the face in pixels: p is the position from the bottom left, s the face's size.
  vec2 s = vSize, p = vUV * s; float px = max(fwidth(p.x), fwidth(p.y)) + 1e-4;
  if (abs(vFace) > .5) {
    vec3 ink = pal(uInk, 1).rgb;
    bool scam = vA.z > .5 && vA.z < 1.5;
    bool front = vFace < 0. ? fract(vA.x * 7.) < (lodged ? .12 : 2.) : false;
    if (front) {
      // The address side: a stamp, three lines of address; a scam shouts across the top.
      vec2 q = (p - s * vec2(.8, .7)) / (s.y * vec2(.16, .2));
      float stamp = 1. - smoothstep(1. - px / (s.y * .16), 1., max(abs(q.x), abs(q.y)));
      c = mix(c, pal(scam ? uRed : uStamp, 1).rgb, stamp);
      for (int i = 0; i < 3; i++) {
        float y = s.y * (.5 - float(i) * .13), x1 = s.x * (.5 - float(i) * .07), t = max(s.y * .028, px * .5);
        float line = (1. - smoothstep(t - px, t + px, abs(p.y - y))) * step(s.x * .14, p.x) * step(p.x, x1);
        c = mix(c, ink, line * .5 * min(1., t / px * .5 + .35));
      }
      if (scam) c = mix(c, pal(uRed, 1).rgb, 1. - smoothstep(-px, px, s.y * .84 - p.y));
    } else {
      // The flap side: two creases from the top corners to a point under the middle.
      float d = min(seg(p, vec2(0., s.y), s * vec2(.5, .42)), seg(p, vec2(s.x, s.y), s * vec2(.5, .42)));
      c = mix(c, ink, (1. - smoothstep(0., px * 1.3, d - px * .2)) * (lodged ? .3 : .42));
      if (scam) c = mix(c, pal(uRed, 1).rgb, 1. - smoothstep(-px, px, p.y - s.y * .14));
    }
    // A hairline edge, so letters in a heap stay apart.
    float e = min(min(p.x, s.x - p.x), min(p.y, s.y - p.y));
    if (!lodged) c = mix(c, ink, (1. - smoothstep(0., px * 1.2, e)) * .34);
    if (vA.w > 0.) c = mix(c, pal(uStamp, 0).rgb, (1. - smoothstep(px * 1.5, px * 2.5, e)) * vA.w);
  } else c = mix(c, pal(uInk, 1).rgb, .25);
  if (burn > 0.) {
    float b = burn * 1.3 - .14;
    c = mix(c, pal(uChar, 1).rgb, (1. - smoothstep(b + .1, b + .55, r)) * .92);
    c = mix(c, pal(uEmber, 1).rgb * 1.6, 1. - smoothstep(b + .02, b + .08, r));
    c = mix(c, vec3(1.6, 1.4, .9), 1. - smoothstep(b, b + .025, r));
  }
  o = vec4(seen(c, vWorld), 1.);
}`

// The shadow map's own: only where a thing is, so as little as can be is carried from the vertices to the pixels.
const DEPTH_VS = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uProj, uModel; uniform vec3 uShift;
out vec3 vWorld;
void main() { vec4 w = uModel * vec4(aPos, 1.); w.xyz += uShift; vWorld = w.xyz; gl_Position = uProj * w; }`
const depthFs = (clip: boolean) => `#version 300 es
precision highp float;
${clip ? 'in vec3 vWorld; uniform vec4 uClipA, uClipB;' : ''}
out vec4 o;
void main() { ${clip ? 'if (dot(vWorld, uClipA.xyz) > uClipA.w || dot(vWorld, uClipB.xyz) > uClipB.w) discard;' : ''} o = vec4(0.); }`
const LETTER_DEPTH_VS = `#version 300 es
layout(location=0) in vec3 aCorner;
layout(location=2) in vec3 iPos; layout(location=3) in vec4 iQuat; layout(location=4) in vec3 iSize; layout(location=5) in vec4 iA;
uniform mat4 uProj;
out vec2 vUV; out vec2 vBurn;
vec3 rot(vec4 q, vec3 v) { return v + 2. * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void main() { vec3 w = iPos + rot(iQuat, aCorner * iSize); vUV = aCorner.xy + .5; vBurn = iA.xy; gl_Position = uProj * vec4(w, 1.); }`
const LETTER_DEPTH_FS = `#version 300 es
precision highp float;
in vec2 vUV; in vec2 vBurn;
out vec4 o;
${BURN}
void main() { if (vBurn.y > 0. && burnt(vUV, vBurn.x) < vBurn.y * 1.3 - .14) discard; o = vec4(0.); }`

// Puffs, sparks and light: quads that face the page. Shape 0 a flat disc, 1 a flat rectangle, 2 a soft light, 3 a beam.
const FX_VS = `#version 300 es
layout(location=0) in vec2 aQuad;
layout(location=1) in vec3 iPos; layout(location=2) in vec3 iSize; layout(location=3) in vec4 iCol; layout(location=4) in float iShape;
uniform mat4 uProj; uniform vec2 uView;
out vec2 vQ; out vec4 vCol; out float vShape; out vec2 vHalf;
void main() {
  float c = cos(iSize.z), s = sin(iSize.z); vec2 q = aQuad * iSize.xy; q = vec2(q.x * c - q.y * s, q.x * s + q.y * c);
  gl_Position = uProj * vec4(iPos, 1.); gl_Position.xy += q * 2. / uView;
  vQ = aQuad; vCol = iCol; vShape = iShape; vHalf = iSize.xy;
}`
const FX_FS = `#version 300 es
precision highp float;
in vec2 vQ; in vec4 vCol; in float vShape; in vec2 vHalf;
out vec4 o;
void main() {
  float a = 1.;
  if (vShape < .5) { float r = length(vQ) * vHalf.x; a = 1. - smoothstep(vHalf.x - 1.2, vHalf.x, r); }
  else if (vShape < 1.5) { vec2 e = (1. - abs(vQ)) * vHalf; a = clamp(min(e.x, e.y), 0., 1.); }
  // (A soft light is so faint a slope that eight bits would show it in steps: a grain's worth of noise goes with it.)
  else if (vShape < 2.5) { float r = clamp(1. - length(vQ), 0., 1.); a = r * r * (3. - 2. * r); o = vec4(max(vCol.rgb * vCol.a * a + (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(.06711056, .00583715)))) - .5) / 255., 0.) * step(1e-4, a), 0.); return; }
  else { float y = abs(vQ.y); a = (1. - smoothstep(.0, 1., y)) * .55 + (1. - smoothstep(.12, .3, y)); o = vec4(mix(vCol.rgb, vec3(1.), 1. - smoothstep(.1, .34, y)) * vCol.a * min(a, 1.), 0.); return; }
  o = vec4(vCol.rgb * vCol.a * a, vShape > 1.5 ? 0. : vCol.a * a);
}`

// Smoke and steam: soft sprites that face the page, each a billow. Its edge is eaten away by a cloud noise that is
// itself pushed about by a slower one (so no two look alike and none looks like a disc), and the noise drifts through
// it as it ages. It is lit like a ball by the scene's own light, the noise bending its surface, so a plume has a lit
// side and a dark one; just after the burst its dark side takes a little of the fire's colour. Drawn into a buffer a
// fraction of the page's size and laid over the scene: density adds up where billows overlap.
// iP: x age (0 to 1), y seed, z density, w what it is (0 steam, 1 smoke). iQ: x heat.
const SMOKE_VS = `#version 300 es
layout(location=0) in vec2 aQuad;
layout(location=1) in vec3 iPos; layout(location=2) in vec2 iSize; layout(location=3) in vec4 iP; layout(location=4) in float iHeat;
uniform mat4 uProj; uniform vec2 uView;
out vec2 vQ, vS; out vec4 vP; out float vHeat;
void main() {
  float c = cos(iSize.y), s = sin(iSize.y); vec2 q = vec2(aQuad.x * c - aQuad.y * s, aQuad.x * s + aQuad.y * c);
  gl_Position = uProj * vec4(iPos, 1.); gl_Position.xy += q * iSize.x * 2. / uView;
  vQ = aQuad; vS = q; vP = iP; vHeat = iHeat;
}`
const SMOKE_FS = `#version 300 es
precision mediump float;
in vec2 vQ, vS; in vec4 vP; in float vHeat;
uniform sampler2D uNoise; uniform vec3 uLit0, uLit1, uShade0, uShade1, uHot;
out vec4 o;
void main() {
  float r = length(vQ);
  if (r >= 1.) discard;
  vec2 p = vQ * .5, drift = vec2(0., -vP.x * .32);
  vec2 warp = texture(uNoise, p * .8 + vP.y * 7.31 + drift * .6).rg - .5;
  float cloud = texture(uNoise, p * 1.35 + warp * .42 + vP.y * 3.17 + drift).b * .72 + texture(uNoise, p * 3.4 + warp * .25 + vP.y * 1.3 + drift * 1.8).a * .28;
  float body = smoothstep(1., .18, r + (cloud - .5) * (.62 + vP.x * .55));
  float alpha = body * body * vP.z * smoothstep(0., .1, vP.x) * (1. - smoothstep(.45, 1., vP.x));
  // The page's own light (gl.ts LIGHT, as the page sees it): from above, a little from the right and the front.
  vec3 n = normalize(vec3(vS + warp * 1.1, sqrt(max(1. - r * r, 0.)) * .75 + .2));
  float lit = smoothstep(-.3, .8, dot(n, vec3(.24, .8, .55)) + (cloud - .5) * .5);
  vec3 c = mix(mix(uShade0, uShade1, vP.w), mix(uLit0, uLit1, vP.w), lit);
  c = mix(c, uHot, vHeat * (1. - lit) * .55);
  o = vec4(c * alpha, alpha);
}`
const OVER_VS = `#version 300 es
out vec2 vUV;
void main() { vec2 p = vec2(gl_VertexID == 1 ? 3. : -1., gl_VertexID == 2 ? 3. : -1.); vUV = p * .5 + .5; gl_Position = vec4(p, 0., 1.); }`
const OVER_FS = `#version 300 es
precision mediump float;
in vec2 vUV; uniform sampler2D uSmoke; out vec4 o;
void main() { o = texture(uSmoke, vUV); }`

/** A tile of cloud noise, four different ones in its four channels: two slow ones to push with, a cloud, a fine one. */
function noiseTile(size: number) {
  const bytes = new Uint8Array(size * size * 4)
  const lattice = (seed: number, period: number) => { const values = new Float32Array(period * period); let s = seed; for (let i = 0; i < values.length; i++) { s = Math.imul(s ^ s >>> 15, 0x2c1b3c6d) + 0x9e3779b9 | 0; values[i] = ((s ^ s >>> 13) >>> 0) / 4294967296 } return (x: number, y: number) => { const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), at = (a: number, b: number) => values[(b % period + period) % period * period + (a % period + period) % period]; return (at(xi, yi) * (1 - u) + at(xi + 1, yi) * u) * (1 - v) + (at(xi, yi + 1) * (1 - u) + at(xi + 1, yi + 1) * u) * v } }
  const fbm = (seed: number, periods: number[]) => { const layers = periods.map((period, i) => [lattice(seed + i * 101, period), period, .5 ** i] as const), total = layers.reduce((sum, layer) => sum + layer[2], 0); return (x: number, y: number) => layers.reduce((sum, [noise, period, weight]) => sum + noise(x * period, y * period) * weight, 0) / total }
  const channels = [fbm(11, [3, 6]), fbm(47, [3, 6]), fbm(83, [4, 8, 16, 32]), fbm(131, [16, 32, 64])]
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) for (let c = 0; c < 4; c++) bytes[(y * size + x) * 4 + c] = Math.round(Math.min(1, Math.max(0, (channels[c](x / size, y / size) - .5) * 1.7 + .5)) * 255)
  return bytes
}

/** `plain`: too small a thing to throw a shadow worth drawing (a roller in the works: fifty-six scallops along one edge). */
export type Part = { start: number; count: number; m: Float32Array; on: boolean; glass: boolean; fade: number; plain?: boolean; clip?: Float32Array; floor?: number }
/** `clip`: two planes (normal, distance); nothing of the part is drawn beyond either (a capsule sliding out of a block). */
export const LETTER_FLOATS = 14, FX_FLOATS = 11, SMOKE_FLOATS = 10

export type Renderer = ReturnType<typeof createRenderer>
/** `shifts`: where each floor of the machine is, off its place (x, y, z to a floor: mesh.ts). */
type Scene = { parts: Part[]; shifts: Float32Array; letters: Float32Array; letterCount: number; fx: Float32Array; fxCount: number; glow: Float32Array; glowCount: number; air: Float32Array; airCount: number; smoke: Float32Array; smokeCount: number; flash: number; flashAt: number[]; flashR: number; wallOn: boolean }

export function createRenderer(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false })
  if (!gl) return null
  const program = (vs: string, fs: string) => {
    const make = (type: number, source: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, source); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error('sorter shader', gl.getShaderInfoLog(s)); return s }
    const p = gl.createProgram()!; gl.attachShader(p, make(gl.VERTEX_SHADER, vs)); gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.error('sorter program', gl.getProgramInfoLog(p))
    const uniforms: Record<string, WebGLUniformLocation | null> = {}, u = (name: string) => uniforms[name] ??= gl.getUniformLocation(p, name)
    // (And what it was last told: a uniform is only sent again when it has changed. `told` the look's version, `at` a
    // floor's shift, then how faded a part is and the burst's light.)
    return { p, u, model: u('uModel'), shift: u('uShift'), told: -1, at: [NaN, NaN, NaN], fade: NaN, flash: NaN }
  }
  type Program = ReturnType<typeof program>
  const solid = program(MESH_VS, meshFs('solid')), solidClip = program(MESH_VS, meshFs('clip')), glassy = program(MESH_VS, meshFs('glass')), letter = program(LETTER_VS, LETTER_FS)
  const depth = program(DEPTH_VS, depthFs(false)), depthClip = program(DEPTH_VS, depthFs(true)), depthLetter = program(LETTER_DEPTH_VS, LETTER_DEPTH_FS)
  const fx = program(FX_VS, FX_FS), smoke = program(SMOKE_VS, SMOKE_FS), over = program(OVER_VS, OVER_FS)

  // The palette: a row of four tones for each material, read as linear light.
  const palette = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, palette)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, TONES, MATS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)

  // The smoke's noise, and the small buffer smoke is drawn into.
  const noise = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, noise)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 128, 128, 0, gl.RGBA, gl.UNSIGNED_BYTE, noiseTile(128))
  gl.generateMipmap(gl.TEXTURE_2D)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  const haze = gl.createTexture()!, hazeTarget = gl.createFramebuffer()!
  let hazeW = 0, hazeH = 0
  const sizeHaze = (width: number, height: number) => {
    if (width === hazeW && height === hazeH) return
    hazeW = width; hazeH = height
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, haze)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindFramebuffer(gl.FRAMEBUFFER, hazeTarget); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, haze, 0); gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  // The shadow map, and a blank one to read while the real one is being drawn.
  const depthTexture = (size: number) => {
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL)
    return t
  }
  let shadowSize = 2048
  let shadow = depthTexture(shadowSize)
  // The same map read a second way, as plain depths: how far off whatever throws a shadow is.
  const plain = gl.createSampler()!
  gl.samplerParameteri(plain, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.samplerParameteri(plain, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.samplerParameteri(plain, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.samplerParameteri(plain, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.samplerParameteri(plain, gl.TEXTURE_COMPARE_MODE, gl.NONE)
  gl.bindSampler(4, plain)
  const blank = depthTexture(1), target = gl.createFramebuffer()!
  const attach = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, target); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadow, 0); gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE); gl.bindFramebuffer(gl.FRAMEBUFFER, null) }
  attach()
  gl.bindFramebuffer(gl.FRAMEBUFFER, target); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, blank, 0); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT); attach()

  // The machine: one buffer of position, normal, material.
  const meshVao = gl.createVertexArray()!, meshBuffer = gl.createBuffer()!
  gl.bindVertexArray(meshVao); gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer)
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE * 4, 0)
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STRIDE * 4, 12)
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE * 4, 24)
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, STRIDE * 4, 28)

  // A letter: a unit box, instanced.
  const boxData: number[] = []
  const face = (n: number[], a: number[], b: number[]) => { for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) boxData.push(.5 * (n[0] + a[0] * u + b[0] * v), .5 * (n[1] + a[1] * u + b[1] * v), .5 * (n[2] + a[2] * u + b[2] * v), n[0], n[1], n[2]) }
  face([0, 0, -1], [1, 0, 0], [0, 1, 0]); face([0, 0, 1], [-1, 0, 0], [0, 1, 0]); face([1, 0, 0], [0, 0, 1], [0, 1, 0]); face([-1, 0, 0], [0, 0, -1], [0, 1, 0]); face([0, 1, 0], [1, 0, 0], [0, 0, 1]); face([0, -1, 0], [1, 0, 0], [0, 0, -1])
  const instanced = (unit: Float32Array, unitSize: number, floats: number, layout: number[]) => {
    const vao = gl.createVertexArray()!, unitBuffer = gl.createBuffer()!, buffer = gl.createBuffer()!
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, unitBuffer); gl.bufferData(gl.ARRAY_BUFFER, unit, gl.STATIC_DRAW)
    let location = 0
    for (let offset = 0; offset < unitSize; location++) { const size = unitSize === 2 ? 2 : 3; gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, size, gl.FLOAT, false, unitSize * 4, offset * 4); offset += size }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    let offset = 0
    for (const size of layout) { gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, size, gl.FLOAT, false, floats * 4, offset * 4); gl.vertexAttribDivisor(location, 1); offset += size; location++ }
    let capacity = 0
    return { vao, upload(data: Float32Array, count: number) { gl.bindBuffer(gl.ARRAY_BUFFER, buffer); if (count * floats > capacity) { capacity = Math.max(count * floats, capacity * 2); gl.bufferData(gl.ARRAY_BUFFER, capacity * 4, gl.DYNAMIC_DRAW) } gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * floats) } }
  }
  const letters = instanced(new Float32Array(boxData), 6, LETTER_FLOATS, [3, 4, 3, 4]), wall = instanced(new Float32Array(boxData), 6, LETTER_FLOATS, [3, 4, 3, 4])
  const quads = instanced(new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), 2, FX_FLOATS, [3, 3, 4, 1]), billows = instanced(new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), 2, SMOKE_FLOATS, [3, 2, 4, 1])
  gl.bindVertexArray(null)

  const proj = new Float32Array(16), light = new Float32Array(16), identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  let W = 1, H = 1, dpr = 1, vertices = 0, wallCount = 0
  const mats = { paper: 0, ink: 0, stamp: 0, red: 0, ember: 0, char: 0, dim: 0, slab: 0 }
  const clear = [0, 0, 0], smokeTones = { lit0: [1, 1, 1], lit1: [.5, .5, .5], shade0: [.4, .4, .4], shade1: [.1, .1, .1], hot: [1, .6, .3] }
  let shadowWanted = 2048
  // The light's own measures of its map: across and up it per unit of the world, and how deep it is.
  const span = [1, 1, 1]
  // How the scene is lit beyond the lamp and its tones (engine.ts sets it from the plan and the theme).
  const look = {
    /** A shadow's edge: how many texels apart the nine looks at the map are (0: a plain edge, in four), and how far
     *  from what throws it a shadow is at its softest. */
    soft: 0, far: 60,
    /** The pool: its middle on the floor (x, z), how far across and how far back it reaches, and what is left outside it. */
    pool: [0, 0, 500, 300], dim: .3,
    /** The dark: where it begins (z), over how far it gathers, how much of it at most, and its colour. */
    fog: [0, 400, .5], fogTo: [0, 0, 0],
    /** Two lit rectangles facing the viewer: centre and half size, then colour and the plane (z) each is in. */
    rects: [[0, 0, 1, 1], [0, 0, 1, 1]], lights: [[0, 0, 0, -1e6], [0, 0, 0, -1e6]],
    /** What closes the ground in: three boxes on the floor (x0, z0, x1, z1) and one over how far each one's shade reaches. */
    boxes: [[1e6, 1e6, 1e6, 1e6], [1e6, 1e6, 1e6, 1e6], [1e6, 1e6, 1e6, 1e6]], reachK: [1, 1, 1],
    /** The machine's unit, the height of its roof. */
    unit: 9, roof: 500,
    /** How much of their own light lit things give, how wide a turned edge is, how uneven a face is, how much grain. */
    own: 0, edge: 1, grime: .2, grain: 1.5 / 255,
    /** Highlights: the lamp's, the room's overhead, the tall lights to the sides. */
    env: [1, .2, .4],
    /** How much of a tone's shade the room gives, and how much of the rest of it the lamp. */
    gain: [1, 1],
    /** The works' own lamp: its height and depth, half its length, how far it carries, the bay's floor; its colour. */
    bay: [0, 0, 1, 100, 0], bayLight: [0, 0, 0],
  }
  // (Its rows as the programs take them, made when the look is set and not every frame.)
  const rows = { rects: new Float32Array(8), lights: new Float32Array(8), boxes: new Float32Array(12) }
  // What a program is told of the scene's light and the page, sent again only when any of it has changed (the page's
  // size, the look, the materials: each bumps `version`). The shadow map's programs only need the lamp's view.
  let version = 0
  const tell = (prog: Program) => {
    if (prog.told === version) return
    prog.told = version
    if (prog === depth || prog === depthClip || prog === depthLetter) { gl.uniformMatrix4fv(prog.u('uProj'), false, light); return }
    gl.uniformMatrix4fv(prog.u('uProj'), false, proj); gl.uniformMatrix4fv(prog.u('uLight'), false, light); gl.uniform3fv(prog.u('uL'), LIGHT)
    gl.uniform1i(prog.u('uPal'), 0); gl.uniform1i(prog.u('uShadow'), 1); gl.uniform1i(prog.u('uNoise'), 2); gl.uniform1i(prog.u('uShadowZ'), 4)
    gl.uniform3f(prog.u('uLs'), 1 / (4 * span[0] * span[0]), 1 / (4 * span[1] * span[1]), 1 / (4 * span[2] * span[2]))
    gl.uniform3f(prog.u('uSh'), look.soft, 1 / span[2], look.far)
    gl.uniform4f(prog.u('uPool'), look.pool[0], look.pool[1], 1 / (look.pool[2] * look.pool[2]), 1 / (look.pool[3] * look.pool[3]))
    gl.uniform4f(prog.u('uFog'), look.fog[0], 1 / look.fog[1], look.fog[2], look.grain); gl.uniform3fv(prog.u('uFogC'), look.fogTo)
    gl.uniform4f(prog.u('uLook'), look.dim, look.own, look.edge, look.grime); gl.uniform3f(prog.u('uGround'), look.unit, look.roof, look.bay[4]); gl.uniform3fv(prog.u('uEnv'), look.env)
    gl.uniform2fv(prog.u('uGain'), look.gain); gl.uniform4f(prog.u('uBay'), look.bay[0], look.bay[1], look.bay[2], 1 / (look.bay[3] * look.bay[3])); gl.uniform3fv(prog.u('uBayC'), look.bayLight)
    gl.uniform4fv(prog.u('uRectA'), rows.rects); gl.uniform4fv(prog.u('uRectB'), rows.lights); gl.uniform4fv(prog.u('uOcc'), rows.boxes); gl.uniform3fv(prog.u('uOccK'), look.reachK)
    if (prog === letter) { gl.uniform1f(prog.u('uPaper'), mats.paper); gl.uniform1f(prog.u('uInk'), mats.ink); gl.uniform1f(prog.u('uStamp'), mats.stamp); gl.uniform1f(prog.u('uRed'), mats.red); gl.uniform1f(prog.u('uEmber'), mats.ember); gl.uniform1f(prog.u('uChar'), mats.char); gl.uniform1f(prog.u('uDim'), mats.dim) }
    else gl.uniform1f(prog.u('uSlab'), mats.slab)
  }
  // The burst's light (only while there is any is where it is worth sending).
  const flash = (prog: Program, scene: Scene) => {
    if (scene.flash === 0 && prog.flash === 0) return
    prog.flash = scene.flash; gl.uniform1f(prog.u('uFlash'), scene.flash)
    if (scene.flash > 0) { gl.uniform3fv(prog.u('uFlashAt'), scene.flashAt); gl.uniform1f(prog.u('uFlashR'), scene.flashR) }
  }
  const shift = (prog: Program, shifts: Float32Array, floor = 0) => {
    const k = 3 * floor, x = shifts[k], y = shifts[k + 1], z = shifts[k + 2], at = prog.at
    if (x === at[0] && y === at[1] && z === at[2]) return
    at[0] = x; at[1] = y; at[2] = z; gl.uniform3f(prog.shift, x, y, z)
  }
  // The machine's parts that one program draws: in the shadow map what throws a shadow, on the page what is opaque;
  // those that have a clip, or those that have none. (It says how many it passed over that have one: if none, their
  // program is not wanted this frame.)
  const solids = (prog: Program, scene: Scene, clipped: boolean, shadow: boolean) => {
    let passed = 0
    for (let i = 0; i < scene.parts.length; i++) {
      const part = scene.parts[i]
      if (!part.on || part.glass || part.fade < 1 || !part.count || (shadow && part.plain)) continue
      if (!part.clip !== !clipped) { passed++; continue }
      shift(prog, scene.shifts, part.floor)
      if (part.clip) { const c = part.clip; gl.uniform4f(prog.u('uClipA'), c[0], c[1], c[2], c[3]); gl.uniform4f(prog.u('uClipB'), c[4], c[5], c[6], c[7]) }
      gl.uniformMatrix4fv(prog.model, false, part.m); gl.drawArrays(gl.TRIANGLES, part.start, part.count)
    }
    return passed
  }
  // Glass, and whatever is fading in or out, faces of one way round.
  const panes = (scene: Scene) => {
    for (let i = 0; i < scene.parts.length; i++) {
      const part = scene.parts[i]
      if (!part.on || !(part.glass || part.fade < 1) || part.fade <= 0 || !part.count) continue
      if (part.fade !== glassy.fade) { glassy.fade = part.fade; gl.uniform1f(glassy.u('uFade'), part.fade) }
      shift(glassy, scene.shifts, part.floor); gl.uniformMatrix4fv(glassy.model, false, part.m); gl.drawArrays(gl.TRIANGLES, part.start, part.count)
    }
  }

  return {
    gl,
    /** `quality`: the shadow map's size and how much smaller than the page the smoke's buffer is. */
    /** `box`: how high and how deep the world is that throws and takes shadows. */
    resize(width: number, height: number, ratio: number, ox: number, oy: number, quality: { shadow: number; smoke: number }, box: { y0: number; y1: number; z0: number; z1: number }) {
      W = width; H = height; dpr = ratio; shadowWanted = quality.shadow
      sizeHaze(Math.max(64, Math.round(W * dpr * quality.smoke)), Math.max(64, Math.round(H * dpr * quality.smoke)))
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
      proj.set([2 / W, 0, 0, 0, 0, 2 / H, 0, 0, 2 * DX / W, 2 * DY / H, 1 / 3000, 0, 2 * ox / W - 1, 1 - 2 * oy / H, -1 / 3, 1])
      // The light's own view of what the page shows, for the shadow map: a box round the slab in view, the machine
      // and a little air over it, looked at along the light. No wider than that: every texel is wanted.
      const zf = box.z0, zb = box.z1, x0 = -ox - 30, x1 = W - ox + 30, top = box.y1, bottom = box.y0
      const f = [-LIGHT[0], -LIGHT[1], -LIGHT[2]], r = norm([f[2], 0, -f[0]]), u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]]
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
      for (const x of [x0, x1]) for (const y of [bottom, top]) for (const z of [zf, zb]) [r, u, f].forEach((axis, i) => { const d = axis[0] * x + axis[1] * y + axis[2] * z; lo[i] = Math.min(lo[i], d); hi[i] = Math.max(hi[i], d) })
      const sx = 2 / (hi[0] - lo[0]), sy = 2 / (hi[1] - lo[1]), sz = 2 / (hi[2] - lo[2])
      span[0] = sx / 2; span[1] = sy / 2; span[2] = sz / 2
      light.set([r[0] * sx, u[0] * sy, f[0] * sz, 0, r[1] * sx, u[1] * sy, f[1] * sz, 0, r[2] * sx, u[2] * sy, f[2] * sz, 0, -(hi[0] + lo[0]) / (hi[0] - lo[0]), -(hi[1] + lo[1]) / (hi[1] - lo[1]), -(hi[2] + lo[2]) / (hi[2] - lo[2]), 1])
      const wanted = shadowWanted
      if (wanted !== shadowSize) { gl.deleteTexture(shadow); shadowSize = wanted; shadow = depthTexture(shadowSize); attach() }
      version++
    },
    setPalette(rgba: Uint8Array) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, palette); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TONES, MATS, gl.RGBA, gl.UNSIGNED_BYTE, rgba) },
    setMaterials(next: typeof mats) { Object.assign(mats, next); version++ },
    /** The page's own colour, behind everything. */
    setClear(r: number, g: number, b: number) { clear[0] = r; clear[1] = g; clear[2] = b },
    /** Steam's and smoke's lit and shaded colours, and what the fire lends smoke's dark side. */
    setSmoke(next: typeof smokeTones) { Object.assign(smokeTones, next) },
    setMesh(data: Float32Array) { gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); vertices = data.length / STRIDE },
    setLook(next: Partial<typeof look>) { Object.assign(look, next); rows.rects.set(look.rects.flat()); rows.lights.set(look.lights.flat()); rows.boxes.set(look.boxes.flat()); version++ },
    setWall(data: Float32Array, count: number) { wall.upload(data, count); wallCount = count },
    get vertices() { return vertices },
    draw(scene: Scene) {
      if (scene.letterCount) letters.upload(scene.letters, scene.letterCount)
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE)
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, palette)
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, noise)
      // The shadow map first, reading a blank one meanwhile: the machine (whatever has no clip first, then the few
      // parts that have one, a capsule coming out of a block), then the letters.
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, blank)
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, blank)
      gl.bindFramebuffer(gl.FRAMEBUFFER, target); gl.viewport(0, 0, shadowSize, shadowSize); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT)
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(2, 4)
      gl.useProgram(depth.p); tell(depth); gl.bindVertexArray(meshVao)
      if (solids(depth, scene, false, true)) { gl.useProgram(depthClip.p); tell(depthClip); solids(depthClip, scene, true, true) }
      if (scene.letterCount) { gl.useProgram(depthLetter.p); tell(depthLetter); gl.bindVertexArray(letters.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, scene.letterCount) }
      gl.disable(gl.POLYGON_OFFSET_FILL)
      // Smoke, into its own small buffer (every pass that is not the page's own comes first: a phone's GPU pays to be
      // interrupted mid-frame).
      if (scene.smokeCount) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, hazeTarget); gl.viewport(0, 0, hazeW, hazeH); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT)
        gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        gl.useProgram(smoke.p); gl.uniformMatrix4fv(smoke.u('uProj'), false, proj); gl.uniform2f(smoke.u('uView'), W, H); gl.uniform1i(smoke.u('uNoise'), 2)
        gl.uniform3fv(smoke.u('uLit0'), smokeTones.lit0); gl.uniform3fv(smoke.u('uLit1'), smokeTones.lit1); gl.uniform3fv(smoke.u('uShade0'), smokeTones.shade0); gl.uniform3fv(smoke.u('uShade1'), smokeTones.shade1); gl.uniform3fv(smoke.u('uHot'), smokeTones.hot)
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, noise)
        billows.upload(scene.smoke, scene.smokeCount); gl.bindVertexArray(billows.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, scene.smokeCount)
        gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST)
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height)
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, shadow)
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, shadow)
      gl.clearColor(clear[0], clear[1], clear[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      // Behind everything: the air round the machine, where it catches the light.
      if (scene.airCount) {
        gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE)
        gl.useProgram(fx.p); gl.uniformMatrix4fv(fx.u('uProj'), false, proj); gl.uniform2f(fx.u('uView'), W, H)
        gl.bindVertexArray(quads.vao); quads.upload(scene.air, scene.airCount); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, scene.airCount)
        gl.disable(gl.BLEND); gl.depthMask(true); gl.enable(gl.DEPTH_TEST)
      }
      // The machine, as for the shadow map; the price's lit windows, then the letters.
      gl.useProgram(solid.p); tell(solid); flash(solid, scene); gl.bindVertexArray(meshVao)
      if (solids(solid, scene, false, false)) { gl.useProgram(solidClip.p); tell(solidClip); flash(solidClip, scene); solids(solidClip, scene, true, false) }
      gl.useProgram(letter.p); tell(letter)
      if (wallCount && scene.wallOn) { gl.bindVertexArray(wall.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, wallCount) }
      if (scene.letterCount) { gl.bindVertexArray(letters.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, scene.letterCount) }
      // Glass and anything fading in or out, over what is behind it: a tube's far wall first, then its near one, the
      // same glass whichever way a tube runs.
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false)
      gl.useProgram(glassy.p); tell(glassy); flash(glassy, scene); gl.bindVertexArray(meshVao)
      gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); panes(scene); gl.cullFace(gl.FRONT); panes(scene); gl.disable(gl.CULL_FACE)
      if (scene.smokeCount) {
        gl.disable(gl.DEPTH_TEST); gl.useProgram(over.p); gl.uniform1i(over.u('uSmoke'), 3); gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, haze)
        gl.bindVertexArray(null); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.enable(gl.DEPTH_TEST)
      }
      gl.useProgram(fx.p); gl.uniformMatrix4fv(fx.u('uProj'), false, proj); gl.uniform2f(fx.u('uView'), W, H)
      gl.bindVertexArray(quads.vao)
      if (scene.fxCount) { quads.upload(scene.fx, scene.fxCount); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, scene.fxCount) }
      if (scene.glowCount) { gl.disable(gl.DEPTH_TEST); quads.upload(scene.glow, scene.glowCount); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, scene.glowCount) }
      gl.bindVertexArray(null); gl.depthMask(true)
    },
    destroy() { gl.getExtension('WEBGL_lose_context')?.loseContext() },
  }
}
