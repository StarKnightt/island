/**
 * Seabirds: gulls wheeling over the beach, the village bay and the north cliffs, and frigatebirds soaring high over
 * the island. One instanced mesh of tiny birds (15 triangles each: a body, a fanned tail and two jointed wings);
 * the wings beat in the vertex shader, in bursts between long glides, the flight paths (circles that drift, bank
 * into the turn and rise and fall) are computed on the CPU. By day only: they roost at night.
 */
import * as THREE from 'three/webgpu';
import { abs, attribute, cross, float, mix, positionLocal, sin, smoothstep, uniform, vec3 } from '../core/tsl';
import { sunLit } from '../core/lighting';

export const birdU = { time: uniform(0) };

interface Bird { cx: number; cz: number; h: number; r: number; w: number; a0: number; seed: number; scale: number; dark: number }

/** a gull, forward +z, up +y, span ~1.45 m; `span` = signed spanwise weight (0 body .. +-1 tips), `shade` = albedo key */
function birdGeometry() {
  const pos: number[] = [], span: number[] = [], shade: number[] = [];
  const tri = (a: number[], b: number[], c: number[], s: number[], k: number[]) => {
    pos.push(...a, ...b, ...c);
    span.push(...s);
    shade.push(...k);
  };
  // body
  const N = [0, 0, 0.3], T = [0, 0.01, -0.32], U = [0, 0.05, 0.02], D = [0, -0.05, 0.04], L = [-0.06, 0, 0.02], R = [0.06, 0, 0.02];
  const z3 = [0, 0, 0];
  for (const [a, b, c, k] of [[N, R, U, 0.8], [N, U, L, 0.8], [N, D, R, 1], [N, L, D, 1], [T, U, R, 0.8], [T, L, U, 0.8], [T, R, D, 1], [T, D, L, 1]] as [number[], number[], number[], number][]) tri(a, b, c, z3, [k, k, k]);
  // tail fan
  tri(T, [-0.075, 0.01, -0.43], [0.075, 0.01, -0.43], z3, [0.9, 0.9, 0.9]);
  // wings: root, elbow, swept tip (black tips, grey back, white inner underside)
  for (const sx of [-1, 1]) {
    const A = [0.05 * sx, 0.01, 0.1], B = [0.05 * sx, 0.01, -0.1], C = [0.34 * sx, 0.03, 0.09], E = [0.32 * sx, 0.03, -0.13], F = [0.72 * sx, 0, -0.2];
    const w = (p: number[]) => p[0] / 0.72;
    tri(A, C, B, [w(A), w(C), w(B)], [0.75, 0.7, 0.75]);
    tri(B, C, E, [w(B), w(C), w(E)], [0.75, 0.7, 0.7]);
    tri(C, F, E, [w(C), w(F), w(E)], [0.55, 0.06, 0.45]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('span', new THREE.Float32BufferAttribute(span, 1));
  g.setAttribute('shade', new THREE.Float32BufferAttribute(shade, 1));
  g.computeVertexNormals();
  return g;
}

export class Birds {
  readonly mesh: THREE.InstancedMesh;
  private birds: Bird[] = [];
  private flap: THREE.InstancedBufferAttribute;
  private rot: THREE.InstancedBufferAttribute;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();

  constructor() {
    const flocks: { c: [number, number]; h: number; r: number; n: number; dark: number; v: number; scale: number }[] = [
      // gulls over the spawn beach's shallows, the village bay, off the north cliffs
      { c: [650, 30], h: 20, r: 45, n: 6, dark: 0, v: 9, scale: 1 },
      { c: [-470, 330], h: 16, r: 35, n: 6, dark: 0, v: 8.5, scale: 1 },
      { c: [-250, -690], h: 55, r: 55, n: 5, dark: 0, v: 9.5, scale: 1 },
      // frigatebirds riding the thermals over the hills
      { c: [100, -50], h: 150, r: 110, n: 4, dark: 1, v: 10, scale: 1.65 },
      { c: [-300, 100], h: 130, r: 90, n: 3, dark: 1, v: 10, scale: 1.65 },
    ];
    let seed = 1;
    for (const f of flocks) for (let i = 0; i < f.n; i++) {
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const r = f.r * (0.55 + rnd() * 0.65);
      const dir = rnd() < 0.7 ? 1 : -1;
      this.birds.push({ cx: f.c[0] + (rnd() - 0.5) * 20, cz: f.c[1] + (rnd() - 0.5) * 20, h: f.h + (rnd() - 0.5) * 10, r, w: (dir * f.v) / r, a0: rnd() * 6.28, seed: rnd() * 100, scale: f.scale * (0.9 + rnd() * 0.2), dark: f.dark });
    }
    const n = this.birds.length;
    const g = birdGeometry();
    this.flap = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    g.setAttribute('iFlap', this.flap);
    this.rot = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    g.setAttribute('iRot', this.rot);
    const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
    // the wings beat about the body's axis, the outer wing more than the inner (a flexing stroke)
    const fl = attribute('iFlap', 'vec4');
    const sp = attribute('span', 'float');
    const ax = abs(sp);
    const beat = sin(birdU.time.mul(18.0).add(fl.x)).mul(fl.y).add(0.1);
    const ang = beat.mul(float(1).add(smoothstep(0.45, 1.0, ax).mul(0.6)));
    // (three applies the instance matrix before positionNode, so positionLocal is already in world space: the stroke
    // is worked out on the bird's own vertex, then turned and scaled into the world by its rotation and size)
    const p = attribute('position', 'vec3');
    const wing = smoothstep(0.04, 0.12, abs(p.x));
    const d = vec3(p.x.mul(ang.cos().sub(1)).mul(wing), abs(p.x).mul(sin(ang)).mul(wing), 0).mul(fl.w);
    const q = attribute('iRot', 'vec4');
    const turned = d.add(cross(q.xyz, cross(q.xyz, d).add(d.mul(q.w))).mul(2));
    m.positionNode = positionLocal.add(turned);
    const key = attribute('shade', 'float');
    const gull = mix(vec3(0.03, 0.03, 0.035), vec3(0.82, 0.83, 0.85), key);
    const frigate = mix(vec3(0.02, 0.02, 0.022), vec3(0.09, 0.085, 0.08), key);
    m.colorNode = mix(gull, frigate, fl.z);
    sunLit(m);
    this.mesh = new THREE.InstancedMesh(g, m, n);
    this.mesh.name = 'birds';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.update(0, 0);
  }

  /** t: world time (s); night: 0 day .. 1 night */
  update(t: number, night: number, cam?: THREE.Vector3) {
    birdU.time.value = t;
    this.mesh.visible = night < 0.35;
    if (!this.mesh.visible) return;
    const f = this.flap.array as Float32Array;
    this.birds.forEach((b, i) => {
      // the circle drifts slowly, so the paths never close into rings
      const cx = b.cx + 14 * Math.sin(t * 0.05 + b.seed), cz = b.cz + 14 * Math.cos(t * 0.043 + b.seed * 1.7);
      const a = b.a0 + b.w * t;
      const y = b.h + 4 * Math.sin(t * 0.31 + b.seed) + 1.5 * Math.sin(t * 0.83 + b.seed * 2.3);
      const vy = 4 * 0.31 * Math.cos(t * 0.31 + b.seed) + 1.5 * 0.83 * Math.cos(t * 0.83 + b.seed * 2.3);
      this.p.set(cx + Math.cos(a) * b.r, y, cz + Math.sin(a) * b.r);
      // velocity along the circle; forward (+z of the bird) along it
      const vx = -Math.sin(a) * b.w * b.r, vz = Math.cos(a) * b.w * b.r;
      const v = Math.hypot(vx, vz);
      const yaw = Math.atan2(vx, vz);
      const bank = Math.atan((v * v) / (Math.abs(b.r) * 9.81)) * Math.sign(b.w);
      this.e.set(-Math.atan2(vy, v) * 0.6, yaw, bank);
      this.q.setFromEuler(this.e);
      // past ~800 m a bird is under two pixels: gone (seen from the summit, the far gulls drew a ragged column of
      // specks down the sea)
      const far = cam ? 1 - THREE.MathUtils.smoothstep(this.p.distanceTo(cam), 500, 800) : 1;
      this.s.setScalar(b.scale * Math.max(far, 1e-4));
      this.m4.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m4);
      (this.rot.array as Float32Array).set([this.q.x, this.q.y, this.q.z, this.q.w], i * 4);
      // flapping in bursts between glides (frigatebirds hardly ever beat)
      const burst = THREE.MathUtils.smoothstep(Math.sin(t * 0.27 + b.seed * 3.1), 0.15, 0.55);
      f[i * 4] = b.seed * 7.3;
      f[i * 4 + 1] = b.dark ? 0.03 + 0.2 * burst * 0.3 : 0.05 + 0.5 * burst;
      f[i * 4 + 2] = b.dark;
      f[i * 4 + 3] = this.s.x;
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.flap.needsUpdate = true;
    this.rot.needsUpdate = true;
  }
}
