/**
 * The plunge pool's rim (boulders.glb from tools/blender/rocks): basalt blocks piled at the foot of the gorge walls and
 * half sunk in the shallows, big wet blocks either side of where the falls land, scattered stones on the gentler banks,
 * cobbles on the shallow bed, and boulders along the outflow with the stream running between them. Every rock is set
 * into the ground by its buried part (the kit models everything below y = 0 to be buried), tipped part way to the
 * slope it lies on.
 */
import * as THREE from 'three/webgpu';
import { loadGLTF } from '../core/Assets';
import { toFloatGeometry } from '../veg/glb';
import { instancedMesh } from '../core/instancing';
import type { Heightfield } from './Heightfield';
import type { Colliders } from './Colliders';
import { fallsPath } from '../water/fallsPath';

/** above ground, buried, footprint x / z at scale 1 (rocks.json) */
const SIZE: Record<string, [number, number, number, number]> = {
  basalt_a: [0.72, 0.25, 1.48, 0.99],
  basalt_b: [0.9, 0.31, 2.19, 1.88],
  basalt_c: [1.43, 0.47, 2.5, 3.31],
  basalt_d: [1.75, 0.53, 5.24, 4.44],
  pebbles_a: [0.14, 0.04, 0.95, 0.76],
  pebbles_b: [0.13, 0.08, 0.77, 0.89],
};

interface Rock { piece: string; m: THREE.Matrix4; x: number; y: number; z: number; s: number; r: number; big: boolean }

function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  return { next, range: (a: number, b: number) => a + (b - a) * next(), pick: <T>(l: T[]) => l[Math.floor(next() * l.length)] };
}

/** where the rocks go: deterministic, from the baked basin, the falls' path and the river */
export function planPoolRocks(hf: Heightfield): Rock[] {
  const { pool } = hf.meta;
  const [cx, cz] = pool.p, L = pool.level;
  const path = fallsPath(hf);
  const r = rng(5150);
  const out: Rock[] = [];
  const up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3(), q = new THREE.Quaternion(), qy = new THREE.Quaternion();
  // the falls' landing, kept clear: the sheet's footprint widened by a metre
  const fallsClear = (x: number, z: number, pad: number) => {
    const dx = x - path.lx, dz = z - path.lz;
    const a = dx * path.fx + dz * path.fz, c = Math.abs(dx * path.nx + dz * path.nz);
    return a > -1 && a < path.outEnd + 2.5 + pad && c < path.W * 0.5 * 1.4 + 1 + pad;
  };
  // the waterfall spot (player and shot camera stand at the outflow) and the trail up the escarpment stay open
  const keepOpen = (x: number, z: number, rad: number) => Math.hypot(x - 186, z + 41) < 3.5 + rad;
  const put = (piece: string, x: number, z: number, s: number, opts: { lean?: number; sink?: number; minGap?: number; force?: boolean; y?: number } = {}) => {
    const [above, buried, fx, fz] = SIZE[piece];
    const rad = Math.max(fx, fz) * 0.5 * s;
    if (!opts.force && (fallsClear(x, z, rad) || keepOpen(x, z, rad))) return false;
    // no two boulders inside each other (cobbles may lie among them)
    const big = !piece.startsWith('pebbles');
    if (big) for (const o of out) if (o.big && Math.hypot(o.x - x, o.z - z) < (o.r + rad) * (opts.minGap ?? 0.62)) return false;
    const yaw = r.next() * Math.PI * 2;
    // the ground under the footprint: the rock settles so its lowest corner is still under its buried part
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    let hMin = Infinity;
    for (const [u, v] of [[0.5, 0.5], [-0.5, 0.5], [0.5, -0.5], [-0.5, -0.5], [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]]) {
      const lx = u * fx * s, lz = v * fz * s;
      hMin = Math.min(hMin, hf.height(x + lx * c + lz * sn, z - lx * sn + lz * c));
    }
    const hC = hf.height(x, z);
    const y = opts.y ?? Math.min(hC, hMin + 0.7 * buried * s) - (opts.sink ?? 0.06) * above * s;
    // tipped part way to the slope
    hf.normal(x, z, n, Math.max(0.8, rad));
    n.lerp(up, 1 - (opts.lean ?? 0.55)).normalize();
    q.setFromUnitVectors(up, n).multiply(qy.setFromAxisAngle(up, yaw));
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s, s, s));
    out.push({ piece, m, x, y, z, s, r: rad, big });
    return true;
  };
  const polar = (deg: number, rad: number): [number, number] => [cx + Math.cos((deg * Math.PI) / 180) * rad, cz + Math.sin((deg * Math.PI) / 180) * rad];
  const depthAt = (x: number, z: number) => L - hf.height(x, z);

  // ---- piles at the foot of the walls (south-west and north-west of the pool, either side of the falls): a big
  // block or two with smaller ones heaped round them, straddling the water's edge
  for (const [a0, a1, k] of [[118, 176, 9], [218, 262, 8]] as [number, number, number][]) {
    for (let i = 0; i < k; i++) {
      const deg = a0 + ((a1 - a0) * (i + r.range(0.15, 0.85))) / k;
      const [x, z] = polar(deg, r.range(13.6, 15.4));
      const s = r.range(0.9, 1.45);
      if (!put(r.next() < 0.55 ? 'basalt_d' : 'basalt_c', x, z, s, { lean: 0.7 })) continue;
      for (let j = 0; j < 3; j++) {
        const [x2, z2] = polar(deg + r.range(-5, 5), r.range(12.4, 16.2));
        put(r.pick(['basalt_a', 'basalt_b', 'basalt_b', 'basalt_c']), x2, z2, r.range(0.6, 1.3), { lean: 0.6, minGap: 0.5 });
      }
      for (let j = 0; j < 2; j++) {
        const [x3, z3] = polar(deg + r.range(-6, 6), r.range(12.2, 15.5));
        put('pebbles_b', x3, z3, r.range(1.4, 2.4));
      }
    }
  }
  // ---- either side of the landing: big black blocks the white water breaks round
  for (const side of [-1, 1]) {
    for (let j = 0; j < 3; j++) {
      const off = path.W * 0.7 + 1.5 + j * r.range(1.6, 2.6);
      const along = path.outEnd + r.range(-1.5, 1.5);
      const x = path.lx + path.fx * along + path.nx * off * side, z = path.lz + path.fz * along + path.nz * off * side;
      put(j === 0 ? 'basalt_d' : r.pick(['basalt_c', 'basalt_b']), x, z, r.range(1.0, 1.5), { lean: 0.5, sink: 0.12 });
    }
  }
  // ---- the gentler banks: single stones and small groups at the edge, some out in the shallows
  for (let deg = -60; deg < 118; deg += r.range(7, 12)) {
    if (deg > -22 && deg < 32) continue; // the outflow: see below
    const [x, z] = polar(deg, r.range(12.6, 15.8));
    const d = depthAt(x, z);
    put(d > 0.3 ? r.pick(['basalt_c', 'basalt_b']) : r.pick(['basalt_a', 'basalt_b', 'basalt_c']), x, z, r.range(0.7, 1.35), { lean: 0.6 });
    if (r.next() < 0.5) {
      const [x2, z2] = polar(deg + r.range(-4, 4), r.range(13.5, 16.5));
      put('basalt_a', x2, z2, r.range(0.6, 1.1));
    }
  }
  // ---- cobbles on the shallow bed and the wet margin all round (not under the falls)
  for (let i = 0; i < 70; i++) {
    const deg = r.next() * 360;
    const [x, z] = polar(deg, r.range(11.2, 15.8));
    if (depthAt(x, z) > 1.3) continue;
    put(r.next() < 0.7 ? 'pebbles_a' : 'pebbles_b', x, z, r.range(1.3, 2.6), { lean: 0.9, sink: 0.25 });
  }
  // ---- the outflow: boulders along both banks and a few in the stream, cobbles on its bed
  const river = hf.river;
  for (let i = 1; i < river.length; i++) {
    const s = river[i], sp = river[i - 1];
    const dp = Math.hypot(s.x - cx, s.z - cz);
    // (downstream of the pool only: the river above the falls runs on the plateau)
    if (s.s < hf.meta.falls.s + 2 || dp < pool.r - 4 || dp > pool.r + 28) continue;
    const dx = s.x - sp.x, dz = s.z - sp.z, dl = Math.hypot(dx, dz) || 1;
    const nx = -dz / dl, nz = dx / dl;
    if (r.next() < 0.75) {
      const side = r.next() < 0.5 ? -1 : 1;
      const off = s.w * 0.5 + r.range(-0.6, 1.4);
      put(r.pick(['basalt_b', 'basalt_c', 'basalt_c', 'basalt_d']), s.x + nx * off * side, s.z + nz * off * side, r.range(0.7, 1.3), { lean: 0.6 });
    }
    if (r.next() < 0.3) put(r.pick(['basalt_a', 'basalt_b']), s.x + nx * r.range(-1.5, 1.5), s.z + nz * r.range(-1.5, 1.5), r.range(0.6, 1.0), { lean: 0.5, sink: 0.15 });
    for (let j = 0; j < 2; j++) put('pebbles_a', s.x + nx * r.range(-s.w * 0.5, s.w * 0.5), s.z + nz * r.range(-s.w * 0.5, s.w * 0.5), r.range(1.4, 2.6), { lean: 0.9, sink: 0.25 });
  }
  // ---- the lip: blocks standing up out of the crest, at the crest a metre back from the edge, set at the crest's height (their footprints hang over the drop, where
  // the usual settling would sink them down the face behind the sheet; placed last, so the rocks
  // before them keep their draws), so the top of the falls is not one
  // straight line of rock and the water comes over between them in tongues
  for (const [u, piece, sc] of [[-0.42, 'basalt_c', 0.9], [-0.12, 'basalt_b', 0.85], [0.2, 'basalt_c', 0.75], [0.47, 'basalt_b', 1.0]] as [number, string, number][]) {
    const back = r.range(0.25, 0.6);
    const X = path.lx + path.nx * u * path.W - path.fx * back, Z = path.lz + path.nz * u * path.W - path.fz * back;
    put(piece, X, Z, sc * r.range(1.6, 1.9), { lean: 0, force: true, minGap: 0.3, y: path.top - 0.1 });
  }
  return out;
}

export class PoolRocks {
  readonly group = new THREE.Group();
  private sets = new Map<string, { lods: THREE.InstancedMesh[]; rocks: Rock[] }>();
  private lastCam = new THREE.Vector3(Infinity, 0, 0);
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private wasPriming = false;

  constructor(private hf: Heightfield, private colliders: Colliders) {
    this.group.name = 'poolrocks';
  }

  /** load the boulders, plan and instance them; `material` turns the kit's own material into the island's rock */
  async load(material: (src: THREE.MeshStandardMaterial) => THREE.Material) {
    const gltf = await loadGLTF('assets/rocks/boulders.glb');
    gltf.scene.updateMatrixWorld(true);
    const parts = new Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material }[]>();
    const mats = new Map<THREE.Material, THREE.Material>();
    for (const node of gltf.scene.children) {
      const mm = /^(.*)_lod(\d)$/.exec(node.name);
      if (!mm || !(mm[1] in SIZE) || Number(mm[2]) > 1) continue;
      node.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const g = toFloatGeometry(mesh.geometry);
        g.applyMatrix4(mesh.matrixWorld);
        const src = mesh.material as THREE.MeshStandardMaterial;
        let mat = mats.get(src);
        if (!mat) mats.set(src, (mat = material(src)));
        let l = parts.get(mm[1]);
        if (!l) parts.set(mm[1], (l = []));
        l[Number(mm[2])] = { geometry: g, material: mat };
      });
    }
    const rocks = planPoolRocks(this.hf);
    for (const rk of rocks) {
      let set = this.sets.get(rk.piece);
      const lods = parts.get(rk.piece);
      if (!lods?.[0]) continue;
      if (!set) {
        const big = rk.piece === 'basalt_c' || rk.piece === 'basalt_d';
        set = {
          rocks: [],
          lods: [lods[0], lods[1] ?? lods[0]].map((p, l) => {
            const mesh = instancedMesh(p.geometry, p.material, 0);
            mesh.name = `${rk.piece}_pool_l${l}`;
            // (the small stones are grounded by the AO; only the big blocks throw shadows)
            mesh.castShadow = big;
            mesh.receiveShadow = true;
            mesh.frustumCulled = false;
            mesh.renderOrder = -3;
            this.group.add(mesh);
            return mesh;
          }),
        };
        this.sets.set(rk.piece, set);
      }
      set.rocks.push(rk);
      if (rk.big && rk.r > 0.55) this.colliders.circle(rk.x, rk.z, rk.r * 0.75, rk.y - 2, rk.y + SIZE[rk.piece][0] * rk.s * 0.9);
    }
    console.info(`[island] pool rocks: ${[...this.sets].map(([k, v]) => `${k}:${v.rocks.length}`).join(' ')}`);
  }

  /** near rocks at full detail, the rest at the low LOD, none past 240 m; re-listed only when the camera has moved */
  update(camera: THREE.Camera, priming: boolean) {
    const cam = camera.position;
    if (!priming && !this.wasPriming && cam.distanceTo(this.lastCam) < 1) return;
    this.wasPriming = priming;
    this.lastCam.copy(cam);
    for (const set of this.sets.values()) {
      const n = [0, 0];
      for (const rk of set.rocks) {
        const d = Math.hypot(rk.x - cam.x, rk.z - cam.z);
        if (d > 240 && !priming) continue;
        const l = d < 22 + rk.r * 8 ? 0 : 1;
        set.lods[l].setMatrixAt(n[l]++, rk.m);
      }
      set.lods.forEach((mesh, l) => {
        if (priming && n[l] === 0) mesh.setMatrixAt(n[l]++, this.zero);
        mesh.count = n[l];
        mesh.visible = n[l] > 0;
        if (n[l] > 0) {
          const im = mesh.instanceMatrix;
          im.clearUpdateRanges();
          im.addUpdateRange(0, n[l] * 16);
          im.needsUpdate = true;
        }
      });
    }
  }
}
