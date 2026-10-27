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
import { sunLit } from '../core/lighting';
import { laceTex } from '../water/surf';

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

/** viewPos: the player's camera (the shadow passes' cameraPosition is the light's) */
export const glbU = { time: TSLTyped.uniform(0), sunColor: TSLTyped.uniform(new THREE.Color(1, 1, 1)), viewPos: TSLTyped.uniform(new THREE.Vector3()) };

/** the island's forest density (mask0 alpha) and heights, for how much open sky a leaf sees (set before plants load) */
let skyMaps: { mask0: THREE.Texture; height: THREE.Texture; half: number; size: number } | null = null;
export function setPlantSkyMaps(mask0: THREE.Texture, height: THREE.Texture, half: number, size: number) {
  skyMaps = { mask0, height, half, size };
}

/**
 * Share of the sky a point of a plant sees: in the forest, anything under the canopy's crowns (~14-28 m above the
 * ground) sees mostly leaves overhead. Per vertex (the masks are smooth). Used as specular occlusion: an understory
 * leaf mirrors the dark canopy above it, not the bright open sky (which, wet under an overcast, reads as frost).
 * A crown seen from afar is a volume of leaves that mostly mirror one another, so under an overcast its sheen of the
 * bright sky drops with distance too (else a wet forested hillside turns grey-white).
 */
function skyVisibility(): N {
  if (!skyMaps) return float(1);
  const m = skyMaps;
  return TSLTyped.varying(Fn(() => {
    const q = positionWorld.xz.add(m.half).div(m.size);
    const forest = texture(m.mask0, q).level(0).a;
    const above = positionWorld.y.sub(texture(m.height, q).level(0).r);
    const open = float(1).sub(forest.mul(float(1).sub(TSLTyped.smoothstep(14, 28, above))).mul(0.8));
    const far = TSLTyped.smoothstep(30, 120, TSLTyped.length(positionWorld.sub(TSLTyped.cameraPosition)));
    return open.mul(float(1).sub(far.mul(atmo.overcast).mul(0.7)));
  })());
}

export interface PlantLook {
  /** wind: how far the tips travel at full bend, as a share of the plant's height (palms bend more than trees) */
  sway: number;
  height: number;
  /** translucency of the leaves against the sun */
  translucent?: number;
  /** multiply the albedo (linear) */
  tint?: [number, number, number];
  /** how much further a squall bends it than a breeze (palms stream, trees bow) */
  storm?: number;
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
  // a squall: crowns stream downwind and the leaves thrash
  const storm = TSLTyped.smoothstep(0.45, 0.9, wetness.wind);
  // gusts and lulls rolling across the island downwind (two fronts of different speed and size), and the plant's own
  // sway on two unrelated periods with every part out of step: irregular, never one metronome per plant
  const along = positionWorld.x.mul(wd.x).add(positionWorld.z.mul(wd.y));
  const g1 = sin(t.mul(0.41).sub(along.mul(0.021)).add(phase.mul(1.3))).mul(0.5).add(0.5);
  const g2 = sin(t.mul(0.17).sub(along.mul(0.006)).add(1.7)).mul(0.5).add(0.5);
  const gust = g1.mul(g2.mul(0.7).add(0.3));
  const sway = sin(t.mul(0.9).add(phase.mul(12.0)).add(part.mul(2.2))).mul(0.3)
    .add(sin(t.mul(1.47).add(phase.mul(5.0)).add(part.mul(4.1))).mul(0.18))
    .add(gust.mul(0.95));
  const lean = storm.mul(gust.mul(0.6).add(0.9)).mul(TSLTyped.uniform(look.storm ?? 1));
  // (a uniform, not a constant: every species then shares one shader, see plantMaterial)
  const amt = bend.mul(bend).mul(strength.mul(sway).add(lean)).mul(TSLTyped.uniform(look.height * look.sway));
  const ft = t.mul(float(7.1).add(storm.mul(4)));
  const fl = sin(ft.add(part.mul(37)).add(positionLocal.x.mul(2.3)).add(positionLocal.z.mul(1.9))).mul(0.7)
    .add(sin(ft.mul(1.9).add(part.mul(11)).add(positionLocal.y.mul(3.1))).mul(0.3))
    .mul(flutter).mul(strength).mul(storm.mul(0.09).add(0.085));
  // the bent tip drops a little as it swings out
  return vec3(lw.x.mul(amt).add(fl.mul(0.35)), fl.mul(0.8).sub(amt.mul(bend).mul(0.18)), lw.y.mul(amt).add(fl.mul(0.35)));
}

/**
 * Leaves within ~2 m of the camera dissolve, in a dither that the temporal AA resolves into a soft fade: the
 * third-person camera in the jungle then sees the player through the plant beside it instead of one leaf filling the
 * frame. 1 = drawn. (In the shadow passes the camera is the sun's, far away: shadows keep every leaf.)
 */
function nearFade(): N {
  const d = TSLTyped.length(positionWorld.sub(TSLTyped.cameraPosition));
  const keep = TSLTyped.smoothstep(0.7, 2.1, d);
  const sc = TSLTyped.screenCoordinate.xy.add(TSLTyped.fract(glbU.time.mul(7.31)).mul(61.0));
  const ign = TSLTyped.fract(float(52.9829189).mul(TSLTyped.fract(dot(sc, vec2(0.06711056, 0.00583715)))));
  return TSLTyped.step(ign, keep);
}

/**
 * The moonlit sky's light on foliage at night (the glow Sky.ts gives the dark sky), stronger on the faces turned up:
 * the forest behind the village was one flat black wall; with it the crowns separate from each other and the sky.
 */
export function nightFill(alb: N): N {
  const up = normalWorld.y.mul(0.4).add(0.6).clamp(0.2, 1);
  return alb.mul(vec3(0.0013, 0.0024, 0.0058).mul(atmo.night.mul(float(1).sub(atmo.overcast)).mul(6))).mul(up);
}

/** a node material for a helper plant part: its textures, AO from COLOR_0, wind, wet darkening, backlit leaves, and
 *  the sheen of the sky only where the plant sees it */
export function plantMaterial(src: THREE.MeshStandardMaterial, look: PlantLook) {
  const m = sunLit(new THREE.MeshPhysicalNodeMaterial());
  m.specularIntensityNode = skyVisibility();
  m.name = `glb_${src.name}`;
  const leaf = src.alphaTest > 0 || src.transparent || src.side === THREE.DoubleSide;
  const col = attribute('color', 'vec4');
  const ao = col.x;
  // (every per-species number is a uniform, not a constant in the code: the species then share a handful of shaders
  // instead of compiling one pipeline each at start-up)
  const U = TSLTyped.uniform;
  const base = src.map ? texture(src.map, uv()) : vec4(U(new THREE.Vector3(src.color.r, src.color.g, src.color.b)), 1);
  // per-instance hue scatter so neighbours of one variant differ
  const iData = attribute('iData', 'vec4');
  const vary = hash(iData.y.mul(1000)).sub(0.5);
  // and a canopy of one species is never one green: some crowns yellower, some bluer, some darker (two independent
  // draws, so hue and brightness do not move together)
  const vary2 = hash(iData.y.mul(731).add(17)).sub(0.5);
  let alb: N = base.rgb.mul(vec3(float(1).add(vary.mul(0.3)), float(1).add(vary.mul(0.12)), float(1).sub(vary.mul(0.24))));
  alb = alb.mul(float(1).add(vary2.mul(0.36)));
  alb = alb.mul(U(new THREE.Vector3(...(look.tint ?? [1, 1, 1]))));
  // (the understory's stem atlas and the floor's stumps and logs are a saturated orange that reads as props in the
  // shade: pulled toward a dull green-brown, the rotting wood darker)
  if (src.name === 'understory_stem' || src.name === 'floor_bark' || src.name === 'floor_log') {
    const luma = alb.dot(vec3(0.3, 0.55, 0.15));
    alb = mix(vec3(luma).mul(vec3(0.92, 1.0, 0.84)), alb, 0.18).mul(src.name === 'understory_stem' ? 0.75 : 0.62);
  }
  // (stems and stalks in the atlases are a saturated orange that the warm afternoon sun turns into props: anything
  // that orange is pulled to a dull brown-olive; leaves and the litter keep their colours)
  if (src.name !== 'floor_litter') {
    const orange = TSLTyped.smoothstep(1.3, 1.9, alb.x.div(alb.y.max(0.005))).mul(TSLTyped.smoothstep(0.9, 1.4, alb.y.div(alb.z.max(0.005))));
    const lumO = alb.dot(vec3(0.3, 0.55, 0.15));
    alb = mix(alb, vec3(lumO).mul(vec3(1.0, 0.98, 0.82)).mul(0.85), orange.mul(0.75));
  }
  // the leaf litter: one atlas for the whole forest floor, so each patch gets its own fall of leaves (fresher and
  // browner, greyer and older, darker where it lies damp) and drifts a few metres across shift the whole floor's hue
  if (src.name === 'floor_litter') {
    const drift = TSLTyped.varying(TSLTyped.mx_noise_float(vec3(positionWorld.xz.mul(1 / 6.5), 4.4)));
    const luma = alb.dot(vec3(0.3, 0.55, 0.15));
    const old = mix(alb, vec3(luma).mul(vec3(1.0, 0.97, 0.88)), TSLTyped.smoothstep(-0.4, 0.4, vary2.add(drift.mul(0.6))).mul(0.7));
    const tone = mix(vec3(0.62, 0.6, 0.56), vec3(1.12, 1.05, 0.9), TSLTyped.smoothstep(-0.5, 0.5, vary.add(drift.mul(0.5))));
    alb = old.mul(tone).mul(mix(vec3(1), vec3(0.85, 1.0, 0.75), TSLTyped.smoothstep(0.3, 0.7, drift).mul(0.6)));
  }
  // wet leaves and bark go darker and a little more saturated
  alb = alb.mul(mix(vec3(1), vec3(0.5, 0.62, 0.46), wetness.rain));
  let alpha: N = base.a;
  if (leaf && src.name === 'canopy_leaf') {
    // seen from the gallery the simplified crowns' cards (a few big ones standing in for many) read as single leaves
    // two metres across: past ~50 m every card is broken into leaf-sized lumps, gaps and shade
    const farW = TSLTyped.smoothstep(40, 85, TSLTyped.length(positionWorld.sub(glbU.viewPos)));
    // (a texture, not procedural noise: this runs on every leaf of the forest, in the shadow passes too)
    // (and only where it shows: the near leaves of the jungle skip both taps; explicit gradients, as a texture
    // sample inside a branch needs them)
    const q = positionWorld.xz.add(positionWorld.y.mul(0.37));
    const qa = q.mul(0.12), qb = q.mul(0.37).add(0.43);
    const qdx = TSLTyped.dFdx(q), qdy = TSLTyped.dFdy(q);
    const taps = TSLTyped.Fn(() => {
      const r = TSLTyped.vec2(0.5, 0.5).toVar();
      TSLTyped.If(farW.greaterThan(0), () => {
        r.assign(TSLTyped.vec2(
          texture(laceTex, qa).grad(qdx.mul(0.12), qdy.mul(0.12)).b,
          texture(laceTex, qb).grad(qdx.mul(0.37), qdy.mul(0.37)).b,
        ));
      });
      return r;
    })();
    const n1 = taps.x.sub(0.5).mul(2), n2 = taps.y.sub(0.5).mul(2);
    alb = alb.mul(mix(float(1), TSLTyped.smoothstep(-0.6, 0.5, n1.add(n2.mul(0.6))).mul(0.6).add(0.4), farW));
    alpha = alpha.mul(float(1).sub(TSLTyped.step(n2.add(n1.mul(0.4)), -0.42).mul(farW)));
  }
  m.colorNode = vec4(alb.mul(ao.mul(0.8).add(0.2)), alpha);
  const orm = src.roughnessMap ?? src.metalnessMap ?? src.aoMap;
  // leaves keep a floor: a mirror-smooth card per leaf glints like a lamp in the sun (wet leaves shine a little more)
  const rough0: N = (orm ? texture(orm, uv()).g.mul(U(src.roughness)) : U(src.roughness)).max(leaf ? 0.58 : 0.3);
  m.roughnessNode = mix(rough0, rough0.min(leaf ? 0.46 : 0.5), wetness.rain);
  m.metalnessNode = float(0);
  if (orm && src.aoMap) m.aoNode = texture(orm, uv()).r;
  if (leaf) {
    m.alphaTest = 0.5;
    m.opacityNode = nearFade();
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
    m.emissiveNode = alb.mul(vec3(glbU.sunColor)).mul(back.mul(facing).mul(U(look.translucent * 0.07))).mul(cloudShadow(positionWorld)).mul(ao)
      .add(nightFill(alb.mul(ao)));
  } else if (leaf) m.emissiveNode = nightFill(alb.mul(ao));
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
    // (generous: neighbouring crowns overlap into one closed, lumpy canopy instead of balls with ground between)
    const rxz = Math.sqrt(sxz / cnt / 2) * 2.0 + 0.5, ry = Math.sqrt(sy / cnt) * 1.75 + 0.4;
    const base = P.length / 3, phase = rnd();
    for (let i = 0; i < ip.count; i++) {
      const x = ip.getX(i), y = ip.getY(i), z = ip.getZ(i);
      // two octaves of lumps: florets on the crown, not one smooth ball
      const lump = 1 + 0.16 * Math.sin(x * 5.1 + k) * Math.sin(y * 4.3 + 2 * k) * Math.sin(z * 4.7 + 3) + 0.09 * Math.sin(x * 11.3 + 2 * k) * Math.sin(y * 9.1 + k) * Math.sin(z * 10.7 + 1);
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
  const m = sunLit(new THREE.MeshPhysicalNodeMaterial());
  m.name = 'glb_crown_proxy';
  // always far: the overcast sheen of a whole crown (see skyVisibility)
  m.specularIntensityNode = float(1).sub(atmo.overcast.mul(0.7));
  const col = attribute('color', 'vec4');
  const p = positionWorld;
  // (seen from 270 m out: clumps of a metre or so; finer noise would be under a pixel)
  const n1 = mx_noise_float(p.mul(0.55));
  const iData = attribute('iData', 'vec4');
  const vary = hash(iData.y.mul(1000)).sub(0.5);
  // crown to crown: yellower and bluer greens, lighter and darker (a forest from afar is never one green)
  const vary2 = hash(iData.y.mul(731).add(17)).sub(0.5);
  const hue = vec3(float(1).add(vary2.mul(0.34)), float(1).add(vary2.mul(0.1)), float(1).sub(vary2.mul(0.3)));
  const alb = vec3(TSLTyped.uniform(new THREE.Vector3(...green))).mul(hue).mul(float(1).add(vary.mul(0.5))).mul(n1.mul(0.3).add(1)).mul(mix(float(1), float(0.68), wetness.rain));
  m.colorNode = vec4(alb.mul(col.x), 1);
  m.emissiveNode = nightFill(alb.mul(col.x));
  // leaf clumps tilt the normal; the gaps between clumps read as shadow
  // (and the crown's own shape only half shows: lit as a canopy of leaf clumps facing up, not as a sphere with a
  // terminator round it, which turned a forest seen from the gallery into bubble wrap)
  const bump = mx_noise_vec3(p.mul(1.1)).mul(0.6).add(mx_noise_vec3(p.mul(2.7)).mul(0.35));
  m.normalNode = transformNormalToView(normalize(normalWorldGeometry.add(vec3(0, 0.55, 0)).add(bump)));
  m.roughnessNode = float(0.75);
  m.metalnessNode = float(0);
  m.positionNode = Fn(() => positionLocal.add(windFrom(look)))();
  return m;
}

/** a node material for a helper rock: its textures as they are */
export function rockMaterial(src: THREE.MeshStandardMaterial) {
  const m = sunLit(new THREE.MeshStandardNodeMaterial());
  m.name = `glb_${src.name}`;
  m.colorNode = src.map ? texture(src.map, uv()).rgb.mul(mix(float(1), float(0.62), wetness.rain)) : vec3(src.color.r, src.color.g, src.color.b);
  const orm = src.roughnessMap ?? src.aoMap;
  m.roughnessNode = orm ? mix(texture(orm, uv()).g, float(0.35), wetness.rain) : float(0.9);
  if (orm) m.aoNode = texture(orm, uv()).r;
  if (src.normalMap) m.normalNode = normalMap(texture(src.normalMap, uv()));
  m.metalnessNode = float(0);
  return m;
}
