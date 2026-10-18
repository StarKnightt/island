// temporary: trace the cliff coasts of the baked island and print waterline, kind and cliff-top height
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { COAST, HALF_WORLD, HEIGHT_RES, H_MAX, H_MIN, MASK_RES, WORLD_SIZE } from '../src/world/layout';

const N = HEIGHT_RES, M = MASK_RES;
const planes = gunzipSync(readFileSync('public/world/height.bin.gz'));
const H = new Float32Array(N * N);
const scale = (H_MAX - H_MIN) / 65535;
let prevRowStart = 0;
for (let j = 0; j < N; j++) {
  let prev = j > 0 ? prevRowStart : 0;
  for (let i = 0; i < N; i++) {
    const k = j * N + i;
    const d = planes[k] | (planes[N * N + k] << 8);
    const v = (prev + d) & 0xffff;
    if (i === 0) prevRowStart = v;
    H[k] = H_MIN + v * scale;
    prev = v;
  }
}
const sh = gunzipSync(readFileSync('public/world/shore.bin.gz'));
const s16 = new Uint16Array(sh.buffer, sh.byteOffset, sh.byteLength / 2);
const S = new Float32Array(s16.length);
for (let i = 0; i < s16.length; i++) S[i] = s16[i] / 32 - 1024;
const m1 = gunzipSync(readFileSync('public/world/mask1.bin.gz'));
const height = (x: number, z: number) => {
  const fx = x + HALF_WORLD - 0.5, fz = z + HALF_WORLD - 0.5;
  const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, k = j * N + i;
  const a = H[k], b = H[k + 1], c = H[k + N], d = H[k + N + 1];
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
};
const cell = WORLD_SIZE / M;
const shore = (x: number, z: number) => {
  const fx = (x + HALF_WORLD) / cell - 0.5, fz = (z + HALF_WORLD) / cell - 0.5;
  const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, k = j * M + i;
  const a = S[k], b = S[k + 1], c = S[k + M], d = S[k + M + 1];
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
};
const kindAt = (x: number, z: number) => m1[(Math.floor((z + HALF_WORLD) / cell) * M + Math.floor((x + HALF_WORLD) / cell)) * 4 + 3] / 255;
const pts = [...COAST, COAST[0]];
let out = '';
for (let s = 0; s < pts.length - 1; s++) {
  const a = pts[s], b = pts[s + 1];
  if (a.kind < 1.4 && b.kind < 1.4) continue;
  const L = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]);
  for (let t = 0; t < L; t += 25) {
    let x = a.p[0] + ((b.p[0] - a.p[0]) * t) / L, z = a.p[1] + ((b.p[1] - a.p[1]) * t) / L;
    let gx = 0, gz = 0;
    for (let it = 0; it < 4; it++) {
      const d = shore(x, z);
      gx = (shore(x + 2, z) - shore(x - 2, z)) / 4;
      gz = (shore(x, z + 2) - shore(x, z - 2)) / 4;
      const g = Math.hypot(gx, gz) || 1;
      x -= (d * gx) / (g * g);
      z -= (d * gz) / (g * g);
    }
    const g = Math.hypot(gx, gz) || 1;
    const nx = -gx / g, nz = -gz / g; // seaward
    const tops = [6, 12, 20, 35].map((d) => height(x - nx * d, z - nz * d).toFixed(0));
    out += `${s} ${x.toFixed(0)},${z.toFixed(0)} kind ${kindAt(x, z).toFixed(2)} n ${nx.toFixed(2)},${nz.toFixed(2)} h@6/12/20/35 ${tops.join('/')} sea@10 ${height(x + nx * 10, z + nz * 10).toFixed(1)}\n`;
  }
}
console.log(out);
