"""Preview renders of a kit under the daylight HDRI (Cycles GPU, denoised), saved to E:/tmp/island/helpers/rocks/previews.

  blender --background --factory-startup -t 6 --python preview.py -- <kit_lods.blend> <layout.json> <view>[,<view>...] [samples]

layout.json: {"sea": true, "ground": [r, g, b] or null, "items": [{"obj": "cliff_a_lod0", "s": 4, "x": 0, "y": 0,
"z": 0, "yaw": 0}, ...], "views": {"name": {"cam": [x, y, z], "at": [x, y, z], "lens": 35, "hdri_rot": 0,
"sun": [elev_deg, azim_deg, strength] (optional extra low sun), "hdri_strength": 1.0}}}
Blender axes: the cliff faces look toward -Y, so 'offshore' cameras sit at negative y.
"""
import os
import sys
import json
import math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import rocklib as R  # noqa: E402

args = R.args_after_dashes()
blend, layout_path, views = args[0], args[1], args[2].split(',')
samples = int(args[3]) if len(args) > 3 else 64
lay = json.load(open(layout_path))
OUT = R.WORK + '/previews'
os.makedirs(OUT, exist_ok=True)
tag = lay.get('tag', os.path.splitext(os.path.basename(layout_path))[0])

bpy.ops.wm.open_mainfile(filepath=blend)
scene = bpy.context.scene
src = {o.name: o for o in scene.objects}
for o in src.values():
    o.hide_render = True
    o.hide_viewport = True
# pieces of other kits (their <kit>_lods.blend), so one layout can mix cliffs, stacks, shelves and boulders
for eb in lay.get('extra_blends', []):
    with bpy.data.libraries.load(eb, link=False) as (dfrom, dto):
        dto.objects = [n for n in dfrom.objects if n not in src]
    src.update({o.name: o for o in dto.objects if o is not None})
for it in lay['items']:
    s = src[it['obj']]
    o = s.copy()
    scene.collection.objects.link(o)
    o.hide_render = False
    o.hide_viewport = False
    sc = it.get('s', 1.0)
    o.scale = (sc, sc, sc)
    o.location = (it.get('x', 0), it.get('y', 0), it.get('z', 0))
    o.rotation_euler = (0, 0, math.radians(it.get('yaw', 0)))
    # low-poly + smooth normals: avoid Cycles' faceted shadow-terminator artefacts (a real-time renderer shows none)
    o.shadow_terminator_geometry_offset = 0.5
    o.shadow_terminator_shading_offset = 0.15

if lay.get('sea', False):
    bpy.ops.mesh.primitive_plane_add(size=6000, location=(0, 0, lay.get('sea_z', 0.0)))
    sea = bpy.context.active_object
    m = bpy.data.materials.new('sea')
    m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (0.010, 0.040, 0.050, 1)
    b.inputs['Roughness'].default_value = 0.06
    sea.data.materials.append(m)
if lay.get('plateau'):
    # vegetated land behind a cliff line: a flat top at z from y0 inland
    # (a solid block: dark rock-coloured front wall like the terrain's own cliff, a green top)
    pl = lay['plateau']
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, pl['y0'] + 1500, (pl['z'] - 40) / 2))
    p = bpy.context.active_object
    p.scale = (4000, 3000, pl['z'] + 40)
    p.data.materials.append(R.solid_material('plateau_rock', tuple(pl.get('wall', [0.05, 0.047, 0.042])), rough=0.9))
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, pl['y0'] + 1500 - 2, pl['z'] + 0.25))
    t = bpy.context.active_object
    t.scale = (4000, 3000, 0.5)
    t.data.materials.append(R.solid_material('plateau', tuple(pl['color']), rough=0.95))
if lay.get('beach'):
    # sloping sand beach: height z0 at y = y0, rising inland (+y) by 'slope' per metre, continuing under the sea
    # up to 'y_flat', then a flat backshore (so the slope does not become a wall on the horizon)
    bc = lay['beach']
    y0, z0, sl = bc['y0'], bc['z0'], bc.get('slope', 0.06)
    yf = bc.get('y_flat', y0 + 40)
    ys_ = [-400.0, yf, 3000.0]
    zs_ = [z0 + (-400.0 - y0) * sl, z0 + (yf - y0) * sl, z0 + (yf - y0) * sl]
    vs = [(x, y, z) for (y, z) in zip(ys_, zs_) for x in (-3000.0, 3000.0)]
    me = bpy.data.meshes.new('beach')
    me.from_pydata(vs, [], [(0, 1, 3, 2), (2, 3, 5, 4)])
    b = bpy.data.objects.new('beach', me)
    scene.collection.objects.link(b)
    b.data.materials.append(R.solid_material('beach', tuple(bc.get('color', [0.36, 0.31, 0.24])), rough=0.95))
if lay.get('ground'):
    bpy.ops.mesh.primitive_plane_add(size=6000, location=(0, 0, lay.get('ground_z', 0.0)))
    g = bpy.context.active_object
    g.data.materials.append(R.solid_material('ground', tuple(lay['ground']), rough=0.95))
for p in lay.get('props', []):
    # simple scale reference: a 1.8 m dark figure
    bpy.ops.mesh.primitive_cylinder_add(radius=0.25, depth=1.8, location=(p[0], p[1], p[2] + 0.9))
    bpy.context.active_object.data.materials.append(R.solid_material('fig', (0.05, 0.05, 0.06)))

R.gpu_cycles(scene, samples=samples)
scene.cycles.use_denoising = True
try:
    scene.cycles.denoiser = 'OPENIMAGEDENOISE'
except Exception:
    pass
scene.view_settings.view_transform = 'AgX'
try:
    scene.view_settings.look = 'AgX - Base Contrast'
except Exception:
    pass
scene.render.resolution_x = lay.get('res', [1600, 900])[0]
scene.render.resolution_y = lay.get('res', [1600, 900])[1]
scene.render.film_transparent = False
world = None
sun = None
for vn in views:
    v = lay['views'][vn]
    world = R.setup_world_hdri(scene, strength=v.get('hdri_strength', 1.0), rot_deg=v.get('hdri_rot', 0.0))
    if sun:
        bpy.data.objects.remove(sun)
        sun = None
    if v.get('sun'):
        el, az, st = v['sun']
        sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
        sun.data.energy = st
        sun.data.angle = math.radians(0.6)
        sun.data.color = tuple(v.get('sun_color', (1.0, 0.85, 0.65)))
        scene.collection.objects.link(sun)
        sun.rotation_euler = (math.radians(90 - el), 0, math.radians(az))
    R.add_camera(scene, v['cam'], v['at'], lens=v.get('lens', 35), name='cam_' + vn)
    scene.render.filepath = f'{OUT}/{tag}_{vn}.png'
    bpy.ops.render.render(write_still=True)
    R.log('rendered', scene.render.filepath)
