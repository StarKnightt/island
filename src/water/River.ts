/**
 * Fresh water: the river ribbon from the spring to the lagoon, the plunge pool, and the falls between them. The
 * river and pool refract their beds with a clear, slightly green absorption and flow-scrolled ripples (faster over
 * the steeper reaches, foamy at riffles and under the falls); the falls are a curved sheet of streaming water with
 * spray and a mist cloud rising from the pool.
 */
import * as THREE from 'three/webgpu';
import {
  abs, attribute, cameraPosition, clamp, dot, exp, float, length, max, min, mix, mx_noise_float, mx_fractal_noise_float,
  normalize, positionWorld, positionView, pow, screenUV, select, smoothstep, transformNormalToView, uniform, uv, vec2,
  vec3, vec4, viewportSharedTexture, sin, fract, hash, instanceIndex, positionLocal, reflect, type N,
} from '../core/tsl';
import type { Heightfield } from '../world/Heightfield';
import { sceneViewDepth } from '../core/depth';
import { wetness } from '../world/weatherUniforms';
import { cloudShadow } from '../sky/Sky';
import { atmo } from '../sky/Atmosphere';

export const riverU = { time: uniform(0) };

export class River {
  readonly group = new THREE.Group();
  readonly fallsCenter = new THREE.Vector3();
  readonly poolCenter = new THREE.Vector3();

  private poolR: number;

  constructor(private hf: Heightfield) {
    this.group.name = 'river';
    this.poolR = hf.meta.pool.r;
    this.buildRibbon();
    this.buildPool();
    this.buildFalls();
  }

  private waterMats: { m: THREE.MeshStandardNodeMaterial; env: number }[] = [];

  /**
   * The sky reflection on fresh water: banks, cliffs and canopy hide most of the sky over the river and the pool,
   * so they take the shared environment at a fraction of its strength.
   */
  setEnvironment(tex: THREE.Texture) {
    for (const { m, env } of this.waterMats) {
      m.envMap = tex;
      m.envMapIntensity = env;
      m.needsUpdate = true;
    }
  }

  private waterMaterial(kind: 'river' | 'pool') {
    const m = new THREE.MeshStandardNodeMaterial();
    m.name = `water_${kind}`;
    this.waterMats.push({ m, env: kind === 'pool' ? 0.14 : 0.35 });
    m.transparent = true;
    m.depthWrite = true;
    const p = positionWorld;
    const t = riverU.time;
    // flow: uv.x runs downstream in metres; speed from the attribute (m/s)
    const flowSpeed = kind === 'river' ? attribute('flow', 'float') : float(0.25);
    const along = kind === 'river' ? uv().x : length(p.xz.sub(vec2(this.poolCenter.x, this.poolCenter.z)));
    const across = kind === 'river' ? uv().y : float(0);
    const s1 = vec3(along.mul(0.55).sub(t.mul(flowSpeed).mul(0.55)), across.mul(0.8), t.mul(0.15));
    const n1 = mx_noise_float(s1);
    const n2 = mx_noise_float(vec3(along.mul(1.6).sub(t.mul(flowSpeed).mul(1.7)), across.mul(2.2).add(3.1), t.mul(0.3)));
    const n3 = mx_noise_float(vec3(p.x.mul(3.1), p.z.mul(3.1), t.mul(1.2)));
    const rough = kind === 'river' ? clamp(flowSpeed.mul(0.45), 0.15, 1.4) : float(0.25);
    let slope: N = vec2(n1.mul(0.5).add(n2.mul(0.35)), n2.mul(0.5).sub(n1.mul(0.3))).mul(rough.mul(0.18)).add(vec2(n3.mul(0.03)));
    // rain rings
    slope = slope.add(vec2(mx_noise_float(vec3(p.xz.mul(4.0), t.mul(4.0))), mx_noise_float(vec3(p.xz.mul(4.0).add(9), t.mul(4.0)))).mul(wetness.intensity.mul(0.12)));
    const N0 = normalize(vec3(slope.x, 1, slope.y));
    const V = normalize(cameraPosition.sub(p));
    const NdotV = clamp(dot(N0, V), 0, 1);
    const viewZ = positionView.z.negate();
    const uvR0 = screenUV.add(N0.xz.mul(0.03).div(max(viewZ.mul(0.05), 1)));
    const sceneZ0 = sceneViewDepth(uvR0);
    const uvR = select(sceneZ0.lessThan(viewZ), screenUV, uvR0);
    const thick = max(sceneViewDepth(uvR).sub(viewZ), 0).mul(length(cameraPosition.sub(p)).div(max(viewZ, 0.01)));
    const behind = viewportSharedTexture(uvR).rgb;
    // the plunge pool is deep and tea-green with leaf tannins; the shallow river runs clearer
    const sigma = (kind === 'pool' ? vec3(0.44, 0.17, 0.27) : vec3(0.3, 0.12, 0.13)).mul(float(1).add(wetness.rain.mul(1.5)));
    const trans = exp(sigma.negate().mul(min(thick.mul(1.6), 30)));
    // foam: riffles where the flow is fast, the churn under the falls
    const fast = kind === 'river' ? smoothstep(0.9, 2.2, flowSpeed) : float(0);
    const fn = mx_fractal_noise_float(vec3(along.mul(0.9).sub(t.mul(flowSpeed)), across.mul(1.3), t.mul(0.2)), 3, 2, 0.5).mul(0.5).add(0.5);
    let foam: N = fast.mul(smoothstep(0.5, 0.75, fn));
    if (kind === 'pool') {
      const dFall = length(p.xz.sub(vec2(this.fallsCenter.x, this.fallsCenter.z)));
      const churn = float(1).sub(smoothstep(1.5, 9, dFall));
      const ring = mx_fractal_noise_float(vec3(p.xz.mul(0.7), t.mul(0.6)), 3, 2, 0.5).mul(0.5).add(0.5);
      foam = max(foam, churn.mul(smoothstep(0.3, 0.6, ring.add(churn.mul(0.3)))));
    }
    // the edge against the banks: foam lines where the water is very shallow
    foam = max(foam, smoothstep(0.12, 0.0, thick).mul(kind === 'pool' ? 0.22 : 0.4));
    const F = float(0.02).add(float(0.98).mul(pow(float(1).sub(NdotV), 5)));
    const body = mix(vec3(0.01, 0.03, 0.025), vec3(0.02, 0.05, 0.035), smoothstep(4, 0.5, thick));
    const cloud = cloudShadow(p);
    m.colorNode = vec4(mix(body, vec3(0.85, 0.88, 0.86), foam), 1);
    m.roughnessNode = mix(float(0.04), float(0.75), foam);
    m.metalnessNode = float(0);
    m.normalNode = transformNormalToView(N0);
    // what low reflections really show here is the gorge wall and the jungle, not the sky: a dark lit surround
    const R = reflect(V.negate(), N0);
    const surroundW = kind === 'pool' ? float(1).sub(smoothstep(0.2, 0.65, R.y)) : float(1).sub(smoothstep(0.04, 0.35, R.y));
    const surround = vec3(0.05, 0.065, 0.045).mul(atmo.lightE.mul(1 / Math.PI)).mul(mix(float(0.7), float(1), cloud));
    m.emissiveNode = behind.mul(trans).mul(float(1).sub(F)).mul(float(1).sub(foam)).mul(mix(float(0.8), float(1), cloud))
      .add(surround.mul(F).mul(surroundW).mul(float(1).sub(foam)));
    // the pool's rim runs under the banks; where the outflow notch cuts it, the surface feathers into the stream
    if (kind === 'pool') m.opacityNode = smoothstep(this.poolR + 1.4, this.poolR - 0.6, along);
    void hash; void instanceIndex; void abs; void sin; void fract; void positionLocal;
    return m;
  }

  private buildRibbon() {
    const r = this.hf.river;
    const pos: number[] = [], uvs: number[] = [], flow: number[] = [], idx: number[] = [];
    const meta = this.hf.meta;
    let along = 0;
    for (let i = 0; i < r.length; i++) {
      const a = r[Math.max(0, i - 1)], b = r[Math.min(r.length - 1, i + 1)];
      const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l, nz = dx / l;
      const s = r[i];
      // skip the stretch that the falls and the pool own
      const inFalls = s.s > meta.falls.s - 1.2 && s.s < meta.falls.s + 2;
      if (i > 0) along += Math.hypot(s.x - r[i - 1].x, s.z - r[i - 1].z);
      const half = s.w / 2 + 1.2;
      const drop = i > 0 ? (r[i - 1].water - s.water) / Math.max(0.5, Math.hypot(s.x - r[i - 1].x, s.z - r[i - 1].z)) : 0;
      const speed = THREE.MathUtils.clamp(0.4 + drop * 25, 0.35, 2.8);
      const y = inFalls ? meta.falls.top : s.water;
      pos.push(s.x + nx * half, y, s.z + nz * half, s.x - nx * half, y, s.z - nz * half);
      uvs.push(along, -half, along, half);
      flow.push(speed, speed);
    }
    const n = r.length;
    for (let i = 0; i < n - 1; i++) {
      // no quads across the falls drop (the sheet covers it) or inside the pool (the pool disc covers it)
      const s0 = r[i], s1 = r[i + 1];
      if (s1.s > meta.falls.s - 0.5 && s0.s < meta.falls.s + 1.5) continue;
      const dp = Math.hypot(s0.x - meta.pool.p[0], s0.z - meta.pool.p[1]);
      if (dp < meta.pool.r - 1) continue;
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('flow', new THREE.Float32BufferAttribute(flow, 1));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, this.waterMaterial('river'));
    mesh.renderOrder = 11;
    mesh.receiveShadow = true;
    mesh.name = 'river';
    this.group.add(mesh);
  }

  private buildPool() {
    const { pool } = this.hf.meta;
    this.poolCenter.set(pool.p[0], pool.level, pool.p[1]);
    const g = new THREE.CircleGeometry(pool.r + 1.5, 72, 0, Math.PI * 2);
    g.rotateX(-Math.PI / 2);
    g.translate(pool.p[0], pool.level, pool.p[1]);
    const mesh = new THREE.Mesh(g, this.waterMaterial('pool'));
    mesh.renderOrder = 11;
    mesh.receiveShadow = true;
    mesh.name = 'pool';
    this.group.add(mesh);
  }

  private buildFalls() {
    const { falls } = this.hf.meta;
    const [lx, lz] = falls.lip, [tx, tz] = falls.toward;
    const dx = tx - lx, dz = tz - lz, dl = Math.hypot(dx, dz);
    const fx = dx / dl, fz = dz / dl;
    const nx = -fz, nz = fx;
    const top = falls.top, bottom = falls.bottom;
    const H = top - bottom;
    const W = falls.width + 1.2;
    this.fallsCenter.set(lx + fx * 2.2, bottom, lz + fz * 2.2);
    // a sheet: leaves the lip horizontally, falls in a parabola, widening slightly
    const rows = 28, cols = 10;
    const pos: number[] = [], uvs: number[] = [], idx: number[] = [];
    const v0 = 1.6; // m/s over the lip
    const tFall = Math.sqrt((2 * H) / 9.81);
    for (let j = 0; j <= rows; j++) {
      const t = (j / rows) * tFall;
      const out = 0.4 + v0 * t;
      const y = top - 0.5 * 9.81 * t * t;
      const spread = 1 + (j / rows) * 0.25;
      for (let i = 0; i <= cols; i++) {
        const u = i / cols - 0.5;
        const wob = Math.sin(u * 9 + j * 0.7) * 0.08;
        pos.push(lx + fx * (out + wob) + nx * u * W * spread, y, lz + fz * (out + wob) + nz * u * W * spread);
        uvs.push(i / cols, j / rows);
      }
    }
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i, b = a + 1, c = a + cols + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.MeshStandardNodeMaterial();
    m.name = 'falls';
    m.transparent = true;
    m.depthWrite = false;
    m.side = THREE.DoubleSide;
    const t = riverU.time;
    const U = uv();
    // streaks stream downward and accelerate
    const vAcc = U.y.mul(U.y).mul(H * 0.8).add(U.y.mul(2));
    const streak = mx_fractal_noise_float(vec3(U.x.mul(W * 3.2), vAcc.sub(t.mul(6.5)).mul(0.35), t.mul(0.2)), 4, 2.1, 0.55).mul(0.5).add(0.5);
    const fine = mx_noise_float(vec3(U.x.mul(W * 14), vAcc.sub(t.mul(9)).mul(1.2), 0.5)).mul(0.5).add(0.5);
    const edge = smoothstep(0.0, 0.12, U.x).mul(smoothstep(1.0, 0.88, U.x));
    const dens = clamp(streak.mul(1.15).add(fine.mul(0.35)).sub(0.25), 0, 1);
    const alpha = clamp(dens.mul(edge).mul(mix(float(0.75), float(0.98), U.y)), 0, 1);
    const cloud = cloudShadow(positionWorld);
    m.colorNode = vec4(vec3(0.82, 0.86, 0.86).mul(mix(float(0.7), float(1.05), dens)), alpha);
    m.opacityNode = alpha;
    m.roughnessNode = float(0.35);
    m.metalnessNode = float(0);
    m.emissiveNode = vec3(0.05, 0.06, 0.06).mul(dens).mul(cloud).mul(atmo.lightE.mul(0.075));
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = 12;
    mesh.name = 'falls';
    this.group.add(mesh);
    this.buildMist(lx + fx * 2.6, bottom, lz + fz * 2.6, W);
  }

  /** spray and mist rising from the plunge: camera-facing soft particles */
  private buildMist(x: number, y: number, z: number, W: number) {
    const count = 220;
    const geo = new THREE.PlaneGeometry(1, 1);
    const m = new THREE.SpriteNodeMaterial();
    m.transparent = true;
    m.depthWrite = false;
    const t = riverU.time;
    const id = float(instanceIndex);
    const seed = hash(id.mul(13.7));
    const life = fract(t.mul(0.12).add(seed));
    const ang = hash(id.mul(7.1)).mul(Math.PI * 2);
    const rad = hash(id.mul(3.3)).mul(W * 0.6).add(life.mul(5));
    const off = vec3(sin(ang).mul(rad), life.mul(life).mul(9).add(life.mul(1.5)), sin(ang.add(1.57)).mul(rad));
    m.positionNode = vec3(x, y + 0.3, z).add(off);
    const size = mix(float(1.5), float(6.5), life);
    m.scaleNode = vec2(size, size);
    const uvc = uv().sub(0.5);
    const soft = smoothstep(0.5, 0.0, length(uvc));
    const fade = smoothstep(0.0, 0.15, life).mul(smoothstep(1.0, 0.5, life));
    // unlit sprite: lit here as a white scatterer under the current sun/moon and sky
    m.colorNode = vec4(vec3(0.86, 0.9, 0.92).mul(atmo.lightE.mul(0.7 / Math.PI)).mul(cloudShadow(vec3(x, y, z)).mul(0.4).add(0.6)), soft.mul(fade).mul(0.12));
    m.opacityNode = soft.mul(fade).mul(0.12);
    const sprite = new THREE.Sprite(m);
    (sprite as unknown as { count: number }).count = count;
    sprite.frustumCulled = false;
    sprite.renderOrder = 13;
    sprite.name = 'mist';
    this.group.add(sprite);
    void geo;
  }

  update(t: number) {
    riverU.time.value = t;
  }
}
