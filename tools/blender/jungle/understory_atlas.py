"""Understory texture atlases (Blender, headless, under the lock):

    bash c:/Code/island/tools/heavy.sh jungle E:/blender/blender-5.1.2-windows-x64/blender.exe --background \
        --factory-startup -t 6 --python tools/blender/jungle/understory_atlas.py [-- --only name,... | --scan-only]

understory_leaf (2048^2): rendered fern / palm fronds + numpy tiles (understory_textures.py) + big sapling leaves +
bird's-nest strap leaves. understory_scan (2048^2): Poly Haven fern_02 | calathea_orbifolia_01 | anthurium_botany_01 |
potted_plant_02 leaves (recoloured toward Alocasia), one 1024^2 quadrant each. Both with normal + ORM maps and a JSON
of tile rects (Blender UV, v up), content boxes, pivots and physical sizes.
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
import sprig_atlas as SA  # noqa: E402

TEX = 'E:/tmp/island/helpers/jungle/tex'
UST = f'{TEX}/us_tiles'
WORK = 'E:/tmp/island/helpers/jungle/work/sprig'
RAWM = 'E:/tmp/island/raw/jungle/models'
N = 2048

TILES = [
    # name, (x, y, w, h) px from the top-left, kind, sheet, moods/variants, pivot, seed
    ('banana_intact', (0, 0, 256, 1024), 'image', None, None, 'bottom', 0),
    ('banana_torn', (256, 0, 256, 1024), 'image', None, None, 'bottom', 0),
    ('banana_shredded', (512, 0, 256, 1024), 'image', None, None, 'bottom', 0),
    ('banana_dead', (768, 0, 256, 1024), 'image', None, None, 'bottom', 0),
    ('treefern_a', (1024, 0, 512, 1024), 'frond_bipinnate', 'pinna', {'young': 0.45, 'apple': 0.35, 'mid': 0.2}, 'bottom', 21),
    ('treefern_b', (1536, 0, 512, 1024), 'frond_bipinnate', 'pinna', {'young': 0.35, 'apple': 0.25, 'mid': 0.25, 'olive': 0.05, 'yellowing': 0.06, 'dead': 0.04}, 'bottom', 22),
    ('rattan', (0, 1024, 512, 1024), 'frond_palm', 'palmlet', {'dark': 0.3, 'mid': 0.35, 'young': 0.2, 'blue': 0.15}, 'bottom', 23),
    ('frond_dead', (512, 1024, 512, 1024), 'frond_dead', 'pinna', {'dead': 0.7, 'yellowing': 0.3}, 'bottom', 24),
    ('colocasia', (1024, 1024, 512, 512), 'image', None, None, 'bottom', 0),
    ('licuala', (1536, 1024, 512, 512), 'image', None, None, 'center', 0),
    ('sapling_leaves', (1024, 1536, 512, 512), 'cells2x2', 'bigobo', ['dark', 'mid', 'young', 'blue'], 'bottom', 0),
    ('strap_singles', (1536, 1536, 512, 512), 'singles', 'strap', ['apple', 'young', 'mid', 'yellowing'], 'bottom', 0),
]


# ------------------------------------------------------------------------------------------------ fronds
def frond_bipinnate(mb, rng, sh, moods, length, lmax, dead=False):
    curve = rng.uniform(-0.18, 0.18)
    path = SA.bend_path((0, 0, 0), (0, 1, 0), length, curve, n=16, zcurve=0.0)
    SA.add_twig(mb, path, 0.016, 0.003)
    s = J.arclen(path)
    L = s[-1]
    npair = int(rng.integers(40, 47))
    aged = 0.0 if dead else sum(w for v, w in moods.items() if v in ('yellowing', 'dead'))
    green = {v: w for v, w in moods.items() if v not in ('yellowing', 'dead')}
    for k in range(npair):
        rel = 0.12 + 0.86 * k / (npair - 1)
        pos = L * rel
        i = int(np.clip(np.searchsorted(s, pos) - 1, 0, len(path) - 2))
        f = (pos - s[i]) / max(s[i + 1] - s[i], 1e-9)
        P = path[i] * (1 - f) + path[i + 1] * f
        tg = J.norm(path[i + 1] - path[i])
        prof = math.sin(math.pi * min(1.0, (rel - 0.08) / 0.95)) ** 0.55 * (1 - 0.25 * rel)
        pair_moods = moods
        if aged > 0:  # browning starts at the lowest (oldest) pinnae and takes both pinnae of a pair together
            a = min(aged * 3.0 * (1 - rel) ** 3, 0.9)
            gt = sum(green.values())
            m = {v: w / gt * (1 - a) for v, w in green.items()}
            m['yellowing'], m['dead'] = a * 0.55, a * 0.45
            keys = list(m)
            p = np.array([m[v] for v in keys])
            pair_moods = {keys[rng.choice(len(keys), p=p / p.sum())]: 1.0}
        for side in (-1, 1):
            ang = math.radians(rng.uniform(55, 72)) * side
            fwd = J.norm(J.rot((0, 0, 1), ang) @ tg + np.array([0, 0, rng.uniform(-0.05, 0.08)]))
            up = J.rot(fwd, rng.normal(0, 0.25 if not dead else 0.6)) @ np.array([0, 0, 1.0])
            ln = lmax * prof * rng.uniform(0.9, 1.08)
            sc = ln / sh.length
            cell = sh.pick(rng, pair_moods)
            SA.add_leaf(mb, sh, cell, P + side * np.cross(tg, (0, 0, 1)) * 0.004, fwd, up, sc,
                        fold=rng.uniform(0.05, 0.2), arch=rng.uniform(0.02, 0.12) + (0.25 if dead else 0),
                        twist=(rng.normal(0, 0.8) if dead else rng.normal(0, 0.12)), curl=(rng.uniform(0.3, 1.0) if dead else 0.1),
                        na=10, nc=2)


def frond_palm(mb, rng, sh, moods, length):
    path = SA.bend_path((0, 0, 0), (0, 1, 0), length, rng.uniform(-0.12, 0.12), n=16, zcurve=0.0)
    SA.add_twig(mb, path, 0.012, 0.003)
    s = J.arclen(path)
    L = s[-1]
    pos = L * 0.1
    while pos < L * 0.99:
        rel = pos / L
        i = int(np.clip(np.searchsorted(s, pos) - 1, 0, len(path) - 2))
        f = (pos - s[i]) / max(s[i + 1] - s[i], 1e-9)
        P = path[i] * (1 - f) + path[i + 1] * f
        tg = J.norm(path[i + 1] - path[i])
        prof = math.sin(math.pi * min(1.0, (rel - 0.05) / 0.98)) ** 0.5 * (1 - 0.35 * rel)
        cell = sh.pick(rng, moods)
        for side in (-1, 1):
            ang = math.radians(rng.uniform(38, 58) * (1 - 0.25 * rel)) * side
            fwd = J.norm(J.rot((0, 0, 1), ang) @ tg + np.array([0, 0, rng.uniform(-0.05, 0.12)]))
            up = J.rot(fwd, rng.normal(0, 0.3)) @ np.array([0, 0, 1.0])
            c = cell if rng.uniform() < 0.7 else sh.pick(rng, moods)
            SA.add_leaf(mb, sh, c, P, fwd, up, prof * rng.uniform(0.85, 1.1) * 1.05, fold=rng.uniform(0.15, 0.4),
                        arch=rng.uniform(0.05, 0.22), twist=rng.normal(0, 0.15), na=10, nc=2)
        pos += L * rng.uniform(0.018, 0.03) * (1.6 if rng.uniform() < 0.15 else 1.0)


def render_rect(sc, cam, name, mb, sh, pivot, w, h):
    """Render a (possibly non-square) tile; returns passes and physical size (sw, sh) and pivot (u, v)."""
    for o in list(sc.collection.objects):
        if o.type == 'MESH':
            bpy.data.objects.remove(o, do_unlink=True)
    ml = SA.pass_material(f'{name}_leaf', sh, 0.08)
    mt = SA.pass_material(f'{name}_twig', None, 0.08)
    mb.build(name, [ml, mt])
    V = np.concatenate(mb.V)
    aspect = w / h
    m = 0.03
    sc.render.resolution_x, sc.render.resolution_y = w * SA.SS, h * SA.SS
    hx = np.abs(V[:, 0]).max()
    if pivot == 'bottom':
        top, bot = V[:, 1].max(), min(V[:, 1].min(), 0.0)
        Sh = max(top - bot, 2 * hx / aspect) / (1 - 2 * m)
        cy = bot - Sh * m + Sh / 2
    else:
        Sh = max(2 * np.abs(V[:, 1]).max(), 2 * hx / aspect) / (1 - 2 * m)
        cy = 0.0
    Sw = Sh * aspect
    cam.data.sensor_fit = 'VERTICAL' if h >= w else 'HORIZONTAL'
    cam.data.ortho_scale = max(Sw, Sh)
    cam.location = (0, cy, max(V[:, 2].max() + 1.0, 2.0))
    passes = {}
    for p, (pname, samples) in enumerate((('alb', 16), ('nrm', 16), ('aux', 48))):
        SA.set_pass([ml, mt], p)
        sc.cycles.samples = samples
        path = f'{WORK}/us_{name}_{pname}.exr'
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        passes[pname] = J.read_exr(path)
    piv = (0.5, 0.5 - cy / Sh)
    return passes, (Sw, Sh), piv


def load_tile(name, w, h):
    a = T.read_image(f'{UST}/{name}_albedo.png')
    n = T.read_image(f'{UST}/{name}_normal.png')[..., :3]
    r = T.read_image(f'{UST}/{name}_rough.png')[..., 0]
    if a.shape[:2] != (h, w):
        a, n, r = T.resize(a, h, w), T.resize(n, h, w), T.resize(r, h, w)
    lin = T.srgb_to_lin(a[..., :3])
    aux = np.stack([np.ones_like(r), r, np.zeros_like(r)], -1)
    return lin, a[..., 3], n, aux


def cells2x2(sheet, variants, w, h):
    sh = SA.Sheet(sheet)
    alb = T.read_image(sh.paths['albedo'])
    nrm = T.read_image(sh.paths['normal'])[..., :3]
    rgh = T.read_image(sh.paths['rough'])[..., 0]
    A = np.zeros((h, w, 4), np.float32)
    Nn = np.tile(np.array([0.5, 0.5, 1.0], np.float32), (h, w, 1))
    X = np.ones((h, w, 3), np.float32)
    subs = []
    cw, ch = w // 2, h // 2
    for k, v in enumerate(variants):
        ci = [i for i, c in enumerate(sh.cells) if c['variant'] == v][0]
        x0 = ci * sh.Wp
        sc_ = min(cw / sh.Wp, ch / sh.Hp)
        w2, h2 = int(sh.Wp * sc_) // 2 * 2, int(sh.Hp * sc_) // 2 * 2
        ox, oy = (k % 2) * cw + (cw - w2) // 2, (k // 2) * ch + (ch - h2) // 2
        A[oy:oy + h2, ox:ox + w2] = T.resize(alb[:, x0:x0 + sh.Wp], h2, w2)
        Nn[oy:oy + h2, ox:ox + w2] = T.resize(nrm[:, x0:x0 + sh.Wp], h2, w2)
        X[oy:oy + h2, ox:ox + w2, 1] = T.resize(rgh[:, x0:x0 + sh.Wp], h2, w2)
        subs.append(dict(variant=v, u0=ox / w, u1=(ox + w2) / w, v0=1 - (oy + h2) / h, v1=1 - oy / h,
                         length=sh.length, width=sh.width))
    lin = T.srgb_to_lin(A[..., :3])
    return lin, A[..., 3], Nn, X, subs


def build_leaf_atlas(only):
    os.makedirs(WORK, exist_ok=True)
    A = np.zeros((N, N, 3), np.float32)
    AL = np.zeros((N, N), np.float32)
    NM = np.tile(np.array([0.5, 0.5, 1.0], np.float32), (N, N, 1))
    X = np.ones((N, N, 3), np.float32)
    meta = {'tiles': {}}
    cache = f'{WORK}/understory_tiles.npz'
    meta_path = f'{TEX}/understory_leaf.json'
    if only and os.path.exists(cache):
        z = np.load(cache)
        A, AL, NM, X = z['A'], z['AL'], z['N'], z['X']
        with open(meta_path) as f:
            meta = json.load(f)
    sc, cam = SA.setup_scene()
    for (name, (x, y, w, h), kind, sheet, moods, pivot, seed) in TILES:
        if only and name not in only:
            continue
        rng = np.random.default_rng(seed)
        info = dict(kind=kind)
        if kind == 'image':
            alb, alpha, nrm, aux = load_tile(name, w, h)
            alb = T.bleed(alb, alpha, 0.5)
            phys = {'banana_intact': (0.55, 2.0), 'banana_torn': (0.55, 2.0), 'banana_shredded': (0.55, 2.0),
                    'banana_dead': (0.55, 2.0), 'colocasia': (0.75, 0.75), 'licuala': (1.2, 1.2)}[name]
            info.update(size_wh=list(phys), pivot=[0.5, 0.0 if pivot == 'bottom' else 0.5])
        elif kind == 'cells2x2':
            alb, alpha, nrm, aux, subs = cells2x2(sheet, moods, w, h)
            alb = T.bleed(alb, alpha, 0.5)
            nrm = T.bleed(nrm, alpha, 0.5)
            info.update(subs=subs)
        elif kind == 'singles':
            sh = SA.Sheet(sheet)
            a2, al2, n2, x2, subs = SA.singles(sh, moods)
            alb, alpha, nrm, aux = a2, al2, n2, x2
            info.update(subs=subs)
        else:
            sh = SA.Sheet(sheet)
            mb = J.MB()
            if kind == 'frond_bipinnate':
                frond_bipinnate(mb, rng, sh, moods, rng.uniform(2.2, 2.5), 0.6)
            elif kind == 'frond_dead':
                frond_bipinnate(mb, rng, sh, moods, 2.0, 0.45, dead=True)
            elif kind == 'frond_palm':
                frond_palm(mb, rng, sh, moods, 2.3)
            passes, (Sw, Sh), piv = render_rect(sc, cam, name, mb, sh, pivot, w, h)
            alb, alpha, nrm, aux = SA.finish_tile(passes)
            info.update(size_wh=[Sw, Sh], pivot=list(piv), faces=len(mb.F))
            print(f'tile {name}: {len(mb.F)} faces, {Sw:.2f} x {Sh:.2f} m')
        info['content'] = SA.content_box(alpha)
        info['coverage'] = float((alpha > 0.5).mean())
        info['rect'] = [x / N, 1 - (y + h) / N, (x + w) / N, 1 - y / N]
        A[y:y + h, x:x + w] = alb
        AL[y:y + h, x:x + w] = alpha
        NM[y:y + h, x:x + w] = nrm
        X[y:y + h, x:x + w] = aux
        meta['tiles'][name] = info
    np.savez_compressed(cache, A=A, AL=AL, N=NM, X=X)
    ao = 0.45 + 0.55 * np.clip(X[..., 0], 0, 1)
    orm = np.stack([ao, np.clip(X[..., 1], 0.15, 1), np.zeros_like(ao)], -1)
    T.write_png(f'{TEX}/understory_leaf_albedo.png', np.concatenate([T.lin_to_srgb(A), AL[..., None]], -1))
    T.write_png(f'{TEX}/understory_leaf_normal.png', NM)
    T.write_png(f'{TEX}/understory_leaf_orm.png', orm)
    meta['px'] = N
    with open(meta_path, 'w') as f:
        json.dump(meta, f, indent=1)
    print('understory_leaf written')


# ------------------------------------------------------------------------------------------------ scans
SCANS = [  # name, quadrant (col, row), albedo, alpha, normal, arm-or-rough
    ('fern_02', (0, 0), 'fern_02/textures/fern_02_diff_2k.jpg', 'fern_02/textures/fern_02_alpha_2k.png',
     'fern_02/textures/fern_02_nor_gl_2k.jpg', ('arm', 'fern_02/textures/fern_02_arm_2k.jpg')),
    ('calathea', (1, 0), 'calathea_orbifolia_01/textures/calathea_orbifolia_01_diff_2k.jpg',
     'calathea_orbifolia_01/textures/calathea_orbifolia_01_alpha_2k.png',
     'calathea_orbifolia_01/textures/calathea_orbifolia_01_nor_gl_2k.jpg', ('arm', 'calathea_orbifolia_01/textures/calathea_orbifolia_01_arm_2k.jpg')),
    ('anthurium', (0, 1), 'anthurium_botany_01/textures/anthurium_botany_01_diff_2k.jpg',
     'anthurium_botany_01/textures/anthurium_botany_01_alpha_2k.png',
     'anthurium_botany_01/textures/anthurium_botany_01_nor_gl_2k.jpg', ('arm', 'anthurium_botany_01/textures/anthurium_botany_01_arm_2k.jpg')),
    ('alocasia', (1, 1), 'potted_plant_02/textures/potted_plant_02_leaves_diff_2k.jpg',
     'potted_plant_02/textures/potted_plant_02_leaves_alpha_2k.png',
     'potted_plant_02/textures/potted_plant_02_leaves_nor_gl_2k.jpg', ('rough', 'potted_plant_02/textures/potted_plant_02_leaves_rough_2k.jpg')),
]


def to_alocasia(lin, alpha):
    """Syngonium arrowheads -> Alocasia-like: deeper, more uniform glossy green, veins only slightly paler."""
    m = alpha > 0.5
    lum = T.luminance(lin)
    base = np.median(lin[m], axis=0)
    blum = float(T.luminance(base[None])[0])
    target = T.srgb8(64, 98, 40)
    # compress luminance deviations (yellow veins) and pull hue toward the target green
    dev = (lum - blum) / max(blum, 1e-4)
    dev = np.clip(dev, -0.6, 1.5) * 0.35
    out = target[None, None, :] * (1 + dev[..., None])
    yel = np.clip((lin[..., 0] - lin[..., 2]) / (lum + 1e-4) - 0.6, 0, 1)[..., None]
    out = out * (1 - 0.25 * yel) + np.clip(out * T.srgb8(110, 130, 50) / target, 0, 1) * 0.25 * yel
    return np.clip(out, 0, 1)


def build_scan_atlas():
    Q = 1024
    A = np.zeros((N, N, 3), np.float32)
    AL = np.zeros((N, N), np.float32)
    NM = np.tile(np.array([0.5, 0.5, 1.0], np.float32), (N, N, 1))
    X = np.ones((N, N, 3), np.float32)
    meta = {'quads': {}}
    for name, (col, row), fa, fal, fn, (kind, fr) in SCANS:
        a = T.resize(T.read_image(f'{RAWM}/{fa}')[..., :3], Q, Q)
        al = T.resize(T.read_image(f'{RAWM}/{fal}')[..., 0], Q, Q)
        n = T.resize(T.read_image(f'{RAWM}/{fn}')[..., :3], Q, Q)
        r = T.resize(T.read_image(f'{RAWM}/{fr}')[..., :3], Q, Q)
        lin = T.srgb_to_lin(a)
        if name == 'alocasia':
            lin = to_alocasia(lin, al)
        if kind == 'arm':
            ao, rough = r[..., 0], r[..., 1]
        else:
            ao, rough = np.ones((Q, Q), np.float32), r[..., 0]
        lin = T.bleed(lin, al, 0.5)
        n = T.bleed(n, al, 0.5)
        x0, y0 = col * Q, row * Q
        A[y0:y0 + Q, x0:x0 + Q] = lin
        AL[y0:y0 + Q, x0:x0 + Q] = al
        NM[y0:y0 + Q, x0:x0 + Q] = n
        X[y0:y0 + Q, x0:x0 + Q] = np.stack([ao, rough, np.zeros_like(ao)], -1)
        meta['quads'][name] = dict(rect=[x0 / N, 1 - (y0 + Q) / N, (x0 + Q) / N, 1 - y0 / N])
        m = al > 0.5
        print(name, 'mean sRGB', (T.lin_to_srgb(lin[m].mean(0)) * 255).round(0))
    T.write_png(f'{TEX}/understory_scan_albedo.png', np.concatenate([T.lin_to_srgb(A), AL[..., None]], -1))
    T.write_png(f'{TEX}/understory_scan_normal.png', NM)
    T.write_png(f'{TEX}/understory_scan_orm.png', np.stack([0.4 + 0.6 * X[..., 0], X[..., 1], X[..., 2]], -1))
    with open(f'{TEX}/understory_scan.json', 'w') as f:
        json.dump(meta, f, indent=1)
    print('understory_scan written')


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    only = argv[argv.index('--only') + 1].split(',') if '--only' in argv else None
    if '--scan-only' not in argv:
        build_leaf_atlas(only)
    if only is None or '--scan-only' in argv:
        build_scan_atlas()


if __name__ == '__main__':
    main()
