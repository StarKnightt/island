/**
 * The round 7 update video, second cut (`pnpm flyover-v2`): five separate shots joined by short dissolves, each a
 * straight, slow move (forward, sideways or a rise) with a fixed lens, eased in and out. Positions are world metres
 * (sea level 0); hours as TimeOfDay takes them. Heights were set against the baked heightfield (scripts/_probe.ts).
 */
export interface Shot {
  name: string;
  /** seconds */
  dur: number;
  from: { pos: number[]; target: number[] };
  to: { pos: number[]; target: number[] };
  fov: number;
  hour: [number, number];
  /** exposure multiplier on the game's metering for this shot */
  bias: number;
}

/** frames of dissolve between consecutive shots */
export const XFADE = 12;

export const SHOTS: Shot[] = [
  // 1. up the river toward the falls at eye height (1.8 m over the water), under the canopy, the falls ahead
  {
    name: 'jungle', dur: 8, fov: 60, hour: [13.0, 13.0], bias: 1,
    from: { pos: [232, 34.6, -52.6], target: [146.5, 47, -55] },
    to: { pos: [212, 36.6, -48.3], target: [146.5, 47.5, -55] },
  },
  // 2. the falls and the clear pool from the outflow, trucking slowly sideways with the falls held in frame
  {
    name: 'pool', dur: 9, fov: 58, hour: [12.8, 12.8], bias: 1,
    from: { pos: [186, 41.5, -43.5], target: [147, 46.5, -54] },
    to: { pos: [182, 41.5, -50.5], target: [147, 46.5, -56] },
  },
  // 3. low over the sea along the north cliffs, the surf and the spray at their foot
  {
    name: 'cliffs', dur: 7, fov: 52, hour: [12.6, 12.6], bias: 1,
    from: { pos: [-305, 16, -670], target: [-214, 27, -615] },
    to: { pos: [-250, 17, -670], target: [-159, 28, -615] },
  },
  // 4. the west shore at golden hour: rising from just over the beach above the shore trees, looking out to sea
  {
    name: 'rise', dur: 6, fov: 55, hour: [17.25, 17.35], bias: 1,
    from: { pos: [-745, 7, 175], target: [-1130, 9, 80] },
    to: { pos: [-752, 30, 173], target: [-1137, 18, 78] },
  },
  // 5. the golden beach, gliding toward the sea as the sun goes down into it; ends on the sun on the horizon
  {
    name: 'sunset', dur: 9, fov: 55, hour: [17.45, 17.74], bias: 1,
    from: { pos: [-748, 14, 190], target: [-1150, 4, 88] },
    to: { pos: [-776, 10, 183], target: [-1150, 2, 88] },
  },
];

/** sine ease in and out: starts and stops at rest */
const ease = (u: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, u)));
const lerp3 = (a: number[], b: number[], k: number) => a.map((v, i) => v + (b[i] - v) * k);

/** the camera of a shot at t seconds into it */
export function shotPose(s: Shot, t: number) {
  const k = ease(t / s.dur);
  return {
    pos: lerp3(s.from.pos, s.to.pos, k), target: lerp3(s.from.target, s.to.target, k), fov: s.fov, up: [0, 1, 0],
    hour: s.hour[0] + (s.hour[1] - s.hour[0]) * (t / s.dur), bias: s.bias,
  };
}

/** where each shot starts in the cut (s): the dissolves overlap consecutive shots */
export function shotStarts(fps: number) {
  const out: number[] = [];
  let t = 0;
  for (const s of SHOTS) {
    out.push(t);
    t += s.dur - XFADE / fps;
  }
  return out;
}

export function cutLength(fps: number) {
  const st = shotStarts(fps);
  return st[st.length - 1] + SHOTS[SHOTS.length - 1].dur;
}
