/**
 * Physically based sky: Rayleigh + Mie + ozone single scattering plus multiple scattering, after Hillaire 2020 ("A
 * Scalable and Production Ready Sky and Atmosphere Rendering Technique"): a transmittance LUT, a multiple-scattering
 * LUT (the light the sky itself sheds on the air: blue-violet at a low sun, not the reddened sun's colour) and a
 * sky-view LUT re-rendered from the camera altitude and sun direction. The visible sky, the image-based light, the
 * sun's colour and the aerial perspective (scene fog) all read the same model.
 *
 * Units: metres; radiance in the game's scaled photometric units (sun illuminance at the top of the atmosphere =
 * SUN_E). Scattering coefficients are Earth's, with a tropical marine aerosol layer whose amount and spectral slope
 * (Angstrom exponent) follow the time of day and the weather (TimeOfDay.ts): a humid whitish haze at dawn, a denser,
 * finer one that reddens the evening sun, more water droplets in rain.
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
  /** Mie scattering at sea level (aerosols), at 550 nm; set per frame by TimeOfDay from the hour and the weather */
  mieScatter: uniform(2e-5),
  /** aerosol scattering and extinction per channel relative to green (680, 550, 440 nm): (lambda / 550)^-angstrom */
  mieTint: uniform(new THREE.Vector3(1, 1, 1)),
  /** aerosol phase asymmetry: marine aerosol ~0.7 (0.78 piled the low sun's glow into a blown-out blob round it) */
  mieG: uniform(0.72),
  /** gain on the multiple-scattering LUT */
  msK: uniform(1.0),
  /** fog: extra extinction for rain, per metre at sea level */
  mist: uniform(0.0),
  /** ground mist at dawn: extinction per metre at sea level, thinning with a scale height of DAWN_H */
  dawnMist: uniform(0.0),
  /**
   * boundary-layer haze for the aerial perspective, per metre at sea level: with the aerosol and the air about 1.7e-4
   * at noon (visibility ~23 km, a humid trade-wind day), ridges 1-2 km out pale by 15-30 %, a coast 5 km out by
   * ~55 %, the sea horizon soft
   */
  haze: uniform(1.4e-4),
  // (rain haze over a green island is a neutral, faintly green grey: a blue-grey one read as frost on the forest)
  mistColor: uniform(new THREE.Color(0.6, 0.62, 0.58)),
  /** 0..1 overcast: flattens the sky toward grey */
  overcast: uniform(0),
  /** brightness of the overcast deck (1 = its mean): dark under a heavy rain cell, lighter in a lull */
  deck: uniform(1),
  /** night factor for the stars, moon light */
  night: uniform(0),
  /** illuminance of a horizontal surface (sun or moon + sky), scene units: lights unlit effects (mist, spray) */
  lightE: uniform(1),
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

/** scattering/extinction at altitude h (m): { rayleigh: vec3, mieS: vec3 (aerosol scattering), ext: vec3 } */
const densities = (h: N) => {
  const dR = exp(h.negate().div(RAYLEIGH_H));
  const dM = exp(h.negate().div(MIE_H));
  const dO = max(float(0), float(1).sub(abs(h.sub(25000)).div(15000)));
  const rayleigh = vec3(RAYLEIGH.x, RAYLEIGH.y, RAYLEIGH.z).mul(dR);
  const mieS = vec3(atmo.mieTint).mul(atmo.mieScatter.mul(dM));
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

// ---------------------------------------------------------------- multiple-scattering LUT (Hillaire 2020, sec. 5.5)
/**
 * Psi_ms(altitude, cos sun zenith): the second-order light at a point (single-scattered sun light arriving from 64
 * directions over the sphere, isotropic phase, the ground's bounce included) times the geometric series 1 / (1 - f_ms)
 * of all higher orders. The sky-view march adds scattering * Psi_ms at every step.
 */
const MS_N = 32;
const MS_DIRS = 64, MS_STEPS = 20;
const MS_ALBEDO = 0.1;
const msMaterial = (() => {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = Fn(() => {
    const muS = uv().x.mul(2).sub(1);
    const r = float(R_GROUND).add(max(uv().y.mul(R_TOP - R_GROUND), 1));
    const sunD = vec3(sqrt(max(float(1).sub(muS.mul(muS)), 0)), muS, 0);
    const lumT = vec3(0).toVar();
    const fms = vec3(0).toVar();
    Loop(MS_DIRS, ({ i }: { i: N }) => {
      const fi = float(i);
      const a = fi.div(8).floor();
      const b = fi.sub(a.mul(8));
      const th = a.add(0.5).mul((Math.PI * 2) / 8);
      const cp = float(1).sub(b.add(0.5).mul(2 / 8));
      const sp = sqrt(max(float(1).sub(cp.mul(cp)), 0));
      const dir = vec3(cos(th).mul(sp), cp, sin(th).mul(sp));
      const ground = hitsGround(r, dir.y);
      const L = select(ground, distToGround(r, dir.y), distToTop(r, dir.y));
      const dt = L.div(MS_STEPS).toVar();
      const tr = vec3(1).toVar();
      const lum = vec3(0).toVar();
      const lf = vec3(0).toVar();
      Loop({ start: 0, end: MS_STEPS, type: 'int', condition: '<', name: 's' }, ({ s }: { s: N }) => {
        const t = float(s).add(0.3).mul(dt);
        const p = dir.mul(t).add(vec3(0, r, 0));
        const rr = length(p);
        const muP = dot(p.div(rr), sunD);
        const den = densities(rr.sub(R_GROUND));
        const vis = smoothstep(-0.02, 0.0, muP.add(sqrt(max(float(1).sub(float(R_GROUND * R_GROUND).div(rr.mul(rr))), 0))));
        const sc = den.rayleigh.add(den.mieS);
        const st = exp(den.ext.negate().mul(dt));
        const sInt = sc.sub(sc.mul(st)).div(max(den.ext, vec3(1e-9)));
        lf.addAssign(tr.mul(sInt));
        lum.addAssign(tr.mul(sInt).mul(transmittanceAt(rr, muP)).mul(vis.mul(1 / (4 * Math.PI))));
        tr.mulAssign(st);
      });
      // the ground (sea and forest) bounces a little of the sun back up
      const gp = dir.mul(L).add(vec3(0, r, 0));
      const gr = length(gp);
      const gm = dot(gp.div(gr), sunD);
      const bounce = tr.mul(transmittanceAt(max(gr, R_GROUND + 1), max(gm, 0.0))).mul(max(gm, 0).mul(MS_ALBEDO / Math.PI));
      lum.addAssign(select(ground, bounce, vec3(0)));
      lumT.addAssign(lum.mul(1 / MS_DIRS));
      fms.addAssign(lf.mul(1 / MS_DIRS));
    });
    return vec4(lumT.div(max(vec3(1).sub(fms), vec3(0.05))), 1);
  })();
  return m;
})();

export const msRT = new THREE.RenderTarget(MS_N, MS_N, { type: THREE.HalfFloatType, depthBuffer: false });
msRT.texture.minFilter = THREE.LinearFilter;
msRT.texture.magFilter = THREE.LinearFilter;
msRT.texture.generateMipmaps = false;

const msAt = (h: N, muS: N) => {
  const u = muS.mul(0.5).add(0.5).mul((MS_N - 1) / MS_N).add(0.5 / MS_N);
  const v = h.div(R_TOP - R_GROUND).clamp(0, 1).mul((MS_N - 1) / MS_N).add(0.5 / MS_N);
  return texture(msRT.texture, vec2(u, v)).rgb;
};

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
      const scat = den.rayleigh.mul(pR).add(den.mieS.mul(pM));
      const ms = den.rayleigh.add(den.mieS).mul(msAt(h, muS)).mul(atmo.msK);
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
/** the aerosol the transmittance and multiple-scattering LUTs were last rendered for */
const lutAerosol = [-1, -1, -1, -1];
export function renderAtmosphereLUTs(renderer: THREE.WebGPURenderer) {
  const prev = renderer.getRenderTarget();
  // both depend only on the air (the aerosol follows the hour and the weather): re-rendered when it has changed
  const tint = atmo.mieTint.value as THREE.Vector3;
  const now = [atmo.mieScatter.value as number, tint.x, tint.z, atmo.mieG.value as number];
  if (now.some((v, i) => Math.abs(v - lutAerosol[i]) > Math.abs(v) * 0.004 + 1e-9)) {
    now.forEach((v, i) => (lutAerosol[i] = v));
    quad.material = transmittanceMaterial;
    renderer.setRenderTarget(transmittanceRT);
    quad.render(renderer);
    quad.material = msMaterial;
    renderer.setRenderTarget(msRT);
    quad.render(renderer);
  }
  quad.material = skyViewMaterial;
  renderer.setRenderTarget(skyViewRT);
  quad.render(renderer);
  renderer.setRenderTarget(prev);
}

// ---------------------------------------------------------------- CPU mirror of the transmittance (for light colours)
const tmpV = new THREE.Vector3();
/** CPU estimate of the sun's transmittance (rgb) at sea level for a sun elevation (radians); matches the LUT closely */
export function sunTransmittanceCPU(elevation: number, mie = 2e-5, out = new THREE.Color(), tint = atmo.mieTint.value as THREE.Vector3) {
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
    tr += (RAYLEIGH.x * dR + mie * tint.x * 1.11 * dM + OZONE.x * dO) * dt;
    tg += (RAYLEIGH.y * dR + mie * tint.y * 1.11 * dM + OZONE.y * dO) * dt;
    tb += (RAYLEIGH.z * dR + mie * tint.z * 1.11 * dM + OZONE.z * dO) * dt;
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
/** scale height of the dawn ground mist (m): it lies over the sea, the beach and the coastal flats, thin on the hills */
export const DAWN_H = 40;

export function aerialFogNode() {
  const factor = Fn(() => {
    const d = length(positionView);
    const h0 = max(cameraPosition.y, 0), h1 = max(positionWorld.y, 0);
    const dh = h1.sub(h0);
    // average density between the two heights of an exponential profile of scale height H
    const avgExp = (H: number) => select(abs(dh).lessThan(1), exp(h0.add(h1).mul(-0.5 / H)), float(H).mul(exp(h0.mul(-1 / H)).sub(exp(h1.mul(-1 / H)))).div(dh));
    // tropical marine haze: visibility of a few tens of kilometres, so ridges a kilometre away pale a little and the
    // sea dissolves into the sky at the horizon (the sky's own aerosol is in the LUT; this is the low boundary layer)
    const haze = atmo.mieScatter.mul(1.11).add(1.1e-5).add(atmo.haze).mul(avgExp(1100));
    // rain: the air between the showers is clearer than the curtains a few kilometres out, so the forest half a
    // kilometre away keeps its dark olive through the rain and the far coast still dissolves into grey
    const rainW = mix(float(0.45), float(1.0), smoothstep(200, 2200, d));
    const rain = atmo.mist.mul(exp(h0.add(h1).mul(-0.5).div(260))).mul(rainW);
    const mist = atmo.dawnMist.mul(avgExp(DAWN_H));
    const tau = haze.add(rain).add(mist).mul(d);
    return float(1).sub(exp(tau.negate())).clamp(0, 1);
  })();
  const colorN = Fn(() => {
    const v = normalize(positionWorld.sub(cameraPosition));
    const dir = vec3(v.x, max(v.y, 0.02), v.z).normalize();
    const sky = skyRadiance(dir);
    // under an overcast the haze is the grey of the overcast sky's horizon (Sky.ts: about a fifth of the dome
    // overhead, scaled from the clear sky 15 degrees up in this direction)
    const lumRef = skyRadiance(normalize(vec3(v.x, 0.27, v.z))).dot(vec3(0.2126, 0.7152, 0.0722));
    return mix(sky, vec3(atmo.mistColor).mul(lumRef.mul(0.73).mul(atmo.deck)), atmo.overcast);
  })();
  return fog(colorN, factor);
}

/**
 * The sky's light on a small particle (spray, splash, mist), from above: the clear sky's zenith; under an overcast
 * the grey of the cloud deck (Sky.ts: the deck overhead renders at about 0.7 of the clear sky's luminance 15 degrees
 * up, taken on both sides of the sun), not the blue of the clear zenith hidden above it.
 */
export const particleSky = Fn(() => {
  const s = vec2(atmo.sunDir.x, atmo.sunDir.z);
  const h = s.div(max(length(s), 1e-3));
  const ref = skyRadiance(normalize(vec3(h.x, 0.27, h.y))).add(skyRadiance(normalize(vec3(h.x.negate(), 0.27, h.y.negate()))));
  const lumRef = dot(ref, vec3(0.2126 * 0.5, 0.7152 * 0.5, 0.0722 * 0.5));
  return mix(skyRadiance(vec3(0, 1, 0)), vec3(0.95, 0.97, 1.0).mul(lumRef.mul(0.7)), atmo.overcast);
});

export const skyNodes = { skyRadiance, transmittanceAt, phaseMie };
export type { N };
void min;
void clamp;
void positionWorldDirection;
