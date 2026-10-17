"""Pack the lod0 UVs of every piece of a kit into ONE shared atlas (uniform texel density across pieces).

  blender --background --factory-startup -t 6 --python atlas_pack.py -- <pieces.json> [skirt_uv_scale]

Reads work/<piece>.blend (from prep.py), appends every <piece>_lod0, averages island scale over all of them (same
texel density everywhere), shrinks the buried skirt islands, packs, and writes work/<piece>_uv.npy (loop UVs, the
bake step loads them) plus work/<kit>_kit.blend (all packed lod0 meshes, used by the LOD / export step).
"""
import os
import sys
import json
import time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import rocklib as R  # noqa: E402

args = R.args_after_dashes()
cfg = json.load(open(args[0]))
SKIRT_UV = float(args[1]) if len(args) > 1 else 0.3
KIT = cfg['kit']
W = R.WORK + '/work'
names = [p['name'] for p in cfg['pieces']]

R.reset_scene()
scene = bpy.context.scene
objs = []
for n in names:
    with bpy.data.libraries.load(f'{W}/{n}.blend', link=False) as (src, dst):
        dst.objects = [f'{n}_lod0']
    o = dst.objects[0]
    scene.collection.objects.link(o)
    objs.append(o)
scene.tool_settings.use_uv_select_sync = True


def edit_all():
    if bpy.context.view_layer.objects.active is not None and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_mode(type='FACE')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')


edit_all()
bpy.ops.uv.average_islands_scale()
bpy.ops.object.mode_set(mode='OBJECT')
for o in objs:
    me = o.data
    uv = np.empty(len(me.loops) * 2, np.float32)
    me.uv_layers.active.data.foreach_get('uv', uv)
    uv = uv.reshape(-1, 2)
    sk = np.zeros(len(me.polygons), np.int32)
    me.attributes['skirt'].data.foreach_get('value', sk)
    ls = np.empty(len(me.polygons), np.int32)
    lt = np.empty(len(me.polygons), np.int32)
    me.polygons.foreach_get('loop_start', ls)
    me.polygons.foreach_get('loop_total', lt)
    sel = np.zeros(len(me.loops), bool)
    for a, t, s in zip(ls, lt, sk):
        if s:
            sel[a:a + t] = True
    uv[sel] *= SKIRT_UV
    me.uv_layers.active.data.foreach_set('uv', uv.ravel())
    me.update()
edit_all()
MARGIN = float(os.environ.get('MARGIN', '0.0015'))
SHAPE = os.environ.get('SHAPE', 'CONCAVE')
t0 = time.time()
bpy.ops.uv.pack_islands(rotate=True, scale=True, margin_method='FRACTION', margin=MARGIN, shape_method=SHAPE)
R.log('packed', SHAPE, 'margin', MARGIN, round(time.time() - t0, 1), 's')
bpy.ops.object.mode_set(mode='OBJECT')
used = 0.0
for o in objs:
    me = o.data
    uv = np.empty(len(me.loops) * 2, np.float32)
    me.uv_layers.active.data.foreach_get('uv', uv)
    np.save(f'{W}/{o.name}_uv.npy', uv.reshape(-1, 2))
    uvr = uv.reshape(-1, 2)
    R.log(o.name, 'uv range', uvr.min(0).round(4), uvr.max(0).round(4))
    # UV area used
    me.calc_loop_triangles()
    lt = np.empty(len(me.loop_triangles) * 3, np.int32)
    me.loop_triangles.foreach_get('loops', lt)
    t = uvr[lt.reshape(-1, 3)]
    a = np.abs(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])) * 0.5
    used += a.sum()
    R.log(o.name, 'uv area', round(float(a.sum()), 4))
R.log('total uv coverage', round(float(used), 3))
bpy.ops.wm.save_as_mainfile(filepath=f'{W}/{KIT}_kit.blend', compress=False)
R.log('saved', f'{W}/{KIT}_kit.blend')
