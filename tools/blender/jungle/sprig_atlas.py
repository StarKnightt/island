"""Renders leaf-cluster cards (sprays, rosettes, pinnate sprays, clumps, vine strips) from 3-D twig + leaf models
into the canopy leaf atlas, with unlit albedo, tangent-space normals and AO/roughness. Run headless under the lock:

    bash c:/Code/island/tools/heavy.sh jungle E:/blender/blender-5.1.2-windows-x64/blender.exe --background \
        --factory-startup -t 6 --python tools/blender/jungle/sprig_atlas.py -- [--atlas canopy] [--only name,...]

Inputs: leaf sheets from leaf_textures.py. Outputs (E:/tmp/island/helpers/jungle/tex): <atlas>_leaf_albedo.png
(sRGB + alpha mask), <atlas>_leaf_normal.png, <atlas>_leaf_orm.png (R AO, G roughness, B 0), <atlas>_leaf.json
(tile rects in Blender UV space, content boxes, pivots, physical tile sizes).
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
from leaf_textures import outline  # noqa: E402

LEAVES = 'E:/tmp/island/helpers/jungle/tex/leaves'
OUT = 'E:/tmp/island/helpers/jungle/tex'
WORK = 'E:/tmp/island/helpers/jungle/work/sprig'
TILE = 512
SS = 2  # supersampling factor of the renders


# ------------------------------------------------------------------------------------------------ leaf sheets
class Sheet:
    def __init__(self, name):
        with open(f'{LEAVES}/leaf_{name}.json') as f:
            d = json.load(f)
        self.name, self.kind = name, d['kind']
        self.width, self.length = d['width'], d['length']
        self.cells = d['cells']
        self.K = len(self.cells)
        self.Wp = d['px'][0] // self.K
        self.Hp = d['px'][1]
        self.paths = {k: f'{LEAVES}/leaf_{name}_{k}.png' for k in ('albedo', 'back', 'normal', 'rough')}

    def pick(self, rng, moods):
        names = list(moods.keys())
        p = np.array([moods[n] for n in names], np.float64)
        v = names[rng.choice(len(names), p=p / p.sum())]
        idx = [i for i, c in enumerate(self.cells) if c['variant'] == v]
        if not idx:
            idx = list(range(self.K))
        return int(rng.choice(idx))

    def uv(self, cell, s, t):
        """Blender UV of blade coords s (-1..1 across), t (0 base .. 1 tip) in a cell, matching make_leaf()."""
        pad = 3
        W, H = self.Wp, self.Hp
        xx = (W - 1) / 2 + s * ((W - 1) / 2 - pad)
        yy = pad + (1 - t) * (H - 1 - 2 * pad)
        u = (cell * W + xx + 0.5) / (self.K * W)
        v = 1.0 - (yy + 0.5) / H
        return u, v


# ------------------------------------------------------------------------------------------------ geometry
TWIG_C = (1, 0, 0, 1)


def add_leaf(mb, sh, cell, P0, fwd, up, scale, fold=0.25, arch=0.12, twist=0.0, curl=0.0, mat=0, na=8, nc=4):
    fwd = J.norm(fwd)
    up = J.norm(up - fwd * np.dot(up, fwd))
    side = np.cross(fwd, up)
    L, W = sh.length * scale, sh.width * scale
    t = np.linspace(0, 1, na + 1)
    w_t = np.clip(outline(sh.kind, t, None), 0, None) * 1.07 + 0.035
    s = np.linspace(-1, 1, nc + 1)
    S_, Tt = np.meshgrid(s, t)
    Wt = np.repeat(w_t[:, None], nc + 1, 1)
    x = S_ * Wt * W / 2
    y = Tt * L
    z = fold * np.abs(x) - arch * L * Tt ** 2 + curl * L * (np.abs(S_) * Wt) ** 2 * 0.5
    if twist:
        a = twist * Tt
        x, z = x * np.cos(a) - z * np.sin(a), x * np.sin(a) + z * np.cos(a)
    P = P0 + x[..., None] * side + y[..., None] * fwd + z[..., None] * up
    base = mb.verts(P.reshape(-1, 3), (1, 1, 1, 1))
    U, V = sh.uv(cell, S_ * Wt, Tt)
    for i in range(na):
        for j in range(nc):
            a0 = base + i * (nc + 1) + j
            idx = (a0, a0 + 1, a0 + nc + 2, a0 + nc + 1)
            uvs = [(U[i, j], V[i, j]), (U[i, j + 1], V[i, j + 1]), (U[i + 1, j + 1], V[i + 1, j + 1]), (U[i + 1, j], V[i + 1, j])]
            mb.face(idx, uvs, mat)


def add_twig(mb, path, r0, r1, sides=5):
    path = np.asarray(path)
    K = len(path)
    radii = np.linspace(r0, r1, K)
    J.tube(mb, path, radii, sides, lambda i, f, a: np.tile(TWIG_C, (len(a), 1)), mat=1, v_scale=3.0)


def bend_path(start, direction, length, curve, n=6, zcurve=0.0, rng=None):
    """Planar-ish curved path: direction rotates by `curve` radians over the length (about +Z)."""
    pts = [np.asarray(start, np.float64)]
    d = J.norm(direction)
    step = length / n
    for k in range(n):
        d = J.rot((0, 0, 1), curve / n) @ d
        d = J.norm(d + np.array([0, 0, zcurve / n]))
        pts.append(pts[-1] + d * step)
    return np.array(pts)


def shoot(mb, rng, sh, moods, start, direction, length, depth, opts):
    """A twig with distichous (two-ranked) leaves facing +Z, optional side shoots."""
    curve = rng.uniform(-0.45, 0.45)
    path = bend_path(start, direction, length, curve, n=8, zcurve=rng.uniform(-0.05, 0.12))
    add_twig(mb, path, opts['r0'] * (0.75 ** depth), 0.0015)
    s = J.arclen(path)
    L = s[-1]
    inter = sh.length * opts['inter']
    pos = L * opts['first']
    side = 1 if rng.uniform() < 0.5 else -1
    k = 0
    while pos < L * 0.985:
        i = np.searchsorted(s, pos) - 1
        i = int(np.clip(i, 0, len(path) - 2))
        f = (pos - s[i]) / max(s[i + 1] - s[i], 1e-9)
        P = path[i] * (1 - f) + path[i + 1] * f
        tg = J.norm(path[i + 1] - path[i])
        rel = pos / L
        young = rel > 0.82
        ang = math.radians(rng.uniform(*opts['angle'])) * (1.0 - 0.45 * rel) * side
        fwd = J.rot((0, 0, 1), ang) @ tg
        fwd = J.norm(fwd + np.array([0, 0, rng.uniform(-0.12, 0.25)]))
        roll = rng.normal(0, opts.get('roll', 0.35))
        up = J.rot(fwd, roll) @ np.array([0, 0, 1.0])
        sc = rng.uniform(0.85, 1.15) * (1.0 - 0.5 * max(0.0, rel - 0.65) / 0.35) * opts.get('scale', 1.0)
        m = dict(moods)
        if young and 'young' in [c['variant'] for c in sh.cells]:
            m = {**{kk: vv * 0.5 for kk, vv in moods.items()}, 'young': 3.0}
        cell = sh.pick(rng, m)
        pet = sh.length * rng.uniform(0.08, 0.16)
        P1 = P + fwd * pet
        add_twig(mb, [P, (P + P1) / 2 + np.array([0, 0, 0.004]), P1], 0.0018, 0.0012, sides=4)
        dead = sh.cells[cell]['dead']
        add_leaf(mb, sh, cell, P1, fwd, up, sc,
                 fold=rng.uniform(0.15, 0.45), arch=rng.uniform(0.04, 0.22) + (0.25 if dead else 0),
                 twist=rng.normal(0, 0.25) + (rng.normal(0, 0.8) if dead else 0),
                 curl=rng.uniform(0.0, 0.4) + (rng.uniform(0.3, 1.0) if dead else 0))
        if depth < opts['depth'] and opts['first'] < rel < 0.7 and k % opts['branch_every'] == 1:
            sub_dir = J.rot((0, 0, 1), side * math.radians(rng.uniform(*opts['sub_angle']))) @ tg
            shoot(mb, rng, sh, moods, P, sub_dir, (L - pos) * rng.uniform(*opts['sub_len']), depth + 1, opts)
        side = -side
        pos += inter * rng.uniform(0.8, 1.25)
        k += 1
    return path


def rosette_shoot(mb, rng, sh, moods, start, direction, length, opts):
    """Twig ending in a spiral rosette of leaves (fig / Terminalia habit)."""
    path = bend_path(start, direction, length, rng.uniform(-0.4, 0.4), n=6, zcurve=0.06)
    add_twig(mb, path, opts['r0'], 0.002)
    tip = path[-1]
    tg = J.norm(path[-1] - path[-2])
    n = rng.integers(*opts['nleaf'])
    a0 = rng.uniform(0, 2 * math.pi)
    for k in range(n):
        a = a0 + k * 2.39996
        rel = k / max(n - 1, 1)
        spread = math.radians(rng.uniform(25, 95)) * (1 - 0.35 * rel)
        fwd = J.rot((0, 0, 1), spread * (1 if math.sin(a) > 0 else -1)) @ tg
        fwd = J.norm(fwd + np.array([0, 0, 0.15 + 0.25 * rel]))
        up = J.rot(fwd, rng.normal(0, 0.35)) @ np.array([0, 0, 1.0])
        P = tip - tg * sh.length * 0.06 * (n - k) / n
        sc = rng.uniform(0.8, 1.15) * (1 - 0.35 * rel) * opts.get('scale', 1.0)
        cell = sh.pick(rng, moods if rel < 0.75 else {**moods, 'young': 2.0})
        dead = sh.cells[cell]['dead']
        add_leaf(mb, sh, cell, P, fwd, up, sc, fold=rng.uniform(0.15, 0.4), arch=rng.uniform(0.05, 0.2) + (0.3 if dead else 0),
                 twist=rng.normal(0, 0.2), curl=rng.uniform(0, 0.3) + (0.6 if dead else 0))


def pinnate_shoot(mb, rng, sh, moods, start, direction, length, opts):
    path = bend_path(start, direction, length, rng.uniform(-0.35, 0.35), n=8, zcurve=0.05)
    add_twig(mb, path, opts['r0'], 0.0015)
    s = J.arclen(path)
    L = s[-1]
    pos = L * 0.12
    side = 1
    while pos < L * 0.97:
        i = int(np.clip(np.searchsorted(s, pos) - 1, 0, len(path) - 2))
        f = (pos - s[i]) / max(s[i + 1] - s[i], 1e-9)
        P = path[i] * (1 - f) + path[i + 1] * f
        tg = J.norm(path[i + 1] - path[i])
        rel = pos / L
        rdir = J.rot((0, 0, 1), side * math.radians(rng.uniform(35, 60)) * (1 - 0.4 * rel)) @ tg
        rlen = opts['rachis'] * rng.uniform(0.8, 1.15) * (1 - 0.35 * max(0, rel - 0.6))
        rpath = bend_path(P, rdir, rlen, rng.uniform(-0.3, 0.3), n=6, zcurve=rng.uniform(-0.05, 0.1))
        add_twig(mb, rpath, 0.0022, 0.001, sides=4)
        rs = J.arclen(rpath)
        npair = int(rlen / (sh.width * 1.55 * opts.get('leaflet', 1.0)))
        mood_c = sh.pick(rng, moods)
        for k in range(1, npair + 1):
            q = rs[-1] * k / (npair + 0.6)
            j = int(np.clip(np.searchsorted(rs, q) - 1, 0, len(rpath) - 2))
            g = (q - rs[j]) / max(rs[j + 1] - rs[j], 1e-9)
            Q = rpath[j] * (1 - g) + rpath[j + 1] * g
            rt = J.norm(rpath[j + 1] - rpath[j])
            for sd in (-1, 1):
                fwd = J.rot((0, 0, 1), sd * math.radians(rng.uniform(62, 82))) @ rt
                fwd = J.norm(fwd + np.array([0, 0, rng.uniform(-0.05, 0.2)]))
                up = J.rot(fwd, rng.normal(0, 0.3)) @ np.array([0, 0, 1.0])
                cell = mood_c if rng.uniform() < 0.8 else sh.pick(rng, moods)
                add_leaf(mb, sh, cell, Q, fwd, up, opts.get('leaflet', 1.0) * rng.uniform(0.85, 1.1) * (1 - 0.3 * k / npair),
                         fold=rng.uniform(0.1, 0.3), arch=rng.uniform(0.02, 0.15), na=4, nc=2)
            if k == npair:
                add_leaf(mb, sh, sh.pick(rng, moods), rpath[-1], rt, np.array([0, 0, 1.0]), 0.9 * opts.get('leaflet', 1.0), na=4, nc=2)
        side = -side
        pos += opts['inter'] * rng.uniform(0.8, 1.2)


def palmate_leaf(mb, rng, sh, moods, P, fwd, opts):
    """Petiole + 5-7 leaflets radiating from its tip, facing up."""
    pl = opts['petiole'] * rng.uniform(0.8, 1.2)
    tip = P + J.norm(fwd + np.array([0, 0, rng.uniform(0.05, 0.3)])) * pl
    add_twig(mb, [P, 0.5 * (P + tip) + np.array([0, 0, 0.01]), tip], 0.0025, 0.0016, sides=4)
    n = int(rng.integers(5, 8))
    spread = math.radians(rng.uniform(250, 320))
    a0 = math.atan2(fwd[1], fwd[0]) - spread / 2
    cell = sh.pick(rng, moods)
    for k in range(n):
        a = a0 + spread * k / (n - 1) + rng.normal(0, 0.06)
        d = J.norm(np.array([math.cos(a), math.sin(a), rng.uniform(-0.05, 0.12)]))
        up = J.rot(d, rng.normal(0, 0.25)) @ np.array([0, 0, 1.0])
        mid = 1.0 - abs(k - (n - 1) / 2) / ((n - 1) / 2) * 0.35  # central leaflets longest
        c = cell if rng.uniform() < 0.75 else sh.pick(rng, moods)
        add_leaf(mb, sh, c, tip + d * 0.004, d, up, opts['leaflet'] * mid * rng.uniform(0.9, 1.08), fold=rng.uniform(0.15, 0.35),
                 arch=rng.uniform(0.05, 0.2), twist=rng.normal(0, 0.15), na=6, nc=2)


def palmate_shoot(mb, rng, sh, moods, start, direction, length, opts):
    path = bend_path(start, direction, length, rng.uniform(-0.4, 0.4), n=6, zcurve=0.05)
    add_twig(mb, path, opts['r0'], 0.002)
    s_ = J.arclen(path)
    L = s_[-1]
    nl = int(rng.integers(*opts['nleaf']))
    for k in range(nl):
        rel = 0.35 + 0.65 * (k / max(nl - 1, 1)) ** 0.7
        pos = L * rel
        i = int(np.clip(np.searchsorted(s_, pos) - 1, 0, len(path) - 2))
        P = path[i]
        tg = J.norm(path[i + 1] - path[i])
        side = 1 if k % 2 == 0 else -1
        fwd = J.rot((0, 0, 1), side * math.radians(rng.uniform(35, 80)) * (1 - 0.5 * rel)) @ tg
        palmate_leaf(mb, rng, sh, moods, P, fwd, opts)


def vine_strip(mb, rng, sh, moods, length, opts):
    pts = [np.array([0.0, 0.0, 0.0])]
    for k in range(10):
        pts.append(pts[-1] + np.array([rng.uniform(-0.03, 0.03), length / 10, rng.uniform(-0.01, 0.01)]))
    path = J.catmull(np.array(pts), 3)
    add_twig(mb, path, 0.006, 0.003)
    s = J.arclen(path)
    pos = 0.04
    side = 1
    while pos < s[-1] * 0.98:
        i = int(np.clip(np.searchsorted(s, pos) - 1, 0, len(path) - 2))
        P = path[i]
        tg = J.norm(path[i + 1] - path[i])
        fwd = J.norm(J.rot((0, 0, 1), side * math.radians(rng.uniform(25, 65))) @ tg + np.array([0, 0, 0.1]))
        up = J.rot(fwd, rng.normal(0, 0.25)) @ np.array([0, 0, 1.0])
        P1 = P + fwd * sh.length * 0.25
        add_twig(mb, [P, P1], 0.002, 0.0015, sides=4)
        add_leaf(mb, sh, sh.pick(rng, moods), P1, fwd, up, rng.uniform(*opts['scale']), fold=rng.uniform(0.1, 0.3),
                 arch=rng.uniform(0.0, 0.15), twist=rng.normal(0, 0.15))
        side = -side
        pos += sh.length * opts['scale'][1] * rng.uniform(0.5, 0.8)


def fig_mat(mb, rng, sh, moods, size, opts):
    """Climbing-fig mat: branching thin stems with many small overlapping leaves pressed flat."""
    for b in range(opts['stems']):
        start = np.array([rng.uniform(-0.45, 0.45) * size, -0.5 * size + rng.uniform(0, 0.35) * size, 0.0])
        d = J.norm(np.array([rng.uniform(-0.5, 0.5) - start[0] / size, 1.0, 0.0]))
        path = bend_path(start, d, size * rng.uniform(0.5, 0.9), rng.uniform(-0.8, 0.8), n=10)
        add_twig(mb, path, 0.0025, 0.0012, sides=4)
        s = J.arclen(path)
        pos = 0.01
        side = 1
        while pos < s[-1]:
            i = int(np.clip(np.searchsorted(s, pos) - 1, 0, len(path) - 2))
            tg = J.norm(path[i + 1] - path[i])
            fwd = J.norm(J.rot((0, 0, 1), side * math.radians(rng.uniform(30, 80))) @ tg + np.array([0, 0, 0.05]))
            up = J.rot(fwd, rng.normal(0, 0.15)) @ np.array([0, 0, 1.0])
            add_leaf(mb, sh, sh.pick(rng, moods), path[i] + np.array([0, 0, 0.002 * rng.uniform()]), fwd, up,
                     rng.uniform(*opts['scale']), fold=0.1, arch=0.02, na=4, nc=2)
            side = -side
            pos += sh.length * opts['scale'][1] * rng.uniform(0.35, 0.6)


# ------------------------------------------------------------------------------------------------ tiles
SPRAY = dict(r0=0.006, inter=0.3, first=0.08, angle=(50, 75), depth=1, branch_every=2, sub_angle=(38, 62), sub_len=(0.6, 0.85))
TILES_CANOPY = [
    # name, slot (col,row), builder, sheet, moods, pivot ('bottom'|'center'), seed, extra
    ('ell_spray_a', (0, 0), 'spray', 'ell', {'dark': 0.45, 'mid': 0.35, 'blue': 0.15, 'old': 0.05}, 'bottom', 1, {}),
    ('ell_spray_b', (1, 0), 'spray', 'ell', {'mid': 0.4, 'young': 0.45, 'yellowing': 0.05, 'dark': 0.1}, 'bottom', 2, {}),
    ('ell_spray_dense', (2, 0), 'dense', 'ell', {'dark': 0.3, 'mid': 0.4, 'young': 0.2, 'blue': 0.1}, 'bottom', 3, {}),
    ('ell_clump', (3, 0), 'clump', 'ell', {'dark': 0.35, 'mid': 0.4, 'young': 0.15, 'blue': 0.1}, 'center', 4, {}),
    ('obo_rosette_a', (0, 1), 'rosette', 'obo', {'dark': 0.5, 'mid': 0.25, 'blue': 0.2, 'old': 0.05}, 'bottom', 5, {}),
    ('obo_rosette_b', (1, 1), 'rosette', 'obo', {'mid': 0.4, 'young': 0.3, 'dark': 0.3}, 'bottom', 6, {}),
    ('obo_clump', (2, 1), 'clump_rosette', 'obo', {'dark': 0.45, 'mid': 0.35, 'blue': 0.1, 'young': 0.1}, 'center', 7, {}),
    ('dead_spray', (3, 1), 'spray', 'ell', {'dead': 0.55, 'yellowing': 0.3, 'old': 0.15}, 'bottom', 8, {}),
    ('palm_spray_a', (0, 2), 'palmate', 'ell', {'mid': 0.45, 'young': 0.3, 'blue': 0.15, 'dark': 0.1}, 'bottom', 9, {}),
    ('palm_spray_b', (1, 2), 'palmate', 'ell', {'young': 0.55, 'mid': 0.35, 'yellowing': 0.1}, 'bottom', 10, {}),
    ('palm_clump', (2, 2), 'clump_palmate', 'ell', {'mid': 0.45, 'young': 0.35, 'blue': 0.1, 'dark': 0.1}, 'center', 11, {}),
    ('vine_strip', (3, 2), 'vine', 'cor', {'dark': 0.3, 'mid': 0.4, 'young': 0.2, 'blue': 0.1}, 'bottom', 12, {}),
    ('strap_singles', (0, 3), 'singles', 'strap', ['apple', 'young', 'mid', 'yellowing'], 'bottom', 0, {}),
    ('brom_singles', (1, 3), 'singles', 'brom', ['olive', 'red', 'mid', 'dark'], 'bottom', 0, {}),
    ('cor_singles', (2, 3), 'singles2x2', 'cor', ['dark', 'mid', 'young', 'old'], 'bottom', 0, {}),
    ('fig_mat', (3, 3), 'mat', 'cor', {'dark': 0.4, 'mid': 0.4, 'young': 0.2}, 'center', 13, {}),
]


def build_tile(kind, sh, moods, seed, sheets):
    rng = np.random.default_rng(seed)
    mb = J.MB()
    if kind == 'spray':
        shoot(mb, rng, sh, moods, (0, 0, 0), (0, 1, 0), 0.85, 0, dict(SPRAY))
    elif kind == 'dense':
        for k, a in enumerate((-0.32, 0.0, 0.3)):
            shoot(mb, rng, sh, moods, (0.02 * k, 0, 0.01 * k), J.rot((0, 0, 1), a) @ np.array([0, 1.0, 0]),
                  rng.uniform(0.75, 0.95), 0, dict(SPRAY, inter=0.28))
    elif kind == 'rosette':
        add_twig(mb, [(0, 0, 0), (0.01, 0.12, 0.01), (0.0, 0.24, 0.02)], 0.009, 0.006)
        nr = int(rng.integers(5, 7))
        for k in range(nr):
            a = (k / (nr - 1) - 0.5) * 2.0 + rng.uniform(-0.15, 0.15)
            d = J.rot((0, 0, 1), a) @ np.array([0, 1.0, 0])
            st = np.array([0.0, rng.uniform(0.06, 0.24), 0.02])
            rosette_shoot(mb, rng, sh, moods, st, d, rng.uniform(0.28, 0.45) * (1 - 0.3 * abs(a)), dict(r0=0.006, nleaf=(6, 10)))
    elif kind == 'palmate':
        add_twig(mb, [(0, 0, 0), (0.0, 0.15, 0.01), (0.01, 0.3, 0.02)], 0.009, 0.006)
        for a in (-0.75, 0.0, 0.7, -0.3, 0.35):
            palmate_shoot(mb, rng, sh, moods, (0, rng.uniform(0.05, 0.3), 0.02), J.rot((0, 0, 1), a + rng.normal(0, 0.1)) @ np.array([0, 1.0, 0]),
                          rng.uniform(0.35, 0.6), dict(r0=0.006, nleaf=(3, 5), petiole=0.13, leaflet=0.85))
    elif kind == 'pinnate':
        pinnate_shoot(mb, rng, sh, moods, (0, 0, 0), (0, 1, 0), 0.85, dict(r0=0.007, rachis=0.44, inter=0.08, leaflet=1.45))
        for a in (-0.6, 0.65, -0.25):
            pinnate_shoot(mb, rng, sh, moods, (0, 0.1, 0.01), J.rot((0, 0, 1), a) @ np.array([0, 1.0, 0]),
                          rng.uniform(0.5, 0.65), dict(r0=0.005, rachis=0.36, inter=0.085, leaflet=1.45))
    elif kind in ('clump', 'clump_rosette', 'clump_pinnate', 'clump_palmate'):
        n = {'clump': 26, 'clump_rosette': 18, 'clump_pinnate': 22, 'clump_palmate': 20}[kind]
        for k in range(n):
            az = 2 * math.pi * k / n + rng.uniform(-0.2, 0.2)
            d = np.array([math.cos(az), math.sin(az), 0.0])
            start = d * rng.uniform(0.0, 0.25) + np.array([0, 0, rng.uniform(0.0, 0.25)])
            if kind == 'clump':
                shoot(mb, rng, sh, moods, start, J.norm(d + np.array([0, 0, rng.uniform(-0.1, 0.35)])), rng.uniform(0.8, 1.1), 0,
                      dict(SPRAY))
            elif kind == 'clump_rosette':
                for q in range(4):
                    st2 = d * rng.uniform(0.05, 0.8) + np.array([0, 0, rng.uniform(0.0, 0.3)])
                    d2 = J.rot((0, 0, 1), rng.uniform(-0.5, 0.5)) @ d
                    rosette_shoot(mb, rng, sh, moods, st2, J.norm(d2 + np.array([0, 0, 0.25])), rng.uniform(0.18, 0.38),
                                  dict(r0=0.006, nleaf=(7, 11)))
            elif kind == 'clump_palmate':
                palmate_shoot(mb, rng, sh, moods, start, J.norm(d + np.array([0, 0, 0.2])), rng.uniform(0.6, 0.95),
                              dict(r0=0.006, nleaf=(3, 6), petiole=0.13, leaflet=0.85))
            else:
                pinnate_shoot(mb, rng, sh, moods, start, J.norm(d + np.array([0, 0, 0.2])), rng.uniform(0.75, 1.0),
                              dict(r0=0.006, rachis=0.38, inter=0.11, leaflet=1.45))
        for k in range(9):  # fill the crown of the clump
            d = J.norm(np.array([rng.uniform(-1, 1), rng.uniform(-1, 1), 0.0]))
            st = np.array([0, 0, 0.3])
            if kind == 'clump':
                shoot(mb, rng, sh, moods, st, d, rng.uniform(0.5, 0.7), 1, dict(SPRAY))
            elif kind == 'clump_rosette':
                rosette_shoot(mb, rng, sh, moods, st, d, rng.uniform(0.3, 0.5), dict(r0=0.006, nleaf=(6, 9)))
            elif kind == 'clump_palmate':
                palmate_shoot(mb, rng, sh, moods, st, d, rng.uniform(0.4, 0.6), dict(r0=0.006, nleaf=(2, 4), petiole=0.12, leaflet=0.85))
            else:
                pinnate_shoot(mb, rng, sh, moods, st, d, rng.uniform(0.45, 0.65), dict(r0=0.006, rachis=0.34, inter=0.12, leaflet=1.45))
    elif kind == 'vine':
        vine_strip(mb, rng, sh, moods, 0.85, dict(scale=(1.0, 1.5)))
    elif kind == 'mat':
        fig_mat(mb, rng, sh, moods, 0.6, dict(stems=16, scale=(0.22, 0.34)))
    return mb


# ------------------------------------------------------------------------------------------------ materials
def sock(node, ident):
    for s in node.inputs:
        if s.identifier == ident:
            return s
    raise KeyError(ident)


def mix_rgba(nt, fac_out, a_out, b_out):
    m = nt.nodes.new('ShaderNodeMix')
    m.data_type = 'RGBA'
    nt.links.new(fac_out, sock(m, 'Factor_Float'))
    nt.links.new(a_out, sock(m, 'A_Color'))
    nt.links.new(b_out, sock(m, 'B_Color'))
    return [o for o in m.outputs if o.identifier == 'Result_Color'][0]


def pass_material(name, sh, ao_dist):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    pv = nt.nodes.new('ShaderNodeValue')
    pv.name = 'PASS'
    pv.outputs[0].default_value = 0
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    if sh is not None:
        uv = nt.nodes.new('ShaderNodeUVMap')
        uv.uv_map = 'UVMap'

        def img(path, cs):
            t = nt.nodes.new('ShaderNodeTexImage')
            t.image = J.load_image(path, cs)
            t.interpolation = 'Cubic'
            nt.links.new(uv.outputs['UV'], t.inputs['Vector'])
            return t
        ta = img(sh.paths['albedo'], 'sRGB')
        tb = img(sh.paths['back'], 'sRGB')
        tn = img(sh.paths['normal'], 'Non-Color')
        tr = img(sh.paths['rough'], 'Non-Color')
        alb = mix_rgba(nt, geo.outputs['Backfacing'], ta.outputs['Color'], tb.outputs['Color'])
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nm.uv_map = 'UVMap'
        nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
        nrm_world = nm.outputs['Normal']
        alpha = ta.outputs['Alpha']
        rough = tr.outputs['Color']
    else:
        noise = nt.nodes.new('ShaderNodeTexNoise')
        noise.inputs['Scale'].default_value = 60.0
        cr = nt.nodes.new('ShaderNodeValToRGB')
        cr.color_ramp.elements[0].color = (*T.srgb8(70, 58, 40), 1)
        cr.color_ramp.elements[1].color = (*T.srgb8(112, 100, 70), 1)
        nt.links.new(noise.outputs['Fac'], cr.inputs['Fac'])
        alb = cr.outputs['Color']
        nrm_world = geo.outputs['Normal']
        alpha = None
        rv = nt.nodes.new('ShaderNodeValue')
        rv.outputs[0].default_value = 0.75
        rough = rv.outputs[0]
    # the tile camera looks down -Z with image right = +X and image up = +Y, so world-space normals are already
    # the card's tangent-space normals (Cycles' camera space would flip Z)
    ma = nt.nodes.new('ShaderNodeVectorMath')
    ma.operation = 'MULTIPLY_ADD'
    nt.links.new(nrm_world, ma.inputs[0])
    ma.inputs[1].default_value = (0.5, 0.5, 0.5)
    ma.inputs[2].default_value = (0.5, 0.5, 0.5)
    ao = nt.nodes.new('ShaderNodeAmbientOcclusion')
    ao.samples = 16
    ao.inputs['Distance'].default_value = ao_dist
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(rough if not isinstance(rough, float) else rough, sep.inputs['Color'])
    comb = nt.nodes.new('ShaderNodeCombineColor')
    nt.links.new(ao.outputs['AO'], comb.inputs['Red'])
    nt.links.new(sep.outputs['Red'], comb.inputs['Green'])
    c1 = nt.nodes.new('ShaderNodeMath')
    c1.operation = 'COMPARE'
    c1.inputs[1].default_value = 1.0
    c1.inputs[2].default_value = 0.1
    nt.links.new(pv.outputs[0], c1.inputs[0])
    c2 = nt.nodes.new('ShaderNodeMath')
    c2.operation = 'COMPARE'
    c2.inputs[1].default_value = 2.0
    c2.inputs[2].default_value = 0.1
    nt.links.new(pv.outputs[0], c2.inputs[0])
    m1 = mix_rgba(nt, c1.outputs[0], alb, ma.outputs['Vector'])
    m2 = mix_rgba(nt, c2.outputs[0], m1, comb.outputs['Color'])
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Strength'].default_value = 1.0
    nt.links.new(m2, em.inputs['Color'])
    if alpha is not None:
        tp = nt.nodes.new('ShaderNodeBsdfTransparent')
        mx = nt.nodes.new('ShaderNodeMixShader')
        nt.links.new(alpha, mx.inputs['Fac'])
        nt.links.new(tp.outputs['BSDF'], mx.inputs[1])
        nt.links.new(em.outputs['Emission'], mx.inputs[2])
        nt.links.new(mx.outputs['Shader'], out.inputs['Surface'])
    else:
        nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    return m


def set_pass(mats, p):
    for m in mats:
        m.node_tree.nodes['PASS'].outputs[0].default_value = p


# ------------------------------------------------------------------------------------------------ render
def setup_scene():
    J.reset_scene()
    sc = bpy.context.scene
    J.cycles_gpu(sc, samples=16)
    sc.cycles.max_bounces = 0
    sc.cycles.transparent_max_bounces = 64
    sc.cycles.use_denoising = False
    sc.cycles.filter_width = 1.0
    sc.render.film_transparent = True
    sc.render.resolution_x = TILE * SS
    sc.render.resolution_y = TILE * SS
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'OPEN_EXR'
    sc.render.image_settings.color_depth = '16'
    sc.render.image_settings.exr_codec = 'ZIP'
    try:
        sc.view_settings.view_transform = 'Standard'
    except Exception:
        pass
    cam_d = bpy.data.cameras.new('cam')
    cam_d.type = 'ORTHO'
    cam = bpy.data.objects.new('cam', cam_d)
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.location = (0, 0, 10)
    cam.rotation_euler = (0, 0, 0)
    cam_d.clip_start = 0.1
    cam_d.clip_end = 30
    return sc, cam


def render_tile(sc, cam, name, mb, sh, pivot, ao_dist):
    for o in list(sc.collection.objects):
        if o.type == 'MESH':
            bpy.data.objects.remove(o, do_unlink=True)
    ml = pass_material(f'{name}_leaf', sh, ao_dist)
    mt = pass_material(f'{name}_twig', None, ao_dist)
    ob = mb.build(name, [ml, mt])
    V = np.concatenate(mb.V)
    margin = 0.035
    if pivot == 'bottom':
        half_w = np.abs(V[:, 0]).max()
        top = V[:, 1].max()
        bot = min(V[:, 1].min(), 0.0)
        size = max(2 * half_w, top - bot) / (1 - 2 * margin)
        cx, cy = 0.0, bot - size * margin + size / 2
    else:
        size = 2 * max(np.abs(V[:, 0]).max(), np.abs(V[:, 1]).max()) / (1 - 2 * margin)
        cx, cy = 0.0, 0.0
    cam.location = (cx, cy, max(V[:, 2].max() + 1.0, 2.0))
    cam.data.ortho_scale = size
    passes = {}
    for p, (pname, samples) in enumerate((('alb', 16), ('nrm', 16), ('aux', 48))):
        set_pass([ml, mt], p)
        sc.cycles.samples = samples
        path = f'{WORK}/{name}_{pname}.exr'
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        passes[pname] = J.read_exr(path)
    piv = (0.5 - cx / size, 0.5 + (0 - cy) / size)  # pivot (0,0,0) in tile coords (u right, v up)
    return passes, size, piv, len(mb.F)


def down(a):
    h, w = a.shape[:2]
    return a.reshape(h // SS, SS, w // SS, SS, -1).mean(axis=(1, 3))


def finish_tile(passes):
    A = down(passes['alb'])
    Nn = down(passes['nrm'])
    X = down(passes['aux'])
    alpha = np.clip(A[..., 3], 0, 1)
    k = np.maximum(alpha, 1e-4)[..., None]
    alb = A[..., :3] / k
    nrm = Nn[..., :3] / k * 2 - 1
    nrm[..., 2] = np.maximum(nrm[..., 2], 0.05)
    nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True) + 1e-9
    nrm = nrm * 0.5 + 0.5
    aux = X[..., :3] / k
    alb = T.bleed(alb, alpha, 0.5)
    nrm = T.bleed(nrm, alpha, 0.5)
    aux = T.bleed(aux, alpha, 0.5)
    return alb, alpha, nrm, aux


def singles(sh, variants, grid2x2=False):
    """Copy single leaves from a sheet into a tile (no render)."""
    alb = T.read_image(sh.paths['albedo'])
    nrm = T.read_image(sh.paths['normal'])[..., :3]
    rgh = T.read_image(sh.paths['rough'])[..., 0]
    out_a = np.zeros((TILE, TILE, 4), np.float32)
    out_n = np.tile(np.array([0.5, 0.5, 1.0], np.float32), (TILE, TILE, 1))
    out_x = np.ones((TILE, TILE, 3), np.float32)
    subs = []
    n = len(variants)
    for k, v in enumerate(variants):
        ci = [i for i, c in enumerate(sh.cells) if c['variant'] == v][0]
        x0 = ci * sh.Wp
        ca = alb[:, x0:x0 + sh.Wp]
        cn = nrm[:, x0:x0 + sh.Wp]
        cr = rgh[:, x0:x0 + sh.Wp]
        if grid2x2:
            cw, chh = TILE // 2, TILE // 2
            ox, oy = (k % 2) * cw, (k // 2) * chh
        else:
            cw, chh = TILE // n, TILE
            ox, oy = k * cw, 0
        sc = min(cw / sh.Wp, chh / sh.Hp)
        w2, h2 = max(4, int(sh.Wp * sc) // 2 * 2), max(4, int(sh.Hp * sc) // 2 * 2)
        ra = T.resize(ca, h2, w2)
        rn = T.resize(cn, h2, w2)
        rr = T.resize(cr, h2, w2)
        px, py = ox + (cw - w2) // 2, oy + (chh - h2) // 2
        out_a[py:py + h2, px:px + w2] = ra
        out_n[py:py + h2, px:px + w2] = rn
        out_x[py:py + h2, px:px + w2, 1] = rr
        # sub-rect in tile-normalised Blender coords (v up), blade base at the bottom
        subs.append(dict(variant=v, u0=px / TILE, u1=(px + w2) / TILE, v0=1 - (py + h2) / TILE, v1=1 - py / TILE,
                         length=sh.length, width=sh.width))
    alpha = out_a[..., 3]
    lin = T.srgb_to_lin(out_a[..., :3])
    lin = T.bleed(lin, alpha, 0.5)
    out_n = T.bleed(out_n, alpha, 0.5)
    out_x[..., 0] = 1.0
    return lin, alpha, out_n, out_x, subs


def content_box(alpha):
    m = alpha > 0.15
    ys, xs = np.nonzero(m)
    if len(xs) == 0:
        return [0, 0, 1, 1]
    h, w = alpha.shape
    return [float(xs.min() / w), float(1 - (ys.max() + 1) / h), float((xs.max() + 1) / w), float(1 - ys.min() / h)]


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    atlas = argv[argv.index('--atlas') + 1] if '--atlas' in argv else 'canopy'
    only = argv[argv.index('--only') + 1].split(',') if '--only' in argv else None
    tiles = TILES_CANOPY
    os.makedirs(WORK, exist_ok=True)
    grid = 4
    A = np.zeros((TILE * grid, TILE * grid, 3), np.float32)
    AL = np.zeros((TILE * grid, TILE * grid), np.float32)
    N = np.tile(np.array([0.5, 0.5, 1.0], np.float32), (TILE * grid, TILE * grid, 1))
    X = np.ones((TILE * grid, TILE * grid, 3), np.float32)
    meta_path = f'{OUT}/{atlas}_leaf.json'
    meta = {'tiles': {}}
    cache = f'{WORK}/{atlas}_tiles.npz'
    if only and os.path.exists(cache):
        z = np.load(cache)
        A, AL, N, X = z['A'], z['AL'], z['N'], z['X']
        with open(meta_path) as f:
            meta = json.load(f)
    sheets = {}
    sc, cam = setup_scene()
    for (name, slot, kind, sname, moods, pivot, seed, extra) in tiles:
        if only and name not in only:
            continue
        sh = sheets.setdefault(sname, Sheet(sname))
        col, row = slot
        x0, y0 = col * TILE, row * TILE
        if kind.startswith('singles'):
            alb, alpha, nrm, aux, subs = singles(sh, moods, grid2x2=(kind == 'singles2x2'))
            info = dict(kind=kind, sheet=sname, subs=subs)
        else:
            mb = build_tile(kind, sh, moods, seed, sheets)
            ao_dist = 0.12 if kind.startswith('clump') else 0.06
            passes, size, piv, nf = render_tile(sc, cam, name, mb, sh, pivot, ao_dist)
            alb, alpha, nrm, aux = finish_tile(passes)
            info = dict(kind=kind, sheet=sname, size=size, pivot=piv, faces=nf)
            print(f'tile {name}: {nf} faces, {size:.2f} m')
        info['content'] = content_box(alpha)
        info['coverage'] = float((alpha > 0.5).mean())
        A[y0:y0 + TILE, x0:x0 + TILE] = alb
        AL[y0:y0 + TILE, x0:x0 + TILE] = alpha
        N[y0:y0 + TILE, x0:x0 + TILE] = nrm
        X[y0:y0 + TILE, x0:x0 + TILE] = aux
        # tile rect in Blender UV (v up)
        info['rect'] = [col / grid, 1 - (row + 1) / grid, (col + 1) / grid, 1 - row / grid]
        meta['tiles'][name] = info
    np.savez_compressed(cache, A=A, AL=AL, N=N, X=X)
    ao = np.clip(X[..., 0], 0, 1)
    ao = 0.45 + 0.55 * ao
    orm = np.stack([ao, np.clip(X[..., 1], 0.15, 1), np.zeros_like(ao)], -1)
    T.write_png(f'{OUT}/{atlas}_leaf_albedo.png', np.concatenate([T.lin_to_srgb(A), AL[..., None]], -1))
    T.write_png(f'{OUT}/{atlas}_leaf_normal.png', N)
    T.write_png(f'{OUT}/{atlas}_leaf_orm.png', orm)
    meta['grid'] = grid
    meta['px'] = TILE * grid
    with open(meta_path, 'w') as f:
        json.dump(meta, f, indent=1)
    print('atlas written', atlas)


if __name__ == '__main__':
    main()
