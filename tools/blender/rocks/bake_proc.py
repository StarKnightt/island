"""Bake one procedural rock body (sculpted <name>_hi -> packed <name>_lod0 atlas UVs) with Cycles on the GPU.

  blender --background --factory-startup -t 6 --python bake_proc.py -- <kit.json> <name> <res> [samples]

Same outputs as bake_piece.py (work/bake/<name>.npz: mask, diff, nrm, arm), but the hi material is built from
tileable Poly Haven scan textures in box (triplanar) projection, object space, sizes from the kit's "material":
  albedo = mix of two fine rock textures by a low-frequency noise, times the luminance of a large-scale rock texture,
           darkened along vertical water-stain streaks and tinted per bedding band (the hi 'band' attribute)
  normal = hi geometry + a bump from the fine texture's displacement
  arm    = R: local AO (AO node, this object only), G: the fine texture's roughness, B: 0
"""
import os
import sys
import json
import time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
import rocklib as R  # noqa: E402

args = R.args_after_dashes()
cfg = json.load(open(args[0]))
name = args[1]
RES = int(args[2]) if len(args) > 2 else 4096
SAMPLES = int(args[3]) if len(args) > 3 else 16
P = next(p for p in cfg['pieces'] if p['name'] == name)
MAT = dict(cfg.get('material', {}), **P.get('material', {}))
W = R.WORK + '/work'
OUT = W + '/bake'
TEXDIR = 'E:/tmp/island/raw/polyhaven/textures'
os.makedirs(OUT, exist_ok=True)
t0 = time.time()

bpy.ops.wm.open_mainfile(filepath=f'{W}/{name}.blend')
scene = bpy.context.scene
hi = bpy.data.objects[f'{name}_hi']
lo = bpy.data.objects[f'{name}_lod0']
for o in list(scene.objects):
    if o not in (hi, lo):
        bpy.data.objects.remove(o)
uv = np.load(f'{W}/{name}_lod0_uv.npy')
lo.data.uv_layers.active.data.foreach_set('uv', uv.astype(np.float32).ravel())
lo.data.update()
R.gpu_cycles(scene, samples=SAMPLES)
scene.cycles.use_denoising = False
try:
    scene.cycles.use_adaptive_sampling = False
except Exception:
    pass


def node_mat(nm):
    m = bpy.data.materials.new(nm)
    try:
        m.use_nodes = True
    except Exception:
        pass
    m.node_tree.nodes.clear()
    return m, m.node_tree.nodes, m.node_tree.links


def tex_path(tex_id, kind):
    ext = 'exr' if kind == 'disp' else 'jpg'
    return f'{TEXDIR}/{tex_id}/{tex_id}_{kind}_4k.{ext}'


def box_img(N, L, coord, path, tile, cs, offset=(0.0, 0.0, 0.0), blend=0.3):
    mp = N.new('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (1 / tile, 1 / tile, 1 / tile)
    mp.inputs['Location'].default_value = offset
    L.new(coord, mp.inputs['Vector'])
    im = N.new('ShaderNodeTexImage')
    im.image = bpy.data.images.load(path, check_existing=True)
    im.image.colorspace_settings.name = cs
    im.projection = 'BOX'
    im.projection_blend = blend
    L.new(mp.outputs['Vector'], im.inputs['Vector'])
    return im


def vmath(N, L, op, a, b=None, scale=None):
    n = N.new('ShaderNodeVectorMath')
    n.operation = op
    if isinstance(a, (tuple, list)):
        n.inputs[0].default_value = a
    else:
        L.new(a, n.inputs[0])
    if b is not None:
        if isinstance(b, (tuple, list)):
            n.inputs[1].default_value = b
        else:
            L.new(b, n.inputs[1])
    if scale is not None:
        if isinstance(scale, (int, float)):
            n.inputs['Scale'].default_value = scale
        else:
            L.new(scale, n.inputs['Scale'])
    return n.outputs['Vector']


def fmath(N, L, op, a, b=None, clamp=False):
    n = N.new('ShaderNodeMath')
    n.operation = op
    n.use_clamp = clamp
    for i, v in enumerate((a, b)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = v
        else:
            L.new(v, n.inputs[i])
    return n.outputs['Value']


# ---- hi material (albedo + bump)
fa, fb, big = MAT['fine_a'], MAT['fine_b'], MAT['big']
m_hi, N, L = node_mat('proc_hi')
tc = N.new('ShaderNodeTexCoord')
co = tc.outputs['Object']
ia = box_img(N, L, co, tex_path(fa['tex'], 'diff'), fa['tile'], 'sRGB')
ib = box_img(N, L, co, tex_path(fb['tex'], 'diff'), fb['tile'], 'sRGB', offset=(0.37, 0.61, 0.13))
ig = box_img(N, L, co, tex_path(big['tex'], 'diff'), big['tile'], 'sRGB', offset=(0.21, 0.77, 0.45), blend=0.4)
nz = N.new('ShaderNodeTexNoise')
nz.inputs['Scale'].default_value = MAT.get('mix_scale', 0.12)
nz.inputs['Detail'].default_value = 3.0
L.new(co, nz.inputs['Vector'])
f = fmath(N, L, 'MULTIPLY_ADD', nz.outputs['Fac'], 3.0, clamp=True)       # (fac * 3 - 1.2) clamped to 0..1
f = fmath(N, L, 'SUBTRACT', f, 1.2, clamp=True)
col = vmath(N, L, 'ADD', ia.outputs['Color'],
            vmath(N, L, 'SCALE', vmath(N, L, 'SUBTRACT', ib.outputs['Color'], ia.outputs['Color']), scale=f))
bw = N.new('ShaderNodeRGBToBW')
L.new(ig.outputs['Color'], bw.inputs['Color'])
gm = fmath(N, L, 'MULTIPLY_ADD', bw.outputs['Val'], MAT.get('big_gain', 1.0))
N[gm.node.name].inputs[2].default_value = MAT.get('big_bias', 0.62)
col = vmath(N, L, 'SCALE', col, scale=gm)
# vertical water-stain streaks
mp = N.new('ShaderNodeMapping')
mp.inputs['Scale'].default_value = (1 / 1.4, 1 / 1.4, 1 / 18.0)
L.new(co, mp.inputs['Vector'])
sn = N.new('ShaderNodeTexNoise')
sn.inputs['Scale'].default_value = 1.0
sn.inputs['Detail'].default_value = 4.0
L.new(mp.outputs['Vector'], sn.inputs['Vector'])
st = fmath(N, L, 'SUBTRACT', sn.outputs['Fac'], 0.52, clamp=True)
st = fmath(N, L, 'MULTIPLY', st, -MAT.get('streaks', 0.3) * 5.0)
st = fmath(N, L, 'ADD', st, 1.0, clamp=True)
col = vmath(N, L, 'SCALE', col, scale=st)
# per-band tint (warmer / cooler bedding layers)
at = N.new('ShaderNodeAttribute')
at.attribute_type = 'GEOMETRY'
at.attribute_name = 'band'
bt = fmath(N, L, 'SUBTRACT', at.outputs['Fac'], 0.5)
bt = fmath(N, L, 'MULTIPLY', bt, MAT.get('band_tint', 0.2))
tint = vmath(N, L, 'ADD', (1.0, 1.0, 1.0), vmath(N, L, 'SCALE', (0.9, 0.15, -0.7), scale=bt))
col = vmath(N, L, 'MULTIPLY', col, tint)
bs = N.new('ShaderNodeBsdfPrincipled')
L.new(col, bs.inputs['Base Color'])
bs.inputs['Roughness'].default_value = 0.9
hd = box_img(N, L, co, tex_path(fa['tex'], 'disp'), fa['tile'], 'Non-Color')
bp = N.new('ShaderNodeBump')
bp.inputs['Strength'].default_value = MAT.get('bump', 0.45)
bp.inputs['Distance'].default_value = MAT.get('bump_dist', 0.05)
L.new(hd.outputs['Color'], bp.inputs['Height'])
L.new(bp.outputs['Normal'], bs.inputs['Normal'])
out = N.new('ShaderNodeOutputMaterial')
L.new(bs.outputs['BSDF'], out.inputs['Surface'])

# ---- hi material for the arm transfer (emission)
m_arm, N2, L2 = node_mat('proc_hi_arm')
tc2 = N2.new('ShaderNodeTexCoord')
ar = box_img(N2, L2, tc2.outputs['Object'], tex_path(fa['tex'], 'arm'), fa['tile'], 'Non-Color')
sp = N2.new('ShaderNodeSeparateColor')
L2.new(ar.outputs['Color'], sp.inputs['Color'])
ao = N2.new('ShaderNodeAmbientOcclusion')
ao.only_local = True
ao.samples = 16
ao.inputs['Distance'].default_value = MAT.get('ao_dist', 2.5)
cc = N2.new('ShaderNodeCombineColor')
L2.new(ao.outputs['AO'], cc.inputs[0])
L2.new(sp.outputs['Green'], cc.inputs[1])
cc.inputs[2].default_value = 0.0
em = N2.new('ShaderNodeEmission')
L2.new(cc.outputs['Color'], em.inputs['Color'])
o2 = N2.new('ShaderNodeOutputMaterial')
L2.new(em.outputs['Emission'], o2.inputs['Surface'])


def set_mat(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    obj.data.polygons.foreach_set('material_index', np.zeros(len(obj.data.polygons), np.int32))


set_mat(hi, m_hi)

# ---- lo material: emission (skirt, 1, 0) for the coverage mask + the active target image node
m_lo, N3, L3 = node_mat('bake_lo')
at3 = N3.new('ShaderNodeAttribute')
at3.attribute_type = 'GEOMETRY'
at3.attribute_name = 'skirt'
c3 = N3.new('ShaderNodeCombineColor')
c3.inputs[1].default_value = 1.0
c3.inputs[2].default_value = 0.0
L3.new(at3.outputs['Fac'], c3.inputs[0])
em3 = N3.new('ShaderNodeEmission')
L3.new(c3.outputs['Color'], em3.inputs['Color'])
o3 = N3.new('ShaderNodeOutputMaterial')
L3.new(em3.outputs['Emission'], o3.inputs['Surface'])
tgt = N3.new('ShaderNodeTexImage')
N3.active = tgt
set_mat(lo, m_lo)


def target(nm):
    img = R.new_image(f'{name}_{nm}', RES, RES, float_buffer=True, srgb=False, alpha=True, color=(0, 0, 0, 0))
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
s2a = dict(use_selected_to_active=True, cage_extrusion=float(os.environ.get('EXTRUDE', MAT.get('extrude', 0.5))),
           max_ray_distance=float(os.environ.get('RAYDIST', MAT.get('raydist', 1.4))))
imgs = {}
hi.hide_render = True
imgs['mask'] = target('mask')
select([lo], lo)
bpy.ops.object.bake(type='EMIT', use_selected_to_active=False, **common)
hi.hide_render = False
R.log('mask baked', round(time.time() - t0, 1))
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

mask = R.img_to_np(imgs['mask'])
cov = mask[..., 3] > 0.5
idx = np.flatnonzero(cov.ravel()).astype(np.int32)
data = dict(idx=idx, res=np.int32(RES))
for k, img in imgs.items():
    data[k] = R.img_to_np(img).reshape(-1, 4)[idx].astype(np.float16)
np.savez(f'{OUT}/{name}.npz', **data)
R.log('saved', f'{OUT}/{name}.npz', 'texels', len(idx), 'diff hit', int((data['diff'][:, 3] > 0.5).sum()),
      'time', round(time.time() - t0, 1))
