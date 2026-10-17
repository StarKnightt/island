"""Generate layouts/cliff_coast.json: an assembled test coast (pieces at 2.5x-5x along a waterline, faces toward -Y in
Blender = +Z glTF), a sea plane at z = 0 and a vegetated plateau behind. Plain Python: python make_coast.py"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
lods = json.load(open('E:/tmp/island/helpers/rocks/work/cliff_lods.json'))


def bb(name):
    """Blender-space bbox (x, y, z) of a piece at scale 1 from the glTF bbox."""
    g = lods[name]['bbox_gltf']
    return ([g['min'][0], -g['max'][2], g['min'][1]], [g['max'][0], -g['min'][2], g['max'][1]])


# (piece, scale, y offset (+ = further inland), z offset of the base line, overlap with the previous piece in m)
seq = [('cliff_d', 4.0, -22, -1.5, 0), ('cliff_c', 4.5, 0, -2.0, 14), ('cliff_a', 5.0, 4, -2.5, 12),
       ('cliff_e', 4.0, 8, -2.0, 16), ('cliff_g', 4.6, -2, -2.0, 18), ('cliff_b', 4.2, -10, -1.5, 22)]
items = []
x = 0.0
for i, (n, s, y, z, ov) in enumerate(seq):
    mn, mx = bb(n)
    w0, w1 = mn[0] * s, mx[0] * s
    if i:
        x -= ov
    cx = x - w0
    items.append(dict(obj=f'{n}_lod0', s=s, x=round(cx, 2), y=y, z=z, yaw=0))
    x = cx + w1
total = x
for it in items:
    it['x'] = round(it['x'] - total / 2, 2)
# low ledge blocks at the foot of the sea-cave face and the undercut face
xc = {it['obj']: it['x'] for it in items}
items += [dict(obj='cliff_f_lod0', s=2.5, x=round(xc['cliff_c_lod0'] + 18, 2), y=-24, z=-1.2, yaw=8),
          dict(obj='cliff_f_lod0', s=2.0, x=round(xc['cliff_g_lod0'] - 30, 2), y=-20, z=-1.0, yaw=-14)]
sun_front = -270.8
lay = dict(tag='cliff_coast', sea=True, sea_z=0.0, items=items,
           plateau=dict(z=31.0, y0=20.0, color=[0.075, 0.09, 0.04]),
           views={
               'offshore': dict(cam=[0, -330, 10], at=[0, 0, 22], lens=30, hdri_rot=sun_front),
               'boat': dict(cam=[-70, -120, 5], at=[-40, 0, 18], lens=28, hdri_rot=sun_front),
               'oblique': dict(cam=[-260, -150, 25], at=[10, 0, 18], lens=35, hdri_rot=sun_front),
               'backlit': dict(cam=[0, -330, 10], at=[0, 0, 22], lens=30, hdri_rot=-75.8, hdri_strength=0.45,
                               sun=[8, 195, 3.5]),
           })
json.dump(lay, open(os.path.join(HERE, 'cliff_coast.json'), 'w'), indent=1)
print('coast width', round(total, 1), 'm;', [(it['obj'], it['x']) for it in items])
