/**
 * Builds the hero GLB from the retargeted Rocketbox avatar (tools/retarget.ts output) with the repainted beach outfit
 * (tools/char/paint_outfit.ts) in place of the body albedo, then optimises it like every other asset:
 *
 *   pnpm tsx tools/char/build_hero.ts <hero_anim.glb> <body_beach.png> <tmp.glb>
 *   pnpm tsx tools/optimize-glb.ts <tmp.glb> public/assets/character/hero.glb --maxtex 1024
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { readFileSync } from 'node:fs';

const [inPath, bodyPath, outPath] = process.argv.slice(2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inPath);
const body = doc.getRoot().listTextures().find((t) => t.getName() === 'm002_body_color');
if (!body) throw new Error('no m002_body_color texture');
body.setImage(new Uint8Array(readFileSync(bodyPath))).setMimeType('image/png');
await io.write(outPath, doc);
console.log('wrote', outPath);
