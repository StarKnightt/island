/**
 * Vegetation: species (several grown variants each) scattered from the baked masks, drawn as instanced meshes per
 * species / LOD / part. Every few frames the visible instances are chosen on the CPU from a 32 m grid: frustum and
 * distance culling, LOD by distance; near instances are always kept so they cast shadows into view. Wind bends trunks
 * and branches from the root and flutters leaves, in world space for every instance alike.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, attribute, cos, float, mix, normalize, positionLocal, sin, texture, uv, vec2, vec3, vec4, uniform, cameraPosition,
  positionWorld, length, smoothstep, max, dot, normalWorld, positionViewDirection, pow, clamp, hash, instanceIndex, type N,
} from '../core/tsl';
import { Rng, Noise2 } from '../core/noise';
import type { Heightfield } from '../world/Heightfield';
import { HALF_WORLD } from '../world/layout';
import { palm, canopyTree, bush, banana, grassClump, type PartGeo } from './geometry';
import { wetness } from '../world/weatherUniforms';
import { loadKTX2, configureTex } from '../core/Assets';
import { atmo } from '../sky/Atmosphere';
import { cloudShadow } from '../sky/Sky';
import { Q } from '../core/quality';
import type { Colliders } from '../world/Colliders';

const CELL = 32;

export const vegU = { time: uniform(0), sunColor: uniform(new THREE.Color(1, 1, 1)) };

interface Lod { maxDist: number; parts: PartGeo[]; shadow: boolean }
interface Species {
  name: string;
  lods: Lod[];
  /** x, y, z, yaw, scale, phase */
  inst: Float32Array;
  count: number;
  cells: Map<number, number[]>;
  meshes: { lod: number; mesh: THREE.InstancedMesh; data: THREE.InstancedBufferAttribute }[][];
  radius: number;
  /** how far an instance may reach out of its 32 m cell (scaled instances reach further than `radius`) */
  pad: number;
}

// ---------------------------------------------------------------- materials
const placeholder = (c: [number, number, number, number]) => {
  const t = new THREE.DataTexture(new Uint8Array([c[0] * 255, c[1] * 255, c[2] * 255, c[3] * 255]), 1, 1);
  t.needsUpdate = true;
  return t;
};

function windOffset(height: N) {
  // per-instance data: yaw, phase
  const iData = attribute('iData', 'vec4');
  const yaw = iData.x, phase = iData.y;
  const w = attribute('wind', 'vec3');
  const t = vegU.time;
  // world wind into the instance's local frame
  const wd = wetness.windDir;
  const c = cos(yaw.negate()), s = sin(yaw.negate());
  const lw = vec2(wd.x.mul(c).add(wd.y.mul(s)), wd.x.mul(s).negate().add(wd.y.mul(c)));
  const strength = wetness.wind.mul(0.8).add(0.12);
  const gust = sin(t.mul(0.35).add(phase.mul(6.28)).add(positionWorld.x.mul(0.01))).mul(0.5).add(0.5);
  const sway = sin(t.mul(1.1).add(phase.mul(12.0)).add(w.z.mul(6.0))).mul(0.5).add(gust.mul(0.8));
  const bend = w.x.mul(strength).mul(sway).mul(height.mul(0.022));
  const flutterA = sin(t.mul(6.3).add(phase.mul(40)).add(positionLocal.x.mul(2.1)).add(positionLocal.z.mul(1.7)).add(w.z.mul(20)));
  const flutter = w.y.mul(strength).mul(flutterA).mul(0.045);
  return vec3(lw.x.mul(bend).add(flutter.mul(0.3)), flutter.mul(0.8).sub(bend.mul(0.12).mul(w.x)), lw.y.mul(bend).add(flutter.mul(0.3)));
}

interface MatSet { [k: string]: THREE.MeshStandardNodeMaterial }

function makeMaterials(): { mats: MatSet; texNodes: Record<string, N[]> } {
  const texNodes: Record<string, N[]> = {};
  const tex = (key: string, ph: THREE.Texture, uvN: N) => {
    const n = texture(ph, uvN);
    (texNodes[key] ??= []).push(n);
    return n;
  };
  const vcol = attribute('color', 'vec3');
  const mk = (name: string, opts: { alpha?: boolean; key?: string; nkey?: string; tint?: [number, number, number]; rough: number; height: number; flat?: [number, number, number]; translucent?: number }) => {
    const m = new THREE.MeshStandardNodeMaterial();
    m.name = `veg_${name}`;
    let col: N;
    let alpha: N = float(1);
    if (opts.key) {
      const t = tex(opts.key, placeholder([0.2, 0.35, 0.1, 1]), uv());
      col = t.rgb;
      alpha = t.a;
    } else col = vec3(...(opts.flat ?? [0.3, 0.25, 0.2]));
    // per-instance tint variation
    const iData = attribute('iData', 'vec4');
    const vary = hash(iData.y.mul(1000)).sub(0.5);
    col = col.mul(vec3(float(1).add(vary.mul(0.12)), float(1).add(vary.mul(0.06)), float(1).sub(vary.mul(0.08))));
    if (opts.tint) col = col.mul(vec3(...opts.tint));
    const ao = vcol.r;
    // wet: darker, glossier
    col = col.mul(mix(float(1), float(0.7), wetness.rain));
    const cloud = cloudShadow(positionWorld);
    m.colorNode = vec4(col.mul(ao.mul(0.85).add(0.15)).mul(mix(float(0.6), float(1), cloud)), alpha);
    // wet leaves turn glossy; wet bark only a little
    m.roughnessNode = mix(float(opts.rough), float(Math.min(opts.rough, opts.alpha ? 0.3 : 0.55)), wetness.rain);
    m.metalnessNode = float(0);
    if (opts.nkey) {
      const nt = tex(opts.nkey, placeholder([0.5, 0.5, 1, 1]), uv());
      m.normalNode = undefined as never;
      void nt;
    }
    if (opts.alpha) {
      m.alphaTest = 0.42;
      m.side = THREE.DoubleSide;
      m.alphaToCoverage = false;
    }
    // light through the leaves when the sun is behind them
    if (opts.translucent) {
      const sunDir = normalize(atmo.sunDir);
      const back = pow(clamp(dot(positionViewDirection.negate(), sunDir.negate()).negate(), 0, 1), 3);
      const facing = clamp(dot(normalWorld, sunDir).negate().add(0.6), 0, 1);
      m.emissiveNode = col.mul(vec3(vegU.sunColor)).mul(back.mul(facing).mul(opts.translucent * 0.07)).mul(cloud).mul(ao);
    }
    const height = float(opts.height);
    m.positionNode = Fn(() => positionLocal.add(windOffset(height)))();
    return m;
  };
  const mats: MatSet = {
    palmbark: mk('palmbark', { key: 'palm_bark', rough: 0.88, height: 12 }),
    frond: mk('frond', { alpha: true, key: 'palm_frond', rough: 0.55, height: 12, translucent: 0.35 }),
    nut: mk('nut', { flat: [0.32, 0.26, 0.12], rough: 0.5, height: 12 }),
    bark: mk('bark', { key: 'bark', rough: 0.88, height: 22, tint: [1.1, 1.05, 1.0] }),
    leaf: mk('leaf', { alpha: true, key: 'canopy', rough: 0.45, height: 22, translucent: 0.3 }),
    banana: mk('banana', { alpha: true, key: 'banana_leaf', rough: 0.5, height: 3, translucent: 0.4 }),
    grass: mk('grass', { alpha: true, key: 'grass', rough: 0.7, height: 1, translucent: 0.25 }),
    bushleaf: mk('bushleaf', { alpha: true, key: 'canopy', rough: 0.5, height: 2, translucent: 0.3 }),
  };
  void vec2; void cameraPosition; void length; void smoothstep; void max; void instanceIndex;
  return { mats, texNodes };
}

// ---------------------------------------------------------------- the system
export class Vegetation {
  readonly group = new THREE.Group();
  private species: Species[] = [];
  private mats: MatSet;
  private texNodes: Record<string, N[]>;
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private lastCam = new THREE.Vector3(1e9, 0, 0);
  private lastDir = new THREE.Vector3();
  private frame = 0;
  private tmpP = new THREE.Vector3();
  private sphere = new THREE.Sphere();
  private box = new THREE.Box3();
  visible = 0;

  constructor(private hf: Heightfield, private colliders: Colliders) {
    const { mats, texNodes } = makeMaterials();
    this.mats = mats;
    this.texNodes = texNodes;
    this.group.name = 'vegetation';
  }

  /** stream the foliage textures and swap them in */
  async loadTextures() {
    const files: Record<string, [string, boolean]> = {
      palm_frond: ['assets/foliage/palm_frond.ktx2', true],
      palm_bark: ['assets/foliage/palm_bark.ktx2', true],
      canopy: ['assets/foliage/canopy.ktx2', true],
      banana_leaf: ['assets/foliage/banana_leaf.ktx2', true],
      grass: ['assets/foliage/grass.ktx2', true],
      bark: ['assets/tex/bark_a.ktx2', true],
    };
    await Promise.all(Object.entries(files).map(async ([key, [url, srgb]]) => {
      const t = configureTex(await loadKTX2(url), srgb);
      t.wrapS = t.wrapT = key === 'palm_bark' || key === 'bark' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      for (const n of this.texNodes[key] ?? []) n.value = t;
    }));
  }

  private addSpecies(name: string, lods: Lod[], radius: number, pad = radius) {
    const sp: Species = { name, lods, inst: new Float32Array(0), count: 0, cells: new Map(), meshes: [], radius, pad };
    this.species.push(sp);
    return sp;
  }

  private setInstances(sp: Species, list: number[]) {
    sp.inst = new Float32Array(list);
    sp.count = list.length / 6;
    for (let i = 0; i < sp.count; i++) {
      const x = sp.inst[i * 6], z = sp.inst[i * 6 + 2];
      const k = this.cellKey(x, z);
      let c = sp.cells.get(k);
      if (!c) sp.cells.set(k, (c = []));
      c.push(i);
    }
    // meshes: per lod, per part, one InstancedMesh sharing one matrix buffer and one data buffer
    for (let l = 0; l < sp.lods.length; l++) {
      const lod = sp.lods[l];
      const cap = Math.max(16, Math.min(sp.count, this.capacityFor(lod.maxDist, sp.count)));
      const matrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
      matrix.setUsage(THREE.DynamicDrawUsage);
      const data = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      data.setUsage(THREE.DynamicDrawUsage);
      const row: Species['meshes'][number] = [];
      for (const part of lod.parts) {
        const g = new THREE.BufferGeometry();
        for (const [k, a] of Object.entries(part.geometry.attributes)) g.setAttribute(k, a);
        g.setIndex(part.geometry.index);
        g.setAttribute('iData', data);
        const mat = part.material ?? (part.part === 'leaf' && name_isBush(sp.name) ? this.mats.bushleaf : this.mats[part.part]);
        const mesh = new THREE.InstancedMesh(g, mat, cap);
        mesh.instanceMatrix = matrix;
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.castShadow = lod.shadow;
        mesh.receiveShadow = true;
        mesh.name = `${sp.name}_l${l}_${part.part}`;
        this.group.add(mesh);
        row.push({ lod: l, mesh, data });
      }
      sp.meshes.push(row);
    }
  }

  private capacityFor(maxDist: number, total: number) {
    // rough upper bound of instances within the LOD's reach
    return Math.ceil(Math.min(total, total * Math.min(1, (Math.PI * maxDist * maxDist) / 1.6e6) * 3.5 + 64));
  }

  private cellKey(x: number, z: number) {
    return (Math.floor((x + HALF_WORLD) / CELL) << 8) | Math.floor((z + HALF_WORLD) / CELL);
  }

  /** grow the species and scatter them over the island */
  build() {
    const hf = this.hf;
    const noise = new Noise2(31);
    const D = Q.density;
    const lodK = Q.lodScale;
    // ---- coconut palms: 6 variants
    const palms: Species[] = [];
    for (let v = 0; v < 6; v++) {
      const height = 9 + v * 1.6;
      const lean = 0.12 + (v % 3) * 0.07;
      const lods: Lod[] = [
        { maxDist: 70 * lodK, parts: palm(100 + v, { height, lean, fronds: 18, segments: 9, sides: 9, dead: 2 + (v % 2), nuts: !new URLSearchParams(location.search).has('nonuts') }), shadow: true },
        { maxDist: 260 * lodK, parts: palm(100 + v, { height, lean, fronds: 12, segments: 5, sides: 6, dead: 1, nuts: false }), shadow: false },
        { maxDist: 1600, parts: palm(100 + v, { height, lean, fronds: 8, segments: 3, sides: 4, dead: 0, nuts: false }), shadow: false },
      ];
      palms.push(this.addSpecies(`palm${v}`, lods, height));
    }
    const young = this.addSpecies('palm_young', [
      { maxDist: 60 * lodK, parts: palm(150, { height: 1.2, lean: 0.05, fronds: 9, segments: 6, sides: 6, dead: 1, nuts: false }), shadow: true },
      { maxDist: 140 * lodK, parts: palm(150, { height: 1.2, lean: 0.05, fronds: 6, segments: 3, sides: 4, dead: 0, nuts: false }), shadow: false },
    ], 3);
    // ---- canopy trees: 5 variants
    const trees: Species[] = [];
    for (let v = 0; v < 5; v++) {
      const height = 17 + v * 2.6;
      const lods: Lod[] = [
        { maxDist: 85 * lodK, parts: canopyTree(300 + v, { height, spread: 8 + v * 0.8, cards: 150, sides: 9, lod: 0 }), shadow: true },
        { maxDist: 330 * lodK, parts: canopyTree(300 + v, { height, spread: 8 + v * 0.8, cards: 60, sides: 5, lod: 1 }), shadow: false },
      ];
      trees.push(this.addSpecies(`tree${v}`, lods, height));
    }
    // ---- understory
    const bushes: Species[] = [];
    for (let v = 0; v < 3; v++) {
      bushes.push(this.addSpecies(`bush${v}`, [
        { maxDist: 55 * lodK, parts: bush(400 + v, 1.4 + v * 0.5, 16), shadow: true },
        { maxDist: 110 * lodK, parts: bush(400 + v, 1.4 + v * 0.5, 6), shadow: false },
      ], 2));
    }
    const bananas = this.addSpecies('banana', [
      { maxDist: 70 * lodK, parts: banana(500, 2.8), shadow: true },
    ], 3);
    const grass: Species[] = [];
    for (let v = 0; v < 2; v++) grass.push(this.addSpecies(`grass${v}`, [{ maxDist: Q.grassFar, parts: grassClump(600 + v, 0.5 + v * 0.2, 5), shadow: false }], 0.6));

    // ---- scatter
    const lists = new Map<Species, number[]>();
    const push = (sp: Species, x: number, z: number, yaw: number, scale: number, phase: number, sink = 0) => {
      const y = hf.height(x, z) - sink;
      let l = lists.get(sp);
      if (!l) lists.set(sp, (l = []));
      l.push(x, y, z, yaw, scale, phase);
    };
    const r = new Rng(2024);
    // palms: the strip behind every beach, leaning out to sea; scattered at the jungle edge
    const STEP = 4.5 / Math.sqrt(D);
    for (let z = -700; z < 700; z += STEP) for (let x = -950; x < 950; x += STEP) {
      const px = x + r.range(-STEP, STEP) * 0.5, pz = z + r.range(-STEP, STEP) * 0.5;
      const s = hf.shoreDist(px, pz);
      if (s < 6 || s > 140) continue;
      const h = hf.height(px, pz);
      if (h < 1.2 || h > 60) continue;
      const sand = hf.sand(px, pz), forest = hf.forest(px, pz), rock = hf.rock(px, pz);
      if (rock > 0.4 || hf.water(px, pz) > 0.2) continue;
      const n = hf.normal(px, pz);
      if (n.y < 0.8) continue;
      // strongest where sand meets jungle, a band 10-70 m inland
      const band = THREE.MathUtils.smoothstep(s, 8, 22) * (1 - THREE.MathUtils.smoothstep(s, 55, 120));
      const edge = Math.max(sand * 0.9, 0.35) * (1 - forest * 0.55);
      const clump = 0.55 + 0.45 * noise.fbm(px / 40, pz / 40, 2);
      const p = band * edge * clump * 0.36;
      if (r.next() > p) continue;
      // lean toward the sea: down the shore-distance gradient
      const gx = hf.shoreDist(px + 4, pz) - hf.shoreDist(px - 4, pz), gz = hf.shoreDist(px, pz + 4) - hf.shoreDist(px, pz - 4);
      const toSea = Math.atan2(-gz, -gx);
      // the trunk leans along local +x: yaw so +x points to the sea, with spread
      const yaw = -toSea + r.range(-0.7, 0.7);
      push(r.pick(palms), px, pz, yaw, r.range(0.85, 1.2), r.next(), 0.1);
      if (r.next() < 0.18) push(young, px + r.range(-4, 4), pz + r.range(-4, 4), r.next() * 6.28, r.range(0.7, 1.4), r.next());
    }
    // keep the pool and the falls open: the clearing round the plunge pool
    const pool = hf.meta.pool, falls = hf.meta.falls;
    const clearing = (x: number, z: number, extra = 0) => Math.hypot(x - pool.p[0], z - pool.p[1]) < pool.r + 14 + extra || Math.hypot(x - falls.lip[0], z - falls.lip[1]) < 16 + extra;
    // canopy trees: jittered grid over the forest mask
    const TS = 8.5 / Math.sqrt(D);
    for (let z = -700; z < 700; z += TS) for (let x = -950; x < 950; x += TS) {
      const px = x + r.range(-0.45, 0.45) * TS, pz = z + r.range(-0.45, 0.45) * TS;
      const f = hf.forest(px, pz);
      if (f < 0.35 || r.next() > f * 1.1 || clearing(px, pz, 6)) continue;
      const n = hf.normal(px, pz);
      if (n.y < 0.75) continue;
      const h = hf.height(px, pz);
      if (h < 2.5) continue;
      if (r.next() < 0.12) {
        // a palm among the broadleaves
        push(r.pick(palms), px, pz, r.next() * 6.28, r.range(0.9, 1.3), r.next(), 0.1);
        continue;
      }
      const sp = r.pick(trees);
      push(sp, px, pz, r.next() * 6.28, r.range(0.75, 1.2) * (1 - THREE.MathUtils.smoothstep(h, 120, 170) * 0.4), r.next(), 0.3);
      this.colliders.circle(px, pz, 0.55 * 1.2, h - 1, h + 8);
    }
    // understory: denser grid, bushes / bananas / young palms under and between the trees
    const US = 3.2 / Math.sqrt(D);
    for (let z = -700; z < 700; z += US) for (let x = -950; x < 950; x += US) {
      const px = x + r.range(-0.5, 0.5) * US, pz = z + r.range(-0.5, 0.5) * US;
      const f = hf.forest(px, pz);
      const g = hf.grass(px, pz);
      if ((f < 0.2 && g < 0.4) || clearing(px, pz, -6)) continue;
      const n = hf.normal(px, pz);
      if (n.y < 0.7 || hf.dirt(px, pz) > 0.4 || hf.water(px, pz) > 0.1) continue;
      const h = hf.height(px, pz);
      if (h < 1.5) continue;
      const k = r.next();
      if (f > 0.3) {
        if (k < 0.42 * f) push(r.pick(bushes), px, pz, r.next() * 6.28, r.range(0.7, 1.4), r.next(), 0.1);
        else if (k < 0.5 * f) push(bananas, px, pz, r.next() * 6.28, r.range(0.75, 1.15), r.next());
        else if (k < 0.56 * f) push(young, px, pz, r.next() * 6.28, r.range(0.8, 1.6), r.next());
      } else if (k < 0.3 * g) push(r.pick(bushes), px, pz, r.next() * 6.28, r.range(0.5, 0.9), r.next(), 0.15);
    }
    // grass clumps (dense, only drawn near the camera)
    const GS = 0.9 / Math.sqrt(D);
    for (let z = -700; z < 700; z += GS) for (let x = -950; x < 950; x += GS) {
      const px = x + r.range(-0.5, 0.5) * GS, pz = z + r.range(-0.5, 0.5) * GS;
      const g = hf.grass(px, pz), f = hf.forest(px, pz), sand = hf.sand(px, pz);
      const w = Math.max(g, f * 0.35, sand > 0.3 && sand < 0.8 && hf.shoreDist(px, pz) > 40 ? 0.3 : 0);
      if (w < 0.15 || r.next() > w) continue;
      if (hf.dirt(px, pz) > 0.5 || hf.rock(px, pz) > 0.5 || hf.water(px, pz) > 0.05) continue;
      if (hf.height(px, pz) < 1.0) continue;
      push(r.pick(grass), px, pz, r.next() * 6.28, r.range(0.7, 1.3), r.next(), 0.02);
    }
    for (const sp of this.species) this.setInstances(sp, lists.get(sp) ?? []);
    let total = 0;
    for (const sp of this.species) total += sp.count;
    console.log('vegetation', this.species.map((s) => `${s.name}:${s.count}`).join(' '), 'total', total);
    return total;
  }

  /**
   * Rocks (Poly Haven scans, loaded later): boulders along rocky coasts and cliff feet, embedded in steep ground,
   * round the pool and the falls, and mossy stones on the jungle floor.
   */
  addRocks(models: { geometry: THREE.BufferGeometry; material: THREE.Material; radius: number; big: boolean }[]) {
    const hf = this.hf;
    const r = new Rng(909);
    const noise = new Noise2(5);
    const small = models.filter((m) => !m.big), big = models.filter((m) => m.big);
    const spOf = new Map<{ geometry: THREE.BufferGeometry }, Species>();
    for (const [i, m] of models.entries()) {
      const g = m.geometry.clone();
      if (!g.getAttribute('wind')) g.setAttribute('wind', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 3), 3));
      if (!g.getAttribute('color')) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 3).fill(1), 3));
      const sp = this.addSpecies(`rock${i}`, [{ maxDist: m.big ? 520 : 260, parts: [{ geometry: g, part: 'rock', material: m.material }], shadow: true }], m.radius * 2);
      spOf.set(m, sp);
    }
    const lists = new Map<Species, number[]>();
    const push = (m: { geometry: THREE.BufferGeometry; radius: number }, x: number, z: number, scale: number, sink: number) => {
      const sp = spOf.get(m)!;
      let l = lists.get(sp);
      if (!l) lists.set(sp, (l = []));
      const y = hf.height(x, z) - sink * scale * m.radius;
      l.push(x, y, z, r.next() * 6.28, scale, r.next());
      if (scale * m.radius > 0.6) this.colliders.circle(x, z, scale * m.radius * 0.8, y - 2, y + scale * m.radius * 1.6);
    };
    const S = 3.2;
    for (let z = -720; z < 720; z += S) for (let x = -960; x < 960; x += S) {
      const px = x + r.range(-0.5, 0.5) * S, pz = z + r.range(-0.5, 0.5) * S;
      const s = hf.shoreDist(px, pz);
      const h = hf.height(px, pz);
      const rock = hf.rock(px, pz);
      const n = hf.normal(px, pz, undefined, 2);
      const clump = noise.fbm(px / 30, pz / 30, 2) * 0.5 + 0.5;
      // rocky shore: kind is in mask1.a (0 beach .. 1 cliff)
      const coastRocky = s > -14 && s < 16 && rock > 0.3 && h < 6;
      // rocks rest on steep ground, not on sheer walls
      const steep = n.y > 0.32 && n.y < 0.72 && h > 2;
      const fallsDist = Math.hypot(px - hf.meta.falls.lip[0], pz - hf.meta.falls.lip[1]);
      const poolDist = Math.hypot(px - hf.meta.pool.p[0], pz - hf.meta.pool.p[1]);
      const nearFalls = (fallsDist < 22 || (poolDist > hf.meta.pool.r - 2 && poolDist < hf.meta.pool.r + 9)) && h > 30;
      let p = 0;
      if (coastRocky) p = 0.5 * clump;
      else if (steep) p = 0.16 * clump;
      else if (nearFalls) p = 0.45;
      else if (hf.forest(px, pz) > 0.5) p = 0.015;
      if (p <= 0 || r.next() > p) continue;
      const useBig = big.length && (steep || coastRocky) && r.next() < 0.22;
      const m = useBig ? r.pick(big) : r.pick(small.length ? small : big);
      const sc = useBig ? r.range(0.35, 1.0) : coastRocky ? r.range(0.9, 3.2) : steep ? r.range(1.2, 3.8) : nearFalls ? r.range(0.6, 2.2) : r.range(0.4, 1.1);
      push(m, px, pz, sc, useBig ? 0.35 : 0.28);
    }
    for (const sp of spOf.values()) this.setInstances(sp, lists.get(sp) ?? []);
    console.log('[island] rocks', [...spOf.values()].map((s) => s.count).join(' '));
    this.addCliffRocks(big.length ? big : small);
  }

  /**
   * Sea cliffs: big boulders (3-7.5 m) embedded in the steep faces of cliff coasts and heaped at their feet, so the
   * cliffs get real relief the heightmap cannot carry. A vertex-clustered low-poly copy draws them beyond 120 m.
   */
  private addCliffRocks(models: { geometry: THREE.BufferGeometry; material: THREE.Material; radius: number }[]) {
    const hf = this.hf;
    const r = new Rng(4711);
    const noise = new Noise2(17);
    const RMAX = 7.5;
    const withAttrs = (g: THREE.BufferGeometry) => {
      const n = g.getAttribute('position').count;
      if (!g.getAttribute('wind')) g.setAttribute('wind', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      if (!g.getAttribute('color')) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
      return g;
    };
    const sps = models.map((m, i) => ({
      m,
      sp: this.addSpecies(`cliffrock${i}`, [
        { maxDist: 120, parts: [{ geometry: withAttrs(m.geometry.clone()), part: 'rock', material: m.material }], shadow: true },
        { maxDist: 950, parts: [{ geometry: withAttrs(clusterSimplify(m.geometry, m.radius * 0.17)), part: 'rock', material: m.material }], shadow: true },
      ], m.radius * 2, RMAX * 2 + 2),
    }));
    const lists = new Map<Species, number[]>();
    const CS = 6;
    for (let z = -720; z < 720; z += CS) for (let x = -960; x < 960; x += CS) {
      const px = x + r.range(-0.5, 0.5) * CS, pz = z + r.range(-0.5, 0.5) * CS;
      const kind = hf.coastKind(px, pz);
      if (kind < 0.55) continue;
      const s = hf.shoreDist(px, pz);
      if (s < -10 || s > 70) continue;
      const h = hf.height(px, pz);
      const n = hf.normal(px, pz, undefined, 2);
      // rocks rest on steep slopes and heap up at the foot; a sheer wall holds none
      const face = n.y > 0.32 && n.y < 0.72 && h > 2;
      const foot = !face && s > -10 && s < 6 && h < 2.5 && h > -6;
      if (!face && !foot) continue;
      const clump = noise.fbm(px / 25, pz / 25, 2) * 0.5 + 0.5;
      if (r.next() > (face ? 0.5 * clump + 0.1 : 0.45 + 0.4 * clump) * THREE.MathUtils.smoothstep(kind, 0.55, 0.8)) continue;
      const pick = r.pick(sps);
      const R = face ? r.range(3.0, RMAX) : r.range(2.2, 6.5);
      const sc = R / pick.m.radius;
      // foot boulders stand on the sea bed and break the surface
      const y = face ? h - 0.55 * R : Math.max(h, -R * 0.9) - 0.3 * R;
      let l = lists.get(pick.sp);
      if (!l) lists.set(pick.sp, (l = []));
      l.push(px, y, pz, r.next() * 6.28, sc, r.next());
      if (foot) this.colliders.circle(px, pz, R * 0.8, y - 2, y + R * 1.6);
    }
    for (const { sp } of sps) this.setInstances(sp, lists.get(sp) ?? []);
    console.log('[island] cliff rocks', sps.map((s) => s.sp.count).join(' '));
  }

  /** palm trunk colliders etc. are added at scatter time; this returns counts for the harness */
  counts() {
    return Object.fromEntries(this.species.map((s) => [s.name, s.count]));
  }

  update(camera: THREE.PerspectiveCamera, shadowNear: number, force = false) {
    this.frame++;
    const cam = camera.position;
    const dir = this.tmpP;
    camera.getWorldDirection(dir);
    const moved = cam.distanceTo(this.lastCam) > 0.8 || dir.angleTo(this.lastDir) > 0.035;
    if (!force && !moved && this.frame % 20 !== 0) return;
    this.lastCam.copy(cam);
    this.lastDir.copy(dir);
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv, THREE.WebGPUCoordinateSystem);
    let vis = 0;
    const counts: number[] = [];
    const cx = cam.x, cy = cam.y, cz = cam.z;
    for (const sp of this.species) {
      const nL = sp.lods.length;
      const maxD = sp.lods[nL - 1].maxDist;
      const maxD2 = maxD * maxD;
      counts.length = nL;
      counts.fill(0);
      const caps = sp.meshes.map((row) => row[0].data.count);
      const mats = sp.meshes.map((row) => row[0].mesh.instanceMatrix.array as Float32Array);
      const datas = sp.meshes.map((row) => row[0].data.array as Float32Array);
      const lim2 = sp.lods.map((l) => l.maxDist * l.maxDist);
      const small = sp.radius < 1.5;
      const ci0 = Math.floor((cx - maxD + HALF_WORLD) / CELL), ci1 = Math.floor((cx + maxD + HALF_WORLD) / CELL);
      const cj0 = Math.floor((cz - maxD + HALF_WORLD) / CELL), cj1 = Math.floor((cz + maxD + HALF_WORLD) / CELL);
      for (let ci = Math.max(0, ci0); ci <= Math.min(63, ci1); ci++) for (let cj = Math.max(0, cj0); cj <= Math.min(63, cj1); cj++) {
        const cell = sp.cells.get((ci << 8) | cj);
        if (!cell) continue;
        const x0 = ci * CELL - HALF_WORLD, z0 = cj * CELL - HALF_WORLD;
        const dx = Math.max(x0 - cx, 0, cx - (x0 + CELL)), dz = Math.max(z0 - cz, 0, cz - (z0 + CELL));
        const cd = Math.hypot(dx, dz);
        if (cd > maxD) continue;
        const nearCell = cd < shadowNear;
        if (!nearCell) {
          this.box.min.set(x0 - sp.pad, -10, z0 - sp.pad);
          this.box.max.set(x0 + CELL + sp.pad, 260, z0 + CELL + sp.pad);
          if (!this.frustum.intersectsBox(this.box)) continue;
        }
        const inst = sp.inst;
        for (let n = 0; n < cell.length; n++) {
          const o = cell[n] * 6;
          const x = inst[o], y = inst[o + 1], z = inst[o + 2];
          const ddx = x - cx, ddy = y - cy, ddz = z - cz;
          const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
          if (d2 > maxD2) continue;
          let l = 0;
          while (l < nL - 1 && d2 > lim2[l]) l++;
          if (!small && (!nearCell || l > 0)) {
            this.sphere.center.set(x, y + sp.radius * 0.5 * inst[o + 4], z);
            this.sphere.radius = sp.radius * inst[o + 4] * 0.9 + 2;
            if (!this.frustum.intersectsSphere(this.sphere)) continue;
          }
          const k = counts[l];
          if (k >= caps[l]) continue;
          counts[l] = k + 1;
          const s = inst[o + 4], yaw = inst[o + 3];
          const c = Math.cos(yaw) * s, sn = Math.sin(yaw) * s;
          const m = mats[l], b = k * 16;
          m[b] = c; m[b + 1] = 0; m[b + 2] = -sn; m[b + 3] = 0;
          m[b + 4] = 0; m[b + 5] = s; m[b + 6] = 0; m[b + 7] = 0;
          m[b + 8] = sn; m[b + 9] = 0; m[b + 10] = c; m[b + 11] = 0;
          m[b + 12] = x; m[b + 13] = y; m[b + 14] = z; m[b + 15] = 1;
          const da = datas[l], q = k * 4;
          da[q] = yaw;
          da[q + 1] = inst[o + 5];
          da[q + 2] = s;
          da[q + 3] = d2;
        }
      }
      for (let l = 0; l < nL; l++) {
        const row = sp.meshes[l];
        if (!row.length) continue;
        const im = row[0].mesh.instanceMatrix;
        im.needsUpdate = true;
        im.clearUpdateRanges();
        im.addUpdateRange(0, counts[l] * 16);
        row[0].data.needsUpdate = true;
        row[0].data.clearUpdateRanges();
        row[0].data.addUpdateRange(0, counts[l] * 4);
        for (const e of row) {
          e.mesh.count = counts[l];
          e.mesh.visible = counts[l] > 0;
        }
        vis += counts[l];
      }
    }
    this.visible = vis;
  }
}

function name_isBush(n: string) {
  return n.startsWith('bush');
}

/** a crude low-poly copy for distant draws: vertices merged on a `cell`-metre grid, collapsed triangles dropped */
function clusterSimplify(src: THREE.BufferGeometry, cell: number) {
  const pos = src.getAttribute('position'), uvA = src.getAttribute('uv');
  const ids = new Map<string, number>();
  const sum: number[] = [], cnt: number[] = [], uvs: number[] = [];
  const remap = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = cnt.length;
      ids.set(key, id);
      cnt.push(0);
      sum.push(0, 0, 0);
      uvs.push(uvA ? uvA.getX(i) : 0, uvA ? uvA.getY(i) : 0);
    }
    sum[id * 3] += x;
    sum[id * 3 + 1] += y;
    sum[id * 3 + 2] += z;
    cnt[id]++;
    remap[i] = id;
  }
  const P = new Float32Array(cnt.length * 3);
  for (let k = 0; k < cnt.length; k++) for (let c = 0; c < 3; c++) P[k * 3 + c] = sum[k * 3 + c] / cnt[k];
  const tris: number[] = [];
  const index = src.index;
  const nT = index ? index.count : pos.count;
  for (let t = 0; t + 2 < nT; t += 3) {
    const a = remap[index ? index.getX(t) : t], b = remap[index ? index.getX(t + 1) : t + 1], c = remap[index ? index.getX(t + 2) : t + 2];
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  g.setIndex(tris);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
