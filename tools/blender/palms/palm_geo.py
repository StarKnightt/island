"""Geometry for coconut palms (and the juvenile palms): trunk, crown base, fronds, nuts, flower stalks, root stubs.

Pure numpy; coordinates in Blender space (metres, Z up, lean toward +X). Every vertex carries the wind data
(G bend, B flutter, A phase); R (AO) is baked afterwards by palm_blender.bake_ao.
Builders append into a MeshBuilder; one MeshBuilder per LOD object, material slots:
  0 = palm_bark, 1 = palm_frond, 2 = palm_nut
"""
import math
import numpy as np
from palm_layout import *

BARK, FROND, NUT = 0, 1, 2
UP = np.array([0.0, 0.0, 1.0])


def nrm(v):
    v = np.asarray(v, dtype=np.float64)
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, 1e-12)


def rot(v, axis, ang):
    """Rodrigues rotation of v (3,) around unit axis by ang"""
    axis = nrm(axis)
    c, s = math.cos(ang), math.sin(ang)
    return v * c + np.cross(axis, v) * s + axis * np.dot(axis, v) * (1 - c)


def lerp(a, b, t):
    return a + (b - a) * t


class MeshBuilder:
    def __init__(self):
        self.co = []      # vertex positions
        self.wind = []    # (G, B, A) per vertex
        self.kind = []    # per vertex: 0 opaque surface, 1 foliage card (for AO)
        self.faces = []   # (vertex index tuple, uv tuple, material)

    def v(self, p, g, b, a, kind=0):
        self.co.append(np.asarray(p, dtype=np.float64))
        self.wind.append((float(g), float(b), float(a)))
        self.kind.append(kind)
        return len(self.co) - 1

    def f(self, idx, uvs, mat):
        self.faces.append((tuple(idx), tuple(tuple(map(float, u)) for u in uvs), mat))

    def tri_count(self, mat=None):
        return sum(len(i) - 2 for i, _, m in self.faces if mat is None or m == mat)


# =====================================================================================================================
# trunk
# =====================================================================================================================
class Trunk:
    """centreline from (0,0,0) to the crown; lean angle phi(t) from vertical toward +X, side angle psi(t) toward +Y"""

    def __init__(self, P, rng):
        self.P = P
        self.rng = rng
        H = P['height']
        lo, hi = H * 0.95, H * 1.8
        for _ in range(40):
            L = 0.5 * (lo + hi)
            if self._integrate(L)[0][-1][2] < H:
                lo = L
            else:
                hi = L
        self.L = 0.5 * (lo + hi)
        self.pts, self.tan, self.ss = self._integrate(self.L)
        # parallel-transport frames
        n0 = nrm(np.cross(self.tan[0], [0, 1, 0]))
        if np.linalg.norm(n0) < 1e-6:
            n0 = np.array([1.0, 0, 0])
        frames = [n0]
        for i in range(1, len(self.tan)):
            a, b = self.tan[i - 1], self.tan[i]
            ax = np.cross(a, b)
            s = np.linalg.norm(ax)
            n = frames[-1]
            if s > 1e-9:
                n = rot(n, ax / s, math.asin(min(1.0, s)))
            n = nrm(n - b * np.dot(n, b))
            frames.append(n)
        self.nor = np.array(frames)
        self.bin = np.cross(self.tan, self.nor)
        # radius noise phases
        self.und = [(rng.uniform(2.6, 4.8), rng.uniform(0, 6.28), rng.uniform(0.02, 0.04)),
                    (rng.uniform(1.0, 1.6), rng.uniform(0, 6.28), rng.uniform(0.008, 0.016))]
        self.lobe = [(k, rng.uniform(0, 6.28), rng.uniform(0.01, 0.03)) for k in (2, 3, 5)]
        with open(TEX_RINGS) as f:
            import json
            self.rings = json.load(f)
        # bark tiles of random length, so the leaf-scar spacing changes up the trunk
        self.tiles = [S_TILE0]
        while self.tiles[-1] < self.L + 2.0:
            self.tiles.append(self.tiles[-1] + TILE_LEN_M * rng.uniform(0.85, 1.15))

    def tile_of(self, s):
        """(index, start, length) of the bark tile containing arc length s (index -1 = bole band)"""
        if s < S_TILE0:
            return -1, S_TILE0 - BOLE_LEN_M, BOLE_LEN_M
        for k in range(len(self.tiles) - 1):
            if s < self.tiles[k + 1]:
                return k, self.tiles[k], self.tiles[k + 1] - self.tiles[k]
        k = len(self.tiles) - 2
        return k, self.tiles[k], self.tiles[k + 1] - self.tiles[k]

    def surface(self, s, theta, r=None, rings=False):
        """trunk surface point. Cross-sections turn from horizontal at the ground to perpendicular to the trunk by
        ~1.1 m, so a leaning trunk grows out of the sand instead of standing on a tilted cut; below ground the
        root ball goes straight down."""
        if r is None:
            r = self.radius(s, theta, rings)
        s0 = max(s, 0.0)
        p, t, n, b = self.at(s0)
        q = p + r * (math.cos(theta) * n + math.sin(theta) * b)
        w = smoothstep(0.0, 1.1, s0)
        if w < 1.0:
            m = nrm(lerp(UP, t, w))
            q = q - t * (np.dot(q - p, m) / np.dot(t, m))
        if s < 0:
            q = q + UP * s
        return q

    def phi(self, t):
        p = self.P['lean']
        kind = p[0]
        if kind == 'curve':                         # (curve, base_deg, top_deg, exponent)
            _, a0, a1, ex = p
            return math.radians(a1 + (a0 - a1) * (1 - t) ** ex)
        if kind == 'scurve':                        # (scurve, base_deg, mid_deg, top_deg)
            _, a0, am, a1 = p
            if t < 0.55:
                return math.radians(lerp(a0, am, smoothstep(0, 0.55, t)))
            return math.radians(lerp(am, a1, smoothstep(0.55, 1.0, t)))
        raise ValueError(kind)

    def psi(self, t):
        a, f, ph = self.P['side']
        return math.radians(a * math.sin(t * f * 6.2832 + ph))

    def _integrate(self, L, n=400):
        ss = np.linspace(0, L, n + 1)
        pts = [np.zeros(3)]
        tans = []
        wob = self.P.get('wobble', 1.0)
        for i, s in enumerate(ss):
            t = s / L
            # J-shaped base: the trunk leaves the sand steeper and reaches its full lean by ~1.4 m
            ramp = 0.3 + 0.7 * smoothstep(0.0, 1.4, s)
            ph = self.phi(t) * ramp + math.radians(wob * 0.9) * math.sin(s * 0.9 + 1.3) + math.radians(wob * 0.5) * math.sin(s * 2.3 + 0.4)
            ps = self.psi(t)
            d = np.array([math.sin(ph) * math.cos(ps), math.sin(ps), math.cos(ph) * math.cos(ps)])
            tans.append(d)
            if i < n:
                pts.append(pts[-1] + d * (L / n))
        return np.array(pts), np.array(tans), ss

    def at(self, s):
        """position, tangent, normal, binormal at arc length s (extends straight below the ground for s < 0)"""
        if s <= 0:
            return self.pts[0] + self.tan[0] * s, self.tan[0], self.nor[0], self.bin[0]
        x = min(s, self.L) / self.L * (len(self.ss) - 1)
        i = min(int(x), len(self.ss) - 2)
        f = x - i
        p = lerp(self.pts[i], self.pts[i + 1], f)
        t = nrm(lerp(self.tan[i], self.tan[i + 1], f))
        n = nrm(lerp(self.nor[i], self.nor[i + 1], f))
        n = nrm(n - t * np.dot(n, t))
        if s > self.L:
            p = self.pts[-1] + self.tan[-1] * (s - self.L)
        return p, t, n, np.cross(t, n)

    def radius(self, s, theta=0.0, rings=False):
        P = self.P
        L = self.L
        t = min(max(s, 0.0), L) / L
        r = P['r_top'] + (P['r_low'] - P['r_top']) * (1 - t) ** 1.35
        for lam, ph, amp in self.und:
            r *= 1 + amp * math.sin(s / lam * 6.2832 + ph)
        # swollen bole
        bulge = P['r_bole']
        if s >= 0:
            r = r + (bulge - r) * math.exp(-s / 0.30) ** 1.15
        else:
            r = bulge * (1 + 0.12 * min(1.0, -s / 0.45))
        # slightly irregular cross-section, stronger at the base (buttress lobes)
        lobe_k = 1.0 + 2.5 * math.exp(-max(s, 0) / 0.4)
        for k, ph, amp in self.lobe:
            r *= 1 + amp * lobe_k * math.cos(k * theta + ph + 0.15 * s)
        if rings:
            r *= 1 - 0.022 * self.groove_shape(s)
        return r

    def groove_shape(self, s):
        """1 at a leaf-scar groove of the bark tile, 0 between (rows are placed on grooves and ridges)"""
        if s < S_TILE0:
            return 0.0
        k, s0, ln = self.tile_of(s)
        v = (s - s0) / ln
        g = np.array([self.rings['grooves'][-1] - 1.0] + self.rings['grooves'] + [self.rings['grooves'][0] + 1.0])
        d = np.min(np.abs(v - g))
        return max(0.0, 1.0 - d / 0.03)

    def ring_rows(self, lod):
        """arc-length positions of vertex rows"""
        L = self.L
        rows = [-0.45, -0.3, -0.18, -0.08, 0.0]
        if lod == 0:
            s = 0.07
            while s < 0.62:
                rows.append(s)
                s += 0.07 + s * 0.08
            # groove / ridge rows aligned to the bark tiles up to ~2.9 m
            g = self.rings['grooves']
            for k in range(len(self.tiles) - 1):
                base, ln = self.tiles[k], self.tiles[k + 1] - self.tiles[k]
                if base > 2.9:
                    break
                ext = sorted(g + [1.0])
                prev = 0.0
                for gv in ext:
                    mid = 0.5 * (prev + gv)
                    for vv in (mid, gv):
                        sv = base + vv * ln
                        if 0.62 < sv <= 2.9:
                            rows.append(sv)
                    prev = gv
            s = 2.9 + 0.35
            step = 0.38
        elif lod == 1:
            rows += [0.15, 0.35, 0.65, 1.1]
            s = 1.7
            step = 1.05
        else:
            rows += [0.3, 1.0]
            s = 2.5
            step = L / 4.0
        while s < L - 0.15:
            rows.append(s)
            s += step
        rows.append(L)
        # tile boundaries (needed for the per-tile UV split) except LOD2 (which maps one stretched tile); they win
        # over any other row closer than 1.5 cm
        bounds = []
        if lod < 2:
            bounds = [round(b, 4) for b in self.tiles if b < L]
            bounds.append(round(S_TILE0 - BOLE_LEN_M, 4))
        rows = sorted(set(round(r, 4) for r in rows if r <= L))
        rows = [r for r in rows if all(abs(r - b) > 0.015 for b in bounds)]
        rows = sorted(rows + bounds)
        out = [rows[0]]
        for r in rows[1:]:
            if r - out[-1] > 0.012 or r in bounds:
                out.append(r)
        return out


S_TILE0 = 0.27          # arc length where the first bark tile starts (bole band below it)
TEX_RINGS = 'E:/tmp/island/helpers/palms/tex/bark_rings.json'


def bark_uv(s, theta, tile, tile_off, wraps=TILE_WRAPS):
    """atlas uv for the trunk surface at arc length s, angle theta (0..2pi); tile = (index, start, length)"""
    u = theta / (2 * math.pi) * wraps + tile_off
    k, s0, ln = tile
    if k < 0:  # bole band
        b0, b1 = BOLE_ROWS
        f = min(1.0, max(0.004, (s - s0) / ln))
        return u, (b0 + f * (b1 - b0)) / BARK_H
    t0, t1 = TILE_ROWS
    f = (s - s0) / ln
    return u, (t0 + f * (t1 - t0)) / BARK_H


def build_trunk(mb, tr, lod, phase, g_top=0.3):
    P = tr.P
    sides = {0: 14, 1: 8, 2: 6}[lod]
    rows = tr.ring_rows(lod)
    rng = np.random.default_rng(P['seed'] * 13 + 5)
    offs = rng.uniform(0, 1, len(tr.tiles) + 1)
    offs[0] = 0.0
    ring_idx = []
    for s in rows:
        idx = []
        tt = max(0.0, s) / tr.L
        g = g_top * tt ** 1.5
        for j in range(sides):
            th = 2 * math.pi * j / sides
            q = tr.surface(s, th, rings=(lod == 0))
            idx.append(mb.v(q, g, 0.0, phase))
        ring_idx.append(idx)
    for i in range(len(rows) - 1):
        s0, s1 = rows[i], rows[i + 1]
        sm = 0.5 * (s0 + s1)
        if lod == 2:
            k = -1 if sm < S_TILE0 else 0
            # LOD2: one tile stretched over the whole trunk (texture detail is invisible there)
            def uvf(s, th, k=k):
                if k < 0:
                    return bark_uv(s, th, tr.tile_of(s), 0.0, wraps=1)
                f = (s - S_TILE0) / (tr.L - S_TILE0)
                return th / (2 * math.pi), (TILE_ROWS[0] + f * (TILE_ROWS[1] - TILE_ROWS[0])) / BARK_H
        else:
            tile = tr.tile_of(sm)
            off = offs[tile[0]] if tile[0] >= 0 else 0.0
            def uvf(s, th, tile=tile, off=off):
                return bark_uv(s, th, tile, off)
        for j in range(sides):
            j1 = (j + 1) % sides
            th0 = 2 * math.pi * j / sides
            th1 = 2 * math.pi * (j + 1) / sides
            a, bb, c, d = ring_idx[i][j], ring_idx[i][j1], ring_idx[i + 1][j1], ring_idx[i + 1][j]
            mb.f((a, bb, c, d), (uvf(s0, th0), uvf(s0, th1), uvf(s1, th1), uvf(s1, th0)), BARK)
    # bottom cap (underground)
    c = mb.v(np.mean([mb.co[k] for k in ring_idx[0]], axis=0) - UP * 0.05, 0.0, 0.0, phase)
    for j in range(sides):
        j1 = (j + 1) % sides
        mb.f((ring_idx[0][j1], ring_idx[0][j], c), ((0.5, 0.01), (0.5, 0.01), (0.5, 0.01)), BARK)
    return ring_idx


def crown_axis(tr):
    p, t, n, b = tr.at(tr.L)
    return p, nrm(t + UP * 1.2)


def build_crown_base(mb, tr, lod, phase, rng, g_top=0.3):
    """fibre collar below the crown and the bulb of leaf bases the fronds grow from"""
    C, A = crown_axis(tr)
    r_top = tr.radius(tr.L)
    sides = {0: 14, 1: 8, 2: 6}[lod]
    _, _, n_top, _ = tr.at(tr.L)
    side_v = nrm(n_top - A * np.dot(n_top, A))
    side_w = np.cross(A, side_v)
    # (offset along the trunk / crown axis, radius factor)
    if lod == 0:
        prof = [(-0.95, 1.10), (-0.62, 1.22), (-0.28, 1.36), (0.02, 1.55), (0.22, 1.5), (0.40, 1.22), (0.55, 0.7), (0.64, 0.25)]
    elif lod == 1:
        prof = [(-0.85, 1.15), (-0.2, 1.42), (0.25, 1.4), (0.6, 0.4)]
    else:
        prof = [(-0.7, 1.2), (0.2, 1.4), (0.6, 0.3)]
    rings = []
    f0, f1 = FIBRE_ROWS
    for i, (h, rf) in enumerate(prof):
        idx = []
        for j in range(sides):
            th = 2 * math.pi * j / sides
            if h < 0:
                jag = (rng.uniform(-0.12, 0.10) if i == 0 else rng.uniform(-0.03, 0.03))
                p, t, n, b = tr.at(tr.L + h + jag)
                rr = tr.radius(tr.L + h + jag, th) * rf * (1 + rng.uniform(-0.05, 0.06))
                q = p + rr * (math.cos(th) * n + math.sin(th) * b)
            else:
                rr = r_top * rf * (1 + rng.uniform(-0.05, 0.05))
                q = C + A * h + rr * (math.cos(th) * side_v + math.sin(th) * side_w)
            idx.append(mb.v(q, g_top, 0.0, phase))
        rings.append(idx)
    vs = [(f0 + 4 + (f1 - f0 - 8) * (i / (len(prof) - 1))) / BARK_H for i in range(len(prof))]
    for i in range(len(prof) - 1):
        for j in range(sides):
            j1 = (j + 1) % sides
            u0, u1 = j / sides, (j + 1) / sides
            mb.f((rings[i][j], rings[i][j1], rings[i + 1][j1], rings[i + 1][j]),
                 ((u0, vs[i]), (u1, vs[i]), (u1, vs[i + 1]), (u0, vs[i + 1])), BARK)
    top = mb.v(C + A * (prof[-1][0] + 0.04), g_top, 0.0, phase)
    for j in range(sides):
        j1 = (j + 1) % sides
        mb.f((rings[-1][j], rings[-1][j1], top), ((j / sides, vs[-1]), ((j + 1) / sides, vs[-1]), (j / sides, vs[-1])), BARK)
    return C, A, r_top


# =====================================================================================================================
# fronds
# =====================================================================================================================
class Frond:
    """one frond: rachis curve + leaflet parameters. kind: green | old | dead | young | spear"""

    def __init__(self, base, az_dir, up, elev, length, droop, rng, kind='green', lateral=0.0, twist=0.0,
                 alpha=30.0, beta=40.0, theta=(70, 55, 32), droop_exp=1.7, broken=None, phase=0.0, g0=0.3,
                 rows=('green1', 'green2'), leaflet_frac=0.21, petiole=0.2, width0=0.075, slot_step=1):
        self.base = np.asarray(base, float)
        self.az = nrm(az_dir)
        self.up = nrm(up)
        self.elev = math.radians(elev)
        self.L = length
        self.droop = math.radians(droop)
        self.kind = kind
        self.lateral = math.radians(lateral)
        self.twist = math.radians(twist)
        self.alpha = math.radians(alpha)
        self.beta = math.radians(beta)
        self.theta = [math.radians(x) for x in theta]
        self.dexp = droop_exp
        self.broken = broken
        self.phase = phase
        self.g0 = g0
        self.rows = rows
        self.lmax = leaflet_frac * length
        self.pf = petiole
        self.w0 = width0
        self.slot_step = slot_step      # >1: small fronds use every n-th atlas slot, stretched (wider leaflets)
        self.rng = rng
        self.card_seed = int(rng.integers(1 << 30))
        side = nrm(np.cross(self.up, self.az))
        n = 160
        ss = np.linspace(0, length, n + 1)
        pts = [self.base.copy()]
        tans = []
        for i, s in enumerate(ss):
            t = s / length
            e = self.elev - self.droop * t ** self.dexp
            if broken is not None and t > broken[0]:
                e -= math.radians(broken[1]) * smoothstep(broken[0], broken[0] + 0.03, t)
            e = max(e, -math.radians(89))
            a = self.lateral * t ** 1.5
            h = math.cos(a) * self.az + math.sin(a) * side
            d = math.cos(e) * h + math.sin(e) * self.up
            tans.append(nrm(d))
            if i < n:
                pts.append(pts[-1] + tans[-1] * (length / n))
        self.ss, self.pts, self.tans = ss, np.array(pts), np.array(tans)

    def at(self, s):
        x = min(max(s, 0), self.L) / self.L * (len(self.ss) - 1)
        i = min(int(x), len(self.ss) - 2)
        f = x - i
        p = lerp(self.pts[i], self.pts[i + 1], f)
        t = nrm(lerp(self.tans[i], self.tans[i + 1], f))
        # frond 'up' = world up made perpendicular to the tangent, then twisted around the tangent
        u = UP - t * np.dot(UP, t)
        if np.linalg.norm(u) < 1e-4:
            u = self.az - t * np.dot(self.az, t)
        u = nrm(u)
        u = rot(u, t, self.twist * (s / self.L) ** 1.2)
        side = np.cross(t, u)
        return p, t, u, side

    def g_at(self, s):
        return self.g0 + (1.0 - self.g0) * (min(max(s, 0), self.L) / self.L) ** 1.25

    def width(self, s):
        t = s / self.L
        w = self.w0 * (1 - 0.86 * t ** 0.6) + 0.006
        w *= 1 + 1.6 * math.exp(-t / 0.045)      # broad clasping leaf base
        return w

    def leaflet_dir(self, s, side_sign, p, t, u, sd, jitter=(0.0, 0.0, 0.0)):
        x = (s / self.L - self.pf) / (1 - self.pf)
        th0, th1, th2 = self.theta
        th = (lerp(th0, th1, x / 0.5) if x < 0.5 else lerp(th1, th2, (x - 0.5) / 0.5)) + jitter[0]
        al = self.alpha * (1 - 0.35 * x) + jitter[1]
        d0 = math.cos(th) * t + math.sin(th) * (math.cos(al) * side_sign * sd + math.sin(al) * u)
        return nrm(d0)

    def leaflet_curve(self, root, d0, length, nseg, beta, kind_tip=1.0):
        """polyline of nseg+1 offsets: the leaflet bends from d0 toward the ground by beta along its length"""
        ax = np.cross(d0, -UP)
        if np.linalg.norm(ax) < 1e-5:
            ax = np.cross(d0, [1, 0, 0])
        ax = nrm(ax)
        off = [np.zeros(3)]
        for j in range(nseg):
            f = (j + 0.5) / nseg
            d = rot(d0, ax, beta * f ** 1.3)
            off.append(off[-1] + d * (length / nseg))
        return off

    # ------------------------------------------------------------------------------------------------------------
    def build(self, mb, lod):
        rng = np.random.default_rng(self.card_seed)
        row_kind = {'green': None, 'old': 'old', 'dead': 'dead', 'young': 'young', 'spear': 'young'}[self.kind]
        rach_name = {'green': 'green', 'old': 'old', 'dead': 'dead', 'young': 'green', 'spear': 'green'}[self.kind]
        env_kind = 'young' if self.kind in ('young', 'spear') else 'mature'
        # ---------------------------------------------------------------- rachis
        nseg = {0: 10, 1: 5, 2: 0}[lod]
        if self.kind == 'dead' and lod == 0:
            nseg = 8
        rv0, rv1 = rachis_v(rach_name)
        if nseg > 0:
            ss = [self.L * (i / nseg) ** 1.15 for i in range(nseg + 1)]
            if lod == 0:
                rings = []
                for s in ss:
                    p, t, u, sd = self.at(s)
                    w = self.width(s)
                    h = w * 0.75
                    # inverted triangle: two upper corners, keel below
                    corners = [p + u * h * 0.35 - sd * w * 0.5, p + u * h * 0.35 + sd * w * 0.5, p - u * h * 0.65]
                    g = self.g_at(s)
                    rings.append([mb.v(c, g, 0.0, self.phase) for c in corners])
                for i in range(nseg):
                    ua, ub = ss[i] / self.L, ss[i + 1] / self.L
                    for j in range(3):
                        j1 = (j + 1) % 3
                        va = rv0 + (rv1 - rv0) * j / 3
                        vb = rv0 + (rv1 - rv0) * (j + 1) / 3
                        mb.f((rings[i][j], rings[i][j1], rings[i + 1][j1], rings[i + 1][j]),
                             ((ua, va), (ua, vb), (ub, vb), (ub, va)), FROND)
            else:
                # LOD1: single vertical ribbon (reads from the side, where distant palms are seen from)
                rows = []
                for s in ss:
                    p, t, u, sd = self.at(s)
                    w = max(self.width(s), 0.03) * 1.3
                    g = self.g_at(s)
                    rows.append((mb.v(p + u * w * 0.5, g, 0.0, self.phase), mb.v(p - u * w * 0.5, g, 0.0, self.phase)))
                for i in range(nseg):
                    ua, ub = ss[i] / self.L, ss[i + 1] / self.L
                    mb.f((rows[i][0], rows[i + 1][0], rows[i + 1][1], rows[i][1]),
                         ((ua, rv1), (ub, rv1), (ub, rv0), (ua, rv0)), FROND)
        # ---------------------------------------------------------------- leaflets
        s_a = self.pf * self.L
        span = self.L - s_a
        for side_sign in (1.0, -1.0):
            main_row = self.rows[0] if side_sign > 0 else self.rows[-1]
            if lod == 0:
                st = self.slot_step
                for kk in range(N_SLOTS // st):
                    k = kk * st + (int(rng.integers(st)) if st > 1 else 0)
                    u0, u1 = slot_bounds(k)
                    sa, sb = s_a + (kk * st / N_SLOTS) * span, s_a + ((kk + 1) * st / N_SLOTS) * span
                    sm = 0.5 * (sa + sb)
                    env = min(1.0, slot_envelope(env_kind, k) * 1.02)
                    row = main_row if (row_kind or rng.random() < 0.7) else (self.rows[1] if main_row == self.rows[0] else self.rows[0])
                    if row_kind:
                        row = row_kind
                    rv_0, rv_1 = row_v(row)
                    v_top = rv_0 + env * (rv_1 - rv_0)
                    mirror = rng.random() < 0.5
                    # leaflet groups sit at slightly different heights / angles (as on a real frond), so the comb
                    # has depth edge-on; mostly alternating, sometimes not, never a regular zigzag
                    sgn = (1.0 if (k + (side_sign > 0)) % 2 else -1.0) * (1.0 if rng.random() < 0.7 else -1.0)
                    jit = (math.radians(rng.uniform(-6, 6)), math.radians(sgn * rng.uniform(2, 8) + rng.uniform(-6, 6)), 0)
                    beta = self.beta * rng.uniform(0.6, 1.35) * (0.75 + 0.5 * (sm - s_a) / span)
                    p, t, u, sd = self.at(sm)
                    d0 = self.leaflet_dir(sm, side_sign, p, t, u, sd, jit)
                    length = env * self.lmax
                    nl = 3 if length > 0.5 else 2
                    off = self.leaflet_curve(None, d0, length, nl, beta)
                    pa, _, _, sda = self.at(sa)
                    pb, _, _, sdb = self.at(sb)
                    ra = pa + side_sign * sda * self.width(sa) * 0.45
                    rb = pb + side_sign * sdb * self.width(sb) * 0.45
                    ga, gb = self.g_at(sa), self.g_at(sb)
                    ua_, ub_ = (u1, u0) if mirror else (u0, u1)
                    xa = (sa / self.L)
                    idx = []
                    for j, o in enumerate(off):
                        f = j / nl
                        flut = f ** 1.25 * (0.55 + 0.45 * xa)
                        if self.kind == 'dead':
                            flut *= 0.5
                        gg_a = min(1.0, ga + 0.12 * f * xa)
                        gg_b = min(1.0, gb + 0.12 * f * xa)
                        idx.append((mb.v(ra + o, gg_a, flut, self.phase, 1), mb.v(rb + o, gg_b, flut, self.phase, 1)))
                    for j in range(nl):
                        va = rv_0 + (v_top - rv_0) * j / nl
                        vb = rv_0 + (v_top - rv_0) * (j + 1) / nl
                        mb.f((idx[j][0], idx[j][1], idx[j + 1][1], idx[j + 1][0]),
                             ((ua_, va), (ub_, va), (ub_, vb), (ua_, vb)), FROND)
            else:
                nw = {1: 5, 2: 3}[lod] if self.kind != 'dead' else {1: 4, 2: 2}[lod]
                na = 2 if lod == 1 else 1
                row = row_kind or main_row
                rv_0, rv_1 = row_v(row)
                cols = []
                for i in range(nw + 1):
                    uu = i / nw
                    s = s_a + uu * span
                    p, t, u, sd = self.at(s)
                    d0 = self.leaflet_dir(s, side_sign, p, t, u, sd)
                    env = min(1.0, envelope(env_kind, uu) * 1.05 + 0.03)
                    beta = self.beta * (0.75 + 0.5 * uu)
                    off = self.leaflet_curve(None, d0, env * self.lmax, na, beta)
                    root = p + side_sign * sd * self.width(s) * 0.45
                    g = self.g_at(s)
                    col = []
                    for j, o in enumerate(off):
                        f = j / na
                        flut = f ** 1.25 * (0.55 + 0.45 * s / self.L) * (0.5 if self.kind == 'dead' else 1.0)
                        col.append((mb.v(root + o, min(1.0, g + 0.12 * f * s / self.L), flut, self.phase, 1),
                                    rv_0 + (rv_1 - rv_0) * env * f))
                    cols.append((uu, col))
                for i in range(nw):
                    ua, ca = cols[i]
                    ub, cb = cols[i + 1]
                    for j in range(na):
                        mb.f((ca[j][0], cb[j][0], cb[j + 1][0], ca[j + 1][0]),
                             ((ua, ca[j][1]), (ub, cb[j][1]), (ub, cb[j + 1][1]), (ua, ca[j + 1][1])), FROND)

    def tip_points(self):
        return self.pts


# =====================================================================================================================
# coconuts, bunch stalks, flower stalks, root stubs
# =====================================================================================================================
def ovoid(mb, centre, axis, length, width, col, g, phase, lod, rng, segs=None):
    """coconut: slightly trigonal ovoid, stalk end at centre + axis * length/2 (the calyx end)"""
    axis = nrm(axis)
    tmp = nrm(np.cross(axis, [0.37, 0.71, 0.6]))
    bx = np.cross(axis, tmp)
    u0, u1, v0, v1 = nut_region(col)
    if segs is not None:
        nr, ns = segs
    elif lod == 0:
        nr, ns = 4, 7
    else:
        nr, ns = 1, 4
    rows = []
    twist = rng.uniform(0, 6.28)
    for i in range(1, nr + 1):
        f = i / (nr + 1)                    # 0 = stalk end .. 1 = distal tip
        z = (0.5 - f) * length
        prof = math.sin(math.pi * f) ** 0.8 * (1.0 - 0.12 * f)
        ring = []
        for j in range(ns):
            th = 2 * math.pi * j / ns + twist
            tri = 1 + 0.06 * math.cos(3 * th)
            r = 0.5 * width * prof * tri
            q = centre + axis * z + r * (math.cos(th) * tmp + math.sin(th) * bx)
            ring.append(mb.v(q, g, 0.0, phase))
        rows.append((ring, v1 - (v1 - v0) * f))
    top = mb.v(centre + axis * 0.5 * length * 0.98, g, 0.0, phase)
    bot = mb.v(centre - axis * 0.5 * length * 1.0, g, 0.0, phase)
    for i in range(len(rows) - 1):
        (ra, va), (rb, vb) = rows[i], rows[i + 1]
        for j in range(ns):
            j1 = (j + 1) % ns
            ua, ub = u0 + (u1 - u0) * j / ns, u0 + (u1 - u0) * (j + 1) / ns
            mb.f((ra[j], rb[j], rb[j1], ra[j1]), ((ua, va), (ua, vb), (ub, vb), (ub, va)), NUT)
    ra, va = rows[0]
    rb, vb = rows[-1]
    for j in range(ns):
        j1 = (j + 1) % ns
        ua, ub = u0 + (u1 - u0) * j / ns, u0 + (u1 - u0) * (j + 1) / ns
        mb.f((ra[j], ra[j1], top), ((ua, va), (ub, va), (0.5 * (ua + ub), v1 - 0.004)), NUT)
        mb.f((rb[j1], rb[j], bot), ((ub, vb), (ua, vb), (0.5 * (ua + ub), v0 + 0.004)), NUT)


def tube(mb, pts, radii, sides, region, g_list, phase, mat=BARK, cap=False):
    """generic tapered tube along pts (u along the length within region, v around)"""
    u0, u1, v0, v1 = region
    rings = []
    prev_n = None
    n = len(pts)
    for i, p in enumerate(pts):
        t = nrm(pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)])
        if prev_n is None:
            nn = nrm(np.cross(t, [0.31, 0.53, 0.79]))
        else:
            nn = nrm(prev_n - t * np.dot(prev_n, t))
        prev_n = nn
        bb = np.cross(t, nn)
        ring = []
        for j in range(sides):
            th = 2 * math.pi * j / sides
            ring.append(mb.v(p + radii[i] * (math.cos(th) * nn + math.sin(th) * bb), g_list[i], 0.0, phase))
        rings.append(ring)
    for i in range(n - 1):
        ua = u0 + (u1 - u0) * i / (n - 1)
        ub = u0 + (u1 - u0) * (i + 1) / (n - 1)
        for j in range(sides):
            j1 = (j + 1) % sides
            va = v0 + (v1 - v0) * j / sides
            vb = v0 + (v1 - v0) * (j + 1) / sides
            mb.f((rings[i][j], rings[i][j1], rings[i + 1][j1], rings[i + 1][j]), ((ua, va), (ua, vb), (ub, vb), (ub, va)), mat)
    if cap:
        c = mb.v(pts[-1] + nrm(pts[-1] - pts[-2]) * radii[-1] * 0.5, g_list[-1], 0.0, phase)
        for j in range(sides):
            j1 = (j + 1) % sides
            mb.f((rings[-1][j], rings[-1][j1], c), ((u1, v0), (u1, v1), (u1, 0.5 * (v0 + v1))), mat)
    return rings


def check_outward(mb, mats=(BARK, NUT)):
    """fraction of opaque faces whose normal points away from the local part centre (debug)"""
    co = np.array(mb.co)
    good = bad = 0
    for idx, _, m in mb.faces:
        if m not in mats or len(idx) < 3:
            continue
        p = co[list(idx)]
        n = np.cross(p[1] - p[0], p[2] - p[0])
        c = p.mean(0)
        # neighbourhood centre: mean of the 60 nearest vertices approximates the local axis of a tube / nut
        d = np.linalg.norm(co - c, axis=1)
        near = co[np.argsort(d)[:60]].mean(0)
        if np.dot(n, c - near) >= 0:
            good += 1
        else:
            bad += 1
    return good, bad


def build_nut_cluster(mb, C, A, r_core, az, n_nuts, lod, rng, phase, g_top=0.3, brown_frac=0.15, h=-0.25):
    """bunch stalk from a leaf axil, curving out and down, with a tight bunch of coconuts at its end"""
    az = nrm(az - A * np.dot(az, A))
    start = C + A * h + az * r_core * 0.85
    L = rng.uniform(0.45, 0.8)
    pts = []
    d = nrm(az * 0.8 - A * 0.35)
    p = start.copy()
    for i in range(5):
        pts.append(p.copy())
        d = nrm(d - A * 0.22)
        p = p + d * (L / 4)
    end = pts[-1]
    if lod == 0:
        tube(mb, pts, [0.045, 0.04, 0.035, 0.03, 0.026], 4, STALK_REGION, [g_top] * 5, phase)
    elif lod == 1:
        tube(mb, pts[::2], [0.05, 0.04, 0.03], 3, STALK_REGION, [g_top] * 3, phase)
    # nuts on a lumpy ellipsoid around and below the stalk end
    nut_len = rng.uniform(0.25, 0.3)
    R = nut_len * (0.55 + 0.11 * n_nuts ** 0.5)
    centre = end + d * R * 0.35 - A * R * 0.45
    if lod == 2:
        ovoid(mb, centre, nrm(d + A), R * 2.1, R * 1.9, 0, g_top, phase, 1, rng)
        return
    placed = []
    golden = math.pi * (3 - math.sqrt(5))
    e1 = nrm(np.cross(A, az))
    e2 = np.cross(e1, A)
    for attempt in range(6):
        m = n_nuts * 3
        cand = []
        for k in range(m):
            zf = 1 - 2 * (k + 0.5) / m
            if zf > 0.45:                           # leave the stalk side of the bunch free
                continue
            rad = math.sqrt(max(0, 1 - zf * zf))
            th = k * golden
            cand.append(nrm(rad * math.cos(th) * e1 + rad * math.sin(th) * e2 + zf * A + rng.normal(0, 0.06, 3)))
        rng.shuffle(cand)
        for dirv in cand:
            if len(placed) >= n_nuts:
                break
            pos = centre + dirv * R * rng.uniform(0.92, 1.06)
            if any(np.linalg.norm(pos - q) < nut_len * 0.8 for q, _ in placed):
                continue
            placed.append((pos, dirv))
        if len(placed) >= n_nuts:
            break
        R *= 1.08
    for pos, dirv in placed:
        col = 2 if rng.random() < brown_frac else (1 if rng.random() < 0.3 else 0)
        ln = nut_len * rng.uniform(0.9, 1.08)
        ax = nrm(-dirv + rng.normal(0, 0.15, 3))     # calyx end toward the bunch centre
        ovoid(mb, pos, ax, ln, ln * rng.uniform(0.76, 0.86), col, g_top, phase, lod, rng)
        if lod == 0:
            # short rachilla from the stalk end to the nut
            q0 = pos + ax * ln * 0.5
            mid = 0.5 * (q0 + end) - A * 0.03
            tube(mb, [end, mid, q0], [0.012, 0.01, 0.008], 3, STALK_REGION, [g_top] * 3, phase)


def build_inflorescence(mb, C, A, r_core, az, lod, rng, phase, g_top=0.3, h=-0.12):
    """woody spathe with a broom of pale-tan flower strands hanging out of it"""
    az = nrm(az - A * np.dot(az, A))
    start = C + A * h + az * r_core * 0.8
    d = nrm(az * 0.75 - A * 0.25)
    L = rng.uniform(0.55, 0.8)
    pts = [start + d * (L * i / 4) - A * (L * 0.12 * (i / 4) ** 2) for i in range(5)]
    tube(mb, pts, [0.05, 0.07, 0.075, 0.05, 0.012], 5 if lod == 0 else 3, SPATHE_REGION, [g_top] * 5, phase, cap=True)
    if lod > 0:
        return
    end = pts[2]
    n = int(rng.integers(9, 15))
    for i in range(n):
        dd = nrm(d * 0.5 - A * 0.8 + rng.normal(0, 0.35, 3))
        ln = rng.uniform(0.25, 0.5)
        q = [end + dd * ln * f + (-A) * ln * 0.25 * f * f for f in (0.0, 0.5, 1.0)]
        tube(mb, q, [0.008, 0.006, 0.003], 3, STALK_REGION, [g_top, g_top + 0.03, g_top + 0.06], phase)


def build_root_stubs(mb, tr, rng, phase, n=34):
    """short exposed roots that leave the bole just above the sand and dive into it (LOD0 only), in loose groups"""
    b0, b1 = BOLE_ROWS
    centres = rng.uniform(0, 2 * math.pi, 7)
    for i in range(n):
        th = centres[i % len(centres)] + rng.normal(0, 0.18)
        s = rng.uniform(0.0, 0.12) ** 1.3
        q = tr.surface(s, th, r=tr.radius(s, th) * 0.93)
        axis = tr.surface(s, th, r=0.0)
        radial = q - axis
        horiz = nrm(radial - UP * np.dot(radial, UP))
        d = nrm(horiz + rng.normal(0, 0.25, 3) - UP * rng.uniform(0.6, 1.6))
        ln = rng.uniform(0.1, 0.24) + max(0.0, q[2]) * 1.5
        rr = rng.uniform(0.011, 0.021)
        bend = nrm(d - UP * 0.8)
        pts = [q, q + d * ln * 0.5 + rng.normal(0, 0.006, 3), q + d * ln * 0.5 + bend * ln * 0.5]
        u0 = rng.uniform(0, 0.9)
        tube(mb, pts, [rr, rr * 0.88, rr * 0.7], 4, (u0, u0 + 0.06, (b0 + 8) / BARK_H, (b0 + 70) / BARK_H), [0, 0, 0], phase)
