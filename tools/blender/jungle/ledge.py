"""Ledge and wall plants for the waterfall gorge and cliffs -> E:/tmp/island/helpers/jungle/glb/ledge_raw.glb

    bash c:/Code/island/tools/heavy.sh jungle E:/blender/blender-5.1.2-windows-x64/blender.exe --background \
        --factory-startup -t 6 --python tools/blender/jungle/ledge.py -- [--skip-atlas]

Hanging plants (hangfern_*, vinecurtain_*, wallclump_a): origin = attachment point at the top (ledge lip / wall top),
they hang down along glTF -Y and stick out toward glTF +Z (the open side; Blender -Y here). Moss cushions (moss_*):
origin = base centre, resting on a ledge top, glTF +Y up. One material `ledge_leaf` (alpha MASK, double-sided) + the
understory stem strips for roots (`ledge_stem`). COLOR_0 = (AO, bend, flutter, phase); hanging strands bend from
0 at the attachment to 1 at their free ends.
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
import jtex as T  # noqa: E402
import sprig_atlas as SA  # noqa: E402
import understory_atlas as UA  # noqa: E402
import understory as U  # noqa: E402

TEX = 'E:/tmp/island/helpers/jungle/tex'
OUT = 'E:/tmp/island/helpers/jungle/glb'
WORK = 'E:/tmp/island/helpers/jungle/work/ledge'
N = 2048
OUTW = np.array([0.0, -1.0, 0.0])  # Blender -Y = glTF +Z (the open side)

TILES = [
    ('fern_hang_a', (0, 0, 256, 1024), 'nephro', 'pin', {'mid': 0.5, 'young': 0.3, 'dark': 0.2}, 'bottom', 31),
    ('fern_hang_b', (256, 0, 256, 1024), 'nephro', 'pin', {'mid': 0.35, 'olive': 0.25, 'yellowing': 0.2, 'young': 0.2}, 'bottom', 32),
    ('vine_a', (512, 0, 256, 1024), 'vinestrand', 'cor', {'dark': 0.35, 'mid': 0.4, 'young': 0.25}, 'bottom', 33),
    ('vine_b', (768, 0, 256, 1024), 'vinestrand', 'cor', {'mid': 0.45, 'blue': 0.2, 'young': 0.25, 'yellowing': 0.1}, 'bottom', 34),
    ('moss', (1024, 0, 1024, 1024), 'moss', None, None, 'center', 35),
    ('wall_mat', (0, 1024, 1024, 1024), 'wallmat', 'cor', {'dark': 0.35, 'mid': 0.4, 'young': 0.25}, 'center', 36),
    ('fern_small_a', (1024, 1024, 512, 512), 'fernfan', 'pin', {'mid': 0.5, 'young': 0.35, 'dark': 0.15}, 'bottom', 37),
    ('fern_small_b', (1536, 1024, 512, 512), 'fernfan', 'pin', {'young': 0.5, 'apple': 0.0, 'mid': 0.3, 'yellowing': 0.2}, 'bottom', 38),
]


def nephro_frond(mb, rng, sh, moods, L):
    """Once-pinnate sword-fern frond (Nephrolepis), drooping when hung."""
    path = SA.bend_path((0, 0, 0), (0, 1, 0), L, rng.uniform(-0.2, 0.2), n=14)
    SA.add_twig(mb, path, 0.005, 0.0015)
    s = J.arclen(path)
    pos = s[-1] * 0.05
    while pos < s[-1] * 0.99:
        rel = pos / s[-1]
        i = int(np.clip(np.searchsorted(s, pos) - 1, 0, len(path) - 2))
        P = path[i]
        tg = J.norm(path[i + 1] - path[i])
        prof = math.sin(math.pi * min(1.0, (rel + 0.05) / 1.02)) ** 0.5
        for side in (-1, 1):
            fwd = J.norm(J.rot((0, 0, 1), side * math.radians(rng.uniform(65, 85))) @ tg + np.array([0, 0, 0.05]))
            up = J.rot(fwd, rng.normal(0, 0.25)) @ np.array([0, 0, 1.0])
            SA.add_leaf(mb, sh, sh.pick(rng, moods), P, fwd, up, 1.7 * prof * rng.uniform(0.9, 1.1), fold=0.2,
                        arch=rng.uniform(0.0, 0.12), twist=rng.normal(0, 0.15), na=4, nc=2)
        pos += sh.width * 1.7 * 1.25 * rng.uniform(0.9, 1.1)


def vine_strand(mb, rng, sh, moods, L):
    pts = [np.array([0.0, 0.0, 0.0])]
    for k in range(16):
        pts.append(pts[-1] + np.array([rng.uniform(-0.03, 0.03), L / 16, 0.0]))
    path = J.catmull(np.array(pts), 3)
    SA.add_twig(mb, path, 0.004, 0.0025)
    s = J.arclen(path)
    pos = 0.02
    side = 1
    while pos < s[-1] * 0.99:
        i = int(np.clip(np.searchsorted(s, pos) - 1, 0, len(path) - 2))
        tg = J.norm(path[i + 1] - path[i])
        fwd = J.norm(J.rot((0, 0, 1), side * math.radians(rng.uniform(30, 75))) @ tg + np.array([0, 0, 0.1]))
        up = J.rot(fwd, rng.normal(0, 0.3)) @ np.array([0, 0, 1.0])
        P1 = path[i] + fwd * 0.012
        SA.add_twig(mb, [path[i], P1], 0.0015, 0.001, sides=3)
        SA.add_leaf(mb, sh, sh.pick(rng, moods), P1, fwd, up, rng.uniform(0.32, 0.5), fold=0.2, arch=0.08, na=4, nc=2)
        side = -side
        pos += rng.uniform(0.035, 0.07)


def fern_fan(mb, rng, sh, moods):
    for k in range(int(rng.integers(6, 9))):
        a = math.radians(rng.uniform(-70, 70))
        L = rng.uniform(0.3, 0.5)
        sub = J.MB()
        nephro_frond(sub, rng, sh, moods, L)
        # rotate the frond about z by a, attach at the origin
        R = J.rot((0, 0, 1), a)
        sub.V = [(R @ v.T).T for v in sub.V]
        mb.merge(sub)


def wall_mat(mb, rng, sh, moods, pin):
    SA.fig_mat(mb, rng, sh, moods, 1.3, dict(stems=34, scale=(0.3, 0.6)))


def moss_tile(seed, n=1024):
    import build_bark as BB
    col, hgt, rough = BB.moss(n, n, seed)
    # a few small fruiting stalks / lighter tips and darker damp gaps
    col = col * (0.92 + 0.12 * np.clip(hgt, 0, 1)[..., None])
    nrm = T.normal_from_height(T.blur(hgt, 0.7) * 0.08, 9.0)
    alpha = np.ones((n, n), np.float32)
    aux = np.stack([0.55 + 0.45 * hgt, rough, np.zeros_like(hgt)], -1)
    return col, alpha, nrm, aux


def build_atlas():
    os.makedirs(WORK, exist_ok=True)
    A = np.zeros((N, N, 3), np.float32)
    AL = np.zeros((N, N), np.float32)
    NM = np.tile(np.array([0.5, 0.5, 1.0], np.float32), (N, N, 1))
    X = np.ones((N, N, 3), np.float32)
    meta = {'tiles': {}}
    sc, cam = SA.setup_scene()
    pin = SA.Sheet('pin')
    for name, (x, y, w, h), kind, sheet, moods, pivot, seed in TILES:
        rng = np.random.default_rng(seed)
        info = dict(kind=kind)
        if kind == 'moss':
            alb, alpha, nrm, aux = moss_tile(seed, w)
            info.update(size_wh=[1.0, 1.0], pivot=[0.5, 0.5])
        else:
            sh = SA.Sheet(sheet)
            mb = J.MB()
            if kind == 'nephro':
                nephro_frond(mb, rng, sh, moods, 1.45)
            elif kind == 'vinestrand':
                vine_strand(mb, rng, sh, moods, 1.6)
            elif kind == 'fernfan':
                fern_fan(mb, rng, sh, moods)
            elif kind == 'wallmat':
                wall_mat(mb, rng, sh, moods, pin)
            passes, (Sw, Sh), piv = UA.render_rect(sc, cam, name, mb, sh, pivot, w, h)
            alb, alpha, nrm, aux = SA.finish_tile(passes)
            info.update(size_wh=[Sw, Sh], pivot=list(piv), faces=len(mb.F))
            print(f'tile {name}: {len(mb.F)} faces, {Sw:.2f} x {Sh:.2f} m')
        info['content'] = SA.content_box(alpha)
        info['coverage'] = float((alpha > 0.5).mean())
        info['rect'] = [x / N, 1 - (y + h) / N, (x + w) / N, 1 - y / N]
        A[y:y + h, x:x + w] = alb
        AL[y:y + h, x:x + w] = alpha
        NM[y:y + h, x:x + w] = nrm
        X[y:y + h, x:x + w] = aux
        meta['tiles'][name] = info
    ao = 0.45 + 0.55 * np.clip(X[..., 0], 0, 1)
    orm = np.stack([ao, np.clip(X[..., 1], 0.15, 1), np.zeros_like(ao)], -1)
    T.write_png(f'{TEX}/ledge_leaf_albedo.png', np.concatenate([T.lin_to_srgb(A), AL[..., None]], -1))
    T.write_png(f'{TEX}/ledge_leaf_normal.png', NM)
    T.write_png(f'{TEX}/ledge_leaf_orm.png', orm)
    with open(f'{TEX}/ledge_leaf.json', 'w') as f:
        json.dump(meta, f, indent=1)
    print('ledge_leaf written')


# ------------------------------------------------------------------------------------------------ plants
class LAt:
    def __init__(self):
        with open(f'{TEX}/ledge_leaf.json') as f:
            self.t = json.load(f)['tiles']

    def tile_uv(self, name, cu, cv):
        r = self.t[name]['rect']
        return (r[0] + cu * (r[2] - r[0]), r[1] + cv * (r[3] - r[1]))


def strip(mb, at, tile, P, Tn, width, g0, ph, lod, ao0=0.5, roll=0.0, normal_out=True):
    """Ribbon along P (hanging strand / frond) using a strip tile, constant width, cropped to content."""
    t_ = at.t[tile]
    cu0, cv0, cu1, cv1 = t_['content']
    piv = t_['pivot']
    side, up = U.leaf_frame(P, Tn, roll=roll)
    if normal_out:  # hanging strands: face the open side
        for i in range(len(P)):
            s_ = J.norm(np.cross(Tn[i], OUTW))
            if np.linalg.norm(np.cross(Tn[i], OUTW)) < 1e-4:
                s_ = np.array([1.0, 0, 0])
            side[i] = s_
            up[i] = J.norm(np.cross(s_, Tn[i]))
            if np.dot(up[i], OUTW) < 0:
                up[i] = -up[i]
                side[i] = -side[i]
    n = len(P) - 1
    t = np.linspace(0, 1, n + 1)
    hw = np.full(n + 1, width / 2)
    half = max(abs(cu0 - 0.5), abs(cu1 - 0.5))

    def uvf(i, sx):
        return at.tile_uv(tile, 0.5 + sx * half, piv[1] + t[i] * (cv1 - piv[1]))

    def colf(i, sx):
        return (ao0 + (1 - ao0) * t[i], min(1.0, g0 + (1 - g0) * t[i]), min(1.0, 0.15 + 0.6 * t[i] + 0.3 * abs(sx)), ph)
    U.ribbon(mb, P, side, up, hw, uvf, colf, 0, droop=lambda i, f: math.radians(12) * f, cols=1 if lod else 1, nrm_bend=0.25)


def hang_path(start, d0, L, n, rng, gravity=1.0, sway=0.1):
    """A strand / frond leaving `start` in direction d0 and curving down under gravity."""
    P = [np.asarray(start, np.float64)]
    d = J.norm(d0)
    T_ = []
    for i in range(n):
        t = (i + 0.5) / n
        d = J.norm(d + np.array([0, 0, -gravity * 2.2 / n]) + rng.normal(0, sway / n, 3))
        P.append(P[-1] + d * L / n)
        T_.append(d)
    T_.append(T_[-1])
    return np.array(P), np.array(T_)


def make_hangfern(at, seed, lod, size):
    rng = np.random.default_rng(seed)
    mb = J.MB()
    nf = int(rng.integers(20, 27)) if lod == 0 else 10
    for k in range(nf):
        a = rng.uniform(-1.4, 1.4)  # spread along the ledge (around the outward direction)
        d0 = J.norm(np.array([math.sin(a), -math.cos(a), rng.uniform(-0.2, 0.7)]))
        L = size * rng.uniform(0.7, 1.15)
        n = 10 if lod == 0 else 4
        P, Tn = hang_path(np.array([rng.uniform(-0.15, 0.15), -0.05, 0.02]), d0, L, n, rng, gravity=rng.uniform(1.1, 1.9))
        tile = 'fern_hang_a' if rng.uniform() < 0.6 else 'fern_hang_b'
        strip(mb, at, tile, P, Tn, 0.32 * L / 1.45, 0.0, float(rng.uniform()), lod, roll=rng.normal(0, 0.3), normal_out=False)
    # soil / moss lump at the attachment
    moss_dome(mb, at, rng, np.array([0, -0.05, -0.06]), 0.32, 0.14, lod, g=0.0)
    return mb


def make_vinecurtain(at, seed, lod, width, length):
    rng = np.random.default_rng(seed)
    mb = J.MB()
    ns = int(width * 9) if lod == 0 else int(width * 4)
    for k in range(ns):
        x = rng.uniform(-width / 2, width / 2)
        L = length * rng.uniform(0.45, 1.0)
        n = max(4, int(L / (0.4 if lod == 0 else 1.0)))
        P, Tn = hang_path(np.array([x, -rng.uniform(0.02, 0.12), 0.0]), np.array([0, -0.15, -1.0]), L, n, rng, gravity=0.3, sway=0.2)
        tile = 'vine_a' if rng.uniform() < 0.5 else 'vine_b'
        ph = float(rng.uniform())
        strip(mb, at, tile, P, Tn, rng.uniform(0.26, 0.36), 0.0, ph, lod, ao0=0.55)
        if lod == 0 and rng.uniform() < 0.5:  # crossed second card for volume from the side
            strip(mb, at, tile, P + np.array([0.02, 0, 0]), Tn, rng.uniform(0.18, 0.26), 0.0, ph, lod, ao0=0.55, roll=1.4, normal_out=False)
    # aerial roots: thin bare strands
    for k in range(int(width * 6) if lod == 0 else int(width * 2)):
        x = rng.uniform(-width / 2, width / 2)
        L = length * rng.uniform(0.3, 1.05)
        n = max(3, int(L / 0.8))
        P, Tn = hang_path(np.array([x, -rng.uniform(0.0, 0.1), 0.0]), np.array([0, -0.05, -1.0]), L, n, rng, gravity=0.2, sway=0.12)
        ph = float(rng.uniform())
        n0 = len(mb.M)
        U.stem_tube(mb, P, np.linspace(rng.uniform(0.006, 0.014), 0.003, len(P)), 3, 'fern', 0.0, 1.0, ph, ao0=0.5, ao1=0.85, v_per_m=0.6)
        mb.M[n0:] = [1] * (len(mb.M) - n0)  # slot 1 = ledge_stem
    return mb


def moss_dome(mb, at, rng, centre, R, H, lod, g=0.0, ph=None):
    """Lumpy moss cushion: a radial grid dome with noise, moss tile planar-mapped (1 m per tile)."""
    nr, na = (5, 14) if lod == 0 else (2, 7)
    ph = float(rng.uniform()) if ph is None else ph
    lob = [(rng.uniform(0.05, 0.15), rng.integers(2, 5), rng.uniform(0, 6.28)) for _ in range(3)]
    rings = []
    top = mb.verts(np.array([centre + np.array([0, 0, H])]), np.array([[0.95, g, 0.0, ph]]), np.array([[0, 0, 1.0]]))
    for ri in range(1, nr + 1):
        f = ri / nr
        pts, cs, ns = [], [], []
        for ai in range(na):
            a = 2 * math.pi * ai / na
            rr = R * f * (1 + sum(l * math.cos(k * a + p) for l, k, p in lob)) * (1 + 0.06 * rng.normal())
            z = H * (1 - f ** 2.2) * (1 + 0.1 * rng.normal()) - 0.02 * f
            p = centre + np.array([math.cos(a) * rr, math.sin(a) * rr, z])
            pts.append(p)
            cs.append((0.95 - 0.4 * f ** 2, g, 0.05, ph))
            ns.append(J.norm(np.array([math.cos(a) * f, math.sin(a) * f, 1.2 - f])))
        b = mb.verts(np.array(pts), np.array(cs), np.array(ns))
        rings.append(b + np.arange(na))
    r_ = at.t['moss']['rect']

    def uv(p):
        q = (p - centre) / 1.0
        return (r_[0] + (r_[2] - r_[0]) * np.clip(0.5 + q[0] * 0.8, 0.01, 0.99),
                r_[1] + (r_[3] - r_[1]) * np.clip(0.5 + q[1] * 0.8, 0.01, 0.99))
    V = np.concatenate(mb.V)
    for ai in range(na):
        a2 = (ai + 1) % na
        mb.face((top, rings[0][ai], rings[0][a2]), [uv(V[top]), uv(V[rings[0][ai]]), uv(V[rings[0][a2]])], 0)
    for ri in range(nr - 1):
        for ai in range(na):
            a2 = (ai + 1) % na
            i0, i1, i2, i3 = rings[ri][ai], rings[ri + 1][ai], rings[ri + 1][a2], rings[ri][a2]
            mb.face((i0, i1, i2, i3), [uv(V[i0]), uv(V[i1]), uv(V[i2]), uv(V[i3])], 0)


def make_moss(at, seed, lod, R):
    rng = np.random.default_rng(seed)
    mb = J.MB()
    moss_dome(mb, at, rng, np.array([0, 0, -0.03]), R, R * rng.uniform(0.22, 0.32), lod)
    for k in range(int(rng.integers(2, 4))):  # a few satellite cushions
        a = rng.uniform(0, 6.28)
        c = np.array([math.cos(a) * R * 0.9, math.sin(a) * R * 0.9, -0.03])
        moss_dome(mb, at, rng, c, R * rng.uniform(0.3, 0.5), R * 0.12, lod)
    for k in range(int(rng.integers(3, 6)) if lod == 0 else 2):  # small ferns rising out of the moss
        a = rng.uniform(0, 6.28)
        r = R * rng.uniform(0.1, 0.6)
        base = np.array([math.cos(a) * r, math.sin(a) * r, R * 0.2])
        tile = 'fern_small_a' if rng.uniform() < 0.6 else 'fern_small_b'
        for j in range(2):  # two crossed fan cards
            az = rng.uniform(0, 6.28) + j * math.pi / 2
            card_fan(mb, at, tile, base, az, rng.uniform(0.35, 0.55), float(rng.uniform()))
    return mb


def card_fan(mb, at, tile, base, az, size, ph):
    t_ = at.t[tile]
    cu0, cv0, cu1, cv1 = t_['content']
    Sw, Sh = t_['size_wh']
    piv = t_['pivot']
    k = size / max((cv1 - piv[1]) * Sh, 1e-3)
    side = np.array([math.cos(az), math.sin(az), 0.0])
    up = np.array([0, 0, 1.0])
    outv = np.cross(up, side)
    idx = []
    for j, cv in enumerate((cv0, (cv0 + cv1) / 2, cv1)):
        y = (cv - piv[1]) * Sh * k
        row = []
        for cu in (cu0, cu1):
            x = (cu - piv[0]) * Sw * k
            p = base + side * x + up * y * 0.85 + outv * (0.25 * y * y / max(size, 1e-3))
            b = mb.verts(p[None], np.array([[0.7 + 0.3 * j / 2, 0.1 + 0.5 * j / 2, 0.2 + 0.6 * j / 2, ph]]), np.array([J.norm(outv + up * 0.6)]))
            row.append(b)
        idx.append(row)
    cvs = (cv0, (cv0 + cv1) / 2, cv1)
    for j in range(2):
        mb.face((idx[j][0], idx[j][1], idx[j + 1][1], idx[j + 1][0]),
                [at.tile_uv(tile, cu0, cvs[j]), at.tile_uv(tile, cu1, cvs[j]), at.tile_uv(tile, cu1, cvs[j + 1]), at.tile_uv(tile, cu0, cvs[j + 1])], 0)


def make_wallclump(at, seed, lod):
    """Dripping wall: moss + leaf mat hugging a vertical wall below the attachment, ferns sticking out and drooping."""
    rng = np.random.default_rng(seed)
    mb = J.MB()
    t_ = at.t['wall_mat']
    Sw, Sh = t_['size_wh']
    cu0, cv0, cu1, cv1 = t_['content']
    # mat panels on the wall plane (x = along the wall, z = down), bulging slightly toward -Y (open side)
    for p in range(3 if lod == 0 else 2):
        w, h = rng.uniform(1.0, 1.4), rng.uniform(1.2, 1.8)
        ox, oz = rng.uniform(-0.4, 0.4), -rng.uniform(0.0, 0.6)
        nx, nz = (4, 4) if lod == 0 else (2, 2)
        idx = np.zeros((nz + 1, nx + 1), int)
        ph = float(rng.uniform())
        for j in range(nz + 1):
            for i in range(nx + 1):
                fx, fz = i / nx, j / nz
                x = ox + (fx - 0.5) * w
                z = oz - fz * h
                bulge = 0.06 * math.sin(math.pi * fx) * math.sin(math.pi * fz) + 0.03
                pnt = np.array([x, -bulge - 0.01 * p, z])
                b = mb.verts(pnt[None], np.array([[0.75, 0.1 * fz, 0.15, ph]]), np.array([[0, -1.0, 0.1]]))
                idx[j, i] = b
        for j in range(nz):
            for i in range(nx):
                def uv(ii, jj):
                    return at.tile_uv('wall_mat', cu0 + (cu1 - cu0) * ii / nx, cv1 - (cv1 - cv0) * jj / nz)
                mb.face((idx[j, i], idx[j + 1, i], idx[j + 1, i + 1], idx[j, i + 1]), [uv(i, j), uv(i, j + 1), uv(i + 1, j + 1), uv(i + 1, j)], 0)
    # moss lumps on the wall (rotated domes facing the open side)
    for k in range(4 if lod == 0 else 2):
        sub = J.MB()
        moss_dome(sub, at, rng, np.zeros(3), rng.uniform(0.18, 0.35), rng.uniform(0.06, 0.12), lod)
        R = J.rot((1, 0, 0), math.radians(90))  # dome +Z -> -Y
        off = np.array([rng.uniform(-0.6, 0.6), -0.02, -rng.uniform(0.1, 1.6)])
        sub.V = [(R @ v.T).T + off for v in sub.V]
        sub.N = [(R @ v.T).T for v in sub.N]
        mb.merge(sub)
    # ferns sticking out and drooping
    for k in range(int(rng.integers(6, 10)) if lod == 0 else 3):
        base = np.array([rng.uniform(-0.6, 0.6), -0.05, -rng.uniform(0.0, 1.5)])
        a = rng.uniform(-0.8, 0.8)
        d0 = J.norm(np.array([math.sin(a), -math.cos(a), rng.uniform(0.0, 0.6)]))
        L = rng.uniform(0.5, 0.9)
        P, Tn = hang_path(base, d0, L, 6 if lod == 0 else 3, rng, gravity=0.8)
        strip(mb, at, 'fern_hang_a' if rng.uniform() < 0.6 else 'fern_hang_b', P, Tn, 0.32 * L / 1.45, 0.05, float(rng.uniform()), lod,
              normal_out=False)
    return mb


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if '--skip-atlas' not in argv:
        build_atlas()
    J.reset_scene()
    at = LAt()
    leaf = J.pbr_material('ledge_leaf', f'{TEX}/ledge_leaf_albedo.png', f'{TEX}/ledge_leaf_normal.png', f'{TEX}/ledge_leaf_orm.png',
                          alpha=True, double_sided=True)
    stem = J.pbr_material('ledge_stem', f'{TEX}/understory_stem_albedo.png', f'{TEX}/understory_stem_normal.png',
                          f'{TEX}/understory_stem_orm.png', alpha=False, double_sided=False)
    plants = [
        ('hangfern_a', lambda lod: make_hangfern(at, 1, lod, 1.4)),
        ('hangfern_b', lambda lod: make_hangfern(at, 2, lod, 1.0)),
        ('vinecurtain_a', lambda lod: make_vinecurtain(at, 3, lod, 1.8, 3.5)),
        ('vinecurtain_b', lambda lod: make_vinecurtain(at, 4, lod, 2.6, 7.5)),
        ('moss_a', lambda lod: make_moss(at, 5, lod, 0.55)),
        ('moss_b', lambda lod: make_moss(at, 6, lod, 0.35)),
        ('wallclump_a', lambda lod: make_wallclump(at, 7, lod)),
    ]
    objs, info = [], {}
    for name, fn in plants:
        for lod in (0, 1):
            mb = fn(lod)
            ob = mb.build(f'{name}_lod{lod}', [leaf, stem])
            objs.append(ob)
            V = np.concatenate(mb.V)
            info[f'{name}_lod{lod}'] = dict(tris=mb.tris(), bbox=[V.min(0).round(2).tolist(), V.max(0).round(2).tolist()])
            print(f'{name}_lod{lod}: {mb.tris()} tris, bbox {V.min(0).round(2)} {V.max(0).round(2)}')
    J.export_glb(f'{OUT}/ledge_raw.glb', objs)
    with open(f'{OUT}/ledge_info.json', 'w') as f:
        json.dump(info, f, indent=1)
    print('exported ledge')


if __name__ == '__main__':
    main()
