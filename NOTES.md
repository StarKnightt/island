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

## Round 2: what changed

* **Assets from helper agents** (Blender 5.1 headless, generators in `tools/blender/{palms,jungle,rocks}`, credits in
  `CREDITS.md`): coconut palms (6 variants x 3 LODs, curved ringed trunks, 20-30 fronds with dead ones), young palms,
  beach scrub, rainforest canopy trees, mid-storey trees, understory (banana, alocasia, tree fern, rattan, licuala),
  ground ferns, leaf litter, logs and roots; a photoscan cliff-face kit (8 pieces), sculpted sea stacks, basalt
  boulders, rock shelves. Plants carry wind weights in COLOR_0 (`veg/glb.ts`); `Vegetation.ts` scatters them in
  layers (canopy, mid-storey, understory, floor), far canopy trees become opaque crown stand-ins (k-means lumps of
  their leaf cards, out to 800 m), the canopy shell (`Canopy.ts`, crown field baked to a 2048^2 texture at load)
  takes over from 285 m.
* **Coast** (`water/surf.ts`, `Ocean.ts`, `Spray.ts`): shoaling and breaking by depth, bores and lobed swash on the
  beaches, a wet-sand film, lace foam, refracted shallows, glints, bursts and spray at the cliff feet. `RockKit.ts`
  chains the cliff kit along the sea cliffs, sets sea stacks on wave-cut platforms, builds the wet mossy gorge round
  the falls and raycasts its pieces against the falls path (`water/fallsPath.ts`) so no rock pokes through the water.
* **Falls** (`River.ts`): two aerated sheets shaded by the time each texel of water left the lip, a splash curtain, a
  mist plume, pool churn and rings. Mist, splash and the thin-water glow are shaded in the gorge's shadow (a march
  over the heightfield toward the sun).
* **Sky, light, night**: ray-marched 3D-noise cumulus with cloud shadows; under an overcast a CIE grey dome (zenith
  three times the horizon) whose brightness follows the clear sky 15 degrees up, haze of the same grey, and the deck
  fading into the dome before the 40 km cloud map ends; rain shafts; stars (fixed: see below) and the moon; village
  lamps with long broken reflections on the sea, lit windows and doorways, the fire pit.
* **Rain**: streaks along their screen motion in a 1/15 s exposure, slanted by the wind; ~1.5 km visibility; wet
  surfaces darker with specular occlusion under the canopy and on distant crowns; the forest floor sees only part of
  the sky (terrain AO from the forest mask); squall wind on palms and trees; `__island.timelapse()` and the clip
  presets `timelapse_day` / `timelapse_rain` film the cycles.
* **Lighthouse and character**: internal stair, keeper's house, glazed lantern, the gallery spawn inside the
  handrail; swim buoyancy and pose, contact shadows, turn smoothing, jump anticipation.
* **Loading**: per-material numbers are uniforms and every instanced mesh is past the uniform-buffer limit
  (`core/instancing.ts`), so materials share shaders (248 -> 106 pipelines); the loading screen primes a batch of
  materials per frame with real progress ("Preparing shaders k / 30") and a compositor-driven glint, so it never
  freezes.
* **Performance**: plants, cliffs and rocks are lit by the sun only (`core/lighting.ts`; the village lamps light the
  ground, the sea and the village); the environment map is re-rendered only when the light changes; the frame cap
  gates on the display's frame times (the rAF timestamp), so a frame that runs long lands in the next slot instead of
  waiting out a whole count of refreshes; instance buffers are uploaded only when the lists change (see below).

### Decisions and gotchas from round 2

* TSL `hash()` casts its seed to uint: a negative seed clamps to 0, so anything hashed by world position matches over
  the whole west / north of the island (stars, glints, canopy tints). Offset seeds to stay positive.
* three r186 re-uploads a `DynamicDrawUsage` attribute in full in every render pass of every frame. With every
  instanced mesh on the attribute path (`SHARED_INSTANCES`) that was ~17 MB a frame and half the main thread; the
  instance buffers are static now and uploaded by range when `update()` rebuilds the lists. The rock kit re-culls only
  when the camera moves or turns.
* A custom `normalNode` built from `normalWorldGeometry` skips the built-in back-face flip: multiply by
  `faceDirection` on double-sided materials (the falls sheet faced the cliff and glowed in the sunset behind it).
* `aoNode` only darkens indirect diffuse in r186: the right place for "the forest floor sees little sky".
* The GPU timer (timestamp queries) does not cover the main scene pass: with shadows off it reads ~1 ms. It is the
  shadow and post passes; judge a view by its frame time.
* In the dev server, edited modules are imported with a `?t=` query: a test that imports a module in the page must
  use the URL the page loaded (`performance.getEntriesByType('resource')`) or it gets a second copy.

## Known issues and what is still weak (round 2)

* Start-up is still shader-bound: first visit ~20.6 s to `ready()` (every asset in by ~4.1 s, the rest compiling 106
  pipelines at ~160 ms each), returning visit ~7.2 s. The loading screen keeps moving, but it is not "a few seconds".
  Next: fewer pipelines (one material per vegetation layer, fewer shadow variants) and a playable start that compiles
  the far set in the background.
* The waterfall view runs 53-57 fps (frames of 15 or 20 ms on the 200 Hz screen): it is GPU-bound in the main pass
  (shadows off gives 64 fps). The jungle at a low sun is borderline (one run 54 fps with a hitch, another 63).
* The plunge pool reads as a smooth green bowl with hard edges; the terrain walls of the basin show as flat grey
  planes in flat light; rim stones are few.
* In rain the forested hills behind the village are mostly haze-grey (physically plausible at 1.5 km visibility, but
  little olive green shows through).
* Rock shelves (`assets/rocks/shelves.glb`) and the eighth cliff piece (`cliff_h`) are delivered but not placed.
* Character: hair, face, the idle, the shirt at night and footprints are as in round 1.

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

## Round 4: what changed

Measured first (`E:\shots\island\round-04-base\perf\`), then the hard rules, then the look. Final numbers in
`E:\shots\island\round-04\perf\perf.md`; load times from `scripts/loadtime.ts` (now also bytes, long tasks and the
longest gap between animation frames).

* **Frame rate.** Two main-thread costs were three.js bookkeeping, not rendering. (1) Shadow passes draw every caster
  with one shared override material and copy the caster's `alphaTest` onto it; the setter bumps the material version
  whenever the test turns on or off, so with leaves and trunks interleaved nearly every shadow draw recomputed its
  full material cache key (a quarter of the frame). `Engine.ts` makes that setter skip the bump on shadow-pass
  materials (a render object of the override always draws one source material). (2) The vegetation re-culled and
  re-uploaded every instance list every 20th frame even with a still camera (a 40-80 ms stall whenever the GPU queue
  was full); it now re-culls only when the camera moves or turns. Result: uncapped lowest 60.9 -> 67.4 fps, 23 -> 29
  of 30 combinations at >= 70; capped 66.7 fps with p99 15.1 ms everywhere.
* **Loading.** (1) three r186 puts an instanced mesh's uuid in its render cache key, so every InstancedMesh built its
  whole node graph again (~15-20 ms each, ~400 of them) for shaders it then de-duplicated. `core/instancing.ts`
  `shareInstancing()` turns three's instancing off on a mesh, gives it a geometry copy with the matrices as named
  per-instance attributes `iM0..iM3` over the same array (synced from `instanceMatrix` in `onBeforeRender`), applies
  them in a `NodeMaterial.setupPosition` hook (position, previous position for TRAA, normal), and the render-object
  lookup sees one uuid for all of them (`Engine.ts`). 395 -> 165 builds. (2) `tools/halve-glb.ts` halves the largest
  textures of chosen GLBs by dropping the top mip of their UASTC KTX2 (no re-encode; stacks, cliff kit, boulders,
  ledge, canopy, young palms, hero) and moves byte-identical atlases shared by several GLBs to `assets/shared/`.
  (3) Priming in 14 batches, each frame drawing only its own batch. First visit 15.6 -> 9.1 s to the first frame
  (17.3 -> 10.7 s to ready), returning 13.9 -> 7.5 s, 170.9 -> 129.1 MB, longest frozen frame 4.1 -> 1.2 s.
* **Day cycle.** The exposure meter's sky term and the sun's light now fade through the horizon instead of switching
  at sun height -2 degrees, the lit-face metering ramps in over the first degrees after sunrise, a moonless sky lets
  the exposure open further (readable pre-dawn), eye adaptation keeps pace with a time-lapse clock, and the
  environment map and the sky LUTs re-render as soon as the sun (or the weather) has moved, not on a real-time
  cadence (in a 24 s day that cadence lagged half an hour of twilight, then jumped). `timelapse_day`: worst one-frame
  jump 150 -> 37 luma; dawn ramps over ~10 frames.
* **Rain.** The rain haze is a neutral grey-green (a blue-grey one read as frost on the forest) at ~2 km visibility,
  wet leaves darker and greener, a squall raises the FFT sea (`amplitudeU` up to 1.75x: steeper chop, whitecaps,
  slate water), streaks are a 1/50 s exposure, rain cells pass with bursts and lulls.
* **Sea.** Whitecaps: the Jacobian foam history of this sea only reaches 0.2-0.5, so the caps now start there (they
  began at 0.64-0.75: none ever showed); a trade-wind day shows a scattering, a squall broken streaks. A facet tilted
  away from the viewer no longer mirrors the environment's ground half (brown troughs in the chop); cliff white water clings to the wall and backwash lace lingers through the set; no shore surf past the
  island tile's edge.
* **Distant forest.** Crown stand-ins are wider with two octaves of lumps and lit as a canopy facing up (the bubble
  wrap was a sphere's terminator round every crown); open grass is a deeper olive from afar; humid trade-wind haze
  (~1.7e-4 /m: ~16 % at 1 km).
* **Wind.** Gusts and lulls roll across the island downwind, and the sway runs on two unrelated periods per part.
* **Night.** Dimmer moonlight on open sand; under the canopy the eye opens up to 6x (the jungle was black).
* **Boats.** Moored canoes ride the water the sea shows there (the probe damped by depth as the shader damps it):
  in the shallow cove they keep their waterline instead of heaving through still water.
* **Harness.** `ready()` waits for the loading screen to leave the page; the game records `ready` itself; `pick()`
  updates the camera first; clips are always 1920x1080 (ffmpeg pads odd sizes). The village spawn-to-jetty walk was
  checked: not stuck.

Final measurements (16:35-16:50, game closed, GPU lock held; other apps kept the GPU at 5-30 %): uncapped 29-30 / 30
combinations at >= 60 fps (lowest 69.5 after re-measuring the rain row, which overlapped outside load in the full
run); capped 64-66.7 fps with p95/p99 15-20 ms (an earlier quiet run at 15:20 held 66.7 fps, p99 15.1 ms in all 30).
Load: first visit 9.1-10.0 s to the first frame, returning 7.5-8.3 s, 129.1 MB, longest frozen frame 1.0-1.8 s.

* **Frame pacing.** The auto cap paces evenly (`Engine.pace`): a rate held only most of the time alternated 15 and
  20 ms frames on the 200 Hz screen (judder). With more than 4 % late frames in the last 120 it steps down a divisor
  (66.7 -> 50 fps, a steady 20 ms; never below 45 fps) and back up on trial after 8 s with the main thread's p90 under
  0.6 of the faster frame, the wait doubling after a failed trial. Checked: jungle, waterfall and beach while running
  hold a uniform 15.0 ms; with 13 ms of extra main-thread work per frame it drops to a uniform 20 ms within half a
  second and returns to 15 ms 8 s after the load goes. `?fps=<n>` still fixes the rate.

* **Pandanus** (`assets/veg/palms/pandanus.glb`, round 3): built by `tools/blender/palms/build_pandanus.py` after
  `make_textures.py` and `make_pandanus_tex.py` (bark tile from the CC0 palm_tree_bark scan, the rest procedural),
  optimised with `tools/optimize-glb.ts`; planted by `Vegetation.ts` as lone trees and clumps of two or three on the
  beach berms, rock shelves and cliff tops. Credited in CREDITS.md.

### Round 4, second session (17:00-18:00)

* **Waterfall.** The splash particles took all their random values from their id, so each replayed one trajectory
  every lifetime and the curtain repeated every second: they are re-seeded every lifetime (the lifetime itself stays,
  so ages never jump) and the plunge surges on two unrelated periods. The pool's impact rings are stronger, reach
  further and are warped by noise with slowly swelling strength; lace is carried outward from the boil (two flow
  phases crossfaded). The drifting foam over the outer pool is still faint.
* **Effects and the normal target.** `core/fx.ts` `effectMRT()`: spray, falls splash and mist, rain streaks and
  splashes, village smoke, flame and glows write the world's up into the scene pass's unblended normal target (as the
  character's effects do), so GTAO no longer draws squares round puffs.
* **Rain.** `atmo.deck` scales the overcast dome, its ground bounce and the rain haze: heavier cells darken the deck
  to ~0.65, lulls lift it to ~1.35, the gathering front darkens it, the clearing has sun breaks. `timelapse_rain`'s
  downpour now moves between ~72 and ~95 luma (it was a flat 84-87).
* **Summit "glitter column".** It was the far gulls (a ragged column of specks down the sea from the gallery), not
  the glints: birds fade out between 500 and 800 m from the camera. The sea's sparkles were already a field.
* **Lagoon.** About a third of the open-sea field reaches behind the reef (was an eighth: glassy); whitecaps only in
  water deeper than 3-10 m.
* **Loading.** The overlay starts to fade once 70 % of the last pipelines are compiled (first frame ~0.5 s
  sooner). Overlapping the shader priming with the asset loading was tried and reverted: the main thread is the
  bottleneck in both (shader builds ~4 s, GLB parsing and scattering ~2 s), so the plants arrived later and the first
  frame moved from 8.9 to 11.7 s. A few seconds needs fewer or cheaper node builds (the CSM shadow node in every
  lit material), not reordering.
* Measured 17:47-17:57 with the GPU lock: capped 66.7 fps, p99 15.1 ms in all 30 combinations (the pacer never stepped
  down); uncapped 30 / 30 >= 60, lowest 67.3 (waterfall rain). Load: first visit 8.3 s to the first frame (10.0 s
  ready), returning 7.0 s (8.6 s), 129.1 MB.

### Gotchas from round 4

* `shareInstancing()` meshes have `isInstancedMesh = false`: three's raycast still works (it is the class method), but
  anything that tests `isInstancedMesh` treats them as plain meshes. Their `count` still sets the instance count.
* A `Material.alphaTest` setter patch (Engine.ts) applies to shadow-pass materials only.
* The village shot camera stands halfway out along the jetty, where the cove is only 0.2-1 m deep: the pale water
  there is real shallows, not a missing sea.

### Still weak (round 4)

* Start-up is still ~9 s on a first visit: 165 node builds (~20 ms each) on the main thread, the first priming
  frame ~1.2 s. Next: a cheaper lit-material graph (the CSM shadow node is a large share of every build) or fewer
  distinct materials.
* Payload 129 MB: the jungle floor and understory atlases (2K), the terrain and kit textures (1K) are the bulk.
* The noon glitter seen from the summit is a one-pixel column (the
  unresolved-slope roughness does not reach it); the beach breaker inside the reef lagoon is small.
* Rain brightness is flat through the downpour (exposure compensates the deck's small changes).
* Character (face, hair, outfit, shoes on the beach) and the falls' looping impact are as in round 3.
