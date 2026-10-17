// Inspect a delivered GLB: nodes, primitives, attributes, UV ranges, materials, textures.
//   node tools/blender/jungle/inspect.mjs <file.glb>
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  let line = `${node.getName()}:`;
  const t = node.getTranslation(), r = node.getRotation(), s = node.getScale();
  if (t.some((v) => v !== 0) || r[3] !== 1 || s.some((v) => v !== 1)) line += ` [transform! t=${t} r=${r} s=${s}]`;
  for (const p of mesh.listPrimitives()) {
    const idx = p.getIndices();
    const tris = idx ? idx.getCount() / 3 : p.getAttribute('POSITION').getCount() / 3;
    const attrs = p.listSemantics().map((sem) => {
      const a = p.getAttribute(sem);
      return `${sem}:${a.getType()}/${a.getComponentType()}${a.getNormalized() ? 'n' : ''}`;
    });
    const pos = p.getAttribute('POSITION');
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    const v = [0, 0, 0];
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, v);
      for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], v[k]); mx[k] = Math.max(mx[k], v[k]); }
    }
    const col = p.getAttribute('COLOR_0');
    let cstat = '';
    if (col) {
      const c = [0, 0, 0, 0];
      const lo = [9, 9, 9, 9], hi = [-9, -9, -9, -9], sum = [0, 0, 0, 0];
      for (let i = 0; i < col.getCount(); i++) {
        col.getElement(i, c);
        for (let k = 0; k < col.getElementSize(); k++) { lo[k] = Math.min(lo[k], c[k]); hi[k] = Math.max(hi[k], c[k]); sum[k] += c[k]; }
      }
      cstat = ` COLOR_0 min ${lo.map((x) => x.toFixed(2))} max ${hi.map((x) => x.toFixed(2))} mean ${sum.map((x) => (x / col.getCount()).toFixed(2))}`;
    }
    line += `\n   prim mat=${p.getMaterial()?.getName()} verts=${pos.getCount()} tris=${tris} bbox=[${mn.map((x) => x.toFixed(2))}]..[${mx.map((x) => x.toFixed(2))}] ${attrs.join(' ')}${cstat}`;
  }
  console.log(line);
}
for (const m of root.listMaterials()) {
  const tex = (t) => (t ? `${t.getName() || t.getURI()} ${t.getSize()?.join('x')} ${t.getMimeType()}` : '-');
  console.log(`material ${m.getName()}: alpha=${m.getAlphaMode()} cutoff=${m.getAlphaCutoff()} doubleSided=${m.getDoubleSided()} metal=${m.getMetallicFactor()} rough=${m.getRoughnessFactor()}`);
  console.log(`   base=${tex(m.getBaseColorTexture())} normal=${tex(m.getNormalTexture())} mr=${tex(m.getMetallicRoughnessTexture())} occ=${tex(m.getOcclusionTexture())}`);
}
