/**
 * Builds the optimised game assets from the raw downloads in E:\tmp\island\raw (pnpm assets:fetch).
 *
 *   pnpm assets:build terrain     terrain layer textures -> public/assets/terrain/*.ktx2
 *   pnpm assets:build tex         prop / building / bark material textures -> public/assets/tex/*.ktx2
 *
 * Textures are packed into two RGBA maps per material (albedo + height; normal XY + roughness + AO), resized to
 * 1024 (or 512), their albedo normalised to a measured target (so every surface sits at a believable PBR albedo),
 * then encoded to KTX2 (UASTC + Zstandard, with mipmaps) by ktx2-encoder (Basis Universal, WebAssembly, one thread).
 */
import sharp from 'sharp';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { encodeToKTX2 } from 'ktx2-encoder';

const RAW = 'E:\\tmp\\island\\raw\\polyhaven\\tex';
const OUT = join(import.meta.dirname, '..', 'public', 'assets');

/** target mean albedo (linear) per layer: measured-plausible values for each surface */
export const TERRAIN_LAYERS: { id: string; src: string; target: [number, number, number] }[] = [
  { id: 'sand_dry', src: 'aerial_beach_01', target: [0.5, 0.44, 0.34] },
  { id: 'sand_wet', src: 'damp_beach_sand', target: [0.25, 0.215, 0.165] },
  { id: 'jungle', src: 'leaves_forest_ground', target: [0.085, 0.065, 0.04] },
  { id: 'grass', src: 'leafy_grass', target: [0.085, 0.13, 0.035] },
  { id: 'dirt', src: 'dirt_floor', target: [0.2, 0.11, 0.06] },
  { id: 'rock', src: 'dark_rock_02', target: [0.055, 0.052, 0.05] },
  { id: 'moss', src: 'mossy_rock', target: [0.075, 0.085, 0.05] },
  { id: 'reef', src: 'coral_ground_02', target: [0.34, 0.29, 0.21] },
];

export const PROP_TEXTURES: { id: string; src: string; target?: [number, number, number]; size?: number }[] = [
  { id: 'thatch', src: 'thatch_roof_angled', target: [0.2, 0.15, 0.08] },
  { id: 'bamboo', src: 'bamboo_wall', target: [0.3, 0.24, 0.13] },
  { id: 'planks', src: 'weathered_planks', target: [0.2, 0.17, 0.13] },
  { id: 'planks_blue', src: 'blue_painted_planks' },
  { id: 'planks_grey', src: 'wood_planks_grey', target: [0.2, 0.18, 0.15] },
  { id: 'plaster', src: 'white_plaster_rough_01', target: [0.62, 0.6, 0.55] },
  { id: 'wood', src: 'rough_wood', target: [0.18, 0.13, 0.09] },
  { id: 'paint_wood', src: 'wood_peeling_paint_weathered' },
  { id: 'rust', src: 'rusty_painted_metal' },
  { id: 'bark', src: 'bark_willow_02', target: [0.16, 0.13, 0.1] },
  { id: 'bark_smooth', src: 'fever_tree_bark', target: [0.25, 0.22, 0.17] },
  { id: 'stone', src: 'stone_wall', target: [0.3, 0.29, 0.27] },
  { id: 'coral_stone', src: 'coral_stone_wall', target: [0.45, 0.42, 0.36] },
];

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

async function load(path: string, size: number, channels: 1 | 3) {
  const img = sharp(path).resize(size, size, { kernel: 'lanczos3' });
  const { data } = await (channels === 1 ? img.greyscale().raw() : img.removeAlpha().raw()).toBuffer({ resolveWithObject: true });
  return data;
}

async function encode(rgba: Uint8Array, size: number, srgb: boolean, out: string, height = size) {
  const png = await sharp(Buffer.from(rgba), { raw: { width: size, height, channels: 4 } }).png().toBuffer();
  const ktx = await encodeToKTX2(new Uint8Array(png), {
    isUASTC: true,
    generateMipmap: true,
    needSupercompression: true,
    enableRDO: true,
    rdoQualityLevel: 1.2,
    isSetKTX2SRGBTransferFunc: srgb,
    isPerceptual: srgb,
    imageDecoder: async (buf: Uint8Array) => {
      const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data: new Uint8Array(data), width: info.width, height: info.height };
    },
  } as Parameters<typeof encodeToKTX2>[1]);
  writeFileSync(out, ktx);
  return ktx.length;
}

/** pack one material into <id>_a.ktx2 (albedo + height) and <id>_n.ktx2 (normal xy, roughness, AO) */
async function packMaterial(src: string, id: string, outDir: string, size: number, target?: [number, number, number]) {
  const dir = join(RAW, src);
  const diff = await load(join(dir, 'Diffuse.jpg'), size, 3);
  const hgtPath = existsSync(join(dir, 'Displacement.png')) ? join(dir, 'Displacement.png') : join(dir, 'Displacement.jpg');
  const hgt = existsSync(hgtPath) ? await load(hgtPath, size, 1) : null;
  const nor = await load(join(dir, 'nor_gl.png'), size, 3);
  const rough = await load(join(dir, 'Rough.jpg'), size, 1);
  const aoPath = join(dir, 'AO.jpg');
  const ao = existsSync(aoPath) ? await load(aoPath, size, 1) : null;
  const n = size * size;
  // albedo normalisation in linear space: scale each channel so the mean hits the target
  let gain = [1, 1, 1];
  if (target) {
    const mean = [0, 0, 0];
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) mean[c] += toLin(diff[i * 3 + c] / 255);
    for (let c = 0; c < 3; c++) mean[c] /= n;
    gain = mean.map((m, c) => target[c] / Math.max(m, 1e-4));
  }
  let hMin = 255, hMax = 0;
  if (hgt) for (let i = 0; i < n; i++) {
    hMin = Math.min(hMin, hgt[i]);
    hMax = Math.max(hMax, hgt[i]);
  }
  const a = new Uint8Array(n * 4), b = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) a[i * 4 + c] = Math.round(Math.min(1, toSrgb(Math.min(1, toLin(diff[i * 3 + c] / 255) * gain[c]))) * 255);
    a[i * 4 + 3] = hgt ? Math.round(((hgt[i] - hMin) / Math.max(1, hMax - hMin)) * 255) : 128;
    b[i * 4] = nor[i * 3];
    b[i * 4 + 1] = nor[i * 3 + 1];
    b[i * 4 + 2] = rough[i];
    b[i * 4 + 3] = ao ? ao[i] : 255;
  }
  mkdirSync(outDir, { recursive: true });
  const s1 = await encode(a, size, true, join(outDir, `${id}_a.ktx2`));
  const s2 = await encode(b, size, false, join(outDir, `${id}_n.ktx2`));
  console.log(`  ${id.padEnd(12)} <- ${src.padEnd(28)} gain ${gain.map((g) => g.toFixed(2)).join(',')}  ${(s1 / 1024).toFixed(0)} + ${(s2 / 1024).toFixed(0)} KB`);
}

/** generated foliage (tools/gen_foliage.py) -> KTX2: colour+alpha maps and normal maps */
async function foliage() {
  const SRC = 'E:/tmp/island/foliage';
  const dir = join(OUT, 'foliage');
  mkdirSync(dir, { recursive: true });
  const color = async (name: string, w: number, h: number) => {
    const { data } = await sharp(join(SRC, `${name}.png`)).resize(w, h, { kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const sz = await encode(new Uint8Array(data), w, true, join(dir, `${name}.ktx2`), h);
    console.log(`  ${name} ${w}x${h} ${(sz / 1024).toFixed(0)} KB`);
  };
  const normalFromHeight = async (name: string, src: string, w: number, h: number, strength: number) => {
    const { data } = await sharp(join(SRC, `${src}.png`)).resize(w, h).greyscale().raw().toBuffer({ resolveWithObject: true });
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const at = (xx: number, yy: number) => data[((yy + h) % h) * w + ((xx + w) % w)] / 255;
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength, dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const o = (y * w + x) * 4;
      out[o] = Math.round((-dx / l * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((dy / l * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
      out[o + 3] = 255;
    }
    const sz = await encode(out, w, false, join(dir, `${name}.ktx2`), h);
    console.log(`  ${name} ${w}x${h} ${(sz / 1024).toFixed(0)} KB`);
  };
  const normal = async (name: string, w: number, h: number) => {
    const { data } = await sharp(join(SRC, `${name}.png`)).resize(w, h).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const sz = await encode(new Uint8Array(data), w, false, join(dir, `${name}.ktx2`), h);
    console.log(`  ${name} ${w}x${h} ${(sz / 1024).toFixed(0)} KB`);
  };
  await color('palm_frond', 2048, 1024);
  await color('banana_leaf', 1024, 512);
  await color('canopy', 1024, 1024);
  await normal('canopy_n', 1024, 1024);
  await color('palm_bark', 512, 1024);
  await normalFromHeight('palm_bark_n', 'palm_bark_h', 512, 1024, 4);
  await color('grass', 512, 512);
}

async function main() {
  const what = process.argv[2] ?? 'terrain';
  if (what === 'terrain' || what === 'all') {
    console.log('terrain layers:');
    for (const L of TERRAIN_LAYERS) await packMaterial(L.src, L.id, join(OUT, 'terrain'), 1024, L.target);
    writeFileSync(join(OUT, 'terrain', 'layers.json'), JSON.stringify(TERRAIN_LAYERS.map((l) => l.id)));
  }
  if (what === 'foliage' || what === 'all') {
    console.log('foliage:');
    await foliage();
  }
  if (what === 'tex' || what === 'all') {
    console.log('material textures:');
    for (const T of PROP_TEXTURES) await packMaterial(T.src, T.id, join(OUT, 'tex'), T.size ?? 1024, T.target);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
