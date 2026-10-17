"""Shared helpers for the palm asset scripts: PNG writing (no PIL), image loading through bpy, noise, dilation.

Arrays are float32, shape (H, W, C), row 0 = BOTTOM of the image (Blender UV v = 0), values 0..1.
write_png flips to PNG row order itself.
"""
import os
import struct
import zlib
import numpy as np

SCRATCH = "E:/tmp/island/helpers/palms"
RAW = "E:/tmp/island/raw/polyhaven"


def write_png(path, arr, bits=8):
    """arr: (H, W, C) float 0..1 (row 0 = bottom), C in 1..4"""
    a = np.asarray(arr, dtype=np.float32)
    if a.ndim == 2:
        a = a[:, :, None]
    h, w, c = a.shape
    ctype = {1: 0, 2: 4, 3: 2, 4: 6}[c]
    a = np.clip(a[::-1], 0.0, 1.0)
    if bits == 16:
        q = (a * 65535.0 + 0.5).astype('>u2')
    else:
        q = (a * 255.0 + 0.5).astype(np.uint8)
    raw = np.zeros((h, 1 + w * c * (bits // 8)), dtype=np.uint8)
    raw[:, 1:] = q.reshape(h, -1).view(np.uint8)
    data = zlib.compress(raw.tobytes(), 6)

    def chunk(tag, payload):
        return struct.pack('>I', len(payload)) + tag + payload + struct.pack('>I', zlib.crc32(tag + payload) & 0xffffffff)

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, bits, ctype, 0, 0, 0)))
        f.write(chunk(b'IDAT', data))
        f.write(chunk(b'IEND', b''))


def load_image(path, linear=False):
    """load with bpy -> float32 (H, W, 4), row 0 = bottom. linear=True keeps data values (normal / rough / disp)."""
    import bpy
    img = bpy.data.images.load(path, check_existing=False)
    if linear:
        img.colorspace_settings.name = 'Non-Color'
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(h, w, 4)


def srgb_to_lin(c):
    c = np.asarray(c, dtype=np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(np.asarray(c, dtype=np.float32), 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def resize(a, h, w):
    """area-average / bilinear resize of (H, W, C) to (h, w, C)"""
    H, W = a.shape[:2]
    if H % h == 0 and W % w == 0:
        fy, fx = H // h, W // w
        return a.reshape(h, fy, w, fx, -1).mean(axis=(1, 3))
    ys = (np.arange(h) + 0.5) * H / h - 0.5
    xs = (np.arange(w) + 0.5) * W / w - 0.5
    y0 = np.clip(np.floor(ys).astype(int), 0, H - 1)
    x0 = np.clip(np.floor(xs).astype(int), 0, W - 1)
    y1 = np.clip(y0 + 1, 0, H - 1)
    x1 = np.clip(x0 + 1, 0, W - 1)
    fy = (ys - np.floor(ys))[:, None, None]
    fx = (xs - np.floor(xs))[None, :, None]
    top = a[y0][:, x0] * (1 - fx) + a[y0][:, x1] * fx
    bot = a[y1][:, x0] * (1 - fx) + a[y1][:, x1] * fx
    return top * (1 - fy) + bot * fy


def value_noise(h, w, cells_y, cells_x, rng, wrap=True):
    """smooth tileable value noise, (h, w)"""
    g = rng.random((cells_y + 1, cells_x + 1)).astype(np.float32)
    if wrap:
        g[-1, :] = g[0, :]
        g[:, -1] = g[:, 0]
    ys = np.linspace(0, cells_y, h, endpoint=False) + 0.5 * cells_y / h
    xs = np.linspace(0, cells_x, w, endpoint=False) + 0.5 * cells_x / w
    y0 = np.floor(ys).astype(int)
    x0 = np.floor(xs).astype(int)
    ty = ys - y0
    tx = xs - x0
    ty = ty * ty * (3 - 2 * ty)
    tx = tx * tx * (3 - 2 * tx)
    a = g[y0][:, x0]
    b = g[y0][:, x0 + 1]
    c = g[y0 + 1][:, x0]
    d = g[y0 + 1][:, x0 + 1]
    return (a * (1 - tx) + b * tx) * (1 - ty[:, None]) + (c * (1 - tx) + d * tx) * ty[:, None]


def fbm(h, w, base_y, base_x, rng, octaves=4, gain=0.5, wrap=True):
    out = np.zeros((h, w), np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        out += amp * value_noise(h, w, base_y * 2 ** o, base_x * 2 ** o, rng, wrap)
        tot += amp
        amp *= gain
    return out / tot


def dilate_rgb(rgb, alpha, threshold=0.5, levels=12):
    """push-pull: fill RGB where alpha < threshold with the average of nearby opaque colour (avoids mip fringes)"""
    w = (alpha >= threshold).astype(np.float32)
    pyr = [(rgb * w[..., None], w)]
    c, m = pyr[0]
    for _ in range(levels):
        H, W = m.shape
        if H < 2 or W < 2:
            break
        h2, w2 = H // 2, W // 2
        c = c[:h2 * 2, :w2 * 2].reshape(h2, 2, w2, 2, -1).sum(axis=(1, 3))
        m = m[:h2 * 2, :w2 * 2].reshape(h2, 2, w2, 2).sum(axis=(1, 3))
        pyr.append((c, m))
    # pull: from coarsest upward, fill holes
    fc = pyr[-1][0] / np.maximum(pyr[-1][1], 1e-6)[..., None]
    for c, m in reversed(pyr[:-1]):
        H, W = m.shape
        up = np.repeat(np.repeat(fc, 2, axis=0), 2, axis=1)
        up = np.pad(up, ((0, H - up.shape[0]), (0, W - up.shape[1]), (0, 0)), mode='edge')[:H, :W]
        known = m > 1e-6
        fc = np.where(known[..., None], c / np.maximum(m, 1e-6)[..., None], up)
    return np.where((alpha >= threshold)[..., None], rgb, fc)


def height_to_normal(hgt, strength, wrap_x=True, wrap_y=True):
    """height (H, W) in metres-ish units scaled by strength -> OpenGL tangent-space normal (H, W, 3) 0..1.
    row 0 = bottom, so +y (rows) = +V = up in texture space."""
    if wrap_x:
        dx = (np.roll(hgt, -1, axis=1) - np.roll(hgt, 1, axis=1)) * 0.5
    else:
        dx = np.gradient(hgt, axis=1)
    if wrap_y:
        dy = (np.roll(hgt, -1, axis=0) - np.roll(hgt, 1, axis=0)) * 0.5
    else:
        dy = np.gradient(hgt, axis=0)
    n = np.stack([-dx * strength, -dy * strength, np.ones_like(hgt)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def blend_normals(base, detail):
    """reoriented normal mapping blend of two 0..1 encoded normal maps"""
    t = base * np.array([2, 2, 2], np.float32) + np.array([-1, -1, 0], np.float32)
    u = detail * np.array([-2, -2, 2], np.float32) + np.array([1, 1, -1], np.float32)
    r = t * np.sum(t * u, axis=-1, keepdims=True) / np.maximum(t[..., 2:3], 1e-4) - u
    r /= np.linalg.norm(r, axis=-1, keepdims=True)
    return r * 0.5 + 0.5
