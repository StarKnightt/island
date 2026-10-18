"""Canopy / emergent rainforest trees (4 species x 3 LODs) -> E:/tmp/island/helpers/jungle/glb/canopy_trees_raw.glb
and, with --set mid, mid-storey trees (2 species x 3 LODs) -> midstorey_trees_raw.glb

    bash c:/Code/island/tools/heavy.sh jungle E:/blender/blender-5.1.2-windows-x64/blender.exe --background \
        --factory-startup -t 6 --python tools/blender/jungle/canopy.py -- [--set mid] [--only a,b] [--blend out.blend]

Needs: build_bark.py and sprig_atlas.py outputs in E:/tmp/island/helpers/jungle/tex. Deterministic (fixed seeds).
Node names: rainforest_<a|b|c|d>_lod<0|1|2>, midstorey_<a|b>_lod<0|1|2>. Materials: canopy_bark, canopy_leaf.
COLOR_0 = (AO, bend, flutter, phase). Blender Z-up here; the glTF exporter writes Y-up.
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
BARK_W = 1.9          # metres of bark per texture unit (u)
LOW_Z0, LOW_Z1 = -0.6, 3.2   # lower-trunk texture region (v 0.5..1.0)
SINK = -0.6

SPECIES = {
    'a': dict(desc='dipterocarp emergent', seed=101, height=36.0, bole=0.55, dbh=1.2, lean=(0.012, 40),
              buttress=dict(n=5, reach=(2.6, 3.9), height=(3.2, 5.2), thick=(0.18, 0.28)),
              crown=dict(width=21.0, depth=0.45, clumps=12, tiles=('ell_spray_a', 'ell_spray_b', 'ell_spray_b'),
                         clump_tile='ell_clump', young=0.5, dead=0.04, limbs=5, fill=10, mass='ell_mass', lead=0.74),
              lianas=3, loops=1, nests=3, broms=4, climber=None, strangler=False, aerial=0),
    'b': dict(desc='strangler fig', seed=202, height=27.0, bole=0.5, dbh=0.85, lean=(0.02, 200),
              buttress=dict(n=3, reach=(1.2, 1.8), height=(1.2, 2.0), thick=(0.2, 0.3)),
              crown=dict(width=21.0, depth=0.42, clumps=13, tiles=('obo_rosette_a', 'obo_rosette_b', 'obo_rosette_a'),
                         clump_tile='obo_clump', young=0.25, dead=0.03, limbs=5, fill=7, mass='obo_mass'),
              lianas=0, loops=0, nests=2, broms=3, climber=None, strangler=True, aerial=16),
    'c': dict(desc='kapok (Ceiba-like) emergent, broad domed crown of palmate leaves', seed=303, height=34.0, bole=0.52,
              dbh=1.3, lean=(0.006, 120), buttress=dict(n=4, reach=(3.0, 4.0), height=(4.0, 6.0), thick=(0.2, 0.3)),
              crown=dict(width=21.0, depth=0.48, clumps=11, tiles=('palm_spray_a', 'palm_spray_b', 'palm_spray_a'),
                         clump_tile='palm_clump', young=0.45, dead=0.03, limbs=5, fill=10, mass='palm_mass', lead=0.7),
              lianas=0, loops=0, nests=1, broms=2, climber='pothos', strangler=False, aerial=0),
    'd': dict(desc='leaning canopy tree with lianas', seed=404, height=23.0, bole=0.55, dbh=0.72, lean=(0.11, 300),
              buttress=dict(n=3, reach=(1.5, 2.2), height=(1.6, 2.6), thick=(0.14, 0.2)),
              crown=dict(width=14.5, depth=0.45, clumps=9, tiles=('ell_spray_a', 'ell_spray_b', 'ell_spray_a'),
                         clump_tile='ell_clump', young=0.65, dead=0.05, limbs=4, fill=6, mass='ell_mass_b'),
              lianas=4, loops=2, nests=2, broms=3, climber='figmat', strangler=False, aerial=0),
    # mid-storey trees (8-15 m, thin trunks, small crowns of big leaves) -> midstorey_trees.glb
    'e': dict(desc='Schefflera-like mid-storey tree, palmate leaves', seed=505, height=12.0, bole=0.42, dbh=0.3,
              lean=(0.035, 70), buttress=dict(n=2, reach=(0.35, 0.6), height=(0.4, 0.8), thick=(0.07, 0.11)),
              crown=dict(width=7.5, depth=0.5, clumps=7, tiles=('palm_spray_a', 'palm_spray_b', 'palm_spray_b'),
                         clump_tile='palm_clump', young=0.5, dead=0.04, limbs=3, fill=3, mass='palm_mass'),
              lianas=0, loops=0, nests=0, broms=1, climber=None, strangler=False, aerial=0,
              prefix='midstorey', budget=(11000, 2800, 600), key='a'),
    'f': dict(desc='leaning broadleaf mid-storey tree, big obovate leaves', seed=606, height=9.5, bole=0.38, dbh=0.26,
              lean=(0.09, 160), buttress=dict(n=2, reach=(0.3, 0.55), height=(0.35, 0.7), thick=(0.06, 0.1)),
              crown=dict(width=7.0, depth=0.62, clumps=9, tiles=('obo_rosette_b', 'obo_rosette_a', 'obo_rosette_b'),
                         clump_tile='obo_clump', young=0.45, dead=0.05, limbs=4, fill=3, mass='obo_mass'),
              lianas=0, loops=0, nests=1, broms=0, climber=None, strangler=False, aerial=0,
              prefix='midstorey', budget=(11000, 2800, 600), key='b'),
}
CANOPY_KEYS = ['a', 'b', 'c', 'd']
MID_KEYS = ['e', 'f']


def icosphere(sub):
    t = (1 + 5 ** 0.5) / 2
    V = [np.array(v, float) / math.sqrt(1 + t * t) for v in
         [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t),
          (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]]
    F = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6),
         (7, 1, 8), (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9), (4, 9, 5), (2, 4, 11), (6, 2, 10),
         (8, 6, 7), (9, 8, 1)]
    for _ in range(sub):
        mid = {}

        def m(a, b):
            k = (min(a, b), max(a, b))
            if k not in mid:
                V.append(J.norm(V[a] + V[b]))
                mid[k] = len(V) - 1
            return mid[k]
        F2 = []
        for a, b, c in F:
            ab, bc, ca = m(a, b), m(b, c), m(c, a)
            F2 += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        F = F2
    return np.array(V), F


# crown hull shells per LOD: icosphere(1) 80 tris, icosahedron 20, octahedron 8
HULL_GEO = [icosphere(1), icosphere(0),
            (np.array([(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)], float),
             [(0, 2, 4), (2, 1, 4), (1, 3, 4), (3, 0, 4), (2, 0, 5), (1, 2, 5), (3, 1, 5), (0, 3, 5)])]


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


# ------------------------------------------------------------------------------------------------ atlas
class Atlas:
    def __init__(self):
        with open(f'{TEX}/canopy_leaf.json') as f:
            self.d = json.load(f)
        self.t = self.d['tiles']

    def card_geom(self, name):
        """Return (x0, x1, y0, y1) metric extents of the tile content relative to its pivot (at native size), and a
        function mapping tile-normalised (tu, tv) -> atlas Blender UV."""
        t = self.t[name]
        S = t['size']
        px, py = t['pivot']
        cu0, cv0, cu1, cv1 = t['content']
        r = t['rect']
        inset = 1.5 / self.d['px'] / (r[2] - r[0])
        cu0, cv0, cu1, cv1 = cu0 + inset, cv0 + inset, cu1 - inset, cv1 - inset

        def uv(tu, tv):
            return (r[0] + tu * (r[2] - r[0]), r[1] + tv * (r[3] - r[1]))
        return ((cu0 - px) * S, (cu1 - px) * S, (cv0 - py) * S, (cv1 - py) * S), (cu0, cu1, cv0, cv1, px, py), uv

    def sub(self, name, k):
        t = self.t[name]
        s = t['subs'][k % len(t['subs'])]
        r = t['rect']

        def uv(su, sv):
            tu = s['u0'] + su * (s['u1'] - s['u0'])
            tv = s['v0'] + sv * (s['v1'] - s['v0'])
            return (r[0] + tu * (r[2] - r[0]), r[1] + tv * (r[3] - r[1]))
        return s, uv


# ------------------------------------------------------------------------------------------------ bark UV
def v_lower(z):
    return 0.5 + (np.clip(z, LOW_Z0, LOW_Z1) - LOW_Z0) / (LOW_Z1 - LOW_Z0) * 0.5


def seam_heights(zmax):
    hs = [LOW_Z1]
    while hs[-1] < zmax:
        hs.append(hs[-1] + BARK_W)
    return hs


def v_band(za, zb):
    """v for a trunk band [za, zb] (never straddles a seam)."""
    zm = 0.5 * (za + zb)
    if zm < LOW_Z1:
        return v_lower(za), v_lower(zb)
    k = math.floor((zm - LOW_Z1) / BARK_W)
    z0 = LOW_Z1 + k * BARK_W
    return (za - z0) / BARK_W * 0.5, (zb - z0) / BARK_W * 0.5


def v_seg_clean(va, vb):
    """Fold a raw clean-bark v range (0.5 per BARK_W metres) into [0, 0.5] by its segment."""
    k = math.floor((0.5 * (va + vb)) / 0.5)
    return va - 0.5 * k, vb - 0.5 * k


# ------------------------------------------------------------------------------------------------ tree
class Tree:
    def __init__(self, key, sp):
        self.key, self.sp = key, sp
        self.rng = np.random.default_rng(sp['seed'])
        self.H = sp['height']
        self.Hb = sp['height'] * sp['bole']
        self.r13 = sp['dbh'] / 2
        la, ld = sp['lean']
        self.lean_dir = np.array([math.cos(math.radians(ld)), math.sin(math.radians(ld))])
        self.lean = la
        self.wob_amp = self.rng.uniform(0.05, 0.14) * (1 + 3 * la)
        self.wob_l = self.rng.uniform(7, 12)
        self.wob_p = self.rng.uniform(0, 6.28)
        self.wob_dir = np.array([-self.lean_dir[1], self.lean_dir[0]])
        self.lobe = [(self.rng.uniform(0.02, 0.05), self.rng.uniform(0, 6.28)),
                     (self.rng.uniform(0.015, 0.035), self.rng.uniform(0, 6.28)),
                     (self.rng.uniform(0.01, 0.025), self.rng.uniform(0, 6.28))]
        self.phase = float(self.rng.uniform())
        self.make_fins()
        self.make_crown()

    # --- trunk shape
    def g_trunk(self, z):
        return 0.28 * (float(np.clip(z, 0, self.Hb)) / self.Hb) ** 1.5

    def centre(self, z):
        scalar = np.ndim(z) == 0
        z = np.atleast_1d(np.asarray(z, np.float64))
        zz = np.maximum(z, 0)
        lean = self.lean * zz * (0.6 + 0.4 * zz / self.H) * (1 + 0.6 * self.lean * zz / max(self.Hb, 1))
        wob = self.wob_amp * np.sin(2 * math.pi * zz / self.wob_l + self.wob_p) * smooth(0, 4, zz)
        xy = self.lean_dir[None] * lean[:, None] + self.wob_dir[None] * wob[:, None]
        out = np.concatenate([xy, z[:, None]], -1)
        return out[0] if scalar else out

    def radius(self, z):
        z = np.asarray(z, np.float64)
        r = self.r13 * (1 - 0.3 * np.clip((z - 1.3) / self.Hb, 0, 1.2))
        r = r * (1 + 0.28 * np.exp(-np.maximum(z, 0) / 0.9))
        r = r * (1 + 0.12 * smooth(self.Hb - 2.5, self.Hb, z))
        return r

    def lobes(self, th, z):
        (a1, p1), (a2, p2), (a3, p3) = self.lobe
        return 1 + a1 * np.cos(2 * th + p1) + a2 * np.cos(3 * th + p2 + 0.1 * z) + a3 * np.cos(5 * th + p3 - 0.13 * z)

    # --- buttresses
    def make_fins(self):
        b = self.sp['buttress']
        n = b['n']
        base = self.rng.uniform(0, 2 * math.pi)
        self.fins = []
        for i in range(n):
            th = base + 2 * math.pi * i / n + self.rng.uniform(-0.35, 0.35) * (2 * math.pi / n) * 0.5
            self.fins.append(dict(th=th, D=self.rng.uniform(*b['reach']), h=self.rng.uniform(*b['height']),
                                  t=self.rng.uniform(*b['thick']), A=self.rng.uniform(0.12, 0.45),
                                  k=self.rng.uniform(1.0, 2.2), ph=self.rng.uniform(0, 6.28),
                                  p=self.rng.uniform(2.6, 3.6), curl=self.rng.uniform(-0.12, 0.12),
                                  wv=self.rng.uniform(0.04, 0.09), wf=self.rng.uniform(5, 9), wp=self.rng.uniform(0, 6.28)))
        self.fins.sort(key=lambda f: f['th'] % (2 * math.pi))
        for f in self.fins:
            f['th'] = f['th'] % (2 * math.pi)
            f['w'] = (f['t'] * 1.35) / self.radius(0.3)
        self.z_fade = min(max(f['h'] for f in self.fins) + 2.6, self.Hb - 1.0)

    def fin_extent(self, f, z):
        if z <= 0:
            return f['D'] * (1 + 0.06 * min(-z, 0.6))
        if z >= f['h']:
            return 0.0
        d = f['D'] * (1 - (z / f['h']) ** (1 / f['p']))
        return d * (1 + f['wv'] * math.sin(f['wf'] * z / f['h'] + f['wp']) * math.sin(math.pi * z / f['h']))

    def fin_curve(self, f, d):
        """Offset (radial, tangential) of the fin centreline at distance d from the trunk."""
        D = f['D']
        s = f['A'] * np.sin(math.pi * d / D * f['k'] + f['ph']) * (d / D) + f['curl'] * d * d / D
        return d, s

    # --- crown layout (skeleton first: leader, primaries at staggered heights, secondaries along primaries)
    def make_crown(self):
        cr = self.sp['crown']
        rng = self.rng
        R = cr['width'] / 2
        self.R = R
        tiered = cr.get('tiered', False)
        top = self.centre(self.Hb)
        H, Hb = self.H, self.Hb
        lead_dir = J.norm(np.array([self.lean_dir[0] * self.lean * 2.5, self.lean_dir[1] * self.lean * 2.5, 1.0]))
        lead_len = (H - Hb) * cr.get('lead', 0.52)
        lead_end = top + lead_dir * lead_len + np.array([rng.normal(0, 0.4), rng.normal(0, 0.4), 0])
        self.crown_c = np.array([lead_end[0], lead_end[1], Hb + (H - Hb) * 0.5])
        limbs = []
        leader = dict(start=self.centre(Hb - 0.6), end=lead_end, parent=None, level=0, kids=[], phase=float(rng.uniform()),
                      g0=self.g_trunk(Hb), g1=0.42, f0=0.0)
        limbs.append(leader)
        n_p = cr['limbs'] + 1
        az0 = rng.uniform(0, 2 * math.pi)
        tips = []
        for i in range(n_p):
            f = 0.05 + 0.8 * i / max(n_p - 1, 1) + rng.uniform(-0.05, 0.05)
            if tiered:
                f = [0.05, 0.4, 0.75, 0.25, 0.6][i % 5]
            f = float(np.clip(f, 0.02, 0.9))
            st = leader['start'] * (1 - f) + leader['end'] * f
            az = az0 + i * 2.39996 + rng.uniform(-0.3, 0.3)
            lo = 1 - f
            length = R * (0.72 + 0.35 * lo) * rng.uniform(0.85, 1.1)
            elev = math.radians(rng.uniform(10, 24) if tiered else rng.uniform(22, 40) - 10 * lo)
            d = np.array([math.cos(az) * math.cos(elev), math.sin(az) * math.cos(elev), math.sin(elev)])
            en = st + d * length
            en[2] = min(en[2], H - 2.0)
            prim = dict(start=st, end=en, parent=leader, level=0, kids=[], phase=float(rng.uniform()),
                        g0=leader['g0'] + (leader['g1'] - leader['g0']) * f, g1=0.55, f0=f, az=az)
            leader['kids'].append(prim)
            limbs.append(prim)
            n_s = 2 if R < 7.5 else 3
            for j in range(n_s):
                fs = float(np.clip(0.4 + 0.5 * j / max(n_s - 1, 1) + rng.uniform(-0.08, 0.08), 0.3, 0.92))
                ss = st * (1 - fs) + en * fs
                a2 = az + (1 if j % 2 == 0 else -1) * math.radians(rng.uniform(28, 55))
                e2 = math.radians(rng.uniform(5, 32))
                d2 = np.array([math.cos(a2) * math.cos(e2), math.sin(a2) * math.cos(e2), math.sin(e2)])
                l2 = R * rng.uniform(0.36, 0.55)
                e_ = ss + d2 * l2
                e_[2] = min(e_[2], H - 1.8)
                sec = dict(start=ss, end=e_, parent=prim, level=1, kids=[], phase=float((prim['phase'] + rng.normal(0, 0.08)) % 1.0),
                           g0=prim['g0'] + (prim['g1'] - prim['g0']) * fs, g1=0.68, f0=fs)
                prim['kids'].append(sec)
                limbs.append(sec)
                tips.append(sec)
            tips.append(prim)
        tips.append(leader)
        inner = []
        for l in limbs:
            if l['level'] == 0 and l['parent'] is not None:
                inner.append((l, rng.uniform(0.42, 0.62)))
        inner.append((leader, rng.uniform(0.35, 0.55)))
        # clumps at limb tips: large, rounded, overlapping
        clumps = []
        for l, f in inner:
            P = l['start'] * (1 - f) + l['end'] * f
            rk = R * rng.uniform(0.24, 0.32)
            rv = rk * rng.uniform(0.6, 0.78)
            c = P + np.array([0, 0, rv * 0.35])
            clumps.append(dict(c=c, r=rk, rv=rv, phase=l['phase'], limb=l, inner=True,
                               young=float(np.clip(cr['young'] - 0.15 + rng.normal(0, 0.1), 0, 1))))
        for l in tips:
            big = 1.15 if l is leader else (1.0 if l['level'] == 0 else 0.85)
            rk = R * rng.uniform(0.3, 0.4) * big
            rv = rk * (rng.uniform(0.72, 0.9) if not tiered else rng.uniform(0.42, 0.55))
            c = l['end'] + np.array([0, 0, rv * 0.25])
            hd = c[:2] - self.crown_c[:2]
            hn = np.linalg.norm(hd)
            if hn > 0.92 * R - 0.4 * rk:
                c[:2] = self.crown_c[:2] + hd / hn * (0.92 * R - 0.4 * rk)
                l['end'][:2] = c[:2]
            over = c[2] + rv - H
            if over > 0:
                c[2] -= over
            q = dict(c=c, r=rk, rv=rv, phase=l['phase'], limb=l,
                     young=float(np.clip(cr['young'] + rng.normal(0, 0.15) + 0.15 * (c[2] - Hb) / (H - Hb), 0, 1)))
            l['clump'] = len(clumps)
            clumps.append(q)
        self.clumps = clumps
        self.limbs = limbs
        # radii: pipe model (exponent 2.4) from tip radii, then scaled to the trunk top
        def rad(l):
            q = clumps[l['clump']] if 'clump' in l else None
            tip = 0.06 * (q['r'] / (R * 0.35)) ** 0.8 if q else 0.04
            kid = sum(rad(k) ** 2.4 for k in l['kids'])
            l['r1'] = tip
            l['r0'] = (tip ** 2.4 + kid) ** (1 / 2.4)
            return l['r0']
        rad(leader)
        k = (self.radius(Hb) * 0.95) / leader['r0']
        for l in limbs:
            l['r0'] = max(l['r0'] * k, 0.05)
            l['r1'] = max(l['r1'] * k * 0.9, 0.035)
        # paths: rise, then arch outward; small wobble
        up = np.array([0, 0, 1.0])
        for l in limbs:
            s_, e = l['start'], l['end']
            d = e - s_
            L = np.linalg.norm(d)
            if l['parent'] is None:
                d0 = J.norm(lead_dir)
            else:
                pd = J.norm(l['parent']['end'] - l['parent']['start'])
                d0 = J.norm(0.35 * pd + 0.65 * J.norm(d) + 0.25 * up)
            d1 = J.norm(J.norm(d) - up * 0.15)
            ctrl = [s_, s_ + d0 * L * 0.38, e - d1 * L * 0.3, e]
            ts = np.linspace(0, 1, 7)
            P = np.array([((1 - t) ** 3) * ctrl[0] + 3 * ((1 - t) ** 2) * t * ctrl[1] + 3 * (1 - t) * t * t * ctrl[2] + t ** 3 * ctrl[3]
                          for t in ts])
            n = J.norm(np.cross(J.norm(d), up + 1e-6))
            for i in range(1, len(P) - 1):
                P[i] += n * rng.normal(0, 0.05 * L / 6) + up * rng.normal(0, 0.035 * L / 6)
            l['ctrl'] = P
            l['L'] = L
        self.add_fill()
        self.make_subclumps()

    def add_fill(self):
        """Dome fill: extra clumps on the upper crown envelope wherever the limb-tip clumps leave a hole, each on a
        short branch from the nearest limb, so the crown reads as one massive lumpy dome from the side and from
        above instead of an umbrella of separate pads."""
        cr = self.sp['crown']
        nfill = cr.get('fill', 0)
        if not nfill:
            return
        rng = np.random.default_rng(self.sp['seed'] + 5)
        R, H, Hb = self.R, self.H, self.Hb
        cc = self.crown_c
        er = np.array([R * 0.84, R * 0.84, (H - Hb) * 0.5])
        polys = [(l, J.catmull(l['ctrl'], 3)) for l in self.limbs]
        added = 0
        for _ in range(nfill * 60):
            if added >= nfill:
                break
            az = rng.uniform(0, 2 * math.pi)
            el = math.asin(rng.uniform(-0.2, 1.0))
            d = np.array([math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el)])
            p = cc + d * er * rng.uniform(0.3, 0.92)
            rk = R * rng.uniform(0.25, 0.33)
            rv = rk * rng.uniform(0.8, 0.95)
            p[2] = min(p[2], H - rv)
            if any(np.linalg.norm((p - q['c']) * np.array([1, 1, 1.3])) < 0.66 * (rk + q['r']) for q in self.clumps):
                continue
            best = None
            for l, P in polys:
                dd = np.linalg.norm(P - p, axis=1)
                i = int(dd.argmin())
                if best is None or dd[i] < best[0]:
                    best = (float(dd[i]), l, P[i])
            dist, l, sp_ = best
            if dist > R * 0.6:
                continue
            self.clumps.append(dict(c=p, r=rk, rv=rv, phase=float((l['phase'] + rng.normal(0, 0.06)) % 1.0), limb=l,
                                    fill=True, stem=sp_, g_stem=float(l['g0'] + (l['g1'] - l['g0']) * 0.7),
                                    young=float(np.clip(cr['young'] + rng.normal(0, 0.15) + 0.15 * (p[2] - Hb) / (H - Hb), 0, 1))))
            added += 1
        self.n_fill = added

    def fill_stems(self, mb, lod):
        """Branches from the limbs to the dome-fill clumps (LOD0 / LOD1)."""
        for q in self.clumps:
            if not q.get('fill'):
                continue
            st, en = q['stem'], q['c'] - np.array([0, 0, q['rv'] * 0.3])
            mid = 0.5 * (st + en) + np.array([0, 0, 0.3 * np.linalg.norm(en - st) * 0.2])
            path = J.catmull(np.array([st, mid, en]), 2 if lod == 0 else 1)
            g0, ph = q['g_stem'], q['phase']
            cols = lambda i, f, a, g0=g0, p=ph: np.tile([0.55 + 0.2 * f, g0 + (0.7 - g0) * f, 0.0, p], (len(a), 1))
            J.tube(mb, path, np.linspace(0.075, 0.035, len(path)), 5 if lod == 0 else 3, cols, mat=0, u_wrap=1,
                   v_scale=0.5 / BARK_W, seg_v=v_seg_clean)

    def hulls(self, mb, at, lod):
        """Inner leaf-mass hull in every clump: a low-poly lumpy shell through the clump core and its sub-clumps,
        shrunk inside the card layer and textured with a seamless dense leaf-mass tile (canopy_mass.py), so the
        crown core blocks the sky. Each face gets its own UV patch inside the tile; normals bend outward like the
        cards'; COLOR_0 like a deep card that barely flutters."""
        mt = self.sp['crown'].get('mass', 'ell_mass')
        V0, F0 = HULL_GEO[min(lod, 2)]
        rng = np.random.default_rng(self.sp['seed'] + 13 + lod)
        nb = [set() for _ in range(len(V0))]
        for f in F0:
            for i in range(3):
                nb[f[i]].update((f[(i + 1) % 3], f[(i + 2) % 3]))
        nb = [list(n) for n in nb]
        tile = at.t[mt]
        r, tphys = tile['rect'], tile['size']
        t0 = mb.tris()
        for q in self.clumps:
            c, rk, rv = q['c'], q['r'], q['rv']
            ells = [(c, np.array([rk, rk, rv]) * 0.46)]
            ells += [(s_['c'], np.array([s_['r'], s_['r'], s_['rv']]) * 0.55) for s_ in q['subs']]
            t = np.zeros(len(V0))
            for vi, d in enumerate(V0):
                best = 0.0
                for ec, er in ells:
                    o = (c - ec) / er
                    dd = d / er
                    a_, b_, c_ = dd @ dd, 2 * (o @ dd), o @ o - 1
                    disc = b_ * b_ - 4 * a_ * c_
                    if disc > 0:
                        best = max(best, (-b_ + math.sqrt(disc)) / (2 * a_))
                t[vi] = best if best > 0 else 0.4 * rk
            t = 0.5 * t + 0.5 * np.array([t[n].mean() for n in nb])
            t *= rng.uniform(0.94, 1.06, len(t))
            P = c + V0 * t[:, None] + np.array([0, 0, 0.12 * rv])
            low = V0[:, 2] < 0
            P[low, 2] = c[2] + 0.12 * rv + (P[low, 2] - c[2] - 0.12 * rv) * 0.75
            dims = np.array([rk, rk, rv])
            Nn, C = [], []
            for p in P:
                out = J.norm(0.55 * (p - c) / dims + 0.45 * (p - self.crown_c) / self.R)
                Nn.append(out)
                hz = np.clip((p[2] - (self.Hb - 1)) / max(self.H - self.Hb + 1, 1), 0, 1)
                ao = (0.32 + 0.38 * hz ** 0.8 + 0.12 * (out[2] * 0.5 + 0.5)) * 0.85
                g = 0.7 + 0.06 * min(1.0, np.linalg.norm(p - c) / rk)
                C.append((min(ao, 1.0), g, 0.06, q['phase']))
            b = mb.verts(P, np.array(C), np.array(Nn))
            for f in F0:
                p0, p1, p2 = P[f[0]], P[f[1]], P[f[2]]
                e1 = J.norm(p1 - p0)
                e2 = np.cross(J.norm(np.cross(p1 - p0, p2 - p0)), e1)
                loc = np.array([[0.0, 0.0], [np.dot(p1 - p0, e1), 0.0], [np.dot(p2 - p0, e1), np.dot(p2 - p0, e2)]]) / tphys
                th = rng.uniform(0, 2 * math.pi)
                loc = loc @ np.array([[math.cos(th), math.sin(th)], [-math.sin(th), math.cos(th)]])
                ext = loc.max(0) - loc.min(0)
                s = min(1.0, 0.94 / max(float(ext.max()), 1e-6))
                loc = (loc - loc.min(0)) * s
                ext = ext * s
                loc += np.array([rng.uniform(0.03, max(0.03, 0.97 - ext[0])), rng.uniform(0.03, max(0.03, 0.97 - ext[1]))])
                uvs = [(r[0] + u_ * (r[2] - r[0]), r[1] + v_ * (r[3] - r[1])) for u_, v_ in loc]
                mb.face((b + f[0], b + f[1], b + f[2]), uvs, 1)
        return mb.tris() - t0

    def make_subclumps(self):
        """Each clump = 4-8 flattened sub-clumps spread through its upper / outer half (lumps within lumps)."""
        rng = np.random.default_rng(self.sp['seed'] + 3)
        for q in self.clumps:
            c, rk, rv = q['c'], q['r'], q['rv']
            outc = c - self.crown_c
            outc[2] = 0
            outc = J.norm(outc + np.array([1e-3, 0, 0]))
            n = int(np.clip(round(rk / 0.6), 4, 8))
            subs = []
            for k in range(n * 5):
                if len(subs) >= n:
                    break
                az = rng.uniform(0, 2 * math.pi)
                el = math.asin(rng.uniform(-0.45, 1.0))
                u = np.array([math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el)])
                if np.dot(u, outc) < -0.6 and rng.uniform() < 0.6:
                    continue
                rs = rk * rng.uniform(0.38, 0.55)
                sc = c + u * np.array([rk, rk, rv]) * rng.uniform(0.3, 0.8)
                if all(np.linalg.norm(sc - o['c']) > 0.7 * (rs + o['r']) for o in subs):
                    subs.append(dict(c=sc, r=rs, rv=rs * rng.uniform(0.62, 0.78)))
            q['subs'] = subs

    # ------------------------------------------------------------------------------------------ wood: trunk
    def trunk(self, mb, lod):
        """Trunk with plank buttresses (LOD0/1) as lofted rings; returns nothing (adds to mb)."""
        fins = self.fins
        if lod == 2:
            return self.trunk_lod2(mb)
        nf_side = 5 if lod == 0 else 2
        fr = np.array([0.0, 0.1, 0.3, 0.55, 0.8])[:nf_side] if lod == 0 else np.array([0.0, 0.5])
        n_arc = 24 if lod == 0 else 10
        # ring heights in the buttress zone (+ seams)
        zb = [SINK, -0.25, 0.0, 0.15, 0.38, 0.7, 1.1, 1.6, 2.25, 3.0, 3.9, 4.9, 6.1, 7.5]
        if lod == 1:
            zb = [SINK, 0.0, 0.3, 0.8, 1.6, 2.6, 3.9, 5.5, 7.4]
        zb = [z for z in zb if z < self.z_fade] + [self.z_fade]
        zb = sorted(set([round(z, 4) for z in zb] + [s for s in seam_heights(self.z_fade) if s < self.z_fade]))
        zb = np.array(zb)
        # arc vertex angles between fins (constant across rings)
        gaps = []
        for i, f in enumerate(fins):
            g = fins[(i + 1) % len(fins)]
            a0 = f['th'] + f['w']
            a1 = g['th'] - g['w'] + (2 * math.pi if i == len(fins) - 1 else 0)
            gaps.append((a0, a1))
        span = np.array([a1 - a0 for a0, a1 in gaps])
        counts = np.maximum(2, np.round(n_arc * span / span.sum()).astype(int))
        layout = []  # per ring vertex: (kind, fin, frac, side, angle)
        for i, f in enumerate(fins):
            for k, fv in enumerate(fr):
                layout.append(('fin', i, fv, -1))
            layout.append(('tip', i, 1.0, 0))
            for k, fv in enumerate(fr[::-1]):
                layout.append(('fin', i, fv, 1))
            a0, a1 = gaps[i]
            for j in range(counts[i]):
                a = a0 + (a1 - a0) * (j + 0.5) / counts[i]
                layout.append(('arc', i, a, 0))
        nring = len(layout)
        n_wrap = max(1, round(2 * math.pi * self.r13 / BARK_W))

        def u_ang(a):
            return n_wrap * a / (2 * math.pi)

        rings, ring_uv = [], []
        for z in zb:
            C = self.centre(z)
            rz = self.radius(z)
            pts, us, aos = [], [], []
            for (kind, fi, fv, side) in layout:
                if kind == 'arc':
                    a = fv
                    r = rz * self.lobes(a, z)
                    pts.append(C + np.array([math.cos(a) * r, math.sin(a) * r, 0]))
                    us.append(u_ang(a))
                    # enclosure AO between fins near the ground
                    aos.append(0.55 + 0.45 * smooth(0.0, 3.5, z))
                    continue
                f = fins[fi]
                th = f['th']
                er = np.array([math.cos(th), math.sin(th), 0.0])
                et = np.array([-math.sin(th), math.cos(th), 0.0])
                d = self.fin_extent(f, z)
                fade = 1.0 - smooth(f['h'], self.z_fade, z) if z > f['h'] else 1.0
                zz = max(z, 0.0)
                ht = f['t'] / 2 * (0.55 + 0.45 * max(0.0, 1 - zz / f['h']) ** 0.5)
                ra = rz * self.lobes(th, z) * 0.97
                if kind == 'tip':
                    dd = d
                    rr, ss = self.fin_curve(f, dd)
                    tipx = ht * (0.9 if d > 0.05 else 0.6)
                    P_fin = C + er * (ra + rr + tipx) + et * ss
                    a_c = th
                    u_fin = u_ang(th) - (dd + tipx) / BARK_W
                    hf = 0
                else:
                    dd = fv * d
                    rr, ss = self.fin_curve(f, dd)
                    # local normal of the fin centreline
                    eps = 0.02
                    r2, s2 = self.fin_curve(f, dd + eps)
                    tg = J.norm(er * (r2 - rr) + et * (s2 - ss) + er * 1e-9)
                    nb = np.cross(np.array([0, 0, 1.0]), tg)
                    thick = ht * (1 + 1.6 * (1 - fv) ** 3)
                    P_fin = C + er * (ra + rr) + et * ss + nb * thick * side
                    a_c = th + side * f['w'] * (1 - fv) * 0.999
                    u_fin = u_ang(th + side * f['w']) - dd / BARK_W - (1 - fv) * 0.0
                    hf = fv
                r = rz * self.lobes(a_c, z)
                P_col = C + np.array([math.cos(a_c) * r, math.sin(a_c) * r, 0])
                u_col = u_ang(a_c)
                if z > f['h']:
                    P = P_col * (1 - fade) + P_fin * fade
                    u = u_col * (1 - fade) + u_fin * fade
                else:
                    P = P_fin
                    u = u_fin
                pts.append(P)
                us.append(u)
                ao = 0.5 + 0.5 * smooth(0.0, 3.0, z)
                ao = ao * (0.75 + 0.25 * hf) if kind != 'tip' else min(1.0, ao * 1.15)
                aos.append(ao)
            pts = np.array(pts)
            G = self.g_trunk(z)
            cols = np.stack([np.clip(aos, 0, 1), np.full(nring, G), np.zeros(nring), np.full(nring, self.phase)], -1)
            rings.append(mb.verts(pts, cols) + np.arange(nring))
            ring_uv.append(np.array(us))
        for k in range(len(zb) - 1):
            va, vb = v_band(zb[k], zb[k + 1])
            A, B = rings[k], rings[k + 1]
            ua, ub = ring_uv[k], ring_uv[k + 1]
            for j in range(nring):
                j2 = (j + 1) % nring
                u0a, u1a, u0b, u1b = ua[j], ua[j2], ub[j], ub[j2]
                if j2 == 0:  # close the ring: continue u past the wrap
                    u1a += n_wrap
                    u1b += n_wrap
                mb.face((A[j], A[j2], B[j2], B[j]), [(u0a, va), (u1a, va), (u1b, vb), (u0b, vb)], 0)
        # upper trunk
        sides = 22 if lod == 0 else 9
        zs = [self.z_fade]
        step = 1.3 if lod == 0 else 3.0
        while zs[-1] + step < self.Hb + 0.4:
            zs.append(zs[-1] + step)
        zs.append(self.Hb + 0.4)
        zs = sorted(set([round(z, 4) for z in zs] + [s for s in seam_heights(self.Hb) if self.z_fade < s < self.Hb + 0.4]))
        ang = np.linspace(0, 2 * math.pi, sides, endpoint=False) + 0.01
        up_rings = []
        for z in zs:
            C = self.centre(z)
            r = self.radius(z) * self.lobes(ang, z)
            pts = C + np.stack([np.cos(ang) * r, np.sin(ang) * r, np.zeros(sides)], -1)
            G = self.g_trunk(z)
            ao = 0.85 + 0.15 * smooth(self.Hb - 3, self.Hb - 6, z) if z > self.Hb - 6 else 1.0
            cols = np.stack([np.full(sides, ao), np.full(sides, G), np.zeros(sides), np.full(sides, self.phase)], -1)
            up_rings.append(mb.verts(pts, cols) + np.arange(sides))
        # stitch last buttress ring to first upper ring by angle
        A = rings[-1]
        posA = np.concatenate(mb.V)[A] if False else None
        angA = []
        for (kind, fi, fv, side) in layout:
            if kind == 'arc':
                angA.append(fv)
            else:
                f = fins[fi]
                angA.append(f['th'] + (0 if kind == 'tip' else side * f['w'] * (1 - fv) * 0.999))
        angA = np.array(angA) % (2 * math.pi)
        self.stitch(mb, A, angA, ring_uv[-1], up_rings[0], ang % (2 * math.pi), u_ang(ang), zb[-1], zs[0], n_wrap)
        for k in range(len(zs) - 1):
            va, vb = v_band(zs[k], zs[k + 1])
            A, B = up_rings[k], up_rings[k + 1]
            for j in range(sides):
                j2 = (j + 1) % sides
                ua, ub = u_ang(ang[j]), u_ang(ang[j2]) + (n_wrap if j2 == 0 else 0)
                mb.face((A[j], A[j2], B[j2], B[j]), [(ua, va), (ub, va), (ub, vb), (ua, vb)], 0)
        # cap
        top = up_rings[-1]
        c = mb.verts(self.centre(zs[-1]) + np.array([0, 0, 0.25 * self.radius(zs[-1])]),
                     (0.6, self.g_trunk(zs[-1]), 0, self.phase))
        for j in range(sides):
            j2 = (j + 1) % sides
            mb.face((top[j], top[j2], c), [(u_ang(ang[j]), 0.1), (u_ang(ang[j2]) + (n_wrap if j2 == 0 else 0), 0.1), (0.5, 0.2)], 0)

    def stitch(self, mb, A, angA, uA, B, angB, uB, za, zb_, n_wrap):
        """Zipper triangulation between two closed rings ordered by angle (both increasing)."""
        va, vb = v_band(za, zb_)
        ia = int(np.argmin(angA))
        ib = int(np.argmin(angB))
        na, nb = len(A), len(B)
        oa = [(ia + k) % na for k in range(na + 1)]
        ob = [(ib + k) % nb for k in range(nb + 1)]

        def ua_(k):
            a = angA[oa[k]] + (2 * math.pi if k >= na or (k > 0 and angA[oa[k]] < angA[oa[0]]) else 0)
            return n_wrap * a / (2 * math.pi), a

        def ub_(k):
            a = angB[ob[k]] + (2 * math.pi if k >= nb or (k > 0 and angB[ob[k]] < angB[ob[0]]) else 0)
            return n_wrap * a / (2 * math.pi), a
        i = j = 0
        while i < na or j < nb:
            uai, aai = ua_(i)
            ubj, abj = ub_(j)
            if j >= nb or (i < na and ua_(i + 1)[1] <= ub_(j + 1)[1]):
                u2, _ = ua_(i + 1)
                mb.face((A[oa[i]], A[oa[i + 1]], B[ob[j]]), [(uai, va), (u2, va), (ubj, vb)], 0)
                i += 1
            else:
                u2, _ = ub_(j + 1)
                mb.face((A[oa[i]], B[ob[j + 1]], B[ob[j]]), [(uai, va), (u2, vb), (ubj, vb)], 0)
                j += 1

    def trunk_lod2(self, mb):
        sides = 6
        zs = [SINK, 1.0, self.Hb * 0.5, self.Hb + 0.3]
        ang = np.linspace(0, 2 * math.pi, sides, endpoint=False)
        rings = []
        for z in zs:
            C = self.centre(z)
            r = self.radius(z) * (1.25 if z < 1.5 else 1.0)
            pts = C + np.stack([np.cos(ang) * r, np.sin(ang) * r, np.zeros(sides)], -1)
            G = self.g_trunk(z)
            rings.append(mb.verts(pts, (0.7, G, 0, self.phase)) + np.arange(sides))
        for k in range(len(zs) - 1):
            for j in range(sides):
                j2 = (j + 1) % sides
                u0, u1 = j / sides, (j + 1) / sides
                mb.face((rings[k][j], rings[k][j2], rings[k + 1][j2], rings[k + 1][j]), [(u0, 0.05), (u1, 0.05), (u1, 0.45), (u0, 0.45)], 0)

    # ------------------------------------------------------------------------------------------ wood: limbs
    def limb_tube(self, mb, l, lod):
        sides = {0: (10, 7), 1: (6, 4), 2: (3, 3)}[lod][l['level']]
        spacing = BARK_W / ({0: (3 if l['level'] == 0 else 2), 1: 1, 2: 1}[lod])
        path = J.catmull(l['ctrl'], 6)
        s = J.arclen(path)
        n = max(2, int(math.ceil(s[-1] / spacing)))
        ss = np.linspace(0, s[-1], n + 1)
        P = np.stack([np.interp(ss, s, path[:, i]) for i in range(3)], -1)
        t = ss / s[-1]
        radii = l['r0'] * (1 - t) + l['r1'] * t
        radii = radii * (1 + 0.22 * np.exp(-ss / max(l['r0'] * 2, 0.2)))
        g0, g1 = l['g0'], l['g1']
        ph = l['phase']

        def colf(i, f, a):
            ao = 0.85 - 0.25 * f if l['level'] == 0 else 0.7 - 0.2 * f
            return np.tile([ao, g0 + (g1 - g0) * f, 0.0, ph], (len(a), 1))
        n_wrap = max(1, round(2 * math.pi * l['r0'] / BARK_W))
        v0 = self.rng.integers(0, 4) * spacing / BARK_W * 0.5
        J.tube(mb, P, radii, sides, colf, mat=0, u_wrap=n_wrap, v_scale=0.5 / BARK_W, v0=v0, seg_v=v_seg_clean)
        return P

    # ------------------------------------------------------------------------------------------ foliage
    def card(self, mb, at, tile, base, fwd, nrm, scale, g_att, phase, clump, lod, fold=0.12, sub=None, folded=True):
        """Folded leaf-cluster card. base = attachment point (tile pivot), fwd = direction to the card top."""
        (x0, x1, y0, y1), (cu0, cu1, cv0, cv1, px, py), uv = at.card_geom(tile)
        fwd = J.norm(fwd)
        nrm = J.norm(nrm - fwd * np.dot(nrm, fwd))
        side = np.cross(fwd, nrm)
        xs = np.array([x0, 0.0, x1]) * scale if folded else np.array([x0, x1]) * scale
        ys = np.array([y0, y1]) * scale
        tus = np.array([cu0, px, cu1]) if folded else np.array([cu0, cu1])
        tvs = np.array([cv0, cv1])
        width = (x1 - x0) * scale
        P, Nn, C = [], [], []
        c, rk = clump['c'], clump['r']
        sb = sub if sub is not None else clump
        for yi, y in enumerate(ys):
            for xi, x in enumerate(xs):
                z = (0 if (not folded or xi == 1) else fold * width)
                p = base + side * x + fwd * y + nrm * z
                P.append(p)
                out = J.norm(0.45 * (p - sb['c']) / max(sb['r'], 0.1) + 0.35 * (p - c) / max(rk, 0.1)
                             + 0.2 * (p - self.crown_c) / self.R)
                Nn.append(J.norm(0.4 * nrm + 0.6 * out))
                # AO: depth in the sub-clump and clump, height in the crown, facing up
                dsb = np.linalg.norm((p - sb['c']) / np.array([sb['r'], sb['r'], sb['rv']]))
                dcl = 0.5 * np.linalg.norm((p - c) / np.array([rk, rk, clump['rv']])) + 0.5 * dsb
                hz = np.clip((p[2] - (self.Hb - 1)) / max(self.H - self.Hb + 1, 1), 0, 1)
                ao = 0.25 + 0.75 * (0.55 * smooth(0.3, 1.05, dcl) + 0.45 * hz ** 0.7)
                ao *= 0.78 + 0.22 * (out[2] * 0.5 + 0.5)
                fy = (y - ys[0]) / max(ys[1] - ys[0], 1e-6)
                fx = abs(x) / max(abs(x0 if x < 0 else x1) * scale, 1e-6) if x != 0 else 0.0
                g = min(1.0, g_att + (1.0 - g_att) * 0.55 * fy)
                fl = min(1.0, 0.25 + 0.6 * fy + 0.3 * fx)
                C.append((min(ao, 1.0), g, fl, phase))
        b = mb.verts(np.array(P), np.array(C), np.array(Nn))
        nx = len(xs)
        for xi in range(nx - 1):
            i00, i01 = b + xi, b + xi + 1
            i10, i11 = b + nx + xi, b + nx + xi + 1
            mb.face((i00, i01, i11, i10), [uv(tus[xi], tvs[0]), uv(tus[xi + 1], tvs[0]), uv(tus[xi + 1], tvs[1]),
                                           uv(tus[xi], tvs[1])], 1)
        return 2 * (nx - 1)

    def foliage(self, mb, at, lod, budget):
        rng = np.random.default_rng(self.sp['seed'] + 7 + lod)
        cr = self.sp['crown']
        tiles = cr['tiles']
        ctile = cr['clump_tile']
        used = 0
        subs = [(q, s_) for q in self.clumps for s_ in q['subs']]
        if lod == 0:  # tertiary branches into some sub-clumps (the hull hides the rest)
            t0 = mb.tris()
            for q, s_ in subs:
                if rng.uniform() > 0.35:
                    continue
                st = q['c'] - np.array([0, 0, q['rv'] * 0.35])
                en = s_['c'] - np.array([0, 0, s_['rv'] * 0.3])
                mid = 0.5 * (st + en) + np.array([0, 0, 0.25]) + rng.normal(0, 0.15, 3)
                ph = q['phase']
                cols = lambda i, f, a, p=ph: np.tile([0.55 + 0.15 * f, 0.68 + 0.08 * f, 0.0, p], (len(a), 1))
                r0 = 0.045
                path = J.catmull(np.array([st, mid, en]), 2)
                radii = np.linspace(r0, r0 * 0.45, len(path))
                J.tube(mb, path, radii, 3, cols, mat=0, u_wrap=1, v_scale=0.5 / BARK_W, seg_v=v_seg_clean)
            used = mb.tris() - t0
        if lod == 2:
            groups = [(q, dict(c=q['c'], r=q['r'], rv=q['rv'])) for q in self.clumps]
        else:
            groups = subs
        area = np.array([g['r'] * (g['r'] + g['rv']) for _, g in groups])
        share = area / area.sum()
        if lod == 0:
            per = dict(core=0.55, spray=0.45)
            tri = {'core': 2, 'spray': 4 + 12 / 6}
        elif lod == 1:
            per = dict(core=0.8, spray=0.2)
            tri = {'core': 2, 'spray': 2}
        else:
            per = dict(core=1.0, spray=0.0)
            tri = {'core': 2, 'spray': 2}
        cost = per['core'] * tri['core'] + per['spray'] * tri['spray']
        ncards = int(max(budget - used, 0) / cost)
        for gi, (q, g) in enumerate(groups):
            n = int(round(ncards * share[gi]))
            ncore = int(round(n * per['core']))
            c, rk, rv = g['c'], g['r'], g['rv']
            for k in range(n):
                core = k < ncore
                for _ in range(8):
                    az = rng.uniform(0, 2 * math.pi)
                    # core cards wrap the hull all round (it must not show from below); sprays favour the top
                    el = math.asin(rng.uniform(-0.85, 1.0) if core and lod < 2 else rng.uniform(-0.45, 1.0))
                    u = np.array([math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el)])
                    outc = J.norm(c - self.crown_c + np.array([0, 0, 1e-3]))
                    if np.dot(u, outc) > -0.4 or rng.uniform() < 0.3:
                        break
                if core:
                    tile = ctile
                    tsz = at.t[ctile]['size']
                    fit = float(np.clip(1.7 * rk / tsz, 0.38, 1.0))
                    scale = {0: rng.uniform(0.85, 1.1) * min(fit, 0.85), 1: rng.uniform(0.9, 1.1) * min(fit * 1.25, 1.1),
                             2: rng.uniform(1.3, 1.7)}[lod]
                    depth = rng.uniform(0.62, 1.0) if lod < 2 else rng.uniform(0.7, 1.05)
                    surf = c + u * np.array([rk, rk, rv]) * depth
                    nrm = J.norm(u * 0.85 + rng.normal(0, 0.35, 3))
                    fwd = J.norm(np.cross(nrm, J.perp(nrm)) + rng.normal(0, 0.3, 3))
                    base = surf
                else:
                    tile = tiles[0] if rng.uniform() > q['young'] else tiles[1]
                    if rng.uniform() < 0.2:
                        tile = tiles[2]
                    if rng.uniform() < cr['dead'] * (2.0 if u[2] < 0 else 0.6):
                        tile = 'dead_spray'
                    scale = rng.uniform(1.0, 1.4) if lod == 0 else rng.uniform(1.4, 1.8)
                    (x0, x1, y0, y1), _, _ = at.card_geom(tile)
                    clen = (y1 - y0) * scale
                    surf = c + u * np.array([rk, rk, rv]) * rng.uniform(0.85, 1.18)
                    fwd = J.norm(u + np.array([0, 0, rng.uniform(-0.45, 0.1)]) + rng.normal(0, 0.45, 3))
                    base = surf - fwd * clen * 0.55
                    nrm = J.norm(np.array([0, 0, 1.0]) * 0.5 + u * 0.5 + rng.normal(0, 0.35, 3))
                g_att = 0.7 + 0.1 * min(1.0, np.linalg.norm(base - q['c']) / max(q['r'], 0.1))
                ph = float((q['phase'] + rng.normal(0, 0.12)) % 1.0)
                used += self.card(mb, at, tile, base, fwd, nrm, scale, g_att, ph, q, lod, sub=g, folded=(lod == 0 and not core))
                if lod == 0 and not core and k % 12 == 0:
                    st = c - np.array([0, 0, rv * 0.3]) + rng.normal(0, 0.1, 3)
                    mid = 0.5 * (st + base) + np.array([0, 0, rng.uniform(0.0, 0.2)])
                    cols = lambda i, f, a, gg=g_att, p=q['phase']: np.tile([0.6 + 0.3 * f, 0.74 + (gg - 0.74) * f, 0, p], (len(a), 1))
                    J.tube(mb, [st, mid, base], [0.022, 0.015, 0.009], 3, cols, mat=0, u_wrap=1, v_scale=0.5 / BARK_W,
                           seg_v=v_seg_clean)
                    used += 12
        return used

    # ------------------------------------------------------------------------------------------ extras
    def limb_point(self, rng, level=0, frac=(0.3, 0.9)):
        ls = [l for l in self.limbs if l['level'] == level]
        l = ls[rng.integers(0, len(ls))]
        P = J.catmull(l['ctrl'], 4)
        i = int(rng.uniform(*frac) * (len(P) - 1))
        return P[i], l

    def twin(self, mb, path, radii, colf, frac=0.7, r2=0.02, pitch=0.5):
        """Second strand twined round the first part of a liana path."""
        T_, N_, B_ = J.frames(path)
        m = max(4, int(len(path) * frac))
        tw = [path[i] + (N_[i] * math.cos(i * pitch) + B_[i] * math.sin(i * pitch)) * (radii[i] + r2 * 0.9)
              for i in range(m)]
        J.tube(mb, np.array(tw), np.full(m, r2), 4, colf, mat=0, u_wrap=1, v_scale=0.5 / BARK_W, seg_v=v_seg_clean)

    def lianas(self, mb, lod):
        """Woody lianas, thick (4.5-8.5 cm) and twisting: climbers that rise from the forest floor with a sag, spiral
        loosely round the trunk, run out along a limb into the crown and drop from a clump; and deep loops hanging
        between two limbs (twin strands twined at LOD0). LOD1 keeps the climbers only."""
        rng = np.random.default_rng(self.sp['seed'] + 31)
        prims = [x for x in self.limbs if x['level'] == 0 and x['parent'] is not None]
        order = rng.permutation(len(prims))
        sides, sub = (6, 2) if lod == 0 else (3, 1)
        c0 = self.centre(0.0)
        for k in range(self.sp['lianas']):
            l = prims[order[k % len(prims)]]
            r = rng.uniform(0.045, 0.085)
            ph = float(rng.uniform())
            a0 = rng.uniform(0, 2 * math.pi)
            dg = self.radius(0.3) + rng.uniform(1.4, 3.6)
            G = np.array([c0[0] + math.cos(a0) * dg, c0[1] + math.sin(a0) * dg, -0.35])
            pts = [G, G + np.array([rng.normal(0, 0.2), rng.normal(0, 0.2), 0.45])]
            z_touch = rng.uniform(3.0, 7.5)
            for i in range(1, 5):  # hangs in a sag between the ground and where it grips the trunk
                t = i / 5
                zt = 0.45 + (z_touch - 0.45) * t
                ct = self.centre(zt)
                rad = self.radius(zt) + r + (dg - self.radius(0.3)) * (1 - t) ** 1.4
                a = a0 + 0.35 * t
                pts.append(np.array([ct[0] + math.cos(a) * rad, ct[1] + math.sin(a) * rad, zt - 0.9 * math.sin(math.pi * t)]))
            z_top = float(min(l['start'][2], self.Hb + 1.5)) - 0.4
            turns = rng.uniform(0.7, 1.5) * (1 if rng.uniform() < 0.5 else -1)
            for i in range(1, 11):  # loose spiral up the trunk
                t = i / 10
                zt = z_touch + (z_top - z_touch) * t
                ct = self.centre(zt)
                a = a0 + 0.35 + turns * 2 * math.pi * t
                rad = self.radius(zt) + r * 1.05 + 0.04 * math.sin(t * 11 + k)
                pts.append(np.array([ct[0] + math.cos(a) * rad, ct[1] + math.sin(a) * rad, zt]))
            Pl = J.catmull(l['ctrl'], 2)
            nl = len(Pl)
            for i in range(1, int(nl * rng.uniform(0.7, 0.95)), 2):  # out along the limb, riding on its upper side
                f = i / (nl - 1)
                lr = l['r0'] + (l['r1'] - l['r0']) * f
                pts.append(Pl[i] + np.array([0, 0, lr + r * 0.9]) + rng.normal(0, 0.05, 3))
            end = pts[-1]
            drop = rng.uniform(2.5, 6.0)  # and falls out of the crown in a swinging curve
            dd = J.norm(np.array([rng.normal(), rng.normal(), 0.0]))
            for i in range(1, 4):
                t = i / 3
                pts.append(end + dd * 0.8 * math.sin(math.pi * t * 0.8) + np.array([0, 0, -drop * t]))
            path = J.catmull(np.array(pts), sub)
            npth = len(path)
            radii = r * (1.15 - 0.45 * np.linspace(0, 1, npth))
            ig = 6 + 10 * sub  # roughly where the stem leaves the trunk for the limb

            def colf(i, f, a, ph=ph, n=npth, ig=ig):
                g = 0.04 + 0.3 * min(1.0, i / max(ig, 1)) + 0.35 * max(0.0, (i - ig) / max(n - ig, 1))
                return np.tile([0.45 + 0.35 * f, min(g, 0.72), 0.0, ph], (len(a), 1))
            J.tube(mb, path, radii, sides, colf, mat=0, u_wrap=1, v_scale=0.5 / BARK_W, seg_v=v_seg_clean, twist=1.6)
            if lod == 0 and k % 2 == 0:
                self.twin(mb, path, radii, colf, frac=0.55, r2=r * 0.4)
        if lod > 0:
            return
        for k in range(self.sp['loops'] + (1 if self.sp['lianas'] else 0)):
            l1, l2 = prims[order[(2 * k) % len(prims)]], prims[order[(2 * k + 1) % len(prims)]]
            P1 = J.catmull(l1['ctrl'], 2)
            P2 = J.catmull(l2['ctrl'], 2)
            A = P1[int(rng.uniform(0.35, 0.85) * (len(P1) - 1))]
            B = P2[int(rng.uniform(0.35, 0.85) * (len(P2) - 1))]
            sag = rng.uniform(3.5, 8.5)
            r = rng.uniform(0.035, 0.065)
            ph = float(rng.uniform())
            sw = J.norm(np.array([rng.normal(), rng.normal(), 0.0])) * rng.uniform(0.3, 1.0)
            pts = [A + (B - A) * t + np.array([0, 0, -sag * 4 * t * (1 - t)]) + sw * math.sin(math.pi * t)
                   for t in np.linspace(0, 1, 11)]
            path = J.catmull(np.array(pts), 2)
            radii = np.full(len(path), r)

            def colf(i, f, a, ph=ph):
                return np.tile([0.5 + 0.25 * math.sin(math.pi * f), 0.6 + 0.12 * math.sin(math.pi * f), 0.0, ph], (len(a), 1))
            J.tube(mb, path, radii, 5, colf, mat=0, u_wrap=1, v_scale=0.5 / BARK_W, seg_v=v_seg_clean, twist=1.2)
            self.twin(mb, path, radii, colf, frac=1.0, r2=r * 0.45, pitch=0.42)

    def aerial_roots(self, mb, lod):
        """Fig aerial roots: wavy, kinked cords; most reach the ground and thicken there (future pillar roots), the
        rest end 1.5-4 m up; some braided in pairs."""
        rng = np.random.default_rng(self.sp['seed'] + 41)
        for k in range(int(self.sp['aerial'] * 0.6) if lod == 0 else self.sp['aerial'] // 4):
            grounded = rng.uniform() < 0.7
            # rooted ones drop from near the trunk and thicken into pillar roots; the rest hang short and wavy
            P0, l = self.limb_point(rng, level=0 if grounded else rng.integers(0, 2), frac=(0.1, 0.45) if grounded else (0.3, 0.95))
            end_z = -0.3 if grounded else rng.uniform(2.0, 5.0)
            n = max(5, int((P0[2] - end_z) / 1.4))
            drift = np.array([rng.normal(0, 0.6), rng.normal(0, 0.6), 0.0])
            walk = np.zeros(3)
            pts = [P0]
            for i in range(1, n + 1):
                t = i / n
                walk[:2] += rng.normal(0, 0.3, 2)
                pts.append(P0 + drift * t + walk * math.sin(math.pi * min(t * 1.2, 1.0))
                           + np.array([0, 0, -(P0[2] - end_z) * t]))
            path = J.catmull(np.array(pts), 2 if lod == 0 else 1)
            f = np.linspace(0, 1, len(path))
            r = rng.uniform(0.012, 0.022) if not grounded else rng.uniform(0.028, 0.05)
            radii = r * (1.2 - 0.4 * f) if not grounded else r * (0.8 + 1.4 * f ** 2.5)
            ph = float(rng.uniform())

            def colf(i, f, a, ph=ph, gr=grounded):
                return np.tile([0.55 + 0.1 * f, 0.5 + (0.0 if gr else 0.4) * f, 0.0 if gr else 0.15 * f, ph], (len(a), 1))
            J.tube(mb, path, radii, 4 if lod == 0 else 3, colf, mat=0, u_wrap=1, v_scale=0.5 / BARK_W,
                   seg_v=v_seg_clean, twist=0.8)
            if lod == 0 and k % 3 == 0:
                self.twin(mb, path, radii, colf, frac=0.8, r2=r * 0.7, pitch=0.35)

    def rosette(self, mb, at, tile, centre, n, length, width_scale, elev, droop, g_att, phase, rng, lod, nseg=5,
                dead_frac=0.15):
        """Epiphyte rosette (bird's-nest fern / bromeliad): strap leaves from a centre."""
        subs = at.t[tile]['subs']
        tris = 0
        for k in range(n):
            az = rng.uniform(0, 2 * math.pi)
            dead = rng.uniform() < dead_frac
            vi = 3 if dead else rng.integers(0, 3)
            s, uv = at.sub(tile, vi)
            L = length * rng.uniform(0.7, 1.15)
            W = s['width'] * L / s['length'] * width_scale
            el = math.radians(rng.uniform(*elev)) - (0.6 if dead else 0)
            d0 = np.array([math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el)])
            side = J.norm(np.cross(d0, np.array([0, 0, 1.0])) + 1e-6)
            P, C, UV = [], [], []
            pos = centre + d0 * 0.04
            d = d0.copy()
            ns = nseg if lod == 0 else 2
            for i in range(ns + 1):
                t = i / ns
                if i > 0:
                    d = J.norm(d + np.array([0, 0, -droop * (1.6 if dead else 1.0) / ns]))
                    pos = pos + d * L / ns
                up = J.norm(np.cross(side, d))
                fold = 0.18 * W
                for sx in (-1, 0, 1):
                    p = pos + side * sx * W / 2 + up * (fold * abs(sx))
                    P.append(p)
                    C.append((0.45 + 0.5 * t, min(1, g_att + 0.3 * t), min(1, 0.1 + 0.9 * t * t + 0.2 * abs(sx) * t), phase))
                    UV.append(uv(0.5 + 0.5 * sx * 0.96, 0.02 + 0.96 * t))
            b = mb.verts(np.array(P), np.array(C))
            for i in range(ns):
                for j in range(2):
                    a0 = b + i * 3 + j
                    idx = (a0, a0 + 1, a0 + 4, a0 + 3)
                    mb.face(idx, [UV[i * 3 + j], UV[i * 3 + j + 1], UV[(i + 1) * 3 + j + 1], UV[(i + 1) * 3 + j]], 1)
                    tris += 2
        return tris

    def epiphytes(self, mb, at, lod):
        rng = np.random.default_rng(self.sp['seed'] + 53)
        for k in range(self.sp['nests']):
            l = [x for x in self.limbs if x['level'] == 1][rng.integers(0, len([x for x in self.limbs if x['level'] == 1]))]
            P = l['ctrl'][rng.integers(0, 2)]
            self.rosette(mb, at, 'strap_singles', P + np.array([0, 0, 0.1]), 15 if lod == 0 else 8, rng.uniform(0.7, 1.05),
                         1.0, (15, 65), 1.3, 0.5, float(rng.uniform()), rng, lod, nseg=4, dead_frac=0.2)
        for k in range(self.sp['broms']):
            P, l = self.limb_point(rng, level=rng.integers(0, 2), frac=(0.15, 0.9))
            self.rosette(mb, at, 'brom_singles', P + np.array([0, 0, 0.12]), 12 if lod == 0 else 6, rng.uniform(0.35, 0.55),
                         1.2, (30, 75), 1.1, 0.5, float(rng.uniform()), rng, lod, nseg=3, dead_frac=0.1)

    def trunk_surface(self, z, a, off=0.0):
        """Point on the trunk surface (outside buttresses) at height z, angle a, offset outward by off."""
        C = self.centre(z)
        r = self.radius(z) * self.lobes(a, z) + off
        return C + np.array([math.cos(a) * r, math.sin(a) * r, 0.0]), np.array([math.cos(a), math.sin(a), 0.0])

    def climber(self, mb, at, lod):
        kind = self.sp['climber']
        if not kind:
            return
        rng = np.random.default_rng(self.sp['seed'] + 61)
        if kind == 'pothos':
            for s in range(2):
                a = rng.uniform(0, 2 * math.pi)
                z = 0.2
                ztop = rng.uniform(10, 15)
                pts = []
                while z < ztop:
                    p, n = self.trunk_surface(z, a, 0.03)
                    pts.append(p)
                    a += rng.normal(0.12, 0.15)
                    z += 0.35
                path = np.array(pts)
                J.tube(mb, path, np.full(len(path), 0.014), 4 if lod == 0 else 3,
                       lambda i, f, aa: np.tile([0.55, 0.15 + 0.15 * f, 0, 0.3], (len(aa), 1)), mat=0, u_wrap=1,
                       v_scale=0.5 / BARK_W, seg_v=v_seg_clean)
                step = 2 if lod == 0 else 5
                for i in range(1, len(path) - 1, step):
                    zf = path[i][2] / ztop
                    p = path[i]
                    aa = math.atan2(p[1] - self.centre(p[2])[1], p[0] - self.centre(p[2])[0])
                    _, nrm = self.trunk_surface(p[2], aa)
                    tang = np.array([-nrm[1], nrm[0], 0.0]) * rng.choice([-1, 1])
                    fwd = J.norm(np.array([0, 0, 1.0]) * rng.uniform(0.4, 1.0) + tang * rng.uniform(-0.8, 0.8))
                    L = 0.16 + 0.26 * zf + rng.uniform(-0.03, 0.05)
                    s, uv = at.sub('cor_singles', rng.integers(0, 4))
                    W = L * s['width'] / s['length']
                    side = J.norm(np.cross(fwd, nrm))
                    base = p + nrm * 0.02
                    P, C, UV = [], [], []
                    for t in (0.0, 1.0):
                        for sx in (-1, 0, 1):
                            q = base + fwd * L * t + side * sx * W / 2 + nrm * (0.04 * t + 0.02 * abs(sx))
                            P.append(q)
                            C.append((0.6 + 0.3 * zf, 0.2 + 0.15 * zf, 0.3 + 0.5 * t, float(rng.uniform())))
                            UV.append(uv(0.5 + 0.5 * sx, t))
                    b = mb.verts(np.array(P), np.array(C), np.array([J.norm(nrm + fwd * 0.2)] * 6))
                    for j in range(2):
                        mb.face((b + j, b + j + 1, b + 4 + j, b + 3 + j), [UV[j], UV[j + 1], UV[4 + j], UV[3 + j]], 1)
        elif kind == 'figmat':
            a0 = rng.uniform(0, 2 * math.pi)
            n = 26 if lod == 0 else 8
            for k in range(n):
                z = rng.uniform(0.4, 9.0) ** 1.0
                a = a0 + rng.normal(0, 0.9)
                tile = 'fig_mat' if rng.uniform() < 0.7 else 'vine_strip'
                (x0, x1, y0, y1), (cu0, cu1, cv0, cv1, px, py), uv = at.card_geom(tile)
                sc = rng.uniform(0.9, 1.3)
                cols = 4 if lod == 0 else 2
                rows = 2
                P, C, UV = [], [], []
                w = (x1 - x0) * sc
                hgt = (y1 - y0) * sc
                ph = float(rng.uniform())
                for ri in range(rows + 1):
                    for ci in range(cols + 1):
                        fx, fy = ci / cols, ri / rows
                        zz = z + (fy - 0.5) * hgt
                        r_here = self.radius(zz)
                        aa = a + (fx - 0.5) * w / max(r_here, 0.2)
                        p, nrm = self.trunk_surface(zz, aa, 0.025)
                        P.append(p)
                        C.append((0.55 + 0.35 * smooth(0, 6, zz), 0.15 + 0.1 * zz / 9, 0.2 + 0.5 * fy * 0 + 0.4 * abs(fx - 0.5), ph))
                        UV.append(uv(cu0 + (cu1 - cu0) * fx, cv0 + (cv1 - cv0) * fy))
                Nn = []
                for p in P:
                    aa = math.atan2(p[1] - self.centre(p[2])[1], p[0] - self.centre(p[2])[0])
                    Nn.append(np.array([math.cos(aa), math.sin(aa), 0.15]))
                b = mb.verts(np.array(P), np.array(C), np.array(Nn))
                for ri in range(rows):
                    for ci in range(cols):
                        i00 = b + ri * (cols + 1) + ci
                        idx = (i00, i00 + 1, i00 + cols + 2, i00 + cols + 1)
                        mb.face(idx, [UV[ri * (cols + 1) + ci], UV[ri * (cols + 1) + ci + 1], UV[(ri + 1) * (cols + 1) + ci + 1],
                                      UV[(ri + 1) * (cols + 1) + ci]], 1)

    def strangler(self, mb, lod):
        if not self.sp['strangler']:
            return
        rng = np.random.default_rng(self.sp['seed'] + 71)
        n = 12 if lod == 0 else 6
        ztop = self.Hb + 0.5
        roots = []
        for k in range(n):
            a = 2 * math.pi * k / n + rng.uniform(-0.2, 0.2)
            z = ztop - rng.uniform(0, 3.0)
            pts, rs = [], []
            r0 = rng.uniform(0.05, 0.09)
            r1 = rng.uniform(0.12, 0.2)
            while z > 0.4:
                p, nrm = self.trunk_surface(z, a, 0.0)
                f = 1 - z / ztop
                rr = r0 + (r1 - r0) * f ** 1.5
                pts.append(p + nrm * rr * 0.55)
                rs.append(rr)
                a += rng.normal(0, 0.08)
                z -= 0.85
            # foot: splay outward onto the ground and sink
            p, nrm = self.trunk_surface(0.4, a, 0.0)
            for d, zz in ((0.25, 0.15), (0.7, 0.0), (1.2, -0.25), (1.6, -0.5)):
                pts.append(p + nrm * (rs[-1] + d) + np.array([0, 0, zz - 0.4]))
                rs.append(rs[-1] * (1.0 - 0.15 * d))
            roots.append((np.array(pts), np.array(rs)))
            sides = 5 if lod == 0 else 3
            path = np.array(pts)
            J.tube(mb, path, np.array(rs), sides, lambda i, f, aa: np.tile([0.5 + 0.35 * (1 - f), self.g_trunk(path[min(i, len(path) - 1)][2]), 0, self.phase], (len(aa), 1)),
                   mat=0, u_wrap=1, v_scale=0.5 / BARK_W, seg_v=v_seg_clean)
        if lod == 0:  # anastomosing bridges between neighbouring roots
            for k in range(7):
                i = rng.integers(0, n)
                j = (i + 1) % n
                pa, ra = roots[i]
                pb, rb = roots[j]
                m = min(len(pa), len(pb)) - 5
                if m < 2:
                    continue
                q = rng.integers(1, m)
                A, B = pa[q], pb[q]
                mid = 0.5 * (A + B)
                c = self.centre(mid[2])
                mid = c + J.norm(mid - c) * (np.linalg.norm(mid[:2] - c[:2]) + 0.12)
                mid[2] = 0.5 * (A[2] + B[2]) - 0.3
                J.tube(mb, J.catmull(np.array([A, mid, B]), 3), np.full(7, min(ra[q], rb[q]) * 0.7), 5,
                       lambda i, f, aa: np.tile([0.6, 0.2, 0, self.phase], (len(aa), 1)), mat=0, u_wrap=1,
                       v_scale=0.5 / BARK_W, seg_v=v_seg_clean)

    # ------------------------------------------------------------------------------------------ build
    def build(self, lod, at, mats):
        mb = J.MB()
        self.trunk(mb, lod)
        wood0 = mb.tris()
        for l in self.limbs:
            if lod == 2 and l['level'] == 1:
                continue
            self.limb_tube(mb, l, lod)
        if lod < 2:
            self.fill_stems(mb, lod)
            self.strangler(mb, lod)
            self.lianas(mb, lod)
        if lod == 0:
            self.aerial_roots(mb, lod)
            self.climber(mb, at, lod)
            self.epiphytes(mb, at, lod)
        hull = self.hulls(mb, at, lod)
        wood = mb.tris()
        bud = self.sp.get('budget', (21800, 4950, 980))
        budget = bud[lod] - wood
        leaves = self.foliage(mb, at, lod, budget)
        name = f"{self.sp.get('prefix', 'rainforest')}_{self.sp.get('key', self.key)}_lod{lod}"
        ob = mb.build(name, mats)
        print(f'{name}: trunk {wood0}, wood+extras+hull {wood} (hull {hull}, {len(self.clumps)} clumps, '
              f'{getattr(self, "n_fill", 0)} fill), total {mb.tris()} tris')
        return ob, mb.tris()


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    mid = '--set' in argv and argv[argv.index('--set') + 1] == 'mid'
    only = argv[argv.index('--only') + 1].split(',') if '--only' in argv else (MID_KEYS if mid else CANOPY_KEYS)
    blend = argv[argv.index('--blend') + 1] if '--blend' in argv else None
    J.reset_scene()
    at = Atlas()
    bark = J.pbr_material('canopy_bark', f'{TEX}/canopy_bark_albedo.png', f'{TEX}/canopy_bark_normal.png',
                          f'{TEX}/canopy_bark_orm.png', alpha=False, double_sided=False)
    leaf = J.pbr_material('canopy_leaf', f'{TEX}/canopy_leaf_albedo.png', f'{TEX}/canopy_leaf_normal.png',
                          f'{TEX}/canopy_leaf_orm.png', alpha=True, double_sided=True)
    objs, info = [], {}
    for key in only:
        t = Tree(key, SPECIES[key])
        info[key] = dict(height=t.H, crown_base=t.Hb, crown_width=2 * t.R, dbh=2 * t.r13,
                         trunk_base_radius=float(t.radius(0.3)),
                         buttress_reach=max(f['D'] for f in t.fins) + float(t.radius(0.3)),
                         lean_deg=math.degrees(math.atan(t.lean)), lean_dir_blender_deg=float(SPECIES[key]['lean'][1]),
                         tris={})
        ext = []
        for lod in (0, 1, 2):
            ob, tris = t.build(lod, at, [bark, leaf])
            objs.append(ob)
            info[key]['tris'][f'lod{lod}'] = tris
            V = np.array([v.co[:] for v in ob.data.vertices])
            ext.append([V.min(0).tolist(), V.max(0).tolist()])
        info[key]['bbox_lod0'] = ext[0]
    stem = 'midstorey_trees' if mid else 'canopy_trees'
    path = f'{OUT}/{stem}_raw.glb'
    J.export_glb(path, objs)
    with open(f'{OUT}/{stem}_info.json', 'w') as f:
        json.dump(info, f, indent=1)
    if blend:
        bpy.ops.wm.save_as_mainfile(filepath=blend)
    print('exported', path)


main()
