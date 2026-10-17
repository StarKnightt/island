/**
 * Physically based sky: Rayleigh + Mie + ozone single scattering with a multiple-scattering approximation, after
 * Hillaire 2020 ("A Scalable and Production Ready Sky and Atmosphere Rendering Technique"). A transmittance LUT is
 * computed once; a sky-view LUT is re-rendered every frame from the camera altitude and sun direction. The visible
 * sky, the image-based light, the sun's colour and the aerial perspective (scene fog) all read the same model.
 *
 * Units: metres; radiance in the game's scaled photometric units (sun illuminance at the top of the atmosphere =
 * SUN_E). Scattering coefficients are Earth's, with a hazier tropical aerosol layer.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, Loop, abs, clamp, cos, dot, exp, float, length, max, min, mix, normalize, positionWorldDirection, pow, select,
  sin, smoothstep, sqrt, texture, uniform, uv, vec2, vec3, vec4, atan, acos, fract, cameraPosition, positionView,
  positionWorld, fog, type N,
} from '../core/tsl';

export const R_GROUND = 6360e3;
export const R_TOP = 6420e3;
/** sun illuminance at the top of the atmosphere, in scene units */
export const SUN_E = 12;

const RAYLEIGH = new THREE.Vector3(5.802e-6, 13.558e-6, 33.1e-6);
const RAYLEIGH_H = 8000;
const MIE_H = 1200;
const OZONE = new THREE.Vector3(0.65e-6, 1.881e-6, 0.085e-6);

export const atmo = {
  sunDir: uniform(new THREE.Vector3(0, 1, 0)),
  moonDir: uniform(new THREE.Vector3(0, -1, 0)),
  /** metres above sea level of the camera, clamped to >= 1 */
  camHeight: uniform(2),
  /** Mie scattering at sea level (aerosols); raised in the tropics and in rain */
  mieScatter: uniform(6.5e-6),
  mieG: uniform(0.78),
  /** extra multiple-scattering brightness */
  msK: uniform(0.25),
  /** fog: extra extinction for rain and mist, per metre at sea level */
  mist: uniform(0.0),
  mistColor: uniform(new THREE.Color(0.55, 0.6, 0.65)),
  /** 0..1 overcast: flattens the sky toward grey */
  overcast: uniform(0),
  /** night factor for the stars, moon light */
  night: uniform(0),
  moonPhaseLight: uniform(0.8),
  time: uniform(0),
};

// ---------------------------------------------------------------- helpers (TSL)
/** distance to the atmosphere's top along a ray from radius r with cos(zenith) mu */
const distToTop = Fn(([r, mu]: N[]) => {
  const disc = r.mul(r).mul(mu.mul(mu).sub(1)).add(R_TOP * R_TOP);
  return max(float(0), r.negate().mul(mu).add(sqrt(max(disc, 0))));
});
const distToGround = Fn(([r, mu]: N[]) => {
  const disc = r.mul(r).mul(mu.mul(mu).sub(1)).add(R_GROUND * R_GROUND);
  return r.negate().mul(mu).sub(sqrt(max(disc, 0)));
});
const hitsGround = Fn(([r, mu]: N[]) => {
  const disc = r.mul(r).mul(mu.mul(mu).sub(1)).add(R_GROUND * R_GROUND);
  return mu.lessThan(0).and(disc.greaterThanEqual(0));
});

/** scattering/extinction at altitude h (m): returns { rayleigh: vec3, mieS: float, ext: vec3 } via three outputs */
const densities = (h: N) => {
  const dR = exp(h.negate().div(RAYLEIGH_H));
  const dM = exp(h.negate().div(MIE_H));
  const dO = max(float(0), float(1).sub(abs(h.sub(25000)).div(15000)));
  const rayleigh = vec3(RAYLEIGH.x, RAYLEIGH.y, RAYLEIGH.z).mul(dR);
  const mieS = atmo.mieScatter.mul(dM);
  const ext = rayleigh.add(mieS.mul(1.11)).add(vec3(OZONE.x, OZONE.y, OZONE.z).mul(dO));
  return { rayleigh, mieS, ext };
};

// ---------------------------------------------------------------- transmittance LUT (Bruneton parametrisation)
const T_W = 256, T_H = 64;
const H_ATM = Math.sqrt(R_TOP * R_TOP - R_GROUND * R_GROUND);

const transmittanceMaterial = (() => {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = Fn(() => {
    const xMu = uv().x, xR = uv().y;
    const rho = xR.mul(H_ATM);
    const r = sqrt(rho.mul(rho).add(R_GROUND * R_GROUND));
    const dMin = float(R_TOP).sub(r);
    const dMax = rho.add(H_ATM);
    const d = dMin.add(xMu.mul(dMax.sub(dMin)));
    const mu = select(d.lessThan(1), float(1), float(H_ATM * H_ATM).sub(rho.mul(rho)).sub(d.mul(d)).div(r.mul(d).mul(2))).clamp(-1, 1);
    const L = distToTop(r, mu);
    const steps = 48;
    const dt = L.div(steps);
    const tau = vec3(0).toVar();
    Loop(steps, ({ i }: { i: N }) => {
      const t = float(i).add(0.5).mul(dt);
      const h = sqrt(r.mul(r).add(t.mul(t)).add(r.mul(t).mul(mu).mul(2))).sub(R_GROUND);
      tau.addAssign(densities(h).ext.mul(dt));
    });
    return vec4(exp(tau.negate()), 1);
  })();
  return m;
})();

export const transmittanceRT = new THREE.RenderTarget(T_W, T_H, { type: THREE.HalfFloatType, depthBuffer: false });
transmittanceRT.texture.minFilter = THREE.LinearFilter;
transmittanceRT.texture.magFilter = THREE.LinearFilter;
transmittanceRT.texture.generateMipmaps = false;

/** transmittance from radius r toward cos-zenith mu, to the top of the atmosphere */
export const transmittanceAt = Fn(([r, mu]: N[]) => {
  const rho = sqrt(max(r.mul(r).sub(R_GROUND * R_GROUND), 0));
  const d = distToTop(r, mu);
  const dMin = float(R_TOP).sub(r);
  const dMax = rho.add(H_ATM);
  const xMu = d.sub(dMin).div(dMax.sub(dMin));
  const xR = rho.div(H_ATM);
  // half-texel inset
  const u = xMu.mul((T_W - 1) / T_W).add(0.5 / T_W);
  const v = xR.mul((T_H - 1) / T_H).add(0.5 / T_H);
  return texture(transmittanceRT.texture, vec2(u, v)).rgb;
});

// ---------------------------------------------------------------- sky-view LUT
const S_W = 192, S_H = 128;
const phaseRayleigh = (c: N) => float(3 / (16 * Math.PI)).mul(c.mul(c).add(1));
const phaseMie = (c: N, g: N) => {
  // Cornette-Shanks
  const g2 = g.mul(g);
  const k = float(3 / (8 * Math.PI)).mul(float(1).sub(g2)).div(g2.add(2));
  return k.mul(c.mul(c).add(1)).div(pow(max(float(1).add(g2).sub(g.mul(c).mul(2)), 1e-4), 1.5));
};

/** view direction from LUT uv: u = azimuth relative to the sun (0..2pi), v = elevation with the horizon refined */
const lutDir = (u: N, v: N) => {
  const az = u.mul(Math.PI * 2);
  // v in [0,1]: 0.5 = horizon; non-linear around it
  const c = v.mul(2).sub(1);
  const el = c.sign().mul(c.mul(c)).mul(Math.PI / 2);
  return vec3(cos(el).mul(cos(az)), sin(el), cos(el).mul(sin(az)));
};

const skyViewMaterial = (() => {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = Fn(() => {
    const sun = normalize(atmo.sunDir);
    // frame: x axis toward the sun's azimuth
    const sunAz = normalize(vec2(sun.x, sun.z).add(vec2(1e-5, 0)));
    const local = lutDir(uv().x, uv().y);
    // rotate local (relative azimuth) into world azimuth
    const dir = vec3(local.x.mul(sunAz.x).sub(local.z.mul(sunAz.y)), local.y, local.x.mul(sunAz.y).add(local.z.mul(sunAz.x)));
    const r0 = float(R_GROUND).add(atmo.camHeight);
    const mu = dir.y;
    const ground = hitsGround(r0, mu);
    const L = select(ground, distToGround(r0, mu), distToTop(r0, mu));
    const steps = 40;
    const lum = vec3(0).toVar();
    const trans = vec3(1).toVar();
    const cosT = dot(dir, sun);
    const pR = phaseRayleigh(cosT);
    const pM = phaseMie(cosT, atmo.mieG);
    const tPrev = float(0).toVar();
    Loop(steps, ({ i }: { i: N }) => {
      // quadratic step distribution: dense near the camera
      const f1 = float(i).add(1).div(steps);
      const t = f1.mul(f1).mul(L);
      // materialise before tPrev changes: TSL emits expressions where they are used, not where they are written
      const dt = t.sub(tPrev).toVar();
      const tm = tPrev.add(dt.mul(0.5)).toVar();
      tPrev.assign(t);
      const px = dir.mul(tm).add(vec3(0, r0, 0));
      const r = length(px);
      const h = r.sub(R_GROUND);
      const up = px.div(r);
      const muS = dot(up, sun);
      const den = densities(h);
      const tSun = transmittanceAt(r, muS);
      // the planet shadows the sun below the horizon
      const sunVis = smoothstep(-0.02, 0.0, muS.add(sqrt(max(float(1).sub(float(R_GROUND * R_GROUND).div(r.mul(r))), 0))));
      const scat = den.rayleigh.mul(pR).add(vec3(den.mieS.mul(pM)));
      const ms = den.rayleigh.add(vec3(den.mieS)).mul(atmo.msK).mul(1 / (4 * Math.PI)).mul(transmittanceAt(r, max(muS, 0.05)).mul(smoothstep(-0.2, 0.15, muS)));
      const inS = scat.mul(tSun).mul(sunVis).add(ms);
      const stepT = exp(den.ext.negate().mul(dt));
      // energy-conserving integration (Hillaire)
      lum.addAssign(trans.mul(inS.sub(inS.mul(stepT)).div(max(den.ext, vec3(1e-9)))));
      trans.mulAssign(stepT);
    });
    if (new URLSearchParams(location.search).has('dbgsky')) return vec4(uv(), trans.x, 1);
    return vec4(lum.mul(SUN_E), 1);
  })();
  return m;
})();

export const skyViewRT = new THREE.RenderTarget(S_W, S_H, { type: THREE.HalfFloatType, depthBuffer: false });
skyViewRT.texture.minFilter = THREE.LinearFilter;
skyViewRT.texture.magFilter = THREE.LinearFilter;
skyViewRT.texture.wrapS = THREE.RepeatWrapping;
skyViewRT.texture.generateMipmaps = false;

/** sky radiance (no sun disc) for a world direction, from the sky-view LUT */
export const skyRadiance = Fn(([dir]: N[]) => {
  const sun = normalize(atmo.sunDir);
  const sunAz = normalize(vec2(sun.x, sun.z).add(vec2(1e-5, 0)));
  // relative azimuth: rotate dir by -sunAz
  const lx = dir.x.mul(sunAz.x).add(dir.z.mul(sunAz.y));
  const lz = dir.z.mul(sunAz.x).sub(dir.x.mul(sunAz.y));
  const az = atan(lz, lx);
  const u = fract(az.div(Math.PI * 2).add(1));
  const el = asinSafe(dir.y.clamp(-1, 1));
  const c = el.div(Math.PI / 2);
  const v = c.sign().mul(sqrt(abs(c))).mul(0.5).add(0.5);
  return texture(skyViewRT.texture, vec2(u, v)).rgb;
});
function asinSafe(x: N) {
  return float(Math.PI / 2).sub(acos(x));
}

/** sun illuminance colour at the camera (scene units), clear-sky */
export const sunTransmittance = Fn(() => {
  const r = float(R_GROUND).add(atmo.camHeight);
  return transmittanceAt(r, normalize(atmo.sunDir).y);
});

// ---------------------------------------------------------------- per-frame LUT rendering
const quad = new THREE.QuadMesh(transmittanceMaterial);
let transmittanceDone = false;
export function renderAtmosphereLUTs(renderer: THREE.WebGPURenderer) {
  const prev = renderer.getRenderTarget();
  if (!transmittanceDone) {
    quad.material = transmittanceMaterial;
    renderer.setRenderTarget(transmittanceRT);
    quad.render(renderer);
    transmittanceDone = true;
  }
  quad.material = skyViewMaterial;
  renderer.setRenderTarget(skyViewRT);
  quad.render(renderer);
  renderer.setRenderTarget(prev);
}

// ---------------------------------------------------------------- CPU mirror of the transmittance (for light colours)
const tmpV = new THREE.Vector3();
/** CPU estimate of the sun's transmittance (rgb) at sea level for a sun elevation (radians); matches the LUT closely */
export function sunTransmittanceCPU(elevation: number, mie = 6.5e-6, out = new THREE.Color()) {
  const r0 = R_GROUND + 2;
  const mu = Math.sin(elevation);
  const disc = r0 * r0 * (mu * mu - 1) + R_TOP * R_TOP;
  const L = Math.max(0, -r0 * mu + Math.sqrt(Math.max(disc, 0)));
  const steps = 64;
  const dt = L / steps;
  let tr = 0, tg = 0, tb = 0;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const h = Math.sqrt(r0 * r0 + t * t + 2 * r0 * t * mu) - R_GROUND;
    const dR = Math.exp(-h / RAYLEIGH_H), dM = Math.exp(-h / MIE_H), dO = Math.max(0, 1 - Math.abs(h - 25000) / 15000);
    tr += (RAYLEIGH.x * dR + mie * 1.11 * dM + OZONE.x * dO) * dt;
    tg += (RAYLEIGH.y * dR + mie * 1.11 * dM + OZONE.y * dO) * dt;
    tb += (RAYLEIGH.z * dR + mie * 1.11 * dM + OZONE.z * dO) * dt;
  }
  // the sun dips below the horizon: fade by the fraction of the disc still visible
  const vis = THREE.MathUtils.smoothstep(elevation, -0.012, 0.012);
  void tmpV;
  return out.setRGB(Math.exp(-tr) * vis, Math.exp(-tg) * vis, Math.exp(-tb) * vis);
}

// ---------------------------------------------------------------- aerial perspective (scene fog)
/**
 * Sky-coloured extinction and in-scattering along the view ray, integrated through the exponential height profile
 * of the haze: transmittance from the optical depth between the camera and the shaded point; in-scattered light
 * from the sky-view LUT toward the horizon in the view direction (the sky that the haze itself is).
 */
export function aerialFogNode() {
  const factor = Fn(() => {
    const d = length(positionView);
    const h0 = max(cameraPosition.y, 0), h1 = max(positionWorld.y, 0);
    const dh = h1.sub(h0);
    // average density of the haze between the two heights (exponential profile, scale height 1.2 km)
    const H = float(1100);
    const avg = select(abs(dh).lessThan(1), exp(h0.negate().div(H)), H.mul(exp(h0.negate().div(H)).sub(exp(h1.negate().div(H)))).div(dh));
    const sigma = atmo.mieScatter.mul(1.11).add(1.1e-5).mul(avg).add(atmo.mist.mul(exp(h0.add(h1).mul(-0.5).div(260))));
    const tau = sigma.mul(d);
    return float(1).sub(exp(tau.negate())).clamp(0, 1);
  })();
  const colorN = Fn(() => {
    const v = normalize(positionWorld.sub(cameraPosition));
    const dir = vec3(v.x, max(v.y, 0.02), v.z).normalize();
    const sky = skyRadiance(dir);
    return mix(sky, vec3(atmo.mistColor).mul(sky.dot(vec3(0.3, 0.5, 0.2)).max(0.0001).mul(1.1)), atmo.overcast);
  })();
  return fog(colorN, factor);
}

export const skyNodes = { skyRadiance, transmittanceAt, phaseMie };
export type { N };
void min;
void clamp;
void positionWorldDirection;
