"""
README: coconut palms (Cocos nucifera) for the island, 6 variants x 3 LODs -> public/assets/veg/palms/coconut.glb

  1. textures (once):  bash c:/Code/island/tools/heavy.sh palms E:/blender/blender-5.1.2-windows-x64/blender.exe \
                         --background --factory-startup -t 6 --python c:/Code/island/tools/blender/palms/make_textures.py
  2. geometry + GLB:   bash c:/Code/island/tools/heavy.sh palms E:/blender/blender-5.1.2-windows-x64/blender.exe \
                         --background --factory-startup -t 6 --python c:/Code/island/tools/blender/palms/build_coconut.py -- [a b ...]
     writes E:/tmp/island/helpers/palms/build/coconut_raw.glb (+ coconut_<v>_raw.glb when a subset is given) and
     build/coconut_info.json (crown heights / radii, trunk base radii, triangle counts)
  3. optimise:         bash c:/Code/island/tools/heavy.sh palms pnpm --dir c:/Code/island exec tsx tools/optimize-glb.ts \
                         E:/tmp/island/helpers/palms/build/coconut_raw.glb public/assets/veg/palms/coconut.glb --maxtex 2048 --maxaux 1024 --noanim
  4. previews:         render_preview.py (same lock wrapper)

Nodes coconut_<a..f>_lod<0..2>, materials palm_bark / palm_frond / palm_nut. Blender Z-up is exported as glTF Y-up;
every palm leans toward +X. COLOR_0 = (AO, bend G, flutter B, phase A). Deterministic seeds per variant.
"""
import sys, os, math, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import bpy
from palm_layout import *
from palm_geo import *
import palm_blender as pb

OUT = 'E:/tmp/island/helpers/palms/build'
os.makedirs(OUT, exist_ok=True)
GOLD = math.radians(137.508)
T0 = time.time()


def log(*a):
    print(f'[coconut {time.time() - T0:6.1f}s]', *a, flush=True)


VARIANTS = {
    # lean: ('curve', base deg, top deg, exponent) or ('scurve', base, mid, top); side: (deg, cycles, phase)
    'a': dict(seed=101, height=9.0, lean=('curve', 36, 9, 1.6), side=(3.0, 0.6, 0.3), wobble=1.2,
              r_low=0.235, r_top=0.158, r_bole=0.36, fronds=26, dead=3, lf=(4.3, 5.0), clusters=[10, 7], infl=1, old=1),
    'b': dict(seed=202, height=11.5, lean=('curve', 15, 4, 1.4), side=(2.5, 0.5, 1.7), wobble=1.0,
              r_low=0.24, r_top=0.155, r_bole=0.37, fronds=28, dead=4, lf=(4.5, 5.4), clusters=[12, 8, 5], infl=2, old=2),
    'c': dict(seed=303, height=13.5, lean=('curve', 40, 6, 1.9), side=(4.0, 0.7, 2.2), wobble=1.3,
              r_low=0.23, r_top=0.15, r_bole=0.37, fronds=24, dead=2, lf=(4.1, 4.9), clusters=[13], infl=1, old=1),
    'd': dict(seed=404, height=15.5, lean=('scurve', 17, -7, 5), side=(3.0, 0.9, 0.9), wobble=1.0,
              r_low=0.235, r_top=0.148, r_bole=0.35, fronds=27, dead=5, lf=(4.2, 5.2), clusters=[8, 11], infl=1, old=2),
    'e': dict(seed=505, height=18.5, lean=('curve', 10, 2, 1.3), side=(2.0, 0.6, 2.9), wobble=0.9,
              r_low=0.22, r_top=0.14, r_bole=0.35, fronds=23, dead=3, lf=(3.9, 4.7), clusters=[6, 14], infl=1, old=1),
    'f': dict(seed=606, height=22.0, lean=('curve', 3.5, 1.0, 1.0), side=(1.5, 1.1, 0.2), wobble=0.8,
              r_low=0.215, r_top=0.135, r_bole=0.34, fronds=26, dead=4, lf=(4.0, 4.8), clusters=[9, 5, 12], infl=2, old=1),
}


def plan_crown(P, tr):
    """all frond / bunch parameters of one palm (shared by every LOD)"""
    rng = np.random.default_rng(P['seed'] * 31 + 7)
    C, A = crown_axis(tr)
    r_top = tr.radius(tr.L)
    e1 = nrm(np.cross(A, [0.0, 1.0, 0.0]))
    e2 = np.cross(A, e1)
    azv = lambda ang: math.cos(ang) * e1 + math.sin(ang) * e2
    N = P['fronds']
    phi0 = rng.uniform(0, 2 * math.pi)
    fronds, ranks = [], []
    for i in range(N):
        r = i / (N - 1)
        ang = phi0 + i * GOLD + rng.uniform(-0.12, 0.12)
        az = azv(ang)
        h = 0.40 - 0.95 * r ** 0.85 + rng.uniform(-0.03, 0.03)
        base = C + A * h + az * r_top * (0.95 if h > -0.25 else 0.85)
        young = r < 0.09
        old = i >= N - P['old']
        elev = lerp(80, -10, r ** 0.7) + rng.uniform(-6, 6)
        length = lerp(*P['lf'], rng.random()) * (0.5 + 0.5 * smoothstep(0, 0.25, r)) * (0.94 if r > 0.85 else 1.0)
        droop = lerp(25, 118, r ** 0.55) + rng.uniform(-10, 10)
        if old:
            droop += 10
        theta = (rng.uniform(70, 80), rng.uniform(58, 66), rng.uniform(36, 44))
        if young:
            theta = tuple(x * 0.6 for x in theta)
        rows = ('green1', 'green2') if rng.random() < 0.5 else ('green2', 'green1')
        fr = Frond(base, az, A, elev, length, droop, np.random.default_rng(int(rng.integers(1 << 30))),
                   kind='young' if young else ('old' if old else 'green'),
                   lateral=rng.uniform(-14, 14), twist=rng.uniform(-35, 35) * (0.3 + r),
                   alpha=lerp(45, 8, r) + rng.uniform(-6, 6), beta=lerp(14, 62, r ** 0.9) + rng.uniform(-8, 8),
                   theta=theta, droop_exp=rng.uniform(1.05, 1.5), phase=float(rng.random()), g0=0.3, rows=rows,
                   leaflet_frac=rng.uniform(0.22, 0.25), petiole=rng.uniform(0.12, 0.16), width0=rng.uniform(0.075, 0.09))
        fr.rank, fr.h, fr.ang = r, h, ang
        fronds.append(fr)
    # spear leaf: newest, still folded, almost vertical
    ang = phi0 - GOLD
    spear = Frond(C + A * 0.5, azv(ang), A, 87, rng.uniform(1.5, 2.1), 5, np.random.default_rng(int(rng.integers(1 << 30))),
                  kind='spear', lateral=rng.uniform(-6, 6), twist=rng.uniform(-20, 20), alpha=80, beta=3, theta=(9, 7, 4),
                  droop_exp=1.5, phase=float(rng.random()), g0=0.3, rows=('young', 'young'), leaflet_frac=0.13,
                  petiole=0.12, width0=0.05)
    spear.rank, spear.h, spear.ang = -0.1, 0.5, ang
    fronds.insert(0, spear)
    # dead fronds hanging under the crown
    for j in range(P['dead']):
        ang = rng.uniform(0, 2 * math.pi)
        az = azv(ang)
        h = rng.uniform(-0.88, -0.62)
        steep = rng.random() < 0.7
        elev = rng.uniform(-78, -58) if steep else rng.uniform(-45, -30)
        broken = (rng.uniform(0.3, 0.6), rng.uniform(35, 70)) if rng.random() < 0.35 else None
        fr = Frond(C + A * h + az * r_top * 1.0, az, A, elev, rng.uniform(3.3, 4.6), rng.uniform(8, 22),
                   np.random.default_rng(int(rng.integers(1 << 30))), kind='dead', lateral=rng.uniform(-25, 25),
                   twist=rng.uniform(-70, 70), alpha=rng.uniform(-12, 12), beta=rng.uniform(50, 80),
                   theta=(rng.uniform(48, 60), rng.uniform(38, 48), rng.uniform(24, 32)), droop_exp=1.3, broken=broken,
                   phase=float(rng.random()), g0=0.3, rows=('dead', 'dead'), leaflet_frac=rng.uniform(0.19, 0.22),
                   petiole=rng.uniform(0.14, 0.2), width0=0.07)
        fr.rank, fr.h, fr.ang = 1.2, h, ang
        fronds.append(fr)
    # coconut bunches in the axils of mature fronds, flower stalks higher up
    mature = [f for f in fronds if f.kind == 'green' and 0.35 <= f.rank <= 0.78]
    rng.shuffle(mature)
    bunches = []
    for c, n in enumerate(P['clusters']):
        f = mature[c % len(mature)]
        bunches.append(dict(az=azv(f.ang + rng.uniform(-0.25, 0.25)), n=n, h=f.h - 0.12, seed=int(rng.integers(1 << 30)),
                            brown=0.1 + 0.25 * f.rank, phase=float(rng.random())))
    upper = [f for f in fronds if f.kind == 'green' and 0.15 <= f.rank <= 0.4]
    rng.shuffle(upper)
    infl = []
    for c in range(P['infl']):
        f = upper[c % len(upper)]
        infl.append(dict(az=azv(f.ang + rng.uniform(-0.3, 0.3)), h=f.h - 0.08, seed=int(rng.integers(1 << 30)), phase=float(rng.random())))
    return dict(C=C, A=A, r_top=r_top, fronds=fronds, bunches=bunches, infl=infl, trunk_phase=float(rng.random()))


def build_lod(P, tr, crown, lod):
    mb = MeshBuilder()
    ph = crown['trunk_phase']
    build_trunk(mb, tr, lod, ph)
    C, A, r_top = build_crown_base(mb, tr, lod, ph, np.random.default_rng(P['seed'] + 99))
    for fr in crown['fronds']:
        if lod == 2 and fr.kind in ('spear', 'young') and fr.L < 2.4:
            continue
        fr.build(mb, lod)
    for b in crown['bunches']:
        build_nut_cluster(mb, C, A, r_top * 1.3, b['az'], b['n'], lod, np.random.default_rng(b['seed']), b['phase'],
                          brown_frac=b['brown'], h=b['h'])
    for fl in crown['infl']:
        if lod < 2:
            build_inflorescence(mb, C, A, r_top * 1.3, fl['az'], lod, np.random.default_rng(fl['seed']), fl['phase'], h=fl['h'])
    if lod == 0:
        build_root_stubs(mb, tr, np.random.default_rng(P['seed'] + 7), ph, n=int(12 + P['seed'] % 5))
    return mb


def palm_info(name, P, tr, crown, mbs):
    C = crown['C']
    co = np.array(mbs[0].co)
    d = np.linalg.norm(co[:, :2] - C[:2], axis=1)
    # crown radius from frond geometry only
    fr_pts = np.vstack([f.pts for f in crown['fronds']])
    cr = float(np.max(np.linalg.norm(fr_pts[:, :2] - C[:2], axis=1)))
    p1, _, _, _ = tr.at(1.0)
    return dict(name=name, crown_height_m=round(float(C[2]), 2), crown_centre_xz_m=[round(float(C[0]), 2), round(float(-C[1]), 2)],
                crown_radius_m=round(cr, 2), top_m=round(float(co[:, 2].max()), 2), lowest_frond_tip_m=round(float(fr_pts[:, 2].min()), 2),
                trunk_length_m=round(tr.L, 2), trunk_radius_ground_m=round(float(tr.radius(0.0)), 3),
                trunk_radius_1m_m=round(float(tr.radius(1.0)), 3), trunk_radius_top_m=round(float(tr.radius(tr.L)), 3),
                trunk_centre_1m_xz=[round(float(p1[0]), 3), round(float(-p1[1]), 3)],
                live_fronds=sum(1 for f in crown['fronds'] if f.kind in ('green', 'old', 'young', 'spear')),
                dead_fronds=sum(1 for f in crown['fronds'] if f.kind == 'dead'),
                nuts=sum(b['n'] for b in crown['bunches']),
                tris=[mb.tri_count() for mb in mbs],
                tris_by_material=[[mb.tri_count(0), mb.tri_count(1), mb.tri_count(2)] for mb in mbs])


def main():
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    names = [a for a in args if a in VARIANTS] or list(VARIANTS)
    no_ao = '--no-ao' in args
    pb.reset_scene()
    mats = pb.palm_materials()
    alpha = pb.frond_alpha_small()
    infos, objs = [], []
    for v in names:
        P = dict(VARIANTS[v])
        tr = Trunk(P, np.random.default_rng(P['seed']))
        crown = plan_crown(P, tr)
        mbs = [build_lod(P, tr, crown, lod) for lod in range(3)]
        log(v, 'built', [mb.tri_count() for mb in mbs])
        baker = None if no_ao else pb.AOBaker(mbs[0], alpha)
        for lod, mb in enumerate(mbs):
            if baker is None:
                ao = np.ones(len(mb.co))
            else:
                vis = baker.bake(mb, nrays={0: 36, 1: 32, 2: 32}[lod], seed=lod + 1)
                ao = pb.ao_remap(vis)
                co = np.array(mb.co)
                kd = np.array(mb.kind)
                above = co[:, 2] > 0.05
                for nm, sel in (('surface', (kd == 0) & above), ('foliage', kd == 1)):
                    if sel.any():
                        q = np.percentile(ao[sel], [5, 25, 50, 75, 95]).round(2)
                        log(v, f'lod{lod} ao {nm}: n={sel.sum()} p5/25/50/75/95 {q}')
            objs.append(pb.mesh_object(f'coconut_{v}_lod{lod}', mb, mats, ao))
        info = palm_info(f'coconut_{v}', P, tr, crown, mbs)
        infos.append(info)
        log(json.dumps(info))
    tag = '' if len(names) == len(VARIANTS) else '_' + ''.join(names)
    path = f'{OUT}/coconut{tag}_raw.glb'
    pb.export_glb(path)
    with open(f'{OUT}/coconut{tag}_info.json', 'w') as f:
        json.dump(infos, f, indent=1)
    bpy.ops.wm.save_as_mainfile(filepath=f'{OUT}/coconut{tag}.blend')
    log('exported', path)


main()
