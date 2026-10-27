/**
 * Fresh water: the river ribbon from the spring to the lagoon, the plunge pool, and the falls between them. The
 * river and pool refract their beds with a clear, slightly green absorption and flow-scrolled ripples (faster over
 * the steeper reaches, foamy at riffles and under the falls); the falls are a curved sheet of streaming water with
 * spray and a mist cloud rising from the pool.
 */
import { effectMRT } from '../core/fx';
import * as THREE from 'three/webgpu';
import {
  abs, attribute, cameraPosition, cameraProjectionMatrix, cameraViewMatrix, clamp, cos, dot, exp, float, floor,
  getScreenPosition, length, max, min, mix, mx_noise_float, normalize, positionWorld, positionView, pow, screenUV, select,
  smoothstep, sqrt, transformNormalToView, uniform, uv, vec2, vec3, vec4, viewportSharedTexture, sin, fract, hash,
  instanceIndex, reflect, texture, varying, normalWorldGeometry, faceDirection, type N,
} from '../core/tsl';
import type { Heightfield } from '../world/Heightfield';
import { sceneViewDepth } from '../core/depth';
import { wetness } from '../world/weatherUniforms';
import { cloudShadow } from '../sky/Sky';
import { atmo, particleSky } from '../sky/Atmosphere';
import { laceTex } from './surf';
import { sprayU } from './Spray';
import { preset } from '../core/quality';
import { sunLit } from '../core/lighting';
import { fallsPath } from './fallsPath';
import { heightLookup } from '../world/Terrain';
import { HALF_WORLD, WORLD_SIZE } from '../world/layout';

export const riverU = { time: uniform(0) };
/** TEMP diagnostics (falls helper): runtime switches for the pool's mirror */
export const poolDbg = { flip: uniform(0), mirror: uniform(1) };
(window as unknown as { __fallsDbg?: unknown }).__fallsDbg = poolDbg;

/**
 * Rain on standing water: rings spreading from drops that land at random in ~0.4 m cells (two layers), as a surface
 * slope (xz). Seeds stay positive (TSL's hash clamps negative ones to 0).
 */
function rainRings(q: N, t: N): N {
  let s: N = vec2(0);
  for (const [scale, off, speed] of [[2.4, 0.0, 1.35], [3.1, 0.53, 1.8]]) {
    const g = q.mul(scale).add(off + 4096);
    const cell = floor(g);
    const h1 = hash(cell.x.add(cell.y.mul(131.7)));
    const h2 = hash(cell.x.mul(17.3).add(cell.y.mul(3.1)).add(911));
    const c = fract(g).sub(0.5).sub(vec2(h1, h2).sub(0.5).mul(0.5));
    const r = length(c);
    const age = fract(t.mul(speed).add(h1.mul(9.7)));
    const front = r.sub(age.mul(0.42));
    const k = sin(front.mul(46)).mul(smoothstep(0.09, 0.0, abs(front))).mul(float(1).sub(age).pow(2));
    s = s.add(c.div(max(r, 1e-3)).mul(k));
  }
  return s;
}

/**
 * The sky's light on white water: the falls, the churn and the spray are lit by the whole dome and by light scattered
 * many times inside the foam, which washes the sky's blue out (with the zenith's colour the shaded falls of an
 * afternoon glowed a saturated blue)
 */
function whiteSky(): N {
  const s = particleSky();
  return mix(vec3(dot(s, vec3(0.2126, 0.7152, 0.0722))).mul(vec3(0.97, 0.99, 1.03)), s, 0.3);
}

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
   * The sky reflection on the river: banks and canopy hide most of the sky over it, so it takes the shared
   * environment at a fraction of its strength. (The pool works out its own reflection: see poolMaterial.)
   */
  setEnvironment(tex: THREE.Texture) {
    for (const { m, env } of this.waterMats) {
      m.envMap = tex;
      m.envMapIntensity = env;
      m.needsUpdate = true;
    }
  }

  /** the water's thickness along the view ray and the refracted scene behind it, from the opaque pass's copies */
  private refraction(N0: N) {
    const p = positionWorld;
    const viewZ = positionView.z.negate();
    const uvR0 = screenUV.add(N0.xz.mul(0.03).div(max(viewZ.mul(0.05), 1)));
    const sceneZ0 = sceneViewDepth(uvR0);
    const uvR = select(sceneZ0.lessThan(viewZ), screenUV, uvR0);
    const thick = max(sceneViewDepth(uvR).sub(viewZ), 0).mul(length(cameraPosition.sub(p)).div(max(viewZ, 0.01)));
    return { thick, behind: viewportSharedTexture(uvR).rgb };
  }

  private riverMaterial() {
    const m = sunLit(new THREE.MeshStandardNodeMaterial());
    m.name = 'water_river';
    this.waterMats.push({ m, env: 0.22 });
    m.transparent = true;
    m.depthWrite = true;
    const p = positionWorld;
    const t = riverU.time;
    // flow: uv.x runs downstream in metres; speed from the attribute (m/s)
    const flowSpeed = attribute('flow', 'float');
    const along = uv().x, across = uv().y;
    const n1 = mx_noise_float(vec3(along.mul(0.55).sub(t.mul(flowSpeed).mul(0.55)), across.mul(0.8), t.mul(0.15)));
    const n2 = mx_noise_float(vec3(along.mul(1.6).sub(t.mul(flowSpeed).mul(1.7)), across.mul(2.2).add(3.1), t.mul(0.3)));
    // fine chop and the riffles' foam from the lace texture, scrolled with the flow and drawn out along it
    const fl = texture(laceTex, vec2(along.sub(t.mul(flowSpeed)).div(5.2), across.div(1.7)));
    const fl2 = texture(laceTex, vec2(along.sub(t.mul(flowSpeed).mul(1.3)).div(11), across.div(4.2)).add(0.41));
    const rough = clamp(flowSpeed.mul(0.45), 0.15, 1.4);
    let slope: N = vec2(n1.mul(0.5).add(n2.mul(0.35)), n2.mul(0.5).sub(n1.mul(0.3))).mul(rough.mul(0.18)).add(vec2(fl.g.sub(0.5), fl.b.sub(0.5)).mul(0.06));
    slope = slope.add(rainRings(p.xz, t).mul(wetness.intensity.mul(0.35)));
    const N0 = normalize(vec3(slope.x, 1, slope.y));
    const V = normalize(cameraPosition.sub(p));
    const NdotV = clamp(dot(N0, V), 0, 1);
    const { thick, behind } = this.refraction(N0);
    // the shallow river runs clear, a little green
    const sigma = vec3(0.3, 0.12, 0.13).mul(float(1).add(wetness.rain.mul(1.5)));
    const trans = exp(sigma.negate().mul(min(thick.mul(1.6), 30)));
    // foam: riffles where the flow is fast, but not on the glassy tongue that speeds smooth and dark into the drop
    const tongue = smoothstep(this.alongLip - 10, this.alongLip - 3, along).mul(smoothstep(this.alongLip + 2, this.alongLip + 0.5, along));
    const fast = smoothstep(0.9, 2.2, flowSpeed).mul(float(1).sub(tongue));
    const fn = fl.r.mul(0.55).add(fl2.a.mul(0.45));
    let foam: N = fast.mul(smoothstep(0.52, 0.8, fn));
    // the edge against the banks: only the riffles leave a line; elsewhere the water thins to nothing
    foam = max(foam, smoothstep(0.12, 0.0, thick).mul(fast).mul(0.4));
    const F = float(0.02).add(float(0.98).mul(pow(float(1).sub(NdotV), 5)));
    // (clear water scatters little: a dark green body, lighter only over the shallow edges)
    const body = mix(vec3(0.01, 0.03, 0.025), vec3(0.02, 0.05, 0.035), smoothstep(4, 0.5, thick));
    const cloud = cloudShadow(p);
    m.colorNode = vec4(mix(body, vec3(0.85, 0.88, 0.86), foam), 1);
    m.roughnessNode = mix(float(0.04), float(0.75), foam);
    m.metalnessNode = float(0);
    m.normalNode = transformNormalToView(N0);
    // what low reflections really show here is the bank and the jungle, not the sky: a dark lit surround
    const R = reflect(V.negate(), N0);
    const surroundW = float(1).sub(smoothstep(0.04, 0.35, R.y));
    const surround = vec3(0.05, 0.065, 0.045).mul(atmo.lightE.mul(1 / Math.PI)).mul(mix(float(0.7), float(1), cloud));
    m.emissiveNode = behind.mul(trans).mul(float(1).sub(F)).mul(float(1).sub(foam)).mul(mix(float(0.8), float(1), cloud))
      .add(surround.mul(F).mul(surroundW).mul(float(1).sub(foam)));
    // at every bank the water thins to nothing over the last few centimetres instead of ending in a line
    m.opacityNode = smoothstep(0.0, 0.18, thick).max(foam.mul(0.6));
    return m;
  }

  /**
   * The plunge pool: milky jade water (it scatters as well as absorbs, so the deep middle is a lit jade, not a black
   * hole) over an uneven bed; agitated round the impact, glassy toward the outflow. The calm water mirrors the gorge:
   * the reflected ray meets a cylinder standing round the pool (its walls, banks and the forest on them) and reads the
   * opaque scene where that point is on screen; where it is off screen or hidden behind something nearer, a dark lit
   * surround stands in. The falls, drawn after the scene copy, are mirrored on their own. Foam boils under the falls
   * and drifts in a widening plume toward the outflow.
   */
  private poolMaterial() {
    const m = sunLit(new THREE.MeshStandardNodeMaterial());
    m.name = 'water_pool';
    // its own environment at zero: the mirror below replaces the sky reflection (left unset, the scene's
    // environment would apply at full strength)
    this.waterMats.push({ m, env: 0 });
    m.transparent = true;
    m.depthWrite = true;
    const p = positionWorld, q = p.xz;
    const t = riverU.time;
    const C = vec2(this.poolCenter.x, this.poolCenter.z);
    const fd = vec2(this.fallDir.x, this.fallDir.y), ac = vec2(-this.fallDir.y, this.fallDir.x);
    const rel = q.sub(vec2(this.impact.x, this.impact.z));
    const ra = dot(rel, fd), rc = dot(rel, ac);
    const rImp = length(vec2(ra, max(abs(rc).sub(this.impactW * 0.4), 0)));
    // ---- the surface: chop round the impact dying out over ~15 m, small ripples everywhere, rain rings
    const agit = exp(rImp.mul(-0.16));
    const calm = float(0.35).add(wetness.wind.mul(0.8));
    let slope: N = vec2(0);
    for (const [kx, kz, w, a] of [[1.9, 0.7, 2.1, 0.011], [-1.1, 2.3, 2.6, 0.008], [3.3, -2.6, 3.9, 0.005], [-4.7, -1.3, 4.6, 0.004]]) {
      slope = slope.add(vec2(kx, kz).mul(cos(q.x.mul(kx).add(q.y.mul(kz)).add(t.mul(w))).mul(a)));
    }
    const g1 = texture(laceTex, q.div(3.7).add(t.mul(0.021)));
    slope = slope.add(vec2(g1.g.sub(0.5), g1.b.sub(0.5)).mul(0.07)).mul(calm.add(agit.mul(2.5)));
    // rings running out from the impact, and a short steep chop in the boil
    const dirR = normalize(rel.add(vec2(0.001, 0)));
    // (trains of rings of uneven strength, their fronts warped by the boil, reaching across the pool)
    const warp = mx_noise_float(vec3(rel.x.mul(0.35), rel.y.mul(0.35), t.mul(0.21))).mul(2.2);
    const swell = sin(t.mul(0.83)).mul(sin(t.mul(0.31).add(2.0))).mul(0.35).add(0.75);
    const ring = sin(rImp.mul(2.3).sub(t.mul(5.5)).add(warp)).mul(0.6).add(sin(rImp.mul(4.1).sub(t.mul(8.3)).add(1.3).add(warp.mul(0.7))).mul(0.4));
    slope = slope.add(dirR.mul(ring.mul(swell).mul(exp(rImp.mul(-0.085))).mul(smoothstep(0.5, 3.0, rImp)).mul(0.36)));
    const boil = float(1).sub(smoothstep(1.0, 8.0, rImp));
    const b1 = texture(laceTex, q.div(2.1).add(vec2(t.mul(0.37), t.mul(-0.29))));
    const b2 = texture(laceTex, q.div(1.3).sub(vec2(t.mul(0.51), t.mul(0.43))).add(0.6));
    slope = slope.add(vec2(b1.g.add(b2.b).sub(1), b1.b.add(b2.g).sub(1)).mul(boil.mul(0.6)));
    slope = slope.add(rainRings(q, t).mul(wetness.intensity.mul(0.35)));
    const N0 = normalize(vec3(slope.x, 1, slope.y));
    const V = normalize(cameraPosition.sub(p));
    const NdotV = clamp(dot(N0, V), 0, 1);
    const F = float(0.02).add(float(0.98).mul(pow(float(1).sub(NdotV), 5)));
    // ---- the body: an uneven bed (boulders, gravel, sunken leaves) seen through milky water that turns jade with depth
    const { thick, behind } = this.refraction(N0);
    const bedN = texture(laceTex, q.div(8.5).add(0.21)).b;
    const dEff = thick.mul(mix(float(0.65), float(1.4), bedN)).mul(1.5);
    // (rain washes silt in: turbid tan-brown)
    const turbid = wetness.rain.mul(0.85);
    const sigma = mix(vec3(0.95, 0.5, 0.58), vec3(1.25, 1.15, 1.3), turbid);
    const T = exp(sigma.negate().mul(min(dEff, 30)));
    const bed = behind.mul(mix(float(0.72), float(1.12), bedN)).mul(vec3(0.92, 1.0, 0.94));
    const jade = mix(vec3(0.012, 0.036, 0.03), vec3(0.05, 0.04, 0.024), turbid);
    // ---- foam: a solid boil under the falls breaking into lace that drifts and spreads toward the outflow
    const down = max(ra, 0);
    const spread = down.mul(0.42).add(this.impactW * 0.45 + 1.5);
    const plume = exp(down.mul(-0.11)).mul(smoothstep(spread, spread.mul(0.25), abs(rc)));
    // (past the boil a thin scatter of drifting foam over the whole pool, thinning toward its banks)
    const cover = max(max(plume.mul(1.05), float(1).sub(smoothstep(0.5, 15, rImp)).pow(1.1)), exp(rImp.mul(-0.03)).mul(0.9));
    const drift = fd.mul(t.mul(0.5));
    const l1 = texture(laceTex, q.sub(drift).div(6.5));
    const l2 = texture(laceTex, q.sub(drift.mul(1.5)).div(2.4).add(0.37));
    // and lace carried outward from the boil, every way across the pool (two flow phases crossfaded, so the pattern
    // never shears apart however long it runs)
    const ph1 = fract(t.mul(0.07)), ph2 = fract(t.mul(0.07).add(0.5));
    const r1 = texture(laceTex, q.sub(dirR.mul(ph1.mul(7))).div(4.2)).r;
    const r2 = texture(laceTex, q.sub(dirR.mul(ph2.mul(7))).div(4.2).add(0.5)).r;
    const radial = r1.mul(float(1).sub(abs(ph1.mul(2).sub(1)))).add(r2.mul(float(1).sub(abs(ph2.mul(2).sub(1)))));
    const pat = mix(l1.r.mul(0.6).add(l2.a.mul(0.4)), radial, smoothstep(1.5, 5.0, rImp).mul(0.55));
    let foam: N = smoothstep(0, 0.16, pat.sub(float(0.98).sub(cover.mul(mix(float(0.85), float(1.25), l1.b)).mul(1.2))));
    // the boil itself, as wide as the falling water, churning with bubbles
    const rCore = length(vec2(ra, max(abs(rc).sub(this.impactW * 0.3), 0)));
    const churn = texture(laceTex, q.div(1.6).add(vec2(t.mul(0.9), t.mul(-0.7)))).g;
    const churn2 = texture(laceTex, q.div(3.3).sub(vec2(t.mul(0.55), t.mul(0.8))).add(0.27)).r;
    foam = max(foam, smoothstep(6.5, 1.0, rCore).mul(churn.mul(0.35).add(churn2.mul(0.3)).add(0.6))).clamp(0, 1);
    // ---- what the calm water mirrors
    const R = reflect(V.negate(), N0);
    const d0 = q.sub(C);
    const Rp = max(float(this.poolR), length(d0).add(0.5));
    const a = max(dot(R.xz, R.xz), 1e-4), b = dot(d0, R.xz), c = dot(d0, d0).sub(Rp.mul(Rp));
    const tc = sqrt(max(b.mul(b).sub(a.mul(c)), 0)).sub(b).div(a);
    const H = p.add(R.mul(tc));
    const vH = cameraViewMatrix.mul(vec4(H, 1)).xyz;
    // (the viewport copy's v runs the other way from getScreenPosition's on WebGPU)
    const uvH0 = getScreenPosition(vH, cameraProjectionMatrix);
    const uvH = vec2(uvH0.x, mix(float(1).sub(uvH0.y), uvH0.y, poolDbg.flip));
    const onScreen = smoothstep(0, 0.06, uvH.x).mul(smoothstep(1, 0.94, uvH.x)).mul(smoothstep(0, 0.06, uvH.y)).mul(smoothstep(1, 0.94, uvH.y));
    const dH = vH.z.negate();
    // (something nearer than the wall stands at that point on screen: the player, a boulder on the bank)
    const clear = smoothstep(dH.sub(5), dH.sub(2), sceneViewDepth(uvH));
    const wMirror = select(dH.greaterThan(0.5), onScreen.mul(clear), float(0));
    const cloud = cloudShadow(p);
    const lightE = atmo.lightE.mul(1 / Math.PI);
    const surround = vec3(0.045, 0.06, 0.04).mul(lightE).mul(mix(float(0.7), float(1), cloud));
    // (the falls are not mirrored: the pool in front of a falls this size is never calm enough to hold its image,
    // and a clean white stripe on the water gave the trick away)
    const mirror: N = mix(surround, viewportSharedTexture(uvH).rgb.mul(0.9), wMirror.mul(poolDbg.mirror));
    // ---- light: the sun on the jade body and the foam comes from the lighting model; the sky (most of it hidden by
    // the gorge) is added here, as are the bed seen through the water and the mirror
    // (a Lambert surface under a sky of radiance L gives back albedo x L; the gorge hides about half of the sky)
    // (the grey-white of the sky gap, not the zenith's blue: in the afternoon shade the foam and the body under a blue
    // sky term turned the whole pool navy)
    const skyE = varying(whiteSky()).mul(mix(float(0.85), float(2.2), foam));
    const diffuse = mix(jade.mul(float(1).sub(T)).mul(vec3(1.2, 1.6, 1.15)), vec3(0.85, 0.88, 0.86), foam);
    m.colorNode = vec4(diffuse, 1);
    m.roughnessNode = mix(float(0.05), float(0.75), foam);
    m.metalnessNode = float(0);
    m.normalNode = transformNormalToView(N0);
    const notFoam = float(1).sub(foam);
    m.emissiveNode = bed.mul(T).mul(float(1).sub(F)).mul(notFoam).mul(mix(float(0.8), float(1), cloud))
      .add(mirror.mul(F).mul(notFoam))
      .add(diffuse.mul(skyE));
    // the pool's rim runs under the banks; where the outflow notch cuts it, the surface feathers into the stream; at
    // every bank the water thins to nothing over the last few centimetres instead of ending in a line
    const thin = smoothstep(0.0, 0.18, thick).max(foam.mul(0.6));
    m.opacityNode = smoothstep(this.poolR + 1.4, this.poolR - 0.6, length(d0)).mul(thin);
    return m;
  }

  /** metres along the ribbon (its uv.x) at the lip of the falls */
  private alongLip = 0;

  private buildRibbon() {
    const r = this.hf.river;
    const pos: number[] = [], uvs: number[] = [], flow: number[] = [], idx: number[] = [];
    const meta = this.hf.meta;
    let along = 0, lipD = Infinity;
    for (let i = 0; i < r.length; i++) {
      const a = r[Math.max(0, i - 1)], b = r[Math.min(r.length - 1, i + 1)];
      const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l, nz = dx / l;
      const s = r[i];
      // skip the stretch that the falls and the pool own
      const inFalls = s.s > meta.falls.s - 1.2 && s.s < meta.falls.s + 2;
      if (i > 0) along += Math.hypot(s.x - r[i - 1].x, s.z - r[i - 1].z);
      if (Math.abs(s.s - meta.falls.s) < lipD) {
        lipD = Math.abs(s.s - meta.falls.s);
        this.alongLip = along;
      }
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
    const mesh = new THREE.Mesh(g, this.riverMaterial());
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
    const mesh = new THREE.Mesh(g, this.poolMaterial());
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
      // (no shadow map on the sheet: the straight shadow of the gorge's rim cut it with a hard seam; the low sun is
      // taken out by the march over the gorge in the material instead)
      mesh.receiveShadow = false;
      mesh.name = name;
      this.group.add(mesh);
    };
    sheet(0, 0.35, 'falls', false);
    sheet(0.55, 0.5, 'falls_veil', true);
    this.buildSplash(W);
  }

  private fallsMaterial(name: string, W: number, tFall: number, veil: boolean) {
    const m = sunLit(new THREE.MeshStandardNodeMaterial());
    m.name = name;
    m.transparent = true;
    m.depthWrite = false;
    m.side = THREE.DoubleSide;
    // (one surface: drawn once, not as a back pass and a front pass)
    m.forceSinglePass = true;
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
    // ragged sides: the edge wanders with the strands and the lumps coming down
    const fray = smoothstep(0.0, mix(float(0.1), float(0.2), U.y).add(s2.mul(0.05)), edge.add(s1.mul(0.09)).add(lumps.mul(aer).mul(0.05)));
    // the body is thick in the middle and thins toward the sides, where the rock shows through
    const core = smoothstep(0.04, 0.24, edge.add(s1.mul(0.05)));
    let alpha: N;
    // thickness of the water here: strands and lumps over a body that pulses as surges come over the lip
    const surge = mx_noise_float(vec3(across.mul(0.18), tau.mul(0.55), 8.8));
    // clumps of aerated water a metre or two across, tumbling down with it and stretching as it accelerates
    const clumps = mx_noise_float(vec3(across.mul(2.6), tau.mul(5.2), 2.2)).mul(aer);
    // fine strands: narrow across, long along the flow
    const fine = mx_noise_float(vec3(across.mul(13), tau.mul(1.6), 5.9));
    const fine2 = mx_noise_float(vec3(across.mul(29), tau.mul(3.4), 8.3));
    // (thin bright ridges where the noise crosses zero: the white threads of aerated water)
    const ridges = clamp(float(1).sub(fine.abs().mul(2.2)), 0, 1).mul(0.6).add(clamp(float(1).sub(fine2.abs().mul(2.5)), 0, 1).mul(0.4));
    const dens = float(0.5).add(fine.mul(0.14)).add(s1.mul(0.3)).add(s2.mul(0.16)).add(lumps.mul(aer).mul(0.32)).add(surge.mul(0.16)).add(clumps.mul(0.22));
    if (veil) {
      // the veil: separate clumps and strands in front of the body, more of them lower down
      const clump = smoothstep(0.3, 0.7, lumps.mul(0.5).add(s1.mul(0.25)).add(clumps.mul(0.45)).add(U.y.mul(0.45)));
      alpha = clump.mul(fray).mul(aer).mul(0.9).mul(smoothstep(1.0, 0.86, U.y));
    } else {
      // (a falls this size is a thick white column: see-through only over the lip and at its frayed sides)
      alpha = clamp(mix(float(0.6), dens.mul(1.5).add(0.55).add(core.mul(0.7)), aer), 0, 1).mul(fray).mul(smoothstep(1.0, 0.93, U.y));
    }
    // colour: the glassy tongue is green-dark water; the body's thick strands white with a bright core, the thin water
    // between them and at the sides grey (the wet rock shows through), the clumps in front whitest
    const strands = clamp(smoothstep(0.15, 0.7, dens).add(core.mul(0.6)).add(clumps.mul(0.3)).add(ridges.sub(0.45).mul(0.7).mul(aer)), 0, 1);
    const white = mix(vec3(0.42, 0.46, 0.45), vec3(0.93, 0.95, 0.95), veil ? float(0.95) : strands);
    const glassy = vec3(0.07, 0.11, 0.09);
    // (a low sun reaches the falls only through the gaps in the jungle and over the gorge's rim)
    const inSun = varying(this.gorgeSun(positionWorld, this.occluder()));
    const col = mix(glassy, white, aer.max(0.25)).mul(mix(float(0.3), float(1), inSun));
    m.colorNode = vec4(col, alpha);
    m.opacityNode = alpha;
    m.roughnessNode = mix(float(0.08), float(0.65), aer);
    m.metalnessNode = float(0);
    // light passing through the thin water toward the eye (backlit falls glow), and the glassy tongue's sky sheen
    const V = normalize(cameraPosition.sub(positionWorld));
    const fwd = pow(max(dot(atmo.sunDir.normalize().negate(), V), 0), 4);
    // (only the thin, frayed water lets the sun through; the thick body is lit from the front like snow; none of it
    // where the escarpment behind the falls hides a low sun)
    // (white water is lit by the sky it sees and by the light it scatters inside itself: the thick body glows
    // white in the gorge's shade instead of turning the blue-grey of a lit card)
    const skyLift = varying(whiteSky()).mul(col).mul(alpha.mul(0.55));
    m.emissiveNode = skyLift.add(vec3(0.9, 0.95, 0.95).mul(fwd.mul(0.012).mul(pow(float(1).sub(alpha.mul(0.85)), 2))).mul(atmo.lightE).mul(cloudShadow(positionWorld)).mul(inSun));
    // relief: the streaks and lumps as bumps across the sheet, on the side facing the eye (the custom normal skips
    // the built-in back-face flip: the sheet's geometric normal faces the cliff, and the sunset behind it would light
    // the face the camera sees)
    const bump = s1.mul(0.5).add(lumps.mul(0.4)).add(s2.mul(0.2)).add(clumps.mul(0.6)).add(ridges.mul(0.35));
    const nG = normalWorldGeometry.mul(faceDirection);
    m.normalNode = transformNormalToView(normalize(vec3(nG.x.add(bump.mul(this.fallDir.y)), nG.y, nG.z.sub(bump.mul(this.fallDir.x)))));
    return m;
  }

  /** what stands between the gorge and a low sun: the ground, and the jungle's canopy ~24 m over it where the forest is */
  private occluder() {
    const ground = heightLookup(this.hf);
    const mask = this.hf.mask0Tex;
    return (xz: N) => ground(xz).add(texture(mask, xz.add(HALF_WORLD).div(WORLD_SIZE)).level(0).w.mul(24));
  }

  /** share of the sun reaching a point down in the gorge: a short march over the heightfield toward the sun */
  private gorgeSun(p: N, heightAt: (xz: N) => N): N {
    const L = atmo.sunDir.normalize();
    const Lh = L.xz.div(max(length(L.xz), 1e-3)), rise = L.y.div(max(length(L.xz), 1e-3));
    let inSun: N = float(1);
    for (const k of [5, 12, 22, 36, 56]) inSun = inSun.mul(smoothstep(-1.5, 1.5, p.y.add(rise.mul(k)).sub(heightAt(p.xz.add(Lh.mul(k))))));
    return inSun;
  }

  /**
   * The plunge: a curtain of splash thrown up and out where the water lands (short, fast, bright), and the mist it
   * leaves (slow, rising and drifting down the pool, outliving it), both soft lumpy sprites lit by the sun and sky.
   */
  private buildSplash(W: number) {
    const c = this.impact, fd = this.fallDir;
    const heightAt = this.occluder();
    const ax = -fd.y, az = fd.x;
    const make = (count: number, mist: boolean) => {
      const m = new THREE.SpriteNodeMaterial();
      m.transparent = true;
      m.depthWrite = false;
      m.mrtNode = effectMRT();
      const t = riverU.time;
      const id = float(instanceIndex);
      const seed = (k: number) => hash(id.mul(k).add(mist ? 31.7 : 3.3));
      // the mist: most of it a low cloud hanging round the plunge, a third a veil drifting out low over the pool
      const veil = seed(3.9).lessThan(0.3);
      // (and a third a dense cloud hugging the plunge, greying the foot of the falls)
      const low = seed(3.9).greaterThanEqual(0.3).and(seed(3.9).lessThan(0.66));
      const life = mist ? select(veil, float(8).add(seed(2.1).mul(4)), float(5).add(seed(2.1).mul(3))) : float(0.9).add(seed(2.1).mul(0.9));
      const age = fract(t.div(life).add(seed(1.3)));
      const tt = age.mul(life);
      // every lifetime a particle is born again with new values (one fixed set per particle replayed the same
      // curtain of puffs every second); only its lifetime and its kind stay
      const cyc = floor(t.div(life).add(seed(1.3)));
      const sc = (k: number) => hash(id.mul(k).add(cyc.mul(13.17)).add(mist ? 57.1 : 11.9));
      // across the plunge: thickest in the middle, thinning out past the falls' edges (an even spread reads as a row
      // of puffs, or a cloud with straight sides)
      const acrossO = sc(4.7).add(sc(5.3)).sub(1).mul(W * (mist ? 1.05 : 0.85));
      const base = vec3(c.x, c.y + (mist ? 0.4 : -0.35), c.z).add(vec3(acrossO.mul(ax), 0, acrossO.mul(az)));
      let p: N;
      if (mist) {
        // rises a little, spreads, drifts downstream (out over the pool) and with the wind
        const rise = float(1).sub(exp(tt.mul(-0.5))).mul(select(veil, float(1.2).add(sc(5.5).mul(2.2)), select(low, float(0.5).add(sc(5.5).mul(1.6)), float(2).add(sc(5.5).mul(4.5)))));
        const out = tt.mul(select(veil, float(1.0).add(sc(6.1).mul(0.9)), select(low, float(0.1).add(sc(6.1).mul(0.5)), float(0.15).add(sc(6.1).mul(0.45)))));
        const side = sc(6.9).sub(0.5).mul(tt).mul(select(veil, float(1.3), float(0.7)));
        const wd = wetness.windDir.mul(wetness.wind.mul(1.6).add(0.2)).mul(tt);
        p = base.add(vec3(fd.x, 0, fd.y).mul(out)).add(vec3(ax, 0, az).mul(side)).add(vec3(wd.x, rise, wd.y));
      } else {
        // thrown up and out, heavy drag, falling back
        const v0 = float(2.5).add(sc(5.5).mul(4));
        const ang = sc(6.1).mul(0.8).add(0.6);
        const k = 1.6;
        const reach = float(1).sub(exp(tt.mul(-k))).div(k);
        const up = v0.mul(ang.sin()).mul(reach).sub(tt.mul(tt).mul(9.81 * 0.4));
        const out = v0.mul(ang.cos()).mul(reach).mul(sc(7.3).mul(1.6).sub(0.3));
        const side = sc(7.9).sub(0.5).mul(reach).mul(3.2);
        // (born in the boil, rising out of it: no gap between the spray and the water)
        p = base.add(vec3(fd.x, 0, fd.y).mul(out)).add(vec3(ax, 0, az).mul(side)).add(vec3(0, max(up, 0), 0));
      }
      m.positionNode = p;
      const size = mist
        ? mix(select(veil, float(5), select(low, float(4.5), float(3.5))), select(veil, float(10.5), select(low, float(9.5), float(8.5))), pow(age, 0.55)).mul(sc(8.8).mul(0.4).add(0.8))
        : mix(float(1.6), float(5.6), pow(age, 0.5)).mul(sc(8.8).mul(0.5).add(0.75));
      m.scaleNode = vec2(size, size);
      // lit per particle: forward scattering toward the eye when backlit, the sky, the cloud shadows, and the gorge's
      // own shadow (a short march over the heightfield toward the sun: with a low sun behind the falls the mist down
      // in the gorge is in shade, not glowing)
      const V = cameraPosition.sub(p).normalize();
      const L = atmo.sunDir.normalize();
      const fwdS = pow(max(L.negate().dot(V), 0), 5).mul(1.8);
      const inSun = this.gorgeSun(p, heightAt);
      const lit = varying(vec3(sprayU.sun).mul(fwdS.add(0.3)).mul(cloudShadow(p)).mul(inSun).mul(0.9).add(whiteSky().mul(2.6)).mul(0.85));
      // the plunge surges and slackens with the lumps of water coming over the lip: some splashes strong, some weak,
      // and the whole curtain breathing on two unrelated periods
      const surge = sin(t.mul(1.37)).mul(sin(t.mul(0.53).add(1.1))).mul(0.3).add(0.85);
      const strength = mist ? select(veil, float(0.22), select(low, float(0.75), float(0.45))) : sc(10.3).mul(0.6).add(0.7).mul(surge).mul(0.8);
      const fade = varying(smoothstep(0.0, mist ? 0.12 : 0.05, age).mul(pow(float(1).sub(age), mist ? 1.2 : 1.6)).mul(smoothstep(1.5, 6, length(p.sub(cameraPosition)))).mul(strength));
      const tex = varying(vec2(sc(9.2), sc(9.7)));
      const r = length(uv().sub(0.5)).mul(2);
      const lump = texture(laceTex, uv().mul(mist ? 0.18 : 0.3).add(tex)).b;
      const puff = smoothstep(1.0, 0.0, r).pow(mist ? 1.5 : 2.1).mul(lump.mul(1.4).sub(0.1).clamp(0.2, 1.2));
      // soft where it meets rock, and thinning into the water's surface (the pool's depth would cut it in a line)
      const soft = smoothstep(0.0, 1.4, sceneViewDepth(screenUV).sub(positionView.z.negate())).mul(smoothstep(c.y - 0.1, c.y + (mist ? 0.6 : 0.3), positionWorld.y));
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
    make(preset === 'low' ? 80 : 210, false);
    make(preset === 'low' ? 48 : 110, true);
    this.buildBoil(W, heightAt);
  }

  /**
   * The churn where the falls land: a low open drum of white water round the plunge, flaring as it rises, cut by
   * noise into clumps that boil up and outward and fall apart a few metres up. It hides the line where the sheet meets
   * the pool and gives the foot of the falls the solid white mass the sprites alone could not.
   */
  private buildBoil(W: number, heightAt: (xz: N) => N) {
    const c = this.impact, fd = this.fallDir;
    const H = 3.6, segs = 40, rows = 8;
    const pos: number[] = [], uvs: number[] = [], idx: number[] = [];
    const ax = -fd.y, az = fd.x;
    for (let j = 0; j <= rows; j++) {
      const v = j / rows;
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        // (an ellipse as wide as the falling water, shallower front to back, flaring as it rises)
        const ra = W * 0.62 * (1 + v * 0.35), rf = W * 0.32 * (1 + v * 0.5);
        const ca = Math.cos(a) * ra, cf = Math.sin(a) * rf;
        pos.push(c.x + ax * ca + fd.x * (cf + 0.6), c.y - 0.3 + v * H, c.z + az * ca + fd.y * (cf + 0.6));
        uvs.push(i / segs, v);
      }
    }
    for (let j = 0; j < rows; j++) for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i, b = a + 1, d = a + segs + 1, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    const m = new THREE.MeshBasicNodeMaterial();
    m.transparent = true;
    m.depthWrite = false;
    m.side = THREE.DoubleSide;
    m.forceSinglePass = true;
    m.mrtNode = effectMRT();
    m.fog = false;
    const t = riverU.time, U = uv(), p = positionWorld;
    const around = U.x.mul(W * 4.2);
    // clumps rising and spreading out of the boil, two scales, the surges of the plunge in their strength
    const n1 = mx_noise_float(vec3(around.mul(0.75), U.y.mul(H * 0.75).sub(t.mul(1.5)), t.mul(0.45)));
    const n2 = mx_noise_float(vec3(around.mul(2.2), U.y.mul(H * 2.2).sub(t.mul(2.9)), t.mul(0.9).add(4.2)));
    const surge = sin(t.mul(1.37)).mul(sin(t.mul(0.53).add(1.1))).mul(0.12).add(0.08);
    // (the height fade is soft and mostly multiplies: an additive cut through the fine noise left a fringe of spikes
    // that read as white petals in the shade)
    const body = n1.mul(0.6).add(n2.mul(0.15)).add(surge).add(float(0.42).sub(U.y.mul(0.6)));
    const V = normalize(cameraPosition.sub(p));
    const L = atmo.sunDir.normalize();
    const fwdS = pow(max(L.negate().dot(V), 0), 5).mul(1.8);
    const lit = varying(vec3(sprayU.sun).mul(fwdS.add(0.35)).mul(cloudShadow(p)).mul(this.gorgeSun(p, heightAt)).mul(0.9).add(whiteSky().mul(2.8)).mul(0.85));
    // (the clumps' undersides and the gaps between them in their own shade)
    const shade = smoothstep(-0.1, 0.5, body).mul(0.4).add(0.6);
    const soft = smoothstep(0.0, 0.8, sceneViewDepth(screenUV).sub(positionView.z.negate())).mul(smoothstep(c.y - 0.35, c.y + 0.25, p.y));
    const a = smoothstep(-0.2, 0.55, body).mul(pow(smoothstep(1.0, 0.1, U.y), 1.6)).mul(soft).mul(0.9);
    m.colorNode = vec4(lit.mul(shade), a);
    m.opacityNode = a;
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = 12.8;
    mesh.frustumCulled = false;
    mesh.name = 'falls_boil';
    this.group.add(mesh);
  }

  update(t: number) {
    riverU.time.value = t;
  }
}
