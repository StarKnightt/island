/**
 * The fishing village in the south-west cove: stilt huts with woven and plank walls under thatch, an open communal
 * house, two wooden jetties you can walk out on, outrigger canoes moored and pulled up on the sand (bobbing on the
 * real wave field), nets drying on poles, a fish rack, a fire pit, crates, barrels, baskets, buoys and lanterns.
 * Everything walkable or solid registers its colliders.
 */
import * as THREE from 'three/webgpu';
import { KitBuilder, box, cylinder, pbr, tubeGeo, flat } from './kit';
import type { Heightfield } from './Heightfield';
import type { Colliders } from './Colliders';
import { Rng } from '../core/noise';
import { loadGLTF } from '../core/Assets';
import {
  float, fract, smoothstep, uv, vec4, vec3, abs, min, max, attribute, mix, positionLocal, sin, uniform, Fn,
} from '../core/tsl';
import { wetness } from './weatherUniforms';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
export const villageU = { time: uniform(0), lights: uniform(0) };

interface Hut { x: number; z: number; rot: number; w: number; d: number; wall: 'bamboo' | 'planks' | 'planks_blue'; floor: number }
interface Boat { x: number; z: number; rot: number; moored: boolean; probe: number; paint: number }

export class Village {
  readonly group = new THREE.Group();
  readonly boats: Boat[] = [];
  private boatMeshes: THREE.InstancedMesh[] = [];
  readonly lanterns: THREE.Vector3[] = [];
  readonly docks: { x0: number; z0: number; x1: number; z1: number; y: number; w: number }[] = [];
  private boatBase: THREE.Matrix4[] = [];

  constructor(private hf: Heightfield, private col: Colliders) {
    this.group.name = 'village';
  }

  private ground(x: number, z: number) {
    return this.hf.height(x, z);
  }

  build() {
    const kb = new KitBuilder();
    const huts: Hut[] = [
      { x: -522, z: 316, rot: 0.32, w: 4.2, d: 5.0, wall: 'bamboo', floor: 1.1 },
      { x: -494, z: 304, rot: 0.16, w: 4.6, d: 5.4, wall: 'planks_blue', floor: 1.0 },
      { x: -463, z: 297, rot: 0.02, w: 4.0, d: 4.8, wall: 'planks', floor: 1.2 },
      { x: -431, z: 301, rot: -0.14, w: 4.4, d: 5.2, wall: 'bamboo', floor: 1.0 },
      { x: -402, z: 311, rot: -0.34, w: 4.0, d: 4.6, wall: 'planks', floor: 1.1 },
      { x: -507, z: 274, rot: 0.22, w: 4.8, d: 5.6, wall: 'planks_blue', floor: 0.9 },
      { x: -471, z: 266, rot: 0.06, w: 4.2, d: 5.0, wall: 'bamboo', floor: 1.0 },
      { x: -438, z: 270, rot: -0.12, w: 4.4, d: 5.0, wall: 'planks', floor: 1.0 },
      { x: -410, z: 281, rot: -0.3, w: 3.8, d: 4.4, wall: 'bamboo', floor: 1.2 },
    ];
    const r = new Rng(77);
    for (const h of huts) this.hut(kb, h, r);
    this.communal(kb, -456, 324, 0.0);
    // jetties: from the sand out into the cove
    this.dock(kb, -452, 334, -452, 388, 2.2, 1.45, true);
    this.dock(kb, -404, 340, -396, 372, 1.6, 1.35, false);
    this.firePit(kb, -476, 330);
    this.netRack(kb, -522, 338, 0.25);
    this.netRack(kb, -488, 334, -0.1);
    this.fishRack(kb, -426, 328, -0.2);
    kb.build(this.group);
    this.buildBoats();
    this.scatterProps().catch((e) => console.warn('village props', e));
  }

  // ---------------------------------------------------------------- huts
  private hut(kb: KitBuilder, h: Hut, r: Rng) {
    const g0 = Math.min(this.ground(h.x, h.z), this.ground(h.x + 2, h.z), this.ground(h.x - 2, h.z));
    const F = g0 + h.floor;
    const c = Math.cos(h.rot), s = Math.sin(h.rot);
    const W = (lx: number, y: number, lz: number) => V(h.x + lx * c + lz * s, y, h.z - lx * s + lz * c);
    const post = pbr('wood', { vcolor: true });
    const wallMat = pbr(h.wall, { vcolor: true });
    const floorMat = pbr('planks_grey', { vcolor: true });
    const thatch = pbr('thatch', { vcolor: true, double: true });
    const hw = h.w / 2, hd = h.d / 2, wallH = 2.3, porch = 1.3;
    // stilts
    for (const lx of [-hw, 0, hw]) for (const lz of [-hd, 0, hd, hd + porch]) {
      if (lx === 0 && (lz === 0 || lz === hd + porch)) continue;
      const p = W(lx, 0, lz);
      const gy = this.ground(p.x, p.z);
      const len = F - gy + 0.4;
      kb.add(post, cylinder(0.09, 0.11, len, V(p.x, gy + len / 2 - 0.4, p.z), [0, 0, 0], 7, 1.2, 0.8));
      this.col.circle(p.x, p.z, 0.14, gy - 1, F);
    }
    // floor and porch deck
    const fl = W(0, F, porch / 2);
    kb.add(floorMat, box(h.w + 0.3, 0.12, h.d + porch, fl, [0, h.rot, 0], 1.6));
    this.col.platform(fl.x, fl.z, (h.w + 0.3) / 2, (h.d + porch) / 2, -h.rot, F + 0.06, 'wood');
    // walls (front with a door gap, sides with windows)
    const t = 0.08;
    const addWall = (lx: number, lz: number, len: number, along: 'x' | 'z', y0: number, y1: number, shade = 1) => {
      const ctr = W(lx, F + 0.06 + (y0 + y1) / 2, lz);
      const ww = along === 'x' ? len : t, dd = along === 'x' ? t : len;
      kb.add(wallMat, box(ww, y1 - y0, dd, ctr, [0, h.rot, 0], 1.6, shade));
      if (y0 < 1.0) this.col.box(ctr.x, ctr.z, ww / 2 + 0.02, dd / 2 + 0.02, -h.rot, F, F + 2.4);
    };
    addWall(0, -hd, h.w, 'x', 0, wallH, 0.85);
    // side walls with a window (sill 0.9, head 1.7)
    for (const side of [-1, 1]) {
      addWall(side * hw, -hd * 0.55, h.d * 0.45, 'z', 0, wallH, 0.9);
      addWall(side * hw, hd * 0.55, h.d * 0.45, 'z', 0, wallH, 0.9);
      addWall(side * hw, 0, h.d * 0.12, 'z', 0, 0.9, 0.9);
      addWall(side * hw, 0, h.d * 0.12, 'z', 1.7, wallH, 0.9);
      addWall(side * hw, 0, h.d * 0.12, 'z', 0.9, 1.7, 0.6);
    }
    // front: door 0.9 m wide
    const seg = (h.w - 0.9) / 2;
    addWall(-(0.45 + seg / 2), hd, seg, 'x', 0, wallH);
    addWall(0.45 + seg / 2, hd, seg, 'x', 0, wallH);
    addWall(0, hd, 0.9, 'x', 2.0, wallH);
    // roof: two thatched slopes over the porch too, ridge along z
    const ridge = 1.9, over = 0.65;
    const halfSpan = hw + over;
    const pitch = Math.atan2(ridge, hw);
    const slopeLen = Math.hypot(halfSpan, ridge * (halfSpan / hw));
    const roofD = h.d + porch + over * 2;
    for (const side of [-1, 1]) {
      const mid = W(side * halfSpan * 0.5, F + 0.06 + wallH + ridge - (ridge * (halfSpan / hw)) * 0.5 + 0.05, porch / 2);
      kb.add(thatch, box(slopeLen, 0.22, roofD, mid, [0, h.rot, 0], 1.2, 0.9), );
      // rotate the slab about the ridge: rebuild with rotation (rotate around local z axis by +-pitch)
      const g = kb as unknown as { parts: Map<string, { geos: THREE.BufferGeometry[] }> };
      const list = g.parts.get(thatch.uuid)!.geos;
      const last = list[list.length - 1];
      const m = new THREE.Matrix4().makeTranslation(-mid.x, -mid.y, -mid.z);
      const rotY = new THREE.Matrix4().makeRotationY(-h.rot);
      const rotZ = new THREE.Matrix4().makeRotationZ(-side * pitch);
      const back = new THREE.Matrix4().makeRotationY(h.rot);
      const tr = new THREE.Matrix4().makeTranslation(mid.x, mid.y, mid.z);
      last.applyMatrix4(tr.multiply(back).multiply(rotZ).multiply(rotY).multiply(m));
    }
    // ridge beam and gable triangles
    kb.add(post, box(0.16, 0.16, roofD, W(0, F + 0.06 + wallH + ridge + 0.05, porch / 2), [0, h.rot, 0], 1.5, 0.7));
    for (const lz of [-hd, hd]) {
      const tri = new THREE.BufferGeometry();
      const a = W(-hw, F + 0.06 + wallH, lz), b = W(hw, F + 0.06 + wallH, lz), cc = W(0, F + 0.06 + wallH + ridge, lz);
      tri.setAttribute('position', new THREE.Float32BufferAttribute([a.x, a.y, a.z, b.x, b.y, b.z, cc.x, cc.y, cc.z, b.x, b.y, b.z, a.x, a.y, a.z, cc.x, cc.y, cc.z], 3));
      tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, h.w / 1.6, 0, h.w / 3.2, ridge / 1.6, h.w / 1.6, 0, 0, 0, h.w / 3.2, ridge / 1.6], 2));
      tri.computeVertexNormals();
      kb.add(wallMat, tri);
    }
    // porch posts and railing, steps down to the ground
    for (const lx of [-hw + 0.1, hw - 0.1]) kb.add(post, cylinder(0.07, 0.08, wallH + 0.2, W(lx, F + 1.2, hd + porch - 0.1), [0, 0, 0], 6, 1.2, 0.85));
    const rail = W(-hw + 0.1, F + 0.95, hd + porch * 0.5);
    kb.add(post, box(0.06, 0.06, porch, rail, [0, h.rot, 0], 1.2, 0.8));
    const steps = Math.max(2, Math.round(h.floor / 0.28));
    const front = W(0, 0, hd + porch);
    const gy = this.ground(front.x, front.z);
    for (let i = 0; i < steps; i++) {
      const tt = (i + 1) / (steps + 1);
      const p = W(0, 0, hd + porch + 0.25 + i * 0.3);
      kb.add(floorMat, box(1.1, 0.08, 0.3, V(p.x, F - (F - gy) * tt, p.z), [0, h.rot, 0], 1.4, 0.9));
    }
    // the steps as a ramp collider
    const rampC = W(0, 0, hd + porch + 0.15 + steps * 0.15);
    const rampLen = steps * 0.3 + 0.3;
    const slope = (F - gy) / rampLen;
    this.col.platform(rampC.x, rampC.z, 0.55, rampLen / 2, -h.rot + Math.PI / 2, (F + gy) / 2, 'wood', slope);
    // lantern by the door
    this.lanterns.push(W(0.8, F + 2.0, hd + 0.15));
    // inside: a mat, a crate (shade from the vertex colour)
    kb.add(floorMat, box(1.6, 0.03, 1.0, W(0.3, F + 0.08, -0.6), [0, h.rot + 0.2, 0], 1.0, 0.55));
    void r;
  }

  private communal(kb: KitBuilder, x: number, z: number, rot: number) {
    const g0 = this.ground(x, z);
    const post = pbr('wood', { vcolor: true });
    const thatch = pbr('thatch', { vcolor: true, double: true, key: 'thatch_c' });
    const floor = pbr('planks_grey', { vcolor: true });
    const W = 8, D = 6, H = 3.0;
    const c = Math.cos(rot), s = Math.sin(rot);
    const P = (lx: number, y: number, lz: number) => V(x + lx * c + lz * s, y, z - lx * s + lz * c);
    for (const lx of [-W / 2, 0, W / 2]) for (const lz of [-D / 2, D / 2]) {
      const p = P(lx, 0, lz);
      const gy = this.ground(p.x, p.z);
      kb.add(post, cylinder(0.12, 0.14, H + (g0 + 0.3 - gy) + 0.3, V(p.x, (gy + g0 + 0.3 + H) / 2, p.z), [0, 0, 0], 8, 1.2, 0.8));
      this.col.circle(p.x, p.z, 0.16, gy - 1, g0 + H + 2);
    }
    kb.add(floor, box(W + 0.4, 0.15, D + 0.4, P(0, g0 + 0.3, 0), [0, rot, 0], 1.6));
    this.col.platform(P(0, 0, 0).x, P(0, 0, 0).z, (W + 0.4) / 2, (D + 0.4) / 2, -rot, g0 + 0.38, 'wood');
    // hip roof as four sloped slabs
    const ridgeH = 2.2;
    for (const side of [-1, 1]) {
      const g = box(W + 1.6, 0.25, Math.hypot(D / 2 + 0.8, ridgeH) + 0.2, P(0, g0 + 0.3 + H + ridgeH / 2, side * (D / 4 + 0.4)), [side * Math.atan2(ridgeH, D / 2 + 0.8), rot, 0], 1.2, 0.9);
      kb.add(thatch, g);
    }
    // benches and a low table inside
    for (const lz of [-1.6, 1.6]) kb.add(floor, box(4.5, 0.08, 0.4, P(0, g0 + 0.75, lz), [0, rot, 0], 1.4, 0.8));
    kb.add(floor, box(2.4, 0.08, 1.1, P(0, g0 + 0.95, 0), [0, rot, 0], 1.4, 0.75));
    this.lanterns.push(P(0, g0 + 0.3 + H - 0.2, 0));
  }

  // ---------------------------------------------------------------- docks
  private dock(kb: KitBuilder, x0: number, z0: number, x1: number, z1: number, w: number, y: number, tee: boolean) {
    const deck = pbr('planks_grey', { vcolor: true, key: 'dockdeck' });
    const post = pbr('wood', { vcolor: true, key: 'dockpost' });
    const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz);
    const ux = dx / L, uz = dz / L;
    const rot = Math.atan2(ux, uz);
    const r = new Rng(Math.round(x0 * 7 + z0));
    // planks across, with gaps and small height noise
    const nPl = Math.floor(L / 0.24);
    for (let i = 0; i < nPl; i++) {
      const t = (i + 0.5) / nPl;
      const px = x0 + dx * t, pz = z0 + dz * t;
      const gy = this.ground(px, pz);
      const yy = Math.max(y, gy + 0.25) + r.range(-0.012, 0.012);
      kb.add(deck, box(w + r.range(-0.05, 0.08), 0.05, 0.21, V(px, yy, pz), [r.range(-0.01, 0.01), rot, r.range(-0.015, 0.015)], 1.2, r.range(0.7, 1.0)));
    }
    // stringers and posts
    for (const side of [-1, 1]) {
      const ox = -uz * side * (w / 2 - 0.12), oz = ux * side * (w / 2 - 0.12);
      kb.add(post, box(0.1, 0.16, L, V((x0 + x1) / 2 + ox, y - 0.1, (z0 + z1) / 2 + oz), [0, rot, 0], 1.5, 0.75));
      for (let s2 = 0; s2 <= L; s2 += 2.4) {
        const px = x0 + ux * s2 + ox, pz = z0 + uz * s2 + oz;
        const gy = this.ground(px, pz);
        const bottom = Math.min(gy, -0.2) - 0.6;
        const top = y + (s2 % 4.8 < 0.1 ? 0.9 : 0.15);
        kb.add(post, cylinder(0.11, 0.13, top - bottom, V(px, (top + bottom) / 2, pz), [r.range(-0.03, 0.03), 0, r.range(-0.03, 0.03)], 7, 1.2, 0.7));
        if (top > y + 0.5) this.col.circle(px, pz, 0.14, bottom, top);
      }
    }
    // rope railing on one side of the outer half
    const pts: THREE.Vector3[] = [];
    for (let s2 = L * 0.35; s2 <= L; s2 += 2.4) pts.push(V(x0 + ux * s2 - uz * (w / 2 - 0.12), y + 0.82 - (s2 % 4.8 < 0.1 ? 0 : 0.12), z0 + uz * s2 + ux * (w / 2 - 0.12)));
    if (pts.length > 2) kb.add(flat([0.55, 0.47, 0.34], 0.9), tubeGeo(pts, 0.022, 5));
    // walkable deck (ramps up from the sand at the shore end)
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    this.col.platform(cx, cz, w / 2, L / 2, -rot + Math.PI / 2 - Math.PI / 2, y + 0.03, 'wood');
    this.docks.push({ x0, z0, x1, z1, y, w });
    if (tee) {
      // a crossing platform at the end
      const ex = x1, ez = z1;
      for (let i = -10; i <= 10; i++) {
        const px = ex + uz * i * 0.24 * -1 + ux * 1.2 * 0, pz = ez + ux * i * 0.24;
        kb.add(deck, box(0.21, 0.05, 3.2, V(px + ux * 0.6, y + r.range(-0.01, 0.01), pz + uz * 0.6), [0, rot, 0], 1.2, r.range(0.7, 1)));
      }
      this.col.platform(ex + ux * 0.6, ez + uz * 0.6, 2.6, 1.6, -rot, y + 0.03, 'wood');
      for (const sx of [-2.4, 2.4]) {
        const px = ex - uz * sx + ux * 1.9, pz = ez + ux * sx + uz * 1.9;
        kb.add(post, cylinder(0.12, 0.14, y + 3.2, V(px, (y + 1.2 - 2) / 2 + 0.6, pz), [0, 0, 0], 7, 1.2, 0.7));
        this.col.circle(px, pz, 0.15, -3, y + 1.2);
      }
    }
  }

  // ---------------------------------------------------------------- canoes
  private buildBoats() {
    const hull = boatHull();
    const paints = [[0.13, 0.33, 0.5], [0.62, 0.18, 0.12], [0.86, 0.84, 0.78], [0.18, 0.42, 0.32], [0.75, 0.6, 0.2]];
    const defs: Boat[] = [
      { x: -445.3, z: 357, rot: 0.08, moored: true, probe: 1, paint: 0 },
      { x: -458.8, z: 368, rot: -0.12, moored: true, probe: 2, paint: 1 },
      { x: -445.5, z: 378, rot: 0.15, moored: true, probe: 3, paint: 2 },
      { x: -459, z: 391, rot: 1.45, moored: true, probe: 4, paint: 3 },
      { x: -392, z: 362, rot: 0.25, moored: true, probe: 5, paint: 4 },
      { x: -500, z: 342, rot: 2.6, moored: false, probe: -1, paint: 1 },
      { x: -486, z: 345, rot: 2.9, moored: false, probe: -1, paint: 0 },
      { x: -372, z: 352, rot: -2.4, moored: false, probe: -1, paint: 2 },
    ];
    this.boats.push(...defs);
    for (const part of hull) {
      const im = new THREE.InstancedMesh(part.geometry, part.material, defs.length);
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      im.name = 'boats';
      for (let i = 0; i < defs.length; i++) im.setColorAt(i, new THREE.Color(...(part.painted ? paints[defs[i].paint] : [1, 1, 1]) as [number, number, number]));
      this.group.add(im);
      this.boatMeshes.push(im);
    }
    for (const b of defs) {
      const gy = this.ground(b.x, b.z);
      const y = b.moored ? 0 : gy + 0.05;
      const m = new THREE.Matrix4().compose(V(b.x, y, b.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(b.moored ? 0 : 0.05, b.rot, b.moored ? 0 : 0.12)), V(1, 1, 1));
      this.boatBase.push(m);
      if (!b.moored) this.col.box(b.x, b.z, 0.75, 3.1, -b.rot, gy - 1, gy + 0.9);
    }
    this.updateBoats(0, () => [0, 0, 0]);
  }

  /** bob and roll the moored boats on the sea surface (probe displacement from the wave sim) */
  updateBoats(t: number, probe: (i: number) => [number, number, number]) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0; i < this.boats.length; i++) {
      const b = this.boats[i];
      if (b.moored) {
        const d = b.probe >= 0 ? probe(b.probe) : [0, 0, 0];
        const heave = d[1] * 0.45 + Math.sin(t * 1.1 + i * 1.7) * 0.03;
        const roll = Math.sin(t * 0.9 + i * 2.1) * 0.04 + d[0] * 0.03;
        const pitch = Math.sin(t * 0.7 + i) * 0.02 + d[2] * 0.02;
        q.setFromEuler(new THREE.Euler(pitch, b.rot + Math.sin(t * 0.15 + i) * 0.04, roll));
        m.compose(V(b.x, heave - 0.08, b.z), q, V(1, 1, 1));
      } else m.copy(this.boatBase[i]);
      for (const im of this.boatMeshes) im.setMatrixAt(i, m);
    }
    for (const im of this.boatMeshes) im.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- nets, racks, fire
  private netRack(kb: KitBuilder, x: number, z: number, rot: number) {
    const post = pbr('wood', { vcolor: true, key: 'netpost' });
    const g = this.ground(x, z);
    const c = Math.cos(rot), s = Math.sin(rot);
    const ends = [V(x - 3 * c, 0, z + 3 * s), V(x + 3 * c, 0, z - 3 * s)];
    for (const e of ends) {
      const gy = this.ground(e.x, e.z);
      kb.add(post, cylinder(0.06, 0.07, 2.4, V(e.x, gy + 1.0, e.z), [0, 0, 0], 6, 1.2, 0.75));
      this.col.circle(e.x, e.z, 0.1, gy - 1, gy + 2.2);
    }
    // a draped net: catenary sheet between the posts, hanging down 1.4 m
    const cols = 24, rows = 10;
    const pos: number[] = [], uvs: number[] = [], idx: number[] = [];
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
      const u = i / cols, v = j / rows;
      const sag = Math.sin(u * Math.PI) * 0.35;
      const px = ends[0].x + (ends[1].x - ends[0].x) * u, pz = ends[0].z + (ends[1].z - ends[0].z) * u;
      const wave = Math.sin(u * 13 + v * 3) * 0.05 * v;
      pos.push(px + s * wave, g + 2.15 - sag - v * 1.45 * (1 - Math.sin(u * Math.PI) * 0.1), pz + c * wave);
      uvs.push(u * 6 / 0.12, v * 1.45 / 0.12);
    }
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i, b = a + 1, cc = a + cols + 1, d = cc + 1;
      idx.push(a, cc, b, b, cc, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, netMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'net';
    this.group.add(mesh);
    // floats along the top rope
    const floats = flat([0.8, 0.55, 0.2], 0.6);
    for (let i = 1; i < 8; i++) {
      const u = i / 8;
      const px = ends[0].x + (ends[1].x - ends[0].x) * u, pz = ends[0].z + (ends[1].z - ends[0].z) * u;
      kb.add(floats, cylinder(0.06, 0.06, 0.12, V(px, g + 2.15 - Math.sin(u * Math.PI) * 0.35, pz), [Math.PI / 2, rot, 0], 8, 1, 1));
    }
  }

  private fishRack(kb: KitBuilder, x: number, z: number, rot: number) {
    const post = pbr('wood', { vcolor: true, key: 'rackpost' });
    const g = this.ground(x, z);
    const c = Math.cos(rot), s = Math.sin(rot);
    for (const [lx, lz] of [[-1.5, -0.5], [1.5, -0.5], [-1.5, 0.5], [1.5, 0.5]]) {
      const px = x + lx * c + lz * s, pz = z - lx * s + lz * c;
      kb.add(post, cylinder(0.05, 0.06, 1.6, V(px, g + 0.75, pz), [0, 0, 0], 6, 1, 0.8));
    }
    kb.add(post, box(3.3, 0.05, 1.2, V(x, g + 1.25, z), [0, rot, 0], 1.0, 0.7));
    this.col.box(x, z, 1.7, 0.65, -rot, g - 1, g + 1.4);
    // fish drying on the rack
    const fish = flat([0.55, 0.5, 0.42], 0.45, 0.1);
    for (let i = 0; i < 14; i++) {
      const lx = -1.4 + (i % 7) * 0.45, lz = i < 7 ? -0.25 : 0.25;
      const px = x + lx * c + lz * s, pz = z - lx * s + lz * c;
      kb.add(fish, box(0.32, 0.03, 0.09, V(px, g + 1.3, pz), [0, rot + 0.2 * Math.sin(i), 0], 1, 0.9));
    }
  }

  private firePit(kb: KitBuilder, x: number, z: number) {
    const stone = pbr('stone', { vcolor: true, key: 'pitstone' });
    const g = this.ground(x, z);
    const r = new Rng(5);
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2;
      kb.add(stone, box(0.32, 0.2, 0.26, V(x + Math.cos(a) * 0.75, g + 0.06, z + Math.sin(a) * 0.75), [r.range(-0.2, 0.2), a, r.range(-0.2, 0.2)], 0.6, 0.85));
    }
    const char = flat([0.05, 0.045, 0.04], 0.95);
    for (let i = 0; i < 5; i++) kb.add(char, cylinder(0.05, 0.05, 0.8, V(x + r.range(-0.2, 0.2), g + 0.1, z + r.range(-0.2, 0.2)), [Math.PI / 2, r.next() * 3, 0.3], 6, 1, 1));
    this.lanterns.push(V(x, g + 0.4, z));
    this.col.circle(x, z, 0.9, g - 1, g + 0.4);
  }

  // ---------------------------------------------------------------- props (Poly Haven models)
  private async scatterProps() {
    const names = ['wooden_crate_01', 'wooden_crate_02', 'wooden_barrels_01', 'wooden_bucket_01', 'wicker_basket_01', 'ocean_buoy', 'lifebuoy', 'wooden_lantern_01', 'folding_wooden_stool', 'painted_wooden_bench', 'fishermans_hat'];
    const loaded = new Map<string, THREE.Object3D>();
    await Promise.all(names.map(async (n) => {
      try {
        const g = await loadGLTF(`assets/props/${n}.glb`);
        loaded.set(n, g.scene);
      } catch {
        // prop not built yet
      }
    }));
    const place = (n: string, x: number, z: number, rot: number, onY?: number, scale = 1) => {
      const src = loaded.get(n);
      if (!src) return;
      const o = src.clone(true);
      const y = onY ?? this.ground(x, z);
      o.position.set(x, y, z);
      o.rotation.y = rot;
      o.scale.setScalar(scale);
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
        }
      });
      this.group.add(o);
      const bb = new THREE.Box3().setFromObject(o);
      const sz = bb.getSize(new THREE.Vector3());
      if (sz.x > 0.35 && sz.z > 0.35) this.col.box((bb.min.x + bb.max.x) / 2, (bb.min.z + bb.max.z) / 2, sz.x / 2, sz.z / 2, 0, bb.min.y, bb.max.y);
    };
    const dockY = 1.45 + 0.03;
    place('wooden_crate_01', -451.2, 372, 0.3, dockY);
    place('wooden_crate_02', -452.6, 373.1, 1.1, dockY);
    place('wooden_barrels_01', -451.5, 352, 0.2, dockY);
    place('wooden_bucket_01', -452.9, 364, 0, dockY);
    place('wicker_basket_01', -451.0, 380, 0.5, dockY);
    place('lifebuoy', -453.1, 386.2, 0.2, dockY + 0.6);
    place('ocean_buoy', -441, 395, 0.4, -0.1, 0.8);
    place('ocean_buoy', -470, 380, 1.2, -0.1, 0.8);
    place('fishermans_hat', -455.8, 323.9, 0.4, this.ground(-456, 324) + 1.05);
    place('wooden_crate_01', -425.5, 324, -0.2);
    place('wooden_crate_02', -424.2, 325.2, 0.6);
    place('wooden_barrels_01', -514, 322, 0.6);
    place('wicker_basket_01', -478.5, 331.5, 0.1);
    place('wicker_basket_01', -479.6, 332.3, 2.1);
    place('folding_wooden_stool', -474.2, 331.8, 0.4);
    place('folding_wooden_stool', -477.8, 328.6, 2.4);
    place('painted_wooden_bench', -470.5, 327.6, -0.2);
    place('wooden_bucket_01', -436.5, 306, 1.4);
    place('wooden_crate_01', -497, 309.5, 0.2);
    for (const p of this.lanterns.slice(0, 9)) place('wooden_lantern_01', p.x, p.z, 0, p.y - 0.4, 0.9);
  }

  update(t: number, probe: (i: number) => [number, number, number]) {
    villageU.time.value = t;
    this.updateBoats(t, probe);
  }
}

// ---------------------------------------------------------------- materials and boat geometry
function netMaterial() {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'net';
  const U = uv();
  const gx = abs(fract(U.x.add(U.y.mul(0.5))).sub(0.5)), gy = abs(fract(U.x.sub(U.y.mul(0.5))).sub(0.5));
  const line = max(smoothstep(0.42, 0.47, gx), smoothstep(0.42, 0.47, gy));
  m.colorNode = vec4(vec3(0.42, 0.45, 0.4).mul(mix(float(1), float(0.7), wetness.rain)), 1);
  m.opacityNode = line;
  m.alphaTest = 0.5;
  m.side = THREE.DoubleSide;
  m.roughnessNode = float(0.9);
  // the net stirs in the wind
  m.positionNode = Fn(() => positionLocal.add(vec3(0, 0, sin(villageU.time.mul(1.7).add(positionLocal.x.mul(0.8))).mul(0.03).mul(wetness.wind.add(0.3)))))();
  void min; void attribute;
  return m;
}

interface BoatPart { geometry: THREE.BufferGeometry; material: THREE.Material; painted: boolean }

/** a planked outrigger canoe: lofted hull (painted outside, raw wood inside), seats, outrigger booms and float */
function boatHull(): BoatPart[] {
  const L = 6.2, B = 1.05, Dp = 0.62;
  const sections = 26, around = 14;
  const pos: number[] = [], uvs: number[] = [], idx: number[] = [], cols: number[] = [];
  const inner: number[] = [], innerUv: number[] = [], innerIdx: number[] = [];
  for (let i = 0; i <= sections; i++) {
    const t = i / sections;
    const zz = (t - 0.5) * L;
    // beam and depth taper to the pointed ends
    const k = Math.pow(Math.sin(Math.PI * t), 0.65);
    const sheer = 0.18 * Math.pow(Math.abs(t - 0.5) * 2, 2.2);
    for (let a = 0; a <= around; a++) {
      const u = a / around;
      const ang = Math.PI * u;
      // U-shaped section: from gunwale (u=0) down round the keel to the other gunwale (u=1)
      const x = Math.cos(ang) * B * 0.5 * k;
      const y = -Math.sin(ang) * Dp * (0.35 + 0.65 * k) + Dp * 0.55 + sheer;
      pos.push(x, y, zz);
      uvs.push(zz / 1.4, u * 1.6);
      cols.push(1, 1, 1);
      inner.push(x * 0.93, y + 0.02, zz * 0.995);
      innerUv.push(zz / 1.4, u * 1.6);
    }
  }
  const ring = around + 1;
  for (let i = 0; i < sections; i++) for (let a = 0; a < around; a++) {
    const p = i * ring + a, q = p + ring;
    idx.push(p, q, p + 1, p + 1, q, q + 1);
    innerIdx.push(p, p + 1, q, p + 1, q + 1, q);
  }
  const outer = new THREE.BufferGeometry();
  outer.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  outer.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  outer.setIndex(idx);
  outer.computeVertexNormals();
  const innerG = new THREE.BufferGeometry();
  innerG.setAttribute('position', new THREE.Float32BufferAttribute(inner, 3));
  innerG.setAttribute('uv', new THREE.Float32BufferAttribute(innerUv, 2));
  innerG.setIndex(innerIdx);
  innerG.computeVertexNormals();
  // seats, booms, the float
  const kb = new KitBuilder();
  const wood = pbr('wood', { vcolor: true, key: 'boatwood' });
  kb.add(wood, innerG);
  for (const zz of [-1.3, 0.2, 1.5]) kb.add(wood, box(B * 0.85, 0.05, 0.28, V(0, 0.42, zz), [0, 0, 0], 1.0, 0.85));
  for (const zz of [-1.0, 1.0]) kb.add(wood, cylinder(0.045, 0.045, 2.6, V(1.15, 0.62, zz), [0, 0, Math.PI / 2], 6, 1, 0.8));
  kb.add(wood, cylinder(0.11, 0.11, 4.2, V(2.3, 0.08, 0), [Math.PI / 2, 0, 0], 8, 1.2, 0.75));
  // an oar laid across
  kb.add(wood, box(0.06, 0.03, 2.4, V(-0.15, 0.48, -0.4), [0, 0.35, 0.05], 1, 0.9));
  const g = new THREE.Group();
  kb.build(g);
  const extra = g.children[0] as THREE.Mesh;
  const paintMat = new THREE.MeshStandardNodeMaterial();
  paintMat.name = 'boat_paint';
  // painted planks (the instance colour multiplies): plank seams and a worn band at the waterline
  const seam = smoothstep(0.035, 0.0, abs(fract(uv().y.mul(5)).sub(0.5)).sub(0.46).max(0));
  const wear = smoothstep(1.35, 1.6, uv().y).mul(0.35);
  paintMat.colorNode = vec4(vec3(0.86).mul(float(1).sub(seam.mul(0.25))).mul(float(1).sub(wear)).mul(mix(float(1), float(0.75), wetness.rain)), 1);
  paintMat.roughnessNode = float(0.55);
  paintMat.metalnessNode = float(0);
  const parts: BoatPart[] = [{ geometry: outer, material: paintMat, painted: true }];
  if (extra) parts.push({ geometry: extra.geometry, material: extra.material as THREE.Material, painted: false });
  void cols;
  return parts;
}
