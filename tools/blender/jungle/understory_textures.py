"""Procedural understory tiles (system Python + numpy):

    python tools/blender/jungle/understory_textures.py

Writes E:/tmp/island/helpers/jungle/tex/us_tiles/<name>_{albedo,normal,rough}.png for banana leaves (intact, torn,
shredded, dead; 256x1024, base at the bottom, midrib in the centre column), a Licuala fan leaf (512x512, petiole at
the centre), a Colocasia leaf (512x512, tip up, peltate point at (0.5, 0.36) from the bottom), and the understory stem
atlas understory_stem_{albedo,normal,orm}.png (1024x1024: four 256-px strips, each periodic in u and v:
banana pseudostem | tree-fern trunk | palm stem | sapling bark). No lighting baked into albedo.
"""
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jtex as T  # noqa: E402

OUT = 'E:/tmp/island/helpers/jungle/tex/us_tiles'
TEX = 'E:/tmp/island/helpers/jungle/tex'


def save(name, col, alpha, nrm, rough):
    col = T.bleed(col, alpha, 0.5)
    nrm = T.bleed(nrm, alpha, 0.5)
    T.write_png(f'{OUT}/{name}_albedo.png', np.concatenate([T.lin_to_srgb(col), alpha[..., None]], -1))
    T.write_png(f'{OUT}/{name}_normal.png', nrm)
    T.write_png(f'{OUT}/{name}_rough.png', np.clip(rough, 0, 1))
    m = alpha > 0.5
    print(name, (T.lin_to_srgb(col[m].mean(0)) * 255).round(0), 'coverage %.2f' % m.mean())


# --------------------------------------------------------------------------------------------- banana leaves
def banana(variant, seed, W=256, H=1024):
    rng = np.random.default_rng(seed)
    pad = 4
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    t = 1.0 - (yy - pad) / (H - 1 - 2 * pad)
    s = (xx - (W - 1) / 2) / ((W - 1) / 2 - pad)
    as_ = np.abs(s)
    hw = (W - 1) / 2 - pad
    L = H - 2 * pad
    base = T.smoothstep(0.0, 0.07, t) ** 0.6
    tip = 1 - T.smoothstep(0.86, 1.0, t) ** 1.7
    asym = np.where(s > 0, 1.0, rng.uniform(0.9, 0.97))
    w = np.clip(base * tip * (0.97 + 0.03 * np.sin(t * 9 + 1)) * asym, 0, 1)
    w = np.where((t < 0) | (t > 1), 0, w)
    sd = (w - as_) * hw
    alpha = np.clip(sd + 0.5, 0, 1)
    mid_w = (0.055 * W) * (1 - 0.65 * np.clip(t, 0, 1)) + 1.0
    midrib = np.clip(mid_w - as_ * hw + 0.5, 0, 1)
    # fine parallel lateral veins, angled toward margin + tip, slightly curving
    ang = math.radians(rng.uniform(10, 14))
    ph = (t * L - as_ * hw * (math.tan(ang) + 0.15 * as_)) / 2.6
    veins = (0.5 + 0.5 * np.cos(ph * 2 * np.pi)) ** 8 * (as_ * hw > mid_w)
    major = (0.5 + 0.5 * np.cos(ph * 2 * np.pi / 7)) ** 30 * (as_ * hw > mid_w)
    nlo = T.fft_noise(H, W, beta=2.4, seed=seed + 1)
    nst = T.fft_noise(H, W, beta=1.5, seed=seed + 2, aniso=(0.3, 1.0))
    dead = variant == 'dead'
    col = np.ones((H, W, 3), np.float32) * (T.srgb8(84, 116, 42) if not dead else T.srgb8(108, 78, 48))
    col *= (1 + 0.06 * nlo[..., None] + 0.05 * nst[..., None])
    lam = np.clip(as_ / np.maximum(w, 1e-3), 0, 1)
    col *= (1 + 0.12 * (1 - lam) ** 2)[..., None] * (1 - 0.1 * lam ** 3)[..., None]
    if not dead:
        yel = T.smoothstep(0.6, 1.0, lam)[..., None] * 0.15
        col = col * (1 - yel) + T.srgb8(120, 128, 50) * yel
    mcol = np.clip(col * 1.55 + T.srgb8(30, 30, 0) * 0.3, 0, 1) if not dead else col * 1.15
    col = col * (1 - 0.85 * midrib[..., None]) + mcol * 0.85 * midrib[..., None]
    col = col * (1 + (0.06 * veins + 0.06 * major)[..., None])
    # necrotic margins / streaks
    nec = T.smoothstep(4.0, 0.0, sd + 3.0 * nlo) * (0.4 if variant == 'intact' else 0.8)
    if dead:
        nec = nec * 0.4
    col = col * (1 - nec[..., None]) + T.srgb8(105, 76, 44) * nec[..., None]
    streak = T.smoothstep(1.9, 2.6, nst) * (0.0 if dead else 0.3)
    col = col * (1 - streak[..., None]) + T.srgb8(70, 52, 30) * streak[..., None]
    if dead:
        mott = T.smoothstep(-0.5, 1.5, T.fft_noise(H, W, beta=1.8, seed=seed + 3))[..., None]
        col = col * (1 - 0.3 * mott) + T.srgb8(132, 100, 62) * 0.3 * mott
        col = col * (1 - 0.3 * veins[..., None])
    # tears along the veins
    ntear = {'intact': rng.integers(5, 9), 'torn': rng.integers(16, 24), 'shredded': rng.integers(30, 42), 'dead': rng.integers(34, 46)}[variant]
    rim = np.zeros((H, W), np.float32)
    # tears wander off the vein line a little and their edges fray (no ruler-straight cuts)
    wob = 0.55 * T.fft_noise(H, W, beta=2.0, seed=seed + 21, aniso=(1.0, 0.4))
    frz = T.fft_noise(H, W, beta=1.1, seed=seed + 22)
    for side in (-1, 1):
        for k in range(ntear):
            t0 = rng.uniform(0.06, 0.95)
            depth = rng.uniform(0.55, 0.96) if variant != 'intact' else rng.uniform(0.3, 0.7)
            if dead:
                depth = 0.7 + 0.29 * (depth - 0.55) / 0.41
            gap = rng.uniform(1.6, 3.0) if rng.uniform() > 0.35 else rng.uniform(4.0, 10.0)
            if variant == 'intact':
                gap = rng.uniform(1.2, 2.0)
            # tear follows the vein line through (t0 at the margin)
            ph0 = (t0 * L - hw * (math.tan(ang) + 0.15)) / 2.6
            dph = np.abs(ph + wob - ph0)
            g = gap * (0.25 + 0.75 * as_ ** 1.5) + 0.7 * frz  # strips spread apart toward the margin
            on = (np.sign(s) == side) & (as_ > (1 - depth)) & (dph * 2.6 < g)
            alpha = alpha * np.where(on, 0.0, 1.0)
            rim = np.maximum(rim, ((np.sign(s) == side) & (as_ > (1 - depth)) & (dph * 2.6 < g + 1.5)).astype(np.float32))
    if variant in ('shredded', 'dead'):  # ragged chunks missing at the margin
        rag = T.fft_noise(H, W, beta=1.6, seed=seed + 5)
        for k in range(rng.integers(2, 5)):
            t0 = rng.uniform(0.15, 0.9)
            side = rng.choice([-1, 1])
            d = rng.uniform(0.12, 0.35)
            dd = np.sqrt(((t - t0) * L / (d * hw * 0.8)) ** 2 + ((1 - as_) / d) ** 2) + 0.35 * rag
            on = (np.sign(s) == side) & (dd < 1.0)
            alpha = alpha * np.where(on, 0.0, 1.0)
        # frayed, nibbled margins
        fray = T.fft_noise(H, W, beta=1.0, seed=seed + 24)
        alpha = alpha * np.clip(sd - 1.0 - (3.5 if dead else 2.0) * np.clip(fray, 0, None) + 0.5, 0, 1)
    col = col * (1 - 0.35 * rim[..., None] * (alpha > 0)[..., None]) + T.srgb8(110, 84, 50) * 0.35 * rim[..., None] * (alpha > 0)[..., None]
    hgt = -0.9 * T.blur(midrib, 1.5) + 0.25 * veins + 0.4 * major + 0.08 * nst
    if dead:
        hgt += 0.6 * T.blur(T.fft_noise(H, W, beta=1.6, seed=seed + 9), 1.0)
    nrm = T.normal_from_height(hgt * np.clip(alpha * 3, 0, 1), 1.4, wrap=False)
    rough = (0.42 if not dead else 0.88) + 0.06 * nlo + 0.1 * midrib
    return col, alpha, nrm, rough


# --------------------------------------------------------------------------------------------- licuala fan
def licuala(seed, N=512):
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    c = (N - 1) / 2
    x, y = (xx - c) / (c - 4), (c - yy) / (c - 4)
    r = np.sqrt(x * x + y * y)
    th = np.arctan2(x, y)  # 0 = up (leaf "tip" direction), +-pi = toward the petiole side
    span = math.radians(330)
    inside_span = np.abs(th) < span / 2
    nseg = int(rng.integers(10, 14))
    a = (th + span / 2) / span * nseg
    seg = np.floor(a)
    f = a - seg
    # segment edges (radial gaps that widen outward), truncate toothed tips
    gap = 0.012 + 0.05 * r ** 1.5
    edge = np.minimum(f, 1 - f) * span / nseg
    seg_alpha = np.clip((edge - gap * 0.5) * N * 0.5, 0, 1)
    rr = np.ones_like(r) * 0.97
    teeth = 0.02 * np.abs(np.sin(f * np.pi * rng.integers(3, 6)))
    rmax = (0.93 + 0.05 * np.sin(seg * 2.1 + rng.uniform(0, 6))) - teeth
    alpha = np.clip((rmax - r) * N * 0.5, 0, 1) * seg_alpha * inside_span * np.clip((r - 0.04) * N * 0.5, 0, 1)
    pleat = np.cos(f * np.pi * 2 * rng.integers(2, 4))
    ribs = np.clip(1.2 - np.abs(np.sin(f * np.pi * 2 * 3)) * 6, 0, 1)
    nlo = T.fft_noise(N, N, beta=2.4, seed=seed + 1)
    col = np.ones((N, N, 3), np.float32) * T.srgb8(52, 84, 34)
    col *= (1 + 0.07 * nlo[..., None] + 0.08 * pleat[..., None])
    col *= (1 + 0.12 * (1 - r))[..., None]
    col = col * (1 - 0.3 * ribs[..., None]) + np.clip(col * 1.4, 0, 1) * 0.3 * ribs[..., None]
    nec = T.smoothstep(0.86, 0.95, r + 0.04 * nlo)[..., None] * 0.5
    col = col * (1 - nec) + T.srgb8(110, 92, 50) * nec
    hgt = 0.5 * pleat + 0.15 * ribs + 0.05 * nlo
    nrm = T.normal_from_height(hgt, 3.0, wrap=False)
    rough = 0.38 + 0.05 * nlo + 0.1 * ribs
    return col, alpha, nrm, rough


# --------------------------------------------------------------------------------------------- colocasia
def colocasia(seed, N=512):
    """Peltate heart-shaped taro leaf, matte satin blue-green, veins radiating from the peltate point."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    px, py = 0.5 * (N - 1), (1 - 0.36) * (N - 1)  # peltate point (36% up from the bottom)
    x, y = (xx - px) / (N * 0.5), (py - yy) / (N * 0.5)
    r = np.sqrt(x * x + y * y)
    th = np.arctan2(x, y)  # 0 = toward the tip (up)
    # heart outline in polar coords around the peltate point; deep notch at the bottom
    R = 1.22 * (0.62 + 0.38 * np.cos(th) ** 2) * (1 - 0.22 * np.cos(th)) + 0.03 * np.sin(th * 9 + 1)
    R = np.where(np.cos(th) > 0, R * (1 + 0.32 * np.cos(th) ** 6), R)
    notch = np.clip((np.abs(th) - (np.pi - 0.42 * (1 - 0.5 * r))) * 4, 0, 1)
    R = R * (1 - notch)
    alpha = np.clip((R * 0.78 - r) * N * 0.5, 0, 1)
    main = [0.0, 2.35, -2.35, 1.2, -1.2, 0.55, -0.55, 1.75, -1.75]
    veins = np.zeros_like(r)
    for k, a0 in enumerate(main):
        curv = 0.25 * np.sign(a0) * (r ** 1.2)
        da = np.abs(np.angle(np.exp(1j * (th - a0 - curv))))
        wv = (2.2 if k < 3 else 1.3) / (N * 0.5) / np.maximum(r, 0.03)
        veins = np.maximum(veins, np.clip(1 - da / wv, 0, 1) * (r > 0.03) * (r < R * 0.74) * (1.0 if k < 3 else 0.7))
    tert = np.clip(1.0 - np.abs(np.sin(th * 34 + r * 6)) * 8, 0, 1) * 0.25 * (r > 0.1)
    nlo = T.fft_noise(N, N, beta=2.5, seed=seed + 1)
    col = np.ones((N, N, 3), np.float32) * T.srgb8(58, 88, 52)
    col *= (1 + 0.06 * nlo[..., None] + 0.08 * (1 - np.clip(r / 0.8, 0, 1))[..., None])
    vc = np.clip(col * 1.3 + T.srgb8(20, 20, 30) * 0.2, 0, 1)
    col = col * (1 - 0.55 * veins[..., None]) + vc * 0.55 * veins[..., None]
    col = col * (1 + 0.04 * tert[..., None])
    nec = T.smoothstep(0.03, -0.01, (R * 0.78 - r) + 0.01 * nlo)[..., None] * 0.6
    col = col * (1 - nec) + T.srgb8(112, 90, 52) * nec
    hgt = -0.6 * T.blur(veins, 1.2) - 0.1 * tert + 0.05 * nlo
    nrm = T.normal_from_height(hgt, 2.2, wrap=False)
    rough = 0.62 + 0.05 * nlo  # satin / matte taro surface
    return col, alpha, nrm, rough


# --------------------------------------------------------------------------------------------- stems
def stems(seed=7):
    W, H = 256, 1024
    strips_c, strips_h, strips_r, strips_ao = [], [], [], []
    # 1 banana pseudostem: green sheaths, dark blotches, fibres, dry brown sheath strips
    f = T.fft_noise(H, W, beta=1.2, seed=seed, aniso=(1.0, 0.08))
    blot = T.smoothstep(0.9, 1.6, T.fft_noise(H, W, beta=2.4, seed=seed + 1, aniso=(1.0, 0.4)))
    dry = T.smoothstep(0.7, 1.2, T.fft_noise(H, W, beta=2.0, seed=seed + 2, aniso=(1.0, 0.12)))
    c = np.ones((H, W, 3), np.float32) * T.srgb8(78, 104, 46)
    c *= (1 + 0.08 * f[..., None])
    c = c * (1 - 0.7 * blot[..., None]) + T.srgb8(52, 40, 30) * 0.7 * blot[..., None]
    c = c * (1 - 0.8 * dry[..., None]) + T.srgb8(130, 104, 66) * (1 + 0.1 * f[..., None]) * 0.8 * dry[..., None]
    strips_c.append(c)
    strips_h.append(0.4 * f + 0.6 * dry)
    strips_r.append(0.5 + 0.3 * dry)
    strips_ao.append(1 - 0.3 * blot)
    # 2 tree-fern trunk: matted fibrous roots + diamond lattice of oval stipe scars
    fib = T.fft_noise(H, W, beta=0.8, seed=seed + 3, aniso=(1.0, 0.3))
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    nu, nv = 4, 10
    wu = T.fft_noise(H, W, beta=2.2, seed=seed + 11) * 0.12
    wv = T.fft_noise(H, W, beta=2.2, seed=seed + 12) * 0.12
    u = xx / W * nu + wu
    v = yy / H * nv + wv
    v2 = v + 0.5 * (np.floor(u) % 2)
    cell_r = np.random.default_rng(seed + 13).uniform(0.7, 1.2, (nv + 2, nu + 2))
    sz = cell_r[(np.floor(v2).astype(int)) % nv, (np.floor(u).astype(int)) % nu]
    du = (u % 1) - 0.5
    dv = (v2 % 1) - 0.5
    scar_d = np.sqrt((du / (0.2 * sz)) ** 2 + (dv / (0.3 * sz)) ** 2) * (1 + 0.15 * fib)
    scar = T.smoothstep(1.0, 0.8, scar_d)
    rimg = T.smoothstep(0.75, 0.95, scar_d) * T.smoothstep(1.15, 0.95, scar_d)
    # shaggy: near-black matted root fibres with rusty hair streaks, dark old stipe bases
    hair = T.smoothstep(0.5, 1.6, T.fft_noise(H, W, beta=0.7, seed=seed + 14, aniso=(1.0, 0.12)))
    c = np.ones((H, W, 3), np.float32) * T.srgb8(36, 27, 20)
    c *= (1 + 0.25 * fib[..., None])
    c = c * (1 - 0.55 * hair[..., None]) + T.srgb8(84, 58, 36) * 0.55 * hair[..., None]
    c = c * (1 - 0.5 * scar[..., None]) + T.srgb8(52, 40, 30) * (1 + 0.1 * fib[..., None]) * 0.5 * scar[..., None]
    c = c * (1 - 0.6 * rimg[..., None])
    strips_c.append(c)
    strips_h.append(0.5 * fib + 0.35 * hair + 0.6 * scar - 0.5 * rimg)
    strips_r.append(0.94 - 0.06 * scar)
    strips_ao.append(1 - 0.4 * rimg - 0.25 * np.clip(-fib, 0, 1))
    # 3 palm stem: green-brown cane with leaf-scar rings and fibrous patches
    ring_v = (yy / H * 14) % 1.0
    ring = T.smoothstep(0.08, 0.0, np.abs(ring_v - 0.5) - 0.0) * 0 + np.exp(-((ring_v - 0.5) / 0.03) ** 2)
    fz = T.fft_noise(H, W, beta=1.4, seed=seed + 4, aniso=(1.0, 0.15))
    fibr = T.smoothstep(0.6, 1.3, T.fft_noise(H, W, beta=2.0, seed=seed + 5))
    c = np.ones((H, W, 3), np.float32) * T.srgb8(84, 92, 54)
    c *= (1 + 0.07 * fz[..., None])
    c = c * (1 - 0.5 * ring[..., None]) + T.srgb8(70, 58, 40) * 0.5 * ring[..., None]
    c = c * (1 - 0.7 * fibr[..., None]) + T.srgb8(96, 76, 52) * 0.7 * fibr[..., None]
    strips_c.append(c)
    strips_h.append(-0.6 * ring + 0.3 * fz + 0.4 * fibr)
    strips_r.append(0.55 + 0.3 * fibr)
    strips_ao.append(1 - 0.3 * ring)
    # 4 sapling bark: smooth grey-brown with lenticels and green algae tint
    sm = T.fft_noise(H, W, beta=2.2, seed=seed + 6, aniso=(1.0, 0.5))
    len_ = T.smoothstep(2.4, 2.8, T.fft_noise(H, W, beta=0.4, seed=seed + 7, fmin=40, aniso=(0.5, 1.0)))
    alg = T.smoothstep(0.4, 1.4, T.fft_noise(H, W, beta=2.4, seed=seed + 8))
    c = np.ones((H, W, 3), np.float32) * T.srgb8(108, 100, 86)
    c *= (1 + 0.07 * sm[..., None])
    c = c * (1 - 0.35 * alg[..., None]) + T.srgb8(86, 100, 66) * 0.35 * alg[..., None]
    c = c * (1 - 0.6 * len_[..., None]) + T.srgb8(150, 140, 118) * 0.6 * len_[..., None]
    strips_c.append(c)
    strips_h.append(0.2 * sm + 0.5 * len_)
    strips_r.append(0.7 + 0.05 * sm)
    strips_ao.append(np.ones((H, W), np.float32))
    col = np.concatenate(strips_c, 1)
    hgt = np.concatenate(strips_h, 1)
    nrm = np.concatenate([T.normal_from_height(h, 2.0) for h in strips_h], 1)
    orm = np.stack([np.clip(np.concatenate(strips_ao, 1), 0, 1), np.clip(np.concatenate(strips_r, 1), 0, 1),
                    np.zeros((H, 4 * W), np.float32)], -1)
    T.write_png(f'{TEX}/understory_stem_albedo.png', T.lin_to_srgb(col))
    T.write_png(f'{TEX}/understory_stem_normal.png', nrm)
    T.write_png(f'{TEX}/understory_stem_orm.png', orm)
    print('stems', [(T.lin_to_srgb(c.reshape(-1, 3).mean(0)) * 255).round(0) for c in strips_c])


def main():
    os.makedirs(OUT, exist_ok=True)
    for i, v in enumerate(['intact', 'torn', 'shredded', 'dead']):
        save(f'banana_{v}', *banana(v, 500 + 17 * i))
    save('licuala', *licuala(600))
    save('colocasia', *colocasia(700))
    stems()
    with open(f'{OUT}/info.json', 'w') as f:
        json.dump(dict(banana=dict(length=2.0, width=0.55), licuala=dict(radius=0.6, petiole_uv=[0.5, 0.5]),
                       colocasia=dict(length=0.75, peltate_uv=[0.5, 0.36])), f, indent=1)


if __name__ == '__main__':
    main()
