"""Bake one kit piece (hi-res scan -> packed lod0 atlas UVs) with Cycles on the GPU.

  blender --background --factory-startup -t 6 --python bake_piece.py -- <piece> <res> [samples]

Inputs: work/<piece>.blend (prep.py: <piece>_hi with the scan, <piece>_lod0), work/<piece>_lod0_uv.npy (atlas_pack.py).
Bakes into <res>^2 float images, only this piece's texels:
  mask   : R = skirt face, G = coverage (lod0 itself, emission)
  diff   : scan albedo (DIFFUSE colour, selected to active)
  nrm    : tangent-space normal (OpenGL +Y) of the scan geometry + the scan's own normal map
  arm    : scan AO / roughness / metal (emission transfer)
Skirt vertices are folded up onto the face during the bake (skirt_parent attribute), so the aprons get real rock
texture mirrored from the face just above them.
Output: work/bake/<piece>.npz (texel indices + float16 values per map).
"""
import os
import sys
import glob
import json
import time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import rocklib as R  # noqa: E402

args = R.args_after_dashes()
piece = args[0]
RES = int(args[1]) if len(args) > 1 else 4096
SAMPLES = int(args[2]) if len(args) > 2 else 16
W = R.WORK + '/work'
OUT = W + '/bake'
os.makedirs(OUT, exist_ok=True)
t0 = time.time()

bpy.ops.wm.open_mainfile(filepath=f'{W}/{piece}.blend')
scene = bpy.context.scene
hi = bpy.data.objects[f'{piece}_hi']
lo = bpy.data.objects[f'{piece}_lod0']
for o in list(scene.objects):
    if o not in (hi, lo):
        bpy.data.objects.remove(o)
uv = np.load(f'{W}/{piece}_lod0_uv.npy')
lo.data.uv_layers.active.data.foreach_set('uv', uv.astype(np.float32).ravel())
lo.data.update()

meta = json.load(open(f'{W}/{piece}.json'))
scan = meta['scan']
tex = {}
for k in ('diff', 'nor_gl', 'arm'):
    tex[k] = glob.glob(f'{R.RAW}/{scan}/textures/{scan}_{k}_*.jpg')[0]
R.log(piece, 'scan', scan, {k: os.path.basename(v) for k, v in tex.items()})

R.gpu_cycles(scene, samples=SAMPLES)
scene.cycles.use_denoising = False
try:
    scene.cycles.use_adaptive_sampling = False
except Exception:
    pass


def node_mat(name):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    m.node_tree.nodes.clear()
    return m, m.node_tree.nodes, m.node_tree.links


def load_img(path, cs):
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = cs
    return img


# ---- hi materials
m_hi, N, L = node_mat('bake_hi')
uvn = N.new('ShaderNodeUVMap')
uvn.uv_map = hi.data.uv_layers.active.name
di = N.new('ShaderNodeTexImage')
di.image = load_img(tex['diff'], 'sRGB')
ni = N.new('ShaderNodeTexImage')
ni.image = load_img(tex['nor_gl'], 'Non-Color')
nm = N.new('ShaderNodeNormalMap')
nm.uv_map = uvn.uv_map
bs = N.new('ShaderNodeBsdfPrincipled')
out = N.new('ShaderNodeOutputMaterial')
L.new(uvn.outputs['UV'], di.inputs['Vector'])
L.new(uvn.outputs['UV'], ni.inputs['Vector'])
L.new(di.outputs['Color'], bs.inputs['Base Color'])
L.new(ni.outputs['Color'], nm.inputs['Color'])
L.new(nm.outputs['Normal'], bs.inputs['Normal'])
bs.inputs['Roughness'].default_value = 0.9
L.new(bs.outputs['BSDF'], out.inputs['Surface'])

m_arm, N2, L2 = node_mat('bake_hi_arm')
uv2 = N2.new('ShaderNodeUVMap')
uv2.uv_map = uvn.uv_map
ai = N2.new('ShaderNodeTexImage')
ai.image = load_img(tex['arm'], 'Non-Color')
em = N2.new('ShaderNodeEmission')
em.inputs['Strength'].default_value = 1.0
o2 = N2.new('ShaderNodeOutputMaterial')
L2.new(uv2.outputs['UV'], ai.inputs['Vector'])
L2.new(ai.outputs['Color'], em.inputs['Color'])
L2.new(em.outputs['Emission'], o2.inputs['Surface'])


def set_mat(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    obj.data.polygons.foreach_set('material_index', np.zeros(len(obj.data.polygons), np.int32))


set_mat(hi, m_hi)

# ---- lo material: emission = (skirt, 1, 0) for the mask bake + the active target image node
m_lo, N3, L3 = node_mat('bake_lo')
at = N3.new('ShaderNodeAttribute')
at.attribute_type = 'GEOMETRY'
at.attribute_name = 'skirt'
cc = N3.new('ShaderNodeCombineColor')
cc.inputs[1].default_value = 1.0
cc.inputs[2].default_value = 0.0
L3.new(at.outputs['Fac'], cc.inputs[0])
em3 = N3.new('ShaderNodeEmission')
L3.new(cc.outputs['Color'], em3.inputs['Color'])
o3 = N3.new('ShaderNodeOutputMaterial')
L3.new(em3.outputs['Emission'], o3.inputs['Surface'])
tgt = N3.new('ShaderNodeTexImage')
N3.active = tgt
tgt.select = True
set_mat(lo, m_lo)


def target(name):
    img = R.new_image(f'{piece}_{name}', RES, RES, float_buffer=True, srgb=False, alpha=True, color=(0, 0, 0, 0))
    tgt.image = img
    N3.active = tgt
    return img


def select(objs, active):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.hide_render = False
        o.select_set(True)
    bpy.context.view_layer.objects.active = active


common = dict(margin=0, use_clear=False, target='IMAGE_TEXTURES')
s2a = dict(use_selected_to_active=True, cage_extrusion=float(os.environ.get('EXTRUDE', '0.2')),
           max_ray_distance=float(os.environ.get('RAYDIST', '0.6')))
imgs = {}

# 1. mask (lo only)
hi.hide_render = True
imgs['mask'] = target('mask')
select([lo], lo)
bpy.ops.object.bake(type='EMIT', use_selected_to_active=False, **common)
R.log('mask baked', round(time.time() - t0, 1))
hi.hide_render = False

# fold skirt vertices up onto the face for the transfer bakes
me = lo.data
co = np.empty(len(me.vertices) * 3, np.float32)
me.vertices.foreach_get('co', co)
co = co.reshape(-1, 3)
par = np.zeros(len(me.vertices), np.int32)
if 'skirt_parent' in me.attributes:
    me.attributes['skirt_parent'].data.foreach_get('value', par)
sk = np.where(par > 0)[0]
if len(sk):
    Htop = float(co[:, 2].max())
    p = par[sk] - 1
    d = co[p] - co[sk]
    dl = np.linalg.norm(d, axis=1)
    k = np.minimum(1.0, 0.45 * max(Htop, 1.0) / np.maximum(dl, 1e-6))
    fco = co.copy()
    fco[sk] = co[p] + d * k[:, None]
    me.vertices.foreach_set('co', fco.ravel())
    me.update()
    R.log('folded skirt verts', len(sk))

select([hi, lo], lo)
imgs['diff'] = target('diff')
bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, **s2a, **common)
R.log('diffuse baked', round(time.time() - t0, 1))
imgs['nrm'] = target('nrm')
bpy.ops.object.bake(type='NORMAL', normal_space='TANGENT', normal_r='POS_X', normal_g='POS_Y', normal_b='POS_Z',
                    **s2a, **common)
R.log('normal baked', round(time.time() - t0, 1))
set_mat(hi, m_arm)
imgs['arm'] = target('arm')
bpy.ops.object.bake(type='EMIT', **s2a, **common)
R.log('arm baked', round(time.time() - t0, 1))

# ---- save the piece's texels
mask = R.img_to_np(imgs['mask'])
cov = mask[..., 3] > 0.5
idx = np.flatnonzero(cov.ravel()).astype(np.int32)
data = dict(idx=idx, res=np.int32(RES))
for k, img in imgs.items():
    a = R.img_to_np(img).reshape(-1, 4)[idx]
    data[k] = a.astype(np.float16)
np.savez(f'{OUT}/{piece}.npz', **data)
R.log('saved', f'{OUT}/{piece}.npz', 'texels', len(idx), 'diff hit', int((data['diff'][:, 3] > 0.5).sum()),
      'time', round(time.time() - t0, 1))
