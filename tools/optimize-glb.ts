/**
 * Optimises a glTF/GLB for the game: dedup, prune, weld, resample animations, KTX2 textures (UASTC, mipmaps,
 * Zstandard; colour maps sRGB), quantized attributes and meshopt compression.
 *
 *   pnpm tsx tools/optimize-glb.ts <in.glb|gltf> <out.glb> [--maxtex 1024] [--simplify 0.5] [--noanim]
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample, quantize, meshopt, weld, textureCompress, simplify, flatten, join as joinMeshes } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { ktx2 } from 'ktx2-encoder/gltf-transform';
import sharp from 'sharp';

const args = process.argv.slice(2);
const [inPath, outPath] = args;
const opt = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const maxTex = Number(opt('maxtex', '1024'));
const maxAux = Number(opt('maxaux', String(maxTex)));
const simp = Number(opt('simplify', '0'));

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(inPath);
const before = doc.getRoot().listTextures().map((t) => t.getSize());

const imageDecoder = async (buffer: Uint8Array) => {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
};

const steps = [dedup(), prune()];
if (args.includes('--flatten')) steps.push(flatten(), joinMeshes());
steps.push(weld());
if (simp > 0) steps.push(simplify({ simplifier: MeshoptSimplifier, ratio: simp, error: 0.002 }));
if (!args.includes('--noanim')) steps.push(resample());
await doc.transform(...steps);
// textures: resize, then KTX2
await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'png', resize: [maxAux, maxAux], slots: /^(normal|metallicRoughness|occlusion)/ }));
await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'png', resize: [maxTex, maxTex] }));
await doc.transform(ktx2({ isUASTC: true, generateMipmap: true, needSupercompression: true, enableRDO: true, rdoQualityLevel: 1.5, imageDecoder } as never));
await doc.transform(quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
await io.write(outPath, doc);
const tris = doc.getRoot().listMeshes().reduce((a, m) => a + m.listPrimitives().reduce((b, p) => b + (p.getIndices()?.getCount() ?? 0) / 3, 0), 0);
console.log(`wrote ${outPath}: ${doc.getRoot().listMeshes().length} meshes, ${tris.toFixed(0)} tris, textures ${before.map((s) => s?.join('x')).join(' ')} -> max ${maxTex}, ${doc.getRoot().listAnimations().length} animations`);
