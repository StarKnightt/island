/**
 * The round 7 update video, third cut (`pnpm flyover-v2 --cut v3`): the second cut opening on the falls and the
 * clear pool (the strongest image, and the one a feed shows as the preview) for two seconds of the pool shot's own
 * drift, then the jungle glide and the rest as before. The glide starts a metre higher: at 1.1 m over the water the
 * near stream filled the bottom of the frame as a dark grazing reflection of the shaded bank.
 */
import { SHOTS as V2, XFADE, shotPose, type Shot } from './cut-v2';

export { XFADE, shotPose, type Shot };

const byName = (n: string) => V2.find((s) => s.name === n)!;
const pool = byName('pool');

/** where the opening starts: the pool shot's framing at this time (matched to the chosen still) */
const OPEN_AT = 0.35;
/** metres the opening drifts, along the pool shot's own move */
const OPEN_DRIFT = 1.2;

const open: Shot = (() => {
  const p = shotPose(pool, OPEN_AT);
  const d = pool.to.pos.map((v, i) => v - pool.from.pos[i]);
  const len = Math.hypot(...d);
  const k = OPEN_DRIFT / len;
  return {
    name: 'open', dur: 2, fov: pool.fov, hour: [p.hour, p.hour], bias: pool.bias,
    from: { pos: p.pos, target: p.target },
    to: {
      pos: p.pos.map((v, i) => v + d[i] * k),
      target: p.target.map((v, i) => v + (pool.to.target[i] - pool.from.target[i]) * k),
    },
  };
})();

const jungle = byName('jungle');

export const SHOTS: Shot[] = [
  open,
  {
    ...jungle,
    from: { pos: [232, 35.6, -52.6], target: [146.5, 48, -55] },
    to: { pos: [212, 37.1, -48.3], target: [146.5, 48, -55] },
  },
  { ...pool, dur: 8.5 },
  byName('cliffs'),
  byName('rise'),
  byName('sunset'),
];

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
