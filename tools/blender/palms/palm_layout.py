"""Texture atlas layout shared by make_textures.py and the geometry builders (UV regions in Blender UV space:
u right, v up, 0..1). Both scripts import this, so the painted leaflets and the card UVs always agree."""
import math

# ---------------------------------------------------------------- bark / fibre / nut atlas (1024 x 2048)
BARK_W, BARK_H = 1024, 2048
BOLE_ROWS = (0, 384)          # root collar band: roots at the bottom, bark at the top that continues into the tile
TILE_ROWS = (384, 1408)       # bark tile, seamless vertically (wraps into itself) and horizontally
GUARD_ROWS = (1408, 1424)     # copy of the first tile rows (stops mip bleeding from the fibre region)
FIBRE_ROWS = (1424, 1792)     # leaf-sheath fibre, seamless horizontally
NUT_ROWS = (1792, 2048)       # 3 coconut colour columns of 256 px + one column with stalk (bottom) and spathe (top)
NUT_COLS = 3                  # green, yellow-green, brown
TILE_LEN_M = 1.25             # trunk length covered by one bark tile (u wraps TILE_WRAPS times around the trunk)
TILE_WRAPS = 2
BOLE_LEN_M = TILE_LEN_M * (BOLE_ROWS[1] - BOLE_ROWS[0]) / (TILE_ROWS[1] - TILE_ROWS[0])


def bark_v(row):
    return row / BARK_H


def nut_region(col):
    """(u0, u1, v0, v1) of coconut colour column col"""
    return (col * 256 / BARK_W, (col + 1) * 256 / BARK_W, bark_v(NUT_ROWS[0]), bark_v(NUT_ROWS[1]))


STALK_REGION = (768 / BARK_W, 1.0, bark_v(NUT_ROWS[0]), bark_v(NUT_ROWS[0] + 128))
SPATHE_REGION = (768 / BARK_W, 1.0, bark_v(NUT_ROWS[0] + 128), bark_v(NUT_ROWS[1]))

# ---------------------------------------------------------------- frond atlas (2048 x 2048)
FROND_W, FROND_H = 2048, 2048
N_SLOTS = 16                  # leaflet-group cards per wing in LOD0 (slot boundaries are kept free of leaflets)
# rows: name -> (row0, row1, leaflet length in metres that the full row height stands for at the reference frond)
ROWS = {
    'green1': (0, 512),
    'green2': (512, 1024),
    'old':    (1024, 1376),
    'dead':   (1376, 1728),
    'young':  (1728, 1984),
}
RACHIS_ROWS = {'green': (1984, 2005), 'old': (2005, 2026), 'dead': (2026, 2048)}


def slot_bounds(k):
    """u range of slot k (0 = frond base end)"""
    return (round(k * FROND_W / N_SLOTS) / FROND_W, round((k + 1) * FROND_W / N_SLOTS) / FROND_W)


def row_v(name):
    r0, r1 = ROWS[name]
    return r0 / FROND_H, r1 / FROND_H


def rachis_v(name):
    r0, r1 = RACHIS_ROWS[name]
    return (r0 + 2) / FROND_H, (r1 - 2) / FROND_H


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def envelope(kind, u):
    """leaflet length (fraction of the row height) for a leaflet rooted at u (0 = base end, 1 = tip of the
    leaflet-bearing rachis). The painted leaflets never exceed it; the cards and wings are cut to it."""
    if kind == 'young':
        e = 0.55 + 0.45 * smoothstep(0.0, 0.3, u)
        e *= 1.0 - 0.72 * smoothstep(0.45, 1.0, u) ** 1.3
        return max(0.16, min(1.0, e))
    e = 0.5 + 0.5 * smoothstep(0.0, 0.33, u)
    e *= 1.0 - 0.80 * smoothstep(0.48, 1.0, u) ** 1.25
    return max(0.14, min(1.0, e))


def slot_envelope(kind, k):
    u0, u1 = slot_bounds(k)
    return max(envelope(kind, u0 + (u1 - u0) * f) for f in (0.0, 0.25, 0.5, 0.75, 1.0))
