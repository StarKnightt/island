"""Preview renders of a delivered (raw, pre-optimisation) GLB under the Poly Haven kloofendal HDRI (Cycles GPU):

    bash c:/Code/island/tools/heavy.sh jungle E:/blender/blender-5.1.2-windows-x64/blender.exe --background \
        --factory-startup -t 6 --python tools/blender/jungle/preview.py -- --glb <raw.glb> --set canopy \
        --tag v1 [--views row,base,up,backlit,lod,aerial] [--res 1600x900] [--samples 64]

Writes E:/tmp/island/helpers/jungle/previews/<set>_<view>_<tag>.png. Leaves get a Translucent BSDF mix for the
preview only (the game has its own foliage shader).
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402

import jmesh as J  # noqa: E402

HDRI = 'E:/tmp/island/raw/jungle/hdri/kloofendal_48d_partly_cloudy_puresky_2k.hdr'
PREV = 'E:/tmp/island/helpers/jungle/previews'


def arg(name, default=None):
    a = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    return a[a.index(name) + 1] if name in a else default


def hdri_sun_dir(img):
    w, h = img.size
    px = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    lum = px[..., 0] * 0.2126 + px[..., 1] * 0.7152 + px[..., 2] * 0.0722
    y, x = np.unravel_index(np.argmax(lum), lum.shape)
    u, v = (x + 0.5) / w, (y + 0.5) / h  # Blender pixels: row 0 = bottom
    az = (u - 0.5) * 2 * math.pi  # equirect: u=0.5 faces -Y? (Blender: direction (-cos?)) handled by rotation search
    el = (v - 0.5) * math.pi
    return az, el, float(lum.max())


def setup_world(sun_az_deg, hdri_strength=1.0):
    sc = bpy.context.scene
    world = bpy.data.worlds.new('w')
    sc.world = world
    world.use_nodes = True
    nt = world.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputWorld')
    bg = nt.nodes.new('ShaderNodeBackground')
    env = nt.nodes.new('ShaderNodeTexEnvironment')
    img = bpy.data.images.load(HDRI)
    env.image = img
    tc = nt.nodes.new('ShaderNodeTexCoord')
    mp = nt.nodes.new('ShaderNodeMapping')
    az, el, mx = hdri_sun_dir(img)
    # Blender equirect: direction d -> u = atan2(d.y, -d.x)/(2pi) + 0.5. The sun texel at u has azimuth
    # phi = atan2(y, x) = pi - 2pi(u - 0.5) ... rotate about Z so the sun lands at the requested azimuth.
    u = az / (2 * math.pi) + 0.5
    phi_tex = math.pi - 2 * math.pi * u  # Cycles equirect: u = (pi - atan2(y, x)) / 2pi
    rotz = phi_tex - math.radians(sun_az_deg)  # lookup dir' = Rz(rotz) dir -> sun at azimuth phi_tex - rotz
    mp.inputs['Rotation'].default_value = (0, 0, rotz)
    nt.links.new(tc.outputs['Generated'], mp.inputs['Vector'])
    nt.links.new(mp.outputs['Vector'], env.inputs['Vector'])
    nt.links.new(env.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = hdri_strength
    nt.links.new(bg.outputs['Background'], out.inputs['Surface'])
    print(f'HDRI sun texel az {math.degrees(az):.1f} el {math.degrees(el):.1f} peak {mx:.0f}; rotated to az {sun_az_deg}')
    return bg, math.degrees(el)


def ground(size=400, col=(0.16, 0.14, 0.12)):
    me = bpy.data.meshes.new('ground')
    s = size / 2
    me.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
    ob = bpy.data.objects.new('ground', me)
    bpy.context.scene.collection.objects.link(ob)
    m = bpy.data.materials.new('ground')
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*col, 1)
    b.inputs['Roughness'].default_value = 0.95
    me.materials.append(m)
    return ob


def strip_vertex_color(mat):
    """glTF COLOR_0 multiplies baseColor in standard viewers; our COLOR_0 is wind/AO data, so unhook it."""
    nt = mat.node_tree
    vcs = [n for n in nt.nodes if n.bl_idname in ('ShaderNodeVertexColor', 'ShaderNodeAttribute')]
    if not vcs:
        return
    bsdf = [n for n in nt.nodes if n.bl_idname == 'ShaderNodeBsdfPrincipled'][0]
    tex = [n for n in nt.nodes if n.bl_idname == 'ShaderNodeTexImage' and n.image and 'albedo' in n.image.name.lower()]
    if not tex:
        tex = [n for n in nt.nodes if n.bl_idname == 'ShaderNodeTexImage']
    for n in vcs:
        nt.nodes.remove(n)
    if tex:
        nt.links.new(tex[0].outputs['Color'], bsdf.inputs['Base Color'])


def leaf_translucency(mat, amount=0.35):
    nt = mat.node_tree
    out = [n for n in nt.nodes if n.bl_idname == 'ShaderNodeOutputMaterial'][0]
    bsdf = [n for n in nt.nodes if n.bl_idname == 'ShaderNodeBsdfPrincipled'][0]
    tex = None
    for l in nt.links:
        if l.to_node == bsdf and l.to_socket.name == 'Base Color':
            tex = l.from_socket
    if tex is None:
        return
    tr = nt.nodes.new('ShaderNodeBsdfTranslucent')
    hs = nt.nodes.new('ShaderNodeHueSaturation')
    hs.inputs['Saturation'].default_value = 1.3
    hs.inputs['Value'].default_value = 1.5
    nt.links.new(tex, hs.inputs['Color'])
    nt.links.new(hs.outputs['Color'], tr.inputs['Color'])
    mix = nt.nodes.new('ShaderNodeMixShader')
    mix.inputs['Fac'].default_value = amount
    nt.links.new(bsdf.outputs['BSDF'], mix.inputs[1])
    nt.links.new(tr.outputs['BSDF'], mix.inputs[2])
    # keep the alpha cut: transparent where Principled alpha says so
    alpha_src = None
    for l in nt.links:
        if l.to_node == bsdf and l.to_socket.name == 'Alpha':
            alpha_src = l.from_socket
    if alpha_src is not None:
        tp = nt.nodes.new('ShaderNodeBsdfTransparent')
        mx2 = nt.nodes.new('ShaderNodeMixShader')
        nt.links.new(alpha_src, mx2.inputs['Fac'])
        nt.links.new(tp.outputs['BSDF'], mx2.inputs[1])
        nt.links.new(mix.outputs['Shader'], mx2.inputs[2])
        nt.links.new(mx2.outputs['Shader'], out.inputs['Surface'])
    else:
        nt.links.new(mix.outputs['Shader'], out.inputs['Surface'])


def vcol_material(mat, channel, attr='Col'):
    """Replace a material's surface with an emission of one COLOR_0 channel (R AO, G bend, B flutter, A phase)."""
    nt = mat.node_tree
    out = [n for n in nt.nodes if n.bl_idname == 'ShaderNodeOutputMaterial'][0]
    at = nt.nodes.new('ShaderNodeAttribute')
    at.attribute_name = attr
    at.attribute_type = 'GEOMETRY'
    em = nt.nodes.new('ShaderNodeEmission')
    if channel == 'A':
        hsv = nt.nodes.new('ShaderNodeCombineColor')
        hsv.mode = 'HSV'
        nt.links.new(at.outputs['Alpha'], hsv.inputs[0])
        hsv.inputs[1].default_value = 0.9
        hsv.inputs[2].default_value = 0.9
        nt.links.new(hsv.outputs['Color'], em.inputs['Color'])
    else:
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(at.outputs['Color'], sep.inputs['Color'])
        nt.links.new(sep.outputs[{'R': 'Red', 'G': 'Green', 'B': 'Blue'}[channel]], em.inputs['Color'])
    alpha_src = None
    bsdf = [n for n in nt.nodes if n.bl_idname == 'ShaderNodeBsdfPrincipled']
    if bsdf:
        for l in nt.links:
            if l.to_node == bsdf[0] and l.to_socket.name == 'Alpha':
                alpha_src = l.from_socket
    if alpha_src is not None:
        tp = nt.nodes.new('ShaderNodeBsdfTransparent')
        mx = nt.nodes.new('ShaderNodeMixShader')
        nt.links.new(alpha_src, mx.inputs['Fac'])
        nt.links.new(tp.outputs['BSDF'], mx.inputs[1])
        nt.links.new(em.outputs['Emission'], mx.inputs[2])
        nt.links.new(mx.outputs['Shader'], out.inputs['Surface'])
    else:
        nt.links.new(em.outputs['Emission'], out.inputs['Surface'])


def camera(name, loc, target, lens=35):
    cd = bpy.data.cameras.new(name)
    cd.lens = lens
    cd.clip_start = 0.05
    cd.clip_end = 2000
    cam = bpy.data.objects.new(name, cd)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = loc
    d = Vector(target) - Vector(loc)
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    return cam


def render(cam, path, samples):
    sc = bpy.context.scene
    sc.camera = cam
    sc.cycles.samples = samples
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print('wrote', path)


def main():
    glb = arg('--glb')
    sset = arg('--set', 'canopy')
    tag = arg('--tag', 'v1')
    views = arg('--views', 'row,base,up,backlit,lod,aerial').split(',')
    res = arg('--res', '1600x900').split('x')
    samples = int(arg('--samples', '64'))
    sun_az = float(arg('--sunaz', '210'))
    J.reset_scene()
    sc = bpy.context.scene
    J.cycles_gpu(sc, samples=samples)
    sc.cycles.use_denoising = True
    try:
        sc.cycles.denoiser = 'OPTIX'
    except Exception:
        pass
    sc.cycles.max_bounces = 6
    sc.cycles.diffuse_bounces = 3
    sc.cycles.transparent_max_bounces = 48
    sc.render.resolution_x, sc.render.resolution_y = int(res[0]), int(res[1])
    sc.render.image_settings.file_format = 'PNG'
    try:
        sc.view_settings.view_transform = 'AgX'
        sc.view_settings.look = 'AgX - Medium High Contrast'
    except Exception:
        pass
    bg, sun_el = setup_world(sun_az, 1.0)
    ground()
    bpy.ops.import_scene.gltf(filepath=glb)
    objs = [o for o in sc.objects if o.type == 'MESH' and o.name != 'ground']
    for m in bpy.data.materials:
        if m.node_tree is None or m.name == 'ground':
            continue
        strip_vertex_color(m)
        if m.name.endswith('_leaf') or 'leaf' in m.name or 'frond' in m.name:
            leaf_translucency(m, 0.35)
    by = {o.name: o for o in objs}
    species = sorted({o.name.rsplit('_lod', 1)[0] for o in objs})
    lods = sorted({int(o.name.rsplit('_lod', 1)[1][0]) for o in objs if '_lod' in o.name})
    sa = math.radians(sun_az)
    sun_vec = Vector((math.cos(sa), math.sin(sa), 0))

    def show(names):
        for o in objs:
            o.hide_render = o.name not in names
    vch = arg('--vcol')
    if vch:  # data view of one COLOR_0 channel for the first species' LOD0 (and the given others)
        cnames = [ca.name for o in objs for ca in o.data.color_attributes]
        attr = cnames[0] if cnames else 'Col'
        print('colour attributes:', sorted(set(cnames)))
        for m in bpy.data.materials:
            if m.node_tree is not None and m.name != 'ground':
                vcol_material(m, vch, attr)
        sc.view_settings.view_transform = 'Standard'
        sc.view_settings.look = 'None'
        names = [o.name for o in objs if o.name.endswith('_lod0')]
        for i, n in enumerate(names):
            by[n].location = (i * 30 - 15 * (len(names) - 1), 0, 0)
        show(names)
        cam = camera('vc', (0, -95, 10), (0, 0, 15), lens=30)
        render(cam, f'{PREV}/{sset}_vcol{vch}_{tag}.png', 16)
        return
    if sset == 'ledge':  # a dark wet cliff with a ledge: wall face at y = 0 going down, ledge top at z = 0 (y > 0)
        sc.objects['ground'].location = (0, 0, -9)
        me = bpy.data.meshes.new('cliff')
        vs = [(-12, 0, -9), (12, 0, -9), (12, 4, -9), (-12, 4, -9), (-12, 0, 0), (12, 0, 0), (12, 4, 0), (-12, 4, 0),
              (-12, 4, 6), (12, 4, 6), (12, 8, 6), (-12, 8, 6)]
        fs = [(0, 1, 5, 4), (4, 5, 6, 7), (1, 2, 6, 5), (3, 0, 4, 7), (7, 6, 9, 8), (8, 9, 10, 11)]
        me.from_pydata(vs, [], fs)
        cl = bpy.data.objects.new('cliff', me)
        sc.collection.objects.link(cl)
        cm = bpy.data.materials.new('rock')
        cm.use_nodes = True
        b = cm.node_tree.nodes['Principled BSDF']
        b.inputs['Base Color'].default_value = (0.05, 0.05, 0.045, 1)
        b.inputs['Roughness'].default_value = 0.45
        me.materials.append(cm)
        lod0 = sorted([o.name for o in objs if o.name.endswith('_lod0')])
        xs = np.linspace(-9, 9, len(lod0))
        for x, n in zip(xs, lod0):
            o = by[n]
            if n.startswith('moss'):
                o.location = (x, 1.2, 0.0)
            else:
                o.location = (x, 0.0, 0.0)
        show(lod0)
        cam = camera('wall', (0, -14, 0.5), (0, 0, -2.0), lens=24)
        render(cam, f'{PREV}/{sset}_wall_{tag}.png', samples)
        for i, n in enumerate(lod0):
            show([n])
            x = xs[i]
            if n.startswith('moss'):
                cam = camera('c', (x + 0.6, -0.4, 1.4), (x, 1.2, 0.2), lens=30)
            elif n.startswith('vinecurtain_b'):
                cam = camera('c', (x + 2, -9, -2.5), (x, 0, -3.5), lens=30)
            else:
                cam = camera('c', (x + 1.0, -4.0, -0.3), (x, 0, -0.8), lens=30)
            render(cam, f'{PREV}/{sset}_{n}_{tag}.png', samples)
        return
    if sset in ('understory', 'floor', 'ledge'):
        lod0 = sorted([o.name for o in objs if o.name.endswith('_lod0')])
        groups = arg('--groups')
        rows = [g.split('+') for g in groups.split(';')] if groups else [lod0[i:i + 6] for i in range(0, len(lod0), 6)]
        spacing = float(arg('--spacing', '4.5'))
        for r, row in enumerate(rows):
            names = []
            for i, base in enumerate(row):
                n = base if base.endswith('_lod0') else f'{base}_lod0'
                if n not in by:
                    continue
                by[n].location = ((i - (len(row) - 1) / 2) * spacing, 0, 0)
                names.append(n)
            show(names)
            width = spacing * max(len(row), 1)
            dist = max(6.0, width * 0.85)
            zt = float(arg('--zt', '1.3'))
            cam = camera('row', (0, -dist, 1.7), (0, 0, zt), lens=32)
            render(cam, f'{PREV}/{sset}_row{r}_{tag}.png', samples)
            if 'close' in views:
                cam = camera('close', (0.6, -dist * 0.45, 1.5), (0, 0, zt), lens=28)
                render(cam, f'{PREV}/{sset}_close{r}_{tag}.png', samples)
            if 'back' in views:
                bg.inputs['Strength'].default_value = 0.35
                ld = bpy.data.lights.new('lowsun', 'SUN')
                ld.energy = 4.0
                ld.angle = math.radians(0.6)
                ld.color = (1.0, 0.85, 0.65)
                ls = bpy.data.objects.new('lowsun', ld)
                sc.collection.objects.link(ls)
                ls.rotation_euler = (math.radians(90 - 14), 0, math.radians(180))
                cam = camera('back', (0, -dist, 1.2), (0, 0, zt), lens=32)
                render(cam, f'{PREV}/{sset}_back{r}_{tag}.png', samples)
                bpy.data.objects.remove(ls)
                bg.inputs['Strength'].default_value = 1.0
            for n in names:
                by[n].location = (0, 1000, 0)
        if 'lod' in views:
            pairs = sorted({o.name.rsplit('_lod', 1)[0] for o in objs})
            for k in range(0, len(pairs), 4):
                chunk = pairs[k:k + 4]
                names = []
                for i, s in enumerate(chunk):
                    for l in (0, 1):
                        n = f'{s}_lod{l}'
                        if n in by:
                            by[n].location = ((i * 2 + l - 3.5) * spacing * 0.8, 0, 0)
                            names.append(n)
                show(names)
                cam = camera('lod', (0, -spacing * 6.5, 2.5), (0, 0, 1.2), lens=35)
                render(cam, f'{PREV}/{sset}_lod{k // 4}_{tag}.png', max(32, samples // 2))
                for n in names:
                    by[n].location = (0, 1000, 0)
        return
    if sset == 'canopy':
        spacing = 30.0
        # row of LOD0 trees along X
        for i, s in enumerate(species):
            for l in lods:
                o = by[f'{s}_lod{l}']
                o.location = (i * spacing - spacing * (len(species) - 1) / 2, 0, 0)
        lod0 = [f'{s}_lod0' for s in species]
        if 'row' in views:
            show(lod0)
            cam = camera('row', (0, -95, 1.7), (0, 0, 16), lens=30)
            render(cam, f'{PREV}/{sset}_row_{tag}.png', samples)
        if 'backlit' in views:
            show(lod0)
            bg.inputs['Strength'].default_value = 0.35
            ld = bpy.data.lights.new('lowsun', 'SUN')
            ld.energy = 4.0
            ld.angle = math.radians(0.6)
            ls = bpy.data.objects.new('lowsun', ld)
            sc.collection.objects.link(ls)
            # sun low (12 deg) behind the trees as seen from the camera at -Y
            ls.rotation_euler = (math.radians(90 - 12), 0, math.radians(180))
            ld.color = (1.0, 0.82, 0.6)
            cam = camera('back', (0, -70, 1.7), (0, 0, 14), lens=30)
            render(cam, f'{PREV}/{sset}_backlit_{tag}.png', samples)
            bpy.data.objects.remove(ls)
            bg.inputs['Strength'].default_value = 1.0
        for i, s in enumerate(species):
            x = i * spacing - spacing * (len(species) - 1) / 2
            if 'base' in views:
                show(lod0)
                cam = camera('base', (x + 5.5, -6.5, 1.7), (x, 0, 1.4), lens=24)
                render(cam, f'{PREV}/{sset}_base_{s}_{tag}.png', samples)
            if 'up' in views:
                show(lod0)
                cam = camera('up', (x + 3.0, -7.0, 1.7), (x - 1.0, 0, 22), lens=20)
                render(cam, f'{PREV}/{sset}_up_{s}_{tag}.png', samples)
        if 'lod' in views:
            for i, s in enumerate(species):
                names = []
                for l in lods:
                    o = by[f'{s}_lod{l}']
                    o.location = ((l - 1) * 28, 0, 0)
                    names.append(o.name)
                show(names)
                cam = camera('lod', (0, -85, 12), (0, 0, 14), lens=35)
                render(cam, f'{PREV}/{sset}_lod_{s}_{tag}.png', max(32, samples // 2))
                for l in lods:
                    by[f'{s}_lod{l}'].location = (i * spacing - spacing * (len(species) - 1) / 2, 0, 0)
        if 'aerial' in views:
            show(lod0)
            cam = camera('aerial', (10, -60, 70), (0, 0, 18), lens=35)
            render(cam, f'{PREV}/{sset}_aerial_{tag}.png', samples)


if __name__ == '__main__':
    main()
