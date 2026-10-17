"""
README: pandanus (screw pine) atlas, 1024 x 2048. Run make_textures.py first (the bark tile is taken from the palm
bark atlas, i.e. from the CC0 Poly Haven palm_tree_bark scan), then:

  bash c:/Code/island/tools/heavy.sh palms E:/blender/blender-5.1.2-windows-x64/blender.exe --background \
       --factory-startup -t 6 --python c:/Code/island/tools/blender/palms/make_pandanus_tex.py

Layout (Blender UV, v up):  rows 0..1023     bark tile (seamless both ways, grey-brown with warts)
                            rows 1024..2047  8 strap-leaf strips of 128 px (u across the leaf, v base -> tip):
                                             0-2 green, 3 yellow-green, 4 yellowing, 5 brown dead, 6 grey dead,
                                             7: fruit (bottom 256 px) + root tip / stalk (rest)
"""
import sys, os, math, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from common import *
from palm_layout import TILE_ROWS, BARK_H

TEX = SCRATCH + '/tex'
W, H = 1024, 2048
STRIP = 128
LEAF0 = 1024
T0 = time.time()


def log(*a):
    print(f'[pandtex {time.time() - T0:6.1f}s]', *a, flush=True)


def srgb8(c):
    return srgb_to_lin(np.array(c, np.float32) / 255.0)


LEAF_COLS = [((58, 88, 38), (74, 100, 44)), ((66, 96, 40), (86, 110, 48)), ((52, 80, 34), (66, 92, 40)),
             ((112, 124, 52), (130, 134, 60)), ((168, 146, 70), (150, 128, 58)), ((132, 100, 66), (112, 84, 56)),
             ((122, 110, 92), (100, 90, 76))]


def build():
    A = np.zeros((H, W, 3), np.float32)
    AL = np.ones((H, W), np.float32)
    N = np.zeros((H, W, 3), np.float32) + np.array([0.5, 0.5, 1.0], np.float32)
    R = np.ones((H, W), np.float32) * 0.6
    O = np.ones((H, W), np.float32)
    # ---------------------------------------------------------------- bark tile from the palm atlas, browner + warts
    pb = load_image(TEX + '/palm_bark_basecolor.png', linear=True)
    pn = load_image(TEX + '/palm_bark_normal.png', linear=True)
    po = load_image(TEX + '/palm_bark_orm.png', linear=True)
    t0, t1 = TILE_ROWS
    tile = srgb_to_lin(pb[t0:t1, :, :3])
    tile = tile * np.array([1.02, 0.96, 0.86], np.float32) * 0.92
    rng = np.random.default_rng(3)
    wart = np.zeros((1024, 1024), np.float32)
    yy, xx = np.mgrid[0:1024, 0:1024].astype(np.float32)
    for _ in range(260):
        cy, cx = rng.uniform(0, 1024, 2)
        r = rng.uniform(3, 7)
        dy = (yy - cy + 512) % 1024 - 512
        dx = (xx - cx + 512) % 1024 - 512
        wart = np.maximum(wart, np.clip(1 - np.hypot(dx, dy * 1.4) / r, 0, 1))
    tile = tile * (1 - 0.35 * wart[..., None]) + srgb8((86, 74, 62)) * 0.35 * wart[..., None]
    A[0:1024] = tile
    wn = height_to_normal(wart * 0.8, 4.0)
    N[0:1024] = blend_normals(pn[t0:t1, :, :3], wn)
    R[0:1024] = po[t0:t1, :, 1]
    O[0:1024] = po[t0:t1, :, 0] * (1 - 0.3 * wart)
    # ---------------------------------------------------------------- strap leaves
    S = 2
    for k in range(8):
        r2 = np.random.default_rng(40 + k)
        h, w = 1024 * S, STRIP * S
        v = (np.arange(h, dtype=np.float32)[:, None] + 0.5) / h       # base -> tip
        u = (np.arange(w, dtype=np.float32)[None, :] + 0.5) / w       # left edge -> right edge
        if k == 7:
            continue
        c0, c1 = LEAF_COLS[min(k, 6)]
        # outline: full width to 72 %, long acuminate tip; slight waviness
        half = 0.46 * np.clip((1 - v) / 0.28, 0, 1) ** 0.75 * (0.92 + 0.08 * np.clip(v / 0.05, 0, 1))
        half = np.minimum(half, 0.46)
        # spiny margin: small forward-pointing teeth every ~2 cm (leaf length ~1.3 m)
        teeth = np.clip(1 - ((v * 64 + 0.3 * u) % 1.0) / 0.35, 0, 1) * 0.035 * (v > 0.05) * (v < 0.97)
        d = np.abs(u - 0.5)
        lim = half + teeth
        cov = np.clip((lim - d) * w + 0.5, 0, 1)
        if k >= 5:   # dead leaves: torn tips, ragged
            cut = 0.82 + 0.12 * r2.random()
            cov *= np.clip((cut - v + 0.02 * np.sin(u * 40)) * h / 3 + 0.5, 0, 1)
        s = (u - 0.5) / 0.46
        col = srgb8(c0) * (1 - v[..., None] * 0.6) + srgb8(c1) * (v[..., None] * 0.6)
        streak = fbm(h, w, 2, 24, r2, 3, wrap=False)
        col = col * (0.88 + 0.24 * streak)[..., None]
        keel = np.clip(1 - np.abs(s) / 0.06, 0, 1)
        col = col * (1 - 0.3 * keel[..., None]) + srgb8((150, 150, 90)) * 0.3 * keel[..., None]
        veins = 0.5 + 0.5 * np.cos(s * np.pi * 14)
        col = col * (0.96 + 0.04 * veins)[..., None]
        if k < 4:   # dry brown tips on the green ones
            tipm = np.clip((v - r2.uniform(0.86, 0.93)) / 0.04, 0, 1)
            col = col * (1 - tipm[..., None]) + srgb8((140, 108, 66)) * tipm[..., None]
        # normal: V crease toward the keel (so flat LOD strips still shade like folded leaves) + fine veins
        ang = np.radians(22) * np.clip(np.abs(s) / 0.08, 0, 1) * np.sign(s)
        nx = np.broadcast_to(np.sin(ang) + 0.04 * np.sin(s * np.pi * 14), (h, w))
        nz = np.broadcast_to(np.cos(ang), (h, w))
        nn = np.stack([nx, np.zeros((h, w), np.float32), nz], -1)
        nn /= np.linalg.norm(nn, axis=-1, keepdims=True)
        a1 = resize(cov[..., None], 1024, STRIP)[..., 0]
        c1r = resize(col * cov[..., None], 1024, STRIP) / np.maximum(a1, 1e-4)[..., None]
        n1 = resize(nn, 1024, STRIP)
        n1 /= np.linalg.norm(n1, axis=-1, keepdims=True)
        sl = (slice(LEAF0, LEAF0 + 1024), slice(k * STRIP, (k + 1) * STRIP))
        A[sl] = c1r
        AL[sl] = a1
        N[sl] = n1 * 0.5 + 0.5
        R[sl] = 0.42 if k < 4 else 0.8
        O[sl] = 1.0
    # ---------------------------------------------------------------- fruit (bottom of strip 7) and root tip / stalk
    r3 = np.random.default_rng(77)
    fx0 = 7 * STRIP
    fh = 256
    v = (np.arange(fh, dtype=np.float32)[:, None] + 0.5) / fh
    u = (np.arange(STRIP, dtype=np.float32)[None, :] + 0.5) / STRIP
    # hexagonal drupe pattern: phalanges with darker seams and green / orange tones
    gx = u * 12
    gy = v * 9 + (np.floor(gx) % 2) * 0.5
    cell = np.minimum(np.abs((gx % 1) - 0.5), np.abs((gy % 1) - 0.5))
    seam = np.clip(1 - cell / 0.12, 0, 1)
    ripe = fbm(fh, STRIP, 4, 4, r3, 3, wrap=False)
    fc = srgb8((150, 120, 40)) * (1 - ripe[..., None]) + srgb8((190, 110, 40)) * ripe[..., None]
    fc = fc * (1 - 0.45 * seam[..., None])
    A[LEAF0:LEAF0 + fh, fx0:fx0 + STRIP] = fc
    N[LEAF0:LEAF0 + fh, fx0:fx0 + STRIP] = height_to_normal(1 - seam, 3.0, wrap_x=False, wrap_y=False)
    R[LEAF0:LEAF0 + fh, fx0:fx0 + STRIP] = 0.5
    stalk = srgb8((120, 104, 82)) * (0.85 + 0.3 * fbm(1024 - fh, STRIP, 32, 2, r3, 3, wrap=False))[..., None]
    A[LEAF0 + fh:, fx0:fx0 + STRIP] = stalk
    R[LEAF0 + fh:, fx0:fx0 + STRIP] = 0.75
    A = dilate_rgb(A, AL)
    write_png(TEX + '/pandanus_basecolor.png', np.concatenate([lin_to_srgb(A), AL[..., None]], -1))
    write_png(TEX + '/pandanus_normal.png', N)
    write_png(TEX + '/pandanus_orm.png', np.stack([O, np.clip(R, 0.05, 1), np.zeros_like(R)], -1))
    sky = np.array([0.55, 0.72, 0.92], np.float32)
    vis = lin_to_srgb(A) * AL[..., None] + sky * (1 - AL[..., None])
    write_png(SCRATCH + '/previews/tex_pandanus_sheet.png', resize(np.concatenate([vis, N], 1), 1024, 1024))
    for k in range(7):
        sl = (slice(LEAF0, LEAF0 + 1024), slice(k * STRIP, (k + 1) * STRIP))
        m = AL[sl] > 0.5
        log('strip', k, 'mean sRGB', (lin_to_srgb(A[sl][m]).mean(0) * 255).round(1))
    log('written')


if __name__ == '__main__':
    build()
