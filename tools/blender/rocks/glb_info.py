"""Print the nodes, meshes (triangles, bounds), materials and images of a GLB (plain Python, no Blender).

  python glb_info.py <file.glb>
"""
import sys
import json
import struct

path = sys.argv[1]
data = open(path, 'rb').read()
magic, ver, total = struct.unpack_from('<III', data, 0)
assert magic == 0x46546C67, 'not a GLB'
ln, typ = struct.unpack_from('<II', data, 12)
doc = json.loads(data[20:20 + ln])
acc = doc.get('accessors', [])
print(path, round(len(data) / 1e6, 2), 'MB', 'extensions', doc.get('extensionsUsed'))
for i, n in enumerate(doc.get('nodes', [])):
    m = doc['meshes'][n['mesh']] if 'mesh' in n else None
    tris, bmin, bmax, attrs = 0, None, None, set()
    if m:
        for p in m['primitives']:
            attrs |= set(p['attributes'])
            if 'indices' in p:
                tris += acc[p['indices']]['count'] // 3
            a = acc[p['attributes']['POSITION']]
            bmin, bmax = a.get('min'), a.get('max')
    xf = {k: n[k] for k in ('translation', 'rotation', 'scale', 'matrix') if k in n}
    mats = sorted({doc['materials'][p['material']]['name'] for p in m['primitives'] if 'material' in p}) if m else []
    rb = (lambda v: [round(x, 2) for x in v]) if bmin else (lambda v: v)
    print(f"  node {n.get('name')}: tris {tris}, mats {mats}, attrs {sorted(attrs)}, min {rb(bmin)} max {rb(bmax)}"
          + (f', xform {xf}' if xf else ''))
for m in doc.get('materials', []):
    print('  material', m['name'], {k: v for k, v in m.items() if k != 'name'})
for im in doc.get('images', []):
    print('  image', im.get('name'), im.get('mimeType'))
