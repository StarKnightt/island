"""numpy texture helpers for the jungle assets (works in system Python and in Blender's Python).

PNG I/O without PIL (own zlib writer; reading goes through tools/blender/jungle/img.mjs + sharp), tileable FFT
noise, colour-space conversion, push-pull alpha bleeding, normal maps from height fields, resampling.
"""
import json
import os
import struct
import subprocess
import zlib

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


# ----------------------------------------------------------------------------------------------------- PNG I/O
def write_png(path, arr):
    """arr: HxW, HxWx3 or HxWx4; uint8 / uint16, or float in 0..1 (written as uint8). Row 0 = top of the image."""
    a = np.asarray(arr)
    if a.dtype.kind == 'f':
        a = np.clip(np.round(a * 255.0), 0, 255).astype(np.uint8)
    if a.ndim == 2:
        a = a[:, :, None]
    h, w, c = a.shape
    ctype = {1: 0, 2: 4, 3: 2, 4: 6}[c]
    bitd = 16 if a.dtype == np.uint16 else 8
    b = a.astype('>u2').view(np.uint8) if bitd == 16 else a.astype(np.uint8)
    rows = b.reshape(h, -1)
    up = rows.copy()
    up[1:] = rows[1:] - rows[:-1]  # PNG "Up" filter (mod 256 by uint8 wrap)
    raw = np.empty((h, rows.shape[1] + 1), np.uint8)
    raw[:, 0] = 2
    raw[0, 0] = 0
    raw[0, 1:] = rows[0]
    raw[1:, 1:] = up[1:]
    data = zlib.compress(raw.tobytes(), 6)

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xFFFFFFFF)

    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, bitd, ctype, 0, 0, 0)))
        f.write(chunk(b'IDAT', data))
        f.write(chunk(b'IEND', b''))


def read_image(path):
    """Any image sharp can read -> HxWx4 float32 0..1 (no colour conversion). Uses node + sharp."""
    tmp = os.path.join(os.environ.get('TEMP', 'E:/tmp'), 'jtex_' + str(os.getpid()) + '.rgba')
    subprocess.run(['node', os.path.join(HERE, 'img.mjs'), 'torgba', path, tmp], check=True, capture_output=True)
    with open(tmp + '.json') as f:
        d = json.load(f)
    a = np.fromfile(tmp, np.uint8).reshape(d['h'], d['w'], 4).astype(np.float32) / 255.0
    os.remove(tmp)
    os.remove(tmp + '.json')
    return a


# ------------------------------------------------------------------------------------------------ colour space
def srgb_to_lin(c):
    c = np.asarray(c, np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(np.asarray(c, np.float32), 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def srgb8(r, g, b):
    """sRGB 0..255 triple -> linear float triple."""
    return srgb_to_lin(np.array([r, g, b], np.float32) / 255.0)


def luminance(lin):
    return lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722


# ----------------------------------------------------------------------------------------------------- noise
def fft_noise(h, w, beta=2.0, seed=0, fmin=0.0, fmax=None, aniso=(1.0, 1.0)):
    """Tileable (period h x w) fractal noise, zero mean / unit std. beta = spectral slope (2 ~ smooth, 1 ~ rough).
    aniso = (sx, sy) stretches features: sy > 1 makes them longer vertically."""
    rng = np.random.default_rng(seed)
    F = np.fft.rfft2(rng.standard_normal((h, w)))
    fy = np.fft.fftfreq(h)[:, None] * h
    fx = np.fft.rfftfreq(w)[None, :] * w
    f = np.sqrt((fx * aniso[0]) ** 2 + (fy * aniso[1]) ** 2)
    amp = 1.0 / np.maximum(f, 1.0) ** (beta / 2.0 + 0.5)
    if fmin:
        amp *= 1.0 / (1.0 + (fmin / np.maximum(f, 1e-3)) ** 4)
    if fmax:
        amp *= np.exp(-(f / fmax) ** 2)
    amp[0, 0] = 0
    n = np.fft.irfft2(F * amp, s=(h, w))
    n -= n.mean()
    return (n / (n.std() + 1e-9)).astype(np.float32)


def blur(a, sigma, wrap=True):
    """Gaussian blur by FFT (periodic). a: HxW or HxWxC."""
    if sigma <= 0:
        return a
    h, w = a.shape[:2]
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.rfftfreq(w)[None, :]
    g = np.exp(-2 * (np.pi * sigma) ** 2 * (fx ** 2 + fy ** 2))
    if a.ndim == 2:
        return np.fft.irfft2(np.fft.rfft2(a) * g, s=(h, w)).astype(np.float32)
    return np.stack([np.fft.irfft2(np.fft.rfft2(a[..., i]) * g, s=(h, w)) for i in range(a.shape[2])], -1).astype(np.float32)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


# ------------------------------------------------------------------------------------------------- resampling
def resize(a, h, w):
    """Area-ish resample: box-downsample by integer factors when possible, else bilinear."""
    H, W = a.shape[:2]
    if H % h == 0 and W % w == 0:
        fy, fx = H // h, W // w
        sh = (h, fy, w, fx) + a.shape[2:]
        return a.reshape(sh).mean(axis=(1, 3)).astype(np.float32)
    ys = (np.arange(h) + 0.5) * H / h - 0.5
    xs = (np.arange(w) + 0.5) * W / w - 0.5
    y0 = np.clip(np.floor(ys).astype(int), 0, H - 1)
    x0 = np.clip(np.floor(xs).astype(int), 0, W - 1)
    y1 = np.clip(y0 + 1, 0, H - 1)
    x1 = np.clip(x0 + 1, 0, W - 1)
    ty = np.clip(ys - y0, 0, 1)[:, None]
    tx = np.clip(xs - x0, 0, 1)[None, :]
    if a.ndim == 3:
        ty = ty[..., None]
        tx = tx[..., None]
    top = a[y0][:, x0] * (1 - tx) + a[y0][:, x1] * tx
    bot = a[y1][:, x0] * (1 - tx) + a[y1][:, x1] * tx
    return (top * (1 - ty) + bot * ty).astype(np.float32)


def bleed(rgb, alpha, thresh=0.02):
    """Push-pull fill: replace colours where alpha < thresh by the alpha-weighted average of nearby opaque pixels,
    so mipmaps and bilinear filtering of alpha-cut cards never pull in black / background fringes."""
    h, w = alpha.shape
    wgt = (alpha >= thresh).astype(np.float32)
    levels = []
    c = rgb * wgt[..., None]
    a = wgt
    while min(c.shape[0], c.shape[1]) > 1:
        levels.append((c, a))
        hh, ww = c.shape[0] // 2 * 2, c.shape[1] // 2 * 2
        c = c[:hh, :ww].reshape(hh // 2, 2, ww // 2, 2, -1).sum(axis=(1, 3))
        a = a[:hh, :ww].reshape(hh // 2, 2, ww // 2, 2).sum(axis=(1, 3))
    fill = c / np.maximum(a, 1e-6)[..., None]
    for c, a in reversed(levels):
        up = np.repeat(np.repeat(fill, 2, 0), 2, 1)
        up = np.pad(up, ((0, c.shape[0] - up.shape[0]), (0, c.shape[1] - up.shape[1]), (0, 0)), mode='edge')
        cur = c / np.maximum(a, 1e-6)[..., None]
        k = np.clip(a, 0, 1)[..., None]
        fill = cur * k + up * (1 - k)
    out = rgb.copy()
    m = alpha < thresh
    out[m] = fill[m]
    return out


def normal_from_height(hgt, strength, wrap=True):
    """Tangent-space normal map (OpenGL / glTF: +Y up = toward image top) from a height field (row 0 = top).
    strength = height units per pixel scale. Returns HxWx3 in 0..1."""
    if wrap:
        dx = (np.roll(hgt, -1, 1) - np.roll(hgt, 1, 1)) * 0.5
        dy = (np.roll(hgt, 1, 0) - np.roll(hgt, -1, 0)) * 0.5  # +y = up the image
    else:
        dx = np.gradient(hgt, axis=1)
        dy = -np.gradient(hgt, axis=0)
    nx = -dx * strength
    ny = -dy * strength
    nz = np.ones_like(hgt)
    l = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx / l, ny / l, nz / l], -1) * 0.5 + 0.5


def blend_normals(n1, n2, k):
    """Blend two encoded (0..1) normal maps with weight k (HxW) in vector space and renormalise."""
    a = n1 * 2 - 1
    b = n2 * 2 - 1
    v = a * (1 - k[..., None]) + b * k[..., None]
    v /= np.linalg.norm(v, axis=-1, keepdims=True) + 1e-9
    return v * 0.5 + 0.5


def detail_normals(base, detail):
    """Whiteout-style combine of encoded normals (base + detail)."""
    a = base * 2 - 1
    b = detail * 2 - 1
    v = np.stack([a[..., 0] + b[..., 0], a[..., 1] + b[..., 1], a[..., 2] * b[..., 2]], -1)
    v /= np.linalg.norm(v, axis=-1, keepdims=True) + 1e-9
    return v * 0.5 + 0.5
