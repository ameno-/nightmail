// WGSL for the renderer (see gpu.js). The "uber" shader draws SDF primitives (glossy ink shapes
// with rim light, flat shapes, glows, starbursts, rays, snow, atlas sprites) and the glossy SDF
// "beans" (the characters, as in Hex). CRT puts the broadcast on the tube, POST adds bloom, shake
// and grain. (FEED, which puts Doug's footage into the broadcast, is in gpu.js.)

export const F = 24 // floats per instance
export const BF = 44 // floats per bean
export const T = {
  CONCRETE: 12,
  SPRITE: 0,
  ELLIPSE: 1,
  RBOX: 2,
  SEG: 3,
  RING: 4,
  STAR: 5,
  BEAN: 6,
  GLOW: 7,
  RAYS: 8,
  SNOW: 9,
  TRI: 10,
  GRID: 11,
}
export const FL = { LIT: 1, CLIP: 2, INK: 4, ADD: 8, STROKE: 16 }

const COMMON = /* wgsl */ `
struct U {
  view: vec4f,  // w, h (css px), dpr, time
  clip: vec4f,  // clip rect x, y, w, h
  clip2: vec4f, // radius, mono, -, -
  l0: vec4f, c0: vec4f, // light 0: x, y, radius, intensity / rgb
  l1: vec4f, c1: vec4f,
  amb: vec4f,   // ambient tint for lit flats
}
struct I { a: vec4f, b: vec4f, c: vec4f, d: vec4f, col: vec4f, col2: vec4f }
struct Bean { b0: vec4f, b1: vec4f, b2: vec4f, b3: vec4f, b4: vec4f, b5: vec4f, b6: vec4f, b7: vec4f, b8: vec4f, b9: vec4f, b10: vec4f }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> inst: array<I>;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<storage, read> beans: array<Bean>;
const CORNERS = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1), vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1));
fn rot2(a: f32) -> mat2x2f { let c = cos(a); let s = sin(a); return mat2x2f(c, s, -s, c); }
fn hash21(p: vec2f) -> f32 { var q = fract(p * vec2f(123.34, 456.21)); q = q + dot(q, q + 45.32); return fract(q.x * q.y); }
fn cov(d: f32, aa: f32) -> f32 { return 1.0 - smoothstep(-aa, aa, d); }
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), w.x), mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), w.x), w.y);
}
fn fbm(p0: vec2f) -> f32 {
  var p = p0; var v = 0.0; var a = 0.5;
  for (var i = 0; i < 5; i = i + 1) { v = v + a * vnoise(p); p = mat2x2f(1.6, -1.2, 1.2, 1.6) * p; a = a * 0.5; }
  return v;
}
fn sdEllipse(p: vec2f, r: vec2f) -> f32 {
  let k0 = length(p / r);
  let k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-4);
}
fn sdRBox(p: vec2f, b: vec2f, r: f32) -> f32 {
  let q = abs(p) - b + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
fn sdSeg(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a; let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
fn sdTri(p: vec2f, a: vec2f, b: vec2f, c: vec2f) -> f32 {
  let e0 = b - a; let e1 = c - b; let e2 = a - c;
  let v0 = p - a; let v1 = p - b; let v2 = p - c;
  let pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  let pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  let pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  let s = sign(e0.x * e2.y - e0.y * e2.x);
  let d = min(min(vec2f(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)), vec2f(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))), vec2f(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}
fn lightAt(w: vec2f) -> vec3f {
  var l = u.amb.rgb;
  if (u.l0.w > 0.0) { let k = length(w - u.l0.xy) / u.l0.z; l = l + u.c0.rgb * u.l0.w * exp(-k * k * 2.2); }
  if (u.l1.w > 0.0) { let k = length(w - u.l1.xy) / u.l1.z; l = l + u.c1.rgb * u.l1.w * exp(-k * k * 2.2); }
  return l;
}
fn lightRim(w: vec2f) -> vec3f {
  var l = vec3f(0.0);
  if (u.l0.w > 0.0) { let k = length(w - u.l0.xy) / u.l0.z; l = l + u.c0.rgb * u.l0.w * exp(-k * k * 1.2); }
  if (u.l1.w > 0.0) { let k = length(w - u.l1.xy) / u.l1.z; l = l + u.c1.rgb * u.l1.w * exp(-k * k * 1.2); }
  return l;
}
fn clipMask(w: vec2f) -> f32 {
  let c = u.clip.xy + u.clip.zw * 0.5;
  let d = sdRBox(w - c, u.clip.zw * 0.5, u.clip2.x);
  return cov(d, 0.8);
}
`

export const UBER = /* wgsl */ `
diagnostic(off, derivative_uniformity);
${COMMON}
struct VO { @builtin(position) pos: vec4f, @location(0) lp: vec2f, @location(1) w: vec2f, @location(2) @interpolate(flat) ii: u32 }
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let s = inst[ii];
  let c = CORNERS[vi];
  var ext = s.a.zw + vec2f(s.b.z);
  if (u32(s.b.y) == 4u) { ext = vec2f(s.a.z + s.a.w + s.b.z); }
  if (u32(s.b.y) == 6u) {
    let bn = beans[u32(s.c.x)];
    let R = bn.b0.z;
    ext = vec2f(R * 1.7, R * 2.1) * max(bn.b1.x, bn.b1.y);
  }
  let lp = c * ext;
  let w = s.a.xy + rot2(s.b.x) * lp;
  var o: VO;
  o.pos = vec4f(w.x / u.view.x * 2.0 - 1.0, 1.0 - w.y / u.view.y * 2.0, 0.0, 1.0);
  o.lp = lp;
  o.w = w;
  o.ii = ii;
  return o;
}

// Glossy ink: near-black with a soft top light, a crisp rim and a faint outer glow.
fn ink(d: f32, n: vec2f, rim: vec3f, w: vec2f, aa: f32) -> vec4f {
  let lift = clamp(0.55 - 0.45 * n.y - 0.25 * n.x, 0.0, 1.0);
  var col = mix(vec3f(0.012, 0.012, 0.016), vec3f(0.085, 0.088, 0.105), pow(lift, 1.6));
  let lr = lightRim(w);
  col = col + lr * 0.10;
  let rimMask = exp(-pow((d + 1.1) / 1.25, 2.0));
  col = col + (rim + lr * 0.9) * rimMask;
  let c = cov(d, aa);
  let glow = (rim * 0.10 + lr * 0.12) * exp(-max(d, 0.0) / 7.0) * (1.0 - c);
  return vec4f(col * c + glow, c);
}

fn bean(bn: Bean, w: vec2f, aa0: f32) -> vec4f {
  let R = bn.b0.z;
  let kind = u32(bn.b1.z);
  let time = u.view.w;
  let p = (rot2(-bn.b0.w) * (w - bn.b0.xy)) / (R * bn.b1.xy);
  let aa = aa0 / R / min(bn.b1.x, bn.b1.y) * 1.2;
  let rx = 0.80 * (1.0 - 0.07 * p.y);
  let dBody = sdEllipse(p, vec2f(rx, 1.0));
  var dAll = dBody;
  // Linda's bun
  let bunC = vec2f(0.12, -1.0);
  let dBun = length(p - bunC) - 0.34;
  if (kind == 0u) { dAll = min(dAll, dBun); }
  // pitchman's little bowler hat
  let hatC = vec2f(-0.04, -0.97);
  let hp = rot2(0.14) * (p - hatC);
  let dBrim = sdRBox(hp - vec2f(0.0, 0.06), vec2f(0.68, 0.07), 0.07);
  let dCrown = sdEllipse(hp - vec2f(0.0, -0.17), vec2f(0.4, 0.34));
  let dHat = min(dBrim, max(dCrown, hp.y - 0.05));
  // robot antenna
  let dAnt = min(sdSeg(p, vec2f(0.0, -0.98), vec2f(0.0, -1.3)) - 0.035, length(p - vec2f(0.0, -1.36)) - 0.1);
  if (kind == 3u) { dAll = min(dAll, dAnt); }

  let rimCol = bn.b5.rgb * bn.b5.w;
  var col = vec3f(0.0);
  var cover = cov(dAll, aa);
  {
    let nx = clamp(p.x / rx * 0.86, -0.96, 0.96);
    let ny = clamp(p.y * 0.86, -0.96, 0.96);
    let nz = sqrt(max(0.03, 1.0 - nx * nx - ny * ny));
    let N = normalize(vec3f(nx, ny, nz));
    let lift = clamp(0.52 - 0.36 * N.y - 0.28 * N.x, 0.0, 1.0);
    col = mix(vec3f(0.016, 0.016, 0.02), vec3f(0.10, 0.105, 0.125), pow(lift, 1.5));
    if (kind == 3u) { col = col * 1.6 + vec3f(0.4, 0.42, 0.46); } // robots are brushed metal, not ink
    // coloured key light (lamp, phone, stove)
    let L = normalize(vec3f(bn.b7.xy, 0.55));
    let diff = max(dot(N, L), 0.0);
    col = col + bn.b6.rgb * bn.b6.w * (diff * diff * 0.55);
    // a second light (her phone)
    let L2 = normalize(vec3f(bn.b10.xy, 0.55));
    let diff2 = max(dot(N, L2), 0.0);
    col = col + bn.b9.rgb * bn.b9.w * (diff2 * diff2 * 0.55);
    // softbox reflection
    let ang = atan2(p.y, p.x);
    let uA = (ang + 2.08) * 0.76;
    let vA = (-dBody) - 0.115;
    let dWin = sdRBox(vec2f(uA, vA), vec2f(0.21, 0.028), 0.026);
    let winM = (1.0 - smoothstep(-0.008, 0.015, dWin)) * smoothstep(0.0, -0.18, p.y);
    let dCatch = sdRBox(vec2f(uA + 0.29, vA), vec2f(0.036, 0.024), 0.022);
    let catchM = (1.0 - smoothstep(-0.008, 0.014, dCatch)) * 0.8;
    col = col + vec3f(0.95, 0.97, 1.0) * (winM * 0.6 + catchM * 0.45);
    // fresnel rim + light-coloured rim
    let fres = exp(-pow(dAll + 0.018, 2.0) / 0.0016);
    let topW = clamp(0.65 - 0.35 * N.y, 0.25, 1.0);
    col = col + rimCol * topW * fres * 0.9;
    let nd = normalize(vec2f(nx, ny) + vec2f(1e-4));
    let lr = bn.b6.rgb * bn.b6.w * max(dot(nd, normalize(bn.b7.xy + vec2f(1e-4))), 0.0)
      + bn.b9.rgb * bn.b9.w * max(dot(nd, normalize(bn.b10.xy + vec2f(1e-4))), 0.0);
    col = col + lr * fres * 1.2;

    // bun shading
    if (kind == 0u && dBun < dBody) {
      let bp = (p - bunC) / 0.34;
      let bl = clamp(0.5 - 0.4 * bp.y - 0.3 * bp.x, 0.0, 1.0);
      col = mix(vec3f(0.016, 0.016, 0.02), vec3f(0.11, 0.11, 0.13), bl * bl);
      let bspec = exp(-dot(bp - vec2f(-0.35, -0.45), bp - vec2f(-0.35, -0.45)) * 18.0);
      col = col + vec3f(0.9) * bspec * 0.5 + rimCol * exp(-pow(dBun + 0.02, 2.0) / 0.0015) * 0.9 + lr * exp(-pow(dBun + 0.02, 2.0) / 0.0015);
      // the line where bun meets head
      col = mix(col, rimCol * 0.5, cov(abs(dBody) - 0.006, aa) * 0.6);
    }
    if (kind == 3u && dAnt < dBody) { col = vec3f(0.2, 0.21, 0.24) + rimCol * 0.4; if (length(p - vec2f(0.0, -1.36)) < 0.1) { col = vec3f(1.0, 0.3, 0.25) * (0.7 + 0.3 * sin(time * 9.0)); } }

    let face = bn.b4.xy;
    let wide = bn.b4.z;
    let squint = bn.b4.w;
    let lid = clamp(max(bn.b2.z, bn.b2.w), 0.0, 1.0);
    let worry = bn.b3.y;
    for (var s = -1; s <= 1; s = s + 2) {
      let side = f32(s);
      let ec = vec2f(side * 0.27, -0.13) + face;
      let ep = p - ec;
      if (kind == 3u) {
        // robot: glowing visor eyes
        let d = sdRBox(ep, vec2f(0.11, 0.07 * (1.0 - lid * 0.9)), 0.03);
        col = mix(col, vec3f(0.55, 1.0, 0.75), cov(d, aa));
        continue;
      }
      if (kind == 5u) {
        // bouncer: sunglasses and a scowl
        let d = sdRBox(ep - vec2f(0.0, 0.02), vec2f(0.15, 0.08), 0.04);
        col = mix(col, vec3f(0.0), cov(d, aa));
        col = col + vec3f(0.85) * cov(abs(d + 0.012) - 0.01, aa) * 0.6 * step(ep.y, 0.0);
        if (s > 0) { col = mix(col, vec3f(0.0), cov(sdSeg(p, vec2f(-0.12, -0.11) + face, vec2f(0.12, -0.11) + face) - 0.03, aa)); }
        let bc5 = vec2f(side * 0.27, -0.33) + face;
        let dir5 = vec2f(cos(-side * 0.35), sin(-side * 0.35)) * 0.14;
        col = mix(col, vec3f(0.96), cov(sdSeg(p, bc5 - dir5, bc5 + dir5) - 0.03, aa));
        continue;
      }
      let er = vec2f(0.145, 0.2 * wide);
      let dSock = sdEllipse(ep, er);
      let tw = select(0.0, bn.b8.y, s < 0);
      let browAng = -side * worry * 0.55;
      let slope = tan(clamp(browAng * 0.5, -0.5, 0.5));
      let topCut = -er.y + (min(lid + tw, 1.0) * 1.95) * er.y + ep.x * slope * 0.6;
      let botCut = er.y - (squint * 0.75 + max(0.0, bn.b3.z) * 0.18) * er.y - ep.x * ep.x * 1.1;
      let dEye = max(dSock, max(topCut - ep.y, ep.y - botCut));
      let eCov = cov(dEye, aa);
      let sclera = vec3f(0.96, 0.96, 0.94) * clamp(1.0 - dot(ep / er, ep / er) * 0.25, 0.7, 1.0) * (0.75 + 0.25 * smoothstep(topCut - 0.01, topCut + 0.07, ep.y));
      let gz = vec2f(bn.b2.x * 0.06, bn.b2.y * 0.075);
      let pp = ep - gz;
      let pr = 0.074 * select(1.0, 0.8, wide > 1.15);
      // eye shine: in the dark (night vision) the pupils glow back at the camera
      let shine = bn.b8.x;
      var ecol = mix(sclera * (1.0 - 0.55 * shine), mix(vec3f(0.03, 0.03, 0.04), vec3f(1.0), shine), cov(length(pp) - pr * (1.0 + 0.25 * shine), aa));
      ecol = mix(ecol, vec3f(1.0), cov(length(pp - vec2f(-0.022, -0.025)) - 0.019, aa));
      col = mix(col, ecol, eCov);
      // lid crease
      let dCr = abs(ep.y - (topCut - 0.024)) - 0.007;
      col = mix(col, col * 0.3, cov(dCr, aa) * smoothstep(er.x * 1.05, er.x * 0.5, abs(ep.x)) * (1.0 - eCov) * 0.6);
      // brows
      let by = -0.43 - bn.b3.x * 0.09 + worry * -0.03 * 0.0 + select(0.0, -tw * 0.06, s < 0);
      let bc = vec2f(side * 0.27, by) + face;
      let bang = -side * (worry * 0.5);
      let dir = vec2f(cos(bang), sin(bang)) * 0.135;
      let bp2 = p - bc;
      let proj = clamp(dot(bp2, dir) / dot(dir, dir), -1.0, 1.0);
      let taper = mix(0.042, 0.024, (proj * side + 1.0) * 0.5);
      col = mix(col, vec3f(0.96, 0.96, 0.94), cov(sdSeg(p, bc - dir, bc + dir) - taper, aa));
    }
    // mouth
    let smile = bn.b3.z;
    let mouth = clamp(bn.b3.w, 0.0, 1.2);
    let mc = vec2f(0.0, 0.31 + 0.12 * mouth) + face * 0.92;
    let mp = p - mc;
    let mw = (0.15 + 0.22 * mouth + 0.06 * max(smile, 0.0)) * bn.b8.z;
    let mux = clamp(mp.x / max(mw, 0.01), -1.0, 1.0);
    let yMid = smile * 0.06 * (1.0 - mux * mux);
    if (mouth < 0.04) {
      let line = cov(abs(mp.y - yMid) - 0.014, aa) * smoothstep(mw + aa, mw - aa, abs(mp.x));
      col = mix(col, vec3f(0.95, 0.95, 0.93), line);
    } else {
      let mh = 0.26 * mouth;
      let yTop = yMid - mh * 0.55 * pow(max(0.0, 1.0 - mux * mux), 0.8) + max(smile, 0.0) * 0.03;
      let yBot = yMid + mh * pow(max(0.0, 1.0 - mux * mux), 0.56) + max(smile, 0.0) * 0.05;
      let dM = max(abs(mp.x) - mw, max(yTop - mp.y, mp.y - yBot));
      var mcol = mix(vec3f(0.22, 0.04, 0.06), vec3f(0.08, 0.01, 0.02), smoothstep(yBot, yTop, mp.y));
      let teeth = cov(mp.y - (yTop + min(0.07, mh * 0.35)), aa);
      mcol = mix(mcol, vec3f(0.97, 0.97, 0.95), teeth * smoothstep(0.08, 0.2, mouth));
      let tongue = cov(sdEllipse(mp - vec2f(0.0, yBot - mh * 0.15), vec2f(mw * 0.55, mh * 0.3)), aa);
      mcol = mix(mcol, vec3f(0.85, 0.3, 0.34), tongue * smoothstep(0.3, 0.6, mouth));
      col = mix(col, mcol, cov(dM, aa));
      col = mix(col, vec3f(0.9), cov(abs(dM) - 0.01, aa) * 0.5);
    }
    // Linda: the stray hairs of a woman who has received 128,402 emails
    if (kind == 0u && bn.b7.z > 0.01) {
      let fr = bn.b7.z;
      for (var k = 0; k < 7; k = k + 1) {
        let fk = f32(k);
        let a0 = -2.6 + fk * 0.36;
        let base = vec2f(cos(a0) * rx * 0.98, sin(a0) * 0.98);
        let cc = base + vec2f(cos(a0 + 0.9), sin(a0 + 0.9)) * 0.16;
        let dArc = abs(length(p - cc) - 0.16) - 0.008;
        let angA = atan2(p.y - cc.y, p.x - cc.x);
        let am = smoothstep(0.0, 0.4, sin(angA - a0 + 3.2)) * step(hash21(vec2f(fk, 3.0)), fr);
        let hm = cov(dArc, aa) * am * (1.0 - cov(dBody + 0.01, aa));
        col = mix(col, vec3f(0.75, 0.76, 0.8), hm);
        cover = max(cover, hm);
      }
    }
    // pitchman's hat on top of everything (kind 6 is the hat alone, once it has left him)
    if (kind == 6u) { cover = 0.0; }
    if (kind == 1u || kind == 6u) {
      let hc = cov(dHat, aa);
      // a brown felt bowler with a red band, a bright rim and a highlight, so it reads at TV size
      var hcol = mix(vec3f(0.27, 0.15, 0.07), vec3f(0.56, 0.35, 0.18), clamp(0.35 - hp.y * 1.5 - hp.x * 0.6, 0.0, 1.0));
      let hl = exp(-dot(hp - vec2f(-0.16, -0.32), hp - vec2f(-0.16, -0.32)) * 30.0);
      hcol = hcol + vec3f(0.9, 0.8, 0.65) * hl * 0.4;
      let band = cov(abs(hp.y + 0.045) - 0.06, aa) * cov(dCrown, aa);
      hcol = mix(hcol, vec3f(0.9, 0.14, 0.1), band);
      hcol = hcol + vec3f(1.0, 0.9, 0.75) * exp(-pow(dHat + 0.014, 2.0) / 0.0005) * 0.5;
      col = mix(col, hcol, hc);
      cover = max(cover, hc);
    }
  }
  let outside = max(dAll, 0.0);
  let halo = rimCol * 0.06 * exp(-outside * 5.0) + (bn.b6.rgb * bn.b6.w + bn.b9.rgb * bn.b9.w) * 0.04 * exp(-outside * 4.0);
  let a = bn.b1.w;
  return vec4f((col * cover + halo * (1.0 - cover)) * a, cover * a);
}

@fragment fn fs(i: VO) -> @location(0) vec4f {
  let s = inst[i.ii];
  let ty = u32(s.b.y);
  let flags = u32(s.b.w);
  let lp = i.lp;
  let aa = max(length(fwidth(lp)) * 0.75, 0.35);
  var out = vec4f(0.0);
  let hs = s.a.zw;
  if (ty == 0u) {
    let uv = mix(s.d.xy, s.d.zw, lp / hs * 0.5 + 0.5);
    let t = textureSampleLevel(atlas, samp, uv, 0.0);
    out = t * vec4f(s.col.rgb * s.col.a, s.col.a);
  } else if (ty == 6u) {
    out = bean(beans[u32(s.c.x)], i.w, aa);
  } else if (ty == 7u) {
    let q = lp / hs;
    let g = exp(-dot(q, q) * 3.0) * s.col.a;
    out = vec4f(s.col.rgb * g, 0.0);
    if ((flags & 8u) == 0u) { out.a = g; }
  } else if (ty == 8u) {
    // rays from local (c.x, c.y)
    let q = lp - s.c.xy;
    let ang = atan2(q.y, q.x) + s.c.w;
    let n = s.c.z;
    let k = fract(ang / 6.2831853 * n);
    let m = smoothstep(0.48, 0.52, k) - smoothstep(0.98, 1.0, k);
    let edge = cov(sdRBox(lp, hs, 0.0), aa);
    out = mix(s.col, s.col2, m) * edge;
    out = vec4f(out.rgb * out.a, out.a);
  } else if (ty == 9u) {
    // procedural snow in the rect: c.x density, c.y wind, c.z speed
    var acc = 0.0;
    for (var l = 0; l < 4; l = l + 1) {
      let fl = f32(l);
      let sc = 28.0 + fl * 16.0;
      let sp = vec2f(lp.x + u.view.w * s.c.y * (8.0 + fl * 6.0) + sin(u.view.w * 0.7 + lp.y * 0.02 + fl) * 6.0, lp.y - u.view.w * s.c.z * (14.0 + fl * 10.0)) / sc;
      let cell = floor(sp);
      let f = fract(sp) - 0.5;
      let h = hash21(cell + fl * 17.0);
      if (h < s.c.x) {
        let o = vec2f(hash21(cell + 3.1) - 0.5, hash21(cell + 7.7) - 0.5) * 0.6;
        let r = (0.06 + 0.05 * (1.0 - fl / 3.0)) ;
        acc = acc + exp(-dot(f - o, f - o) / (r * r)) * (0.9 - fl * 0.18);
      }
    }
    let edge = cov(sdRBox(lp, hs, 0.0), aa);
    let v = clamp(acc, 0.0, 1.0) * edge * s.col.a;
    out = vec4f(s.col.rgb * v, v);
  } else if (ty == 12u) {
    // poured concrete: broad mottling, fine aggregate, the odd pit. Neutral, no tint.
    // d.xy is the page position of the world origin and c.x the scale, so the texture is anchored
    // to the world and moves with the camera. c.y: formwork seams and tie holes (a cast wall).
    let w = (i.w - s.d.xy) / max(s.c.x, 0.01);
    let mott = fbm(w * 0.004 + vec2f(3.1, 7.7));
    let fine = fbm(w * 0.06);
    let grain = hash21(floor(w * 1.0));
    let pit = smoothstep(0.82, 0.9, vnoise(w * 0.09 + 11.0)) * smoothstep(0.6, 0.75, vnoise(w * 0.02));
    var v = s.col.r * (0.82 + 0.3 * mott) + (fine - 0.5) * 0.035 + (grain - 0.5) * 0.02 - pit * 0.03;
    if (s.c.y > 0.0) {
      let panel = vec2f(440.0, 300.0);
      let pw = w + vec2f(170.0, 40.0);
      let pc = fract(pw / panel) * panel;
      let px = 1.0 / max(s.c.x, 0.01);
      let seam = min(min(pc.x, panel.x - pc.x), min(pc.y, panel.y - pc.y));
      v = v - (1.0 - smoothstep(0.0, 1.2 + px, seam)) * 0.022 * s.c.y;
      v = v + (smoothstep(1.5, 3.0, seam) - smoothstep(3.0, 7.0, seam)) * 0.008 * s.c.y;
      let hq = abs(pc - panel * 0.5) - panel * vec2f(0.34, 0.3);
      let hd = length(hq) - 5.0;
      v = v - (1.0 - smoothstep(-1.0, 1.0 + px, hd)) * 0.03 * s.c.y;
      v = v + (1.0 - smoothstep(0.0, 2.5, abs(hd - 1.5))) * step(0.0, hq.y) * 0.012 * s.c.y;
    }
    v = max(v, 0.0);
    let edge = cov(sdRBox(lp, hs, 0.0), aa);
    out = vec4f(vec3f(v) * edge * s.col.a, edge * s.col.a);
  } else if (ty == 11u) {
    // synthwave floor grid, horizon at the top of the rect
    let q = lp / hs * 0.5 + 0.5;
    let z = 1.0 / max(q.y, 0.02);
    let gx = (q.x - 0.5) * z * 6.0;
    let gy = z * 2.0 - u.view.w * s.c.x;
    let lx = abs(fract(gx) - 0.5);
    let ly = abs(fract(gy) - 0.5);
    let wl = fwidth(gx) * 1.2; let wl2 = fwidth(gy) * 1.2;
    let line = max(1.0 - smoothstep(0.0, wl, 0.5 - lx), 1.0 - smoothstep(0.0, wl2, 0.5 - ly));
    let edge = cov(sdRBox(lp, hs, 0.0), aa);
    let fade = smoothstep(0.0, 0.4, q.y);
    let c = mix(s.col2, s.col, line * fade);
    out = vec4f(c.rgb * c.a * edge, c.a * edge);
  } else {
    var d = 0.0;
    var n = vec2f(0.0);
    if (ty == 1u) {
      d = sdEllipse(lp, hs);
      n = lp / hs;
    } else if (ty == 2u) {
      d = sdRBox(lp, hs, min(s.c.x, min(hs.x, hs.y)));
      n = lp / hs;
    } else if (ty == 3u) {
      d = sdSeg(lp, vec2f(-hs.x, 0.0), vec2f(hs.x, 0.0)) - hs.y;
      n = vec2f(lp.x / (hs.x + hs.y), lp.y / hs.y);
    } else if (ty == 4u) {
      // ring/arc: radius hs.x, thickness hs.y, arc from c.x to c.y (radians)
      let r = length(lp);
      d = abs(r - hs.x) - hs.y;
      let a = atan2(lp.y, lp.x);
      if (s.c.y > s.c.x) {
        let mid = (s.c.x + s.c.y) * 0.5;
        let half = (s.c.y - s.c.x) * 0.5;
        let da = abs(atan2(sin(a - mid), cos(a - mid))) - half;
        d = max(d, da * r);
      }
      n = lp / hs.x;
    } else if (ty == 5u) {
      let a = atan2(lp.y, lp.x);
      let k = abs(fract(a / 6.2831853 * s.c.x) - 0.5) * 2.0;
      let r = hs.x * mix(s.c.y, 1.0, k);
      d = (length(lp) - r) * 0.8;
      n = lp / hs;
    } else if (ty == 10u) {
      d = sdTri(lp, vec2f(-hs.x, hs.y), vec2f(hs.x, hs.y), vec2f(s.c.x * hs.x, -hs.y));
      n = lp / hs;
    }
    if ((flags & 16u) != 0u) { d = abs(d) - s.c.w; }
    if ((flags & 4u) != 0u) {
      out = ink(d, n, s.col2.rgb * s.col2.a, i.w, aa);
      out = out * s.col.a;
    } else {
      let soft = max(aa, s.c.z);
      let c = 1.0 - smoothstep(-soft, soft, d);
      var rgb = s.col.rgb;
      if (s.col2.a > 0.0 && ty == 2u) { rgb = mix(s.col.rgb, s.col2.rgb, clamp(lp.y / hs.y * 0.5 + 0.5, 0.0, 1.0)); }
      if ((flags & 1u) != 0u) { rgb = rgb * lightAt(i.w); }
      let a = c * s.col.a;
      out = vec4f(rgb * a, a);
      if ((flags & 8u) != 0u) { out.a = 0.0; }
    }
  }
  if ((flags & 2u) != 0u) { out = out * clipMask(i.w); }
  return out;
}
`

export const CRT = /* wgsl */ `
struct C {
  rect: vec4f,   // screen rect in css px
  view: vec4f,   // canvas w, h, time, power (0 off → 1 on)
  fx: vec4f,     // tilt (radians: the camera gets knocked), tracking, warp (tape stop), clean
  fx2: vec4f,    // brightness, roll, static, radius
}
@group(0) @binding(0) var<uniform> c: C;
@group(0) @binding(1) var tv: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
const CORNERS = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  let k = CORNERS[vi];
  let w = c.rect.xy + k * c.rect.zw;
  var o: VO;
  o.pos = vec4f(w.x / c.view.x * 2.0 - 1.0, 1.0 - w.y / c.view.y * 2.0, 0.0, 1.0);
  o.uv = k;
  return o;
}
fn h(p: vec2f) -> f32 { var q = fract(p * vec2f(123.34, 456.21)); q = q + dot(q, q + 45.32); return fract(q.x * q.y); }
fn sdRBox(p: vec2f, b: vec2f, r: f32) -> f32 { let q = abs(p) - b + vec2f(r); return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r; }
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let t = c.view.z;
  let power = c.view.w;
  let clean = c.fx.w;
  var uv = i.uv;
  // CRT curvature
  let cc = uv - 0.5;
  // (overscanned a little, like a real set: the picture runs under the edge of the glass)
  let k = mix(0.07, 0.04, clean);
  uv = 0.5 + cc * (1.0 + k * dot(cc, cc)) * 0.962;
  let px = c.rect.zw;
  // a knocked camera: the picture rotates, pushed in a little so its corners stay covered
  let tilt = c.fx.x;
  let rp = (uv - 0.5) * px;
  uv = 0.5 + vec2f(rp.x * cos(tilt) - rp.y * sin(tilt), rp.x * sin(tilt) + rp.y * cos(tilt)) / px / (1.0 + abs(tilt) * 2.2);
  let dEdge = sdRBox((i.uv - 0.5) * px, px * 0.5 - vec2f(1.0), c.fx2.w);
  let inScreen = 1.0 - smoothstep(-1.0, 1.0, dEdge);
  // power-on: a bright line that opens vertically
  let open = smoothstep(0.0, 0.55, power);
  let lineH = mix(0.004, 0.5, open);
  let vy = (uv.y - 0.5) / max(lineH * 2.0, 0.001) + 0.5;
  let squeezeX = mix(0.0, 1.0, smoothstep(0.0, 0.12, power));
  let vx = (uv.x - 0.5) / max(squeezeX, 0.001) + 0.5;
  var suv = vec2f(vx, vy);
  // tracking wobble + tape-stop warp
  let warp = c.fx.z;
  let band = exp(-pow((fract(uv.y - t * 0.13) - 0.5) * 9.0, 2.0)) * c.fx.y;
  suv.x = suv.x + band * (h(vec2f(floor(uv.y * 240.0), floor(t * 30.0))) - 0.5) * 0.06 + sin(uv.y * 30.0 + t * 3.0) * 0.0015 * (1.0 - clean);
  suv.x = suv.x + sin(uv.y * 8.0 + t * 1.3) * warp * 0.02;
  suv.y = fract(suv.y + c.fx2.y);
  let ca = mix(0.0011, 0.0004, clean) + warp * 0.004 + band * 0.004;
  var col = vec3f(
    textureSampleLevel(tv, samp, suv + vec2f(ca, 0.0), 0.0).r,
    textureSampleLevel(tv, samp, suv, 0.0).g,
    textureSampleLevel(tv, samp, suv - vec2f(ca, 0.0), 0.0).b
  );
  // a little horizontal bleed
  let bl = textureSampleLevel(tv, samp, suv - vec2f(0.004, 0.0), 0.0).rgb;
  col = mix(col, max(col, bl), 0.18 * (1.0 - clean));
  // the tape dying drains the colour
  let lum = dot(col, vec3f(0.299, 0.587, 0.114));
  col = mix(col, vec3f(lum), clamp(warp * 0.6, 0.0, 1.0));
  col = col * c.fx2.x;
  // scanlines + aperture
  let sl = 0.88 + 0.12 * sin(uv.y * px.y * 3.14159 / 1.6);
  let ap = 0.92 + 0.08 * sin(uv.x * px.x * 3.14159 / 1.1);
  col = col * mix(sl * ap, 1.0, clean * 0.7);
  // grain + static
  let g = h(uv * px + vec2f(t * 60.0, t * 37.0));
  col = col + (g - 0.5) * mix(0.06, 0.02, clean);
  col = mix(col, vec3f(g), c.fx2.z);
  // vignette
  let vg = smoothstep(0.85, 0.25, length(cc * vec2f(1.0, 1.15)));
  col = col * mix(0.55, 1.0, vg);
  let inside = step(0.0, suv.x) * step(suv.x, 1.0) * step(0.0, vy) * step(vy, 1.0);
  col = col * inside;
  // the power-on flash line
  let flash = exp(-pow((uv.y - 0.5) / max(lineH, 0.002), 2.0) * 3.0) * (1.0 - smoothstep(0.3, 0.8, power)) * smoothstep(0.0, 0.05, power);
  col = col + vec3f(0.9, 0.95, 1.0) * flash * 1.5;
  // off: dark glass with a reflection
  let off = 1.0 - smoothstep(0.0, 0.04, power);
  let glass = vec3f(0.035, 0.036, 0.04) + vec3f(0.07) * smoothstep(0.35, 0.0, abs(i.uv.x + i.uv.y * 0.6 - 0.45)) * 0.6;
  col = mix(col, glass, off);
  // the tube is a thick piece of glass: the picture falls off into the bezel and the room
  // puts a soft highlight across the top-left
  col = col * (0.25 + 0.75 * smoothstep(0.0, -26.0, dEdge));
  let glare = smoothstep(0.55, 0.0, length((i.uv - vec2f(0.2, 0.06)) * vec2f(0.7, 1.9)));
  col = col + vec3f(1.0, 0.97, 0.92) * glare * glare * 0.05;
  return vec4f(col * inScreen, inScreen);
}
`

export const POST = /* wgsl */ `
struct P {
  view: vec4f,   // w, h (device px), time, dpr
  fx: vec4f,     // shakeX, shakeY (css px), aberration, flash
  pad: vec4f,
  fx2: vec4f,    // bloom, grain, vignette, -
}
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var scene: texture_2d<f32>;
@group(0) @binding(2) var bloom: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  let xy = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: VO;
  o.pos = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(xy.x, 1.0 - xy.y);
  return o;
}
fn h1(x: f32) -> f32 { return fract(sin(x * 127.1) * 43758.5453); }
fn h2(q: vec2f) -> f32 { return fract(sin(dot(q, vec2f(127.1, 311.7))) * 43758.5453); }
fn vn(x: f32) -> f32 { let i = floor(x); let f = fract(x); let u2 = f * f * (3.0 - 2.0 * f); return mix(h1(i), h1(i + 1.0), u2); }
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let css = p.view.xy / p.view.w;
  let uv = i.uv - p.fx.xy / css;
  let ab = p.fx.z / css.x;
  let c0 = textureSampleLevel(scene, samp, uv, 0.0);
  var col = c0.rgb;
  var a = c0.a;
  if (ab > 0.0) {
    col.r = textureSampleLevel(scene, samp, uv + vec2f(ab, 0.0), 0.0).r;
    col.b = textureSampleLevel(scene, samp, uv - vec2f(ab, 0.0), 0.0).b;
  }
  let b = textureSampleLevel(bloom, samp, uv, 0.0).rgb * p.fx2.x;
  col = col + b;
  a = max(a, clamp(max(b.r, max(b.g, b.b)), 0.0, 1.0));
  // vignette: the corners of the room fall away
  let vq = (i.uv - 0.5) * vec2f(1.15, 1.0);
  col = col * mix(1.0, smoothstep(0.95, 0.3, length(vq)), p.fx2.z);
  col = col + vec3f(p.fx.w);
  a = max(a, p.fx.w);
  let g = h2(i.uv * p.view.xy + vec2f(p.view.z * 61.0, p.view.z * 17.0));
  col = col + (g - 0.5) * p.fx2.y * a;
  return vec4f(col, a);
}
`

export const BLOOM = /* wgsl */ `
struct B { dir: vec4f }
@group(0) @binding(0) var<uniform> b: B;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  let xy = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: VO;
  o.pos = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(xy.x, 1.0 - xy.y);
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let w = array<f32, 7>(0.03, 0.11, 0.22, 0.28, 0.22, 0.11, 0.03);
  var acc = vec3f(0.0);
  for (var k = 0; k < 7; k = k + 1) {
    let c = textureSampleLevel(src, samp, i.uv + b.dir.xy * f32(k - 3), 0.0).rgb;
    var v = c;
    if (b.dir.z > 0.5) { v = max(c - vec3f(b.dir.w), vec3f(0.0)); }
    acc = acc + v * w[k];
  }
  return vec4f(acc, 1.0);
}
`
