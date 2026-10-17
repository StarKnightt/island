"""
README: pandanus / screw pine (Pandanus tectorius) -> public/assets/veg/palms/pandanus.glb

  1. atlas:  make_textures.py, then make_pandanus_tex.py
  2. build:  bash c:/Code/island/tools/heavy.sh palms E:/blender/blender-5.1.2-windows-x64/blender.exe --background \
               --factory-startup -t 6 --python c:/Code/island/tools/blender/palms/build_pandanus.py
  3. optimise build/pandanus_raw.glb with tools/optimize-glb.ts (see build_coconut.py)

2 variants x 3 LODs, nodes pandanus_<a|b>_lod<0..2>; materials pandanus_bark (opaque: trunk, branches, stilt roots,
fruit) and pandanus_leaf (MASK, double-sided), one atlas. Leaning (+X), forking trunk on a cone of stilt roots;
every branch ends in a 3-ranked spiral tuft of keeled strap leaves (1-1.5 m) drooping at the tips, with dead leaves
hanging under the tuft. COLOR_0 = (AO, bend G, flutter B, phase A per leaf).
"""
import sys, os, math, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import bpy
from palm_geo import MeshBuilder, nrm, rot, UP, lerp
import palm_blender as pb
from common import SCRATCH

OUT = 'E:/tmp/island/helpers/palms/build'
TEX = SCRATCH + '/tex'
BARK, LEAF = 0, 1
AW, AH = 1024, 2048
TILE_V = (0.0, 1024 / AH)
LEAF_V = (1024 / AH, 2047 / AH)
STRIP = 128 / AW
T0 = time.time()


def log(*a):
    print(f'[pandanus {time.time() - T0:6.1f}s]', *a, flush=True)


VARIANTS = {
    'a': dict(seed=5, trunk_len=2.6, lean=22, r0=0.15, depth=3, kids=2, branch_len=1.3, roots=14, tuft_leaves=25,
              leaf_len=(1.05, 1.45), fruit=1),
    'b': dict(seed=9, trunk_len=1.8, lean=10, r0=0.12, depth=2, kids=3, branch_len=1.25, roots=11, tuft_leaves=28,
              leaf_len=(0.95, 1.3), fruit=0),
}


def frame(t, hint=None):
    hint = np.array([0.3, 0.7, 0.2]) if hint is None else hint
    n = nrm(np.cross(t, hint))
    return n, np.cross(t, n)


def bark_tube(mb, pts, radii, sides, g_list, phase, tile_len=1.2, s0=0.0, wraps=1, mat=BARK, close=False):
    """tapered tube with the bark tile: around -> u (wraps), along -> v, rows split at tile boundaries"""
    pts = [np.asarray(p, float) for p in pts]
    L = [0.0]
    for i in range(1, len(pts)):
        L.append(L[-1] + np.linalg.norm(pts[i] - pts[i - 1]))
    # resample with tile boundaries inserted
    ss = sorted(set([round(x, 5) for x in L] + [round(b - s0, 5) for b in np.arange(math.ceil(s0 / tile_len) * tile_len, s0 + L[-1], tile_len) if 0 < b - s0 < L[-1]]))
    def interp(arr, s):
        i = np.searchsorted(L, s) - 1
        i = min(max(i, 0), len(L) - 2)
        f = (s - L[i]) / max(L[i + 1] - L[i], 1e-9)
        return arr[i] * (1 - f) + arr[i + 1] * f
    P = [interp(np.array(pts), s) for s in ss]
    Rr = [interp(np.array(radii), s) for s in ss]
    G = [interp(np.array(g_list), s) for s in ss]
    rings = []
    prev = None
    for i, (p, r) in enumerate(zip(P, Rr)):
        t = nrm(P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)])
        if prev is None:
            n, b = frame(t)
        else:
            n = nrm(prev - t * np.dot(prev, t))
            b = np.cross(t, n)
        prev = n
        rings.append([mb.v(p + r * (math.cos(2 * math.pi * j / sides) * n + math.sin(2 * math.pi * j / sides) * b), G[i], 0.0, phase) for j in range(sides)])
    for i in range(len(P) - 1):
        sa, sb = s0 + ss[i], s0 + ss[i + 1]
        k = math.floor((0.5 * (sa + sb)) / tile_len)
        va = TILE_V[0] + (TILE_V[1] - TILE_V[0]) * (sa / tile_len - k)
        vb = TILE_V[0] + (TILE_V[1] - TILE_V[0]) * (sb / tile_len - k)
        off = (k * 0.37) % 1.0
        for j in range(sides):
            j1 = (j + 1) % sides
            ua, ub = off + wraps * j / sides, off + wraps * (j + 1) / sides
            mb.f((rings[i][j], rings[i][j1], rings[i + 1][j1], rings[i + 1][j]), ((ua, va), (ub, va), (ub, vb), (ua, vb)), mat)
    if close:
        c = mb.v(P[-1] + nrm(P[-1] - P[-2]) * Rr[-1] * 0.6, G[-1], 0.0, phase)
        for j in range(sides):
            mb.f((rings[-1][j], rings[-1][(j + 1) % sides], c), ((0.5, 0.1), (0.5, 0.1), (0.5, 0.1)), mat)
    return s0 + L[-1]


def grow(P, rng):
    """branch tree: list of (pts, radii, g) limbs and list of tips (pos, dir, radius, g)"""
    limbs, tips = [], []
    lean = math.radians(P['lean'])
    d0 = nrm(np.array([math.sin(lean), 0.0, math.cos(lean)]))

    def limb(p, d, L, r0, r1, g0, g1, depth, s0):
        pts, radii, gs = [p], [r0], [g0]
        q, dd = p.copy(), d.copy()
        n = 6
        for i in range(1, n + 1):
            dd = nrm(dd + UP * 0.07 * (depth + 0.6) + rng.normal(0, 0.03, 3))
            q = q + dd * (L / n)
            f = i / n
            pts.append(q.copy())
            radii.append(lerp(r0, r1, f))
            gs.append(lerp(g0, g1, f))
        limbs.append((pts, radii, gs, s0))
        end, de = pts[-1], nrm(pts[-1] - pts[-2])
        if depth >= P['depth']:
            tips.append((end, de, r1, g1))
            return
        kids = P['kids'] if depth == 0 else 2
        az0 = rng.uniform(0, 2 * math.pi)
        for c in range(kids):
            n1, b1 = frame(de)
            az = az0 + 2 * math.pi * c / kids + rng.uniform(-0.3, 0.3)
            spread = math.radians(rng.uniform(34, 55) if depth < 2 else rng.uniform(25, 40))
            side = math.cos(az) * n1 + math.sin(az) * b1
            dc = nrm(de * math.cos(spread) + side * math.sin(spread) + UP * 0.08)
            Lc = P['branch_len'] * (0.85 ** depth) * rng.uniform(0.85, 1.15)
            rc = r1 * rng.uniform(0.72, 0.82)
            limb(end, dc, Lc, rc, rc * 0.72, g1, min(0.35, g1 + 0.08), depth + 1, s0 + L)

    limb(np.array([0.0, 0.0, -0.25]), d0, P['trunk_len'] + 0.25, P['r0'] * 1.25, P['r0'] * 0.78, 0.0, 0.18, 0, 0.0)
    return limbs, tips


def strap_leaf(mb, p, d0, length, width, strip, droop, twist, rng, lod, g0, phase, fold=0.55):
    """keeled strap leaf: V cross-section (LOD0), flat strip (LOD1/2); u across the leaf, v base -> tip"""
    nseg = {0: 6, 1: 4, 2: 2}[lod]
    u0 = strip * STRIP
    u1 = u0 + STRIP
    ax = np.cross(d0, -UP)
    ax = nrm(ax) if np.linalg.norm(ax) > 1e-4 else np.array([1.0, 0, 0])
    pts, ups = [p], []
    q = p.copy()
    for i in range(nseg):
        f = (i + 0.5) / nseg
        d = rot(d0, ax, droop * f ** 1.6)
        q = q + d * (length / nseg)
        pts.append(q.copy())
    cols = []
    for i, q in enumerate(pts):
        f = i / nseg
        t = nrm(pts[min(i + 1, nseg)] - pts[max(i - 1, 0)])
        up = UP - t * np.dot(UP, t)
        up = nrm(up) if np.linalg.norm(up) > 1e-4 else nrm(np.cross(t, [1, 0, 0]))
        up = rot(up, t, twist * f)
        side = np.cross(t, up)
        hw = 0.5 * width * (1.0 if f < 0.7 else max(0.25, 1 - (f - 0.7) / 0.3 * 0.75))
        hw *= {0: 1.0, 1: 1.35, 2: 2.4}[lod]          # fewer, wider leaves keep the tuft's coverage
        g = min(1.0, g0 + (1 - g0) * f ** 1.2)
        flut = f ** 1.3
        v = LEAF_V[0] + (LEAF_V[1] - LEAF_V[0]) * f
        if lod == 0:
            l = mb.v(q - side * hw * math.cos(fold) + up * hw * math.sin(fold), g, flut, phase, 1)
            k = mb.v(q, g, flut * 0.6, phase, 1)
            r = mb.v(q + side * hw * math.cos(fold) + up * hw * math.sin(fold), g, flut, phase, 1)
            cols.append(((l, u0), (k, 0.5 * (u0 + u1)), (r, u1), v))
        else:
            l = mb.v(q - side * hw, g, flut, phase, 1)
            r = mb.v(q + side * hw, g, flut, phase, 1)
            cols.append(((l, u0), (r, u1), v))
    for i in range(nseg):
        a, b = cols[i], cols[i + 1]
        va, vb = a[-1], b[-1]
        for j in range(len(a) - 2):
            (ia, ua), (ia2, ua2) = a[j], a[j + 1]
            (ib, ub), (ib2, ub2) = b[j], b[j + 1]
            mb.f((ia, ia2, ib2, ib), ((ua, va), (ua2, va), (ub2, vb), (ub, vb)), LEAF)
    return pts[-1]


def tuft(mb, tip, P, rng, lod):
    pos, d, r, g0 = tip
    n = {0: P['tuft_leaves'], 1: int(P['tuft_leaves'] * 0.55), 2: 5}[lod]
    ldead = {0: int(rng.integers(3, 6)), 1: 2, 2: 1}[lod]
    n1, b1 = frame(d)
    a0 = rng.uniform(0, 2 * math.pi)
    for i in range(n + ldead):
        dead = i >= n
        f = i / max(1, n - 1) if not dead else 1.0     # 0 = newest (top) .. 1 = oldest (bottom)
        ang = a0 + i * math.radians(127.5)              # 3 spiral ranks (screw pine)
        h = -0.32 * f if not dead else -0.36 - 0.06 * (i - n)
        p = pos + d * (h + 0.02)
        radial = math.cos(ang) * n1 + math.sin(ang) * b1
        if dead:
            elev = math.radians(rng.uniform(-80, -58))
            strip = int(rng.integers(5, 7))
            droop = math.radians(rng.uniform(5, 20))
        else:
            elev = math.radians(lerp(76, 2, f ** 0.8) + rng.uniform(-6, 6))
            strip = 4 if (f > 0.85 and rng.random() < 0.5) else (3 if f < 0.12 else int(rng.integers(0, 3)))
            droop = math.radians(lerp(40, 118, f) + rng.uniform(-12, 12))      # fountain: tips arch over
        hd = nrm(radial - UP * np.dot(radial, UP))
        d0 = nrm(hd * math.cos(elev) + UP * math.sin(elev))
        L = lerp(*P['leaf_len'], rng.random()) * (0.6 if f < 0.08 and not dead else 1.0)
        strap_leaf(mb, p + radial * r * 0.8, d0, L, rng.uniform(0.055, 0.075), strip, droop,
                   math.radians(rng.uniform(-50, 50)), rng, lod, g0, float(rng.random()))


def prop_roots(mb, P, rng, lod, trunk_limb):
    pts, radii, gs, s0 = trunk_limb
    sides = {0: 5, 1: 4, 2: 3}[lod]
    n = P['roots'] if lod < 2 else max(3, P['roots'] // 2)
    tr = np.array(pts)
    for i in range(n):
        h = rng.uniform(0.3, 1.6)
        k = int(np.clip(h / (P['trunk_len'] / 6), 0, len(tr) - 2))
        start = tr[k] + (tr[k + 1] - tr[k]) * 0.3
        az = 2 * math.pi * (i + rng.uniform(-0.35, 0.35)) / n
        out = np.array([math.cos(az), math.sin(az), 0.0])
        # stilt roots fan out more on the side the trunk leans away from (they hold it up)
        spread = h * rng.uniform(0.5, 0.95) * (1.25 if out[0] < 0 else 0.9)
        end = np.array([start[0], start[1], 0.0]) + out * spread - UP * 0.18
        aerial = rng.random() < 0.2 and h > 0.8
        if aerial:     # young aerial root that has not reached the sand yet
            end = start + (end - start) * rng.uniform(0.35, 0.6)
        start = start + out * radii[k] * 0.7
        mid = 0.5 * (start + end) + out * 0.05 + UP * 0.04
        rr = rng.uniform(0.025, 0.06) * (0.7 if aerial else 1.0)
        steps = [start, start * 0.66 + mid * 0.34, mid, end * 0.7 + mid * 0.3, end] if lod == 0 else [start, mid, end]
        rad = list(np.linspace(rr, rr * 0.8, len(steps)))
        bark_tube(mb, steps, rad, sides, [0.0] * len(steps), float(rng.random()), tile_len=1.0, s0=rng.uniform(0, 3))


def fruit(mb, tip, rng, lod):
    from palm_geo import ovoid
    pos, d, r, g0 = tip
    n1, b1 = frame(d)
    stalk_end = pos - UP * 0.35 + n1 * 0.12
    bark_tube(mb, [pos - d * 0.1, pos - UP * 0.15 + n1 * 0.08, stalk_end], [0.025, 0.02, 0.018], 4 if lod == 0 else 3, [g0] * 3, 0.5)
    # pineapple-like syncarp: reuse the coconut ovoid builder with the fruit region of the pandanus atlas
    import palm_geo
    reg = palm_geo.nut_region
    palm_geo.nut_region = lambda col: (7 * STRIP, 8 * STRIP, LEAF_V[0], LEAF_V[0] + 256 / AH)
    try:
        ovoid(mb, stalk_end - UP * 0.11, UP, 0.24, 0.19, 0, g0, 0.5, lod, rng, segs=(4, 8) if lod == 0 else (1, 5))
    finally:
        palm_geo.nut_region = reg


def build(v, lod):
    P = VARIANTS[v]
    rng = np.random.default_rng(P['seed'])
    limbs, tips = grow(P, rng)
    mb = MeshBuilder()
    sides = {0: 9, 1: 6, 2: 4}
    step = {0: 1, 1: 2, 2: 3}[lod]
    for li, (pts, radii, gs, s0) in enumerate(limbs):
        idx = list(range(0, len(pts), step))
        if idx[-1] != len(pts) - 1:
            idx.append(len(pts) - 1)
        bark_tube(mb, [pts[i] for i in idx], [radii[i] for i in idx], sides[lod] if li == 0 else max(3, sides[lod] - 3),
                  [gs[i] for i in idx], 0.3, tile_len=1.25 if lod < 2 else 4.0, s0=s0, wraps=1, close=li > 0 and lod < 2)
    prop_roots(mb, P, np.random.default_rng(P['seed'] + 1), lod, limbs[0])
    r2 = np.random.default_rng(P['seed'] + 2)
    for t in tips:
        tuft(mb, t, P, np.random.default_rng(int(r2.integers(1 << 30))), lod)
    if P['fruit'] and lod < 2:
        fruit(mb, tips[0], np.random.default_rng(P['seed'] + 3), lod)
    for k, (i, uv, m) in enumerate(mb.faces):
        if m == 2:
            mb.faces[k] = (i, uv, BARK)
    return mb, tips


def main():
    pb.reset_scene()
    mats = [pb.make_material('pandanus_bark', f'{TEX}/pandanus_basecolor.png', f'{TEX}/pandanus_normal.png', f'{TEX}/pandanus_orm.png'),
            pb.make_material('pandanus_leaf', f'{TEX}/pandanus_basecolor.png', f'{TEX}/pandanus_normal.png', f'{TEX}/pandanus_orm.png',
                             alpha_clip=True, double_sided=True)]
    from common import load_image, resize
    alpha = resize(load_image(f'{TEX}/pandanus_basecolor.png', linear=True)[..., 3:4], 512, 256)[..., 0]
    infos = []
    for v in VARIANTS:
        built = [build(v, lod) for lod in range(3)]
        mbs = [b[0] for b in built]
        baker = pb.AOBaker(mbs[0], alpha, frond_mat=LEAF)
        for lod, mb in enumerate(mbs):
            ao = pb.ao_remap(baker.bake(mb, nrays=32, seed=lod + 5))
            pb.mesh_object(f'pandanus_{v}_lod{lod}', mb, mats, ao)
        co = np.array(mbs[0].co)
        tips = built[0][1]
        info = dict(name=f'pandanus_{v}', tris=[mb.tri_count() for mb in mbs], height_m=round(float(co[:, 2].max()), 2),
                    extent_x_m=[round(float(co[:, 0].min()), 2), round(float(co[:, 0].max()), 2)],
                    extent_y_m=[round(float(co[:, 1].min()), 2), round(float(co[:, 1].max()), 2)], tufts=len(tips),
                    trunk_radius_m=VARIANTS[v]['r0'])
        infos.append(info)
        log(json.dumps(info))
    pb.export_glb(f'{OUT}/pandanus_raw.glb')
    with open(f'{OUT}/pandanus_info.json', 'w') as f:
        json.dump(infos, f, indent=1)
    bpy.ops.wm.save_as_mainfile(filepath=f'{OUT}/pandanus.blend')
    log('exported')


main()
