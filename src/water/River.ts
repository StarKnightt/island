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
  vec3, vec4, viewportSharedTexture, sin, fract, hash, instanceIndex, reflect, texture, varying, normalWorldGeometry,
  type N,
} from '../core/tsl';
import type { Heightfield } from '../world/Heightfield';
import { sceneViewDepth } from '../core/depth';
import { wetness } from '../world/weatherUniforms';
import { cloudShadow } from '../sky/Sky';
import { atmo, skyRadiance } from '../sky/Atmosphere';
import { laceTex } from './surf';
import { sprayU } from './Spray';
import { preset } from '../core/quality';
import { fallsPath } from './fallsPath';

export const riverU = { time: uniform(0) };

export class River {
  readonly group = new THREE.Group();
  readonly fallsCenter = new THREE.Vector3();
  readonly poolCenter = new THREE.Vector3();

  private poolR: number;

  constructor(private hf: Heightfield) {
    this.group.name = 'river';
    this.poolR = hf.meta.pool.r;
    // the falls first: the pool's surface reads where they land
    this.buildFalls();
    this.buildRibbon();
    this.buildPool();
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
    this.waterMats.push({ m, env: kind === 'pool' ? 0.06 : 0.3 });
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
    // the plunge: distance from the line where the falls land (stretched across their width)
    const fd = vec2(this.fallDir.x, this.fallDir.y);
    const rel = p.xz.sub(vec2(this.impact.x, this.impact.z));
    const ra = dot(rel, fd), rc = dot(rel, vec2(fd.y.negate(), fd.x));
    const rImp = length(vec2(ra, max(abs(rc).sub(this.impactW * 0.4), 0)));
    if (kind === 'pool') {
      // rings running out from the impact, and a short steep chop in the boil
      const dirR = normalize(rel.add(vec2(0.001, 0)));
      const ring = sin(rImp.mul(2.3).sub(t.mul(5.5))).mul(0.6).add(sin(rImp.mul(4.1).sub(t.mul(8.3)).add(1.3)).mul(0.4));
      slope = slope.add(dirR.mul(ring.mul(exp(rImp.mul(-0.13))).mul(smoothstep(0.5, 3.0, rImp)).mul(0.3)));
      const boil = float(1).sub(smoothstep(1.0, 8.0, rImp));
      slope = slope.add(vec2(mx_noise_float(vec3(p.xz.mul(1.7), t.mul(2.2))), mx_noise_float(vec3(p.xz.mul(1.7).add(5.3), t.mul(2.2)))).mul(boil.mul(0.35)));
    }
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
    const sigma = (kind === 'pool' ? vec3(0.62, 0.3, 0.42) : vec3(0.3, 0.12, 0.13)).mul(float(1).add(wetness.rain.mul(1.5)));
    const trans = exp(sigma.negate().mul(min(thick.mul(1.6), 30)));
    // foam: riffles where the flow is fast, the churn under the falls
    const fast = kind === 'river' ? smoothstep(0.9, 2.2, flowSpeed) : float(0);
    const fn = mx_fractal_noise_float(vec3(along.mul(0.9).sub(t.mul(flowSpeed)), across.mul(1.3), t.mul(0.2)), 3, 2, 0.5).mul(0.5).add(0.5);
    let foam: N = fast.mul(smoothstep(0.5, 0.75, fn));
    if (kind === 'pool') {
      // white water boiling where the falls land, breaking into a lace of foam that the current carries out over
      // the pool, thinning as it goes
      const drift = fd.mul(t.mul(0.45));
      const l1 = texture(laceTex, p.xz.sub(drift).div(6.5));
      const l2 = texture(laceTex, p.xz.sub(drift.mul(1.4)).div(2.4).add(0.37));
      const pat = l1.r.mul(0.6).add(l2.a.mul(0.4));
      const cover = float(1).sub(smoothstep(0.5, 13, rImp)).pow(1.3).mul(mix(float(0.75), float(1.2), l1.b));
      foam = max(foam, smoothstep(0, 0.16, pat.sub(float(1.04).sub(cover.mul(1.15)))));
      foam = max(foam, smoothstep(3.2, 0.6, rImp));
    }
    // the edge against the banks: only the river's riffles leave a line; elsewhere the water thins to nothing
    if (kind === 'river') foam = max(foam, smoothstep(0.12, 0.0, thick).mul(fast).mul(0.4));
    const F = float(0.02).add(float(0.98).mul(pow(float(1).sub(NdotV), 5)));
    // (clear water scatters little: a dark tea-green body, lighter only over the shallow edges)
    const body = kind === 'pool' ? mix(vec3(0.0035, 0.011, 0.008), vec3(0.012, 0.03, 0.02), smoothstep(3, 0.4, thick)) : mix(vec3(0.01, 0.03, 0.025), vec3(0.02, 0.05, 0.035), smoothstep(4, 0.5, thick));
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
    // the pool's rim runs under the banks; where the outflow notch cuts it, the surface feathers into the stream; at
    // every bank the water thins to nothing over the last few centimetres instead of ending in a line
    const thin = smoothstep(0.0, 0.18, thick).max(foam.mul(0.6));
    m.opacityNode = kind === 'pool' ? smoothstep(this.poolR + 1.4, this.poolR - 0.6, along).mul(thin) : thin;
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

  /** where the falls land, the across direction and the width there (set by buildFalls, used by the pool) */
  readonly impact = new THREE.Vector3();
  private fallDir = new THREE.Vector2(1, 0);
  private impactW = 8;

  /**
   * The falls: two sheets on the ballistic path from the lip (leaving it at ~1.6 m/s, falling ~20 m in 2 s), widening
   * as they drop. Every texel is shaded by the moment its water left the lip, so streaks and aerated lumps travel
   * down with the water and stretch as it accelerates (not a texture scrolling on a card). The top is a glassy green
   * tongue, the body thick white water translucent only at its frayed edges; a sparser veil of clumps in front gives
   * it depth. Splash and mist rise from the plunge.
   */
  private buildFalls() {
    const path = fallsPath(this.hf);
    const { lx, lz, fx, fz, W, tFall, outEnd, bottom } = path;
    this.fallsCenter.set(lx + fx * (outEnd - 1.4), bottom, lz + fz * (outEnd - 1.4));
    this.impact.set(lx + fx * outEnd, bottom, lz + fz * outEnd);
    this.fallDir.set(fx, fz);
    this.impactW = W * 1.4;
    const sheet = (offset: number, widen: number, name: string, veil: boolean) => {
      const rows = 40, cols = 26;
      const pos: number[] = [], uvs: number[] = [], idx: number[] = [];
      const p = new THREE.Vector3();
      for (let j = 0; j <= rows; j++) {
        const f = j / rows;
        for (let i = 0; i <= cols; i++) {
          path.point(i / cols - 0.5, f, offset, widen, p);
          pos.push(p.x, p.y, p.z);
          uvs.push(i / cols, f);
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
      const mesh = new THREE.Mesh(g, this.fallsMaterial(name, W, tFall, veil));
      mesh.renderOrder = veil ? 12.5 : 12;
      mesh.name = name;
      this.group.add(mesh);
    };
    sheet(0, 0.35, 'falls', false);
    sheet(0.55, 0.5, 'falls_veil', true);
    this.buildSplash(W);
  }

  private fallsMaterial(name: string, W: number, tFall: number, veil: boolean) {
    const m = new THREE.MeshStandardNodeMaterial();
    m.name = name;
    m.transparent = true;
    m.depthWrite = false;
    m.side = THREE.DoubleSide;
    const U = uv();
    const across = U.x.sub(0.5).mul(W);
    // when this water left the lip: the pattern rides with it
    const tau = riverU.time.sub(U.y.mul(tFall)).add(veil ? 17.3 : 0);
    const s1 = mx_noise_float(vec3(across.mul(1.9), tau.mul(0.8), 0.3));
    const s2 = mx_noise_float(vec3(across.mul(6.5), tau.mul(2.4), 1.7));
    const lumps = mx_noise_float(vec3(across.mul(0.9), tau.mul(3.1), 4.1));
    // aeration: glassy over the lip, white within a few metres, breaking up toward the plunge
    const aer = smoothstep(0.02, 0.3, U.y);
    const edge = float(0.5).sub(abs(U.x.sub(0.5)));
    const fray = smoothstep(0.0, mix(float(0.1), float(0.2), U.y).add(s2.mul(0.05)), edge.add(s1.mul(0.06)));
    let alpha: N;
    // thickness of the water here: strands and lumps over a body that pulses as surges come over the lip
    const surge = mx_noise_float(vec3(across.mul(0.18), tau.mul(0.55), 8.8));
    const dens = float(0.5).add(s1.mul(0.3)).add(s2.mul(0.16)).add(lumps.mul(aer).mul(0.32)).add(surge.mul(0.16));
    if (veil) {
      // the veil: separate clumps and strands in front of the body, more of them lower down
      const clump = smoothstep(0.3, 0.75, lumps.mul(0.6).add(s1.mul(0.3)).add(U.y.mul(0.4)));
      alpha = clump.mul(fray).mul(aer).mul(0.9).mul(smoothstep(1.0, 0.86, U.y));
    } else {
      alpha = clamp(mix(float(0.4), dens.add(0.28), aer), 0, 1).mul(fray).mul(smoothstep(1.0, 0.9, U.y));
    }
    // colour: the glassy tongue is green-dark water; the body's thick strands white, the thin water between them
    // grey (the wet rock shows through), the clumps in front whitest
    const strands = smoothstep(0.3, 0.95, dens);
    const white = mix(vec3(0.36, 0.41, 0.4), vec3(0.85, 0.87, 0.87), veil ? float(0.9) : strands);
    const glassy = vec3(0.07, 0.11, 0.09);
    const col = mix(glassy, white, aer.max(0.25));
    m.colorNode = vec4(col, alpha);
    m.opacityNode = alpha;
    m.roughnessNode = mix(float(0.08), float(0.65), aer);
    m.metalnessNode = float(0);
    // light passing through the thin water toward the eye (backlit falls glow), and the glassy tongue's sky sheen
    const V = normalize(cameraPosition.sub(positionWorld));
    const fwd = pow(max(dot(atmo.sunDir.normalize().negate(), V), 0), 4);
    // (only the thin, frayed water lets the sun through; the thick body is lit from the front like snow)
    m.emissiveNode = vec3(0.9, 0.95, 0.95).mul(fwd.mul(0.012).mul(pow(float(1).sub(alpha.mul(0.85)), 2))).mul(atmo.lightE).mul(cloudShadow(positionWorld));
    // relief: the streaks and lumps as bumps across the sheet
    const bump = s1.mul(0.5).add(lumps.mul(0.4)).add(s2.mul(0.2));
    m.normalNode = transformNormalToView(normalize(vec3(normalWorldGeometry.x.add(bump.mul(this.fallDir.y)), normalWorldGeometry.y, normalWorldGeometry.z.sub(bump.mul(this.fallDir.x)))));
    return m;
  }

  /**
   * The plunge: a curtain of splash thrown up and out where the water lands (short, fast, bright), and the mist it
   * leaves (slow, rising and drifting down the pool, outliving it), both soft lumpy sprites lit by the sun and sky.
   */
  private buildSplash(W: number) {
    const c = this.impact, fd = this.fallDir;
    const ax = -fd.y, az = fd.x;
    const make = (count: number, mist: boolean) => {
      const m = new THREE.SpriteNodeMaterial();
      m.transparent = true;
      m.depthWrite = false;
      const t = riverU.time;
      const id = float(instanceIndex);
      const seed = (k: number) => hash(id.mul(k).add(mist ? 31.7 : 3.3));
      const life = mist ? float(7).add(seed(2.1).mul(5)) : float(1.1).add(seed(2.1).mul(1.1));
      const age = fract(t.div(life).add(seed(1.3)));
      const tt = age.mul(life);
      const acrossO = seed(4.7).sub(0.5).mul(W * 1.15);
      const base = vec3(c.x + ax * 0, c.y + 0.2, c.z).add(vec3(acrossO.mul(ax), 0, acrossO.mul(az)));
      let p: N;
      if (mist) {
        // rises slowly, spreads, drifts downstream (out over the pool) and with the wind
        const rise = float(1).sub(exp(tt.mul(-0.35))).mul(float(5).add(seed(5.5).mul(9)));
        const out = tt.mul(float(0.35).add(seed(6.1).mul(0.6)));
        const side = seed(6.9).sub(0.5).mul(tt).mul(0.9);
        const wd = wetness.windDir.mul(wetness.wind.mul(1.6).add(0.2)).mul(tt);
        p = base.add(vec3(fd.x, 0, fd.y).mul(out)).add(vec3(ax, 0, az).mul(side)).add(vec3(wd.x, rise, wd.y));
      } else {
        // thrown up and out, heavy drag, falling back
        const v0 = float(3).add(seed(5.5).mul(5.5));
        const ang = seed(6.1).mul(1.1).add(0.35);
        const k = 1.6;
        const reach = float(1).sub(exp(tt.mul(-k))).div(k);
        const up = v0.mul(ang.sin()).mul(reach).sub(tt.mul(tt).mul(9.81 * 0.4));
        const out = v0.mul(ang.cos()).mul(reach).mul(seed(7.3).mul(1.6).sub(0.3));
        p = base.add(vec3(fd.x, 0, fd.y).mul(out)).add(vec3(0, max(up, 0.1), 0));
      }
      m.positionNode = p;
      const size = mist ? mix(float(2.5), float(13), pow(age, 0.6)).mul(seed(8.8).mul(0.5).add(0.75)) : mix(float(0.8), float(3.4), pow(age, 0.5)).mul(seed(8.8).mul(0.6).add(0.7));
      m.scaleNode = vec2(size, size);
      // lit per particle: forward scattering toward the eye when backlit, the sky, the cloud shadows
      const V = cameraPosition.sub(p).normalize();
      const L = atmo.sunDir.normalize();
      const fwdS = pow(max(L.negate().dot(V), 0), 5).mul(1.8);
      const lit = varying(vec3(sprayU.sun).mul(fwdS.add(0.3)).mul(cloudShadow(p)).mul(0.9).add(skyRadiance(vec3(0, 1, 0)).mul(2.6)).mul(0.85));
      const fade = varying(smoothstep(0.0, mist ? 0.12 : 0.05, age).mul(pow(float(1).sub(age), mist ? 1.2 : 1.6)).mul(smoothstep(1.5, 6, length(p.sub(cameraPosition)))).mul(mist ? 0.3 : 0.55));
      const tex = varying(vec2(seed(9.2), seed(9.7)));
      const r = length(uv().sub(0.5)).mul(2);
      const lump = texture(laceTex, uv().mul(mist ? 0.18 : 0.3).add(tex)).b;
      const puff = smoothstep(1.0, 0.0, r).pow(1.5).mul(lump.mul(1.4).sub(0.1).clamp(0.2, 1.2));
      const soft = smoothstep(0.0, 1.4, sceneViewDepth(screenUV).sub(positionView.z.negate()));
      const a = puff.mul(fade).mul(soft);
      m.colorNode = vec4(lit, a);
      m.opacityNode = a;
      const sprite = new THREE.Sprite(m);
      (sprite as unknown as { count: number }).count = count;
      sprite.frustumCulled = false;
      sprite.renderOrder = mist ? 14 : 13;
      sprite.name = mist ? 'falls_mist' : 'falls_splash';
      this.group.add(sprite);
    };
    make(preset === 'low' ? 60 : 150, false);
    make(preset === 'low' ? 60 : 140, true);
  }

  update(t: number) {
    riverU.time.value = t;
  }
}
