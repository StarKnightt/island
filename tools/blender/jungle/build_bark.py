"""Builds the canopy bark texture set (system Python + numpy):

    python tools/blender/jungle/build_bark.py

Source: Poly Haven `japanese_hackberry_bark` (CC0, 1.89 m tile) graded toward a pale grey-brown rainforest bark,
plus procedural crustose lichen blotches, moss and soil staining.

Layout of the 1024 x 2048 maps (row 0 = top, Blender v = 1):
  rows    0..1023 (v 1.0 .. 0.5): lower-trunk region, 3.8 m of bark (two scan tiles squeezed vertically), moss rising
                                  toward the bottom (z = 0 at v ~0.579), soil stain at the very bottom; its top and
                                  bottom rows are clean bark so it tiles with the clean half.
  rows 1024..2047 (v 0.5 .. 0.0): clean bark tile, 1.9 m x 1.9 m, periodic in both directions.
Mapping used by the generators: lower zone z in [-0.6, 3.2] -> v in [0.5, 1.0]; above that, 1.9 m segments -> v in
[0.0, 0.5] (seam ring per segment); u wraps around the trunk with 1.9 m per unit (rounded to whole wraps).
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jtex as T  # noqa: E402

SRC = 'E:/tmp/island/raw/jungle/tex/japanese_hackberry_bark/japanese_hackberry_bark'
OUT = 'E:/tmp/island/helpers/jungle/tex'
N = 1024
TILE_M = 1.9
LOW_Z0, LOW_Z1 = -0.6, 3.2


def load_scan():
    alb = T.read_image(SRC + '_diff_2k.jpg')[..., :3]
    nrm = T.read_image(SRC + '_nor_gl_2k.png')[..., :3]
    rgh = T.read_image(SRC + '_rough_2k.jpg')[..., 0]
    ao = T.read_image(SRC + '_ao_2k.jpg')[..., 0]
    hgt = T.read_image(SRC + '_disp_2k.png')[..., 0]
    alb = T.resize(T.srgb_to_lin(alb), N, N)
    n = T.resize(nrm * 2 - 1, N, N)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return alb, n * 0.5 + 0.5, T.resize(rgh, N, N), T.resize(ao, N, N), T.resize(hgt, N, N)


def grade(alb):
    """Pull the scan toward pale grey-brown (sRGB ~112,106,96) and tame the yellow algae streaks."""
    lum = T.luminance(alb)[..., None]
    sat = alb - lum
    yellow = np.clip((alb[..., 1] - alb[..., 2]) / (lum[..., 0] + 1e-4) - 0.25, 0, 1)[..., None]
    alb = lum + sat * (0.55 - 0.15 * yellow)
    target = T.srgb8(112, 106, 96)
    mean = alb.reshape(-1, 3).mean(0)
    return np.clip(alb * (target / mean), 0, 1)


def warp(a, dx, dy):
    """Periodic domain warp of a 2-D field by pixel offsets."""
    h, w = a.shape
    yy, xx = np.mgrid[0:h, 0:w]
    return a[(yy + np.round(dy).astype(int)) % h, (xx + np.round(dx).astype(int)) % w]


def lichen_layer(seed, bark_lum):
    """Crustose lichen: thin whitish grey-green crusts of many sizes with lobed edges; bark relief shows through.
    Returns coverage (N x N), rim darkening and colour. Periodic."""
    det = T.fft_noise(N, N, beta=1.0, seed=seed + 1)
    wx = T.fft_noise(N, N, beta=2.2, seed=seed + 5) * 9
    wy = T.fft_noise(N, N, beta=2.2, seed=seed + 6) * 9
    big = warp(T.fft_noise(N, N, beta=2.8, seed=seed, aniso=(1.0, 0.75)), wx, wy)
    mid = warp(T.fft_noise(N, N, beta=2.2, seed=seed + 2, fmin=6), wx * 0.6, wy * 0.6)
    sml = T.fft_noise(N, N, beta=1.6, seed=seed + 3, fmin=25)
    cov = np.maximum.reduce([
        T.smoothstep(1.85, 2.1, big + 0.18 * det) * 0.9,
        T.smoothstep(1.55, 1.8, mid + 0.22 * det) * 0.95,
        T.smoothstep(1.95, 2.2, sml + 0.15 * det) * 0.9,
    ])
    thin = np.clip(0.55 + 0.45 * T.smoothstep(-0.4, 0.8, det), 0, 1)
    cov = cov * thin
    rim = np.clip(T.smoothstep(0.05, 0.25, cov) - T.smoothstep(0.35, 0.7, cov), 0, 1)
    tone = T.smoothstep(-1.2, 1.2, T.fft_noise(N, N, beta=2.4, seed=seed + 4))[..., None]
    white, green, yel = T.srgb8(176, 176, 166), T.srgb8(150, 156, 134), T.srgb8(166, 160, 120)
    col = white * (1 - tone) + green * tone
    ys = T.smoothstep(1.2, 2.0, T.fft_noise(N, N, beta=2.6, seed=seed + 7))[..., None]
    col = col * (1 - 0.5 * ys) + yel * 0.5 * ys
    hp = bark_lum - T.blur(bark_lum, 6.0)
    col = col * np.clip(1.0 + 3.0 * hp[..., None] + 0.07 * det[..., None], 0.6, 1.25)
    dots = T.smoothstep(2.9, 3.2, T.fft_noise(N, N, beta=0.3, seed=seed + 8, fmin=120))
    col = col * (1 - 0.6 * dots[..., None])
    return cov.astype(np.float32), rim.astype(np.float32), col.astype(np.float32)


def moss(h, w, seed):
    """Procedural moss at physical resolution: cushions (~1-4 cm) of fine tufts with near-black gaps, olive to
    yellow-green tips. Returns albedo, height (cushion thickness, 0..1) and roughness."""
    tufts = T.blur(T.fft_noise(h, w, beta=0.2, seed=seed, fmin=150), 0.7)
    tufts /= tufts.std() + 1e-6
    cush = T.fft_noise(h, w, beta=1.4, seed=seed + 1, fmin=18, fmax=140)
    cush_h = T.smoothstep(-0.9, 0.9, cush)
    hgt = np.clip(0.45 * cush_h + 0.35 * np.clip(tufts * 0.5 + 0.5, 0, 1) + 0.2, 0, 1)
    dark, base, tip = T.srgb8(34, 42, 20), T.srgb8(60, 76, 34), T.srgb8(90, 104, 44)
    t = np.clip(hgt + 0.1 * tufts, 0, 1)[..., None]
    col = np.where(t < 0.55, dark + (base - dark) * (t / 0.55), base + (tip - base) * ((t - 0.55) / 0.45))
    hue = T.fft_noise(h, w, beta=2.4, seed=seed + 2)[..., None]
    olive, yel = T.srgb8(70, 78, 36), T.srgb8(112, 116, 50)
    col = col * (1 - 0.3 * T.smoothstep(0.3, 1.5, hue)) + olive * 0.3 * T.smoothstep(0.3, 1.5, hue)
    col = col * (1 - 0.3 * T.smoothstep(0.6, 1.8, -hue)) + yel * 0.3 * T.smoothstep(0.6, 1.8, -hue)
    rough = np.clip(0.9 + 0.06 * tufts, 0.8, 1.0)
    return col.astype(np.float32), hgt.astype(np.float32), rough.astype(np.float32)


def main():
    os.makedirs(OUT, exist_ok=True)
    alb, nrm, rgh, ao, hgt = load_scan()
    alb = grade(alb)

    # lichen on the base tile
    lm, rim, lcol = lichen_layer(11, T.luminance(alb))
    alb = alb * (1 - 0.22 * rim[..., None])
    alb = alb * (1 - lm[..., None]) + lcol * lm[..., None]
    hgt = hgt + 0.015 * lm
    rgh = np.clip(rgh * (1 - lm) + 0.85 * lm, 0, 1)
    ln = T.normal_from_height(T.blur(lm, 0.8), 1.2)
    nrm = T.detail_normals(nrm, ln)
    rgh = np.clip(0.7 + (rgh - rgh.mean()) * 0.8 + 0.1, 0.55, 0.95)
    print('lichen cover', float(lm.mean()))

    # --- clean half (rows 1024..2047)
    clean_alb, clean_nrm, clean_rgh, clean_ao = alb, nrm, rgh, ao

    # --- lower-trunk half at physical resolution: two tiles stacked (2048 rows = 3.8 m), then squeezed to 1024
    H2 = 2 * N
    talb = np.concatenate([alb, alb], 0)
    tnrm = np.concatenate([nrm, nrm], 0)
    trgh = np.concatenate([rgh, rgh], 0)
    tao = np.concatenate([ao, ao], 0)
    thgt = np.concatenate([hgt, hgt], 0)
    rows = np.arange(H2)
    z = LOW_Z1 - (rows + 0.5) / H2 * (LOW_Z1 - LOW_Z0)  # row 0 = top of the lower zone
    zc = z[:, None]

    # moss coverage: dense from the soil to ~1 m, patchy streaks and crevice lines to ~2.8 m, gone at region edges
    prof = 1.0 - T.smoothstep(0.4, 2.8, zc)
    prof *= T.smoothstep(-0.58, -0.42, zc)
    wx = T.fft_noise(H2, N, beta=2.2, seed=25) * 14
    wy = T.fft_noise(H2, N, beta=2.2, seed=26) * 14
    patch = warp(T.fft_noise(H2, N, beta=2.3, seed=21, aniso=(1.0, 0.4)), wx, wy)
    streak = T.fft_noise(H2, N, beta=2.0, seed=22, aniso=(1.0, 0.15))
    islands = T.fft_noise(H2, N, beta=1.7, seed=23, fmin=20)
    crev = 1.0 - np.clip((thgt - thgt.mean()) / (thgt.std() * 2.5) + 0.5, 0, 1)
    cover = prof * 1.25 + 0.55 * patch + 0.3 * streak + 0.3 * islands + 0.7 * (crev - 0.5) - 0.9
    mcol, mhgt, mrgh = moss(H2, N, 31)
    # thickness: thin where coverage is marginal, so the edge breaks into tufts over the bark
    thick = np.clip(cover * 2.2, 0, 1) * (0.55 + 0.45 * mhgt)
    mm = T.smoothstep(0.12, 0.42, thick) * T.smoothstep(-0.58, -0.42, zc)
    talb = talb * (1 - mm[..., None]) + mcol * mm[..., None]
    mn = T.normal_from_height(T.blur(mhgt * mm, 0.6) * 0.06, 9.0)
    tnrm = T.blend_normals(tnrm, mn, np.clip(mm * 1.3, 0, 1))
    trgh = trgh * (1 - mm) + mrgh * mm
    tao = tao * (1 - 0.5 * mm) + (0.45 + 0.55 * mhgt) * 0.5 * mm
    print('moss cover (lower region)', float(mm.mean()))

    # soil splash / damp stain at the base (dark brown, slightly smoother)
    stain = (1.0 - T.smoothstep(-0.2, 0.45, zc)) * T.smoothstep(-0.58, -0.42, zc)
    stain = stain * np.clip(0.75 + 0.35 * T.fft_noise(H2, N, beta=1.8, seed=41, aniso=(1.0, 0.5)), 0, 1)
    soil = T.srgb8(70, 54, 40)
    talb = talb * (1 - 0.55 * stain[..., None]) + soil * 0.55 * stain[..., None]
    trgh = trgh * (1 - 0.3 * stain) + 0.7 * 0.3 * stain
    # bark slightly greener / darker where damp above the moss line
    damp = (1.0 - T.smoothstep(0.5, 3.0, zc)) * T.smoothstep(-0.58, -0.42, zc) * (1 - mm)
    talb = talb * (1 - 0.18 * damp[..., None]) + talb * T.srgb8(90, 100, 70) / T.srgb8(112, 106, 96) * 0.18 * damp[..., None]

    low_alb = T.resize(talb, N, N)
    n2 = T.resize(tnrm * 2 - 1, N, N)
    n2 /= np.linalg.norm(n2, axis=-1, keepdims=True)
    low_nrm = n2 * 0.5 + 0.5
    low_rgh = T.resize(trgh, N, N)
    low_ao = T.resize(tao, N, N)

    out_alb = np.concatenate([low_alb, clean_alb], 0)
    out_nrm = np.concatenate([low_nrm, clean_nrm], 0)
    out_rgh = np.concatenate([low_rgh, clean_rgh], 0)
    out_ao = np.concatenate([low_ao, clean_ao], 0)
    out_ao = np.clip(0.35 + 0.65 * out_ao, 0, 1)

    srgb = T.lin_to_srgb(out_alb)
    T.write_png(f'{OUT}/canopy_bark_albedo.png', srgb)
    T.write_png(f'{OUT}/canopy_bark_normal.png', out_nrm)
    orm = np.stack([out_ao, out_rgh, np.zeros_like(out_ao)], -1)
    T.write_png(f'{OUT}/canopy_bark_orm.png', orm)
    m = srgb.reshape(-1, 3).mean(0) * 255
    mc = (T.lin_to_srgb(clean_alb).reshape(-1, 3).mean(0) * 255)
    print('bark albedo mean sRGB all', m.round(1), 'clean', mc.round(1))


if __name__ == '__main__':
    main()
