# Island: builder notes

A realistic open-world tropical island in the browser: Vite + TypeScript + three.js r186 `WebGPURenderer` with TSL
node materials (WebGL 2 fallback through the same renderer). These notes are for whoever builds the next round:
architecture, systems, decisions, the asset pipeline and what is still weak. `TESTING.md` is the critic-facing
document (commands, URL parameters, harness API); `CREDITS.md` lists every third-party asset.

## Layout of the repository

```
src/
  main.ts                 boot order, the per-frame update, authored shot cameras per spot
  core/                   Engine (renderer, post chain, frame cap, GPU timing, manual stepping), Assets (KTX2,
                          meshopt glTF, texture arrays), params (URL), quality (presets), depth (shared scene depth),
                          noise (CPU simplex/fbm/ridged, seeded RNG), tsl (loosely typed TSL re-exports)
  world/                  layout (authored geography: coast, islets, hills, peak, escarpment, river, pool, village,
                          trails, spots), Heightfield (CPU copy + GPU textures of the baked data), Terrain (CDLOD),
                          TerrainMaterial (8-layer splat), Colliders, kit (building kit + PBR material library),
                          Village, Lighthouse, weatherUniforms (shared wetness/wind uniforms)
  water/                  oceanSim (3-cascade FFT on WebGPU compute), Ocean (surface mesh + shading), River (river
                          ribbon, plunge pool, waterfall sheet, mist)
  sky/                    Atmosphere (Hillaire-style LUTs, aerial perspective fog), Sky (sky dome, clouds, stars,
                          moon, environment map), TimeOfDay (sun/moon, light, exposure), Weather (state machine, rain,
                          splashes, lightning)
  veg/                    geometry (procedural palms, rainforest trees, bushes, bananas, grass), Vegetation (instanced
                          species, LODs, culling, wind; rock scans; sea-cliff boulders), Canopy (far forest shell)
  player/                 Input (keyboard/mouse/gamepad/scripted), Player (kinematic controller + animation), CameraRig
  audio/                  Audio (Web Audio ambience layers, positional sources, footsteps, thunder)
  ui/                     Loading screen, Hud, DebugOverlay
  debug/harness.ts        window.__island test API
scripts/                  harness runners (shots, perf, clip, look, poses) and asset builders (build-assets,
                          fetch-audio); lib/browser.ts launches Chrome on the monitor picked from the layout at
                          launch (the primary unless ISLAND_DISPLAY says otherwise)
tools/                    offline bakers: gen-island.ts (heightmap + masks), gen_foliage.py (foliage atlases),
                          retarget.ts (animation retargeting), optimize-glb.ts, build-props.sh, prep_audio.py,
                          blender/rocketbox_to_glb.py
public/world/             baked island data (heights, masks, shore distance, meta.json)
public/assets/            game assets (KTX2 textures, meshopt GLBs, Ogg audio)
```

## The world

* Authored, not noise: `src/world/layout.ts` defines the coastline (Catmull-Rom spline with a "kind" per point: 0
  beach, 1 rock shelf, 2 sea cliff), islets and sea stacks, smooth-max hills, the summit cone (214 m) with the
  lighthouse platform, an escarpment step, an 844 m river with a 20.6 m waterfall into a plunge pool, the village
  cove, six trails, and the named spots. World: 2048 x 2048 m tile, island about 1.7 x 1.1 km.
* `tools/gen-island.ts` (`pnpm gen:island`, ~11 s, deterministic) bakes it: rasterized island mask, exact Euclidean
  distance to the coast, coastal profiles per kind (sand shelf and lagoon with sand waves and patch reefs, rock
  shelves, 50-85 m sea cliffs), domain-warped hills with ridged erosion noise, droplet hydraulic erosion on a 2 m grid,
  the river profile (always falling, carved valley, gorge at the falls), the plunge pool (level below its lowest bank
  so the basin is closed), the levelled village terrace, the lighthouse platform and graded trails (cut/fill with
  max-grade checks). Outputs: 2048^2 heights (delta-coded, gzip), 1024^2 masks (sand, grass, dirt, forest / rock,
  wet, water, coast kind), shore distance, and `meta.json` (river polyline, falls, pool).
* Everything visible is reachable on foot: trails connect the beach, jungle, falls, village, cliffs and summit; the
  lighthouse has an external spiral stair to the gallery.

## Rendering

* **Engine** (`core/Engine.ts`): WebGPU with `powerPreference: 'high-performance'`, raised sampled-texture limits,
  RenderPipeline post chain: scene pass with MRT normals, GTAO, TRAA (temporal AA so foliage does not shimmer), bloom
  (thresholded on the exposed image, so it is the same by day and night), AgX tone mapping, a small colour grade,
  auto-exposure from `TimeOfDay` (metered for open ground, opened up under the canopy at night, held back under a storm
  overcast). Frame cap: an integer divisor of the
  measured refresh rate that keeps >= 60 fps (66.7 fps on the 200 Hz monitor), `?fps=0` uncaps. GPU time from
  timestamp queries; `manual` + `stepOnce` give deterministic fixed-step frames for clips.
* **Terrain**: CDLOD quadtree over the 1 m heightmap with geomorphing; 8 layers (dry sand, wet sand, jungle floor,
  grass, laterite, basalt, mossy rock, reef) from the masks, height-blended, triplanar on rock, per-pixel normals
  from the heightmap; basalt walls get warped strata bands, broken joints, runoff streaks, a 22 m macro sample and a
  derivative bump (surface-gradient) near the camera; wetness (swash band, rain on up-facing ground, puddles), cloud
  shadows and lagoon caustics.
* **Sky and light**: Hillaire 2020-style transmittance and sky-view LUTs re-rendered per frame; aerial perspective
  from the LUT; sun and moon from celestial mechanics at a tropical latitude; a 2D fbm cloud layer with self-shadow,
  coverage and thickness driven by the weather; stars and a moon disc at night; the environment map (PMREM, 128) is
  re-rendered when the sun moves or every 2.5 s; its lower hemisphere is a neutral ground bounce (sun + sky on an
  albedo of ~0.12). Cascaded shadow maps (`CSMShadowNode`, 3 cascades on High, practical split, fade; the near
  cascade every frame, the other two alternating).
* **Ocean**: three FFT cascades (WebGPU compute, packed IFFT) with Jacobian foam history; a camera-following polar
  grid; shallow-water damping by depth; a scripted breaker and swash model along beaches (from the shore-distance
  texture); refraction of the bed through Beer-Lambert absorption; turquoise shallows to deep blue by depth; foam
  (whitecaps, surf, trails, swash lace); sun glitter and sky reflection from the shared environment; rain ripples.
* **Fresh water**: river ribbon with flow-scrolled ripples and riffle foam; the plunge pool (tea-green absorption, a
  dark "surround" reflection instead of sky at low angles, churn foam under the falls, edges feathered into the
  outflow); the falls are a parabolic sheet with streaming, accelerating streaks; mist sprites lit by the scene
  illuminance (`atmo.lightE`).
* **Vegetation**: procedural species (4 coconut palm variants, young palms, 3 rainforest trees, 2 bushes, bananas, 2
  grass clumps), ~550k instances placed from the masks; per-species LOD tiers; a 32 m cell grid culled on the CPU
  every few frames (frustum + distance; near cells always kept so shadows land in view); wind bend + leaf flutter in
  world space; leaf translucency; wet darkening. Far forest is a canopy shell mesh (worley crown relief, dithered
  hand-over at 260-320 m) so the lighthouse view reads as continuous rainforest. Rock scans (Poly Haven) are
  instanced too; sea cliffs get 3-7.5 m boulders on 40-70 degree slopes and a boulder apron at the waterline, with a
  vertex-clustered LOD beyond 120 m.
* **Village and lighthouse**: built from a kit (boxes, cylinders, tubes with world-scale UVs, merged per material),
  PBR from Poly Haven scans: nine stilt huts, a communal house with a thick hip roof, two walkable jetties, eight
  outrigger canoes (five moored, bobbing on the wave-probe heights), drying nets with an animated net shader, a fish
  rack, a fire pit, Poly Haven props. The lighthouse: masonry tower, spiral stair, gallery, lantern room with a
  rotating beam at night, keeper's hut.

## Gameplay

* `Player`: kinematic controller over the heightfield + walkable platforms (`Colliders`: cylinders, boxes, sloped
  platforms) with a ~40 degree slope limit; walk/jog/sprint share one stride phase (blends never cross feet); jump
  start -> fall -> land; wading, treading and swimming by water depth; footstep events with the surface underfoot
  (sand, wet sand, grass, leaves, rock, wood, metal stair, shallow water). Rocketbox mesh with Quaternius clips
  retargeted offline (`tools/retarget.ts`).
* `CameraRig`: third-person follow with smoothing, collision against terrain and colliders, free fly (photo mode),
  orbit, fixed pose.
* `Audio`: lazily loaded loops (waves by distance to shore, surf, wind by altitude and exposure, birds by day, night
  insects/frogs, rain, heavy rain, waterfall and stream positional, village chimes/chickens/creaks/gulls), thunder
  delayed by lightning distance, surface-specific footsteps, swim splashes; underwater muffling.

## Asset pipeline

* Raw downloads live in `E:\tmp\island\raw\` (never in git): Poly Haven textures and models, Freesound audio,
  Rocketbox and Quaternius sources in `E:\tmp\island\dl\`.
* `pnpm assets:build terrain|tex|foliage|all` (`scripts/build-assets.ts`): resizes, normalizes albedo to measured
  targets, packs albedo+height and normal+roughness+AO, encodes UASTC KTX2 with mipmaps.
* `tools/optimize-glb.ts` + `tools/build-props.sh`: meshopt compression, quantization, KTX2 textures, optional
  simplification (`--simplify`, `--error`).
* `tools/gen_foliage.py`: paints the palm frond, banana leaf, palm bark and grass atlases; cuts leaves out of the
  Island Tree 02 scan into canopy cluster cards with normals.
* `tools/prep_audio.py`: loops with crossfades, loudness matching, footstep slicing, Ogg Vorbis.
* Loading: the heightfield (~5 MB) streams with real progress; terrain layers, foliage and prop textures, rocks and
  props stream in parallel (placeholders are flat target colours, swapped without recompiling); the loading screen
  stays up until the first frame (which compiles the shaders) has been presented; audio loads on first interaction.
  `__island.timeline()` and `scripts/loadtime.ts` measure it.

## Decisions worth knowing

* Glb geometry from meshopt files is quantized (normalized int16, often interleaved): convert attributes to float
  before baking transforms into them (`toFloatGeometry` in `main.ts`), or they clamp to +-1 m.
* Kit materials are keyed: `pbr(name, { key })` binds textures by the texture name (`src`), not by the key.
* WebGPU limits: the terrain shader samples many textures; the engine requests `maxSampledTexturesPerShaderStage` 32.
* TSL gotchas met: JS `/` on nodes produces `NaN`; `pow` of negative bases is NaN (wrap with `max(..., 0)`);
  lazily evaluated `assign` needs `.toVar()` to snapshot; avoid named arrow functions inside `page.evaluate` under
  tsx (it injects `__name`).
* The harness reads the monitor layout at every launch. On a 1920x1080 display (DISPLAY1, the primary) the window
  goes borderless fullscreen and renders a real 1920x1080 viewport; on any other display size it falls back to
  Playwright viewport emulation, so captures are always 16:9 at full resolution.

## Known issues and what is still weak (round 1)

* Start-up is shader-bound: every asset is in by ~2.5 s, then the first frames compile every render pipeline of the
  island synchronously (first visit ~16.5 s to the first frame, returning visit ~14.7 s). The priming frames draw
  everything once with frustum culling off, plus meshes that start hidden (empty vegetation LODs, rain, the
  lighthouse beam: `prime`), so nothing compiles with a hitch later in play. `compileAsync` does not help in three
  r186: the variants it builds differ from the MRT pass's first-frame variants (the uniform grouping of the lighting /
  CSM nodes differs), so it doubled the start-up and was removed. To get to a few seconds: find that mismatch (then
  compile asynchronously and reveal progressively), and cut the pipeline count (one uber material for the vegetation
  species, fewer shadow-pass variants, a slimmer terrain shader with baked noise textures).
* Frame budget (High, 1920x1080, RTX 4060): 60-66.7 fps everywhere; the jungle at a low sun is the tightest (~60 fps,
  main thread ~9.7 ms: three.js spends most of it per draw call). Levers used: the canopy shell drawn last (depth test
  rejects hidden shell pixels) and collapsed inside its hand-over distance, 4 palm / 3 tree / 2 bush variants, small
  rocks without shadows, the middle and far shadow cascades updating on alternate frames, a 1.1 km shadow box (a low
  sun no longer pulls whole strips of the island in as casters), sky LUTs every third frame. Next levers: instance the
  village props (each Poly Haven prop is several meshes), merge vegetation materials.
* Sea cliffs are a heightfield with shading tricks and boulders; a real displaced cliff mesh (or rock-kit meshes)
  along the cliff coasts would add overhangs and true relief.
* The jungle is lush at mid range but the floor is still sparse up close: no ferns, vines, roots or leaf-litter
  meshes yet (fern and anthurium scans are already optimized in `public/assets/props/`).
* Water reflections are environment-only (no screen-space reflections): the plunge pool and river use a dark
  "surround" term instead.
* Clouds are a 2D layer, not volumetric; the overcast in rain is convincing at ground level but flat from the summit.
* The character has no IK on slopes; swimming is a tread/swim blend without a proper crawl.
* Canopy shell hand-over can show a slight colour seam at 260-320 m in some lights.

## Skills

Installed in round 1 (`pnpm dlx skills add ... -g -y`): `cloudai-x/threejs-skills`, `dgreenheck/webgpu-claude-skill`,
`majidmanzarpour/threejs-game-skills` (updated), `mengto/skills@threejs-weather`,
`emalorenzo/three-agent-skills@three-best-practices`, `playableintelligence/game-creator@game-audio`, and from
`scottstts/threejs-awesome-graphics-agent-skills`: threejs-spectral-ocean, threejs-precipitation-surfaces,
threejs-volumetric-clouds, threejs-procedural-materials, threejs-temporal-surfaces, threejs-procedural-animation.

Used while building: webgpu-threejs-tsl, threejs-fundamentals, threejs-shaders, threejs-postprocessing,
threejs-loaders, threejs-animation, threejs-game-director, threejs-aaa-graphics-builder, threejs-gameplay-systems,
threejs-debug-profiler, threejs-qa-release, threejs-audio, game-audio, threejs-game-ui-designer,
3d-ultra-realistic-water, threejs-spectral-ocean, threejs-water-optics, threejs-atmosphere-aerial-perspective,
threejs-weather, threejs-precipitation-surfaces, threejs-procedural-vegetation, threejs-shadow-systems,
threejs-screen-space-ambient-occlusion, threejs-bloom, threejs-exposure-color-grading, threejs-procedural-vfx,
threejs-camera-direction, threejs-visual-validation, game-feel, playwright-best-practices.
