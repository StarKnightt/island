/**
 * Repaints the Rocketbox Male_Adult_01 body albedo into beach clothes, keeping the scan's folds and weave:
 *   striped polo -> washed olive tee (the stripes closed away by a grey-scale morphological closing, the folds kept)
 *   khaki chinos  -> navy board shorts with a pale side stripe
 *   grey canvas sneakers -> sand-dusted oatmeal canvas
 * Colours avoid the warm-red range the skin shader reads as skin (heroMaterials.ts masks skin from the albedo).
 *
 *   pnpm tsx tools/char/paint_outfit.ts <body_color.jpg> <out.png>
 */
import sharp from 'sharp';

const [inPath, outPath] = process.argv.slice(2);
const { data, info } = await sharp(inPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, S = W / 2048;
const px = (x: number, y: number) => (y * W + x) * 3;
const toLin = (c: number) => Math.pow(c / 255, 2.2);
const toS = (l: number) => Math.round(255 * Math.pow(Math.min(1, Math.max(0, l)), 1 / 2.2));

type Rect = [number, number, number, number];
const inR = (x: number, y: number, rs: Rect[]) => rs.some(([x0, y0, x1, y1]) => x >= x0 * S && x < x1 * S && y >= y0 * S && y < y1 * S);
const SHORTS: Rect[] = [[0, 0, 600, 520], [1440, 0, 2048, 520]];
const SHIRT: Rect[] = [[650, 40, 1400, 1790], [0, 880, 640, 1290], [1410, 880, 2048, 1290]];
const SHOES: Rect[] = [[420, 1420, 880, 2048], [1200, 1420, 1660, 2048]];

const lum = new Float32Array(W * H);
for (let i = 0; i < W * H; i++) lum[i] = 0.2126 * toLin(data[i * 3]) + 0.7152 * toLin(data[i * 3 + 1]) + 0.0722 * toLin(data[i * 3 + 2]);

/** separable square max / min filter of radius r (in place into a copy) */
function filt(src: Float32Array, r: number, max: boolean) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const pick = max ? Math.max : Math.min;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = src[y * W + x];
    for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < W) v = pick(v, src[y * W + xx]); }
    tmp[y * W + x] = v;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = tmp[y * W + x];
    for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < H) v = pick(v, tmp[yy * W + x]); }
    out[y * W + x] = v;
  }
  return out;
}
function blur(src: Float32Array, r: number) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < W) { s += src[y * W + xx]; n++; } }
    tmp[y * W + x] = s / n;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < H) { s += tmp[yy * W + x]; n++; } }
    out[y * W + x] = s / n;
  }
  return out;
}

// the shirt: bright fabric with dark stripes; the background is near black, so the closing only runs on fabric
const shirtMask = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = y * W + x;
  const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const skin = (r - b) / (mx + 1) > 0.22 && (r - g) / (mx + 1) > 0.14 && mx > 150;
  if (inR(x, y, SHIRT) && mx > 18 && !skin) shirtMask[i] = 1;
}
// stripes are ~8-12 px at 2048: a closing of radius 9 removes them, folds (much wider) survive
const R = Math.round(12 * S);
const masked = Float32Array.from(lum, (v, i) => (shirtMask[i] ? v : 0));
const closed = blur(filt(filt(masked, R, true), R, false), Math.max(1, Math.round(2 * S)));
// fold shading relative to the local mean (so the tee keeps its creases but not the old fabric's brightness)
const mean = blur(closed, Math.round(60 * S));

// hash noise for a little slub in the cotton
const hash = (x: number, y: number) => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

const out = Buffer.from(data);
const TEE = [0.15, 0.155, 0.088]; // washed olive (linear)
const NAVY = [0.022, 0.036, 0.075];
const CANVAS = [0.50, 0.44, 0.33];
const SOLE = [0.62, 0.58, 0.50];

for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = y * W + x, o = px(x, y);
  const r = data[o], g = data[o + 1], b = data[o + 2];
  const mx = Math.max(r, g, b);
  if (mx < 10) continue;
  const L = lum[i];
  if (shirtMask[i]) {
    const fold = Math.min(1.5, Math.max(0.62, closed[i] / Math.max(1e-3, mean[i])));
    const n = 1 + (hash(x >> 1, y >> 2) - 0.5) * 0.06;
    // the polo's dark collar band inside the neck: a little darker fabric
    const collar = L < 0.03 && closed[i] < 0.05 ? 0.82 : 1;
    const k = (collar < 1 ? 0.8 : Math.pow(fold, 1.2)) * n;
    // the sun has faded the tee unevenly: lighter over the shoulders (top of each panel)
    out[o] = toS(TEE[0] * k); out[o + 1] = toS(TEE[1] * k); out[o + 2] = toS(TEE[2] * k);
    continue;
  }
  if (inR(x, y, SHORTS)) {
    const skin = (r - g) / (mx + 1) > 0.2 && mx > 120;
    if (skin) continue;
    // fold shading from the khaki's own luminance against its typical value
    const k = Math.min(1.6, Math.max(0.3, L / 0.32));
    out[o] = toS(NAVY[0] * k); out[o + 1] = toS(NAVY[1] * k); out[o + 2] = toS(NAVY[2] * k);
    continue;
  }
  if (inR(x, y, SHOES)) {
    const sat = (mx - Math.min(r, g, b)) / (mx + 1);
    if (sat > 0.25) continue; // skin of the hands nearby
    const bright = L > 0.35;
    const c = bright ? SOLE : CANVAS;
    const k = bright ? Math.min(1.2, L / 0.6) : Math.min(1.8, Math.max(0.35, L / 0.06));
    const dust = 1 + (hash(x, y) - 0.5) * 0.12;
    out[o] = toS(c[0] * k * dust); out[o + 1] = toS(c[1] * k * dust); out[o + 2] = toS(c[2] * k * dust);
  }
}
await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toFile(outPath);
console.log('wrote', outPath, W, H);
