/**
 * The sea around the island: the FFT wave field (oceanSim.ts) on a camera-centred polar grid that reaches the
 * horizon, calmed in the lagoons and the village cove, with the near-shore surf (surf.ts: shoaling crests, breakers,
 * bores, the swash sheet on the beach face, bursts at the cliffs) added on top.
 *
 * Optics: the sea bed is seen through the water along the refracted ray, so the in-water path is the water column
 * over the cosine of the refracted view ray plus that of the refracted sun ray (not the slant distance of the
 * unrefracted ray, which made every shallow look opaque); Beer-Lambert absorption over it turns white sand from
 * near-colourless in the swash to mint, turquoise and, past the reef drop-off, navy. Bubbles in the surf zone scatter
 * (pale aerated water), foam is a lace drawn from the surf's foam cover. Reflections: the sky (image-based light) and
 * every light (sun, moon, lamps) through a GGX lobe whose roughness takes over the slopes of the cascades faded out
 * with distance, broken into world-anchored sparkles, so the glitter path is many separate glints.
 */
import * as THREE from 'three/webgpu';
import { PhysicalLightingModel } from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import {
  Fn, abs, cameraPosition, clamp, dot, exp, float, floor, fract, hash, length, log2, max, mix, mx_noise_float,
  normalize, positionView, positionWorld, pow, screenUV, select, smoothstep, sqrt, transformNormalToView,
  uniform, vec2, vec3, vec4, viewportSharedTexture, attribute, normalView, positionViewDirection, type N,
} from '../core/tsl';
import { OceanSim, OCEAN } from './oceanSim';
import type { Heightfield } from '../world/Heightfield';
import { heightLookup } from '../world/Terrain';
import { atmo } from '../sky/Atmosphere';
import { clouds } from '../sky/Sky';
import { Q } from '../core/quality';
import { sceneViewDepth } from '../core/depth';
import { surfU, coastAt, waves, swash, laceMask, bubbleMask, type Coast } from './surf';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TSL = TSLTyped as any;
const { BRDF_Lambert, D_GGX, V_GGX_SmithCorrelated, diffuseContribution, roughness: roughnessP } = TSL;

export const oceanU = {
  time: uniform(0),
  rain: uniform(0),
  foamBoost: uniform(0),
  /** 0..1 how rough the sea is (rain squalls raise it) */
  storm: uniform(0),
  /** diagnostics (?oceandebug=1): 1 = surf foam cover (R), cliff weight (G), distance offshore over 20 m (B) */
  debug: uniform(Number(new URLSearchParams(location.search).get('oceandebug') ?? 0)),
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

/**
 * Direct light on the water: Lambert for the light scattered inside it (the albedo) and a GGX glint whose facets are
 * world-anchored cells that each catch the light or not. In the middle of the lobe most facets do (a smooth bright
 * core), in its tail few do (separate sparkles); `sparkle` is the cell's random value, `contrast` 0 makes it smooth.
 */
class OceanLighting extends PhysicalLightingModel {
  constructor(private glint: { sparkle: N; contrast: N }) {
    super();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  direct({ lightDirection, lightColor, reflectedLight }: any) {
    const Nn = normalView, V = positionViewDirection, L = lightDirection;
    const dotNL = Nn.dot(L).clamp();
    const irr = dotNL.mul(lightColor);
    reflectedLight.directDiffuse.addAssign(irr.mul(BRDF_Lambert({ diffuseColor: diffuseContribution })));
    const H = L.add(V).normalize();
    const dotNH = Nn.dot(H).clamp(), dotNV = Nn.dot(V).clamp().max(1e-3), dotVH = V.dot(H).clamp();
    const a = roughnessP.pow2();
    const D = D_GGX({ alpha: a, dotNH });
    const vis = V_GGX_SmithCorrelated({ alpha: a, dotNL, dotNV });
    const F = float(0.02).add(float(0.98).mul(pow(float(1).sub(dotVH), 5)));
    const tail = float(1).sub(D.mul(a.pow2()).mul(Math.PI)).clamp(0, 1);
    const k = mix(float(1.5), float(10), tail).mul(this.glint.contrast);
    const spark = pow(this.glint.sparkle, k).mul(k.add(1));
    reflectedLight.directSpecular.addAssign(irr.mul(F.mul(D).mul(vis)).mul(spark));
  }
}

class OceanMaterial extends THREE.MeshPhysicalNodeMaterial {
  glint = { sparkle: float(0.5) as N, contrast: float(0) as N };
  setupLightingModel() {
    return new OceanLighting(this.glint);
  }
}

export class Ocean {
  readonly sim = new OceanSim();
  readonly mesh: THREE.Mesh;
  private followStep = 0.5;
  private followXU = uniform(0);
  private followZU = uniform(0);

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
    const m = new OceanMaterial();
    m.name = 'ocean';
    m.transparent = true;
    m.depthWrite = true;
    m.side = THREE.FrontSide;
    m.ior = 1.333;
    const sim = this.sim;
    const hf = this.hf;
    const heightAt = heightLookup(hf);
    const PIXEL_ANGLE = 0.0011;

    /** how much of the open-sea field reaches here: lagoons calmer, nothing over the sand, the cove nearly glassy */
    const damping = (c: Coast, depth: N) => {
      const lagoon = mix(float(1), float(0.45), c.wb.mul(smoothstep(-300, -150, c.s)));
      return lagoon.mul(smoothstep(0.0, 5.0, depth)).mul(float(0.7).add(oceanU.storm.mul(0.6))).mul(float(1).sub(c.shelter.mul(0.85)));
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

    // ---- vertex: follow the camera, add the open sea, the surf and the swash sheet
    m.positionNode = Fn(() => {
      const local = attribute('position', 'vec3');
      const xz = local.xz.add(vec2(this.followXU, this.followZU));
      const camDist = length(xz.sub(cameraPosition.xz));
      const ground = heightAt(xz);
      const c = coastAt(hf, xz);
      const d = seaDisp(xz, camDist).mul(damping(c, max(ground.negate(), 0)));
      const w = waves(c);
      const sw = swash(c, w);
      const seaY = d.y.add(w.eta);
      // up a beach face the sheet takes over from the sea (never below the sea surface); only on low, gentle shores,
      // never up a rock face
      const faceW = smoothstep(-2.5, 0.5, c.s).mul(smoothstep(1.6, 0.9, ground)).mul(smoothstep(0.05, 0.3, c.wb.add(c.wr.mul(0.45)).mul(float(1).sub(c.wc))));
      const y = max(seaY, mix(seaY, ground.add(sw.sheet), faceW));
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
      const column = max(p.y.sub(ground), 0);
      const c = coastAt(hf, xz);
      const damp = damping(c, max(ground.negate(), 0));
      // normal from the cascades' slope maps (fold-aware), footprint faded; the faded slopes go into roughness
      const camH = max(abs(cameraPosition.y), 1.5);
      const foot = camDist.mul(camDist).mul(PIXEL_ANGLE).div(camH);
      const keep = [float(1).sub(smoothstep(6.0, 16.0, foot)), float(1).sub(smoothstep(1.0, 4.0, foot)), float(1).sub(smoothstep(0.25, 1.2, foot))];
      let slope: N = vec2(0);
      let jac: N = vec2(0);
      let foamH: N = float(0);
      let lost: N = float(0);
      const amp2 = OCEAN.amplitude * OCEAN.amplitude;
      for (let i = 0; i < 3; i++) {
        const uvc = xz.div(sim.patchLengths[i]);
        const der = sim.derivNodes[i].sample(uvc);
        slope = slope.add(der.xy.mul(keep[i]));
        jac = jac.add(der.zw.mul(keep[i]));
        // whitecap history from the two long cascades (the fragment stage is at its 16-sampler limit)
        if (i < 2) foamH = foamH.add(float(1).sub(sim.dispNodes[i].sample(uvc).w).max(0).mul(keep[i]));
        lost = lost.add(float(1).sub(keep[i]).mul(sim.slope2[i] * amp2));
      }
      slope = slope.mul(damp).div(float(1).add(jac.mul(damp)).max(0.2));
      lost = lost.mul(damp.mul(damp));
      // the surf: the near-shore wave's slope toward land; up the beach face, the sheet lies on the sand
      const w = waves(c);
      const sw = swash(c, w);
      const onSheet = smoothstep(-1.5, 0.5, c.s).mul(smoothstep(0.0, 0.01, sw.sheet));
      const gx = heightAt(xz.add(vec2(0.5, 0))).sub(ground).div(0.5);
      const gz = heightAt(xz.add(vec2(0, 0.5))).sub(ground).div(0.5);
      slope = mix(slope.add(c.nrm.mul(w.slope)), vec2(gx, gz).mul(0.85), onSheet);
      // rain rings near the camera; capillary ripples
      const nearCam = float(1).sub(smoothstep(6, 30, camDist));
      const rr = oceanU.rain.mul(nearCam);
      const rip = mx_noise_float(vec3(xz.mul(2.8), oceanU.time.mul(3.1))).mul(rr).mul(0.6);
      const ripB = mx_noise_float(vec3(xz.mul(6.1).add(4.0), oceanU.time.mul(4.3))).mul(rr).mul(0.4);
      slope = slope.add(vec2(rip.add(ripB), rip.sub(ripB)).mul(0.25));
      const cap = mx_noise_float(vec3(xz.mul(1.9), oceanU.time.mul(0.9))).mul(float(1).sub(smoothstep(8, 40, camDist))).mul(mix(float(0.06), float(0.02), onSheet));
      slope = slope.add(vec2(cap, cap.negate()));
      const N0 = normalize(vec3(slope.x.negate(), 1, slope.y.negate()));
      const NdotV = clamp(dot(N0, V), 0.001, 1);

      // ---- foam: the surf's, the swash's, whitecaps on the open sea
      const drift = float(1).sub(exp(w.age.div(-1.3))).mul(1.4);
      const surfFoam = laceMask(w.foam.mul(oceanU.foamBoost.mul(0.3).add(1)), xz, w.n, c.nrm, drift);
      const lip = bubbleMask(sw.lip, xz);
      const sheetFoam = laceMask(sw.sheetFoam, xz, w.n0, c.nrm, float(1.6), sw.back).mul(onSheet);
      const capsA = smoothstep(mix(float(0.75), float(0.4), oceanU.storm), float(1.6), foamH.mul(damp)).mul(float(0.55).add(oceanU.storm.mul(0.9)));
      const caps = laceMask(capsA, xz, float(0), vec2(0.6, 0.8), float(0));
      const foam = max(max(surfFoam, lip), max(sheetFoam, caps)).clamp(0, 1);

      // ---- refraction: the sea bed along the refracted rays, absorbed over the in-water path
      const cosT = sqrt(float(1).sub(float(1).sub(NdotV.mul(NdotV)).div(1.777)));
      const lightY = max(normalize(clouds.lightDir).y, 0.05);
      const cosS = sqrt(float(1).sub(float(1).sub(lightY.mul(lightY)).div(1.777)));
      const path = column.div(cosT).add(column.div(cosS)).min(200);
      // sand stirred up in the surf zone
      const turbid = w.broken.mul(exp(w.age.div(-4))).mul(smoothstep(1.6, 0.2, column)).mul(0.6).add(oceanU.rain.mul(0.3));
      const sigma = vec3(0.4, 0.068, 0.034).mul(turbid.mul(1.5).add(1));
      const trans = exp(sigma.negate().mul(path));
      const viewZ = positionView.z.negate();
      const offs = N0.xz.mul(0.03).mul(clamp(column.mul(0.6), 0, 1)).div(max(viewZ.mul(0.03), 1));
      const uvR0 = screenUV.add(offs);
      // a refracted sample in front of the water is invalid: fall back to the straight one
      const uvR = select(sceneViewDepth(uvR0).lessThan(viewZ), screenUV, uvR0);
      const behind = viewportSharedTexture(uvR).rgb;
      const aer = w.aerated.mul(float(1).sub(foam)).mul(smoothstep(0.02, 0.25, column));
      const bed = mix(behind.mul(trans), behind.mul(trans).mul(vec3(0.85, 0.82, 0.66)), turbid.mul(0.5)).mul(float(1).sub(aer.mul(0.55)));
      // ---- light scattered by the water itself (lit like a diffuse albedo): over the lagoons the fine carbonate silt
      // in suspension scatters blue-green (turquoise); past the reef drop-off clear ocean water is navy; bubbles pale
      const lagoon = smoothstep(14, 4, max(ground.negate(), 0));
      const deep = mix(vec3(0.0026, 0.0145, 0.032), vec3(0.008, 0.075, 0.085), lagoon);
      const inscat = deep.mul(float(1).sub(exp(path.mul(mix(float(-0.12), float(-0.3), lagoon)))));
      const body = mix(inscat, vec3(0.3, 0.42, 0.4), aer.mul(0.7));

      // ---- glint: world-anchored facet cells about two pixels wide (two sizes blended), re-drawn ~5 times a second
      const fp = camDist.mul(0.0009).div(sqrt(max(V.y, 0.05)));
      const lv = log2(max(fp.mul(1.8), 0.04).div(0.04));
      const cellAt = (size: N) => {
        const cell = floor(xz.div(size)).add(70000);
        const h0 = hash(cell.x.add(hash(cell.y).mul(65536)));
        const slot = floor(oceanU.time.mul(5).add(h0.mul(7)));
        return hash(cell.x.mul(3).add(slot.mul(17)).add(hash(cell.y.add(slot)).mul(65536)));
      };
      const s0 = pow(float(2), floor(lv)).mul(0.04);
      const sparkle = mix(cellAt(s0), cellAt(s0.mul(2)), fract(lv));
      const sky = float(1).sub(atmo.overcast);
      const contrast = sky.mul(sky).mul(float(1).sub(foam)).mul(float(1).sub(onSheet.mul(0.6)));
      // roughness: calm water, a little more where the slopes are no longer resolved, rain, foam
      const alpha0 = float(0.03).add(oceanU.rain.mul(0.05));
      const alpha = sqrt(alpha0.mul(alpha0).add(lost.mul(2)));
      const rough = mix(sqrt(alpha), float(0.75), foam);
      const dbg = vec3(w.foam, c.wc, smoothstep(0, 20, c.d));
      return { N0, NdotV, foam, bed, body, rough, sparkle, contrast, dbg };
    })();

    m.glint.sparkle = shade.sparkle;
    m.glint.contrast = shade.contrast;
    const foamCol = vec3(0.86, 0.88, 0.88);
    m.colorNode = vec4(mix(shade.body, foamCol, shade.foam), 1);
    m.roughnessNode = shade.rough;
    m.metalnessNode = float(0);
    m.normalNode = transformNormalToView(shade.N0);
    // the light from the bed comes through; the Fresnel share of the surface reflects the sky instead
    const F = float(0.02).add(float(0.98).mul(pow(float(1).sub(shade.NdotV), 5)));
    m.emissiveNode = select(oceanU.debug.greaterThan(0.5), shade.dbg.mul(oceanU.debug.mul(0.5)), shade.bed.mul(float(1).sub(F)).mul(float(1).sub(shade.foam)));
    m.opacityNode = float(1);
    return m;
  }

  update(renderer: THREE.WebGPURenderer, camera: THREE.Camera, t: number, dt: number) {
    oceanU.time.value = t;
    surfU.time.value = t;
    surfU.storm.value = oceanU.storm.value as number;
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
