/**
 * Prints the structure of a palm GLB: nodes, triangles per mesh and material, vertex attributes (COLOR_0 ranges),
 * materials (alpha mode, double-sided, texture slots and sizes).
 *   pnpm --dir c:/Code/island exec tsx tools/blender/palms/inspect_glb.ts <file.glb>
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  const t = node.getTranslation(), r = node.getRotation(), s = node.getScale();
  const xf = t.some((v) => v !== 0) || r[3] !== 1 || s.some((v) => v !== 1) ? ` XFORM t=${t} r=${r} s=${s}` : '';
  if (!mesh) { console.log(`node ${node.getName()} (no mesh)${xf}`); continue; }
  const parts = mesh.listPrimitives().map((p) => {
    const tris = (p.getIndices()?.getCount() ?? 0) / 3;
    const col = p.getAttribute('COLOR_0');
    let cr = 'no COLOR_0';
    if (col) {
      const n = col.getCount(), k = col.getElementSize();
      const mn = Array(k).fill(Infinity), mx = Array(k).fill(-Infinity), el: number[] = [];
      for (let i = 0; i < n; i++) { col.getElement(i, el); for (let j = 0; j < k; j++) { mn[j] = Math.min(mn[j], el[j]); mx[j] = Math.max(mx[j], el[j]); } }
      cr = `COLOR_0 vec${k} ${col.getComponentType()}${col.getNormalized() ? ' norm' : ''} min ${mn.map((v) => v.toFixed(2))} max ${mx.map((v) => v.toFixed(2))}`;
    }
    const pos = p.getAttribute('POSITION')!;
    const bb = [pos.getMin([]), pos.getMax([])].map((v) => v.map((x) => x.toFixed(2)).join(','));
    return `${p.getMaterial()?.getName()}: ${tris} tris, ${pos.getCount()} verts, [${p.listSemantics().join(' ')}], ${cr}, bbox ${bb.join(' .. ')}`;
  });
  console.log(`node ${node.getName()}${xf}\n  ${parts.join('\n  ')}`);
}
for (const m of root.listMaterials()) {
  const tex = (name: string, t: ReturnType<typeof m.getBaseColorTexture>) => (t ? `${name}=${t.getName() || t.getURI()} ${t.getSize()?.join('x')} ${t.getMimeType()}` : '');
  console.log(`material ${m.getName()}: alpha ${m.getAlphaMode()} cutoff ${m.getAlphaCutoff()} doubleSided ${m.getDoubleSided()} metal ${m.getMetallicFactor()} rough ${m.getRoughnessFactor()} ` +
    [tex('base', m.getBaseColorTexture()), tex('normal', m.getNormalTexture()), tex('mr', m.getMetallicRoughnessTexture()), tex('occ', m.getOcclusionTexture())].filter(Boolean).join(' '));
}
console.log('extensions', root.listExtensionsUsed().map((e) => e.extensionName).join(' '));
