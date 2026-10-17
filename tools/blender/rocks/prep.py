"""Prepare one kit piece from a Poly Haven scan.

  blender --background --factory-startup -t 6 --python prep.py -- <pieces.json> <piece_name>

Steps: import scan (merged vertices, smooth) -> orient face to -Y -> crop (x / y / z ranges; optional keep_largest)
-> drop small floating fragments -> re-orient the section by its own mean normal (and re-cut the sides) -> centre
(x centre = 0, face plane y = 0, base z = 0) = <piece>_hi.
<piece>_lod0 = decimated copy (scan UVs dropped first so seams do not constrain the collapse) + bottom skirt (the
whole lower boundary continued 4.5 m below the base). Then both get the same isometric plan bend (arc length along
the face is preserved, so no texture stretch along it) and lod0 gets a smart UV unwrap (skirt islands shrunk, they
are buried).
Output: E:/tmp/island/helpers/rocks/work/<piece>.blend and <piece>.json
"""
import os
import sys
import math
import json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import bmesh  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
import rocklib as R  # noqa: E402

cfg_path, piece_name = R.args_after_dashes()[:2]
cfg = json.load(open(cfg_path))
P = next(p for p in cfg['pieces'] if p['name'] == piece_name)
WORK = R.WORK + '/work'
os.makedirs(WORK, exist_ok=True)
LOD0_TARGET = int(P.get('lod0_tris', cfg.get('lod0_tris', 21500)))
SKIRT = float(P.get('skirt', cfg.get('skirt', 4.5)))
RETURN = float(P.get('return', cfg.get('return', 3.0)))


def import_scan(scan_id):
    path = R.scan_gltf_path(scan_id)
    before = set(bpy.data.objects)
    try:
        bpy.ops.import_scene.gltf(filepath=path, merge_vertices=True, import_shading='SMOOTH')
    except TypeError:
        bpy.ops.import_scene.gltf(filepath=path, merge_vertices=True)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for o in new:
        if o.name in bpy.data.objects and o.type != 'MESH':
            bpy.data.objects.remove(o)
    # weld any remaining seam splits so cuts / decimation never open cracks
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bm.to_mesh(obj.data)
    bm.free()
    if obj.data.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    obj.data.polygons.foreach_set('use_smooth', np.ones(len(obj.data.polygons), bool))
    return obj


def delete_verts_mask(obj, mask):
    """Delete vertices where mask is True (fast, via edit-mode operator)."""
    me = obj.data
    if not mask.any():
        return
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='OBJECT')
    me.vertices.foreach_set('select', mask.astype(bool))
    me.edges.foreach_set('select', np.zeros(len(me.edges), bool))
    me.polygons.foreach_set('select', np.zeros(len(me.polygons), bool))
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_mode(type='VERT')
    bpy.ops.mesh.delete(type='VERT')
    bpy.ops.object.mode_set(mode='OBJECT')


def crop(obj, axis, lo, hi):
    """Exact planar cut keeping lo <= coord <= hi on the given axis (0 x, 1 y, 2 z)."""
    co, _ = R.mesh_arrays(obj)
    # coarse delete far outside first (cheap), then bisect exactly
    far = (co[:, axis] < lo - 1.0) | (co[:, axis] > hi + 1.0)
    delete_verts_mask(obj, far)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    no = Vector((0, 0, 0))
    no[axis] = 1
    pc = Vector((0, 0, 0))
    pc[axis] = lo
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-6, plane_co=pc, plane_no=no, clear_inner=True)
    pc[axis] = hi
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-6, plane_co=pc, plane_no=-no, clear_inner=True)
    bm.to_mesh(obj.data)
    bm.free()


def components(nv, tri):
    e = np.concatenate([tri[:, [0, 1]], tri[:, [1, 2]], tri[:, [2, 0]]])
    lab = np.arange(nv)
    for _ in range(10000):
        m = np.minimum(lab[e[:, 0]], lab[e[:, 1]])
        new = lab.copy()
        np.minimum.at(new, e[:, 0], m)
        np.minimum.at(new, e[:, 1], m)
        for _ in range(4):
            new = new[new]
        if np.array_equal(new, lab):
            break
        lab = new
    return lab


def keep_largest(obj):
    co, tri = R.mesh_arrays(obj)
    lab = components(len(co), tri)
    _, ar = R.tri_normals_areas(co, tri)
    tl = lab[tri[:, 0]]
    uniq, inv = np.unique(tl, return_inverse=True)
    area = np.bincount(inv, weights=ar)
    keep = uniq[int(np.argmax(area))]
    used = np.zeros(len(co), bool)
    used[tri.ravel()] = True
    delete_verts_mask(obj, (lab != keep) | ~used)
    R.log('kept largest component, area', round(float(area.max()), 1), 'of', round(float(area.sum()), 1))


def drop_fragments(obj, min_frac=0.004, min_area=0.4):
    co, tri = R.mesh_arrays(obj)
    lab = components(len(co), tri)
    _, ar = R.tri_normals_areas(co, tri)
    tl = lab[tri[:, 0]]
    uniq, inv = np.unique(tl, return_inverse=True)
    area = np.bincount(inv, weights=ar)
    total = area.sum()
    small = (area < max(min_frac * total, min_area))
    bad_labels = set(uniq[small].tolist())
    if not bad_labels:
        return 0
    used = np.zeros(len(co), bool)
    used[tri.ravel()] = True
    vmask = np.isin(lab, list(bad_labels)) | ~used
    delete_verts_mask(obj, vmask)
    R.log('dropped fragments', len(bad_labels), 'area', round(float(area[small].sum()), 2), 'of', round(float(total), 1))
    return len(bad_labels)


def boundary_vertex_ids(tri):
    e = np.sort(np.concatenate([tri[:, [0, 1]], tri[:, [1, 2]], tri[:, [2, 0]]]), axis=1)
    key = e[:, 0].astype(np.int64) * 10_000_000 + e[:, 1]
    u, c = np.unique(key, return_counts=True)
    be = u[c == 1]
    return np.unique(np.concatenate([be // 10_000_000, be % 10_000_000]))


def theta_fn(bend, W):
    """Heading angle (radians) along the face as a function of arc length s (centre s = 0)."""
    t = bend.get('type', 'none')
    deg = math.radians(bend.get('deg', 0))

    def smooth(x):
        x = np.clip(x, 0, 1)
        return x * x * (3 - 2 * x)
    if t == 'ends':
        sb = W / 2 - bend.get('frac', 0.25) * W
        span = max(W / 2 - sb, 1e-3)

        def f(s):
            return deg * (smooth((s - sb) / span) - smooth((-s - sb) / span))
    elif t == 'nose':
        c = bend.get('corner', 0.25) * W
        w = bend.get('width', 0.15) * W

        def f(s):
            return deg / 2 * (smooth((s - c) / (2 * w) + 0.5) - smooth((-s - c) / (2 * w) + 0.5))
    elif t == 'gully':
        def f(s):
            return -deg * np.clip(s / W, -0.5, 0.5) - deg * 0.0
    else:
        def f(s):
            return np.zeros_like(s)
    return f


def bend_coords(co, bend, W):
    if bend.get('type', 'none') == 'none':
        return co
    f = theta_fn(bend, W)
    L = W / 2 + 30
    s = np.linspace(-L, L, 24001)
    th = f(s)
    ds = s[1] - s[0]
    i0 = len(s) // 2
    cx = np.cumsum(np.cos(th)) * ds
    cy = np.cumsum(np.sin(th)) * ds
    cx -= cx[i0]
    cy -= cy[i0]
    x, y = co[:, 0], co[:, 1]
    px = np.interp(x, s, cx)
    py = np.interp(x, s, cy)
    t = np.interp(x, s, th)
    ox, oy = np.sin(t), -np.cos(t)  # outward (sea-facing) direction
    out = co.copy()
    out[:, 0] = px - y * ox
    out[:, 1] = py - y * oy
    return out


def profile_scale(x, W, prof):
    """Vertical scale s(x) of the face so its skyline is not one constant height: tapers toward both ends (the
    neighbour that overlaps an end is then taller there), steps (ds added right of xc over a ramp of w metres),
    notches (gaussian dips) and a little low-frequency wobble. xc in units of the half width (-1 left .. 1 right)."""
    def sm(t):
        t = np.clip(t, 0, 1)
        return t * t * (3 - 2 * t)
    xi = x / (W / 2)
    s = np.ones_like(x)
    el, er = prof.get('ends', [1.0, 1.0])
    ef = prof.get('end_frac', 0.25)
    s *= 1 - (1 - el) * sm((-xi - (1 - 2 * ef)) / (2 * ef))
    s *= 1 - (1 - er) * sm((xi - (1 - 2 * ef)) / (2 * ef))
    for xc, ds, w in prof.get('steps', []):
        s += ds * sm((x - xc * W / 2) / w + 0.5)
    for xc, depth, w in prof.get('notches', []):
        s -= depth * np.exp(-0.5 * ((x - xc * W / 2) / w) ** 2)
    amp = prof.get('wobble', 0.0)
    if amp:
        rng = np.random.default_rng(prof.get('seed', 1))
        for lam in (2.5, 4.5, 8.0):
            s += amp / 3 * np.sin(2 * np.pi * x / lam + rng.uniform(0, 2 * np.pi))
    return s


def set_coords(obj, co):
    obj.data.vertices.foreach_set('co', co.astype(np.float32).ravel())
    obj.data.update()


def boundary_loops(bm):
    bnd = [e for e in bm.edges if e.is_boundary]
    vedges = {}
    for e in bnd:
        for v in e.verts:
            vedges.setdefault(v, []).append(e)
    seen = set()
    loops = []
    for e0 in bnd:
        if e0 in seen:
            continue
        v0 = e0.verts[0]
        lv = [v0]
        e = e0
        v = v0
        while True:
            seen.add(e)
            v = e.other_vert(v)
            if v == v0:
                break
            lv.append(v)
            nxt = [x for x in vedges[v] if x not in seen]
            if not nxt:
                break
            e = nxt[0]
        loops.append(lv)
    return loops


def add_skirt(obj, flare=0.3, mode='bottom'):
    """Bottom apron, built in flat coordinates (face toward -Y, width along X) before the plan bend: the lower half
    of the main boundary loop (from the bottom-left to the bottom-right corner, every edge, so there are no gaps) is
    extended down to z = -SKIRT along a smoothed line, so the piece can sink into the sea bed / terrain.
    mode 'loop' extrudes the whole main loop (free-standing blocks). Sides and top stay open (buried in the terrain
    or hidden by the overlapping neighbour). Apron faces are tagged in the 'skirt' face attribute."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    lay = bm.faces.layers.int.get('skirt') or bm.faces.layers.int.new('skirt')
    # skirt_parent (vertex): 1 + index of the boundary vertex a skirt vertex hangs from (0 = not a skirt vertex);
    # the bake folds the skirt up onto the face with it, so buried-but-visible aprons get real rock texture
    play = bm.verts.layers.int.get('skirt_parent') or bm.verts.layers.int.new('skirt_parent')
    bm.verts.index_update()
    loops = boundary_loops(bm)

    def loop_len(lv):
        return sum((lv[i].co - lv[(i + 1) % len(lv)].co).length for i in range(len(lv)))
    main = max(loops, key=loop_len)
    P_ = np.array([v.co[:] for v in main])
    if mode == 'loop':
        path = main + [main[0]]
    else:
        xlo, xhi = P_[:, 0].min(), P_[:, 0].max()
        cand_l = np.where(P_[:, 0] < xlo + 0.08)[0]
        cand_r = np.where(P_[:, 0] > xhi - 0.08)[0]
        i = int(cand_l[np.argmin(P_[cand_l, 2])])
        j = int(cand_r[np.argmin(P_[cand_r, 2])])
        n = len(main)
        if i < j:
            p1 = list(range(i, j + 1))
            p2 = list(range(j, n)) + list(range(0, i + 1))
        else:
            p1 = list(range(i, n)) + list(range(0, j + 1))
            p2 = list(range(j, i + 1))

        def mean_z(idx):
            q = P_[idx]
            seg = np.linalg.norm(np.diff(q, axis=0), axis=1)
            mid = (q[1:, 2] + q[:-1, 2]) / 2
            return float((mid * seg).sum() / max(seg.sum(), 1e-9))
        idx = p1 if mean_z(p1) < mean_z(p2) else p2
        path = [main[k] for k in idx]
    Q = np.array([v.co[:] for v in path])
    seg = np.linalg.norm(np.diff(Q[:, :2], axis=0), axis=1)
    sarc = np.concatenate([[0], np.cumsum(seg)])
    sig = 0.8
    w = np.exp(-0.5 * ((sarc[:, None] - sarc[None, :]) / sig) ** 2)
    w /= w.sum(1, keepdims=True)
    xy = w @ Q[:, :2]
    if mode != 'loop':
        xy[:, 0] = np.clip(xy[:, 0], Q[:, 0].min(), Q[:, 0].max())
        xy[0, 0], xy[-1, 0] = Q[0, 0], Q[-1, 0]
    new_of = {}
    for k, v in enumerate(path):
        if v in new_of:
            continue
        z = min(-SKIRT, v.co.z - 0.5)
        if mode == 'loop':
            c = Q[:, :2].mean(0)
            d = xy[k] - c
            d = d / max(np.linalg.norm(d), 1e-6)
            nv = bm.verts.new((xy[k, 0] + d[0] * flare, xy[k, 1] + d[1] * flare, z))
        else:
            nv = bm.verts.new((xy[k, 0], xy[k, 1] - flare, z))
        nv[play] = v.index + 1
        new_of[v] = nv
    nf = 0
    for k in range(len(path) - 1):
        a, b = path[k], path[k + 1]
        e = bm.edges.get((a, b))
        if e is None or not e.link_faces:
            continue
        f0 = e.link_faces[0]
        lp = next(x for x in f0.loops if x.edge == e)
        quad = (b, a, new_of[a], new_of[b]) if lp.vert == a else (a, b, new_of[b], new_of[a])
        try:
            f = bm.faces.new(quad)
            f.smooth = True
            f[lay] = 1
            nf += 1
        except ValueError:
            pass
    R.log('skirt: loops', len(loops), 'main loop verts', len(main), 'path verts', len(path), 'faces', nf)
    bm.to_mesh(obj.data)
    bm.free()
    return nf


def smart_uv(obj, smooth_it=60, ring=False):
    """Charts from a smart projection of a heavily smoothed copy (so rock roughness does not shatter the charts
    into thousands of islands), turned into seams, then a minimum-stretch unwrap of the real mesh. Skirt faces are
    always separate islands (shrunk later by atlas_pack)."""
    me = obj.data
    if not me.uv_layers:
        me.uv_layers.new(name='UVMap')
    skirt = np.zeros(len(me.polygons), np.int32)
    me.attributes['skirt'].data.foreach_get('value', skirt)
    tmp = obj.copy()
    tmp.data = me.copy()
    bpy.context.scene.collection.objects.link(tmp)
    bpy.ops.object.select_all(action='DESELECT')
    tmp.select_set(True)
    bpy.context.view_layer.objects.active = tmp
    m = tmp.modifiers.new('sm', 'SMOOTH')
    m.factor = 1.0
    m.iterations = smooth_it
    bpy.ops.object.modifier_apply(modifier=m.name)
    for part in (0, 1):
        bpy.ops.object.mode_set(mode='OBJECT')
        tmp.data.polygons.foreach_set('select', skirt == part)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_mode(type='FACE')
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.0, area_weight=0.0,
                                 correct_aspect=True, scale_to_bounds=False)
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.seams_from_islands()
    bpy.ops.object.mode_set(mode='OBJECT')
    seams = np.zeros(len(tmp.data.edges), bool)
    tmp.data.edges.foreach_get('use_seam', seams)
    bpy.data.meshes.remove(tmp.data)
    # a closed skirt ring around a free-standing block is cut into strips (charts from the real skirt); an open
    # bottom skirt is a strip already and stays one island
    if ring:
        seams = ring_seams(obj, skirt, seams)
    me.edges.foreach_set('use_seam', seams)
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    how = 'MINIMUM_STRETCH'
    try:
        bpy.ops.uv.unwrap(method='MINIMUM_STRETCH', margin=0.0)
    except Exception as e:  # noqa
        R.log('min stretch unwrap failed', e)
        how = 'ANGLE_BASED'
    bpy.ops.object.mode_set(mode='OBJECT')
    bad = collapsed_uv_fraction(obj, skirt)
    if how != 'MINIMUM_STRETCH' or bad > 0.01:
        R.log('unwrap', how, 'collapsed fraction', round(bad, 4), '-> angle based')
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.select_all(action='SELECT')
        bpy.ops.uv.unwrap(method='ANGLE_BASED', margin=0.0)
        bpy.ops.object.mode_set(mode='OBJECT')
        how = 'ANGLE_BASED'
        bad = collapsed_uv_fraction(obj, skirt)
    if bad > 0.002:
        # charts the solver could not flatten (non-disk / folded scan geometry): smart-project just those faces
        polys = collapsed_polys(obj, skirt)
        me.polygons.foreach_set('select', polys)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.0, area_weight=0.0,
                                 correct_aspect=True, scale_to_bounds=False)
        bpy.ops.object.mode_set(mode='OBJECT')
        R.log('re-projected collapsed faces', int(polys.sum()))
        bad = collapsed_uv_fraction(obj, skirt)
    me.update()
    R.log('unwrap', how, 'seam edges', int(seams.sum()), 'collapsed fraction', round(bad, 4))


def collapsed_polys(obj, skirt):
    me = obj.data
    me.calc_loop_triangles()
    nt = len(me.loop_triangles)
    lt = np.empty(nt * 3, np.int32)
    me.loop_triangles.foreach_get('loops', lt)
    vt = np.empty(nt * 3, np.int32)
    me.loop_triangles.foreach_get('vertices', vt)
    pi = np.empty(nt, np.int32)
    me.loop_triangles.foreach_get('polygon_index', pi)
    uv = np.empty(len(me.loops) * 2, np.float32)
    me.uv_layers.active.data.foreach_get('uv', uv)
    t = uv.reshape(-1, 2)[lt.reshape(-1, 3)]
    co, _ = R.mesh_arrays(obj)
    p = co[vt.reshape(-1, 3)]
    a2 = np.abs(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])) * 0.5
    a3 = np.linalg.norm(np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]), axis=1) * 0.5
    d = np.sqrt(a2 / np.maximum(a3, 1e-9))
    f = skirt[pi] == 0
    bad_t = f & (d < np.median(d[f]) / 3)
    polys = np.zeros(len(me.polygons), bool)
    polys[pi[bad_t]] = True
    return polys


def collapsed_uv_fraction(obj, skirt):
    """Fraction of (non-skirt) 3D area whose UV density is under a third of the median (failed charts)."""
    me = obj.data
    me.calc_loop_triangles()
    nt = len(me.loop_triangles)
    lt = np.empty(nt * 3, np.int32)
    me.loop_triangles.foreach_get('loops', lt)
    vt = np.empty(nt * 3, np.int32)
    me.loop_triangles.foreach_get('vertices', vt)
    pi = np.empty(nt, np.int32)
    me.loop_triangles.foreach_get('polygon_index', pi)
    uv = np.empty(len(me.loops) * 2, np.float32)
    me.uv_layers.active.data.foreach_get('uv', uv)
    t = uv.reshape(-1, 2)[lt.reshape(-1, 3)]
    co, _ = R.mesh_arrays(obj)
    p = co[vt.reshape(-1, 3)]
    a2 = np.abs(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])) * 0.5
    a3 = np.linalg.norm(np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]), axis=1) * 0.5
    f = (skirt[pi] == 0) & (a3 > 1e-8)
    d = np.sqrt(a2[f] / a3[f])
    return float(a3[f][d < np.median(d) / 3].sum() / a3[f].sum())


def ring_seams(obj, skirt, seams):
    me = obj.data
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    me.polygons.foreach_set('select', skirt == 1)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_mode(type='FACE')
    bpy.ops.uv.smart_project(angle_limit=math.radians(80), island_margin=0.0, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.seams_from_islands()
    bpy.ops.object.mode_set(mode='OBJECT')
    s2 = np.zeros(len(me.edges), bool)
    me.edges.foreach_get('use_seam', s2)
    lt = np.empty(len(me.polygons), np.int32)
    me.polygons.foreach_get('loop_total', lt)
    le = np.empty(len(me.loops), np.int32)
    me.loops.foreach_get('edge_index', le)
    skirt_edge = np.zeros(len(me.edges), bool)
    skirt_edge[le[np.repeat(skirt, lt) == 1]] = True
    return seams | (s2 & skirt_edge)


# ---------------------------------------------------------------- main
R.reset_scene()
obj = import_scan(P['scan'])
R.log(piece_name, 'scan', P['scan'], 'tris', R.tri_count(obj))
R.rotate_face_to_minus_y(obj, P.get('rot', 0.0))
for axis, key in ((0, 'x'), (1, 'y'), (2, 'z')):
    if key in P:
        crop(obj, axis, *P[key])
if P.get('keep_largest'):
    keep_largest(obj)
drop_fragments(obj)
co0, _ = R.mesh_arrays(obj)
rot2 = R.rotate_face_to_minus_y(obj, P.get('rot2', 0.0)) if P.get('reorient', True) else 0.0
if 'x' in P and abs(rot2) > 0.2:
    # the side cuts are slanted after the re-orientation: cut again so both sides are planes x = const
    co1, _ = R.mesh_arrays(obj)
    lo, hi = P['x']
    left = np.abs(co0[:, 0] - lo) < 2e-3
    right = np.abs(co0[:, 0] - hi) < 2e-3
    if left.any() and right.any():
        crop(obj, 0, float(co1[left, 0].max()), float(co1[right, 0].min()))
        drop_fragments(obj)
R.log('section re-orient', round(rot2, 2), 'tris', R.tri_count(obj))

# centre: x centre -> 0, face plane -> y 0, base -> z 0
co, tri = R.mesh_arrays(obj)
n, ar = R.tri_normals_areas(co, tri)
mn, mx = co.min(0), co.max(0)
H0 = mx[2] - mn[2]
tc = co[tri].mean(1)
front = (n[:, 1] < -0.55) & (tc[:, 2] > mn[2] + 0.15 * H0) & (tc[:, 2] < mn[2] + 0.85 * H0)
y_face = float(np.average(tc[front, 1], weights=ar[front])) if front.any() else float(np.median(co[:, 1]))
bids = boundary_vertex_ids(tri)
bz = co[bids, 2]
low = bids[bz < mn[2] + 0.3 * H0]
z_base = float(np.percentile(co[low, 2], P.get('base_pct', 55))) if len(low) else float(mn[2])
if 'base_z' in P:
    z_base = float(P['base_z'])
x_c = float((mn[0] + mx[0]) / 2)
co = co - np.array([x_c, y_face, z_base], np.float32)
W = float(mx[0] - mn[0])
if P.get('profile'):
    s = profile_scale(co[:, 0], W, P['profile'])
    up = co[:, 2] > 0
    co[up, 2] *= s[up]
    R.log('profile: s min / max', round(float(s.min()), 3), round(float(s.max()), 3))
set_coords(obj, co)
if P.get('end_trim'):
    # a concave bend swings whatever lies behind the face out toward and past the ends: the depth kept behind the
    # face shrinks linearly toward each end (y0 + k * distance to the end), and anything the bend would still carry
    # past the bent end of the face is dropped
    et = P['end_trim']
    d_end = W / 2 - np.abs(co[:, 0])
    kill = co[:, 1] > et.get('y0', 0.6) + et.get('k', 0.7) * d_end
    if P.get('bend'):
        b = bend_coords(co, P['bend'], W)
        e = bend_coords(np.array([[-W / 2, 0, 0], [W / 2, 0, 0]], np.float32), P['bend'], W)
        mg = et.get('margin', 0.3)
        kill |= (co[:, 1] > 0.2) & (((co[:, 0] > 0) & (b[:, 0] > e[1, 0] - mg)) |
                                    ((co[:, 0] < 0) & (b[:, 0] < e[0, 0] + mg)))
    delete_verts_mask(obj, kill)
    drop_fragments(obj)
obj.name = obj.data.name = piece_name + '_hi'
hi_tris = R.tri_count(obj)
R.log('hi tris', hi_tris, 'W', round(W, 2), 'z_base', round(z_base, 2), 'y_face', round(y_face, 2))

# ---------------- lod0 (decimated + skirt in flat coordinates, then both meshes get the same plan bend)
lod = obj.copy()
lod.data = obj.data.copy()
bpy.context.scene.collection.objects.link(lod)
lod.name = lod.data.name = piece_name + '_lod0'
while lod.data.uv_layers:
    lod.data.uv_layers.remove(lod.data.uv_layers[0])
for a in [a.name for a in lod.data.color_attributes]:
    lod.data.color_attributes.remove(lod.data.color_attributes[a])
lod.data.materials.clear()
bpy.ops.object.select_all(action='DESELECT')
lod.select_set(True)
bpy.context.view_layer.objects.active = lod
m = lod.modifiers.new('dec', 'DECIMATE')
m.decimate_type = 'COLLAPSE'
m.ratio = min(1.0, LOD0_TARGET / max(hi_tris, 1))
m.use_collapse_triangulate = True
bpy.ops.object.modifier_apply(modifier=m.name)
dec_tris = R.tri_count(lod)
nsk = add_skirt(lod, mode=P.get('skirt_mode', 'bottom'))
bm = bmesh.new()
bm.from_mesh(lod.data)
bmesh.ops.triangulate(bm, faces=bm.faces[:])
bm.to_mesh(lod.data)
bm.free()
bend = P.get('bend', {})
for o in (obj, lod):
    c, _ = R.mesh_arrays(o)
    set_coords(o, bend_coords(c, bend, W))
smart_uv(lod, smooth_it=int(P.get('uv_smooth', 60)), ring=P.get('skirt_mode', 'bottom') == 'loop')
lod_tris = R.tri_count(lod)
R.log('lod0 tris', lod_tris, '(decimated', dec_tris, '+ skirt quads', nsk, ')')

co, _ = R.mesh_arrays(obj)
mn, mx = co.min(0), co.max(0)
lco, _ = R.mesh_arrays(lod)
lmn, lmx = lco.min(0), lco.max(0)
H = float(mx[2])
meta = dict(name=piece_name, scan=P['scan'], use=P.get('use', ''), bend=bend, width_flat=W,
            face_width=float(mx[0] - mn[0]), top_height=H, hi_tris=hi_tris, lod0_tris=lod_tris,
            bbox_min=lmn.tolist(), bbox_max=lmx.tolist(), z_base_scan=z_base, y_face_scan=y_face, rot2=rot2)
json.dump(meta, open(f'{WORK}/{piece_name}.json', 'w'), indent=1)
bpy.ops.wm.save_as_mainfile(filepath=f'{WORK}/{piece_name}.blend', compress=False)
R.log('saved', f'{WORK}/{piece_name}.blend', 'bbox', lmn.round(2), lmx.round(2))
