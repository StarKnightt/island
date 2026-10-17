"""Inspect a Poly Haven scan: orient its face toward -Y, print stats, render ortho front + top views with
1 m / 5 m ticks (red) so crop ranges can be read off the image.

  blender --background --factory-startup -t 6 --python inspect_scan.py -- <scan_id> [extra_rot_deg]
Output: E:/tmp/island/helpers/rocks/inspect/<scan_id>_front.png, _top.png, _info.json
"""
import os
import sys
import math
import json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import rocklib as R  # noqa: E402

args = R.args_after_dashes()
scan_id = args[0]
extra = float(args[1]) if len(args) > 1 else 0.0
out_dir = R.WORK + '/inspect'
os.makedirs(out_dir, exist_ok=True)

R.reset_scene()
scene = bpy.context.scene
obj = R.import_gltf(R.scan_gltf_path(scan_id))
tris = R.tri_count(obj)
rot = R.rotate_face_to_minus_y(obj, extra)
mn, mx = R.bbox(obj)
h, mean_n = R.face_direction(obj)
R.log(scan_id, 'tris', tris, 'rot', round(rot, 1), 'bbox', mn.round(2), mx.round(2), 'mean normal', mean_n.round(3))

# ticks
tick_mat = R.solid_material('tick', (1, 0, 0))
tick_mat2 = R.solid_material('tick2', (1, 1, 0))


def tick(x, z, sx, sz, mat):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(x, mn[1] - 1, z))
    t = bpy.context.active_object
    t.scale = (sx, 0.05, sz)
    t.data.materials.append(mat)
    return t


W = mx[0] - mn[0]
H = mx[2] - mn[2]
step = 1.0 if max(W, H) < 30 else 2.0
x = math.floor(mn[0])
while x <= mx[0] + 0.01:
    big = abs(x / 5 - round(x / 5)) < 1e-6
    tick(x, mn[2] - 0.6, 0.06 * (2 if big else 1) * step, 1.2 if big else 0.6, tick_mat2 if abs(x) < 1e-6 else tick_mat)
    x += step
z = math.floor(mn[2])
while z <= mx[2] + 0.01:
    big = abs(z / 5 - round(z / 5)) < 1e-6
    tick(mn[0] - 0.6, z, 1.2 if big else 0.6, 0.06 * (2 if big else 1) * step, tick_mat2 if abs(z) < 1e-6 else tick_mat)
    z += step

R.gpu_cycles(scene, samples=24)
scene.cycles.use_denoising = True
scene.view_settings.view_transform = 'AgX'
world = bpy.data.worlds.new('w')
scene.world = world
try:
    world.use_nodes = True
except Exception:
    pass
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.35, 0.4, 0.5, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
sun.data.energy = 4.0
sun.data.angle = math.radians(2)
scene.collection.objects.link(sun)
# raking light from upper left, slightly in front of the face
sun.rotation_euler = (math.radians(62), 0, math.radians(-120))
clay = os.environ.get('CLAY', '0') == '1'
if clay:
    obj.data.materials.clear()
    obj.data.materials.append(R.solid_material('clay', (0.35, 0.35, 0.35)))
pad = 2.5
suffix = '_clay' if clay else ''
nseg = int(os.environ.get('SEG', '1'))
res_x = 1800
scene.render.film_transparent = False
segw = W / nseg
skip_front = os.environ.get('SKIPFRONT', '0') == '1'
for si in range(0 if skip_front else nseg):
    x0 = mn[0] + si * segw
    x1 = x0 + segw
    aspect = (segw + 2 * pad) / (H + 2 * pad)
    scene.render.resolution_x = res_x
    scene.render.resolution_y = max(200, int(res_x / aspect))
    cx, cz = (x0 + x1) / 2, (mn[2] + mx[2]) / 2
    R.add_camera(scene, (cx, mn[1] - 50, cz), (cx, 0, cz), ortho_scale=max(segw, H * aspect) + 2 * pad, name='front')
    scene.render.filepath = f'{out_dir}/{scan_id}_front{suffix}' + (f'_{si}' if nseg > 1 else '') + '.png'
    bpy.ops.render.render(write_still=True)
cx = (mn[0] + mx[0]) / 2

# top view
D = mx[1] - mn[1]
aspect2 = (W + 2 * pad) / (D + 2 * pad)
scene.render.resolution_y = max(200, int(res_x / aspect2))
cy = (mn[1] + mx[1]) / 2
R.add_camera(scene, (cx, cy, mx[2] + 50), (cx, cy, 0), ortho_scale=max(W, D * aspect2) + 2 * pad, name='top')
scene.render.filepath = f'{out_dir}/{scan_id}_top{suffix}.png'
if not skip_front:
    bpy.ops.render.render(write_still=True)

# optional oblique perspective views of a section: OBLIQUE="x0,x1"
obl = os.environ.get('OBLIQUE')
if obl:
    x0, x1 = [float(v) for v in obl.split(',')]
    cxs = (x0 + x1) / 2
    span = (x1 - x0)
    scene.render.resolution_x = 1400
    scene.render.resolution_y = 800
    tgt = (cxs, (mn[1] + mx[1]) / 2 * 0.3, H * 0.4)
    for nm, (dx, dy, dz) in dict(left=(-0.8, -1.0, 0.45), right=(0.8, -1.0, 0.45), low=(0.0, -1.0, 0.08)).items():
        dist = span * 1.25 + 8
        R.add_camera(scene, (cxs + dx * dist, dy * dist, dz * dist + H * 0.4), tgt, lens=35, name='obl_' + nm)
        scene.render.filepath = f'{out_dir}/{scan_id}_obl_{int(x0)}_{int(x1)}_{nm}{suffix}.png'
        bpy.ops.render.render(write_still=True)

info = dict(scan=scan_id, tris=tris, rot_deg=rot, bbox_min=mn.tolist(), bbox_max=mx.tolist(), mean_normal=mean_n.tolist())
json.dump(info, open(f'{out_dir}/{scan_id}_info.json', 'w'), indent=1)
R.log('wrote', out_dir)
