import * as THREE from 'three/webgpu';
import { cameraViewMatrix, mrt, normalize, packNormalToRGB, vec4, type N } from './tsl';

/**
 * The weight of the ambient occlusion per pixel (the scene pass's `aow` target, read by Engine): opaque surfaces
 * write 1; it is blended premultiplied, so a transparent surface that writes (0, cover) leaves w * (1 - cover). GTAO
 * sees only the opaque depth: over the falls the occlusion is the rock's, behind the water, and it darkened the white
 * sheet in blocks with a hard edge across it.
 */
export const aoWeightBlend = (() => {
  const b = new THREE.BlendMode(THREE.CustomBlending);
  b.blendSrc = THREE.OneFactor;
  b.blendDst = THREE.OneMinusSrcAlphaFactor;
  b.blendSrcAlpha = THREE.OneFactor;
  b.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  return b;
})();

/** MRT output of a transparent surface that hides `cover` (0..1) of the occlusion of what is behind it */
export function aoCoverMRT(cover: N | number) {
  return mrt({ aow: vec4(0, 0, 0, cover) });
}

/**
 * MRT outputs for a transparent effect (spray, mist, rain, smoke): the scene pass's normal target is not blended, so
 * whatever an effect writes there replaces the surface behind it for the ambient occlusion (a square or a ring round
 * every puff). An effect writes the world's up instead, as the character's effects do; `cover` fades the occlusion
 * out under it by its own opacity.
 */
export function effectMRT(cover: N | number = 0) {
  return mrt({ normal: packNormalToRGB(normalize(cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz)), aow: vec4(0, 0, 0, cover) });
}
