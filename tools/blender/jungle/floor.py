"""Forest floor set -> E:/tmp/island/helpers/jungle/glb/floor_raw.glb (Blender, headless, under the lock):

    bash c:/Code/island/tools/heavy.sh jungle E:/blender/blender-5.1.2-windows-x64/blender.exe --background \
        --factory-startup -t 6 --python tools/blender/jungle/floor.py -- [--skip-atlas] [--skip-bake]

* floor_litter atlas (2048^2, rendered): three leaf-litter patches (dead tropical leaves, twigs, a fallen palm frond)
  and seedling leaves. Litter cards: flat 4x4 grids lying at y = +0.015 m.
* floor_log: Poly Haven dead_tree_trunk_02 decimated twice (two orientations, different moss) and baked from the scan
  (albedo with moss on the up-facing side, normal, ORM) into one 2048^2 atlas.
* floor_bark (the canopy bark maps): procedural surface roots.
* seedlings (0.2-0.5 m).
COLOR_0: plants (seedlings, litter) use (AO, bend, flutter, phase); logs and roots use RGB = AO, A = 1.
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
import understory_atlas as UA  # noqa: E402

TEX = 'E:/tmp/island/helpers/jungle/tex'
OUT = 'E:/tmp/island/helpers/jungle/glb'
WORK = 'E:/tmp/island/helpers/jungle/work/floor'
RAWM = 'E:/tmp/island/raw/jungle/models'
N = 2048

LITTER = [  # name, rect px, seed, radius m, leaves, palm frond, darkness
    ('litter_a', (0, 0, 1024, 1024), 71, 1.3, 650, False, 0.0),
    ('litter_b', (1024, 0, 1024, 1024), 72, 1.5, 420, True, 0.1),
    ('litter_c', (0, 1024, 1024, 1024), 73, 0.9, 520, False, 0.35),
]
DEAD = {'dead': 0.86, 'yellowing': 0.1, 'old': 0.04}


def litter_patch(mb, rng, sheets, R, nleaves, frond, dark):
    ang = rng.uniform(0, 6.28)
    lobes = [(rng.uniform(0.08, 0.2), rng.integers(2, 6), rng.uniform(0, 6.28)) for _ in range(3)]

    def rad(th):
        return R * (1 + sum(a * math.cos(k * th + p) for a, k, p in lobes))

    def feathered(rmax=1.15):
        """Polar sample: dense core, density fading from 0.45 to 1.12 of the lobed radius, sparse outliers beyond,
        so the card edge dissolves into scattered single leaves instead of ending in a rim."""
        while True:
            th = rng.uniform(0, 2 * math.pi)
            f = math.sqrt(rng.uniform(0, 1)) * rmax
            t = min(max((f - 0.45) / 0.67, 0.0), 1.0)
            if rng.uniform() < max(1.0 - t * t * (3 - 2 * t), 0.035):
                return th, rad(th) * f
    names = list(sheets.keys())
    wts = np.array([0.34, 0.24, 0.14, 0.2, 0.08])[:len(names)]
    moods = dict(DEAD)
    if dark:
        moods = {'dead': 0.92, 'old': 0.05, 'yellowing': 0.03}
    z = 0.0
    if frond:  # fallen dead palm frond lying across the patch
        sh = sheets['palmlet']
        d = np.array([math.cos(ang), math.sin(ang), 0.0])
        start = -d * R * 1.05
        path = SA.bend_path(start, d, R * 2.0, rng.uniform(-0.25, 0.25), n=10)
        path[:, 2] = 0.01
        SA.add_twig(mb, path, 0.018, 0.006)
        s = J.arclen(path)
        pos = 0.15
        while pos < s[-1] * 0.98:
            i = int(np.clip(np.searchsorted(s, pos) - 1, 0, len(path) - 2))
            P = path[i]
            tg = J.norm(path[i + 1] - path[i])
            for side in (-1, 1):
                fwd = J.norm(J.rot((0, 0, 1), side * math.radians(rng.uniform(35, 70))) @ tg + np.array([0, 0, 0.02]))
                up = J.rot(fwd, rng.normal(0, 0.5)) @ np.array([0, 0, 1.0])
                SA.add_leaf(mb, sh, sh.pick(rng, {'dead': 0.8, 'yellowing': 0.2}), P + np.array([0, 0, 0.012]), fwd, up,
                            rng.uniform(0.7, 1.1), fold=0.3, arch=rng.uniform(-0.05, 0.1), twist=rng.normal(0, 0.6),
                            curl=rng.uniform(0.2, 0.8), na=6, nc=2)
            pos += s[-1] * rng.uniform(0.025, 0.04)
    for k in range(nleaves):
        name = names[rng.choice(len(names), p=wts / wts.sum())]
        sh = sheets[name]
        th, r = feathered()
        P = np.array([math.cos(th) * r, math.sin(th) * r, 0.002 + z])
        z += 0.00012
        fwd = J.norm(np.array([math.cos(rng.uniform(0, 6.28)), math.sin(rng.uniform(0, 6.28)), rng.uniform(-0.05, 0.08)]))
        up = J.rot(fwd, rng.normal(0, 0.35)) @ np.array([0, 0, 1.0])
        sc = rng.uniform(0.8, 2.0) if name in ('ell', 'obo') else rng.uniform(0.7, 1.4)
        if name == 'palmlet':
            sc = rng.uniform(0.5, 0.9)
        cell = sh.pick(rng, moods)
        SA.add_leaf(mb, sh, cell, P - fwd * sh.length * sc * 0.5, fwd, up, sc, fold=rng.uniform(0.1, 0.5),
                    arch=rng.uniform(-0.12, 0.12), twist=rng.normal(0, 0.5), curl=rng.uniform(0.0, 0.9), na=6, nc=2)
    for k in range(int(nleaves * 0.04)):  # twigs
        th, r = feathered(1.0)
        c = np.array([math.cos(th) * r, math.sin(th) * r, 0.01 + z * rng.uniform()])
        d = np.array([math.cos(rng.uniform(0, 6.28)), math.sin(rng.uniform(0, 6.28)), 0.0])
        L = rng.uniform(0.15, 0.6)
        path = SA.bend_path(c - d * L / 2, d, L, rng.uniform(-0.6, 0.6), n=4)
        SA.add_twig(mb, path, rng.uniform(0.004, 0.012), 0.002, sides=4)


def build_atlas(sheets):
    os.makedirs(WORK, exist_ok=True)
    A = np.zeros((N, N, 3), np.float32)
    AL = np.zeros((N, N), np.float32)
    NM = np.tile(np.array([0.5, 0.5, 1.0], np.float32), (N, N, 1))
    X = np.ones((N, N, 3), np.float32)
    meta = {'tiles': {}}
    sc, cam = SA.setup_scene()
    for name, (x, y, w, h), seed, R, n, frond, dark in LITTER:
        rng = np.random.default_rng(seed)
        mb = J.MB()
        litter_patch(mb, rng, sheets, R, n, frond, dark)
        # leaves come from several sheets: render each sheet's leaves with its own material slot set
        passes, (Sw, Sh), piv = render_multi(sc, cam, name, mb, w, h)
        alb, alpha, nrm, aux = SA.finish_tile(passes)
        if dark:
            alb = alb * (1 - 0.3 * dark)
        meta['tiles'][name] = dict(kind='litter', size_wh=[Sw, Sh], pivot=list(piv), content=SA.content_box(alpha),
                                   coverage=float((alpha > 0.5).mean()), rect=[x / N, 1 - (y + h) / N, (x + w) / N, 1 - y / N])
        A[y:y + h, x:x + w] = alb
        AL[y:y + h, x:x + w] = alpha
        NM[y:y + h, x:x + w] = nrm
        X[y:y + h, x:x + w] = aux
        print(f'litter {name}: {len(mb.F)} faces, {Sw:.2f} m, coverage {(alpha > 0.5).mean():.2f}')
    # seedling leaves: 2x2 single leaves (young / mid)
    for k, (sheet, var) in enumerate([('bigobo', 'young'), ('ell', 'young'), ('cor', 'mid'), ('bigobo', 'mid')]):
        x0, y0 = 1024 + (k % 2) * 512, 1024 + (k // 2) * 512
        # cells2x2 places the single leaf in the top-left quarter: take the whole 512 tile with 1 leaf scaled up
        sh = SA.Sheet(sheet)
        alb_s = T.read_image(sh.paths['albedo'])
        nrm_s = T.read_image(sh.paths['normal'])[..., :3]
        rgh_s = T.read_image(sh.paths['rough'])[..., 0]
        ci = [i for i, c in enumerate(sh.cells) if c['variant'] == var][0]
        xs = ci * sh.Wp
        scl = min(480 / sh.Wp, 480 / sh.Hp)
        w2, h2 = int(sh.Wp * scl) // 2 * 2, int(sh.Hp * scl) // 2 * 2
        ox, oy = (512 - w2) // 2, (512 - h2) // 2
        a2 = np.zeros((512, 512, 4), np.float32)
        n2 = np.tile(np.array([0.5, 0.5, 1.0], np.float32), (512, 512, 1))
        r2 = np.ones((512, 512), np.float32) * 0.5
        a2[oy:oy + h2, ox:ox + w2] = T.resize(alb_s[:, xs:xs + sh.Wp], h2, w2)
        n2[oy:oy + h2, ox:ox + w2] = T.resize(nrm_s[:, xs:xs + sh.Wp], h2, w2)
        r2[oy:oy + h2, ox:ox + w2] = T.resize(rgh_s[:, xs:xs + sh.Wp], h2, w2)
        lin = T.bleed(T.srgb_to_lin(a2[..., :3]), a2[..., 3], 0.5)
        A[y0:y0 + 512, x0:x0 + 512] = lin
        AL[y0:y0 + 512, x0:x0 + 512] = a2[..., 3]
        NM[y0:y0 + 512, x0:x0 + 512] = T.bleed(n2, a2[..., 3], 0.5)
        X[y0:y0 + 512, x0:x0 + 512] = np.stack([np.ones_like(r2), r2, np.zeros_like(r2)], -1)
        meta['tiles'][f'seedleaf_{k}'] = dict(kind='leaf', sheet=sheet, length=sh.length, width=sh.width,
                                              rect=[(x0 + ox) / N, 1 - (y0 + oy + h2) / N, (x0 + ox + w2) / N, 1 - (y0 + oy) / N])
    ao = 0.45 + 0.55 * np.clip(X[..., 0], 0, 1)
    orm = np.stack([ao, np.clip(X[..., 1], 0.15, 1), np.zeros_like(ao)], -1)
    T.write_png(f'{TEX}/floor_litter_albedo.png', np.concatenate([T.lin_to_srgb(A), AL[..., None]], -1))
    T.write_png(f'{TEX}/floor_litter_normal.png', NM)
    T.write_png(f'{TEX}/floor_litter_orm.png', orm)
    with open(f'{TEX}/floor_litter.json', 'w') as f:
        json.dump(meta, f, indent=1)
    print('floor_litter written')


def render_multi(sc, cam, name, mb, w, h):
    """Like UA.render_rect but the MB's leaf faces may reference several sheets: we split them by UV range is not
    possible, so all litter leaves share one combined sheet image built on the fly."""
    return UA.render_rect(sc, cam, name, mb, COMBINED, 'center', w, h)


# combined litter sheet: the five sheets' images stacked so one material can render every leaf
COMBINED = None


def make_combined():
    """Stack the leaf sheets vertically into one image set and patch Sheet.uv to address it."""
    global COMBINED
    names = ['ell', 'obo', 'cor', 'bigobo', 'palmlet']
    sheets = [SA.Sheet(n) for n in names]
    imgs = {k: [] for k in ('albedo', 'back', 'normal', 'rough')}
    W = max(s.Wp * s.K for s in sheets)
    for s in sheets:
        for k in imgs:
            im = T.read_image(s.paths[k])
            pad = np.zeros((im.shape[0], W - im.shape[1], 4), np.float32)
            imgs[k].append(np.concatenate([im, pad], 1))
    Htot = sum(i.shape[0] for i in imgs['albedo'])
    os.makedirs(WORK, exist_ok=True)
    paths = {}
    for k, lst in imgs.items():
        big = np.concatenate(lst, 0)
        p = f'{WORK}/combined_{k}.png'
        if k == 'albedo':
            T.write_png(p, big)
        else:
            T.write_png(p, big[..., :3])
        paths[k] = p
    # per-sheet offsets (rows from the top)
    y = 0
    for s in sheets:
        s.combo = (y, Htot, W)
        y += s.Hp

        def uv(cell, ss, t, s=s):
            pad = 3
            Wc, Hc = s.Wp, s.Hp
            xx = (Wc - 1) / 2 + ss * ((Wc - 1) / 2 - pad)
            yy = pad + (1 - t) * (Hc - 1 - 2 * pad)
            u = (cell * Wc + xx + 0.5) / s.combo[2]
            v = 1.0 - (s.combo[0] + yy + 0.5) / s.combo[1]
            return u, v
        s.uv = uv
    combo = SA.Sheet('ell')
    combo.paths = paths
    COMBINED = combo
    return {n: s for n, s in zip(names, sheets)}


# ------------------------------------------------------------------------------------------------ logs
def bake_logs():
    """Two mossy logs from the dead_tree_trunk_02 scan, baked into one 2048^2 atlas (log_a top half, log_b bottom)."""
    J.reset_scene()
    sc = bpy.context.scene
    J.cycles_gpu(sc, samples=16)
    bpy.ops.import_scene.gltf(filepath=f'{RAWM}/dead_tree_trunk_02/dead_tree_trunk_02_2k.gltf')
    hp = [o for o in sc.objects if o.type == 'MESH'][0]
    bpy.context.view_layer.objects.active = hp
    hp.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    # moss into the HP material: up-facing (world normal z) + noise
    mat = hp.data.materials[0]
    nt = mat.node_tree
    bsdf = [n for n in nt.nodes if n.bl_idname == 'ShaderNodeBsdfPrincipled'][0]
    base_link = [l for l in nt.links if l.to_node == bsdf and l.to_socket.name == 'Base Color'][0]
    base_out = base_link.from_socket
    rough_link = [l for l in nt.links if l.to_node == bsdf and l.to_socket.name == 'Roughness']
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    sepn = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(geo.outputs['Normal'], sepn.inputs['Vector'])
    noise = nt.nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 2.5
    noise.inputs['Detail'].default_value = 6
    tc = nt.nodes.new('ShaderNodeTexCoord')
    nt.links.new(tc.outputs['Object'], noise.inputs['Vector'])
    m1 = nt.nodes.new('ShaderNodeMath')
    m1.operation = 'MULTIPLY_ADD'
    nt.links.new(sepn.outputs['Z'], m1.inputs[0])
    m1.inputs[1].default_value = 1.6
    nt.links.new(noise.outputs['Fac'], m1.inputs[2])
    mr = nt.nodes.new('ShaderNodeMapRange')
    mr.inputs['From Min'].default_value = 1.0
    mr.inputs['From Max'].default_value = 1.55
    nt.links.new(m1.outputs[0], mr.inputs['Value'])
    mossn = nt.nodes.new('ShaderNodeTexNoise')
    mossn.inputs['Scale'].default_value = 90
    mossn.inputs['Detail'].default_value = 8
    nt.links.new(tc.outputs['Object'], mossn.inputs['Vector'])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (*T.srgb8(30, 38, 18), 1)
    ramp.color_ramp.elements[1].color = (*T.srgb8(76, 88, 38), 1)
    nt.links.new(mossn.outputs['Fac'], ramp.inputs['Fac'])
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    nt.links.new(mr.outputs['Result'], SA.sock(mix, 'Factor_Float'))
    nt.links.new(base_out, SA.sock(mix, 'A_Color'))
    nt.links.new(ramp.outputs['Color'], SA.sock(mix, 'B_Color'))
    out_col = [o for o in mix.outputs if o.identifier == 'Result_Color'][0]
    nt.links.new(out_col, bsdf.inputs['Base Color'])
    # bake helpers: an emission output we can switch between colour and ORM
    emit = nt.nodes.new('ShaderNodeEmission')
    outn = [n for n in nt.nodes if n.bl_idname == 'ShaderNodeOutputMaterial'][0]
    orig_surface = [l.from_socket for l in nt.links if l.to_node == outn and l.to_socket.name == 'Surface'][0]
    # ORM source: arm texture R (AO) / G (rough) with moss rough 0.95
    arm_tex = [n for n in nt.nodes if n.bl_idname == 'ShaderNodeTexImage' and n.image and 'arm' in n.image.filepath]
    comb = nt.nodes.new('ShaderNodeCombineColor')
    if arm_tex:
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(arm_tex[0].outputs['Color'], sep.inputs['Color'])
        nt.links.new(sep.outputs['Red'], comb.inputs['Red'])
        mx = nt.nodes.new('ShaderNodeMath')
        mx.operation = 'MAXIMUM'
        mm = nt.nodes.new('ShaderNodeMath')
        mm.operation = 'MULTIPLY'
        nt.links.new(mr.outputs['Result'], mm.inputs[0])
        mm.inputs[1].default_value = 0.95
        nt.links.new(sep.outputs['Green'], mx.inputs[0])
        nt.links.new(mm.outputs[0], mx.inputs[1])
        nt.links.new(mx.outputs[0], comb.inputs['Green'])
    # two low-poly copies: a (as scanned), b (rolled 115 deg, 0.8 scale) -> moss lands on different sides
    lows = []
    for key, roll, scale in (('a', 0.0, 1.0), ('b', 115.0, 0.8)):
        h = hp.copy()
        h.data = hp.data.copy()
        sc.collection.objects.link(h)
        h.rotation_euler = (math.radians(roll), 0, 0)
        h.scale = (scale, scale, scale)
        bpy.context.view_layer.objects.active = h
        bpy.ops.object.select_all(action='DESELECT')
        h.select_set(True)
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        lo = h.copy()
        lo.data = h.data.copy()
        sc.collection.objects.link(lo)
        dec = lo.modifiers.new('d', 'DECIMATE')
        dec.ratio = 3700 / max(1, sum(len(p.vertices) - 2 for p in lo.data.polygons))
        bpy.context.view_layer.objects.active = lo
        bpy.ops.object.select_all(action='DESELECT')
        lo.select_set(True)
        bpy.ops.object.modifier_apply(modifier='d')
        # new UVs, packed into this log's half of the atlas
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004)
        bpy.ops.object.mode_set(mode='OBJECT')
        uvl = lo.data.uv_layers.active.data
        uv = np.empty(len(uvl) * 2, np.float32)
        uvl.foreach_get('uv', uv)
        uv = uv.reshape(-1, 2)
        uv[:, 1] = uv[:, 1] * 0.5 * 0.99 + (0.5 if key == 'a' else 0.0) + 0.0025
        uv[:, 0] = uv[:, 0] * 0.99 + 0.005
        uvl.foreach_set('uv', uv.ravel())
        lows.append((key, h, lo))
    img_c = bpy.data.images.new('floor_log_albedo', N, N, alpha=False, float_buffer=True)
    img_n = bpy.data.images.new('floor_log_normal', N, N, alpha=False, float_buffer=True)
    img_o = bpy.data.images.new('floor_log_orm', N, N, alpha=False, float_buffer=True)
    img_n.colorspace_settings.name = 'Non-Color'
    img_o.colorspace_settings.name = 'Non-Color'
    bm = bpy.data.materials.new('bake_target')
    bm.use_nodes = True
    tn = bm.node_tree.nodes.new('ShaderNodeTexImage')
    bm.node_tree.nodes.active = tn
    sc.render.bake.use_selected_to_active = True
    sc.render.bake.cage_extrusion = 0.04
    sc.render.bake.max_ray_distance = 0.12
    sc.render.bake.margin = 6
    sc.render.bake.use_clear = False
    for key, h, lo in lows:
        lo.data.materials.clear()
        lo.data.materials.append(bm)
        for (img, btype, which) in ((img_c, 'EMIT', 'col'), (img_o, 'EMIT', 'orm'), (img_n, 'NORMAL', None)):
            tn.image = img
            if which == 'col':
                nt.links.new(out_col, emit.inputs['Color'])
                nt.links.new(emit.outputs['Emission'], outn.inputs['Surface'])
            elif which == 'orm':
                nt.links.new(comb.outputs['Color'], emit.inputs['Color'])
                nt.links.new(emit.outputs['Emission'], outn.inputs['Surface'])
            else:
                nt.links.new(orig_surface, outn.inputs['Surface'])
            bpy.ops.object.select_all(action='DESELECT')
            h.select_set(True)
            lo.select_set(True)
            bpy.context.view_layer.objects.active = lo
            bpy.ops.object.bake(type=btype, normal_space='TANGENT', normal_r='POS_X', normal_g='POS_Y', normal_b='POS_Z')
            print('baked', key, btype, which)
    def save(img, path, srgb):
        w, hh = img.size
        px = np.empty(w * hh * 4, np.float32)
        img.pixels.foreach_get(px)
        px = px.reshape(hh, w, 4)[::-1, :, :3]
        if srgb:
            px = T.lin_to_srgb(px)
        T.write_png(path, np.clip(px, 0, 1))
    save(img_c, f'{TEX}/floor_log_albedo.png', True)
    save(img_n, f'{TEX}/floor_log_normal.png', False)
    save(img_o, f'{TEX}/floor_log_orm.png', False)
    # keep the low-poly meshes for the export pass
    lp = {}
    for key, h, lo in lows:
        V = np.array([v.co[:] for v in lo.data.vertices])
        uvl = lo.data.uv_layers.active.data
        uv = np.empty(len(uvl) * 2, np.float32)
        uvl.foreach_get('uv', uv)
        F = [list(p.vertices) for p in lo.data.polygons]
        lp[key] = dict(V=V.tolist(), F=F, UV=uv.reshape(-1, 2).tolist(),
                       loops=[list(p.loop_indices) for p in lo.data.polygons])
    with open(f'{WORK}/logs_lp.json', 'w') as f:
        json.dump(lp, f)
    print('logs baked')


# ------------------------------------------------------------------------------------------------ export
def log_mb(d, lod, key):
    V = np.array(d['V'])
    # glTF scan is Y-up imported to Blender Z-up already; centre on x/y and sit on the ground (sunk 12 cm)
    V[:, 0] -= (V[:, 0].min() + V[:, 0].max()) / 2
    V[:, 1] -= (V[:, 1].min() + V[:, 1].max()) / 2
    V[:, 2] -= V[:, 2].min() + 0.32  # the scan rests on a branch stub: sink it so the body lies on the ground
    zmax = V[:, 2].max()
    rr = np.hypot(V[:, 1], V[:, 2] - zmax * 0.45)
    ao = np.clip(0.45 + 0.55 * (V[:, 2] + 0.12) / (zmax + 0.12), 0.35, 1.0)
    C = np.stack([ao, ao, ao, np.ones_like(ao)], -1)
    mb = J.MB()
    mb.verts(V, C)
    UV = d['UV']
    for f, loops in zip(d['F'], d['loops']):
        mb.face(f, [tuple(UV[i]) for i in loops], 1)
    return mb


ROOT_V0, ROOT_DV, ROOT_M = 0.579, 0.105, 0.8  # damp / mossy / soil-stained band of the canopy bark (0..0.8 m)


def root_v(va, vb):
    k = math.floor(0.5 * (va + vb) / ROOT_DV)
    return ROOT_V0 + va - k * ROOT_DV, ROOT_V0 + vb - k * ROOT_DV


def roots_mb(seed, lod):
    """Surface buttress roots radiating and snaking over the ground, partly buried (canopy bark, clean region)."""
    rng = np.random.default_rng(seed)
    mb = J.MB()
    nroot = 9 if lod == 0 else 6
    for k in range(nroot):
        a = 2 * math.pi * k / nroot + rng.uniform(-0.3, 0.3)
        L = rng.uniform(1.6, 3.4)
        r0 = rng.uniform(0.08, 0.14)
        n = 9 if lod == 0 else 4
        pts, rad = [], []
        wav = rng.uniform(0.2, 0.5)
        for i in range(n + 1):
            t = i / n
            d = t * L
            off = wav * math.sin(t * rng.uniform(2.5, 4.0) + k) * t
            p = np.array([math.cos(a) * d - math.sin(a) * off, math.sin(a) * d + math.cos(a) * off, 0.0])
            r = r0 * (1 - 0.8 * t) + 0.012
            p[2] = r * rng.uniform(-0.35, 0.45) + 0.06 * (1 - t) ** 2
            pts.append(p)
            rad.append(r)
        pts = np.array(pts)

        def colf(i, f, aa):
            return np.tile([0.55 + 0.35 * f, 0.55 + 0.35 * f, 0.55 + 0.35 * f, 1.0], (len(aa), 1))
        J.tube(mb, pts, np.array(rad), 6 if lod == 0 else 4, colf, mat=2, u_wrap=1, v_scale=ROOT_DV / ROOT_M, seg_v=root_v)
        if lod == 0 and rng.uniform() < 0.6:  # a side root
            j = int(n * rng.uniform(0.3, 0.6))
            b = a + rng.choice([-1, 1]) * rng.uniform(0.5, 1.0)
            L2 = L * rng.uniform(0.3, 0.5)
            q = [pts[j] + np.array([math.cos(b) * L2 * t, math.sin(b) * L2 * t, 0.0]) for t in np.linspace(0, 1, 5)]
            q = np.array(q)
            q[:, 2] = np.linspace(pts[j][2], -0.02, 5)
            J.tube(mb, q, np.linspace(rad[j] * 0.7, 0.012, 5), 5, colf, mat=2, u_wrap=1, v_scale=ROOT_DV / ROOT_M, seg_v=root_v)
    # knot / stump base the roots come from
    J.tube(mb, np.array([[0, 0, -0.2], [0, 0, 0.12], [0.02, 0.0, 0.3]]), [0.2, 0.18, 0.1], 8 if lod == 0 else 5,
           lambda i, f, aa: np.tile([0.5 + 0.3 * f] * 3 + [1.0], (len(aa), 1)), mat=2, u_wrap=1, v_scale=ROOT_DV / ROOT_M,
           seg_v=root_v, cap=True)
    return mb


def litter_mb(at, name, lod, seed):
    """Flat litter card: 4x4 grid (lod0) or a quad (lod1), cropped to the patch content, lying at z = 0.015."""
    rng = np.random.default_rng(seed)
    t = at['tiles'][name]
    Sw, Sh = t['size_wh']
    cu0, cv0, cu1, cv1 = t['content']
    piv = t['pivot']
    r = t['rect']
    n = 4 if lod == 0 else 1
    mb = J.MB()
    idx = np.zeros((n + 1, n + 1), int)
    ph = float(rng.uniform())
    for j in range(n + 1):
        for i in range(n + 1):
            cu = cu0 + (cu1 - cu0) * i / n
            cv = cv0 + (cv1 - cv0) * j / n
            x, y = (cu - piv[0]) * Sw, (cv - piv[1]) * Sh
            b = mb.verts(np.array([[x, y, 0.015]]), np.array([[0.85, 0.0, 0.03, ph]]), np.array([[0, 0, 1.0]]))
            idx[j, i] = b
    for j in range(n):
        for i in range(n):
            def uv(ii, jj):
                cu = cu0 + (cu1 - cu0) * ii / n
                cv = cv0 + (cv1 - cv0) * jj / n
                return (r[0] + cu * (r[2] - r[0]), r[1] + cv * (r[3] - r[1]))
            mb.face((idx[j, i], idx[j, i + 1], idx[j + 1, i + 1], idx[j + 1, i]), [uv(i, j), uv(i + 1, j), uv(i + 1, j + 1), uv(i, j + 1)], 0)
    return mb


def seedling_mb(at, seed, lod, height, nleaf):
    rng = np.random.default_rng(seed)
    mb = J.MB()
    ph = float(rng.uniform())
    P = np.array([[0, 0, -0.03], [0.01, 0.0, height * 0.5], [0.02, 0.01, height]])
    J.tube(mb, P, [0.006, 0.005, 0.003], 4 if lod == 0 else 3,
           lambda i, f, a: np.tile([0.6 + 0.3 * f, 0.3 * f, 0.0, ph], (len(a), 1)), mat=2, u_wrap=1, v_scale=0.3)
    keys = [k for k in at['tiles'] if k.startswith('seedleaf_')]
    for k in range(nleaf):
        tk = keys[(seed + k) % len(keys)]
        t = at['tiles'][tk]
        r = t['rect']
        f = 0.55 + 0.45 * k / max(nleaf - 1, 1)
        base = P[1] * (1 - f) * 2 if f < 0.5 else P[1] + (P[2] - P[1]) * (f - 0.5) * 2
        az = rng.uniform(0, 6.28) if k else 0.3
        L = rng.uniform(0.06, 0.12) * (height / 0.3) ** 0.5 * (1.4 if k == nleaf - 1 else 1.0)
        W = L * t['width'] / t['length']
        d = J.norm(np.array([math.cos(az), math.sin(az), rng.uniform(0.1, 0.6)]))
        side = J.norm(np.cross(d, np.array([0, 0, 1.0])))
        up = J.norm(np.cross(side, d))
        ns = 3 if lod == 0 else 1
        idx = []
        for s in range(ns + 1):
            tt = s / ns
            c = base + d * L * tt - up * 0.25 * L * tt * tt
            pts = [c - side * W / 2, c, c + side * W / 2]
            cols = [(0.7 + 0.3 * tt, 0.3 + 0.7 * tt, 0.2 + 0.8 * tt * abs(sx), ph) for sx in (-1, 0, 1)]
            b = mb.verts(np.array(pts) + np.array([0, 0, 0.0]), np.array(cols), np.array([up, up, up]))
            idx.append(b)
        for s in range(ns):
            for cx in range(2):
                a0, a1 = idx[s] + cx, idx[s + 1] + cx
                v0, v1 = s / ns, (s + 1) / ns

                def uv(cc, vv):
                    return (r[0] + cc / 2 * (r[2] - r[0]), r[1] + vv * (r[3] - r[1]))
                mb.face((a0, a0 + 1, a1 + 1, a1), [uv(cx, v0), uv(cx + 1, v0), uv(cx + 1, v1), uv(cx, v1)], 0)
    return mb


def export():
    J.reset_scene()
    with open(f'{TEX}/floor_litter.json') as f:
        at = json.load(f)
    with open(f'{WORK}/logs_lp.json') as f:
        logs = json.load(f)
    litter = J.pbr_material('floor_litter', f'{TEX}/floor_litter_albedo.png', f'{TEX}/floor_litter_normal.png',
                            f'{TEX}/floor_litter_orm.png', alpha=True, double_sided=True)
    logm = J.pbr_material('floor_log', f'{TEX}/floor_log_albedo.png', f'{TEX}/floor_log_normal.png',
                          f'{TEX}/floor_log_orm.png', alpha=False, double_sided=False)
    bark = J.pbr_material('floor_bark', f'{TEX}/canopy_bark_albedo.png', f'{TEX}/canopy_bark_normal.png',
                          f'{TEX}/canopy_bark_orm.png', alpha=False, double_sided=False)
    mats = [litter, logm, bark]
    objs, info = [], {}

    def add(name, mb):
        ob = mb.build(name, mats)
        objs.append(ob)
        V = np.concatenate(mb.V)
        info[name] = dict(tris=mb.tris(), bbox=[V.min(0).round(2).tolist(), V.max(0).round(2).tolist()])
        print(name, mb.tris(), 'tris', V.min(0).round(2), V.max(0).round(2))
    for i, (name, *_r) in enumerate(LITTER):
        for lod in (0, 1):
            add(f'litter_{name[-1]}_lod{lod}', litter_mb(at, name, lod, 80 + i))
    for key in ('a', 'b'):
        mb = log_mb(logs[key], 0, key)
        ob = mb.build(f'log_{key}_lod0', mats)
        objs.append(ob)
        ob1 = mb.build(f'log_{key}_lod1', mats)
        m = ob1.modifiers.new('d', 'DECIMATE')
        m.ratio = 900 / mb.tris()
        bpy.context.view_layer.objects.active = ob1
        ob1.select_set(True)
        bpy.ops.object.modifier_apply(modifier='d')
        objs.append(ob1)
        V = np.concatenate(mb.V)
        info[f'log_{key}'] = dict(tris_lod0=mb.tris(), tris_lod1=sum(len(p.vertices) - 2 for p in ob1.data.polygons),
                                  bbox=[V.min(0).round(2).tolist(), V.max(0).round(2).tolist()])
        print(f'log_{key}', info[f'log_{key}'])
    for lod in (0, 1):
        add(f'roots_a_lod{lod}', roots_mb(91, lod))
        add(f'seedling_a_lod{lod}', seedling_mb(at, 3, lod, 0.45, 6))
        add(f'seedling_b_lod{lod}', seedling_mb(at, 6, lod, 0.22, 3))
    J.export_glb(f'{OUT}/floor_raw.glb', objs)
    with open(f'{OUT}/floor_info.json', 'w') as f:
        json.dump(info, f, indent=1)
    print('exported floor')


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if '--skip-atlas' not in argv:
        build_atlas(make_combined())
    if '--skip-bake' not in argv:
        bake_logs()
    export()


if __name__ == '__main__':
    main()
