"""
README: preview renders of the palm assets (Cycles GPU, 1600x900, denoised) for self-critique.

  bash c:/Code/island/tools/heavy.sh palms E:/blender/blender-5.1.2-windows-x64/blender.exe --background \
       --factory-startup -t 6 --python c:/Code/island/tools/blender/palms/render_preview.py -- <blend> <view> [<view> ...]

Views: lineup, pair_ab, pair_cd, pair_ef, under, backlit, lods, base, rain_side (see VIEWS below). Daylight is the Poly Haven HDRI
kloofendal_48d_partly_cloudy_puresky (CC0); the backlit view uses Blender's Nishita sky with a 5 degree sun.
Writes E:/tmp/island/helpers/palms/previews/<prefix>_<view>.png
"""
import sys, os, math
import bpy
from mathutils import Vector, Euler

HDRI = 'E:/tmp/island/raw/polyhaven/hdri/kloofendal_48d_partly_cloudy_puresky_2k.hdr'
PREV = 'E:/tmp/island/helpers/palms/previews'


def gpu_setup(scene, samples):
    try:
        scene.render.engine = 'CYCLES'
    except TypeError as e:
        print('engine error', e)
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for dev_type in ('OPTIX', 'CUDA'):
        try:
            prefs.compute_device_type = dev_type
            prefs.get_devices()
            gpus = [d for d in prefs.devices if d.type == dev_type]
            if gpus:
                for d in prefs.devices:
                    d.use = d.type == dev_type
                scene.cycles.device = 'GPU'
                break
        except Exception as e:
            print('device', dev_type, e)
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 6
    scene.cycles.diffuse_bounces = 2
    scene.cycles.glossy_bounces = 2
    scene.cycles.transmission_bounces = 2
    scene.cycles.transparent_max_bounces = 48
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 900
    scene.render.film_transparent = False
    scene.view_settings.view_transform = 'AgX'
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = 6


def world_hdri(scene, strength=1.0, rot_z=0.0):
    w = bpy.data.worlds.new('w')
    scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputWorld')
    bg = nt.nodes.new('ShaderNodeBackground')
    env = nt.nodes.new('ShaderNodeTexEnvironment')
    env.image = bpy.data.images.load(HDRI)
    mp = nt.nodes.new('ShaderNodeMapping')
    tc = nt.nodes.new('ShaderNodeTexCoord')
    mp.inputs['Rotation'].default_value = (0, 0, rot_z)
    nt.links.new(tc.outputs['Generated'], mp.inputs['Vector'])
    nt.links.new(mp.outputs['Vector'], env.inputs['Vector'])
    nt.links.new(env.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = strength
    nt.links.new(bg.outputs['Background'], out.inputs['Surface'])


def world_sky(scene, sun_elev_deg, sun_rot_deg, strength=0.6):
    w = bpy.data.worlds.new('sky')
    scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputWorld')
    bg = nt.nodes.new('ShaderNodeBackground')
    sky = nt.nodes.new('ShaderNodeTexSky')
    for t in ('NISHITA', 'MULTIPLE_SCATTERING', 'SINGLE_SCATTERING'):
        try:
            sky.sky_type = t
            break
        except TypeError:
            continue
    sky.sun_elevation = math.radians(sun_elev_deg)
    sky.sun_rotation = math.radians(sun_rot_deg)
    try:
        sky.air_density = 1.6
        sky.dust_density = 3.0
    except Exception:
        pass
    nt.links.new(sky.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = strength
    nt.links.new(bg.outputs['Background'], out.inputs['Surface'])


def ground(scene, size=400, col=(0.42, 0.39, 0.34)):
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, 0))
    g = bpy.context.active_object
    g.name = 'ground'
    m = bpy.data.materials.new('ground')
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (*col, 1)
    b.inputs['Roughness'].default_value = 0.95
    g.data.materials.append(m)
    return g


def camera(scene, loc, target, lens=35):
    cd = bpy.data.cameras.new('cam')
    cd.lens = lens
    cd.clip_end = 2000
    c = bpy.data.objects.new('cam', cd)
    scene.collection.objects.link(c)
    c.location = loc
    d = Vector(target) - Vector(loc)
    c.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    scene.camera = c
    return c


def place(names, offsets, rotz=None):
    """show only the named objects, moved by offsets (preview only)"""
    for o in bpy.data.objects:
        if o.type == 'MESH' and o.name != 'ground':
            o.hide_render = True
    for i, (n, off) in enumerate(zip(names, offsets)):
        o = bpy.data.objects.get(n)
        if o is None:
            print('missing', n)
            continue
        o.hide_render = False
        o.location = off
        o.rotation_euler = (0, 0, rotz[i] if rotz else 0)


VIEWS = {}


def view(fn):
    VIEWS[fn.__name__] = fn
    return fn


@view
def lineup(scene, pre):
    names = [f'{pre}_{v}_lod0' for v in 'abcdef']
    xs = [0, 13, 26, 39, 52, 65]
    place(names, [(x, 0, 0) for x in xs])
    world_hdri(scene, 1.0, math.radians(200))
    camera(scene, (34, -58, 1.7), (34, 0, 11), lens=26)


@view
def pair_ab(scene, pre):
    place([f'{pre}_a_lod0', f'{pre}_b_lod0'], [(-6, 0, 0), (6, 3, 0)])
    world_hdri(scene, 1.0, math.radians(200))
    camera(scene, (0, -27, 1.7), (1, 0, 7.5), lens=28)


@view
def pair_cd(scene, pre):
    place([f'{pre}_c_lod0', f'{pre}_d_lod0'], [(-8, 0, 0), (6, 3, 0)])
    world_hdri(scene, 1.0, math.radians(120))
    camera(scene, (0, -33, 1.7), (1, 0, 9.5), lens=26)


@view
def pair_ef(scene, pre):
    place([f'{pre}_e_lod0', f'{pre}_f_lod0'], [(-6, 0, 0), (6, 3, 0)])
    world_hdri(scene, 1.0, math.radians(60))
    camera(scene, (0, -40, 1.7), (0, 0, 12.5), lens=24)


@view
def under(scene, pre):
    place([f'{pre}_b_lod0'], [(0, 0, 0)])
    world_hdri(scene, 1.0, math.radians(200))
    o = bpy.data.objects[f'{pre}_b_lod0']
    camera(scene, (-3.5, -6.5, 1.7), (1.5, 0.5, 10.5), lens=22)


@view
def backlit(scene, pre):
    place([f'{pre}_a_lod0', f'{pre}_c_lod0', f'{pre}_e_lod0'], [(-10, 4, 0), (4, 10, 0), (14, 2, 0)], rotz=[0.4, 0.0, -0.3])
    world_sky(scene, 3.5, 0, 1.0)
    scene.view_settings.exposure = -2.5        # exposed for the bright sky, like a real sunset photo
    camera(scene, (2, -26, 1.7), (2, 10, 8.5), lens=24)


@view
def lods(scene, pre):
    place([f'{pre}_c_lod0', f'{pre}_c_lod1', f'{pre}_c_lod2'], [(-16, 0, 0), (0, 0, 0), (16, 0, 0)])
    world_hdri(scene, 1.0, math.radians(200))
    camera(scene, (2, -45, 1.7), (2, 0, 9), lens=30)


@view
def base(scene, pre):
    place([f'{pre}_a_lod0'], [(0, 0, 0)])
    world_hdri(scene, 1.0, math.radians(200))
    camera(scene, (-1.2, -2.6, 1.25), (0.4, 0, 0.6), lens=30)


@view
def young_row(scene, pre):
    place([f'{pre}_a_lod0', f'{pre}_b_lod0', f'{pre}_c_lod0'], [(-2.6, 0.5, 0), (0.4, 0, 0), (4.6, 1.5, 0)], rotz=[0.6, 0.0, 2.0])
    world_hdri(scene, 1.0, math.radians(200))
    camera(scene, (0.6, -7.5, 1.7), (0.8, 0, 1.2), lens=24)


@view
def young_lods(scene, pre):
    place([f'{pre}_c_lod0', f'{pre}_c_lod1', f'{pre}_b_lod0', f'{pre}_b_lod1'], [(-7, 0, 0), (-2, 0, 0), (3, 0, 0), (7, 0, 0)])
    world_hdri(scene, 1.0, math.radians(200))
    camera(scene, (0, -16, 1.7), (0, 0, 1.6), lens=30)


@view
def sprout(scene, pre):
    place([f'{pre}_a_lod0'], [(0, 0, 0)], rotz=[0.6])
    world_hdri(scene, 1.0, math.radians(200))
    camera(scene, (-0.6, -2.2, 1.1), (0.05, 0, 0.3), lens=30)


@view
def scrub_row(scene, pre):
    place([f'{pre}_a_lod0', f'{pre}_b_lod0', f'{pre}_c_lod0', f'{pre}_d_lod0'], [(-7.5, 1, 0), (-1.5, 3, 0), (4.5, 1.5, 0), (9.5, 0, 0)])
    world_hdri(scene, 1.0, math.radians(200))
    camera(scene, (1, -13, 1.7), (1, 0, 1.0), lens=24)


@view
def scrub_close(scene, pre):
    place([f'{pre}_c_lod0'], [(0, 0, 0)])
    world_hdri(scene, 1.0, math.radians(200))
    camera(scene, (-1.0, -4.6, 1.7), (0.2, 0, 1.2), lens=28)


@view
def scrub_lods(scene, pre):
    place([f'{pre}_b_lod0', f'{pre}_b_lod1', f'{pre}_b_lod2'], [(-6, 0, 0), (0, 0, 0), (6, 0, 0)])
    world_hdri(scene, 1.0, math.radians(200))
    camera(scene, (0, -17, 1.7), (0, 0, 0.9), lens=30)


@view
def pandanus_pair(scene, pre):
    place([f'{pre}_a_lod0', f'{pre}_b_lod0'], [(-3.5, 1, 0), (4.0, 0, 0)], rotz=[0.0, 2.2])
    world_hdri(scene, 1.0, math.radians(200))
    camera(scene, (0.5, -14, 1.7), (0.5, 0, 3.0), lens=26)


@view
def pandanus_close(scene, pre):
    place([f'{pre}_a_lod0'], [(0, 0, 0)])
    world_hdri(scene, 1.0, math.radians(200))
    camera(scene, (-1.5, -6.0, 1.7), (0.6, 0, 2.4), lens=24)


@view
def pandanus_lods(scene, pre):
    place([f'{pre}_a_lod0', f'{pre}_a_lod1', f'{pre}_a_lod2'], [(-8, 0, 0), (0, 0, 0), (8, 0, 0)])
    world_hdri(scene, 1.0, math.radians(200))
    camera(scene, (0, -24, 1.7), (0, 0, 3.2), lens=30)


@view
def crown_close(scene, pre):
    place([f'{pre}_b_lod0'], [(0, 0, 0)])
    world_hdri(scene, 1.0, math.radians(260))
    camera(scene, (3.5, -7.5, 11.8), (1.6, 0, 11.0), lens=30)


@view
def crown_side(scene, pre):
    place([f'{pre}_b_lod0'], [(0, 0, 0)])
    world_hdri(scene, 1.0, math.radians(260))
    camera(scene, (2, -16, 11.5), (2.0, 0, 11.0), lens=32)


def ao_materials():
    """show COLOR_0.R (baked AO) as a grey albedo, keeping the frond cut-out"""
    for m in bpy.data.materials:
        if not m.use_nodes or m.name == 'ground':
            continue
        nt = m.node_tree
        bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if bsdf is None:
            continue
        at = nt.nodes.new('ShaderNodeVertexColor')
        at.layer_name = 'Color'
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(at.outputs['Color'], sep.inputs['Color'])
        comb = nt.nodes.new('ShaderNodeCombineColor')
        for k in ('Red', 'Green', 'Blue'):
            nt.links.new(sep.outputs['Red'], comb.inputs[k])
        nt.links.new(comb.outputs['Color'], bsdf.inputs['Base Color'])
        bsdf.inputs['Roughness'].default_value = 1.0


def wind_materials():
    """show COLOR_0 wind data: red = bend G, green = flutter B, blue = phase A (emission, unlit)"""
    for m in bpy.data.materials:
        if not m.use_nodes or m.name == 'ground':
            continue
        nt = m.node_tree
        out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'), None)
        bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if out is None or bsdf is None:
            continue
        at = nt.nodes.new('ShaderNodeVertexColor')
        at.layer_name = 'Color'
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(at.outputs['Color'], sep.inputs['Color'])
        comb = nt.nodes.new('ShaderNodeCombineColor')
        nt.links.new(sep.outputs['Green'], comb.inputs['Red'])
        nt.links.new(sep.outputs['Blue'], comb.inputs['Green'])
        nt.links.new(at.outputs['Alpha'], comb.inputs['Blue'])
        em = nt.nodes.new('ShaderNodeEmission')
        nt.links.new(comb.outputs['Color'], em.inputs['Color'])
        mix = nt.nodes.new('ShaderNodeMixShader')
        tr = nt.nodes.new('ShaderNodeBsdfTransparent')
        alpha_src = bsdf.inputs['Alpha'].links[0].from_socket if bsdf.inputs['Alpha'].links else None
        if alpha_src is not None:
            nt.links.new(alpha_src, mix.inputs['Fac'])
        else:
            mix.inputs['Fac'].default_value = 1.0
        nt.links.new(tr.outputs[0], mix.inputs[1])
        nt.links.new(em.outputs[0], mix.inputs[2])
        nt.links.new(mix.outputs[0], out.inputs['Surface'])


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    blend, views = args[0], args[1:]
    aoviz = 'aoviz' in views
    if aoviz:
        views.remove('aoviz')
    windviz = 'windviz' in views
    if windviz:
        views.remove('windviz')
    samples = 64
    for a in list(views):
        if a.startswith('samples='):
            samples = int(a.split('=')[1])
            views.remove(a)
    pre = 'coconut'
    for a in list(views):
        if a.startswith('prefix='):
            pre = a.split('=')[1]
            views.remove(a)
    tag = os.path.splitext(os.path.basename(blend))[0]
    for v in views:
        bpy.ops.wm.open_mainfile(filepath=blend)
        scene = bpy.context.scene
        gpu_setup(scene, samples)
        ground(scene)
        VIEWS[v](scene, pre)
        if aoviz:
            ao_materials()
        if windviz:
            wind_materials()
            scene.view_settings.view_transform = 'Standard'
        scene.render.filepath = f'{PREV}/{tag}_{v}{"_ao" if aoviz else ""}{"_wind" if windviz else ""}.png'
        bpy.ops.render.render(write_still=True)
        print('rendered', scene.render.filepath, flush=True)


main()
