"""Understory plants (LOD0 + LOD1) -> E:/tmp/island/helpers/jungle/glb/understory_raw.glb

    bash c:/Code/island/tools/heavy.sh jungle E:/blender/blender-5.1.2-windows-x64/blender.exe --background \
        --factory-startup -t 6 --python tools/blender/jungle/understory.py -- [--only banana,treefern,...]

Needs understory_atlas.py + understory_textures.py outputs. Materials: understory_stem (opaque), understory_leaf and
understory_scan (alpha MASK, double-sided). Nodes <species>_<variant>_lod<k>. COLOR_0 = (AO, bend, flutter, phase).
Blender Z-up; origin = plant base at ground level.
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bpy  # noqa: E402
import numpy as np  # noqa: E402

import jmesh as J  # noqa: E402

TEX = 'E:/tmp/island/helpers/jungle/tex'
OUT = 'E:/tmp/island/helpers/jungle/glb'
RAWM = 'E:/tmp/island/raw/jungle/models'
STEM, LEAF, SCAN = 0, 1, 2
STRIP = {'banana': 0, 'fern': 1, 'palm': 2, 'bark': 3}  # understory_stem strips (u = k/4 .. (k+1)/4)


def smooth(e0, e1, x):
    t = min(max((x - e0) / (e1 - e0), 0.0), 1.0)
    return t * t * (3 - 2 * t)


class Atlas:
    def __init__(self):
        with open(f'{TEX}/understory_leaf.json') as f:
            self.t = json.load(f)['tiles']
        with open(f'{TEX}/understory_scan.json') as f:
            self.q = json.load(f)['quads']

    def tile_uv(self, name, cu, cv):
        """Tile-normalised (u, v up) -> atlas UV."""
        r = self.t[name]['rect']
        return (r[0] + cu * (r[2] - r[0]), r[1] + cv * (r[3] - r[1]))

    def sub_uv(self, name, k, su, sv):
        s = self.t[name]['subs'][k % len(self.t[name]['subs'])]
        return self.tile_uv(name, s['u0'] + su * (s['u1'] - s['u0']), s['v0'] + sv * (s['v1'] - s['v0']))


# ------------------------------------------------------------------------------------------------ builders
def stem_tube(mb, path, radii, sides, strip, g0, g1, ph, ao0=0.45, ao1=0.9, v_per_m=0.4):
    """Tube with the understory_stem strip `strip` (u wraps inside the strip, v repeats every 1/v_per_m metres)."""
    u0 = STRIP[strip] / 4.0

    def colf(i, f, a):
        return np.tile([ao0 + (ao1 - ao0) * f, g0 + (g1 - g0) * f, 0.0, ph], (len(a), 1))
    rings = J.tube(mb, path, radii, sides, colf, mat=STEM, u_wrap=1, v_scale=v_per_m)
    # remap u from 0..1 to the strip
    n = len(rings) - 1
    k0 = len(mb.UV) - n * sides * 4
    for i in range(k0, len(mb.UV)):
        u, v = mb.UV[i]
        mb.UV[i] = (u0 + u * 0.25 * 0.995 + 0.25 * 0.0025, v)
    return rings


def ribbon(mb, P, side, up, half_w, uvf, colf, mat=LEAF, droop=None, cols=2, nrm_bend=0.35):
    """Leaf / frond ribbon along centre line P (K x 3). side/up: per-point unit vectors. half_w: per-point half
    widths. droop(i, f) -> angle (rad) the half-blade at fraction f (0 midrib .. 1 edge) hangs below the leaf plane.
    uvf(i, sx) -> (u, v) for sx in [-1, 1]. colf(i, sx) -> RGBA."""
    K = len(P)
    xs = np.linspace(-1, 1, 2 * cols + 1)
    idx = np.zeros((K, len(xs)), int)
    for i in range(K):
        pts, cs, ns = [], [], []
        for j, sx in enumerate(xs):
            f = abs(sx)
            a = droop(i, f) if droop else 0.0
            # walk out along the half-blade, bending down progressively
            p = P[i].copy()
            steps = max(1, int(round(f * cols)))
            if f > 0:
                for k in range(steps):
                    ff = (k + 0.5) / steps * f
                    ang = droop(i, ff) if droop else 0.0
                    p = p + (np.sign(sx) * side[i] * math.cos(ang) - up[i] * math.sin(ang)) * half_w[i] * f / steps
            pts.append(p)
            cs.append(colf(i, sx))
            nn = J.norm(up[i] * (1 - nrm_bend) + np.sign(sx) * side[i] * nrm_bend * f)
            ns.append(nn)
        b = mb.verts(np.array(pts), np.array(cs), np.array(ns))
        idx[i] = b + np.arange(len(xs))
    for i in range(K - 1):
        for j in range(len(xs) - 1):
            mb.face((idx[i, j], idx[i, j + 1], idx[i + 1, j + 1], idx[i + 1, j]),
                    [uvf(i, xs[j]), uvf(i, xs[j + 1]), uvf(i + 1, xs[j + 1]), uvf(i + 1, xs[j])], mat)


def arc_path(start, d0, length, bend, n, side_axis=None, twist=0.0, rng=None, wob=0.0):
    """Path starting at `start` in direction d0, bending downward (about the horizontal side axis) by `bend`
    radians over its length (bend grows with t^1.6). Returns points, tangents."""
    d0 = J.norm(d0)
    if side_axis is None:
        side_axis = J.norm(np.cross(d0, np.array([0, 0, 1.0])) + 1e-9)
    P = [np.asarray(start, np.float64)]
    T_ = []
    for i in range(n):
        t = (i + 0.5) / n
        d = J.rot(side_axis, -bend * t ** 1.6) @ d0
        if wob and rng is not None:
            d = J.norm(d + rng.normal(0, wob, 3))
        P.append(P[-1] + d * length / n)
        T_.append(d)
    T_.append(T_[-1])
    return np.array(P), np.array(T_), side_axis


def leaf_frame(P, T_, roll=0.0):
    """Side / up vectors along a path; side horizontal-ish, up = side x tangent."""
    side, up = [], []
    for i in range(len(P)):
        t = T_[i]
        s = np.cross(t, np.array([0, 0, 1.0]))
        if np.linalg.norm(s) < 1e-6:
            s = np.array([1.0, 0, 0])
        s = J.norm(s)
        u = J.norm(np.cross(s, t))
        if roll:
            s, u = J.rot(t, roll) @ s, J.rot(t, roll) @ u
        side.append(s)
        up.append(u)
    return np.array(side), np.array(up)


# ------------------------------------------------------------------------------------------------ plants
class Plant:
    def __init__(self, at, seed):
        self.at = at
        self.seed = seed

    def rng(self, k=0):
        return np.random.default_rng(self.seed * 101 + k)


def banana_leaf(mb, at, rng, base, az, elev, L, W, bend, tile, lod, g0, ph, droop_a, hang=False):
    n = 12 if lod == 0 else 4
    d0 = np.array([math.cos(az) * math.cos(elev), math.sin(az) * math.cos(elev), math.sin(elev)])
    P, Tn, _ = arc_path(base, d0, L, bend, n, rng=rng, wob=0.02)
    side, up = leaf_frame(P, Tn, roll=rng.normal(0, 0.12))
    t = np.linspace(0, 1, n + 1)
    hw = np.full(n + 1, W / 2)  # constant width: the texture alpha carries the outline
    pad = 4 / 1024
    tinfo = at.t[tile]

    def uvf(i, sx):
        return at.tile_uv(tile, 0.5 + 0.5 * sx * (1 - 2 * 4 / 256), pad + t[i] * (1 - 2 * pad))

    def colf(i, sx):
        return (0.55 + 0.45 * t[i] if not hang else 0.5 + 0.2 * t[i], min(1.0, g0 + (1 - g0) * t[i] ** 1.2),
                min(1.0, 0.15 * t[i] + 0.85 * abs(sx) * (0.3 + 0.7 * t[i])), ph)

    def dr(i, f):
        return droop_a * (0.4 + 0.8 * t[i]) * (0.5 + 0.5 * f)
    ribbon(mb, P, side, up, hw, uvf, colf, LEAF, droop=dr, cols=2 if lod == 0 else 1)
    return P


def make_banana(at, seed, lod, tall):
    rng = np.random.default_rng(seed)
    mb = J.MB()
    nst = rng.integers(3, 6)
    ph0 = float(rng.uniform())
    stems = []
    for k in range(nst):
        if k == 0:
            h = tall * rng.uniform(0.95, 1.05)
            pos = np.array([0.0, 0.0])
        else:
            h = tall * rng.uniform(0.25, 0.75)
            a = rng.uniform(0, 2 * math.pi)
            pos = np.array([math.cos(a), math.sin(a)]) * rng.uniform(0.35, 0.9)
        stems.append((h, pos))
    for si, (h, pos) in enumerate(stems):
        lean = J.norm(np.array([rng.normal(0, 0.06) + pos[0] * 0.08, rng.normal(0, 0.06) + pos[1] * 0.08, 1.0]))
        r0 = 0.07 + 0.06 * h / tall + rng.uniform(0, 0.02)
        top = np.array([pos[0], pos[1], -0.15]) + lean * (h * 0.56 + 0.15)
        path = np.array([np.array([pos[0], pos[1], -0.15]) + lean * (h * 0.56 + 0.15) * f for f in np.linspace(0, 1, 6)])
        gtop = 0.12 + 0.2 * h / 4.0
        ph = float((ph0 + 0.3 * si) % 1.0)
        stem_tube(mb, path, np.linspace(r0 * 1.15, r0 * 0.8, 6), 9 if lod == 0 else 5, 'banana', 0.0, gtop, ph,
                  v_per_m=0.35)
        # leaves in a spiral from the top
        nl = int(rng.integers(9, 13)) if si == 0 else int(rng.integers(5, 9))
        a0 = rng.uniform(0, 2 * math.pi)
        for k in range(nl):
            az = a0 + k * 2.4
            young = k == nl - 1
            elev = math.radians(rng.uniform(30, 68)) if not young else math.radians(80)
            L = h * rng.uniform(0.48, 0.64) * (0.65 if young else 1.0)
            W = L * rng.uniform(0.32, 0.38)
            pet = rng.uniform(0.25, 0.5) * h / tall
            pdir = np.array([math.cos(az) * 0.45, math.sin(az) * 0.45, 1.0])
            pb = top + np.array([0, 0, -0.05])
            pe = pb + J.norm(pdir) * pet
            stem_tube(mb, np.array([pb, (pb + pe) / 2, pe]), [0.035, 0.028, 0.022], 5 if lod == 0 else 3, 'banana',
                      gtop, gtop + 0.08, ph, v_per_m=0.5)
            tiles = ['banana_intact', 'banana_torn', 'banana_torn', 'banana_shredded']
            tile = tiles[rng.integers(0, len(tiles))] if not young else 'banana_intact'
            lph = float(rng.uniform())
            banana_leaf(mb, at, rng, pe, az, elev, L, W, math.radians(rng.uniform(60, 120) if not young else 25), tile,
                        lod, gtop + 0.08, lph, droop_a=math.radians(rng.uniform(6, 22)))
        # dead leaves hanging along the pseudostem
        for k in range(int(rng.integers(2, 5)) if h > 1.5 else 0):
            az = rng.uniform(0, 2 * math.pi)
            pb = top + np.array([math.cos(az) * (r0 + 0.12), math.sin(az) * (r0 + 0.12), -rng.uniform(0.05, 0.35)])
            L = h * rng.uniform(0.35, 0.5)
            banana_leaf(mb, at, rng, pb, az, math.radians(rng.uniform(-88, -72)), L, L * 0.22,
                        math.radians(rng.uniform(-8, 8)), 'banana_dead', lod, gtop, float(rng.uniform()),
                        droop_a=math.radians(rng.uniform(65, 80)), hang=True)
    return mb


def make_alocasia(at, seed, lod, size):
    """Elephant ear from the recoloured scan leaves: arrow leaves on long petioles from a short trunk."""
    rng = np.random.default_rng(seed)
    mb = J.MB()
    q = at.q['alocasia']['rect']
    # leaf crops inside the alocasia quadrant (quadrant-normalised, y down), attachment point in the crop (x, y down)
    crops = [((0.03, 0.01, 0.45, 0.63), (0.5, 0.66)), ((0.42, 0.02, 0.72, 0.49), (0.5, 0.69)),
             ((0.39, 0.45, 0.76, 0.99), (0.5, 0.7)), ((0.09, 0.55, 0.38, 0.98), (0.5, 0.72))]
    ph0 = float(rng.uniform())
    trunk_h = size * rng.uniform(0.12, 0.25)
    stem_tube(mb, np.array([[0, 0, -0.1], [0.02, 0.01, trunk_h * 0.5], [0.03, 0.0, trunk_h]]), [0.09, 0.075, 0.06],
              8 if lod == 0 else 5, 'palm', 0.0, 0.05, ph0, v_per_m=0.6)
    nl = int(rng.integers(10, 14))
    a0 = rng.uniform(0, 2 * math.pi)
    for k in range(nl):
        az = a0 + k * 2.4 + rng.normal(0, 0.15)
        rel = k / max(nl - 1, 1)
        pl = size * rng.uniform(0.5, 0.8) * (0.7 + 0.3 * (1 - rel))
        top = np.array([0.03, 0.0, trunk_h])
        d = np.array([math.cos(az) * rng.uniform(0.35, 0.7), math.sin(az) * rng.uniform(0.35, 0.7), 1.0])
        P, Tn, _ = arc_path(top, d, pl, math.radians(rng.uniform(20, 45)), 6 if lod == 0 else 3)
        ph = float(rng.uniform())
        stem_tube(mb, P, np.linspace(0.028, 0.014, len(P)) * size, 5 if lod == 0 else 3, 'banana', 0.05, 0.35, ph, v_per_m=0.5)
        A = P[-1]
        (cx0, cy0, cx1, cy1), (ax, ay) = crops[rng.integers(0, len(crops))]
        Lr = size * rng.uniform(0.45, 0.65) * (0.75 + 0.25 * (1 - rel))
        wr = (cx1 - cx0) / (cy1 - cy0)
        Wd = Lr * wr
        hdir = np.array([math.cos(az), math.sin(az), 0.0])
        tilt = math.radians(rng.uniform(25, 60))
        fwd = J.norm(hdir * math.cos(tilt) - np.array([0, 0, 1.0]) * math.sin(tilt))  # toward the tip
        side = J.norm(np.cross(fwd, np.array([0, 0, 1.0])))
        nrm = J.norm(np.cross(side, fwd))
        nu, nv = (6, 7) if lod == 0 else (3, 3)
        idx = np.zeros((nv + 1, nu + 1), int)
        for iv in range(nv + 1):
            fy = iv / nv  # 0 = crop bottom (lobes), 1 = crop top (tip)
            ty = 1 - fy  # y-down coordinate in crop
            y = (ay - ty) * Lr  # metres along fwd from the attachment (tip positive)
            pts, cs, ns = [], [], []
            for iu in range(nu + 1):
                fx = iu / nu
                x = (fx - ax) * Wd
                z = -0.22 * (x / (Wd * 0.5)) ** 2 * Wd * 0.25 - 0.18 * max(y, 0) ** 2 / Lr + 0.1 * min(y, 0) ** 2 / Lr
                p = A + side * x + fwd * y + nrm * z
                pts.append(p)
                dist = math.hypot(x, y) / Lr
                cs.append((0.6 + 0.4 * min(1, dist), min(1.0, 0.35 + 0.65 * dist), min(1.0, 0.1 + 0.9 * dist), ph))
                ns.append(J.norm(nrm + side * x / Wd * 0.5))
            b = mb.verts(np.array(pts), np.array(cs), np.array(ns))
            idx[iv] = b + np.arange(nu + 1)

        def uv(iu, iv):
            fx, fy = iu / nu, iv / nv
            qu = cx0 + fx * (cx1 - cx0)
            qv = 1 - (cy1 - fy * (cy1 - cy0))  # quadrant v up
            return (q[0] + qu * (q[2] - q[0]), q[1] + qv * (q[3] - q[1]))
        for iv in range(nv):
            for iu in range(nu):
                mb.face((idx[iv, iu], idx[iv, iu + 1], idx[iv + 1, iu + 1], idx[iv + 1, iu]),
                        [uv(iu, iv), uv(iu + 1, iv), uv(iu + 1, iv + 1), uv(iu, iv + 1)], SCAN)
    return mb


def make_colocasia(at, seed, lod, size):
    """Taro: peltate heart leaves (procedural tile) held tip-down on long petioles from the ground."""
    rng = np.random.default_rng(seed)
    mb = J.MB()
    tl = at.t['colocasia']
    nl = int(rng.integers(8, 12))
    a0 = rng.uniform(0, 2 * math.pi)
    for k in range(nl):
        az = a0 + k * 2.4 + rng.normal(0, 0.2)
        rel = k / max(nl - 1, 1)
        pl = size * rng.uniform(0.6, 0.95) * (0.7 + 0.3 * (1 - rel))
        base = np.array([rng.normal(0, 0.05), rng.normal(0, 0.05), -0.05])
        d = np.array([math.cos(az) * rng.uniform(0.12, 0.35), math.sin(az) * rng.uniform(0.12, 0.35), 1.0])
        P, Tn, _ = arc_path(base, d, pl, math.radians(rng.uniform(10, 28)), 6 if lod == 0 else 3)
        ph = float(rng.uniform())
        stem_tube(mb, P, np.linspace(0.025, 0.012, len(P)) * size, 5 if lod == 0 else 3, 'banana', 0.0, 0.35, ph, v_per_m=0.5)
        A = P[-1]
        Lr = size * rng.uniform(0.42, 0.58)
        hdir = np.array([math.cos(az), math.sin(az), 0.0])
        tilt = math.radians(rng.uniform(35, 70))
        fwd = J.norm(hdir * math.cos(tilt) - np.array([0, 0, 1.0]) * math.sin(tilt))
        side = J.norm(np.cross(fwd, np.array([0, 0, 1.0])))
        nrm = J.norm(np.cross(side, fwd))
        nu, nv = (6, 6) if lod == 0 else (3, 3)
        px_, py_ = 0.5, 0.36  # peltate point in tile (v up)
        idx = np.zeros((nv + 1, nu + 1), int)
        for iv in range(nv + 1):
            fy = iv / nv
            y = (fy - py_) * Lr / 0.78
            pts, cs, ns = [], [], []
            for iu in range(nu + 1):
                fx = iu / nu
                x = (fx - px_) * Lr / 0.78
                r2 = (x * x + y * y) / (Lr * Lr)
                z = -0.25 * r2 * Lr  # cupped down toward the margin
                p = A + side * x + fwd * y + nrm * z
                pts.append(p)
                dist = math.sqrt(r2)
                cs.append((0.6 + 0.4 * min(1, dist * 1.5), min(1.0, 0.35 + 0.65 * dist * 1.5), min(1.0, 0.1 + 0.9 * dist * 1.5), ph))
                ns.append(J.norm(nrm + (side * x + fwd * y) / Lr * 0.6))
            b = mb.verts(np.array(pts), np.array(cs), np.array(ns))
            idx[iv] = b + np.arange(nu + 1)
        for iv in range(nv):
            for iu in range(nu):
                mb.face((idx[iv, iu], idx[iv, iu + 1], idx[iv + 1, iu + 1], idx[iv + 1, iu]),
                        [at.tile_uv('colocasia', iu / nu, iv / nv), at.tile_uv('colocasia', (iu + 1) / nu, iv / nv),
                         at.tile_uv('colocasia', (iu + 1) / nu, (iv + 1) / nv), at.tile_uv('colocasia', iu / nu, (iv + 1) / nv)], LEAF)
    return mb


def frond(mb, at, rng, base, az, elev, L, bend, tile, lod, g0, ph, droop_a=0.25, scale_w=1.0, twist=0.0):
    t_ = at.t[tile]
    Sw, Sh = t_['size_wh']
    piv = t_['pivot']
    cu0, cv0, cu1, cv1 = t_['content']
    n = 12 if lod == 0 else 5
    d0 = np.array([math.cos(az) * math.cos(elev), math.sin(az) * math.cos(elev), math.sin(elev)])
    P, Tn, _ = arc_path(base, d0, L, bend, n, rng=rng, wob=0.015)
    side, up = leaf_frame(P, Tn, roll=twist)
    t = np.linspace(0, 1, n + 1)
    content_len = (cv1 - piv[1]) * Sh
    k = L / content_len
    half = max(abs(cu0 - 0.5), abs(cu1 - 0.5)) * Sw * k * scale_w
    hw = np.full(n + 1, half)

    def uvf(i, sx):
        tu = 0.5 + sx * (half / (Sw * k * scale_w))
        tv = piv[1] + t[i] * (cv1 - piv[1])
        return at.tile_uv(tile, tu, tv)

    def colf(i, sx):
        return (0.55 + 0.45 * t[i], min(1.0, g0 + (1 - g0) * t[i] ** 1.1), min(1.0, 0.1 * t[i] + 0.9 * abs(sx) * (0.25 + 0.75 * t[i])), ph)

    def dr(i, f):
        return droop_a * (0.5 + 0.7 * t[i]) * f
    ribbon(mb, P, side, up, hw, uvf, colf, LEAF, droop=dr, cols=2 if lod == 0 else 1)
    return P


def make_treefern(at, seed, lod, height):
    rng = np.random.default_rng(seed)
    mb = J.MB()
    ph0 = float(rng.uniform())
    lean = J.norm(np.array([rng.normal(0, 0.08), rng.normal(0, 0.08), 1.0]))
    n = 9 if lod == 0 else 4
    pts = []
    for i in range(n + 1):
        f = i / n
        p = np.array([0, 0, -0.2]) + lean * (height + 0.2) * f
        p[:2] += np.array([math.sin(f * 3 + seed), math.cos(f * 2.3 + seed)]) * 0.06 * f
        pts.append(p)
    pts = np.array(pts)
    zf = np.linspace(0, 1, n + 1)
    radii = 0.13 * (1 - 0.25 * zf) + 0.16 * np.exp(-zf * height / 0.5)  # root-mass flare
    gtop = 0.1 + 0.04 * height
    stem_tube(mb, pts, radii, 10 if lod == 0 else 5, 'fern', 0.0, gtop, ph0, ao0=0.4, ao1=0.85, v_per_m=0.45)
    top = pts[-1]
    nf = int(rng.integers(17, 23)) if lod == 0 else int(rng.integers(12, 15))
    a0 = rng.uniform(0, 2 * math.pi)
    for k in range(nf):
        az = a0 + k * 2.4 + rng.normal(0, 0.1)
        young = rng.uniform() < 0.2
        elev = math.radians(rng.uniform(55, 75) if young else rng.uniform(10, 45))
        L = rng.uniform(2.2, 3.0) * (0.8 if young else 1.0)
        tile = 'treefern_a' if rng.uniform() < 0.6 else 'treefern_b'
        frond(mb, at, rng, top + np.array([0, 0, 0.05]), az, elev, L, math.radians(rng.uniform(60, 105) if not young else 25),
              tile, lod, gtop, float(rng.uniform()), droop_a=math.radians(rng.uniform(5, 20)), scale_w=1.2)
    # dead skirt
    for k in range(int(rng.integers(4, 8)) if lod == 0 else 3):
        az = rng.uniform(0, 2 * math.pi)
        base = top + np.array([math.cos(az) * 0.1, math.sin(az) * 0.1, -rng.uniform(0.0, 0.2)])
        frond(mb, at, rng, base, az, math.radians(rng.uniform(-80, -62)), rng.uniform(1.4, 2.0), math.radians(rng.uniform(-15, 10)),
              'frond_dead', lod, gtop, float(rng.uniform()), droop_a=math.radians(60), scale_w=0.6, twist=rng.normal(0, 0.4))
    # fiddleheads (crosiers) at the crown
    if lod == 0:
        for k in range(int(rng.integers(2, 4))):
            az = rng.uniform(0, 2 * math.pi)
            st = top + np.array([math.cos(az) * 0.06, math.sin(az) * 0.06, 0.05])
            h = rng.uniform(0.15, 0.45)
            stalk = [st, st + np.array([math.cos(az) * 0.05, math.sin(az) * 0.05, h])]
            c = stalk[-1]
            sp = []
            for i in range(14):
                a = i / 13 * math.pi * 2.6
                r = 0.06 * (1 - i / 16)
                sp.append(c + np.array([math.cos(az) * (math.sin(a) * r), math.sin(az) * (math.sin(a) * r), math.cos(a) * r - r]))
            path = np.vstack([np.array(stalk), np.array(sp[1:])])
            stem_tube(mb, path, np.linspace(0.016, 0.006, len(path)), 4, 'fern', gtop, gtop + 0.2, float(rng.uniform()), v_per_m=2.0)
    return mb


def make_rosette(mb, at, rng, centre, n, length, elev, droop, g_att, phase, lod, tile='strap_singles', dead_frac=0.15,
                 width_scale=1.0):
    for k in range(n):
        az = rng.uniform(0, 2 * math.pi)
        dead = rng.uniform() < dead_frac
        vi = 3 if dead else int(rng.integers(0, 3))
        s = at.t[tile]['subs'][vi]
        L = length * rng.uniform(0.7, 1.15)
        W = s['width'] * L / s['length'] * width_scale
        el = math.radians(rng.uniform(*elev)) - (0.6 if dead else 0)
        d0 = np.array([math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el)])
        ns = 5 if lod == 0 else 2
        P, Tn, _ = arc_path(centre + d0 * 0.03, d0, L, droop * (1.5 if dead else 1.0), ns, rng=rng, wob=0.02)
        side, up = leaf_frame(P, Tn)
        t = np.linspace(0, 1, ns + 1)
        hw = np.full(ns + 1, W / 2)

        def uvf(i, sx, k_=vi):
            return at.sub_uv(tile, k_, 0.5 + 0.5 * sx * 0.96, 0.02 + 0.96 * t[i])

        def colf(i, sx, ph=float(rng.uniform())):
            return (0.45 + 0.55 * t[i], min(1.0, g_att + (1 - g_att) * t[i]), min(1.0, 0.1 + 0.9 * t[i] * t[i] + 0.2 * abs(sx) * t[i]), ph)
        P[:, 2] = np.maximum(P[:, 2], centre[2] * 0 + 0.02)
        ribbon(mb, P, side, up, hw, uvf, colf, LEAF, droop=lambda i, f: math.radians(25) * f, cols=1)


def make_birdsnest(at, seed, lod):
    rng = np.random.default_rng(seed)
    mb = J.MB()
    make_rosette(mb, at, rng, np.array([0, 0, 0.05]), 22 if lod == 0 else 10, rng.uniform(0.75, 1.0), (20, 70), 1.2, 0.05,
                 float(rng.uniform()), lod, dead_frac=0.15)
    return mb


def make_rattan(at, seed, lod, height):
    rng = np.random.default_rng(seed)
    mb = J.MB()
    nst = int(rng.integers(4, 7))
    for si in range(nst):
        h = height * rng.uniform(0.45, 1.0) if si else height
        a = rng.uniform(0, 2 * math.pi)
        pos = np.array([math.cos(a), math.sin(a), 0]) * (0 if si == 0 else rng.uniform(0.15, 0.5))
        lean = J.norm(np.array([pos[0] * 0.5 + rng.normal(0, 0.1), pos[1] * 0.5 + rng.normal(0, 0.1), 1.0]))
        P = np.array([pos + np.array([0, 0, -0.1]) + lean * (h * f) + np.array([0.05 * math.sin(f * 4 + si), 0, 0]) * f
                      for f in np.linspace(0, 1, 7 if lod == 0 else 3)])
        g = 0.12 + 0.05 * h
        ph = float(rng.uniform())
        stem_tube(mb, P, np.linspace(0.035, 0.022, len(P)), 6 if lod == 0 else 4, 'palm', 0.0, g, ph, v_per_m=0.5)
        top = P[-1]
        nf = int(rng.integers(7, 11))
        a0 = rng.uniform(0, 2 * math.pi)
        for k in range(nf):
            az = a0 + k * 2.4
            young = k == nf - 1
            frond(mb, at, rng, top, az, math.radians(rng.uniform(20, 60) if not young else 78), rng.uniform(1.8, 2.6) * (0.7 if young else 1.0),
                  math.radians(rng.uniform(50, 105) if not young else 20), 'rattan', lod, g, float(rng.uniform()),
                  droop_a=math.radians(rng.uniform(-25, -10)), scale_w=1.35)
        if rng.uniform() < 0.7:
            az = rng.uniform(0, 2 * math.pi)
            frond(mb, at, rng, top - np.array([0, 0, 0.15]), az, math.radians(-70), rng.uniform(1.2, 1.6), 0.1, 'frond_dead', lod, g,
                  float(rng.uniform()), droop_a=math.radians(60), scale_w=0.5)
    return mb


def make_licuala(at, seed, lod, height):
    rng = np.random.default_rng(seed)
    mb = J.MB()
    t_ = at.t['licuala']
    nl = int(rng.integers(10, 15))
    a0 = rng.uniform(0, 2 * math.pi)
    base_h = height * rng.uniform(0.0, 0.15)
    if base_h > 0.05:
        stem_tube(mb, np.array([[0, 0, -0.1], [0, 0, base_h]]), [0.07, 0.06], 6, 'palm', 0.0, 0.05, float(rng.uniform()), v_per_m=0.8)
    for k in range(nl):
        az = a0 + k * 2.4 + rng.normal(0, 0.1)
        rel = k / max(nl - 1, 1)
        pl = height * rng.uniform(0.55, 0.8)
        elev = math.radians(rng.uniform(45, 75))
        d = np.array([math.cos(az) * math.cos(elev), math.sin(az) * math.cos(elev), math.sin(elev)])
        P, Tn, _ = arc_path(np.array([0, 0, base_h]), d, pl, math.radians(rng.uniform(10, 30)), 6 if lod == 0 else 3)
        ph = float(rng.uniform())
        stem_tube(mb, P, np.linspace(0.016, 0.009, len(P)), 4 if lod == 0 else 3, 'palm', 0.05, 0.4, ph, v_per_m=0.8)
        C = P[-1]
        R = rng.uniform(0.45, 0.65) * height / 2.2
        # fan normal: facing up and outward, tilted
        tilt = math.radians(rng.uniform(15, 55))
        hdir = np.array([math.cos(az), math.sin(az), 0])
        nrm = J.norm(np.array([0, 0, 1.0]) * math.cos(tilt) + hdir * math.sin(tilt))
        fwd = J.norm(hdir - nrm * np.dot(hdir, nrm))  # fan "up" in texture = outward
        side = np.cross(nrm, fwd)
        na = 22 if lod == 0 else 10
        rings = [0.0, 0.3, 0.65, 1.0] if lod == 0 else [0.0, 0.5, 1.0]
        span = math.radians(330)
        idx = []
        for ri, rr in enumerate(rings):
            row = []
            if ri == 0:
                b = mb.verts(C[None], np.array([[0.5, 0.4, 0.05, ph]]), np.array([nrm]))
                idx.append([b] * (na + 1))
                continue
            pts, cs, ns = [], [], []
            for ai in range(na + 1):
                th = -span / 2 + span * ai / na
                pleat = (0.035 if ai % 2 else -0.035) * rr * R
                droop = -0.18 * rr ** 2 * R
                p = C + (fwd * math.cos(th) + side * math.sin(th)) * rr * R + nrm * (pleat + droop)
                pts.append(p)
                cs.append((0.6 + 0.4 * rr, min(1.0, 0.4 + 0.6 * rr), min(1.0, 0.1 + 0.9 * rr), ph))
                ns.append(J.norm(nrm + (fwd * math.cos(th) + side * math.sin(th)) * 0.25 * rr))
            b = mb.verts(np.array(pts), np.array(cs), np.array(ns))
            idx.append(list(b + np.arange(na + 1)))

        def uv(ri, ai):
            th = -span / 2 + span * ai / na
            rr = rings[ri] * 0.985
            # texture: 0 = up (+v), angle measured from up toward +u
            return at.tile_uv('licuala', 0.5 + 0.5 * rr * math.sin(th), 0.5 + 0.5 * rr * math.cos(th))
        for ri in range(len(rings) - 1):
            for ai in range(na):
                if ri == 0:
                    mb.face((idx[0][ai], idx[1][ai], idx[1][ai + 1]), [uv(0, ai), uv(1, ai), uv(1, ai + 1)], LEAF)
                else:
                    mb.face((idx[ri][ai], idx[ri + 1][ai], idx[ri + 1][ai + 1], idx[ri][ai + 1]),
                            [uv(ri, ai), uv(ri + 1, ai), uv(ri + 1, ai + 1), uv(ri, ai + 1)], LEAF)
    return mb


def make_sapling(at, seed, lod, height, tiers):
    rng = np.random.default_rng(seed)
    mb = J.MB()
    ph0 = float(rng.uniform())
    pts = []
    for f in np.linspace(0, 1, 8 if lod == 0 else 4):
        pts.append(np.array([0.12 * math.sin(f * 2.2 + seed) * f, 0.08 * math.sin(f * 3.1 + seed) * f, -0.1 + (height + 0.1) * f]))
    P = np.array(pts)
    g = 0.15 + 0.06 * height
    stem_tube(mb, P, np.linspace(0.03, 0.012, len(P)) * (height / 3.0) ** 0.5, 6 if lod == 0 else 4, 'bark', 0.0, g, ph0, v_per_m=0.6)
    heads = [(P[-1], g)]
    if tiers == 0:  # leaves spread along the upper third of the stem (alternate), not only a terminal rosette
        for f in np.linspace(0.62, 0.92, 4):
            i = int(f * (len(P) - 1))
            heads.append((P[i] + (P[i + 1] - P[i]) * (f * (len(P) - 1) - i), g * f))
    for k in range(tiers):
        f = rng.uniform(0.5, 0.85)
        i = int(f * (len(P) - 1))
        az = rng.uniform(0, 2 * math.pi)
        L = height * rng.uniform(0.18, 0.3)
        end = P[i] + np.array([math.cos(az) * L, math.sin(az) * L, L * 0.6])
        stem_tube(mb, np.array([P[i], (P[i] + end) / 2 + np.array([0, 0, 0.05]), end]), [0.014, 0.01, 0.007], 4, 'bark',
                  g * f, g * f + 0.15, float(rng.uniform()), v_per_m=0.8)
        heads.append((end, g * f + 0.15))
    for (C, gc) in heads:
        nl = int(rng.integers(9, 13)) if C is heads[0][0] else (int(rng.integers(2, 4)) if tiers == 0 else int(rng.integers(6, 10)))
        a0 = rng.uniform(0, 2 * math.pi)
        for k in range(nl):
            az = a0 + k * 2.4
            elev = math.radians(rng.uniform(-5, 55))
            d = np.array([math.cos(az) * math.cos(elev), math.sin(az) * math.cos(elev), math.sin(elev)])
            pe = C + d * rng.uniform(0.04, 0.12)
            stem_tube(mb, np.array([C, pe]), [0.006, 0.004], 3, 'bark', gc, gc + 0.05, ph0, v_per_m=1.0)
            vi = int(rng.integers(0, 4))
            s = at.t['sapling_leaves']['subs'][vi]
            L = rng.uniform(0.38, 0.58)
            W = s['width'] * L / s['length']
            n = 5 if lod == 0 else 2
            P2, Tn, _ = arc_path(pe, d, L, math.radians(rng.uniform(25, 70)), n)
            side, up = leaf_frame(P2, Tn, roll=rng.normal(0, 0.15))
            t = np.linspace(0, 1, n + 1)
            hw = np.full(n + 1, W / 2)
            lph = float(rng.uniform())
            ribbon(mb, P2, side, up, hw,
                   lambda i, sx, k_=vi, t=t: at.sub_uv('sapling_leaves', k_, 0.5 + 0.5 * sx * 0.98, 0.01 + 0.98 * t[i]),
                   lambda i, sx, t=t, ph=lph, gc=gc: (0.6 + 0.4 * t[i], min(1.0, gc + 0.1 + (0.9 - gc) * t[i]), min(1.0, 0.1 + 0.6 * t[i] + 0.4 * abs(sx) * t[i]), ph),
                   LEAF, droop=lambda i, f: math.radians(12) * f, cols=1)
    return mb


# ------------------------------------------------------------------------------------------------ scans
def import_scan(path, keep):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    out = {}
    for o in new:
        if o.type == 'MESH' and o.name in keep:
            out[o.name] = o
    for o in new:
        if o.name not in out:
            bpy.data.objects.remove(o, do_unlink=True)
    return out


def scan_to_mb(ob, quad, seed, target_h=None, decimate=None):
    """Bake a scan object (transforms applied) into an MB: UVs remapped into the scan-atlas quadrant, COLOR_0 computed
    (AO and bend from height, flutter from distance to the plant axis, phase per connected piece)."""
    import bmesh
    rng = np.random.default_rng(seed)
    me = ob.data.copy()
    me.transform(ob.matrix_world)
    bm = bmesh.new()
    bm.from_mesh(me)
    if decimate:
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.verts.ensure_lookup_table()
    V = np.array([v.co[:] for v in bm.verts])
    zmin = V[:, 2].min()
    V[:, 2] -= zmin
    cx, cy = (V[:, 0].min() + V[:, 0].max()) / 2, (V[:, 1].min() + V[:, 1].max()) / 2
    V[:, 0] -= cx
    V[:, 1] -= cy
    if target_h:
        V *= target_h / max(V[:, 2].max(), 1e-3)
    H = max(V[:, 2].max(), 1e-3)
    R = max(np.hypot(V[:, 0], V[:, 1]).max(), 1e-3)
    # connected pieces -> phase
    parent = list(range(len(V)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for e in bm.edges:
        a, b = find(e.verts[0].index), find(e.verts[1].index)
        if a != b:
            parent[a] = b
    roots = {}
    ph = np.zeros(len(V))
    for i in range(len(V)):
        r = find(i)
        if r not in roots:
            roots[r] = rng.uniform()
        ph[i] = roots[r]
    rr = np.hypot(V[:, 0], V[:, 1]) / R
    zz = V[:, 2] / H
    C = np.stack([0.45 + 0.55 * np.clip(zz * 0.7 + rr * 0.5, 0, 1), np.clip(0.1 + 0.5 * zz + 0.5 * rr, 0, 1),
                  np.clip(rr ** 1.3 * 0.9 + zz * 0.2, 0, 1), ph], -1)
    mb = J.MB()
    mb.verts(V, C)
    uvl = bm.loops.layers.uv.active
    q = quad
    for f in bm.faces:
        idx = [l.vert.index for l in f.loops]
        uvs = []
        for l in f.loops:
            u, v = l[uvl].uv
            uvs.append((q[0] + u * (q[2] - q[0]), q[1] + v * (q[3] - q[1])))
        mb.face(idx, uvs, SCAN)
    bm.free()
    bpy.data.meshes.remove(me)
    return mb, H


def decimate_object(ob, ratio):
    m = ob.modifiers.new('dec', 'DECIMATE')
    m.ratio = ratio
    m.use_collapse_triangulate = True
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.modifier_apply(modifier='dec')


# ------------------------------------------------------------------------------------------------ main
def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    only = argv[argv.index('--only') + 1].split(',') if '--only' in argv else None
    J.reset_scene()
    at = Atlas()
    stem = J.pbr_material('understory_stem', f'{TEX}/understory_stem_albedo.png', f'{TEX}/understory_stem_normal.png',
                          f'{TEX}/understory_stem_orm.png', alpha=False, double_sided=False)
    leaf = J.pbr_material('understory_leaf', f'{TEX}/understory_leaf_albedo.png', f'{TEX}/understory_leaf_normal.png',
                          f'{TEX}/understory_leaf_orm.png', alpha=True, double_sided=True)
    scan = J.pbr_material('understory_scan', f'{TEX}/understory_scan_albedo.png', f'{TEX}/understory_scan_normal.png',
                          f'{TEX}/understory_scan_orm.png', alpha=True, double_sided=True)
    mats = [stem, leaf, scan]
    plants = [
        ('banana_a', lambda lod: make_banana(at, 11, lod, 4.2)),
        ('banana_b', lambda lod: make_banana(at, 12, lod, 3.2)),
        ('alocasia_a', lambda lod: make_alocasia(at, 21, lod, 2.4)),
        ('colocasia_a', lambda lod: make_colocasia(at, 22, lod, 1.8)),
        ('treefern_a', lambda lod: make_treefern(at, 31, lod, 4.8)),
        ('treefern_b', lambda lod: make_treefern(at, 32, lod, 3.0)),
        ('birdsnest_a', lambda lod: make_birdsnest(at, 41, lod)),
        ('rattan_a', lambda lod: make_rattan(at, 51, lod, 3.4)),
        ('licuala_a', lambda lod: make_licuala(at, 52, lod, 2.3)),
        ('sapling_a', lambda lod: make_sapling(at, 61, lod, 3.2, 0)),
        ('sapling_b', lambda lod: make_sapling(at, 62, lod, 2.6, 3)),
    ]
    objs, info = [], {}
    for name, fn in plants:
        if only and not any(name.startswith(o) for o in only):
            continue
        for lod in (0, 1):
            mb = fn(lod)
            ob = mb.build(f'{name}_lod{lod}', mats)
            objs.append(ob)
            V = np.concatenate(mb.V)
            info.setdefault(name, {})[f'lod{lod}'] = dict(tris=mb.tris(), bbox=[V.min(0).round(2).tolist(), V.max(0).round(2).tolist()])
            print(f'{name}_lod{lod}: {mb.tris()} tris, bbox {V.min(0).round(2)} {V.max(0).round(2)}')
    # Poly Haven scans: ground ferns (fern_02), calathea, anthurium
    scans = [
        ('fern', f'{RAWM}/fern_02/fern_02_2k.gltf', [('fern_02_a', 'a', 0.75), ('fern_02_c', 'b', 0.55)], 'fern_02'),
        ('calathea', f'{RAWM}/calathea_orbifolia_01/calathea_orbifolia_01_2k.gltf',
         [('calathea_orbifolia_01_a', 'a', 0.75), ('calathea_orbifolia_01_b', 'b', 0.6), ('calathea_orbifolia_01_d', 'c', 0.45)], 'calathea'),
        ('anthurium', f'{RAWM}/anthurium_botany_01/anthurium_botany_01_2k.gltf',
         [('anthurium_botany_01_a', 'a', 0.85), ('anthurium_botany_01_b', 'b', 0.75), ('anthurium_botany_01_c', 'c', 0.6)], 'anthurium'),
    ]
    for sp, path, picks, qname in scans:
        if only and sp not in only:
            continue
        got = import_scan(path, [p[0] for p in picks])
        for k, (src, var, th) in enumerate(picks):
            if src not in got:
                print('missing scan object', src, list(got))
                continue
            ob = got[src]
            mb0, H = scan_to_mb(ob, at.q[qname]['rect'], 300 + k, target_h=th)
            o0 = mb0.build(f'{sp}_{var}_lod0', mats)
            t0 = mb0.tris()
            if t0 > 4600:
                decimate_object(o0, 4500 / t0)
                t0 = sum(len(p.vertices) - 2 for p in o0.data.polygons)
            o1 = mb0.build(f'{sp}_{var}_lod1', mats)
            if mb0.tris() > 1100:
                decimate_object(o1, 1050 / mb0.tris())
            objs += [o0, o1]
            t1 = sum(len(p.vertices) - 2 for p in o1.data.polygons)
            V = np.concatenate(mb0.V)
            info[f'{sp}_{var}'] = dict(lod0=dict(tris=t0, bbox=[V.min(0).round(2).tolist(), V.max(0).round(2).tolist()]), lod1=dict(tris=t1))
            print(f'{sp}_{var}: lod0 {t0} tris, lod1 {t1} tris, height {H:.2f}, bbox {V.min(0).round(2)} {V.max(0).round(2)}')
            bpy.data.objects.remove(ob, do_unlink=True)
    path = f'{OUT}/understory_raw.glb'
    J.export_glb(path, objs)
    with open(f'{OUT}/understory_info.json', 'w') as f:
        json.dump(info, f, indent=1)
    print('exported', path)


if __name__ == '__main__':
    main()
