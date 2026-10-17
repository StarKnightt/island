/**
 * Building kit: a material library of Poly Haven scans (KTX2 pairs: albedo+height, normal+roughness+AO) and
 * geometry helpers that emit boxes, planks, cylinders and tubes with world-scaled UVs, merged per material so a
 * whole village draws in a handful of calls.
 */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { float, mix, normalize, texture, uv, vec3, vec4, attribute, positionWorld, transformNormalToView, normalMap, type N } from '../core/tsl';
import { loadKTX2, configureTex } from '../core/Assets';
import { wetness } from './weatherUniforms';
import { cloudShadow } from '../sky/Sky';

export type MatName = 'thatch' | 'bamboo' | 'planks' | 'planks_blue' | 'planks_grey' | 'plaster' | 'wood' | 'paint_wood' | 'rust' | 'bark' | 'bark_smooth' | 'stone' | 'coral_stone';

const ph = (r: number, g: number, b: number, a = 1) => {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, a * 255]), 1, 1);
  t.needsUpdate = true;
  return t;
};

interface LibEntry { mat: THREE.MeshStandardNodeMaterial; src: string; aNodes: N[]; nNodes: N[] }
const lib = new Map<string, LibEntry>();
const loading = new Map<string, Promise<void>>();
const texCache = new Map<string, [THREE.Texture, THREE.Texture]>();

/**
 * A PBR material from a texture pair. `tint` multiplies the albedo; `paint` (rgb) recolours painted wood;
 * vertex colours (if present) multiply too (dirt, AO).
 */
export function pbr(name: MatName, opts: { tint?: [number, number, number]; vcolor?: boolean; roughMul?: number; key?: string; emissive?: [number, number, number]; double?: boolean } = {}) {
  const key = opts.key ?? name;
  const hit = lib.get(key);
  if (hit) return hit.mat;
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = `kit_${key}`;
  const aT = texture(ph(150, 130, 110), uv());
  const nT = texture(ph(128, 128, 200, 1), uv());
  let col: N = aT.rgb;
  if (opts.tint) col = col.mul(vec3(...opts.tint));
  if (opts.vcolor) col = col.mul(attribute('color', 'vec3'));
  // wet in the rain on surfaces facing up
  col = col.mul(mix(float(1), float(0.66), wetness.rain));
  const cloud = cloudShadow(positionWorld);
  m.colorNode = vec4(col.mul(mix(float(0.62), float(1), cloud)), 1);
  const nxy = nT.xy.mul(2).sub(1);
  const nz = float(1).sub(nxy.dot(nxy)).max(0).sqrt();
  // tangent-space detail normal (the z the packing dropped is rebuilt)
  m.normalNode = normalMap(vec3(nT.x, nT.y, nz.mul(0.5).add(0.5)));
  void normalize; void transformNormalToView;
  m.roughnessNode = mix(nT.z.mul(opts.roughMul ?? 1), float(0.25), wetness.rain.mul(0.8));
  m.metalnessNode = float(name === 'rust' ? 0.3 : 0);
  m.aoNode = mix(float(1), nT.w, 0.8);
  if (opts.emissive) m.emissiveNode = vec3(...opts.emissive);
  if (opts.double) m.side = THREE.DoubleSide;
  const entry: LibEntry = { mat: m, src: name, aNodes: [aT], nNodes: [nT] };
  lib.set(key, entry);
  const loaded = texCache.get(name);
  if (loaded) {
    aT.value = loaded[0];
    nT.value = loaded[1];
  }
  if (!loading.has(name)) {
    loading.set(name, (async () => {
      const [a, n] = await Promise.all([loadKTX2(`assets/tex/${name}_a.ktx2`), loadKTX2(`assets/tex/${name}_n.ktx2`)]);
      configureTex(a, true);
      configureTex(n, false);
      texCache.set(name, [a, n]);
      for (const e of lib.values()) {
        if (e.src !== name) continue;
        for (const t of e.aNodes) t.value = a;
        for (const t of e.nNodes) t.value = n;
      }
    })().catch((e) => console.warn('kit texture', name, e)));
  }
  return m;
}

export function kitTexturesReady() {
  return Promise.all(loading.values());
}

/** geometry accumulators per material key, merged into meshes at the end */
export class KitBuilder {
  private parts = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[] }>();
  add(mat: THREE.Material, g: THREE.BufferGeometry) {
    const k = mat.uuid;
    let p = this.parts.get(k);
    if (!p) this.parts.set(k, (p = { mat, geos: [] }));
    // keep attribute sets identical for merging
    if (!g.getAttribute('color')) {
      const c = new Float32Array(g.getAttribute('position').count * 3).fill(1);
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    p.geos.push(g.index ? g : indexify(g));
  }
  build(group: THREE.Group, opts: { castShadow?: boolean } = {}) {
    for (const { mat, geos } of this.parts.values()) {
      const merged = mergeGeometries(geos.map(strip), false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = opts.castShadow ?? true;
      mesh.receiveShadow = true;
      mesh.name = (mat as THREE.Material).name;
      group.add(mesh);
    }
    this.parts.clear();
  }
}

function indexify(g: THREE.BufferGeometry) {
  const n = g.getAttribute('position').count;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}
function strip(g: THREE.BufferGeometry) {
  const out = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'uv', 'color']) {
    const a = g.getAttribute(k);
    if (a) out.setAttribute(k, a.clone());
  }
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  out.setIndex(g.index!.clone());
  // merging needs one index type
  const idx = out.index!;
  if (!(idx.array instanceof Uint32Array)) out.setIndex(new THREE.BufferAttribute(new Uint32Array(idx.array), 1));
  return out;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/** a box with UVs in metres / `tile`, transformed by position, rotation (Euler XYZ) and colour */
export function box(w: number, h: number, d: number, pos: THREE.Vector3, rot: [number, number, number] = [0, 0, 0], tile = 1.5, shade = 1) {
  const g = new THREE.BoxGeometry(w, h, d);
  // world-scale UVs per face
  const uvA = g.getAttribute('uv') as THREE.BufferAttribute;
  const nA = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < uvA.count; i++) {
    const nx = Math.abs(nA.getX(i)), ny = Math.abs(nA.getY(i));
    const sx = nx > 0.5 ? d : w, sy = ny > 0.5 ? d : h;
    uvA.setXY(i, (uvA.getX(i) * sx) / tile, (uvA.getY(i) * sy) / tile);
  }
  _m.compose(pos, _q.setFromEuler(_e.set(...rot)), new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(_m);
  const c = new Float32Array(g.getAttribute('position').count * 3).fill(shade);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

export function cylinder(rTop: number, rBot: number, h: number, pos: THREE.Vector3, rot: [number, number, number] = [0, 0, 0], sides = 8, tile = 1.5, shade = 1) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, sides, 1, false);
  const uvA = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uvA.count; i++) uvA.setXY(i, (uvA.getX(i) * Math.PI * 2 * rBot) / tile, (uvA.getY(i) * h) / tile);
  _m.compose(pos, _q.setFromEuler(_e.set(...rot)), new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(_m);
  const c = new Float32Array(g.getAttribute('position').count * 3).fill(shade);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** a tube through points (ropes, railings, net floats) */
export function tubeGeo(points: THREE.Vector3[], radius: number, sides = 5, shade = 1) {
  const curve = new THREE.CatmullRomCurve3(points);
  const g = new THREE.TubeGeometry(curve, Math.max(4, points.length * 4), radius, sides, false);
  const c = new Float32Array(g.getAttribute('position').count * 3).fill(shade);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** a plain coloured material for small parts (ropes, glass frames, paint) */
export function flat(color: [number, number, number], rough = 0.8, metal = 0, emissive?: [number, number, number]) {
  const key = `flat_${color.join(',')}_${rough}_${metal}_${emissive?.join(',') ?? ''}`;
  const hit = lib.get(key);
  if (hit) return hit.mat;
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = key;
  m.colorNode = vec4(vec3(...color).mul(attribute('color', 'vec3')).mul(mix(float(1), float(0.7), wetness.rain)), 1);
  m.roughnessNode = mix(float(rough), float(0.3), wetness.rain.mul(0.7));
  m.metalnessNode = float(metal);
  if (emissive) m.emissiveNode = vec3(...emissive);
  lib.set(key, { mat: m, src: '', aNodes: [], nNodes: [] });
  return m;
}
