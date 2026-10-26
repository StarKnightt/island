/**
 * Kicked sand: at a footfall on sand, clumps of grains and (on dry sand) puffs of dust thrown back and up off the toe,
 * more and further the faster the stride (a walk barely stirs it, a sprint throws a spray behind each foot). Grains
 * are small dark lumps (half in their own shadow, darker when wet) falling ballistically; dust is a soft sprite under
 * heavy drag, growing and thinning as it settles, lit by the light on open ground (brighter backlit: dust scatters
 * forward). One draw of up to MAX sprites; the oldest is reused.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { atmo } from '../sky/Atmosphere';
import { printU } from './Footprints';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TSL = TSLTyped as any;
const {
  float, vec2, vec3, vec4, mix, max, pow, smoothstep, length, uv, exp, instancedBufferAttribute, varying, cameraPosition, select, mrt, packNormalToRGB, cameraViewMatrix, normalize,
} = TSL;

const MAX = 160;

export class SandPuffs {
  readonly sprite: THREE.Sprite;
  private a: THREE.InstancedBufferAttribute;
  private b: THREE.InstancedBufferAttribute;
  private next = 0;

  constructor() {
    // origin xyz + birth time; velocity xyz + seed
    this.a = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.b = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    for (let i = 0; i < MAX; i++) this.a.array[i * 4 + 3] = -1e6;
    const m = new THREE.SpriteNodeMaterial();
    m.name = 'sand_puffs';
    m.transparent = true;
    m.depthWrite = false;
    m.fog = false;
    const A = instancedBufferAttribute(this.a), B = instancedBufferAttribute(this.b);
    const age = max(printU.time.sub(A.w), 0);
    // B.w: a seed in [0, 1) for a dust puff, [2, 3) for a thrown clump of dry sand, [4, 5) for wet sand
    const grain = B.w.greaterThan(1.5);
    const seed = TSL.fract(B.w);
    const life = select(grain, mix(float(0.35), float(0.6), seed), mix(float(0.7), float(1.4), seed));
    const u = age.div(life);
    // drag: the throw stalls within a few tenths of a second; the grains fall, the dust hangs a little
    const k = select(grain, float(1.5), float(5.5));
    const reach = float(1).sub(exp(age.mul(k).negate())).div(k);
    const p = vec3(A.x, A.y, A.z).add(vec3(B.x, B.y, B.z).mul(reach)).sub(vec3(0, 1, 0).mul(age.mul(age)).mul(select(grain, float(4.9), mix(float(1.6), float(0.5), seed))));
    m.positionNode = vec3(p.x, max(p.y, A.y.add(0.02)), p.z);
    const size = select(grain, mix(float(0.012), float(0.028), seed), mix(float(0.07), float(0.34), pow(u.clamp(0, 1), 0.55)).mul(mix(float(0.7), float(1.2), seed)));
    m.scaleNode = vec2(size, size);
    const V = cameraPosition.sub(p).normalize();
    const L = atmo.sunDir.normalize();
    const back = pow(max(L.negate().dot(V), 0), 4).mul(1.2);
    const E = atmo.lightE.mul(1 / Math.PI);
    // grains are lumps of sand half in their own shadow (and darker still when wet); dust scatters the light
    const wetGrain = B.w.greaterThan(3.5);
    const grainCol = select(wetGrain, vec3(0.24, 0.21, 0.17), vec3(0.42, 0.37, 0.3));
    const col = varying(select(grain, grainCol.mul(0.75), vec3(0.62, 0.56, 0.45).mul(back.add(0.85))).mul(E));
    const alive = select(u.lessThan(1).and(p.y.greaterThan(A.y.sub(0.03))), float(1), float(0));
    const fade = varying(select(grain, float(0.95), pow(float(1).sub(u.clamp(0, 1)), 1.6).mul(smoothstep(0.0, 0.05, u)).mul(0.3)).mul(alive));
    const r = length(uv().sub(0.5)).mul(2);
    const puff = select(grain, smoothstep(1.0, 0.6, r), smoothstep(1.0, 0.0, r).pow(1.8));
    m.colorNode = vec4(col, puff.mul(fade));
    m.opacityNode = puff.mul(fade);
    // the scene pass's normal target is not blended: write the ground's up there (else every quad shows in the AO),
    // and draw nothing where the puff is clear
    m.mrtNode = mrt({ normal: packNormalToRGB(normalize(cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz)) });
    m.alphaTest = 0.004;
    this.sprite = new THREE.Sprite(m);
    (this.sprite as unknown as { count: number }).count = MAX;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = 21;
    this.sprite.name = 'sand_puffs';
  }

  /** a footfall at (x, y, z) moving along (fx, fz) at `speed` m/s, at time `time` (the footprints' clock); wet sand
   *  throws a few dark clumps and no dust */
  kick(x: number, y: number, z: number, fx: number, fz: number, speed: number, time: number, wet: boolean) {
    const run = THREE.MathUtils.clamp((speed - 1.2) / 5.4, 0, 1);
    const grains = Math.round((2 + run * 12) * (wet ? 0.5 : 1));
    const dust = wet ? 0 : Math.round(run * 4);
    for (let j = 0; j < grains + dust; j++) {
      const isGrain = j < grains;
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      // thrown back off the toe (and a little to the sides), up a little; grains fly further than the dust
      const back = (0.25 + run * (isGrain ? 2.2 : 1.6)) * (0.5 + Math.random());
      const side = (Math.random() - 0.5) * (0.4 + run * 0.8);
      const vx = -fx * back + fz * side, vz = -fz * back - fx * side;
      const vy = (0.25 + run * (isGrain ? 1.8 : 1.1)) * (0.5 + Math.random());
      this.a.array.set([x + fx * 0.06, y + 0.03, z + fz * 0.06, time + j * 0.006], i * 4);
      this.b.array.set([vx, vy, vz, Math.random() * 0.999 + (isGrain ? (wet ? 4 : 2) : 0)], i * 4);
    }
    for (const at of [this.a, this.b]) at.needsUpdate = true;
  }
}
