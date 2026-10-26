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
    // eye adaptation: faster toward darker than toward brighter, as eyes do (and short enough to follow clouds); with
    // the clock sped up (a time-lapse) it keeps pace with the clock, as a camera's auto exposure does, instead of
    // lagging hours behind (a white-out after sunrise)
    const speed = this.frozen ? 1 : Math.max(1, 30 / Math.max(0.05, this.dayMinutes));
    const k = (this.exposureTarget > this.exposure ? 0.6 : 1.4) * Math.min(speed, 40);
    this.exposure += (this.exposureTarget - this.exposure) * (1 - Math.exp(-dt * k));
  }

  private compute() {
    const H = ((this.hour - 12) / 24) * Math.PI * 2;
    celestial(H, DECL, this.sun);
    // a moon just past full: it rises in the east around sunset, so at dusk it is just clear of the sea off the spawn
    // beach and lays its path on the water, lights the whole night (no black hours before moonrise) and sets in the
    // dawn twilight
    celestial(H + Math.PI + 0.1, MOON_DECL, this.moon);
    this.sunElevation = Math.asin(this.sun.y);
    this.night = THREE.MathUtils.smoothstep(-this.sun.y, -0.02, 0.16);
    atmo.sunDir.value.copy(this.sun);
    atmo.moonDir.value.copy(this.moon);
    atmo.night.value = this.night;
    atmo.overcast.value = this.overcast;

    // the air. Midday: a clean trade-wind haze. At sunrise the night has settled the aerosol into a shallow layer: the
    // air above is clean (a golden sun with a small glow, a pastel sky) and the haze is a ground mist over the sea and
    // the flats; toward sunset a day of sea spray, convection and cooking smoke leaves more, finer aerosol that
    // reddens the low sun, widens its glow and lays an orange band along the horizon. Rain fills the air with grey
    // droplets.
    const { smoothstep, lerp } = THREE.MathUtils;
    const low = 1 - smoothstep(this.sunElevation, 0.04, 0.42);
    // afternoon air from midday until the night has settled it, morning air from about midnight until midday
    const pm = smoothstep(this.hour, 11, 13) * (1 - smoothstep(this.hour, 21, 23.9));
    const cover = Math.min(1, this.overcast / 0.9);
    let mie = lerp(2.0e-5, lerp(2.5e-5, 4.5e-5, pm), low);
    let ang = lerp(1.0, lerp(0.8, 1.35, pm), low);
    mie = lerp(mie, 3.5e-5, cover);
    ang = lerp(ang, 0.3, cover);
    atmo.mieScatter.value = mie;
    (atmo.mieTint.value as THREE.Vector3).set(Math.pow(680 / 550, -ang), 1, Math.pow(440 / 550, -ang));
    const dawn = smoothstep(this.hour, 4.6, 5.8) * (1 - smoothstep(this.hour, 6.9, 8.2));
    atmo.dawnMist.value = 7e-4 * dawn * (1 - cover);

    // the key light: the sun by day, the moon by night
    const sunUp = this.sun.y > -0.035;
    const dir = sunUp ? this.sun : this.moon;
    this.light.position.copy(dir).multiplyScalar(1000);
    this.light.target.position.set(0, 0, 0);
    // a thick overcast leaves almost no direct sun (no shadows in the rain), a thin one only dims it
    const shade = Math.pow(1 - this.overcast, 1.7);
    const cl = clouds.lightColor.value as THREE.Color;
    if (sunUp) {
      sunTransmittanceCPU(this.sunElevation, atmo.mieScatter.value as number, this.sunColor);
      const lum = Math.max(1e-6, this.sunColor.r * 0.2126 + this.sunColor.g * 0.7152 + this.sunColor.b * 0.0722);
      this.light.color.setRGB(this.sunColor.r / lum, this.sunColor.g / lum, this.sunColor.b / lum);
      // (fading out as the disc goes under the horizon, so the hand-over to the moon below is continuous)
      this.light.intensity = SUN_E * lum * shade * THREE.MathUtils.smoothstep(this.sun.y, -0.035, 0.03);
      // the clouds see the sun (reddened at a low sun) unshadowed by themselves
      (clouds.lightDir.value as THREE.Vector3).copy(this.sun);
      cl.copy(this.sunColor).multiplyScalar(SUN_E * 0.5);
    } else {
      const m = Math.max(0, this.moon.y);
      this.light.color.setRGB(0.62, 0.74, 1.0);
      // (fading in through the twilight: the key light hands over from the sun at a moon already up, and a moonlight
      // switched on at full strength would flip every shadow in one frame)
      const moonE = 0.058 * THREE.MathUtils.smoothstep(m, -0.02, 0.22) * THREE.MathUtils.smoothstep(-this.sun.y, 0.035, 0.14);
      this.light.intensity = moonE * (1 - this.overcast * 0.9);
      (clouds.lightDir.value as THREE.Vector3).copy(this.moon);
      // moonlit cumulus read dim and grey-blue to the night-adapted eye, not as the white daytime clouds a long
      // exposure shows (at the moon's full light they outshone the sand)
      cl.setRGB(0.72, 0.8, 0.95).multiplyScalar(moonE * 0.18);
    }
    // exposure: from the illuminance of a horizontal surface (sun + sky), toward a mid-grey key. With the sun low the
    // meter takes the light on surfaces that face it (walls, trunks, cliffs: ten times what a horizontal one gets),
    // as a photographer keys a golden-hour scene on its lit faces: the shade stays dark and the light stays warm and
    // rich, instead of the whole frame opening up into a flat bright late afternoon
    const sunH = sunUp ? this.light.intensity * Math.max(0.35 * THREE.MathUtils.smoothstep(this.sunElevation, -0.01, 0.12), this.sun.y) : this.light.intensity * Math.max(0, this.moon.y);
    // (the sky term carries on below the horizon and fades through the civil twilight: switched on with the sun's
    // disc it made the meter jump at sunrise, a dip and then a surge of light)
    const skyF = this.sun.y > 0 ? Math.sin(this.sunElevation) + 0.06 : 0.06 * Math.pow(THREE.MathUtils.smoothstep(this.sun.y, -0.105, 0), 1.5);
    const sky = SUN_E * 0.14 * skyF * (1 - this.overcast * 0.45);
    const twilight = SUN_E * 0.004 * THREE.MathUtils.smoothstep(this.sun.y, -0.2, 0.02);
    const E = sunH + sky + twilight + 0.0006;
    atmo.lightE.value = E;
    // luminance of a mid-grey (18 %) surface, adapted only partly (exponent 0.66): noon is keyed bright (white sand
    // and surf near clipping), sunsets stay rich, and a moonlit night stays a night (about twenty times darker on
    // screen than noon) with silhouettes readable against the sky
    const L = (E * 0.18) / Math.PI;
    // under a storm overcast the eye does not fully open up: rain stays moody instead of a bright flat day (the grey
    // dome and the deck light the ground about twice as much as the meter's sky term assumes, so the cut is larger
    // than it looks: without it the wet forest and the haze wash out to pale grey)
    // (a moonless night opens up further than a moonlit one: starlight and the sky glow keep the sand faintly grey and
    // the palms in silhouette instead of a black screen between moonset and dawn)
    const moonUp = THREE.MathUtils.smoothstep(this.moon.y, -0.02, 0.15);
    // (under the moon the cap holds the white sand to a dim blue-grey, below the sky's glow, not snow under a lamp)
    const maxExp = THREE.MathUtils.lerp(30, 11, moonUp);
    this.exposureTarget = THREE.MathUtils.clamp(0.42 / Math.pow(L, 0.66), 0.15, maxExp) * (1 - 0.35 * this.overcast);
    void clouds;
  }
}
