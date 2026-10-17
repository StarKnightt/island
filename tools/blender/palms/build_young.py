"""
README: juvenile coconut palms -> public/assets/veg/palms/coconut_young.glb (3 variants x 2 LODs)

  bash c:/Code/island/tools/heavy.sh palms E:/blender/blender-5.1.2-windows-x64/blender.exe --background \
       --factory-startup -t 6 --python c:/Code/island/tools/blender/palms/build_young.py
  then optimise build/coconut_young_raw.glb with tools/optimize-glb.ts (see build_coconut.py).

  coconut_young_a : sprouting nut lying on the sand, 3 small fronds 0.5-0.9 m
  coconut_young_b : trunkless young palm, 8 fronds from a ground bulb, ~2.4 m tall
  coconut_young_c : 4 m palm with a 1.3 m trunk, 12 fronds
Same materials and atlases as coconut.glb (palm_bark / palm_frond / palm_nut). Nodes coconut_young_<v>_lod<0|1>.
COLOR_0 as in coconut.glb (AO, bend G from 0 at the ground, flutter B, phase A per frond).
"""
import sys, os, math, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import bpy
from palm_layout import *
from palm_geo import *
import palm_blender as pb

OUT = 'E:/tmp/island/helpers/palms/build'
GOLD = math.radians(137.508)
T0 = time.time()


def log(*a):
    print(f'[young {time.time() - T0:6.1f}s]', *a, flush=True)


def bulb(mb, C, A, radius, prof, sides, phase, g, rng, region=None):
    """lathe of the fibre region around axis A through C: prof = [(height, radius factor), ...]"""
    if region is None:
        f0, f1 = FIBRE_ROWS
        region = (f0 + 4, f1 - 4)
    side_v = nrm(np.cross(A, [0.3, 1.0, 0.1]))
    side_w = np.cross(A, side_v)
    rings = []
    for h, rf in prof:
        ring = []
        for j in range(sides):
            th = 2 * math.pi * j / sides
            rr = radius * rf * (1 + rng.uniform(-0.05, 0.05))
            ring.append(mb.v(C + A * h + rr * (math.cos(th) * side_v + math.sin(th) * side_w), g, 0.0, phase))
        rings.append(ring)
    vs = [(region[0] + (region[1] - region[0]) * i / (len(prof) - 1)) / BARK_H for i in range(len(prof))]
    for i in range(len(prof) - 1):
        for j in range(sides):
            j1 = (j + 1) % sides
            u0, u1 = j / sides, (j + 1) / sides
            mb.f((rings[i][j], rings[i][j1], rings[i + 1][j1], rings[i + 1][j]), ((u0, vs[i]), (u1, vs[i]), (u1, vs[i + 1]), (u0, vs[i + 1])), BARK)
    top = mb.v(C + A * (prof[-1][0] + 0.02), g, 0.0, phase)
    for j in range(sides):
        j1 = (j + 1) % sides
        mb.f((rings[-1][j], rings[-1][j1], top), ((j / sides, vs[-1]), ((j + 1) / sides, vs[-1]), (j / sides, vs[-1])), BARK)


def ground_roots(mb, C, radius, rng, n, phase, z0=0.03):
    b0, b1 = BOLE_ROWS
    for i in range(n):
        th = rng.uniform(0, 2 * math.pi)
        d0 = np.array([math.cos(th), math.sin(th), 0.0])
        q = C + d0 * radius * 0.9 + UP * rng.uniform(0.0, z0)
        d = nrm(d0 - UP * rng.uniform(0.6, 1.5))
        ln = rng.uniform(0.08, 0.2)
        rr = rng.uniform(0.006, 0.012)
        pts = [q, q + d * ln * 0.5, q + d * ln - UP * ln * 0.3]
        u0 = rng.uniform(0, 0.9)
        tube(mb, pts, [rr, rr * 0.85, rr * 0.6], 4, (u0, u0 + 0.06, (b0 + 8) / BARK_H, (b0 + 70) / BARK_H), [0, 0, 0], phase)


def rosette(C, A, n, lf, rng, elev=(78, 22), droop=(25, 95), r_att=0.12, h_span=0.25, g0=0.05, small=False, dead=0,
            leaflet_frac=(0.22, 0.25), seedling=False):
    e1 = nrm(np.cross(A, [0.0, 1.0, 0.0]))
    e2 = np.cross(A, e1)
    phi0 = rng.uniform(0, 2 * math.pi)
    fronds = []
    for i in range(n):
        r = i / max(1, n - 1)
        ang = phi0 + i * GOLD + rng.uniform(-0.15, 0.15)
        az = math.cos(ang) * e1 + math.sin(ang) * e2
        h = h_span * (1 - r) - 0.05
        young = i == 0
        fr = Frond(C + A * h + az * r_att, az, A, lerp(*elev, r ** 0.8) + rng.uniform(-6, 6),
                   lerp(*lf, rng.random()) * (0.65 if young else 1.0) * (0.75 + 0.25 * smoothstep(0, 0.4, r)),
                   lerp(*droop, r ** 0.7) + rng.uniform(-10, 10), np.random.default_rng(int(rng.integers(1 << 30))),
                   kind='young' if young else 'green', lateral=rng.uniform(-15, 15), twist=rng.uniform(-30, 30) * (0.3 + r),
                   alpha=lerp(42, 10, r) + rng.uniform(-5, 5), beta=lerp(12, 55, r) + rng.uniform(-8, 8),
                   theta=(rng.uniform(62, 72), rng.uniform(50, 58), rng.uniform(32, 40)) if not young else (34, 26, 18),
                   droop_exp=rng.uniform(1.1, 1.5), phase=float(rng.random()), g0=g0,
                   rows=('green1', 'green2') if rng.random() < 0.5 else ('green2', 'green1'),
                   leaflet_frac=rng.uniform(*leaflet_frac), petiole=rng.uniform(0.14, 0.2), width0=0.03 if small else 0.05,
                   slot_step=2)
        if seedling:
            # first leaves of a seedling: narrow pleated blades (leaflets still folded together), pale green
            fr = Frond(C + A * h + az * r_att, az, A, lerp(84, 58, r) + rng.uniform(-5, 5), lerp(*lf, rng.random()),
                       lerp(10, 45, r) + rng.uniform(-6, 6), np.random.default_rng(int(rng.integers(1 << 30))),
                       kind='young', lateral=rng.uniform(-10, 10), twist=rng.uniform(-40, 40), alpha=rng.uniform(35, 45),
                       beta=rng.uniform(6, 14), theta=(32, 25, 15), droop_exp=1.4, phase=float(rng.random()), g0=g0,
                       rows=('young', 'young'), leaflet_frac=rng.uniform(0.2, 0.24), petiole=rng.uniform(0.18, 0.24),
                       width0=0.018, slot_step=2)
        fronds.append(fr)
    for j in range(dead):
        ang = rng.uniform(0, 2 * math.pi)
        az = math.cos(ang) * e1 + math.sin(ang) * e2
        fr = Frond(C + A * (-0.06) + az * r_att, az, A, rng.uniform(-5, 10), lerp(*lf, rng.random()) * 0.9, rng.uniform(50, 80),
                   np.random.default_rng(int(rng.integers(1 << 30))), kind='dead', lateral=rng.uniform(-25, 25),
                   twist=rng.uniform(-60, 60), alpha=rng.uniform(-10, 10), beta=rng.uniform(50, 80),
                   theta=(52, 42, 28), droop_exp=1.2, phase=float(rng.random()), g0=g0, rows=('dead', 'dead'),
                   leaflet_frac=0.2, petiole=0.16, width0=0.04, slot_step=2)
        fronds.append(fr)
    return fronds


def build_variant(v, lod):
    mb = MeshBuilder()
    if v == 'a':
        rng = np.random.default_rng(71)
        # husk lying on its side, half sunk, sprouting from the stalk end
        ax = nrm(np.array([1.0, 0.25, 0.18]))
        nut_c = np.array([0.0, 0.0, 0.07])
        ovoid(mb, nut_c, ax, 0.31, 0.25, 2, 0.02, 0.1, lod, np.random.default_rng(5), segs=(6, 11) if lod == 0 else (2, 6))
        sprout = nut_c + ax * 0.13 + UP * 0.08
        A = nrm(UP + ax * 0.15)
        bulb(mb, sprout - UP * 0.05, A, 0.035, [(0, 1.0), (0.06, 1.15), (0.14, 0.9), (0.2, 0.4)], 6 if lod == 0 else 4, 0.3, 0.02, rng)
        if lod == 0:
            ground_roots(mb, nut_c - ax * 0.04 - UP * 0.06, 0.06, rng, 4, 0.1, z0=0.0)
        fronds = rosette(sprout + UP * 0.08, A, 3, (0.55, 0.85), rng, elev=(82, 45), droop=(15, 55), r_att=0.02, h_span=0.08,
                         g0=0.05, small=True, leaflet_frac=(0.2, 0.23), seedling=True)
        for fr in fronds:
            fr.build(mb, lod)
    elif v == 'b':
        rng = np.random.default_rng(72)
        C = np.array([0.0, 0.0, 0.05])
        A = nrm(UP + np.array([0.06, 0.02, 0.0]))
        bulb(mb, np.array([0, 0, -0.2]), A, 0.15, [(0, 0.95), (0.15, 1.05), (0.26, 1.1), (0.36, 0.92), (0.44, 0.6), (0.5, 0.25)],
             10 if lod == 0 else 6, 0.4, 0.02, rng)
        if lod == 0:
            ground_roots(mb, np.array([0, 0, 0.0]), 0.16, rng, 14, 0.4)
        fronds = rosette(C + A * 0.18, A, 8, (1.9, 2.6), rng, elev=(80, 18), droop=(25, 100), r_att=0.1, h_span=0.14,
                         g0=0.05, dead=1)
        for fr in fronds:
            fr.build(mb, lod)
    else:
        rng = np.random.default_rng(73)
        P = dict(seed=31, height=1.35, lean=('curve', 12, 5, 1.2), side=(2.0, 0.5, 0.8), wobble=0.6, r_low=0.17,
                 r_top=0.155, r_bole=0.24)
        tr = Trunk(P, np.random.default_rng(31))
        build_trunk(mb, tr, lod, 0.6, g_top=0.15)
        C, A, r_top = build_crown_base(mb, tr, lod, 0.6, np.random.default_rng(34), g_top=0.15)
        if lod == 0:
            build_root_stubs(mb, tr, np.random.default_rng(35), 0.6, n=18)
        fronds = rosette(C + A * 0.25, A, 12, (2.5, 3.3), rng, elev=(80, -5), droop=(28, 110), r_att=r_top * 0.95, h_span=0.55,
                         g0=0.15, dead=2)
        for fr in fronds:
            fr.build(mb, lod)
    return mb, fronds


def main():
    pb.reset_scene()
    mats = pb.palm_materials()
    alpha = pb.frond_alpha_small()
    infos = []
    for v in 'abc':
        mbs, fr_sets = zip(*[build_variant(v, lod) for lod in range(2)])
        baker = pb.AOBaker(mbs[0], alpha)
        for lod, mb in enumerate(mbs):
            ao = pb.ao_remap(baker.bake(mb, nrays=36, seed=lod + 1))
            pb.mesh_object(f'coconut_young_{v}_lod{lod}', mb, mats, ao)
        co = np.array(mbs[0].co)
        pts = np.vstack([f.pts for f in fr_sets[0]])
        info = dict(name=f'coconut_young_{v}', tris=[mb.tri_count() for mb in mbs], height_m=round(float(co[:, 2].max()), 2),
                    radius_m=round(float(np.max(np.linalg.norm(pts[:, :2], axis=1))), 2), fronds=len(fr_sets[0]))
        infos.append(info)
        log(json.dumps(info))
    pb.export_glb(f'{OUT}/coconut_young_raw.glb')
    with open(f'{OUT}/coconut_young_info.json', 'w') as f:
        json.dump(infos, f, indent=1)
    bpy.ops.wm.save_as_mainfile(filepath=f'{OUT}/coconut_young.blend')
    log('exported')


main()
