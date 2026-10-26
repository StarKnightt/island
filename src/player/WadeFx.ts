/**
 * Water round the hero: ripple rings spreading from the legs while wading (one at every step, and a slow one while
 * standing in the water), from the shoulders while treading and swimming (a chain of them behind a swimmer reads as
 * the wake), and splashes of droplets kicked up by wading steps and swim strokes. Rings ride the water level at the
 * hero (the wave height there), so they rise and fall with the swell; they are thin bright crests that fade as they
 * spread. Both are lit like the island's other unlit effects (the light on open ground).
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { atmo } from '../sky/Atmosphere';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TSL = TSLTyped as any;
const {
  float, vec2, vec3, vec4, mix, max, pow, smoothstep, length, uv, exp, instancedBufferAttribute, varying, cameraPosition,
  select, uniform, sin, atan,
} = TSL;

const RINGS = 40, DROPS = 120;
/** ring plane size (m): rings spread to ~1.4 m radius */
const SIZE = 3.2;

export interface WadeState {
  pos: THREE.Vector3;
  state: 'ground' | 'air' | 'swim';
  speed: number;
  waterDepth: number;
  waterLevel: number;
  heading: number;
}

export class WadeFx {
  readonly group = new THREE.Group();
  private time = uniform(0);
  private t = 0;
  private ringA: THREE.InstancedBufferAttribute;
  private ringMesh: THREE.InstancedMesh;
  private nextRing = 0;
  private dropA: THREE.InstancedBufferAttribute;
  private dropB: THREE.InstancedBufferAttribute;
  private nextDrop = 0;
  private idleT = 0;
  private swimT = 0;
  private m = new THREE.Matrix4();

  constructor() {
    this.group.name = 'wade-fx';
    // ---- rings: centre x, z (world), birth time, strength
    this.ringA = new THREE.InstancedBufferAttribute(new Float32Array(RINGS * 4), 4);
    for (let i = 0; i < RINGS; i++) this.ringA.array[i * 4 + 2] = -1e6;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const rm = new THREE.MeshBasicNodeMaterial();
    rm.name = 'wade_rings';
    rm.transparent = true;
    rm.depthWrite = false;
    rm.fog = false;
    const R = instancedBufferAttribute(this.ringA);
    const age = max(this.time.sub(R.z), 0);
    const life = mix(float(1.3), float(2.2), R.w);
    const u = age.div(life);
    const q = uv().sub(0.5).mul(SIZE);
    const r = length(q);
    // the crest spreads fast then slows (energy spreading out), thinning; a faint trough inside it
    const ringR = float(0.12).add(pow(u.clamp(0, 1), 0.6).mul(mix(float(0.7), float(1.4), R.w)));
    const w = mix(float(0.025), float(0.07), u);
    const d = r.sub(ringR).div(w);
    // broken a little round the ring (the water is not still)
    const ang = atan(q.y, q.x);
    const broken = sin(ang.mul(7).add(R.x.mul(13))).mul(0.25).add(sin(ang.mul(13).sub(R.y.mul(7))).mul(0.15)).add(0.8);
    const crest = exp(d.mul(d).negate()).mul(broken);
    const fade = pow(float(1).sub(u.clamp(0, 1)), 1.5).mul(smoothstep(0, 0.06, u)).mul(select(u.lessThan(1), float(1), float(0)));
    const E = atmo.lightE.mul(1 / Math.PI);
    const a = crest.mul(fade).mul(mix(float(0.35), float(0.65), R.w));
    rm.colorNode = vec4(vec3(0.85, 0.9, 0.92).mul(E), a);
    rm.opacityNode = a;
    this.ringMesh = new THREE.InstancedMesh(geo, rm, RINGS);
    this.ringMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < RINGS; i++) this.ringMesh.setMatrixAt(i, this.m);
    this.ringMesh.frustumCulled = false;
    this.ringMesh.renderOrder = 20;
    this.ringMesh.name = 'wade_rings';
    this.group.add(this.ringMesh);

    // ---- droplets: origin xyz + birth; velocity xyz + seed
    this.dropA = new THREE.InstancedBufferAttribute(new Float32Array(DROPS * 4), 4);
    this.dropB = new THREE.InstancedBufferAttribute(new Float32Array(DROPS * 4), 4);
    for (let i = 0; i < DROPS; i++) this.dropA.array[i * 4 + 3] = -1e6;
    const dm = new THREE.SpriteNodeMaterial();
    dm.name = 'wade_drops';
    dm.transparent = true;
    dm.depthWrite = false;
    dm.fog = false;
    const A = instancedBufferAttribute(this.dropA), B = instancedBufferAttribute(this.dropB);
    const dage = max(this.time.sub(A.w), 0);
    const dlife = mix(float(0.35), float(0.75), B.w);
    const du = dage.div(dlife);
    const p = vec3(A.x, A.y, A.z).add(vec3(B.x, B.y, B.z).mul(dage)).sub(vec3(0, 4.9, 0).mul(dage.mul(dage)));
    dm.positionNode = p;
    const size = mix(float(0.025), float(0.07), B.w).mul(mix(float(1), float(1.8), du.clamp(0, 1)));
    dm.scaleNode = vec2(size, size);
    const V = cameraPosition.sub(p).normalize();
    const back = pow(max(atmo.sunDir.normalize().negate().dot(V), 0), 6).mul(2.5);
    const dcol = varying(vec3(0.85, 0.92, 0.95).mul(E).mul(back.add(0.9)));
    const alive = du.lessThan(1).and(p.y.greaterThan(A.y.sub(0.05)));
    const dfade = varying(select(alive, pow(float(1).sub(du.clamp(0, 1)), 0.8).mul(0.75), float(0)));
    const dr = length(uv().sub(0.5)).mul(2);
    const dot_ = smoothstep(1.0, 0.25, dr);
    dm.colorNode = vec4(dcol, dot_.mul(dfade));
    dm.opacityNode = dot_.mul(dfade);
    const sprite = new THREE.Sprite(dm);
    (sprite as unknown as { count: number }).count = DROPS;
    sprite.frustumCulled = false;
    sprite.renderOrder = 21;
    sprite.name = 'wade_drops';
    this.group.add(sprite);
  }

  private ring(x: number, z: number, strength: number) {
    const i = this.nextRing;
    this.nextRing = (this.nextRing + 1) % RINGS;
    this.ringA.array.set([x, z, this.t, THREE.MathUtils.clamp(strength, 0, 1)], i * 4);
    this.m.makeScale(SIZE, 1, SIZE).setPosition(x, 0, z);
    this.ringMesh.setMatrixAt(i, this.m);
    const im = this.ringMesh.instanceMatrix;
    im.clearUpdateRanges();
    im.addUpdateRange(i * 16, 16);
    im.needsUpdate = true;
    this.ringA.clearUpdateRanges();
    this.ringA.addUpdateRange(i * 4, 4);
    this.ringA.needsUpdate = true;
  }

  private splash(x: number, y: number, z: number, fx: number, fz: number, n: number, power: number) {
    for (let j = 0; j < n; j++) {
      const i = this.nextDrop;
      this.nextDrop = (this.nextDrop + 1) % DROPS;
      const a = Math.random() * Math.PI * 2;
      const out = (0.3 + Math.random() * 0.9) * power;
      const vx = Math.cos(a) * out + fx * power * 0.8, vz = Math.sin(a) * out + fz * power * 0.8;
      const vy = (1.2 + Math.random() * 1.6) * power;
      this.dropA.array.set([x + Math.cos(a) * 0.08, y + 0.02, z + Math.sin(a) * 0.08, this.t + Math.random() * 0.04], i * 4);
      this.dropB.array.set([vx, vy, vz, Math.random()], i * 4);
    }
    this.dropA.needsUpdate = true;
    this.dropB.needsUpdate = true;
  }

  /** a wading step or a swim stroke at the hero */
  step(p: WadeState, swim: boolean) {
    if (p.waterDepth < 0.04) return;
    const fx = Math.sin(p.heading), fz = -Math.cos(p.heading);
    const y = p.waterLevel;
    if (swim) {
      this.ring(p.pos.x + fx * 0.5, p.pos.z + fz * 0.5, 0.7);
      this.splash(p.pos.x + fx * 0.6, y, p.pos.z + fz * 0.6, fx, fz, 10, 0.75);
      return;
    }
    // shallow water: a splash off the foot; knee-deep: the leg pushes a bow wave and throws less spray
    const deep = THREE.MathUtils.smoothstep(p.waterDepth, 0.1, 0.7);
    const sp = THREE.MathUtils.clamp(p.speed / 4.5, 0.25, 1.3);
    this.ring(p.pos.x + fx * 0.15, p.pos.z + fz * 0.15, 0.35 + deep * 0.45);
    this.splash(p.pos.x + fx * 0.25, y, p.pos.z + fz * 0.25, fx, fz, Math.round(4 + sp * 10 * (1 - deep * 0.5)), sp * (1 - deep * 0.4));
  }

  update(dt: number, p: WadeState) {
    this.t += dt;
    this.time.value = this.t;
    this.ringMesh.position.y = Number.isFinite(p.waterLevel) ? p.waterLevel + 0.015 : -100;
    const inWater = p.waterDepth > 0.08 && Number.isFinite(p.waterLevel);
    // standing or treading in the water: slow rings round the body
    if (inWater && p.speed < 0.3) {
      this.idleT -= dt;
      if (this.idleT <= 0) {
        this.idleT = p.state === 'swim' ? 0.9 + Math.random() * 0.5 : 1.6 + Math.random() * 1.2;
        this.ring(p.pos.x + (Math.random() - 0.5) * 0.2, p.pos.z + (Math.random() - 0.5) * 0.2, p.state === 'swim' ? 0.45 : 0.2);
      }
    }
    // swimming: rings shed from the shoulders between strokes (the wake)
    if (p.state === 'swim' && p.speed > 0.3) {
      this.swimT -= dt;
      if (this.swimT <= 0) {
        this.swimT = 0.28;
        const fx = Math.sin(p.heading), fz = -Math.cos(p.heading);
        this.ring(p.pos.x + fx * 0.3, p.pos.z + fz * 0.3, 0.55);
      }
    }
  }
}
