# Credits

Every third-party asset in this repository, with its author, source and license. All of them allow public use and
redistribution in a public repository: CC0 1.0 (public domain dedication) or MIT. Files in `public/assets/` are
optimized derivatives (resized, KTX2 / Ogg / meshopt re-encoded, albedo-normalized, tinted); the raw downloads are
not in the repository (they live in `E:\tmp\island\raw\`).

Everything else (the island's geography and heightmap, the terrain, sky, atmosphere, clouds, ocean, river and
waterfall shaders, the procedural palms, trees, bushes and grass, the village and lighthouse buildings, boats, nets,
the palm-frond, banana-leaf, palm-bark and grass texture atlases, the loading screen and HUD) is original work made
for this project.

## Character and animation

| Asset | Author | License | Source | Used for |
|---|---|---|---|---|
| Microsoft Rocketbox avatar `Male_Adult_01` (mesh, skin, textures) | Microsoft (Rocketbox Studios) | MIT | [github.com/microsoft/Microsoft-Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox) | the player character (`public/assets/character/hero.glb`, converted with `tools/blender/rocketbox_to_glb.py`) |
| Universal Animation Library (Standard) and Universal Animation Library 2 (Standard) | Quaternius | CC0 1.0 | [quaternius.itch.io/universal-animation-library](https://quaternius.itch.io/universal-animation-library), [quaternius.itch.io/universal-animation-library-2](https://quaternius.itch.io/universal-animation-library-2) | idle, walk, jog, sprint, jump, fall, land, swim and tread clips, retargeted onto the Rocketbox skeleton (`tools/retarget.ts`) |

## Textures (Poly Haven, CC0 1.0)

All from [polyhaven.com](https://polyhaven.com) under CC0 1.0. Packed by `scripts/build-assets.ts` into KTX2
(albedo + height, normal + roughness + AO), albedo-normalized to measured target values.

| Texture | Author(s) | Source | Used for |
|---|---|---|---|
| Aerial Beach 01 | Rob Tuytel | [aerial_beach_01](https://polyhaven.com/a/aerial_beach_01) | dry sand (terrain layer) |
| Damp Beach Sand | Dimitrios Savva | [damp_beach_sand](https://polyhaven.com/a/damp_beach_sand) | wet sand, lagoon floor (terrain layer) |
| Leaves Forest Ground | Dario Barresi (processing), Dimitrios Savva (photography) | [leaves_forest_ground](https://polyhaven.com/a/leaves_forest_ground) | jungle floor and leaf litter (terrain layer) |
| Leafy Grass | Charlotte Baglioni | [leafy_grass](https://polyhaven.com/a/leafy_grass) | grass (terrain layer) |
| Dirt Floor | eye-candy.xyz | [dirt_floor](https://polyhaven.com/a/dirt_floor) | laterite trails (terrain layer) |
| Dark Rock 02 | Amal Kumar | [dark_rock_02](https://polyhaven.com/a/dark_rock_02) | basalt cliffs and steep ground (terrain layer) |
| Mossy Rock | Rob Tuytel | [mossy_rock](https://polyhaven.com/a/mossy_rock) | mossy rock in the jungle (terrain layer) |
| Coral Ground 02 | Rob Tuytel | [coral_ground_02](https://polyhaven.com/a/coral_ground_02) | patch reefs in the lagoon (terrain layer) |
| Thatch Roof Angled | Rob Tuytel (processing), Dimitrios Savva (photography) | [thatch_roof_angled](https://polyhaven.com/a/thatch_roof_angled) | village roofs |
| Bamboo Wall | Amal Kumar | [bamboo_wall](https://polyhaven.com/a/bamboo_wall) | hut walls |
| Weathered Planks | Dario Barresi (processing), Dimitrios Savva (photography) | [weathered_planks](https://polyhaven.com/a/weathered_planks) | hut walls |
| Blue Painted Planks | Rob Tuytel | [blue_painted_planks](https://polyhaven.com/a/blue_painted_planks) | painted hut walls |
| Wood Planks Grey | Rob Tuytel | [wood_planks_grey](https://polyhaven.com/a/wood_planks_grey) | floors, jetty decks, steps |
| White Plaster Rough 01 | Rob Tuytel | [white_plaster_rough_01](https://polyhaven.com/a/white_plaster_rough_01) | lighthouse tower |
| Rough Wood | Rob Tuytel | [rough_wood](https://polyhaven.com/a/rough_wood) | posts, stilts, beams, canoe interiors |
| Wood Peeling Paint Weathered | Rob Tuytel (processing), Dimitrios Savva (photography) | [wood_peeling_paint_weathered](https://polyhaven.com/a/wood_peeling_paint_weathered) | packed for painted woodwork (shipped, not used yet in round 1) |
| Rusty Painted Metal | Amal Kumar | [rusty_painted_metal](https://polyhaven.com/a/rusty_painted_metal) | packed for ironwork (shipped, not used yet in round 1) |
| Bark Willow 02 | Charlotte Baglioni | [bark_willow_02](https://polyhaven.com/a/bark_willow_02) | rainforest tree bark |
| Fever Tree Bark | Dimitrios Savva | [fever_tree_bark](https://polyhaven.com/a/fever_tree_bark) | packed for smooth bark (shipped, not used yet in round 1) |
| Stone Wall | Dario Barresi (processing), Charlotte Baglioni (photography) | [stone_wall](https://polyhaven.com/a/stone_wall) | fire-pit stones, lighthouse base |
| Coral Stone Wall | Dimitrios Savva | [coral_stone_wall](https://polyhaven.com/a/coral_stone_wall) | the lighthouse keeper's hut |
| Island Tree 02 (leaf atlas: diffuse, alpha, normal) | Rob Tuytel (scanning, processing), Rico Cilliers (cleanup, processing) | [island_tree_02](https://polyhaven.com/a/island_tree_02) | the leaves cut out and composited into the canopy and bush leaf-cluster cards (`tools/gen_foliage.py`) |

## Models (Poly Haven, CC0 1.0)

Optimized by `tools/optimize-glb.ts` (meshopt geometry, KTX2 textures, simplification where noted in
`tools/build-props.sh`).

| Model | Author(s) | Source | Used for |
|---|---|---|---|
| Namaqualand Boulder 05 | Jenelle van Heerden (modeling), Dario Barresi (photography) | [namaqualand_boulder_05](https://polyhaven.com/a/namaqualand_boulder_05) | round 1 boulders (shipped in `assets/props/`, replaced in round 2 by `assets/rocks/boulders.glb`, see below) |
| Rock Moss Set 01 | Kless Gyzen | [rock_moss_set_01](https://polyhaven.com/a/rock_moss_set_01) | round 1 rocks (shipped in `assets/props/`, replaced in round 2 by `assets/rocks/boulders.glb`) |
| Wooden Crate 01 | James Ray Cock | [wooden_crate_01](https://polyhaven.com/a/wooden_crate_01) | village and jetty clutter |
| Wooden Crate 02 | James Ray Cock (modeling), Jurita Burger (graphic design) | [wooden_crate_02](https://polyhaven.com/a/wooden_crate_02) | village and jetty clutter |
| Wooden Barrels 01 | James Ray Cock | [wooden_barrels_01](https://polyhaven.com/a/wooden_barrels_01) | village and jetty clutter |
| Wooden Bucket 01 | James Ray Cock | [wooden_bucket_01](https://polyhaven.com/a/wooden_bucket_01) | village and jetty clutter |
| Wicker Basket 01 | Kuutti Siitonen | [wicker_basket_01](https://polyhaven.com/a/wicker_basket_01) | fish baskets |
| Ocean Buoy | Mateusz Sadek | [ocean_buoy](https://polyhaven.com/a/ocean_buoy) | buoys in the cove |
| Lifebuoy | Hank Kaamura | [lifebuoy](https://polyhaven.com/a/lifebuoy) | on the main jetty |
| Wooden Lantern 01 | James Ray Cock | [wooden_lantern_01](https://polyhaven.com/a/wooden_lantern_01) | hut and jetty lanterns |
| Folding Wooden Stool | Ulan Cabanilla | [folding_wooden_stool](https://polyhaven.com/a/folding_wooden_stool) | by the fire pit |
| Painted Wooden Bench | Kirill Sannikov | [painted_wooden_bench](https://polyhaven.com/a/painted_wooden_bench) | by the fire pit |
| Fishermans Hat | PierreB3D | [fishermans_hat](https://polyhaven.com/a/fishermans_hat) | on the communal-house bench |
| Fern 02 | Rob Tuytel (scanning), Rico Cilliers (modeling) | [fern_02](https://polyhaven.com/a/fern_02) | optimized for jungle ground cover (shipped, not placed yet in round 1) |
| Anthurium Botany 01 | Rob Tuytel (scanning), Rico Cilliers (modeling) | [anthurium_botany_01](https://polyhaven.com/a/anthurium_botany_01) | optimized for jungle ground cover (shipped, not placed yet in round 1) |
| Lambis Shell | Kuutti Siitonen | [lambis_shell](https://polyhaven.com/a/lambis_shell) | optimized for beach clutter (shipped, not placed yet in round 1) |
| Bananas | Alexander Shulha | [bananas](https://polyhaven.com/a/bananas) | optimized for village clutter (shipped, not placed yet in round 1) |

## Round 2 asset sets made in Blender (`tools/blender/palms`, `jungle`, `rocks`)

Built headless in Blender 5.1.2 by the round-2 asset helpers, then optimized by `tools/optimize-glb.ts`. All geometry
not listed here (palm trunks, fronds, leaflets, coconuts, roots, the rainforest trees, lianas, epiphytes, understory
palms, saplings, litter, the sea-stack bodies, the basalt blocks and rubble) is procedural, own work under the
repository's licence. Every source below is CC0 1.0 from [polyhaven.com](https://polyhaven.com) (raw downloads are not
in the repository).

### Palms and beach plants (`public/assets/veg/palms/`)

| Asset | Author(s) | Source | Used for |
|---|---|---|---|
| Palm Tree Bark (texture) | Dimitrios Savva (photography), Rico Cilliers (processing) | [palm_tree_bark](https://polyhaven.com/a/palm_tree_bark) | coconut trunk bark tile (recoloured, scratch marks removed, ring grooves) |
| Palm Bark (texture) | Charlotte Baglioni | [palm_bark](https://polyhaven.com/a/palm_bark) | leaf-sheath fibre of the palm crown collar |
| Kloofendal 48d Partly Cloudy (Pure Sky) (HDRI) | Greg Zaal (original), Jarod Guest (sky edits) | [kloofendal_48d_partly_cloudy_puresky](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky) | the helpers' preview renders only (not shipped) |

### Rainforest (`public/assets/veg/jungle/`)

| Asset | Author(s) | Source | Used for |
|---|---|---|---|
| Japanese Hackberry Bark (texture) | Charlotte Baglioni | [japanese_hackberry_bark](https://polyhaven.com/a/japanese_hackberry_bark) | base of the rainforest bark atlas (graded, with procedural lichen, moss and soil stain) in `canopy_trees.glb` and `midstorey_trees.glb`; surface roots in `floor.glb` |
| Fern 02 (model) | Rob Tuytel (scan), Rico Cilliers (model) | [fern_02](https://polyhaven.com/a/fern_02) | ground ferns `fern_a`, `fern_b` in `understory.glb` (texture repacked) |
| Calathea Orbifolia 01 (model) | Rob Tuytel (scan), Rico Cilliers (model) | [calathea_orbifolia_01](https://polyhaven.com/a/calathea_orbifolia_01) | `calathea_a/b/c` in `understory.glb` (scaled, decimated LODs) |
| Anthurium Botany 01 (model) | Rob Tuytel (scan), Rico Cilliers (model) | [anthurium_botany_01](https://polyhaven.com/a/anthurium_botany_01) | `anthurium_a/b/c` in `understory.glb` (scaled, decimated LODs) |
| Potted Plant 02 (model) | Rico Cilliers | [potted_plant_02](https://polyhaven.com/a/potted_plant_02) | leaf scan recoloured for the elephant ear `alocasia_a` in `understory.glb` |
| Dead Tree Trunk 02 (model) | Jenelle van Heerden, Rico Cilliers | [dead_tree_trunk_02](https://polyhaven.com/a/dead_tree_trunk_02) | fallen mossy logs `log_a`, `log_b` in `floor.glb` (decimated, re-baked with moss) |

### Cliffs, stacks, boulders and shelves (`public/assets/rocks/`)

Photoscans cropped, bent, decimated and retopologized, full-resolution detail baked into normal and AO maps, albedo
de-lit and re-graded to one shared basalt palette.

| Asset | Author(s) | Source | Used for |
|---|---|---|---|
| Mountainside (scan) | Dario Barresi (photography), Rico Cilliers (processing) | [mountainside](https://polyhaven.com/a/mountainside) | fluted cliff face `cliff_a` (`cliff_kit.glb`) |
| Namaqualand Cliff 02 (scan) | Dario Barresi (photography), Rico Cilliers (modeling) | [namaqualand_cliff_02](https://polyhaven.com/a/namaqualand_cliff_02) | blocky jointed cliff face `cliff_b` |
| Coastal Cliff 01 (scan) | Rob Tuytel (photography, processing), Rico Cilliers (cleanup) | [coastal_cliff_01](https://polyhaven.com/a/coastal_cliff_01) | gully and undercut faces `cliff_e`, `cliff_g` |
| Coastal Cliff 02 (scan) | Rob Tuytel | [coastal_cliff_02](https://polyhaven.com/a/coastal_cliff_02) | sea-cave face and headland nose `cliff_c`, `cliff_d` |
| Coastal Cliff 04 (scan) | Rob Tuytel (photography, processing), Rico Cilliers (cleanup) | [coastal_cliff_04](https://polyhaven.com/a/coastal_cliff_04) | low ledge block `cliff_f`, bedded wave-cut face `cliff_h` |
| Aerial Rocks 02 (texture) | Rob Tuytel | [aerial_rocks_02](https://polyhaven.com/a/aerial_rocks_02) | joint and slab relief, colour of the sea stacks (`stacks.glb`), shore shelves (`shelves.glb`) and basalt blocks (`boulders.glb`) |
| Dark Rock 02 (texture) | Amal Kumar | [dark_rock_02](https://polyhaven.com/a/dark_rock_02) | fine fractured relief, albedo and roughness of the stacks, shelves and basalt blocks |
| Dark Rock (texture) | Amal Kumar | [dark_rock](https://polyhaven.com/a/dark_rock) | albedo variation of the stacks, basalt boulders and pebbles, and shelves |
| Rock 01 (texture) | Rob Tuytel | [rock_01](https://polyhaven.com/a/rock_01) | fine relief and albedo of the granite boulders and beach stones (`boulders.glb`) |
| Rock Surface (texture) | Amal Kumar | [rock_surface](https://polyhaven.com/a/rock_surface) | medium relief and colour variation of the granite boulders |
| Namaqualand Boulder 03 (scan, massing only) | Jenelle van Heerden (modeling), Dario Barresi (photography) | [namaqualand_boulder_03](https://polyhaven.com/a/namaqualand_boulder_03) | jointed granite block `granite_b` (re-sculpted) |
| Namaqualand Boulder 04 (scan, massing only) | Jenelle van Heerden | [namaqualand_boulder_04](https://polyhaven.com/a/namaqualand_boulder_04) | huge granite boulder `granite_d` (re-sculpted) |
| Namaqualand Boulder 05 (scan, massing only) | Jenelle van Heerden (modeling), Dario Barresi (photography) | [namaqualand_boulder_05](https://polyhaven.com/a/namaqualand_boulder_05) | low granite whaleback `granite_a` (re-sculpted) |
| Namaqualand Boulder 06 (scan, massing only) | Greg Zaal (photography), Jenelle van Heerden (modeling) | [namaqualand_boulder_06](https://polyhaven.com/a/namaqualand_boulder_06) | granite loaf boulder `granite_c` (re-sculpted) |

## Sound (CC0 1.0)

Recordings from [freesound.org](https://freesound.org) under CC0 1.0 (fetched by `scripts/fetch-audio.ts`, cut into
loops / one-shots and loudness-matched by `tools/prep_audio.py`).

| Sound | Author | Source | Used for |
|---|---|---|---|
| beach_waves.mp3 | 3bagbrew | [freesound 59564](https://freesound.org/people/3bagbrew/sounds/59564/) | `amb_waves` (shore waves) |
| waves_1.wav | haldigital97 | [freesound 241824](https://freesound.org/people/haldigital97/sounds/241824/) | `amb_surf` (surf on the reef and cliffs) |
| Strong Wind | florianreichelt | [freesound 459981](https://freesound.org/people/florianreichelt/sounds/459981/) | `amb_wind` |
| Jungle, Tropical birds and insects | myrinvp | [freesound 423711](https://freesound.org/people/myrinvp/sounds/423711/) | `amb_birds`, `amb_jungle` |
| Lake at night 1.aif | i_luv_soundz | [freesound 412942](https://freesound.org/people/i_luv_soundz/sounds/412942/) | `amb_night` (insects, frogs) |
| Soft Rain in Forest Raindrops fall on leaves | Borgory | [freesound 678435](https://freesound.org/people/Borgory/sounds/678435/) | `amb_rain` |
| Rain_06.wav | Q.K. | [freesound 56311](https://freesound.org/people/Q.K./sounds/56311/) | `amb_rain_heavy` |
| Rain and Thunder 4 | FlatHill | [freesound 237729](https://freesound.org/people/FlatHill/sounds/237729/) | `thunder_1` |
| Thunder.ogg | lennyboy | [freesound 244053](https://freesound.org/people/lennyboy/sounds/244053/) | `thunder_2` |
| sfx_thunder blast.wav | bajko | [freesound 399656](https://freesound.org/people/bajko/sounds/399656/) | `thunder_3` |
| Waterfall | nsmusic | [freesound 321886](https://freesound.org/people/nsmusic/sounds/321886/) | `amb_waterfall` |
| Small Rocks in a Creek | Hitrison | [freesound 191360](https://freesound.org/people/Hitrison/sounds/191360/) | `amb_stream` (via River Morning's `amb_river_calm`) |
| Wind chimes 1 | giddster | [freesound 437337](https://freesound.org/people/giddster/sounds/437337/) | `amb_chimes` (village) |
| Chicken Alarm Call full with Occasional bird sound | Rudmer_Rotteveel | [freesound 316921](https://freesound.org/people/Rudmer_Rotteveel/sounds/316921/) | `amb_chickens` (village) |
| ship_creak.mp3 | Walter_Odington | [freesound 31574](https://freesound.org/people/Walter_Odington/sounds/31574/) | `amb_creak` (moored boats) |
| Seagull on beach | squashy555 | [freesound 353416](https://freesound.org/people/squashy555/sounds/353416/) | `amb_gulls` |
| Foot_Step_grit_Sand.wav | savataivanov | [freesound 384082](https://freesound.org/people/savataivanov/sounds/384082/) | `step_sand_*` |
| Footsteps Dirt Gravel | PotatokingXII | [freesound 352870](https://freesound.org/people/PotatokingXII/sounds/352870/) | `step_leaves_*` (jungle floor) |
| Stone Steps | Phil25 | [freesound 208103](https://freesound.org/people/Phil25/sounds/208103/) | `step_stone_*` (rock) |
| Footsteps Metallic Muffled Louder.wav | RutgerMuller | [freesound 50724](https://freesound.org/people/RutgerMuller/sounds/50724/) | `step_metal_*` (lighthouse stair) |
| Swimming.wav | 13FPanska_Marval_Lukas | [freesound 379334](https://freesound.org/people/13FPanska_Marval_Lukas/sounds/379334/) | `swim_*` |
| FOOTSTEPS GRASS WALK1 (F).wav | sillygrizzlies | [freesound 635056](https://freesound.org/people/sillygrizzlies/sounds/635056/) | `step_grass_*` (via River Morning) |
| footsteps - gravel 02.wav | Anthousai | [freesound 398777](https://freesound.org/people/Anthousai/sounds/398777/) | `step_gravel_*` (via River Morning) |
| footsteps - wood & stairs 02.wav | Anthousai | [freesound 398781](https://freesound.org/people/Anthousai/sounds/398781/) | `step_wood_*` (jetties, hut floors; via River Morning) |
| Big rock into water at Spfd Lake.wav | williew705 | [freesound 98451](https://freesound.org/people/williew705/sounds/98451/) | `splash_big` (via River Morning) |
| Rock In Water Splash-Plop 3.aif | jc144940 | [freesound 178732](https://freesound.org/people/jc144940/sounds/178732/) | `splash_small` (via River Morning) |

Shallow-water footsteps (`step_water_*`) mix the sand steps (savataivanov) with a burst of the swimming recording
(13FPanska_Marval_Lukas), both credited above.

## Libraries

| Library | License | Source |
|---|---|---|
| three.js (WebGPURenderer, TSL, addons: GLTFLoader, KTX2Loader, CSMShadowNode, GTAO, TRAA, bloom) | MIT | [github.com/mrdoob/three.js](https://github.com/mrdoob/three.js) |
| Basis Universal transcoder (shipped with three.js) | Apache 2.0 | [github.com/BinomialLLC/basis_universal](https://github.com/BinomialLLC/basis_universal) |
| meshoptimizer decoder (shipped with three.js) | MIT | [github.com/zeux/meshoptimizer](https://github.com/zeux/meshoptimizer) |

Build and test tools (not shipped to players): Vite (MIT), TypeScript (Apache 2.0), glTF Transform (MIT),
meshoptimizer (MIT), ktx2-encoder (MIT), sharp (Apache 2.0), Playwright (Apache 2.0), tsx (MIT).
