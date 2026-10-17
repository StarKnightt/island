#!/usr/bin/env bash
# Rebuilds every jungle asset from its sources (deterministic seeds) and writes the optimized GLBs to
# public/assets/veg/jungle/. Run from anywhere:
#
#     bash c:/Code/island/tools/blender/jungle/build_all.sh [stage ...]
#
# Stages, in dependency order (default: all of them):
#   fetch       fetch_polyhaven.py      Poly Haven CC0 sources -> E:/tmp/island/raw/jungle (idempotent, network)
#   bark        build_bark.py           canopy bark texture set (system Python + numpy)
#   leaves      leaf_textures.py        single-leaf texture sheets (system Python + numpy)
#   sprigs      sprig_atlas.py          canopy leaf-cluster atlas (Blender)
#   canopy      canopy.py               canopy_trees_raw.glb -> canopy_trees.glb
#   mid         canopy.py --set mid     midstorey_trees_raw.glb -> midstorey_trees.glb
#   ustex       understory_textures.py  banana / Licuala / taro tiles + understory stem strips (system Python)
#   usatlas     understory_atlas.py     understory leaf + scan atlases (Blender)
#   understory  understory.py           understory_raw.glb -> understory.glb
#   floor       floor.py                litter atlas, log bakes, floor_raw.glb -> floor.glb
#   ledge       ledge.py                ledge atlas, ledge_raw.glb -> ledge.glb
#
# Every heavy step takes the shared lock on its own (tools/heavy.sh), so other jobs can run in between.
# Scratch and raw GLBs: E:/tmp/island/helpers/jungle/{tex,work,glb}. Previews: preview.py (one GLB) and
# scene_preview.py (all GLBs together), see their headers.
set -euo pipefail
REPO=c:/Code/island
J=$REPO/tools/blender/jungle
BL=E:/blender/blender-5.1.2-windows-x64/blender.exe
RAW=E:/tmp/island/helpers/jungle/glb
OUT=$REPO/public/assets/veg/jungle
export PYTHONIOENCODING=utf-8
cd "$REPO"

heavy() { bash "$REPO/tools/heavy.sh" jungle "$@"; }
blend() {
  local script=$1
  shift
  heavy "$BL" --background --factory-startup -t 6 --python-exit-code 1 --python "$J/$script" -- "$@"
}
opt() {
  heavy pnpm --dir "$REPO" exec tsx tools/optimize-glb.ts "$RAW/$1_raw.glb" "$OUT/$1.glb" \
    --maxtex 2048 --maxaux 1024 --noanim
}

stages=("$@")
if [ ${#stages[@]} -eq 0 ]; then
  stages=(fetch bark leaves sprigs canopy mid ustex usatlas understory floor ledge)
fi
for s in "${stages[@]}"; do
  echo "== jungle build: $s"
  case $s in
    fetch) python "$J/fetch_polyhaven.py" ;;
    bark) heavy python "$J/build_bark.py" ;;
    leaves) heavy python "$J/leaf_textures.py" ;;
    sprigs) blend sprig_atlas.py ;;
    canopy) blend canopy.py && opt canopy_trees ;;
    mid) blend canopy.py --set mid && opt midstorey_trees ;;
    ustex) heavy python "$J/understory_textures.py" ;;
    usatlas) blend understory_atlas.py ;;
    understory) blend understory.py && opt understory ;;
    floor) blend floor.py && opt floor ;;
    ledge) blend ledge.py && opt ledge ;;
    *) echo "unknown stage: $s" >&2; exit 2 ;;
  esac
done
