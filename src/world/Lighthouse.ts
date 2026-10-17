/**
 * The lighthouse on the summit: a white masonry tower with a red lantern cap, a gallery with railings you can walk
 * round, and an iron spiral stair wound twice round the outside of the tower from the ground to the gallery (a
 * helical ramp collider under the steps). A keeper's hut stands beside it. At night the lamp burns and two beams
 * sweep the island and the sea.
 */
import * as THREE from 'three/webgpu';
import { KitBuilder, box, cylinder, pbr, flat, tubeGeo } from './kit';
import type { Heightfield } from './Heightfield';
import type { Colliders } from './Colliders';
import { LIGHTHOUSE } from './layout';
import { float, uniform, uv, vec3, vec4, smoothstep, abs, positionLocal, length, mix, pow, max, cameraPosition, positionWorld, normalize, dot } from '../core/tsl';
import { atmo } from '../sky/Atmosphere';

export const lighthouseU = { angle: uniform(0), on: uniform(0) };

export class Lighthouse {
  readonly group = new THREE.Group();
  /** frames left in which the beam is drawn by day, so its pipeline compiles up front */
  prime = 0;
  readonly lampPos = new THREE.Vector3();
  readonly galleryY: number;
  private beam!: THREE.Mesh;
  readonly lamp: THREE.PointLight;
  readonly baseY: number;
  static readonly TOWER_H = 17;
  static readonly R0 = 2.7;
  static readonly R1 = 2.15;

  constructor(private hf: Heightfield, private col: Colliders) {
    this.group.name = 'lighthouse';
    const [x, z] = LIGHTHOUSE.p;
    this.baseY = hf.height(x, z);
    this.galleryY = this.baseY + Lighthouse.TOWER_H;
    this.lamp = new THREE.PointLight(0xffd9a0, 0, 60, 2);
    this.build(x, z);
  }

  private build(x: number, z: number) {
    const kb = new KitBuilder();
    const y0 = this.baseY;
    const H = Lighthouse.TOWER_H, R0 = Lighthouse.R0, R1 = Lighthouse.R1;
    const plaster = pbr('plaster', { vcolor: true, key: 'lh_plaster' });
    const stone = pbr('stone', { vcolor: true, key: 'lh_stone' });
    const iron = flat([0.06, 0.065, 0.07], 0.55, 0.6);
    const red = flat([0.48, 0.07, 0.05], 0.5, 0.05);
    const glass = flat([0.05, 0.06, 0.07], 0.05, 0.0, [0, 0, 0]);
    // plinth and tower
    kb.add(stone, cylinder(R0 + 0.6, R0 + 0.8, 1.2, new THREE.Vector3(x, y0 + 0.3, z), [0, 0, 0], 20, 1.2, 0.9));
    kb.add(plaster, cylinder(R1, R0, H, new THREE.Vector3(x, y0 + 0.9 + H / 2 - 0.6, z), [0, 0, 0], 28, 2.0, 1));
    // a red band below the gallery
    kb.add(red, cylinder(R1 + 0.02, R1 + 0.06, 1.1, new THREE.Vector3(x, y0 + H - 0.55, z), [0, 0, 0], 28, 1, 1));
    // windows up the tower (dark recesses)
    for (let i = 0; i < 4; i++) {
      const a = i * 1.7 + 0.4, yy = y0 + 3.5 + i * 3.4;
      const rr = THREE.MathUtils.lerp(R0, R1, (yy - y0) / H) + 0.01;
      kb.add(glass, box(0.5, 0.9, 0.06, new THREE.Vector3(x + Math.cos(a) * rr, yy, z + Math.sin(a) * rr), [0, -a + Math.PI / 2, 0], 1, 1));
    }
    // gallery deck and railing
    const gy = y0 + H;
    kb.add(stone, cylinder(R1 + 1.25, R1 + 1.25, 0.25, new THREE.Vector3(x, gy, z), [0, 0, 0], 32, 1.2, 0.85));
    const railPts: THREE.Vector3[] = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      railPts.push(new THREE.Vector3(x + Math.cos(a) * (R1 + 1.15), gy + 1.05, z + Math.sin(a) * (R1 + 1.15)));
      if (i % 2 === 0 && i < 48) kb.add(iron, cylinder(0.025, 0.025, 1.05, new THREE.Vector3(x + Math.cos(a) * (R1 + 1.15), gy + 0.55, z + Math.sin(a) * (R1 + 1.15)), [0, 0, 0], 5, 1, 1));
    }
    kb.add(iron, tubeGeo(railPts, 0.035, 6));
    const midPts = railPts.map((p) => p.clone().setY(gy + 0.55));
    kb.add(iron, tubeGeo(midPts, 0.02, 5));
    // lantern room: glazing between iron mullions, red domed cap, vent ball
    const lr = R1 - 0.45;
    kb.add(iron, cylinder(lr + 0.05, lr + 0.05, 0.5, new THREE.Vector3(x, gy + 0.37, z), [0, 0, 0], 16, 1, 1));
    kb.add(glass, cylinder(lr, lr, 2.2, new THREE.Vector3(x, gy + 1.7, z), [0, 0, 0], 16, 1, 1));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      kb.add(iron, box(0.07, 2.25, 0.07, new THREE.Vector3(x + Math.cos(a) * lr, gy + 1.72, z + Math.sin(a) * lr), [0, -a, 0], 1, 1));
    }
    const dome = new THREE.SphereGeometry(lr + 0.12, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    dome.scale(1, 0.7, 1);
    dome.translate(x, gy + 2.82, z);
    const dc = new Float32Array(dome.getAttribute('position').count * 3).fill(1);
    dome.setAttribute('color', new THREE.BufferAttribute(dc, 3));
    kb.add(red, dome);
    kb.add(iron, cylinder(0.08, 0.12, 0.6, new THREE.Vector3(x, gy + 3.7, z), [0, 0, 0], 8, 1, 1));
    // the spiral stair: two turns of iron steps on brackets, with a hand rail
    const turns = 2.0, steps = 92;
    const rIn = R0 + 0.05, rOut = R0 + 1.15;
    const startA = Math.PI * 0.75;
    const handPts: THREE.Vector3[] = [];
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const a = startA + t * turns * Math.PI * 2;
      const yy = y0 + 0.6 + t * (H - 0.75);
      const rT = THREE.MathUtils.lerp(R0, R1, (yy - y0) / H);
      const rI = rT + 0.02, rO = rT + 1.12;
      const rm = (rI + rO) / 2;
      kb.add(iron, box(rO - rI, 0.05, 0.42, new THREE.Vector3(x + Math.cos(a) * rm, yy, z + Math.sin(a) * rm), [0, -a, 0], 1, 0.9));
      if (i % 3 === 0) kb.add(iron, cylinder(0.02, 0.02, 0.95, new THREE.Vector3(x + Math.cos(a) * (rO - 0.04), yy + 0.48, z + Math.sin(a) * (rO - 0.04)), [0, 0, 0], 4, 1, 1));
      handPts.push(new THREE.Vector3(x + Math.cos(a) * (rO - 0.04), yy + 0.95, z + Math.sin(a) * (rO - 0.04)));
    }
    kb.add(iron, tubeGeo(handPts, 0.025, 5));
    void rIn; void rOut;
    // keeper's hut
    this.keeper(kb, x + 7.5, z + 5.5, 0.6);
    kb.build(this.group);

    // ---- colliders: tower, stair ramp, gallery
    // the tower tapers: stacked rings so the stair stays walkable all the way up
    for (let k = 0; k < 6; k++) {
      const ya = y0 - 2 + (k * (H + 2)) / 6, yb = y0 - 2 + ((k + 1) * (H + 2)) / 6;
      const rr = THREE.MathUtils.lerp(R0, R1, Math.max(0, ((ya + yb) / 2 - y0) / H)) + 0.03;
      this.col.circle(x, z, rr, ya, yb);
    }
    const total = turns * Math.PI * 2;
    this.col.surface({
      minX: x - R0 - 1.4, maxX: x + R0 + 1.4, minZ: z - R0 - 1.4, maxZ: z + R0 + 1.4, material: 'metal',
      height: (px, pz) => {
        const dx = px - x, dz = pz - z, d = Math.hypot(dx, dz);
        if (d < R1 - 0.1 || d > R0 + 1.3) return null;
        // angle along the helix: choose the turn whose height is nearest below the walker (the surface API
        // asks for the highest surface not above maxY, so return every candidate via the closest turn)
        let a = Math.atan2(dz, dx) - startA;
        a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        const cands: number[] = [];
        for (let k = 0; k < Math.ceil(turns) + 1; k++) {
          const s = (a + k * Math.PI * 2) / total;
          if (s >= 0 && s <= 1) cands.push(y0 + 0.6 + s * (H - 0.75) + 0.03);
        }
        if (!cands.length) return null;
        // the caller filters by maxY; return the lowest here and let the multi-surface below add the others
        return cands[0];
      },
    });
    // the upper turn (a second surface so the walker on the upper turn is not snapped down)
    this.col.surface({
      minX: x - R0 - 1.4, maxX: x + R0 + 1.4, minZ: z - R0 - 1.4, maxZ: z + R0 + 1.4, material: 'metal',
      height: (px, pz) => {
        const dx = px - x, dz = pz - z, d = Math.hypot(dx, dz);
        if (d < R1 - 0.1 || d > R0 + 1.3) return null;
        let a = Math.atan2(dz, dx) - startA;
        a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        const s = (a + Math.PI * 2) / total;
        if (s < 0 || s > 1) return null;
        return y0 + 0.6 + s * (H - 0.75) + 0.03;
      },
    });
    // gallery deck (ring)
    this.col.surface({
      minX: x - R1 - 1.4, maxX: x + R1 + 1.4, minZ: z - R1 - 1.4, maxZ: z + R1 + 1.4, material: 'stone',
      height: (px, pz) => {
        const d = Math.hypot(px - x, pz - z);
        return d > lr + 0.1 && d < R1 + 1.2 ? gy + 0.13 : null;
      },
    });
    // gallery railing and the lantern room as obstacles (only at gallery height)
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      this.col.circle(x + Math.cos(a) * (R1 + 1.3), z + Math.sin(a) * (R1 + 1.3), 0.2, gy - 0.1, gy + 1.2);
    }
    this.col.circle(x, z, lr + 0.1, gy, gy + 3);
    // the stair's outer edge: rail posts as obstacles along the helix, so the walker cannot step off
    for (let i = 0; i < steps; i += 2) {
      const t = i / (steps - 1);
      const a = startA + t * total;
      const yy = y0 + 0.6 + t * (H - 0.75);
      const rT = THREE.MathUtils.lerp(R0, R1, (yy - y0) / H) + 1.3;
      this.col.circle(x + Math.cos(a) * rT, z + Math.sin(a) * rT, 0.16, yy - 0.2, yy + 1.0);
    }

    // ---- lamp and beams
    this.lampPos.set(x, gy + 1.7, z);
    this.lamp.position.copy(this.lampPos);
    this.group.add(this.lamp);
    const lampMat = new THREE.MeshBasicNodeMaterial();
    lampMat.colorNode = vec3(1.0, 0.82, 0.55).mul(lighthouseU.on.mul(60).add(0.4));
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 10), lampMat);
    bulb.position.copy(this.lampPos);
    this.group.add(bulb);
    // two beams: long cones, additive, fading along their length and at the edges
    const coneLen = 900;
    const cone = new THREE.ConeGeometry(70, coneLen, 24, 1, true);
    cone.translate(0, -coneLen / 2, 0);
    cone.rotateZ(Math.PI / 2);
    const bm = new THREE.MeshBasicNodeMaterial();
    bm.transparent = true;
    bm.depthWrite = false;
    bm.blending = THREE.AdditiveBlending;
    bm.side = THREE.DoubleSide;
    const along = positionLocal.x.div(coneLen).clamp(0, 1);
    const rad = length(positionLocal.yz).div(max(positionLocal.x.mul(70 / coneLen), 0.3));
    const core = pow(smoothstep(1.0, 0.0, rad), 2.0);
    const view = abs(dot(normalize(positionWorld.sub(cameraPosition)), normalize(positionWorld.sub(vec3(this.lampPos.x, this.lampPos.y, this.lampPos.z)))));
    const k = smoothstep(0.0, 0.02, along).mul(pow(float(1).sub(along), 2.5)).mul(core).mul(mix(float(1), float(0.25), view));
    bm.colorNode = vec4(vec3(1.0, 0.86, 0.62).mul(k).mul(lighthouseU.on).mul(float(0.5).add(atmo.mist.mul(8000))), 1);
    this.beam = new THREE.Mesh(cone, bm);
    const beam2 = new THREE.Mesh(cone, bm);
    beam2.rotation.y = Math.PI;
    this.beam.add(beam2);
    this.beam.position.copy(this.lampPos);
    this.beam.frustumCulled = false;
    beam2.frustumCulled = false;
    this.beam.renderOrder = 20;
    this.group.add(this.beam);
    void uv;
  }

  private keeper(kb: KitBuilder, x: number, z: number, rot: number) {
    const g = this.hf.height(x, z);
    const stone = pbr('coral_stone', { vcolor: true, key: 'keeper_stone' });
    const roof = flat([0.45, 0.16, 0.1], 0.7);
    const wood = pbr('wood', { vcolor: true, key: 'keeper_wood' });
    const W = 4.4, D = 3.6, Hh = 2.6;
    kb.add(stone, box(W, Hh, D, new THREE.Vector3(x, g + Hh / 2 - 0.2, z), [0, rot, 0], 1.5, 0.95));
    for (const side of [-1, 1]) {
      kb.add(roof, box(W + 0.5, 0.14, D / 2 + 0.55, new THREE.Vector3(x + Math.sin(rot) * side * (D / 4 + 0.1), g + Hh + 0.42, z + Math.cos(rot) * side * (D / 4 + 0.1)), [side * 0.48, rot, 0], 1, 0.9));
    }
    kb.add(wood, box(0.9, 1.9, 0.08, new THREE.Vector3(x + Math.sin(rot) * (D / 2 + 0.02), g + 0.75, z + Math.cos(rot) * (D / 2 + 0.02)), [0, rot, 0], 1, 0.8));
    this.col.box(x, z, W / 2 + 0.05, D / 2 + 0.05, -rot, g - 1, g + Hh + 1);
  }

  update(dt: number, night: number) {
    lighthouseU.on.value = THREE.MathUtils.smoothstep(night, 0.25, 0.7);
    lighthouseU.angle.value += dt * 0.55;
    this.beam.rotation.set(0, lighthouseU.angle.value as number, -0.035);
    // drawn in the first frames by day too (prime), so its pipeline compiles behind the loading screen
    this.beam.visible = (lighthouseU.on.value as number) > 0.01 || this.prime > 0;
    if (this.prime > 0) this.prime--;
    this.lamp.intensity = (lighthouseU.on.value as number) * 400;
  }
}
