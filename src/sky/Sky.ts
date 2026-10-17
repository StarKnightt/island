/**
 * The sky as seen and as lit: the atmosphere (Atmosphere.ts), a moving cumulus field (a cloud map re-rendered every
 * frame, shared by the sky and by the cloud shadows on the ground), the sun and moon discs, stars, and the
 * image-based light refreshed from the same sky as the time of day moves.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, abs, cameraPosition, clamp, cos, dot, exp, float, floor, fract, hash, max, mix, mx_fractal_noise_float,
  normalize, positionWorldDirection, pow, select, sin, smoothstep, sqrt, texture, uniform, uv, vec2, vec3, vec4, length,
  type N,
} from '../core/tsl';
import { SUN_E, atmo, renderAtmosphereLUTs, skyRadiance, transmittanceAt, R_GROUND } from './Atmosphere';

/** cloud layer */
export const clouds = {
  coverage: uniform(0.42),
  /** 0 fair-weather cumulus .. 1 thick rain clouds */
  thickness: uniform(0.2),
  base: uniform(1500),
  offset: uniform(new THREE.Vector2(0, 0)),
  /** extent of the cloud map (m), centred on the island */
  extent: 48000,
};

const CLOUD_RES = 1024;
export const cloudRT = new THREE.RenderTarget(CLOUD_RES, CLOUD_RES, { type: THREE.HalfFloatType, depthBuffer: false });
cloudRT.texture.minFilter = THREE.LinearFilter;
cloudRT.texture.magFilter = THREE.LinearFilter;
cloudRT.texture.wrapS = cloudRT.texture.wrapT = THREE.ClampToEdgeWrapping;
cloudRT.texture.generateMipmaps = false;

const cloudMapMaterial = (() => {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = Fn(() => {
    const p = uv().sub(0.5).mul(clouds.extent).add(clouds.offset);
    // large weather systems, then cumulus cells, then detail
    const weather = mx_fractal_noise_float(vec3(p.mul(1 / 14000), 0.3), 3, 2.0, 0.5).mul(0.5).add(0.5);
    const cells = mx_fractal_noise_float(vec3(p.mul(1 / 2600), 1.7), 5, 2.05, 0.52).mul(0.5).add(0.5);
    const detail = mx_fractal_noise_float(vec3(p.mul(1 / 520), 4.1), 3, 2.1, 0.5).mul(0.5).add(0.5);
    const cov = clouds.coverage.add(weather.sub(0.5).mul(0.35));
    const base = cells.mul(0.8).add(detail.mul(0.2));
    const d = smoothstep(float(1).sub(cov), float(1).sub(cov).add(0.22), base);
    // thickness grows toward the centre of each cloud
    const thick = d.mul(smoothstep(float(0.85).sub(cov), float(1.15).sub(cov), base));
    return vec4(d, thick, 0, 1);
  })();
  return m;
})();

const cloudQuad = new THREE.QuadMesh(cloudMapMaterial);

/** cloud density and thickness at a world xz position */
export const cloudAt = Fn(([xz]: N[]) => {
  const uvc = xz.div(clouds.extent).add(0.5);
  return texture(cloudRT.texture, uvc).xy;
});

/** cloud shadow on the ground: 1 = clear, smaller under clouds (sampled along the sun direction to the cloud base) */
export const cloudShadow = Fn(([worldPos]: N[]) => {
  const sun = normalize(atmo.sunDir);
  const t = clouds.base.sub(worldPos.y).div(max(sun.y, 0.08));
  const p = worldPos.xz.add(sun.xz.mul(t));
  const c = cloudAt(p);
  return float(1).sub(c.x.mul(0.55).add(c.y.mul(0.35)).clamp(0, 0.92));
});

// ---------------------------------------------------------------- the sky dome node
const sunCos = Math.cos((0.53 * Math.PI) / 360);
const moonCos = Math.cos((0.55 * Math.PI) / 360);

function stars(dir: N) {
  const p = dir.mul(220);
  const cell = floor(p);
  const h = hash(cell.x.mul(157).add(cell.y.mul(311)).add(cell.z.mul(523)));
  const f = fract(p).sub(0.5);
  const off = vec3(hash(cell.x.add(13.1)), hash(cell.y.add(7.7)), hash(cell.z.add(3.3))).sub(0.5).mul(0.7);
  const dd = length(f.sub(off));
  const star = smoothstep(0.09, 0.0, dd).mul(smoothstep(0.985, 1.0, h));
  const tw = sin(atmo.time.mul(h.mul(9).add(2)).add(h.mul(40))).mul(0.3).add(0.7);
  const tint = mix(vec3(1.0, 0.85, 0.7), vec3(0.75, 0.85, 1.0), hash(cell.x.add(cell.z)));
  // milky way: a faint band
  const band = exp(abs(dot(dir, normalize(vec3(0.3, 0.55, -0.78)))).mul(-9)).mul(mx_fractal_noise_float(dir.mul(6), 4, 2, 0.55).mul(0.5).add(0.5));
  return tint.mul(star.mul(tw).mul(pow(h, 40).mul(6).add(0.5))).add(vec3(0.6, 0.65, 0.8).mul(band.mul(0.06)));
}

/** full sky radiance: atmosphere, clouds, sun and moon discs, stars. `withSun` false for the environment map */
export function skyColorNode(withSun: boolean) {
  return Fn(() => {
    const dir = normalize(positionWorldDirection);
    const sun = normalize(atmo.sunDir);
    const moon = normalize(atmo.moonDir);
    const up = max(dir.y, 0);
    const above = vec3(dir.x, max(dir.y, 0.0), dir.z).normalize();
    let col = skyRadiance(above).toVar();
    // overcast: the clear sky flattens toward a grey with the same brightness
    const lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col.assign(mix(col, vec3(lum).mul(vec3(0.92, 0.96, 1.02)), atmo.overcast));
    // night sky glow so the darkest sky is deep blue, not black
    col.addAssign(vec3(0.0006, 0.0011, 0.0024).mul(atmo.night));
    // stars and moon (behind the clouds)
    const tr = transmittanceAt(float(R_GROUND).add(atmo.camHeight), max(dir.y, 0.02));
    const starL = stars(dir).mul(atmo.night).mul(float(1).sub(atmo.overcast)).mul(tr).mul(0.08);
    col.addAssign(starL);
    const md = dot(dir, moon);
    const moonDisc = smoothstep(moonCos - 0.000015, moonCos + 0.000015, md);
    const moonTex = mx_fractal_noise_float(dir.mul(900), 4, 2, 0.5).mul(0.25).add(0.82);
    const moonL = vec3(0.9, 0.92, 0.98).mul(moonDisc).mul(moonTex).mul(withSun ? 2.4 : 0.6).mul(atmo.moonPhaseLight).mul(tr);
    col.addAssign(moonL.mul(float(1).sub(atmo.overcast.mul(0.9))));
    // moon halo
    col.addAssign(vec3(0.5, 0.55, 0.65).mul(pow(max(md, 0), 900).mul(0.02)).mul(atmo.night));
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
    // clouds: a layer at the cloud base, seen through the haze
    const t = clouds.base.sub(cameraPosition.y).div(max(dir.y, 0.012));
    const p = cameraPosition.xz.add(dir.xz.mul(t));
    const c = cloudAt(p);
    const dens = c.x.mul(smoothstep(0.0, 0.08, dir.y));
    // lighting: sun through the cloud (self-shadow from the map toward the sun), sky ambient from above
    const ps = p.add(sun.xz.mul(320).div(max(sun.y, 0.1)));
    const shadowT = cloudAt(ps).y;
    const sunT = transmittanceAt(float(R_GROUND).add(clouds.base), max(sun.y, -0.1));
    const sunVis = smoothstep(-0.08, 0.04, sun.y);
    const cosT = dot(dir, sun);
    const forward = pow(max(cosT, 0), 8).mul(2.2).add(pow(max(cosT, 0), 64).mul(4));
    const thick = c.y.mul(clouds.thickness.mul(0.6).add(0.4));
    const beer = exp(thick.mul(-3.2).sub(shadowT.mul(2.2)));
    const powder = float(1).sub(exp(c.x.mul(-6)));
    const sunlit = sunT.mul(SUN_E / Math.PI).mul(sunVis).mul(beer.mul(powder).mul(float(1).add(forward)).mul(0.9).add(0.06));
    const zen = skyRadiance(vec3(0, 1, 0));
    const ambient = zen.mul(2.4).mul(float(1).sub(thick.mul(0.55))).add(vec3(0.004, 0.006, 0.01).mul(atmo.night));
    const rainDark = float(1).sub(clouds.thickness.mul(0.7));
    const cloudCol = sunlit.add(ambient).mul(rainDark).mul(float(1).sub(atmo.overcast.mul(0.3)));
    // aerial perspective of the clouds themselves
    const haze = float(1).sub(exp(t.mul(-1 / 26000)));
    const cloudSeen = mix(cloudCol, col, haze.mul(0.85));
    col.assign(mix(col, cloudSeen, dens.mul(smoothstep(60000, 15000, t))));
    // below the horizon (the environment map's lower half): light bounced off the ground (sand, leaves, sea) under
    // the sun and the sky, so undersides and trunks get a neutral warm bounce instead of a colour of their own
    const horizon = skyRadiance(normalize(vec3(dir.x, 0.02, dir.z)));
    const sunIrr = transmittanceAt(float(R_GROUND).add(atmo.camHeight), max(sun.y, 0.0)).mul(SUN_E).mul(max(sun.y, 0)).mul(float(1).sub(atmo.overcast.mul(0.88)));
    const skyIrr = mix(zen, horizon, 0.5).mul(Math.PI);
    const ground = vec3(0.13, 0.12, 0.095).mul(sunIrr.add(skyIrr)).div(Math.PI);
    const sea = vec3(0.012, 0.035, 0.05).mul(horizon.dot(vec3(0.33)).mul(8).add(0.05));
    const below = mix(horizon.mul(0.5), withSun ? sea : ground, smoothstep(0.0, -0.25, dir.y));
    col.assign(select(dir.y.lessThan(0), mix(col, below, smoothstep(0.0, -0.06, dir.y)), col));
    void up;
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

  constructor(private renderer: THREE.WebGPURenderer, scene: THREE.Scene) {
    scene.backgroundNode = skyColorNode(true);
    this.envScene.backgroundNode = skyColorNode(false);
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  /** per frame: atmosphere LUTs and the cloud map; the environment map when the light has changed */
  update(dt: number, scene: THREE.Scene, force = false) {
    // the sun, the haze and the clouds change slowly: the LUTs every third frame, the cloud map every second
    this.n++;
    if (force || this.n % 3 === 0) renderAtmosphereLUTs(this.renderer);
    if (force || this.n % 2 === 0) {
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

export { cos, sin, clamp, vec2, uniform };
