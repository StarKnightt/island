"""Sculpt one shore rock shelf (a low wave-cut platform) procedurally.

  blender --background --factory-startup -t 6 --python shelf_gen.py -- <shelves.json> <name>

The body is a closed height field over the footprint, voxel-remeshed so its steep edges become real walls:
  outline : a rounded rectangle whose sides are pushed in and out by noise (lobes, embayments; most on the seaward
            side), cut by surge channels and broken back along the joint pattern: whole joint blocks along the edge
            are missing, so the edge is stepped and blocky like a real jointed platform
  top     : nearly flat with a gentle landward rise ('dip_deg'), terrace steps that follow the joints, per joint
            block height / tilt jitter, crack grooves along the joints (segments open by different amounts), tide
            pools and potholes; the joint blocks along the seaward edge are slumped toward the sea
  edges   : a near-vertical wall with a rounded lip on the seaward side and the ends, a gentle slope on the landward
            side (meant to be buried in the beach / terrain)
  blocks  : fallen joint blocks at the foot of the wall and a few storm-tossed ones on the platform
After the remesh: scan-displacement relief (aerial_rocks_02 large, dark_rock_02 fine), bedding ledges on the walls
and a wave-cut notch along the foot of the seaward wall.
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

cfg_path, name = R.args_after_dashes()[:2]
cfg = json.load(open(cfg_path))
P = next(p for p in cfg['pieces'] if p['name'] == name)
WORK = R.WORK + '/work'
TEXDIR = 'E:/tmp/island/raw/polyhaven/textures'
SEED = int(P.get('seed', 1))
rng = np.random.default_rng(SEED)


def sm(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def cell_rand(i, j, k):
    """Deterministic 0..1 value per integer lattice cell (i, j) and channel k."""
    v = (np.asarray(i, np.int64) * 73856093) ^ (np.asarray(j, np.int64) * 19349663) ^ np.int64(k * 83492791 + SEED * 2654435761)
    v &= 0xffffffff
    v ^= v >> 13
    v = (v * 1274126177) & 0xffffffff
    v ^= v >> 16
    return (v & 0xffffff) / float(0x1000000)


def noise2(x, y, scale, octaves=3, seed=0):
    p = np.stack([np.ravel(x) / scale, np.ravel(y) / scale, np.full(np.size(x), 0.37 * seed + 0.11)], 1)
    return PR.fbm(p, octaves, seed=SEED * 31 + seed).reshape(np.shape(x)).astype(np.float64)


# ---------------------------------------------------------------- footprint grid
Lx, Ly = P['extent']
g = P.get('grid', 0.08)
floor = P.get('floor', -1.5)
mar = 3.0
xs = np.arange(-Lx / 2 - mar, Lx / 2 + mar + g / 2, g)
ys = np.arange(-Ly / 2 - mar, Ly / 2 + mar + g / 2, g)
X, Y = np.meshgrid(xs, ys)
ny, nx = X.shape
R.log(name, 'grid', nx, 'x', ny)


def sample2d(F, x, y):
    fx = (np.asarray(x) - xs[0]) / g
    fy = (np.asarray(y) - ys[0]) / g
    ix = np.clip(np.floor(fx).astype(np.int64), 0, nx - 2)
    iy = np.clip(np.floor(fy).astype(np.int64), 0, ny - 2)
    tx = np.clip(fx - ix, 0, 1)
    ty = np.clip(fy - iy, 0, 1)
    return (F[iy, ix] * (1 - tx) * (1 - ty) + F[iy, ix + 1] * tx * (1 - ty) +
            F[iy + 1, ix] * (1 - tx) * ty + F[iy + 1, ix + 1] * tx * ty)


def sd_round_box(px, py, hx, hy, r):
    qx = np.abs(px) - hx + r
    qy = np.abs(py) - hy + r
    return np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r


def seaward(y):
    """1 on the seaward half of the footprint (-Y), 0 at the landward edge."""
    return sm((-y / (Ly / 2) + 0.35) / 0.9)


def outline_sdf(x, y):
    """Signed distance (m, negative inside) of the outline before the joint-block breakage."""
    d = sd_round_box(x, y, Lx / 2, Ly / 2, P.get('corner', 3.0))
    ws = seaward(y)
    d = d + P.get('edge_amp', 1.5) * noise2(x, y, P.get('edge_scale', 6.0), 3, 1) * (0.35 + 0.65 * ws)
    d = d + P.get('rag_amp', 0.3) * noise2(x, y, P.get('rag_scale', 1.3), 3, 2)
    for k, ch in enumerate(P.get('channels', [])):
        # surge channel: a wobbly, inland-tapering slot cut in from the seaward edge
        a = math.radians(ch.get('ang', 0.0))
        y0 = -Ly / 2 - 2.5
        t = np.clip((y - y0) / max(math.cos(a), 0.2), 0, None)
        cx = ch['x'] + t * math.sin(a) + ch.get('wobble', 0.5) * noise2(x, y, 2.5, 2, 10 + k)
        end = 2.5 + ch['len']
        hw = 0.5 * ch['w'] * (1 - 0.65 * sm(t / end)) * (1 + 0.25 * noise2(x, y, 1.5, 2, 20 + k))
        dist = np.abs(x - cx)
        dist = np.where(t > end, np.hypot(dist, (t - end) * math.cos(a)), dist)
        d = np.maximum(d, hw - dist)
    return d


# ---------------------------------------------------------------- joints
J = P.get('joints', {})
t1 = math.radians(J.get('angle', 15.0))
t2 = t1 + math.radians(90.0 + J.get('skew', 12.0))
sa, sb = J.get('spacing', [2.6, 2.0])
A = X * math.cos(t1) + Y * math.sin(t1)
B = X * math.cos(t2) + Y * math.sin(t2)
wob = J.get('wobble', 0.22)
A = A + wob * noise2(X, Y, 4.0, 2, 3)
B = B + wob * noise2(X, Y, 4.0, 2, 4)
ia = np.floor(A / sa).astype(np.int64)
ib = np.floor(B / sb).astype(np.int64)
fa = A / sa - ia
fb = B / sb - ib
da = np.minimum(fa, 1 - fa) * sa          # metres to the nearest crack of family 1
db = np.minimum(fb, 1 - fb) * sb
dc = np.minimum(da, db)
Minv = np.linalg.inv(np.array([[math.cos(t1), math.sin(t1)], [math.cos(t2), math.sin(t2)]]))
cen = np.stack([(ia + 0.5) * sa, (ib + 0.5) * sb], -1) @ Minv.T
cx, cy = cen[..., 0], cen[..., 1]
sc = -outline_sdf(cx, cy)                 # how far inside the outline each joint block's centre lies
r_rm, r_dz, r_ta, r_tb, r_tint, r_drop = (cell_rand(ia, ib, k) for k in range(6))
cell = max(sa, sb)
ws_c = seaward(cy)
# whole blocks missing along the edge (mostly seaward)
p_rm = J.get('erode', 0.5) * (1 - sm((sc - 0.15 * cell) / (J.get('erode_cells', 0.9) * cell))) * (0.3 + 0.7 * ws_c)
removed = (r_rm < p_rm) & (sc < 0.9 * cell)
d_out = outline_sdf(X, Y)
d_out = np.where(removed, np.maximum(d_out, dc), d_out)
S = -d_out
R.log(name, 'joint blocks removed', int(len(np.unique((ia[removed] * 100003 + ib[removed])))))

# ---------------------------------------------------------------- top surface
T = np.full(X.shape, float(P['top']))
T += math.tan(math.radians(P.get('dip_deg', 2.0))) * (Y + Ly / 2)
T -= P.get('end_drop', 0.3) * (1 - sm((Lx / 2 - np.abs(X)) / (0.25 * Lx)))
T += P.get('undulate', 0.1) * noise2(X, Y, 6.0, 3, 5)
for k, st in enumerate(P.get('steps', [])):
    # terrace (bedding) step: joint blocks whose centre lies landward of a wavy line stand higher
    u_c = cy + P.get('step_wave', 1.0) * noise2(cx, cy, 5.0, 2, 40 + k) + 0.45 * cell * (cell_rand(ia, ib, 50 + k) - 0.5)
    T += st['h'] * (u_c > st['y'])
# per-block jitter: height and a small tilt
T += J.get('cell_dz', 0.07) * (r_dz - 0.5)
tilt = J.get('cell_tilt', 0.03)
T += tilt * ((r_ta - 0.5) * (A / sa - ia - 0.5) * sa + (r_tb - 0.5) * (B / sb - ib - 0.5) * sb)
# slumped blocks along the seaward edge: lower, tilted toward the sea
edge_c = (1 - sm((sc - 0.2 * cell) / (1.2 * cell))) * ws_c
T -= J.get('edge_drop', 0.25) * r_drop * edge_c * (1 + 0.6 * np.clip(-(Y - cy) / cell, -1, 1))
# crack grooves; each segment between two crossings opens by its own amount
jb1 = ia + (fa > 0.5)
jb2 = ib + (fb > 0.5)
open1 = np.clip(cell_rand(jb1, ib, 7) * 1.4 - 0.15, 0, 1)
open2 = np.clip(cell_rand(ia, jb2, 8) * 1.4 - 0.15, 0, 1)
cw = J.get('crack_w', 0.15) * (0.6 + 0.8 * sm(0.5 + noise2(X, Y, 3.0, 2, 6)))
groove = np.maximum(open1 * (1 - np.clip(da / cw, 0, 1)) ** 1.5, open2 * (1 - np.clip(db / cw, 0, 1)) ** 1.5)
T -= J.get('crack_d', 0.2) * groove
# tide pools (flat beds, irregular rims) and small deep potholes
pools = np.zeros(X.shape)


def scatter(defn, min_inside):
    out = []
    for _ in range(defn.get('count', 0)):
        for _try in range(400):
            r = rng.uniform(*defn['r'])
            c = np.array([rng.uniform(-Lx / 2, Lx / 2), rng.uniform(-Ly / 2, Ly / 2)])
            if float(sample2d(S, c[0], c[1])) < r + min_inside:
                continue
            if any(np.hypot(*(c - q)) < (r + rq) * 1.1 for q, rq in out):
                continue
            out.append((c, r))
            break
    return out


for k, (c, r) in enumerate(scatter(P.get('pools', {}), 0.8)):
    asp = rng.uniform(1.0, 1.8)
    ang = t1 + rng.choice([0.0, math.pi / 2])
    dx, dy = X - c[0], Y - c[1]
    u = (dx * math.cos(ang) + dy * math.sin(ang)) / asp
    v = -dx * math.sin(ang) + dy * math.cos(ang)
    wx = 0.35 * r * noise2(X, Y, 0.9 * r, 2, 60 + k)
    wy = 0.35 * r * noise2(X, Y, 0.9 * r, 2, 70 + k)
    q = np.hypot(u + wx, v + wy) / r
    dep = rng.uniform(*P['pools']['depth'])
    pools = np.maximum(pools, dep * (1 - sm((q - 0.5) / 0.5)))
for k, (c, r) in enumerate(scatter(P.get('potholes', {}), 0.5)):
    q = np.hypot(X - c[0], Y - c[1]) / r
    dep = rng.uniform(*P['potholes']['depth'])
    pools = np.maximum(pools, dep * (1 - sm((q - 0.35) / 0.65)) ** 0.7)
T -= pools

# ---------------------------------------------------------------- edge profile -> height field
gy, gx = np.gradient(d_out, g)
gl = np.maximum(np.hypot(gx, gy), 1e-6)
back_w = sm((gy / gl - 0.3) / 0.5)             # outward normal pointing inland: gentle slope
wprof = P.get('w_cliff', 0.4) + (P.get('w_back', 3.0) - P.get('w_cliff', 0.4)) * back_w
t = np.clip(S / wprof, 0, 1)
prof = (1 - (1 - t) ** 2.2) * (1 - back_w) + sm(t) * back_w
Z = np.where(S > 0, floor + (T - floor) * prof, floor)


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


def block_mesh(c, size, yaw, tilt_ax, tilt, oname, jit=0.12):
    """Irregular hexahedron (a joint block with jittered corners), yawed and tilted, bottom centre at c."""
    hx, hy, h = size[0] / 2, size[1] / 2, size[2]
    v = np.array([[x, y, z] for x in (-hx, hx) for y in (-hy, hy) for z in (0.0, h)], float)
    v += rng.uniform(-jit, jit, v.shape) * np.array([size[0], size[1], size[2]])
    M = np.array(Matrix.Rotation(math.radians(tilt), 3, Vector(tilt_ax)) @ Matrix.Rotation(math.radians(yaw), 3, 'Z'))
    v = v @ M.T + np.asarray(c, float)
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    o = PR.mesh_object(oname, v, f)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(o.data)
    bm.free()
    return o


# ---------------------------------------------------------------- build
R.reset_scene()
parts = [heightfield_solid(Z, floor - 0.8, name + '_hi')]
BL = P.get('blocks', {})
placed = []
n_foot = BL.get('count', 0)
for k in range(n_foot + BL.get('on_top', 0)):
    on_top = k >= n_foot
    for _try in range(600):
        s = rng.uniform(*BL.get('size', [0.5, 1.6]))
        c = np.array([rng.uniform(-Lx / 2 - 1, Lx / 2 + 1), rng.uniform(-Ly / 2 - 2.5, Ly / 2)])
        dd = float(sample2d(d_out, c[0], c[1]))
        if on_top:
            ok = -dd > 1.5 + s and float(seaward(c[1])) > 0.5
        else:
            ok = 0.15 < dd < BL.get('reach', 2.5) and float(seaward(c[1])) > 0.4
        if not ok or any(np.hypot(*(c - q)) < 0.55 * (s + sq) for q, sq in placed):
            continue
        placed.append((c, s))
        yaw = rng.uniform(0, 360)
        ax = (rng.normal(), rng.normal(), 0.0)
        if on_top:
            zt = float(sample2d(T, c[0], c[1]))
            size = (s, s * rng.uniform(0.6, 0.95), s * rng.uniform(0.4, 0.65))
            parts.append(block_mesh((c[0], c[1], zt - 0.12 * size[2]), size, yaw, ax, rng.uniform(5, 18), f'blk{k}'))
        else:
            top = rng.uniform(*BL.get('top', [0.2, 1.0]))
            size = (s, s * rng.uniform(0.6, 0.95), top - floor + 0.3)
            parts.append(block_mesh((c[0], c[1], floor - 0.3), size, yaw, ax, rng.uniform(4, 22), f'blk{k}'))
        break
R.log(name, 'blocks', len(placed))
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
PR.apply_mod(body, 'SMOOTH', factor=0.5, iterations=int(P.get('smooth', 2)))
co0 = PR.get_co(body).astype(np.float64)
up_pts = co0[co0[:, 2] > 0.2]
off = np.array([(up_pts[:, 0].min() + up_pts[:, 0].max()) / 2, (up_pts[:, 1].min() + up_pts[:, 1].max()) / 2, 0.0])
R.log(name, 'remeshed verts', len(co0), 'recentre by', off.round(2))

# ---------------------------------------------------------------- displacement
co = co0
n = PR.macro_normals(body, int(P.get('normal_smooth', 12))).astype(np.float64)
D = P.get('disp', {})
steep = np.clip((1 - np.abs(n[:, 2])) / 0.75, 0, 1)
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
    d += prot * steep
    band_bed = tw[li]
new = co + n * d[:, None]
if 'notch' in P:
    # wave-cut notch along the foot of the seaward wall (and of the fallen blocks): inward, horizontal
    c = P['notch']
    tz = co[:, 2] - c['z']
    f = np.where(tz < 0, np.exp(-0.5 * (tz / c['h_down']) ** 2), np.exp(-0.5 * (tz / c['h_up']) ** 2))
    nh = n.copy()
    nh[:, 2] = 0
    nl = np.maximum(np.linalg.norm(nh, axis=1), 1e-6)
    facing = sm((-nh[:, 1] / nl + 0.6) / 1.0)              # deepest where the wall faces the sea (-Y)
    patch = 0.45 + 0.55 * sm(0.5 + 1.2 * PR.fbm(co / c.get('scale', 3.0), 2, seed=c.get('seed', 6)))
    depth = c['depth'] * f * facing * patch * steep
    new -= (nh / nl[:, None]) * depth[:, None]
new[:, :2] -= off[:2]
PR.set_co(body, new)
co_f = new

# ---------------------------------------------------------------- bake attributes
xw, yw = co[:, 0], co[:, 1]
top_w = 1 - steep
tint_cell = sample2d(r_tint.astype(np.float64), xw, yw)
band = np.clip(top_w * tint_cell + (1 - top_w) * band_bed, 0, 1)
wet_top = P.get('wet_top', 0.8) * (0.75 + 0.5 * sm(0.5 + PR.fbm(co / 4.0, 2, seed=SEED + 9)))
stain = 0.65 * (1 - sm((co[:, 2] - wet_top) / 0.45))
pool_bed = sample2d(pools, xw, yw)
stain = np.maximum(stain, 0.55 * sm(pool_bed / 0.12) * top_w)
crack_g = sample2d(groove, xw, yw)
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
