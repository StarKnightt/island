/**
 * The round 7 drone flight (`pnpm flyover`): one continuous camera path over the island, as keyframes in time.
 * Position, look target and lens are each a natural cubic spline in time (C2: no jumps in speed or acceleration);
 * the height is splined in log space, so climbs and descents ease in and out as the opening dive of the old trailer
 * does (slow near the ground, fast high up). The roll banks gently into turns (from the path's own lateral
 * acceleration, a fixed-wing feel, capped at a few degrees). The time of day runs on a monotone curve: early
 * afternoon over the cliffs, the canopy and the falls (the gorge is lit only while the sun is high, and a lower sun
 * in the west glares off the pool straight into the lens), then a time-lapse through the afternoon and the sunset while
 * the camera is high over the island, dusk turning to night over the village.
 */
import * as THREE from 'three';

interface Key { t: number; p: [number, number, number]; look: [number, number, number]; fov: number }

/** sea level is 0; log-height splines use ln(y + Y0) */
const Y0 = 25;

export const KEYS: Key[] = [
  // 1. low over the sea off the north cliffs, flying east along the 60-80 m walls, the surf columns at their foot
  { t: 0.0, p: [-317, 15.6, -670], look: [-226, 26, -615], fov: 52 },
  { t: 2.0, p: [-268, 16, -671], look: [-176, 28, -618], fov: 52 },
  { t: 5.0, p: [-185, 21, -668], look: [-95, 34, -606], fov: 52 },
  // 2. up and over the cliff top, banking south over the plateau's canopy toward the falls valley
  { t: 7.0, p: [-118, 48, -650], look: [-30, 70, -560], fov: 54 },
  { t: 9.0, p: [-45, 118, -560], look: [80, 70, -380], fov: 56 },
  { t: 11.5, p: [90, 140, -330], look: [200, 50, -140], fov: 56 },
  // 3. slowing over a gap in the crowns north of the pool (crown-free from 9 m above the ground to the canopy top:
  //    planned on the plants' own meshes) and dropping straight down through it into the green haze
  { t: 13.5, p: [196, 110, -150], look: [217, 45, -100], fov: 56 },
  { t: 15.0, p: [215, 96, -110], look: [217, 40, -96], fov: 57 },
  { t: 16.0, p: [217.3, 84, -102.8], look: [200, 52, -102], fov: 58 },
  { t: 17.0, p: [217.5, 66, -102.5], look: [198, 49, -103], fov: 60 },
  { t: 18.0, p: [217, 53, -102.5], look: [198, 47, -103], fov: 62 },
  // 4. gliding 7-14 m over the forest floor between the trunks and the tree ferns, out into the open gorge
  { t: 18.8, p: [213.5, 50.2, -102.6], look: [201.5, 45, -102.6], fov: 62 },
  { t: 19.25, p: [209.5, 48.5, -104.4], look: [197.5, 46, -98.8], fov: 62 },
  { t: 19.6, p: [205.5, 45.5, -104.5], look: [193.5, 48.5, -96.6], fov: 62 },
  { t: 19.95, p: [201.5, 45.5, -102.6], look: [189.5, 49.7, -94.6], fov: 62 },
  { t: 20.4, p: [197.5, 47.5, -98.8], look: [185.5, 49.3, -93.2], fov: 62 },
  { t: 20.8, p: [193.5, 51.4, -96.6], look: [183.4, 48.3, -89.5], fov: 62 },
  { t: 21.15, p: [189.5, 52.4, -94.6], look: [182.6, 47.5, -85.5], fov: 62 },
  { t: 21.5, p: [185.5, 50.8, -93.2], look: [182.4, 47.3, -81.5], fov: 62 },
  { t: 21.85, p: [183.4, 49.8, -89.5], look: [179.6, 47.1, -77.6], fov: 62 },
  { t: 22.2, p: [182.6, 49, -85.5], look: [175.6, 47.7, -76], fov: 62 },
  { t: 22.55, p: [182.4, 48.8, -81.5], look: [172.6, 49, -72.5], fov: 62 },
  { t: 22.95, p: [179.6, 48.6, -77.6], look: [172.4, 49.5, -68.5], fov: 62 },
  { t: 23.35, p: [175.6, 49.2, -76], look: [170, 49, -62], fov: 61 },
  { t: 23.75, p: [172.6, 50.5, -72.5], look: [165, 48, -56], fov: 60 },
  { t: 24.1, p: [172.4, 51, -68.5], look: [156, 48, -55], fov: 59 },
  { t: 24.45, p: [172.2, 51.5, -64.5], look: [150, 49, -55], fov: 58 },
  // 5. low along the pool's east edge, about 6 m over the water, the falls and the foam of the plunge pool across it
  //    (from 10 m up or over the pool, within ~20 m of the plunge, its foam reads as one white sheet), then lifting
  //    over the rim
  { t: 24.8, p: [175, 49, -61.5], look: [147, 45, -55], fov: 58 },
  { t: 25.7, p: [178.5, 44.8, -55.5], look: [147, 45, -54], fov: 58 },
  { t: 26.6, p: [180.5, 45, -46], look: [147, 45, -52], fov: 58 },
  { t: 27.5, p: [176, 62, -39], look: [140, 52, -40], fov: 58 },
  { t: 28.6, p: [165, 100, -8], look: [90, 70, 80], fov: 58 },
  // 6. high and fast south-west over the south hill and out over the sea off the village cove, the sun going down
  { t: 30.5, p: [60, 175, 150], look: [-150, 60, 380], fov: 56 },
  { t: 32.6, p: [-160, 140, 400], look: [-400, 30, 470], fov: 54 },
  // 7. curving in from the sea toward the village as dusk becomes night: the jetty, the lamps, the huts, the peak
  //    behind with the lighthouse's soft beam
  { t: 34.8, p: [-345, 58, 500], look: [-455, 8, 330], fov: 52 },
  { t: 36.8, p: [-438, 38, 430], look: [-452, 6, 330], fov: 52 },
  { t: 38.8, p: [-458, 62, 330], look: [-390, 110, 40], fov: 52 },
  // 8. lifting over the roofs and up the island toward the summit, settling wide on the lighthouse from high above
  //    it, looking down (level with the lamp the beam sweeps straight into the lens; looking out to the horizon, the
  //    far night sea is a black band)
  { t: 40.8, p: [-440, 150, 190], look: [-320, 190, -240], fov: 50 },
  { t: 42.8, p: [-420, 330, 60], look: [-305, 205, -290], fov: 48 },
  { t: 44.3, p: [-395, 435, -15], look: [-300, 215, -300], fov: 48 },
];

/** the last key's time: the camera eases from cruising to a slow drift over the last SETTLE s of the video, so the
 *  video runs a little longer than the keys */
const LAST = KEYS[KEYS.length - 1].t;
const SETTLE = 3;
/** flight time (the keys' clock) at video time t: 1:1, then slowing to 20 % */
function flight(t: number) {
  const t0 = LAST - 0.6 * SETTLE;
  if (t <= t0) return t;
  // integral of 1 - 0.8 smoothstep((u - t0) / SETTLE) from t0 to t
  const x = Math.min((t - t0) / SETTLE, 1);
  const S = x ** 3 - x ** 4 / 2;
  return t0 + (t - t0) - 0.8 * SETTLE * S - (t > t0 + SETTLE ? 0.8 * (t - t0 - SETTLE) : 0);
}
/** video length: where the flight clock reaches the last key */
export const DURATION = (() => {
  let t = LAST;
  while (flight(t) < LAST) t += 1 / 600;
  return Math.round(t * 60) / 60;
})();

/** time of day (hours) against video time (s): monotone cubic (no overshoot, no reversal) */
const TOD: [number, number][] = [
  [0, 12.4], [12.5, 12.7], [26.5, 13.0], [29.5, 14.2], [32.6, 16.6], [34.8, 17.85], [38.8, 18.2], [45.5, 18.38],
];

/** natural cubic spline through (x_i, y_i): second derivatives */
function natural(x: number[], y: number[]) {
  const n = x.length, m = new Array(n).fill(0), u = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const sig = (x[i] - x[i - 1]) / (x[i + 1] - x[i - 1]);
    const p = sig * m[i - 1] + 2;
    m[i] = (sig - 1) / p;
    u[i] = (y[i + 1] - y[i]) / (x[i + 1] - x[i]) - (y[i] - y[i - 1]) / (x[i] - x[i - 1]);
    u[i] = ((6 * u[i]) / (x[i + 1] - x[i - 1]) - sig * u[i - 1]) / p;
  }
  m[n - 1] = 0;
  for (let k = n - 2; k >= 0; k--) m[k] = m[k] * m[k + 1] + u[k];
  return (t: number) => {
    let k = 0;
    while (k < n - 2 && t > x[k + 1]) k++;
    const h = x[k + 1] - x[k], a = (x[k + 1] - t) / h, b = (t - x[k]) / h;
    return a * y[k] + b * y[k + 1] + ((a * a * a - a) * m[k] + (b * b * b - b) * m[k + 1]) * (h * h) / 6;
  };
}

/** monotone cubic (Fritsch-Carlson) */
function monotone(pts: [number, number][]) {
  const n = pts.length, x = pts.map((p) => p[0]), y = pts.map((p) => p[1]);
  const d = x.slice(0, -1).map((_, i) => (y[i + 1] - y[i]) / (x[i + 1] - x[i]));
  const m = x.map((_, i) => (i === 0 ? d[0] : i === n - 1 ? d[n - 2] : d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const tau = 3 / Math.sqrt(s); m[i] = tau * a * d[i]; m[i + 1] = tau * b * d[i]; }
  }
  return (t: number) => {
    const tt = THREE.MathUtils.clamp(t, x[0], x[n - 1]);
    let k = 0;
    while (k < n - 2 && tt > x[k + 1]) k++;
    const h = x[k + 1] - x[k], s = (tt - x[k]) / h;
    const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s, h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
    return h00 * y[k] + h10 * h * m[k] + h01 * y[k + 1] + h11 * h * m[k + 1];
  };
}

const T = KEYS.map((k) => k.t);
const px = natural(T, KEYS.map((k) => k.p[0]));
const pz = natural(T, KEYS.map((k) => k.p[2]));
const py = natural(T, KEYS.map((k) => Math.log(k.p[1] + Y0)));
const lx = natural(T, KEYS.map((k) => k.look[0]));
const ly = natural(T, KEYS.map((k) => k.look[1]));
const lz = natural(T, KEYS.map((k) => k.look[2]));
const fv = natural(T, KEYS.map((k) => k.fov));
export const hour = monotone(TOD);

export function position(t: number) {
  return new THREE.Vector3(px(t), Math.exp(py(t)) - Y0, pz(t));
}

/** the bank (radians, positive rolls right) from the turn rate of the heading times the ground speed, as a
 *  coordinated turn would lean (scaled down to a gentle fraction of that, capped), averaged over 0.8 s */
function bankAt(t: number) {
  let s = 0, w = 0;
  for (let k = -8; k <= 8; k++) {
    const u = t + k * 0.1, e = 0.05;
    const a = position(u - e), b = position(u), c = position(u + e);
    const v1 = new THREE.Vector2(b.x - a.x, b.z - a.z), v2 = new THREE.Vector2(c.x - b.x, c.z - b.z);
    const speed = (v1.length() + v2.length()) / (2 * e);
    if (v1.length() < 1e-4 || v2.length() < 1e-4) continue;
    const turn = Math.atan2(v1.x * v2.y - v1.y * v2.x, v1.dot(v2)) / e;
    const lean = Math.atan((speed * turn) / 9.81) * 0.1;
    const wt = Math.cos((k / 9) * (Math.PI / 2));
    s += lean * wt;
    w += wt;
  }
  // (a soft limit: the bank rounds off toward 3.4 degrees instead of flattening at it)
  return 0.06 * Math.tanh((w ? s / w : 0) / 0.06);
}

export function pose(video: number) {
  const t = flight(video);
  const pos = position(t);
  const target = new THREE.Vector3(lx(t), ly(t), lz(t));
  const roll = bankAt(t);
  // the camera's up, rolled about the view direction (lookAt uses it)
  const fwd = target.clone().sub(pos).normalize();
  const up = new THREE.Vector3(0, 1, 0).applyAxisAngle(fwd, -roll);
  return { pos, target, fov: fv(t), up, roll, hour: hour(video) };
}
