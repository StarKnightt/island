/**
 * Loosely typed TSL entry point for shader graphs. @types/three types node graphs very strictly (vec3 vs color
 * unions and so on), which is noise for shader code; game logic stays typed.
 */
import * as TSLTyped from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TSL = TSLTyped as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type N = any;

export const {
  abs, acos, add, asin, atan, attribute, billboarding, bool, builtinAOContext, cameraFar, cameraNear, cameraPosition,
  cameraProjectionMatrix, cameraProjectionMatrixInverse, cameraViewMatrix, cameraWorldMatrix, clamp, color, cos,
  cross, cubeTexture, dFdx, dFdy, degrees, depth, diffuseColor, directionToColor, colorToDirection, distance, div, dot,
  emissive, equirectUV, exp, exp2, faceDirection, float, floor, fog, fract, frontFacing, Fn, fwidth, getScreenPosition,
  hash, If, instanceIndex, instancedArray, int, interleavedGradientNoise, inverseSqrt, ivec2, length, linearDepth,
  log, log2, Loop, luminance, materialReference, max, min, mix, mod, modelNormalMatrix, modelPosition,
  modelViewMatrix, modelWorldMatrix, modelWorldMatrixInverse, mrt, mul, mx_fractal_noise_float, mx_noise_float,
  mx_noise_vec3, mx_worley_noise_float, negate, normalize, normalLocal, normalMap, normalView, normalWorld,
  normalWorldGeometry, objectPosition, oneMinus, output, pass, perspectiveDepthToViewZ, PI, pmremTexture, positionGeometry,
  positionLocal, positionView, positionViewDirection, positionWorld, positionWorldDirection, pow, radians, reflect,
  reflectVector, refract, remap, renderOutput, round, rtt, saturate, screenCoordinate, screenSize, screenUV, select,
  sign, sin, smoothstep, sqrt, step, storage, sub, tan, texture, texture3D, textureLoad, textureStore, time,
  transformNormalToView, transformedNormalView, transformedNormalWorld, TWO_PI, uint, uniform, uniformArray, uv, varying,
  vec2, vec3, vec4, velocity, vertexIndex, viewportDepthTexture, viewportLinearDepth, viewportSharedTexture, viewportUV,
  workgroupArray, workgroupBarrier, workgroupId, localId, getViewPosition, mat3, transpose, cameraViewMatrixInverse,
  textureBicubic, triplanarTexture, packNormalToRGB, unpackRGBToNormal, globalId, positionWorldDirection: posWorldDir,
  shadow: tslShadow, lights, viewportCoordinate, premultiplyAlpha, Discard, Return, Break, Continue, sampler, bitcast,
  modelViewProjection, ceil, trunc, lengthSq, all, any, not, equal, notEqual, greaterThan, lessThan, convertToTexture, sample,
} = TSL;
