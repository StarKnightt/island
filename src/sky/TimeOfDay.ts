/**
 * Time of day: a tropical sun path (latitude 16 S), the moon roughly opposite, the light that follows them, and the
 * exposure that adapts to the light level. A full day lasts `dayMinutes` (30 by default).
 */
import * as THREE from 'three/webgpu';
import { SUN_E, atmo, sunTransmittanceCPU } from './Atmosphere';
import { clouds } from './Sky';

const LAT = (-16 * Math.PI) / 180;
const DECL = (14 * Math.PI) / 180;
const MOON_DECL = (-6 * Math.PI) / 180;

/** direction (x east, y up, z south) for a hour angle and declination */
function celestial(hourAngle: number, decl: number, out: THREE.Vector3) {
  const sinEl = Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(hourAngle);
  const el = Math.asin(THREE.MathUtils.clamp(sinEl, -1, 1));
  // azimuth from north, clockwise
  const az = Math.atan2(-Math.sin(hourAngle) * Math.cos(decl), Math.cos(LAT) * Math.sin(decl) - Math.sin(LAT) * Math.cos(decl) * Math.cos(hourAngle));
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

export class TimeOfDay {
  hour = 6.15;
  dayMinutes = 30;
  frozen = false;
  readonly sun = new THREE.Vector3();
  readonly moon = new THREE.Vector3();
  readonly light: THREE.DirectionalLight;
  /** 0 day .. 1 night */
  night = 0;
  sunElevation = 0;
  /** exposure the camera adapts toward, and the current value */
  exposureTarget = 1;
  exposure = 1;
  /** weather inputs: 0..1 */
  overcast = 0;
  private sunColor = new THREE.Color();

  constructor(light: THREE.DirectionalLight) {
    this.light = light;
  }

  setHour(h: number) {
    this.hour = ((h % 24) + 24) % 24;
    this.compute();
    this.exposure = this.exposureTarget;
  }

  update(dt: number) {
    if (!this.frozen) this.hour = (this.hour + (dt / (this.dayMinutes * 60)) * 24) % 24;
    this.compute();
    // eye adaptation: faster toward darker than toward brighter, as eyes do (and short enough to follow clouds)
    const k = this.exposureTarget > this.exposure ? 0.6 : 1.4;
    this.exposure += (this.exposureTarget - this.exposure) * (1 - Math.exp(-dt * k));
  }

  private compute() {
    const H = ((this.hour - 12) / 24) * Math.PI * 2;
    celestial(H, DECL, this.sun);
    celestial(H + Math.PI * 1.03, MOON_DECL, this.moon);
    this.sunElevation = Math.asin(this.sun.y);
    this.night = THREE.MathUtils.smoothstep(-this.sun.y, -0.02, 0.16);
    atmo.sunDir.value.copy(this.sun);
    atmo.moonDir.value.copy(this.moon);
    atmo.night.value = this.night;
    atmo.overcast.value = this.overcast;

    // the key light: the sun by day, the moon by night
    const sunUp = this.sun.y > -0.035;
    const dir = sunUp ? this.sun : this.moon;
    this.light.position.copy(dir).multiplyScalar(1000);
    this.light.target.position.set(0, 0, 0);
    // a thick overcast leaves almost no direct sun (no shadows in the rain), a thin one only dims it
    const shade = Math.pow(1 - this.overcast, 1.7);
    if (sunUp) {
      sunTransmittanceCPU(this.sunElevation, atmo.mieScatter.value as number, this.sunColor);
      const lum = Math.max(1e-6, this.sunColor.r * 0.2126 + this.sunColor.g * 0.7152 + this.sunColor.b * 0.0722);
      this.light.color.setRGB(this.sunColor.r / lum, this.sunColor.g / lum, this.sunColor.b / lum);
      this.light.intensity = SUN_E * lum * shade;
    } else {
      const m = Math.max(0, this.moon.y);
      this.light.color.setRGB(0.62, 0.74, 1.0);
      this.light.intensity = 0.045 * THREE.MathUtils.smoothstep(m, 0.0, 0.25) * (1 - this.overcast * 0.9);
    }
    // exposure: from the illuminance of a horizontal surface (sun + sky), toward a mid-grey key
    const sunH = sunUp ? this.light.intensity * Math.max(0.03, this.sun.y) : this.light.intensity * Math.max(0, this.moon.y);
    const sky = sunUp ? SUN_E * 0.14 * Math.max(0.02, Math.sin(Math.max(this.sunElevation, 0) + 0.06)) * (1 - this.overcast * 0.45) : 0;
    const twilight = SUN_E * 0.004 * THREE.MathUtils.smoothstep(this.sun.y, -0.2, 0.02);
    const E = sunH + sky + twilight + 0.0006;
    atmo.lightE.value = E;
    // luminance of a mid-grey (18 %) surface, adapted with an exponent < 1 so sunsets and nights keep their mood
    const L = (E * 0.18) / Math.PI;
    // under a storm overcast the eye does not fully open up: rain stays moody instead of a bright flat day
    this.exposureTarget = THREE.MathUtils.clamp(0.22 / Math.pow(L, 0.75), 0.15, 14) * (1 - 0.32 * this.overcast);
    void clouds;
  }
}
