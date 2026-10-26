import { cameraViewMatrix, mrt, normalize, packNormalToRGB, vec4 } from './tsl';

/**
 * MRT outputs for a transparent effect (spray, mist, rain, smoke): the scene pass's normal target is not blended, so
 * whatever an effect writes there replaces the surface behind it for the ambient occlusion (a square or a ring round
 * every puff). An effect writes the world's up instead, as the character's effects do.
 */
export function effectMRT() {
  return mrt({ normal: packNormalToRGB(normalize(cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz)) });
}
