import * as THREE from 'three/webgpu';
import { dot, float, length, mix, renderOutput, screenUV, smoothstep, uniform, vec3, vec4, type N } from './tsl';
import { params } from './params';

/** display-space grade applied after tone mapping (exposure and bloom strength are read before it, in Engine) */
export const grade = {
  exposure: uniform(1.0),
  /**
   * exposure compensation for shooting into a low sun (1 = none): the sky around a setting or rising sun is ten to
   * twenty times brighter than the land it lights, and a photographer exposes for the sky, so the glow keeps its
   * orange and the land in front of it falls toward silhouette. Set per frame by updateViewExposure.
   */
  sunComp: uniform(1.0),
  saturation: uniform(1.06),
  contrast: uniform(1.06),
  lift: uniform(new THREE.Vector3(0.0, 0.0, 0.0)),
  gain: uniform(new THREE.Vector3(1.0, 1.0, 1.0)),
  vignette: uniform(params.clean ? 0 : 0.2),
  aoStrength: uniform(0.75),
  /** set per frame by updateViewExposure */
  bloomStrength: uniform(0.04),
};

const BLOOM = 0.04;
const view = { k: 1 };
/**
 * Per frame: how much of a low sun's glow the view looks into. `dir` is the camera's forward direction, `sun` the sun
 * direction (both unit, world space), `overcast` 0..1, `visible` 0..1 whether the disc itself is in view (SunProbe).
 * Strongest with the sun in or just outside the frame and within ~25 degrees of the horizon; nothing under an
 * overcast, with the sun behind the land or the trees, or once the afterglow has faded.
 */
export function updateViewExposure(dir: THREE.Vector3, sun: THREE.Vector3, overcast: number, dt: number, visible = 1) {
  const { smoothstep: ss } = THREE.MathUtils;
  const into = ss(dir.dot(sun), 0.707, 0.978) * (1 - ss(sun.y, 0.1, 0.42)) * ss(sun.y, -0.1, -0.02) * (1 - ss(overcast, 0.2, 0.7)) * visible;
  const target = 1 - 0.65 * into;
  view.k += (target - view.k) * (1 - Math.exp(-Math.min(dt, 0.1) * 3));
  grade.sunComp.value = view.k;
  // the bloom is taken before this compensation (Engine): its threshold sees the glow round the sun at full exposure,
  // so it is turned down with it (else a halo the size of the glow swallows the disc)
  grade.bloomStrength.value = BLOOM * (0.3 + 0.7 * view.k);
}

const { smoothstep: ss3, lerp } = THREE.MathUtils;
/**
 * Per frame: the finishing grade for the light. A clear midday: a harder, more saturated high key (white sand and surf
 * against deep shade); overcast and rain: colour held under the grey veil (wet greens dark olive, not grey); night:
 * night vision, desaturated toward blue-grey, with a navy toe so moonlit rock and forest read as dark blue shapes
 * instead of crushing to black. `night`, `overcast` 0..1, `sunY` the sun direction's height.
 */
export function updateGradeLook(night: number, overcast: number, sunY: number) {
  const noon = ss3(sunY, 0.3, 0.75) * (1 - overcast);
  const rain = ss3(overcast, 0.3, 0.9) * (1 - night);
  let sat = lerp(1.06, 1.12, noon), con = lerp(1.06, 1.1, noon);
  sat = lerp(sat, 1.18, rain);
  con = lerp(con, 1.08, rain);
  sat = lerp(sat, 0.6, night);
  con = lerp(con, 1.0, night);
  grade.saturation.value = sat;
  grade.contrast.value = con;
  (grade.lift.value as THREE.Vector3).set(0.012, 0.017, 0.03).multiplyScalar(night);
}

/** exposed scene-linear HDR (exposure and bloom applied) -> tone mapping -> display-space grade -> vec4 in 0..1 */
export function toneAndGrade(exposed: N): N {
  const tm = ({ aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping } as Record<string, THREE.ToneMapping>)[params.toneMap] ?? THREE.ACESFilmicToneMapping;
  const display = renderOutput(vec4(exposed.mul(grade.sunComp), 1), tm, THREE.SRGBColorSpace);
  const lum = dot(display.rgb, vec3(0.2126, 0.7152, 0.0722));
  let c = mix(vec3(lum), display.rgb, grade.saturation);
  c = c.sub(0.5).mul(grade.contrast).add(0.5);
  c = c.mul(grade.gain).add(grade.lift.mul(float(1).sub(c)));
  const v = length(screenUV.sub(0.5).mul(vec3(1.0, 0.75, 0).xy));
  c = c.mul(mix(float(1), float(1).sub(grade.vignette), smoothstep(0.3, 0.85, v)));
  return vec4(c.clamp(0, 1), 1);
}
