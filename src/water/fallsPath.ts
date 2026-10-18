/**
 * The falls' ballistic path, shared by the water (River.ts builds its sheets on it) and the rock behind it
 * (RockKit.ts keeps the gorge wall clear of it): the water leaves the lip at `V0` and falls freely, the sheet widening
 * as it drops and bowing out in the middle, its edges trailing a little.
 */
import * as THREE from 'three/webgpu';
import type { Heightfield } from '../world/Heightfield';

const V0 = 2.2;

const smoothstep01 = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

export function fallsPath(hf: Heightfield) {
  const { falls } = hf.meta;
  const [lx, lz] = falls.lip, [tx, tz] = falls.toward;
  const dx = tx - lx, dz = tz - lz, dl = Math.hypot(dx, dz);
  const fx = dx / dl, fz = dz / dl;
  const nx = -fz, nz = fx;
  const top = falls.top + 0.55, bottom = falls.bottom;
  const W = falls.width + 2.4;
  const tFall = Math.sqrt((2 * (top - bottom)) / 9.81);
  return {
    lx, lz, fx, fz, nx, nz, top, bottom, W, tFall,
    /** metres out from the lip where the water lands */
    outEnd: 0.35 + V0 * tFall,
    /** a point of a sheet: u across (-0.5..0.5), f down (0 at the lip .. 1 at the pool); `offset` moves the sheet out
     *  from the lip (a veil in front), `widen` is how much wider it is at the bottom */
    point(u: number, f: number, offset = 0, widen = 0.35, out = new THREE.Vector3()) {
      const t = f * tFall;
      // the lip is rounded: the water curls over it before it falls free
      const o = 0.35 + V0 * t + offset * smoothstep01(f * 6) + (0.25 - u * u) * 0.9 * f;
      const y = top - 0.5 * 9.81 * t * t + (f < 0.05 ? 0.12 * (1 - f / 0.05) : 0);
      const across = u * W * (1 + widen * Math.pow(f, 1.4));
      return out.set(lx + fx * o + nx * across, y, lz + fz * o + nz * across);
    },
  };
}
