import * as THREE from 'three/webgpu';

/**
 * Room for at least this many instances. three r186 keeps the matrices of an instanced mesh in a uniform buffer
 * named after that mesh and sized to it while they fit the device's uniform-buffer limit (64 KB: 1024 matrices),
 * which makes each such mesh's vertex shader unique: one more pipeline to compile at start-up per mesh (two hundred
 * of them, most of the load). Past the limit they are instanced vertex attributes and the code is the same for all.
 */
export const SHARED_INSTANCES = 1025;

/** an InstancedMesh that shares its shader with every other one of the same material; `count` is how many are drawn */
export function instancedMesh(geometry: THREE.BufferGeometry, material: THREE.Material, count: number) {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(count, SHARED_INSTANCES));
  mesh.count = count;
  return mesh;
}
