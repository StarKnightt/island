/**
 * Weather: fair trade-wind days broken by passing squalls. A state machine (clear -> gathering -> rain -> clearing)
 * drives every weather input smoothly: cloud cover and thickness, an overcast flattening of the light, wind,
 * haze, sea state, surface wetness (soaks in during rain, dries afterwards), rain streaks and splashes around the
 * camera, ripples on the water, and lightning with thunder in heavy rain.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, float, fract, hash, instanceIndex, length, mix, smoothstep, texture, uniform, uv, vec2, vec3, vec4, cameraPosition,
  max, positionView, abs, sin, type N,
} from '../core/tsl';
import { clouds } from './Sky';
import { atmo } from './Atmosphere';
import { wetness } from '../world/weatherUniforms';
import { oceanU } from '../water/Ocean';
import { Rng } from '../core/noise';
import { Q } from '../core/quality';
import type { Heightfield } from '../world/Heightfield';
import { HALF_WORLD, WORLD_SIZE } from '../world/layout';

export type WeatherKind = 'clear' | 'gathering' | 'rain' | 'clearing';

const rainU = {
  intensity: uniform(0),
  time: uniform(0),
  wind: uniform(new THREE.Vector2(0, 0)),
  flash: uniform(0),
};

export class Weather {
  kind: WeatherKind = 'clear';
  /** 0..1 progress through the current phase */
  private t = 0;
  private dur = 300;
  /** smoothed outputs */
  rain = 0;
  cover = 0;
  wet = 0;
  wind = 0.3;
  auto = true;
  private rng = new Rng(4711);
  readonly group = new THREE.Group();
  /** lightning: next strike time, current flash */
  private nextStrike = 0;
  flash = 0;
  onThunder: ((delay: number, strength: number) => void) | null = null;
  private time = 0;

  constructor(private hf: Heightfield) {
    this.group.name = 'weather';
    this.dur = this.durationFor('clear');
    this.buildRain();
    this.buildSplashes();
  }

  private durationFor(k: WeatherKind) {
    const r = this.rng;
    return k === 'clear' ? r.range(240, 520) : k === 'gathering' ? r.range(55, 85) : k === 'rain' ? r.range(140, 260) : r.range(60, 95);
  }

  /** force a state; immediate jumps straight to it (for captures) */
  set(w: 'clear' | 'rain' | 'auto', immediate = true) {
    if (w === 'auto') {
      this.auto = true;
      return this.state();
    }
    this.auto = false;
    this.kind = w === 'rain' ? 'rain' : 'clear';
    this.t = 0;
    this.dur = 1e9;
    if (immediate) {
      const target = this.targets();
      this.cover = target.cover;
      this.rain = target.rain;
      this.wet = w === 'rain' ? 1 : 0;
      this.wind = target.wind;
    }
    this.apply();
    return this.state();
  }

  state() {
    return { kind: this.kind, auto: this.auto, progress: +this.t.toFixed(3), rain: +this.rain.toFixed(3), cover: +this.cover.toFixed(3), wet: +this.wet.toFixed(3), wind: +this.wind.toFixed(3) };
  }

  private targets() {
    const p = this.t;
    switch (this.kind) {
      case 'clear': return { cover: 0, rain: 0, wind: 0.3 };
      case 'gathering': return { cover: THREE.MathUtils.smoothstep(p, 0, 1), rain: THREE.MathUtils.smoothstep(p, 0.75, 1) * 0.3, wind: 0.3 + 0.5 * p };
      case 'rain': return { cover: 1, rain: 0.65 + 0.35 * Math.sin(p * Math.PI) , wind: 0.8 };
      case 'clearing': return { cover: 1 - THREE.MathUtils.smoothstep(p, 0.1, 1), rain: (1 - THREE.MathUtils.smoothstep(p, 0, 0.4)) * 0.6, wind: 0.8 - 0.5 * p };
    }
  }

  update(dt: number) {
    this.time += dt;
    if (this.auto) {
      this.t += dt / this.dur;
      if (this.t >= 1) {
        this.t = 0;
        this.kind = this.kind === 'clear' ? 'gathering' : this.kind === 'gathering' ? 'rain' : this.kind === 'rain' ? 'clearing' : 'clear';
        this.dur = this.durationFor(this.kind);
      }
    }
    const tg = this.targets();
    const k = 1 - Math.exp(-dt * 0.5);
    this.cover += (tg.cover - this.cover) * k;
    this.rain += (tg.rain - this.rain) * (1 - Math.exp(-dt * 0.8));
    this.wind += (tg.wind - this.wind) * k;
    // surfaces soak quickly in rain and dry over a few minutes
    if (this.rain > 0.05) this.wet = Math.min(1, this.wet + dt * this.rain * 0.08);
    else this.wet = Math.max(0, this.wet - dt / 240);
    // lightning in heavy rain
    if (this.rain > 0.7 && this.time > this.nextStrike) {
      this.nextStrike = this.time + this.rng.range(9, 26);
      this.flash = 1;
      this.onThunder?.(this.rng.range(0.8, 4.5), this.rng.range(0.5, 1));
    }
    this.flash = Math.max(0, this.flash - dt * (this.flash > 0.6 ? 6 : 2.2));
    this.apply();
    rainU.time.value = this.time;
  }

  private apply() {
    const c = this.cover;
    clouds.coverage.value = THREE.MathUtils.lerp(0.42, 0.98, c);
    clouds.thickness.value = THREE.MathUtils.lerp(0.2, 1.0, c);
    atmo.overcast.value = THREE.MathUtils.smoothstep(c, 0.3, 1.0) * 0.95;
    atmo.mieScatter.value = THREE.MathUtils.lerp(6.5e-6, 1.6e-5, c);
    atmo.mist.value = this.rain * 7e-4;
    wetness.rain.value = this.wet;
    wetness.intensity.value = this.rain;
    wetness.wind.value = this.wind;
    oceanU.rain.value = this.rain;
    oceanU.storm.value = THREE.MathUtils.smoothstep(this.wind, 0.4, 0.9);
    rainU.intensity.value = this.rain;
    this.group.visible = this.rain > 0.004;
    rainU.flash.value = this.flash;
    const wd = wetness.windDir.value as THREE.Vector2;
    rainU.wind.value.set(wd.x * this.wind * 3.5, wd.y * this.wind * 3.5);
  }

  /** rain streaks: velocity-stretched quads in a box that follows the camera */
  private buildRain() {
    const count = Q.rainParticles;
    const m = new THREE.SpriteNodeMaterial();
    m.transparent = true;
    m.depthWrite = false;
    m.blending = THREE.NormalBlending;
    const id = float(instanceIndex);
    const box = vec3(36, 22, 36);
    const seed = vec3(hash(id.mul(1.31)), hash(id.mul(7.77)), hash(id.mul(3.19)));
    const speed = float(9.5).add(seed.x.mul(2.5));
    const fall = rainU.time.mul(speed);
    // positions wrap inside a camera-centred box
    const base = seed.mul(box);
    const p = vec3(
      fract(base.x.add(rainU.wind.x.mul(rainU.time)).sub(cameraPosition.x).div(box.x)).sub(0.5).mul(box.x).add(cameraPosition.x),
      fract(base.y.sub(fall).sub(cameraPosition.y).div(box.y)).sub(0.5).mul(box.y).add(cameraPosition.y),
      fract(base.z.add(rainU.wind.y.mul(rainU.time)).sub(cameraPosition.z).div(box.z)).sub(0.5).mul(box.z).add(cameraPosition.z),
    );
    m.positionNode = p;
    const dist = length(p.sub(cameraPosition));
    m.scaleNode = vec2(0.012, float(0.55).add(seed.y.mul(0.3)));
    const fade = smoothstep(0.6, 2.5, dist).mul(smoothstep(18, 10, dist));
    const keep = smoothstep(seed.z.sub(0.02), seed.z, rainU.intensity);
    const a = fade.mul(keep).mul(0.3).mul(smoothstep(0.0, 0.15, rainU.intensity));
    m.colorNode = vec4(vec3(0.75, 0.78, 0.82).mul(float(1).add(rainU.flash.mul(3))), a);
    m.opacityNode = a.mul(smoothstep(0.5, 0.2, abs(uv().x.sub(0.5))));
    const sprite = new THREE.Sprite(m);
    (sprite as unknown as { count: number }).count = count;
    sprite.frustumCulled = false;
    sprite.renderOrder = 30;
    sprite.name = 'rain';
    this.group.add(sprite);
    void positionView; void max; void sin; void mix;
  }

  /** splashes: brief bright rings on the ground or the sea near the camera */
  private buildSplashes() {
    const count = Math.round(Q.rainParticles * 0.25);
    const m = new THREE.SpriteNodeMaterial();
    m.transparent = true;
    m.depthWrite = false;
    const id = float(instanceIndex);
    const life = fract(rainU.time.mul(2.3).add(hash(id.mul(5.3))));
    const cycle = rainU.time.mul(2.3).add(hash(id.mul(5.3))).floor();
    const rx = hash(id.mul(11.1).add(cycle.mul(0.37))).sub(0.5).mul(26);
    const rz = hash(id.mul(17.3).add(cycle.mul(0.91))).sub(0.5).mul(26);
    const xz = vec2(cameraPosition.x.add(rx), cameraPosition.z.add(rz));
    const hTex = this.hf.heightTex;
    const ground = texture(hTex, xz.add(HALF_WORLD).div(WORLD_SIZE)).level(0).r;
    const y = max(ground, float(0.05));
    m.positionNode = vec3(xz.x, y.add(0.03), xz.y);
    const s = life.mul(0.18).add(0.02);
    m.scaleNode = vec2(s, s.mul(0.45));
    const ring = smoothstep(0.5, 0.35, length(uv().sub(0.5))).mul(smoothstep(0.15, 0.32, length(uv().sub(0.5))));
    const a = ring.mul(float(1).sub(life)).mul(rainU.intensity).mul(0.5).mul(smoothstep(hash(id.mul(2.2)).sub(0.05), hash(id.mul(2.2)), rainU.intensity));
    m.colorNode = vec4(vec3(0.85, 0.88, 0.9), a);
    m.opacityNode = a;
    const sprite = new THREE.Sprite(m);
    (sprite as unknown as { count: number }).count = count;
    sprite.frustumCulled = false;
    sprite.renderOrder = 31;
    sprite.name = 'splashes';
    this.group.add(sprite);
  }

  get flashU() {
    return rainU.flash;
  }
}

export { rainU, Fn, type N };
