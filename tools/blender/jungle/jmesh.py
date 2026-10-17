"""Blender-side helpers for the jungle generators: numpy mesh builder, tubes, cards, glTF materials, export,
Cycles setup and EXR read-back. Import inside Blender (bpy available)."""
import math
import os

import bpy
import numpy as np


# ------------------------------------------------------------------------------------------------ math helpers
def norm(v):
    v = np.asarray(v, np.float64)
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, 1e-12)


def perp(d):
    """A unit vector perpendicular to d (stable)."""
    d = norm(d)
    a = np.array([0.0, 0.0, 1.0]) if abs(d[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
    return norm(np.cross(d, a))


def rot(axis, ang):
    """Rotation matrix (3x3) about unit axis by ang radians."""
    axis = norm(axis)
    x, y, z = axis
    c, s = math.cos(ang), math.sin(ang)
    C = 1 - c
    return np.array([[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
                     [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
                     [z * x * C - y * s, z * y * C + x * s, c + z * z * C]])


def catmull(pts, n_per):
    """Catmull-Rom resample of control points (K x 3) with n_per samples per span (endpoints included)."""
    P = np.asarray(pts, np.float64)
    P = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for k in range(n_per):
            t = k / n_per
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(P[-2])
    return np.array(out)


def frames(path):
    """Parallel-transport frames along a polyline: returns tangents, normals, binormals (K x 3 each)."""
    P = np.asarray(path, np.float64)
    T = np.zeros_like(P)
    T[1:-1] = P[2:] - P[:-2]
    T[0] = P[1] - P[0]
    T[-1] = P[-1] - P[-2]
    T = norm(T)
    N = np.zeros_like(P)
    N[0] = perp(T[0])
    for i in range(1, len(P)):
        b = np.cross(T[i - 1], T[i])
        bl = np.linalg.norm(b)
        if bl < 1e-9:
            N[i] = N[i - 1]
        else:
            ang = math.atan2(bl, float(np.dot(T[i - 1], T[i])))
            N[i] = rot(b / bl, ang) @ N[i - 1]
        N[i] = norm(N[i] - T[i] * np.dot(N[i], T[i]))
    B = np.cross(T, N)
    return T, N, B


def arclen(path):
    d = np.linalg.norm(np.diff(path, axis=0), axis=1)
    return np.concatenate([[0], np.cumsum(d)])


# ------------------------------------------------------------------------------------------------ mesh builder
class MB:
    """Accumulates a mesh: vertices with RGBA colour and optional custom normals, faces with per-corner UVs and a
    material index. Vertices are shared across UV seams (UVs live on face corners), so smooth normals stay
    continuous."""

    def __init__(self):
        self.V, self.C, self.N, self.Nf = [], [], [], []
        self.F, self.UV, self.M = [], [], []
        self.nv = 0

    def verts(self, P, C, N=None):
        P = np.asarray(P, np.float64).reshape(-1, 3)
        C = np.asarray(C, np.float64).reshape(-1, 4) if np.ndim(C) > 1 else np.tile(np.asarray(C, np.float64), (len(P), 1))
        base = self.nv
        self.V.append(P)
        self.C.append(C)
        if N is None:
            self.N.append(np.zeros_like(P))
            self.Nf.append(np.zeros(len(P), bool))
        else:
            self.N.append(norm(np.asarray(N, np.float64).reshape(-1, 3)))
            self.Nf.append(np.ones(len(P), bool))
        self.nv += len(P)
        return base

    def face(self, idx, uvs, mat=0):
        self.F.append(tuple(int(i) for i in idx))
        self.UV.extend(uvs)
        self.M.append(mat)

    def tris(self):
        return sum(len(f) - 2 for f in self.F)

    def merge(self, other):
        base = self.nv
        self.V += other.V
        self.C += other.C
        self.N += other.N
        self.Nf += other.Nf
        self.F += [tuple(i + base for i in f) for f in other.F]
        self.UV += other.UV
        self.M += other.M
        self.nv += other.nv

    def build(self, name, materials, smooth=True):
        V = np.concatenate(self.V) if self.V else np.zeros((0, 3))
        C = np.concatenate(self.C) if self.C else np.zeros((0, 4))
        N = np.concatenate(self.N) if self.N else np.zeros((0, 3))
        Nf = np.concatenate(self.Nf) if self.Nf else np.zeros(0, bool)
        me = bpy.data.meshes.new(name)
        me.from_pydata(V.tolist(), [], self.F)
        me.update()
        uv = me.uv_layers.new(name='UVMap')
        uv.data.foreach_set('uv', np.asarray(self.UV, np.float32).ravel())
        ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
        ca.data.foreach_set('color', np.asarray(C, np.float32).ravel())
        me.color_attributes.active_color = ca
        try:
            me.color_attributes.render_color_index = me.color_attributes.active_color_index
        except Exception:
            pass
        for m in materials:
            me.materials.append(m)
        me.polygons.foreach_set('material_index', np.asarray(self.M, np.int32))
        me.polygons.foreach_set('use_smooth', np.full(len(self.F), smooth, bool))
        me.update()
        if Nf.any():
            vn = np.empty(len(V) * 3, np.float32)
            me.vertex_normals.foreach_get('vector', vn)
            vn = vn.reshape(-1, 3)
            vn[Nf] = N[Nf]
            me.normals_split_custom_set_from_vertices(vn.tolist())
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob


def tube(mb, path, radii, sides, color_fn, mat=0, u_wrap=1, v_scale=1.0, v0=0.0, cap=False, seg_v=None, twist=0.0,
         jitter=None):
    """Sweep a tube along path (K x 3) with per-point radius. color_fn(i, s_frac, ring_angle_array) -> (sides x 4).
    UV: u = u_wrap * a / 2pi around (seam shared), v = v0 + arclength * v_scale, optionally folded into segments by
    seg_v(v) -> v' with seam rings. Returns list of ring vertex index arrays."""
    P = np.asarray(path, np.float64)
    K = len(P)
    T, Nn, B = frames(P)
    s = arclen(P)
    L = max(s[-1], 1e-6)
    ang = np.linspace(0, 2 * math.pi, sides, endpoint=False)
    rings = []
    for i in range(K):
        a = ang + twist * s[i]
        r = radii[i] if np.ndim(radii) else radii
        rr = np.full(sides, r) if np.ndim(r) == 0 else np.asarray(r)
        if jitter is not None:
            rr = rr * jitter(i, a)
        pts = P[i] + (np.outer(np.cos(a), Nn[i]) + np.outer(np.sin(a), B[i])) * rr[:, None]
        col = color_fn(i, s[i] / L, a)
        rings.append(mb.verts(pts, col) + np.arange(sides))
    for i in range(K - 1):
        va, vb = v0 + s[i] * v_scale, v0 + s[i + 1] * v_scale
        if seg_v is not None:
            va, vb = seg_v(va, vb)
        for j in range(sides):
            j2 = (j + 1) % sides
            ua, ub = u_wrap * j / sides, u_wrap * (j + 1) / sides
            mb.face((rings[i][j], rings[i][j2], rings[i + 1][j2], rings[i + 1][j]),
                    [(ua, va), (ub, va), (ub, vb), (ua, vb)], mat)
    if cap:
        c = mb.verts(P[-1:] + T[-1] * 0.0, color_fn(K - 1, 1.0, ang[:1])[:1])
        for j in range(sides):
            j2 = (j + 1) % sides
            mb.face((rings[-1][j], rings[-1][j2], c), [(0.5, v0), (0.5, v0), (0.5, v0)], mat)
    return rings


# ------------------------------------------------------------------------------------------------ materials
def load_image(path, colorspace='sRGB'):
    name = os.path.basename(path)
    img = bpy.data.images.get(name)
    if img is None or img.filepath != path:
        img = bpy.data.images.load(path, check_existing=False)
        img.name = name
    img.colorspace_settings.name = colorspace
    return img


def gltf_output_group():
    g = bpy.data.node_groups.get('glTF Material Output')
    if g is None:
        g = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
        g.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
        g.interface.new_socket('Thickness', in_out='INPUT', socket_type='NodeSocketFloat')
    return g


def pbr_material(name, albedo, normal=None, orm=None, alpha=False, double_sided=False, preview_translucency=0.0):
    """glTF-exportable material: baseColor (+alpha MASK 0.5 via Round), normal map, ORM (R occlusion, G rough,
    B metal). preview_translucency adds a Translucent BSDF mix for Cycles previews only (not exported)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    uv = nt.nodes.new('ShaderNodeUVMap')
    uv.uv_map = 'UVMap'
    ti = nt.nodes.new('ShaderNodeTexImage')
    ti.image = load_image(albedo, 'sRGB')
    nt.links.new(uv.outputs['UV'], ti.inputs['Vector'])
    nt.links.new(ti.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Metallic'].default_value = 0.0
    if alpha:
        rnd = nt.nodes.new('ShaderNodeMath')
        rnd.operation = 'ROUND'
        nt.links.new(ti.outputs['Alpha'], rnd.inputs[0])
        nt.links.new(rnd.outputs[0], bsdf.inputs['Alpha'])
    if normal:
        tn = nt.nodes.new('ShaderNodeTexImage')
        tn.image = load_image(normal, 'Non-Color')
        nt.links.new(uv.outputs['UV'], tn.inputs['Vector'])
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nm.uv_map = 'UVMap'
        nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    if orm:
        to = nt.nodes.new('ShaderNodeTexImage')
        to.image = load_image(orm, 'Non-Color')
        nt.links.new(uv.outputs['UV'], to.inputs['Vector'])
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(to.outputs['Color'], sep.inputs['Color'])
        nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
        bsdf.inputs['Metallic'].default_value = 0.0
        go = nt.nodes.new('ShaderNodeGroup')
        go.node_tree = gltf_output_group()
        nt.links.new(sep.outputs['Red'], go.inputs['Occlusion'])
    if preview_translucency > 0:
        tr = nt.nodes.new('ShaderNodeBsdfTranslucent')
        hsv = nt.nodes.new('ShaderNodeHueSaturation')
        hsv.inputs['Saturation'].default_value = 1.25
        hsv.inputs['Value'].default_value = 1.6
        nt.links.new(ti.outputs['Color'], hsv.inputs['Color'])
        nt.links.new(hsv.outputs['Color'], tr.inputs['Color'])
        mix = nt.nodes.new('ShaderNodeMixShader')
        mix.inputs['Fac'].default_value = preview_translucency
        nt.links.new(bsdf.outputs['BSDF'], mix.inputs[1])
        nt.links.new(tr.outputs['BSDF'], mix.inputs[2])
        if alpha:
            tp = nt.nodes.new('ShaderNodeBsdfTransparent')
            mx2 = nt.nodes.new('ShaderNodeMixShader')
            nt.links.new(rnd.outputs[0], mx2.inputs['Fac'])
            nt.links.new(tp.outputs['BSDF'], mx2.inputs[1])
            nt.links.new(mix.outputs['Shader'], mx2.inputs[2])
            nt.links.new(mx2.outputs['Shader'], out.inputs['Surface'])
        else:
            nt.links.new(mix.outputs['Shader'], out.inputs['Surface'])
    else:
        nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    m.use_backface_culling = not double_sided
    try:
        m.surface_render_method = 'DITHERED'
    except Exception:
        pass
    return m


# ------------------------------------------------------------------------------------------------ scene / io
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def cycles_gpu(scene, samples=32, threads=6):
    scene.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for t in ('OPTIX', 'CUDA'):
        try:
            prefs.compute_device_type = t
            prefs.get_devices()
            ok = False
            for d in prefs.devices:
                d.use = d.type == t
                ok = ok or d.use
            if ok:
                break
        except Exception:
            continue
    scene.cycles.device = 'GPU'
    scene.cycles.samples = samples
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = threads


def export_glb(path, objects):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=True,
              export_texcoords=True, export_normals=True, export_tangents=False, export_materials='EXPORT',
              export_animations=False, export_cameras=False, export_lights=False, export_extras=False)
    try:
        bpy.ops.export_scene.gltf(**kw, export_vertex_color='ACTIVE', export_all_vertex_colors=False)
    except TypeError:
        bpy.ops.export_scene.gltf(**kw, export_colors=True)


def read_exr(path):
    """Load a rendered EXR -> HxWx4 float32, row 0 = top, premultiplied as rendered."""
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    px = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(h, w, 4)[::-1].copy()
