/**
 * Is the sun's disc in view, or hidden behind the island, its trees and its buildings? A small invisible sphere kept
 * 1.5 km out toward the sun, drawn after the opaque scene with a GPU occlusion query: the exposure for shooting into a
 * low sun applies only when there is a sun to shoot into (a sunset behind a palm grove or a gorge wall is exposed for
 * the land and the sky that are there, not for a glare that is not).
 *
 * The query's result is read while the main view renders (three keeps it per render context); it arrives a frame or
 * two late, which the smoothing hides. Until the probe's pipeline exists the sun counts as visible.
 */
import * as THREE from 'three/webgpu';

const DIST = 1500;
/** angular radius of the probe: about twice the sun's, so a sun peeking past a trunk still counts */
const RADIUS = (0.5 * Math.PI) / 180;

let probe: THREE.Mesh | null = null;
let mainCamera: THREE.Camera | null = null;
let occluded = false;
let seen = 1;
const camPos = new THREE.Vector3();

export function initSunProbe(scene: THREE.Scene) {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorWrite = false;
  m.depthWrite = false;
  // (transparent: drawn after the opaque scene, so the depth test sees the land, the trees and the houses)
  m.transparent = true;
  m.fog = false;
  probe = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), m);
  (probe as unknown as { occlusionTest: boolean }).occlusionTest = true;
  probe.frustumCulled = false;
  probe.renderOrder = 1000;
  probe.name = 'sun-probe';
  probe.onBeforeRender = (renderer, _scene, camera) => {
    if (camera === mainCamera && probe) occluded = (renderer as unknown as THREE.WebGPURenderer).isOccluded(probe);
  };
  scene.add(probe);
}

/** how visible the sun's disc was in the last frames, 0..1 */
export const sunVisibility = () => seen;

/** per frame: keep the probe toward the sun from the view camera; returns how visible the sun is, 0..1 (smoothed) */
export function updateSunProbe(camera: THREE.Camera | null, sun: THREE.Vector3, dt: number) {
  if (!probe || !camera) return 1;
  mainCamera = camera;
  camera.getWorldPosition(camPos);
  probe.position.copy(camPos).addScaledVector(sun, DIST);
  probe.scale.setScalar(DIST * Math.tan(RADIUS));
  probe.visible = sun.y > -0.05;
  const target = probe.visible && !occluded ? 1 : 0;
  seen += (target - seen) * (1 - Math.exp(-Math.min(dt, 0.1) * 4));
  return seen;
}
