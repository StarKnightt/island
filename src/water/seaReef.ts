/**
 * The fringing reef that tools/gen-island.ts bakes off the east bay and the south shore (reefWidthAt): how far its
 * crest lies from the main island's shore, by bearing round the island (the same bearing as the surf's along-shore
 * coordinate). The bake roughens the crest by up to ~40 m, so shaders use this only to know where a reef can be and
 * find the crest itself from the bed depth.
 */
import { float, smoothstep, type N } from '../core/tsl';

/** crest distance (m) from the shore for the along-shore coordinate of surf.ts's coast frame; 0 where no reef */
export function reefCrestDist(along: N): N {
  const th = along.div(650).mul(180 / Math.PI);
  const east = smoothstep(-23, -11, th).mul(float(1).sub(smoothstep(10, 21, th)));
  const south = smoothstep(32, 42, th).mul(float(1).sub(smoothstep(72, 88, th)));
  return east.mul(272).add(south.mul(245));
}
