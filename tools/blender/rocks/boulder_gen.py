"""Sculpt one boulder piece procedurally (rounded granite, angular basalt block or a small-rock cluster).

  blender --background --factory-startup -t 6 --python boulder_gen.py -- <boulders.json> <name>

kinds:
  granite : a weathered corestone. The body is the smooth intersection (log-sum-exp, edge radius ~round_k) of
            jointed half-spaces whose faces are slices of large spheres ('pillow'), so faces bulge gently and edges
            are round; the form reshapes the top (box, wedge: tilted top, ridge: pitched whaleback, dome: chamfered
            shoulders). Then soft lumps, an optional wave notch at the sand line, joint cracks, exfoliation sheet
            steps (one side of a wavy line lost its outer sheet), fall-line runnels starting at the shoulders and
            fine relief from scan displacement maps.
  block   : a jointed basalt block: flat-faced half-spaces with corner chips and shallow fracture facets, a very
            small edge radius, fracture steps and scan-displacement relief.
  cluster : several small stones (rounded or angular), placed without overlap, each sculpted at its own resolution,
            joined (not fused) into one mesh.
Every piece is lowered so that a 'bury' fraction of its height lies below z = 0 (the ground line) and centred on its
footprint (origin = base centre). Blender Z up (glTF Y up after export).
The hi mesh carries two point attributes for the bake: 'band' (0..1 colour-tint field) and 'stain' (0..1 dark water
stains: runnel beds, streaks running down from the shoulders, the damp band above the ground line).
Output: work/<name>.blend (<name>_hi, <name>_lod0 decimated, chart-unwrapped, all-zero 'skirt') and work/<name>.json.
"""
import os
import sys
import json
import math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402
import rocklib as R  # noqa: E402
import proc as PR  # noqa: E402

cfg_path, name = R.args_after_dashes()[:2]
cfg = json.load(open(cfg_path))
P = next(p for p in cfg['pieces'] if p['name'] == name)
WORK = R.WORK + '/work'
TEXDIR = 'E:/tmp/island/raw/polyhaven/textures'
rng = np.random.default_rng(P.get('seed', 1))
_img_cache = {}


def sm(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b + (a - b) * h - k * h * (1 - h)


def unit(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


def rand_rot(rng, max_deg=180.0):
    ax = unit(rng.normal(size=3))
    return np.array(Matrix.Rotation(math.radians(rng.uniform(-max_deg, max_deg)), 3, Vector(ax)))


def rot_about(axis, ang):
    return np.array(Matrix.Rotation(ang, 3, Vector(unit(axis))))


def tex_disp(tex_id, co, n, tile, amp, seed, sharp=6.0):
    if tex_id not in _img_cache:
        img = PR.load_gray(f'{TEXDIR}/{tex_id}/{tex_id}_disp_4k.exr')
        _img_cache[tex_id] = (img, float(img.mean()), float(img.std()))
    img, m, s = _img_cache[tex_id]
    h = PR.triplanar(img, co, n, tile, sharp=sharp, seed=seed)
    return np.clip((h - m) / (3 * s), -1.2, 1.2) * amp


def ellipsoid(c, r, segs=48, rings=24):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * r[0] + c[0], v.co.y * r[1] + c[1], v.co.z * r[2] + c[2]))
    me = bpy.data.meshes.new('ell')
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new('ell', me)
    bpy.context.scene.collection.objects.link(o)
    return o


def body_planes(P, S, rng):
    """Faces (n, d, R) of the body n . p <= d: three jittered joint-plane pairs, the top reshaped by P['form'], corner
    chips and shallow fracture facets. R = pillow radius (the face is the sphere of radius R through n * d) or inf."""
    A = np.array(Matrix.Rotation(rng.uniform(0, 2 * math.pi), 3, 'Z')) @ rand_rot(rng, P.get('axis_tilt', 10.0))
    S = np.asarray(S, float)
    jit = P.get('jitter', 12.0)

    def support(nn):
        return float(np.sum(np.abs(nn @ A) * S / 2))

    pl = []
    for ax in range(3):
        for sgn in (1, -1):
            nn = unit(sgn * (A[:, ax] @ rand_rot(rng, jit).T))
            pl.append([nn, S[ax] / 2 * rng.uniform(0.88, 1.1)])
    top = pl.pop(4)
    form = P.get('form', 'box')
    if form == 'wedge':
        # top tilted about the block's y axis: one end high, the other low
        ang = math.radians(P.get('wedge_deg', 25.0)) * rng.choice([-1.0, 1.0])
        nn = unit(rot_about(A[:, 1], ang) @ top[0])
        p_hi = A @ np.array([-np.sign(ang) * S[0] * 0.42, 0.0, S[2] / 2])
        pl.append([nn, float(nn @ p_hi)])
    elif form == 'ridge':
        # pitched top along the long axis: a whaleback once rounded
        ang = math.radians(P.get('ridge_deg', 24.0))
        p_r = A @ np.array([0.0, rng.uniform(-0.3, 0.3) * S[1] / 2, S[2] / 2])
        for sgn in (1.0, -1.0):
            nn = unit(rot_about(A[:, 0], sgn * ang * rng.uniform(0.8, 1.2)) @ top[0])
            pl.append([nn, float(nn @ p_r)])
    elif form == 'dome':
        # chamfered upper edges all round
        pl.append(top)
        ch = P.get('dome_chamfer', 0.22)
        for ax in (0, 1):
            for sgn in (1.0, -1.0):
                nn = unit(top[0] + sgn * A[:, ax] * rng.uniform(0.8, 1.3))
                pl.append([nn, support(nn) * (1 - ch * rng.uniform(0.75, 1.25))])
    else:
        pl.append(top)
    for _ in range(P.get('chips', 3)):
        nn = unit(rng.normal(size=3))
        pl.append([nn, support(nn) * (1 - rng.uniform(*P.get('chip_depth', [0.1, 0.25])))])
    for _ in range(P.get('facets', 0)):
        # fracture bevels: planes across an edge of the block (between two face normals), cut a little way in
        i, j = rng.choice(3, 2, replace=False)
        nn = unit(A[:, i] * rng.choice([-1.0, 1.0]) * rng.uniform(0.6, 1.4) +
                  A[:, j] * rng.choice([-1.0, 1.0]) * rng.uniform(0.6, 1.4) + 0.35 * rng.normal(size=3))
        pl.append([nn, support(nn) * (1 - rng.uniform(*P.get('facet_depth', [0.05, 0.14])))])
    sz = float(S.max())
    pil = P.get('pillow')
    out = []
    for nn, d in pl:
        Rr = pil * sz * rng.uniform(0.7, 1.4) if pil else np.inf
        out.append((nn, d, max(Rr, 1.2 * d) if pil else Rr))
    return out, A


def round_max(a, b, r):
    """Intersection of two distance fields with a circular fillet of radius r (hg_sdf fOpIntersectionRound)."""
    ua = np.maximum(r + a, 0)
    ub = np.maximum(r + b, 0)
    return np.minimum(-r, np.maximum(a, b)) + np.sqrt(ua * ua + ub * ub)


def soft_body(faces, k, subdiv=6, oname='body', fillet=None):
    """Mesh of the rounded convex body: s_i = signed distance to face i (plane or pillow sphere), combined either by
    the log-sum-exp smooth max with softness k (long soft blends) or, with fillet = r, by successive round
    intersections (flat faces, circular edge fillets of radius r). Rays from the origin, bisection per icosphere
    direction."""
    Nn = np.array([f[0] for f in faces])
    Dd = np.array([f[1] for f in faces])
    Rr = np.array([f[2] for f in faces])
    fin = np.isfinite(Rr)
    C = Nn[fin] * (Dd[fin] - Rr[fin])[:, None]
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=1.0)
    U = np.array([v.co[:] for v in bm.verts])
    U /= np.linalg.norm(U, axis=1, keepdims=True)

    def f(Pt):
        s = Pt @ Nn.T - Dd
        if fin.any():
            s[:, fin] = np.linalg.norm(Pt[:, None, :] - C[None], axis=2) - Rr[fin]
        if fillet:
            d = s[:, 0]
            for i in range(1, s.shape[1]):
                d = round_max(d, s[:, i], fillet)
            return d
        x = s / k
        m = x.max(1, keepdims=True)
        return k * (m[:, 0] + np.log(np.exp(x - m).sum(1)))

    lo = np.zeros(len(U))
    hi = np.full(len(U), 4.0 * float(Dd.max()) + 4 * k)
    for _ in range(40):
        mid = (lo + hi) / 2
        inside = f(U * mid[:, None]) < 0
        lo = np.where(inside, mid, lo)
        hi = np.where(inside, hi, mid)
    co = U * ((lo + hi) / 2)[:, None]
    for v, c in zip(bm.verts, co):
        v.co = Vector(c)
    me = bpy.data.meshes.new(oname)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(oname, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def fit_size(o, A, S):
    """Rescale along the block's own axes so the rounded body keeps the requested size."""
    co = PR.get_co(o).astype(np.float64) @ A
    co = (co - (co.min(0) + co.max(0)) / 2) * (np.asarray(S, float) / np.ptp(co, 0))
    PR.set_co(o, co @ A.T)


def recalc(o):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(o.data)
    bm.free()


def place(o, bury, tilt_deg=0.0, rng=None):
    """Optional random tilt, then centre the footprint on x = y = 0 and sink 'bury' of the height below z = 0."""
    co = PR.get_co(o).astype(np.float64)
    if tilt_deg:
        co = co @ rand_rot(rng, tilt_deg).T
    lo, hi = co.min(0), co.max(0)
    z0 = lo[2] + bury * (hi[2] - lo[2])
    near = co[co[:, 2] < z0 + 0.05 * (hi[2] - lo[2])]
    cx = (near[:, 0].min() + near[:, 0].max()) / 2
    cy = (near[:, 1].min() + near[:, 1].max()) / 2
    co -= np.array([cx, cy, z0])
    PR.set_co(o, co)


# ------------------------------------------------------------------ surface features
def shoulder_drop(co, n, nz_thr=0.75, nb=240):
    """Per vertex: height below the 'shoulder' of its azimuth sector (the highest point where the surface is already
    steeper than nz_thr), i.e. how far down the fall line from where water starts running down the side."""
    cen = co[co[:, 2] > 0].mean(0)
    th = np.arctan2(co[:, 1] - cen[1], co[:, 0] - cen[0])
    b = np.floor((th + math.pi) / (2 * math.pi) * nb).astype(np.int64) % nb
    zsh = np.full(nb, -1e9)
    st = n[:, 2] < nz_thr
    np.maximum.at(zsh, b[st], co[st, 2])
    zsh[zsh < -1e8] = co[:, 2].max()
    zsh = np.convolve(np.concatenate([zsh[-4:], zsh, zsh[:4]]), np.ones(9) / 9, 'valid')
    return zsh[b] - co[:, 2], zsh[b], th, cen


def runnels(co, n, ru, sz, drop, zsh, th, seed, axis_az=0.0):
    """Fall-line runnels (granite rillenkarren): straight grooves evenly spaced in azimuth (slight meander), sharp
    ridges between neighbours, each with its own depth and length; they deepen over a short ramp below the shoulder,
    keep their depth for about half their length and fade out downhill. Optional azimuth sectors (degrees relative
    to the block's x axis) limit them to the flanks that shed the most water. Returns (displacement, wetness)."""
    rr = np.random.default_rng(seed)
    cen = co[co[:, 2] > 0].mean(0)
    rh = np.hypot(co[:, 0] - cen[0], co[:, 1] - cen[1])
    Rm = float(np.median(rh[co[:, 2] > 0]))
    N = max(8, int(round(2 * math.pi * Rm / ru['spacing'])))
    q = np.stack([np.cos(th) * 1.6, np.sin(th) * 1.6, co[:, 2] / ru.get('wobble_l', 1.4)], 1)
    u = th / (2 * math.pi) * N + ru.get('wobble', 0.08) * PR.perlin(q, seed)
    ui = np.floor(u)
    gi = ui.astype(np.int64) % N
    fu = u - ui - 0.5
    g_depth = rr.uniform(0.55, 1.05, N) * (rr.uniform(size=N) > ru.get('gaps', 0.1))
    g_len = rr.uniform(*ru.get('len', [0.5, 1.0]), N)
    g_wid = rr.uniform(*ru.get('width', [0.42, 0.5]), N)
    sect = np.ones(len(co))
    if 'sectors' in ru:
        sect = np.zeros(len(co))
        for a_deg, half_deg in ru['sectors']:
            a = axis_az + math.radians(a_deg)
            sect = np.maximum(sect, sm((np.cos(th - a) - math.cos(math.radians(half_deg))) / 0.25))
    L = np.maximum(g_len[gi] * np.maximum(zsh, 0.3) * ru.get('reach', 0.9), 1e-3)
    along = sm(drop / (ru.get('ramp', 0.1) * sz)) * (1 - sm((drop - 0.45 * L) / (0.55 * L)))
    flat = sm((ru.get('nz_top', 0.85) - n[:, 2]) / 0.25)
    w = along * flat * sect
    halfw = g_wid[gi] * (0.8 + 0.2 * w)
    prof = np.clip(1 - (fu / halfw) ** 2, 0, 1) ** 1.1
    g = prof * w * g_depth[gi]
    return -ru['depth'] * g, np.clip(g * 1.3, 0, 1)


def sheet_steps(co, n, P, sz, seed):
    """Exfoliation / fracture steps on the steep sides: on one side of a wavy plane, within an azimuth sector, the
    outer sheet (thickness t) has spalled off; by default the lower side, leaving an overhanging lip. Returns the
    displacement."""
    rr = np.random.default_rng(seed)
    side_w = sm((P.get('step_nz', 0.8) - n[:, 2]) / 0.3)
    up = co[:, 2] > 0
    cen = co[up].mean(0)
    hd = co[:, :2] - cen[:2]
    hd /= np.maximum(np.linalg.norm(hd, axis=1, keepdims=True), 1e-9)
    d = np.zeros(len(co))
    for k in range(P.get('steps', 0)):
        m = rr.normal(size=3)
        m[2] = abs(m[2]) * P.get('step_up', 1.0) + 0.25
        m = unit(m)
        s = (co - cen) @ m
        e = np.quantile(s[up], rr.uniform(*P.get('step_at', [0.4, 0.75])))
        s = s - e + P.get('step_wave', 0.03) * sz * PR.fbm(co / (0.22 * sz), 2, seed=seed + 31 * k)
        a = rr.uniform(0, 2 * math.pi)
        half = math.radians(P.get('step_sector', 80.0) * rr.uniform(0.8, 1.2))
        sect = sm((hd @ np.array([math.cos(a), math.sin(a)]) - math.cos(half)) / 0.35)
        side = -1.0 if P.get('step_lip', True) else 1.0
        t = P.get('step_t', 0.03) * sz * rr.uniform(0.7, 1.2)
        d -= t * sm(side * s / (P.get('step_soft', 0.012) * sz)) * sect * side_w
    return d


def streak_stain(co, n, drop, H, seed, scale=(0.28, 2.2)):
    """Dark water-stain streaks running down the steep sides from the shoulder line (0..1)."""
    q = np.stack([co[:, 0] / scale[0], co[:, 1] / scale[0], co[:, 2] / scale[1]], 1)
    sn = PR.fbm(q, 3, seed=seed)
    streak = sm((sn - 0.05) / 0.3)
    steep = sm((0.85 - n[:, 2]) / 0.3)
    run = sm(drop / 0.08) * (1 - sm((drop - 0.55 * H) / (0.5 * H)))
    return streak * steep * run


def scan_body(P, S, oname):
    """Large-scale shape from a photoscan: imported, rotated (scan.rot degrees XYZ, then a yaw), scaled uniformly so
    its longest horizontal extent is size[0], voxel-remeshed and smoothed until only the forms (faces, rounded edges,
    bulges) remain; the scan's own grain would read far too coarse at boulder scale."""
    sc = P['scan']
    o = R.import_gltf(R.scan_gltf_path(sc['id']))
    o.name = o.data.name = oname
    o.data.materials.clear()
    bm = bmesh.new()
    bm.from_mesh(o.data)
    R.log('scan', sc['id'], 'verts', len(bm.verts), 'boundary edges', sum(1 for e in bm.edges if e.is_boundary))
    bm.free()
    co = PR.get_co(o).astype(np.float64)
    rx, ry, rz = (math.radians(a) for a in sc.get('rot', [0, 0, 0]))
    M = np.array(Matrix.Rotation(rz, 3, 'Z')) @ np.array(Matrix.Rotation(ry, 3, 'Y')) @ np.array(Matrix.Rotation(rx, 3, 'X'))
    co = co @ M.T
    ext = np.ptp(co, 0)
    co = (co - (co.min(0) + co.max(0)) / 2) * (S[0] / max(ext[0], ext[1]))
    PR.set_co(o, co)
    sz = float(np.ptp(co, 0).max())
    PR.voxel_remesh(o, sz / sc.get('vox_div', 80))
    PR.apply_mod(o, 'SMOOTH', factor=1.0, iterations=sc.get('smooth', 12))
    return o


# ------------------------------------------------------------------ sculpting per kind
def sculpt_granite(P):
    S = np.array(P['size'], float)
    sz = float(S.max())
    if 'scan' in P:
        o = scan_body(P, S, name + '_hi')
        A = np.eye(3)
    else:
        faces, A = body_planes(P, S, rng)
        fil = P['round_r'] * float(S.min()) if 'round_r' in P else None
        o = soft_body(faces, P.get('round_k', 0.1) * sz, oname=name + '_hi', fillet=fil)
        fit_size(o, A, S)
        PR.voxel_remesh(o, sz / 70)
    co = PR.get_co(o).astype(np.float64)
    n = PR.macro_normals(o, 10).astype(np.float64)
    co += n * (P.get('lumps', 0.025) * sz * PR.fbm(co / (0.6 * sz), 3, seed=P.get('seed', 1)))[:, None]
    # exfoliation flats: push everything beyond a plane back onto it, with a rounded transition
    cen = co.mean(0)
    for k in range(P.get('flats', 0)):
        nn = rng.normal(size=3)
        nn[2] = abs(nn[2]) * P.get('flat_up', 1.0)
        nn = unit(nn)
        s = (co - cen) @ nn
        off = s.max() * (1 - rng.uniform(*P.get('flat_depth', [0.06, 0.16])))
        new_s = smin(s - off, 0.0, 0.06 * sz) + off
        co -= nn[None, :] * (s - new_s)[:, None]
    PR.set_co(o, co)
    PR.apply_mod(o, 'SMOOTH', factor=0.5, iterations=2)
    place(o, P.get('bury', 0.3))
    PR.voxel_remesh(o, max(P.get('hi_min', 0.012), sz / P.get('hi_div', 230)))
    co = PR.get_co(o).astype(np.float64)
    n = PR.macro_normals(o, 20).astype(np.float64)
    H = float(co[:, 2].max())
    sd = P.get('seed', 1)
    d = np.zeros(len(co))
    steep = np.clip((1 - np.abs(n[:, 2])) / 0.8, 0, 1)
    uc_f = np.zeros(len(co))
    uc = P.get('undercut')
    if uc:
        # salt / wave notch just above the sand line: an overhanging lip, patchy around the boulder
        uc_f = np.exp(-0.5 * ((co[:, 2] - uc['z'] * H) / (uc['h'] * H)) ** 2)
        uc_f *= 0.3 + 0.7 * sm(0.5 + 1.2 * PR.fbm(co / (0.35 * sz), 2, seed=sd + 5))
        uc_f *= steep
        d -= uc['depth'] * sz * uc_f
    for k in range(P.get('cracks', 0)):
        # joint crack: a narrow groove where a random near-vertical plane meets the surface
        nn = rng.normal(size=3)
        nn[2] *= 0.35
        nn = unit(nn)
        dist = (co - co.mean(0) - rng.uniform(-0.2, 0.2, 3) * sz) @ nn
        dist += 0.02 * sz * PR.fbm(co / (0.15 * sz), 2, seed=sd + 20 + k)
        w = P.get('crack_w', 0.01) * sz
        d -= P.get('crack_d', 0.025) * sz * np.exp(-0.5 * (dist / w) ** 2) * sm((co[:, 2] + 0.1 * H) / (0.3 * H))
    d += sheet_steps(co, n, P, sz, sd + 40)
    drop, zsh, th, _ = shoulder_drop(co, n, P.get('shoulder_nz', 0.75))
    wet = np.zeros(len(co))
    if P.get('runnels'):
        dr, wet = runnels(co, n, P['runnels'], sz, drop, zsh, th, P['runnels'].get('seed', sd + 7),
                          axis_az=math.atan2(A[1, 0], A[0, 0]))
        d += dr
    streak = streak_stain(co, n, drop, H, sd + 13)
    # the stain streaks are where water runs: a shallow wash groove under each
    d -= P.get('streak_relief', 0.0) * sz * streak
    f = P.get('fine', {})
    d += tex_disp(f.get('tex', 'rock_01'), co, n, f.get('tile', 1.4), f.get('amp', 0.012), f.get('seed', 3))
    if 'fine2' in P:
        f2 = P['fine2']
        d += tex_disp(f2['tex'], co, n, f2['tile'], f2['amp'], f2.get('seed', 4))
    PR.set_co(o, co + n * d[:, None])
    band = np.clip(0.5 + 0.9 * PR.fbm(co / P.get('band_scale', 1.6), 3, seed=sd + 11), 0, 1)
    stn = np.maximum(wet, P.get('streak_amt', 0.75) * streak)
    stn = np.maximum(stn, 0.45 * np.exp(-0.5 * ((co[:, 2] - 0.06 * H) / (0.08 * H)) ** 2) * steep)
    stn = np.maximum(stn, 0.6 * uc_f)
    return o, band, np.clip(stn, 0, 1)


def sculpt_block(P, S=None, seed_shift=0, hi=None, oname=None):
    S = np.array(S if S is not None else P['size'], float)
    sz = float(S.max())
    faces, A = body_planes(P, S, rng)
    o = soft_body(faces, P.get('round_k', 0.015) * sz, oname=oname or name + '_hi')
    fit_size(o, A, S)
    if oname is None:
        place(o, P.get('bury', 0.25), P.get('tilt', 0.0), rng)
    PR.voxel_remesh(o, hi or max(P.get('hi_min', 0.008), sz / P.get('hi_div', 230)))
    co = PR.get_co(o).astype(np.float64)
    n = PR.macro_normals(o, 6).astype(np.float64)
    d = np.zeros(len(co))
    sd = P.get('seed', 1) * 7 + seed_shift
    for key in ('big', 'fine', 'fine2'):
        if key in P:
            t = P[key]
            d += tex_disp(t['tex'], co, n, t['tile'] * (sz if t.get('rel') else 1.0),
                          t['amp'] * (sz if t.get('rel') else 1.0), sd + len(key))
    if 'lumps' in P:
        d += P['lumps'] * sz * PR.fbm(co / (0.4 * sz), 3, seed=sd + 5)
    if oname is None:
        d += sheet_steps(co, n, P, sz, sd + 40)
    PR.set_co(o, co + n * d[:, None])
    band = np.clip(0.5 + 0.9 * PR.fbm(co / P.get('band_scale', 1.2), 3, seed=sd + 11), 0, 1)
    if oname is None:
        H = float(co[:, 2].max())
        drop, _, _, _ = shoulder_drop(co, n, 0.6)
        stn = P.get('streak_amt', 0.5) * streak_stain(co, n, drop, H, sd + 13, scale=(0.18, 1.2))
    else:
        stn = np.zeros(len(co))
    return o, band, np.clip(stn, 0, 1)


def sculpt_cluster(P):
    n_st = P['count']
    lo, hi = P['sizes']
    spread = P['spread']
    placed = []
    tries = 0
    while len(placed) < n_st and tries < 4000:
        tries += 1
        s = lo * (hi / lo) ** rng.uniform() ** P.get('size_bias', 1.6)
        r = spread * math.sqrt(rng.uniform()) * (1.0 - 0.45 * (s - lo) / (hi - lo + 1e-9))
        a = rng.uniform(0, 2 * math.pi)
        c = np.array([r * math.cos(a), r * math.sin(a)])
        if all(np.linalg.norm(c - q) > 0.5 * (s + t) * P.get('gap', 0.95) for q, t in placed):
            placed.append((c, s))
    objs, bands = [], []
    for i, (c, s) in enumerate(placed):
        if P['stone'] == 'round':
            S = s * np.array([1.0, rng.uniform(0.65, 0.9), rng.uniform(0.45, 0.7)])
            o = ellipsoid((0, 0, 0), S / 2, segs=24, rings=12)
            PR.voxel_remesh(o, s / 40)
            co = PR.get_co(o).astype(np.float64)
            n = PR.macro_normals(o, 4).astype(np.float64)
            co += n * (0.06 * s * PR.fbm(co / (0.5 * s), 3, seed=100 + i))[:, None]
            PR.set_co(o, co)
            PR.voxel_remesh(o, s / P.get('hi_div', 120))
            co = PR.get_co(o).astype(np.float64)
            n = PR.macro_normals(o, 6).astype(np.float64)
            f = P.get('fine', {})
            co += n * tex_disp(f.get('tex', 'rock_01'), co, n, f.get('tile', 0.5), f.get('amp', 0.004), 200 + i)[:, None]
            PR.set_co(o, co)
            band = np.full(len(co), rng.uniform(0.2, 0.8))
        else:
            S = s * np.array([1.0, rng.uniform(0.6, 0.9), rng.uniform(0.4, 0.75)])
            o, band, _ = sculpt_block(P, S=S, seed_shift=i * 13, hi=s / P.get('hi_div', 120), oname=f'st{i}')
        co = PR.get_co(o).astype(np.float64)
        co = (co - co.mean(0)) @ rand_rot(rng, 180).T
        # rest flat-ish: keep the stone's thinnest axis roughly vertical
        ev = np.linalg.eigh(np.cov(co.T))[1]
        co = co @ ev[:, ::-1]
        co = co @ rand_rot(rng, P.get('tilt', 15.0)).T
        co[:, 2] -= co[:, 2].min() + P.get('bury', 0.3) * np.ptp(co[:, 2]) * rng.uniform(0.7, 1.3)
        co[:, :2] += c
        PR.set_co(o, co)
        objs.append(o)
        bands.append(band)
    o = PR.join(objs, name + '_hi')
    co = PR.get_co(o)
    lo2 = co[co[:, 2] < 0.02]
    if len(lo2):
        off = np.array([(lo2[:, 0].min() + lo2[:, 0].max()) / 2, (lo2[:, 1].min() + lo2[:, 1].max()) / 2, 0])
        PR.set_co(o, co - off.astype(np.float32))
    band = np.concatenate(bands)
    return o, band, np.zeros(len(band))


# ------------------------------------------------------------------ build
R.reset_scene()
kind = P['kind']
if kind == 'granite':
    body, band, stain = sculpt_granite(P)
elif kind == 'block':
    body, band, stain = sculpt_block(P)
else:
    body, band, stain = sculpt_cluster(P)
recalc(body)
me = body.data
for an, vals in (('band', band), ('stain', stain)):
    if an not in me.attributes:
        me.attributes.new(an, 'FLOAT', 'POINT')
    me.attributes[an].data.foreach_set('value', np.asarray(vals, np.float32))
me.polygons.foreach_set('use_smooth', np.ones(len(me.polygons), bool))
hi_tris = R.tri_count(body)
R.log(name, kind, 'hi tris', hi_tris, 'stain mean', round(float(np.mean(stain)), 3))

lo = body.copy()
lo.data = body.data.copy()
bpy.context.scene.collection.objects.link(lo)
lo.name = lo.data.name = name + '_lod0'
for an in ('band', 'stain'):
    lo.data.attributes.remove(lo.data.attributes[an])
PR.decimate_to(lo, int(P['lod0_tris']))
bm = bmesh.new()
bm.from_mesh(lo.data)
bmesh.ops.triangulate(bm, faces=bm.faces[:])
bm.to_mesh(lo.data)
bm.free()
PR.chart_unwrap(lo, smooth_it=int(P.get('uv_smooth', 20)), angle=P.get('uv_angle', 66))
PR.add_zero_skirt(lo)
lo_tris = R.tri_count(lo)
co_lo = PR.get_co(lo)
mn, mx = co_lo.min(0), co_lo.max(0)
meta = dict(name=name, kind=kind, use=P.get('use', ''), hi_tris=hi_tris, lod0_tris=lo_tris, bbox_min=mn.tolist(),
            bbox_max=mx.tolist(), height_above=float(mx[2]), depth_below=float(-mn[2]))
json.dump(meta, open(f'{WORK}/{name}.json', 'w'), indent=1)
bpy.ops.wm.save_as_mainfile(filepath=f'{WORK}/{name}.blend', compress=False)
R.log(name, 'saved, lod0 tris', lo_tris, 'bbox', mn.round(2), mx.round(2))
