"""Dense leaf-mass tiles for the canopy crown hulls (system Python + numpy). Run after sprig_atlas.py:

    python tools/blender/jungle/canopy_mass.py

Composites many copies of the rendered spray / rosette / clump tiles of the canopy leaf atlas (random rotation and
scale, wrapping round the edges so every tile is seamless) into four 256x256 'mass' tiles that take the slot of the
former ell_spray_dense tile: ell_mass, obo_mass, palm_mass, ell_mass_b. Earlier (deeper) layers get a darker AO and a
slightly darker albedo, so the mass reads as leaves over shadowed leaves. Tangent normals are rotated with each stamp.
Updates canopy_leaf_{albedo,normal,orm}.png and canopy_leaf.json in place (idempotent: the slot is never a source).
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
SLOT = (1024, 0)      # px (x, y from the top) of the 512 slot (former ell_spray_dense)
TP = 256              # mass tile size, px
PHYS = 1.6            # metres of leaf surface across one mass tile
COVER = 0.9           # alpha coverage the mats stop at
MASSES = [  # name, quadrant (col, row), source tiles with weights, scale range, seed
    ('ell_mass', (0, 0), {'ell_spray_a': 0.4, 'ell_spray_b': 0.4, 'ell_clump': 0.2}, 11),
    ('obo_mass', (1, 0), {'obo_rosette_a': 0.45, 'obo_rosette_b': 0.4, 'obo_clump': 0.15}, 12),
    ('palm_mass', (0, 1), {'palm_spray_a': 0.5, 'palm_spray_b': 0.25, 'palm_clump': 0.25}, 13),
    ('ell_mass_b', (1, 1), {'ell_spray_b': 0.45, 'ell_spray_a': 0.35, 'ell_clump': 0.15, 'dead_spray': 0.05}, 14),
]


def tile_px(rect):
    x0, x1 = int(round(rect[0] * N)), int(round(rect[2] * N))
    y0, y1 = int(round((1 - rect[3]) * N)), int(round((1 - rect[1]) * N))
    return x0, y0, x1, y1


def rotate_stamp(img, theta):
    """Rotate an HxWxC image about its centre by theta (counter-clockwise on screen), bilinear, into a square canvas
    large enough to hold it. Returns the rotated image."""
    h, w = img.shape[:2]
    S = int(math.ceil(math.hypot(h, w))) + 2
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    cx, cy = (S - 1) / 2, (S - 1) / 2
    dx, dy = xx - cx, yy - cy
    c, s = math.cos(theta), math.sin(theta)
    # screen CCW with y down: inverse map target -> source
    sx = c * dx - s * dy + (w - 1) / 2
    sy = s * dx + c * dy + (h - 1) / 2
    x0 = np.floor(sx).astype(int)
    y0 = np.floor(sy).astype(int)
    fx, fy = sx - x0, sy - y0
    out = np.zeros((S, S, img.shape[2]), np.float32)
    acc = np.zeros((S, S, img.shape[2]), np.float32)
    for oy, wy in ((0, 1 - fy), (1, fy)):
        for ox, wx in ((0, 1 - fx), (1, fx)):
            xi, yi = x0 + ox, y0 + oy
            ok = (xi >= 0) & (xi < w) & (yi >= 0) & (yi < h)
            wgt = (wx * wy * ok)[..., None]
            out += img[np.clip(yi, 0, h - 1), np.clip(xi, 0, w - 1)] * wgt
            acc += wgt
    return out


def main():
    with open(f'{TEX}/canopy_leaf.json') as f:
        meta = json.load(f)
    tiles = meta['tiles']
    alb = T.read_image(f'{TEX}/canopy_leaf_albedo.png')
    nrm = T.read_image(f'{TEX}/canopy_leaf_normal.png')[..., :3]
    orm = T.read_image(f'{TEX}/canopy_leaf_orm.png')[..., :3]
    px_per_m = TP / PHYS
    for name, (qc, qr), srcs, seed in MASSES:
        rng = np.random.default_rng(seed)
        C = np.zeros((TP, TP, 3), np.float32)      # albedo (sRGB encoded), premultiplied by A
        A = np.zeros((TP, TP), np.float32)
        Nv = np.zeros((TP, TP, 3), np.float32)     # normal vectors, premultiplied
        R = np.zeros((TP, TP), np.float32)         # roughness, premultiplied
        O = np.zeros((TP, TP), np.float32)         # AO, premultiplied
        names = list(srcs)
        p = np.array([srcs[k] for k in names])
        p = p / p.sum()
        cache = {}
        n_max = 900
        layer = 0
        while layer < n_max:
            cov = float((A > 0.5).mean())
            # stop with ~10 % small gaps: seen from below a hull reads as leaves with sky specks, not a solid plate
            if cov > COVER:
                break
            # depth: stamps laid while the mat is still open end up deep inside it; the last layers are the surface
            depth = cov / COVER
            k = names[rng.choice(len(names), p=p)]
            t = tiles[k]
            sc = rng.uniform(0.75, 1.1) * (0.55 if t['kind'].startswith('clump') else 1.0)
            key = (k, round(sc, 2))
            if key not in cache:
                x0, y0, x1, y1 = tile_px(t['rect'])
                src_px = x1 - x0
                f = t['size'] * px_per_m / src_px * sc
                n2 = max(8, int(round(src_px * f)))
                stack = np.concatenate([alb[y0:y1, x0:x1], nrm[y0:y1, x0:x1], orm[y0:y1, x0:x1, :2]], -1)
                cache[key] = T.resize(stack, n2, n2)
            st = cache[key]
            theta = rng.uniform(0, 2 * math.pi)
            rs = rotate_stamp(st, theta)
            S = rs.shape[0]
            a = np.clip(rs[..., 3], 0, 1)
            if a.max() < 0.05:
                layer += 1
                continue
            dark = 0.38 + 0.62 * min(depth, 1.0) ** 1.3
            col_s = rs[..., :3] * (0.8 + 0.2 * dark)
            v = rs[..., 4:7] * 2 - 1
            px_, py_ = v[..., 0], -v[..., 1]
            c, s = math.cos(theta), math.sin(theta)
            # image rotated CCW on screen (y down): directions rotate by -theta in (x, y-down) coordinates
            qx = c * px_ + s * py_
            qy = -s * px_ + c * py_
            vn = np.stack([qx, -qy, v[..., 2]], -1)
            vn /= np.maximum(np.linalg.norm(vn, axis=-1, keepdims=True), 1e-6)
            ao_s = np.clip(rs[..., 7], 0, 1) * dark
            rough_s = rs[..., 8]
            ox, oy = int(rng.integers(0, TP)), int(rng.integers(0, TP))
            ys = (np.arange(S) + oy) % TP
            xs = (np.arange(S) + ox) % TP
            # wrap-around compositing (stamps may be larger than the tile: composite in TP-sized chunks)
            for by in range(0, S, TP):
                for bx in range(0, S, TP):
                    sy_, sx_ = slice(by, min(by + TP, S)), slice(bx, min(bx + TP, S))
                    yy, xx = ys[sy_], xs[sx_]
                    aa = a[sy_, sx_]
                    ix = np.ix_(yy, xx)
                    inv = 1 - aa
                    C[ix] = col_s[sy_, sx_] * aa[..., None] + C[ix] * inv[..., None]
                    Nv[ix] = vn[sy_, sx_] * aa[..., None] + Nv[ix] * inv[..., None]
                    O[ix] = ao_s[sy_, sx_] * aa + O[ix] * inv
                    R[ix] = rough_s[sy_, sx_] * aa + R[ix] * inv
                    A[ix] = aa + A[ix] * inv
            layer += 1
        cov = float((A > 0.5).mean())
        Ad = np.maximum(A, 1e-4)
        col = C / Ad[..., None]
        nv = Nv / np.maximum(np.linalg.norm(Nv, axis=-1, keepdims=True), 1e-6)
        nv[A < 0.02] = (0, 0, 1)
        ao = O / Ad
        rough = R / Ad
        col = T.bleed(col, A)
        X0, Y0 = SLOT[0] + TP * qc, SLOT[1] + TP * qr
        alb[Y0:Y0 + TP, X0:X0 + TP, :3] = col
        alb[Y0:Y0 + TP, X0:X0 + TP, 3] = np.clip(A, 0, 1)
        nrm[Y0:Y0 + TP, X0:X0 + TP] = nv * 0.5 + 0.5
        orm[Y0:Y0 + TP, X0:X0 + TP, 0] = np.where(A > 0.02, ao, 0.5)
        orm[Y0:Y0 + TP, X0:X0 + TP, 1] = np.where(A > 0.02, rough, 0.6)
        orm[Y0:Y0 + TP, X0:X0 + TP, 2] = 0
        rect = [X0 / N, 1 - (Y0 + TP) / N, (X0 + TP) / N, 1 - Y0 / N]
        tiles[name] = dict(kind='mass', sheet=name.split('_')[0], size=PHYS, pivot=[0.5, 0.5], content=[0, 0, 1, 1],
                           coverage=cov, rect=rect, layers=layer)
        print(f'{name}: {layer} stamps, coverage {cov:.3f}, rect {[round(v, 4) for v in rect]}')
    tiles.pop('ell_spray_dense', None)
    T.write_png(f'{TEX}/canopy_leaf_albedo.png', alb)
    T.write_png(f'{TEX}/canopy_leaf_normal.png', nrm)
    T.write_png(f'{TEX}/canopy_leaf_orm.png', orm)
    with open(f'{TEX}/canopy_leaf.json', 'w') as f:
        json.dump(meta, f, indent=1)
    print('canopy mass tiles written')


if __name__ == '__main__':
    main()
