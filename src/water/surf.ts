/**
 * The surf: one model of the waves that reach the island, shared by the sea surface (Ocean.ts), the sand
 * (TerrainMaterial.ts) and the spray (Spray.ts), so the water, its foam, the wet sand and the spray agree.
 *
 * Waves come in sets (a period of ~7.5 s, warped so no two intervals are equal) and travel shoreward along the
 * distance-to-shore field, slowing with depth: their arrival time is the shallow-water travel time over each coast
 * kind's sea-bed profile (the same profiles tools/gen-island.ts carves). A wave steepens as the depth falls toward
 * 1.3 wave heights, breaks, and runs on as a bore whose height follows the depth. On beaches the bore turns into a
 * swash sheet whose front runs up the beach face, decelerating, in lobes (standing beach cusps plus noise that is new
 * for every wave), stops and drains back; the sand keeps a mirror film for a few seconds where the sheet has just
 * drained and stays damp below the reach of the run-up. At sea cliffs the wave meets deep water and bursts at the
 * foot of the wall.
 *
 * Foam is born in the roller just behind each broken front and ages behind it. It is drawn by thresholding a
 * bubble-raft lace pattern with the foam amount, so it thins from solid white to a net of lines to nothing; every
 * wave reads a different part of the pattern, carried shoreward with the bore.
 */
import * as THREE from 'three/webgpu';
import {
  abs, atan, clamp, cos, exp, float, floor, fract, hash, length, max, min, mix, mx_noise_float, normalize, pow,
  select, sin, smoothstep, sqrt, texture, uniform, vec2, vec3, type N,
} from '../core/tsl';
import type { Heightfield } from '../world/Heightfield';
import { HALF_WORLD, WORLD_SIZE } from '../world/layout';

export const surfU = {
  time: uniform(0),
  /** mean wave period (s) */
  period: uniform(7.5),
  /** breaker height on open beaches (m); rock shelves and cliffs see more, the village cove far less */
  height: uniform(0.52),
  /** mean run-up of the swash up a beach face (m, horizontal) */
  runup: uniform(4.2),
  /** 0..1 rough weather: bigger sets, longer run-up, more foam */
  storm: uniform(0),
};

const G = 9.81;
const TAU = Math.PI * 2;
/** the village cove: sheltered by its headlands and the skerry, so its moorings stay calm */
const COVE: [number, number] = [-455, 425];

// ---------------------------------------------------------------- the lace pattern
/** wrapped box blur of radius r along one axis (running sum) */
function boxWrap(src: Float32Array, n: number, r: number, horizontal: boolean): Float32Array {
  const out = new Float32Array(n * n);
  const w = 2 * r + 1;
  for (let line = 0; line < n; line++) {
    const at = (i: number) => (horizontal ? src[line * n + (((i % n) + n) % n)] : src[(((i % n) + n) % n) * n + line]);
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += at(i);
    for (let i = 0; i < n; i++) {
      if (horizontal) out[line * n + i] = sum / w;
      else out[i * n + line] = sum / w;
      sum += at(i + r + 1) - at(i - r);
    }
  }
  return out;
}
/** three box passes per axis: a Gaussian of about this sigma (texels), tileable */
function gaussWrap(src: Float32Array, n: number, sigma: number) {
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  let a = src;
  for (let k = 0; k < 3; k++) a = boxWrap(boxWrap(a, n, r, true), n, r, false);
  return a;
}
/** band-passed white noise (difference of two Gaussians), unit RMS, tileable */
function bandpass(seed: number, n: number, s1: number, s2: number) {
  let st = seed >>> 0;
  const white = new Float32Array(n * n);
  for (let i = 0; i < white.length; i++) {
    st = (Math.imul(st, 1664525) + 1013904223) >>> 0;
    white[i] = st / 4294967296 - 0.5;
  }
  const a = gaussWrap(white, n, s1), b = gaussWrap(white, n, s2);
  const out = new Float32Array(n * n);
  let sq = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] = a[i] - b[i];
    sq += out[i] * out[i];
  }
  const k = 1 / Math.sqrt(sq / out.length);
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
}

/**
 * RGBA, tileable, 256 texels per repeat: R the lace (a bubble-raft web of meandering lines where foam collects,
 * times clumps), G fine bubbles, B coarse clumps (patchiness of the cover), A a second, coarser web.
 * Approach after the foam pattern of the threejs-spectral-ocean skill's coastal breaker example (MIT, CREDITS.md).
 */
function lacePattern() {
  const n = 256;
  const web = bandpass(777, n, 2, 6), mid = bandpass(778, n, 3, 9), fine = bandpass(779, n, 1, 2.5);
  const bub = bandpass(780, n, 0.7, 1.8), clump = bandpass(781, n, 10, 28), web2 = bandpass(782, n, 3.5, 10);
  const data = new Uint8Array(n * n * 4);
  const u8 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  for (let i = 0; i < n * n; i++) {
    const w = Math.max(0, 1 - 1.25 * Math.abs(web[i]));
    data[i * 4] = u8(0.55 * w * w + 0.22 + 0.1 * mid[i] + 0.06 * fine[i]);
    data[i * 4 + 1] = u8(0.5 + 0.3 * bub[i]);
    data[i * 4 + 2] = u8(0.5 + 0.28 * clump[i]);
    data[i * 4 + 3] = u8(Math.max(0, 1 - 1.25 * Math.abs(web2[i])));
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}
export const laceTex = lacePattern();
/** metres per repeat of the lace pattern */
const LACE_M = 11;

// ---------------------------------------------------------------- the coast frame
export interface Coast {
  /** signed distance to the waterline (m), positive on land */
  s: N;
  /** distance offshore (m, 0 on land) */
  d: N;
  /** coast kind 0 beach .. 1 rock shelf .. 2 sea cliff, and its hat weights */
  kind: N; wb: N; wr: N; wc: N;
  /** along-shore coordinate (m, roughly arc length around the island) */
  along: N;
  /** unit vector toward land */
  nrm: N;
  /** 0 open coast .. 1 inside the village cove */
  shelter: N;
}

export function coastAt(hf: Heightfield, xz: N): Coast {
  const uvAt = (p: N) => p.add(HALF_WORLD).div(WORLD_SIZE);
  const sAt = (p: N) => texture(hf.shoreTex, uvAt(p)).level(0).r;
  const here = texture(hf.shoreTex, uvAt(xz)).level(0);
  const s = here.r;
  const e = 2.0;
  const gx = sAt(xz.add(vec2(e, 0))).sub(sAt(xz.sub(vec2(e, 0))));
  const gz = sAt(xz.add(vec2(0, e))).sub(sAt(xz.sub(vec2(0, e))));
  const nrm = normalize(vec2(gx, gz).add(vec2(1e-4, 0)));
  const kind = here.g.mul(2);
  const wb = clamp(float(1).sub(kind), 0, 1);
  const wr = clamp(float(1).sub(abs(kind.sub(1))), 0, 1);
  const wc = clamp(kind.sub(1), 0, 1);
  const along = atan(xz.y.add(35), xz.x).mul(650);
  const shelter = float(1).sub(smoothstep(150, 290, length(xz.sub(vec2(...COVE)))));
  return { s, d: max(s.negate(), 0), kind, wb, wr, wc, along, nrm, shelter };
}

// ---------------------------------------------------------------- the wave train
/** shallow-water travel time (s) from distance d offshore to the waterline over a sloping bed h0 + m d, then deep */
function travel(d: N, h0: number, m: number, dStar: number, cDeep: number) {
  const dc = min(d, dStar);
  const lin = sqrt(dc.mul(m).add(h0).mul(G)).sub(Math.sqrt(G * h0)).mul(2 / (m * G));
  return lin.add(max(d.sub(dStar), 0).div(cDeep));
}

/** sea-bed depth (m) of the coast kinds' profiles, without their noise */
function bedDepth(c: Coast) {
  const db = c.d.min(170).mul(0.021).add(0.12).add(max(c.d.sub(170), 0).mul(0.172));
  const dr = c.d.mul(0.11).add(0.4);
  const dcl = c.d.mul(0.26).add(5);
  const prof = db.mul(c.wb).add(dr.mul(c.wr)).add(dcl.mul(c.wc));
  // the bake eases the bed up to the waterline over the last 5 m
  return prof.mul(smoothstep(0, 5, c.d).mul(0.6).add(0.4));
}

/** time warped smoothly so wave intervals vary by about +-30 % */
function warpedTime() {
  const t = surfU.time;
  return t.add(sin(t.mul(TAU / 41)).mul(0.9)).add(sin(t.mul(TAU / 17).add(1.3)).mul(0.5));
}
/** set modulation of a wave's height: every sixth wave or so is a big one, with scatter */
function setFactor(n: N) {
  return sin(n.mul(TAU / 6.3).add(0.7)).mul(0.25).add(0.72).add(hash(n.add(5000)).sub(0.5).mul(0.22));
}

/** at the waterline: the latest wave's index and the seconds since its front reached it */
export function waterlinePhase(c: Coast) {
  const P = surfU.period;
  const wob = mx_noise_float(vec3(c.along.div(90), surfU.time.div(60), 3.1)).mul(0.35);
  const phi0 = warpedTime().div(P).add(wob);
  return { n0: floor(phi0), tau0: fract(phi0).mul(P) };
}

export interface Waves {
  /** surface elevation of the near-shore wave (m) and its slope toward land (dEta/ds) */
  eta: N; slope: N;
  /** foam cover 0..1 (before the lace threshold), bubbles under the surface 0..1 */
  foam: N; aerated: N;
  /** wave index, phase 0..1 after the front passed, seconds since it passed */
  n: N; f: N; age: N;
  /** 0 unbroken .. 1 broken (a bore) */
  broken: N;
  /** at the waterline: wave index and seconds since its front reached it (drives the swash and cliff bursts) */
  n0: N; tau0: N;
}

export function waves(c: Coast): Waves {
  const P = surfU.period;
  const tw = warpedTime();
  const T = travel(c.d, 0.27, 0.021, 170, 9).mul(c.wb).add(travel(c.d, 0.55, 0.11, 107, 11).mul(c.wr)).add(travel(c.d, 5.15, 0.26, 27, 11).mul(c.wc));
  const wob = mx_noise_float(vec3(c.along.div(90), surfU.time.div(60), 3.1)).mul(0.35);
  const phi = tw.add(T).div(P).add(wob);
  const n = floor(phi);
  const f = fract(phi);
  const age = f.mul(P);
  const D = bedDepth(c);
  const cLocal = min(sqrt(D.add(0.15).mul(G)), 11);
  // height of this wave here: coast kind, the set, along the crest, the weather, the cove's shelter
  const kindH = c.wb.add(c.wr.mul(1.5)).add(c.wc.mul(2.2));
  const along = mx_noise_float(vec3(c.along.div(38), n.mul(0.73), 1.9)).mul(0.22).add(1);
  const H = surfU.height.mul(kindH).mul(setFactor(n)).mul(along).mul(surfU.storm.mul(0.8).add(1)).mul(float(1).sub(c.shelter.mul(0.78))).max(0.02);
  // depth ratio: breaking where the depth falls under ~1.3 wave heights
  const q = D.mul(0.78).div(H);
  const broken = smoothstep(1.15, 0.85, q);
  const Hs = H.mul(min(pow(max(q, 0.05), -0.25), 1));
  const Hb = min(H, D.mul(0.62).add(0.02));
  // unbroken: a skewed Stokes-like crest at f = 0, steepening toward the break
  const K = mix(float(0.3), float(0.88), smoothstep(2.2, 1.0, q));
  const th = f.mul(TAU).sub(K.mul(float(1).sub(cos(f.mul(TAU)))));
  const dth = float(1).sub(K.mul(sin(f.mul(TAU)))).mul(TAU);
  const etaU = Hs.mul(cos(th).mul(0.5).add(cos(th.mul(2)).mul(0.09)));
  const dU = Hs.mul(sin(th).mul(-0.5).sub(sin(th.mul(2)).mul(0.18))).mul(dth);
  // broken: a bore, a sawtooth with its jump at f = 0 eased over the last few hundredths of the cycle
  const Dl = 0.035;
  const fall = pow(float(1).sub(f), 1.7);
  const x = clamp(f.sub(1 - Dl).div(Dl), 0, 1);
  const rise = x.mul(x).mul(float(3).sub(x.mul(2)));
  const B = max(fall, rise);
  const dB = select(rise.greaterThan(fall), x.mul(float(1).sub(x)).mul(6 / Dl), pow(float(1).sub(f), 0.7).mul(-1.7));
  const meanB = 1 / 2.7 + Dl / 2;
  const etaB = Hb.mul(B.sub(meanB));
  const dBd = Hb.mul(dB);
  // only the near-shore band; the spectral sea owns the open water
  const near = float(1).sub(smoothstep(40, 75, c.d)).mul(float(1).sub(smoothstep(-1.0, 0.5, c.s)));
  const eta = mix(etaU, etaB, broken).mul(near);
  // dPhi/ds = -1 / (P c): the phase falls toward land
  const slope = mix(dU, dBd, broken).mul(near).div(P.mul(cLocal)).negate();

  // foam: the roller just behind a broken front, then its residue ageing behind it (and a trace of the wave before)
  const roller = broken.mul(smoothstep(0.0, 0.012, f)).mul(float(1).sub(smoothstep(0.05, 0.24, f)));
  const residue = exp(age.div(-3.2)).mul(0.72).add(exp(age.div(-10)).mul(0.3)).add(exp(age.add(P).div(-10)).mul(0.3));
  const energy = mix(float(0.55), float(1), Hb.div(H).clamp(0, 1));
  const varyF = mx_noise_float(vec3(c.along.div(21), n.mul(1.91), 7.7)).mul(0.25).add(0.95);
  // a steep crest about to break whitens along its top
  const spill = smoothstep(1.4, 1.0, q).mul(float(1).sub(broken)).mul(smoothstep(0.93, 0.995, f)).mul(0.8);
  // the cove's ripples break with barely a fringe of bubbles
  const calm = float(1).sub(c.shelter.mul(0.75));
  let foam: N = max(max(roller, residue.mul(broken).mul(energy).mul(varyF)), spill).mul(calm);
  let aerated: N = broken.mul(exp(age.div(-3.2))).mul(calm);

  // at the waterline (d = 0): the wave index and the time since its front arrived
  const { n0, tau0 } = waterlinePhase(c);
  // sea cliffs: the wave bursts white at the foot and the backwash spreads lace out from the wall
  const H0 = surfU.height.mul(2.2).mul(setFactor(n0)).mul(surfU.storm.mul(0.8).add(1));
  const burst = exp(tau0.div(-1.6)).mul(float(1).sub(smoothstep(tau0.mul(3.0).add(3.0), tau0.mul(3.0).add(7.0), c.d)));
  const band = float(1).sub(smoothstep(2.0, 11.0, c.d)).mul(exp(tau0.div(-2.5)).mul(0.35).add(0.5));
  // the backwash carries the white water out from the wall as lace that thins over the rest of the cycle
  const spread = exp(tau0.div(-6.5)).mul(float(1).sub(smoothstep(tau0.mul(2.4).add(6), tau0.mul(2.6).add(16), c.d))).mul(0.72);
  const alongC = mx_noise_float(vec3(c.along.div(9), n0.mul(0.61), 2.3)).mul(0.35).add(0.85);
  const cliff = c.wc.mul(max(max(burst, band), spread)).mul(alongC).mul(H0.div(0.92).clamp(0.4, 1.4)).mul(float(1).sub(c.shelter));
  foam = max(foam, cliff);
  aerated = max(aerated, c.wc.mul(float(1).sub(smoothstep(1, 10, c.d))).mul(exp(tau0.div(-2.2)).mul(0.5).add(0.5)));
  return { eta, slope, foam: foam.clamp(0, 1), aerated: aerated.clamp(0, 1), n, f, age, broken, n0, tau0 };
}

// ---------------------------------------------------------------- the swash
interface Run { R: N; tu: N; td: N; tau: N }
function run(c: Coast, n: N, tau: N): Run {
  const kindRun = c.wb.add(c.wr.mul(0.45)).mul(float(1).sub(c.wc));
  const cusp = sin(c.along.mul(TAU / 17).add(mx_noise_float(vec3(c.along.div(60), 0.5, 4.4)).mul(1.8))).mul(0.26);
  const lobes = cusp.add(1)
    .add(mx_noise_float(vec3(c.along.div(6.5), n.mul(1.37), 0.3)).mul(0.22))
    .add(mx_noise_float(vec3(c.along.div(2.3), n.mul(2.71), 5.5)).mul(0.12));
  const R = surfU.runup.mul(kindRun).mul(setFactor(n)).mul(lobes).mul(surfU.storm.mul(0.5).add(1)).mul(float(1).sub(c.shelter.mul(0.65))).max(0.05);
  // the front does not reach every part of the beach at once
  const late = mx_noise_float(vec3(c.along.div(13), n.mul(3.3), 8.1)).mul(0.45);
  return { R, tu: R.mul(0.38).add(1.4), td: R.mul(0.6).add(2.0), tau: max(tau.sub(late), 0) };
}
/** position of the swash front up the beach (m from the still waterline): decelerating run-up, then the drain */
function front(r: Run) {
  const u = r.tau.div(r.tu);
  const up = r.R.mul(float(1).sub(float(1).sub(u).pow(2)));
  const v = r.tau.sub(r.tu).div(r.td);
  const down = max(r.R.sub(r.R.add(2.5).mul(v.mul(v))), -2.5);
  return select(u.lessThan(1), up, down);
}

export interface Swash {
  /** sheet surface above the ground (m; negative where the sand is dry) */
  sheet: N;
  /** foam on the sheet: the bubbly lip of the running-up front, the bore's residue thinning on the sheet */
  lip: N; sheetFoam: N;
  /** sand: mirror film 0..1 (covered or just drained), damp 0..1 (below the reach of the run-up) */
  gloss: N; damp: N;
  /** a line of stranded bubbles where the last run-up stopped, popping */
  strand: N;
  /** 0 uprush .. 1 backwash, of the latest wave */
  back: N;
}

export function swash(c: Coast, w: { n0: N; tau0: N }): Swash {
  const P = surfU.period;
  const a = run(c, w.n0, w.tau0);
  const b = run(c, w.n0.sub(1), w.tau0.add(P));
  const fa = front(a), fb = front(b);
  const thick = (r: Run, fr: N) => mix(float(0.035), float(0.011), smoothstep(r.tu, r.tu.add(1.8), r.tau)).mul(fr.sub(c.s));
  const sheet = max(thick(a, fa), thick(b, fb)).min(0.2);
  // the lip: dense bubbles at the running-up front, gone as it stalls
  const ua = a.tau.div(a.tu);
  const calm = float(1).sub(c.shelter.mul(0.7));
  const lip = smoothstep(-0.05, 0.05, fa.sub(c.s)).mul(float(1).sub(smoothstep(0.0, ua.mul(0.8).add(0.45), fa.sub(c.s)))).mul(float(1).sub(smoothstep(0.65, 1.0, ua))).mul(calm);
  const sheetFoam = smoothstep(0, 0.4, fa.sub(c.s)).mul(exp(a.tau.div(-2.2)).mul(0.85)).mul(calm);
  // wetness of the sand: covered by a wave since it reached here, then a film draining for a couple of seconds
  const film = (r: Run) => {
    const reach = r.tu.mul(float(1).sub(sqrt(float(1).sub(c.s.div(r.R).clamp(0, 1)))));
    const unc = r.tu.add(r.td.mul(sqrt(r.R.sub(c.s).div(r.R.add(2.5)).max(0))));
    const wetted = r.tau.greaterThan(reach).and(c.s.lessThan(r.R));
    return select(wetted, exp(max(r.tau.sub(unc), 0).div(-2.2)), float(0));
  };
  const gloss = max(film(a), film(b).mul(0.85));
  const kindRun = c.wb.add(c.wr.mul(0.45)).mul(float(1).sub(c.wc));
  const env = surfU.runup.mul(kindRun).mul(sin(c.along.mul(TAU / 17).add(mx_noise_float(vec3(c.along.div(60), 0.5, 4.4)).mul(1.8))).mul(0.26).add(1.15))
    .mul(surfU.storm.mul(0.5).add(1)).mul(float(1).sub(c.shelter.mul(0.65)));
  const damp = smoothstep(env.add(1.6), env.sub(0.8), c.s).mul(smoothstep(0.05, 0.4, kindRun));
  const strandAt = (r: Run, fr: N) => smoothstep(r.tu, r.tu.add(0.3), r.tau).mul(exp(r.tau.sub(r.tu).div(-1.7)))
    .mul(float(1).sub(smoothstep(0.06, 0.4, abs(c.s.sub(r.R.sub(0.1)))))).mul(smoothstep(0.0, 0.15, c.s.sub(fr)));
  const strand = max(strandAt(a, fa), strandAt(b, fb).mul(0.5));
  const back = smoothstep(0.85, 1.1, ua);
  return { sheet, lip, sheetFoam, gloss, damp, strand, back };
}

// ---------------------------------------------------------------- drawing foam
/**
 * Foam cover 0..1 -> visible foam 0..1: the lace pattern thresholded by the cover, so solid at 1, a net of lines
 * around 0.4 and nothing at 0. Every wave reads its own part of the pattern, carried toward land by `drift` metres.
 */
export function laceMask(amount: N, xz: N, n: N, nrm: N, drift: N, stretch: N = float(0)) {
  const off = vec2(hash(n.add(9100)), hash(n.add(9300))).mul(LACE_M * 7);
  const p = xz.sub(nrm.mul(drift)).add(off);
  // stretched across the shore by the backwash
  const across = nrm.mul(p.dot(nrm));
  const q = p.sub(across.mul(stretch.mul(0.6)));
  const t1 = texture(laceTex, q.div(LACE_M));
  const t2 = texture(laceTex, q.div(LACE_M * 2.7).add(0.37));
  const pat = t1.r.mul(0.62).add(t2.a.mul(0.38));
  const cover = amount.mul(mix(float(0.7), float(1.25), t2.b));
  return smoothstep(0, 0.16, pat.sub(float(1.04).sub(cover.mul(1.12))));
}

/** fine bubbly foam (the swash lip, stranded lines): a granular threshold */
export function bubbleMask(amount: N, xz: N) {
  const t = texture(laceTex, xz.div(LACE_M * 0.45).add(0.11));
  return smoothstep(0, 0.2, t.g.sub(float(1.0).sub(amount.mul(1.05)))).mul(smoothstep(0.0, 0.1, amount));
}
