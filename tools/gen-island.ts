/**
 * Offline island baker: turns the authored layout (src/world/layout.ts) into the heightmap and the material masks
 * the game streams in. Deterministic; run with `pnpm gen:island` (writes public/world/*.bin.gz and a relief preview
 * to E:\tmp\island\preview.png).
 *
 * Pipeline: coastline spline -> rasterised island mask -> signed distance to the coast (exact Euclidean distance
 * transform) with the coast's kind (beach, rock shelf, sea cliff) carried from the nearest coast point -> island body
 * from smooth-max hills, the summit cone and ridged erosion noise -> coastal profiles (sand shelf and lagoon, rock
 * shelves, sea cliffs) -> escarpment step -> river valley, the falls and the plunge pool -> levelled village and
 * lighthouse platform -> trails -> masks.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  COAST, ESCARPMENT, FALLS_INDEX, HALF_WORLD, HEIGHT_RES, HILLS, H_MAX, H_MIN, ISLETS, LIGHTHOUSE, MASK_RES, PATHS, PEAK,
  POOL, RIVER, VILLAGE, WORLD_SIZE, type V2,
} from '../src/world/layout.ts';
import { Noise2, clamp, lerp, smax, smin, smoothstep } from '../src/core/noise.ts';

const N = HEIGHT_RES;
const CELL = WORLD_SIZE / N;
const outDir = join(import.meta.dirname, '..', 'public', 'world');
const previewDir = 'E:\\tmp\\island';
mkdirSync(outDir, { recursive: true });
mkdirSync(previewDir, { recursive: true });

const noise = new Noise2(1337);
const noiseB = new Noise2(4242);
const noiseC = new Noise2(777);
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

const wx = (i: number) => -HALF_WORLD + (i + 0.5) * CELL;

// ---------------------------------------------------------------- coastline
interface DensePt { x: number; z: number; kind: number }
function catmull(p0: V2, p1: V2, p2: V2, p3: V2, t: number): V2 {
  const t2 = t * t, t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}

function densifyCoast(): DensePt[] {
  const n = COAST.length;
  const raw: DensePt[] = [];
  for (let i = 0; i < n; i++) {
    const a = COAST[(i - 1 + n) % n], b = COAST[i], c = COAST[(i + 1) % n], d = COAST[(i + 2) % n];
    const len = Math.hypot(c.p[0] - b.p[0], c.p[1] - b.p[1]);
    const steps = Math.max(4, Math.ceil(len / 0.8));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const [x, z] = catmull(a.p, b.p, c.p, d.p, t);
      const tk = t * t * (3 - 2 * t);
      raw.push({ x, z, kind: lerp(b.kind, c.kind, tk) });
    }
  }
  // warp along the normal: smooth sand, ragged rock
  const out: DensePt[] = [];
  let arc = 0;
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i], q = raw[(i + 1) % raw.length], o = raw[(i - 1 + raw.length) % raw.length];
    arc += Math.hypot(q.x - p.x, q.z - p.z);
    const tx = q.x - o.x, tz = q.z - o.z, tl = Math.hypot(tx, tz) || 1;
    const nx = tz / tl, nz = -tx / tl;
    const rockAmt = clamp(p.kind, 0, 2) / 2;
    const amp = lerp(2.2, 11, rockAmt);
    const w = noise.simplex(arc / 90, 3.1) * 0.6 + noise.simplex(arc / 31, 7.7) * 0.3 * (0.3 + rockAmt) +
      noise.simplex(arc / 9, 1.9) * 0.18 * rockAmt;
    out.push({ x: p.x + nx * amp * w, z: p.z + nz * amp * w, kind: p.kind });
  }
  return out;
}

const coast = densifyCoast();
/** islets: noisy ellipses, each its own closed ring */
const isletRings: DensePt[][] = ISLETS.map((is, k) => {
  const ring: DensePt[] = [];
  const n = Math.ceil((2 * Math.PI * Math.max(is.rx, is.rz)) / 0.8);
  for (let s = 0; s < n; s++) {
    const a = (s / n) * Math.PI * 2;
    const wob = 1 + 0.16 * noise.simplex(Math.cos(a) * 1.6 + k * 7, Math.sin(a) * 1.6) + 0.07 * noiseB.simplex(Math.cos(a) * 5 + k, Math.sin(a) * 5);
    const lx = Math.cos(a) * is.rx * wob, lz = Math.sin(a) * is.rz * wob;
    const c = Math.cos(is.rot), sn = Math.sin(is.rot);
    ring.push({ x: is.c[0] + lx * c - lz * sn, z: is.c[1] + lx * sn + lz * c, kind: is.kind });
  }
  return ring;
});
const allCoast = [coast, ...isletRings];
log(`coast: ${coast.length} points, ${isletRings.length} islets`);

// rasterise the polygons (even-odd) at texel centres
const inside = new Uint8Array(N * N);
{
  const edges: [number, number, number, number][] = [];
  for (const ring of allCoast) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    edges.push([a.x, a.z, b.x, b.z]);
  }
  for (let j = 0; j < N; j++) {
    const z = wx(j);
    const xs: number[] = [];
    for (const [x0, z0, x1, z1] of edges) {
      if ((z0 <= z && z1 > z) || (z1 <= z && z0 > z)) xs.push(x0 + ((z - z0) / (z1 - z0)) * (x1 - x0));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] + HALF_WORLD) / CELL - 0.5));
      const i1 = Math.min(N - 1, Math.floor((xs[k + 1] + HALF_WORLD) / CELL - 0.5));
      for (let i = i0; i <= i1; i++) inside[j * N + i] = 1;
    }
  }
}
log('rasterised island');

// ---------------------------------------------------------------- exact EDT with nearest-feature index
/** squared Euclidean distance transform (Felzenszwalb-Huttenlocher) to the pixels where feature[i] = 1 */
function edt(feature: Uint8Array, n: number): { dist: Float32Array; nearest: Int32Array } {
  const INF = 1e20;
  const colD = new Float64Array(n * n);
  const colIdx = new Int32Array(n * n);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n), arg = new Int32Array(n);
  const pass = (len: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
      arg[q] = v[k];
    }
  };
  // columns
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) f[y] = feature[y * n + x] ? 0 : INF;
    pass(n);
    for (let y = 0; y < n; y++) {
      colD[y * n + x] = d[y];
      colIdx[y * n + x] = arg[y];
    }
  }
  const dist = new Float32Array(n * n);
  const nearest = new Int32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) f[x] = colD[y * n + x];
    pass(n);
    for (let x = 0; x < n; x++) {
      dist[y * n + x] = Math.sqrt(d[x]);
      const fx = arg[x];
      nearest[y * n + x] = colIdx[y * n + fx] * n + fx;
    }
  }
  return { dist, nearest };
}

const outside = new Uint8Array(N * N);
for (let i = 0; i < N * N; i++) outside[i] = inside[i] ? 0 : 1;
const dIn = edt(outside, N); // for inside pixels: distance to the sea
const dOut = edt(inside, N); // for sea pixels: distance to land
const sd = new Float32Array(N * N);
for (let i = 0; i < N * N; i++) sd[i] = (inside[i] ? dIn.dist[i] - 0.5 : -(dOut.dist[i] - 0.5)) * CELL;
log('signed distance to the coast');

// coast kind at every texel, from the nearest coast point
const kindGrid = new Float32Array(N * N).fill(NaN);
for (const p of allCoast.flat()) {
  const i = Math.floor((p.x + HALF_WORLD) / CELL), j = Math.floor((p.z + HALF_WORLD) / CELL);
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const ii = i + di, jj = j + dj;
    if (ii >= 0 && jj >= 0 && ii < N && jj < N) kindGrid[jj * N + ii] = p.kind;
  }
}
let kind = new Float32Array(N * N);
for (let i = 0; i < N * N; i++) {
  const nIdx = inside[i] ? dIn.nearest[i] : dOut.nearest[i];
  let k = kindGrid[nIdx];
  if (Number.isNaN(k)) {
    const nx = nIdx % N, ny = Math.floor(nIdx / N);
    outer: for (let r = 1; r < 4; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const ii = clamp(nx + di, 0, N - 1), jj = clamp(ny + dj, 0, N - 1);
      const kk = kindGrid[jj * N + ii];
      if (!Number.isNaN(kk)) {
        k = kk;
        break outer;
      }
    }
  }
  kind[i] = Number.isNaN(k) ? 1 : k;
}
/** separable box blur, in place over a few passes */
function blur(src: Float32Array, n: number, r: number, passes: number): Float32Array {
  let a = src, b = new Float32Array(n * n);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < n; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += a[y * n + clamp(x, 0, n - 1)];
      for (let x = 0; x < n; x++) {
        b[y * n + x] = acc / (2 * r + 1);
        acc += a[y * n + clamp(x + r + 1, 0, n - 1)] - a[y * n + clamp(x - r, 0, n - 1)];
      }
    }
    for (let x = 0; x < n; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += b[clamp(y, 0, n - 1) * n + x];
      for (let y = 0; y < n; y++) {
        a[y * n + x] = acc / (2 * r + 1);
        acc += b[clamp(y + r + 1, 0, n - 1) * n + x] - b[clamp(y - r, 0, n - 1) * n + x];
      }
    }
  }
  return a;
}
kind = blur(kind, N, 10, 2);
log('coast kinds');

// ---------------------------------------------------------------- polyline helpers
interface Near { d: number; s: number; seg: number; t: number; side: number }
function nearestOnPolyline(pts: V2[], x: number, z: number, cum: number[]): Near {
  let best: Near = { d: 1e9, s: 0, seg: 0, t: 0, side: 0 };
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    const t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
    const px = ax + dx * t, pz = az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best.d) {
      const cross = dx * (z - az) - dz * (x - ax);
      best = { d, s: cum[i] + t * Math.sqrt(l2), seg: i, t, side: cross };
    }
  }
  return best;
}
const cumLen = (pts: V2[]) => {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return c;
};

const riverPts = RIVER.map((r) => r.p);
const riverCum = cumLen(riverPts);
const escPts = ESCARPMENT.map((e) => e.p);
const escCum = cumLen(escPts);
const pathCums = PATHS.map(cumLen);

function riverWidth(seg: number, t: number) {
  const a = RIVER[seg], b = RIVER[Math.min(seg + 1, RIVER.length - 1)];
  return lerp(a.w, b.w, t);
}

// ---------------------------------------------------------------- trail corridors
// distance to the nearest trail: the erosion noise is calmed near trails so they run along smooth shoulders
const trailDist = (() => {
  const m = new Uint8Array(N * N);
  for (const pts of PATHS) for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
    const len = Math.hypot(bx - ax, bz - az);
    for (let s = 0; s <= len; s += 0.5) {
      const x = lerp(ax, bx, s / len), z = lerp(az, bz, s / len);
      const i = Math.floor((x + HALF_WORLD) / CELL), j = Math.floor((z + HALF_WORLD) / CELL);
      if (i >= 0 && j >= 0 && i < N && j < N) m[j * N + i] = 1;
    }
  }
  const r = edt(m, N);
  for (let i = 0; i < N * N; i++) r.dist[i] *= CELL;
  return r.dist;
})();
log('trail corridors');

// ---------------------------------------------------------------- the island body
function hillsAt(x: number, z: number, calm: number, ux: number, uz: number) {
  let m = 0;
  for (const h of HILLS) {
    const d = Math.hypot(x - h.p[0], z - h.p[1]) / h.r;
    if (d >= 1) continue;
    const v = h.h * Math.pow(1 - d * d, h.e);
    m = m === 0 ? v : smax(m, v, 9);
  }
  // the summit cone (unwarped, so the summit stays under the lighthouse), its flanks broken into spurs
  const dp = Math.hypot(ux - PEAK.p[0], uz - PEAK.p[1]);
  if (dp < 600) {
    // spurs: ridged noise in warped polar coordinates, so ridges radiate but curve and branch outward
    let ang = Math.atan2(uz - PEAK.p[1], ux - PEAK.p[0]);
    ang += 0.16 * noiseC.fbm(dp / 160, ang * 1.3, 3) + 0.05 * noise.simplex(dp / 60, ang * 4);
    const R0 = 1.7 + dp / 230;
    const spur = noiseB.ridged(Math.cos(ang) * R0 + 3.1, Math.sin(ang) * R0 - 1.7, 4);
    const cone = PEAK.h * Math.pow(1 - dp / 600, 1.5) * (1 + 0.3 * (spur - 0.5) * smoothstep(20, 160, dp) * calm);
    m = smax(m, cone, 10);
  }
  return m;
}
function isletsAt(x: number, z: number) {
  let m = 0;
  for (const is of ISLETS) {
    const c = Math.cos(-is.rot), s = Math.sin(-is.rot);
    const lx = (x - is.c[0]) * c - (z - is.c[1]) * s, lz = (x - is.c[0]) * s + (z - is.c[1]) * c;
    const d = Math.hypot(lx / (is.rx * 1.25), lz / (is.rz * 1.25));
    if (d < 1) m = Math.max(m, is.h * Math.pow(1 - d * d, is.e) * (1 + 0.15 * noiseC.simplex(x / 6, z / 6)));
  }
  return m;
}

function bodyAt(x: number, z: number, calmDist: number) {
  const calm = 0.3 + 0.7 * smoothstep(6, 45, calmDist);
  // domain warp for organic forms
  const qx = x + noise.fbm(x / 420, z / 420, 3) * 70;
  const qz = z + noise.fbm(x / 420 + 5.2, z / 420 - 1.3, 3) * 70;
  let m = hillsAt(qx, qz, calm, x, z);
  // erosion-like gullies and ridges, stronger on high ground
  const r = noise.ridged(qx / 190, qz / 190, 5);
  const r2 = noiseC.ridged(qx / 70, qz / 70, 4);
  const hi = smoothstep(8, 90, m);
  m += m * (0.2 * (r - 0.42) + 0.06 * (r2 - 0.42)) * hi * calm;
  m = Math.max(m, isletsAt(x, z));
  // gentle undulation of the lowland jungle floor
  m += 2.2 * noise.fbm(x / 85, z / 85, 4) + 0.6 * noiseB.fbm(x / 23, z / 23, 3);
  return m;
}

const H = new Float32Array(N * N);
const pathW = new Float32Array(N * N); // 1 on trails
const riverD = new Float32Array(N * N).fill(1e9); // distance to the river's edge (negative inside the channel)

// coastal profiles
function landProfile(sdv: number, k: number, m: number) {
  const wb = clamp(1 - k, 0, 1), wr = clamp(1 - Math.abs(k - 1), 0, 1), wc = clamp(k - 1, 0, 1);
  const sum = wb + wr + wc;
  const beach = sdv < 30 ? 0.065 * sdv : sdv < 65 ? 1.95 + (sdv - 30) * 0.045 : Math.min(3.53 + (sdv - 65) * 0.02, 4.5);
  const rock = Math.min(sdv * 0.55, 5);
  const cliff = Math.min(sdv * 0.9, 2.5);
  const base = (beach * wb + rock * wr + cliff * wc) / sum;
  const w = (110 * wb + 32 * wr + 9 * wc) / sum;
  return base + Math.max(0, m - base) * smoothstep(0, w, sdv);
}
function seabed(d: number, k: number, x: number, z: number) {
  const wb = clamp(1 - k, 0, 1), wr = clamp(1 - Math.abs(k - 1), 0, 1), wc = clamp(k - 1, 0, 1);
  const sum = wb + wr + wc;
  let beach = d < 170 ? -(0.12 + 0.021 * d) : -3.69 - Math.min(d - 170, 165) * 0.172 - Math.max(0, d - 335) * 0.035;
  // lagoon: sand waves and patch reefs
  const lag = 1 - smoothstep(120, 190, d);
  beach += lag * (0.35 * noise.simplex(x / 22, z / 22) + 1.4 * smoothstep(0.35, 0.75, noiseB.fbm(x / 38, z / 38, 3)) * smoothstep(40, 90, d));
  const rock = d < 214 ? -(0.4 + 0.11 * d) : -23.94 - (d - 214) * 0.05;
  const cliff = d < 135 ? -(5 + 0.26 * d) : -40.1 - (d - 135) * 0.06;
  let h = (beach * wb + (rock + 1.5 * noiseC.fbm(x / 18, z / 18, 3)) * wr + (cliff + 2.5 * noiseC.fbm(x / 25, z / 25, 3)) * wc) / sum;
  // every profile converges on one deep floor far out, so no coast kind shows on the open sea bed
  const floor = -48 - Math.max(0, d - 380) * 0.025 + 3 * noise.fbm(x / 300, z / 300, 2);
  h = lerp(h, Math.min(h, floor), smoothstep(230, 430, d));
  h = Math.max(h, -78);
  // continuity at the waterline
  return h * smoothstep(0, 5, d) + (1 - smoothstep(0, 5, d)) * h * 0.4;
}

log('heights...');
for (let j = 0; j < N; j++) {
  const z = wx(j);
  for (let i = 0; i < N; i++) {
    const x = wx(i);
    const idx = j * N + i;
    const s = sd[idx], k = kind[idx];
    let h: number;
    if (s > -2) {
      const m = bodyAt(x, z, trailDist[idx]);
      let land = landProfile(Math.max(s, 0), k, m);
      // escarpment: a rock step, raised on its west side, near the falls (not past the polyline's ends)
      const e = nearestOnPolyline(escPts, x, z, escCum);
      const atEnd = (e.seg === 0 && e.t <= 0) || (e.seg === escPts.length - 2 && e.t >= 1);
      if (e.d < 260 && !atEnd) {
        const step = lerp(ESCARPMENT[e.seg].step, ESCARPMENT[e.seg + 1].step, e.t);
        const signed = e.side < 0 ? e.d : -e.d; // positive west of the rim
        const near = 1 - smoothstep(90, 250, e.d);
        land += step * (smoothstep(-5, 5, signed) - 0.28) * near;
      }
      h = s < 0 ? lerp(seabed(0.01, k, x, z), land, smoothstep(-2, 0, s)) : land;
    } else {
      h = seabed(-s, k, x, z);
    }
    H[idx] = h;
  }
  if (j % 256 === 0) log(`  row ${j}`);
}

// ---------------------------------------------------------------- hydraulic erosion (droplets, 2 m grid)
log('erosion...');
{
  const E = 1024, S = N / E;
  const e = new Float32Array(E * E);
  for (let j = 0; j < E; j++) for (let i = 0; i < E; i++) {
    let acc = 0;
    for (let b = 0; b < S; b++) for (let a = 0; a < S; a++) acc += H[(j * S + b) * N + i * S + a];
    e[j * E + i] = acc / (S * S);
  }
  const orig = e.slice();
  const rng = new (await import('../src/core/noise.ts')).Rng(99);
  const radius = 4;
  const brush: { di: number; dj: number; w: number }[] = [];
  let wsum = 0;
  for (let dj = -radius; dj <= radius; dj++) for (let di = -radius; di <= radius; di++) {
    const d = Math.hypot(di, dj);
    if (d <= radius) {
      const w = 1 - d / radius;
      brush.push({ di, dj, w });
      wsum += w;
    }
  }
  for (const b of brush) b.w /= wsum;
  const hg = (x: number, z: number) => {
    const i = Math.floor(x), j = Math.floor(z), u = x - i, v = z - j;
    const k = j * E + i;
    const a = e[k], b = e[k + 1], c = e[k + E], d = e[k + E + 1];
    return { h: a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v, gx: (b - a) * (1 - v) + (d - c) * v, gz: (c - a) * (1 - u) + (d - b) * u };
  };
  const DROPS = 300000, LIFE = 64;
  const inertia = 0.1, capF = 1.8, minCap = 0.01, depS = 0.25, eroS = 0.2, evap = 0.015, grav = 4;
  let spawned = 0;
  for (let n = 0; n < DROPS; n++) {
    let x = 4 + rng.next() * (E - 8), z = 4 + rng.next() * (E - 8);
    if (e[Math.floor(z) * E + Math.floor(x)] < 6) continue;
    spawned++;
    let dx = 0, dz = 0, speed = 1, water = 1, sed = 0;
    for (let life = 0; life < LIFE; life++) {
      const i = Math.floor(x), j = Math.floor(z), u = x - i, v = z - j;
      const p = hg(x, z);
      dx = dx * inertia - p.gx * (1 - inertia);
      dz = dz * inertia - p.gz * (1 - inertia);
      const l = Math.hypot(dx, dz);
      if (l < 1e-6) break;
      dx /= l;
      dz /= l;
      x += dx;
      z += dz;
      if (x < 4 || z < 4 || x > E - 5 || z > E - 5) break;
      const nh = hg(x, z).h;
      const dh = nh - p.h;
      if (nh < 0.5) {
        // reached the sea: drop the load at the shore
        break;
      }
      const cap = Math.max(-dh * speed * water * capF, minCap);
      const k = j * E + i;
      if (sed > cap || dh > 0) {
        const dep = dh > 0 ? Math.min(dh, sed) : (sed - cap) * depS;
        sed -= dep;
        e[k] += dep * (1 - u) * (1 - v);
        e[k + 1] += dep * u * (1 - v);
        e[k + E] += dep * (1 - u) * v;
        e[k + E + 1] += dep * u * v;
      } else {
        const ero = Math.min((cap - sed) * eroS, -dh);
        for (const b of brush) {
          const ii = i + b.di, jj = j + b.dj;
          if (ii < 0 || jj < 0 || ii >= E || jj >= E) continue;
          const kk = jj * E + ii;
          const w = ero * b.w;
          const take = e[kk] < w ? e[kk] : w;
          e[kk] -= take;
          sed += take;
        }
      }
      speed = Math.sqrt(Math.max(0, speed * speed + dh * grav));
      water *= 1 - evap;
    }
  }
  // fold the change back into the full-resolution heights, away from the authored places
  let maxCut = 0, maxFill = 0;
  const delta = new Float32Array(E * E);
  for (let k = 0; k < E * E; k++) delta[k] = e[k] - orig[k];
  blur(delta, E, 1, 2);
  for (let k = 0; k < E * E; k++) {
    maxCut = Math.min(maxCut, delta[k]);
    maxFill = Math.max(maxFill, delta[k]);
  }
  for (let j = 0; j < N; j++) {
    const fz = (j + 0.5) / S - 0.5;
    const z = wx(j);
    for (let i = 0; i < N; i++) {
      const idx = j * N + i;
      if (sd[idx] < 1) continue;
      const fx = (i + 0.5) / S - 0.5;
      const i0 = clamp(Math.floor(fx), 0, E - 2), j0 = clamp(Math.floor(fz), 0, E - 2);
      const u = clamp(fx - i0, 0, 1), v = clamp(fz - j0, 0, 1);
      const d = lerp(lerp(delta[j0 * E + i0], delta[j0 * E + i0 + 1], u), lerp(delta[(j0 + 1) * E + i0], delta[(j0 + 1) * E + i0 + 1], u), v);
      const x = wx(i);
      const keep = smoothstep(4, 14, H[idx]) * smoothstep(4, 30, trailDist[idx]) *
        smoothstep(VILLAGE.r, VILLAGE.r * 1.5, Math.hypot(x - VILLAGE.center[0], z - VILLAGE.center[1])) *
        smoothstep(LIGHTHOUSE.platformR + 10, LIGHTHOUSE.platformR + 40, Math.hypot(x - LIGHTHOUSE.p[0], z - LIGHTHOUSE.p[1]));
      H[idx] += d * keep;
    }
  }
  console.log(`  ${spawned} droplets, change ${maxCut.toFixed(1)} .. +${maxFill.toFixed(1)} m`);
}

// sample the body (pre-carve) along the river for diagnostics
console.log('pre-carve terrain along the river:', RIVER.map((r) => {
  const i = Math.round((r.p[0] + HALF_WORLD) / CELL - 0.5), j = Math.round((r.p[1] + HALF_WORLD) / CELL - 0.5);
  return `${H[j * N + i].toFixed(1)}/${r.bed}`;
}).join(' '));

// ---------------------------------------------------------------- river profile from the terrain it crosses
const sampleRaw = (x: number, z: number) => {
  const fx = (x + HALF_WORLD) / CELL - 0.5, fz = (z + HALF_WORLD) / CELL - 0.5;
  const i = clamp(Math.floor(fx), 0, N - 2), j = clamp(Math.floor(fz), 0, N - 2);
  const tx = fx - i, tz = fz - j;
  const a = H[j * N + i], b = H[j * N + i + 1], c = H[(j + 1) * N + i], d = H[(j + 1) * N + i + 1];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
};
const riverTotal = riverCum[riverCum.length - 1];
const RS = Math.ceil(riverTotal) + 1;
const riverBedS = new Float32Array(RS);
const riverWaterS = new Float32Array(RS);
const sFalls = riverCum[FALLS_INDEX] + 1.5;
const sPool = riverCum[FALLS_INDEX + 1];
let poolLevel = 0, lipWater = 0;
{
  const T = new Float32Array(RS);
  const at = (s: number): [number, number, number] => {
    let seg = 0;
    while (seg < RIVER.length - 2 && riverCum[seg + 1] < s) seg++;
    const t = clamp((s - riverCum[seg]) / (riverCum[seg + 1] - riverCum[seg]), 0, 1);
    return [lerp(riverPts[seg][0], riverPts[seg + 1][0], t), lerp(riverPts[seg][1], riverPts[seg + 1][1], t), seg];
  };
  // the lowest terrain across the channel (a few metres either side), so the bed never rides a spur
  for (let s = 0; s < RS; s++) {
    const [x, z, seg] = at(s);
    const a = riverPts[seg], b = riverPts[seg + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
    const nx = -dz / l, nz = dx / l;
    let lo = 1e9;
    for (const o of [-4, -2, 0, 2, 4]) lo = Math.min(lo, sampleRaw(x + nx * o, z + nz * o));
    T[s] = lo;
  }
  const sm = new Float32Array(RS);
  for (let s = 0; s < RS; s++) {
    let acc = 0, c = 0;
    for (let k = -8; k <= 8; k++) {
      const q = clamp(s + k, 0, RS - 1);
      if ((s < sFalls) !== (q < sFalls)) continue;
      acc += T[q];
      c++;
    }
    sm[s] = acc / c;
  }
  // upstream of the falls: at least 2.2 m below the terrain, always falling
  let bed = sm[0] - 1.6;
  for (let s = 0; s < RS; s++) {
    if (s < sFalls) {
      bed = Math.min(sm[s] - 2.2, s === 0 ? bed : bed - 0.012);
      riverBedS[s] = bed;
      riverWaterS[s] = bed + 0.8;
    }
  }
  const lipBed = riverBedS[Math.floor(sFalls) - 1];
  lipWater = lipBed + 0.55;
  // the pool lies 3.5 m below the ground around it, and at least 14 m under the lip
  const [ppx, ppz] = POOL.p;
  let around = 0;
  for (let a = 0; a < 16; a++) around += sampleRaw(ppx + Math.cos(a) * (POOL.r + 6), ppz + Math.sin(a) * (POOL.r + 6));
  around /= 16;
  poolLevel = Math.min(around - 3.2, lipWater - 14);
  bed = poolLevel - 0.9;
  for (let s = Math.floor(sFalls); s < RS; s++) {
    const inPool = s < sPool + POOL.r * 0.6;
    bed = inPool ? poolLevel - 1.2 : Math.min(sm[s] - 2.0, bed - 0.006);
    riverBedS[s] = bed;
    riverWaterS[s] = inPool ? poolLevel : Math.max(bed + 0.75, -0.05);
  }
  // the last metres meet the sea
  for (let s = 0; s < RS; s++) if (riverBedS[s] < 0.4) riverWaterS[s] = Math.max(riverWaterS[s], 0.02);
  console.log(`river: ${riverTotal.toFixed(0)} m, lip water ${lipWater.toFixed(2)}, pool level ${poolLevel.toFixed(2)} (ground around ${around.toFixed(1)}), falls ${(lipWater - poolLevel).toFixed(1)} m`);
}
const bedAtS = (s: number) => riverBedS[clamp(Math.round(s), 0, RS - 1)];

// ---------------------------------------------------------------- river valley, falls, pool
log('river...');
{
  const minX = Math.min(...riverPts.map((p) => p[0])) - 140, maxX = Math.max(...riverPts.map((p) => p[0])) + 140;
  const minZ = Math.min(...riverPts.map((p) => p[1])) - 140, maxZ = Math.max(...riverPts.map((p) => p[1])) + 140;
  for (let j = 0; j < N; j++) {
    const z = wx(j);
    if (z < minZ || z > maxZ) continue;
    for (let i = 0; i < N; i++) {
      const x = wx(i);
      if (x < minX || x > maxX) continue;
      const idx = j * N + i;
      const r = nearestOnPolyline(riverPts, x, z, riverCum);
      // the falls: a near-vertical drop over the lip
      const bed = r.s > sFalls - 2 && r.s < sFalls + 1.5 ? lerp(bedAtS(sFalls - 2), bedAtS(sFalls + 1.5), smoothstep(sFalls - 1, sFalls + 0.8, r.s)) : bedAtS(r.s);
      const w = riverWidth(r.seg, r.t);
      const half = w / 2;
      riverD[idx] = r.d - half;
      if (r.d > 140) continue;
      // the walls are steep near the falls (a gorge cut into the escarpment), gentler downstream
      const dFall = Math.hypot(x - RIVER[FALLS_INDEX].p[0], z - RIVER[FALLS_INDEX].p[1]);
      const steep = 1 - smoothstep(25, 120, dFall);
      const k1 = lerp(0.24, 1.6, steep), k2 = lerp(0.0035, 0.01, steep);
      const out = Math.max(0, r.d - half);
      const channel = r.d < half ? 1.15 * smoothstep(0, half, r.d) ** 2 : 1.15 + out * k1 + out * out * k2;
      const valley = bed + channel + 0.25 * noise.simplex(x / 6, z / 6) * smoothstep(0, 3, out);
      H[idx] = smin(H[idx], valley, 2.5);
    }
  }
  // the plunge pool: a round basin at the foot of the falls
  const [px, pz] = POOL.p;
  const bottom = poolLevel - POOL.depth;
  for (let j = 0; j < N; j++) {
    const z = wx(j);
    if (Math.abs(z - pz) > POOL.r * 3) continue;
    for (let i = 0; i < N; i++) {
      const x = wx(i);
      if (Math.abs(x - px) > POOL.r * 3) continue;
      const d = Math.hypot(x - px, z - pz);
      const idx = j * N + i;
      // steep rock walls on the falls side, an open bank downstream
      const toFalls = ((x - px) * (RIVER[FALLS_INDEX].p[0] - px) + (z - pz) * (RIVER[FALLS_INDEX].p[1] - pz)) /
        (Math.max(d, 1e-3) * Math.hypot(RIVER[FALLS_INDEX].p[0] - px, RIVER[FALLS_INDEX].p[1] - pz));
      const wall = lerp(0.6, 4.5, smoothstep(-0.1, 0.6, toFalls));
      const bowl = bottom + POOL.depth * 1.2 * smoothstep(POOL.r * 0.15, POOL.r * 1.05, d) ** 1.4 +
        Math.max(0, d - POOL.r) * wall;
      H[idx] = smin(H[idx], bowl, 1.5);
      if (d < POOL.r) riverD[idx] = Math.min(riverD[idx], d - POOL.r);
    }
  }
}

// ---------------------------------------------------------------- village terrace, lighthouse platform
log('village and summit...');
{
  const [vx, vz] = VILLAGE.center;
  for (let j = 0; j < N; j++) {
    const z = wx(j);
    for (let i = 0; i < N; i++) {
      const x = wx(i);
      const idx = j * N + i;
      const dv = Math.hypot(x - vx, z - vz);
      if (dv < VILLAGE.r * 1.4) {
        const target = lerp(VILLAGE.back, VILLAGE.front, smoothstep(220, 330, z)) + 0.25 * noise.simplex(x / 15, z / 15);
        const w = (1 - smoothstep(VILLAGE.r * 0.75, VILLAGE.r * 1.35, dv)) * smoothstep(18, 34, sd[idx]);
        H[idx] = lerp(H[idx], target, w);
      }
      const dl = Math.hypot(x - LIGHTHOUSE.p[0], z - LIGHTHOUSE.p[1]);
      if (dl < LIGHTHOUSE.platformR + 30) {
        const w = 1 - smoothstep(LIGHTHOUSE.platformR, LIGHTHOUSE.platformR + 22, dl);
        H[idx] = lerp(H[idx], LIGHTHOUSE.base + 0.15 * noise.simplex(x / 4, z / 4), w);
      }
    }
  }
}

// ---------------------------------------------------------------- trails
log('trails...');
const sampleH = (x: number, z: number) => {
  const fx = (x + HALF_WORLD) / CELL - 0.5, fz = (z + HALF_WORLD) / CELL - 0.5;
  const i = clamp(Math.floor(fx), 0, N - 2), j = clamp(Math.floor(fz), 0, N - 2);
  const tx = fx - i, tz = fz - j;
  const a = H[j * N + i], b = H[j * N + i + 1], c = H[(j + 1) * N + i], d = H[(j + 1) * N + i + 1];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
};
{
  PATHS.forEach((pts, pi) => {
    const cum = pathCums[pi];
    const total = cum[cum.length - 1];
    // height profile along the trail: terrain sampled every metre, smoothed, then grade-limited
    const n = Math.ceil(total) + 1;
    const prof = new Float32Array(n);
    let seg = 0;
    for (let s = 0; s < n; s++) {
      while (seg < pts.length - 2 && cum[seg + 1] < s) seg++;
      const t = clamp((s - cum[seg]) / (cum[seg + 1] - cum[seg]), 0, 1);
      const x = lerp(pts[seg][0], pts[seg + 1][0], t), z = lerp(pts[seg][1], pts[seg + 1][1], t);
      prof[s] = Math.max(sampleH(x, z), 0.6);
    }
    const sm = new Float32Array(n);
    const R = 9;
    for (let s = 0; s < n; s++) {
      let acc = 0, c = 0;
      for (let k = -R; k <= R; k++) {
        const q = clamp(s + k, 0, n - 1);
        acc += prof[q];
        c++;
      }
      sm[s] = acc / c;
    }
    let maxGrade = 0;
    for (let s = 1; s < n; s++) maxGrade = Math.max(maxGrade, Math.abs(sm[s] - sm[s - 1]));
    // grade limit (cut and fill): no stretch steeper than about 24 degrees
    const g = Math.tan((24 * Math.PI) / 180);
    for (let it = 0; it < 4; it++) {
      for (let s = 1; s < n; s++) sm[s] = clamp(sm[s], sm[s - 1] - g, sm[s - 1] + g);
      for (let s = n - 2; s >= 0; s--) sm[s] = clamp(sm[s], sm[s + 1] - g, sm[s + 1] + g);
    }
    let maxCut = 0, at = 0;
    for (let s = 0; s < n; s++) if (Math.abs(sm[s] - prof[s]) > maxCut) { maxCut = Math.abs(sm[s] - prof[s]); at = s; }
    console.log(`  trail ${pi}: ${total.toFixed(0)} m, natural max grade ${(Math.atan(maxGrade) * 57.3).toFixed(1)} deg, max cut/fill ${maxCut.toFixed(1)} m at s=${at}`);
    if (maxCut > 6) {
      const row: string[] = [];
      for (let s = Math.max(0, at - 60); s < Math.min(n, at + 60); s += 10) row.push(`${s}:${prof[s].toFixed(0)}/${sm[s].toFixed(0)}`);
      console.log('    ' + row.join(' '));
    }
    const minX = Math.min(...pts.map((p) => p[0])) - 12, maxX = Math.max(...pts.map((p) => p[0])) + 12;
    const minZ = Math.min(...pts.map((p) => p[1])) - 12, maxZ = Math.max(...pts.map((p) => p[1])) + 12;
    for (let j = 0; j < N; j++) {
      const z = wx(j);
      if (z < minZ || z > maxZ) continue;
      for (let i = 0; i < N; i++) {
        const x = wx(i);
        if (x < minX || x > maxX) continue;
        const r = nearestOnPolyline(pts, x, z, cum);
        if (r.d > 9) continue;
        const idx = j * N + i;
        const target = sm[clamp(Math.round(r.s), 0, n - 1)] - 0.12 * (1 - smoothstep(0, 1.6, r.d));
        const w = 1 - smoothstep(1.6, 7.5, r.d);
        // trails do not fill the river or the sea
        if (riverD[idx] < 1 || sd[idx] < 2) continue;
        H[idx] = lerp(H[idx], target, w);
        pathW[idx] = Math.max(pathW[idx], 1 - smoothstep(0.9, 2.3, r.d + 0.5 * noise.simplex(x / 3, z / 3)));
      }
    }
  });
}

// ---------------------------------------------------------------- outputs
log('encoding heights...');
let hMin = 1e9, hMax = -1e9;
const h16 = new Uint16Array(N * N);
for (let i = 0; i < N * N; i++) {
  const h = H[i];
  hMin = Math.min(hMin, h);
  hMax = Math.max(hMax, h);
  h16[i] = Math.round(clamp((h - H_MIN) / (H_MAX - H_MIN), 0, 1) * 65535);
}
console.log(`height range ${hMin.toFixed(1)} .. ${hMax.toFixed(1)}`);
// delta along rows (first column against the row above), then byte planes: compresses about 3x better than raw
{
  const delta = new Uint16Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    const prev = i > 0 ? h16[k - 1] : j > 0 ? h16[k - N] : 0;
    delta[k] = (h16[k] - prev) & 0xffff;
  }
  const planes = Buffer.alloc(N * N * 2);
  for (let k = 0; k < N * N; k++) {
    planes[k] = delta[k] & 0xff;
    planes[N * N + k] = delta[k] >> 8;
  }
  writeFileSync(join(outDir, 'height.bin.gz'), gzipSync(planes, { level: 9 }));
}

// masks at 2 m
log('masks...');
const M = MASK_RES;
const R = N / M;
const mask0 = new Uint8Array(M * M * 4); // sand, grass, dirt/path, forest
const mask1 = new Uint8Array(M * M * 4); // rock, wet, water (river/pool), cliff kind
const shore = new Uint16Array(M * M); // signed distance to the waterline (positive on land), (d + 1024) * 32
const landM = new Uint8Array(M * M);
const hM = new Float32Array(M * M);
for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
  let acc = 0;
  for (let b = 0; b < R; b++) for (let a = 0; a < R; a++) acc += H[(j * R + b) * N + i * R + a];
  hM[j * M + i] = acc / (R * R);
  landM[j * M + i] = hM[j * M + i] > 0 ? 1 : 0;
}
{
  const seaM = new Uint8Array(M * M);
  for (let i = 0; i < M * M; i++) seaM[i] = landM[i] ? 0 : 1;
  const a = edt(seaM, M), b = edt(landM, M);
  for (let i = 0; i < M * M; i++) {
    const d = (landM[i] ? a.dist[i] - 0.5 : -(b.dist[i] - 0.5)) * (WORLD_SIZE / M);
    shore[i] = Math.round(clamp((d + 1024) * 32, 0, 65535));
  }
}
const cellM = WORLD_SIZE / M;
for (let j = 0; j < M; j++) {
  const z = -HALF_WORLD + (j + 0.5) * cellM;
  for (let i = 0; i < M; i++) {
    const x = -HALF_WORLD + (i + 0.5) * cellM;
    const o = (j * M + i) * 4;
    const ci = (j * R + R / 2) * N + i * R + R / 2;
    const h = hM[j * M + i];
    const s = sd[ci], k = kind[ci];
    const hx = hM[j * M + Math.min(i + 1, M - 1)] - hM[j * M + Math.max(i - 1, 0)];
    const hz = hM[Math.min(j + 1, M - 1) * M + i] - hM[Math.max(j - 1, 0) * M + i];
    const slope = Math.atan(Math.hypot(hx, hz) / (2 * cellM)) * 57.2958; // degrees
    const n1 = noise.fbm(x / 40, z / 40, 3), n2 = noiseB.fbm(x / 13, z / 13, 3);
    const beachK = clamp(1 - k, 0, 1);
    const rd = riverD[ci];
    const path = pathW[ci];
    const dv = Math.hypot(x - VILLAGE.center[0], z - VILLAGE.center[1]);
    const dl = Math.hypot(x - LIGHTHOUSE.p[0], z - LIGHTHOUSE.p[1]);
    // sand: beaches and their lagoon floors, the river mouth bars
    let sand = beachK * (1 - smoothstep(48 + 14 * n1, 72 + 14 * n1, s)) * (h < 4.5 ? 1 : 1 - smoothstep(4.5, 6, h));
    sand = Math.max(sand, (1 - smoothstep(-2, 6, rd)) * (1 - smoothstep(1.5, 4, h)));
    if (s < 0) sand = Math.max(sand, beachK * 0.9 + 0.1);
    // rock: cliffs and rock shelves at the coast, steep ground, the summit
    let rock = smoothstep(33, 46, slope + 6 * n2);
    rock = Math.max(rock, clamp(k - 0.6, 0, 1) * (1 - smoothstep(10 + 10 * n1, 26 + 10 * n1, s)) * (s > -6 ? 1 : 0.5));
    rock = Math.max(rock, smoothstep(196, 206, h + 8 * n2) * 0.85);
    // falls gorge
    const dFall = Math.hypot(x - RIVER[FALLS_INDEX].p[0], z - RIVER[FALLS_INDEX].p[1]);
    rock = Math.max(rock, (1 - smoothstep(18, 32, dFall)) * smoothstep(20, 35, slope));
    rock = clamp(rock, 0, 1);
    // grass: windswept summit, cliff tops, beach backshore, around the village, along trails
    let grass = smoothstep(150, 175, h + 10 * n1);
    grass = Math.max(grass, clamp(k - 1.2, 0, 1) * (1 - smoothstep(30, 70, s)) * smoothstep(4, 12, s));
    grass = Math.max(grass, beachK * smoothstep(50, 70, s) * (1 - smoothstep(80, 110, s)) * 0.8);
    grass = Math.max(grass, smoothstep(55, 85, dv) * (1 - smoothstep(110, 150, dv)) * 0.9);
    grass = Math.max(grass, (1 - path) * smoothstep(0.02, 0.4, path) * 0.7);
    grass *= 1 - rock * 0.8;
    // dirt: trails, the village ground, river banks
    let dirt = path;
    dirt = Math.max(dirt, (1 - smoothstep(50, 75, dv)) * smoothstep(20, 34, s) * (0.6 + 0.4 * smoothstep(-0.2, 0.3, n2)));
    dirt = Math.max(dirt, (1 - smoothstep(0.5, 3.5, rd)) * 0.7);
    // forest density
    let forest = s > 0 ? 1 : 0;
    forest *= smoothstep(58 + 12 * n1, 95 + 12 * n1, s) * beachK + (1 - beachK) * smoothstep(14, 40, s);
    forest *= 1 - smoothstep(150, 178, h + 10 * n1);
    forest *= 1 - path;
    forest *= smoothstep(0.5, 6, rd);
    forest *= smoothstep(70, 105, dv) * 0.85 + 0.15 * smoothstep(40, 70, dv);
    forest *= 1 - smoothstep(38, 50, slope);
    forest *= smoothstep(-0.62, -0.32, noiseC.fbm(x / 160, z / 160, 3));
    forest *= smoothstep(LIGHTHOUSE.platformR + 8, LIGHTHOUSE.platformR + 30, dl);
    forest = clamp(forest, 0, 1);
    const wet = Math.max((1 - smoothstep(0, 7, rd)) * (h > 0.3 ? 1 : 0), (1 - smoothstep(0, 4, s)) * 0.6);
    const water = 1 - smoothstep(-0.8, 0.4, rd);
    mask0[o] = Math.round(clamp(sand, 0, 1) * 255);
    mask0[o + 1] = Math.round(clamp(grass, 0, 1) * 255);
    mask0[o + 2] = Math.round(clamp(dirt, 0, 1) * 255);
    mask0[o + 3] = Math.round(forest * 255);
    mask1[o] = Math.round(rock * 255);
    mask1[o + 1] = Math.round(clamp(wet, 0, 1) * 255);
    mask1[o + 2] = Math.round(clamp(water, 0, 1) * 255);
    mask1[o + 3] = Math.round(clamp(k / 2, 0, 1) * 255);
  }
}
writeFileSync(join(outDir, 'mask0.bin.gz'), gzipSync(Buffer.from(mask0.buffer), { level: 9 }));
writeFileSync(join(outDir, 'mask1.bin.gz'), gzipSync(Buffer.from(mask1.buffer), { level: 9 }));
writeFileSync(join(outDir, 'shore.bin.gz'), gzipSync(Buffer.from(shore.buffer), { level: 9 }));
// the river for the game: centreline samples every 2 m with bed, water level and width
const riverOut: number[][] = [];
for (let s = 0; s <= riverTotal; s += 2) {
  let seg = 0;
  while (seg < RIVER.length - 2 && riverCum[seg + 1] < s) seg++;
  const t = clamp((s - riverCum[seg]) / (riverCum[seg + 1] - riverCum[seg]), 0, 1);
  const x = lerp(riverPts[seg][0], riverPts[seg + 1][0], t), z = lerp(riverPts[seg][1], riverPts[seg + 1][1], t);
  riverOut.push([+x.toFixed(2), +z.toFixed(2), +bedAtS(s).toFixed(2), +riverWaterS[clamp(Math.round(s), 0, RS - 1)].toFixed(2), +riverWidth(seg, t).toFixed(2), +s.toFixed(1)]);
}
const lip = RIVER[FALLS_INDEX].p, below = RIVER[FALLS_INDEX + 1].p;
writeFileSync(join(outDir, 'meta.json'), JSON.stringify({
  N, M, H_MIN, H_MAX, worldSize: WORLD_SIZE, hMin, hMax,
  river: riverOut,
  falls: { lip, toward: below, s: sFalls, top: lipWater, bottom: poolLevel, width: RIVER[FALLS_INDEX].w },
  pool: { p: POOL.p, r: POOL.r, level: poolLevel },
  at: new Date().toISOString(),
}));

// ---------------------------------------------------------------- relief preview
log('preview...');
{
  const img = Buffer.alloc(M * M * 3);
  for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
    const h = hM[j * M + i];
    const hx = (hM[j * M + Math.min(i + 1, M - 1)] - hM[j * M + Math.max(i - 1, 0)]) / (2 * cellM);
    const hz = (hM[Math.min(j + 1, M - 1) * M + i] - hM[Math.max(j - 1, 0) * M + i]) / (2 * cellM);
    // light from the north-west, high
    const nx = -hx, ny = 1, nz = -hz, nl = Math.hypot(nx, ny, nz);
    const lx = -0.5, ly = 0.75, lz = -0.45, ll = Math.hypot(lx, ly, lz);
    const shade = clamp((nx * lx + ny * ly + nz * lz) / (nl * ll), 0, 1);
    const o = (j * M + i) * 4;
    let r: number, g: number, b: number;
    if (h < 0) {
      const d = clamp(-h / 40, 0, 1);
      r = lerp(120, 10, Math.sqrt(d)); g = lerp(220, 50, Math.sqrt(d)); b = lerp(210, 110, d);
      if (-h < 0.6) { r = 200; g = 230; b = 220; }
    } else {
      const sand = mask0[o] / 255, grass = mask0[o + 1] / 255, dirt = mask0[o + 2] / 255, forest = mask0[o + 3] / 255;
      const rock = mask1[o] / 255, water = mask1[o + 2] / 255;
      r = 95; g = 120; b = 60; // base scrub
      const mixc = (c: number[], w: number) => { r = lerp(r, c[0], w); g = lerp(g, c[1], w); b = lerp(b, c[2], w); };
      mixc([140, 170, 80], grass);
      mixc([30, 75, 30], forest);
      mixc([125, 95, 65], dirt);
      mixc([225, 210, 170], sand);
      mixc([120, 115, 110], rock);
      mixc([60, 140, 170], water);
      const s = 0.45 + 0.75 * shade;
      r *= s; g *= s; b *= s;
      // contour lines every 20 m
      if (Math.abs((h % 20) - 10) > 9.6) { r *= 0.8; g *= 0.8; b *= 0.8; }
    }
    img[(j * M + i) * 3] = clamp(r, 0, 255);
    img[(j * M + i) * 3 + 1] = clamp(g, 0, 255);
    img[(j * M + i) * 3 + 2] = clamp(b, 0, 255);
  }
  await sharp(img, { raw: { width: M, height: M, channels: 3 } }).png().toFile(join(previewDir, `preview_${Date.now() % 100000}.png`));
}
// spot heights for the log
for (const [name, p] of [['spawn', [596, 34]], ['pool', POOL.p], ['village', VILLAGE.center], ['lighthouse', LIGHTHOUSE.p], ['falls lip', RIVER[FALLS_INDEX].p]] as [string, V2][]) {
  console.log(`  ${name}: h ${sampleH(p[0], p[1]).toFixed(2)}`);
}
log('done');
