/**
 * Which lights a material evaluates. The renderer shades every light in the scene in every lit fragment, wherever
 * it is, so the lamps of the village and the lighthouse would cost the whole island's foliage (most of the frame's
 * overdraw) all day for light that only falls within a few tens of metres of them. Plants, the far canopy and the
 * cliffs see the sun and moon only; the ground, the sea, the buildings and the player see the lamps too.
 */
import type * as THREE from 'three/webgpu';
import { lights, type N } from './tsl';

let sunOnly: N = null;

/** call once, before the plant and rock materials are made */
export function setSunLight(sun: THREE.DirectionalLight) {
  sunOnly = lights([sun]);
}

/** give a material the sun (or moon) as its only direct light */
export function sunLit<T extends THREE.Material>(m: T): T {
  if (sunOnly) (m as unknown as { lightsNode: N }).lightsNode = sunOnly;
  return m;
}
