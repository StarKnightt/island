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
| Namaqualand Boulder 05 | Jenelle van Heerden (modeling), Dario Barresi (photography) | [namaqualand_boulder_05](https://polyhaven.com/a/namaqualand_boulder_05) | sea-cliff, coast and falls boulders, tinted to basalt |
| Rock Moss Set 01 | Kless Gyzen | [rock_moss_set_01](https://polyhaven.com/a/rock_moss_set_01) | rocks on slopes, by the pool and on the jungle floor |
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
