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
import { instancedMesh } from '../core/instancing';
import {
  float, fract, smoothstep, uv, vec4, vec3, abs, min, max, attribute, mix, positionLocal, sin, uniform, Fn,
  uniformArray, instanceIndex, vec2, length, pow, positionWorld, type N,
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
  /** lit openings (windows, doorways): centre, the way they face, size, brightness */
  private glows: { p: THREE.Vector3; yaw: number; w: number; h: number; k: number }[] = [];
  /** the warm lights of the night: lanterns at the busiest huts, the communal house, the fire */
  private lamps: { light: THREE.PointLight; base: number; phase: number }[] = [];
  private firePos = new THREE.Vector3();
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
    this.lifeProps(kb);
    kb.build(this.group);
    this.buildNight();
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
    // the lamp-lit inside seen through the windows and the doorway at night
    for (const side of [-1, 1]) this.glows.push({ p: W(side * (hw - 0.07), F + 0.06 + 1.3, 0), yaw: h.rot + side * Math.PI / 2, w: h.d * 0.12, h: 0.8, k: 1 });
    this.glows.push({ p: W(0, F + 0.06 + 1.0, hd - 0.07), yaw: h.rot, w: 0.9, h: 2.0, k: 0.75 });
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
    // thick thatched hip roof on a ring beam
    const top = g0 + 0.3 + H;
    for (const lz of [-D / 2, D / 2]) kb.add(post, box(W + 0.3, 0.18, 0.18, P(0, top - 0.09, lz), [0, rot, 0], 1.5, 0.75));
    for (const lx of [-W / 2, W / 2]) kb.add(post, box(0.18, 0.18, D + 0.3, P(lx, top - 0.09, 0), [0, rot, 0], 1.5, 0.75));
    hipRoof(kb, thatch, P, top, W, D, 2.4, 0.9, 0.32);
    // benches and a low table inside
    for (const lz of [-1.6, 1.6]) kb.add(floor, box(4.5, 0.08, 0.4, P(0, g0 + 0.75, lz), [0, rot, 0], 1.4, 0.8));
    kb.add(floor, box(2.4, 0.08, 1.1, P(0, g0 + 0.95, 0), [0, rot, 0], 1.4, 0.75));
    this.lanterns.push(P(0, g0 + 0.3 + H - 0.2, 0));
  }

  // ---------------------------------------------------------------- docks
  private dock(kb: KitBuilder, x0: number, z0: number, x1: number, z1: number, w: number, y: number, tee: boolean) {
    const deck = pbr('planks_grey', { vcolor: true, key: 'dockdeck' });
    const post = pbr('wood', { vcolor: true, key: 'dockpost' });
    if (!(post as unknown as { _wet?: boolean })._wet) {
      // the posts dark and green with weed below the high-water mark, bleached above it
      (post as unknown as { _wet: boolean })._wet = true;
      post.colorNode = (post.colorNode as N).mul(vec4(mix(vec3(0.28, 0.34, 0.24), vec3(1.0), smoothstep(-0.15, 0.45, positionWorld.y)), 1));
    }
    const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz);
    const ux = dx / L, uz = dz / L;
    const rot = Math.atan2(ux, uz);
    const r = new Rng(Math.round(x0 * 7 + z0));
    // planks across, each its own width, gap, warp and weathering (silver-grey to brown), not one board repeated
    for (let s = 0.1; s < L - 0.1;) {
      const bw = r.range(0.15, 0.27);
      const t = (s + bw / 2) / L;
      s += bw + r.range(0.012, 0.028);
      const px = x0 + dx * t, pz = z0 + dz * t;
      const gy = this.ground(px, pz);
      const yy = Math.max(y, gy + 0.25) + r.range(-0.012, 0.012);
      kb.add(deck, box(w + r.range(-0.06, 0.1), 0.038, bw, V(px + r.range(-0.03, 0.03), yy, pz), [r.range(-0.012, 0.012), rot + r.range(-0.012, 0.012), r.range(-0.018, 0.018)], 1.2, r.range(0.55, 1.05)));
    }
    // stringers and posts
    for (const side of [-1, 1]) {
      const ox = -uz * side * (w / 2 - 0.12), oz = ux * side * (w / 2 - 0.12);
      kb.add(post, box(0.1, 0.16, L, V((x0 + x1) / 2 + ox, y - 0.1, (z0 + z1) / 2 + oz), [0, rot, 0], 1.5, 0.75));
      for (let s2 = 0; s2 <= L; s2 += 2.4) {
        const px = x0 + ux * s2 + ox + r.range(-0.08, 0.08), pz = z0 + uz * s2 + oz + r.range(-0.08, 0.08);
        const gy = this.ground(px, pz);
        const bottom = Math.min(gy, -0.2) - 0.6;
        const top = y + (s2 % 4.8 < 0.1 ? 0.9 : 0.15) + r.range(-0.06, 0.1);
        // crooked round poles of mixed thickness, leaning a little each their own way
        const rad = r.range(0.085, 0.15);
        kb.add(post, cylinder(rad * 0.9, rad, top - bottom, V(px, (top + bottom) / 2, pz), [r.range(-0.07, 0.07), 0, r.range(-0.07, 0.07)], 7, 1.2, r.range(0.55, 0.85)));
        if (top > y + 0.5) this.col.circle(px, pz, 0.14, bottom, top);
        // a diagonal brace to the next pair, alternating
        if (side === 1 && s2 + 2.4 <= L && Math.round(s2 / 2.4) % 2 === 0) {
          const qx = x0 + ux * (s2 + 1.2), qz = z0 + uz * (s2 + 1.2);
          kb.add(post, box(0.07, 0.14, w + 0.1, V(qx, y - 0.55, qz), [0.42 * (Math.round(s2 / 4.8) % 2 ? 1 : -1), rot + Math.PI / 2, 0], 1.2, 0.65));
        }
      }
    }
    // rope railing on one side of the outer half
    const pts: THREE.Vector3[] = [];
    for (let s2 = L * 0.35; s2 <= L; s2 += 2.4) pts.push(V(x0 + ux * s2 - uz * (w / 2 - 0.12), y + 0.82 - (s2 % 4.8 < 0.1 ? 0 : 0.12), z0 + uz * s2 + ux * (w / 2 - 0.12)));
    if (pts.length > 2) kb.add(flat([0.24, 0.2, 0.15], 0.95), tubeGeo(pts, 0.022, 5));
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

  /** signs of the people who live here: mooring lines, washing on a line, the firewood by the fire */
  private lifeProps(kb: KitBuilder) {
    const r = new Rng(901);
    const rope = flat([0.55, 0.47, 0.34], 0.95);
    // a rope sagging between two points (a catenary is a parabola at this sag)
    const sagLine = (a: THREE.Vector3, b: THREE.Vector3, sag: number, rad: number) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        pts.push(a.clone().lerp(b, t).add(V(0, -sag * 4 * t * (1 - t), 0)));
      }
      kb.add(rope, tubeGeo(pts, rad, 4));
    };
    // mooring lines: each moored canoe's bow to a post of the nearest jetty (the canoes ride to them)
    const posts = [...[-451.0, -453.0].flatMap((px) => Array.from({ length: 23 }, (_, i) => V(px, 1.62, 334 + i * 2.4))),
      ...[-399.2, -400.8].flatMap((px) => Array.from({ length: 14 }, (_, i) => V(px + i * 0.25 * 0.25, 1.5, 340 + i * 2.4)))];
    for (const b of [{ x: -445.3, z: 357, rot: 0.08 }, { x: -458.8, z: 368, rot: -0.12 }, { x: -445.5, z: 378, rot: 0.15 }, { x: -459, z: 391, rot: 0.05 }, { x: -392, z: 362, rot: 0.2 }]) {
      const bow = V(b.x + Math.sin(b.rot) * 2.9, 0.62, b.z + Math.cos(b.rot) * 2.9);
      let best = posts[0], bd = Infinity;
      for (const p of posts) {
        const d = p.distanceTo(bow);
        if (d < bd) { bd = d; best = p; }
      }
      sagLine(bow, best, Math.min(0.6, 0.12 + bd * 0.06), 0.014);
    }
    // washing on a line between two poles in front of the huts
    const pole = pbr('wood', { vcolor: true, key: 'villagepole' });
    const a = V(-487, 0, 314), b = V(-473, 0, 311);
    const ga = this.ground(a.x, a.z), gb = this.ground(b.x, b.z);
    for (const [p, g] of [[a, ga], [b, gb]] as [THREE.Vector3, number][]) kb.add(pole, cylinder(0.045, 0.055, 2.3, V(p.x, g + 1.15, p.z), [r.range(-0.04, 0.04), 0, r.range(-0.04, 0.04)], 6, 1, 0.75));
    const top = (p: THREE.Vector3, g: number) => V(p.x, g + 2.2, p.z);
    sagLine(top(a, ga), top(b, gb), 0.28, 0.008);
    const cloths: [number, number, number][] = [[0.72, 0.12, 0.1], [0.92, 0.88, 0.8], [0.12, 0.32, 0.6], [0.85, 0.62, 0.15], [0.3, 0.55, 0.42], [0.9, 0.9, 0.88], [0.55, 0.2, 0.45]];
    const run = b.clone().sub(a), len = Math.hypot(run.x, run.z), rotY = Math.atan2(run.x, run.z) + Math.PI / 2;
    for (let s = 0.9; s < len - 0.7; s += r.range(0.75, 1.2)) {
      const t = s / len;
      const lineY = THREE.MathUtils.lerp(ga, gb, t) + 2.2 - 0.28 * 4 * t * (1 - t);
      const cw = r.range(0.45, 0.75), ch = r.range(0.5, 0.95);
      const c = r.pick(cloths);
      kb.add(flat(c, 0.9), box(cw, ch, 0.012, V(a.x + run.x * t, lineY - ch / 2 - 0.02, a.z + run.z * t), [r.range(-0.05, 0.05), rotY + r.range(-0.15, 0.15), r.range(-0.04, 0.04)], 1, r.range(0.8, 1)));
    }
    // a stack of split firewood beside the fire pit
    const logs = pbr('wood', { vcolor: true, key: 'firewood' });
    const fx = -480.2, fz = 333.2, fg = this.ground(fx, fz);
    for (let row = 0; row < 4; row++) for (let i = 0; i < 5 - row; i++) {
      kb.add(logs, cylinder(r.range(0.05, 0.075), r.range(0.05, 0.075), r.range(0.75, 1.0), V(fx + (i - (4 - row) / 2) * 0.15 + r.range(-0.02, 0.02), fg + 0.07 + row * 0.12, fz + r.range(-0.06, 0.06)), [Math.PI / 2 + r.range(-0.08, 0.08), 0.6 + r.range(-0.1, 0.1), 0], 6, 1, r.range(0.55, 0.9)));
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
      { x: -459, z: 391, rot: 0.05, moored: true, probe: 4, paint: 3 },
      { x: -392, z: 362, rot: 0.2, moored: true, probe: 5, paint: 4 },
      // pulled up on the sand in a row, bows to the sea
      { x: -500, z: 342, rot: 2.85, moored: false, probe: -1, paint: 1 },
      { x: -486, z: 345, rot: 2.95, moored: false, probe: -1, paint: 0 },
      { x: -514, z: 341, rot: 2.75, moored: false, probe: -1, paint: 3 },
      { x: -528, z: 339, rot: 2.9, moored: false, probe: -1, paint: 4 },
      { x: -372, z: 352, rot: -2.4, moored: false, probe: -1, paint: 2 },
    ];
    this.boats.push(...defs);
    for (const part of hull) {
      const im = instancedMesh(part.geometry, part.material, defs.length);
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      im.name = 'boats';
      for (let i = 0; i < defs.length; i++) im.setColorAt(i, new THREE.Color(...(part.painted ? paints[defs[i].paint] : [1, 1, 1]) as [number, number, number]));
      this.group.add(im);
      this.boatMeshes.push(im);
    }
    // the sea stays out of the boats: a depth-only lid across each hull just above its waterline, drawn after the
    // hull and before the sea (the sea is transparent, so it comes later and fails the depth test inside the hull)
    const lidMat = new THREE.MeshBasicNodeMaterial();
    lidMat.name = 'boat_waterlid';
    lidMat.colorWrite = false;
    lidMat.depthWrite = true;
    lidMat.side = THREE.DoubleSide;
    const lid = instancedMesh(hullLid(-0.17), lidMat, defs.length);
    lid.name = 'boat_waterlid';
    lid.castShadow = false;
    lid.receiveShadow = false;
    lid.frustumCulled = false;
    lid.renderOrder = 2;
    this.group.add(lid);
    this.boatMeshes.push(lid);
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
        // riding the swell, about 8 cm down (the keel is 0.28 m under the hull's origin)
        const heave = d[1] * 0.85 + Math.sin(t * 1.1 + i * 1.7) * 0.02 + 0.2;
        const roll = Math.sin(t * 0.9 + i * 2.1) * 0.04 + d[0] * 0.03;
        const pitch = Math.sin(t * 0.7 + i) * 0.02 + d[2] * 0.02;
        q.setFromEuler(new THREE.Euler(pitch, b.rot + Math.sin(t * 0.15 + i) * 0.04, roll));
        m.compose(V(b.x, heave, b.z), q, V(1, 1, 1));
      } else m.copy(this.boatBase[i]);
      for (const im of this.boatMeshes) im.setMatrixAt(i, m);
    }
    for (const im of this.boatMeshes) {
      im.instanceMatrix.clearUpdateRanges();
      im.instanceMatrix.addUpdateRange(0, this.boats.length * 16);
      im.instanceMatrix.needsUpdate = true;
    }
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
    this.firePos.set(x, g + 0.15, z);
    this.col.circle(x, z, 0.9, g - 1, g + 0.4);
  }

  /**
   * Night: the insides of the huts lamp-lit behind their windows and doorways, a glow round every lantern, real warm
   * point lights at the fire, the communal house and the front huts (pools of light on the sand and the walls, and
   * broken streaks on the water through the sea's own glints), flames and embers in the pit, smoke by day and night.
   * Everything scales with `villageU.lights` (0 by day, 1 at night); the lights exist all the time (at zero
   * intensity by day) so no shader ever recompiles at dusk.
   */
  private buildNight() {
    const L = villageU.lights, t = villageU.time;
    const warm = vec3(1.0, 0.52, 0.2);
    // ---- lit openings
    const geo = new THREE.PlaneGeometry(1, 1);
    const gm = new THREE.MeshBasicNodeMaterial();
    gm.name = 'village_glow';
    gm.side = THREE.DoubleSide;
    const flick = sin(t.mul(9.1).add(positionLocal.x.mul(30))).mul(0.04).add(sin(t.mul(3.7)).mul(0.03)).add(1);
    // brighter low in the opening (the lamp stands on the floor), a little cooler at the top
    const v = uv().y;
    gm.colorNode = vec4(mix(warm, vec3(0.9, 0.6, 0.35), v).mul(mix(float(1.2), float(0.6), v)).mul(flick).mul(L).mul(0.05), 1);
    const glow = instancedMesh(geo, gm, this.glows.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    this.glows.forEach((g, i) => {
      q.setFromAxisAngle(up, g.yaw);
      glow.setMatrixAt(i, m4.compose(g.p, q, new THREE.Vector3(g.w, g.h, 1)));
    });
    glow.name = 'village_windows';
    this.group.add(glow);
    // ---- lantern glows: a hot core and a soft halo, camera-facing
    const pos = this.lanterns.slice(0, 16);
    const arr = uniformArray(pos.map((p) => new THREE.Vector3(p.x, p.y, p.z)), 'vec3');
    for (const [size, k] of [[0.28, 1.0], [1.6, 0.12]] as [number, number][]) {
      const sm = new THREE.SpriteNodeMaterial();
      sm.transparent = true;
      sm.depthWrite = false;
      sm.blending = THREE.AdditiveBlending;
      sm.positionNode = arr.element(instanceIndex);
      sm.scaleNode = vec2(size, size);
      const r = length(uv().sub(0.5)).mul(2);
      const a = smoothstep(1.0, 0.0, r).pow(size < 1 ? 1.5 : 2.6);
      const fl = sin(t.mul(11).add(float(instanceIndex).mul(2.3))).mul(0.06).add(1);
      sm.colorNode = vec4(warm.mul(a).mul(fl).mul(L).mul(k * 0.6), 1);
      const sp = new THREE.Sprite(sm);
      (sp as unknown as { count: number }).count = pos.length;
      sp.frustumCulled = false;
      sp.renderOrder = 30;
      sp.name = 'village_lantern_glow';
      this.group.add(sp);
    }
    // ---- real lights at the fire, the communal house and the front huts
    const pick = [pos.length - 1, pos.length - 2, 1, 2, 3, 4].filter((i) => i >= 0 && i < pos.length);
    for (const [n, i] of pick.entries()) {
      const fire = i === pos.length - 1;
      // no range cutoff: the falloff is inverse-square, so a lamp still reaches the water tens of metres out, where
      // the sea's glints draw its reflection as a long broken streak toward the viewer
      const light = new THREE.PointLight(fire ? 0xff8a3a : 0xffa560, 0, 0, 2);
      light.position.copy(pos[i]).add(new THREE.Vector3(0, fire ? 0.6 : 0, 0));
      light.castShadow = false;
      this.group.add(light);
      this.lamps.push({ light, base: fire ? 26 : 5, phase: n * 1.7 });
    }
    // ---- the fire: flames, embers and smoke
    const fp = this.firePos;
    const flame = new THREE.SpriteNodeMaterial();
    flame.transparent = true;
    flame.depthWrite = false;
    flame.blending = THREE.AdditiveBlending;
    {
      const id = float(instanceIndex);
      const seed = (k: number) => fract(sin(id.mul(k).add(1.3)).mul(43758.5453));
      const life = float(0.55).add(seed(3.1).mul(0.5));
      const age = fract(t.div(life).add(seed(7.7)));
      const sway = sin(t.mul(2.3).add(seed(5.1).mul(6))).mul(0.12).mul(age);
      flame.positionNode = vec3(fp.x, fp.y, fp.z).add(vec3(seed(1.9).sub(0.5).mul(0.6).add(sway), age.mul(age.mul(0.3).add(0.9)), seed(2.9).sub(0.5).mul(0.6)));
      const size = mix(float(0.55), float(0.12), age).mul(seed(4.4).mul(0.5).add(0.75));
      flame.scaleNode = vec2(size, size.mul(1.6));
      const r = length(uv().sub(0.5).mul(vec2(1, 0.8))).mul(2);
      const hot = mix(vec3(1.0, 0.85, 0.45), vec3(1.0, 0.32, 0.05), age);
      flame.colorNode = vec4(hot.mul(smoothstep(1.0, 0.1, r)).mul(float(1).sub(age)).mul(mix(float(0.15), float(1), L)).mul(0.9), 1);
    }
    const flames = new THREE.Sprite(flame);
    (flames as unknown as { count: number }).count = 26;
    flames.frustumCulled = false;
    flames.renderOrder = 31;
    flames.name = 'village_fire';
    this.group.add(flames);
    const smoke = new THREE.SpriteNodeMaterial();
    smoke.transparent = true;
    smoke.depthWrite = false;
    {
      const id = float(instanceIndex);
      const seed = (k: number) => fract(sin(id.mul(k).add(7.3)).mul(43758.5453));
      const life = float(7).add(seed(3.1).mul(5));
      const age = fract(t.div(life).add(seed(7.7)));
      const tt = age.mul(life);
      const wd = wetness.windDir.mul(wetness.wind.mul(1.4).add(0.35)).mul(tt);
      smoke.positionNode = vec3(fp.x, fp.y + 0.8, fp.z).add(vec3(wd.x.add(seed(1.9).sub(0.5).mul(tt).mul(0.25)), tt.mul(0.7).add(tt.mul(tt).mul(0.01)), wd.y.add(seed(2.9).sub(0.5).mul(tt).mul(0.25))));
      const size = mix(float(0.6), float(5.5), pow(age, 0.7));
      smoke.scaleNode = vec2(size, size);
      const r = length(uv().sub(0.5)).mul(2);
      const a = smoothstep(1.0, 0.0, r).pow(1.8).mul(smoothstep(0.0, 0.08, age)).mul(pow(float(1).sub(age), 1.5)).mul(0.22);
      // grey-blue wood smoke, lit a little from below by the fire at night
      smoke.colorNode = vec4(mix(vec3(0.5, 0.52, 0.55), vec3(0.9, 0.5, 0.25), L.mul(float(1).sub(age).pow(3)).mul(0.6)).mul(0.06), a);
      smoke.opacityNode = a;
    }
    const smk = new THREE.Sprite(smoke);
    (smk as unknown as { count: number }).count = 34;
    smk.frustumCulled = false;
    smk.renderOrder = 29;
    smk.name = 'village_smoke';
    this.group.add(smk);
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

  update(t: number, probe: (i: number) => [number, number, number], night = 0) {
    villageU.time.value = t;
    const lit = THREE.MathUtils.smoothstep(night, 0.25, 0.8);
    villageU.lights.value = lit;
    for (const l of this.lamps) {
      const fl = 0.86 + 0.08 * Math.sin(t * 7.3 + l.phase) + 0.06 * Math.sin(t * 17.1 + l.phase * 2.1);
      l.light.intensity = l.base * lit * fl;
    }
    this.updateBoats(t, probe);
  }
}

/**
 * A thick hip roof over a W x D plan (W >= D), eaves `over` past the walls, ridge `rise` above the wall top `y0`.
 * `P(lx, y, lz)` maps plan-local coordinates to world. Top and underside surfaces, eave fascias, ridge and hip bundles.
 */
function hipRoof(kb: KitBuilder, mat: THREE.Material, P: (lx: number, y: number, lz: number) => THREE.Vector3, y0: number, W: number, D: number, rise: number, over: number, thick: number) {
  const slope = rise / (D / 2);
  const A = W / 2 + over, B = D / 2 + over, R = (W - D) / 2;
  const ye = y0 - over * slope, yr = y0 + rise;
  const faces: [number, number, number][][] = [
    [[-A, ye, B], [A, ye, B], [R, yr, 0], [-R, yr, 0]],
    [[A, ye, -B], [-A, ye, -B], [-R, yr, 0], [R, yr, 0]],
    [[A, ye, B], [A, ye, -B], [R, yr, 0]],
    [[-A, ye, -B], [-A, ye, B], [-R, yr, 0]],
  ];
  const tile = 1.4;
  const poly = (pts: THREE.Vector3[], shade: number, flip: boolean) => {
    const e = pts[1].clone().sub(pts[0]).normalize();
    const n = pts[2].clone().sub(pts[0]).cross(e).normalize();
    const d = n.clone().cross(e);
    const pos: number[] = [], uvs: number[] = [];
    for (let i = 1; i + 1 < pts.length; i++) {
      const tri = flip ? [pts[0], pts[i + 1], pts[i]] : [pts[0], pts[i], pts[i + 1]];
      for (const p of tri) {
        const q = p.clone().sub(pts[0]);
        pos.push(p.x, p.y, p.z);
        uvs.push(q.dot(d) / tile, q.dot(e) / tile);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(pos.length).fill(shade), 3));
    g.computeVertexNormals();
    kb.add(mat, g);
  };
  for (const f of faces) {
    const topPts = f.map(([x, y, z]) => P(x, y, z));
    const under = f.map(([x, y, z]) => P(x, y - thick, z));
    // the winding computeVertexNormals reads: n = (c - b) x (a - b)
    const up = topPts[2].clone().sub(topPts[1]).cross(topPts[0].clone().sub(topPts[1])).y > 0;
    poly(topPts, 0.95, !up);
    poly(under, 0.55, up);
  }
  // eave fascias: the thatch edge all round
  const ring: [number, number][] = [[-A, B], [A, B], [A, -B], [-A, -B]];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % 4];
    poly([P(ax, ye, az), P(bx, ye, bz), P(bx, ye - thick, bz), P(ax, ye - thick, az)], 0.7, true);
  }
  // ridge and hip bundles
  const bundle = (a: [number, number, number], b: [number, number, number]) => kb.add(mat, tubeGeo([P(...a), P((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 0.02, (a[2] + b[2]) / 2), P(...b)], 0.13, 7, 0.8));
  bundle([-R - 0.1, yr + 0.04, 0], [R + 0.1, yr + 0.04, 0]);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) bundle([sx * R, yr + 0.03, 0], [sx * A, ye + 0.03, sz * B]);
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

const HULL = { L: 6.2, B: 1.05, Dp: 0.62, sections: 26 };

/** the hull's inside cut flat at height y (boat space): the outline of its inner skin there, as a triangle strip */
function hullLid(y: number): THREE.BufferGeometry {
  const { L, B, Dp, sections } = HULL;
  const pos: number[] = [], idx: number[] = [];
  for (let i = 0; i <= sections; i++) {
    const t = i / sections;
    const k = Math.pow(Math.sin(Math.PI * t), 0.65);
    const sheer = 0.18 * Math.pow(Math.abs(t - 0.5) * 2, 2.2);
    // where the U-section reaches height y: sin(ang) = (top - y) / depth; shallower than that at the ends: closed
    const s = (Dp * 0.55 + sheer - (y - 0.02)) / (Dp * (0.35 + 0.65 * k));
    const half = s >= 1 || k < 1e-3 ? 0 : Math.cos(Math.asin(Math.max(0, s))) * B * 0.5 * k * 0.93;
    pos.push(-half, y, (t - 0.5) * L, half, y, (t - 0.5) * L);
  }
  for (let i = 0; i < sections; i++) {
    const p = i * 2;
    idx.push(p, p + 2, p + 1, p + 1, p + 2, p + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

/** a planked outrigger canoe: lofted hull (painted outside, raw wood inside), seats, outrigger booms and float */
function boatHull(): BoatPart[] {
  const { L, B, Dp } = HULL;
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
