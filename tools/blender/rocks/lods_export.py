"""Build LODs, assign the shared material and export a kit GLB (scratch), ready for tools/optimize-glb.ts.

  blender --background --factory-startup -t 6 --python lods_export.py -- <pieces.json>

Reads work/<kit>_kit.blend (atlas-packed lod0 meshes) and work/tex/<kit>_{albedo,normal,orm}.png. For every piece:
lod1 / lod2 = collapse-decimated copies of lod0 (same atlas UVs). One material <family>_<kit> (glTF PBR: baseColor,
normal (OpenGL), ORM: R = AO, G = roughness, B = metalness 0). Nodes are top level, transforms applied, named
<piece>_lod<k>. Blender -Y (the cliff face direction) becomes glTF +Z, Blender +Z becomes glTF +Y.
Writes work/<kit>_raw.glb, work/<kit>_lods.blend and work/<kit>_lods.json (triangles per node, bounding boxes).
"""
import os
import sys
import json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import rocklib as R  # noqa: E402

args = R.args_after_dashes()
cfg = json.load(open(args[0]))
KIT = cfg['kit']
FAMILY = cfg.get('family', 'rock')
W = R.WORK + '/work'
TEX = W + '/tex'
TARGETS = cfg.get('lod_tris', [None, 5800, 1150])

bpy.ops.wm.open_mainfile(filepath=f'{W}/{KIT}_kit.blend')
scene = bpy.context.scene

# ---- material
mat = bpy.data.materials.new(f'{FAMILY}_{KIT}')
try:
    mat.use_nodes = True
except Exception:
    pass
# glTF doubleSided = not backface culling; closed bodies (stacks, boulders, shelves) are single-sided,
# the cliff pieces are open shells (top / back) and stay double-sided
mat.use_backface_culling = not cfg.get('double_sided', True)
nt = mat.node_tree
N, L = nt.nodes, nt.links
N.clear()
out = N.new('ShaderNodeOutputMaterial')
bs = N.new('ShaderNodeBsdfPrincipled')
L.new(bs.outputs['BSDF'], out.inputs['Surface'])


def img_node(path, cs):
    n = N.new('ShaderNodeTexImage')
    n.image = bpy.data.images.load(path, check_existing=True)
    n.image.colorspace_settings.name = cs
    return n


alb = img_node(f'{TEX}/{KIT}_albedo.png', 'sRGB')
L.new(alb.outputs['Color'], bs.inputs['Base Color'])
nrm = img_node(f'{TEX}/{KIT}_normal.png', 'Non-Color')
nmap = N.new('ShaderNodeNormalMap')
L.new(nrm.outputs['Color'], nmap.inputs['Color'])
L.new(nmap.outputs['Normal'], bs.inputs['Normal'])
orm = img_node(f'{TEX}/{KIT}_orm.png', 'Non-Color')
sep = N.new('ShaderNodeSeparateColor')
L.new(orm.outputs['Color'], sep.inputs['Color'])
L.new(sep.outputs['Green'], bs.inputs['Roughness'])
L.new(sep.outputs['Blue'], bs.inputs['Metallic'])
# glTF occlusion: the exporter reads the 'Occlusion' input of a group named 'glTF Material Output'
ng = bpy.data.node_groups.get('glTF Material Output') or bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
if not any(getattr(i, 'name', '') == 'Occlusion' for i in ng.interface.items_tree):
    ng.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
gn = N.new('ShaderNodeGroup')
gn.node_tree = ng
L.new(sep.outputs['Red'], gn.inputs['Occlusion'])

meta = {}
export_objs = []
for P in cfg['pieces']:
    name = P['name']
    lo = bpy.data.objects[f'{name}_lod0']
    for a in ('skirt', 'skirt_parent'):
        if a in lo.data.attributes:
            lo.data.attributes.remove(lo.data.attributes[a])
    lo.data.materials.clear()
    lo.data.materials.append(mat)
    lo.data.polygons.foreach_set('material_index', np.zeros(len(lo.data.polygons), np.int32))
    lo.data.polygons.foreach_set('use_smooth', np.ones(len(lo.data.polygons), bool))
    lods = [lo]
    for k, tgt in enumerate(P.get('lod_tris', TARGETS)[1:], start=1):
        o = lo.copy()
        o.data = lo.data.copy()
        scene.collection.objects.link(o)
        o.name = o.data.name = f'{name}_lod{k}'
        bpy.ops.object.select_all(action='DESELECT')
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        m = o.modifiers.new('dec', 'DECIMATE')
        m.decimate_type = 'COLLAPSE'
        m.use_collapse_triangulate = True
        m.ratio = min(1.0, tgt / max(R.tri_count(lo), 1))
        bpy.ops.object.modifier_apply(modifier=m.name)
        # one corrective pass if the collapse overshoots the budget
        t = R.tri_count(o)
        if t > tgt * 1.04:
            m = o.modifiers.new('dec2', 'DECIMATE')
            m.decimate_type = 'COLLAPSE'
            m.use_collapse_triangulate = True
            m.ratio = tgt / t
            bpy.ops.object.modifier_apply(modifier=m.name)
        lods.append(o)
    info = {}
    for k, o in enumerate(lods):
        co, _ = R.mesh_arrays(o)
        info[f'lod{k}'] = dict(node=o.name, tris=R.tri_count(o), verts=len(o.data.vertices))
        export_objs.append(o)
    co, _ = R.mesh_arrays(lo)
    mn, mx = co.min(0), co.max(0)
    # glTF axes: x = x, y = z(blender), z = -y(blender)
    info['bbox_gltf'] = dict(min=[float(mn[0]), float(mn[2]), float(-mx[1])], max=[float(mx[0]), float(mx[2]), float(-mn[1])])
    meta[name] = info
    R.log(name, {k: v['tris'] for k, v in info.items() if k.startswith('lod')})

for o in list(scene.objects):
    if o not in export_objs:
        bpy.data.objects.remove(o)
bpy.ops.object.select_all(action='DESELECT')
for o in export_objs:
    o.select_set(True)
bpy.context.view_layer.objects.active = export_objs[0]
glb = f'{W}/{KIT}_raw.glb'
kw = dict(filepath=glb, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
          export_texcoords=True, export_normals=True, export_tangents=True, export_materials='EXPORT',
          export_animations=False, export_cameras=False, export_lights=False, export_image_format='AUTO')
try:
    bpy.ops.export_scene.gltf(**kw, export_vertex_color='NONE')
except TypeError:
    bpy.ops.export_scene.gltf(**kw)
json.dump(meta, open(f'{W}/{KIT}_lods.json', 'w'), indent=1)
bpy.ops.wm.save_as_mainfile(filepath=f'{W}/{KIT}_lods.blend', compress=False)
R.log('exported', glb, os.path.getsize(glb) // 1024, 'KB')
