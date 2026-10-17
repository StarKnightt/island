"""
README: beach scrub (sea-grape / Scaevola / beach naupaka character) -> public/assets/veg/palms/scrub.glb

  1. atlas:  make_scrub_tex.py (see its README)
  2. build:  bash c:/Code/island/tools/heavy.sh palms E:/blender/blender-5.1.2-windows-x64/blender.exe --background \
               --factory-startup -t 6 --python c:/Code/island/tools/blender/palms/build_scrub.py
  3. optimise build/scrub_raw.glb with tools/optimize-glb.ts (see build_coconut.py)

4 variants x 3 LODs, nodes scrub_<a..d>_lod<0..2>, materials scrub_leaf (MASK, double-sided) and scrub_wood (opaque),
one shared atlas. Each shrub = union of ellipsoid lobes: leaf-cluster cards in the outer shell (front faces outward,
normals bent 60 % toward the outward direction so the crown shades as a mass) + an inner hull with an opaque
dense-leaf texture (you cannot see through the core) + a few stems near the ground. Variant d is wind-pruned:
low on the seaward +X side. COLOR_0 = (AO, bend G, flutter B, phase A per card).
"""
import sys, os, math, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import bpy
from palm_geo import MeshBuilder, nrm, rot, tube, UP
import palm_blender as pb
from common import SCRATCH
import make_scrub_tex as st

OUT = 'E:/tmp/island/helpers/palms/build'
TEX = SCRATCH + '/tex'
LEAF, WOOD = 0, 1
T0 = time.time()


def log(*a):
    print(f'[scrub {time.time() - T0:6.1f}s]', *a, flush=True)


VARIANTS = {
    # lobes: (centre xyz, radii xyz); cells: weights for scaevola / seagrape / sprig cards
    'a': dict(seed=11, lobes=[((0, 0, 0.55), (1.45, 1.3, 1.05)), ((0.5, 0.35, 0.75), (0.9, 0.9, 0.85)), ((-0.6, -0.3, 0.5), (0.9, 0.8, 0.7))],
              cells=(0.65, 0.15, 0.2)),
    'b': dict(seed=22, lobes=[((0, 0, 0.35), (2.2, 1.6, 0.85)), ((1.2, 0.5, 0.45), (1.1, 1.0, 0.75)), ((-1.3, -0.4, 0.4), (1.1, 1.1, 0.7)),
                              ((0.2, -0.9, 0.3), (1.0, 0.8, 0.6))], cells=(0.2, 0.65, 0.15)),
    'c': dict(seed=33, lobes=[((0, 0, 1.25), (1.5, 1.4, 1.5)), ((0.9, 0.5, 1.0), (1.0, 1.0, 1.1)), ((-0.8, -0.2, 0.9), (1.0, 0.9, 1.0)),
                              ((0.1, 0.1, 2.1), (0.8, 0.8, 0.7))], cells=(0.4, 0.4, 0.2)),
    'd': dict(seed=44, lobes=[((-0.35, 0, 0.9), (1.05, 1.15, 1.05)), ((0.45, 0.1, 0.55), (0.95, 1.0, 0.6)), ((1.05, -0.1, 0.35), (0.6, 0.8, 0.38))],
              cells=(0.55, 0.25, 0.2)),
}
SCAEVOLA = [i for i, c in enumerate(st.CARDS) if c[2].startswith('scaevola')]
SEAGRAPE = [i for i, c in enumerate(st.CARDS) if c[2].startswith('seagrape')]
SPRIG = [i for i, c in enumerate(st.CARDS) if c[2] == 'sprig']


def cell_uv(col, row, margin=3):
    c = st.CELL / 2048.0
    m = margin / 2048.0
    return (col * c + m, row * c + m, (col + 1) * c - m, (row + 1) * c - m)


class Shape:
    def __init__(self, lobes, seed=0):
        self.c = np.array([l[0] for l in lobes], float)
        self.r = np.array([l[1] for l in lobes], float)
        r = np.random.default_rng(seed)
        self.waves = [(r.normal(0, 1, 3) * f, r.uniform(0, 6.28), a) for f, a in ((2.2, 0.11), (3.7, 0.07), (6.1, 0.04))]

    def sdf(self, p):
        p = np.atleast_2d(p)
        q = (p[:, None, :] - self.c[None]) / self.r[None]
        k = np.linalg.norm(q, axis=2)
        d = (k - 1.0) * self.r.min(axis=1)[None]
        # smooth union
        kk = 0.25
        res = d[:, 0]
        for i in range(1, d.shape[1]):
            h = np.clip(0.5 + 0.5 * (d[:, i] - res) / kk, 0, 1)
            res = d[:, i] * (1 - h) + res * h - kk * h * (1 - h)
        # lumpy, irregular outline
        for kv, ph, amp in self.waves:
            res = res + amp * np.sin(p @ kv + ph)
        return res

    def grad(self, p, e=0.02):
        p = np.atleast_2d(p)
        g = np.stack([(self.sdf(p + np.array([e, 0, 0])) - self.sdf(p - np.array([e, 0, 0]))),
                      (self.sdf(p + np.array([0, e, 0])) - self.sdf(p - np.array([0, e, 0]))),
                      (self.sdf(p + np.array([0, 0, e])) - self.sdf(p - np.array([0, 0, e])))], 1)
        return g / np.maximum(np.linalg.norm(g, axis=1, keepdims=True), 1e-9)

    def bbox(self):
        return (self.c - self.r).min(0), (self.c + self.r).max(0)


def sample_shell(shape, rng, n, spacing, depth=0.35):
    lo, hi = shape.bbox()
    lo[2] = max(lo[2], 0.05)
    pts = []
    tries = 0
    while len(pts) < n and tries < 200:
        tries += 1
        cand = rng.uniform(lo, hi, (4000, 3))
        d = shape.sdf(cand)
        keep = (d < 0.04) & (d > -depth)
        cand, d = cand[keep], d[keep]
        # favour the outer skin
        w = np.exp(d / (depth * 0.45))
        cand = cand[rng.random(len(cand)) < w]
        for p in cand:
            if len(pts) >= n:
                break
            if pts and np.min(np.linalg.norm(np.array(pts) - p, axis=1)) < spacing:
                continue
            pts.append(p)
    return np.array(pts)


def add_card(mb, p, n_out, size, cell, rng, height, phase, lod, bend=0.6, ground=0.0):
    """dome-folded quad (4 tris; LOD2: 2 tris), leaves facing the sky more than the outside (rosettes face the sun),
    normals bent toward n_out so the crown shades as one mass"""
    n = nrm(UP * 0.9 + n_out * 0.75 + rng.normal(0, 0.5, 3))
    if np.dot(n, n_out) < 0.1:
        n = nrm(n + n_out * 0.8)
    if lod > 0:
        p = p - n_out * size * 0.22        # bigger cards sit deeper so they keep the LOD0 silhouette
    t = nrm(np.cross(n, rng.normal(0, 1, 3)))
    b = np.cross(n, t)
    s = size * 0.5
    sx, sy = s * rng.uniform(0.85, 1.15), s * rng.uniform(0.85, 1.15)
    corners = [p - t * sx - b * sy, p + t * sx - b * sy, p + t * sx + b * sy, p - t * sx + b * sy]
    # keep cards above the sand
    corners = [c if c[2] > ground + 0.02 else c + UP * (ground + 0.02 - c[2]) for c in corners]
    u0, v0, u1, v1 = cell_uv(*cell)
    uvs = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
    zf = np.clip(p[2] / max(height, 0.5), 0, 1)
    g = 0.04 + 0.26 * zf ** 1.2
    nb = nrm((1 - bend) * n + bend * n_out)
    if lod == 2:
        idx = [mb.v(c, g, 0.6, phase, 1) for c in corners]
        mb.f(idx, uvs, LEAF)
        mb.custom_n.extend([nb] * 4)
        return
    centre = p + n * size * 0.07
    idx = [mb.v(c, min(1.0, g + 0.06), 0.85 + 0.15 * rng.random(), phase, 1) for c in corners]
    ci = mb.v(centre, g, 0.3, phase, 1)
    mb.custom_n.extend([nrm(nb + 0.15 * nrm(c - p)) for c in corners] + [nb])
    cu = (0.5 * (u0 + u1), 0.5 * (v0 + v1))
    for k in range(4):
        k1 = (k + 1) % 4
        mb.f((idx[k], idx[k1], ci), (uvs[k], uvs[k1], cu), LEAF)


def hull(mb, shape, rng, subdiv, inset, phase, height):
    """icosphere shrink-wrapped to the lobe union, inset below the card shell; opaque dense-leaf texture"""
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=1.0)
    verts = np.array([v.co[:] for v in bm.verts])
    faces = [[v.index for v in f.verts] for f in bm.faces]
    bm.free()
    lo, hi = shape.bbox()
    centre = np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, max(0.3, (lo[2] + hi[2]) * 0.4)])
    out = []
    for d in verts:
        d = nrm(d)
        # march outward from the centre to the surface
        r0, r1 = 0.0, 6.0
        for _ in range(40):
            rm = 0.5 * (r0 + r1)
            if shape.sdf(centre + d * rm)[0] < 0:
                r0 = rm
            else:
                r1 = rm
        q = centre + d * max(0.05, r0 - inset)
        q[2] = max(q[2], -0.12)
        out.append(q)
    out = np.array(out)
    idx = []
    for q in out:
        zf = np.clip(q[2] / max(height, 0.5), 0, 1)
        idx.append(mb.v(q, 0.03 + 0.15 * zf, 0.1, phase, 0))
    u0, v0, u1, v1 = cell_uv(*st.DENSE_CELL, margin=6)
    span = 0.9    # metres of hull per atlas cell
    for f in faces:
        p = out[f]
        e1 = nrm(p[1] - p[0])
        nn = nrm(np.cross(p[1] - p[0], p[2] - p[0]))
        e2 = np.cross(nn, e1)
        loc = np.array([[np.dot(q - p[0], e1), np.dot(q - p[0], e2)] for q in p]) / span
        loc -= loc.min(0)
        ext = loc.max(0)
        sc = min(1.0, 0.96 / max(ext.max(), 1e-6))
        loc *= sc
        off = rng.uniform(0, np.maximum(1 - loc.max(0), 0))
        uv = [(u0 + (u1 - u0) * (l[0] + off[0]), v0 + (v1 - v0) * (l[1] + off[1])) for l in loc]
        mb.f([idx[k] for k in f], uv, LEAF)
        # hull normals stay geometric (they are deep inside)
    mb.custom_n.extend([None] * len(out))


def stems(mb, shape, rng, n, phase, lod):
    u0, v0, u1, v1 = cell_uv(*st.WOOD_CELL, margin=6)
    lo, hi = shape.bbox()
    for i in range(n):
        th = rng.uniform(0, 2 * math.pi)
        base = np.array([math.cos(th), math.sin(th), 0]) * rng.uniform(0.0, 0.25) + np.array([0, 0, -0.08])
        tgt = shape.c[int(rng.integers(len(shape.c)))] + rng.normal(0, 0.3, 3)
        tgt[2] = max(0.35, tgt[2] * 0.75)
        k = 4 if lod == 0 else 2
        pts = []
        for j in range(k + 1):
            f = j / k
            q = base + (tgt - base) * f
            q = q + np.array([math.cos(th + 1.3), math.sin(th + 1.3), 0]) * 0.12 * math.sin(math.pi * f) + rng.normal(0, 0.03, 3) * (j > 0)
            pts.append(q)
        r = rng.uniform(0.025, 0.05)
        radii = [r * (1 - 0.6 * j / k) for j in range(k + 1)]
        before = len(mb.co)
        tube(mb, pts, radii, 5 if lod == 0 else 4, (u0, u0 + (u1 - u0) * 0.9, v0, v1), [0.02 + 0.1 * j / k for j in range(k + 1)], phase, mat=WOOD)
        mb.custom_n.extend([None] * (len(mb.co) - before))


def build(v, lod):
    P = VARIANTS[v]
    rng = np.random.default_rng(P['seed'] * 10 + lod)
    shape = Shape(P['lobes'], P['seed'])
    lo, hi = shape.bbox()
    height = hi[2]
    mb = MeshBuilder()
    mb.custom_n = []
    hull(mb, shape, rng, {0: 2, 1: 1, 2: 1}[lod], {0: 0.22, 1: 0.18, 2: 0.12}[lod], float(rng.random()), height)
    if lod < 2:
        stems(mb, shape, rng, {0: 9, 1: 4}[lod], float(rng.random()), lod)
    area = 0.0
    for c, r in zip(shape.c, shape.r):
        # ellipsoid surface (Thomsen), x0.55 for lobe overlap and the part under the sand
        area += 4 * math.pi * (((r[0] * r[1]) ** 1.6 + (r[0] * r[2]) ** 1.6 + (r[1] * r[2]) ** 1.6) / 3) ** (1 / 1.6) * 0.55
    size = {0: 0.46, 1: 0.75, 2: 1.1}[lod]
    layers = {0: 5.5, 1: 3.5, 2: 1.8}[lod]
    n = int(area * layers / (size * size))
    n = min(n, {0: 1250, 1: 300, 2: 105}[lod])
    pts = sample_shell(shape, rng, n, spacing=size * {0: 0.3, 1: 0.4, 2: 0.5}[lod])
    grads = shape.grad(pts)
    if lod == 0:
        # a few sprigs stick out of the shell and break the outline
        k = int(len(pts) * 0.12)
        sel = rng.choice(len(pts), k, replace=False)
        pts[sel] = pts[sel] + grads[sel] * rng.uniform(0.08, 0.28, (k, 1))
    wts = np.array(P['cells'])
    pools = [SCAEVOLA, SEAGRAPE, SPRIG]
    for p, g in zip(pts, grads):
        w = wts.copy()
        if abs(g[2]) < 0.45:
            w[2] += 0.5          # sides of the shrub: more side-view sprigs
        pool = pools[int(rng.choice(3, p=w / w.sum()))]
        ci = pool[int(rng.integers(len(pool)))]
        col, row, _ = st.CARDS[ci]
        add_card(mb, p, g, size * rng.uniform(0.85, 1.15), (col, row), rng, height, float(rng.random()), lod)
    return mb, shape


def mesh_object_custom(name, mb, mats, ao):
    ob = pb.mesh_object(name, mb, mats, ao)
    me = ob.data
    # custom (bent) normals for the cards, geometric elsewhere
    if len(me.vertices) != len(mb.co) or len(mb.custom_n) != len(mb.co):
        log('WARNING custom normals skipped', name, len(me.vertices), len(mb.co), len(mb.custom_n))
        return ob
    vn = np.zeros((len(mb.co), 3))
    geo = np.array([v.normal[:] for v in me.vertices])
    for i, cn in enumerate(mb.custom_n):
        vn[i] = cn if cn is not None else geo[i]
    me.normals_split_custom_set_from_vertices([tuple(x) for x in vn])
    return ob


def main():
    pb.reset_scene()
    mats = [pb.make_material('scrub_leaf', f'{TEX}/scrub_leaf_basecolor.png', f'{TEX}/scrub_leaf_normal.png', f'{TEX}/scrub_leaf_orm.png',
                             alpha_clip=True, double_sided=True),
            pb.make_material('scrub_wood', f'{TEX}/scrub_leaf_basecolor.png', f'{TEX}/scrub_leaf_normal.png', f'{TEX}/scrub_leaf_orm.png',
                             rough_factor=0.95)]
    from common import load_image, resize
    alpha = resize(load_image(f'{TEX}/scrub_leaf_basecolor.png', linear=True)[..., 3:4], 512, 512)[..., 0]
    infos = []
    for v in VARIANTS:
        built = [build(v, lod) for lod in range(3)]
        mbs = [b[0] for b in built]
        shape = built[0][1]
        baker = pb.AOBaker(mbs[0], alpha, frond_mat=LEAF)
        for lod, mb in enumerate(mbs):
            vis = baker.bake(mb, nrays=28, seed=lod + 3)
            ao = np.clip(0.22 + 0.78 * np.power(vis, 1.2), 0.22, 1.0)
            mesh_object_custom(f'scrub_{v}_lod{lod}', mb, mats, ao)
        co = np.array(mbs[0].co)
        lo, hi = shape.bbox()
        info = dict(name=f'scrub_{v}', tris=[mb.tri_count() for mb in mbs], height_m=round(float(co[:, 2].max()), 2),
                    extent_x_m=[round(float(co[:, 0].min()), 2), round(float(co[:, 0].max()), 2)],
                    extent_y_m=[round(float(co[:, 1].min()), 2), round(float(co[:, 1].max()), 2)],
                    cards=[sum(1 for f in mb.faces if f[2] == LEAF) for mb in mbs])
        infos.append(info)
        log(json.dumps(info))
    pb.export_glb(f'{OUT}/scrub_raw.glb')
    with open(f'{OUT}/scrub_info.json', 'w') as f:
        json.dump(infos, f, indent=1)
    bpy.ops.wm.save_as_mainfile(filepath=f'{OUT}/scrub.blend')
    log('exported')


main()
