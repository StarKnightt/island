/**
 * Camera rig. Modes:
 *   follow  third person behind the player: shoulder offset, smoothed, pulled in by terrain and props
 *   orbit   around a point (harness captures, photo mode): yaw / pitch / distance
 *   free    fly camera (photo mode): WASD + mouse, Q/E down/up, Shift faster
 *   pose    fixed position and target (harness)
 */
import * as THREE from 'three/webgpu';
import type { Intent } from './Input';

export type CamMode = 'follow' | 'orbit' | 'free' | 'pose';

export interface CamWorld {
  groundAt(x: number, z: number): number;
  /** distance along a ray to the first static collider (props, buildings), or Infinity */
  raycast?(from: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number;
  waterAt?(x: number, z: number): number;
}

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();

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
  }

  update(dt: number, intent: Intent, playerPos: THREE.Vector3, playerSpeed: number) {
    const cam = this.camera;
    if (this.mode === 'pose') {
      cam.position.copy(this.posePos);
      cam.lookAt(this.poseTarget);
      return;
    }
    this.yaw += intent.lookX;
    this.pitch = THREE.MathUtils.clamp(this.pitch - intent.lookY, -1.25, 1.35);
    if (this.mode === 'free') {
      const sp = (intent.sprint ? 18 : 5) * dt;
      const fwd = tmp.set(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
      const right = tmp2.set(Math.cos(this.yaw), 0, Math.sin(this.yaw));
      cam.position.addScaledVector(fwd, intent.moveY * sp).addScaledVector(right, intent.moveX * sp);
      cam.position.y += intent.up * sp;
      const g = this.world.groundAt(cam.position.x, cam.position.z);
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
      const g = this.world.groundAt(cam.position.x, cam.position.z);
      cam.position.y = Math.max(cam.position.y, g + 0.4);
      cam.lookAt(this.orbitCenter);
      return;
    }
    // ---- follow
    this.dist = THREE.MathUtils.clamp(this.dist + intent.zoom * 0.45, 1.6, 9);
    // a little farther back and lower when sprinting
    const want = this.dist * (1 + Math.min(playerSpeed, 7) * 0.02);
    this.target.copy(playerPos).add(tmp.set(0, 1.55, 0));
    if (this.first) {
      this.smoothTarget.copy(this.target);
      this.curDist = want;
      this.first = false;
    }
    // critically damped follow of the pivot: tight vertically less than horizontally (no bob from steps)
    const kH = 1 - Math.exp(-dt * 14), kV = 1 - Math.exp(-dt * 8);
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
      if (y < this.world.groundAt(x, z) + 0.35) {
        free = Math.max(0.6, d - want / steps);
        break;
      }
    }
    if (this.world.raycast) free = Math.min(free, Math.max(0.6, this.world.raycast(pivot, back, want) - 0.3));
    // pull in fast, ease back out slowly
    const k = free < this.curDist ? 1 - Math.exp(-dt * 25) : 1 - Math.exp(-dt * 3);
    this.curDist += (free - this.curDist) * k;
    cam.position.copy(pivot).addScaledVector(back, this.curDist);
    const g = this.world.groundAt(cam.position.x, cam.position.z);
    cam.position.y = Math.max(cam.position.y, g + 0.3);
    cam.lookAt(tmp.copy(pivot).add(new THREE.Vector3(0, -0.05, 0)));
    // FOV opens a touch at sprint
    const fov = this.baseFov + Math.max(0, playerSpeed - 4) * 0.9;
    if (Math.abs(cam.fov - fov) > 0.05) {
      cam.fov += (fov - cam.fov) * (1 - Math.exp(-dt * 4));
      cam.updateProjectionMatrix();
    }
  }
}
