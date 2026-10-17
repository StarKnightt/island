/**
 * The lighthouse on the summit: a whitewashed masonry tower (hollow, 0.5 m walls) with a cast-iron spiral stair
 * climbing 3.25 turns inside it from the door at its foot to the watch room; a door in the watch room opens onto the
 * gallery, a stone deck on corbels with an iron railing. Above sits the lantern: an iron parapet, glazing between
 * mullions, the lens, and a red domed cap. A whitewashed keeper's house with a tiled gable roof stands beside it.
 * At night the lamp burns and two beams sweep the island and the sea.
 */
import * as THREE from 'three/webgpu';
import { KitBuilder, box, cylinder, pbr, flat, tubeGeo, poly, MeshAcc } from './kit';
import type { Heightfield } from './Heightfield';
import type { Colliders } from './Colliders';
import { LIGHTHOUSE } from './layout';
import { float, uniform, vec3, vec4, smoothstep, abs, positionLocal, length, mix, pow, max, cameraPosition, positionWorld, normalize, dot } from '../core/tsl';
import { atmo } from '../sky/Atmosphere';

export const lighthouseU = { angle: uniform(0), on: uniform(0) };

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const TAU = Math.PI * 2;
const angDiff = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

export class Lighthouse {
  readonly group = new THREE.Group();
  /** frames left in which the beam is drawn by day, so its pipeline compiles up front */
  prime = 0;
  readonly lampPos = new THREE.Vector3();
  /** top of the gallery deck (and the watch-room floor) */
  readonly galleryY: number;
  readonly baseY: number;
  /** angle (atan2(dz, dx)) of the door at the foot of the tower and of the gallery door */
  readonly doorA = -0.4;
  readonly galleryDoorA = 0.85;
  private beam!: THREE.Mesh;
  readonly lamp: THREE.PointLight;
  static readonly TOWER_H = 17;
  static readonly R0 = 2.7;
  static readonly R1 = 2.2;
  static readonly WALL = 0.5;
  /** watch room: inner / outer radius and height; gallery deck outer radius; railing radius */
  static readonly RWI = 1.7;
  static readonly RW = 2.05;
  static readonly WR_H = 2.5;
  static readonly RG = 3.3;
  static readonly RR = 3.18;
  /** stair: about 3.5 turns, set so the hole it climbs through lies opposite the gallery door */
  private turns = 3.5;
  private readonly steps = 92;
  private readonly stairW = 1.0;
  private aStart = 0;
  private x = 0;
  private z = 0;

  constructor(private hf: Heightfield, private col: Colliders) {
    this.group.name = 'lighthouse';
    const [x, z] = LIGHTHOUSE.p;
    this.x = x;
    this.z = z;
    this.baseY = hf.height(x, z);
    this.galleryY = this.baseY + Lighthouse.TOWER_H;
    // the lamp's own spill: faint (the lens throws its light into the beams, not onto the gallery)
    this.lamp = new THREE.PointLight(0xffd9a0, 0, 26, 2);
    this.aStart = this.doorA + 1.0;
    for (let it = 0; it < 4; it++) {
      const end = this.galleryDoorA + Math.PI + this.holeA / 2;
      this.turns = (((((end - this.aStart) % TAU) + TAU) % TAU) + 3 * TAU) / TAU;
    }
    this.build();
  }

  /** outer and inner radius of the tower wall at height y */
  ro(y: number) {
    return THREE.MathUtils.lerp(Lighthouse.R0, Lighthouse.R1, THREE.MathUtils.clamp((y - this.baseY) / Lighthouse.TOWER_H, 0, 1));
  }
  ri(y: number) {
    return this.ro(y) - Lighthouse.WALL;
  }
  private get floorY() {
    return this.baseY + 0.15;
  }
  private get rise() {
    return (this.galleryY - this.floorY) / this.steps;
  }
  private get total() {
    return this.turns * TAU;
  }
  /** angle where the stair arrives at the watch-room floor */
  private get aEnd() {
    return this.aStart + this.total;
  }
  /** the stair passes under the watch-room floor for this angle before its top (2.3 m of headroom) */
  private get holeA() {
    return 2.3 / ((this.galleryY - this.floorY) / this.total);
  }

  /** tread top under angle a (absolute, along the helix from aStart), or null off the stair */
  private treadY(aRel: number) {
    if (aRel < 0 || aRel >= this.total) return null;
    const i = Math.min(this.steps - 1, Math.floor((aRel / this.total) * this.steps));
    return this.floorY + (i + 1) * this.rise;
  }

  private build() {
    const { x, z } = this;
    const y0 = this.baseY, gy = this.galleryY;
    const kb = new KitBuilder();
    const kbGlass = new KitBuilder();
    const stucco = pbr('stucco', { vcolor: true, key: 'lh_stucco' });
    const stone = pbr('stone', { vcolor: true, key: 'lh_stone' });
    const red = pbr('rust', { vcolor: true, key: 'lh_red', tint: [1.25, 0.42, 0.34], roughMul: 0.8 });
    const iron = flat([0.035, 0.038, 0.04], 0.5, 0.55);
    const brass = flat([0.32, 0.24, 0.1], 0.35, 0.9);
    const winGlass = flat([0.03, 0.035, 0.04], 0.06, 0.0);
    // ---- plinth
    kb.add(stone, cylinder(Lighthouse.R0 + 0.55, Lighthouse.R0 + 0.7, 0.9, V(x, y0 - 0.1, z), [0, 0, 0], 32, 1.2, 0.85));
    // ---- the tower wall: door at the foot, small windows climbing with the stair
    const openings: Opening[] = [{ a: this.doorA, w: 1.05, y0: this.floorY, y1: this.floorY + 2.15, glass: false }];
    for (let k = 0; k < 6; k++) {
      // windows over the stair: one every ~half turn, staggered round the tower
      const s = (k + 0.7) / 6.6;
      const a = this.aStart + s * this.total - 0.25;
      const yy = this.floorY + s * (gy - this.floorY) + 0.9;
      openings.push({ a, w: 0.55, y0: yy, y1: yy + 0.95, glass: true });
    }
    roundWall(kb, kbGlass, stucco, winGlass, x, z, y0 + 0.35, gy - 0.32, (y) => this.ro(y), (y) => this.ri(y), 56, openings, 0.85,
      (y) => 0.82 + 0.18 * THREE.MathUtils.smoothstep(y, y0, y0 + 6));
    // door: a recessed painted plank door standing open into the tower, a stone threshold and lintel
    const doorWood = pbr('paint_wood', { vcolor: true, key: 'lh_door', tint: [0.5, 0.75, 0.9] });
    const da = this.doorA;
    // the leaf stands open, flat against the inside of the wall beside the opening
    const leafA = da - 0.62, leafR = this.ri(y0) - 0.05;
    kb.add(doorWood, box(0.95, 2.05, 0.06, V(x + Math.cos(leafA) * leafR, this.floorY + 1.03, z + Math.sin(leafA) * leafR), [0, -(leafA + Math.PI / 2), 0], 1.2, 0.9));
    kb.add(stone, box(0.62, 0.16, 1.2, V(x + Math.cos(da) * (this.ro(y0) - 0.15), this.floorY - 0.06, z + Math.sin(da) * (this.ro(y0) - 0.15)), [0, -da, 0], 1, 0.9));
    // ground floor inside (stone flags)
    kb.add(stone, disc(x, z, 0, this.ri(y0) + 0.02, this.floorY, 28, 1.1, 0.7));
    // ---- the cast-iron spiral stair along the inside of the wall
    this.stair(kb, iron, brass);
    // ---- corbels and the gallery deck
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * TAU;
      const rr = Lighthouse.R1 + 0.35;
      kb.add(stone, box(0.7, 0.55, 0.32, V(x + Math.cos(a) * rr, gy - 0.62, z + Math.sin(a) * rr), [0, -a, 0.35], 0.8, 0.8));
    }
    kb.add(stone, disc(x, z, Lighthouse.R1 - 0.3, Lighthouse.RG, gy, 48, 1.1, 0.9));
    kb.add(stone, disc(x, z, Lighthouse.R1 - 0.3, Lighthouse.RG, gy - 0.32, 48, 1.1, 0.55, true));
    kb.add(stone, cylinder(Lighthouse.RG, Lighthouse.RG - 0.12, 0.32, V(x, gy - 0.16, z), [0, 0, 0], 40, 1.1, 0.88));
    // a painted band under the deck's lip
    kb.add(red, cylinder(Lighthouse.RG + 0.01, Lighthouse.RG + 0.01, 0.12, V(x, gy - 0.26, z), [0, 0, 0], 40, 1, 0.9));
    // gallery railing: posts, a top rail and two lower rails
    const RR = Lighthouse.RR;
    const ringPts = (yy: number, r: number) => Array.from({ length: 65 }, (_, i) => V(x + Math.cos((i / 64) * TAU) * r, yy, z + Math.sin((i / 64) * TAU) * r));
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * TAU;
      kb.add(iron, cylinder(0.022, 0.026, 1.08, V(x + Math.cos(a) * RR, gy + 0.54, z + Math.sin(a) * RR), [0, 0, 0], 6, 1, 1));
    }
    kb.add(iron, tubeGeo(ringPts(gy + 1.08, RR), 0.035, 6));
    kb.add(iron, tubeGeo(ringPts(gy + 0.7, RR), 0.016, 5));
    kb.add(iron, tubeGeo(ringPts(gy + 0.35, RR), 0.016, 5));
    // ---- watch room: a lower round room on the tower top with a door onto the gallery
    const WR = Lighthouse.WR_H;
    roundWall(kb, kbGlass, stucco, winGlass, x, z, gy, gy + WR, () => Lighthouse.RW, () => Lighthouse.RWI, 40,
      [{ a: this.galleryDoorA, w: 0.95, y0: gy, y1: gy + 2.0, glass: false }, { a: this.galleryDoorA + Math.PI, w: 0.6, y0: gy + 1.0, y1: gy + 1.9, glass: true }], 0.85, () => 0.95);
    this.watchFloor(kb, stone, iron);
    // watch-room roof / lantern deck
    kb.add(stone, cylinder(Lighthouse.RW + 0.12, Lighthouse.RW + 0.12, 0.22, V(x, gy + WR + 0.11, z), [0, 0, 0], 40, 1.1, 0.85));
    kb.add(stone, disc(x, z, 0, Lighthouse.RW + 0.12, gy + WR + 0.225, 40, 1.1, 0.85));
    kb.add(stone, disc(x, z, 0, Lighthouse.RWI, gy + WR - 0.005, 32, 1.1, 0.5, true));
    // ---- lantern: parapet, glazing in mullions, lens and lamp, red dome, vent ball, lightning rod
    const LY = gy + WR + 0.22, LR = 1.45;
    kb.add(red, cylinder(LR + 0.06, LR + 0.08, 0.55, V(x, LY + 0.275, z), [0, 0, 0], 24, 1, 0.9));
    const glassMat = lanternGlass();
    const glazing = new THREE.CylinderGeometry(LR, LR, 1.95, 30, 1, true);
    glazing.translate(x, LY + 0.55 + 0.975, z);
    const gMesh = new THREE.Mesh(glazing, glassMat);
    gMesh.renderOrder = 6;
    gMesh.castShadow = false;
    this.group.add(gMesh);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU + 0.15;
      kb.add(iron, box(0.06, 2.0, 0.06, V(x + Math.cos(a) * LR, LY + 1.52, z + Math.sin(a) * LR), [0, -a, 0], 1, 1));
    }
    kb.add(iron, cylinder(LR + 0.05, LR + 0.05, 0.08, V(x, LY + 0.58, z), [0, 0, 0], 30, 1, 1));
    kb.add(iron, cylinder(LR + 0.05, LR + 0.05, 0.1, V(x, LY + 2.5, z), [0, 0, 0], 30, 1, 1));
    kb.add(iron, cylinder(LR + 0.03, LR + 0.03, 0.04, V(x, LY + 1.52, z), [0, 0, 0], 30, 1, 1));
    // the lens: stacked glass rings round the lamp, on a brass pedestal
    kb.add(brass, cylinder(0.2, 0.32, 0.65, V(x, LY + 0.88, z), [0, 0, 0], 12, 1, 1));
    const lensMat = lensMaterial();
    const lens = new THREE.Group();
    for (let k = 0; k < 9; k++) {
      const t = k / 8;
      const r = 0.5 - Math.abs(t - 0.5) * 0.22;
      const g = new THREE.CylinderGeometry(r, r - 0.03, 0.16, 24, 1, false);
      g.translate(x, LY + 1.25 + k * 0.155, z);
      const m = new THREE.Mesh(g, lensMat);
      m.castShadow = false;
      lens.add(m);
    }
    this.group.add(lens);
    // dome and vent
    const dome = new THREE.SphereGeometry(LR + 0.14, 28, 10, 0, TAU, 0, Math.PI / 2);
    dome.scale(1, 0.62, 1);
    dome.translate(x, LY + 2.55, z);
    dome.setAttribute('color', new THREE.BufferAttribute(new Float32Array(dome.getAttribute('position').count * 3).fill(0.95), 3));
    const duv = dome.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < duv.count; i++) duv.setXY(i, duv.getX(i) * 4, duv.getY(i) * 1.2);
    kb.add(red, dome);
    kb.add(red, cylinder(0.12, 0.18, 0.45, V(x, LY + 3.55, z), [0, 0, 0], 10, 1, 1));
    const ball = new THREE.SphereGeometry(0.22, 12, 8);
    ball.translate(x, LY + 3.9, z);
    ball.setAttribute('color', new THREE.BufferAttribute(new Float32Array(ball.getAttribute('position').count * 3).fill(1), 3));
    kb.add(red, ball);
    kb.add(iron, cylinder(0.015, 0.02, 1.4, V(x, LY + 4.7, z), [0, 0, 0], 4, 1, 1));
    // lantern catwalk rail on the watch-room roof
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * TAU;
      kb.add(iron, cylinder(0.015, 0.015, 0.62, V(x + Math.cos(a) * (Lighthouse.RW + 0.02), LY + 0.31, z + Math.sin(a) * (Lighthouse.RW + 0.02)), [0, 0, 0], 4, 1, 1));
    }
    kb.add(iron, tubeGeo(ringPts(LY + 0.62, Lighthouse.RW + 0.02), 0.022, 5));

    // ---- keeper's house
    this.keeper(kb, kbGlass, x - 6.2, z + 7.4, 0.55);
    kb.build(this.group);
    kbGlass.build(this.group, { castShadow: false });

    this.colliders();

    // ---- lamp and beams
    this.lampPos.set(x, LY + 1.85, z);
    this.lamp.position.copy(this.lampPos);
    this.group.add(this.lamp);
    const lampMat = new THREE.MeshBasicNodeMaterial();
    lampMat.colorNode = vec3(1.0, 0.84, 0.58).mul(lighthouseU.on.mul(220).add(0.6));
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 10), lampMat);
    bulb.position.copy(this.lampPos);
    bulb.castShadow = false;
    this.group.add(bulb);
    // two beams: long cones, additive, fading along their length and at the edges, seen only in haze
    const coneLen = 900;
    const cone = new THREE.ConeGeometry(60, coneLen, 24, 1, true);
    cone.translate(0, -coneLen / 2, 0);
    cone.rotateZ(Math.PI / 2);
    const bm = new THREE.MeshBasicNodeMaterial();
    bm.transparent = true;
    bm.depthWrite = false;
    bm.blending = THREE.AdditiveBlending;
    bm.side = THREE.DoubleSide;
    const along = positionLocal.x.div(coneLen).clamp(0, 1);
    const rad = length(positionLocal.yz).div(max(positionLocal.x.mul(60 / coneLen), 0.25));
    const core = pow(smoothstep(1.0, 0.0, rad), 2.0);
    const view = abs(dot(normalize(positionWorld.sub(cameraPosition)), normalize(positionWorld.sub(vec3(this.lampPos.x, this.lampPos.y, this.lampPos.z)))));
    const k = smoothstep(0.0, 0.015, along).mul(pow(float(1).sub(along), 2.2)).mul(core).mul(mix(float(1), float(0.3), view));
    bm.colorNode = vec4(vec3(1.0, 0.86, 0.62).mul(k).mul(lighthouseU.on).mul(float(0.25).add(atmo.mist.mul(9000))), 1);
    this.beam = new THREE.Mesh(cone, bm);
    const beam2 = new THREE.Mesh(cone, bm);
    beam2.rotation.y = Math.PI;
    this.beam.add(beam2);
    this.beam.position.copy(this.lampPos);
    this.beam.frustumCulled = false;
    beam2.frustumCulled = false;
    this.beam.renderOrder = 20;
    this.group.add(this.beam);
  }

  /** treads with risers, brackets into the wall, balusters and a handrail on the open (inner) side */
  private stair(kb: KitBuilder, iron: THREE.Material, brass: THREE.Material) {
    const { x, z } = this;
    const N = this.steps, da = this.total / N, W = this.stairW;
    const rail: THREE.Vector3[] = [], string: THREE.Vector3[] = [];
    for (let i = 0; i < N; i++) {
      const a0 = this.aStart + i * da, am = a0 + da / 2;
      const yTop = this.floorY + (i + 1) * this.rise;
      const ro = this.ri(yTop) + 0.02, rin = ro - W, rm = (ro + rin) / 2;
      const arc = da * rm * 1.12;
      kb.add(iron, box(W, 0.05, arc, V(x + Math.cos(am) * rm, yTop - 0.025, z + Math.sin(am) * rm), [0, -am, 0], 1, 0.75));
      // riser plate at the front edge of the tread
      kb.add(iron, box(W * 0.98, this.rise, 0.015, V(x + Math.cos(a0) * rm, yTop - this.rise / 2 - 0.02, z + Math.sin(a0) * rm), [0, -a0, 0], 1, 0.6));
      if (i % 2 === 0) {
        const rb = rin + 0.04;
        kb.add(iron, cylinder(0.013, 0.013, 0.92, V(x + Math.cos(am) * rb, yTop + 0.46, z + Math.sin(am) * rb), [0, 0, 0], 4, 1, 1));
      }
      rail.push(V(x + Math.cos(am) * (rin + 0.04), yTop + 0.93, z + Math.sin(am) * (rin + 0.04)));
      string.push(V(x + Math.cos(am) * (rin + 0.03), yTop - 0.12, z + Math.sin(am) * (rin + 0.03)));
    }
    kb.add(brass, tubeGeo(rail, 0.024, 6));
    kb.add(iron, tubeGeo(string, 0.05, 5, 0.7));
    // a rope rail on the wall side
    const wallRail = rail.map((p, i) => {
      const am = this.aStart + (i + 0.5) * da;
      const rr = this.ri(p.y) - 0.07;
      return V(x + Math.cos(am) * rr, p.y - 0.05, z + Math.sin(am) * rr);
    });
    kb.add(brass, tubeGeo(wallRail, 0.018, 5, 0.8));
  }

  /** the watch-room floor: a stone disc with the stair hole, railed round the hole */
  private watchFloor(kb: KitBuilder, stone: THREE.Material, iron: THREE.Material) {
    const { x, z } = this;
    const gy = this.galleryY;
    const RWI = Lighthouse.RWI, rIn = RWI - this.stairW - 0.02;
    const acc = new MeshAcc();
    const a0 = this.aEnd, a1 = this.aEnd + TAU - this.holeA;
    const seg = 28;
    const up = V(0, 1, 0), down = V(0, -1, 0);
    const P = (a: number, r: number, y: number) => V(x + Math.cos(a) * r, y, z + Math.sin(a) * r);
    const uvOf = (p: THREE.Vector3): [number, number] => [p.x / 1.1, p.z / 1.1];
    for (let i = 0; i < seg; i++) {
      const aa = a0 + ((a1 - a0) * i) / seg, ab = a0 + ((a1 - a0) * (i + 1)) / seg;
      for (const [y, n] of [[gy, up], [gy - 0.18, down]] as const) {
        const q = [P(aa, rIn, y), P(ab, rIn, y), P(ab, RWI + 0.02, y), P(aa, RWI + 0.02, y)];
        acc.quad(q[0], q[1], q[2], q[3], n, q.map(uvOf), y === gy ? 0.8 : 0.5);
      }
    }
    // the centre over the well
    for (let i = 0; i < 24; i++) {
      const aa = (i / 24) * TAU, ab = ((i + 1) / 24) * TAU;
      for (const [y, n] of [[gy, up], [gy - 0.18, down]] as const) {
        const q = [P(aa, 0, y), P(ab, 0, y), P(ab, rIn, y), P(aa, rIn, y)];
        acc.quad(q[0], q[1], q[2], q[3], n, q.map(uvOf), y === gy ? 0.8 : 0.5);
      }
    }
    kb.add(stone, acc.geometry());
    // railing round the hole: along its inner edge and its lower end
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 12; i++) {
      const a = this.aEnd - this.holeA + (this.holeA * i) / 12;
      const p = P(a, rIn + 0.03, gy);
      pts.push(p.clone().setY(gy + 0.95));
      if (i % 2 === 0) kb.add(iron, cylinder(0.018, 0.018, 0.95, p.clone().setY(gy + 0.475), [0, 0, 0], 4, 1, 1));
    }
    const ae = this.aEnd - this.holeA;
    for (let i = 1; i <= 3; i++) {
      const p = P(ae, rIn + (i / 3) * (RWI - rIn - 0.05), gy);
      pts.unshift(p.clone().setY(gy + 0.95));
      kb.add(iron, cylinder(0.018, 0.018, 0.95, p.clone().setY(gy + 0.475), [0, 0, 0], 4, 1, 1));
    }
    kb.add(iron, tubeGeo(pts.reverse(), 0.025, 5));
  }

  private colliders() {
    const { x, z } = this;
    const y0 = this.baseY, gy = this.galleryY;
    const col = this.col;
    const doorGap = { a: this.doorA, half: 0.52 / this.ro(y0), y0: this.floorY, y1: this.floorY + 2.1 };
    // tower wall in bands (it tapers); the lowest band holds the door
    const yDoorTop = y0 + 2.6;
    col.ring(x, z, this.ri(y0 + 1) - 0.02, this.ro(y0) + 0.02, y0 - 1, yDoorTop, [doorGap]);
    const bands = 5;
    for (let k = 0; k < bands; k++) {
      const ya = yDoorTop + (k * (gy - yDoorTop)) / bands, yb = yDoorTop + ((k + 1) * (gy - yDoorTop)) / bands;
      const ym = (ya + yb) / 2;
      col.ring(x, z, this.ri(ym) - 0.02, this.ro(ym) + 0.02, ya, yb);
    }
    // plinth step, tower floor
    const R0 = Lighthouse.R0;
    col.surface({
      minX: x - R0 - 1, maxX: x + R0 + 1, minZ: z - R0 - 1, maxZ: z + R0 + 1, material: 'stone',
      height: (px, pz) => {
        const d = Math.hypot(px - x, pz - z);
        if (d < this.ri(y0)) return this.floorY;
        if (d < R0 + 0.62) return y0 + 0.35;
        return null;
      },
    });
    // the stair: every turn's tread under the walker, the highest not above maxY
    const W = this.stairW;
    col.surface({
      minX: x - R0, maxX: x + R0, minZ: z - R0, maxZ: z + R0, material: 'metal',
      height: (px, pz, maxY) => {
        const dx = px - x, dz = pz - z, d = Math.hypot(dx, dz);
        let a = Math.atan2(dz, dx) - this.aStart;
        a = ((a % TAU) + TAU) % TAU;
        let best: number | null = null;
        for (let k = 0; k <= Math.ceil(this.turns); k++) {
          const y = this.treadY(a + k * TAU);
          if (y === null || y > maxY + 1e-3) continue;
          const ro = this.ri(y) + 0.04;
          if (d < ro - W - 0.05 || d > ro) continue;
          if (best === null || y > best) best = y;
        }
        return best;
      },
    });
    // the well: posts along the inner edge of the stair so nobody walks off it
    const N = this.steps, da = this.total / N;
    for (let i = 0; i < N; i += 2) {
      const am = this.aStart + (i + 0.5) * da;
      const yTop = this.floorY + (i + 1) * this.rise;
      const rr = this.ri(yTop) + 0.02 - W - 0.02;
      col.circle(x + Math.cos(am) * rr, z + Math.sin(am) * rr, 0.09, yTop - 0.4, yTop + 1.2);
    }
    // watch-room floor (with the hole), its wall and door, the gallery deck and railing
    const RWI = Lighthouse.RWI, rIn = RWI - W - 0.02;
    col.surface({
      minX: x - Lighthouse.RG, maxX: x + Lighthouse.RG, minZ: z - Lighthouse.RG, maxZ: z + Lighthouse.RG, material: 'stone',
      height: (px, pz) => {
        const dx = px - x, dz = pz - z, d = Math.hypot(dx, dz);
        if (d > Lighthouse.RG) return null;
        if (d < RWI && d > rIn) {
          // inside the hole (the stair's last stretch under the floor)?
          const rel = angDiff(Math.atan2(dz, dx), this.aEnd);
          if (rel < 0 && rel > -this.holeA) return null;
        }
        return gy;
      },
    });
    for (let i = 0; i <= 12; i++) {
      const a = this.aEnd - this.holeA + (this.holeA * i) / 12;
      col.circle(x + Math.cos(a) * (rIn + 0.03), z + Math.sin(a) * (rIn + 0.03), 0.1, gy - 0.2, gy + 1.2);
    }
    for (let i = 1; i <= 3; i++) {
      const a = this.aEnd - this.holeA, r = rIn + (i / 3) * (RWI - rIn - 0.05);
      col.circle(x + Math.cos(a) * r, z + Math.sin(a) * r, 0.1, gy - 0.2, gy + 1.2);
    }
    col.ring(x, z, RWI - 0.02, Lighthouse.RW + 0.02, gy - 0.1, gy + Lighthouse.WR_H, [{ a: this.galleryDoorA, half: 0.47 / Lighthouse.RW, y0: gy, y1: gy + 2.0 }]);
    col.ring(x, z, Lighthouse.RR - 0.05, Lighthouse.RR + 0.05, gy - 0.3, gy + 1.15);
  }

  /** a whitewashed keeper's house: stone plinth, windows with shutters, a door, a tiled gable roof and a chimney */
  private keeper(kb: KitBuilder, kbGlass: KitBuilder, cx: number, cz: number, rot: number) {
    const hf = this.hf;
    const W = 6.4, D = 4.6, WH = 2.75, T = 0.36;
    const c = Math.cos(rot), s = Math.sin(rot);
    const g = Math.min(hf.height(cx, cz), hf.height(cx + 2.5 * c, cz - 2.5 * s), hf.height(cx - 2.5 * c, cz + 2.5 * s));
    const P = (lx: number, y: number, lz: number) => V(cx + lx * c + lz * s, y, cz - lx * s + lz * c);
    const walls = pbr('stucco', { vcolor: true, key: 'keeper_stucco' });
    const stone = pbr('stone', { vcolor: true, key: 'keeper_stone' });
    const tiles = pbr('roof_tiles', { vcolor: true, key: 'keeper_tiles' });
    const wood = pbr('wood', { vcolor: true, key: 'keeper_wood' });
    const paint = pbr('paint_wood', { vcolor: true, key: 'keeper_paint', tint: [0.45, 0.8, 0.7] });
    const glass = flat([0.025, 0.03, 0.035], 0.05, 0);
    const floor = g + 0.35;
    // plinth
    kb.add(stone, box(W + 0.25, 0.75, D + 0.25, P(0, g - 0.02, 0), [0, rot, 0], 1.2, 0.85));
    // walls with openings: along local x at lz = +-D/2 (front has the door), ends along z at lx = +-W/2
    type Op = { at: number; w: number; y0: number; y1: number; door?: boolean };
    const wallRun = (len: number, place: (t: number, y: number, depth: number) => THREE.Vector3, rotY: number, ops: Op[], shade: number) => {
      // pieces between openings, full height; above / below each opening
      const edges = [-len / 2, ...ops.flatMap((o) => [o.at - o.w / 2, o.at + o.w / 2]), len / 2];
      for (let i = 0; i + 1 < edges.length; i += 2) {
        const a = edges[i], b = edges[i + 1];
        if (b - a > 0.01) kb.add(walls, box(b - a, WH, T, place((a + b) / 2, floor + WH / 2, 0), [0, rotY, 0], 1.6, shade));
      }
      for (const o of ops) {
        if (o.y0 > 0.01) kb.add(walls, box(o.w, o.y0, T, place(o.at, floor + o.y0 / 2, 0), [0, rotY, 0], 1.6, shade));
        kb.add(walls, box(o.w, WH - o.y1, T, place(o.at, floor + (o.y1 + WH) / 2, 0), [0, rotY, 0], 1.6, shade));
        // frame, glass or door, sill, shutters
        kb.add(wood, box(o.w + 0.1, 0.08, T + 0.06, place(o.at, floor + o.y1 + 0.04, 0), [0, rotY, 0], 1, 0.8));
        if (o.door) {
          kb.add(paint, box(o.w - 0.04, o.y1 - 0.02, 0.06, place(o.at, floor + o.y1 / 2, -0.06), [0, rotY, 0], 1.2, 0.85));
          kb.add(stone, box(o.w + 0.3, 0.18, 0.5, place(o.at, floor - 0.26, T / 2 + 0.22), [0, rotY, 0], 1, 0.85));
        } else {
          kbGlass.add(glass, box(o.w - 0.04, o.y1 - o.y0 - 0.04, 0.02, place(o.at, floor + (o.y0 + o.y1) / 2, -0.08), [0, rotY, 0], 1, 1));
          kb.add(wood, box(0.05, o.y1 - o.y0, 0.05, place(o.at, floor + (o.y0 + o.y1) / 2, -0.07), [0, rotY, 0], 1, 0.8));
          kb.add(wood, box(o.w, 0.05, 0.05, place(o.at, floor + (o.y0 + o.y1) / 2, -0.07), [0, rotY, 0], 1, 0.8));
          kb.add(stone, box(o.w + 0.16, 0.07, T + 0.14, place(o.at, floor + o.y0 - 0.035, 0.04), [0, rotY, 0], 1, 0.9));
          for (const side of [-1, 1]) kb.add(paint, box(o.w / 2 + 0.02, o.y1 - o.y0 + 0.04, 0.04, place(o.at + side * (o.w * 0.78), floor + (o.y0 + o.y1) / 2, T / 2 + 0.05), [0, rotY + side * 0.12, 0], 1, 0.9));
        }
      }
    };
    const hw = W / 2, hd = D / 2;
    // front (+z) and back (-z)
    wallRun(W, (t, y, d) => P(t, y, hd - T / 2 + d * -1), rot, [{ at: -1.6, w: 0.8, y0: 0.95, y1: 2.0 }, { at: 0.35, w: 0.95, y0: 0, y1: 2.05, door: true }, { at: 1.85, w: 0.8, y0: 0.95, y1: 2.0 }], 0.95);
    wallRun(W, (t, y, d) => P(-t, y, -hd + T / 2 + d), rot + Math.PI, [{ at: -1.2, w: 0.8, y0: 0.95, y1: 2.0 }, { at: 1.3, w: 0.8, y0: 0.95, y1: 2.0 }], 0.85);
    // ends (+x, -x)
    wallRun(D - 2 * T, (t, y, d) => P(hw - T / 2 - d, y, -t), rot + Math.PI / 2, [{ at: 0, w: 0.7, y0: 1.0, y1: 1.95 }], 0.9);
    wallRun(D - 2 * T, (t, y, d) => P(-hw + T / 2 + d, y, t), rot - Math.PI / 2, [], 0.88);
    // corner quoins (stone)
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (let k = 0; k < 5; k++) {
      const yy = floor + 0.25 + k * 0.55;
      kb.add(stone, box(k % 2 ? 0.42 : 0.28, 0.24, k % 2 ? 0.28 : 0.42, P(sx * (hw - 0.1), yy, sz * (hd - 0.1)), [0, rot, 0], 0.8, 0.9));
    }
    // gable roof, ridge along local x, 32 degree pitch, eaves 0.45 m out, gables 0.3 m out
    const top = floor + WH;
    const pitch = 0.56, over = 0.45, gOver = 0.3;
    const rise = (hd + over) * Math.tan(pitch);
    const yr = top + hd * Math.tan(pitch);
    const ye = yr - rise;
    const tk = 0.14;
    for (const sz of [-1, 1]) {
      const a = P(-hw - gOver, ye, sz * (hd + over)), b = P(hw + gOver, ye, sz * (hd + over));
      const cR = P(hw + gOver, yr, 0), dR = P(-hw - gOver, yr, 0);
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(dR, a)).normalize();
      if (n.y < 0) n.negate();
      kb.add(tiles, poly([a, b, cR, dR], n, 1.25, 0.95));
      const off = n.clone().multiplyScalar(-tk);
      kb.add(wood, poly([a.clone().add(off), b.clone().add(off), cR.clone().add(off), dR.clone().add(off)], n.clone().negate(), 1.2, 0.5));
      // fascia board along the eave
      kb.add(wood, poly([a, b, b.clone().add(off).add(V(0, -0.08, 0)), a.clone().add(off).add(V(0, -0.08, 0))], P(0, 0, sz).sub(P(0, 0, 0)).normalize(), 1.2, 0.7));
    }
    // gable walls
    for (const sx of [-1, 1]) {
      const n = P(sx, 0, 0).sub(P(0, 0, 0)).normalize();
      kb.add(walls, poly([P(sx * hw, top, -hd), P(sx * hw, top, hd), P(sx * hw, yr - 0.05, 0)], n, 1.6, 0.9));
      kb.add(walls, poly([P(sx * (hw - T), top, -hd + T), P(sx * (hw - T), top, hd - T), P(sx * (hw - T), yr - 0.2, 0)], n.clone().negate(), 1.6, 0.5));
      // barge boards on the gable ends
      for (const sz of [-1, 1]) {
        const e0 = P(sx * (hw + gOver), ye - 0.02, sz * (hd + over)), e1 = P(sx * (hw + gOver), yr - 0.02, 0);
        kb.add(wood, tubeGeo([e0, e0.clone().lerp(e1, 0.5), e1], 0.05, 4, 0.7));
      }
    }
    // ridge cap tiles
    kb.add(tiles, tubeGeo([P(-hw - gOver - 0.05, yr + 0.03, 0), P(0, yr + 0.04, 0), P(hw + gOver + 0.05, yr + 0.03, 0)], 0.12, 8, 0.85));
    // chimney on the west end
    kb.add(walls, box(0.65, 1.7, 0.65, P(-hw + 0.75, yr + 0.15, -0.35), [0, rot, 0], 1.2, 0.9));
    kb.add(stone, box(0.8, 0.12, 0.8, P(-hw + 0.75, yr + 1.04, -0.35), [0, rot, 0], 1, 0.8));
    // a water butt and a bench by the door
    kb.add(wood, cylinder(0.32, 0.3, 0.85, P(hw - 0.5, floor - 0.35 + 0.42, hd + 0.5), [0, 0, 0], 12, 0.8, 0.8));
    kb.add(wood, box(1.4, 0.06, 0.38, P(-0.9, floor - 0.35 + 0.45, hd + 0.35), [0, rot, 0], 1, 0.8));
    for (const sx of [-1, 1]) kb.add(wood, box(0.06, 0.45, 0.32, P(-0.9 + sx * 0.6, floor - 0.35 + 0.22, hd + 0.35), [0, rot, 0], 1, 0.7));
    this.col.box(cx, cz, hw + 0.1, hd + 0.1, -rot, g - 1, yr + 1);
  }

  /**
   * The camera inside the tower and the watch room: from the far side of the well, at head height, looking at the
   * player (a follow camera behind him would be inside the wall).
   */
  interiorCamera(p: THREE.Vector3, outPos: THREE.Vector3, outTarget: THREE.Vector3) {
    const dx = p.x - this.x, dz = p.z - this.z, d = Math.hypot(dx, dz);
    const gy = this.galleryY;
    const inShaft = p.y > this.baseY - 0.5 && p.y < gy - 0.05 && d < this.ri(p.y) + 0.05;
    const inRoom = p.y >= gy - 0.05 && p.y < gy + 1.0 && d < Lighthouse.RWI + 0.05;
    if (!inShaft && !inRoom) return false;
    const ux = d > 1e-3 ? dx / d : 1, uz = d > 1e-3 ? dz / d : 0;
    const back = inRoom ? 1.25 : 0.35;
    outPos.set(this.x - ux * back, p.y + 1.72, this.z - uz * back);
    outTarget.set(p.x, p.y + 1.35, p.z);
    return true;
  }

  update(dt: number, night: number) {
    lighthouseU.on.value = THREE.MathUtils.smoothstep(night, 0.25, 0.7);
    lighthouseU.angle.value += dt * 0.55;
    this.beam.rotation.set(0, lighthouseU.angle.value as number, -0.035);
    // drawn in the first frames by day too (prime), so its pipeline compiles behind the loading screen
    this.beam.visible = (lighthouseU.on.value as number) > 0.01 || this.prime > 0;
    if (this.prime > 0) this.prime--;
    this.lamp.intensity = (lighthouseU.on.value as number) * 6;
  }
}

interface Opening { a: number; w: number; y0: number; y1: number; glass: boolean }

/** a flat ring (or disc, r0 = 0) at height y with planar UVs (no polar smearing), facing up or down */
function disc(cx: number, cz: number, r0: number, r1: number, y: number, segs: number, tile: number, shade: number, down = false) {
  const acc = new MeshAcc();
  const n = V(0, down ? -1 : 1, 0);
  const P = (a: number, r: number) => V(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r);
  const uvOf = (p: THREE.Vector3): [number, number] => [p.x / tile, p.z / tile];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * TAU, b = ((i + 1) / segs) * TAU;
    const p = [P(a, r0), P(b, r0), P(b, r1), P(a, r1)];
    acc.quad(p[0], p[1], p[2], p[3], n, p.map(uvOf) as [number, number][], shade);
  }
  return acc.geometry();
}

/**
 * A round wall from y0 to y1 (outer radius ro(y), inner ri(y)) with rectangular openings: outer and inner faces,
 * reveals round each opening (sills, lintels, jambs), the top edge, and glass set into the windows.
 */
function roundWall(kb: KitBuilder, kbGlass: KitBuilder, mat: THREE.Material, glassMat: THREE.Material, cx: number, cz: number, y0: number, y1: number,
  ro: (y: number) => number, ri: (y: number) => number, segs: number, openings: Opening[], tile: number, shadeAt: (y: number) => number) {
  const ys = new Set<number>([y0, y1]);
  for (let y = y0; y < y1; y += 1.1) ys.add(y);
  for (const o of openings) {
    ys.add(THREE.MathUtils.clamp(o.y0, y0, y1));
    ys.add(THREE.MathUtils.clamp(o.y1, y0, y1));
  }
  const rows = [...ys].sort((a, b) => a - b).filter((y, i, a) => i === 0 || y - a[i - 1] > 0.02);
  const da = TAU / segs;
  const colA = (i: number) => i * da;
  const isOpen = (i: number, j: number) => {
    if (j < 0 || j >= rows.length - 1) return null;
    const am = colA(i + 0.5), ym = (rows[j] + rows[j + 1]) / 2;
    for (const o of openings) {
      const half = o.w / 2 / ro(ym);
      if (Math.abs(angDiff(am, o.a)) < half && ym > o.y0 && ym < o.y1) return o;
    }
    return null;
  };
  const P = (a: number, y: number, r: number) => V(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r);
  const rad = (a: number) => V(Math.cos(a), 0, Math.sin(a));
  const acc = new MeshAcc();
  const accIn = new MeshAcc();
  for (let j = 0; j < rows.length - 1; j++) {
    const ya = rows[j], yb = rows[j + 1];
    for (let i = 0; i < segs; i++) {
      const aa = colA(i), ab = colA(i + 1);
      const o = isOpen(i, j);
      if (!o) {
        const ra = ro(ya), rb = ro(yb);
        acc.quad(P(aa, ya, ra), P(ab, ya, ra), P(ab, yb, rb), P(aa, yb, rb), [rad(aa), rad(ab), rad(ab), rad(aa)],
          [[aa * ra / tile, ya / tile], [ab * ra / tile, ya / tile], [ab * rb / tile, yb / tile], [aa * rb / tile, yb / tile]], [shadeAt(ya), shadeAt(ya), shadeAt(yb), shadeAt(yb)]);
        const ia = ri(ya), ib = ri(yb);
        accIn.quad(P(aa, ya, ia), P(ab, ya, ia), P(ab, yb, ib), P(aa, yb, ib), [rad(aa).negate(), rad(ab).negate(), rad(ab).negate(), rad(aa).negate()],
          [[aa * ia / tile, ya / tile], [ab * ia / tile, ya / tile], [ab * ib / tile, yb / tile], [aa * ib / tile, yb / tile]], 0.42);
        continue;
      }
      // reveals where an opening cell meets wall
      const reveal = (a: number, yy0: number, yy1: number, n: THREE.Vector3) => acc.quad(P(a, yy0, ri(yy0)), P(a, yy0, ro(yy0)), P(a, yy1, ro(yy1)), P(a, yy1, ri(yy1)), n,
        [[0, yy0 / tile], [0.33, yy0 / tile], [0.33, yy1 / tile], [0, yy1 / tile]], 0.7);
      const tan = (a: number) => V(-Math.sin(a), 0, Math.cos(a));
      if (!isOpen(i - 1, j)) reveal(aa, ya, yb, tan(aa));
      if (!isOpen(i + 1, j)) reveal(ab, ya, yb, tan(ab).negate());
      if (j === 0 || !isOpen(i, j - 1)) acc.quad(P(aa, ya, ri(ya)), P(ab, ya, ri(ya)), P(ab, ya, ro(ya)), P(aa, ya, ro(ya)), V(0, 1, 0), [[0, 0], [0.4, 0], [0.4, 0.33], [0, 0.33]], 0.75);
      if (j === rows.length - 2 || !isOpen(i, j + 1)) acc.quad(P(aa, yb, ri(yb)), P(ab, yb, ri(yb)), P(ab, yb, ro(yb)), P(aa, yb, ro(yb)), V(0, -1, 0), [[0, 0], [0.4, 0], [0.4, 0.33], [0, 0.33]], 0.6);
      if (o.glass) {
        const rg = (ro(ya) + ri(ya)) / 2 + 0.05;
        const gacc = new MeshAcc();
        gacc.quad(P(aa, ya, rg), P(ab, ya, rg), P(ab, yb, rg), P(aa, yb, rg), [rad(aa), rad(ab), rad(ab), rad(aa)], [[0, 0], [1, 0], [1, 1], [0, 1]], 1);
        kbGlass.add(glassMat, gacc.geometry());
      }
    }
  }
  // top edge
  for (let i = 0; i < segs; i++) {
    const aa = colA(i), ab = colA(i + 1);
    acc.quad(P(aa, y1, ri(y1)), P(ab, y1, ri(y1)), P(ab, y1, ro(y1)), P(aa, y1, ro(y1)), V(0, 1, 0), [[aa, 0], [ab, 0], [ab, 0.3], [aa, 0.3]], 0.8);
  }
  kb.add(mat, acc.geometry());
  kb.add(mat, accIn.geometry());
}

/** lantern glazing: dark, glossy and see-through, with the sky's reflection on top */
function lanternGlass() {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'lh_glazing';
  m.transparent = true;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  m.colorNode = vec4(vec3(0.02, 0.025, 0.03), 0.22);
  m.roughnessNode = float(0.04);
  m.metalnessNode = float(0.0);
  return m;
}

/** the lens: clear glass rings that catch the light by day and glow warm at night */
function lensMaterial() {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'lh_lens';
  m.colorNode = vec4(vec3(0.16, 0.19, 0.17), 1);
  m.roughnessNode = float(0.08);
  m.metalnessNode = float(0.6);
  m.emissiveNode = vec3(1.0, 0.8, 0.5).mul(lighthouseU.on.mul(14));
  return m;
}
