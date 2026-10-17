/**
 * The player: a Rocketbox avatar (MIT) animated with retargeted Quaternius clips (CC0), driven by a kinematic
 * controller over the heightfield and the walkable surfaces. Walk / run / sprint share one stride phase so their
 * blends never cross feet; jumps go start -> fall -> land; deep water switches to treading and swimming.
 */
import * as THREE from 'three/webgpu';
import type { Intent } from './Input';
import type { Heightfield } from '../world/Heightfield';
import type { Colliders } from '../world/Colliders';
import { loadGLTF } from '../core/Assets';
import { SPOTS } from '../world/layout';
import { uniform, float, mix, vec4, texture, uv } from '../core/tsl';

export type Surface = 'sand' | 'wet_sand' | 'grass' | 'dirt' | 'rock' | 'wood' | 'stone' | 'metal' | 'shallow_water' | 'water' | 'leaves';
export interface StepEvent { surface: Surface; speed: number; foot: 0 | 1; pos: THREE.Vector3 }

const WALK = 1.55, RUN = 4.1, SPRINT = 6.6, SWIM = 1.35, SWIM_FAST = 2.1;
const GRAVITY = 16;
const JUMP_V = 5.4;
const MAX_SLOPE = Math.cos((40 * Math.PI) / 180);
/** depth of water (surface - ground) at which wading turns into swimming */
const SWIM_DEPTH = 1.32;
/** feet below the surface while swimming */
const SWIM_SINK = 1.18;

export const playerU = { wet: uniform(0) };

interface Clip { action: THREE.AnimationAction; duration: number }

export class Player {
  readonly root = new THREE.Group();
  private model!: THREE.Object3D;
  private mixer!: THREE.AnimationMixer;
  private clips: Record<string, Clip> = {};
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  heading = 0;
  private turnRate = 0;
  state: 'ground' | 'air' | 'swim' = 'ground';
  speed = 0;
  private phase = 0;
  private airTime = 0;
  private landT = 0;
  private jumpT = -1;
  private lastFootPhase = 0;
  surface: Surface = 'sand';
  waterDepth = 0;
  waterLevel = -Infinity;
  onStep: ((e: StepEvent) => void) | null = null;
  onSplash: ((strength: number, pos: THREE.Vector3) => void) | null = null;
  /** sea-surface sampler (waves), set by main */
  seaAt: ((x: number, z: number) => number) | null = null;
  private ready = false;
  private weights: Record<string, number> = {};
  private wetness = 0;

  constructor(private hf: Heightfield, private col: Colliders) {
    this.root.name = 'player';
  }

  async load() {
    const g = await loadGLTF('assets/character/hero.glb');
    this.model = g.scene;
    this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      const src = m.material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[];
      const mats = Array.isArray(src) ? src : [src];
      const out = mats.map((mm) => {
        const nm = new THREE.MeshStandardNodeMaterial();
        nm.name = mm.name;
        nm.normalMap = mm.normalMap;
        const isHair = /opacity/i.test(mm.name);
        const isHead = /head/i.test(mm.name);
        const r = isHair ? 0.55 : isHead ? 0.5 : 0.8;
        nm.metalness = 0;
        if (mm.map) {
          const tex = texture(mm.map, uv());
          // wet: darker and glossier (after swimming, in the rain)
          nm.colorNode = vec4(tex.rgb.mul(mix(float(1), float(isHead ? 0.85 : 0.62), playerU.wet)), tex.a);
          if (isHair) nm.opacityNode = tex.a;
        }
        nm.roughnessNode = mix(float(r), float(Math.min(r, 0.28)), playerU.wet);
        if (isHair) {
          nm.alphaTest = 0.4;
          nm.transparent = false;
          nm.side = THREE.DoubleSide;
        }
        return nm;
      });
      m.material = Array.isArray(src) ? out : out[0];
    });
    this.root.add(this.model);
    this.mixer = new THREE.AnimationMixer(this.model);
    for (const clip of g.animations) {
      const a = this.mixer.clipAction(clip);
      a.play();
      a.setEffectiveWeight(0);
      a.timeScale = 0;
      this.clips[clip.name] = { action: a, duration: clip.duration };
    }
    this.ready = true;
  }

  place(x: number, z: number, heading: number) {
    const g = this.groundAt(x, z, 1e9);
    this.pos.set(x, g.y, z);
    this.vel.set(0, 0, 0);
    this.heading = heading;
    this.state = 'ground';
    this.updateWater();
    if (this.waterDepth > SWIM_DEPTH) {
      this.state = 'swim';
      this.pos.y = this.waterLevel - SWIM_SINK;
    }
    this.syncRoot();
  }

  toSpot(name: string) {
    const s = SPOTS.find((p) => p.name === name);
    if (!s) return null;
    this.place(s.player[0], s.player[1], s.yaw);
    return { name, pos: this.pos.toArray() };
  }

  /** walkable height under (x, z): terrain or a surface no higher than a step above the feet */
  groundAt(x: number, z: number, maxY: number) {
    const t = this.hf.height(x, z);
    const s = this.col.surfaceAt(x, z, maxY);
    if (s && s.y >= t - 0.05) return { y: s.y, surf: s.material as Surface, onSurface: true };
    return { y: t, surf: null as Surface | null, onSurface: false };
  }

  private updateWater() {
    const lvl = this.hf.waterLevel(this.pos.x, this.pos.z);
    const sea = lvl === 0 && this.seaAt ? this.seaAt(this.pos.x, this.pos.z) : 0;
    this.waterLevel = lvl + sea;
    const g = this.groundAt(this.pos.x, this.pos.z, this.pos.y + 0.5);
    this.waterDepth = this.waterLevel - g.y;
  }

  private surfaceUnderfoot(onSurf: Surface | null): Surface {
    if (onSurf) return onSurf;
    const { x, z } = this.pos;
    if (this.waterDepth > 0.06) return 'shallow_water';
    const hf = this.hf;
    const rock = Math.max(hf.rock(x, z), 1 - hf.normal(x, z).y > 0.45 ? 1 : 0);
    const sand = hf.sand(x, z), grass = hf.grass(x, z), dirt = hf.dirt(x, z), forest = hf.forest(x, z);
    const best = Math.max(rock, sand, grass, dirt, forest);
    if (best === rock && rock > 0.4) return 'rock';
    if (best === sand) return this.pos.y < 0.9 ? 'wet_sand' : 'sand';
    if (best === dirt) return 'dirt';
    if (best === forest && forest > 0.5) return 'leaves';
    return 'grass';
  }

  update(dt: number, intent: Intent, camYaw: number) {
    if (!this.ready) return;
    const fwdX = Math.sin(camYaw), fwdZ = -Math.cos(camYaw);
    const rightX = Math.cos(camYaw), rightZ = Math.sin(camYaw);
    let wx = fwdX * intent.moveY + rightX * intent.moveX;
    let wz = fwdZ * intent.moveY + rightZ * intent.moveX;
    const mag = Math.min(1, Math.hypot(wx, wz));
    if (mag > 1e-3) {
      wx /= Math.hypot(wx, wz);
      wz /= Math.hypot(wx, wz) || 1;
    }
    const swim = this.state === 'swim';
    let top = swim ? (intent.sprint ? SWIM_FAST : SWIM) : intent.sprint ? SPRINT : intent.walk ? WALK : RUN;
    if (!swim && mag < 0.55 && !intent.sprint) top = THREE.MathUtils.lerp(WALK, RUN, Math.max(0, mag - 0.2) / 0.35);
    // wading slows you down
    if (!swim && this.waterDepth > 0.25) top *= THREE.MathUtils.lerp(1, 0.55, Math.min(1, (this.waterDepth - 0.25) / 0.9));
    const want = mag * top;
    // velocity in the plane: accelerate toward the wish, brake harder than you speed up
    const vx = this.vel.x, vz = this.vel.z;
    const tvx = wx * want, tvz = wz * want;
    const accel = this.state === 'air' ? 2.5 : swim ? 2.2 : want > Math.hypot(vx, vz) ? 9 : 13;
    const k = 1 - Math.exp(-accel * dt);
    this.vel.x += (tvx - vx) * k;
    this.vel.z += (tvz - vz) * k;
    const planar = Math.hypot(this.vel.x, this.vel.z);
    // heading: turn toward the direction of travel, faster when slow
    if (planar > 0.15 || mag > 0.1) {
      const target = Math.atan2(mag > 0.1 ? wx : this.vel.x, mag > 0.1 ? -wz : -this.vel.z);
      let d = target - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const rate = swim ? 3 : THREE.MathUtils.lerp(12, 7, Math.min(1, planar / SPRINT));
      const step = THREE.MathUtils.clamp(d, -rate * dt, rate * dt);
      this.turnRate = step / Math.max(dt, 1e-4);
      this.heading += step;
    } else this.turnRate *= 0.8;

    // ---- integrate
    const next = new THREE.Vector3(this.pos.x + this.vel.x * dt, this.pos.y, this.pos.z + this.vel.z * dt);
    // slope limit: block moves up ground steeper than ~40 degrees
    if (this.state === 'ground') {
      const n = this.hf.normal(next.x, next.z);
      const gNext = this.groundAt(next.x, next.z, this.pos.y + 0.45);
      const rise = gNext.y - this.pos.y;
      if (!gNext.onSurface && n.y < MAX_SLOPE && rise > 0.02) {
        // remove the uphill component of the motion
        const ux = -n.x, uz = -n.z, ul = Math.hypot(ux, uz) || 1;
        const along = (this.vel.x * -ux + this.vel.z * -uz) / ul;
        if (along < 0) {
          this.vel.x -= (-ux / ul) * along;
          this.vel.z -= (-uz / ul) * along;
        }
        next.set(this.pos.x + this.vel.x * dt, this.pos.y, this.pos.z + this.vel.z * dt);
      }
      // steps higher than 0.5 m block (walls of platforms)
      if (gNext.y - this.pos.y > 0.5) next.set(this.pos.x, this.pos.y, this.pos.z);
    }
    this.col.resolve(next, 0.32);
    this.pos.x = next.x;
    this.pos.z = next.z;

    // ---- vertical
    this.updateWater();
    const g = this.groundAt(this.pos.x, this.pos.z, this.pos.y + 0.5);
    if (this.state === 'swim') {
      const target = this.waterLevel - SWIM_SINK;
      this.pos.y += (target - this.pos.y) * (1 - Math.exp(-dt * 4));
      this.vel.y = 0;
      if (this.waterDepth < SWIM_DEPTH - 0.18) {
        this.state = 'ground';
        this.pos.y = Math.max(this.pos.y, g.y);
      }
      if (intent.jump) this.vel.y = 0;
    } else if (this.state === 'ground') {
      if (intent.jump && this.waterDepth < 0.7) {
        this.state = 'air';
        this.vel.y = JUMP_V;
        this.airTime = 0;
        this.jumpT = 0;
      } else if (g.y < this.pos.y - 0.55) {
        this.state = 'air';
        this.vel.y = 0;
        this.airTime = 0;
        this.jumpT = -1;
      } else {
        // follow the ground smoothly (up steps quickly, down slopes exactly)
        const dy = g.y - this.pos.y;
        this.pos.y += dy > 0 ? dy * (1 - Math.exp(-dt * 30)) : dy;
        this.vel.y = 0;
      }
      if (this.waterDepth > SWIM_DEPTH) this.state = 'swim';
    } else {
      this.airTime += dt;
      this.vel.y -= GRAVITY * dt;
      this.pos.y += this.vel.y * dt;
      if (this.jumpT >= 0) this.jumpT += dt;
      if (this.waterLevel > -Infinity && this.pos.y < this.waterLevel - SWIM_SINK && this.waterDepth > SWIM_DEPTH) {
        this.state = 'swim';
        this.onSplash?.(Math.min(1, Math.abs(this.vel.y) / 8 + 0.3), this.pos);
        this.vel.y = 0;
      } else if (this.pos.y <= g.y) {
        this.pos.y = g.y;
        const impact = -this.vel.y;
        this.vel.y = 0;
        this.state = 'ground';
        this.landT = impact > 3.5 ? 0.0001 : -1;
        this.onStep?.({ surface: this.surfaceUnderfoot(g.surf), speed: Math.max(3, impact), foot: 0, pos: this.pos });
      }
    }
    this.surface = this.surfaceUnderfoot(g.surf);
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    // wet after swimming, slowly drying
    const inWater = this.state === 'swim' ? 1 : this.waterDepth > 0.3 ? 0.6 : 0;
    this.wetness = inWater > this.wetness ? THREE.MathUtils.lerp(this.wetness, inWater, 1 - Math.exp(-dt * 3)) : Math.max(0, this.wetness - dt / 90);
    playerU.wet.value = Math.max(this.wetness, this.rainWet);
    this.animate(dt);
    this.syncRoot();
  }
  rainWet = 0;

  private syncRoot() {
    this.root.position.copy(this.pos);
    // the model faces +z: rotate it onto the heading (yaw 0 = north / -z)
    this.root.rotation.set(0, Math.PI - this.heading, 0);
  }

  private setW(name: string, w: number) {
    this.weights[name] = (this.weights[name] ?? 0) + w;
  }

  private animate(dt: number) {
    for (const k of Object.keys(this.weights)) this.weights[k] = 0;
    const c = this.clips;
    const sp = this.speed;
    if (this.state === 'swim') {
      const m = THREE.MathUtils.smoothstep(sp, 0.2, 1.0);
      this.setW('tread', 1 - m);
      this.setW('swim', m);
      this.phase += dt / (c.swim?.duration ?? 1.33) * Math.max(0.6, sp / SWIM);
      // a stroke splash twice a cycle while swimming forward
      const fp = this.phase % 1;
      if (sp > 0.3 && ((this.lastFootPhase < 0.25 && fp >= 0.25) || (this.lastFootPhase < 0.75 && fp >= 0.75))) this.onStep?.({ surface: 'water', speed: sp, foot: 0, pos: this.pos });
      this.lastFootPhase = fp;
    } else if (this.state === 'air') {
      if (this.jumpT >= 0 && this.jumpT < 0.32) this.setW('jump_start', 1);
      else this.setW('fall', 1);
    } else {
      // locomotion blend: idle -> walk -> jog -> sprint, one shared stride phase
      const wIdle = 1 - THREE.MathUtils.smoothstep(sp, 0.05, 0.6);
      const loco = 1 - wIdle;
      const a = THREE.MathUtils.clamp((sp - WALK) / (RUN - WALK), 0, 1);
      const b = THREE.MathUtils.clamp((sp - RUN) / (SPRINT - RUN), 0, 1);
      this.setW('idle', wIdle);
      this.setW('walk', loco * (1 - a));
      this.setW('jog', loco * a * (1 - b));
      this.setW('sprint', loco * a * b);
      // stride frequency: interpolate the cycle rate of the blended clips at their reference speeds
      const fWalk = 1 / (c.walk?.duration ?? 1.33), fJog = 1 / (c.jog?.duration ?? 0.93), fSprint = 1 / (c.sprint?.duration ?? 0.67);
      const freq = sp < RUN ? THREE.MathUtils.lerp(fWalk * Math.max(0.55, sp / WALK), fJog * (sp / RUN), a) : THREE.MathUtils.lerp(fJog * (sp / RUN), fSprint * (sp / SPRINT), b);
      this.phase += dt * Math.max(freq, 0.2) * (sp > 0.05 ? 1 : 0);
      // landing: a short dip
      if (this.landT >= 0) {
        this.landT += dt;
        const lw = 1 - THREE.MathUtils.smoothstep(this.landT, 0.18, 0.45);
        for (const k of Object.keys(this.weights)) this.weights[k] *= 1 - lw * 0.85;
        this.setW('land', lw * 0.85);
        if (this.landT > 0.45) this.landT = -1;
      }
      // footsteps: two per cycle
      const fp = this.phase % 1;
      if (sp > 0.4) {
        const crossed = (t: number) => (this.lastFootPhase < t && fp >= t) || (this.lastFootPhase > fp && (t >= this.lastFootPhase || t < fp));
        if (crossed(0.02)) this.onStep?.({ surface: this.surface, speed: sp, foot: 0, pos: this.pos });
        if (crossed(0.52)) this.onStep?.({ surface: this.surface, speed: sp, foot: 1, pos: this.pos });
      }
      this.lastFootPhase = fp;
    }
    // smooth the weights (cross-fades), drive clip times
    const kW = 1 - Math.exp(-dt * 10);
    for (const [name, clip] of Object.entries(c)) {
      const target = this.weights[name] ?? 0;
      const cur = clip.action.getEffectiveWeight();
      const w = cur + (target - cur) * kW;
      clip.action.setEffectiveWeight(w < 0.002 ? 0 : w);
      clip.action.enabled = w >= 0.002;
      let t: number;
      if (name === 'walk' || name === 'jog' || name === 'sprint' || name === 'swim') t = (this.phase % 1) * clip.duration;
      else if (name === 'jump_start') t = Math.min(clip.duration * 0.95, 0.42 + Math.max(0, this.jumpT) * 1.1);
      else if (name === 'land') t = Math.min(clip.duration * 0.9, 0.12 + Math.max(0, this.landT) * 1.4);
      else t = (clip.action.time + dt) % clip.duration;
      clip.action.time = t;
    }
    this.mixer.update(0);
  }

  /** scripted actions for the harness: walk, run, sprint, jump, swim, idle */
  act(input: { scripted: { t: number; intent: Partial<Intent> } | null }, action: string, seconds: number, yaw: number | undefined, camYaw: number) {
    const rel = yaw !== undefined ? yaw - camYaw : 0;
    const mx = Math.sin(rel), my = Math.cos(rel);
    const intents: Record<string, Partial<Intent>> = {
      idle: { moveX: 0, moveY: 0 },
      walk: { moveX: mx, moveY: my, walk: true },
      run: { moveX: mx, moveY: my },
      sprint: { moveX: mx, moveY: my, sprint: true },
      jump: { moveX: mx * 0.8, moveY: my * 0.8, jump: true },
      swim: { moveX: mx, moveY: my },
    };
    const it = intents[action];
    if (!it) return null;
    input.scripted = { t: seconds, intent: it };
    if (action === 'jump') setTimeout(() => { if (input.scripted) input.scripted.intent = { ...input.scripted.intent, jump: false }; }, 60);
    return { action, seconds };
  }

  state_() {
    return {
      pos: this.pos.toArray().map((v) => +v.toFixed(2)), heading: +this.heading.toFixed(3), state: this.state,
      speed: +this.speed.toFixed(2), surface: this.surface, waterDepth: +this.waterDepth.toFixed(2),
      weights: Object.fromEntries(Object.entries(this.clips).map(([k, c]) => [k, +c.action.getEffectiveWeight().toFixed(2)]).filter(([, w]) => (w as number) > 0)),
    };
  }
}
