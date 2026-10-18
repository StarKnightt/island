"""Height field of one shore rock shelf (pure numpy: used by shelf_gen.py inside Blender and by shelf_field_view.py).

build(P) returns a namespace with the grid (xs, ys, X, Y, g), the final outline distance field d_out (m, negative
inside), the top surface T, the closed height field Z (floor outside the outline), the crack grooves, the tide-pool
depths, a tint value per joint block and the fallen-block placements.

  joints  : irregular blocks from an anisotropic, domain-warped Voronoi pattern (merged seeds give mixed sizes); only
            some joints are open (narrow V grooves, clustered in zones), closed joints are blended smooth
  outline : rounded rectangle pushed in and out by noise, cut by surge channels, minus missing joint blocks along the
            seaward edge; a morphological opening then removes slivers, fins and one-block necks
  top     : gentle seaward dip, broad lobes, wandering bedding ridges (sub-parallel, asymmetric, fading in and out),
            terrace risers and seaward edge benches that follow the joint blocks (rounded lips), per-block height /
            tilt jitter that grows toward the seaward edge (slumped blocks), tide pools and potholes
  edges   : a near-vertical wall with a rounded lip that turns into a convex ramp in places on the seaward side, and a
            gentle slope on the landward side (to be buried in the beach / terrain)
"""
import math
from types import SimpleNamespace
import numpy as np
from proc import fbm


def sm(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def build(P, log=print):
    SEED = int(P.get('seed', 1))
    rng = np.random.default_rng(SEED)

    def cell_rand(i, j, k):
        """Deterministic 0..1 value per integer pair (i, j) and channel k."""
        v = (np.asarray(i, np.int64) * 73856093) ^ (np.asarray(j, np.int64) * 19349663) ^ np.int64(k * 83492791 + SEED * 2654435761)
        v &= 0xffffffff
        v ^= v >> 13
        v = (v * 1274126177) & 0xffffffff
        v ^= v >> 16
        return (v & 0xffffff) / float(0x1000000)

    def noise2(x, y, scale, octaves=3, seed=0):
        p = np.stack([np.ravel(x) / scale, np.ravel(y) / scale, np.full(np.size(x), 0.37 * seed + 0.11)], 1)
        return fbm(p, octaves, seed=SEED * 31 + seed).reshape(np.shape(x)).astype(np.float64)

    # ------------------------------------------------------------ grid
    Lx, Ly = P['extent']
    g = P.get('grid', 0.08)
    floor = P.get('floor', -1.5)
    mar = 3.0
    xs = np.arange(-Lx / 2 - mar, Lx / 2 + mar + g / 2, g)
    ys = np.arange(-Ly / 2 - mar, Ly / 2 + mar + g / 2, g)
    X, Y = np.meshgrid(xs, ys)
    ny, nx = X.shape

    def sample2d(A, x, y):
        fx = (np.asarray(x) - xs[0]) / g
        fy = (np.asarray(y) - ys[0]) / g
        ix = np.clip(np.floor(fx).astype(np.int64), 0, nx - 2)
        iy = np.clip(np.floor(fy).astype(np.int64), 0, ny - 2)
        tx = np.clip(fx - ix, 0, 1)
        ty = np.clip(fy - iy, 0, 1)
        return (A[iy, ix] * (1 - tx) * (1 - ty) + A[iy, ix + 1] * tx * (1 - ty) +
                A[iy + 1, ix] * (1 - tx) * ty + A[iy + 1, ix + 1] * tx * ty)

    offs = [(dy, dx, g * math.hypot(dx, dy)) for dy in range(-2, 3) for dx in range(-2, 3)
            if (dx or dy) and math.gcd(abs(dx), abs(dy)) == 1]

    def shifted(a, dy, dx, fill):
        out = np.full_like(a, fill)
        y0, y1 = max(0, -dy), ny - max(0, dy)
        x0, x1 = max(0, -dx), nx - max(0, dx)
        out[y0:y1, x0:x1] = a[y0 + dy:y1 + dy, x0 + dx:x1 + dx]
        return out

    def dist_to(mask, max_d):
        """5x5 chamfer distance (m) from each grid point to the nearest point of mask, capped at max_d."""
        d = np.where(mask, 0.0, max_d)
        for _ in range(int(max_d / g) + 2):
            prev = d
            for dy, dx, w in offs:
                d = np.minimum(d, shifted(d, dy, dx, max_d) + w)
            if np.array_equal(d, prev):
                break
        return d

    def sdf_of(mask, max_d=5.0):
        """Signed distance (m) to the boundary of mask, negative inside."""
        return np.where(mask, -(dist_to(~mask, max_d) - 0.5 * g), dist_to(mask, max_d) - 0.5 * g)

    def blur(a, it=1):
        for _ in range(it):
            p = np.pad(a, 1, mode='edge')
            a = (p[:-2, :-2] + p[:-2, 1:-1] + p[:-2, 2:] + p[1:-1, :-2] + p[1:-1, 1:-1] + p[1:-1, 2:] +
                 p[2:, :-2] + p[2:, 1:-1] + p[2:, 2:]) / 9.0
        return a

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

    # ------------------------------------------------------------ joint blocks (Voronoi)
    J = P.get('joints', {})
    th = math.radians(J.get('angle', 15.0))
    aniso = J.get('aniso', 1.4)
    sj = J.get('spacing', 2.2)
    wob, wsc = J.get('wobble', 0.35), J.get('wobble_scale', 3.0)
    Xw = X + wob * noise2(X, Y, wsc, 2, 3)
    Yw = Y + wob * noise2(X, Y, wsc, 2, 4)
    U = (Xw * math.cos(th) + Yw * math.sin(th)) / aniso
    V = -Xw * math.sin(th) + Yw * math.cos(th)
    iu0 = np.floor(U / sj).astype(np.int64)
    iv0 = np.floor(V / sj).astype(np.int64)
    jit, merge = J.get('jitter', 0.9), J.get('merge', 0.2)
    d1 = np.full(X.shape, np.inf)
    d2 = np.full(X.shape, np.inf)
    a_i, a_j, b_i, b_j = (np.zeros(X.shape, np.int64) for _ in range(4))
    a_u, a_v, b_u, b_v = (np.zeros(X.shape) for _ in range(4))
    for du in range(-2, 3):
        for dv in range(-2, 3):
            ci, cj = iu0 + du, iv0 + dv
            su = (ci + 0.5 + jit * (cell_rand(ci, cj, 101) - 0.5)) * sj
            sv = (cj + 0.5 + jit * (cell_rand(ci, cj, 102) - 0.5)) * sj
            dd = (U - su) ** 2 + (V - sv) ** 2
            dd[cell_rand(ci, cj, 103) < merge] = np.inf
            n1 = dd < d1
            n2 = ~n1 & (dd < d2)
            b_i = np.where(n1, a_i, np.where(n2, ci, b_i))
            b_j = np.where(n1, a_j, np.where(n2, cj, b_j))
            b_u = np.where(n1, a_u, np.where(n2, su, b_u))
            b_v = np.where(n1, a_v, np.where(n2, sv, b_v))
            d2 = np.where(n1, d1, np.where(n2, dd, d2))
            a_i = np.where(n1, ci, a_i)
            a_j = np.where(n1, cj, a_j)
            a_u = np.where(n1, su, a_u)
            a_v = np.where(n1, sv, a_v)
            d1 = np.where(n1, dd, d1)
    eu, ev = b_u - a_u, b_v - a_v
    el = np.maximum(np.hypot(eu, ev), 1e-9)
    e_w = (d2 - d1) / (2 * el) / np.hypot(eu / el / aniso, ev / el)   # metres to the joint with the nearest neighbour
    cid = a_i * 1000003 + a_j
    nid = b_i * 1000003 + b_j
    uid, inv = np.unique(cid, return_inverse=True)
    inv = inv.reshape(X.shape)
    ncell = len(uid)
    cnt = np.bincount(inv.ravel(), minlength=ncell).astype(np.float64)
    ccx = np.bincount(inv.ravel(), X.ravel(), ncell) / cnt
    ccy = np.bincount(inv.ravel(), Y.ravel(), ncell) / cnt
    ninv = np.clip(np.searchsorted(uid, nid), 0, ncell - 1)
    ninv = np.where(uid[ninv] == nid, ninv, inv)

    def crand(k):
        """Per-block random value (compact block index)."""
        return np.bincount(inv.ravel(), cell_rand(a_i, a_j, k).ravel(), ncell) / cnt

    cell = sj * math.sqrt(aniso)          # typical block size (m)
    log('joint blocks', ncell, 'typical size', round(cell, 2))
    # which joints are open (per neighbour pair, clustered in zones)
    lo, hi = np.minimum(cid, nid), np.maximum(cid, nid)
    zone = sm(0.5 + J.get('zone', 0.9) * noise2(X, Y, J.get('zone_scale', 6.0), 2, 8))
    opn = np.clip((cell_rand(lo, hi, 7) - (1 - J.get('open_frac', 0.5))) / 0.25, 0, 1) * (0.25 + 0.75 * zone)
    opn = np.where(lo == hi, 0.0, opn)

    # ------------------------------------------------------------ outline
    d0 = outline_sdf(X, Y)
    sc_c = -outline_sdf(ccx, ccy)         # how far inside the outline each block's centroid lies
    ws_cc = seaward(ccy)
    p_rm = (J.get('erode', 0.5) * (1 - sm((sc_c - 0.15 * cell) / (J.get('erode_cells', 0.9) * cell)))
            * sm((ws_cc - 0.2) / 0.5))
    rm_c = (crand(0) < p_rm) & (sc_c < 1.2 * cell)
    removed = rm_c[inv]
    inside = (d0 < 0) & ~removed
    r_open = J.get('open_r', 0.35)
    core = sdf_of(inside, r_open + 3 * g) < -r_open
    kept = inside & (dist_to(core, r_open + 3 * g) < r_open)
    d_k = blur(sdf_of(kept), 2) + J.get('break_rag', 0.12) * noise2(X, Y, 0.9, 2, 12) / 0.3
    d_out = np.maximum(d0, np.where(removed | (d_k > -1.0), d_k, blur(sdf_of(kept), 2)))
    # open joints that reach the seaward wall split it: narrow vertical crevices cut back into the edge
    crev = J.get('crevice', 0.0) * opn * (1 - np.clip(e_w / J.get('crevice_w', 0.3), 0, 1)) ** 1.5
    d_out = d_out + crev * sm((seaward(Y) - 0.2) / 0.4)
    S = -d_out
    log('missing edge blocks', int(rm_c.sum()), 'opened away', int((inside & ~kept).sum()), 'samples')
    gy, gx = np.gradient(blur(d0, 2), g)
    gl = np.maximum(np.hypot(gx, gy), 1e-6)
    back_w = sm((gy / gl - 0.3) / 0.5)    # outward normal pointing inland: the buried landward slope
    if J.get('back_blocks', 0.0) > 0:
        # the landward slope breaks along the joints too: each block's edge steps in or out by its own amount
        # (a jointed outcrop going under the sand, not a smooth bun)
        bw_c = np.bincount(inv.ravel(), back_w.ravel(), ncell) / cnt
        off = J['back_blocks'] * (2 * crand(6) - 1) * sm((bw_c - 0.25) / 0.4)
        d_out = d_out + off[inv]
        S = -d_out

    # ------------------------------------------------------------ top surface
    T = np.full(X.shape, float(P['top']))
    T += math.tan(math.radians(P.get('dip_deg', 2.0))) * (Y + Ly / 2)
    T -= P.get('end_drop', 0.3) * (1 - sm((Lx / 2 - np.abs(X)) / (0.25 * Lx)))
    T += P.get('undulate', 0.1) * noise2(X, Y, P.get('undulate_scale', 6.0), 3, 5)
    T += P.get('swell', 0.0) * noise2(X, Y, P.get('swell_scale', 11.0), 2, 6) / 0.3
    Bd = P.get('bedding')
    bed_k = np.zeros(X.shape, np.int64)
    if Bd:
        # eroded bedding: sub-parallel low ridges with a gentle back and a short scarp, wandering, fading in and out
        tb = math.radians(Bd.get('strike', 0.0))
        w = -X * math.sin(tb) + Y * math.cos(tb) + Bd.get('warp', 0.8) * noise2(X, Y, Bd.get('warp_scale', 6.0), 2, 30)
        if Bd.get('flip'):
            w = -w
        r3 = np.random.default_rng(SEED + 300)
        e = w.min() - 0.5 + np.concatenate([[0], np.cumsum(r3.uniform(Bd['thick'][0], Bd['thick'][1], 600))])
        bed_k = np.clip(np.searchsorted(e, w) - 1, 0, len(e) - 2)
        tl = (w - e[bed_k]) / (e[bed_k + 1] - e[bed_k])
        f = Bd.get('scarp', 0.22)
        shape = np.where(tl < 1 - f, sm(tl / (1 - f)), 1 - sm((tl - (1 - f)) / f))
        amp = r3.uniform(Bd['amp'][0], Bd['amp'][1], len(e))[bed_k]
        fade = sm(0.5 + Bd.get('fade', 1.0) * noise2(X, Y, Bd.get('fade_scale', 5.0), 2, 31))
        T += amp * shape * fade
    edge_c = (1 - sm((sc_c - 0.2 * cell) / (1.2 * cell))) * ws_cc
    r1, r2, r3c, r5 = crand(1), crand(2), crand(3), crand(5)

    def block_offset(c):
        """Height offset of block c (compact index array) evaluated at every grid point."""
        e_ = edge_c[c]
        dz = J.get('cell_dz', 0.05) * (r1[c] - 0.5)
        tilt = J.get('cell_tilt', 0.02) * ((r2[c] - 0.5) * (X - ccx[c]) + (r3c[c] - 0.5) * (Y - ccy[c]))
        slump = -J.get('edge_drop', 0.25) * r5[c] * e_ * (1 + 0.6 * np.clip(-(Y - ccy[c]) / cell, -1, 1))
        return (dz + tilt) * (0.35 + 0.65 * e_) + slump

    off_a = block_offset(inv)
    off_b = block_offset(ninv)
    wb = 0.5 * (1 - np.clip(e_w / J.get('blend', 0.35), 0, 1)) * (1 - opn)
    T += off_a + (off_b - off_a) * wb
    cw = J.get('crack_w', 0.09) * (0.6 + 0.8 * sm(0.5 + noise2(X, Y, 2.0, 2, 9)))
    groove = opn * (1 - np.clip(e_w / cw, 0, 1)) ** 1.5
    groove *= 1 - back_w * (1 - sm((S - 0.5) / 1.5))     # cracks fade out on the buried landward slope
    T -= J.get('crack_d', 0.12) * groove
    for k, st in enumerate(P.get('steps', [])):
        # terrace riser along the joints: blocks whose centroid lies landward of a wavy line stand higher
        u_c = ccy + P.get('step_wave', 1.0) * noise2(ccx, ccy, 5.0, 2, 40 + k) + 0.45 * cell * (crand(50 + k) - 0.5)
        sdU = blur(sdf_of((u_c > st['y'])[inv], 2.0), 1)
        T += st['h'] * np.where(sdU < 0, 1 - (1 - np.clip(-sdU / st.get('w', 0.35), 0, 1)) ** 2, 0.0)
    for k, es in enumerate(P.get('edge_steps', [])):
        # seaward edge bench: the outermost blocks are one bed lower than the platform behind them (by a varying
        # amount, none in places)
        ins = es['inset'] * (1 + es.get('var', 0.5) * noise2(ccx, ccy, 4.0, 2, 90 + k) / 0.3)
        upper = ((sample2d(S, ccx, ccy) > ins) | (ws_cc < 0.3))[inv]
        sdU = blur(sdf_of(upper, 2.0), 1)
        lift = np.where(sdU < 0, 1 - (1 - np.clip(-sdU / es.get('w', 0.3), 0, 1)) ** 2, 0.0)
        hv = es['h'] * np.clip(0.9 + noise2(X, Y, 6.0, 2, 95 + k) / 0.3 * 0.6, 0, 1.8)
        T -= hv * (1 - lift) * sm((seaward(Y) - 0.25) / 0.4)

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

    strike = math.radians(Bd.get('strike', 0.0)) if Bd else th
    for k, (c, r) in enumerate(scatter(P.get('pools', {}), 0.8)):
        # elongated along the bedding, with a ragged rim (two warp scales) and a flat bed
        asp = rng.uniform(1.3, 2.6)
        ang = strike + rng.normal(0, 0.25)
        dx, dy = X - c[0], Y - c[1]
        u = (dx * math.cos(ang) + dy * math.sin(ang)) / asp
        v = -dx * math.sin(ang) + dy * math.cos(ang)
        wx = r * (0.55 * noise2(X, Y, 0.8 * r, 2, 60 + k) + 0.1 * noise2(X, Y, 0.3 * r + 0.15, 2, 80 + k)) / 0.3
        wy = r * (0.55 * noise2(X, Y, 0.8 * r, 2, 70 + k) + 0.1 * noise2(X, Y, 0.3 * r + 0.15, 2, 85 + k)) / 0.3
        q = np.hypot(u + 0.4 * wx, v + 0.4 * wy) / r
        dep = rng.uniform(*P['pools']['depth'])
        pools = np.maximum(pools, dep * (1 - sm((q - 0.55) / 0.35)))
    for k, (c, r) in enumerate(scatter(P.get('potholes', {}), 0.5)):
        q = np.hypot(X - c[0], Y - c[1]) / r
        dep = rng.uniform(*P['potholes']['depth'])
        pools = np.maximum(pools, dep * (1 - sm((q - 0.35) / 0.65)) ** 0.7)
    T -= pools

    # ------------------------------------------------------------ edge profile -> height field
    # seaward profile: a near-vertical wall with a rounded lip, turning into a wide convex ramp in places
    rampm = P.get('ramp', 0.0) * sm((noise2(X, Y, P.get('ramp_scale', 7.0), 2, 77) - P.get('ramp_thr', 0.1)) / 0.3)
    w_sea = P.get('w_cliff', 0.4) * (1 - rampm) + P.get('w_ramp', 2.5) * rampm
    wprof = w_sea * (1 - back_w) + P.get('w_back', 3.0) * back_w
    t = np.clip(S / wprof, 0, 1)
    pe = 2.2 - 0.8 * rampm
    prof = (1 - (1 - t) ** pe) * (1 - back_w) + sm(t) * back_w
    Z = np.where(S > 0, floor + (T - floor) * prof, floor)

    # ------------------------------------------------------------ fallen blocks
    BL = P.get('blocks', {})
    blocks = []
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
                blocks.append(dict(c=(c[0], c[1], zt - 0.12 * size[2]), size=size, yaw=yaw, ax=ax,
                                   tilt=rng.uniform(5, 18), top=True))
            else:
                top = rng.uniform(*BL.get('top', [0.2, 1.0]))
                size = (s, s * rng.uniform(0.6, 0.95), top - floor + 0.3)
                blocks.append(dict(c=(c[0], c[1], floor - 0.3), size=size, yaw=yaw, ax=ax,
                                   tilt=rng.uniform(4, 22), top=False))
            break
    log('fallen blocks', len(blocks))

    tint = crand(4)[inv]
    return SimpleNamespace(P=P, rng=rng, g=g, xs=xs, ys=ys, X=X, Y=Y, nx=nx, ny=ny, floor=floor, Lx=Lx, Ly=Ly,
                           d_out=d_out, S=S, T=T, Z=Z, groove=groove, pools=pools, tint=tint, bed=bed_k,
                           back_w=back_w, ramp=rampm, blocks=blocks, sample2d=sample2d, seaward=seaward,
                           noise2=noise2)
