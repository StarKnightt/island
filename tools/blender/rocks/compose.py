"""Compose the baked pieces of a kit into the final shared texture set, re-graded to ONE palette.

  python compose.py <pieces.json> [res]          (plain Python + numpy, or inside Blender: --python compose.py -- ...)

Per piece (only its own texels): de-light (divide out part of the scan AO, compress the large-scale luminance
variation so exposure / sun differences between scans disappear but bands and stains stay), then a robust colour
transfer in (log luminance, warmth, greenness) to the shared targets: dark grey basalt ~ sRGB (72, 72, 70), lighter
weathered planes ~ (100, 96, 88), the warmest scan stains pushed to rust (105, 78, 56), the greenest to a grey-green
lichen. Roughness / AO come from the scan's ARM map. Gutters are push-pull filled (mip-safe).
Writes work/tex/<kit>_albedo.png (res, sRGB), <kit>_normal.png (res/2, OpenGL), <kit>_orm.png (res/2: R AO,
G roughness, B 0) and small debug views.
"""
import os
import sys
import json
import time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402
import imgio as I  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
cfg = json.load(open(argv[0]))
RES = int(argv[1]) if len(argv) > 1 else 4096
KIT = cfg['kit']
WORK = 'E:/tmp/island/helpers/rocks/work'
OUT = WORK + '/tex'
os.makedirs(OUT, exist_ok=True)
G = cfg.get('grade', {})
T_LOGY = np.log(G.get('y_mean', 0.068))      # linear luminance of the basalt base
T_STD = G.get('y_std', 0.28)                 # log-luminance spread
LARGE_KEEP = G.get('large_keep', 0.55)       # fraction of large-scale (>~1 m) luminance variation kept
W_MEAN, W_STD = G.get('w_mean', 0.12), G.get('w_std', 0.08)
G_MEAN, G_STD = G.get('g_mean', 0.03), G.get('g_std', 0.025)
LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)
t0 = time.time()

n = RES * RES
diff = np.zeros((n, 3), np.float32)
nrm = np.zeros((n, 3), np.float32)
arm = np.zeros((n, 3), np.float32)
hit = np.zeros(n, bool)
cov = np.zeros(n, bool)
skirt = np.zeros(n, bool)
pid = np.full(n, -1, np.int16)
stats = {}


def robust(x):
    med = np.median(x)
    mad = np.median(np.abs(x - med)) * 1.4826
    return float(med), float(max(mad, 1e-4))


for k, P in enumerate(cfg['pieces']):
    d = np.load(f'{WORK}/bake/{P["name"]}.npz')
    assert int(d['res']) == RES, 'bake resolution mismatch'
    idx = d['idx']
    D = d['diff'].astype(np.float32)
    A = d['arm'].astype(np.float32)
    M = d['mask'].astype(np.float32)
    h = D[:, 3] > 0.5
    sk = M[:, 0] > 0.5
    cov[idx] = True
    pid[idx] = k
    skirt[idx] = sk
    hit[idx] = h
    nrm[idx] = d['nrm'][:, :3].astype(np.float32)
    # ---- de-light
    ao = np.clip(A[:, 0], 0.05, 1)
    rgb = np.clip(D[:, :3], 1e-4, None) / np.clip(ao, 0.35, 1)[:, None] ** 0.5
    Y = rgb @ LUMA
    logY = np.log(np.maximum(Y, 1e-4))
    wv = (rgb[:, 0] - rgb[:, 2]) / Y
    gv = (rgb[:, 1] - (rgb[:, 0] + rgb[:, 2]) / 2) / Y
    good = h & ~sk

    def big_field(vals, sigma_px, f=4):
        """Large-scale part of a per-texel value: masked blur in UV space at 1/f resolution, this piece only."""
        full = np.zeros(n, np.float32)
        wgt = np.zeros(n, np.float32)
        full[idx[good]] = vals[good]
        wgt[idx[good]] = 1
        lo, lw = I.downsample_w(full.reshape(RES, RES), wgt.reshape(RES, RES), f)
        bl, _ = I.masked_blur(lo, (lw > 0).astype(np.float32) * lw, sigma_px / f)
        return I.upsample_linear(bl, f).reshape(-1)[idx]

    big = big_field(logY, G.get('large_sigma_px', 90))
    det = logY - big
    m_big, s_big = robust(big[good])
    big2 = m_big + (big - m_big) * LARGE_KEEP
    ly = big2 + det
    # ---- colour transfer to the shared palette
    my, sy = robust(ly[good])
    zy = (ly - my) / sy
    ly2 = T_LOGY + zy * T_STD
    mw, sw = robust(wv[good])
    mg, sg = robust(gv[good])
    zw = (wv - mw) / sw
    zg = (gv - mg) / sg
    # warmth split: small streaky stains may go rust; broad warm areas (sandy / soil-covered tops) stay weathered tan
    zb = (big_field(wv, G.get('warm_sigma_px', 60)) - mw) / sw
    zd = zw - zb
    w2 = W_MEAN + (0.55 * np.clip(zb, -2.5, 1.5) + zd) * W_STD + 0.10 * np.clip(zy, 0, 2.2)
    rust = np.clip(zd - 1.3, 0, 2.5) + 0.35 * np.clip(zb - 1.5, 0, 2.0)
    w2 += G.get('rust_push', 0.26) * rust
    g2 = G_MEAN + zg * G_STD + 0.05 * np.clip(zg - 1.4, 0, 3)          # greenest -> grey-green lichen
    g2 -= 0.06 * rust                                                # rust is not green
    w2 = np.clip(w2, -0.05, G.get('w_max', 0.95))
    g2 = np.clip(g2, -0.18, 0.24)
    Y2 = np.exp(ly2)
    mm = 1 - 0.0702 * w2 - 0.7152 * g2
    out = Y2[:, None] * np.stack([mm + w2 / 2, mm + g2, mm - w2 / 2], 1)
    diff[idx] = np.clip(out, 0.004, 0.6)
    # ---- AO / roughness
    rough = np.clip(0.86 + 0.8 * (A[:, 1] - np.median(A[good, 1])), 0.6, 0.97)
    arm[idx] = np.stack([np.clip(ao, 0.15, 1), rough, np.zeros_like(rough)], 1)
    srgb_mean = I.lin_to_srgb(diff[idx[good]].mean(0)) * 255
    stats[P['name']] = dict(texels=int(len(idx)), hit=float(h.mean()), skirt=float(sk.mean()),
                            scan_logY=[round(my, 3), round(sy, 3)], scan_w=[round(mw, 3), round(sw, 3)],
                            scan_g=[round(mg, 3), round(sg, 3)], out_mean_srgb=[round(float(v)) for v in srgb_mean],
                            rust_frac=float((rust > 0.5).mean()), lichen_frac=float((zg > 2.0).mean()),
                            p99_srgb=[round(float(v)) for v in np.percentile(I.lin_to_srgb(diff[idx[good]]) * 255, 99, 0)])
    print(P['name'], stats[P['name']], round(time.time() - t0, 1), flush=True)

# ---- fill + write (Blender buffers are bottom-up: flip for PNG)
valid = hit.reshape(RES, RES)
alb = I.push_pull(diff.reshape(RES, RES, 3), valid)
alb_s = I.lin_to_srgb(alb)
ARES = int(cfg.get('albedo_res', RES // 2))      # the optimizer cannot encode 4096 KTX2: ship 2048, bake at 4096
if ARES < RES:
    small = I.downsample(alb, RES // ARES)
    small = small + 0.35 * (small - I.gauss_blur(small, 0.8))    # light unsharp mask after the box filter
    alb_ship = I.lin_to_srgb(np.clip(small, 0.003, 0.7))
    I.write_png(f'{OUT}/{KIT}_albedo_full.png', I.to_u8(alb_s[::-1]))
else:
    alb_ship = alb_s
I.write_png(f'{OUT}/{KIT}_albedo.png', I.to_u8(alb_ship[::-1]))
print('albedo written', ARES, round(time.time() - t0, 1), flush=True)

nm = nrm.reshape(RES, RES, 3).copy()
nvalid = (hit & ~skirt).reshape(RES, RES)
flat = np.array([0.5, 0.5, 1.0], np.float32)
nm[skirt.reshape(RES, RES)] = flat
nvalid2 = nvalid | skirt.reshape(RES, RES)
nm = I.push_pull(nm, nvalid2)
v = nm * 2 - 1
v[..., 2] = np.maximum(v[..., 2], 0.05)
v /= np.linalg.norm(v, axis=2, keepdims=True)
v2 = I.downsample(v, 2)
v2 /= np.linalg.norm(v2, axis=2, keepdims=True)
I.write_png(f'{OUT}/{KIT}_normal.png', I.to_u8((v2 * 0.5 + 0.5)[::-1]))
print('normal written', round(time.time() - t0, 1), flush=True)

orm = I.push_pull(arm.reshape(RES, RES, 3), valid)
orm2 = I.downsample(orm, 2)
I.write_png(f'{OUT}/{KIT}_orm.png', I.to_u8(orm2[::-1]))
# debug views (1024)
I.write_png(f'{OUT}/{KIT}_albedo_dbg.png', I.to_u8(I.downsample(alb_s, 4)[::-1]))
raw = np.zeros((n, 3), np.float32)
for k, P in enumerate(cfg['pieces']):
    d = np.load(f'{WORK}/bake/{P["name"]}.npz')
    raw[d['idx']] = d['diff'][:, :3].astype(np.float32)
I.write_png(f'{OUT}/{KIT}_rawdiff_dbg.png', I.to_u8(I.lin_to_srgb(I.downsample(raw.reshape(RES, RES, 3), 4))[::-1]))
json.dump(stats, open(f'{OUT}/{KIT}_grade_stats.json', 'w'), indent=1)
print('done', round(time.time() - t0, 1), flush=True)
