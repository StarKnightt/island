"""
Foliage textures for the island (all generated here; the leaf scans used are Poly Haven CC0):

  palm_frond   2048x1024 RGBA: two coconut fronds (green, and an old yellow-brown one), top view, rachis along x
  banana_leaf  1024x512  RGBA: a torn banana leaf, midrib along x
  canopy       2048x2048 RGBA: 2x2 leaf-cluster cards composited from Poly Haven "Island Tree 02" leaf scans
  canopy_n     2048x2048 RGB : the matching tangent-space normals (leaf normals rotated with each leaf)
  palm_bark    512x1024  RGB : coconut trunk with ring scars, tileable vertically
  grass        512x512   RGBA: grass blade strip atlas

  python tools/gen_foliage.py <out_dir>
Writes PNGs (the asset build turns them into KTX2).
"""
import sys, os, math, random
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

out = sys.argv[1] if len(sys.argv) > 1 else "E:/tmp/island/foliage"
os.makedirs(out, exist_ok=True)
RAW = "E:/tmp/island/raw/polyhaven"
rng = random.Random(1234)
np.random.seed(1234)


def lerp(a, b, t):
    return a + (b - a) * t


def hsv_jitter(c, dh=0.0, ds=0.0, dv=0.0):
    import colorsys
    h, s, v = colorsys.rgb_to_hsv(*[x / 255 for x in c])
    h = (h + dh) % 1
    s = min(1, max(0, s + ds))
    v = min(1, max(0, v + dv))
    r, g, b = colorsys.hsv_to_rgb(h, s, v)
    return (int(r * 255), int(g * 255), int(b * 255))


# ------------------------------------------------------------------ palm frond
def palm_frond(W, H, seed, palette):
    """one frond in a W x H RGBA image (supersampled 2x): rachis along x, pinnae either side"""
    S = 2
    w, h = W * S, H * S
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = random.Random(seed)
    cy = h / 2
    base, mid, tip, rib, dry = palette
    # pinnae
    n = 92
    for side in (-1, 1):
        for i in range(n):
            t = 0.1 + 0.88 * (i / (n - 1)) ** 0.92
            x0 = t * w
            # length: longest a little past mid, short at base and tip
            L = (0.92 * h / 2) * (math.sin(math.pi * min(1, t * 1.04)) ** 0.55) * (0.88 + 0.2 * r.random())
            if t > 0.93:
                L *= 0.6
            ang = math.radians(lerp(58, 30, t) + r.uniform(-6, 6))
            wid = (0.024 + 0.008 * r.random()) * h * lerp(1.15, 0.6, t)
            # skip some pinnae (gaps, torn)
            if r.random() < 0.035:
                continue
            seg = 10
            pts_l, pts_r = [], []
            curve = r.uniform(-0.08, 0.12)
            for k in range(seg + 1):
                u = k / seg
                a = ang + curve * u
                px = x0 + math.cos(a) * L * u
                py = cy + side * math.sin(a) * L * u
                ww = wid * (math.sin(math.pi * min(1, u * 1.15 + 0.05)) ** 0.7) * (1 - 0.85 * u ** 3)
                nx, ny = -math.sin(a) * side, math.cos(a)
                pts_l.append((px + nx * ww * 0.5 * side, py + ny * ww * 0.5 * side))
                pts_r.append((px - nx * ww * 0.5 * side, py - ny * ww * 0.5 * side))
            poly = pts_l + pts_r[::-1]
            # colour: mid green, lighter toward the rachis, dry tips on some
            c = tuple(int(lerp(base[j], mid[j], t)) for j in range(3))
            c = hsv_jitter(c, r.uniform(-0.015, 0.015), r.uniform(-0.05, 0.05), r.uniform(-0.08, 0.06))
            d.polygon(poly, fill=c + (255,))
            # the midrib of the pinna
            for k in range(seg):
                u = k / seg
                a = ang + curve * u
                p1 = (x0 + math.cos(a) * L * u, cy + side * math.sin(a) * L * u)
                u2 = (k + 1) / seg
                a2 = ang + curve * u2
                p2 = (x0 + math.cos(a2) * L * u2, cy + side * math.sin(a2) * L * u2)
                d.line([p1, p2], fill=hsv_jitter(c, 0, -0.1, 0.12) + (255,), width=max(1, int(wid * 0.12)))
            # dry, frayed tip
            if r.random() < 0.14:
                u0 = r.uniform(0.82, 0.93)
                a = ang + curve
                tip_pts = []
                for k in range(int(u0 * seg), seg + 1):
                    u = k / seg
                    tip_pts.append((x0 + math.cos(a) * L * u, cy + side * math.sin(a) * L * u))
                if len(tip_pts) > 1:
                    d.line(tip_pts, fill=dry + (255,), width=max(1, int(wid * 0.55)))
    # rachis: thick at the base, olive-yellow
    for k in range(200):
        t0, t1 = k / 200, (k + 1) / 200
        wr = lerp(0.055, 0.008, t0 ** 0.8) * h
        d.line([(t0 * w, cy), (t1 * w, cy)], fill=tuple(int(lerp(rib[j], tip[j], t0)) for j in range(3)) + (255,), width=max(2, int(wr)))
    img = img.resize((W, H), Image.LANCZOS)
    return img


def make_palm_fronds():
    W, H = 2048, 512
    green = ((62, 92, 28), (88, 126, 36), (120, 140, 52), (150, 150, 70), (150, 125, 70))
    old = ((150, 128, 60), (170, 140, 70), (160, 130, 70), (175, 150, 90), (120, 90, 50))
    a = palm_frond(W, H, 11, green)
    b = palm_frond(W, H, 23, old)
    atlas = Image.new("RGBA", (W, H * 2))
    atlas.paste(a, (0, 0))
    atlas.paste(b, (0, H))
    atlas = dilate_rgb(atlas)
    atlas.save(f"{out}/palm_frond.png")
    print("palm_frond", atlas.size)


def dilate_rgb(img, steps=6):
    """bleed colour into transparent texels so mipmaps do not darken the leaf edges"""
    a = np.array(img).astype(np.float32)
    rgb, al = a[..., :3], a[..., 3:] / 255.0
    acc, wsum = rgb * al, al.copy()
    cur_rgb, cur_w = acc.copy(), wsum.copy()
    for _ in range(steps):
        k = np.zeros_like(cur_rgb)
        kw = np.zeros_like(cur_w)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            k += np.roll(np.roll(cur_rgb, dx, 1), dy, 0)
            kw += np.roll(np.roll(cur_w, dx, 1), dy, 0)
        cur_rgb = np.where(cur_w > 0, cur_rgb, k / np.maximum(kw, 1e-6) * np.minimum(kw, 1))
        cur_w = np.maximum(cur_w, np.minimum(kw, 1) * 0.999)
    fill = cur_rgb / np.maximum(cur_w, 1e-6)
    out_rgb = np.where(al > 0.5, rgb, fill)
    res = np.concatenate([np.clip(out_rgb, 0, 255), a[..., 3:]], -1).astype(np.uint8)
    return Image.fromarray(res, "RGBA")


# ------------------------------------------------------------------ banana leaf
def make_banana():
    W, H, S = 1024, 512, 2
    w, h = W * S, H * S
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = random.Random(77)
    cy = h / 2
    # outline: long oval, blunt tip
    top, bot = [], []
    for k in range(121):
        t = k / 120
        half = (0.44 * h) * (math.sin(math.pi * min(1, 0.06 + t * 0.98)) ** 0.45) * (1 - 0.15 * t)
        x = (0.03 + 0.95 * t) * w
        top.append((x, cy - half))
        bot.append((x, cy + half))
    base = (70, 112, 30)
    d.polygon(top + bot[::-1], fill=base + (255,))
    # parallel veins (lighter) and tears along them
    for side in (-1, 1):
        for k in range(110):
            t = 0.04 + 0.93 * k / 110
            x = t * w
            half = (0.44 * h) * (math.sin(math.pi * min(1, 0.06 + t * 0.98)) ** 0.45) * (1 - 0.15 * t)
            ang = math.radians(70)
            ex, ey = x + math.cos(ang) * half * 0.35, cy + side * half
            c = hsv_jitter(base, r.uniform(-0.01, 0.01), 0, r.uniform(-0.05, 0.12))
            d.line([(x, cy), (ex, ey)], fill=c + (255,), width=3)
            # tears: thin transparent wedges from the edge toward the midrib
            if r.random() < 0.09:
                depth = r.uniform(0.3, 0.92)
                mx, my = x + math.cos(ang) * half * 0.35 * (1 - depth), cy + side * half * (1 - depth)
                d.polygon([(ex - 4, ey), (ex + 8, ey), (mx, my)], fill=(0, 0, 0, 0))
    # midrib
    d.line([(0.02 * w, cy), (0.98 * w, cy)], fill=(150, 160, 80, 255), width=int(0.03 * h))
    # brown, dry margins
    img = img.resize((W, H), Image.LANCZOS)
    a = np.array(img).astype(np.float32)
    yy = np.abs(np.linspace(-1, 1, H))[:, None]
    edge = np.clip((yy - 0.6) * 3, 0, 1) * (np.random.rand(H, W) * 0.6 + 0.4)
    a[..., 0] = a[..., 0] * (1 - edge * 0.2) + 110 * edge * 0.25
    a[..., 1] = a[..., 1] * (1 - edge * 0.3) + 90 * edge * 0.2
    img = dilate_rgb(Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGBA"))
    img.save(f"{out}/banana_leaf.png")
    print("banana_leaf", img.size)


# ------------------------------------------------------------------ canopy leaf clusters from leaf scans
def leaf_sprites():
    """cut the eight leaves out of the Island Tree 02 leaf atlas (Poly Haven, CC0) with their normals"""
    diff = Image.open(f"{RAW}/alpha/island_tree_02__leaves_diff.png").convert("RGB")
    alpha = Image.open(f"{RAW}/alpha/island_tree_02__leaves_alpha.png").convert("L")
    nor = Image.open(f"{RAW}/alpha/island_tree_02__leaves_nor_gl.png").convert("RGB")
    W = diff.width
    al = np.array(alpha) > 128
    # connected components by bounding boxes of alpha blobs (coarse grid scan)
    from scipy import ndimage
    lab, n = ndimage.label(al)
    sprites = []
    for i, sl in enumerate(ndimage.find_objects(lab)):
        if sl is None:
            continue
        ys, xs = sl
        if (ys.stop - ys.start) < W * 0.05:
            continue
        box = (xs.start, ys.start, xs.stop, ys.stop)
        m = (lab[ys, xs] == i + 1).astype(np.uint8) * 255
        rgb = diff.crop(box)
        nn = nor.crop(box)
        a = Image.fromarray(m, "L").filter(ImageFilter.GaussianBlur(1.2))
        area = int((m > 0).sum())
        asp = max(rgb.width, rgb.height) / max(1, min(rgb.width, rgb.height))
        sprites.append((area, asp, (rgb, a, nn)))
    # the eight leaves: the largest blobs that are not thin stems
    sprites = [s for s in sprites if s[0] > 50000]
    sprites.sort(key=lambda s: -s[0])
    sprites = [s[2] for s in sprites[:8]]
    print("leaf sprites", len(sprites))
    return sprites


def rotate_normals(nimg, ang):
    """rotate a tangent-space normal map image by `ang` degrees: pixels and their XY vectors"""
    a = np.array(nimg).astype(np.float32) / 255.0 * 2 - 1
    t = math.radians(ang)
    c, s = math.cos(t), math.sin(t)
    x, y = a[..., 0], a[..., 1]
    # image y is down; OpenGL normal y is up
    xr = x * c - (-y) * s * -1
    yr = -(x * s + (-y) * c) * -1
    a[..., 0], a[..., 1] = xr * 1.0, yr
    return Image.fromarray(np.clip((a + 1) * 127.5, 0, 255).astype(np.uint8), "RGB")


def make_canopy():
    sprites = leaf_sprites()
    C = 1024  # one cluster card
    atlas = Image.new("RGBA", (C * 2, C * 2), (0, 0, 0, 0))
    natlas = Image.new("RGB", (C * 2, C * 2), (128, 128, 255))
    for cell in range(4):
        r = random.Random(500 + cell)
        card = Image.new("RGBA", (C, C), (0, 0, 0, 0))
        ncard = Image.new("RGB", (C, C), (128, 128, 255))
        # twig from the bottom centre up, leaves along and around it
        cx0, cy0 = C * 0.5, C * 0.98
        n = 46 + cell * 6
        placed = []
        for k in range(n):
            t = k / n
            # radial cluster: angle spread, distance from the attachment point
            ang = r.uniform(-150, -30)
            dist = r.uniform(0.18, 0.47) * C
            px = cx0 + math.cos(math.radians(ang)) * dist
            py = cy0 + math.sin(math.radians(ang)) * dist - C * 0.08
            rgb, a, nn = r.choice(sprites)
            scale = r.uniform(0.22, 0.34) * C / max(rgb.width, rgb.height)
            sz = (max(4, int(rgb.width * scale)), max(4, int(rgb.height * scale)))
            # leaves point outward from the twig
            rot = -(ang + 90) + r.uniform(-25, 25)
            rgb2 = rgb.resize(sz, Image.LANCZOS)
            a2 = a.resize(sz, Image.LANCZOS)
            nn2 = nn.resize(sz, Image.LANCZOS)
            # deeper tropical greens, inner leaves darker (self-shadowing)
            depth = dist / (0.47 * C)
            arr = np.array(rgb2).astype(np.float32)
            g = r.uniform(0.8, 1.05) * lerp(0.62, 1.0, depth)
            arr[..., 0] *= g * r.uniform(0.45, 0.62)
            arr[..., 1] *= g * r.uniform(0.95, 1.08)
            arr[..., 2] *= g * r.uniform(0.38, 0.55)
            rgb2 = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
            rgb2 = rgb2.rotate(rot, Image.BICUBIC, expand=True)
            a2 = a2.rotate(rot, Image.BICUBIC, expand=True)
            nn2 = rotate_normals(nn2, rot).rotate(rot, Image.BICUBIC, expand=True, fillcolor=(128, 128, 255))
            ox, oy = int(px - rgb2.width / 2), int(py - rgb2.height / 2)
            card.paste(rgb2, (ox, oy), a2)
            ncard.paste(nn2, (ox, oy), a2)
            placed.append((px, py))
        # twig strokes
        d = ImageDraw.Draw(card)
        for (px, py) in placed[::3]:
            d.line([(cx0, cy0), ((cx0 + px) / 2, (cy0 + py) / 2)], fill=(70, 55, 35, 255), width=5)
        ox, oy = (cell % 2) * C, (cell // 2) * C
        atlas.paste(card, (ox, oy))
        natlas.paste(ncard, (ox, oy))
    atlas = dilate_rgb(atlas)
    atlas.save(f"{out}/canopy.png")
    natlas.save(f"{out}/canopy_n.png")
    print("canopy", atlas.size)


# ------------------------------------------------------------------ palm bark
def make_palm_bark():
    W, H = 512, 1024
    y = np.arange(H)[:, None].astype(np.float32)
    x = np.arange(W)[None, :].astype(np.float32)
    noise = np.random.rand(H // 8, W // 8)
    big = np.array(Image.fromarray((noise * 255).astype(np.uint8)).resize((W, H), Image.BICUBIC)).astype(np.float32) / 255
    fine = np.random.rand(H, W).astype(np.float32)
    fine = np.array(Image.fromarray((fine * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))).astype(np.float32) / 255
    # ring scars every ~1/16 of the tile, slightly wavy
    period = H / 16
    wav = np.sin(x / W * math.pi * 2 * 3) * 3 + (big - 0.5) * 6
    ph = ((y + wav) % period) / period
    ring = np.exp(-((ph - 0.5) ** 2) / 0.004)
    # vertical fissures
    fiss = (np.sin(x / W * math.pi * 2 * 22 + big * 6) * 0.5 + 0.5) ** 6
    v = 0.52 + 0.18 * (big - 0.5) + 0.1 * (fine - 0.5) - 0.22 * ring - 0.12 * fiss
    col = np.stack([v * 0.62, v * 0.57, v * 0.5], -1)
    col = np.clip(col * 255, 0, 255).astype(np.uint8)
    Image.fromarray(col, "RGB").save(f"{out}/palm_bark.png")
    # height for the normal map
    hgt = np.clip((1 - ring * 0.8 - fiss * 0.4 + (fine - 0.5) * 0.2) * 255, 0, 255).astype(np.uint8)
    Image.fromarray(hgt, "L").save(f"{out}/palm_bark_h.png")
    print("palm_bark", col.shape)


# ------------------------------------------------------------------ grass blade atlas
def make_grass():
    W, H, S = 512, 512, 2
    img = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = random.Random(9)
    for k in range(70):
        x0 = r.uniform(0.04, 0.96) * W * S
        hgt = r.uniform(0.45, 0.98) * H * S
        bend = r.uniform(-0.25, 0.25) * W * S * 0.3
        wid = r.uniform(5, 11)
        c = hsv_jitter((78, 118, 34), r.uniform(-0.03, 0.03), r.uniform(-0.1, 0.1), r.uniform(-0.15, 0.1))
        pts = []
        for i in range(13):
            t = i / 12
            pts.append((x0 + bend * t * t, H * S - hgt * t))
        for i in range(12):
            t = i / 12
            ww = wid * (1 - t) ** 0.8
            cc = tuple(int(lerp(c[j] * 0.55, c[j] * 1.1, t)) for j in range(3))
            d.line([pts[i], pts[i + 1]], fill=cc + (255,), width=max(1, int(ww)))
    img = dilate_rgb(img.resize((W, H), Image.LANCZOS))
    img.save(f"{out}/grass.png")
    print("grass", img.size)


make_palm_fronds()
make_banana()
make_canopy()
make_palm_bark()
make_grass()
print("done")
