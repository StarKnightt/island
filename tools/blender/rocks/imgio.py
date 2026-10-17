"""numpy-only image helpers (no bpy, no PIL): PNG writer, sRGB transfer, masked blur, push-pull fill, resampling.
Works inside Blender's Python and a plain Python with numpy."""
import struct
import zlib
import numpy as np


def write_png(path, arr, level=6):
    """arr: HxWx{1,3,4} uint8 (row 0 = top of the image)."""
    a = np.ascontiguousarray(arr)
    if a.ndim == 2:
        a = a[..., None]
    h, w, c = a.shape
    ct = {1: 0, 3: 2, 4: 6}[c]
    raw = np.empty((h, 1 + w * c), np.uint8)
    raw[:, 0] = 0
    raw[:, 1:] = a.reshape(h, w * c)

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, ct, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw.tobytes(), level)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def read_png(path):
    """8 / 16-bit grey, grey+alpha, RGB or RGBA, non-interlaced PNG -> HxWxC uint8 or uint16 (row 0 = top)."""
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', path
    pos, idat = 8, []
    while pos < len(data):
        n, t = struct.unpack('>I4s', data[pos:pos + 8])
        d = data[pos + 8:pos + 8 + n]
        if t == b'IHDR':
            w, h, depth, ct, _, _, il = struct.unpack('>IIBBBBB', d)
        elif t == b'IDAT':
            idat.append(d)
        pos += 12 + n
    assert il == 0 and depth in (8, 16) and ct in (0, 2, 4, 6), (path, depth, ct, il)
    c = {0: 1, 2: 3, 4: 2, 6: 4}[ct]
    bpp = c * depth // 8
    raw = np.frombuffer(zlib.decompress(b''.join(idat)), np.uint8).reshape(h, 1 + w * bpp)
    out = np.zeros((h, w * bpp), np.int32)
    prev = np.zeros(w * bpp, np.int32)
    for y in range(h):
        f, line = raw[y, 0], raw[y, 1:].astype(np.int32)
        if f == 0:
            cur = line
        elif f == 2:
            cur = (line + prev) & 255
        else:
            cur = line.copy()
            for x in range(w * bpp):
                a = cur[x - bpp] if x >= bpp else 0
                b = prev[x]
                if f == 1:
                    cur[x] = (cur[x] + a) & 255
                elif f == 3:
                    cur[x] = (cur[x] + ((a + b) >> 1)) & 255
                else:
                    cc = prev[x - bpp] if x >= bpp else 0
                    p = a + b - cc
                    pa, pb, pc = abs(p - a), abs(p - b), abs(p - cc)
                    cur[x] = (cur[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else cc)) & 255
        out[y] = cur
        prev = cur
    if depth == 16:
        o = out.astype(np.uint16).reshape(h, w * c, 2)
        return (o[..., 0] * 256 + o[..., 1]).reshape(h, w, c)
    return out.astype(np.uint8).reshape(h, w, c)


def to_u8(a):
    return (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)


def srgb_to_lin(c):
    c = np.asarray(c, np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4).astype(np.float32)


def lin_to_srgb(c):
    c = np.clip(np.asarray(c, np.float32), 0, None)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055).astype(np.float32)


def box_blur(a, r, axis):
    """Box filter of radius r (window 2r+1) along axis, edges clamped."""
    if r <= 0:
        return a
    a = np.moveaxis(a, axis, 0)
    n = a.shape[0]
    pad = np.concatenate([np.repeat(a[:1], r + 1, 0), a, np.repeat(a[-1:], r, 0)], 0)
    cs = np.cumsum(pad, 0, dtype=np.float64)
    out = (cs[2 * r + 1:2 * r + 1 + n] - cs[:n]) / (2 * r + 1)
    return np.moveaxis(out.astype(np.float32), 0, axis)


def gauss_blur(a, sigma):
    """~Gaussian via 3 box passes per axis."""
    r = max(1, int(round(np.sqrt(12 * sigma * sigma / 3 + 1) / 2 - 0.5)))
    for _ in range(3):
        a = box_blur(a, r, 0)
        a = box_blur(a, r, 1)
    return a


def masked_blur(val, w, sigma):
    """Normalized convolution: blur(val*w)/blur(w). val HxW or HxWxC, w HxW (0..1)."""
    if val.ndim == 3:
        num = gauss_blur(val * w[..., None], sigma)
        den = gauss_blur(w, sigma)[..., None]
    else:
        num = gauss_blur(val * w, sigma)
        den = gauss_blur(w, sigma)
    return num / np.maximum(den, 1e-6), den


def downsample(a, f):
    h, w = a.shape[:2]
    return a.reshape(h // f, f, w // f, f, *a.shape[2:]).mean((1, 3))


def downsample_w(a, wgt, f):
    """Weighted block average (a HxW[xC], wgt HxW)."""
    h, w = wgt.shape
    ws = wgt.reshape(h // f, f, w // f, f).sum((1, 3))
    if a.ndim == 3:
        s = (a * wgt[..., None]).reshape(h // f, f, w // f, f, a.shape[2]).sum((1, 3))
        return s / np.maximum(ws, 1e-8)[..., None], ws / (f * f)
    s = (a * wgt).reshape(h // f, f, w // f, f).sum((1, 3))
    return s / np.maximum(ws, 1e-8), ws / (f * f)


def upsample_linear(a, f):
    """Bilinear upsampling by integer factor f (pixel-centre aligned)."""
    def up1(x, axis):
        x = np.moveaxis(x, axis, 0)
        n = x.shape[0]
        pos = (np.arange(n * f) + 0.5) / f - 0.5
        i0 = np.clip(np.floor(pos).astype(int), 0, n - 1)
        i1 = np.clip(i0 + 1, 0, n - 1)
        t = np.clip(pos - np.floor(pos), 0, 1).astype(np.float32)
        t = t.reshape(-1, *([1] * (x.ndim - 1)))
        return np.moveaxis(x[i0] * (1 - t) + x[i1] * t, 0, axis)
    return up1(up1(a, 0), 1)


def push_pull(img, valid):
    """Fill invalid texels from a coarse-to-fine pyramid of the valid ones (mip-friendly gutter fill)."""
    c = (img * valid[..., None]).astype(np.float32)
    w = valid.astype(np.float32)
    levels = [(c, w)]
    while c.shape[0] > 1 and c.shape[1] > 1:
        c = c.reshape(c.shape[0] // 2, 2, c.shape[1] // 2, 2, -1).sum((1, 3))
        w = w.reshape(w.shape[0] // 2, 2, w.shape[1] // 2, 2).sum((1, 3))
        levels.append((c, w))
    filled = levels[-1][0] / np.maximum(levels[-1][1], 1e-8)[..., None]
    for c, w in reversed(levels[:-1]):
        up = np.repeat(np.repeat(filled, 2, 0), 2, 1)
        cur = c / np.maximum(w, 1e-8)[..., None]
        filled = np.where((w > 0)[..., None], cur, up)
    return np.where(valid[..., None], img, filled).astype(np.float32)


def dilate(mask, n):
    m = mask.copy()
    for _ in range(n):
        g = m.copy()
        g[1:] |= m[:-1]
        g[:-1] |= m[1:]
        g[:, 1:] |= m[:, :-1]
        g[:, :-1] |= m[:, 1:]
        m = g
    return m
