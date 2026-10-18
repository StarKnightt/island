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
import { HALF_WORLD, VILLAGE } from '../world/layout';
import { sunLit } from '../core/lighting';
import { grassClump, type PartGeo } from './geometry';
import { wetness } from '../world/weatherUniforms';
import { loadKTX2, configureTex } from '../core/Assets';
import { atmo } from '../sky/Atmosphere';
import { cloudShadow } from '../sky/Sky';
import { Q } from '../core/quality';
import type { Colliders } from '../world/Colliders';
import { glbU, loadVariants, plantMaterial, crownProxy, crownMaterial, type GlbVariant, type PlantLook } from './glb';

const CELL = 32;

export const vegU = glbU;
void uniform;

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
  /** lie on the slope (flat ground covers such as leaf litter) instead of standing upright */
  tilt?: boolean;
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
    const m = sunLit(new THREE.MeshStandardNodeMaterial());
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
    m.colorNode = vec4(col.mul(ao.mul(0.85).add(0.15)), alpha);
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
  private tmpUp = new THREE.Vector3();
  private tmpAx = new THREE.Vector3();
  private tmpAz = new THREE.Vector3();
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
      grass: ['assets/foliage/grass.ktx2', true],
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
        // every instanced mesh sits at the origin, so the renderer cannot sort them near to far: near LODs first, so
        // the far ones are mostly rejected by the depth test before they shade
        mesh.renderOrder = l - 4;
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

  /** the grass clumps (procedural); the plants come from the helpers' GLBs in buildGlb() */
  build() {
    const hf = this.hf;
    const D = Q.density;
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
    // grass clumps (dense, only drawn near the camera)
    const GS = 0.9 / Math.sqrt(D);
    for (let z = -700; z < 700; z += GS) for (let x = -950; x < 950; x += GS) {
      const px = x + r.range(-0.5, 0.5) * GS, pz = z + r.range(-0.5, 0.5) * GS;
      const g = hf.grass(px, pz), f = hf.forest(px, pz), sand = hf.sand(px, pz);
      // (under the forest the litter, ferns and herbs cover the floor: little grass there)
      const w = Math.max(g * (1 - f * 0.7), f * 0.12, sand > 0.3 && sand < 0.8 && hf.shoreDist(px, pz) > 40 ? 0.3 : 0);
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

  /** one species from a helper GLB variant: its LODs at these distances, shadows from the LODs flagged */
  private glbSpecies(v: GlbVariant, dists: number[], shadows: boolean[], look: PlantLook, opts: { maxScale?: number; tilt?: boolean } = {}) {
    const lods: Lod[] = [];
    for (let k = 0; k < dists.length && k < v.lods.length; k++) {
      lods.push({
        maxDist: dists[k],
        shadow: shadows[k] ?? false,
        parts: v.lods[k].map((p) => ({ geometry: p.geometry, part: 'leaf' as const, material: p.override ?? this.matFor(p.src, look) })),
      });
    }
    const reach = Math.max(v.height, v.radius) * (opts.maxScale ?? 1.25);
    const sp = this.addSpecies(v.name, lods, Math.max(v.height, v.radius * 2), reach);
    sp.tilt = opts.tilt;
    return sp;
  }

  private glbMats = new Map<string, THREE.Material>();
  private matFor(src: THREE.MeshStandardMaterial, look: PlantLook) {
    const key = `${src.uuid}:${look.sway}:${look.height}`;
    let m = this.glbMats.get(key);
    if (!m) this.glbMats.set(key, (m = plantMaterial(src, look)));
    return m;
  }

  /**
   * The island's plants, from the helpers' GLBs, in layers: coconut palms leaning out over every beach with young
   * palms and sea-front scrub on the berm; rainforest on the forest mask (emergent dipterocarps and kapoks over a
   * closed canopy of strangler figs and leaning broadleaves, a midstorey between their trunks, tree ferns, bananas,
   * aroids, rattan and fan palms below, ferns and herbs on the ground, leaf litter, logs and surface roots).
   */
  async buildGlb() {
    const hf = this.hf;
    const D = Q.density;
    const K = Q.lodScale;
    const [coco, young, scrub, canopy, mid, under, floor] = await Promise.all([
      loadVariants('assets/veg/palms/coconut.glb', { palm_nut: 'palm_bark' }),
      loadVariants('assets/veg/palms/coconut_young.glb', { palm_nut: 'palm_bark' }),
      loadVariants('assets/veg/palms/scrub.glb'),
      loadVariants('assets/veg/jungle/canopy_trees.glb'),
      loadVariants('assets/veg/jungle/midstorey_trees.glb'),
      loadVariants('assets/veg/jungle/understory.glb'),
      loadVariants('assets/veg/jungle/floor.glb'),
    ]);
    const get = (m: Map<string, GlbVariant>, n: string) => {
      const v = m.get(n);
      if (!v) throw new Error(`vegetation: no ${n}`);
      return v;
    };
    const palmLook: PlantLook = { sway: 0.055, height: 16, translucent: 0.4 };
    const treeLook: PlantLook = { sway: 0.02, height: 28, translucent: 0.3 };
    const midLook: PlantLook = { sway: 0.03, height: 10, translucent: 0.25 };
    const lowLook: PlantLook = { sway: 0.06, height: 2.5, translucent: 0.18 };
    const groundLook: PlantLook = { sway: 0.06, height: 0.8, translucent: 0.15 };
    // every variant x LOD x material is a draw call in every pass it is in: few variants, shadows from lod0 only
    const palms = ['a', 'b', 'd', 'e', 'f'].map((k) => this.glbSpecies(get(coco, `coconut_${k}`), [60 * K, 210 * K, 1500], [true, false, false], palmLook));
    const youngs = ['a', 'b', 'c'].map((k) => this.glbSpecies(get(young, `coconut_young_${k}`), [40 * K, 110 * K], [true, false], { ...palmLook, height: 4 }));
    // (the scrub's stems only show close up: its distant LODs keep the leaves)
    const scrubVar = ['a', 'b', 'd'].map((k) => get(scrub, `scrub_${k}`));
    for (const v of scrubVar) for (let k = 1; k < v.lods.length; k++) v.lods[k] = v.lods[k].filter((p) => p.mat !== 'scrub_wood');
    const scrubs = scrubVar.map((v) => this.glbSpecies(v, [40 * K, 130 * K, 420], [true, false, false], lowLook));
    // far canopy trees: the crown as lumpy opaque ellipsoids over the lod2 bark (see crownProxy)
    const greens: Record<string, [number, number, number]> = { a: [0.04, 0.066, 0.018], b: [0.028, 0.05, 0.014], c: [0.045, 0.072, 0.02], d: [0.034, 0.058, 0.016] };
    const trees = ['a', 'b', 'c', 'd'].map((k) => {
      const v = get(canopy, `rainforest_${k}`);
      const bark = v.lods[2].filter((p) => p.mat === 'canopy_bark');
      v.lods[3] = [...bark, { geometry: crownProxy(v, 'canopy_leaf', 12), mat: 'crown_proxy', src: bark[0].src, override: crownMaterial(greens[k], treeLook) }];
      return this.glbSpecies(v, [50 * K, 150 * K, 270 * K, 1500], [true, false, false, false], treeLook);
    });
    const mids = ['a', 'b'].map((k) => this.glbSpecies(get(mid, `midstorey_${k}`), [30 * K, 90 * K, 190 * K], [true, false, false], midLook));
    const unders = ['banana_a', 'alocasia_a', 'treefern_a', 'rattan_a', 'licuala_a']
      .map((k) => this.glbSpecies(get(under, k), [26 * K, 70 * K], [false, false], lowLook));
    // the scanned herbs' full meshes are 4500 triangles: their second LOD is plenty on the forest floor
    for (const k of ['anthurium_a']) { const v = get(under, k); v.lods = [v.lods[1]]; }
    const grounds = ['fern_a', 'fern_b', 'anthurium_a'].map((k) => this.glbSpecies(get(under, k), [30 * K], [false], groundLook));
    const litter = ['litter_a', 'litter_b', 'litter_c'].map((k) => this.glbSpecies(get(floor, k), [44 * K], [false], groundLook, { tilt: true }));
    const logs = ['log_a', 'log_b', 'roots_a'].map((k) => this.glbSpecies(get(floor, k), [35 * K, 90 * K], [true, false], groundLook, { tilt: true }));

    const noise = new Noise2(31);
    const r = new Rng(2024);
    const lists = new Map<Species, number[]>();
    const push = (sp: Species, x: number, z: number, yaw: number, scale: number, sink = 0) => {
      let l = lists.get(sp);
      if (!l) lists.set(sp, (l = []));
      l.push(x, hf.height(x, z) - sink, z, yaw, scale, r.next());
    };
    // trunks claim their ground so the next layer does not grow through them
    const taken = new Map<number, [number, number, number][]>();
    const tkey = (x: number, z: number) => (Math.floor(x / 8) + 512) * 4096 + Math.floor(z / 8) + 512;
    const free = (x: number, z: number, rad: number) => {
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const [tx, tz, tr] of taken.get(tkey(x + i * 8, z + j * 8)) ?? []) if (Math.hypot(tx - x, tz - z) < tr + rad) return false;
      }
      return true;
    };
    const claim = (x: number, z: number, rad: number) => {
      const k = tkey(x, z);
      (taken.get(k) ?? taken.set(k, []).get(k)!).push([x, z, rad]);
    };
    const pool = hf.meta.pool, falls = hf.meta.falls;
    const clearing = (x: number, z: number, extra = 0) => Math.hypot(x - pool.p[0], z - pool.p[1]) < pool.r + 14 + extra || Math.hypot(x - falls.lip[0], z - falls.lip[1]) < 16 + extra;
    const toSea = (x: number, z: number) => {
      const gx = hf.shoreDist(x + 4, z) - hf.shoreDist(x - 4, z), gz = hf.shoreDist(x, z + 4) - hf.shoreDist(x, z - 4);
      return Math.atan2(-gz, -gx);
    };

    // ---- the beach front: palms in loose groves 8-120 m inland (short leaners near the sea, tall straight ones
    // behind), young palms and fallen nuts sprouting among them, scrub mounds on the berm
    const STEP = 4.2 / Math.sqrt(D);
    for (let z = -700; z < 700; z += STEP) for (let x = -950; x < 950; x += STEP) {
      const px = x + r.range(-0.5, 0.5) * STEP, pz = z + r.range(-0.5, 0.5) * STEP;
      const s = hf.shoreDist(px, pz);
      if (s < 6 || s > 150) continue;
      const h = hf.height(px, pz);
      if (h < 1.2 || h > 70) continue;
      const sand = hf.sand(px, pz), forest = hf.forest(px, pz), rock = hf.rock(px, pz);
      if (rock > 0.4 || hf.water(px, pz) > 0.2) continue;
      if (hf.normal(px, pz).y < 0.8) continue;
      const band = THREE.MathUtils.smoothstep(s, 7, 20) * (1 - THREE.MathUtils.smoothstep(s, 60, 140));
      const edge = Math.max(sand * 0.95, 0.35) * (1 - forest * 0.5);
      const grove = THREE.MathUtils.smoothstep(noise.fbm(px / 55, pz / 55, 3), -0.35, 0.35);
      // the village keeps its ground open between the huts: a few shade palms, the groves round it
      const vk = THREE.MathUtils.smoothstep(Math.hypot(px - VILLAGE.center[0], pz - VILLAGE.center[1]), 50, 110);
      const p = band * edge * (0.25 + 0.75 * grove) * 0.42 * (0.12 + 0.88 * vk);
      if (r.next() > p || !free(px, pz, 1.2)) continue;
      // near the sea the short leaners (a, b), behind them the tall ones (d, e, f)
      const inland = THREE.MathUtils.smoothstep(s, 15, 70);
      const pick = r.next() < 0.6 - inland * 0.45 ? r.pick([palms[0], palms[0], palms[1]]) : r.pick([palms[2], palms[3], palms[4], palms[1]]);
      const yaw = -toSea(px, pz) + r.range(-0.65, 0.65);
      const sc = r.range(0.85, 1.12);
      push(pick, px, pz, yaw, sc, 0.05);
      claim(px, pz, 1.0);
      this.colliders.circle(px, pz, 0.36 * sc, h - 1, h + 7);
      if (r.next() < 0.3) {
        const a = r.next() * 6.28, d = r.range(2.5, 6);
        const yx = px + Math.cos(a) * d, yz = pz + Math.sin(a) * d;
        if (free(yx, yz, 0.6)) push(r.pick(youngs), yx, yz, r.next() * 6.28, r.range(0.8, 1.25), 0.05);
      }
    }
    // scrub on the berm and the dune crest: clumps of two or three mounds, wind-pruned toward the sea
    const SS = 3.4 / Math.sqrt(D);
    for (let z = -700; z < 700; z += SS) for (let x = -950; x < 950; x += SS) {
      const px = x + r.range(-0.5, 0.5) * SS, pz = z + r.range(-0.5, 0.5) * SS;
      const s = hf.shoreDist(px, pz);
      if (s < 9 || s > 45) continue;
      const h = hf.height(px, pz);
      if (h < 1.0 || hf.rock(px, pz) > 0.5 || hf.water(px, pz) > 0.1 || hf.dirt(px, pz) > 0.5) continue;
      const kind = hf.coastKind(px, pz);
      const berm = THREE.MathUtils.smoothstep(s, 9, 16) * (1 - THREE.MathUtils.smoothstep(s, 30, 45));
      const patch = THREE.MathUtils.smoothstep(noise.fbm(px / 22 + 7, pz / 22, 2), -0.1, 0.4);
      if (r.next() > berm * patch * (kind < 0.4 ? 0.5 : 0.3) || !free(px, pz, 1.5)) continue;
      // scrub_d is pruned low on its +x side: face that to the sea
      const sp = r.pick(scrubs);
      push(sp, px, pz, sp === scrubs[2] ? -toSea(px, pz) : r.next() * 6.28, r.range(0.75, 1.25), 0.15);
    }

    // ---- the rainforest: canopy trees on a jittered grid (emergents rarer), each claiming its trunk's ground
    const TS = 11 / Math.sqrt(D);
    for (let z = -700; z < 700; z += TS) for (let x = -950; x < 950; x += TS) {
      const px = x + r.range(-0.45, 0.45) * TS, pz = z + r.range(-0.45, 0.45) * TS;
      const f = hf.forest(px, pz);
      if (f < 0.35 || r.next() > f * 1.15 || clearing(px, pz, 6)) continue;
      if (hf.normal(px, pz).y < 0.72) continue;
      const h = hf.height(px, pz);
      if (h < 2.5) continue;
      if (r.next() < 0.08) {
        // a palm among the broadleaves
        push(r.pick([palms[2], palms[3], palms[4]]), px, pz, r.next() * 6.28, r.range(0.95, 1.25), 0.05);
        claim(px, pz, 1.0);
        continue;
      }
      // emergents (a dipterocarp, c kapok) stand out of the canopy; high on the mountain the trees are shorter
      const k = r.next();
      const sp = k < 0.14 ? trees[0] : k < 0.28 ? trees[2] : k < 0.58 ? trees[1] : trees[3];
      const alt = 1 - THREE.MathUtils.smoothstep(h, 110, 175) * 0.45;
      const sc = r.range(0.8, 1.12) * alt;
      push(sp, px, pz, r.next() * 6.28, sc, 0.3);
      claim(px, pz, (sp === trees[0] || sp === trees[2] ? 3.6 : 2.0) * sc);
      this.colliders.circle(px, pz, (sp === trees[0] || sp === trees[2] ? 0.75 : 0.5) * sc, h - 1, h + 10);
    }
    // midstorey between the trunks
    const MS = 8.5 / Math.sqrt(D);
    for (let z = -700; z < 700; z += MS) for (let x = -950; x < 950; x += MS) {
      const px = x + r.range(-0.5, 0.5) * MS, pz = z + r.range(-0.5, 0.5) * MS;
      const f = hf.forest(px, pz);
      if (f < 0.3 || r.next() > f * 0.6 || clearing(px, pz, 2)) continue;
      if (hf.normal(px, pz).y < 0.7 || hf.height(px, pz) < 2 || !free(px, pz, 1.5)) continue;
      const sc = r.range(0.75, 1.15);
      push(r.pick(mids), px, pz, r.next() * 6.28, sc, 0.2);
      claim(px, pz, 0.8);
      this.colliders.circle(px, pz, 0.28 * sc, hf.height(px, pz) - 1, hf.height(px, pz) + 6);
    }
    // understory: tree ferns and fan palms in the shade, bananas and aroids in gaps and along the edges
    const US = 3.4 / Math.sqrt(D);
    for (let z = -700; z < 700; z += US) for (let x = -950; x < 950; x += US) {
      const px = x + r.range(-0.5, 0.5) * US, pz = z + r.range(-0.5, 0.5) * US;
      const f = hf.forest(px, pz), g = hf.grass(px, pz);
      if ((f < 0.22 && g < 0.45) || clearing(px, pz, -8)) continue;
      if (hf.normal(px, pz).y < 0.68 || hf.dirt(px, pz) > 0.45 || hf.water(px, pz) > 0.1 || hf.height(px, pz) < 1.5) continue;
      const edge = 1 - THREE.MathUtils.smoothstep(f, 0.35, 0.8);
      const k = r.next();
      if (k > 0.82 * Math.max(f, g * 0.5) || !free(px, pz, 0.5)) continue;
      // bananas and aroids in the gaps and at the edges, tree ferns, rattan and fan palms in the shade
      const q = r.next();
      const sp = q < 0.16 + edge * 0.14 ? unders[0] : q < 0.36 + edge * 0.08 ? unders[1] : q < 0.62 ? unders[2] : q < 0.78 ? unders[3] : unders[4];
      push(sp, px, pz, r.next() * 6.28, r.range(0.75, 1.3), 0.08);
    }
    // ground: ferns and herbs, and the leaf litter that covers the forest floor
    const GS = 1.8 / Math.sqrt(D);
    for (let z = -700; z < 700; z += GS) for (let x = -950; x < 950; x += GS) {
      const px = x + r.range(-0.5, 0.5) * GS, pz = z + r.range(-0.5, 0.5) * GS;
      const f = hf.forest(px, pz);
      if (f < 0.3 || clearing(px, pz, -10) || hf.water(px, pz) > 0.05 || hf.height(px, pz) < 1.5) continue;
      if (hf.normal(px, pz).y < 0.66) continue;
      const k = r.next();
      if (k < 0.32 * f) push(r.pick(grounds), px, pz, r.next() * 6.28, r.range(0.7, 1.35), 0.03);
    }
    const LS = 2.9 / Math.sqrt(D);
    for (let z = -700; z < 700; z += LS) for (let x = -950; x < 950; x += LS) {
      const px = x + r.range(-0.4, 0.4) * LS, pz = z + r.range(-0.4, 0.4) * LS;
      const f = hf.forest(px, pz);
      if (f < 0.3 || hf.water(px, pz) > 0.05 || hf.dirt(px, pz) > 0.6 || hf.height(px, pz) < 1.5) continue;
      if (hf.normal(px, pz).y < 0.8 || r.next() > f * 0.85) continue;
      push(r.pick(litter), px, pz, r.next() * 6.28, r.range(0.85, 1.2), 0.02);
      if (r.next() < 0.02 && free(px, pz, 2)) push(r.pick(logs), px, pz, r.next() * 6.28, r.range(0.8, 1.2), 0.1);
    }
    let total = 0;
    for (const sp of [...palms, ...youngs, ...scrubs, ...trees, ...mids, ...unders, ...grounds, ...litter, ...logs]) {
      this.setInstances(sp, lists.get(sp) ?? []);
      total += sp.count;
    }
    console.log('vegetation (glb)', [...lists.entries()].map(([s, l]) => `${s.name}:${l.length / 6}`).join(' '), 'total', total);
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
      const g1 = clusterSimplify(g, m.radius * 0.14);
      for (const k of ['wind', 'color']) g1.setAttribute(k, new THREE.BufferAttribute(new Float32Array(g1.getAttribute('position').count * 3).fill(k === 'color' ? 1 : 0), 3));
      // (only the big boulders cast shadows; the small stones are grounded by the AO)
      const sp = this.addSpecies(`rock${i}`, [
        { maxDist: 50, parts: [{ geometry: g, part: 'rock', material: m.material }], shadow: m.big },
        { maxDist: m.big ? 520 : 260, parts: [{ geometry: g1, part: 'rock', material: m.material }], shadow: false },
      ], m.radius * 2, m.radius * 2 * 3.8);
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
      // rocky shore: kind is in mask1.a (0 beach .. 1 cliff); the sea cliffs have the rock kit's own blocks
      const coastRocky = s > -14 && s < 16 && rock > 0.3 && h < 6 && hf.coastKind(px, pz) < 0.8;
      // rocks rest on steep ground, not on sheer walls (nor on the gorge walls round the falls, which are the kit's)
      const steep = n.y > 0.32 && n.y < 0.72 && h > 2 && Math.hypot(px - hf.meta.falls.lip[0], pz - hf.meta.falls.lip[1]) > 34;
      const poolDist = Math.hypot(px - hf.meta.pool.p[0], pz - hf.meta.pool.p[1]);
      // boulders ring the pool's banks (not in its water, not where the waterfall shot's camera stands)
      const nearFalls = poolDist > hf.meta.pool.r + 0.5 && poolDist < hf.meta.pool.r + 8 && h > 30 && Math.hypot(px - 186, pz + 42) > 9;
      let p = 0;
      // (the waterfall shot's camera stands on the east bank)
      if (Math.hypot(px - 186, pz + 42) < 9) continue;
      if (coastRocky) p = 0.5 * clump;
      else if (steep) p = 0.16 * clump;
      else if (nearFalls) p = 0.45;
      else if (hf.forest(px, pz) > 0.5) p = 0.015;
      if (p <= 0 || r.next() > p) continue;
      const useBig = big.length && (steep || coastRocky) && r.next() < 0.22;
      const m = useBig ? r.pick(big) : r.pick(small.length ? small : big);
      const sc = useBig ? r.range(0.35, 1.0) : coastRocky ? r.range(0.9, 3.2) : steep ? r.range(1.2, 3.8) : nearFalls ? r.range(0.5, 1.6) : r.range(0.4, 1.1);
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
        { maxDist: 80, parts: [{ geometry: withAttrs(m.geometry.clone()), part: 'rock', material: m.material }], shadow: true },
        { maxDist: 950, parts: [{ geometry: withAttrs(clusterSimplify(m.geometry, m.radius * 0.17)), part: 'rock', material: m.material }], shadow: true },
      ], m.radius * 2, RMAX * 2 + 2),
    }));
    const lists = new Map<Species, number[]>();
    const CS = 6;
    for (let z = -720; z < 720; z += CS) for (let x = -960; x < 960; x += CS) {
      const px = x + r.range(-0.5, 0.5) * CS, pz = z + r.range(-0.5, 0.5) * CS;
      const kind = hf.coastKind(px, pz);
      // the sea cliffs have the rock kit's faces and fallen blocks (RockKit); these heap on the rock shelves
      if (kind < 0.55 || kind > 0.8) continue;
      const s = hf.shoreDist(px, pz);
      if (s < -10 || s > 70) continue;
      const h = hf.height(px, pz);
      const n = hf.normal(px, pz, undefined, 2);
      // rocks rest on gentle rock slopes and heap up at the foot; never stuck to a steep face
      const face = n.y > 0.6 && n.y < 0.8 && h > 2 && h < 14;
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

  /**
   * Plants on the rock: sword ferns over moss lumps, dripping-wall mats and vine curtains hanging on the gorge walls
   * round the falls, moss cushions on its ledges, long curtains down the upper sea cliffs (points from RockKit).
   */
  async addLedges(points: { x: number; y: number; z: number; yaw: number; s: number; kind: string }[]) {
    const ledge = await loadVariants('assets/veg/jungle/ledge.glb');
    const K = Q.lodScale;
    const look: PlantLook = { sway: 0.07, height: 3, translucent: 0.25 };
    const sps = new Map<string, Species>();
    for (const [name, v] of ledge) {
      // the long curtains hang on the sea cliffs too: seen from far out at sea
      const far = name.startsWith('vinecurtain') ? 700 : 140 * K;
      sps.set(name, this.glbSpecies(v, [36 * K, far], [true, false], look, { maxScale: 3.6 }));
    }
    const r = new Rng(77);
    const lists = new Map<Species, number[]>();
    for (const p of points) {
      const sp = sps.get(p.kind);
      if (!sp) continue;
      let l = lists.get(sp);
      if (!l) lists.set(sp, (l = []));
      l.push(p.x, p.y, p.z, p.yaw, p.s, r.next());
    }
    for (const [sp, l] of lists) this.setInstances(sp, l);
    console.log('[island] ledge plants', [...lists.entries()].map(([sp, l]) => `${sp.name}:${l.length / 6}`).join(' '));
  }

  /** palm trunk colliders etc. are added at scatter time; this returns counts for the harness */
  counts() {
    return Object.fromEntries(this.species.map((s) => [s.name, s.count]));
  }

  update(camera: THREE.PerspectiveCamera, shadowNear: number, force = false) {
    this.frame++;
    const priming = this.prime > 0;
    if (priming) this.prime--;
    const cam = camera.position;
    const dir = this.tmpP;
    camera.getWorldDirection(dir);
    // culled against a frustum 6 degrees wider than the view, so the camera can turn ~3 degrees (or walk 1.2 m)
    // before the lists need rebuilding: fewer instance-buffer uploads while the camera swings
    const moved = cam.distanceTo(this.lastCam) > 1.2 || dir.angleTo(this.lastDir) > 0.05;
    // the frame after priming re-culls so the collapsed instances go away
    if (!force && !priming && !moved && this.frame % 20 !== 0 && !this.unprime) return;
    this.unprime = priming;
    this.lastCam.copy(cam);
    this.lastDir.copy(dir);
    const cc = this.cullCam;
    const camX = camera as unknown as { coordinateSystem: number; _reversedDepth: boolean };
    const ccX = cc as unknown as { coordinateSystem: number; _reversedDepth: boolean };
    if (cc.fov !== camera.fov + 6 || cc.aspect !== camera.aspect || cc.far !== camera.far || ccX.coordinateSystem !== camX.coordinateSystem) {
      cc.fov = camera.fov + 6;
      cc.aspect = camera.aspect;
      cc.near = camera.near;
      cc.far = camera.far;
      ccX.coordinateSystem = camX.coordinateSystem;
      ccX._reversedDepth = camX._reversedDepth;
      cc.updateProjectionMatrix();
    }
    this.pv.multiplyMatrices(cc.projectionMatrix, camera.matrixWorldInverse);
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
          if (sp.tilt) {
            // the yawed frame tilted onto the ground's slope: y along the terrain normal
            const nrm = this.hf.normal(x, z);
            const up = this.tmpUp.set(nrm.x, nrm.y, nrm.z);
            const ax = this.tmpAx.set(Math.cos(yaw), 0, -Math.sin(yaw));
            const az = this.tmpAz.crossVectors(ax, up).normalize();
            ax.crossVectors(up, az);
            m[b] = ax.x * s; m[b + 1] = ax.y * s; m[b + 2] = ax.z * s; m[b + 3] = 0;
            m[b + 4] = up.x * s; m[b + 5] = up.y * s; m[b + 6] = up.z * s; m[b + 7] = 0;
            m[b + 8] = az.x * s; m[b + 9] = az.y * s; m[b + 10] = az.z * s; m[b + 11] = 0;
          } else {
            m[b] = c; m[b + 1] = 0; m[b + 2] = -sn; m[b + 3] = 0;
            m[b + 4] = 0; m[b + 5] = s; m[b + 6] = 0; m[b + 7] = 0;
            m[b + 8] = sn; m[b + 9] = 0; m[b + 10] = c; m[b + 11] = 0;
          }
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
        let n = counts[l];
        if (priming && n === 0 && sp.count > 0) {
          // one collapsed instance, so this mesh's pipelines compile now (behind the loading screen) and not with a
          // hitch the first time the species or LOD comes into view
          mats[l].fill(0, 0, 16);
          n = 1;
        }
        const im = row[0].mesh.instanceMatrix;
        im.needsUpdate = true;
        im.clearUpdateRanges();
        im.addUpdateRange(0, n * 16);
        row[0].data.needsUpdate = true;
        row[0].data.clearUpdateRanges();
        row[0].data.addUpdateRange(0, n * 4);
        for (const e of row) {
          e.mesh.count = n;
          e.mesh.visible = n > 0;
        }
        vis += counts[l];
      }
    }
    this.visible = vis;
  }

  /** frames left in which every mesh is drawn (collapsed if empty) so all pipelines compile up front */
  prime = 0;
  private unprime = false;
  private cullCam = new THREE.PerspectiveCamera();
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
