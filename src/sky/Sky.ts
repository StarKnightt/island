/**
 * The sky as seen and as lit: the atmosphere (Atmosphere.ts), a field of tropical cumulus (flat bases at a common
 * height, towers whose height follows each cell, lit tops and grey bases, ray-marched through a slab), drifting
 * with the trade wind; at full cover a lumpy rain deck. One cloud map feeds the sky, the cloud shadows on land and
 * sea, and the ocean's reflections. Sun and moon discs, stars and the Milky Way at night, and the image-based light
 * refreshed from the same sky as the time of day moves.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, Loop, If, Break, abs, cameraPosition, clamp, dot, exp, float, floor, fract, hash, max, min, mix, mx_noise_float,
  mx_fractal_noise_float, normalize, positionWorldDirection, pow, select, sin, smoothstep, sqrt, texture, uniform,
  uv, vec2, vec3, vec4, length, screenCoordinate, interleavedGradientNoise, type N,
} from '../core/tsl';
import { SUN_E, atmo, renderAtmosphereLUTs, skyRadiance, transmittanceAt, R_GROUND } from './Atmosphere';
import { Q } from '../core/quality';

/** cloud layer */
export const clouds = {
  /** 0..1 share of the sky covered */
  coverage: uniform(0.42),
  /** 0 fair-weather cumulus .. 1 thick rain clouds */
  thickness: uniform(0.2),
  /** cloud base and the tallest towers above it (m) */
  base: uniform(1150),
  depth: uniform(1500),
  /** cloud-space drift (the wind carries the field) and the origin of the cloud map in cloud space */
  drift: uniform(new THREE.Vector2(0, 0)),
  origin: uniform(new THREE.Vector2(0, 0)),
  /** the light the clouds are lit by: the sun by day, the moon by night (direction, radiance scale) */
  lightDir: uniform(new THREE.Vector3(0, 1, 0)),
  lightColor: uniform(new THREE.Color(1, 1, 1)),
  /** frame counter (mod 64) for the march jitter, so temporal AA resolves it even with the world clock frozen */
  frame: uniform(0),
  /** extent of the cloud map (m) */
  extent: 40000,
};

const CLOUD_RES = 1024;
export const cloudRT = new THREE.RenderTarget(CLOUD_RES, CLOUD_RES, { type: THREE.HalfFloatType, depthBuffer: false });
cloudRT.texture.minFilter = THREE.LinearFilter;
cloudRT.texture.magFilter = THREE.LinearFilter;
cloudRT.texture.wrapS = cloudRT.texture.wrapT = THREE.ClampToEdgeWrapping;
cloudRT.texture.generateMipmaps = false;

/** a small tileable noise for eroding the cloud towers into puffs: R fbm, G billows, B fine fbm */
function erosionTexture() {
  const S = 128;
  const lattice = (period: number, seed: number) => {
    const g = new Float32Array(period * period);
    let s = seed;
    for (let i = 0; i < g.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      g[i] = s / 4294967296;
    }
    return (x: number, y: number) => {
      const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
      const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
      const at = (a: number, b: number) => g[(((b % period) + period) % period) * period + (((a % period) + period) % period)];
      return (at(xi, yi) * (1 - ux) + at(xi + 1, yi) * ux) * (1 - uy) + (at(xi, yi + 1) * (1 - ux) + at(xi + 1, yi + 1) * ux) * uy;
    };
  };
  const oct = [4, 8, 16, 32].map((p, i) => ({ p, f: lattice(p, 17 + i * 101) }));
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let fbm = 0, bill = 0, fine = 0, w = 0.5;
    for (const { p, f } of oct) {
      const v = f((x / S) * p, (y / S) * p);
      fbm += v * w;
      bill += (1 - Math.abs(v * 2 - 1)) * w;
      w *= 0.5;
    }
    for (const { p, f } of oct.slice(2)) fine += f((x / S) * p * 2 + 0.37, (y / S) * p * 2 + 0.61) * (p === 16 ? 0.6 : 0.4);
    const o = (y * S + x) * 4;
    data[o] = Math.round(Math.min(1, fbm / 0.9375) * 255);
    data[o + 1] = Math.round(Math.min(1, bill / 0.9375) * 255);
    data[o + 2] = Math.round(Math.min(1, fine) * 255);
    data[o + 3] = 255;
  }
  const t = new THREE.DataTexture(data, S, S);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
const erosion = erosionTexture();

const cloudMapMaterial = (() => {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = Fn(() => {
    const q = uv().sub(0.5).mul(clouds.extent).add(clouds.origin);
    // weather systems, then cumulus cells (~1-2 km), then their lumpy outlines
    const weather = mx_fractal_noise_float(vec3(q.mul(1 / 15000), 0.3), 3, 2.0, 0.5).mul(0.5).add(0.5);
    const cells = mx_fractal_noise_float(vec3(q.mul(1 / 2300), 1.7), 5, 2.05, 0.5).mul(0.5).add(0.5);
    const detail = mx_fractal_noise_float(vec3(q.mul(1 / 560), 4.1), 3, 2.1, 0.5).mul(0.5).add(0.5);
    const cov = clouds.coverage.add(weather.sub(0.5).mul(0.4));
    const v = cells.mul(0.78).add(detail.mul(0.22));
    const th = float(1).sub(cov);
    // footprint (where there is cloud at all) and tower height (rising toward the centre of each cell)
    const foot = smoothstep(th, th.add(0.07), v);
    const height = smoothstep(th, th.add(0.3), v);
    return vec4(foot, height, 0, 1);
  })();
  return m;
})();

const cloudQuad = new THREE.QuadMesh(cloudMapMaterial);

/** cloud map (footprint, tower height) at a world xz position; fades out before the map's edge (sampling past it
 *  would smear the edge texels into streaks fanning out to the horizon) */
export const cloudAt = Fn(([xz]: N[]) => {
  const q = xz.add(clouds.drift);
  const uvc = q.sub(clouds.origin).div(clouds.extent).add(0.5);
  const edge = max(abs(uvc.x.sub(0.5)), abs(uvc.y.sub(0.5)));
  return texture(cloudRT.texture, uvc).xy.mul(float(1).sub(smoothstep(0.36, 0.47, edge)));
});

/**
 * Cloud density at a world point inside the slab (h: 0 at the base .. 1 at the tallest tops). Each cell of the map is
 * a dome (steep sides, a rounded top) whose height the large fbm varies; billows heap its upper part into cauliflower
 * and rag its lower sides into wisps; the base is flat and crisp, but a rain deck's base hangs in lumps.
 */
function cloudDensity(p: N, h: N, detail = true) {
  const m = cloudAt(p.xz);
  const out = float(0).toVar();
  // most samples of a fair-weather sky fall where the map has no cloud: no noise there
  If(m.x.greaterThan(0.001), () => {
    const q = p.xz.add(clouds.drift);
    const deck = clouds.thickness;
    // billows from true 3D gradient noise (2D noise shifted with height extrudes into tall sheets that read as
    // streaks): |noise| has rounded crowns and sharp creases between them
    const P3 = vec3(q.x, p.y.mul(1.4), q.y);
    const b1 = abs(mx_noise_float(P3.div(430)));
    const b2 = detail ? abs(mx_noise_float(P3.div(150).add(7.1))) : float(0.32);
    const f1 = texture(erosion, q.div(2600).add(0.71)).level(0).r;
    const top = pow(m.y, 0.7).mul(mix(float(0.8), float(1.0), deck)).mul(f1.mul(0.5).add(0.75));
    const bulge = b1.mul(0.65).add(b2.mul(0.35)).sub(0.3).mul(1.6);
    const up = smoothstep(0.12, 0.6, h);
    const inside = top.sub(h).add(bulge.mul(mix(float(0.46), float(0.22), deck)).mul(mix(float(0.55), float(1.0), up)));
    const baseEdge = smoothstep(0.0, mix(float(0.02), float(0.08), deck), h.add(bulge.mul(mix(float(0.012), float(0.09), deck))));
    out.assign(smoothstep(0.0, 0.06, inside).mul(baseEdge).mul(mix(float(0.55), float(1.0), m.x)));
  });
  return out;
}

/**
 * Direct light let through the clouds at a world point (1 = clear sky): the cloud map sampled where the light ray
 * crosses the lower half of the slab.
 */
export const cloudShadow = Fn(([worldPos]: N[]) => {
  const l = normalize(clouds.lightDir);
  const y = clouds.base.add(clouds.depth.mul(0.2));
  const t = y.sub(worldPos.y).div(max(l.y, 0.06));
  const c = cloudAt(worldPos.xz.add(l.xz.mul(t)));
  const opacity = c.x.mul(smoothstep(0.02, 0.3, c.y)).mul(mix(float(0.86), float(0.96), clouds.thickness));
  return float(1).sub(opacity);
});

// ---------------------------------------------------------------- the sky dome node
const sunCos = Math.cos((0.53 * Math.PI) / 360);
const moonCos = Math.cos((0.55 * Math.PI) / 360);

function stars(dir: N) {
  const p = dir.mul(240);
  const cell = floor(p);
  const h = hash(cell.x.mul(157).add(cell.y.mul(311)).add(cell.z.mul(523)));
  const f = fract(p).sub(0.5);
  const off = vec3(hash(cell.x.add(13.1)), hash(cell.y.add(7.7)), hash(cell.z.add(3.3))).sub(0.5).mul(0.7);
  const dd = length(f.sub(off));
  const star = smoothstep(0.1, 0.0, dd).mul(smoothstep(0.968, 1.0, h));
  const tw = sin(atmo.time.mul(h.mul(9).add(2)).add(h.mul(40))).mul(0.3).add(0.7);
  const tint = mix(vec3(1.0, 0.85, 0.7), vec3(0.75, 0.85, 1.0), hash(cell.x.add(cell.z)));
  // the Milky Way: a broad, mottled band across the sky
  const bandD = abs(dot(dir, normalize(vec3(0.3, 0.55, -0.78))));
  const band = exp(bandD.mul(bandD).mul(-26)).mul(mx_fractal_noise_float(dir.mul(7), 4, 2, 0.55).mul(0.6).add(0.55));
  return tint.mul(star.mul(tw).mul(pow(h, 40).mul(7).add(0.6))).add(vec3(0.62, 0.66, 0.82).mul(band.mul(0.16)));
}

/** full sky radiance: atmosphere, clouds, sun and moon discs, stars. `withSun` false for the environment map */
export function skyColorNode(withSun: boolean) {
  return Fn(() => {
    const dir = normalize(positionWorldDirection);
    const sun = normalize(atmo.sunDir);
    const moon = normalize(atmo.moonDir);
    const above = vec3(dir.x, max(dir.y, 0.0), dir.z).normalize();
    const col = skyRadiance(above).toVar();
    // overcast: the clear sky flattens toward a grey with the same brightness
    const lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col.assign(mix(col, vec3(lum).mul(vec3(0.92, 0.96, 1.02)), atmo.overcast));
    // night sky glow so the darkest sky is deep blue, not black
    col.addAssign(vec3(0.0005, 0.0009, 0.0021).mul(atmo.night));
    // stars and moon (behind the clouds)
    const tr = transmittanceAt(float(R_GROUND).add(atmo.camHeight), max(dir.y, 0.02));
    const starL = stars(dir).mul(atmo.night).mul(float(1).sub(atmo.overcast)).mul(tr).mul(0.14);
    col.addAssign(starL);
    const md = dot(dir, moon);
    const moonDisc = smoothstep(moonCos - 0.000015, moonCos + 0.000015, md);
    const moonTex = mx_fractal_noise_float(dir.mul(900), 4, 2, 0.5).mul(0.25).add(0.82);
    const moonL = vec3(0.9, 0.92, 0.98).mul(moonDisc).mul(moonTex).mul(withSun ? 2.4 : 0.6).mul(atmo.moonPhaseLight).mul(tr);
    col.addAssign(moonL.mul(float(1).sub(atmo.overcast.mul(0.9))));
    // moon halo in the haze
    col.addAssign(vec3(0.5, 0.55, 0.65).mul(pow(max(md, 0), 700).mul(0.03).add(pow(max(md, 0), 30).mul(0.0015))).mul(atmo.night));
    if (withSun) {
      const sd = dot(dir, sun);
      const disc = smoothstep(sunCos - 0.000006, sunCos + 0.000006, sd);
      // limb darkening
      const mu = sqrt(max(float(1).sub(float(1).sub(sd).div(1 - sunCos)), 0));
      const limb = float(1).sub(float(0.6).mul(float(1).sub(mu)));
      const sunL = transmittanceAt(float(R_GROUND).add(atmo.camHeight), sun.y).mul(disc).mul(limb).mul(SUN_E * 220);
      // a thick overcast hides the disc completely (5 % of it would still bloom into a glare)
      col.addAssign(sunL.mul(float(1).sub(smoothstep(0.25, 0.85, atmo.overcast))));
    }
    // ---- cumulus: ray-marched through the slab between the base and the tallest tops
    const base = clouds.base, depth = clouds.depth;
    const camY = cameraPosition.y;
    const dy = max(dir.y, 0.008);
    const t0 = max(base.sub(camY).div(dy), 0);
    const t1 = min(base.add(depth).sub(camY).div(dy), t0.add(11000));
    const STEPS = withSun ? Math.round(Q.cloudSteps * 1.5) : 9;
    const dt = t1.sub(t0).div(STEPS);
    // interleaved gradient noise stepped every frame (Jimenez's 5.588 offset) so TAA averages the slices away
    const jitter = withSun ? interleavedGradientNoise(screenCoordinate.xy.add(clouds.frame.mul(5.588238))) : float(0.5);
    const T = float(1).toVar();
    const Lc = vec3(0).toVar();
    const l = normalize(clouds.lightDir);
    const cosT = dot(dir, l);
    const hg = (g: number) => float((1 - g * g) / (4 * Math.PI)).div(pow(float(1 + g * g).sub(cosT.mul(2 * g)), 1.5));
    const phase = hg(0.62).mul(0.55).add(hg(-0.12).mul(0.45));
    const lightRad = vec3(clouds.lightColor);
    const zen = skyRadiance(vec3(0, 1, 0));
    const sigma = mix(float(0.03), float(0.05), clouds.thickness);
    // cloud base lit from below by the sea and the land (a little), from above by the sky dome
    const ambTop = zen.mul(2.1).add(vec3(0.0012, 0.0016, 0.0026).mul(atmo.night));
    const ambBot = ambTop.mul(0.32).add(vec3(0.01, 0.02, 0.025).mul(lightRad.dot(vec3(0.33)).mul(0.25)));
    If(dir.y.greaterThan(0.004).and(camY.lessThan(base)).and(t0.lessThan(70000)), () => {
      Loop(STEPS, ({ i }: { i: N }) => {
        const t = t0.add(float(i).add(jitter).mul(dt));
        const p = cameraPosition.add(dir.mul(t));
        const h = p.y.sub(base).div(depth);
        const d = cloudDensity(p, h);
        If(d.greaterThan(0.002), () => {
          // light toward the sun (or moon): two taps through the cloud
          const p1 = p.add(l.mul(110)), p2 = p.add(l.mul(380));
          const d1 = cloudDensity(p1, p1.y.sub(base).div(depth), false);
          const d2 = cloudDensity(p2, p2.y.sub(base).div(depth), false);
          const tauL = d1.mul(110).add(d2.mul(270)).mul(sigma);
          const tL = exp(tauL.negate()).mul(0.72).add(exp(tauL.mul(-0.22)).mul(0.28));
          // powder: thin edges facing away from the light are darker (in-scatter has not built up yet)
          const powder = float(1).sub(exp(d.mul(sigma).mul(-160))).mul(0.7).add(0.3);
          const direct = lightRad.mul(tL).mul(phase).mul(powder).mul(Math.PI * 4 * 0.55);
          const amb = mix(ambBot, ambTop, smoothstep(0.0, 0.8, h));
          const stepT = exp(d.mul(sigma).mul(dt).negate());
          Lc.addAssign(T.mul(float(1).sub(stepT)).mul(direct.add(amb)));
          T.mulAssign(stepT);
        });
        If(T.lessThan(0.02), () => {
          Break();
        });
      });
      // the clouds sit in the haze: far ones pale toward the sky behind them
      const tm = t0.add(t1).mul(0.5);
      const haze = float(1).sub(exp(tm.mul(-1 / 21000)));
      const dark = float(1).sub(clouds.thickness.mul(0.55)).mul(float(1).sub(atmo.overcast.mul(0.25)));
      const seen = mix(Lc.mul(dark), col.mul(float(1).sub(T)), haze.mul(0.9));
      col.assign(col.mul(T).add(seen));
    });
    // below the horizon (the environment map's lower half): light bounced off the ground (sand, leaves, sea) under
    // the sun and the sky, so undersides and trunks get a neutral bounce instead of a colour of their own; it fades
    // at a low sun so shade stays cool (sky-lit) against the warm light
    const horizon = skyRadiance(normalize(vec3(dir.x, 0.02, dir.z)));
    const sunIrr = transmittanceAt(float(R_GROUND).add(atmo.camHeight), max(sun.y, 0.0)).mul(SUN_E).mul(max(sun.y, 0)).mul(float(1).sub(atmo.overcast.mul(0.88)));
    const skyIrr = mix(zen, horizon, 0.5).mul(Math.PI);
    const ground = vec3(0.13, 0.12, 0.095).mul(sunIrr.add(skyIrr)).div(Math.PI);
    const sea = vec3(0.012, 0.035, 0.05).mul(horizon.dot(vec3(0.33)).mul(8).add(0.05));
    const below = mix(horizon.mul(0.5), withSun ? sea : ground, smoothstep(0.0, -0.25, dir.y));
    col.assign(select(dir.y.lessThan(0), mix(col, below, smoothstep(0.0, -0.06, dir.y)), col));
    return col;
  })();
}

export class Sky {
  readonly envScene = new THREE.Scene();
  private pmrem: THREE.PMREMGenerator;
  envRT: THREE.RenderTarget | null = null;
  private envAge = 1e9;
  private n = 0;
  private lastSun = new THREE.Vector3();
  private mapState = { cov: -1, thick: -1, ox: 1e9, oz: 1e9 };

  constructor(private renderer: THREE.WebGPURenderer, scene: THREE.Scene) {
    scene.backgroundNode = skyColorNode(true);
    this.envScene.backgroundNode = skyColorNode(false);
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  /**
   * Move the cloud field: drift with the wind over real time and over the clock (so captures frozen at different
   * hours see different skies); the map is re-rendered only when the drift has carried it far or the cover changed.
   */
  setDrift(windX: number, windZ: number, seconds: number, hour: number) {
    const speed = 9;
    const s = seconds + hour * 75;
    const dx = windX * speed * s, dz = windZ * speed * s;
    (clouds.drift.value as THREE.Vector2).set(dx, dz);
  }

  /** per frame: atmosphere LUTs and the cloud map; the environment map when the light has changed */
  update(dt: number, scene: THREE.Scene, force = false) {
    // the sun and the haze change slowly: the LUTs every third frame
    this.n++;
    clouds.frame.value = this.n % 64;
    if (force || this.n % 3 === 0) renderAtmosphereLUTs(this.renderer);
    const st = this.mapState;
    const drift = clouds.drift.value as THREE.Vector2;
    const cov = clouds.coverage.value as number, thick = clouds.thickness.value as number;
    const far = Math.hypot(drift.x - st.ox, drift.y - st.oz) > 6000;
    if (force || far || Math.abs(cov - st.cov) > 0.004 || Math.abs(thick - st.thick) > 0.004) {
      if (force || far) {
        st.ox = Math.round(drift.x / 500) * 500;
        st.oz = Math.round(drift.y / 500) * 500;
        (clouds.origin.value as THREE.Vector2).set(st.ox, st.oz);
      }
      st.cov = cov;
      st.thick = thick;
      const prev = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(cloudRT);
      cloudQuad.render(this.renderer);
      this.renderer.setRenderTarget(prev);
    }
    this.envAge += dt;
    const sun = atmo.sunDir.value as THREE.Vector3;
    const moved = sun.angleTo(this.lastSun) > 0.004;
    if (force || this.envAge > 2.5 || (moved && this.envAge > 0.6)) {
      this.envAge = 0;
      this.lastSun.copy(sun);
      this.envRT = this.pmrem.fromScene(this.envScene as unknown as THREE.Scene, 0, 0.1, 100, { size: 128, renderTarget: this.envRT ?? undefined } as never);
      scene.environment = this.envRT.texture;
    }
  }
}

export { clamp, vec2, uniform, abs };
