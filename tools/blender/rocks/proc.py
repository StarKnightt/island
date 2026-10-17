"""Procedural helpers for sculpted rock bodies (stacks, blocks, shelves): numpy gradient noise, triplanar sampling of
scan displacement maps, voxel-remesh union, macro (smoothed) vertex normals, chart UV unwrap. Imported inside Blender.
"""
import math
import numpy as np
import bpy
import bmesh
import rocklib as R

_G = np.array([[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
               [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]], np.float32)


def _hash(ix, iy, iz, seed):
    h = (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791) ^ (seed * 2654435761 + 1013904223)
    h &= 0xffffffff
    h ^= h >> 13
    h = (h * 0x5bd1e995) & 0xffffffff
    h ^= h >> 15
    return h


def perlin(p, seed=0):
    """3D gradient noise, p: Nx3 -> N values in about [-1, 1]."""
    p = np.asarray(p, np.float64)
    pi = np.floor(p)
    f = (p - pi).astype(np.float32)
    pi = pi.astype(np.int64)
    u = f * f * f * (f * (f * 6 - 15) + 10)
    acc = np.zeros(len(p), np.float32)
    for dx in (0, 1):
        wx = u[:, 0] if dx else 1 - u[:, 0]
        for dy in (0, 1):
            wy = u[:, 1] if dy else 1 - u[:, 1]
            for dz in (0, 1):
                wz = u[:, 2] if dz else 1 - u[:, 2]
                g = _G[_hash(pi[:, 0] + dx, pi[:, 1] + dy, pi[:, 2] + dz, seed) % 12]
                d = g[:, 0] * (f[:, 0] - dx) + g[:, 1] * (f[:, 1] - dy) + g[:, 2] * (f[:, 2] - dz)
                acc += wx * wy * wz * d
    return acc * 1.4


def fbm(p, octaves=4, lac=2.03, gain=0.5, seed=0):
    s = np.zeros(len(p), np.float32)
    a, tot = 1.0, 0.0
    for o in range(octaves):
        s += a * perlin(p * lac ** o, seed + 17 * o)
        tot += a
        a *= gain
    return s / tot


def load_gray(path):
    """Single channel float image (row 0 = bottom, Blender order)."""
    img = bpy.data.images.load(path, check_existing=False)
    img.colorspace_settings.name = 'Non-Color'
    w, h = img.size
    px = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    a = px.reshape(h, w, 4)[..., 0].copy()
    bpy.data.images.remove(img)
    return a


def sample(img, u, v):
    """Bilinear, wrapping, u / v in tile units."""
    h, w = img.shape
    x = np.mod(u, 1.0) * w - 0.5
    y = np.mod(v, 1.0) * h - 0.5
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx = (x - x0).astype(np.float32)
    fy = (y - y0).astype(np.float32)
    x0 %= w
    y0 %= h
    x1 = (x0 + 1) % w
    y1 = (y0 + 1) % h
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x1] * fx * (1 - fy) +
            img[y1, x0] * (1 - fx) * fy + img[y1, x1] * fx * fy)


def triplanar(img, p, n, tile, sharp=6.0, seed=0):
    """Height from a tileable map projected along X, Y and Z (each projection randomly offset / rotated by 90 deg
    steps so the three never line up), blended by |n|^sharp."""
    rng = np.random.default_rng(seed)
    q = p / tile
    w = np.abs(n) ** sharp
    w /= np.maximum(w.sum(1, keepdims=True), 1e-9)
    out = np.zeros(len(p), np.float32)
    for ax, (a, b) in enumerate(((1, 2), (0, 2), (0, 1))):
        ou, ov = rng.uniform(0, 1, 2)
        uu, vv = q[:, a] + ou, q[:, b] + ov
        if rng.uniform() < 0.5:
            uu, vv = vv, -uu
        out += w[:, ax] * sample(img, uu, vv)
    return out


def get_co(obj):
    me = obj.data
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', co)
    return co.reshape(-1, 3)


def set_co(obj, co):
    obj.data.vertices.foreach_set('co', np.ascontiguousarray(co, np.float32).ravel())
    obj.data.update()


def vertex_normals(obj):
    me = obj.data
    n = np.empty(len(me.vertices) * 3, np.float32)
    me.vertex_normals.foreach_get('vector', n)
    return n.reshape(-1, 3)


def apply_mod(obj, typ, **kw):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    m = obj.modifiers.new('m', typ)
    for k, v in kw.items():
        setattr(m, k, v)
    bpy.ops.object.modifier_apply(modifier=m.name)


def macro_normals(obj, iterations=25):
    """Vertex normals of a heavily smoothed copy (same vertex order): stable directions for displacement."""
    tmp = obj.copy()
    tmp.data = obj.data.copy()
    bpy.context.scene.collection.objects.link(tmp)
    apply_mod(tmp, 'SMOOTH', factor=1.0, iterations=iterations)
    n = vertex_normals(tmp)
    bpy.data.meshes.remove(tmp.data)
    return n


def voxel_remesh(obj, size, adaptivity=0.0):
    apply_mod(obj, 'REMESH', mode='VOXEL', voxel_size=size, adaptivity=adaptivity, use_smooth_shade=True)


def boolean(obj, cutter, op='DIFFERENCE'):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    m = obj.modifiers.new('b', 'BOOLEAN')
    m.operation = op
    m.object = cutter
    for s in ('EXACT', 'MANIFOLD', 'FLOAT'):
        try:
            m.solver = s
            break
        except TypeError:
            continue
    bpy.ops.object.modifier_apply(modifier=m.name)


def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = o.data.name = name
    return o


def mesh_object(name, verts, faces):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(map(float, v)) for v in verts], [], [tuple(map(int, f)) for f in faces])
    me.update()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def decimate_to(obj, target):
    apply_mod(obj, 'DECIMATE', decimate_type='COLLAPSE', ratio=min(1.0, target / max(R.tri_count(obj), 1)),
              use_collapse_triangulate=True)
    t = R.tri_count(obj)
    if t > target * 1.03:
        apply_mod(obj, 'DECIMATE', decimate_type='COLLAPSE', ratio=target / t, use_collapse_triangulate=True)


def chart_unwrap(obj, smooth_it=40, angle=66):
    """Charts from a smart projection of a smoothed copy (rock roughness does not shatter them), as seams, then a
    minimum-stretch unwrap of the real mesh (angle-based fallback)."""
    me = obj.data
    if not me.uv_layers:
        me.uv_layers.new(name='UVMap')
    tmp = obj.copy()
    tmp.data = me.copy()
    bpy.context.scene.collection.objects.link(tmp)
    apply_mod(tmp, 'SMOOTH', factor=1.0, iterations=smooth_it)
    bpy.ops.object.select_all(action='DESELECT')
    tmp.select_set(True)
    bpy.context.view_layer.objects.active = tmp
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=0.0, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.seams_from_islands()
    bpy.ops.object.mode_set(mode='OBJECT')
    seams = np.zeros(len(tmp.data.edges), bool)
    tmp.data.edges.foreach_get('use_seam', seams)
    bpy.data.meshes.remove(tmp.data)
    me.edges.foreach_set('use_seam', seams)
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    try:
        bpy.ops.uv.unwrap(method='MINIMUM_STRETCH', margin=0.0)
        how = 'MINIMUM_STRETCH'
    except Exception:  # noqa
        bpy.ops.uv.unwrap(method='ANGLE_BASED', margin=0.0)
        how = 'ANGLE_BASED'
    bpy.ops.object.mode_set(mode='OBJECT')
    R.log('unwrap', how, 'seams', int(seams.sum()))


def add_zero_skirt(obj):
    """The kit tools (atlas pack, bake, export) expect the cliff 'skirt' face attribute: all zero here."""
    me = obj.data
    if 'skirt' not in me.attributes:
        me.attributes.new('skirt', 'INT', 'FACE')
    me.attributes['skirt'].data.foreach_set('value', np.zeros(len(me.polygons), np.int32))
