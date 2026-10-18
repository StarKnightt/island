"""Quick look at a shelf height field without Blender: a top-down hillshade and an oblique view from the sea (PNG).

  python shelf_field_view.py <shelves.json> <name> <out_prefix>

Water (blue) is drawn at the piece's waterline, fallen blocks are not drawn.
"""
import os
import sys
import json
import math
import struct
import zlib
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shelf_field as SF  # noqa: E402


def write_png(path, rgb):
    h, w, _ = rgb.shape
    raw = b''.join(b'\x00' + rgb[y].tobytes() for y in range(h))

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) +
                           chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))


def shade(Z, g, sun):
    gy, gx = np.gradient(Z, g)
    n = np.stack([-gx, -gy, np.ones_like(Z)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    L = np.asarray(sun, float)
    L /= np.linalg.norm(L)
    return np.clip(n @ L, 0, 1), n


cfg_path, name, out = sys.argv[1:4]
cfg = json.load(open(cfg_path))
P = next(p for p in cfg['pieces'] if p['name'] == name)
F = SF.build(P, log=lambda *a: print('[field]', name, *a))
wl = P.get('waterline', 0.4)
Zw = np.maximum(F.Z, wl)
water = F.Z < wl
rock = np.array([0.42, 0.41, 0.39])
wcol = np.array([0.16, 0.30, 0.36])

# top-down hillshade (+Y, landward, up)
lam, n = shade(Zw, F.g, (-0.45, -0.7, 0.55))
col = rock[None, None] * (0.25 + 0.85 * lam[..., None])
col = np.where(water[..., None], wcol[None, None] * (0.8 + 0.2 * lam[..., None]), col)
col = np.where((F.pools > 0.03)[..., None] & ~water[..., None], col * np.array([0.6, 0.75, 0.85]), col)
img = (np.clip(col[::-1], 0, 1) ** (1 / 1.6) * 255).astype(np.uint8)
img = np.repeat(np.repeat(img, 2, 0), 2, 1)
write_png(out + '_top.png', img)

# oblique view from the sea (painter's algorithm over the grid rows, far to near)
for tag, el, sun in (('obl', 22.0, (-0.5, -0.6, 0.45)), ('low', 8.0, (0.6, 0.5, 0.35))):
    e = math.radians(el)
    scale = 1500.0 / (F.xs[-1] - F.xs[0])
    sy = Zw * math.cos(e) + F.Y * math.sin(e)
    H = int((sy.max() - sy.min()) * scale) + 40
    W = int((F.xs[-1] - F.xs[0]) * scale) + 1
    lam, _ = shade(Zw, F.g, sun)
    c = rock[None, None] * (0.22 + 0.9 * lam[..., None])
    c = np.where(water[..., None], wcol[None, None] * (0.85 + 0.15 * lam[..., None]), c)
    canvas = np.zeros((H, W, 3))
    canvas[:] = (0.62, 0.70, 0.78)
    px = ((F.xs - F.xs[0]) * scale).astype(int)
    cols = np.arange(W)
    xi = np.clip(np.searchsorted(px, cols), 0, F.nx - 1)
    rows = np.arange(H)[:, None]
    for r in range(F.ny - 1, -1, -1):
        top = (H - 20 - (sy[r, xi] - sy.min()) * scale).astype(int)
        m = rows >= top[None, :]
        canvas = np.where(m[..., None], c[r, xi][None, :, :], canvas)
    img = (np.clip(canvas, 0, 1) ** (1 / 1.6) * 255).astype(np.uint8)
    write_png(out + f'_{tag}.png', img)
print('[field] wrote', out + '_top.png / _obl.png / _low.png')
