"""
README: beach scrub leaf atlas (sea-grape / Scaevola character), painted with numpy, deterministic.

  bash c:/Code/island/tools/heavy.sh palms E:/blender/blender-5.1.2-windows-x64/blender.exe --background \
       --factory-startup -t 6 --python c:/Code/island/tools/blender/palms/make_scrub_tex.py

Atlas 2048 x 2048, 4 x 4 cells of 512 px (cell (col, row), row 0 at the bottom):
  rows 0-2 and (2, 3), (3, 3): leaf-cluster cards (alpha cut-out), see CARDS
  (0, 3): dense opaque leaf tile (tileable, for the inner hull that stops see-through)
  (1, 3): bark tile for scrub_wood (tileable)
Writes E:/tmp/island/helpers/palms/tex/scrub_leaf_{basecolor,normal,orm}.png (+ preview sheet).
"""
import sys, os, math, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from common import *

TEX = SCRATCH + '/tex'
CELL = 512
T0 = time.time()


def log(*a):
    print(f'[scrubtex {time.time() - T0:6.1f}s]', *a, flush=True)


def srgb8(c):
    return srgb_to_lin(np.array(c, np.float32) / 255.0)


# leaf palettes (sRGB): spec "mid to dark green with some yellow-green, a few red-brown old leaves"
DARK = [(46, 70, 30), (52, 76, 32), (40, 62, 28), (58, 80, 34)]
MID = [(68, 94, 38), (76, 100, 40), (62, 88, 36), (84, 106, 44)]
YELLOW = [(108, 122, 48), (118, 128, 54), (98, 116, 44)]
OLD = [(104, 60, 38), (118, 76, 44), (96, 64, 40), (128, 96, 50)]


class Canvas:
    def __init__(self, h, w):
        self.rgb = np.zeros((h, w, 3), np.float32)
        self.a = np.zeros((h, w), np.float32)
        self.n = np.zeros((h, w, 3), np.float32) + np.array([0, 0, 1], np.float32)
        self.r = np.ones((h, w), np.float32) * 0.5
        self.hgt = np.zeros((h, w), np.float32)
        self.h, self.w = h, w


def paint_leaf(cv, base, ang, L, W, col, shape, rng, layer, tilt=(0.0, 0.0), vein_col=None, wrap=False, rough=0.38,
               petiole=0.0):
    """one leaf: base point (x, y) px, direction ang, length / width px. shape: obovate | round | elliptic.
    Leaves that would leave the canvas (minus a 14 px margin) are shortened, never cut straight."""
    ca, sa = math.cos(ang), math.sin(ang)
    if not wrap:
        m = 14
        L0 = L
        for _ in range(14):
            pts = [(base[0] + ca * L * f - sa * W * 0.5 * w, base[1] + sa * L * f + ca * W * 0.5 * w)
                   for f, w in ((1.0, 0.0), (0.7, 1.0), (0.7, -1.0), (0.45, 1.0), (0.45, -1.0))]
            if all(m <= x <= cv.w - m and m <= y <= cv.h - m for x, y in pts):
                break
            L *= 0.88
            W *= 0.88
        else:
            return
        if L < 0.3 * L0:
            return
    ext = L * 1.05 + petiole
    xs = [base[0] + ca * (-petiole), base[0] + ca * ext]
    ys = [base[1] + sa * (-petiole), base[1] + sa * ext]
    pad = W * 0.6 + 3
    x0, x1 = int(math.floor(min(xs) - pad)), int(math.ceil(max(xs) + pad))
    y0, y1 = int(math.floor(min(ys) - pad)), int(math.ceil(max(ys) + pad))
    if not wrap:
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(cv.w, x1), min(cv.h, y1)
        if x1 <= x0 or y1 <= y0:
            return
    X, Y = np.meshgrid(np.arange(x0, x1, dtype=np.float32), np.arange(y0, y1, dtype=np.float32))
    dx, dy = X - base[0], Y - base[1]
    u = (dx * ca + dy * sa) / L          # along the leaf, 0 base .. 1 tip
    v = (-dx * sa + dy * ca)             # across, px
    uc = np.clip(u, 0, 1)
    if shape == 'round':                 # sea grape: orbicular, slightly heart-shaped base
        prof = np.sqrt(np.clip(1 - (2 * uc - 1) ** 2, 0, 1)) * (1 - 0.25 * np.exp(-uc / 0.06))
    elif shape == 'obovate':             # Scaevola: spoon-shaped, widest at ~70 %
        prof = np.clip(uc / 0.72, 0, 1) ** 0.75 * np.clip((1 - uc) / 0.28, 0, 1) ** 0.45
    else:                                # elliptic
        prof = np.clip(np.sin(np.pi * uc), 0, 1) ** 0.75
    hw = 0.5 * W * prof
    # slightly wavy margin
    hw = hw * (1 + 0.03 * np.sin(uc * 23 + base[0]))
    d = np.abs(v)
    cov = np.clip(np.minimum(d + 0.5, hw) - np.maximum(d - 0.5, -hw), 0, 1) * ((u >= 0) & (u <= 1))
    # petiole: thin stalk from the base back to the stem
    if petiole > 0:
        up = (dx * ca + dy * sa)
        pc = np.clip(1.6 - d, 0, 1) * ((up > -petiole) & (up < 0.05 * L))
        cov = np.maximum(cov, pc)
    if cov.max() <= 0:
        return
    s = np.clip(v / np.maximum(hw, 0.5), -1, 1)
    c = np.broadcast_to(srgb8(col), cov.shape + (3,)).copy()
    # tone: paler toward the base, slow mottling, faint lateral veins and a pale midrib
    c *= (1 + 0.10 * np.clip(0.25 - uc, 0, 1)[..., None] * 4)
    c *= (0.94 + 0.12 * np.sin(uc * rng.uniform(3, 7) + rng.uniform(0, 6)) * np.cos(s * 2.0))[..., None] ** 0.5
    mid = np.clip(1 - np.abs(v) / 1.6, 0, 1) * (u > 0) * (u < 0.95)
    vcol = srgb8(vein_col) if vein_col is not None else c * 1.5
    c = c * (1 - 0.6 * mid[..., None]) + vcol * 0.6 * mid[..., None]
    lat = np.abs(np.sin((uc * 6.5 - np.abs(s) * 1.4) * np.pi))
    latm = np.clip((lat - 0.9) / 0.1, 0, 1) * (np.abs(s) < 0.85) * (np.abs(s) > 0.08)
    lc = srgb8(vein_col) if vein_col is not None else c * 1.25
    c = c * (1 - 0.12 * latm[..., None]) + lc * 0.12 * latm[..., None]
    # normal: leaf tilt + cupped blade (margins curl up) + midrib groove
    tx, ty = tilt
    cup = 0.35 * s * np.abs(s)
    nx_l = -cup * 0.9                       # across-leaf slope (local)
    nx_l += 0.25 * np.sign(s) * np.exp(-np.abs(v) / 1.5) * -1
    ny_l = -0.15 * (uc - 0.5)
    # rotate local (along, across) slopes into canvas space
    gx = ca * ny_l - sa * nx_l + tx
    gy = sa * ny_l + ca * nx_l + ty
    nn = np.stack([gx, gy, np.ones_like(gx)], -1)
    nn /= np.linalg.norm(nn, axis=-1, keepdims=True)
    cc = cov[..., None]
    if wrap:
        yy = (np.arange(y0, y1) % cv.h)[:, None]
        xx = (np.arange(x0, x1) % cv.w)[None, :]
        sl = (yy, xx)
    else:
        sl = (slice(y0, y1), slice(x0, x1))
    cv.rgb[sl] = cv.rgb[sl] * (1 - cc) + c * cc
    cv.n[sl] = cv.n[sl] * (1 - cc) + nn * cc
    cv.r[sl] = cv.r[sl] * (1 - cov) + rough * rng.uniform(0.9, 1.15) * cov
    cv.a[sl] = np.maximum(cv.a[sl], cov)
    cv.hgt[sl] = np.where(cov > 0.5, layer + 0.3 * (1 - np.abs(s)), cv.hgt[sl])


def pick(rng, pal):
    c = np.array(pal[int(rng.integers(len(pal)))], np.float32)
    return tuple(np.clip(c * rng.uniform(0.9, 1.1), 0, 255))


def cluster(cv, cx, cy, size, rng, style):
    """one card: a rosette (top view) or a sprig, filling a size x size px cell centred at (cx, cy)"""
    layer = 0
    if style in ('scaevola', 'scaevola_y'):
        # two or three overlapping rosettes (branch tips) per card, so the card is mostly leaf
        golden = math.pi * (3 - math.sqrt(5))
        centres = [(cx + rng.uniform(-0.12, 0.12) * size, cy + rng.uniform(-0.12, 0.12) * size, 1.0)]
        for _ in range(int(rng.integers(2, 4))):
            a = rng.uniform(0, 6.28)
            centres.insert(0, (cx + math.cos(a) * size * 0.24, cy + math.sin(a) * size * 0.24, 0.62))
        for (rx, ry, sc) in centres:
            n = int(rng.integers(14, 20))
            a0 = rng.uniform(0, 6.28)
            for i in range(n):
                f = 1 - i / n                     # outer (long, drawn first) .. inner (short, on top)
                ang = a0 + i * golden + rng.uniform(-0.2, 0.2)
                L = size * sc * (0.2 + 0.27 * f) * rng.uniform(0.85, 1.05)
                if sc < 1.0:
                    L = min(L, size * 0.26)
                W = L * rng.uniform(0.4, 0.5)
                r0 = size * 0.02 * f
                base = (rx + math.cos(ang) * r0, ry + math.sin(ang) * r0)
                pal = YELLOW if (style == 'scaevola_y' and rng.random() < 0.6) or (f < 0.3 and rng.random() < 0.5) else (MID if rng.random() < 0.7 else DARK)
                if rng.random() < 0.05:
                    pal = OLD
                tilt = (math.cos(ang) * 0.35 * f, math.sin(ang) * 0.35 * f)
                paint_leaf(cv, base, ang, L, W, pick(rng, pal), 'obovate', rng, layer, tilt, vein_col=(150, 160, 90), rough=0.5)
                layer += 1
        return
    if style in ('seagrape', 'seagrape_old'):
        n = int(rng.integers(9, 13))
        golden = math.pi * (3 - math.sqrt(5))
        a0 = rng.uniform(0, 6.28)
        for i in range(n):
            f = 1 - i / n
            ang = a0 + i * golden + rng.uniform(-0.25, 0.25)
            L = size * (0.24 + 0.14 * f) * rng.uniform(0.9, 1.06)
            W = L * rng.uniform(0.92, 1.08)
            r0 = size * rng.uniform(0.0, 0.05)
            base = (cx + math.cos(ang) * r0, cy + math.sin(ang) * r0)
            pal = DARK if rng.random() < 0.6 else MID
            if style == 'seagrape_old' and rng.random() < 0.18:
                pal = OLD
            vein = (150, 70, 52) if rng.random() < 0.6 else (120, 140, 70)
            tilt = (rng.uniform(-0.4, 0.4), rng.uniform(-0.4, 0.4))
            paint_leaf(cv, base, ang, L, W, pick(rng, pal), 'round', rng, layer, tilt, vein_col=vein, rough=0.46,
                       petiole=size * 0.04)
            layer += 1
    else:  # sprigs: two or three twigs across the card with alternating elliptic leaves
        for k in range(int(rng.integers(2, 4))):
            sprig(cv, cx + rng.uniform(-0.15, 0.15) * size, cy + rng.uniform(-0.15, 0.15) * size, size * rng.uniform(0.7, 0.9), rng, layer)
            layer += 20


def sprig(cv, cx, cy, size, rng, layer):
    if True:
        ang0 = rng.uniform(0, 6.28)
        L0 = size * 0.85
        p0 = np.array([cx, cy]) - 0.5 * L0 * np.array([math.cos(ang0), math.sin(ang0)])
        n = int(rng.integers(11, 16))
        for i in range(n):
            t = (i + 0.5) / n
            bp = p0 + t * L0 * np.array([math.cos(ang0), math.sin(ang0)])
            side = 1 if i % 2 == 0 else -1
            ang = ang0 + side * rng.uniform(0.6, 1.1) - 0.25 * side * t
            L = size * (0.2 + 0.18 * math.sin(math.pi * t)) * rng.uniform(0.85, 1.1)
            W = L * rng.uniform(0.4, 0.52)
            pal = MID if rng.random() < 0.55 else (DARK if rng.random() < 0.6 else YELLOW)
            if rng.random() < 0.06:
                pal = OLD
            tilt = (rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3))
            paint_leaf(cv, tuple(bp), ang, L, W, pick(rng, pal), 'elliptic', rng, layer, tilt, vein_col=(140, 150, 80), rough=0.52,
                       petiole=size * 0.02)
            layer += 1


CARDS = [
    # (col, row, style)
    (0, 0, 'scaevola'), (1, 0, 'scaevola'), (2, 0, 'scaevola_y'), (3, 0, 'scaevola'),
    (0, 1, 'seagrape'), (1, 1, 'seagrape'), (2, 1, 'seagrape_old'), (3, 1, 'seagrape'),
    (0, 2, 'sprig'), (1, 2, 'sprig'), (2, 2, 'scaevola'), (3, 2, 'seagrape_old'),
    (2, 3, 'scaevola_y'), (3, 3, 'sprig'),
]
DENSE_CELL = (0, 3)
WOOD_CELL = (1, 3)


def build():
    S = 2
    H = W = 2048 * S
    cv = Canvas(H, W)
    for i, (cx, cy, style) in enumerate(CARDS):
        rng = np.random.default_rng(500 + i)
        sub = Canvas(CELL * S, CELL * S)
        cluster(sub, CELL * S / 2, CELL * S / 2, CELL * S, rng, style)
        sl = (slice(cy * CELL * S, (cy + 1) * CELL * S), slice(cx * CELL * S, (cx + 1) * CELL * S))
        # keep a 4 px empty border (no bleeding between cells)
        m = np.ones_like(sub.a)
        m[:8, :] = m[-8:, :] = 0
        m[:, :8] = m[:, -8:] = 0
        sub.a *= m
        ao = np.clip(1 - 0.08 * (box_blur2(sub.hgt, 18) - sub.hgt), 0.45, 1.0)
        cv.rgb[sl], cv.a[sl], cv.n[sl], cv.r[sl] = sub.rgb, sub.a, sub.n, sub.r
        cv.hgt[sl] = ao
        log('card', i, style, 'coverage', round(float((sub.a > 0.5).mean()), 2), 'nan', int(np.isnan(sub.rgb).sum()))
    # dense opaque tile: random overlapping leaves, wrapping, on a dark floor
    rng = np.random.default_rng(900)
    sub = Canvas(CELL * S, CELL * S)
    sub.rgb[:] = srgb8((34, 46, 24))
    sub.a[:] = 1.0
    for i in range(170):
        sty = rng.choice(['obovate', 'round', 'elliptic'], p=[0.45, 0.3, 0.25])
        L = CELL * S * rng.uniform(0.12, 0.22)
        Wd = L * (1.0 if sty == 'round' else rng.uniform(0.38, 0.5))
        pal = DARK if rng.random() < 0.55 else (MID if rng.random() < 0.8 else YELLOW)
        if rng.random() < 0.04:
            pal = OLD
        paint_leaf(sub, (rng.uniform(0, CELL * S), rng.uniform(0, CELL * S)), rng.uniform(0, 6.28), L, Wd, pick(rng, pal), sty, rng, i,
                   (rng.uniform(-0.4, 0.4), rng.uniform(-0.4, 0.4)), wrap=True, rough=0.4)
    sub.a[:] = 1.0
    cx, cy = DENSE_CELL
    sl = (slice(cy * CELL * S, (cy + 1) * CELL * S), slice(cx * CELL * S, (cx + 1) * CELL * S))
    ao = np.clip(1 - 0.05 * (box_blur2(sub.hgt, 18, wrap=True) - sub.hgt), 0.4, 1.0)
    cv.rgb[sl], cv.a[sl], cv.n[sl], cv.r[sl], cv.hgt[sl] = sub.rgb, sub.a, sub.n, sub.r, ao * 0.8
    # bark tile (grey-brown, smooth with flaky patches and fine vertical streaks)
    rng = np.random.default_rng(901)
    n = CELL * S
    b = fbm(n, n, 6, 3, rng, 5)
    fl = np.clip((fbm(n, n, 10, 6, rng, 3) - 0.6) * 5, 0, 1)
    bark = srgb8((104, 92, 80)) * (0.8 + 0.4 * b)[..., None]
    bark = bark * (1 - 0.5 * fl[..., None]) + srgb8((140, 128, 112)) * 0.5 * fl[..., None]
    hb = b * 0.6 + fl * 0.4
    cx, cy = WOOD_CELL
    sl = (slice(cy * CELL * S, (cy + 1) * CELL * S), slice(cx * CELL * S, (cx + 1) * CELL * S))
    cv.rgb[sl], cv.a[sl], cv.r[sl] = bark, 1.0, 0.8
    cv.n[sl] = height_to_normal(hb, 6.0) * 2 - 1
    cv.hgt[sl] = 1.0
    # downsample
    a1 = resize(cv.a[..., None], 2048, 2048)[..., 0]
    rgb1 = resize(cv.rgb * cv.a[..., None], 2048, 2048) / np.maximum(a1, 1e-4)[..., None]
    n1 = resize(cv.n, 2048, 2048)
    n1 /= np.linalg.norm(n1, axis=-1, keepdims=True)
    r1 = resize(cv.r[..., None], 2048, 2048)[..., 0]
    ao1 = resize(cv.hgt[..., None], 2048, 2048)[..., 0]
    rgb1 = dilate_rgb(rgb1, a1)
    sel = a1 > 0.5
    log('leaf mean sRGB (cards+dense)', (lin_to_srgb(rgb1[sel]).mean(0) * 255).round(1))
    write_png(TEX + '/scrub_leaf_basecolor.png', np.concatenate([lin_to_srgb(rgb1), a1[..., None]], -1))
    write_png(TEX + '/scrub_leaf_normal.png', n1 * 0.5 + 0.5)
    write_png(TEX + '/scrub_leaf_orm.png', np.stack([np.clip(ao1, 0, 1), np.clip(r1, 0.05, 1), np.zeros_like(r1)], -1))
    sky = np.array([0.55, 0.72, 0.92], np.float32)
    vis = lin_to_srgb(rgb1) * a1[..., None] + sky * (1 - a1[..., None])
    write_png(SCRATCH + '/previews/tex_scrub_sheet.png', resize(np.concatenate([vis, n1 * 0.5 + 0.5], 1), 1024, 2048))
    write_png(SCRATCH + '/previews/tex_scrub_crop.png', vis[0:1024, 0:1024])
    log('written')


def box_blur2(a, r, wrap=False):
    out = a.astype(np.float32)
    for axis in (0, 1):
        if wrap:
            pad = np.take(out, range(-r - 1, 0), axis=axis), out, np.take(out, range(0, r), axis=axis)
            c = np.cumsum(np.concatenate(pad, axis=axis), axis=axis)
        else:
            p = [(0, 0), (0, 0)]
            p[axis] = (r + 1, r)
            c = np.cumsum(np.pad(out, p, mode='edge'), axis=axis)
        n = out.shape[axis]
        out = (np.take(c, range(2 * r + 1, 2 * r + 1 + n), axis=axis) - np.take(c, range(0, n), axis=axis)) / (2 * r + 1)
    return out


if __name__ == '__main__':
    build()
