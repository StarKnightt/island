/**
 * The scene depth as seen by transparent surfaces (water): a viewport depth copy with a float format, matching the
 * scene pass's depth32float (reversed depth), which the default shared depth texture (depth24plus) does not.
 */
import * as THREE from 'three/webgpu';
import { viewportDepthTexture, perspectiveDepthToViewZ, cameraNear, cameraFar, type N } from './tsl';

const depthCopy = new THREE.DepthTexture(1, 1);
depthCopy.type = THREE.FloatType;

/** linear view distance (m, positive) of the opaque scene at a screen uv */
export const sceneViewDepth = (uv: N) => perspectiveDepthToViewZ(viewportDepthTexture(uv, null, depthCopy).x, cameraNear, cameraFar).negate();
