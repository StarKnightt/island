"""
README: palm texture atlases (bark/fibre/nut atlas and frond atlas) for the coconut / juvenile palm GLBs.

  bash c:/Code/island/tools/heavy.sh palms E:/blender/blender-5.1.2-windows-x64/blender.exe --background \
       --factory-startup -t 6 --python c:/Code/island/tools/blender/palms/make_textures.py

Inputs (CC0, Poly Haven): palm_tree_bark (Dimitrios Savva, Rico Cilliers) and palm_bark (Charlotte Baglioni) 2k PNG
maps in E:/tmp/island/raw/polyhaven/tex/. Everything else (leaflets, roots, coconuts, stalks) is painted here with
numpy, deterministic seeds. Writes E:/tmp/island/helpers/palms/tex/*.png plus bark_rings.json (groove positions of
the bark tile, used by the trunk builder) and preview sheets.
Layout of both atlases: palm_layout.py.
"""
import sys, os, json, math, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from common import *
from palm_layout import *

TEX = SCRATCH + '/tex'
os.makedirs(TEX, exist_ok=True)
T0 = time.time()


def log(*a):
    print(f'[tex {time.time() - T0:6.1f}s]', *a, flush=True)


def box_blur(a, ry, rx, wrap=True):
    """separable box blur on axis 0 (radius ry) and 1 (radius rx)"""
    out = a.astype(np.float32)
    for axis, r in ((0, ry), (1, rx)):
        if r <= 0:
            continue
        if wrap:
            c = np.cumsum(np.concatenate([np.take(out, range(-r - 1, 0), axis=axis), out, np.take(out, range(0, r), axis=axis)], axis=axis), axis=axis)
        else:
            pad = [(0, 0)] * out.ndim
            pad[axis] = (r + 1, r)
            c = np.cumsum(np.pad(out, pad, mode='edge'), axis=axis)
        n = out.shape[axis]
        hi = np.take(c, range(2 * r + 1, 2 * r + 1 + n), axis=axis)
        lo = np.take(c, range(0, n), axis=axis)
        out = (hi - lo) / (2 * r + 1)
    return out


def lum(rgb):
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def srgb8(c):
    return srgb_to_lin(np.array(c, np.float32) / 255.0)


# =====================================================================================================================
# BARK ATLAS
# =====================================================================================================================
def build_bark_atlas():
    rng = np.random.default_rng(11)
    src = f'{RAW}/tex/palm_tree_bark/palm_tree_bark_'
    diff = load_image(src + 'diff_2k.png', linear=True)[..., :3]
    log('bark diff raw mean', diff.reshape(-1, 3).mean(0))
    diff = srgb_to_lin(diff)
    nor = load_image(src + 'nor_gl_2k.png', linear=True)[..., :3]
    rough = load_image(src + 'rough_2k.png', linear=True)[..., 0]
    ao = load_image(src + 'ao_2k.png', linear=True)[..., 0]
    disp = load_image(src + 'disp_2k.png', linear=True)[..., 0]
    H, W = disp.shape
    log('bark src', W, 'x', H)

    # roll so the deepest ring groove sits on row 0 (tile seams then hide in a groove)
    prof = box_blur(disp.mean(axis=1)[:, None], 40, 0)[:, 0]
    shift = int(np.argmin(prof))
    roll = lambda a: np.roll(a, -shift, axis=0)
    diff, nor, rough, ao, disp = map(roll, (diff, nor, rough, ao, disp))

    # remove distinctive dark streaks (they would repeat up the trunk): outliers vs. the row-wise local average
    def streak_mask(diff):
        L = lum(diff)
        ratio = L / np.maximum(box_blur(L, 8, 160), 1e-4)
        vdark = (ratio < 0.3).astype(np.float32)                    # near-black scratch marks only
        cluster = box_blur(vdark, 20, 20)                             # ... that form a sizeable cluster
        m = np.clip((cluster - 0.08) / 0.06, 0, 1)
        return np.clip(box_blur(m, 14, 14) * 2.0, 0, 1)

    m = streak_mask(diff)
    log('streak mask coverage', float(m.mean()))
    for k in range(2):
        sh = W // 2 if k == 0 else W // 3
        alt = lambda a: np.roll(a, sh, axis=1)
        mm = m[..., None]
        diff = diff * (1 - mm) + alt(diff) * mm
        nor = nor * (1 - mm) + alt(nor) * mm
        rough = rough * (1 - m) + alt(rough) * m
        ao = ao * (1 - m) + alt(ao) * m
        disp = disp * (1 - m) + alt(disp) * m
        m = streak_mask(diff)
        log('  remaining streak mask', float(m.mean()))

    # downsample to the 1024 x 1024 tile
    th = TILE_ROWS[1] - TILE_ROWS[0]
    d_t = resize(diff, th, BARK_W)
    n_t = resize(nor, th, BARK_W)
    r_t = resize(rough[..., None], th, BARK_W)[..., 0]
    a_t = resize(ao[..., None], th, BARK_W)[..., 0]
    h_t = resize(disp[..., None], th, BARK_W)[..., 0]

    # colour grade toward the spec trunk albedo (sRGB mean 125,116,102) and darker ring grooves (~82,74,64)
    target = srgb8((125, 116, 102))
    cur = d_t.reshape(-1, 3).mean(0)
    d_t = d_t * (target / cur)
    rowmean = h_t.mean(1, keepdims=True)
    ring = np.clip((box_blur(rowmean, 30, 0) - rowmean) / 0.05, 0, 1)            # whole-row grooves (leaf scars)
    crevice = np.clip((box_blur(h_t, 3, 60) - h_t) / 0.06, 0, 1)                 # local cracks inside a scar
    groove = np.clip(box_blur(ring * 0.7 + crevice * ring * 0.5 + crevice * 0.25, 2, 4), 0, 1)
    d_t = d_t * (1 - 0.42 * groove[..., None])
    # weathering variation: large soft blotches (grey-green lichen, darker damp streaks)
    blot = fbm(th, BARK_W, 3, 4, rng, 4)
    lichen = np.clip((blot - 0.58) / 0.12, 0, 1) * np.clip(fbm(th, BARK_W, 12, 16, rng, 3) * 1.6 - 0.5, 0, 1)
    d_t = d_t * (1 - 0.35 * lichen[..., None]) + srgb8((150, 152, 132)) * 0.35 * lichen[..., None]
    streak = np.clip(fbm(th, BARK_W, 2, 24, rng, 3) * 1.8 - 1.0, 0, 1)
    d_t *= (1 - 0.18 * streak[..., None])
    cur = d_t.reshape(-1, 3).mean(0)
    d_t = d_t * (target / cur)
    log('bark tile srgb mean', (lin_to_srgb(d_t).reshape(-1, 3).mean(0) * 255).round(1),
        'groove srgb', (lin_to_srgb(d_t[groove > 0.6]).mean(0) * 255).round(1) if (groove > 0.6).any() else '-')

    # ring groove positions in the tile (fraction of tile height, from the bottom) for the LOD0 geometry
    rp = box_blur(h_t.mean(axis=1)[:, None], 6, 0)[:, 0]
    mins = [i for i in range(th) if rp[i] <= rp[(i - 1) % th] and rp[i] < rp[(i + 1) % th] and rp[i] < np.percentile(rp, 45)]
    # merge minima closer than 40 px
    grooves = []
    for i in mins:
        if grooves and i - grooves[-1] < 40:
            if rp[i] < rp[grooves[-1]]:
                grooves[-1] = i
        else:
            grooves.append(i)
    rings = {'tile_len_m': TILE_LEN_M, 'grooves': [g / th for g in grooves],
             'depth': [float((rp.max() - rp[g]) / (rp.max() - rp.min() + 1e-6)) for g in grooves]}
    with open(TEX + '/bark_rings.json', 'w') as f:
        json.dump(rings, f, indent=1)
    log('ring grooves', len(grooves), [round(g, 3) for g in rings['grooves']])

    # ---------------------------------------------------------------- atlas canvases
    A = np.zeros((BARK_H, BARK_W, 3), np.float32)
    N = np.zeros((BARK_H, BARK_W, 3), np.float32) + np.array([0.5, 0.5, 1.0], np.float32)
    R = np.ones((BARK_H, BARK_W), np.float32) * 0.8
    O = np.ones((BARK_H, BARK_W), np.float32)
    t0, t1 = TILE_ROWS
    A[t0:t1], N[t0:t1], R[t0:t1], O[t0:t1] = d_t, n_t, np.clip(r_t * 1.05 + 0.05, 0, 1), a_t
    g0, g1 = GUARD_ROWS
    A[g0:g1], N[g0:g1], R[g0:g1], O[g0:g1] = d_t[:g1 - g0], n_t[:g1 - g0], R[t0:t0 + g1 - g0], a_t[:g1 - g0]

    # ---------------------------------------------------------------- bole band: bark continuing down into roots
    b0, b1 = BOLE_ROWS
    bh = b1 - b0
    band_d = d_t[th - bh:].copy()
    band_n = n_t[th - bh:].copy()
    band_r = R[t1 - bh:t1].copy()
    band_o = a_t[th - bh:].copy()
    y = np.arange(bh, dtype=np.float32)[:, None]
    x = np.arange(BARK_W, dtype=np.float32)[None, :]
    # roots: wavy vertical tubes of varying width, densest at the bottom
    root_cov = np.zeros((bh, BARK_W), np.float32)
    root_col = np.zeros((bh, BARK_W, 3), np.float32)
    root_nx = np.zeros((bh, BARK_W), np.float32)
    nroots = 260
    root_pal = [(88, 66, 50), (76, 58, 46), (98, 80, 62), (70, 56, 46), (104, 88, 70)]
    for i in range(nroots):
        cx = rng.uniform(0, BARK_W)
        top = rng.uniform(0.18, 0.62) * bh          # roots emerge at different heights on the bole
        wid = rng.uniform(1.6, 4.2)                 # half width in px (roots 7-18 mm)
        amp = rng.uniform(0.5, 3.0)
        fr = rng.uniform(0.004, 0.012)
        ph = rng.uniform(0, 6.28)
        slant = rng.uniform(-0.35, 0.35)
        xc = cx + slant * (top - y) + amp * np.sin(y * fr * 6.28 + ph)
        dx = (x - xc + BARK_W / 2) % BARK_W - BARK_W / 2
        tt = np.clip((top - y) / 25.0, 0, 1)          # taper in where it emerges
        w = wid * (0.4 + 0.6 * tt)
        d = np.abs(dx)
        cov = np.clip(np.minimum(d + 0.5, w) - np.maximum(d - 0.5, -w), 0, 1) * (y < top)
        s = np.clip(dx / np.maximum(w, 1e-3), -1, 1)
        c = srgb8(root_pal[int(rng.integers(len(root_pal)))]) * rng.uniform(0.85, 1.15)
        c = c * (1 - 0.25 * np.abs(s))[..., None]       # rounded root: darker flanks (form, not light)
        newer = cov > root_cov * 0.6
        root_col = np.where(newer[..., None], c, root_col)
        root_nx = np.where(newer, s * 0.9, root_nx)
        root_cov = np.maximum(root_cov, cov)
    soil = srgb8((66, 54, 44)) * (0.8 + 0.4 * fbm(bh, BARK_W, 8, 32, rng, 3))[..., None]
    sand = np.clip((fbm(bh, BARK_W, 24, 96, rng, 2) - 0.55) * 5, 0, 1) * np.clip(1 - y / (0.25 * bh), 0, 1)
    soil = soil * (1 - sand[..., None]) + srgb8((176, 162, 136)) * sand[..., None]
    roots_rgb = soil * (1 - root_cov[..., None]) + root_col * root_cov[..., None]
    fade = 1 - np.clip((y - 0.30 * bh) / (0.55 * bh), 0, 1)   # 1 = roots (bottom) .. 0 = bark (top)
    fade = np.clip(fade + (fbm(bh, BARK_W, 4, 16, rng, 3) - 0.5) * 0.5, 0, 1) ** 1.3
    fade[-40:] *= np.linspace(1, 0, 40)[:, None]
    # bark near the ground is darker and browner (damp sand splash)
    damp = np.clip(1.4 - y / bh * 1.6, 0, 1)[..., None]
    band_d = band_d * (1 - 0.35 * damp) * (1 - damp * np.array([0.0, 0.05, 0.12], np.float32))
    A[b0:b1] = band_d * (1 - fade[..., None]) + roots_rgb * fade[..., None]
    rn = np.stack([root_nx, np.zeros_like(root_nx), np.sqrt(np.clip(1 - root_nx ** 2, 0, 1))], -1) * 0.5 + 0.5
    rn = rn * root_cov[..., None] + np.array([0.5, 0.5, 1.0], np.float32) * (1 - root_cov[..., None])
    N[b0:b1] = band_n * (1 - fade[..., None]) + rn * fade[..., None]
    R[b0:b1] = band_r * (1 - fade) + 0.85 * fade
    O[b0:b1] = band_o * (1 - fade) + (0.55 + 0.45 * root_cov) * fade

    # ---------------------------------------------------------------- fibre (leaf sheath) from palm_bark
    fsrc = f'{RAW}/tex/palm_bark/palm_bark_'
    f_d = srgb_to_lin(load_image(fsrc + 'diff_2k.png', linear=True)[..., :3])
    f_n = load_image(fsrc + 'nor_gl_2k.png', linear=True)[..., :3]
    f_r = load_image(fsrc + 'rough_2k.png', linear=True)[..., 0]
    f_a = load_image(fsrc + 'ao_2k.png', linear=True)[..., 0]
    f0, f1 = FIBRE_ROWS
    fh = f1 - f0
    crop = slice(400, 400 + fh * 2)
    fd = resize(f_d[crop], fh, BARK_W)
    tgt = srgb8((95, 70, 45))
    fd = fd * (tgt / fd.reshape(-1, 3).mean(0))
    # some paler, greyer old fibre streaks
    pale = np.clip(fbm(fh, BARK_W, 3, 10, rng, 3) * 2 - 1.05, 0, 1)
    fd = fd * (1 - 0.5 * pale[..., None]) + srgb8((128, 108, 84)) * 0.5 * pale[..., None]
    A[f0:f1] = fd
    N[f0:f1] = resize(f_n[crop], fh, BARK_W)
    R[f0:f1] = np.clip(resize(f_r[crop][..., None], fh, BARK_W)[..., 0] * 1.0 + 0.1, 0, 1)
    O[f0:f1] = resize(f_a[crop][..., None], fh, BARK_W)[..., 0]
    log('fibre srgb mean', (lin_to_srgb(A[f0:f1]).reshape(-1, 3).mean(0) * 255).round(1))

    # ---------------------------------------------------------------- coconuts, stalk, spathe
    n0, n1 = NUT_ROWS
    nh = n1 - n0
    yy = (np.arange(nh, dtype=np.float32)[:, None] + 0.5) / nh       # 0 = distal tip .. 1 = stalk end
    xx = (np.arange(256, dtype=np.float32)[None, :] + 0.5) / 256     # around the nut
    palettes = [((95, 110, 40), (120, 128, 48)), ((132, 128, 46), (150, 140, 56)), ((110, 75, 45), (128, 92, 58))]
    for col, (c_main, c_alt) in enumerate(palettes):
        r2 = np.random.default_rng(100 + col)
        mott = fbm(nh, 256, 6, 6, r2, 4)
        fibres = fbm(nh, 256, 3, 64, r2, 3)
        base = srgb8(c_main) * (1 - 0.35 * mott[..., None]) + srgb8(c_alt) * 0.35 * mott[..., None]
        base *= (0.92 + 0.16 * fibres)[..., None]
        # three faint ridges (trigonal fruit)
        ridge = np.cos(xx * 6.2832 * 3) * 0.5 + 0.5
        base *= (1 + 0.05 * (ridge - 0.5))[..., None]
        # calyx: brown-grey sepals over the top 14 %, darker distal point
        sep = np.clip((yy - 0.86 - 0.025 * np.sin(xx * 6.2832 * 3)) / 0.02, 0, 1)
        sep_col = srgb8((92, 74, 52)) * (0.85 + 0.3 * fibres)[..., None]
        base = base * (1 - sep[..., None]) + sep_col * sep[..., None]
        tip = np.clip((0.035 - yy) / 0.03, 0, 1)
        base = base * (1 - tip[..., None] * 0.6) + srgb8((70, 60, 40)) * tip[..., None] * 0.6
        if col == 2:   # dry nut: greyish patches
            g = np.clip((fbm(nh, 256, 4, 4, r2, 3) - 0.55) * 4, 0, 1)
            base = base * (1 - 0.4 * g[..., None]) + srgb8((128, 116, 100)) * 0.4 * g[..., None]
        A[n0:n1, col * 256:(col + 1) * 256] = base
        hgt = fibres * 0.6 + ridge * 0.4 + sep * 0.8
        N[n0:n1, col * 256:(col + 1) * 256] = height_to_normal(hgt, 3.0)
        R[n0:n1, col * 256:(col + 1) * 256] = (0.48 + 0.12 * mott + 0.3 * sep) if col < 2 else (0.75 + 0.1 * mott)
        O[n0:n1, col * 256:(col + 1) * 256] = 1 - 0.2 * sep
    # stalk (bottom half of column 3): yellow-green to tan with longitudinal striations (u along the stalk)
    r3 = np.random.default_rng(130)
    sx = 256
    st = fbm(128, sx, 16, 2, r3, 3)
    stalk = srgb8((150, 132, 66)) * (0.85 + 0.3 * st)[..., None]
    A[n0:n0 + 128, 768:] = stalk
    N[n0:n0 + 128, 768:] = height_to_normal(st, 2.0)
    R[n0:n0 + 128, 768:] = 0.6
    # spathe (top half): brown woody, ridged
    sp = fbm(128, sx, 24, 3, r3, 3)
    spathe = srgb8((118, 90, 60)) * (0.8 + 0.4 * sp)[..., None]
    A[n0 + 128:n1, 768:] = spathe
    N[n0 + 128:n1, 768:] = height_to_normal(sp, 3.0)
    R[n0 + 128:n1, 768:] = 0.8

    write_png(TEX + '/palm_bark_basecolor.png', lin_to_srgb(A))
    write_png(TEX + '/palm_bark_normal.png', N)
    orm = np.stack([O, np.clip(R, 0.05, 1), np.zeros_like(R)], -1)
    write_png(TEX + '/palm_bark_orm.png', orm)
    log('bark atlas written')
    return lin_to_srgb(A), N, orm


# =====================================================================================================================
# FROND ATLAS
# =====================================================================================================================
ROW_STYLE = {
    #            colours (sRGB, sampled per leaflet)         width  spacing clump  conv      torn  miss  split dry   rough
    'green1': dict(cols=[(84, 104, 40), (92, 108, 42), (80, 98, 38), (98, 112, 46), (76, 96, 40)],
                   width=22, spacing=25, clump=(1, 4), conv=(0.35, 0.9), torn=0.06, miss=0.03, split=0.04, dry=0.10,
                   rough=0.58, dry_col=(150, 120, 70), seed=1, sway=0.35),
    'green2': dict(cols=[(94, 108, 44), (88, 106, 40), (102, 114, 48), (84, 100, 38), (96, 104, 42)],
                   width=22, spacing=25, clump=(1, 4), conv=(0.35, 0.9), torn=0.08, miss=0.04, split=0.05, dry=0.14,
                   rough=0.6, dry_col=(146, 116, 68), seed=2, sway=0.35),
    'old':    dict(cols=[(150, 140, 52), (166, 142, 56), (140, 136, 60), (158, 120, 52), (128, 126, 50)],
                   width=20, spacing=25, clump=(2, 5), conv=(0.5, 0.95), torn=0.14, miss=0.07, split=0.06, dry=0.35,
                   rough=0.68, dry_col=(140, 104, 62), seed=3, sway=0.45),
    'dead':   dict(cols=[(150, 118, 72), (132, 102, 64), (118, 92, 60), (105, 80, 52), (140, 120, 92)],
                   width=13, spacing=24, clump=(2, 6), conv=(0.6, 1.0), torn=0.22, miss=0.06, split=0.0, dry=0.0,
                   rough=0.85, dry_col=(100, 78, 52), seed=4, sway=0.7),
    'young':  dict(cols=[(150, 150, 72), (140, 146, 66), (156, 152, 78), (132, 140, 62)],
                   width=17, spacing=21, clump=(1, 2), conv=(0.1, 0.35), torn=0.0, miss=0.0, split=0.0, dry=0.0,
                   rough=0.52, dry_col=(150, 130, 80), seed=5, sway=0.2),
}


def paint_row(name, S=2):
    st = ROW_STYLE[name]
    rng = np.random.default_rng(st['seed'] * 7919)
    r0, r1 = ROWS[name]
    H = (r1 - r0) * S
    W = FROND_W * S
    rgb = np.zeros((H, W, 3), np.float32)
    alpha = np.zeros((H, W), np.float32)
    nrm = np.zeros((H, W, 3), np.float32) + np.array([0.0, 0.0, 1.0], np.float32)
    rough = np.ones((H, W), np.float32) * st['rough']
    kind = 'young' if name == 'young' else 'mature'
    sp = st['spacing'] * S
    margin = 0.5 * st['width'] * S + 3 * S
    count = 0
    for k in range(N_SLOTS):
        u0, u1 = slot_bounds(k)
        x0, x1 = u0 * W + margin, u1 * W - margin
        n = max(1, int(round((x1 - x0) / sp)) + 1)
        xs = np.linspace(x0, x1, n) + rng.uniform(-0.22, 0.22, n) * sp
        xs = np.clip(xs, x0, x1)
        keep = rng.random(n) >= st['miss']
        xs = xs[keep]
        if len(xs) == 0:
            continue
        # clumps
        groups, i = [], 0
        while i < len(xs):
            g = int(rng.integers(st['clump'][0], st['clump'][1] + 1))
            groups.append(list(range(i, min(len(xs), i + g))))
            i += g
        order = []
        for g in groups:
            cx = xs[g].mean()
            conv = rng.uniform(*st['conv'])
            for j in g:
                order.append((xs[j], cx, conv))
        rng.shuffle(order)
        for xr, cx, conv in order:
            u = xr / W
            env = envelope(kind, u)
            ln = env * H * rng.uniform(0.86, 0.99)
            wid = st['width'] * S * rng.uniform(0.85, 1.12) * (0.75 + 0.25 * min(1, env / 0.6))
            sway = rng.uniform(-1, 1) * st['sway'] * sp
            torn = rng.random() < st['torn']
            t_cut = rng.uniform(0.45, 0.85) if torn else 2.0
            split = rng.random() < st['split']
            t_split = rng.uniform(0.35, 0.7) if split else 2.0
            dry = rng.random() < st['dry']
            t_dry = rng.uniform(0.7, 0.92) if dry else 2.0
            col = srgb8(st['cols'][int(rng.integers(len(st['cols'])))]) * rng.uniform(0.88, 1.12)
            col = col * np.array([rng.uniform(0.95, 1.05), 1.0, rng.uniform(0.9, 1.1)], np.float32)
            dry_col = srgb8(st['dry_col']) * rng.uniform(0.85, 1.15)
            fold = math.radians(rng.uniform(16, 28))
            lr = st['rough'] * rng.uniform(0.9, 1.12)
            ytop = int(min(H, ln + 2))
            if ytop < 4:
                continue
            y = np.arange(ytop, dtype=np.float32)[:, None]
            t = np.clip(y / ln, 0, 1)
            # midline: converge to clump centre toward the tip, plus a gentle sway
            xc = xr + (cx - xr) * conv * t ** 1.6 + sway * np.sin(np.pi * t) * t
            # leaflet outline (linear-lanceolate): narrow stalk, parallel sides to ~55 %, acuminate tip
            t_full = rng.uniform(0.5, 0.62)
            prof = (0.35 + 0.65 * np.clip(t / 0.06, 0, 1) ** 0.6) * (1 - 0.08 * np.clip(t / t_full, 0, 1))
            prof *= np.clip(1 - np.clip((t - t_full) / (1 - t_full), 0, 1), 0, 1) ** 0.8
            hw = 0.5 * wid * np.maximum(prof, 0.0) + 0.3 * S * (1 - t)
            hw = np.where(y <= ln, hw, 0.0)
            # never cross the slot boundary (LOD0 cuts the row into cards there)
            xc = np.clip(xc, u0 * W + hw + S, u1 * W - hw - S)
            xa = int(max(0, np.floor((xc - hw).min()) - 2))
            xb = int(min(W, np.ceil((xc + hw).max()) + 3))
            if xb <= xa:
                continue
            x = np.arange(xa, xb, dtype=np.float32)[None, :]
            dxp = x - xc
            d = np.abs(dxp)
            cov = np.clip(np.minimum(d + 0.5, hw) - np.maximum(d - 0.5, -hw), 0, 1)
            s = np.clip(dxp / np.maximum(hw, 0.5), -1, 1)
            if torn:
                jag = t_cut + 0.05 * np.sin(s * 7.0 + xr) + 0.03 * np.sin(s * 19.0)
                cov *= np.clip((jag - t) * ln / 1.5 + 0.5, 0, 1)
            if split:
                cov *= np.where(t > t_split, np.clip((np.abs(s) - 0.1) * hw / 1.2 + 0.5, 0, 1), 1.0)
            if cov.max() <= 0:
                continue
            # colour: paler base and midrib, faint veins, dry tips, sparse blemishes
            c = np.broadcast_to(col, cov.shape + (3,)).copy()
            # yellower base, slow tone drift along the blade, faint lengthwise streaks
            base_k = np.clip(0.14 - t, 0, 1)[..., None] / 0.14
            c = c * (1 - 0.35 * base_k) + c * np.array([1.35, 1.2, 1.0], np.float32) * 0.35 * base_k
            ph1, ph2 = rng.uniform(0, 6.28, 2)
            drift = 1 + 0.07 * np.sin(t * rng.uniform(4, 9) + ph1) + 0.04 * np.sin(t * rng.uniform(15, 30) + ph2)
            c *= (drift * (1 - 0.05 * t))[..., None]
            mid = np.clip(1 - np.abs(s) / 0.09, 0, 1)
            c = c * (1 - 0.5 * mid[..., None]) + srgb8((150, 146, 74)) * 0.5 * mid[..., None]
            vein = 0.5 + 0.5 * np.cos(s * np.pi * 9 + rng.uniform(0, 3))
            c *= (0.95 + 0.05 * vein)[..., None]
            # leaf margin a touch lighter (thin edge, waxy)
            c *= (1 + 0.06 * np.clip((np.abs(s) - 0.8) / 0.2, 0, 1))[..., None]
            dm = np.zeros_like(cov)
            if dry:
                dm = np.clip((t - t_dry + 0.02 * np.sin(s * 9 + xr)) / 0.05, 0, 1)
                c = c * (1 - dm[..., None]) + dry_col * dm[..., None]
            if name != 'young' and rng.random() < 0.25:
                by, bx = rng.uniform(0.2, 0.8), rng.uniform(-0.6, 0.6)
                bm = np.clip(1 - np.hypot((t - by) * ln / (2.5 * S), (s - bx) * hw / (2.0 * S)), 0, 1)
                c = c * (1 - 0.6 * bm[..., None]) + srgb8((120, 96, 58)) * 0.6 * bm[..., None]
            # normal: V fold along the midrib (valley on the upper side), margins curl a little more
            a = -np.sign(s) * fold * np.clip(np.abs(s) / 0.15, 0, 1) - np.sign(s) * 0.35 * fold * np.clip((np.abs(s) - 0.7) / 0.3, 0, 1)
            a += 0.06 * np.sin(s * np.pi * 7)
            # slope of the midline along the leaflet tilts the normal slightly
            nx, nz = np.sin(a), np.cos(a)
            ny = np.zeros_like(nx) - 0.08 * (t - 0.5)
            nn = np.stack([nx, ny, nz], -1)
            ccov = cov[..., None]
            sl = (slice(0, ytop), slice(xa, xb))
            rgb[sl] = rgb[sl] * (1 - ccov) + c * ccov
            nrm[sl] = nrm[sl] * (1 - ccov) + nn * ccov
            rough[sl] = rough[sl] * (1 - cov) + (lr + 0.25 * dm) * cov
            alpha[sl] = np.maximum(alpha[sl], cov)
            count += 1
    # downsample supersampled canvases
    h1, w1 = H // S, W // S
    a1 = resize(alpha[..., None], h1, w1)[..., 0]
    rgb1 = resize(rgb * alpha[..., None], h1, w1) / np.maximum(a1, 1e-4)[..., None]
    n1 = resize(nrm * alpha[..., None], h1, w1)
    n1 = n1 + np.array([0, 0, 1], np.float32) * (1 - a1)[..., None]
    n1 /= np.linalg.norm(n1, axis=-1, keepdims=True)
    r1 = resize((rough * alpha)[..., None], h1, w1)[..., 0] / np.maximum(a1, 1e-4) * (a1 > 0) + st['rough'] * (a1 <= 0)
    cover = float((a1 > 0.5).mean())
    sel = a1 > 0.5
    mean_srgb = (lin_to_srgb(rgb1[sel]).mean(0) * 255).round(1) if sel.any() else None
    log(f'row {name}: {count} leaflets, coverage {cover:.2f}, mean sRGB {mean_srgb}')
    return rgb1, a1, n1 * 0.5 + 0.5, r1


def paint_rachis(name, h, rng):
    """rachis colour strip: u along the frond (0 = petiole base), v around the cross-section"""
    W = FROND_W
    u = (np.arange(W, dtype=np.float32)[None, :] + 0.5) / W
    v = (np.arange(h, dtype=np.float32)[:, None] + 0.5) / h
    if name == 'green':
        c0, c1, c2 = srgb8((150, 130, 72)), srgb8((130, 120, 70)), srgb8((108, 114, 52))
    elif name == 'old':
        c0, c1, c2 = srgb8((160, 134, 70)), srgb8((158, 136, 60)), srgb8((148, 126, 56))
    else:
        c0, c1, c2 = srgb8((118, 96, 70)), srgb8((128, 104, 72)), srgb8((112, 88, 60))
    k = np.clip(u / 0.3, 0, 1)[..., None]
    c = c0 * (1 - k) + c1 * k
    k2 = np.clip((u - 0.3) / 0.7, 0, 1)[..., None]
    c = c * (1 - k2) + c2 * k2
    streak = fbm(h, W, 2, 96, rng, 3)
    c = c * (0.9 + 0.2 * streak)[..., None]
    c = c * (1.0 + 0.06 * np.cos(v * 6.2832))[..., None]  # side faces slightly different (upper channel greener)
    return np.broadcast_to(c, (h, W, 3)).copy()


def build_frond_atlas():
    A = np.zeros((FROND_H, FROND_W, 3), np.float32)
    AL = np.zeros((FROND_H, FROND_W), np.float32)
    N = np.zeros((FROND_H, FROND_W, 3), np.float32) + np.array([0.5, 0.5, 1.0], np.float32)
    R = np.ones((FROND_H, FROND_W), np.float32) * 0.6
    stats = {}
    for name, (r0, r1) in ROWS.items():
        rgb, a, n, r = paint_row(name)
        A[r0:r1], AL[r0:r1], N[r0:r1], R[r0:r1] = rgb, a, n, r
        stats[name] = float((a > 0.5).mean())
    rng = np.random.default_rng(77)
    for name, (r0, r1) in RACHIS_ROWS.items():
        A[r0:r1] = paint_rachis(name, r1 - r0, rng)
        AL[r0:r1] = 1.0
        R[r0:r1] = 0.62 if name != 'dead' else 0.85
    # fill RGB of transparent texels with nearby leaf colour so mips do not fringe dark / white
    A = dilate_rgb(A, AL)
    write_png(TEX + '/palm_frond_basecolor.png', np.concatenate([lin_to_srgb(A), AL[..., None]], -1))
    write_png(TEX + '/palm_frond_normal.png', N)
    O = np.ones_like(R)
    write_png(TEX + '/palm_frond_orm.png', np.stack([O, np.clip(R, 0.05, 1), np.zeros_like(R)], -1))
    with open(TEX + '/frond_stats.json', 'w') as f:
        json.dump(stats, f, indent=1)
    log('frond atlas written')
    return lin_to_srgb(A), AL, N


def sheets(bark, frond):
    # preview sheets for eyeballing (alpha shown over sky blue)
    b_rgb, b_n, b_orm = bark
    f_rgb, f_a, f_n = frond
    sky = np.array([0.55, 0.72, 0.92], np.float32)
    f_vis = f_rgb * f_a[..., None] + sky * (1 - f_a[..., None])
    write_png(SCRATCH + '/previews/tex_frond_sheet.png', resize(np.concatenate([f_vis, f_n], 1), 1024, 2048))
    write_png(SCRATCH + '/previews/tex_frond_crop.png', f_vis[0:600, 0:1100])
    write_png(SCRATCH + '/previews/tex_bark_sheet.png', resize(np.concatenate([b_rgb, b_n, b_orm], 1), 1024, 1536))
    write_png(SCRATCH + '/previews/tex_bark_crop.png', b_rgb[0:900, 0:900])


if __name__ == '__main__':
    which = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    bark = build_bark_atlas()
    frond = build_frond_atlas()
    sheets(bark, frond)
    log('done')
