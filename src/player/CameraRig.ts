/**
 * Camera rig. Modes:
 *   follow  third person behind the player: shoulder offset, lagging and easing round behind the direction of
 *           travel, pulled in by terrain and props; inside the lighthouse a room camera takes over (blended)
 *   orbit   around a point (harness captures, photo mode): yaw / pitch / distance
 *   free    fly camera (photo mode): WASD + mouse, Q/E down/up, Shift faster
 *   pose    fixed position and target (harness)
 */
import * as THREE from 'three/webgpu';
import type { Intent } from './Input';

export type CamMode = 'follow' | 'orbit' | 'free' | 'pose';

export interface CamWorld {
  /** ground or walkable surface under (x, z) that is not above y */
  groundAt(x: number, z: number, y?: number): number;
  /** distance along a ray to the first static collider (props, buildings), or Infinity */
  raycast?(from: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number;
  waterAt?(x: number, z: number): number;
  /** a room camera for enclosed spaces (the lighthouse): fills pos / target and returns true when it applies */
  interior?(player: THREE.Vector3, pos: THREE.Vector3, target: THREE.Vector3): boolean;
}

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const tmp3 = new THREE.Vector3();
const tmp4 = new THREE.Vector3();
/** offsets (right, up; m) of the extra collision rays round the camera */
const WHISKERS = [[0.32, 0], [-0.32, 0], [0, 0.22], [0, -0.22]];

export class CameraRig {
  mode: CamMode = 'follow';
  yaw = 0;
  pitch = 0.12;
  dist = 3.8;
  private curDist = 3.8;
  readonly target = new THREE.Vector3();
  private smoothTarget = new THREE.Vector3();
  private first = true;
  /** orbit */
  orbitCenter = new THREE.Vector3();
  orbitDist = 12;
  orbitSpeed = 0;
  /** pose */
  posePos = new THREE.Vector3();
  poseTarget = new THREE.Vector3();
  baseFov = 55;
  private flyVel = new THREE.Vector3();
  /** seconds since the last look input (the camera eases round behind the player after a while) */
  private idleLook = 10;
  /** interior camera state and the blend between it and the follow camera */
  private inside = false;
  private blend = 1;
  private blendFrom = new THREE.Vector3();
  private blendFromQ = new THREE.Quaternion();
  private iPos = new THREE.Vector3();
  private iTarget = new THREE.Vector3();
  private iSmooth = new THREE.Vector3();
  private iLook = new THREE.Vector3();

  constructor(readonly camera: THREE.PerspectiveCamera, private world: CamWorld) {}

  set(m: string | { pos: number[]; target: number[]; fov?: number } | { mode: 'orbit'; center: number[]; yaw?: number; pitch?: number; dist?: number; speed?: number }) {
    if (typeof m === 'string') {
      if (m === 'orbit') {
        this.orbitCenter.copy(this.target);
        this.orbitDist = Math.max(6, this.curDist * 2);
      }
      if (m === 'free') {
        // keep the current view
        const d = new THREE.Vector3();
        this.camera.getWorldDirection(d);
        this.yaw = Math.atan2(d.x, -d.z);
        this.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
      }
      this.mode = m as CamMode;
      return this.mode;
    }
    if ('pos' in m) {
      this.mode = 'pose';
      this.posePos.fromArray(m.pos);
      this.poseTarget.fromArray(m.target);
      if (m.fov) this.camera.fov = m.fov;
      this.camera.updateProjectionMatrix();
      return this.mode;
    }
    this.mode = 'orbit';
    this.orbitCenter.fromArray(m.center);
    if (m.yaw !== undefined) this.yaw = m.yaw;
    if (m.pitch !== undefined) this.pitch = m.pitch;
    if (m.dist !== undefined) this.orbitDist = m.dist;
    this.orbitSpeed = m.speed ?? 0;
    return this.mode;
  }

  /** snap the follow camera behind a heading (no smoothing on the next frame) */
  snapBehind(yaw: number) {
    this.yaw = yaw;
    this.pitch = 0.1;
    this.first = true;
    this.blend = 1;
    this.inside = false;
  }

  /** start a blend from wherever the camera is now (mode changes) */
  private startBlend() {
    this.blendFrom.copy(this.camera.position);
    this.blendFromQ.copy(this.camera.quaternion);
    this.blend = 0;
  }

  update(dt: number, intent: Intent, playerPos: THREE.Vector3, playerSpeed: number, playerHeading = this.yaw) {
    const cam = this.camera;
    if (this.mode === 'pose') {
      cam.position.copy(this.posePos);
      cam.lookAt(this.poseTarget);
      return;
    }
    this.yaw += intent.lookX;
    this.pitch = THREE.MathUtils.clamp(this.pitch - intent.lookY, -1.25, 1.35);
    if (Math.abs(intent.lookX) + Math.abs(intent.lookY) > 1e-4) this.idleLook = 0;
    else this.idleLook += dt;
    if (this.mode === 'free') {
      // smoothed fly camera (photo mode): velocity eases toward the wish so recordings glide
      const sp = intent.sprint ? 16 : 4;
      const fwd = tmp.set(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
      const right = tmp2.set(Math.cos(this.yaw), 0, Math.sin(this.yaw));
      const wish = new THREE.Vector3().addScaledVector(fwd, intent.moveY * sp).addScaledVector(right, intent.moveX * sp);
      wish.y += intent.up * sp;
      this.flyVel.lerp(wish, 1 - Math.exp(-dt * 3));
      cam.position.addScaledVector(this.flyVel, dt);
      const g = this.world.groundAt(cam.position.x, cam.position.z, cam.position.y);
      cam.position.y = Math.max(cam.position.y, g + 0.3);
      cam.lookAt(tmp.copy(cam.position).add(fwd));
      return;
    }
    if (this.mode === 'orbit') {
      this.yaw += this.orbitSpeed * dt;
      const d = this.orbitDist;
      cam.position.set(
        this.orbitCenter.x - Math.sin(this.yaw) * Math.cos(this.pitch) * d,
        this.orbitCenter.y + Math.sin(this.pitch) * d,
        this.orbitCenter.z + Math.cos(this.yaw) * Math.cos(this.pitch) * d,
      );
      const g = this.world.groundAt(cam.position.x, cam.position.z, cam.position.y);
      cam.position.y = Math.max(cam.position.y, g + 0.4);
      cam.lookAt(this.orbitCenter);
      return;
    }
    // ---- follow
    this.target.copy(playerPos).add(tmp.set(0, 1.55, 0));
    // enclosed rooms (the lighthouse stair and watch room): a room camera, blended in and out
    const inside = !!this.world.interior?.(playerPos, this.iPos, this.iTarget);
    if (inside !== this.inside) {
      this.startBlend();
      this.inside = inside;
      if (inside) {
        this.iSmooth.copy(this.iPos);
        this.iLook.copy(this.iTarget);
      } else {
        // leave the room looking the way the room camera looked
        this.yaw = Math.atan2(this.iTarget.x - this.iPos.x, -(this.iTarget.z - this.iPos.z));
        this.smoothTarget.copy(this.target);
        this.curDist = 1.2;
      }
    }
    if (inside) {
      const k = 1 - Math.exp(-dt * 5);
      this.iSmooth.lerp(this.iPos, k);
      this.iLook.lerp(this.iTarget, 1 - Math.exp(-dt * 8));
      cam.position.copy(this.iSmooth);
      cam.lookAt(this.iLook);
      this.applyBlend(dt);
      return;
    }
    this.dist = THREE.MathUtils.clamp(this.dist + intent.zoom * 0.45, 1.6, 9);
    // a little farther back when running
    const want = this.dist * (1 + Math.min(playerSpeed, 7) * 0.02);
    if (this.first) {
      this.smoothTarget.copy(this.target);
      this.curDist = want;
      this.first = false;
    }
    // ease round behind the direction of travel once the player has stopped steering the camera (not when
    // walking toward the camera: that would swing it through the player)
    if (this.idleLook > 1.2 && playerSpeed > 0.6) {
      const d = Math.atan2(Math.sin(playerHeading - this.yaw), Math.cos(playerHeading - this.yaw));
      if (Math.abs(d) < 2.2) this.yaw += d * (1 - Math.exp(-dt * 0.35 * Math.min(playerSpeed, 6) * 0.5));
    }
    // the pivot lags the player (more horizontally than vertically), so starts, stops and turns read in frame
    const kH = 1 - Math.exp(-dt * 7), kV = 1 - Math.exp(-dt * 5);
    this.smoothTarget.x += (this.target.x - this.smoothTarget.x) * kH;
    this.smoothTarget.z += (this.target.z - this.smoothTarget.z) * kH;
    this.smoothTarget.y += (this.target.y - this.smoothTarget.y) * kV;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const back = tmp.set(-Math.sin(this.yaw) * cp, sp, Math.cos(this.yaw) * cp).normalize();
    const right = tmp2.set(Math.cos(this.yaw), 0, Math.sin(this.yaw));
    // shoulder offset
    const pivot = new THREE.Vector3().copy(this.smoothTarget).addScaledVector(right, 0.42);
    // collision: march toward the wanted position, stop short of the ground and colliders
    let free = want;
    const steps = 16;
    for (let i = 1; i <= steps; i++) {
      const d = (want * i) / steps;
      const x = pivot.x + back.x * d, y = pivot.y + back.y * d, z = pivot.z + back.z * d;
      if (y < this.world.groundAt(x, z, y) + 0.35) {
        free = Math.max(0.6, d - want / steps);
        break;
      }
    }
    if (this.world.raycast) {
      free = Math.min(free, Math.max(0.6, this.world.raycast(pivot, back, want) - 0.3));
      // whiskers round the camera's footprint: a post or a boulder edge just beside the line of sight would fill
      // the frame from the near plane, so the camera comes in before it can (each hit scaled back onto the axis)
      const up = tmp3.crossVectors(right, back).normalize();
      for (const [sx, sy] of WHISKERS) {
        const end = tmp4.copy(back).multiplyScalar(want).addScaledVector(right, sx).addScaledVector(up, sy);
        const len = end.length();
        const hit = this.world.raycast(pivot, end.normalize(), len);
        if (hit < len) free = Math.min(free, Math.max(0.6, (hit / len) * want - 0.25));
      }
    }
    // pull in fast, ease back out slowly
    const k = free < this.curDist ? 1 - Math.exp(-dt * 25) : 1 - Math.exp(-dt * 3);
    this.curDist += (free - this.curDist) * k;
    cam.position.copy(pivot).addScaledVector(back, this.curDist);
    const g = this.world.groundAt(cam.position.x, cam.position.z, cam.position.y);
    cam.position.y = Math.max(cam.position.y, g + 0.3);
    cam.lookAt(tmp.copy(pivot).add(new THREE.Vector3(0, -0.05, 0)));
    // FOV opens a touch at sprint
    const fov = this.baseFov + Math.max(0, playerSpeed - 4) * 0.9;
    if (Math.abs(cam.fov - fov) > 0.05) {
      cam.fov += (fov - cam.fov) * (1 - Math.exp(-dt * 4));
      cam.updateProjectionMatrix();
    }
    this.applyBlend(dt);
  }

  private applyBlend(dt: number) {
    if (this.blend >= 1) return;
    this.blend = Math.min(1, this.blend + dt / 0.7);
    const t = this.blend * this.blend * (3 - 2 * this.blend);
    const cam = this.camera;
    cam.position.lerpVectors(this.blendFrom, cam.position, t);
    cam.quaternion.slerpQuaternions(this.blendFromQ, cam.quaternion.clone(), t);
  }
}
