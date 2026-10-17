/**
 * Plants and rocks made in Blender by the asset helpers (tools/blender/*): GLB files whose top-level nodes are
 * `<variant>_lod<k>`, each one mesh with a primitive per material. Positions arrive quantized (int16 with a decode
 * transform on the node), so every primitive is turned into float attributes and baked into metres.
 *
 * Plant vertex colours (COLOR_0) are data, not a tint: R baked AO, G bend weight for wind (0 at the root, rising
 * along trunk, branch and frond to 1 at the tips), B leaf flutter weight, A a phase per frond / branch / leaf
 * cluster so parts sway out of step.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  Fn, attribute, clamp, cos, dot, float, hash, mix, mx_noise_float, mx_noise_vec3, normalMap, normalize, normalWorld,
  normalWorldGeometry, positionLocal, positionViewDirection, positionWorld, pow, sin, texture, transformNormalToView, uv,
  vec2, vec3, vec4, type N,
} from '../core/tsl';
import { loadGLTF } from '../core/Assets';
import { wetness } from '../world/weatherUniforms';
import { atmo } from '../sky/Atmosphere';
import { cloudShadow } from '../sky/Sky';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { normalViewGeometry } = TSLTyped as any;

export interface GlbPart { geometry: THREE.BufferGeometry; mat: string; src: THREE.MeshStandardMaterial; override?: THREE.Material }
export interface GlbVariant {
  name: string;
  /** parts per LOD (index = k of `_lod<k>`) */
  lods: GlbPart[][];
  /** height and plan radius of lod0 (m) */
  height: number;
  radius: number;
}

/** float copy of a geometry (quantized, normalized or interleaved attributes would clamp to +-1 once transformed) */
export function toFloatGeometry(src: THREE.BufferGeometry) {
  const geo = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(src.attributes)) {
    const n = a.count, k = a.itemSize;
    const f = new Float32Array(n * k);
    const get = [a.getX, a.getY, a.getZ, a.getW];
    for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) f[i * k + c] = get[c].call(a, i);
    geo.setAttribute(name, new THREE.BufferAttribute(f, k));
  }
  if (src.index) geo.setIndex(src.index.clone());
  return geo;
}

/** merge parts that share a material (bark + nuts use the same atlas) into one geometry */
function mergeParts(parts: GlbPart[], into: Record<string, string>) {
  const groups = new Map<string, GlbPart[]>();
  for (const p of parts) {
    const key = into[p.mat] ?? p.mat;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
  }
  const out: GlbPart[] = [];
  for (const [key, list] of groups) {
    if (list.length === 1) {
      out.push({ ...list[0], mat: key });
      continue;
    }
    const names = Object.keys(list[0].geometry.attributes).filter((n) => list.every((p) => p.geometry.getAttribute(n)));
    const g = new THREE.BufferGeometry();
    for (const n of names) {
      const k = list[0].geometry.getAttribute(n).itemSize;
      const total = list.reduce((s, p) => s + p.geometry.getAttribute(n).count, 0);
      const f = new Float32Array(total * k);
      let o = 0;
      for (const p of list) {
        const a = p.geometry.getAttribute(n).array as Float32Array;
        f.set(a, o);
        o += a.length;
      }
      g.setAttribute(n, new THREE.BufferAttribute(f, k));
    }
    const idx: number[] = [];
    let base = 0;
    for (const p of list) {
      const pi = p.geometry.index!;
      for (let i = 0; i < pi.count; i++) idx.push(pi.getX(i) + base);
      base += p.geometry.getAttribute('position').count;
    }
    g.setIndex(idx);
    out.push({ geometry: g, mat: key, src: list.find((p) => p.mat === key)?.src ?? list[0].src });
  }
  return out;
}

/**
 * Load a helper GLB: variants with their LODs, geometry in metres (origin = where the plant meets the ground).
 * `merge` maps material names onto another material whose part they join (e.g. { palm_nut: 'palm_bark' }).
 */
export async function loadVariants(url: string, merge: Record<string, string> = {}): Promise<Map<string, GlbVariant>> {
  const gltf = await loadGLTF(url);
  gltf.scene.updateMatrixWorld(true);
  const out = new Map<string, GlbVariant>();
  for (const node of gltf.scene.children) {
    const m = /^(.*)_lod(\d)$/.exec(node.name);
    if (!m) continue;
    const [, name, k] = m;
    const parts: GlbPart[] = [];
    node.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const g = toFloatGeometry(mesh.geometry);
      g.applyMatrix4(mesh.matrixWorld);
      const src = mesh.material as THREE.MeshStandardMaterial;
      parts.push({ geometry: g, mat: src.name, src });
    });
    let v = out.get(name);
    if (!v) out.set(name, (v = { name, lods: [], height: 0, radius: 0 }));
    v.lods[Number(k)] = mergeParts(parts, merge);
  }
  for (const v of out.values()) {
    const box = new THREE.Box3();
    for (const p of v.lods[0] ?? []) {
      p.geometry.computeBoundingBox();
      box.union(p.geometry.boundingBox!);
    }
    v.height = box.max.y;
    v.radius = Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z);
    // missing LODs fall back to the next coarser one that exists
    for (let i = 0; i < v.lods.length; i++) if (!v.lods[i]) v.lods[i] = v.lods[i + 1] ?? v.lods[i - 1];
  }
  return out;
}

export const glbU = { time: TSLTyped.uniform(0), sunColor: TSLTyped.uniform(new THREE.Color(1, 1, 1)) };

export interface PlantLook {
  /** wind: how far the tips travel at full bend, as a share of the plant's height (palms bend more than trees) */
  sway: number;
  height: number;
  /** translucency of the leaves against the sun */
  translucent?: number;
  /** multiply the albedo (linear) */
  tint?: [number, number, number];
}

/** wind in the plant's own frame, from its COLOR_0 weights (see the header) and the per-instance yaw and phase */
function windFrom(look: PlantLook) {
  const col = attribute('color', 'vec4');
  const bend = col.y, flutter = col.z, part = col.w;
  const iData = attribute('iData', 'vec4');
  const yaw = iData.x, phase = iData.y;
  const t = glbU.time;
  const wd = wetness.windDir;
  const c = cos(yaw.negate()), s = sin(yaw.negate());
  const lw = vec2(wd.x.mul(c).add(wd.y.mul(s)), wd.x.mul(s).negate().add(wd.y.mul(c)));
  const strength = wetness.wind.mul(0.85).add(0.1);
  // a slow gust front crossing the island, the plant's own sway, and every part a little out of step
  const gust = sin(t.mul(0.33).add(phase.mul(6.28)).add(positionWorld.x.mul(0.012)).add(positionWorld.z.mul(0.007))).mul(0.5).add(0.5);
  const sway = sin(t.mul(0.9).add(phase.mul(12.0)).add(part.mul(2.2))).mul(0.45).add(gust.mul(0.85));
  const amt = bend.mul(bend).mul(strength).mul(sway).mul(look.height * look.sway);
  const fl = sin(t.mul(7.1).add(part.mul(37)).add(positionLocal.x.mul(2.3)).add(positionLocal.z.mul(1.9))).mul(flutter).mul(strength).mul(0.06);
  // the bent tip drops a little as it swings out
  return vec3(lw.x.mul(amt).add(fl.mul(0.35)), fl.mul(0.8).sub(amt.mul(bend).mul(0.18)), lw.y.mul(amt).add(fl.mul(0.35)));
}

/** a node material for a helper plant part: its textures, AO from COLOR_0, wind, wet darkening, backlit leaves */
export function plantMaterial(src: THREE.MeshStandardMaterial, look: PlantLook) {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = `glb_${src.name}`;
  const leaf = src.alphaTest > 0 || src.transparent || src.side === THREE.DoubleSide;
  const col = attribute('color', 'vec4');
  const ao = col.x;
  const base = src.map ? texture(src.map, uv()) : vec4(src.color.r, src.color.g, src.color.b, 1);
  // per-instance hue scatter so neighbours of one variant differ
  const iData = attribute('iData', 'vec4');
  const vary = hash(iData.y.mul(1000)).sub(0.5);
  let alb: N = base.rgb.mul(vec3(float(1).add(vary.mul(0.14)), float(1).add(vary.mul(0.07)), float(1).sub(vary.mul(0.1))));
  if (look.tint) alb = alb.mul(vec3(...look.tint));
  alb = alb.mul(mix(float(1), float(0.68), wetness.rain));
  m.colorNode = vec4(alb.mul(ao.mul(0.8).add(0.2)), base.a);
  const orm = src.roughnessMap ?? src.metalnessMap ?? src.aoMap;
  // leaves keep a floor: a mirror-smooth card per leaf glints like a lamp in the sun (wet leaves shine a little more)
  const rough0: N = (orm ? texture(orm, uv()).g.mul(src.roughness) : float(src.roughness)).max(leaf ? 0.58 : 0.3);
  m.roughnessNode = mix(rough0, rough0.min(leaf ? 0.4 : 0.5), wetness.rain);
  m.metalnessNode = float(0);
  if (orm && src.aoMap) m.aoNode = texture(orm, uv()).r;
  if (leaf) {
    m.alphaTest = 0.5;
    m.side = THREE.DoubleSide;
    // the leaf cards' normals are bent toward the outside of their clump: used as they are on both faces
    m.normalNode = normalViewGeometry;
  } else if (src.normalMap) {
    m.normalNode = normalMap(texture(src.normalMap, uv()));
  }
  if (leaf && look.translucent) {
    const sunDir = normalize(atmo.sunDir);
    const back = pow(clamp(dot(positionViewDirection.negate(), sunDir.negate()).negate(), 0, 1), 3);
    const facing = clamp(dot(normalWorld, sunDir).negate().add(0.6), 0, 1);
    m.emissiveNode = alb.mul(vec3(glbU.sunColor)).mul(back.mul(facing).mul(look.translucent * 0.07)).mul(cloudShadow(positionWorld)).mul(ao);
  }
  m.positionNode = Fn(() => positionLocal.add(windFrom(look)))();
  return m;
}

/**
 * A distant stand-in for a tree's crown: its lod2 leaf cards clustered (k-means) into lumpy ellipsoids, opaque, so
 * hundreds of far trees cost a few large triangles each instead of thousands of alpha-tested slivers (which also
 * overdraw behind the near trees). The bark of lod2 stays as it is.
 */
export function crownProxy(v: GlbVariant, leafMat: string, clusters = 12): THREE.BufferGeometry {
  const src = (v.lods[2] ?? v.lods[v.lods.length - 1]).find((p) => p.mat === leafMat);
  if (!src) throw new Error(`crownProxy: ${v.name} has no ${leafMat}`);
  const pos = src.geometry.getAttribute('position');
  const idx = src.geometry.index!;
  const pts: THREE.Vector3[] = [];
  for (let t = 0; t + 2 < idx.count; t += 3) {
    const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
    pts.push(new THREE.Vector3(
      (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3, (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3, (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3));
  }
  // k-means, seeded deterministically
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const K = Math.min(clusters, pts.length);
  const cen = Array.from({ length: K }, () => pts[Math.floor(rnd() * pts.length)].clone());
  const asg = new Int32Array(pts.length);
  for (let it = 0; it < 10; it++) {
    for (let i = 0; i < pts.length; i++) {
      let best = 0, bd = Infinity;
      for (let k = 0; k < K; k++) {
        const d = pts[i].distanceToSquared(cen[k]);
        if (d < bd) { bd = d; best = k; }
      }
      asg[i] = best;
    }
    const sum = cen.map(() => new THREE.Vector3()), n = new Int32Array(K);
    for (let i = 0; i < pts.length; i++) { sum[asg[i]].add(pts[i]); n[asg[i]]++; }
    for (let k = 0; k < K; k++) if (n[k]) cen[k].copy(sum[k].divideScalar(n[k]));
  }
  // each cluster an ellipsoid covering its cards (horizontal and vertical spread), lumped by noise
  const ico = mergeVertices(new THREE.IcosahedronGeometry(1, 1).deleteAttribute('normal').deleteAttribute('uv'));
  const P: number[] = [], Nn: number[] = [], C: number[] = [], U: number[] = [], I: number[] = [];
  const ip = ico.getAttribute('position'), ii = ico.index!;
  for (let k = 0; k < K; k++) {
    let sxz = 0, sy = 0, cnt = 0;
    for (let i = 0; i < pts.length; i++) if (asg[i] === k) {
      const d = pts[i].clone().sub(cen[k]);
      sxz += d.x * d.x + d.z * d.z;
      sy += d.y * d.y;
      cnt++;
    }
    if (!cnt) continue;
    const rxz = Math.sqrt(sxz / cnt / 2) * 1.7 + 0.4, ry = Math.sqrt(sy / cnt) * 1.6 + 0.4;
    const base = P.length / 3, phase = rnd();
    for (let i = 0; i < ip.count; i++) {
      const x = ip.getX(i), y = ip.getY(i), z = ip.getZ(i);
      const lump = 1 + 0.16 * Math.sin(x * 5.1 + k) * Math.sin(y * 4.3 + 2 * k) * Math.sin(z * 4.7 + 3);
      // flattened underneath, as crowns are
      const yy = y < 0 ? y * 0.55 : y;
      P.push(cen[k].x + x * rxz * lump, cen[k].y + yy * ry * lump, cen[k].z + z * rxz * lump);
      const nn = new THREE.Vector3(x / rxz, yy / ry, z / rxz).normalize();
      Nn.push(nn.x, nn.y, nn.z);
      // COLOR_0: AO darker underneath and toward the crown's core, a gentle bend, no flutter, a phase per lump
      C.push(0.35 + 0.65 * (0.5 + 0.5 * y), 0.32, 0, phase);
      U.push(0, 0);
    }
    for (let t = 0; t < ii.count; t++) I.push(ii.getX(t) + base);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(Nn, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 4));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setIndex(I);
  return g;
}

/** the crown stand-ins' material: a leafy green whose clumps come from world-space noise in colour and normal */
export function crownMaterial(green: [number, number, number], look: PlantLook) {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'glb_crown_proxy';
  const col = attribute('color', 'vec4');
  const p = positionWorld;
  const n1 = mx_noise_float(p.mul(0.55)), n2 = mx_noise_float(p.mul(1.7).add(3.1));
  const iData = attribute('iData', 'vec4');
  const vary = hash(iData.y.mul(1000)).sub(0.5);
  const alb = vec3(...green).mul(float(1).add(vary.mul(0.25))).mul(n1.mul(0.22).add(n2.mul(0.12)).add(1)).mul(mix(float(1), float(0.68), wetness.rain));
  m.colorNode = vec4(alb.mul(col.x), 1);
  // leaf clumps tilt the normal; the gaps between clumps read as shadow
  const bump = mx_noise_vec3(p.mul(1.1)).mul(0.55).add(mx_noise_vec3(p.mul(3.1)).mul(0.25));
  m.normalNode = transformNormalToView(normalize(normalWorldGeometry.add(bump)));
  m.roughnessNode = float(0.75);
  m.metalnessNode = float(0);
  m.positionNode = Fn(() => positionLocal.add(windFrom(look)))();
  return m;
}

/** a node material for a helper rock: its textures as they are */
export function rockMaterial(src: THREE.MeshStandardMaterial) {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = `glb_${src.name}`;
  m.colorNode = src.map ? texture(src.map, uv()).rgb.mul(mix(float(1), float(0.62), wetness.rain)) : vec3(src.color.r, src.color.g, src.color.b);
  const orm = src.roughnessMap ?? src.aoMap;
  m.roughnessNode = orm ? mix(texture(orm, uv()).g, float(0.35), wetness.rain) : float(0.9);
  if (orm) m.aoNode = texture(orm, uv()).r;
  if (src.normalMap) m.normalNode = normalMap(texture(src.normalMap, uv()));
  m.metalnessNode = float(0);
  return m;
}
