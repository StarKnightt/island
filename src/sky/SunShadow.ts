/**
 * The sun's shadow term for every receiver: the cascaded shadow map (near detail), times the shadows of the
 * clouds overhead (at any distance, also beyond the last cascade), times the terrain's own shadow at a low sun
 * (the heightfield marched toward the sun, so ridges throw long shadows across the island at sunrise and sunset).
 * Only direct sunlight is shadowed; sky light and bounce are untouched.
 */
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { positionWorld, float, type N } from '../core/tsl';

type Factor = (p: N) => N;
const factors: Factor[] = [];

/** register an extra occlusion of direct sunlight (cloud shadow, terrain shadow) */
export function addSunOcclusion(f: Factor) {
  factors.push(f);
}

export class SunShadowNode extends CSMShadowNode {
  /** shadow-map size per cascade (near to far); the outer cascades cover far more ground where texels can be coarser,
   * and their fill (alpha-tested leaf cards, many times over) is most of the shadow cost. Unset: the light's size. */
  mapSizes: number[] = [];

  setup(builder: unknown) {
    let s = (super.setup as (b: unknown) => N)(builder);
    // (the cascade lights exist from the first setup on; each render resizes its map to its shadow's mapSize)
    const lights = (this as unknown as { lights: { shadow: { mapSize: { set: (w: number, h: number) => void } } }[] }).lights;
    lights.forEach((l, i) => {
      const m = this.mapSizes[i];
      if (m) l.shadow.mapSize.set(m, m);
    });
    let k: N = float(1);
    for (const f of factors) k = k.mul(f(positionWorld));
    s = s.mul(k);
    return s;
  }
}
