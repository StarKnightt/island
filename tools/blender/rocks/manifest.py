"""Write public/assets/rocks/rocks.json from the kit exports (plain Python, no Blender needed).

  python manifest.py <kit.json> [<kit.json> ...]

Per kit config: reads work/<kit>_lods.json (nodes, triangles, glTF bounding boxes written by the export step) and,
for cliff pieces, work/<piece>.json (prep metadata). Kits whose export does not exist yet are skipped, so the
manifest can be rebuilt after every delivery. All boxes are glTF metres at scale 1 (Y up; cliff faces look toward +Z).
"""
import os
import sys
import json

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = 'E:/tmp/island/helpers/rocks/work'
OUT = 'c:/Code/island/public/assets/rocks/rocks.json'


def r3(v):
    return [round(float(x), 3) for x in v]


man = {
    'version': 1,
    'units': 'metres, glTF Y-up, scale 1',
    'material_note': 'all kits share one palette (dark grey basalt, weathered planes, rust stains, grey-green lichen); '
                     'albedo is de-lit; ORM = R ambient occlusion, G roughness, B metalness 0',
    'kits': {},
    'pieces': {},
}
for path in sys.argv[1:]:
    cfg = json.load(open(path if os.path.isabs(path) else os.path.join(HERE, path)))
    kit = cfg['kit']
    lods_path = f'{WORK}/{kit}_lods.json'
    if not os.path.exists(lods_path):
        print('skip (not exported yet):', kit)
        continue
    lods = json.load(open(lods_path))
    K = cfg.get('manifest', {})
    man['kits'][kit] = dict(file=cfg['file'], material=f"{cfg.get('family', 'rock')}_{kit}",
                            textures=K.get('textures'), notes=K.get('notes'))
    for P in cfg['pieces']:
        name = P['name']
        L = lods[name]
        lod_keys = sorted(k for k in L if k.startswith('lod'))
        e = dict(kit=kit, file=cfg['file'],
                 nodes=[L[k]['node'] for k in lod_keys], tris=[L[k]['tris'] for k in lod_keys],
                 bbox=dict(min=r3(L['bbox_gltf']['min']), max=r3(L['bbox_gltf']['max'])),
                 scale=P.get('scale', K.get('scale')), use=P.get('use'), type=P.get('type', K.get('type')))
        pj = f'{WORK}/{name}.json'
        if kit == 'cliff' and os.path.exists(pj):
            pm = json.load(open(pj))
            mn, mx = e['bbox']['min'], e['bbox']['max']
            e.update(face_width=round(mx[0] - mn[0], 2), top_height=round(mx[1], 2), base_y=0.0,
                     bottom_y=round(mn[1], 2), face_dir='+Z', source_scan=pm['scan'])
        for k in ('lod_dist', 'bury', 'notes', 'source_scan'):
            if k in P:
                e[k] = P[k]
        man['pieces'][name] = e
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(man, open(OUT, 'w'), indent=1)
print('wrote', OUT, len(man['pieces']), 'pieces')
