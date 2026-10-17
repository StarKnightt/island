/** shader uniforms driven by the weather system, shared by every material that gets wet */
import * as THREE from 'three/webgpu';
import { uniform } from '../core/tsl';

export const wetness = {
  /** 0 dry .. 1 soaked (surfaces facing the sky) */
  rain: uniform(0),
  /** 0..1 rain intensity right now (ripples, streaks) */
  intensity: uniform(0),
  /** wind direction (xz, normalised) and strength 0..1 */
  windDir: uniform(new THREE.Vector2(0.8, 0.6)),
  wind: uniform(0.3),
  /** seconds, for animated surface effects */
  time: uniform(0),
};
