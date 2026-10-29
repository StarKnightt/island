/**
 * The round 7 update video, fifth cut (`pnpm flyover-v2 --cut v5 --name v5 --frames v4 --encode-only`): a re-cut of
 * the v4 render (the third cut's shots) without rendering. The opening is the start of the pool shot's drift, so the
 * pool hold, which began on the same framing, now joins its drift halfway, at the start of its second half.
 */
import { SHOTS as V3 } from './cut-v3';
import { XFADE, shotPose, type Shot } from './cut-v2';

export { XFADE, shotPose, type Shot };

/** seconds of the pool shot's drift the hold leaves out: its first half */
const POOL_SKIP = 4.25;

export const SHOTS: Shot[] = V3.map((s) => (s.name === 'pool' ? { ...s, skip: POOL_SKIP } : s));

const length = (s: Shot) => s.dur - (s.skip ?? 0);

/** where each shot starts in the cut (s): the dissolves overlap consecutive shots */
export function shotStarts(fps: number) {
  const out: number[] = [];
  let t = 0;
  for (const s of SHOTS) {
    out.push(t);
    t += length(s) - XFADE / fps;
  }
  return out;
}

export function cutLength(fps: number) {
  const st = shotStarts(fps);
  return st[st.length - 1] + length(SHOTS[SHOTS.length - 1]);
}
