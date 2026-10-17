#!/usr/bin/env bash
# Optimise the Poly Haven prop models (raw glTF in E:\tmp\island\raw) into game GLBs (KTX2 + meshopt).
# One model at a time (the encoder is single-threaded); usage: bash tools/build-props.sh
set -e
cd "$(dirname "$0")/.."
RAW="E:/tmp/island/raw/polyhaven/models"
OUT="public/assets/props"
mkdir -p "$OUT"
# id  max-texture  simplify-ratio
while read -r id tex simp; do
  [ -z "$id" ] && continue
  if [ -f "$OUT/$id.glb" ]; then echo "skip $id"; continue; fi
  args=(--maxtex "$tex" --noanim)
  if [ "$simp" != "0" ]; then args+=(--simplify "$simp"); fi
  pnpm exec tsx tools/optimize-glb.ts "$RAW/$id/$id.gltf" "$OUT/$id.glb" "${args[@]}" 2>&1 | grep -E "wrote|Error" || true
done <<'EOF'
wooden_crate_01 512 0
wooden_crate_02 512 0
wooden_barrels_01 512 0.5
wooden_bucket_01 512 0
wicker_basket_01 512 0.4
ocean_buoy 512 0.5
lifebuoy 512 0.5
wooden_lantern_01 512 0.4
folding_wooden_stool 512 0
painted_wooden_bench 512 0
fishermans_hat 256 0.5
lambis_shell 256 0.5
bananas 256 0.15
boulder_01 1024 0.08
rock_moss_set_01 1024 0.3
namaqualand_boulder_05 1024 0.1
fern_02 512 0.5
anthurium_botany_01 512 0.6
EOF
echo done
