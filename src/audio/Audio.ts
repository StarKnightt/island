/**
 * Sound: looping ambience layers mixed every frame from where the listener is and what the world is doing (waves by
 * distance to the shore, wind by altitude and exposure, birds by day and frogs and insects by night, rain, the
 * waterfall, the river, village sounds), positional sources for the falls and the village, and one-shots (footsteps
 * by surface, splashes, swimming strokes, thunder). Files stream in after the island is playable.
 */
import * as THREE from 'three/webgpu';
import type { Heightfield } from '../world/Heightfield';
import type { Surface, StepEvent } from '../player/Player';
import { VILLAGE } from '../world/layout';

const BASE = './assets/audio/';

interface Layer { name: string; files: string[]; gain: GainNode; src: AudioBufferSourceNode | null; target: number; level: number; panner?: PannerNode; pos?: THREE.Vector3; max: number }

const STEP_FILES: Record<Surface, string[]> = {
  sand: ['step_sand_1', 'step_sand_2', 'step_sand_3', 'step_sand_4'],
  wet_sand: ['step_sand_1', 'step_sand_2', 'step_sand_3', 'step_sand_4'],
  grass: ['step_grass_1', 'step_grass_2', 'step_grass_3', 'step_grass_4'],
  leaves: ['step_leaves_1', 'step_leaves_2', 'step_leaves_3', 'step_leaves_4'],
  dirt: ['step_gravel_1', 'step_gravel_2', 'step_gravel_3', 'step_gravel_4'],
  rock: ['step_stone_1', 'step_stone_2', 'step_stone_3', 'step_stone_4'],
  stone: ['step_stone_1', 'step_stone_2', 'step_stone_3', 'step_stone_4'],
  wood: ['step_wood_1', 'step_wood_2', 'step_wood_3', 'step_wood_4'],
  metal: ['step_metal_1', 'step_metal_2', 'step_metal_3', 'step_metal_4'],
  shallow_water: ['step_water_1', 'step_water_2', 'step_water_3', 'step_water_4'],
  water: ['swim_1', 'swim_2', 'swim_3'],
};

export class AudioSystem {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private bus!: GainNode;
  private layers: Layer[] = [];
  private buffers = new Map<string, AudioBuffer>();
  private loading = new Set<string>();
  muted = false;
  lastSurface: Surface | null = null;
  lastStepAt = 0;
  private steps = 0;
  private started = false;
  readonly fallsPos = new THREE.Vector3();

  constructor(private hf: Heightfield) {}

  /** create the context (needs a user gesture outside tests) and start streaming the files */
  start() {
    if (this.started) return;
    this.started = true;
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    this.bus = this.ctx.createGain();
    this.bus.connect(comp).connect(this.master).connect(this.ctx.destination);
    const L = (name: string, files: string[], max: number, pos?: THREE.Vector3) => {
      const gain = this.ctx!.createGain();
      gain.gain.value = 0;
      let panner: PannerNode | undefined;
      if (pos) {
        panner = this.ctx!.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 12;
        panner.rolloffFactor = 1.1;
        panner.positionX.value = pos.x;
        panner.positionY.value = pos.y;
        panner.positionZ.value = pos.z;
        gain.connect(panner).connect(this.bus);
      } else gain.connect(this.bus);
      this.layers.push({ name, files, gain, src: null, target: 0, level: 0, panner, pos, max });
    };
    L('waves', ['amb_waves'], 0.9);
    L('surf', ['amb_surf'], 0.45);
    L('wind', ['amb_wind'], 0.55);
    L('birds', ['amb_birds'], 0.5);
    L('jungle', ['amb_jungle'], 0.45);
    L('night', ['amb_night'], 0.55);
    L('rain', ['amb_rain'], 0.7);
    L('rain_heavy', ['amb_rain_heavy'], 0.6);
    L('waterfall', ['amb_waterfall'], 1.0, this.fallsPos.clone());
    L('stream', ['amb_stream'], 0.45);
    L('village', ['amb_chimes'], 0.35, new THREE.Vector3(VILLAGE.center[0], 4, VILLAGE.center[1] + 20));
    L('chickens', ['amb_chickens'], 0.25, new THREE.Vector3(VILLAGE.center[0] - 20, 4, VILLAGE.center[1] - 10));
    L('creak', ['amb_creak'], 0.35, new THREE.Vector3(-452, 1.5, 370));
    L('gulls', ['amb_gulls'], 0.3);
    // stream every layer, then the one-shots
    for (const l of this.layers) this.load(l.files[0]).then((b) => b && this.loop(l, b));
    for (const list of Object.values(STEP_FILES)) for (const f of list) this.load(f);
    for (const f of ['splash_big', 'splash_small', 'thunder_1', 'thunder_2', 'thunder_3', 'land_sand']) this.load(f);
  }

  private async load(name: string): Promise<AudioBuffer | null> {
    if (this.buffers.has(name)) return this.buffers.get(name)!;
    if (this.loading.has(name) || !this.ctx) return null;
    this.loading.add(name);
    try {
      const r = await fetch(`${BASE}${name}.ogg`);
      if (!r.ok) return null;
      const b = await this.ctx.decodeAudioData(await r.arrayBuffer());
      this.buffers.set(name, b);
      return b;
    } catch {
      return null;
    } finally {
      this.loading.delete(name);
    }
  }

  private loop(l: Layer, b: AudioBuffer) {
    if (!this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = b;
    src.loop = true;
    src.connect(l.gain);
    // random start offset so layers do not phase
    src.start(0, Math.random() * b.duration);
    l.src = src;
  }

  mute(m: boolean) {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }

  /** per frame: listener pose and the mix */
  update(dt: number, camera: THREE.Camera, w: { night: number; rain: number; wind: number; underwater: boolean }) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const p = camera.position;
    const lis = ctx.listener;
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    const t = ctx.currentTime;
    if (lis.positionX) {
      lis.positionX.setTargetAtTime(p.x, t, 0.05);
      lis.positionY.setTargetAtTime(p.y, t, 0.05);
      lis.positionZ.setTargetAtTime(p.z, t, 0.05);
      lis.forwardX.setTargetAtTime(fwd.x, t, 0.05);
      lis.forwardY.setTargetAtTime(fwd.y, t, 0.05);
      lis.forwardZ.setTargetAtTime(fwd.z, t, 0.05);
      lis.upX.value = 0;
      lis.upY.value = 1;
      lis.upZ.value = 0;
    }
    const hf = this.hf;
    const shore = hf.shoreDist(p.x, p.z);
    const forest = hf.forest(p.x, p.z);
    const day = 1 - w.night;
    const nearSea = THREE.MathUtils.clamp(1 - Math.abs(shore) / 90, 0, 1);
    const coast = THREE.MathUtils.clamp(1 - Math.max(0, shore) / 420, 0, 1);
    const river = hf.nearestRiver(p.x, p.z);
    const dFalls = p.distanceTo(this.fallsPos);
    const dVillage = Math.hypot(p.x - VILLAGE.center[0], p.z - VILLAGE.center[1]);
    const height = p.y;
    const set = (name: string, v: number) => {
      const l = this.layers.find((x) => x.name === name);
      if (l) l.target = THREE.MathUtils.clamp(v, 0, 1) * l.max;
    };
    set('waves', nearSea * nearSea * (1 - forest * 0.5) * (1 + w.wind * 0.3));
    set('surf', coast * 0.7 + 0.15 * THREE.MathUtils.smoothstep(height, 40, 200));
    set('wind', 0.25 + 0.5 * THREE.MathUtils.smoothstep(height, 10, 180) + 0.45 * w.wind - forest * 0.25);
    set('birds', day * (0.35 + 0.65 * forest) * (1 - w.rain * 0.8) * (1 - THREE.MathUtils.smoothstep(height, 150, 230) * 0.7));
    set('jungle', day * forest * (1 - w.rain * 0.6));
    set('night', w.night * (0.4 + 0.6 * Math.max(forest, hf.grass(p.x, p.z))) * (1 - w.rain * 0.5));
    set('rain', THREE.MathUtils.smoothstep(w.rain, 0.02, 0.5));
    set('rain_heavy', THREE.MathUtils.smoothstep(w.rain, 0.5, 1.0));
    set('waterfall', THREE.MathUtils.clamp(1 - dFalls / 260, 0, 1) ** 0.6);
    set('stream', THREE.MathUtils.clamp(1 - river.d / 45, 0, 1) * (dFalls > 40 ? 1 : 0.4));
    set('village', THREE.MathUtils.clamp(1 - dVillage / 160, 0, 1) * (0.5 + w.wind * 0.5));
    set('chickens', day * THREE.MathUtils.clamp(1 - dVillage / 120, 0, 1) * (1 - w.rain));
    set('creak', THREE.MathUtils.clamp(1 - dVillage / 140, 0, 1));
    set('gulls', day * nearSea * (1 - w.rain) * 0.8 + day * THREE.MathUtils.clamp(1 - dVillage / 200, 0, 1) * 0.5);
    const k = 1 - Math.exp(-dt * 2.5);
    for (const l of this.layers) {
      l.level += (l.target - l.level) * k;
      l.gain.gain.setTargetAtTime(this.muted ? 0 : l.level * (w.underwater ? 0.25 : 1), t, 0.08);
    }
  }

  private play(name: string, gain: number, rate = 1, delay = 0, pos?: THREE.Vector3, lowpass?: number) {
    const ctx = this.ctx;
    const b = this.buffers.get(name);
    if (!ctx || !b || this.muted) return;
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    let node: AudioNode = src;
    if (lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lowpass;
      node.connect(f);
      node = f;
    }
    node.connect(g);
    if (pos) {
      const pn = ctx.createPanner();
      pn.panningModel = 'equalpower';
      pn.refDistance = 2;
      pn.positionX.value = pos.x;
      pn.positionY.value = pos.y;
      pn.positionZ.value = pos.z;
      g.connect(pn).connect(this.bus);
    } else g.connect(this.bus);
    src.start(ctx.currentTime + delay);
  }

  step(e: StepEvent) {
    this.lastSurface = e.surface;
    this.lastStepAt = performance.now();
    this.steps++;
    const list = STEP_FILES[e.surface] ?? STEP_FILES.sand;
    const name = list[Math.floor(Math.random() * list.length)];
    const loud = THREE.MathUtils.clamp(0.35 + e.speed * 0.09, 0.3, 0.95);
    this.play(name, loud * (e.surface === 'wet_sand' ? 1.1 : 1), 0.92 + Math.random() * 0.16, 0, e.pos.clone().setY(e.pos.y + 0.1));
    if (e.surface === 'wood' && Math.random() < 0.15) this.play(list[0], 0.2, 0.6);
  }

  splash(strength: number, pos: THREE.Vector3) {
    this.play(strength > 0.6 ? 'splash_big' : 'splash_small', 0.5 + strength * 0.5, 0.9 + Math.random() * 0.2, 0, pos);
  }

  swimStroke(pos: THREE.Vector3) {
    const list = STEP_FILES.water;
    this.play(list[Math.floor(Math.random() * list.length)], 0.35, 0.9 + Math.random() * 0.2, 0, pos);
  }

  thunder(delay: number, strength: number) {
    const n = `thunder_${1 + Math.floor(Math.random() * 3)}`;
    this.play(n, 0.6 + strength * 0.4, 0.85 + Math.random() * 0.2, delay, undefined, 900 + strength * 2500);
  }

  state() {
    return {
      running: this.ctx?.state ?? 'none',
      muted: this.muted,
      layers: Object.fromEntries(this.layers.map((l) => [l.name, { gain: +l.level.toFixed(3), loaded: !!l.src }])),
      footstepSurface: this.lastSurface,
      steps: this.steps,
      buffers: this.buffers.size,
    };
  }
}
