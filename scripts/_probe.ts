// temporary: print a height map around a point of the baked island
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { HALF_WORLD, HEIGHT_RES, H_MAX, H_MIN } from '../src/world/layout';

const N = HEIGHT_RES;
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
const height = (x: number, z: number) => H[Math.round(z + HALF_WORLD - 0.5) * N + Math.round(x + HALF_WORLD - 0.5)];
const [x0, x1, z0, z1, st] = process.argv.slice(2).map(Number);
let hdr = '      ';
for (let x = x0; x <= x1; x += st) hdr += String(x).padStart(5);
console.log(hdr);
for (let z = z0; z <= z1; z += st) {
  let row = String(z).padStart(6);
  for (let x = x0; x <= x1; x += st) row += height(x, z).toFixed(0).padStart(5);
  console.log(row);
}
