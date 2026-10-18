"""Lobster-claw heliconia inflorescence card for the understory leaf atlas (system Python + numpy). Run after
understory_atlas.py:

    python tools/blender/jungle/heliconia_tex.py

Draws an erect Heliconia bihai-like spike (8 alternating boat-shaped bracts on a zig-zag rachis: scarlet with a yellow
keel band and a green tip) into the free bottom-right cell of the `sapling_leaves` tile (256 x 256 px = 0.5 x 0.5 m,
pivot at the bottom centre) and registers it as tile `heliconia_bracts` in understory_leaf.json.
"""
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import jtex as T  # noqa: E402

TEX = 'E:/tmp/island/helpers/jungle/tex'
N = 2048
CELL = (1280, 1792, 256)   # px x, y (from the top), size
PHYS = 0.5                 # metres across the cell
SS = 2                     # supersampling


def main():
    rng = np.random.default_rng(77)
    S = CELL[2] * SS
    px = PHYS / S
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    X = (xx + 0.5) * px - PHYS / 2          # metres, centre 0
    Y = PHYS - (yy + 0.5) * px              # metres, 0 at the bottom (pivot)
    col = np.zeros((S, S, 3), np.float32)
    alpha = np.zeros((S, S), np.float32)
    hgt = np.zeros((S, S), np.float32)
    rough = np.full((S, S), 0.5, np.float32)
    ao = np.ones((S, S), np.float32)
    red, dred = T.srgb8(186, 26, 20), T.srgb8(128, 16, 16)
    yel, grn = T.srgb8(236, 196, 52), T.srgb8(140, 168, 58)
    nb = 8
    nodes = []
    for i in range(nb):
        side = 1 if i % 2 == 0 else -1
        nodes.append((np.array([0.011 * side, 0.035 + i * 0.05]), side, i))
    # rachis: zig-zag polyline through the nodes
    pts = [np.array([0.0, 0.0])] + [n[0] for n in nodes] + [np.array([0.0, 0.035 + nb * 0.05])]
    for a, b in zip(pts[:-1], pts[1:]):
        d = b - a
        L = np.linalg.norm(d)
        t = np.clip(((X - a[0]) * d[0] + (Y - a[1]) * d[1]) / (L * L), 0, 1)
        dist = np.hypot(X - (a[0] + t * d[0]), Y - (a[1] + t * d[1]))
        on = dist < 0.0045
        col[on] = T.srgb8(150, 140, 56)
        alpha[on] = 1
        hgt[on] = np.maximum(hgt[on], 0.6 * (1 - dist[on] / 0.0045))
    # bracts, top first so the lower (older, bigger) ones overlap them
    for (p0, side, i) in reversed(nodes):
        f = i / (nb - 1)
        Lb = (0.165 - 0.08 * f) * rng.uniform(0.92, 1.06)
        th0 = math.radians(58 - 14 * f + rng.uniform(-4, 4))
        ts = np.linspace(0, 1, 48)
        axis = []
        for t in ts:
            th = th0 * (1 - 0.5 * t)          # the claw curves up toward its tip
            axis.append((math.sin(th) * side, math.cos(th)))
        dirs = np.array(axis)
        A = np.concatenate([[p0], p0 + np.cumsum(dirs[1:] * (Lb / (len(ts) - 1)), 0)])
        # distance from every pixel in the bract's box to the axis polyline
        x0, x1 = A[:, 0].min() - 0.03, A[:, 0].max() + 0.03
        y0, y1 = A[:, 1].min() - 0.03, A[:, 1].max() + 0.03
        box = (X > x0) & (X < x1) & (Y > y0) & (Y < y1)
        bx, by = X[box], Y[box]
        best = np.full(bx.shape, 1e9, np.float32)
        bt = np.zeros(bx.shape, np.float32)
        bs = np.zeros(bx.shape, np.float32)
        for k in range(len(A) - 1):
            a, b = A[k], A[k + 1]
            d = b - a
            L2 = float(d @ d)
            t = np.clip(((bx - a[0]) * d[0] + (by - a[1]) * d[1]) / L2, 0, 1)
            qx, qy = a[0] + t * d[0], a[1] + t * d[1]
            dist = np.hypot(bx - qx, by - qy)
            m = dist < best
            best = np.where(m, dist, best)
            bt = np.where(m, (k + t) / (len(A) - 1), bt)
            # which side of the axis: + = upper / outer margin (the keel band)
            cr = d[0] * (by - a[1]) - d[1] * (bx - a[0])
            bs = np.where(m, np.sign(cr) * side * -1, bs)
        w = 0.024 * np.power(np.clip(bt, 1e-3, 1), 0.3) * np.power(np.clip(1 - bt, 0, 1), 0.5) * 2.15
        inside = best < w
        if not inside.any():
            continue
        r = np.clip(best / np.maximum(w, 1e-4), 0, 1)
        c = red * (1 + 0.08 * rng.normal()) * (1 - 0.35 * T.smoothstep(0.25, 0.0, bt))[..., None] \
            + dred * 0.35 * T.smoothstep(0.25, 0.0, bt)[..., None]
        keel = T.smoothstep(0.35, 0.85, r) * (bs > 0)
        c = c * (1 - 0.85 * keel[..., None]) + yel * 0.85 * keel[..., None]
        tip = T.smoothstep(0.78, 0.95, bt)
        c = c * (1 - tip[..., None]) + grn * tip[..., None]
        sel = np.where(box)
        iy, ix = sel[0][inside], sel[1][inside]
        col[iy, ix] = c[inside]
        alpha[iy, ix] = 1
        hgt[iy, ix] = 1.0 + (1 - r[inside] ** 2) * 1.2 - 0.3 * keel[inside]
        rough[iy, ix] = 0.32 + 0.1 * keel[inside]
        ao[iy, ix] = 0.75 + 0.25 * np.clip(bt[inside] * 3, 0, 1)
    # downsample to the cell
    n = CELL[2]
    col = col.reshape(n, SS, n, SS, 3).mean((1, 3))
    alpha = alpha.reshape(n, SS, n, SS).mean((1, 3))
    hgt = hgt.reshape(n, SS, n, SS).mean((1, 3))
    rough = rough.reshape(n, SS, n, SS).mean((1, 3))
    ao = ao.reshape(n, SS, n, SS).mean((1, 3))
    nrm = T.normal_from_height(T.blur(hgt, 0.8, wrap=False), 2.0, wrap=False)
    col = T.bleed(np.where(alpha[..., None] > 0, col / np.maximum(alpha[..., None], 1e-3), 0), alpha)
    alb = T.read_image(f'{TEX}/understory_leaf_albedo.png')
    nm = T.read_image(f'{TEX}/understory_leaf_normal.png')[..., :3]
    orm = T.read_image(f'{TEX}/understory_leaf_orm.png')[..., :3]
    x0, y0 = CELL[0], CELL[1]
    alb[y0:y0 + n, x0:x0 + n, :3] = T.lin_to_srgb(col)
    alb[y0:y0 + n, x0:x0 + n, 3] = alpha
    nm[y0:y0 + n, x0:x0 + n] = nrm
    orm[y0:y0 + n, x0:x0 + n, 0] = ao
    orm[y0:y0 + n, x0:x0 + n, 1] = rough
    orm[y0:y0 + n, x0:x0 + n, 2] = 0
    T.write_png(f'{TEX}/understory_leaf_albedo.png', alb)
    T.write_png(f'{TEX}/understory_leaf_normal.png', nm)
    T.write_png(f'{TEX}/understory_leaf_orm.png', orm)
    with open(f'{TEX}/understory_leaf.json') as f:
        meta = json.load(f)
    meta['tiles']['heliconia_bracts'] = dict(kind='image', rect=[x0 / N, 1 - (y0 + n) / N, (x0 + n) / N, 1 - y0 / N],
                                             size_wh=[PHYS, PHYS], pivot=[0.5, 0.0], height=0.035 + nb * 0.05)
    meta['tiles']['sapling_leaves']['subs'][3]['variant'] = 'unused (heliconia_bracts)'
    with open(f'{TEX}/understory_leaf.json', 'w') as f:
        json.dump(meta, f, indent=1)
    print('heliconia bracts written, coverage', float((alpha > 0.5).mean()))


if __name__ == '__main__':
    main()
