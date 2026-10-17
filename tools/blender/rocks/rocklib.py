"""Shared helpers for the rock pipeline (imported by the other scripts in this folder).

All scripts run headless:
  E:/blender/blender-5.1.2-windows-x64/blender.exe --background --factory-startup -t 6 --python <script> -- <args>
"""
import bpy
import bmesh
import math
import os
import sys
import json
import numpy as np
from mathutils import Vector, Matrix

RAW = 'E:/tmp/island/raw/polyhaven/scans'
WORK = 'E:/tmp/island/helpers/rocks'
HDRI = WORK + '/hdri/kloofendal_48d_partly_cloudy_puresky_2k.hdr'
REPO_OUT = 'c:/Code/island/public/assets/rocks'


def args_after_dashes():
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def log(*a):
    print('[rocks]', *a, flush=True)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def gpu_cycles(scene, samples=64, threads=6):
    scene.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    ok = False
    for dev_type in ('OPTIX', 'CUDA'):
        try:
            prefs.compute_device_type = dev_type
            prefs.get_devices()
            gpus = [d for d in prefs.devices if d.type == dev_type]
            if gpus:
                for d in prefs.devices:
                    d.use = d.type == dev_type
                ok = True
                break
        except Exception as e:  # noqa
            log('device type', dev_type, 'failed', e)
    scene.cycles.device = 'GPU' if ok else 'CPU'
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = threads
    scene.cycles.samples = samples
    log('cycles device', scene.cycles.device, prefs.compute_device_type)


def import_gltf(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == 'MESH']
    for o in new:
        if o.type != 'MESH':
            # keep children transforms: parent-clear-keep-transform on meshes first
            pass
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for o in new:
        if o.name in bpy.data.objects and o.type != 'MESH':
            bpy.data.objects.remove(o)
    return obj


def scan_gltf_path(scan_id):
    d = f'{RAW}/{scan_id}'
    for f in os.listdir(d):
        if f.endswith('.gltf'):
            return f'{d}/{f}'
    raise FileNotFoundError(d)


def mesh_arrays(obj):
    me = obj.data
    nv = len(me.vertices)
    co = np.empty(nv * 3, np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    me.calc_loop_triangles()
    nt = len(me.loop_triangles)
    tri = np.empty(nt * 3, np.int32)
    me.loop_triangles.foreach_get('vertices', tri)
    tri = tri.reshape(-1, 3)
    return co, tri


def tri_normals_areas(co, tri):
    a, b, c = co[tri[:, 0]], co[tri[:, 1]], co[tri[:, 2]]
    n = np.cross(b - a, c - a)
    ar = np.linalg.norm(n, axis=1) * 0.5
    n = n / np.maximum(ar[:, None] * 2, 1e-12)
    return n, ar


def face_direction(obj):
    """Area-weighted mean horizontal normal (unit 2D vector) of the mesh."""
    co, tri = mesh_arrays(obj)
    n, ar = tri_normals_areas(co, tri)
    m = (n * ar[:, None]).sum(0)
    h = np.array([m[0], m[1]])
    return h / max(np.linalg.norm(h), 1e-9), m / ar.sum()


def rotate_face_to_minus_y(obj, extra_deg=0.0):
    """Rotate about Z so the mean face normal looks toward -Y (glTF +Z after export)."""
    h, _ = face_direction(obj)
    ang = math.atan2(h[1], h[0])
    target = -math.pi / 2
    rot = target - ang + math.radians(extra_deg)
    obj.matrix_world = Matrix.Rotation(rot, 4, 'Z') @ obj.matrix_world
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return math.degrees(rot)


def bbox(obj):
    co, _ = mesh_arrays(obj)
    return co.min(0), co.max(0)


def tri_count(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def new_image(name, w, h, float_buffer=False, srgb=True, alpha=False, color=(0, 0, 0, 1)):
    if name in bpy.data.images:
        bpy.data.images.remove(bpy.data.images[name])
    img = bpy.data.images.new(name, w, h, alpha=alpha, float_buffer=float_buffer)
    img.colorspace_settings.name = 'sRGB' if srgb else 'Non-Color'
    img.generated_color = color
    return img


def img_to_np(img):
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)


def np_to_img(arr, img):
    img.pixels.foreach_set(np.ascontiguousarray(arr, dtype=np.float32).ravel())
    img.update()


def load_np(path, colorspace='Non-Color'):
    img = bpy.data.images.load(path, check_existing=False)
    img.colorspace_settings.name = colorspace
    a = img_to_np(img)
    bpy.data.images.remove(img)
    return a


def save_np_png(arr, path, srgb=False, depth='8', alpha=False):
    """arr HxWx{3,4} float 0..1 (values stored as-is: pass sRGB-encoded data for colour maps)."""
    h, w = arr.shape[:2]
    if arr.shape[2] == 3:
        arr = np.concatenate([arr, np.ones((h, w, 1), np.float32)], 2)
    img = bpy.data.images.new('tmp_save', w, h, alpha=alpha, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    np_to_img(np.clip(arr, 0, 1), img)
    img.filepath_raw = path
    img.file_format = 'PNG'
    st = bpy.context.scene.render.image_settings
    st.file_format = 'PNG'
    st.color_mode = 'RGBA' if alpha else 'RGB'
    st.color_depth = depth
    try:
        st.color_management = 'OVERRIDE'
        st.view_settings.view_transform = 'Standard'
        st.display_settings.display_device = 'sRGB'
        st.linear_colorspace_settings.name = 'Non-Color'
    except Exception:
        pass
    img.save_render(path, scene=bpy.context.scene)
    bpy.data.images.remove(img)


def srgb_to_lin(c):
    c = np.asarray(c, np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(np.asarray(c, np.float32), 0, None)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def setup_world_hdri(scene, strength=1.0, rot_deg=0.0):
    world = bpy.data.worlds.new('hdri') if not scene.world else scene.world
    scene.world = world
    try:
        world.use_nodes = True
    except Exception:
        pass
    nt = world.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new('ShaderNodeTexCoord')
    mp = nt.nodes.new('ShaderNodeMapping')
    mp.inputs['Rotation'].default_value = (0, 0, math.radians(rot_deg))
    env = nt.nodes.new('ShaderNodeTexEnvironment')
    env.image = bpy.data.images.load(HDRI, check_existing=True)
    bg = nt.nodes.new('ShaderNodeBackground')
    bg.inputs['Strength'].default_value = strength
    out = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(tc.outputs['Generated'], mp.inputs['Vector'])
    nt.links.new(mp.outputs['Vector'], env.inputs['Vector'])
    nt.links.new(env.outputs['Color'], bg.inputs['Color'])
    nt.links.new(bg.outputs['Background'], out.inputs['Surface'])
    return world


def add_camera(scene, loc, look_at, lens=35.0, ortho_scale=None, name='cam'):
    cam_data = bpy.data.cameras.new(name)
    if ortho_scale:
        cam_data.type = 'ORTHO'
        cam_data.ortho_scale = ortho_scale
    else:
        cam_data.lens = lens
    cam_data.clip_start = 0.05
    cam_data.clip_end = 5000
    cam = bpy.data.objects.new(name, cam_data)
    scene.collection.objects.link(cam)
    cam.location = Vector(loc)
    d = Vector(look_at) - Vector(loc)
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam
    return cam


def solid_material(name, rgb, rough=0.9):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = rough
    m.diffuse_color = (*rgb, 1)
    return m
