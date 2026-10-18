"""Sculpt one shore rock shelf (a low wave-cut platform) procedurally.

  blender --background --factory-startup -t 6 --python shelf_gen.py -- <shelves.json> <name>
  (quick look at the height field alone, no Blender: python shelf_field_view.py <shelves.json> <name> <out_prefix>)

The body is a closed height field over the footprint (shelf_field.py: Voronoi joint blocks, bedding ridges, terraces,
edge benches, tide pools, a seaward wall that turns into ramps in places, a buried landward slope) plus fallen joint
blocks at the foot of the wall and a few storm-tossed ones on the platform, voxel-remeshed so the steep edges become
real walls. After the remesh: scan-displacement relief (aerial_rocks_02 large, dark_rock_02 fine), bedding ledges on
the walls and a wave-cut notch along the foot of the seaward wall.
z = 0 is the foot of the seaward wall; the walls continue down to z = 'floor' (buried / under water) and the mesh is
open there. Origin at the centre of the footprint. Blender Z up, the sea toward -Y (glTF +Z after export).
Hi-mesh point attributes for the bake: 'band' (tint per joint block and bedding layer) and 'stain' (the wet spray
zone along the foot, tide-pool beds, crack grime).
Output: work/<name>.blend (<name>_hi, <name>_lod0 decimated, chart-unwrapped, all-zero 'skirt') and work/<name>.json.
"""
import os
import sys
import json
import math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402
import rocklib as R  # noqa: E402
import proc as PR  # noqa: E402
import shelf_field as SF  # noqa: E402

cfg_path, name = R.args_after_dashes()[:2]
cfg = json.load(open(cfg_path))
P = next(p for p in cfg['pieces'] if p['name'] == name)
WORK = R.WORK + '/work'
TEXDIR = 'E:/tmp/island/raw/polyhaven/textures'
SEED = int(P.get('seed', 1))
sm = SF.sm

F = SF.build(P, log=lambda *a: R.log(name, *a))
X, Y, Z, T = F.X, F.Y, F.Z, F.T
ny, nx = X.shape
floor = F.floor
rng = F.rng
R.log(name, 'grid', nx, 'x', ny)


def heightfield_solid(Z, z_bottom, oname):
    verts = np.stack([X.ravel(), Y.ravel(), Z.ravel()], 1).astype(np.float32)
    i = np.arange(ny * nx).reshape(ny, nx)
    q = np.stack([i[:-1, :-1], i[:-1, 1:], i[1:, 1:], i[1:, :-1]], -1).reshape(-1, 4)
    me = bpy.data.meshes.new(oname)
    me.vertices.add(len(verts))
    me.vertices.foreach_set('co', verts.ravel())
    me.loops.add(q.size)
    me.loops.foreach_set('vertex_index', q.ravel().astype(np.int32))
    me.polygons.add(len(q))
    me.polygons.foreach_set('loop_start', np.arange(0, q.size, 4, dtype=np.int32))
    me.polygons.foreach_set('loop_total', np.full(len(q), 4, np.int32))
    me.update(calc_edges=True)
    bm = bmesh.new()
    bm.from_mesh(me)
    bnd = [e for e in bm.edges if e.is_boundary]
    ret = bmesh.ops.extrude_edge_only(bm, edges=bnd)
    nv = {v for v in ret['geom'] if isinstance(v, bmesh.types.BMVert)}
    for v in nv:
        v.co.z = z_bottom
    ne = [e for e in ret['geom'] if isinstance(e, bmesh.types.BMEdge) and e.verts[0] in nv and e.verts[1] in nv]
    filled = bmesh.ops.holes_fill(bm, edges=ne, sides=0)
    bmesh.ops.triangulate(bm, faces=filled['faces'])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(oname, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def block_mesh(c, size, yaw, tilt_ax, tilt, oname, jit=0.1):
    """A broken joint block: jittered hexahedron with 2-4 corners / edges sheared off by fracture planes, yawed and
    tilted, bottom centre at c."""
    hx, hy, h = size[0] / 2, size[1] / 2, size[2]
    v = np.array([[x, y, z] for x in (-hx, hx) for y in (-hy, hy) for z in (0.0, h)], float)
    v += rng.uniform(-jit, jit, v.shape) * np.array([size[0], size[1], size[2]])
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    o = PR.mesh_object(oname, v, f)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    smin = min(size[0], size[1], size[2])
    for _k in range(int(rng.integers(2, 5))):
        nrm = rng.normal(size=3)
        nrm[2] = abs(nrm[2]) * 0.8 - 0.1                      # mostly upper corners and sides, never the buried base
        nrm /= np.linalg.norm(nrm)
        far = max(float(np.dot(np.array(vv.co), nrm)) for vv in bm.verts)
        depth = rng.uniform(0.12, 0.32) * smin
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-5,
                               plane_co=Vector(nrm * (far - depth)), plane_no=Vector(nrm), clear_outer=True)
        bnd = [e for e in bm.edges if e.is_boundary]
        if bnd:
            bmesh.ops.holes_fill(bm, edges=bnd, sides=0)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    M = Matrix.Translation(Vector(c)) @ Matrix.Rotation(math.radians(tilt), 4, Vector(tilt_ax)) @ \
        Matrix.Rotation(math.radians(yaw), 4, 'Z')
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts[:])
    bm.to_mesh(o.data)
    bm.free()
    return o


def drop_small_islands(obj, min_faces):
    """Delete connected pieces with fewer than min_faces faces (remesh crumbs left after the floor cut)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    seen = np.zeros(len(bm.faces), bool)
    kill = []
    for f0 in bm.faces:
        if seen[f0.index]:
            continue
        comp, stack = [], [f0]
        seen[f0.index] = True
        while stack:
            f = stack.pop()
            comp.append(f)
            for e in f.edges:
                for f2 in e.link_faces:
                    if not seen[f2.index]:
                        seen[f2.index] = True
                        stack.append(f2)
        if len(comp) < min_faces:
            kill.extend(comp)
    if kill:
        bmesh.ops.delete(bm, geom=kill, context='FACES')
        loose = [v for v in bm.verts if not v.link_faces]
        bmesh.ops.delete(bm, geom=loose, context='VERTS')
    bm.to_mesh(obj.data)
    bm.free()
    return len(kill)


# ---------------------------------------------------------------- build
R.reset_scene()
parts = [heightfield_solid(Z, floor - 0.8, name + '_hi')]
for k, b in enumerate(F.blocks):
    parts.append(block_mesh(b['c'], b['size'], b['yaw'], b['ax'], b['tilt'], f'blk{k}'))
body = PR.join(parts, name + '_hi') if len(parts) > 1 else parts[0]
PR.voxel_remesh(body, P.get('hi_voxel', 0.07))
# drop the flat floor around the shelf (and the bottom of the solid): the base stays open, below the ground
bm = bmesh.new()
bm.from_mesh(body.data)
cut = floor + 0.04
bmesh.ops.delete(bm, geom=[f for f in bm.faces if all(v.co.z < cut for v in f.verts)], context='FACES')
loose = [v for v in bm.verts if not v.link_faces]
bmesh.ops.delete(bm, geom=loose, context='VERTS')
bm.to_mesh(body.data)
bm.free()
R.log(name, 'crumbs removed (faces)', drop_small_islands(body, int(P.get('min_island', 400))))
PR.apply_mod(body, 'SMOOTH', factor=0.5, iterations=int(P.get('smooth', 2)))
co0 = PR.get_co(body).astype(np.float64)
inside = F.S > 0.3                          # the platform footprint (not the fallen blocks) sets the origin
off = np.array([(X[inside].min() + X[inside].max()) / 2, (Y[inside].min() + Y[inside].max()) / 2, 0.0])
R.log(name, 'remeshed verts', len(co0), 'recentre by', off.round(2))

# ---------------------------------------------------------------- displacement
co = co0
n = PR.macro_normals(body, int(P.get('normal_smooth', 12))).astype(np.float64)
D = P.get('disp', {})
steep = np.clip((1 - np.abs(n[:, 2])) / 0.75, 0, 1)
nh = n.copy()
nh[:, 2] = 0
nl = np.maximum(np.linalg.norm(nh, axis=1), 1e-6)
landward = sm((nh[:, 1] / nl - 0.2) / 0.6)            # walls facing inland: the buried back slope
d = np.zeros(len(co))


def tex_height(c, tex_id):
    img = PR.load_gray(f'{TEXDIR}/{tex_id}/{tex_id}_disp_4k.exr')
    m, s = float(img.mean()), float(img.std())
    h = PR.triplanar(img, co, n, c['tile'], sharp=c.get('sharp', 6.0), seed=c.get('seed', 0))
    return np.clip((h - m) / (3 * s), -1.2, 1.2) * c['amp']


if 'big' in D:
    d += tex_height(D['big'], D['big'].get('tex', 'aerial_rocks_02'))
if 'fine' in D:
    d += tex_height(D['fine'], D['fine'].get('tex', 'dark_rock_02'))
if 'wall' in D:
    # fractured relief on the steep faces only (walls, block sides)
    d += tex_height(D['wall'], D['wall'].get('tex', 'dark_rock')) * steep
if 'lumps' in D:
    c = D['lumps']
    d += c['amp'] * PR.fbm(co / c['scale'], 3, seed=c.get('seed', 5))
band_bed = np.zeros(len(co))
if 'strata' in D:
    # horizontal bedding on the walls: each layer protrudes or recedes a little, fading along the wall
    c = D['strata']
    r2 = np.random.default_rng(c.get('seed', 3))
    u = co[:, 2] + c.get('warp', 0.15) * PR.fbm(co / c.get('warp_scale', 4.0), 2, seed=c.get('seed', 3) + 1)
    th = r2.uniform(c['thick'][0], c['thick'][1], 400)
    edges = floor - 2 + np.concatenate([[0], np.cumsum(th)])
    li = np.clip(np.searchsorted(edges, u) - 1, 0, len(edges) - 2)
    amps = r2.uniform(-1, 1, len(edges)) * c['amp']
    tw = r2.uniform(0, 1, len(edges))
    tl = (u - edges[li]) / (edges[li + 1] - edges[li])
    e = 0.15
    prot = amps[li] * sm(tl / e) * sm((1 - tl) / e) + 0.5 * (amps[li] + amps[np.maximum(li - 1, 0)]) * (1 - sm(tl / e))
    prot *= 0.3 + 0.7 * sm(0.5 + PR.fbm(co / c.get('mod_scale', 3.0), 2, seed=c.get('seed', 3) + 2))
    d += prot * steep * (1 - 0.8 * landward)
    band_bed = tw[li]
new = co + n * d[:, None]
if 'notch' in P:
    # wave-cut notch along the foot of the seaward wall (and of the fallen blocks): inward, horizontal
    c = P['notch']
    tz = co[:, 2] - c['z']
    f = np.where(tz < 0, np.exp(-0.5 * (tz / c['h_down']) ** 2), np.exp(-0.5 * (tz / c['h_up']) ** 2))
    facing = sm((-nh[:, 1] / nl + 0.6) / 1.0)              # deepest where the wall faces the sea (-Y)
    patch = 0.45 + 0.55 * sm(0.5 + 1.2 * PR.fbm(co / c.get('scale', 3.0), 2, seed=c.get('seed', 6)))
    depth = c['depth'] * f * facing * patch * steep
    new -= (nh / nl[:, None]) * depth[:, None]
new[:, :2] -= off[:2]
PR.set_co(body, new)

# ---------------------------------------------------------------- bake attributes
xw, yw = co[:, 0], co[:, 1]
top_w = 1 - steep
tint_cell = F.sample2d(F.tint, xw, yw)
band = np.clip(top_w * tint_cell + (1 - top_w) * band_bed, 0, 1)
wet_top = P.get('wet_top', 0.8) * (0.75 + 0.5 * sm(0.5 + PR.fbm(co / 4.0, 2, seed=SEED + 9)))
stain = 0.65 * (1 - sm((co[:, 2] - wet_top) / 0.45))
pool_bed = F.sample2d(F.pools, xw, yw)
stain = np.maximum(stain, 0.55 * sm(pool_bed / 0.12) * top_w)
crack_g = F.sample2d(F.groove, xw, yw)
stain = np.maximum(stain, 0.35 * crack_g * top_w)
me = body.data
for an, vals in (('band', band), ('stain', np.clip(stain, 0, 1))):
    if an not in me.attributes:
        me.attributes.new(an, 'FLOAT', 'POINT')
    me.attributes[an].data.foreach_set('value', np.asarray(vals, np.float32))
me.polygons.foreach_set('use_smooth', np.ones(len(me.polygons), bool))
hi_tris = R.tri_count(body)
R.log(name, 'hi tris', hi_tris, 'disp range', round(float(d.min()), 3), round(float(d.max()), 3),
      'stain mean', round(float(stain.mean()), 3))

# ---------------------------------------------------------------- lod0
lo = body.copy()
lo.data = body.data.copy()
bpy.context.scene.collection.objects.link(lo)
lo.name = lo.data.name = name + '_lod0'
for an in ('band', 'stain'):
    lo.data.attributes.remove(lo.data.attributes[an])
PR.decimate_to(lo, int(P.get('lod0_tris', 15000)))
bm = bmesh.new()
bm.from_mesh(lo.data)
bmesh.ops.triangulate(bm, faces=bm.faces[:])
bm.to_mesh(lo.data)
bm.free()
PR.chart_unwrap(lo, smooth_it=int(P.get('uv_smooth', 20)), angle=P.get('uv_angle', 66))
PR.add_zero_skirt(lo)
lo_tris = R.tri_count(lo)
co_lo = PR.get_co(lo)
mn, mx = co_lo.min(0), co_lo.max(0)
meta = dict(name=name, use=P.get('use', ''), hi_tris=hi_tris, lod0_tris=lo_tris, bbox_min=mn.tolist(),
            bbox_max=mx.tolist(), top=float(mx[2]), waterline=P.get('waterline'))
json.dump(meta, open(f'{WORK}/{name}.json', 'w'), indent=1)
bpy.ops.wm.save_as_mainfile(filepath=f'{WORK}/{name}.blend', compress=False)
R.log(name, 'saved, lod0 tris', lo_tris, 'bbox', mn.round(2), mx.round(2))
