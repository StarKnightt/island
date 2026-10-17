/**
 * Retargets Quaternius Universal Animation Library clips (CC0, UE-mannequin skeleton) onto the Rocketbox avatar
 * (MIT, 3ds Max Biped skeleton) and writes one GLB with the mesh, skin and every clip.
 *
 *   pnpm tsx tools/retarget.ts <character.glb> <out.glb>
 *
 * Method: per mapped bone, the source's world-space rotation change from its reference pose (the T/A pose clip) is
 * applied to the target's rest pose after aligning the bone directions of the two reference poses, so differences in
 * rest pose (A vs T), local bone axes and facing do not matter. The pelvis height is scaled by the leg-length ratio.
 * Natural speeds (m/s) of the locomotion loops are measured from the root-motion versions of the same clips.
 */
import { NodeIO, type Document, type Node as GNode, type Animation } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { writeFileSync } from 'node:fs';

const UAL1 = 'E:/tmp/island/dl/ual1/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb';
const UAL1_RM = 'E:/tmp/island/dl/ual1/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard_RM.glb';
const UAL2 = 'E:/tmp/island/dl/ual2/Universal Animation Library 2[Standard]/Unreal-Godot/UAL2_Standard.glb';
const UAL2_RM = 'E:/tmp/island/dl/ual2/Universal Animation Library 2[Standard]/Unreal-Godot/UAL2_Standard_RM.glb';

/** clips to bring over: [source file, source clip, our name] */
const CLIPS: [string, string, string][] = [
  [UAL1, 'Idle_Loop', 'idle'],
  [UAL1, 'Walk_Loop', 'walk'],
  [UAL1, 'Jog_Fwd_Loop', 'jog'],
  [UAL1, 'Sprint_Loop', 'sprint'],
  [UAL1, 'Jump_Start', 'jump_start'],
  [UAL1, 'Jump_Loop', 'fall'],
  [UAL1, 'Jump_Land', 'land'],
  [UAL1, 'Swim_Fwd_Loop', 'swim'],
  [UAL1, 'Swim_Idle_Loop', 'tread'],
  [UAL1, 'Crouch_Idle_Loop', 'crouch'],
  [UAL1, 'Interact', 'interact'],
  [UAL1, 'Sitting_Idle_Loop', 'sit'],
  [UAL2, 'Idle_FoldArms_Loop', 'idle_arms'],
  [UAL2, 'Idle_Rail_Loop', 'lean_rail'],
  [UAL2, 'Walk_Carry_Loop', 'walk_carry'],
];

/** UE mannequin -> Biped */
const MAP: Record<string, string> = {
  pelvis: 'Bip01 Pelvis', spine_01: 'Bip01 Spine', spine_02: 'Bip01 Spine1', spine_03: 'Bip01 Spine2',
  neck_01: 'Bip01 Neck', Head: 'Bip01 Head',
};
for (const [s, t] of [['l', 'L'], ['r', 'R']]) {
  Object.assign(MAP, {
    [`clavicle_${s}`]: `Bip01 ${t} Clavicle`, [`upperarm_${s}`]: `Bip01 ${t} UpperArm`, [`lowerarm_${s}`]: `Bip01 ${t} Forearm`,
    [`hand_${s}`]: `Bip01 ${t} Hand`, [`thigh_${s}`]: `Bip01 ${t} Thigh`, [`calf_${s}`]: `Bip01 ${t} Calf`,
    [`foot_${s}`]: `Bip01 ${t} Foot`, [`ball_${s}`]: `Bip01 ${t} Toe0`,
    [`thumb_01_${s}`]: `Bip01 ${t} Finger0`, [`thumb_02_${s}`]: `Bip01 ${t} Finger01`, [`thumb_03_${s}`]: `Bip01 ${t} Finger02`,
    [`index_01_${s}`]: `Bip01 ${t} Finger1`, [`index_02_${s}`]: `Bip01 ${t} Finger11`, [`index_03_${s}`]: `Bip01 ${t} Finger12`,
    [`middle_01_${s}`]: `Bip01 ${t} Finger2`, [`middle_02_${s}`]: `Bip01 ${t} Finger21`, [`middle_03_${s}`]: `Bip01 ${t} Finger22`,
    [`ring_01_${s}`]: `Bip01 ${t} Finger3`, [`ring_02_${s}`]: `Bip01 ${t} Finger31`, [`ring_03_${s}`]: `Bip01 ${t} Finger32`,
    [`pinky_01_${s}`]: `Bip01 ${t} Finger4`, [`pinky_02_${s}`]: `Bip01 ${t} Finger41`, [`pinky_03_${s}`]: `Bip01 ${t} Finger42`,
  });
}
/** the child that defines each bone's direction (source names) */
const DIR_CHILD: Record<string, string> = {
  pelvis: 'spine_01', spine_01: 'spine_02', spine_02: 'spine_03', spine_03: 'neck_01', neck_01: 'Head',
};
for (const s of ['l', 'r']) {
  Object.assign(DIR_CHILD, {
    [`clavicle_${s}`]: `upperarm_${s}`, [`upperarm_${s}`]: `lowerarm_${s}`, [`lowerarm_${s}`]: `hand_${s}`,
    [`hand_${s}`]: `middle_01_${s}`, [`thigh_${s}`]: `calf_${s}`, [`calf_${s}`]: `foot_${s}`, [`foot_${s}`]: `ball_${s}`,
    [`thumb_01_${s}`]: `thumb_02_${s}`, [`thumb_02_${s}`]: `thumb_03_${s}`,
    [`index_01_${s}`]: `index_02_${s}`, [`index_02_${s}`]: `index_03_${s}`,
    [`middle_01_${s}`]: `middle_02_${s}`, [`middle_02_${s}`]: `middle_03_${s}`,
    [`ring_01_${s}`]: `ring_02_${s}`, [`ring_02_${s}`]: `ring_03_${s}`,
    [`pinky_01_${s}`]: `pinky_02_${s}`, [`pinky_02_${s}`]: `pinky_03_${s}`,
  });
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const FPS = 30;

interface Pose { world: Map<string, Matrix4> }

function nodeMap(doc: Document) {
  const m = new Map<string, GNode>();
  for (const n of doc.getRoot().listNodes()) m.set(n.getName(), n);
  return m;
}
function parentOf(doc: Document, n: GNode): GNode | null {
  for (const p of doc.getRoot().listNodes()) if (p.listChildren().includes(n)) return p;
  return null;
}
const local = (n: GNode, t?: [number, number, number], r?: [number, number, number, number], s?: [number, number, number]) => {
  const m = new Matrix4();
  m.compose(new Vector3(...(t ?? n.getTranslation())), new Quaternion(...(r ?? n.getRotation())), new Vector3(...(s ?? n.getScale())));
  return m;
};

/** sample an animation channel (linear / slerp) */
function sampler(anim: Animation, node: GNode, path: 'rotation' | 'translation') {
  const ch = anim.listChannels().find((c) => c.getTargetNode() === node && c.getTargetPath() === path);
  if (!ch) return null;
  const s = ch.getSampler()!;
  const times = s.getInput()!.getArray()! as Float32Array;
  const vals = s.getOutput()!.getArray()! as Float32Array;
  const k = path === 'rotation' ? 4 : 3;
  return (t: number): number[] => {
    if (t <= times[0]) return Array.from(vals.slice(0, k));
    if (t >= times[times.length - 1]) return Array.from(vals.slice((times.length - 1) * k, times.length * k));
    let i = 0;
    while (i < times.length - 2 && times[i + 1] < t) i++;
    const u = (t - times[i]) / (times[i + 1] - times[i]);
    if (k === 4) {
      const a = new Quaternion(...(vals.slice(i * 4, i * 4 + 4) as unknown as [number, number, number, number]));
      const b = new Quaternion(...(vals.slice(i * 4 + 4, i * 4 + 8) as unknown as [number, number, number, number]));
      a.slerp(b, u);
      return [a.x, a.y, a.z, a.w];
    }
    return [0, 1, 2].map((c) => vals[i * 3 + c] * (1 - u) + vals[i * 3 + 3 + c] * u);
  };
}

function duration(anim: Animation) {
  let d = 0;
  for (const s of anim.listSamplers()) {
    const a = s.getInput()!.getArray()!;
    d = Math.max(d, a[a.length - 1]);
  }
  return d;
}

/** world matrices of every node at time t of `anim` (or the rest pose) */
function poseAt(doc: Document, anim: Animation | null, t: number): Pose {
  const world = new Map<string, Matrix4>();
  const visit = (n: GNode, parent: Matrix4) => {
    let tr: number[] | undefined, ro: number[] | undefined;
    if (anim) {
      tr = sampler(anim, n, 'translation')?.(t);
      ro = sampler(anim, n, 'rotation')?.(t);
    }
    const w = parent.clone().multiply(local(n, tr as [number, number, number] | undefined, ro as [number, number, number, number] | undefined));
    world.set(n.getName(), w);
    for (const c of n.listChildren()) visit(c, w);
  };
  for (const scene of doc.getRoot().listScenes()) for (const n of scene.listChildren()) visit(n, new Matrix4());
  return { world };
}

const pos = (m: Matrix4) => new Vector3().setFromMatrixPosition(m);
const rot = (m: Matrix4) => {
  const p = new Vector3(), q = new Quaternion(), s = new Vector3();
  m.decompose(p, q, s);
  return q;
};

async function main() {
  const [charPath, outPath] = process.argv.slice(2);
  const tgt = await io.read(charPath);
  const tNodes = nodeMap(tgt);
  const tRest = poseAt(tgt, null, 0);

  const sources = new Map<string, Document>();
  for (const f of [UAL1, UAL2, UAL1_RM, UAL2_RM]) sources.set(f, await io.read(f));

  // source reference pose: the T/A pose clip
  const src1 = sources.get(UAL1)!;
  const tposeAnim = src1.getRoot().listAnimations().find((a) => a.getName() === 'A_TPose')!;
  const sRef = poseAt(src1, tposeAnim, 0);

  // facing: forward = up x (left shoulder - right shoulder) ... computed from hips/shoulders
  const facing = (pose: Pose, l: string, r: string) => {
    const d = pos(pose.world.get(l)!).sub(pos(pose.world.get(r)!));
    d.y = 0;
    d.normalize();
    // forward is perpendicular to the left->right axis, on the ground plane (left-handed check below)
    return new Vector3(-d.z, 0, d.x).multiplyScalar(1);
  };
  const fS = facing(sRef, 'thigh_l', 'thigh_r');
  const fT = facing(tRest, 'Bip01 L Thigh', 'Bip01 R Thigh');
  const yaw = new Quaternion().setFromUnitVectors(fS, fT);
  console.log('facing src', fS.toArray().map((v) => v.toFixed(2)), 'tgt', fT.toArray().map((v) => v.toFixed(2)));
  const yawM = new Matrix4().makeRotationFromQuaternion(yaw);

  // per-bone direction alignment of the reference poses
  const align = new Map<string, Quaternion>();
  for (const [s, t] of Object.entries(MAP)) {
    const child = DIR_CHILD[s];
    if (!child || !sRef.world.has(s) || !tNodes.has(t)) {
      align.set(s, new Quaternion());
      continue;
    }
    const tChild = MAP[child];
    const ds = pos(sRef.world.get(child)!).sub(pos(sRef.world.get(s)!)).applyQuaternion(yaw).normalize();
    const dt = pos(tRest.world.get(tChild)!).sub(pos(tRest.world.get(t)!)).normalize();
    align.set(s, new Quaternion().setFromUnitVectors(dt, ds));
  }

  // hip heights for translation scaling
  const sHip = pos(sRef.world.get('pelvis')!).y - Math.min(pos(sRef.world.get('foot_l')!).y, pos(sRef.world.get('foot_r')!).y);
  const tHip = pos(tRest.world.get('Bip01 Pelvis')!).y - Math.min(pos(tRest.world.get('Bip01 L Foot')!).y, pos(tRest.world.get('Bip01 R Foot')!).y);
  const hipScale = tHip / sHip;
  console.log(`hip height src ${sHip.toFixed(3)} tgt ${tHip.toFixed(3)} scale ${hipScale.toFixed(3)}`);

  // remove any existing animations on the target
  for (const a of tgt.getRoot().listAnimations()) a.dispose();
  const buffer = tgt.getRoot().listBuffers()[0];
  const meta: Record<string, { duration: number; speed: number }> = {};

  // mapped target bones in hierarchy order (parents first)
  const order: string[] = [];
  const visit = (n: GNode) => {
    if (Object.values(MAP).includes(n.getName())) order.push(n.getName());
    for (const c of n.listChildren()) visit(c);
  };
  for (const n of tgt.getRoot().listScenes()[0].listChildren()) visit(n);
  const inv = Object.fromEntries(Object.entries(MAP).map(([s, t]) => [t, s]));
  const pelvisRestLocal = tNodes.get('Bip01 Pelvis')!.getTranslation();
  const pelvisParent = parentOf(tgt, tNodes.get('Bip01 Pelvis')!);
  const pelvisParentW = pelvisParent ? tRest.world.get(pelvisParent.getName())! : new Matrix4();

  for (const [file, name, ours] of CLIPS) {
    const src = sources.get(file)!;
    const anim = src.getRoot().listAnimations().find((a) => a.getName() === name);
    if (!anim) {
      console.log(`missing ${name}`);
      continue;
    }
    const dur = duration(anim);
    const frames = Math.max(2, Math.round(dur * FPS) + 1);
    const times = new Float32Array(frames);
    const rotOut = new Map<string, Float32Array>();
    for (const t of order) rotOut.set(t, new Float32Array(frames * 4));
    const hipOut = new Float32Array(frames * 3);
    const sRest0 = poseAt(src, anim, 0);
    const p0 = pos(sRest0.world.get('pelvis')!);
    for (let f = 0; f < frames; f++) {
      const time = Math.min(dur, f / FPS);
      times[f] = time;
      const sp = poseAt(src, anim, time);
      const tWorld = new Map<string, Matrix4>();
      for (const t of order) {
        const s = inv[t];
        const node = tNodes.get(t)!;
        const parent = parentOf(tgt, node)!;
        const parentW = tWorld.get(parent.getName()) ?? tRest.world.get(parent.getName())!;
        // desired world rotation: source delta (yaw-corrected) applied to the aligned target rest
        const qS = rot(yawM.clone().multiply(sp.world.get(s)!));
        const qSRef = rot(yawM.clone().multiply(sRef.world.get(s)!));
        const delta = qS.multiply(qSRef.invert());
        const qT = delta.multiply(align.get(s)!).multiply(rot(tRest.world.get(t)!));
        // local = inverse(parent world rotation) * world rotation
        const qLocal = rot(parentW).invert().multiply(qT);
        rotOut.get(t)!.set([qLocal.x, qLocal.y, qLocal.z, qLocal.w], f * 4);
        // the world matrix of this bone for its children (rest translation in the parent frame)
        const restLocal = local(node);
        const lp = new Vector3().setFromMatrixPosition(restLocal);
        let lpos = lp;
        if (t === 'Bip01 Pelvis') {
          // pelvis: the source's pelvis motion relative to its first frame, scaled and yaw-corrected, in the parent frame
          const d = pos(sp.world.get('pelvis')!).sub(p0).applyQuaternion(yaw).multiplyScalar(hipScale);
          const restW = pos(tRest.world.get(t)!);
          const wantW = restW.clone().add(new Vector3(0, d.y, 0)).add(new Vector3(d.x, 0, d.z).multiplyScalar(ours === 'idle' || ours.startsWith('idle') ? 1 : 1));
          lpos = wantW.applyMatrix4(pelvisParentW.clone().invert());
          hipOut.set([lpos.x, lpos.y, lpos.z], f * 3);
        }
        const m = new Matrix4().compose(lpos, qLocal, new Vector3(...node.getScale()));
        tWorld.set(t, parentW.clone().multiply(m));
      }
    }
    // natural speed from the root-motion version
    let speed = 0;
    const rmDoc = sources.get(file === UAL1 ? UAL1_RM : UAL2_RM)!;
    const rmAnim = rmDoc.getRoot().listAnimations().find((a) => a.getName() === name);
    if (rmAnim) {
      const a = poseAt(rmDoc, rmAnim, 0), b = poseAt(rmDoc, rmAnim, duration(rmAnim));
      const pa = pos(a.world.get('root') ?? a.world.get('pelvis')!), pb = pos(b.world.get('root') ?? b.world.get('pelvis')!);
      speed = (Math.hypot(pb.x - pa.x, pb.z - pa.z) / duration(rmAnim)) * hipScale;
    }
    meta[ours] = { duration: +dur.toFixed(3), speed: +speed.toFixed(3) };

    const out = tgt.createAnimation(ours);
    const input = tgt.createAccessor().setType('SCALAR').setArray(times).setBuffer(buffer);
    for (const t of order) {
      const smp = tgt.createAnimationSampler().setInput(input).setOutput(tgt.createAccessor().setType('VEC4').setArray(rotOut.get(t)!).setBuffer(buffer)).setInterpolation('LINEAR');
      out.addSampler(smp).addChannel(tgt.createAnimationChannel().setTargetNode(tNodes.get(t)!).setTargetPath('rotation').setSampler(smp));
    }
    const hs = tgt.createAnimationSampler().setInput(input).setOutput(tgt.createAccessor().setType('VEC3').setArray(hipOut).setBuffer(buffer)).setInterpolation('LINEAR');
    out.addSampler(hs).addChannel(tgt.createAnimationChannel().setTargetNode(tNodes.get('Bip01 Pelvis')!).setTargetPath('translation').setSampler(hs));
    console.log(`  ${ours.padEnd(12)} ${dur.toFixed(2)} s, ${frames} frames, speed ${speed.toFixed(2)} m/s`);
  }
  void pelvisRestLocal;
  await io.write(outPath, tgt);
  writeFileSync(outPath.replace(/\.glb$/, '.clips.json'), JSON.stringify(meta, null, 1));
  console.log('wrote', outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
