/**
 * Footprints in sand: one instanced draw of small decals laid on the ground at the footfalls. Each print is a
 * procedural sneaker-sole hollow (a heel and a forefoot disc joined smoothly, tread bars, a rim of pushed-up sand,
 * deeper at the toe when running). The decal multiplies the colour already drawn under it by how differently its
 * hollow is lit: the side facing the sun or moon brighter, the side facing away darker, the wall's shadow cast over
 * the bottom at a low sun, the bottom a little occluded from the sky. So a print reads in raking light and nearly
 * vanishes under an overcast, as real ones do. Wet sand prints are darker (water in the hollow); prints in the swash
 * fade within seconds, the rest over a minute or two. Capped at MAX: the oldest is reused.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { atmo } from '../sky/Atmosphere';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TSL = TSLTyped as any;
const {
  Fn, float, vec2, vec3, vec4, mix, max, min, saturate, smoothstep, sin, exp, length, normalize, dot, cross, select,
  uv, uniform, instancedBufferAttribute, normalWorld, pow, mrt, packNormalToRGB, cameraViewMatrix,
} = TSL;

const MAX = 160;
/** decal size (m): across, along the foot */
const W = 0.2, L = 0.38;

export const printU = { time: uniform(0) };

/** signed distance (m) to a sneaker sole in the decal plane (x across, y toward the toe); `out` bulges the forefoot */
const sole = Fn(([q, out]: [unknown, unknown]) => {
  const qq = q as ReturnType<typeof vec2>;
  const d1 = length(qq.sub(vec2(float(0.006).mul(out), 0.058))).sub(0.054);
  const d2 = length(qq.sub(vec2(0.0, -0.088))).sub(0.042);
  const k = 0.035;
  const h = saturate(float(0.5).add(d2.sub(d1).mul(0.5 / k)));
  return mix(d2, d1, h).sub(h.mul(float(1).sub(h)).mul(k));
});

/** height (m) of the print's surface at q: the hollow (negative) and its rim */
const printHeight = Fn(([q, depth, push, out]: unknown[]) => {
  const qq = q as ReturnType<typeof vec2>;
  const d = sole(qq, out);
  const inside = smoothstep(0.004, -0.009, d);
  // deeper under the toe when pushing off, and under the heel strike
  const dig = float(1).add(smoothstep(0.02, 0.1, qq.y).mul(push).mul(0.75)).add(smoothstep(-0.05, -0.12, qq.y).mul(push).mul(0.25));
  // tread bars in the bottom
  const tread = sin(qq.y.mul(560)).mul(0.06).add(sin(qq.x.mul(640).add(qq.y.mul(260))).mul(0.03));
  // sand pushed up round the edge, more in front of a running toe
  const rimD = d.sub(0.01).div(0.009);
  const rim = exp(rimD.mul(rimD).negate()).mul(float(0.22).add(smoothstep(0.0, 0.12, qq.y).mul(push).mul(0.5)));
  return (depth as ReturnType<typeof float>).mul(inside.mul(dig).mul(float(-1).add(tread)).add(rim));
});

export class Footprints {
  readonly mesh: THREE.InstancedMesh;
  private data: THREE.InstancedBufferAttribute;
  private data2: THREE.InstancedBufferAttribute;
  private next = 0;
  private m = new THREE.Matrix4();

  constructor() {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    // birth time, life (s), side (+1 right, -1 left), wet
    this.data = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    // depth (m), push-off 0..1, forward direction x, z
    this.data2 = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    for (let i = 0; i < MAX; i++) this.data.array[i * 4] = -1e6;
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.name = 'footprints';
    mat.transparent = true;
    mat.depthWrite = false;
    mat.fog = false;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -4;
    // multiply the colour under the decal (the scene target is half float: factors above 1 brighten)
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = THREE.AddEquation;
    mat.blendSrc = THREE.ZeroFactor;
    mat.blendDst = THREE.SrcColorFactor;
    mat.blendSrcAlpha = THREE.ZeroFactor;
    mat.blendDstAlpha = THREE.OneFactor;
    mat.colorNode = this.shade();
    // the scene pass's normal target is not blended: the decal's flat plane would replace the sand's rippled
    // normals (a rectangle of ambient occlusion round every print); write the ground's up instead
    mat.mrtNode = mrt({ normal: packNormalToRGB(normalize(cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz)) });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.name = 'footprints';
    this.mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    // every instance starts collapsed (drawn once while the shaders are primed, but covering nothing)
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < MAX; i++) this.mesh.setMatrixAt(i, this.m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  private shade() {
    const d1 = instancedBufferAttribute(this.data);
    const d2 = instancedBufferAttribute(this.data2);
    const age = printU.time.sub(d1.x), life = d1.y, side = d1.z, wet = d1.w;
    const depth = d2.x, push = d2.y;
    const q = uv().sub(0.5).mul(vec2(W, L)).mul(vec2(side, 1));
    // the decal's frame in the world: ground normal, forward, right
    const n = normalize(normalWorld);
    const fw = vec3(d2.z, 0, d2.w);
    const b = normalize(fw.sub(n.mul(dot(fw, n))));
    const t = cross(b, n).mul(side);
    // relief: forward differences of the height field
    const e = 0.0025;
    const h0 = printHeight(q, depth, push, side);
    const hx = printHeight(q.add(vec2(e, 0)), depth, push, side);
    const hy = printHeight(q.add(vec2(0, e)), depth, push, side);
    const nW = normalize(n.add(t.mul(h0.sub(hx).div(e))).add(b.mul(h0.sub(hy).div(e))));
    // the key light: the sun, or the moon once the sun is down
    const l = normalize(select(atmo.sunDir.y.greaterThan(-0.035), atmo.sunDir, atmo.moonDir));
    const ln = dot(l, n);
    // the hollow's own shadow: march toward the light across the plane (4 cm in 1 cm steps)
    const lp = vec2(dot(l, t), dot(l, b));
    const lpl = max(length(lp), 1e-3);
    const dir = lp.div(lpl);
    const rise = ln.div(lpl);
    let occ = float(0);
    for (let i = 1; i <= 4; i++) {
      const s = i * 0.01;
      occ = max(occ, saturate(printHeight(q.add(dir.mul(s)), depth, push, side).sub(h0).sub(rise.mul(s)).div(0.0015)));
    }
    // how much of the light on open sand is direct: none under an overcast, most of it in sun or moonlight
    // (a low sun lights open ground weakly next to the sky, so its share ramps in over the first ~12 degrees: the
    // shadowed hollow of a print at sunset is lit by the sky, not black)
    const direct = pow(float(1).sub(atmo.overcast), 1.7).mul(smoothstep(-0.02, 0.2, l.y)).mul(0.8);
    const ratio = min(max(dot(nW, l), 0).add(0.02).div(max(ln, 0).add(0.02)), 1.8).mul(float(1).sub(occ));
    // the bottom sees less sky (deeper prints more), and water darkens wet sand prints
    const inside = saturate(h0.negate().div(max(depth, 1e-4)));
    const sky = float(1).sub(inside.mul(saturate(depth.mul(14))).mul(0.45));
    const k = mix(float(1), ratio, direct).mul(mix(float(1), sky, float(1).sub(direct.mul(0.5)))).mul(float(1).sub(inside.mul(wet).mul(0.2)));
    // fade in over a tenth of a second, out over the last 40 % of the life
    const fade = smoothstep(0.0, 0.1, age).mul(float(1).sub(smoothstep(life.mul(0.6), life, age)));
    const f = mix(float(1), k, fade);
    return vec4(f, f, f, 1);
  }

  /**
   * A print of one foot at (x, y, z) on ground with normal `n`, the foot pointing along (fx, fz).
   * `side` +1 right, -1 left; `depth` m; `push` 0 walking .. 1 sprinting; `wet` 0..1; `life` seconds.
   */
  stamp(x: number, y: number, z: number, n: THREE.Vector3, fx: number, fz: number, side: number, depth: number, push: number, wet: number, life: number, time: number) {
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    const up = n.clone().normalize();
    const fwd = new THREE.Vector3(fx, 0, fz);
    fwd.addScaledVector(up, -fwd.dot(up)).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    // plane axes: local x across, local y up, local z backward (uv v runs toward the toe)
    this.m.makeBasis(right.multiplyScalar(W), up, fwd.multiplyScalar(-L));
    this.m.setPosition(x, y + 0.006, z);
    this.mesh.setMatrixAt(i, this.m);
    this.data.array.set([time, life, side, wet], i * 4);
    this.data2.array.set([depth, push, fx, fz], i * 4);
    const im = this.mesh.instanceMatrix;
    im.clearUpdateRanges();
    im.addUpdateRange(i * 16, 16);
    im.needsUpdate = true;
    for (const a of [this.data, this.data2]) {
      a.clearUpdateRanges();
      a.addUpdateRange(i * 4, 4);
      a.needsUpdate = true;
    }
  }

  /** remove every print (spawning elsewhere) */
  clear() {
    for (let i = 0; i < MAX; i++) this.data.array[i * 4] = -1e6;
    this.data.clearUpdateRanges();
    this.data.needsUpdate = true;
  }
}
