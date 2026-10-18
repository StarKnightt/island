"""Single-leaf texture sheets for the jungle sprig renders (system Python + numpy):

    python tools/blender/jungle/leaf_textures.py [--only ell,obo,...]

Each leaf type gets a horizontal sheet of variants (green moods, damaged, senescent, dead). Per sheet:
  leaf_<type>_albedo.png (sRGB, alpha = blade), leaf_<type>_back.png (underside albedo), leaf_<type>_normal.png,
  leaf_<type>_rough.png, and leaf_<type>.json (cells, physical size). Row 0 = leaf tip, bottom row = leaf base.
No lighting is baked into any albedo.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jtex as T  # noqa: E402

OUT = 'E:/tmp/island/helpers/jungle/tex/leaves'

# sRGB palette (spec albedo targets): dark glossy, mid, young/sunlit, dead
PAL = {
    'dark': (38, 60, 30), 'mid': (60, 86, 36), 'young': (105, 124, 44), 'blue': (40, 64, 44),
    'olive': (78, 90, 40), 'dead': (135, 98, 58), 'tan': (160, 128, 78), 'dkbrown': (92, 62, 38),
    'yellow': (168, 150, 60), 'apple': (98, 132, 40), 'strap': (88, 120, 34),
}


def outline(kind, t, s):
    """Half-width (0..1 of max) of the blade at t (0 base .. 1 tip). Some kinds return a cut mask too."""
    if kind == 'ell':  # elliptic with acuminate drip tip, cuneate-rounded base
        body = np.maximum(np.sin(np.pi * np.clip(t, 0, 1) ** 0.82), 0) ** 0.85
        tip = 1.0 - 0.55 * T.smoothstep(0.62, 0.97, t)
        return body * tip
    if kind == 'obo':  # obovate, widest ~0.62, short point
        tt = np.clip(t, 0, 1)
        body = (tt ** 0.9 * (1 - tt) ** 0.42)
        body = body / 0.6075
        return np.clip(body, 0, 1.2) * (1 - 0.25 * T.smoothstep(0.85, 1.0, t))
    if kind == 'pin':  # oblong leaflet, slightly asymmetric
        body = np.maximum(np.sin(np.pi * np.clip(t, 0, 1) ** 0.9), 0) ** 0.6
        return body * (1 - 0.3 * T.smoothstep(0.8, 1.0, t))
    if kind == 'cor':  # cordate: broad base lobes (t<0.2) + acuminate tip
        tt = np.clip(t, 0, 1)
        body = np.maximum(np.sin(np.pi * (0.08 + 0.92 * tt) ** 0.62), 0) ** 0.75
        body *= 1 - 0.5 * T.smoothstep(0.6, 0.98, tt)
        return body * (0.75 + 0.25 * T.smoothstep(0.0, 0.18, tt))
    if kind == 'strap':  # bird's-nest fern frond: long strap, narrowed base, acute tip
        tt = np.clip(t, 0, 1)
        return (T.smoothstep(0.0, 0.3, tt) * 0.85 + 0.15) * (1 - T.smoothstep(0.7, 1.0, tt) ** 1.4)
    if kind == 'brom':  # bromeliad leaf: sheathing base, strap, acute tip
        tt = np.clip(t, 0, 1)
        return (1.0 - 0.25 * T.smoothstep(0.05, 0.25, tt)) * (1 - T.smoothstep(0.55, 1.0, tt) ** 1.6)
    if kind == 'pinna':  # fern pinna: lanceolate, long taper (pinnule comb is cut in make_leaf)
        tt = np.clip(t, 0, 1)
        return (T.smoothstep(0.0, 0.12, tt) * 0.7 + 0.3) * (1 - tt ** 1.25)
    if kind == 'palmlet':  # feather-palm leaflet: linear, acuminate
        tt = np.clip(t, 0, 1)
        return T.smoothstep(0.0, 0.1, tt) * (1 - T.smoothstep(0.55, 1.0, tt) ** 1.3)
    raise ValueError(kind)


TYPES = {
    # kind, cell px (w, h), physical (width m, length m), secondaries, curve-up, gamma, variants
    'ell': dict(kind='ell', cw=160, ch=416, size=(0.058, 0.15), nsec=9, kup=0.22, gam=1.35, im=True,
                variants=['dark', 'mid', 'mid', 'young', 'blue', 'old', 'yellowing', 'dead']),
    'obo': dict(kind='obo', cw=208, ch=416, size=(0.10, 0.2), nsec=13, kup=0.07, gam=1.05, im=True,
                variants=['dark', 'dark', 'mid', 'blue', 'young', 'old', 'yellowing', 'dead']),
    'pin': dict(kind='pin', cw=96, ch=256, size=(0.022, 0.06), nsec=5, kup=0.2, gam=1.3, im=False,
                variants=['mid', 'mid', 'young', 'young', 'dark', 'olive', 'yellowing', 'dead']),
    'cor': dict(kind='cor', cw=256, ch=320, size=(0.10, 0.125), nsec=4, kup=0.3, gam=1.5, im=False,
                variants=['dark', 'mid', 'mid', 'young', 'blue', 'old', 'yellowing', 'dead']),
    'pinna': dict(kind='pinna', cw=160, ch=512, size=(0.13, 0.42), nsec=0, kup=0.0, gam=1.0, im=False,
                  variants=['mid', 'young', 'mid', 'apple', 'olive', 'old', 'yellowing', 'dead']),
    'palmlet': dict(kind='palmlet', cw=48, ch=640, size=(0.03, 0.42), nsec=0, kup=0.0, gam=1.0, im=False,
                    variants=['dark', 'mid', 'mid', 'young', 'blue', 'old', 'yellowing', 'dead']),
    'bigobo': dict(kind='obo', cw=256, ch=512, size=(0.17, 0.38), nsec=12, kup=0.08, gam=1.05, im=True,
                   variants=['dark', 'mid', 'young', 'blue', 'mid', 'old', 'yellowing', 'dead']),
    'strap': dict(kind='strap', cw=144, ch=1024, size=(0.13, 0.95), nsec=0, kup=0.0, gam=1.0, im=False,
                  variants=['apple', 'apple', 'young', 'mid', 'olive', 'old', 'yellowing', 'dead']),
    'brom': dict(kind='brom', cw=96, ch=768, size=(0.06, 0.45), nsec=0, kup=0.0, gam=1.0, im=False,
                 variants=['olive', 'mid', 'red', 'mid', 'dark', 'red', 'yellowing', 'dead']),
}


def cell_noise_edges(h, w, cell, seed):
    """Distance to Voronoi cell borders (F2 - F1) on a jittered grid -> reticulate tertiary veins."""
    rng = np.random.default_rng(seed)
    gy, gx = int(np.ceil(h / cell)) + 2, int(np.ceil(w / cell)) + 2
    pts = (np.stack(np.mgrid[0:gy, 0:gx], -1) + rng.uniform(0.1, 0.9, (gy, gx, 2))) * cell - cell
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    cy = (yy // cell).astype(int) + 1
    cx = (xx // cell).astype(int) + 1
    d1 = np.full((h, w), 1e9, np.float32)
    d2 = np.full((h, w), 1e9, np.float32)
    for oy in (-1, 0, 1):
        for ox in (-1, 0, 1):
            p = pts[np.clip(cy + oy, 0, gy - 1), np.clip(cx + ox, 0, gx - 1)]
            d = np.sqrt((p[..., 0] - yy) ** 2 + (p[..., 1] - xx) ** 2)
            m = d < d1
            d2 = np.where(m, d1, np.minimum(d2, d))
            d1 = np.where(m, d, d1)
    return d2 - d1


def make_leaf(spec, variant, seed):
    rng = np.random.default_rng(seed)
    kind, W, H = spec['kind'], spec['cw'], spec['ch']
    pad = 3
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    t = 1.0 - (yy - pad) / (H - 1 - 2 * pad)  # 0 base (bottom) .. 1 tip (top)
    s = (xx - (W - 1) / 2) / ((W - 1) / 2 - pad)  # -1..1
    asym = 1.0 + (0.06 if kind in ('pin', 'ell') else 0.03) * np.sign(s) * rng.uniform(-1, 1)
    wav = 1.0
    if kind == 'strap':
        wav = 1.0 + 0.06 * np.sin(t * rng.uniform(26, 34) + rng.uniform(0, 6)) * T.smoothstep(0.1, 0.4, t)
    w = outline(kind, t, s) * asym * wav
    w = np.where((t < 0) | (t > 1), 0, w)
    hw_px = (W - 1) / 2 - pad
    sd = (w - np.abs(s)) * hw_px  # px inside the margin
    alpha = np.clip(sd + 0.5, 0, 1)
    if kind == 'cor':  # basal sinus notch
        sinus = 0.09 - 0.14 * np.abs(s)
        alpha = alpha * np.clip((t - sinus) * (H - 2 * pad) + 0.5, 0, 1)
    L = H - 2 * pad
    as_ = np.abs(s)
    lobe_mid = None
    if kind == 'pinna':  # comb of pinnules: deep incisions from the margin toward the costa
        nl = rng.integers(30, 37)
        ph = (t * nl + 0.5 * (s > 0) - 0.9 * as_) % 1.0
        prof = 0.08 + 0.92 * np.abs(np.sin(np.pi * ph)) ** 0.7
        alpha = alpha * np.clip((w * prof - as_) * hw_px + 0.5, 0, 1)
        lobe_mid = np.clip(1.0 - np.abs(ph - 0.5) * 2 * 6, 0, 1) * (as_ > 0.08)
    if kind == 'palmlet':
        pass

    # ---- veins
    mid_w = (0.022 * W) * (1.0 - 0.75 * np.clip(t, 0, 1)) + 0.7
    if kind in ('strap', 'brom'):
        mid_w = (0.045 * W if kind == 'strap' else 0.03 * W) * (1.0 - 0.7 * np.clip(t, 0, 1)) + 0.8
    d_mid = np.abs(s) * hw_px
    midrib = np.clip(mid_w - d_mid + 0.5, 0, 1)
    sec = np.zeros((H, W), np.float32)
    secdist = np.full((H, W), 1e4, np.float32)
    n = spec['nsec']
    if n:
        base_t = np.linspace(0.08, 0.86, n) + rng.uniform(-0.02, 0.02, n)
        for side in (-1, 1):
            off = 0.5 * (base_t[1] - base_t[0]) * (0.35 if side > 0 else 0.0)
            for i, tb in enumerate(base_t):
                tb = tb + off + rng.uniform(-0.012, 0.012)
                ku = spec['kup'] * rng.uniform(0.8, 1.2) * (1.0 + 0.4 * tb)
                tv = tb + ku * (as_ / np.maximum(w, 0.05)) ** spec['gam'] * np.maximum(w, 0.05)
                if kind == 'cor' and i == 0:
                    tv = 0.1 + 0.55 * (as_ / 0.9) ** 1.8  # basal palmate pair sweeping to the tip
                dv = np.abs(t - tv) * L
                on = (np.sign(s) == side) & (as_ < np.maximum(w, 1e-3) * 0.93)
                vw = 1.1 * (1.0 - 0.55 * np.clip(as_ / np.maximum(w, 1e-3), 0, 1)) + 0.25
                v = np.clip(vw - dv + 0.5, 0, 1) * on
                sec = np.maximum(sec, v)
                secdist = np.where(on, np.minimum(secdist, dv), secdist)
    if spec['im']:
        dim = np.abs(sd - 0.045 * hw_px)
        sec = np.maximum(sec, np.clip(0.7 - dim + 0.4, 0, 1) * 0.7 * (t > 0.06) * (t < 0.93))
    if kind == 'strap':  # many fine parallel veins, oblique toward the margin
        ph = (t * L - as_ * hw_px * 0.35) / 3.2
        sec = np.maximum(sec, (0.5 + 0.5 * np.cos(ph * 2 * np.pi)) ** 6 * 0.5 * (as_ > mid_w / hw_px))
    if lobe_mid is not None:
        sec = np.maximum(sec, lobe_mid * 0.6)
    if kind == 'palmlet':  # plicate: 2 strong longitudinal ribs + fine striations
        rib = np.clip(1.6 - np.abs(np.abs(s) - 0.45) * hw_px, 0, 1)
        sec = np.maximum(sec, rib * 0.8)
        sec = np.maximum(sec, (0.5 + 0.5 * np.cos(s * np.pi * 7)) ** 6 * 0.3)
    if kind == 'brom':  # longitudinal striations
        st = 0.5 + 0.5 * np.cos(s * np.pi * rng.uniform(9, 13))
        sec = np.maximum(sec, st ** 5 * 0.45)
    tert = cell_noise_edges(H, W, 9.0 if kind != 'strap' else 6.0, seed + 7)
    tert = np.clip(1.3 - tert, 0, 1) * 0.6

    # ---- colour
    v = variant
    dead = v in ('dead',)
    yellowing = v == 'yellowing'
    old = v == 'old'
    if v == 'red':
        base = T.srgb8(*PAL['olive'])
    elif v in PAL:
        base = T.srgb8(*PAL[v])
    elif old:
        base = T.srgb8(*PAL['dark']) * 1.05
    elif yellowing:
        base = T.srgb8(*PAL['mid'])
    else:
        base = T.srgb8(*PAL['mid'])
    if dead:
        base = T.srgb8(*PAL[['dead', 'tan', 'dkbrown'][rng.integers(0, 3)]])
    hue_j = rng.normal(0, 1, 3) * 0.035
    base = np.clip(base * (1 + hue_j), 0, 1)
    nlo = T.fft_noise(H, W, beta=2.6, seed=seed + 1)
    nmid = T.fft_noise(H, W, beta=1.8, seed=seed + 2)
    col = np.ones((H, W, 3), np.float32) * base
    col *= (1 + 0.07 * nlo[..., None] + 0.03 * nmid[..., None])
    lam = np.clip(as_ / np.maximum(w, 1e-3), 0, 1)
    col *= (1 + 0.06 * (1 - lam)[..., None])  # lighter along the midrib
    if v == 'red':  # bromeliad blush toward the tip
        blush = T.smoothstep(0.35, 1.0, t)[..., None] * rng.uniform(0.5, 0.9)
        col = col * (1 - blush) + T.srgb8(120, 52, 40) * blush
    if yellowing:
        yel = np.clip(T.smoothstep(-0.5, 1.2, nlo + 0.8 * lam - 0.3) * 0.85, 0, 1)[..., None]
        col = col * (1 - yel) + T.srgb8(*PAL['yellow']) * (0.9 + 0.1 * nmid[..., None]) * yel
    if dead:
        mott = T.smoothstep(-0.2, 1.2, nmid)[..., None]
        col = col * (1 - 0.35 * mott) + col * 0.55 * 0.35 * mott
    if old:  # epiphyll crusts (lichens / algae on old leaves) and fungal spots
        ep = T.smoothstep(1.2, 1.6, T.fft_noise(H, W, beta=2.0, seed=seed + 3) + 0.2 * nmid)[..., None]
        col = col * (1 - 0.6 * ep) + T.srgb8(120, 128, 100) * 0.6 * ep
    # necrotic margin / tip on some leaves
    if old or yellowing or (rng.uniform() < 0.25 and not dead):
        nec = T.smoothstep(2.5, 0.0, sd + 2.0 * nmid)[..., None] * (0.35 + 0.3 * T.smoothstep(0.75, 1.0, t)[..., None])
        col = col * (1 - nec) + T.srgb8(110, 78, 44) * nec
    # vein colours: pale yellow-green midrib and secondaries on the top side (darker on dead leaves)
    vc = np.clip(col * 1.45 + T.srgb8(30, 30, 0) * 0.35, 0, 1) if not dead else col * 0.6
    col = col * (1 - 0.75 * midrib[..., None]) + vc * 0.75 * midrib[..., None]
    col = col * (1 - 0.32 * sec[..., None]) + vc * 0.32 * sec[..., None]
    col = col * (1 - 0.06 * tert[..., None])

    # spots: brown fungal spots with yellow halo
    nspots = rng.integers(0, 2) + (4 if old else 0) + (2 if yellowing else 0)
    pert = T.fft_noise(H, W, beta=1.4, seed=seed + 11)
    for _ in range(nspots):
        cy_, cx_ = rng.uniform(0.15, 0.9) * H, rng.uniform(0.25, 0.75) * W
        r = rng.uniform(1.2, 4.0) * (W / 160)
        d = np.sqrt((yy - cy_) ** 2 + (xx - cx_) ** 2) + pert * r * 0.6
        halo = np.clip(1 - (d - r) / (r * 2.2), 0, 1)[..., None] ** 1.5 * 0.35
        core = np.clip(r - d + 0.5, 0, 1)[..., None] * rng.uniform(0.6, 0.95)
        col = col * (1 - halo) + col * T.srgb8(150, 140, 70) / np.maximum(base, 1e-3) * 0.5 * halo
        col = col * (1 - core) + T.srgb8(78, 56, 32) * core

    # ---- damage: insect holes and margin bites (alpha), browned rims
    nholes = 0 if dead else rng.integers(0, 3) + (3 if old else 0)
    if dead:
        nholes = rng.integers(1, 5)
    rim = np.zeros((H, W), np.float32)
    for _ in range(nholes):
        cy_, cx_ = rng.uniform(0.2, 0.85) * H, rng.uniform(0.3, 0.7) * W
        rx, ry = rng.uniform(2, 9) * (W / 160), rng.uniform(2, 9) * (W / 160)
        d = np.sqrt(((yy - cy_) / ry) ** 2 + ((xx - cx_) / rx) ** 2) + 0.45 * pert
        e = (d - 1) * min(rx, ry)
        alpha = alpha * np.clip(e + 0.5, 0, 1)
        rim = np.maximum(rim, np.clip(1 - e / 2.5, 0, 1) * (e > 0))
    nbites = rng.integers(0, 2) + (2 if old else 0) + (2 if dead else 0)
    for _ in range(nbites):
        ty = rng.uniform(0.25, 0.8)
        side = rng.choice([-1, 1])
        row = int((1 - ty) * L + pad)
        wr = float(outline(kind, np.array([ty]), None)[0]) * hw_px
        cy_, cx_ = row, (W - 1) / 2 + side * wr
        r = rng.uniform(4, 14) * (W / 160)
        d = np.sqrt((yy - cy_) ** 2 + (xx - cx_) ** 2) - r + pert * r * 0.35
        alpha = alpha * np.clip(d + 0.5, 0, 1)
        rim = np.maximum(rim, np.clip(1 - d / 2.5, 0, 1) * (d > 0))
    col = col * (1 - 0.6 * rim[..., None]) + T.srgb8(100, 70, 40) * 0.6 * rim[..., None]

    # ---- underside: paler, greyer, veins raised and lighter
    lum = T.luminance(col)[..., None]
    back = lum + (col - lum) * 0.55
    back = back * 1.35 + T.srgb8(20, 26, 24) * 0.25
    back = back * (1 - 0.5 * midrib[..., None]) + np.clip(back * 1.35, 0, 1) * 0.5 * midrib[..., None]
    back = back * (1 - 0.3 * sec[..., None]) + np.clip(back * 1.25, 0, 1) * 0.3 * sec[..., None]

    # ---- height (top side): impressed midrib & veins, lamina bulging between secondaries, fine areoles
    hgt = -0.8 * T.blur(midrib, 1.0) - 0.35 * T.blur(sec, 0.8) - 0.12 * tert
    if n:
        bul = T.smoothstep(0.0, 6.0, secdist) * (secdist < 1e3)
        hgt += 0.25 * T.blur(bul.astype(np.float32), 2.0)
    if dead:
        hgt += 0.5 * T.blur(T.fft_noise(H, W, beta=1.6, seed=seed + 9), 1.0)
    hgt += 0.04 * T.fft_noise(H, W, beta=1.0, seed=seed + 4)
    hgt *= np.clip(alpha * 3, 0, 1)
    nrm = T.normal_from_height(hgt, 1.6, wrap=False)

    # ---- roughness: glossy lamina, rougher veins / spots / dead tissue
    gl = {'dark': 0.32, 'blue': 0.34, 'mid': 0.38, 'young': 0.42, 'apple': 0.4, 'olive': 0.45, 'red': 0.45,
          'old': 0.5, 'yellowing': 0.55, 'dead': 0.75}.get(v, 0.4)
    rough = gl + 0.05 * nmid + 0.1 * sec + 0.12 * midrib + 0.25 * rim
    rough = np.clip(rough, 0.2, 0.95)

    return dict(col=col, back=back, alpha=alpha, nrm=nrm, rough=rough)


def build(name, spec, seed0=100):
    os.makedirs(OUT, exist_ok=True)
    K = len(spec['variants'])
    W, H = spec['cw'], spec['ch']
    sheet = {k: [] for k in ('col', 'back', 'alpha', 'nrm', 'rough')}
    for i, v in enumerate(spec['variants']):
        r = make_leaf(spec, v, seed0 + 31 * i + sum(map(ord, name)) * 7)
        for k in sheet:
            sheet[k].append(r[k])
    col = np.concatenate(sheet['col'], 1)
    back = np.concatenate(sheet['back'], 1)
    alpha = np.concatenate(sheet['alpha'], 1)
    nrm = np.concatenate(sheet['nrm'], 1)
    rough = np.concatenate(sheet['rough'], 1)
    col = T.bleed(col, alpha)
    back = T.bleed(back, alpha)
    nrm = T.bleed(nrm, alpha)
    T.write_png(f'{OUT}/leaf_{name}_albedo.png', np.concatenate([T.lin_to_srgb(col), alpha[..., None]], -1))
    T.write_png(f'{OUT}/leaf_{name}_back.png', T.lin_to_srgb(back))
    T.write_png(f'{OUT}/leaf_{name}_normal.png', nrm)
    T.write_png(f'{OUT}/leaf_{name}_rough.png', rough)
    cells = [dict(variant=v, u0=i / K, u1=(i + 1) / K, dead=(v == 'dead')) for i, v in enumerate(spec['variants'])]
    with open(f'{OUT}/leaf_{name}.json', 'w') as f:
        json.dump(dict(name=name, kind=spec['kind'], width=spec['size'][0], length=spec['size'][1], px=[W * K, H],
                       cells=cells), f, indent=1)
    m = alpha > 0.5
    print(name, 'sheet', W * K, 'x', H, 'mean sRGB', (T.lin_to_srgb(col[m].mean(0)) * 255).round(0))


def main():
    only = None
    if '--only' in sys.argv:
        only = sys.argv[sys.argv.index('--only') + 1].split(',')
    for name, spec in TYPES.items():
        if only and name not in only:
            continue
        build(name, spec)


if __name__ == '__main__':
    main()
