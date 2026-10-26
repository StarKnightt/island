/**
 * Weather: fair trade-wind days broken by passing squalls. A state machine (clear -> gathering -> rain -> clearing)
 * drives every weather input smoothly: cloud cover and thickness, an overcast flattening of the light, wind,
 * haze, sea state, surface wetness (soaks in during rain, dries afterwards), rain streaks and splashes around the
 * camera, ripples on the water, and lightning with thunder in heavy rain.
 */
import { effectMRT } from '../core/fx';
import * as THREE from 'three/webgpu';
import {
  Fn, float, fract, hash, instanceIndex, length, smoothstep, texture, uniform, uv, vec2, vec3, vec4, cameraPosition,
  cameraViewMatrix, max, abs, atan, dot, normalize, varying, type N,
} from '../core/tsl';
import { clouds } from './Sky';
import { atmo, skyRadiance } from './Atmosphere';
import { initTerrainShadow } from './TerrainShadow';
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
  /** frames left in which the rain is drawn even when dry, so its pipelines compile up front */
  prime = 0;
  /** 0..1 progress through the current phase */
  private t = 0;
  private dur = 300;
  /** smoothed outputs */
  rain = 0;
  cover = 0;
  wet = 0;
  wind = 0.3;
  auto = true;
  /** how fast the weather runs (time-lapses); 1 = real time */
  speed = 1;
  /** a scripted squall (time-lapses): fixed phase lengths instead of random ones */
  private scripted = false;
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
    // the island's shadow at a low light is baked from the same heightfield (the sky re-bakes it as the light moves)
    initTerrainShadow(hf.heightTex, hf.mask0Tex);
  }

  private durationFor(k: WeatherKind) {
    if (this.scripted) return k === 'clear' ? 1e9 : k === 'gathering' ? 70 : k === 'rain' ? 150 : 80;
    const r = this.rng;
    return k === 'clear' ? r.range(240, 520) : k === 'gathering' ? r.range(55, 85) : k === 'rain' ? r.range(140, 260) : r.range(60, 95);
  }

  /**
   * One squall from a clear sky, `speed` times faster than life (for a time-lapse): the cloud gathers (70 s), rains
   * (150 s), clears (80 s), and stays clear. speed 0 ends it and returns to real time.
   */
  squall(speed: number) {
    if (speed <= 0) {
      this.scripted = false;
      this.speed = 1;
      return this.state();
    }
    this.set('clear', true);
    this.auto = true;
    this.scripted = true;
    this.speed = speed;
    this.kind = 'gathering';
    this.t = 0;
    this.dur = this.durationFor('gathering');
    return this.state();
  }

  /** force a state; immediate jumps straight to it (for captures) */
  set(w: 'clear' | 'rain' | 'auto', immediate = true) {
    this.scripted = false;
    this.speed = 1;
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
      // rain cells pass: heavier bursts and lulls (a few in a squall), the deck a little lighter between them
      case 'rain': {
        const cell = 0.5 + 0.5 * Math.sin(p * 29 + 1.3) * Math.sin(p * 11.7 + 0.4);
        return { cover: 0.93 + 0.07 * cell, rain: 0.42 + 0.28 * Math.sin(p * Math.PI) + 0.3 * cell, wind: 0.72 + 0.16 * cell };
      }
      case 'clearing': return { cover: 1 - THREE.MathUtils.smoothstep(p, 0.1, 1), rain: (1 - THREE.MathUtils.smoothstep(p, 0, 0.4)) * 0.6, wind: 0.8 - 0.5 * p };
    }
  }

  update(dtReal: number) {
    const dt = dtReal * this.speed;
    this.time += dtReal;
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
    this.flash = Math.max(0, this.flash - dtReal * (this.flash > 0.6 ? 6 : 2.2));
    this.apply();
    rainU.time.value = this.time;
  }

  private apply() {
    const c = this.cover;
    clouds.coverage.value = THREE.MathUtils.lerp(0.42, 0.98, c);
    clouds.thickness.value = THREE.MathUtils.lerp(0.2, 1.0, c);
    atmo.overcast.value = THREE.MathUtils.smoothstep(c, 0.3, 1.0) * 0.95;
    // (the aerosol, rain droplets included, is set by TimeOfDay from the hour and the cover)
    // a tropical downpour: visibility down to about two kilometres, every layer of distance paler
    atmo.mist.value = this.rain * 1.9e-3;
    clouds.rain.value = this.rain;
    wetness.rain.value = this.wet;
    wetness.intensity.value = this.rain;
    wetness.wind.value = this.wind;
    oceanU.rain.value = this.rain;
    oceanU.storm.value = THREE.MathUtils.smoothstep(this.wind, 0.4, 0.9);
    rainU.intensity.value = this.rain;
    // drawn in the first frames even when dry (prime), so the rain's pipelines compile behind the loading screen
    this.group.visible = this.rain > 0.004 || this.prime > 0;
    if (this.prime > 0) this.prime--;
    rainU.flash.value = this.flash;
    const wd = wetness.windDir.value as THREE.Vector2;
    // a squall's wind drives the rain at 30-40 degrees
    rainU.wind.value.set(wd.x * this.wind * 8, wd.y * this.wind * 8);
  }

  /**
   * Rain: drops falling with the wind in a box that follows the camera, each drawn as the streak a camera sees in a
   * 1/50 s exposure: along its own motion on screen (slanted downwind, short when it falls toward the lens), about a
   * pixel and a half wide at any distance, a little darker than the overcast sky behind it, so streaks show against
   * dark trees and rock and vanish against the bright sky.
   */
  private buildRain() {
    const count = Q.rainParticles;
    const m = new THREE.SpriteNodeMaterial();
    m.transparent = true;
    m.mrtNode = effectMRT();
    m.depthWrite = false;
    m.blending = THREE.NormalBlending;
    const id = float(instanceIndex);
    const box = vec3(40, 24, 40);
    const seed = vec3(hash(id.mul(1.31)), hash(id.mul(7.77)), hash(id.mul(3.19)));
    const speed = float(8).add(seed.x.mul(3.5));
    // gusts: each drop rides its own share of the wind plus a little turbulence, so the streaks are not ruled lines
    const g1 = hash(id.mul(2.17)), g2 = hash(id.mul(5.03)), g3 = hash(id.mul(9.41));
    const share = g1.mul(0.7).add(0.65);
    const vel = vec3(rainU.wind.x.mul(share).add(g2.sub(0.5).mul(3)), speed.negate(), rainU.wind.y.mul(share).add(g3.sub(0.5).mul(3)));
    const t = rainU.time;
    // positions wrap inside a camera-centred box
    const base = seed.mul(box);
    const p = vec3(
      fract(base.x.add(vel.x.mul(t)).sub(cameraPosition.x).div(box.x)).sub(0.5).mul(box.x).add(cameraPosition.x),
      fract(base.y.add(vel.y.mul(t)).sub(cameraPosition.y).div(box.y)).sub(0.5).mul(box.y).add(cameraPosition.y),
      fract(base.z.add(vel.z.mul(t)).sub(cameraPosition.z).div(box.z)).sub(0.5).mul(box.z).add(cameraPosition.z),
    );
    m.positionNode = p;
    const vv = cameraViewMatrix.mul(vec4(vel, 0)).xy;
    const dist = length(p.sub(cameraPosition));
    m.rotationNode = atan(vv.x.negate(), vv.y);
    m.scaleNode = vec2(max(float(0.005), dist.mul(0.0015)), length(vv).mul(g2.mul(0.6).add(0.7).mul(1 / 50)).max(0.03));
    const fade = smoothstep(0.7, 2.5, dist).mul(smoothstep(21, 12, dist));
    const keep = smoothstep(seed.z.sub(0.02), seed.z, rainU.intensity);
    const a = fade.mul(keep).mul(g3.mul(0.5).add(0.6)).mul(0.34).mul(smoothstep(0.0, 0.15, rainU.intensity));
    // a drop is a little lens showing the sky above and the darker ground below: a little darker than the rain deck
    // behind it (about 0.4 of the clear sky's luminance 15 degrees up), so it vanishes against the sky and shows
    // against trees and rock
    const v = normalize(p.sub(cameraPosition));
    const lumRef = varying(dot(skyRadiance(normalize(vec3(v.x, 0.27, v.z))), vec3(0.2126, 0.7152, 0.0722)));
    const lit = lumRef.mul(0.3).mul(float(1).add(rainU.flash.mul(3)));
    m.colorNode = vec4(vec3(0.92, 0.95, 1.0).mul(lit), a);
    const across = abs(uv().x.sub(0.5)), along = uv().y;
    m.opacityNode = a.mul(smoothstep(0.5, 0.1, across)).mul(smoothstep(0.0, 0.25, along)).mul(smoothstep(1.0, 0.7, along));
    const sprite = new THREE.Sprite(m);
    (sprite as unknown as { count: number }).count = count;
    sprite.frustumCulled = false;
    sprite.renderOrder = 30;
    sprite.name = 'rain';
    this.group.add(sprite);
  }

  /** splashes: brief bright rings on the ground or the sea near the camera */
  private buildSplashes() {
    const count = Math.round(Q.rainParticles * 0.25);
    const m = new THREE.SpriteNodeMaterial();
    m.transparent = true;
    m.mrtNode = effectMRT();
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
    m.colorNode = vec4(vec3(0.9, 0.92, 0.95).mul(float(atmo.lightE).mul(1 / Math.PI)), a);
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
