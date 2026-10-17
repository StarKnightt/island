"""Sculpt one sea stack (or any free-standing rock body) procedurally, with scan displacement maps for the relief.

  blender --background --factory-startup -t 6 --python stack_gen.py -- <stacks.json> <name>

Shape: the union (voxel remesh) of irregular tapered, tilted prisms ("columns", angled cap cuts) and boxes ("blocks"),
minus "tunnels" (boolean), softened, then re-meshed finely (hi_voxel, ~6 cm) and displaced along smoothed normals:
  big    : aerial_rocks_02 displacement, triplanar at tens of metres (joint blocks / slabs)
  fine   : dark_rock_02 displacement, triplanar at ~3 m (fractured surface)
  lumps  : fBm noise (mid scale)
  strata : bedding bands along a tilted axis, each band protruding or recessed (ledges, overhangs), walls only
  flutes : vertical runnels (zero crossings of vertically stretched noise), walls only
  notch  : wave-cut notch around the waterline (inward, along the horizontal normal)
The base sits at z = 0 (origin at the base centre), Blender Z up (glTF Y up after export).
Output: work/<name>.blend (<name>_hi with a per-vertex 'band' attribute for the bake's tint, <name>_lod0 decimated,
chart-unwrapped, all-zero 'skirt' attribute) and work/<name>.json.
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


def sm(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def prism(c, z, r, sides=8, aspect=1.0, rot=0.0, jag=0.2, seed=0, tilt=(0.0, 0.0), cap=(0.0, 0.0), wobble=0.3,
          seg=1.5, **_):
    """Irregular tapered prism: per-vertex radius jitter (two random sets blended bottom to top), a random-walk
    centre line, an angled top cut (cap = slope deg, azimuth deg), then tilted about its base centre."""
    rng = np.random.default_rng(seed)
    z0, z1 = z
    nseg = max(2, int(math.ceil((z1 - z0) / seg)))
    base = 2 * np.pi * (np.arange(sides) + rng.uniform(-0.3, 0.3, sides)) / sides
    ja, jb = 1 + jag * rng.uniform(-1, 1, sides), 1 + jag * rng.uniform(-1, 1, sides)
    ca, sa = math.cos(math.radians(rot)), math.sin(math.radians(rot))
    walk = np.cumsum(rng.normal(0, wobble, (nseg + 1, 2)), 0)
    walk -= walk[0]
    cs, cz = math.radians(cap[0]), math.radians(cap[1])
    verts = []
    for k in range(nseg + 1):
        t = k / nseg
        rr = r[0] + (r[1] - r[0]) * t
        jj = ja * (1 - t) + jb * t
        ex = rr * jj * np.cos(base) * aspect
        ey = rr * jj * np.sin(base) / aspect
        x = c[0] + walk[k, 0] + ex * ca - ey * sa
        y = c[1] + walk[k, 1] + ex * sa + ey * ca
        zz = np.full(sides, z0 + (z1 - z0) * t)
        if k == nseg:
            zz += math.tan(cs) * ((x - c[0] - walk[k, 0]) * math.cos(cz) + (y - c[1] - walk[k, 1]) * math.sin(cz))
        verts += list(zip(x, y, zz))
    faces = []
    for k in range(nseg):
        for i in range(sides):
            j = (i + 1) % sides
            faces.append((k * sides + i, k * sides + j, (k + 1) * sides + j, (k + 1) * sides + i))
    faces.append(tuple(reversed(range(sides))))
    faces.append(tuple(nseg * sides + i for i in range(sides)))
    v = np.array(verts, np.float64)
    if tilt[0]:
        ax = Vector((-math.sin(math.radians(tilt[1])), math.cos(math.radians(tilt[1])), 0))
        M = np.array(Matrix.Rotation(math.radians(tilt[0]), 3, ax))
        o = np.array([c[0], c[1], z0])
        v = (v - o) @ M.T + o
    return v, faces


def box(c, size, rot=(0, 0, 0), **_):
    sx, sy, sz = size
    v = np.array([[x, y, z] for x in (-sx / 2, sx / 2) for y in (-sy / 2, sy / 2) for z in (-sz / 2, sz / 2)])
    M = np.array(Matrix.Rotation(math.radians(rot[2]), 3, 'Z') @ Matrix.Rotation(math.radians(rot[1]), 3, 'Y') @
                 Matrix.Rotation(math.radians(rot[0]), 3, 'X'))
    v = v @ M.T + np.array(c)
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return v, f


def tunnel(c, az, r, length, seed=0, seg=1.0, wobble=0.25, sides=14, **_):
    """Horizontal irregular elliptical tube along azimuth az (deg) through c: r = (half width, half height)."""
    rng = np.random.default_rng(seed)
    n = max(2, int(length / seg))
    d = np.array([math.cos(math.radians(az)), math.sin(math.radians(az)), 0.0])
    side = np.array([-d[1], d[0], 0.0])
    up = np.array([0, 0, 1.0])
    walk = np.cumsum(rng.normal(0, wobble, (n + 1, 2)), 0)
    jit = 1 + 0.18 * rng.uniform(-1, 1, (n + 1, sides))
    a = 2 * np.pi * np.arange(sides) / sides
    verts = []
    for k in range(n + 1):
        t = k / n
        o = np.array(c) + d * (t - 0.5) * length + side * walk[k, 0] + up * walk[k, 1] * 0.5
        flat = np.where(np.sin(a) < 0, 0.55, 1.0)       # flatter floor, arched roof
        for i in range(sides):
            verts.append(o + side * math.cos(a[i]) * r[0] * jit[k, i] + up * math.sin(a[i]) * r[1] * jit[k, i] * flat[i])
    faces = []
    for k in range(n):
        for i in range(sides):
            j = (i + 1) % sides
            faces.append((k * sides + i, (k + 1) * sides + i, (k + 1) * sides + j, k * sides + j))
    faces.append(tuple(range(sides)))
    faces.append(tuple(reversed([n * sides + i for i in range(sides)])))
    return np.array(verts), faces


# ---------------------------------------------------------------- base shape
R.reset_scene()
parts = []
for i, col in enumerate(P.get('columns', [])):
    v, f = prism(**col)
    parts.append(PR.mesh_object(f'col{i}', v, f))
for i, b in enumerate(P.get('blocks', [])):
    v, f = box(**b)
    parts.append(PR.mesh_object(f'blk{i}', v, f))
for o in parts:
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(o.data)
    bm.free()
body = PR.join(parts, name + '_hi')
PR.voxel_remesh(body, P.get('base_voxel', 0.25))
for i, tdef in enumerate(P.get('tunnels', [])):
    v, f = tunnel(**tdef)
    cut = PR.mesh_object(f'tun{i}', v, f)
    bm = bmesh.new()
    bm.from_mesh(cut.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(cut.data)
    bm.free()
    PR.apply_mod(cut, 'SUBSURF', levels=1, render_levels=1)
    nv = len(body.data.vertices)
    PR.boolean(body, cut, 'DIFFERENCE')
    R.log(name, 'tunnel', i, 'verts', nv, '->', len(body.data.vertices))
    bpy.data.objects.remove(cut)
    PR.voxel_remesh(body, P.get('base_voxel', 0.25))
PR.apply_mod(body, 'SMOOTH', factor=0.6, iterations=int(P.get('base_smooth', 3)))
PR.voxel_remesh(body, P.get('hi_voxel', 0.06))
R.log(name, 'base remeshed, verts', len(body.data.vertices))
# origin at the centre of the base footprint (bounding box of the lowest 3 m)
co0 = PR.get_co(body)
foot = co0[co0[:, 2] < co0[:, 2].min() + 3.0]
off = np.array([(foot[:, 0].min() + foot[:, 0].max()) / 2, (foot[:, 1].min() + foot[:, 1].max()) / 2, 0.0])
PR.set_co(body, co0 - off.astype(np.float32))
R.log(name, 'recentred by', off.round(2))

# ---------------------------------------------------------------- displacement
co = PR.get_co(body).astype(np.float64)
n = PR.macro_normals(body, int(P.get('normal_smooth', 30))).astype(np.float64)
D = P.get('disp', {})
steep = np.clip((1 - np.abs(n[:, 2])) / 0.75, 0, 1)
up = np.clip((n[:, 2] - 0.35) / 0.4, 0, 1)
d = np.zeros(len(co))


def tex_height(key, tex_id):
    c = D[key]
    img = PR.load_gray(f'{TEXDIR}/{tex_id}/{tex_id}_disp_4k.exr')
    m, s = float(img.mean()), float(img.std())
    h = PR.triplanar(img, co, n, c['tile'], sharp=c.get('sharp', 6.0), seed=c.get('seed', 0))
    return np.clip((h - m) / (3 * s), -1.2, 1.2) * c['amp']


if 'big' in D:
    d += tex_height('big', D['big'].get('tex', 'aerial_rocks_02'))
if 'fine' in D:
    d += tex_height('fine', D['fine'].get('tex', 'dark_rock_02'))
if 'lumps' in D:
    c = D['lumps']
    d += c['amp'] * PR.fbm(co / c['scale'], 4, seed=c.get('seed', 5))
if 'top' in D:
    c = D['top']
    d += up * c['amp'] * PR.fbm(co / c['scale'], 4, seed=c.get('seed', 9))
band = np.zeros(len(co))
if 'strata' in D:
    c = D['strata']
    rng = np.random.default_rng(c.get('seed', 3))
    tl, az = math.radians(c['tilt'][0]), math.radians(c['tilt'][1])
    a = np.array([math.sin(tl) * math.cos(az), math.sin(tl) * math.sin(az), math.cos(tl)])
    u = co @ a + c.get('warp', 0.5) * PR.fbm(co / c.get('warp_scale', 9.0), 3, seed=c.get('seed', 3) + 1)
    th = rng.uniform(c['thick'][0], c['thick'][1], 600)
    edges = u.min() - 1 + np.concatenate([[0], np.cumsum(th)])
    edges = edges[: np.searchsorted(edges, u.max() + 2) + 2]
    amps = rng.uniform(-1, 1, len(edges) + 1) * c['amp']
    tint = rng.uniform(0, 1, len(edges) + 1)
    i = np.clip(np.searchsorted(edges, u) - 1, 0, len(edges) - 2)
    wid = edges[i + 1] - edges[i]
    t = (u - edges[i]) / wid
    e = np.minimum(c.get('edge', 0.12) / wid, 0.45)
    prot = amps[i].copy()
    wl = 1 - sm(t / e)
    prot = prot * (1 - wl) + 0.5 * (amps[np.maximum(i - 1, 0)] + amps[i]) * wl
    wu = 1 - sm((1 - t) / e)
    prot = prot * (1 - wu) + 0.5 * (amps[i] + amps[i + 1]) * wu
    # bands fade in and out along the wall instead of wrapping the body as uniform rings
    mmin = c.get('mod_min', 0.2)
    prot *= mmin + (1 - mmin) * sm(0.5 + 1.1 * PR.fbm(co / c.get('mod_scale', 6.0), 3, seed=c.get('seed', 3) + 2))
    d += prot * steep ** 0.7
    band = tint[i]
if 'flutes' in D:
    c = D['flutes']
    q = np.stack([co[:, 0] / c['lh'], co[:, 1] / c['lh'], co[:, 2] / c['lv']], 1)
    nz = PR.perlin(q, c.get('seed', 4)) + 0.45 * PR.perlin(q * 2.13, c.get('seed', 4) + 1)
    groove = (1 - np.clip(np.abs(nz) / c.get('width', 0.3), 0, 1)) ** 2
    d -= c['amp'] * groove * steep
new = co + n * d[:, None]
if 'notch' in D:
    c = D['notch']
    tz = co[:, 2] - c['z']
    f = np.where(tz < 0, np.exp(-0.5 * (tz / c['h_down']) ** 2), np.exp(-0.5 * (tz / c['h_up']) ** 2))
    # deepest on the side facing the swell ('dir', azimuth in degrees), patchy elsewhere
    var = c.get('var', 0.7)
    patch = sm(0.5 + 1.2 * PR.fbm(co / c.get('scale', 5.0), 3, seed=c.get('seed', 5)))
    facing = 0.5 + 0.5 * np.cos(np.arctan2(n[:, 1], n[:, 0]) - math.radians(c.get('dir', 270)))
    depth = c['depth'] * f * np.clip((1 - var) + var * 1.5 * (0.45 * patch + 0.55 * facing), 0.15, 1.3)
    nh = n.copy()
    nh[:, 2] = 0
    new -= nh * depth[:, None]
PR.set_co(body, new)
me = body.data
if 'band' not in me.attributes:
    me.attributes.new('band', 'FLOAT', 'POINT')
me.attributes['band'].data.foreach_set('value', band.astype(np.float32))
body.data.polygons.foreach_set('use_smooth', np.ones(len(me.polygons), bool))
hi_tris = R.tri_count(body)
R.log(name, 'hi tris', hi_tris, 'disp range', round(float(d.min()), 2), round(float(d.max()), 2))

# ---------------------------------------------------------------- lod0
lo = body.copy()
lo.data = body.data.copy()
bpy.context.scene.collection.objects.link(lo)
lo.name = lo.data.name = name + '_lod0'
if 'band' in lo.data.attributes:
    lo.data.attributes.remove(lo.data.attributes['band'])
PR.decimate_to(lo, int(P.get('lod0_tris', cfg.get('lod0_tris', 19500))))
bm = bmesh.new()
bm.from_mesh(lo.data)
bmesh.ops.triangulate(bm, faces=bm.faces[:])
bm.to_mesh(lo.data)
bm.free()
PR.chart_unwrap(lo, smooth_it=int(P.get('uv_smooth', 40)))
PR.add_zero_skirt(lo)
lo_tris = R.tri_count(lo)
co_lo = PR.get_co(lo)
mn, mx = co_lo.min(0), co_lo.max(0)
meta = dict(name=name, use=P.get('use', ''), hi_tris=hi_tris, lod0_tris=lo_tris, bbox_min=mn.tolist(),
            bbox_max=mx.tolist(), height=float(mx[2]), waterline=P.get('waterline'))
json.dump(meta, open(f'{WORK}/{name}.json', 'w'), indent=1)
bpy.ops.wm.save_as_mainfile(filepath=f'{WORK}/{name}.blend', compress=False)
R.log(name, 'saved, lod0 tris', lo_tris, 'bbox', mn.round(2), mx.round(2))
