import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

/**
 * Room for at least this many instances. three r186 keeps the matrices of an instanced mesh in a uniform buffer
 * named after that mesh and sized to it while they fit the device's uniform-buffer limit (64 KB: 1024 matrices),
 * which makes each such mesh's vertex shader unique: one more pipeline to compile at start-up per mesh (two hundred
 * of them, most of the load). Past the limit they are instanced vertex attributes and the code is the same for all.
 */
export const SHARED_INSTANCES = 1025;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TSL = TSLTyped as any;
const buffers = new WeakMap<THREE.BufferAttribute, THREE.InstancedInterleavedBuffer>();

/**
 * Even with identical shaders, three r186 still builds the node graph of every instanced mesh on its own (the mesh's
 * uuid is part of its render cache key, because its instance node owns that mesh's buffer): ~15 ms of main thread per
 * mesh, four hundred of them at start-up, for shaders it then finds it already has. A shared-instancing mesh reads its
 * matrices from named per-instance attributes of its own geometry (`iM0`..`iM3`, resolved per draw like any vertex
 * attribute) instead, applied by the `setupPosition` hook below where three would apply its own instancing; with
 * three's instancing switched off on it and one uuid for all of them in the render-object lookup (Engine), meshes of
 * the same material and vertex layout share one build.
 */
export function shareInstancing(mesh: THREE.InstancedMesh) {
  const im = mesh.instanceMatrix;
  let ib = buffers.get(im);
  if (!ib) {
    ib = new THREE.InstancedInterleavedBuffer(im.array as Float32Array, 16, 1);
    buffers.set(im, ib);
  }
  const src = mesh.geometry;
  const g = new THREE.BufferGeometry();
  g.setIndex(src.index);
  for (const [name, a] of Object.entries(src.attributes)) g.setAttribute(name, a);
  for (const gr of src.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
  g.drawRange = { ...src.drawRange };
  g.boundingBox = src.boundingBox;
  g.boundingSphere = src.boundingSphere;
  g.name = src.name;
  for (let k = 0; k < 4; k++) g.setAttribute(`iM${k}`, new THREE.InterleavedBufferAttribute(ib, 4, k * 4));
  mesh.geometry = g;
  (mesh as unknown as { isInstancedMesh: boolean }).isInstancedMesh = false;
  mesh.userData.sharedInstancing = true;
  const buf = ib;
  const before = mesh.onBeforeRender;
  // the callers keep writing mesh.instanceMatrix (needsUpdate, update ranges): hand that on to the attribute buffer
  mesh.onBeforeRender = function (...args) {
    if (buf.version !== im.version) {
      buf.clearUpdateRanges();
      for (const r of im.updateRanges) buf.addUpdateRange(r.start, r.count);
      im.clearUpdateRanges();
      buf.version = im.version;
    }
    before.apply(this, args);
  };
  return mesh;
}

{
  const proto = THREE.NodeMaterial.prototype as unknown as { setupPosition(builder: unknown): unknown };
  const setupPosition = proto.setupPosition;
  proto.setupPosition = function (builder: { geometry: THREE.BufferGeometry; needsPreviousData(): boolean; hasGeometryAttribute(n: string): boolean }) {
    if (builder.geometry?.getAttribute('iM0')) {
      const m = TSL.mat4(TSL.attribute('iM0', 'vec4'), TSL.attribute('iM1', 'vec4'), TSL.attribute('iM2', 'vec4'), TSL.attribute('iM3', 'vec4'));
      TSL.positionLocal.assign(m.mul(TSL.positionLocal).xyz);
      // the instances do not move between frames: the motion vector is the camera's
      if (builder.needsPreviousData()) TSL.positionPrevious.assign(m.mul(TSL.positionPrevious).xyz);
      if (builder.hasGeometryAttribute('normal')) TSL.normalLocal.assign(TSL.transformNormal(TSL.normalLocal, m));
    }
    return setupPosition.call(this, builder);
  };
}

/** an InstancedMesh that shares its shader with every other one of the same material; `count` is how many are drawn */
export function instancedMesh(geometry: THREE.BufferGeometry, material: THREE.Material, count: number) {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(count, SHARED_INSTANCES));
  mesh.count = count;
  return shareInstancing(mesh);
}
