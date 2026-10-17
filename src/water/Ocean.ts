/**
 * The sea around the island: the FFT wave field (oceanSim.ts) on a camera-centred polar grid that reaches the
 * horizon, damped in the lagoon and over the shallows, with shore breakers and a swash film that runs up the beach.
 * Shading: Fresnel reflection of the same sky (image-based light + sun glints, shadowed), refraction of the sea bed
 * through the water with Beer-Lambert absorption (turquoise over sand, deep blue offshore), crest scattering, and
 * foam from the Jacobian, the breakers and the swash edge.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, abs, cameraPosition, clamp, dot, exp, float, fract, length, max, min, mix, mx_noise_float,
  mx_fractal_noise_float, normalize, positionView, positionWorld, pow, screenUV, select, sin,
  smoothstep, texture, transformNormalToView, uniform, vec2, vec3, vec4, viewportSharedTexture,
  attribute, cos, atan, type N,
} from '../core/tsl';
import { OceanSim } from './oceanSim';
import type { Heightfield } from '../world/Heightfield';
import { HALF_WORLD, WORLD_SIZE } from '../world/layout';
import { heightLookup } from '../world/Terrain';
import { atmo } from '../sky/Atmosphere';
import { wetness } from '../world/weatherUniforms';
import { Q } from '../core/quality';
import { sceneViewDepth } from '../core/depth';

export const oceanU = {
  time: uniform(0),
  /** breaker period (s) and wavelength (m) */
  breakPeriod: uniform(7.5),
  breakLen: uniform(16),
  /** run-up of the swash above sea level (m) */
  swashMax: uniform(0.62),
  rain: uniform(0),
  foamBoost: uniform(0),
  /** 0..1 how rough the sea is (rain squalls raise it) */
  storm: uniform(0),
};

/** polar grid: rings that grow geometrically from ~0.15 m at the centre to the horizon */
function polarGrid(segments: number, rings: number, rMax: number) {
  const b = 0.045 * (200 / rings);
  const a = rMax / (Math.exp(b * rings) - 1);
  const pos: number[] = [];
  const idx: number[] = [];
  pos.push(0, 0, 0);
  for (let r = 1; r <= rings; r++) {
    const rad = a * (Math.exp(b * r) - 1);
    for (let s = 0; s < segments; s++) {
      const ang = (s / segments) * Math.PI * 2 + (r % 2) * (Math.PI / segments);
      pos.push(Math.cos(ang) * rad, 0, Math.sin(ang) * rad);
    }
  }
  for (let s = 0; s < segments; s++) idx.push(0, 1 + ((s + 1) % segments), 1 + s);
  for (let r = 1; r < rings; r++) {
    const o0 = 1 + (r - 1) * segments, o1 = 1 + r * segments;
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      if (r % 2 === 1) {
        idx.push(o0 + s, o0 + s1, o1 + s);
        idx.push(o0 + s1, o1 + s1, o1 + s);
      } else {
        idx.push(o0 + s, o1 + s1, o1 + s);
        idx.push(o0 + s, o0 + s1, o1 + s1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), rMax);
  return g;
}

export class Ocean {
  readonly sim = new OceanSim();
  readonly mesh: THREE.Mesh;
  private followStep = 0.5;

  constructor(private hf: Heightfield) {
    const geo = polarGrid(Q.oceanSegments, 200, 26000);
    const mat = this.material();
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.renderOrder = 10;
    this.mesh.name = 'ocean';
  }

  private material() {
    const m = new THREE.MeshStandardNodeMaterial();
    m.name = 'ocean';
    m.transparent = true;
    m.depthWrite = true;
    m.side = THREE.FrontSide;
    const sim = this.sim;
    const hf = this.hf;
    const heightAt = heightLookup(hf);
    const shoreAt = (xz: N) => texture(hf.shoreTex, xz.add(HALF_WORLD).div(WORLD_SIZE)).level(0).r;
    const kindAt = (xz: N) => texture(hf.mask1Tex, xz.add(HALF_WORLD).div(WORLD_SIZE)).level(0).a;
    const PIXEL_ANGLE = 0.0011;

    /** damping of the open-sea field: lagoon calm, shallow water, and none past the waterline */
    const damping = (xz: N, depth: N, shore: N) => {
      const beachy = float(1).sub(kindAt(xz).mul(2)).clamp(0, 1);
      const lagoon = mix(float(1), float(0.38), beachy.mul(smoothstep(-300, -150, shore)));
      return lagoon.mul(smoothstep(0.0, 5.0, depth)).mul(float(0.7).add(oceanU.storm.mul(0.6)));
    };

    /** shore breaker wave train: crests parallel to the shoreline, steep fronts, shoaling with depth */
    const breaker = (xz: N, depth: N, shore: N) => {
      const along = atan(xz.y.sub(-50), xz.x.sub(-100)).mul(260);
      const wob = mx_noise_float(vec3(along.mul(1 / 90), 0, oceanU.time.mul(0.02))).mul(2.2);
      const k = float(Math.PI * 2).div(oceanU.breakLen);
      const w = float(Math.PI * 2).div(oceanU.breakPeriod);
      const phase = shore.mul(k).add(oceanU.time.mul(w)).add(wob);
      const f = fract(phase.div(Math.PI * 2));
      // asymmetric crest: slow rise, sharp fall (front faces the shore)
      const shape = pow(f, 3.2).mul(smoothstep(1.0, 0.92, f));
      // breakers only in the last tens of metres before the beach, on shallow water
      const shoal = smoothstep(2.2, 0.9, depth).mul(smoothstep(0.05, 0.5, depth)).mul(smoothstep(-38, -14, shore));
      const amp = float(0.3).add(oceanU.storm.mul(0.3)).mul(shoal);
      const beachy = float(1).sub(kindAt(xz).mul(1.6)).clamp(0.15, 1);
      return { h: shape.mul(amp).mul(beachy), front: smoothstep(0.86, 0.97, f).mul(shoal).mul(beachy), f, beachy };
    };

    /** swash: the waterline runs up the beach and back with the breakers */
    const swash = (xz: N, shore: N) => {
      const w = float(Math.PI * 2).div(oceanU.breakPeriod);
      const along = atan(xz.y.sub(-50), xz.x.sub(-100)).mul(260);
      const wob = mx_noise_float(vec3(along.mul(1 / 90), 0, oceanU.time.mul(0.02))).mul(2.2);
      const cyc = fract(oceanU.time.mul(w).add(wob).div(Math.PI * 2).add(0.35));
      // quick run-up, slow backwash
      const up = select(cyc.lessThan(0.3), smoothstep(0.0, 0.3, cyc), smoothstep(1.0, 0.3, cyc).pow(0.7));
      const band = smoothstep(-40, -4, shore).mul(smoothstep(30, 6, shore));
      return { level: up.mul(oceanU.swashMax).mul(band), up, band };
    };

    /** displacement of the open-sea cascades at xz, faded by pixel footprint */
    const seaDisp = (xz: N, camDist: N) => {
      const camH = max(abs(cameraPosition.y), 1.5);
      const foot = camDist.mul(camDist).mul(PIXEL_ANGLE).div(camH);
      const keep = [float(1).sub(smoothstep(4.0, 9.0, foot)), float(1).sub(smoothstep(0.6, 1.8, foot)), float(1).sub(smoothstep(0.15, 0.5, foot))];
      let d: N = vec3(0);
      for (let i = 0; i < 3; i++) d = d.add(sim.dispNodes[i].sample(xz.div(sim.patchLengths[i])).level(0).xyz.mul(keep[i]));
      return d;
    };

    // ---- vertex: follow the camera, displace
    m.positionNode = Fn(() => {
      const local = attribute('position', 'vec3');
      const xz = local.xz.add(vec2(this.followX, this.followZ));
      const camDist = length(xz.sub(cameraPosition.xz));
      const ground = heightAt(xz);
      const depth = max(float(0).sub(ground), 0);
      const shore = shoreAt(xz);
      const damp = damping(xz, depth, shore);
      const d = seaDisp(xz, camDist).mul(damp);
      const br = breaker(xz, depth, shore);
      const sw = swash(xz, shore);
      const y = d.y.add(br.h).max(sw.level.mul(smoothstep(-2, 2, shore)));
      return vec3(xz.x.add(d.x), y, xz.y.add(d.z));
    })();

    // ---- fragment
    const shade = (() => {
      const p = positionWorld;
      const xz = p.xz;
      const viewVec = cameraPosition.sub(p);
      const camDist = length(viewVec);
      const V = viewVec.div(camDist);
      const ground = heightAt(xz);
      const depth = max(p.y.sub(ground), 0);
      const shore = shoreAt(xz);
      const damp = damping(xz, max(float(0).sub(ground), 0), shore);
      // normal from the cascades' slope maps (fold-aware), footprint faded, plus capillary detail
      const camH = max(abs(cameraPosition.y), 1.5);
      const foot = camDist.mul(camDist).mul(PIXEL_ANGLE).div(camH);
      const keep = [float(1).sub(smoothstep(6.0, 16.0, foot)), float(1).sub(smoothstep(1.0, 4.0, foot)), float(1).sub(smoothstep(0.25, 1.2, foot))];
      let slope: N = vec2(0);
      let jac: N = vec2(0);
      let foamH: N = float(0);
      for (let i = 0; i < 3; i++) {
        const uvc = xz.div(sim.patchLengths[i]);
        const der = sim.derivNodes[i].sample(uvc);
        slope = slope.add(der.xy.mul(keep[i]));
        jac = jac.add(der.zw.mul(keep[i]));
        foamH = foamH.add(float(1).sub(sim.dispNodes[i].sample(uvc).w).max(0).mul(keep[i]).mul(i === 2 ? 0.12 : 1));
      }
      slope = slope.mul(damp).div(float(1).add(jac.mul(damp)).max(0.2));
      // rain ripples: many small expanding rings
      const rr = oceanU.rain;
      const rip = mx_noise_float(vec3(xz.mul(2.8), oceanU.time.mul(3.1))).mul(rr).mul(0.6);
      const ripB = mx_noise_float(vec3(xz.mul(6.1).add(4.0), oceanU.time.mul(4.3))).mul(rr).mul(0.4);
      slope = slope.add(vec2(rip.add(ripB), rip.sub(ripB)).mul(0.25));
      // capillary ripples near the camera
      const cap = mx_noise_float(vec3(xz.mul(1.9), oceanU.time.mul(0.9))).mul(float(1).sub(smoothstep(8, 40, camDist))).mul(0.06);
      slope = slope.add(vec2(cap, cap.negate()));
      const br = breaker(xz, max(float(0).sub(ground), 0), shore);
      const sw = swash(xz, shore);
      let N0: N = normalize(vec3(slope.x.negate(), 1, slope.y.negate()));
      // the breaker face tilts the normal toward the shore
      N0 = normalize(N0.add(vec3(0, 0, 0)));
      // far away the sea is a mirror of the sky with a little roughness for the glitter
      const NdotV = clamp(dot(N0, V), 0, 1);

      // ---- refraction: what lies behind, through the water
      const viewZ = positionView.z.negate();
      const offs = N0.xz.mul(0.035).mul(clamp(depth.mul(0.5), 0, 1)).div(max(viewZ.mul(0.03), 1));
      const uvR0 = screenUV.add(offs);
      const sceneZ0 = sceneViewDepth(uvR0);
      // a refracted sample in front of the water is invalid: fall back to the straight one
      const uvR = select(sceneZ0.lessThan(viewZ), screenUV, uvR0);
      const sceneZ = sceneViewDepth(uvR);
      const thick = max(sceneZ.sub(viewZ), 0).mul(camDist.div(max(viewZ, 0.01)));
      const behind = viewportSharedTexture(uvR).rgb;
      // optical path: down to the bed (vertical depth) and back along the view
      const path = min(thick.add(depth), 120);
      const sigma = vec3(0.42, 0.075, 0.045).mul(float(1).add(oceanU.rain.mul(0.6)));
      const trans = exp(sigma.negate().mul(path));
      // turbidity in the swash and the breakers (sand in suspension)
      const turbid = max(br.front.mul(0.6), sw.band.mul(0.35)).mul(smoothstep(2.5, 0.2, depth));
      const refr = mix(behind.mul(trans), behind.mul(vec3(0.75, 0.72, 0.6)), turbid.mul(0.5));
      // ---- body colour: light scattered by the water itself (blue-green), more in shallows (seen as turquoise)
      const scatterAlb = mix(vec3(0.004, 0.02, 0.034), vec3(0.02, 0.1, 0.1), smoothstep(12, 1.5, depth));
      const bodyAlb = scatterAlb.mul(float(1).sub(trans.y.mul(0.8)));
      // crest scattering: light through thin wave crests
      const crest = clamp(sim.dispNodes[0].sample(xz.div(sim.patchLengths[0])).y.mul(damp).mul(0.6).add(0.15), 0, 1);
      const sunDir = normalize(atmo.sunDir);
      const sss = pow(clamp(dot(V, sunDir.negate().add(vec3(0, 0.2, 0))).add(0.2), 0, 1), 3).mul(crest).mul(0.25);
      // ---- foam
      const fNoise = mx_fractal_noise_float(vec3(xz.mul(0.42), oceanU.time.mul(0.12)), 3, 2.2, 0.55).mul(0.5).add(0.5);
      const fNoise2 = mx_noise_float(vec3(xz.mul(1.7), oceanU.time.mul(0.3))).mul(0.5).add(0.5);
      const caps = smoothstep(0.55, 1.5, foamH.mul(damp)).mul(smoothstep(0.4, 0.7, fNoise)).mul(float(0.6).add(oceanU.storm));
      const surf = br.front.mul(smoothstep(0.35, 0.7, fNoise.mul(0.7).add(fNoise2.mul(0.5))));
      // trailing foam behind the breaker: decays with phase
      const nearShore = smoothstep(-70, -25, shore);
      const trail = br.beachy.mul(nearShore).mul(smoothstep(2.6, 0.6, max(float(0).sub(ground), 0))).mul(pow(float(1).sub(br.f), 2.5)).mul(smoothstep(0.5, 0.85, fNoise2.mul(0.6).add(fNoise.mul(0.5))));
      // the lacy edge of the swash
      const edge = sw.band.mul(smoothstep(0.25, 0.0, depth)).mul(smoothstep(0.4, 0.75, fNoise2)).mul(smoothstep(0.0, 0.05, depth.add(0.01)));
      const foam = clamp(caps.add(surf).add(trail.mul(0.7)).add(edge.mul(0.9)).add(oceanU.foamBoost.mul(caps)), 0, 1);
      // thin water over the beach: almost fully transparent
      const thin = smoothstep(0.35, 0.02, depth);
      void sin; void cos; void fract;
      return { N0, refr, bodyAlb, foam, sss, NdotV, thin, trans, depth };
    })();

    const foamCol = vec3(0.92, 0.93, 0.92);
    m.colorNode = vec4(mix(shade.bodyAlb, foamCol, shade.foam), 1);
    m.roughnessNode = mix(float(0.035).add(oceanU.rain.mul(0.08)), float(0.8), shade.foam);
    m.metalnessNode = float(0);
    m.normalNode = transformNormalToView(shade.N0);
    // light coming through from the bed, and the crest glow; the Fresnel share of it is reflected instead
    const F = float(0.02).add(float(0.98).mul(pow(float(1).sub(shade.NdotV), 5)));
    m.emissiveNode = shade.refr.mul(float(1).sub(F)).mul(float(1).sub(shade.foam)).add(vec3(0.02, 0.12, 0.1).mul(shade.sss).mul(atmo.sunDir.y.max(0).mul(3).add(0.05)));
    // the swash film is barely there
    m.opacityNode = float(1);
    void wetness;
    return m;
  }

  /** camera-following offset, snapped so the grid does not crawl */
  private followXU = uniform(0);
  private followZU = uniform(0);
  private get followX() { return this.followXU; }
  private get followZ() { return this.followZU; }

  update(renderer: THREE.WebGPURenderer, camera: THREE.Camera, t: number, dt: number) {
    oceanU.time.value = t;
    this.sim.update(renderer, t, dt);
    const s = this.followStep;
    this.followXU.value = Math.round(camera.position.x / s) * s;
    this.followZU.value = Math.round(camera.position.z / s) * s;
  }

  /** CPU estimate of the sea surface height at (x, z): probe displacement damped like the shader (for swimming) */
  surfaceAt(x: number, z: number, probe = 0): number {
    const d = this.sim.probe(probe);
    const ground = this.hf.height(x, z);
    const depth = Math.max(0, -ground);
    const damp = THREE.MathUtils.smoothstep(depth, 0, 5) * 0.7;
    return d[1] * damp;
  }
}
