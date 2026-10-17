"""Composite jungle patch from the raw GLBs (instanced, random placement) to judge layering and sightlines:

    bash c:/Code/island/tools/heavy.sh jungle E:/blender/blender-5.1.2-windows-x64/blender.exe --background \
        --factory-startup -t 6 --python tools/blender/jungle/scene_preview.py -- --tag s1 [--res 1600x900] [--samples 64]
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bpy  # noqa: E402
import numpy as np  # noqa: E402

import jmesh as J  # noqa: E402
import preview as P  # noqa: E402  (module: main() guarded below)

GLB = 'E:/tmp/island/helpers/jungle/glb'
PREV = 'E:/tmp/island/helpers/jungle/previews'


def main():
    tag = P.arg('--tag', 's1')
    res = P.arg('--res', '1600x900').split('x')
    samples = int(P.arg('--samples', '64'))
    J.reset_scene()
    sc = bpy.context.scene
    J.cycles_gpu(sc, samples=samples)
    sc.cycles.use_denoising = True
    sc.cycles.max_bounces = 6
    sc.cycles.diffuse_bounces = 3
    sc.cycles.transparent_max_bounces = 64
    sc.render.resolution_x, sc.render.resolution_y = int(res[0]), int(res[1])
    sc.render.image_settings.file_format = 'PNG'
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'AgX - Medium High Contrast'
    bg, _ = P.setup_world(float(P.arg('--sunaz', '200')), 1.0)
    P.ground(400, (0.075, 0.055, 0.04))
    lib = {}
    for f in ('canopy_trees', 'midstorey_trees', 'understory', 'floor'):
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=f'{GLB}/{f}_raw.glb')
        for o in bpy.data.objects:
            if o not in before and o.type == 'MESH':
                lib[o.name] = o
                o.hide_render = True
    for m in bpy.data.materials:
        if m.node_tree is not None and m.name != 'ground':
            P.strip_vertex_color(m)
            if 'leaf' in m.name or 'scan' in m.name or 'litter' in m.name:
                P.leaf_translucency(m, 0.35)
    rng = np.random.default_rng(7)

    def place(name, x, y, rot=None, s=1.0):
        src = lib[name]
        o = bpy.data.objects.new(name + '_i', src.data)
        sc.collection.objects.link(o)
        o.location = (x, y, 0)
        o.rotation_euler = (0, 0, rng.uniform(0, 6.28) if rot is None else rot)
        o.scale = (s, s, s)
        return o
    # canopy giants around the view, mid-storey, understory carpet, floor
    for i, (n, x, y) in enumerate([('rainforest_a_lod0', -9, 22), ('rainforest_c_lod0', 14, 30), ('rainforest_b_lod0', 2, 45),
                                   ('rainforest_d_lod0', -18, 38), ('rainforest_a_lod0', 26, 52), ('rainforest_c_lod0', -30, 60)]):
        place(n, x, y)
    for k in range(9):
        place(['midstorey_a_lod0', 'midstorey_b_lod0'][k % 2], rng.uniform(-22, 22), rng.uniform(8, 50), s=rng.uniform(0.8, 1.2))
    us = ['banana_a_lod0', 'banana_b_lod0', 'alocasia_a_lod0', 'colocasia_a_lod0', 'treefern_a_lod0', 'treefern_b_lod0',
          'rattan_a_lod0', 'licuala_a_lod0', 'sapling_a_lod0', 'sapling_b_lod0', 'birdsnest_a_lod0', 'fern_a_lod0',
          'fern_b_lod0', 'calathea_a_lod0', 'anthurium_a_lod0', 'anthurium_b_lod0', 'calathea_b_lod0']
    for k in range(70):
        x, y = rng.uniform(-16, 16), rng.uniform(3, 40)
        if abs(x) < 1.5 and y < 12:
            continue  # keep a little path open in front of the camera
        place(us[rng.integers(0, len(us))], x, y, s=rng.uniform(0.85, 1.2))
    for k in range(26):
        place(['litter_a_lod0', 'litter_b_lod0', 'litter_c_lod0'][k % 3], rng.uniform(-12, 12), rng.uniform(1, 30))
    place('log_a_lod0', 3.5, 9.0, rot=0.4)
    place('log_b_lod0', -4.0, 15.0, rot=-0.9)
    place('roots_a_lod0', -9 + 0.5, 22 - 0.5)
    cam = P.camera('eye', (0.3, -2.0, 1.7), (0.0, 20.0, 4.0), lens=24)
    P.render(cam, f'{PREV}/scene_eye_{tag}.png', samples)
    cam = P.camera('up', (0.3, 0.0, 1.6), (-2.0, 18.0, 16.0), lens=20)
    P.render(cam, f'{PREV}/scene_up_{tag}.png', samples)
    cam = P.camera('far', (10, -45, 22), (0, 30, 14), lens=30)
    P.render(cam, f'{PREV}/scene_far_{tag}.png', samples)


main()
