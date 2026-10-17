"""Blender side of the palm builders: materials, mesh objects from MeshBuilder, AO bake into COLOR_0.R, GLB export."""
import math
import numpy as np
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from common import load_image, resize, SCRATCH

TEX = SCRATCH + '/tex'


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def _gltf_output_group():
    ng = bpy.data.node_groups.get('glTF Material Output')
    if ng is None:
        ng = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
        ng.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
        ng.nodes.new('NodeGroupInput')
    return ng


def _img(path, colour):
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = 'sRGB' if colour else 'Non-Color'
    return img


def make_material(name, base, normal, orm, alpha_clip=False, double_sided=False, rough_factor=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    tc = nt.nodes.new('ShaderNodeTexImage')
    tc.image = _img(base, True)
    tc.location = (-700, 300)
    nt.links.new(tc.outputs['Color'], bsdf.inputs['Base Color'])
    tn = nt.nodes.new('ShaderNodeTexImage')
    tn.image = _img(normal, False)
    tn.location = (-700, -300)
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nm.location = (-350, -300)
    nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    to = nt.nodes.new('ShaderNodeTexImage')
    to.image = _img(orm, False)
    to.location = (-700, 0)
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    sep.location = (-400, 0)
    nt.links.new(to.outputs['Color'], sep.inputs['Color'])
    if rough_factor != 1.0:
        mul = nt.nodes.new('ShaderNodeMath')
        mul.operation = 'MULTIPLY'
        mul.inputs[1].default_value = rough_factor
        nt.links.new(sep.outputs['Green'], mul.inputs[0])
        nt.links.new(mul.outputs[0], bsdf.inputs['Roughness'])
    else:
        nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
    bsdf.inputs['Metallic'].default_value = 0.0
    grp = nt.nodes.new('ShaderNodeGroup')
    grp.node_tree = _gltf_output_group()
    grp.location = (0, -500)
    nt.links.new(sep.outputs['Red'], grp.inputs['Occlusion'])
    if alpha_clip:
        mth = nt.nodes.new('ShaderNodeMath')
        mth.operation = 'ROUND'
        mth.location = (-350, 450)
        nt.links.new(tc.outputs['Alpha'], mth.inputs[0])
        nt.links.new(mth.outputs[0], bsdf.inputs['Alpha'])
    m.use_backface_culling = not double_sided
    return m


def palm_materials():
    mats = {}
    mats['palm_bark'] = make_material('palm_bark', f'{TEX}/palm_bark_basecolor.png', f'{TEX}/palm_bark_normal.png', f'{TEX}/palm_bark_orm.png')
    mats['palm_frond'] = make_material('palm_frond', f'{TEX}/palm_frond_basecolor.png', f'{TEX}/palm_frond_normal.png', f'{TEX}/palm_frond_orm.png',
                                       alpha_clip=True, double_sided=True)
    # same atlas as the bark; the smoother husk (roughness factor) also keeps it a separate material through dedup
    mats['palm_nut'] = make_material('palm_nut', f'{TEX}/palm_bark_basecolor.png', f'{TEX}/palm_bark_normal.png', f'{TEX}/palm_bark_orm.png',
                                     rough_factor=0.85)
    return [mats['palm_bark'], mats['palm_frond'], mats['palm_nut']]


# ---------------------------------------------------------------------------------------------------------------------
def builder_arrays(mb):
    co = np.array(mb.co, dtype=np.float64)
    tris, tri_uv, tri_mat = [], [], []
    for idx, uvs, mat in mb.faces:
        for k in range(1, len(idx) - 1):
            tris.append((idx[0], idx[k], idx[k + 1]))
            tri_uv.append((uvs[0], uvs[k], uvs[k + 1]))
            tri_mat.append(mat)
    return co, np.array(tris, dtype=np.int64), np.array(tri_uv, dtype=np.float64), np.array(tri_mat)


def vertex_normals(co, tris):
    n = np.zeros_like(co)
    fn = np.cross(co[tris[:, 1]] - co[tris[:, 0]], co[tris[:, 2]] - co[tris[:, 0]])
    for k in range(3):
        np.add.at(n, tris[:, k], fn)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    return n / np.maximum(ln, 1e-12)


class AOBaker:
    """ray-traced vertex AO against a reference mesh (LOD0) plus a ground plane; foliage hits are alpha tested"""

    def __init__(self, ref_mb, frond_alpha, ground_z=0.0, frond_mat=1):
        co, tris, tuv, tmat = builder_arrays(ref_mb)
        # ground: big quad (two triangles) slightly below z = 0
        g = 60.0
        base = len(co)
        co = np.vstack([co, [[-g, -g, ground_z - 0.02], [g, -g, ground_z - 0.02], [g, g, ground_z - 0.02], [-g, g, ground_z - 0.02]]])
        tris = np.vstack([tris, [[base, base + 1, base + 2], [base, base + 2, base + 3]]])
        tuv = np.vstack([tuv, np.zeros((2, 3, 2))])
        tmat = np.concatenate([tmat, [-1, -1]])
        self.co, self.tris, self.tuv, self.tmat = co, tris, tuv, tmat
        self.bvh = BVHTree.FromPolygons([Vector(c) for c in co], tris.tolist(), all_triangles=True)
        self.alpha = frond_alpha
        self.ah, self.aw = frond_alpha.shape
        self.frond_mat = frond_mat

    def _alpha_at(self, ti, loc):
        a, b, c = self.co[self.tris[ti]]
        v0, v1, v2 = b - a, c - a, np.asarray(loc) - a
        d00, d01, d11 = v0 @ v0, v0 @ v1, v1 @ v1
        d20, d21 = v2 @ v0, v2 @ v1
        den = d00 * d11 - d01 * d01
        if abs(den) < 1e-14:
            return 1.0
        w1 = (d11 * d20 - d01 * d21) / den
        w2 = (d00 * d21 - d01 * d20) / den
        w0 = 1 - w1 - w2
        uv = self.tuv[ti]
        u = w0 * uv[0][0] + w1 * uv[1][0] + w2 * uv[2][0]
        v = w0 * uv[0][1] + w1 * uv[1][1] + w2 * uv[2][1]
        x = int(min(self.aw - 1, max(0, (u % 1.0) * self.aw)))
        y = int(min(self.ah - 1, max(0, v * self.ah)))
        return self.alpha[y, x]

    def visibility(self, p, d, maxd=8.0):
        o = Vector(p)
        dv = Vector(d)
        travelled = 0.0
        for _ in range(10):
            loc, nor, idx, dist = self.bvh.ray_cast(o, dv, maxd - travelled)
            if loc is None:
                return 1.0
            if self.tmat[idx] == self.frond_mat and self._alpha_at(idx, loc) < 0.5:
                travelled += dist + 0.004
                o = loc + dv * 0.004
                continue
            return 0.0
        return 1.0

    def bake(self, mb, nrays=40, seed=3):
        co, tris, _, _ = builder_arrays(mb)
        vn = vertex_normals(co, tris)
        rng = np.random.default_rng(seed)
        out = np.ones(len(co))
        kinds = np.array(mb.kind)
        # fixed direction sets (stratified)
        k = np.arange(nrays) + 0.5
        zs = 1 - k / nrays          # hemisphere z in (0, 1)
        ph = k * math.pi * (3 - math.sqrt(5))
        hemi = np.stack([np.sqrt(1 - zs ** 2) * np.cos(ph), np.sqrt(1 - zs ** 2) * np.sin(ph), zs], 1)
        zs2 = 1 - 2 * k / nrays
        sph = np.stack([np.sqrt(1 - zs2 ** 2) * np.cos(ph), np.sqrt(1 - zs2 ** 2) * np.sin(ph), zs2], 1)
        for i in range(len(co)):
            p = co[i]
            if kinds[i] == 1:
                # foliage: whole sphere, sky (upper) directions weigh more
                rotz = rng.uniform(0, 2 * math.pi)
                c, s = math.cos(rotz), math.sin(rotz)
                dirs = sph @ np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]]).T
                w = np.where(dirs[:, 2] > 0, 1.0, 0.35)
                vis = 0.0
                for d, ww in zip(dirs, w):
                    vis += ww * self.visibility(p + d * 0.02, d)
                out[i] = vis / w.sum()
            else:
                n = vn[i]
                t = np.cross(n, [0.0, 0.0, 1.0]) if abs(n[2]) < 0.9 else np.cross(n, [1.0, 0.0, 0.0])
                t /= np.linalg.norm(t)
                b = np.cross(n, t)
                rotz = rng.uniform(0, 2 * math.pi)
                c, s = math.cos(rotz), math.sin(rotz)
                loc = hemi @ np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]]).T
                dirs = loc[:, :1] * t + loc[:, 1:2] * b + loc[:, 2:3] * n
                vis = 0.0
                for d in dirs:
                    vis += self.visibility(p + n * 0.015, d)
                out[i] = vis / nrays
        return out


def frond_alpha_small():
    a = load_image(f'{TEX}/palm_frond_basecolor.png', linear=True)[..., 3]
    return resize(a[..., None], 512, 512)[..., 0]


def ao_remap(vis):
    """visibility -> COLOR_0.R (1 open .. ~0.25 deep in the crown or at the trunk base)"""
    return np.clip(0.2 + 0.8 * np.power(np.clip(vis, 0, 1), 1.4), 0.2, 1.0)


# ---------------------------------------------------------------------------------------------------------------------
def mesh_object(name, mb, mats, ao):
    co, _, _, _ = builder_arrays(mb)
    faces = [f[0] for f in mb.faces]
    me = bpy.data.meshes.new(name)
    me.from_pydata(co.tolist(), [], faces)
    uv = me.uv_layers.new(name='UVMap')
    flat = np.array([c for f in mb.faces for uvp in f[1] for c in uvp], dtype=np.float32)
    uv.data.foreach_set('uv', flat)
    me.polygons.foreach_set('material_index', np.array([f[2] for f in mb.faces], dtype=np.int32))
    col = np.zeros((len(co), 4), dtype=np.float32)
    w = np.array(mb.wind, dtype=np.float32)
    col[:, 0] = ao
    col[:, 1:4] = w
    attr = me.color_attributes.new('Color', 'FLOAT_COLOR', 'POINT')
    attr.data.foreach_set('color', col.ravel())
    me.color_attributes.active_color_name = 'Color'
    me.color_attributes.render_color_index = 0
    for m in mats:
        me.materials.append(m)
    me.validate(clean_customdata=False)
    me.update()
    me.shade_smooth()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def export_glb(path, objects=None):
    if objects is not None:
        bpy.ops.object.select_all(action='DESELECT')
        for o in objects:
            o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=objects is not None, export_apply=True,
                              export_yup=True, export_texcoords=True, export_normals=True, export_tangents=False,
                              export_materials='EXPORT', export_vertex_color='ACTIVE', export_all_vertex_colors=False,
                              export_animations=False, export_cameras=False, export_lights=False, export_extras=False,
                              export_image_format='AUTO')
