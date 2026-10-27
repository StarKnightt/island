/**
 * The rock kit from tools/blender/rocks (public/assets/rocks/rocks.json): photoscanned cliff faces and sculpted sea
 * stacks, instanced along the sea cliffs, round the waterfall and offshore.
 *
 * The layout is planned from the heightfield as soon as it loads, before anything reads the waterline: the new faces
 * stand in the sea in front of the terrain's own cliff, so the distance-to-shore field is moved out to their feet
 * (the surf bursts against them, the spray rises there), and the pyramid islets the stacks replace are cut down to
 * wave-cut platforms. The GLBs stream in later; each piece type and LOD is one instanced mesh.
 */
import * as THREE from 'three/webgpu';
import {
  cameraViewMatrix, cameraWorldMatrix, float, fract, length, max, min, mix, mx_noise_float, normalize, normalMap,
  normalWorldGeometry, positionWorld, smoothstep, texture, uniform, uv, varying, vec2, vec3, vec4, type N,
  cameraPosition, Fn, If, select, floor, hash,
} from '../core/tsl';
import { loadGLTF } from '../core/Assets';
import { toFloatGeometry } from '../veg/glb';
import type { Heightfield } from './Heightfield';
import type { Colliders } from './Colliders';
import { COAST, HALF_WORLD, ISLETS, MASK_RES, WORLD_SIZE } from './layout';
import { wetness } from './weatherUniforms';
import { fallsPath } from '../water/fallsPath';
import { sunLit } from '../core/lighting';
import { instancedMesh } from '../core/instancing';
import { PoolRocks } from './poolRocks';

/**
 * Piece geometry at scale 1 (from rocks.json and the lod1 meshes): plan extent, how far the face's foot stands out
 * in front of the origin (+Z), skyline height; stacks: how deep to sink them so the wave-cut notch sits at the sea
 */
interface Spec { file: 'cliff' | 'stack'; x0: number; x1: number; z0: number; front: number; top: number; water?: number }
const SPEC: Record<string, Spec> = {
  cliff_a: { file: 'cliff', x0: -5.09, x1: 4.98, z0: -3.76, front: 1.3, top: 10.06 },
  cliff_b: { file: 'cliff', x0: -9.79, x1: 9.4, z0: -3.93, front: 2.5, top: 6.13 },
  cliff_c: { file: 'cliff', x0: -7.58, x1: 7.77, z0: -3.31, front: 1.4, top: 7.71 },
  cliff_d: { file: 'cliff', x0: -5.19, x1: 4.58, z0: -4.71, front: 2.2, top: 7.92 },
  cliff_e: { file: 'cliff', x0: -9.27, x1: 9.21, z0: -2.03, front: 3.0, top: 8.88 },
  cliff_f: { file: 'cliff', x0: -7.24, x1: 7.31, z0: -7.59, front: 2.4, top: 2.85 },
  cliff_g: { file: 'cliff', x0: -10.44, x1: 10.39, z0: -5.17, front: 1.2, top: 9.49 },
  cliff_h: { file: 'cliff', x0: -12.12, x1: 11.91, z0: -3.92, front: 1.6, top: 5.23 },
  stack_a: { file: 'stack', x0: -10.1, x1: 13.0, z0: -8, front: 8.2, top: 32.5, water: 4.6 },
  stack_b: { file: 'stack', x0: -11.2, x1: 10.4, z0: -8, front: 7.9, top: 21.4, water: 5.0 },
  stack_c: { file: 'stack', x0: -8.9, x1: 8.5, z0: -6.5, front: 6.5, top: 43.5, water: 4.6 },
};
const FILES = { cliff: 'assets/rocks/cliff_kit.glb', stack: 'assets/rocks/stacks.glb' };

/** where a piece stands: origin, yaw (local +Z = the way the face looks), uniform scale; zone 0 sea cliffs, 1 the
 *  gorge, 2 sea stacks, 3 the low faces round the plunge pool; `wall` marks the piece right behind the falls */
export interface RockPlace { piece: string; x: number; y: number; z: number; yaw: number; s: number; zone: number; wall?: boolean }

/** the falls' sheet and the escarpment's direction there (+ north), kept for the gorge (see RockKit.clearFalls) */
let sheet: ReturnType<typeof fallsPath> | null = null;
let gorgeT: THREE.Vector2 | null = null;
/** the island the plan was made for (the pool's rim rocks are planned from it when the kit loads) */
let planned: Heightfield | null = null;

export const rockU = {
  falls: uniform(new THREE.Vector3()),
  pool: uniform(new THREE.Vector3()),
  /** where the falls land (the spray soaks the walls round it) */
  impact: uniform(new THREE.Vector3()),
};

function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  return { next, range: (a: number, b: number) => a + (b - a) * next(), pick: <T>(l: T[]) => l[Math.floor(next() * l.length)] };
}

/** bilinear distance to the waterline (the stored field is per 2 m cell) */
function shoreAt(hf: Heightfield, x: number, z: number) {
  const M = MASK_RES, cell = WORLD_SIZE / M, S = hf.shore;
  const fx = (x + HALF_WORLD) / cell - 0.5, fz = (z + HALF_WORLD) / cell - 0.5;
  const i = Math.max(0, Math.min(M - 2, Math.floor(fx))), j = Math.max(0, Math.min(M - 2, Math.floor(fz)));
  const tx = fx - i, tz = fz - j, k = j * M + i;
  const a = S[k], b = S[k + 1], c = S[k + M], d = S[k + M + 1];
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
}

interface WlPt { x: number; z: number; nx: number; nz: number; kind: number; top: number; arc: number }

/** the waterline round the main island every ~3 m, with smoothed seaward normals, coast kind and cliff-top height */
function traceWaterline(hf: Heightfield): WlPt[] {
  const loop = [...COAST, COAST[0]];
  const raw: { x: number; z: number }[] = [];
  for (let s = 0; s < loop.length - 1; s++) {
    const a = loop[s].p, b = loop[s + 1].p;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let t = 0; t < L; t += 3) {
      let x = a[0] + ((b[0] - a[0]) * t) / L, z = a[1] + ((b[1] - a[1]) * t) / L;
      for (let it = 0; it < 5; it++) {
        const d = shoreAt(hf, x, z);
        const gx = (shoreAt(hf, x + 2, z) - shoreAt(hf, x - 2, z)) / 4, gz = (shoreAt(hf, x, z + 2) - shoreAt(hf, x, z - 2)) / 4;
        const g2 = gx * gx + gz * gz || 1;
        x -= (d * gx) / g2;
        z -= (d * gz) / g2;
      }
      raw.push({ x, z });
    }
  }
  const n = raw.length, out: WlPt[] = [];
  let arc = 0;
  for (let i = 0; i < n; i++) {
    // the normal across a 48 m chord, turned to face the sea
    const a = raw[(i - 8 + n) % n], b = raw[(i + 8) % n], p = raw[i];
    let nx = b.z - a.z, nz = -(b.x - a.x);
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    if (shoreAt(hf, p.x + nx * 4, p.z + nz * 4) > shoreAt(hf, p.x - nx * 4, p.z - nz * 4)) { nx = -nx; nz = -nz; }
    if (i > 0) arc += Math.hypot(p.x - raw[i - 1].x, p.z - raw[i - 1].z);
    // the cliff top: where the terrain's face has risen to the plateau (the face itself spans ~15 m inland)
    const top = Math.max(hf.height(p.x - nx * 14, p.z - nz * 14), hf.height(p.x - nx * 20, p.z - nz * 20) - 2);
    out.push({ x: p.x, z: p.z, nx, nz, kind: hf.coastKind(p.x, p.z), top, arc });
  }
  return out;
}

/** cut the pyramid islets that the kit stacks replace down to wave-cut platforms, and raise shelves under new stacks */
function reshapeSeaRocks(hf: Heightfield, stacks: { x: number; z: number; r: number }[]) {
  const N = hf.n, H = hf.heights;
  const M = MASK_RES, cell = WORLD_SIZE / M;
  const rockMask = (x: number, z: number, w: number) => {
    const i = Math.floor((x + HALF_WORLD) / cell), j = Math.floor((z + HALF_WORLD) / cell);
    if (i < 0 || j < 0 || i >= M || j >= M) return;
    const k = (j * M + i) * 4;
    hf.mask1[k] = Math.max(hf.mask1[k], Math.round(255 * w));
    hf.mask0[k] = Math.round(hf.mask0[k] * (1 - w));
  };
  for (const is of ISLETS) {
    if (is.kind < 2) continue;
    const c = Math.cos(-is.rot), sn = Math.sin(-is.rot);
    const R = Math.max(is.rx, is.rz) * 1.3;
    for (let z = Math.floor(is.c[1] - R); z <= is.c[1] + R; z++) for (let x = Math.floor(is.c[0] - R); x <= is.c[0] + R; x++) {
      const lx = (x - is.c[0]) * c - (z - is.c[1]) * sn, lz = (x - is.c[0]) * sn + (z - is.c[1]) * c;
      const d = Math.hypot(lx / (is.rx * 1.25), lz / (is.rz * 1.25));
      if (d >= 1) continue;
      const i = Math.round(x + HALF_WORLD - 0.5), j = Math.round(z + HALF_WORLD - 0.5);
      if (i < 0 || j < 0 || i >= N || j >= N) continue;
      // a platform awash at high tide, its rim breaking off into the sea
      const shelf = 0.7 - 1.3 * d * d + 0.25 * Math.sin(x * 0.7) * Math.sin(z * 0.6);
      H[j * N + i] = Math.min(H[j * N + i], shelf);
    }
  }
  for (const st of stacks) {
    const R = st.r;
    for (let z = Math.floor(st.z - R); z <= st.z + R; z++) for (let x = Math.floor(st.x - R); x <= st.x + R; x++) {
      const d = Math.hypot(x - st.x, z - st.z) / R;
      if (d >= 1) continue;
      const i = Math.round(x + HALF_WORLD - 0.5), j = Math.round(z + HALF_WORLD - 0.5);
      if (i < 0 || j < 0 || i >= N || j >= N) continue;
      // a reef of fallen blocks round the foot, just under the surface at the stack, dropping away outside
      const shelf = -0.6 - 9 * d * d + 0.35 * Math.sin(x * 0.9) * Math.sin(z * 0.8);
      H[j * N + i] = Math.max(H[j * N + i], shelf);
      rockMask(x, z, 1 - d * d);
    }
  }
  hf.heightTex.needsUpdate = true;
  hf.mask0Tex.needsUpdate = true;
  hf.mask1Tex.needsUpdate = true;
}

/** signed distance (positive inside) to a piece's footprint at the waterline, in its own frame */
function footprintSd(p: RockPlace, sp: Spec, x: number, z: number) {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  const dx = x - p.x, dz = z - p.z;
  // local +X = (cos, -sin), local +Z = (sin, cos)
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  const k = p.s;
  // the ends bend back: the footprint narrows a little; stacks are round-ish
  const x0 = sp.x0 * k * (sp.file === 'stack' ? 0.8 : 0.9), x1 = sp.x1 * k * (sp.file === 'stack' ? 0.8 : 0.9);
  const z0 = sp.z0 * k * (sp.file === 'stack' ? 0.8 : 1), z1 = sp.front * k * (sp.file === 'stack' ? 0.8 : 0.85);
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, hx = (x1 - x0) / 2, hz = (z1 - z0) / 2;
  const qx = Math.abs(lx - cx) - hx, qz = Math.abs(lz - cz) - hz;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qz, 0));
  const inside = Math.min(Math.max(qx, qz), 0);
  return -(outside + inside);
}

/**
 * Sea cliffs plunge into deep water: the shallow ledge the terrain's own cliff profile keeps at its waterline lies
 * under and just in front of the new faces, where it would show as a band of lagoon-turquoise; it is dropped away.
 */
function deepenFeet(hf: Heightfield, places: RockPlace[]) {
  const N = hf.n, H = hf.heights;
  for (const p of places) {
    if (p.zone !== 0) continue;
    const sp = SPEC[p.piece];
    const R = Math.max(Math.abs(sp.x0), Math.abs(sp.x1), Math.abs(sp.z0), sp.front) * p.s + 30;
    for (let z = Math.floor(p.z - R); z <= p.z + R; z++) for (let x = Math.floor(p.x - R); x <= p.x + R; x++) {
      const i = Math.round(x + HALF_WORLD - 0.5), j = Math.round(z + HALF_WORLD - 0.5);
      if (i < 0 || j < 0 || i >= N || j >= N) continue;
      const k = j * N + i;
      if (H[k] > -0.3) continue;
      const out = Math.max(0, -footprintSd(p, sp, x, z));
      if (out > 30) continue;
      H[k] = Math.min(H[k], -7.5 - out * 0.28);
    }
  }
  hf.heightTex.needsUpdate = true;
}

/** move the waterline the surf, the spray and the sand see out to the foot of the pieces standing in the sea */
function moveWaterline(hf: Heightfield, places: RockPlace[]) {
  const M = MASK_RES, cell = WORLD_SIZE / M;
  const tex = hf.shoreTex.image.data as Float32Array;
  for (const p of places) {
    if (p.zone === 1 || p.zone === 3) continue;
    const sp = SPEC[p.piece];
    const R = Math.max(Math.abs(sp.x0), Math.abs(sp.x1), Math.abs(sp.z0), sp.front) * p.s + 40;
    const i0 = Math.max(0, Math.floor((p.x - R + HALF_WORLD) / cell)), i1 = Math.min(M - 1, Math.floor((p.x + R + HALF_WORLD) / cell));
    const j0 = Math.max(0, Math.floor((p.z - R + HALF_WORLD) / cell)), j1 = Math.min(M - 1, Math.floor((p.z + R + HALF_WORLD) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = (i + 0.5) * cell - HALF_WORLD, z = (j + 0.5) * cell - HALF_WORLD;
      const k = j * M + i;
      const sd = footprintSd(p, sp, x, z);
      if (sd > hf.shore[k]) {
        hf.shore[k] = sd;
        tex[k * 2] = sd;
      }
    }
  }
  hf.shoreTex.needsUpdate = true;
}

/**
 * Plan every piece, reshape the sea rocks they replace and move the waterline. Call right after the heightfield has
 * loaded, before the terrain, the sea, the spray or the plants read it.
 */
export function planRocks(hf: Heightfield): RockPlace[] {
  planned = hf;
  const out: RockPlace[] = [];
  const r = rng(4242);
  const wl = traceWaterline(hf);
  const at = (arc: number) => {
    // first sample at or beyond this arc length (wrapping)
    const total = wl[wl.length - 1].arc;
    const a = ((arc % total) + total) % total;
    let lo = 0, hi = wl.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (wl[m].arc < a) lo = m + 1;
      else hi = m;
    }
    return lo;
  };

  // ---- sea cliffs: runs of cliff coast, walked with overlapping pieces
  const isCliff = (p: WlPt) => p.kind > 0.8 && p.top > 16;
  let i = 0;
  // start at a point that is not cliff so runs do not wrap
  while (i < wl.length && isCliff(wl[i])) i++;
  const start = i;
  const runs: [number, number][] = [];
  for (let k = 0; k < wl.length; k++) {
    const idx = (start + k) % wl.length;
    if (!isCliff(wl[idx])) continue;
    let e = k;
    while (e + 1 < wl.length && isCliff(wl[(start + e + 1) % wl.length])) e++;
    runs.push([idx, (start + e) % wl.length]);
    k = e;
  }
  let prev = '';
  for (const [ia, ib] of runs) {
    const arcA = wl[ia].arc, arcB = ib >= ia ? wl[ib].arc : wl[ib].arc + wl[wl.length - 1].arc;
    if (arcB - arcA < 30) continue;
    let a = arcA - 6;
    while (a < arcB) {
      const p0 = wl[at(a)];
      const tall = p0.top > 34;
      const pool = tall ? ['cliff_a', 'cliff_a', 'cliff_g', 'cliff_g', 'cliff_c', 'cliff_c', 'cliff_e', 'cliff_d'] : ['cliff_b', 'cliff_b', 'cliff_c', 'cliff_g', 'cliff_d'];
      let piece = r.pick(pool);
      if (piece === prev) piece = r.pick(pool);
      prev = piece;
      const sp = SPEC[piece];
      // the skyline at the terrain's lip over the piece, give or take (the lip rounds over onto the plateau)
      let s = ((p0.top + 0.9) * r.range(0.93, 1.02)) / sp.top;
      s = THREE.MathUtils.clamp(s, 1.6, 9);
      let W = (sp.x1 - sp.x0) * s;
      const tops: number[] = [];
      for (let k = 0; k <= 6; k++) tops.push(wl[at(a + (W * k) / 6)].top);
      tops.sort((x, y) => x - y);
      s = THREE.MathUtils.clamp(Math.min(s, ((tops[2] + 0.9) * 1.02) / sp.top), 1.6, 9);
      W = (sp.x1 - sp.x0) * s;
      // facing: the mean normal over the width; the base line where no waterline point is in front of it
      let nx = 0, nz = 0;
      const pts: WlPt[] = [];
      for (let k = 0; k <= 8; k++) {
        const q = wl[at(a + (W * k) / 8)];
        pts.push(q);
        nx += q.nx;
        nz += q.nz;
      }
      const l = Math.hypot(nx, nz) || 1;
      nx /= l;
      nz /= l;
      const mid = wl[at(a + W / 2)];
      let off = 0;
      for (let k = 1; k < 8; k++) off = Math.max(off, (pts[k].x - mid.x) * nx + (pts[k].z - mid.z) * nz);
      const yaw = Math.atan2(nx, nz);
      const tx = nz, tz = -nx;
      const cx = ((sp.x0 + sp.x1) / 2) * s;
      out.push({ piece, x: mid.x + nx * (off + 0.6) - tx * cx, y: -0.9, z: mid.z + nz * (off + 0.6) - tz * cx, yaw, s, zone: 0 });
      // fallen blocks at the foot of some tall faces, washed by the surf
      if (tall && r.next() < 0.45) {
        const bp = r.next() < 0.6 ? 'cliff_f' : 'cliff_b';
        const bs = bp === 'cliff_f' ? r.range(1.3, 2.2) : r.range(0.9, 1.4);
        const along = r.range(-0.3, 0.3) * W;
        const outD = off + 0.6 + sp.front * s * 0.8 + r.range(1, 5);
        const yawB = yaw + r.range(-0.6, 0.6);
        out.push({ piece: bp, x: mid.x + nx * outD + tx * along, y: -1.6, z: mid.z + nz * outD + tz * along, yaw: yawB, s: bs, zone: 0 });
      }
      a += W * r.range(0.68, 0.78);
    }
  }

  // ---- sea stacks: on the platforms of the old islets, plus two off the north cliffs
  const stacks: { piece: string; x: number; z: number; s: number; shelf: number }[] = [];
  const isl = ISLETS.filter((is) => is.kind >= 2);
  const pickFor = (h: number) => (h > 30 ? 'stack_c' : h > 24 ? 'stack_a' : 'stack_b');
  for (const is of isl) stacks.push({ piece: pickFor(is.h), x: is.c[0], z: is.c[1], s: is.h > 30 ? 0.95 : 0.92, shelf: 0 });
  // two more off the north cliffs, standing in deep water (the surf rings their feet from the moved waterline)
  stacks.push({ piece: 'stack_a', x: -268, z: -652, s: 1.1, shelf: 0 });
  stacks.push({ piece: 'stack_b', x: -455, z: -618, s: 0.85, shelf: 0 });
  for (const st of stacks) {
    const sp = SPEC[st.piece];
    // the deep notch (+Z) toward the open sea: away from the island's middle
    const yaw = Math.atan2(st.x + 120, st.z + 60);
    out.push({ piece: st.piece, x: st.x, y: -(sp.water ?? 4.6) * st.s, z: st.z, yaw, s: st.s, zone: 2 });
  }
  reshapeSeaRocks(hf, stacks.filter((s) => s.shelf > 0).map((s) => ({ x: s.x, z: s.z, r: s.shelf })));

  // ---- the waterfall: a gorge of wet faces round the plunge pool (see falls())
  out.push(...falls(hf));

  deepenFeet(hf, out);
  moveWaterline(hf, out);
  return out;
}

/**
 * The gorge: a fluted wall behind the falls (the water falls a metre or two in front of it), wider walls on either
 * side turned toward the pool. Each piece is fitted to the escarpment: its face stands just in front of where the
 * terrain wall reaches mid-height, its skyline just under the plateau, its foot under the pool or the bank.
 */
function falls(hf: Heightfield): RockPlace[] {
  const { lip, toward } = hf.meta.falls;
  const pool = hf.meta.pool;
  const dx = toward[0] - lip[0], dz = toward[1] - lip[1], dl = Math.hypot(dx, dz);
  const Dx = dx / dl, Dz = dz / dl;
  rockU.falls.value.set(lip[0], hf.meta.falls.top, lip[1]);
  rockU.pool.value.set(pool.p[0], pool.level, pool.p[1]);
  const fp = fallsPath(hf);
  rockU.impact.value.set(fp.lx + fp.fx * fp.outEnd, pool.level, fp.lz + fp.fz * fp.outEnd);
  // the escarpment runs about north-south here and faces east
  const Tx = 0.083, Tz = -0.997, Fx = 0.997, Fz = 0.083;
  const out: RockPlace[] = [];
  // piece, metres along the escarpment from the lip (+ north), turn toward the pool (0..1), gap in front of the
  // wall (behind the falls: in front of the terrain at mid-height but behind the falling water; the flanks: in front
  // of the terrain's most protruding point at every height, so none of it shows through), largest scale
  const layout: [string, number, number, number, number][] = [
    ['cliff_a', 0, 0, -4.2, 3.0],
    ['cliff_c', 18, 0.35, 0.6, 2.8],
    ['cliff_a', -13, 0.4, 0.6, 2.6],
    ['cliff_d', -27, 0.3, 0.6, 2.6],
    ['cliff_g', 42, 0.2, 0.6, 2.6],
  ];
  for (const [piece, along, turn, gap, sMax] of layout) {
    const sp = SPEC[piece];
    const bx = lip[0] + Tx * along, bz = lip[1] + Tz * along;
    // facing: the falls' direction behind them, else the escarpment's, turned toward the pool's middle
    const ax = along === 0 ? Dx : Fx, az = along === 0 ? Dz : Fz;
    const px = pool.p[0] - bx, pz = pool.p[1] - bz, pl = Math.hypot(px, pz) || 1;
    let fx = ax * (1 - turn) + (px / pl) * turn, fz = az * (1 - turn) + (pz / pl) * turn;
    const fl = Math.hypot(fx, fz);
    fx /= fl;
    fz /= fl;
    const top = hf.height(bx - fx * 7, bz - fz * 7) - 0.4;
    const foot = Math.min(hf.height(bx + fx * 9, bz + fz * 9), pool.level) - 1.8;
    // the wall: walk in from the pool side until the terrain stands at a level
    const wallAt = (level: number) => {
      let w = 16;
      while (w > -10 && hf.height(bx + fx * w, bz + fz * w) < level) w -= 0.25;
      return w;
    };
    let w = wallAt((top + foot) / 2);
    if (along !== 0) for (const k of [0.3, 0.45, 0.6, 0.75, 0.9]) w = Math.max(w, wallAt(foot + (top - foot) * k));
    let s = THREE.MathUtils.clamp((top - foot) / sp.top, 1.4, sMax);
    // (a piece at its largest scale keeps its skyline at the plateau)
    let y = Math.max(foot, top - sp.top * s);
    // the face's foot stands ~front*s in front of the origin, its middle a little less
    const at = (k: number) => {
      const back = sp.front * k * 0.85 - gap, cx = ((sp.x0 + sp.x1) / 2) * k;
      return [bx + fx * (w - back) - fz * cx, bz + fz * (w - back) + fx * cx];
    };
    // the flanks: the base line goes down to the bank in front of the face (the skirt below it is a plain extrusion:
    // left standing above the bank it reads as a flat grey wall round the pool); the piece grows to keep its skyline
    // at the plateau
    for (let it = 0; it < 3 && along !== 0; it++) {
      const [X, Z] = at(s);
      const hs: number[] = [];
      for (const u of [-0.2, 0, 0.2]) for (const o of [0.6, 1.6, 2.6]) {
        const lx = ((sp.x0 + sp.x1) / 2) * s + u * (sp.x1 - sp.x0) * Math.min(s, 2.6), lz = sp.front * s + o;
        hs.push(hf.height(X + fz * lx + fx * lz, Z - fx * lx + fz * lz));
      }
      // a low quantile, never under the pool's surface (the water hides the rest)
      const bank = Math.max(hs.sort((p, q) => p - q)[2], pool.level - 0.3);
      if (bank > y - 0.3) break;
      s = THREE.MathUtils.clamp((top - bank + 0.5) / sp.top, 1.4, 3.15);
      y = Math.min(top - sp.top * s, bank - 0.5);
    }
    const [X, Z] = at(s);
    out.push({ piece, x: X, y, z: Z, yaw: Math.atan2(fx, fz), s, zone: 1, wall: along === 0 });
  }
  // the low tier: where the basin's bank climbs steeply to the gorge walls (south-west and north-west of the pool,
  // clear of the falls), low faces stand out of the water with their feet at its edge, so the bank between the pool
  // and the walls is broken rock rather than a smooth slope of terrain. Piece, bearing from the pool's middle
  // (degrees, 0 = +x, 90 = +z), scale, turn off the radial, sink of the base line below the water
  const rim: [string, number, number, number, number][] = [
    ['cliff_b', 136, 0.74, 0.08, 0.35],
    ['cliff_h', 244, 0.62, -0.06, 0.12],
  ];
  for (const [piece, deg, s, turn, sink] of rim) {
    const sp = SPEC[piece];
    const a = (deg * Math.PI) / 180, dx = Math.cos(a), dz = Math.sin(a);
    let edge = 6;
    while (edge < 30 && hf.height(pool.p[0] + dx * edge, pool.p[1] + dz * edge) < pool.level) edge += 0.2;
    const ro = edge + sp.front * s * 0.55;
    const yaw = Math.atan2(-dx, -dz) + turn;
    const cx = ((sp.x0 + sp.x1) / 2) * s;
    out.push({ piece, x: pool.p[0] + dx * ro - Math.cos(yaw) * cx, y: pool.level - sink * s, z: pool.p[1] + dz * ro + Math.sin(yaw) * cx, yaw, s, zone: 3 });
  }
  sheet = fallsPath(hf);
  gorgeT = new THREE.Vector2(Tx, Tz);
  return out;
}

/** the kit's rock: its scan textures, darker and glossier where spray, the falls or rain wet it, moss and grass on
 * ledges and in the damp gorge, rust and lichen bands and dark runoff stains down the faces */
function kitMaterial(src: THREE.MeshStandardMaterial) {
  const m = sunLit(new THREE.MeshStandardNodeMaterial());
  m.name = `kit_${src.name}`;
  const U = uv();
  const p = positionWorld;
  const base = src.map ? texture(src.map, U).rgb : vec3(0.07, 0.068, 0.064);
  const ormT = src.roughnessMap ?? src.aoMap;
  const orm = ormT ? texture(ormT, U) : vec4(1, 0.85, 0, 1);
  const up = normalWorldGeometry.y;
  // (every pattern a few metres or more across is worked out per vertex: the meshes have vertices every 0.3-1.5 m)
  // broad lighter and darker reaches over a face, rust-brown and greenish bands across it
  // (packed four to a varying: the vertex stage has sixteen slots and the lighting takes most of them)
  const along = p.x.mul(0.62).add(p.z.mul(0.78));
  const ybN = mx_noise_float(vec3(p.xz.mul(1 / 17), 5.2));
  const vA: N = varying(vec4(
    mx_noise_float(vec3(p.x.add(p.z).mul(1 / 46), p.y.mul(1 / 31), 1.7)),
    mx_noise_float(vec3(p.y.mul(1 / 7.5), p.x.sub(p.z).mul(1 / 70), 4.3)),
    mx_noise_float(vec3(along.mul(0.21), p.y.mul(0.012), 7.7)),
    mx_noise_float(vec3(p.xz.mul(0.045), 2.1))));
  const vB: N = varying(vec4(
    mx_noise_float(p.mul(0.16)),
    ybN,
    mx_noise_float(vec3(along.mul(0.09), p.y.add(ybN.mul(2.6)).mul(0.21), 9.4)),
    mx_noise_float(vec3(along.mul(0.05), p.y.mul(0.11), 2.6))));
  const big = vA.x, band = vA.y;
  let alb: N = base.mul(float(1).add(big.mul(0.26)));
  alb = mix(alb, alb.mul(vec3(1.32, 0.98, 0.72)), smoothstep(0.25, 0.7, band).mul(0.55));
  alb = mix(alb, alb.mul(vec3(0.92, 1.08, 0.95)), smoothstep(-0.3, -0.7, band).mul(0.5));
  // runoff stains: narrow across, long down the face
  const stain = smoothstep(0.35, 0.8, vA.z.mul(0.5).add(0.5));
  alb = alb.mul(float(1).sub(stain.mul(0.5)));
  // crisp detail finer than the stretched scan: narrow runnels down the face, thin bedding lines across it, grit in
  // between, so the broad scan lumps read as fractured, weathered rock and not as smooth wax
  const run = mx_noise_float(vec3(along.mul(0.85), p.y.mul(0.05), 3.3));
  const runnel = smoothstep(0.08, 0.0, run.abs()).mul(smoothstep(0.2, 0.6, float(1).sub(up.abs())));
  const bed = smoothstep(0.1, 0.0, mx_noise_float(vec3(p.y.mul(0.55), along.mul(0.04), 8.1)).abs());
  const grit = mx_noise_float(p.mul(2.7)).mul(0.5).add(0.5);
  alb = alb.mul(float(1).sub(runnel.mul(0.45))).mul(float(1).sub(bed.mul(0.3))).mul(grit.mul(0.36).add(0.82));
  // lava-flow strata on the walls: every metre or two a ledge, a sun-catching lip over a shadowed undercut, broken
  // along the face and wandering in height, and vertical cooling joints between them, so the scan's broad lumps read
  // as fractured basalt and not as melted wax
  const sheer = smoothstep(0.8, 0.35, up.abs());
  const yb = p.y.add(vB.y.mul(2.6));
  const sf = fract(yb.div(2.3));
  const ledgeOn = smoothstep(-0.3, 0.2, vB.z).mul(sheer);
  const lip = smoothstep(0.8, 0.9, sf).mul(smoothstep(1.0, 0.93, sf)).mul(ledgeOn);
  const under = smoothstep(0.0, 0.03, sf).mul(smoothstep(0.26, 0.06, sf)).mul(ledgeOn);
  const jx = fract(along.div(2.7).add(vB.w.mul(0.6)));
  const joint = smoothstep(0.07, 0.0, jx.sub(0.5).abs()).mul(sheer).mul(smoothstep(-0.2, 0.4, vB.w.mul(1.7).sub(vA.z.mul(0.8))));
  alb = alb.mul(float(1).sub(under.mul(0.72))).mul(float(1).add(lip.mul(0.3))).mul(float(1).sub(joint.mul(0.5)));
  // the waterfall: everything within reach of its spray is wet; the gorge is mossy
  const dFalls = length(p.xz.sub(rockU.falls.xz));
  const dPool = length(p.xz.sub(rockU.pool.xz));
  // fractured blocks on the sea-cliff faces: a cell pattern in the plane of the face (rows a block high along the
  // strata), each cell a flat facet tilted its own way with its own tone, dark cracks between them, so the scan's
  // rounded lumps break into angular basalt. Only near the camera and away from the falls (the gorge's rocks share
  // this material and skip the work in the branch).
  const nG = normalWorldGeometry;
  const camD = length(p.sub(cameraPosition));
  const fracMask = smoothstep(0.92, 0.55, nG.y.abs()).mul(smoothstep(170, 70, camD)).mul(smoothstep(45, 70, dPool));
  const useX = nG.x.abs().greaterThan(nG.z.abs());
  const frac: N = Fn(() => {
    const r = vec4(0.5, 0.5, 1, 0).toVar();
    If(fracMask.greaterThan(0.01), () => {
      const q = vec2(select(useX, p.z, p.x).div(1.45), p.y.add(vB.y.mul(2.6)).div(1.05)).add(4096);
      // (the 2x2 cells nearest the point, jitter kept under half a cell so they hold the nearest two; branch-free:
      // a smaller node graph to build at load and less work per pixel than a 3x3 search)
      const cell = floor(q.sub(0.5));
      let f1: N = float(9), f2: N = float(9), id: N = vec2(0.5);
      for (let j = 0; j <= 1; j++) for (let i = 0; i <= 1; i++) {
        const c = cell.add(vec2(i, j));
        const h = vec2(hash(c.x.mul(37).add(c.y.mul(1301))), hash(c.x.mul(113).add(c.y.mul(709)).add(17)));
        const d = length(c.add(0.5).add(h.sub(0.5).mul(0.5)).sub(q));
        const nearer = d.lessThan(f1);
        f2 = min(f2, max(f1, d));
        id = select(nearer, h, id);
        f1 = min(f1, d);
      }
      r.assign(vec4(id, f2.sub(f1), fracMask));
    });
    return r;
  })();
  const crack = smoothstep(0.07, 0.0, frac.z).mul(frac.w);
  alb = alb.mul(mix(float(1), frac.x.mul(0.16).add(0.92), frac.w)).mul(float(1).sub(crack.mul(0.55)));
  const gorge = smoothstep(42, 18, dPool).mul(smoothstep(rockU.pool.y.sub(8), rockU.pool.y.add(2), p.y));
  // (the plunge throws spray over the walls round it, a dozen metres up)
  const plunge = smoothstep(24, 7, length(p.xz.sub(rockU.impact.xz))).mul(smoothstep(rockU.pool.y.add(18), rockU.pool.y.add(4), p.y));
  const fallsWet = max(max(smoothstep(13, 4, dFalls), plunge), smoothstep(24, 10, dPool).mul(smoothstep(rockU.pool.y.add(9), rockU.pool.y, p.y)).mul(0.8));
  // the spray zone at the foot of the sea cliffs (higher where they are exposed), dark and glistening
  const sprayTop = float(4.5).add(vA.w.mul(2.2));
  const spray = smoothstep(sprayTop, sprayTop.mul(0.25), p.y);
  // moss and turf on ledges and the cliff cap; in the gorge on everything but the sheer faces
  const patch = smoothstep(-0.25, 0.35, vB.x);
  const fine = mx_noise_float(p.mul(0.9)).mul(0.5).add(0.5);
  const ledge = smoothstep(0.42, 0.8, up).mul(patch).mul(float(1).sub(spray));
  const gorgeMoss = gorge.mul(smoothstep(-0.25, 0.35, up)).mul(smoothstep(0.1, 0.7, patch.add(fine.mul(0.4))));
  const green = max(ledge, gorgeMoss).clamp(0, 1);
  const mossCol = mix(vec3(0.035, 0.06, 0.016), vec3(0.075, 0.105, 0.03), fine);
  alb = mix(alb, mossCol, green.mul(0.92));
  // wet: darker, smoother. Spray and the falls keep a glassy film; rain only darkens the rough scan and gives it a
  // soft sheen (a sharp one mirrors the bright overcast in every boss and reads as frost)
  const soaked = max(spray, fallsWet).clamp(0, 1);
  const wet = max(soaked, wetness.rain.mul(0.85)).clamp(0, 1);
  // (soaked rock under a running film is near black)
  alb = alb.mul(mix(float(1), float(0.48), wet)).mul(mix(float(1), float(0.58), soaked));
  m.colorNode = vec4(alb, 1);
  const wetRough = mix(min(orm.g, float(0.48)), min(orm.g, float(0.17)), soaked.div(wet.max(0.001)));
  m.roughnessNode = mix(orm.g.max(0.62).mul(float(1).sub(green.mul(0.1))), wetRough, wet.mul(float(1).sub(green.mul(0.5))));
  m.metalnessNode = float(0);
  m.aoNode = orm.r;
  // (the scan's normals pushed harder, then the ledges' lips tilted up and their undercuts down, in world space)
  const nV: N = src.normalMap ? normalMap(texture(src.normalMap, U), vec2(1.7)) : normalWorldGeometry;
  const nW = src.normalMap ? cameraWorldMatrix.mul(vec4(nV, 0)).xyz : nV;
  const tang = select(useX, vec3(0, 0, 1), vec3(1, 0, 0));
  const facet = tang.mul(frac.x.sub(0.5).mul(0.6)).add(vec3(0, 1, 0).mul(frac.y.sub(0.42).mul(0.55)));
  const nF = normalize(mix(nW, nG, frac.w.mul(0.2)).add(facet.mul(frac.w)));
  const nW2 = normalize(nF.add(vec3(0, 1, 0).mul(lip.mul(1.5).sub(under.mul(1.0)))));
  m.normalNode = normalize(cameraViewMatrix.mul(vec4(nW2, 0)).xyz);
  return m;
}

interface PieceSet { lods: { geometry: THREE.BufferGeometry; material: THREE.Material }[][]; places: RockPlace[]; meshes: THREE.InstancedMesh[][] }

export class RockKit {
  readonly group = new THREE.Group();
  private sets = new Map<string, PieceSet>();
  /** frames left in which every mesh draws (collapsed if empty) so its pipelines compile behind the loading screen */
  prime = 0;
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private sc = new THREE.Vector3();
  private yAxis = new THREE.Vector3(0, 1, 0);
  private lastCam = new THREE.Vector3(Infinity, 0, 0);
  private lastDir = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private unprime = false;

  constructor(readonly places: RockPlace[], private colliders: Colliders) {
    this.group.name = 'rockkit';
    // (the gorge's pieces may still move to clear the falls: theirs are made once the kit has loaded)
    for (const p of places) if (p.zone !== 1) this.collide(p);
  }

  /** the swimmer (and the camera) are kept out of the rock: a box from behind the face to its foot */
  private collide(p: RockPlace) {
    const sp = SPEC[p.piece];
    const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
    const zf = sp.front * p.s * (sp.file === 'stack' ? 0.75 : 0.8), zb = sp.file === 'stack' ? -zf : -1.5;
    const hx = ((sp.x1 - sp.x0) / 2) * p.s * (sp.file === 'stack' ? 0.75 : 0.9), cxl = ((sp.x0 + sp.x1) / 2) * p.s;
    const czl = (zf + zb) / 2;
    // local (x, z) -> world: x * (c, -s) + z * (s, c)
    const wx = p.x + cxl * c + czl * s, wz = p.z - cxl * s + czl * c;
    this.colliders.box(wx, wz, hx, (zf - zb) / 2, -p.yaw, p.y - 4, p.y + sp.top * p.s);
  }

  /** boulders, stones and cobbles round the plunge pool */
  private poolRocks: PoolRocks | null = null;

  async load() {
    const byFile = new Map<string, Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material }[][]>>();
    const mats = new Map<THREE.Material, THREE.Material>();
    const rocks = planned ? new PoolRocks(planned, this.colliders) : null;
    const rocksLoad = rocks?.load(kitMaterial).then(() => {
      this.poolRocks = rocks;
      this.group.add(rocks.group);
    }, (e) => console.warn('pool rocks', e));
    await Promise.all((Object.keys(FILES) as (keyof typeof FILES)[]).map(async (f) => {
      const gltf = await loadGLTF(FILES[f]);
      gltf.scene.updateMatrixWorld(true);
      const pieces = new Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material }[][]>();
      for (const node of gltf.scene.children) {
        const mm = /^(.*)_lod(\d)$/.exec(node.name);
        if (!mm) continue;
        const parts: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];
        node.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const g = toFloatGeometry(mesh.geometry);
          g.applyMatrix4(mesh.matrixWorld);
          const src = mesh.material as THREE.MeshStandardMaterial;
          let mat = mats.get(src);
          if (!mat) mats.set(src, (mat = kitMaterial(src)));
          parts.push({ geometry: g, material: mat });
        });
        let lods = pieces.get(mm[1]);
        if (!lods) pieces.set(mm[1], (lods = []));
        lods[Number(mm[2])] = parts;
      }
      byFile.set(f, pieces);
    }));
    for (const p of this.places) {
      let set = this.sets.get(p.piece);
      if (!set) {
        const lods = byFile.get(SPEC[p.piece].file)?.get(p.piece);
        if (!lods) continue;
        this.sets.set(p.piece, (set = { lods, places: [], meshes: [] }));
      }
      set.places.push(p);
    }
    this.clearFalls();
    for (const p of this.places) if (p.zone === 1) this.collide(p);
    this.findLedges();
    for (const [name, set] of this.sets) {
      set.meshes = set.lods.map((parts, l) => parts.map((part) => {
        const mesh = instancedMesh(part.geometry, part.material, set.places.length);
        mesh.name = `${name}_l${l}`;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        mesh.count = 0;
        // big occluders: drawn before the terrain and the far plants they hide
        mesh.renderOrder = -3.5;
        this.group.add(mesh);
        return mesh;
      }));
    }
    await rocksLoad;
  }

  /**
   * No rock pokes through the falling water: rays from in front of the sheet find each gorge piece's real surface
   * (its flutes and bosses reach well past its placement box). The wall behind the falls steps back until all of it
   * is at least `margin` behind the water; a flank whose edge swings in front of the sheet (they are turned toward
   * the pool) slides along the escarpment, away from the falls, until that edge is past the sheet's.
   */
  private clearFalls(margin = 0.8) {
    if (!sheet || !gorgeT) return;
    const T = gorgeT;
    const ray = new THREE.Raycaster();
    const back = new THREE.Vector3(-sheet.fx, 0, -sheet.fz);
    const o = new THREE.Vector3();
    const pts: THREE.Vector3[] = [];
    for (let j = 0; j <= 12; j++) for (let i = 0; i <= 10; i++) pts.push(sheet.point(i / 10 - 0.5, j / 12, 0, 0.35));
    // metres along the escarpment from the lip (+ north)
    const along = (x: number, z: number) => (x - sheet!.lx) * T.x + (z - sheet!.lz) * T.y;
    const aMin = Math.min(...pts.map((q) => along(q.x, q.z))), aMax = Math.max(...pts.map((q) => along(q.x, q.z)));
    const moves: string[] = [];
    for (const [name, set] of this.sets) {
      const geo = (set.lods[1] ?? set.lods[0])[0]?.geometry;
      if (!geo) continue;
      const probe = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.FrontSide }));
      for (const pl of set.places) {
        if (pl.zone !== 1) continue;
        for (let pass = 0; pass < 3; pass++) {
          probe.position.set(pl.x, pl.y, pl.z);
          probe.rotation.set(0, pl.yaw, 0);
          probe.scale.setScalar(pl.s);
          probe.updateMatrixWorld(true);
          let push = 0, lo = Infinity, hi = -Infinity;
          for (const q of pts) {
            ray.set(o.copy(q).addScaledVector(back, -12), back);
            const hit = ray.intersectObject(probe, false)[0];
            if (!hit || hit.distance > 12 + margin) continue;
            push = Math.max(push, 12 + margin - hit.distance);
            const a = along(q.x, q.z);
            lo = Math.min(lo, a);
            hi = Math.max(hi, a);
          }
          if (push === 0) break;
          if (pl.wall) {
            const d = Math.min(push, 6);
            pl.x += back.x * d;
            pl.z += back.z * d;
            moves.push(`${name} back ${d.toFixed(1)} m`);
          } else {
            const side = Math.sign(along(pl.x, pl.z)) || 1;
            const d = Math.min(side > 0 ? aMax + 1 - lo : hi - (aMin - 1), 14);
            pl.x += T.x * side * d;
            pl.z += T.y * side * d;
            moves.push(`${name} along ${(side * d).toFixed(1)} m`);
          }
        }
      }
    }
    if (moves.length) console.info(`[island] rock kit: cleared the falls (${moves.join(', ')})`);
  }

  /** where plants hold on to the rock: ferns, vine curtains and dripping mats on the walls, moss on the ledges */
  readonly ledges: { x: number; y: number; z: number; yaw: number; s: number; kind: string }[] = [];

  /**
   * Rays at each gorge piece (and the upper faces of the sea cliffs) find its real surface: hits on walls hold
   * hanging plants turned out along the surface normal, hits on ledge tops hold moss cushions and ferns.
   */
  private findLedges() {
    const r = rng(9191);
    const ray = new THREE.Raycaster();
    const nm = new THREE.Matrix3();
    const n = new THREE.Vector3();
    for (const set of this.sets.values()) {
      const geo = (set.lods[1] ?? set.lods[0])[0]?.geometry;
      if (!geo) continue;
      const probe = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.FrontSide }));
      for (const p of set.places) {
        if (p.zone === 2) continue;
        const sp = SPEC[p.piece];
        probe.position.set(p.x, p.y, p.z);
        probe.rotation.set(0, p.yaw, 0);
        probe.scale.setScalar(p.s);
        probe.updateMatrixWorld(true);
        nm.getNormalMatrix(probe.matrixWorld);
        const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw), tx = Math.cos(p.yaw), tz = -Math.sin(p.yaw);
        const gorge = p.zone === 1 || p.zone === 3;
        const tries = p.zone === 1 ? 70 : p.zone === 3 ? 26 : 6;
        for (let k = 0; k < tries; k++) {
          const lx = r.range(sp.x0 * 0.85, sp.x1 * 0.85) * p.s;
          const down = r.next() < (gorge ? 0.4 : 0);
          const ly = (gorge ? r.range(0.12, 0.98) : r.range(0.72, 0.97)) * sp.top * p.s;
          const ox = p.x + tx * lx, oz = p.z + tz * lx;
          if (down) {
            const lz = r.range(-0.5, sp.front) * p.s;
            ray.set(new THREE.Vector3(ox + fx * lz, p.y + sp.top * p.s + 3, oz + fz * lz), new THREE.Vector3(0, -1, 0));
          } else {
            ray.set(new THREE.Vector3(ox + fx * (sp.front * p.s + 12), p.y + ly, oz + fz * (sp.front * p.s + 12)), new THREE.Vector3(-fx, 0, -fz));
          }
          const hit = ray.intersectObject(probe, false)[0];
          if (!hit?.face) continue;
          n.copy(hit.face.normal).applyMatrix3(nm).normalize();
          const q = hit.point;
          if (gorge && q.y < rockU.pool.value.y + 0.8) continue;
          if (n.y > 0.55) {
            // a ledge: a moss cushion, or a fern hanging over its edge
            const kind = r.next() < 0.6 ? r.pick(['moss_a', 'moss_b']) : r.pick(['hangfern_a', 'hangfern_b']);
            this.ledges.push({ x: q.x, y: q.y - 0.05, z: q.z, yaw: kind.startsWith('moss') ? r.next() * 6.28 : Math.atan2(n.x, n.z) || p.yaw, s: r.range(0.8, 1.5), kind });
          } else if (n.y > -0.3) {
            // a wall: hanging plants, turned out from it and pushed into it a little
            const out = Math.hypot(n.x, n.z) || 1;
            const yaw = Math.atan2(n.x / out, n.z / out);
            const kind = gorge ? r.pick(['hangfern_a', 'hangfern_b', 'wallclump_a', 'wallclump_a', 'vinecurtain_a', 'vinecurtain_b']) : 'vinecurtain_b';
            const s = gorge ? r.range(0.8, 1.6) : r.range(2.2, 3.6);
            this.ledges.push({ x: q.x - (n.x / out) * 0.1, y: q.y, z: q.z - (n.z / out) * 0.1, yaw, s, kind });
          }
        }
      }
    }
  }

  update(camera: THREE.PerspectiveCamera) {
    const cam = camera.position;
    const priming = this.prime > 0;
    if (priming) this.prime--;
    this.poolRocks?.update(camera, priming);
    // the lists change only when the camera moves or turns (and once after the priming frames): re-cull and upload
    // them then, not every frame
    camera.getWorldDirection(this.dir);
    if (!priming && !this.unprime && cam.distanceTo(this.lastCam) < 0.5 && this.dir.angleTo(this.lastDir) < 0.01) return;
    this.unprime = priming;
    this.lastCam.copy(cam);
    this.lastDir.copy(this.dir);
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv, THREE.WebGPUCoordinateSystem);
    for (const set of this.sets.values()) {
      const counts = set.meshes.map(() => 0);
      for (const p of set.places) {
        const sp = SPEC[p.piece];
        const half = Math.max(sp.x1 - sp.x0, sp.top) * 0.5 * p.s;
        this.sphere.center.set(p.x, p.y + sp.top * p.s * 0.5, p.z);
        this.sphere.radius = half * 1.25;
        if (!priming && !this.frustum.intersectsSphere(this.sphere)) continue;
        const d = Math.max(0, this.sphere.center.distanceTo(cam) - half);
        // (the small faces round the pool are seen from a few metres: full detail as far as a big face's)
        const ls = p.zone === 3 ? Math.max(p.s, 1.6) : p.s;
        const l = Math.min(set.meshes.length - 1, d < 26 * ls ? 0 : d < 105 * ls ? 1 : 2);
        const k = counts[l]++;
        this.q.setFromAxisAngle(this.yAxis, p.yaw);
        this.m4.compose(this.v.set(p.x, p.y, p.z), this.q, this.sc.set(p.s, p.s, p.s));
        for (const mesh of set.meshes[l]) mesh.setMatrixAt(k, this.m4);
      }
      set.meshes.forEach((row, l) => {
        for (const mesh of row) {
          let n = counts[l];
          if (priming && n === 0) {
            mesh.setMatrixAt(0, this.m4.makeScale(0, 0, 0));
            n = 1;
          }
          mesh.count = n;
          mesh.visible = n > 0;
          if (n > 0) {
            const im = mesh.instanceMatrix;
            im.clearUpdateRanges();
            im.addUpdateRange(0, n * 16);
            im.needsUpdate = true;
          }
        }
      });
    }
  }
}
