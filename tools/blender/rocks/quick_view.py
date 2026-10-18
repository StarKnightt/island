"""Clay render of objects in a .blend from several angles (geometry check).

  blender --background --factory-startup -t 6 --python quick_view.py -- <file.blend> <out_prefix> <obj1,obj2,...>
"""
import os
import sys
import math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import rocklib as R  # noqa: E402

blend, out_prefix, names = R.args_after_dashes()[:3]
names = names.split(',')
bpy.ops.wm.open_mainfile(filepath=blend)
scene = bpy.context.scene
for o in list(scene.objects):
    if o.name not in names:
        o.hide_render = True
clay = R.solid_material('clay', (0.4, 0.4, 0.4))
skirt_mat = R.solid_material('skirtc', (0.6, 0.25, 0.2))
objs = [bpy.data.objects[n] for n in names]
mn = np.array([1e9] * 3)
mx = -mn
for i, o in enumerate(objs):
    o.hide_render = False
    o.data.materials.clear()
    o.data.materials.append(clay)
    o.data.materials.append(skirt_mat)
    if 'skirt' in o.data.attributes:
        sk = np.zeros(len(o.data.polygons), np.int32)
        o.data.attributes['skirt'].data.foreach_get('value', sk)
        o.data.polygons.foreach_set('material_index', sk)
    co, _ = R.mesh_arrays(o)
    mn = np.minimum(mn, co.min(0))
    mx = np.maximum(mx, co.max(0))
R.gpu_cycles(scene, samples=24)
scene.cycles.use_denoising = True
scene.view_settings.view_transform = 'AgX'
world = bpy.data.worlds.new('w')
scene.world = world
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.35, 0.4, 0.5, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.7
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
sun.data.energy = 4.0
scene.collection.objects.link(sun)
sun.rotation_euler = (math.radians(55), 0, math.radians(-140))
# ground plane at z = 0
bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 0, 0))
g = bpy.context.active_object
g.data.materials.append(R.solid_material('ground', (0.25, 0.23, 0.2)))
if os.environ.get('NOGROUND') == '1':
    g.hide_render = True
if os.environ.get('QV_WATER'):
    # flat dark water plane at the given height (shelves: judge how the piece reads at the waterline)
    bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 0, float(os.environ['QV_WATER'])))
    bpy.context.active_object.data.materials.append(R.solid_material('waterc', (0.05, 0.12, 0.15)))
scene.render.resolution_x = 1280
scene.render.resolution_y = 720
c = (mn + mx) / 2
size = float(np.max(mx - mn))
tgt = (c[0], c[1], c[2] * 0.8)
views = dict(fl=(-0.7, -1.0, 0.35), fr=(0.8, -0.9, 0.12), side=(1.0, 0.05, 0.3), top=(0.05, -0.5, 1.4), back=(0.3, 1.0, 0.6))
rad = float(np.linalg.norm(mx - mn)) / 2
for nm, (dx, dy, dz) in views.items():
    # fit the bounding sphere in the vertical field of view (35 mm lens, 16:9: half angle ~16 deg)
    d = max(size * 1.25 + 4, rad / math.sin(math.radians(15.5)))
    d /= math.sqrt(dx * dx + dy * dy + dz * dz)
    d *= float(os.environ.get('QV_ZOOM', '1'))
    R.add_camera(scene, (c[0] + dx * d, c[1] + dy * d, c[2] + dz * d), tgt, lens=35, name=nm)
    scene.render.filepath = f'{out_prefix}_{nm}.png'
    bpy.ops.render.render(write_still=True)
R.log('done', out_prefix)
