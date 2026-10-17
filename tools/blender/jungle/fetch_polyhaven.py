"""Download the CC0 Poly Haven sources used by the jungle assets into E:/tmp/island/raw/jungle (idempotent).

    python tools/blender/jungle/fetch_polyhaven.py
"""
import json
import os
import sys
import urllib.request

RAW = 'E:/tmp/island/raw/jungle'
API = 'https://api.polyhaven.com'

TEXTURES = {
    # id: (resolution, [maps])
    'chinese_hackberry_bark': ('2k', ['Diffuse', 'nor_gl', 'Rough', 'Displacement', 'AO']),
    'japanese_hackberry_bark': ('2k', ['Diffuse', 'nor_gl', 'Rough', 'Displacement', 'AO']),
}
MODELS = {
    'potted_plant_02': '2k',
    'fern_02': '2k',
    'calathea_orbifolia_01': '2k',
    'anthurium_botany_01': '2k',
    'dead_tree_trunk_02': '2k',
    'root_cluster_01': '2k',
    'moss_01': '2k',
}
HDRIS = {'kloofendal_48d_partly_cloudy_puresky': '2k'}
EXTRA_MAPS = {  # separate alpha masks of the plant scans (the glTF variants reference JPG albedo without alpha)
    'fern_02': ('2k', ['Alpha']),
    'calathea_orbifolia_01': ('2k', ['Alpha']),
    'anthurium_botany_01': ('2k', ['Alpha']),
    'potted_plant_02': ('2k', ['leaves_alpha']),
}


def get(url, dst):
    if os.path.exists(dst) and os.path.getsize(dst) > 0:
        return
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + '.part'
    req = urllib.request.Request(url, headers={'User-Agent': 'island-jungle-helper/1.0'})
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, 'wb') as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
    os.replace(tmp, dst)
    print('got', dst, os.path.getsize(dst))


def files(asset):
    req = urllib.request.Request(f'{API}/files/{asset}', headers={'User-Agent': 'island-jungle-helper/1.0'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode('utf-8'))


def info(asset):
    req = urllib.request.Request(f'{API}/info/{asset}', headers={'User-Agent': 'island-jungle-helper/1.0'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode('utf-8'))


def main():
    meta = {}
    for tid, (res, maps) in TEXTURES.items():
        fl = files(tid)
        for m in maps:
            ent = fl[m][res]
            fmt = 'png' if m in ('nor_gl', 'Displacement') and 'png' in ent else 'jpg'
            url = ent[fmt]['url']
            get(url, f'{RAW}/tex/{tid}/{os.path.basename(url)}')
        meta[tid] = info(tid)
    for mid, res in MODELS.items():
        fl = files(mid)
        g = fl['gltf'][res]['gltf']
        base = f'{RAW}/models/{mid}'
        get(g['url'], f'{base}/{os.path.basename(g["url"])}')
        for rel, ent in g.get('include', {}).items():
            get(ent['url'], f'{base}/{rel}')
        meta[mid] = info(mid)
    for mid, (res, maps) in EXTRA_MAPS.items():
        fl = files(mid)
        for m in maps:
            url = fl[m][res]['png']['url']
            get(url, f'{RAW}/models/{mid}/textures/{os.path.basename(url)}')
    for hid, res in HDRIS.items():
        fl = files(hid)
        url = fl['hdri'][res]['hdr']['url']
        get(url, f'{RAW}/hdri/{os.path.basename(url)}')
        meta[hid] = info(hid)
    with open(f'{RAW}/meta.json', 'w', encoding='utf-8') as f:
        json.dump({k: {'name': v.get('name'), 'authors': v.get('authors'), 'dimensions': v.get('dimensions')} for k, v in meta.items()}, f, indent=1)
    print('done')


if __name__ == '__main__':
    sys.exit(main())
