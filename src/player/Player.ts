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
import { uniform, float, vec4, uv, pow, clamp } from '../core/tsl';
import { heroU, hairMaterial, prepareHairGeometry, skinMaterial, smoothSeams } from './heroMaterials';
import { Footprints, printU } from './Footprints';
import { PoseLayer } from './PoseLayer';
import { atmo } from '../sky/Atmosphere';

export type Surface = 'sand' | 'wet_sand' | 'grass' | 'dirt' | 'rock' | 'wood' | 'stone' | 'metal' | 'shallow_water' | 'water' | 'leaves';
export interface StepEvent { surface: Surface; speed: number; foot: 0 | 1; pos: THREE.Vector3 }

const WALK = 1.35, RUN = 4.1, SPRINT = 6.6, SWIM = 1.35, SWIM_FAST = 2.1;
/** distance covered by one cycle (two steps) of each locomotion clip, from its root-motion speed (hero.clips.json) */
const STRIDE = { walk: 0.952 * 1.333, jog: 5.229 * 0.933, sprint: 8.053 * 0.667 };
const GRAVITY = 16;
const JUMP_V = 5.4;
const MAX_SLOPE = Math.cos((40 * Math.PI) / 180);
/** depth of water (surface - ground) at which wading turns into swimming */
const SWIM_DEPTH = 1.32;
/** feet below the surface while swimming */
const SWIM_SINK = 1.18;

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
  /** direction of travel (yaw), body bank into turns, jump crouch timer (-1 = none) */
  private moveA = 0;
  private bank = 0;
  private crouchT = -1;
  private contact!: ContactShadows;
  /** footprints in sand (world-space decals under `shadows`), the clock they age by, the foot bones */
  private prints = new Footprints();
  private clock = 0;
  private feet: { foot: THREE.Object3D; toe: THREE.Object3D; side: number }[] = [];
  private wasMoving = false;
  /** procedural layer: idle life (arms, breath, weight shift, blinks) and feet on the ground */
  private pose: PoseLayer | null = null;
  private plant = 1;

  constructor(private hf: Heightfield, private col: Colliders) {
    this.root.name = 'player';
    this.shadows.add(this.prints.mesh);
  }

  async load() {
    const g = await loadGLTF('assets/character/hero.glb');
    this.model = g.scene;
    const parts: Record<'body' | 'head' | 'hair', THREE.Mesh | null> = { body: null, head: null, hair: null };
    this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      const name = (m.material as THREE.Material).name;
      parts[/opacity/i.test(name) ? 'hair' : /head/i.test(name) ? 'head' : 'body'] = m;
    });
    const { body, head, hair } = parts;
    // the KTX2 files flag every map sRGB: normal maps decoded as sRGB tilt every normal ~40 degrees, by a frame that
    // jumps from triangle to triangle (no tangents: the frame comes from screen derivatives), so faces looked faceted
    for (const m of [body, head]) {
      const nm = (m?.material as THREE.MeshStandardMaterial | undefined)?.normalMap;
      if (nm) {
        nm.colorSpace = THREE.NoColorSpace;
        nm.needsUpdate = true;
      }
    }
    if (head) smoothSeams(head.geometry, body?.geometry ?? null);
    if (hair && head) prepareHairGeometry(hair.geometry, head.geometry);
    for (const [part, m] of [['body', body], ['head', head]] as const) {
      if (!m) continue;
      const src = m.material as THREE.MeshStandardMaterial;
      if (src.map) m.material = skinMaterial(src.map, src.normalMap, part);
    }
    if (hair) {
      const src = hair.material as THREE.MeshStandardMaterial;
      if (src.map) hair.material = hairMaterial(src.map);
      // the hair's shadow on the scalp and neck: one-sided cut-out, a little behind its own surface
      hair.castShadow = true;
    }
    this.root.add(this.model);
    this.contact = new ContactShadows(this.model);
    this.shadows.add(this.contact.group);
    const bone = (n: string) => {
      let hit: THREE.Object3D | null = null;
      this.model.traverse((o) => { if (!hit && o.name.replace(/[ _]/g, '') === n) hit = o; });
      return hit as THREE.Object3D | null;
    };
    for (const [s, side] of [['L', -1], ['R', 1]] as const) {
      const foot = bone(`Bip01${s}Foot`), toe = bone(`Bip01${s}Toe0`);
      if (foot && toe) this.feet.push({ foot, toe, side });
    }
    this.pose = new PoseLayer(this.model, this.root);
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

  /** stand on the highest walkable surface at (x, z), or the highest one not above `y` */
  place(x: number, z: number, heading: number, y = 1e9) {
    const g = this.groundAt(x, z, y + 0.3);
    this.pos.set(x, g.y, z);
    this.vel.set(0, 0, 0);
    this.heading = heading;
    this.moveA = heading;
    this.bank = 0;
    this.crouchT = -1;
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
    this.place(s.player[0], s.player[1], s.yaw, s.player[2] ?? 1e9);
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
    const refYaw = intent.worldYaw ?? camYaw;
    const fwdX = Math.sin(refYaw), fwdZ = -Math.cos(refYaw);
    const rightX = Math.cos(refYaw), rightZ = Math.sin(refYaw);
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
    // the direction of travel turns toward the wish at a limited rate (a run curves through a turn instead of
    // snapping round), the speed eases toward the wish (braking harder than accelerating)
    const planar0 = Math.hypot(this.vel.x, this.vel.z);
    const air = this.state === 'air';
    const turnK = swim ? 2.2 : THREE.MathUtils.lerp(8.5, 4.6, Math.min(1, planar0 / SPRINT));
    if (mag > 1e-3) {
      const wishA = Math.atan2(wx, -wz);
      if (planar0 < 0.35 && !air) this.moveA = wishA;
      else {
        const d = Math.atan2(Math.sin(wishA - this.moveA), Math.cos(wishA - this.moveA));
        // a reversal (more than ~150 degrees) slows down through the turn instead of pivoting at speed
        const lim = (air ? 1.2 : turnK * 1.25) * dt;
        this.moveA += THREE.MathUtils.clamp(d, -lim, lim);
      }
    }
    const reverse = mag > 1e-3 ? Math.abs(Math.atan2(Math.sin(Math.atan2(wx, -wz) - this.moveA), Math.cos(Math.atan2(wx, -wz) - this.moveA))) : 0;
    const wantNow = want * (reverse > 1.6 ? 0.25 : 1);
    const accel = air ? 1.5 : swim ? 2.2 : wantNow > planar0 ? 6.5 : 11;
    const sp = planar0 + (wantNow - planar0) * (1 - Math.exp(-accel * dt));
    this.vel.x = Math.sin(this.moveA) * sp;
    this.vel.z = -Math.cos(this.moveA) * sp;
    const planar = sp;
    // the body follows the direction of travel a little behind it, and banks into the turn
    if (planar > 0.12 || mag > 0.1) {
      let d = this.moveA - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const step = THREE.MathUtils.clamp(d, -turnK * dt, turnK * dt);
      this.turnRate = step / Math.max(dt, 1e-4);
      this.heading += step;
    } else this.turnRate *= 0.8;
    const bankWant = THREE.MathUtils.clamp(this.turnRate * planar * 0.022, -0.2, 0.2) * (swim || air ? 0.3 : 1);
    this.bank += (bankWant - this.bank) * (1 - Math.exp(-dt * 6));

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
      // steps higher than 0.5 m block (walls of platforms), but the walker slides along them: keep whichever
      // single-axis part of the move stays walkable
      if (gNext.y - this.pos.y > 0.5) {
        const mx = this.vel.x * dt, mz = this.vel.z * dt;
        const okX = this.groundAt(this.pos.x + mx, this.pos.z, this.pos.y + 0.45).y - this.pos.y <= 0.5;
        const okZ = this.groundAt(this.pos.x, this.pos.z + mz, this.pos.y + 0.45).y - this.pos.y <= 0.5;
        if (okX && (!okZ || Math.abs(mx) >= Math.abs(mz))) next.set(this.pos.x + mx, this.pos.y, this.pos.z);
        else if (okZ) next.set(this.pos.x, this.pos.y, this.pos.z + mz);
        else next.set(this.pos.x, this.pos.y, this.pos.z);
      }
    }
    const wantX = next.x - this.pos.x, wantZ = next.z - this.pos.z;
    const pre = next.clone();
    if (this.col.resolve(next, 0.32) && this.col.hitRound) {
      // walking square into a trunk or a post: the push-out cancels the move and the walker would stand there
      // pressing on it; side-step round it instead, to the side the move already leans to
      const px = next.x - pre.x, pz = next.z - pre.z, pl = Math.hypot(px, pz), wl = Math.hypot(wantX, wantZ);
      if (pl > 1e-5 && wl > 1e-5 && (wantX * px + wantZ * pz) / (pl * wl) < -0.85) {
        const tx = -pz / pl, tz = px / pl;
        const side = wantX * tx + wantZ * tz >= 0 ? 1 : -1;
        next.x += tx * side * wl * 0.7;
        next.z += tz * side * wl * 0.7;
        this.col.resolve(next, 0.32);
      }
    }
    this.pos.x = next.x;
    this.pos.z = next.z;

    // ---- vertical
    this.updateWater();
    const g = this.groundAt(this.pos.x, this.pos.z, this.pos.y + 0.5);
    if (this.state === 'swim') {
      // buoyancy: the treading body stands with head and shoulders out; the swimming body lies along the surface
      // (its pose carries the trunk ~0.9 m above the root), its back awash and its head up, bobbing with the stroke
      const sw = this.clips.swim?.action.getEffectiveWeight() ?? 0;
      const bob = Math.sin(this.phase * Math.PI * 2) * 0.035 * sw;
      const target = this.waterLevel - THREE.MathUtils.lerp(SWIM_SINK + 0.06, 0.94, sw) + bob;
      this.pos.y += (target - this.pos.y) * (1 - Math.exp(-dt * 4));
      this.vel.y = 0;
      if (this.waterDepth < SWIM_DEPTH - 0.18) {
        this.state = 'ground';
        this.pos.y = Math.max(this.pos.y, g.y);
      }
      if (intent.jump) this.vel.y = 0;
    } else if (this.state === 'ground') {
      // a jump crouches first (a few frames of anticipation), then leaves the ground
      if (intent.jump && this.waterDepth < 0.7 && this.crouchT < 0) this.crouchT = 0;
      if (this.crouchT >= 0) {
        this.crouchT += dt;
        const dur = this.speed > 3 ? 0.07 : 0.13;
        if (this.crouchT >= dur) {
          this.crouchT = -1;
          this.state = 'air';
          this.vel.y = JUMP_V;
          this.airTime = 0;
          this.jumpT = 0;
        }
      }
      if (this.state === 'air') {
        // took off this frame
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
        this.step({ surface: this.surfaceUnderfoot(g.surf), speed: Math.max(3, impact), foot: 0, pos: this.pos }, true);
      }
    }
    this.surface = this.surfaceUnderfoot(g.surf);
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    // wet after swimming, slowly drying
    const inWater = this.state === 'swim' ? 1 : this.waterDepth > 0.3 ? 0.6 : 0;
    this.wetness = inWater > this.wetness ? THREE.MathUtils.lerp(this.wetness, inWater, 1 - Math.exp(-dt * 3)) : Math.max(0, this.wetness - dt / 90);
    heroU.wet.value = Math.max(this.wetness, this.rainWet);
    heroU.frame.value = (heroU.frame.value + 1) % 64;
    // by night the side away from the moon sees only a near-black sky: a little moonlit-sky fill keeps the shirt and
    // the hair readable (a fraction of the moonlight on open ground)
    const night = atmo.night.value as number, lightE = atmo.lightE.value as number;
    (heroU.fill.value as THREE.Color).setRGB(0.55, 0.66, 1.0).multiplyScalar(lightE * 0.3 * night);
    this.clock += dt;
    printU.time.value = this.clock;
    // coming to a stop leaves both feet's prints
    if (this.state === 'ground' && this.speed > 0.6) this.wasMoving = true;
    else if (this.wasMoving && this.state === 'ground' && this.speed < 0.1) {
      this.wasMoving = false;
      this.stampPrints(this.surface, 0.5, true);
    }
    this.animate(dt);
    this.syncRoot();
    if (this.pose) {
      // the feet follow the ground while standing and walking, not in the air or the water
      const plantWant = this.state === 'ground' && this.waterDepth < 0.6 && this.crouchT < 0 ? 1 : 0;
      this.plant += (plantWant - this.plant) * (1 - Math.exp(-dt * (plantWant > this.plant ? 10 : 25)));
      this.pose.update({
        dt,
        idle: this.state === 'ground' ? this.clips.idle?.action.getEffectiveWeight() ?? 0 : 0,
        plant: this.plant,
        rootY: this.pos.y,
        ground: (x, z, y) => {
          const g = this.groundAt(x, z, y);
          return { y: g.y, n: g.onSurface ? UP : this.hf.normal(x, z) };
        },
      });
    }
    this.updateContact();
  }
  rainWet = 0;

  /** a footfall: a print in sand under the planted foot (under both on landing), then the sound */
  private step(e: StepEvent, both = false) {
    this.stampPrints(e.surface, e.speed, both);
    this.onStep?.(e);
  }

  private lastPrint = [new THREE.Vector3(1e9, 0, 0), new THREE.Vector3(1e9, 0, 0)];
  private stampPrints(surface: Surface, speed: number, both: boolean) {
    if ((surface !== 'sand' && surface !== 'wet_sand') || this.waterDepth > 0.03 || this.feet.length < 2) return;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    const low = (f: { foot: THREE.Object3D; toe: THREE.Object3D }) => f.foot.getWorldPosition(a).y + f.toe.getWorldPosition(b).y;
    // the planted foot is the lower one
    const feet = both ? this.feet : [low(this.feet[0]) <= low(this.feet[1]) ? this.feet[0] : this.feet[1]];
    const run = THREE.MathUtils.smoothstep(speed, WALK + 0.4, SPRINT);
    for (const f of feet) {
      f.foot.getWorldPosition(a);
      f.toe.getWorldPosition(b);
      // the sole's middle is about halfway from the ankle to the ball of the foot
      const x = (a.x + b.x) / 2, z = (a.z + b.z) / 2;
      let fx = b.x - a.x, fz = b.z - a.z;
      const l = Math.hypot(fx, fz);
      if (l > 1e-4) {
        fx /= l;
        fz /= l;
      } else {
        fx = Math.sin(this.heading);
        fz = -Math.cos(this.heading);
      }
      const last = this.lastPrint[f.side > 0 ? 1 : 0];
      if (Math.hypot(x - last.x, z - last.z) < 0.12) continue;
      if (this.hf.sand(x, z) < 0.35) continue;
      const g = this.groundAt(x, z, this.pos.y + 0.4);
      if (g.onSurface) continue;
      last.set(x, g.y, z);
      // the swash washes prints away in seconds; wet sand keeps them for a while, dry sand for a couple of minutes
      const wet = g.y < 0.9 ? 1 : 0;
      const life = g.y < 0.5 ? 7 : wet ? 50 : 110;
      const depth = (0.011 + 0.011 * run) * (wet ? 0.8 : 1) * (both ? 1.25 : 1);
      this.prints.stamp(x, g.y, z, this.hf.normal(x, z), fx, fz, f.side, depth, both ? 0.25 : run, wet, life, this.clock);
    }
  }

  /** the contact shadows under the feet and the body (world-space decals; main adds `shadows` to the scene) */
  readonly shadows = new THREE.Group();
  private updateContact() {
    if (!this.contact) return;
    const show = this.state !== 'swim' && this.waterDepth < 0.08;
    this.contact.update(show, (x, z, y) => {
      const g = this.groundAt(x, z, y + 0.4);
      return { y: g.y, n: g.onSurface ? UP : this.hf.normal(x, z) };
    });
  }

  private syncRoot() {
    this.root.position.copy(this.pos);
    // soles settle a couple of centimetres into sand and soil
    if (this.state !== 'swim') this.root.position.y -= 0.025;
    // the model faces +z: rotate it onto the heading (yaw 0 = north / -z); swimming pitches the body head-up,
    // turns bank it into the curve
    const sw = this.state === 'swim' ? this.clips.swim?.action.getEffectiveWeight() ?? 0 : 0;
    this.root.rotation.set(-0.2 * sw, Math.PI - this.heading, this.bank, 'YXZ');
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
      // the take-off pose carries the rise, then the airborne loop takes over round the apex and the fall
      const rising = this.jumpT >= 0 ? THREE.MathUtils.smoothstep(this.vel.y, -0.8, 2.6) : 0;
      this.setW('jump_start', rising);
      this.setW('fall', 1 - rising);
    } else if (this.crouchT >= 0) {
      // anticipation: the crouch at the start of the take-off clip (half of it when running)
      const run = THREE.MathUtils.smoothstep(sp, 2, 4.5);
      this.setW('jump_start', 1 - run * 0.45);
      this.setW(sp > RUN ? 'sprint' : 'jog', run * 0.45);
      this.phase += dt * (sp / STRIDE.jog);
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
      // stride: the cycle advances by the distance covered over the blended clips' stride lengths, so planted feet
      // stay planted (no skating) at every speed
      const stride = STRIDE.walk * (1 - a) + (STRIDE.jog * (1 - b) + STRIDE.sprint * b) * a;
      this.phase += dt * Math.max(sp / stride, sp > 0.05 ? 0.25 : 0);
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
        if (crossed(0.02)) this.step({ surface: this.surface, speed: sp, foot: 0, pos: this.pos });
        if (crossed(0.52)) this.step({ surface: this.surface, speed: sp, foot: 1, pos: this.pos });
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
      else if (name === 'jump_start') t = this.crouchT >= 0 ? 0.16 + Math.min(1, this.crouchT / 0.13) * 0.26 : Math.min(clip.duration * 0.95, 0.42 + Math.max(0, this.jumpT) * 1.25);
      else if (name === 'land') t = Math.min(clip.duration * 0.9, 0.12 + Math.max(0, this.landT) * 1.4);
      else t = (clip.action.time + dt) % clip.duration;
      clip.action.time = t;
    }
    this.mixer.update(0);
  }

  /** scripted actions for the harness: walk, run, sprint, jump, swim, idle */
  act(input: { scripted: { t: number; intent: Partial<Intent> } | null }, action: string, seconds: number, yaw: number | undefined, camYaw: number) {
    // a world heading, so the walk keeps its direction while the camera eases round behind the player
    const worldYaw = yaw ?? camYaw;
    const intents: Record<string, Partial<Intent>> = {
      idle: { moveX: 0, moveY: 0 },
      walk: { moveX: 0, moveY: 1, walk: true, worldYaw },
      run: { moveX: 0, moveY: 1, worldYaw },
      sprint: { moveX: 0, moveY: 1, sprint: true, worldYaw },
      jump: { moveX: 0, moveY: 0.8, jump: true, worldYaw },
      swim: { moveX: 0, moveY: 1, worldYaw },
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

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Contact shadows: a soft ambient-occlusion blob under the body and one under each foot that fades as the foot
 * lifts, laid on the ground's slope. They ground the character where the sun's shadow map is too coarse (or the
 * light is overcast) to show contact.
 */
class ContactShadows {
  readonly group = new THREE.Group();
  private body: THREE.Mesh;
  private feet: THREE.Mesh[] = [];
  private bones: { foot: THREE.Object3D; toe: THREE.Object3D }[] = [];
  private pelvis: THREE.Object3D | null = null;
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();

  constructor(model: THREE.Object3D) {
    this.group.name = 'contact-shadows';
    const blob = (strength: ReturnType<typeof uniform>, soft: number) => {
      const m = new THREE.MeshBasicNodeMaterial();
      m.transparent = true;
      m.depthWrite = false;
      m.polygonOffset = true;
      m.polygonOffsetFactor = -2;
      m.polygonOffsetUnits = -4;
      const d = uv().sub(0.5).mul(2).length();
      m.colorNode = vec4(0, 0, 0, pow(clamp(float(1).sub(d), 0, 1), soft).mul(strength));
      m.fog = false;
      return m;
    };
    const plane = new THREE.PlaneGeometry(1, 1);
    plane.rotateX(-Math.PI / 2);
    const bodyU = uniform(0.3);
    this.body = new THREE.Mesh(plane, blob(bodyU, 1.4));
    this.body.userData.u = bodyU;
    this.body.renderOrder = 3;
    this.group.add(this.body);
    for (let i = 0; i < 2; i++) {
      const u = uniform(0);
      const f = new THREE.Mesh(plane, blob(u, 1.2));
      f.userData.u = u;
      f.renderOrder = 3;
      this.feet.push(f);
      this.group.add(f);
    }
    const find = (n: string) => {
      let hit: THREE.Object3D | null = null;
      model.traverse((o) => { if (!hit && o.name.replace(/[ _]/g, '') === n) hit = o; });
      return hit as THREE.Object3D | null;
    };
    for (const s of ['L', 'R']) {
      const foot = find(`Bip01${s}Foot`), toe = find(`Bip01${s}Toe0`);
      if (foot && toe) this.bones.push({ foot, toe });
    }
    this.pelvis = find('Bip01Pelvis');
    for (const o of this.group.children) o.frustumCulled = false;
  }

  private lay(m: THREE.Mesh, x: number, z: number, y: number, ground: (x: number, z: number, y: number) => { y: number; n: THREE.Vector3 }, yaw: number, sx: number, sz: number) {
    const g = ground(x, z, y);
    m.position.set(x, g.y + 0.012, z);
    this.q.setFromUnitVectors(UP, g.n);
    this.q2.setFromAxisAngle(UP, yaw);
    m.quaternion.copy(this.q).multiply(this.q2);
    m.scale.set(sx, 1, sz);
    return g.y;
  }

  update(show: boolean, ground: (x: number, z: number, y: number) => { y: number; n: THREE.Vector3 }) {
    this.group.visible = show;
    if (!show || !this.pelvis) return;
    this.pelvis.getWorldPosition(this.tmpA);
    const gy = this.lay(this.body, this.tmpA.x, this.tmpA.z, this.tmpA.y - 0.8, ground, 0, 0.95, 0.95);
    (this.body.userData.u as { value: number }).value = 0.32 * (1 - THREE.MathUtils.smoothstep(this.tmpA.y - gy, 1.0, 2.2));
    this.bones.forEach((b, i) => {
      b.foot.getWorldPosition(this.tmpA);
      b.toe.getWorldPosition(this.tmpB);
      const cx = (this.tmpA.x + this.tmpB.x) / 2, cz = (this.tmpA.z + this.tmpB.z) / 2;
      const low = Math.min(this.tmpB.y - 0.03, this.tmpA.y - 0.08);
      const yaw = Math.atan2(this.tmpB.x - this.tmpA.x, this.tmpB.z - this.tmpA.z);
      const f = this.feet[i];
      const g = this.lay(f, cx, cz, low, ground, yaw, 0.17, 0.36);
      (f.userData.u as { value: number }).value = 0.62 * (1 - THREE.MathUtils.smoothstep(low - g, 0.0, 0.2));
    });
  }
}
