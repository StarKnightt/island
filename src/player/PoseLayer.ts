/**
 * Procedural layer on top of the blended clips, applied after the mixer each frame:
 *
 *   idle life   arms hanging close to the body with the hands relaxed open, breathing in the chest and shoulders, a
 *               slow weight shift from leg to leg (pelvis over the standing leg, the free hip dropping, the spine
 *               keeping the head over the feet), the head drifting a little, blinks
 *   arm swing   in walk, jog and sprint each arm swings against the opposite leg, elbows bending on the forward swing
 *   feet        two-bone leg IK: the feet stay where the clip planted them while the pelvis sways, and on slopes and
 *               steps each foot is set on the ground under it (the pelvis drops for the lower foot), the planted
 *               sole tilted to the ground
 *
 * Everything works on world-space directions, so the Biped's local bone axes do not matter.
 */
import * as THREE from 'three/webgpu';

export interface PoseInput {
  dt: number;
  /** 0..1 how much of the pose is the standing idle */
  idle: number;
  /** 0..1 how much the feet should follow the ground (on the ground: 1; jumping, swimming: 0) */
  plant: number;
  /** ground height and normal under (x, z), not above y */
  ground: (x: number, z: number, y: number) => { y: number; n: THREE.Vector3 };
  /** the height the root stands at (the controller's ground) */
  rootY: number;
}

interface Leg {
  thigh: THREE.Object3D;
  calf: THREE.Object3D;
  foot: THREE.Object3D;
  toe: THREE.Object3D;
  side: number;
  /** smoothed ground offset of this foot */
  lift: number;
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

function find(root: THREE.Object3D, name: string) {
  let hit: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!hit && o.name.replace(/[ _]/g, '') === name) hit = o;
  });
  return hit as THREE.Object3D | null;
}

/** rotate a bone so that its world-space direction `from` turns to `to` (amount 0..1) */
function turnWorld(bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, amount = 1) {
  if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return;
  _q.setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
  if (amount < 1) _q.slerp(_q3.identity(), 1 - amount);
  rotateWorld(bone, _q);
}

/** pre-multiply a bone's world rotation by `q` (world space) */
function rotateWorld(bone: THREE.Object3D, q: THREE.Quaternion) {
  bone.getWorldQuaternion(_q2);
  _q2.premultiply(q);
  bone.parent!.getWorldQuaternion(_q3);
  bone.quaternion.copy(_q3.invert().multiply(_q2));
  bone.updateMatrixWorld(true);
}

/** set a bone's world rotation */
function setWorldQuat(bone: THREE.Object3D, q: THREE.Quaternion) {
  bone.parent!.getWorldQuaternion(_q3);
  bone.quaternion.copy(_q3.invert().multiply(q));
  bone.updateMatrixWorld(true);
}

export class PoseLayer {
  private ok = false;
  private pelvis!: THREE.Object3D;
  private spine1!: THREE.Object3D;
  private spine2!: THREE.Object3D;
  private neck!: THREE.Object3D;
  private head!: THREE.Object3D;
  private arms: { clav: THREE.Object3D; upper: THREE.Object3D; fore: THREE.Object3D; hand: THREE.Object3D; side: number }[] = [];
  private fingers: { bone: THREE.Object3D; rest: THREE.Quaternion }[] = [];
  private lids: { bone: THREE.Object3D; rest: THREE.Vector3; top: boolean }[] = [];
  private legs: Leg[] = [];
  private t = Math.random() * 100;
  private drop = 0;
  private blinkT = 2;
  private blink = 0;
  /** debug: hold the eyelids this far closed (0 = blink normally) */
  blinkHold = 0;
  private footQ = [new THREE.Quaternion(), new THREE.Quaternion()];
  private target = [new THREE.Vector3(), new THREE.Vector3()];

  constructor(model: THREE.Object3D, private root: THREE.Object3D) {
    const need = (n: string) => find(model, n);
    const pelvis = need('Bip01Pelvis'), spine1 = need('Bip01Spine1'), spine2 = need('Bip01Spine2');
    const neck = need('Bip01Neck'), head = need('Bip01Head');
    if (!pelvis || !spine1 || !spine2 || !neck || !head) return;
    Object.assign(this, { pelvis, spine1, spine2, neck, head });
    for (const [s, side] of [['L', -1], ['R', 1]] as const) {
      const clav = need(`Bip01${s}Clavicle`), upper = need(`Bip01${s}UpperArm`), fore = need(`Bip01${s}Forearm`), hand = need(`Bip01${s}Hand`);
      if (clav && upper && fore && hand) this.arms.push({ clav, upper, fore, hand, side });
      const thigh = need(`Bip01${s}Thigh`), calf = need(`Bip01${s}Calf`), foot = need(`Bip01${s}Foot`), toe = need(`Bip01${s}Toe0`);
      if (thigh && calf && foot && toe) this.legs.push({ thigh, calf, foot, toe, side, lift: 0 });
      // fingers: the bind pose has open hands
      for (let f = 0; f <= 4; f++) {
        for (const j of ['', '1', '2']) {
          const b = need(`Bip01${s}Finger${f}${j}`);
          if (b) this.fingers.push({ bone: b, rest: b.quaternion.clone() });
        }
      }
      for (const top of [true, false]) {
        const b = need(`Bip01${s === 'L' ? 'L' : 'R'}EyeBlink${top ? 'Top' : 'Bottom'}`);
        if (b) this.lids.push({ bone: b, rest: b.position.clone(), top });
      }
    }
    this.ok = this.legs.length === 2 && this.arms.length === 2;
    // the bind pose stands upright: the model's up, in the head bone's frame
    model.updateMatrixWorld(true);
    const mq = model.getWorldQuaternion(new THREE.Quaternion());
    const hq = head.getWorldQuaternion(new THREE.Quaternion());
    this.headUpLocal.copy(UP).applyQuaternion(mq).applyQuaternion(hq.invert()).normalize();
  }

  update(p: PoseInput) {
    if (!this.ok) return;
    const dt = Math.min(p.dt, 0.1);
    this.t += dt;
    const t = this.t;
    this.root.updateMatrixWorld(true);
    // the character's frame: the model faces +z
    this.root.getWorldQuaternion(_q);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(_q).setY(0).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();

    // ---- where the clip puts the feet (before the layer moves the pelvis)
    for (let i = 0; i < 2; i++) {
      const leg = this.legs[i];
      leg.foot.getWorldPosition(this.target[i]);
      leg.foot.getWorldQuaternion(this.footQ[i]);
    }

    const idle = p.idle;
    if (idle > 0.01 && p.plant > 0.5) {
      // the clip stands with one foot 38 cm ahead of the other (mid-stride from the side): bring the feet closer
      // to a relaxed stance, a hand's length apart front to back, keeping their spread and their angles
      const mid = _a.addVectors(this.target[0], this.target[1]).multiplyScalar(0.5);
      for (let i = 0; i < 2; i++) {
        const off = _b.subVectors(this.target[i], mid);
        const along = off.dot(fwd);
        this.target[i].addScaledVector(fwd, -along * 0.6 * idle);
      }
    }
    if (idle > 0.01) {
      // weight shift: about seven seconds on each leg, a two-second transfer between
      const shift = THREE.MathUtils.smoothstep(Math.sin((t * Math.PI * 2) / 15), -0.45, 0.45) * 2 - 1;
      const sway = shift * idle;
      // the pelvis moves over the standing leg and its free side drops; the chest keeps the head over the feet
      const pos = this.pelvis.getWorldPosition(_a).addScaledVector(right, sway * 0.024);
      pos.y -= Math.abs(sway) * 0.006;
      this.setWorldPosition(this.pelvis, pos);
      // (a positive angle about the forward axis lowers the right side)
      rotateWorld(this.pelvis, _q.setFromAxisAngle(fwd, -sway * 0.045));
      rotateWorld(this.spine1, _q.setFromAxisAngle(fwd, sway * 0.05));
      // breathing: chest lifts and opens, shoulders rise a little (4.4 s a breath)
      const br = Math.sin((t * Math.PI * 2) / 4.4);
      rotateWorld(this.spine2, _q.setFromAxisAngle(right, -br * 0.012 * idle));
      // the head drifts: slow look around, levelled against the sway
      const yaw = (Math.sin(t * 0.37) * 0.6 + Math.sin(t * 0.13 + 1.7) * 0.4) * 0.09 * idle;
      const pitch = (Math.sin(t * 0.29 + 0.6) * 0.5 + 0.25) * 0.05 * idle;
      rotateWorld(this.neck, _q.setFromAxisAngle(UP, yaw * 0.4).multiply(_q2.setFromAxisAngle(right, pitch * 0.4)));
      rotateWorld(this.head, _q.setFromAxisAngle(UP, yaw * 0.6).multiply(_q2.setFromAxisAngle(right, pitch * 0.6)).multiply(_q3.setFromAxisAngle(fwd, sway * 0.03)));
      for (const arm of this.arms) {
        // shoulders rise with the breath
        rotateWorld(arm.clav, _q.setFromAxisAngle(fwd, arm.side * br * 0.012 * idle));
        // arms hang close to the body, a little forward, elbows softly bent
        arm.upper.getWorldPosition(_a);
        arm.fore.getWorldPosition(_b);
        const dir = _b.clone().sub(_a).normalize();
        const want = dir.clone();
        // pull the arm in toward the body's side plane (remove most of its outward lean) and slightly forward
        const out = want.dot(right) * arm.side;
        want.addScaledVector(right, -arm.side * Math.max(0, out - 0.06) * 0.85);
        want.addScaledVector(fwd, 0.06);
        turnWorld(arm.upper, dir, want.normalize(), idle);
        arm.fore.getWorldPosition(_a);
        arm.hand.getWorldPosition(_b);
        const fdir = _b.clone().sub(_a).normalize();
        const fwant = fdir.clone().addScaledVector(fwd, 0.22).normalize();
        turnWorld(arm.fore, fdir, fwant, idle);
      }
      // hands: relax the clip's fists toward the open bind pose (a natural half curl)
      for (const f of this.fingers) f.bone.quaternion.slerp(f.rest, 0.6 * idle);
    }

    // ---- arm swing in locomotion: the clips carry the arms almost still. Each arm swings against the other leg
    // (read from that thigh, so it is always in step), the elbow bending more on the forward swing
    const loco = (1 - idle) * p.plant;
    if (loco > 0.01) {
      for (const arm of this.arms) {
        const other = this.legs[0].side === arm.side ? this.legs[1] : this.legs[0];
        const legF = other.calf.getWorldPosition(_b).sub(other.thigh.getWorldPosition(_a)).normalize().dot(fwd);
        const swing = THREE.MathUtils.clamp(legF, -0.6, 0.6) * 0.75 * loco;
        // arms in close to the body while walking (the clips hold them a little out)
        arm.upper.getWorldPosition(_a);
        arm.fore.getWorldPosition(_b);
        const dir = _b.clone().sub(_a).normalize();
        const want = dir.clone();
        want.addScaledVector(right, -arm.side * Math.max(0, want.dot(right) * arm.side - 0.08) * 0.6);
        turnWorld(arm.upper, dir, want.normalize(), loco);
        rotateWorld(arm.upper, _q.setFromAxisAngle(right, swing));
        rotateWorld(arm.fore, _q.setFromAxisAngle(right, (Math.max(0, swing) * 0.7 + 0.12) * loco));
      }
    }

    // ---- blinks (the eyelid bones are not animated by the clips: set absolutely)
    this.blinkT -= dt;
    if (this.blinkT <= 0) {
      this.blink = 0.0001;
      this.blinkT = 2.5 + Math.random() * 4;
    }
    if (this.blink > 0) {
      this.blink += dt;
      if (this.blink > 0.16) this.blink = 0;
    }
    const close = this.blinkHold > 0 ? this.blinkHold : this.blink > 0 ? Math.sin((this.blink / 0.16) * Math.PI) : 0;
    for (const lid of this.lids) {
      lid.bone.position.copy(lid.rest);
      if (close <= 0) continue;
      // the upper lid comes down over the eye, the lower one rises a little (world space, along the head's up)
      const parent = lid.bone.parent!;
      parent.updateWorldMatrix(true, false);
      const w = parent.localToWorld(_a.copy(lid.rest));
      w.addScaledVector(this.headUp(), (lid.top ? -0.0095 : 0.0022) * close);
      lid.bone.position.copy(parent.worldToLocal(w));
    }

    // ---- feet: on the ground under them, and where the clip had them while the pelvis sways
    if (p.plant > 0.01) {
      const offs = [0, 0];
      for (let i = 0; i < 2; i++) {
        const tg = this.target[i];
        const g = p.ground(tg.x, tg.z, tg.y + 0.5);
        // the clip's height of this ankle above flat ground, put on the ground under it (steps and slopes)
        const want = g.y - p.rootY;
        const leg = this.legs[i];
        leg.lift += (want - leg.lift) * (1 - Math.exp(-dt * 18));
        offs[i] = THREE.MathUtils.clamp(leg.lift, -0.45, 0.45) * p.plant;
      }
      // the pelvis drops so the lower foot can reach its ground
      const wantDrop = Math.max(0, -Math.min(offs[0], offs[1]));
      this.drop += (wantDrop - this.drop) * (1 - Math.exp(-dt * 12));
      if (this.drop > 1e-4) {
        const pp = this.pelvis.getWorldPosition(_a);
        pp.y -= this.drop;
        this.setWorldPosition(this.pelvis, pp);
      }
      for (let i = 0; i < 2; i++) {
        const leg = this.legs[i];
        const tg = this.target[i].clone();
        tg.y += offs[i];
        this.solveLeg(leg, tg, fwd);
        // the sole follows the slope while the foot is down (lifted feet keep the clip's angle)
        const h = this.target[i].y - p.rootY;
        const planted = (1 - THREE.MathUtils.smoothstep(h, 0.13, 0.22)) * p.plant;
        const g = p.ground(tg.x, tg.z, tg.y + 0.5);
        _q.setFromUnitVectors(UP, g.n.clone().normalize());
        _q.slerp(_q3.identity(), 1 - planted * 0.8);
        setWorldQuat(leg.foot, this.footQ[i].clone().premultiply(_q));
      }
    }
  }

  /** the head's up direction (in the head bone's frame, from the upright bind pose) */
  private headUpLocal = new THREE.Vector3(0, 1, 0);
  private headUp() {
    return _d.copy(this.headUpLocal).applyQuaternion(this.head.getWorldQuaternion(_q2)).normalize();
  }

  private setWorldPosition(bone: THREE.Object3D, p: THREE.Vector3) {
    bone.parent!.updateWorldMatrix(true, false);
    bone.position.copy(bone.parent!.worldToLocal(p.clone()));
    bone.updateMatrixWorld(true);
  }

  /** two-bone IK: thigh and calf turned so the ankle reaches `target`, the knee bending the way it bent */
  private solveLeg(leg: Leg, target: THREE.Vector3, fwd: THREE.Vector3) {
    const a = leg.thigh.getWorldPosition(new THREE.Vector3());
    const b = leg.calf.getWorldPosition(new THREE.Vector3());
    const c = leg.foot.getWorldPosition(new THREE.Vector3());
    const lab = a.distanceTo(b), lbc = b.distanceTo(c);
    const at = _c.subVectors(target, a);
    const dist = THREE.MathUtils.clamp(at.length(), Math.abs(lab - lbc) + 1e-3, lab + lbc - 1e-4);
    at.normalize();
    // the bend plane: the knee's current offset from the hip-ankle line, else forward
    const ac = _d.subVectors(c, a).normalize();
    const pole = b.clone().sub(a);
    pole.addScaledVector(ac, -pole.dot(ac));
    if (pole.lengthSq() < 1e-6) pole.copy(fwd);
    pole.addScaledVector(at, -pole.dot(at)).normalize();
    const cosA = THREE.MathUtils.clamp((lab * lab + dist * dist - lbc * lbc) / (2 * lab * dist), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    const knee = a.clone().addScaledVector(at, cosA * lab).addScaledVector(pole, sinA * lab);
    turnWorld(leg.thigh, b.clone().sub(a), knee.clone().sub(a));
    const b2 = leg.calf.getWorldPosition(new THREE.Vector3());
    const c2 = leg.foot.getWorldPosition(new THREE.Vector3());
    turnWorld(leg.calf, c2.clone().sub(b2), target.clone().sub(b2));
  }
}
