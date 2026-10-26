/**
 * Kicked sand: at a footfall on dry sand, a few grains-and-dust puffs thrown back and up off the toe, more and
 * further the faster the stride (a walk barely stirs it, a sprint throws a spray behind each foot). Each puff is a
 * soft sprite flying under drag and gravity, growing and thinning as it settles, coloured as dry sand lit by the
 * light on open ground (brighter backlit: dust scatters forward). One draw of up to MAX sprites; the oldest is reused.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { atmo } from '../sky/Atmosphere';
import { printU } from './Footprints';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TSL = TSLTyped as any;
const {
  float, vec2, vec3, vec4, mix, max, pow, smoothstep, length, uv, exp, instancedBufferAttribute, varying, cameraPosition, select,
} = TSL;

const MAX = 96;

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
    const seed = B.w;
    const life = mix(float(0.7), float(1.4), seed);
    const u = age.div(life);
    // drag: the throw stalls within a few tenths of a second; the grains fall, the dust hangs a little
    const k = float(5.5);
    const reach = float(1).sub(exp(age.mul(k).negate())).div(k);
    const p = vec3(A.x, A.y, A.z).add(vec3(B.x, B.y, B.z).mul(reach)).sub(vec3(0, 1.6, 0).mul(age.mul(age)).mul(mix(float(1), float(0.3), seed)));
    m.positionNode = vec3(p.x, max(p.y, A.y.add(0.02)), p.z);
    const size = mix(float(0.07), float(0.34), pow(u.clamp(0, 1), 0.55)).mul(mix(float(0.7), float(1.2), seed));
    m.scaleNode = vec2(size, size);
    const V = cameraPosition.sub(p).normalize();
    const L = atmo.sunDir.normalize();
    const back = pow(max(L.negate().dot(V), 0), 4).mul(1.2);
    const E = atmo.lightE.mul(1 / Math.PI);
    const col = varying(vec3(0.62, 0.56, 0.45).mul(E).mul(back.add(0.85)));
    const fade = varying(pow(float(1).sub(u.clamp(0, 1)), 1.6).mul(smoothstep(0.0, 0.05, u)).mul(select(u.lessThan(1), float(0.32), float(0))));
    const r = length(uv().sub(0.5)).mul(2);
    const puff = smoothstep(1.0, 0.0, r).pow(1.8);
    m.colorNode = vec4(col, puff.mul(fade));
    m.opacityNode = puff.mul(fade);
    this.sprite = new THREE.Sprite(m);
    (this.sprite as unknown as { count: number }).count = MAX;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = 21;
    this.sprite.name = 'sand_puffs';
  }

  /** a footfall at (x, y, z) moving along (fx, fz) at `speed` m/s, at time `time` (the footprints' clock) */
  kick(x: number, y: number, z: number, fx: number, fz: number, speed: number, time: number) {
    const run = THREE.MathUtils.clamp((speed - 1.2) / 5.4, 0, 1);
    const n = Math.round(1 + run * 5);
    for (let j = 0; j < n; j++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      const s = Math.random();
      // thrown back off the toe (and a little to the sides), up a little
      const back = (0.25 + run * 1.6) * (0.5 + Math.random());
      const side = (Math.random() - 0.5) * (0.4 + run * 0.8);
      const vx = -fx * back + fz * side, vz = -fz * back - fx * side;
      const vy = (0.25 + run * 1.1) * (0.5 + Math.random());
      this.a.array.set([x + fx * 0.06, y + 0.03, z + fz * 0.06, time + j * 0.012], i * 4);
      this.b.array.set([vx, vy, vz, s], i * 4);
    }
    for (const at of [this.a, this.b]) at.needsUpdate = true;
  }
}
