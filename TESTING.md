# Testing the island

Everything a tester needs without reading the source: how to run the game, the URL parameters, the
`window.__island` debug API, the named spots and conditions, and the harness commands (`pnpm shots`, `pnpm perf`,
`pnpm clip`) with their output paths.

## Run it

```bash
cd c:\Code\island
pnpm install
pnpm dev                    # development server: http://127.0.0.1:5230/
pnpm build                  # production build into dist/ (type-check + vite build)
pnpm preview                # serves dist/: http://127.0.0.1:5231/   <- test this: it is what viewers get
```

Ports are fixed (`--strictPort`): 5230 dev, 5231 preview. Port 5201 belongs to another project; leave it alone.
The harness commands below start the server they need (preview by default, `--dev` for the dev server) if nothing
answers on its port, and stop it again afterwards; a server you started yourself is reused and left running.

Controls: click to look (pointer lock), WASD move, Shift sprint, Ctrl walk, Space jump, P (or F) photo mode, M mute,
F3 debug overlay. Photo mode: the HUD hides, WASD/QE fly the camera, Shift faster, `[` `]` change the lens, P exits.
Gamepad: left stick move, right stick look, A jump, B or L3 sprint.

## URL parameters

All optional, combine freely: `http://127.0.0.1:5231/?spot=cliffs&tod=sunset&freeze=1&hud=0`

| Parameter | Values | Effect |
|---|---|---|
| `spot` | `beach` `jungle` `waterfall` `village` `cliffs` `lighthouse` | start at a named place (default: the spawn beach) |
| `tod` | `sunrise` `morning` `noon` `afternoon` `sunset` `dusk` `night` or hours `0`-`24` | time of day at start (presets: 6.55, 8.5, 12.3, 15.5, 17.42, 18.1, 22.5 h) |
| `freeze` | `1` | the time of day does not advance |
| `daylen` | minutes | length of a full day (default 30) |
| `weather` | `clear` `rain` `auto` | weather at start; `auto` (default): squalls roll in and clear on their own |
| `hud` | `0` | hide the HUD |
| `mute` | `1` | mute all sound |
| `debug` | `1` | debug overlay: GPU adapter, backend, preset, frame cap, fps, frame / CPU / GPU ms, draws, triangles, player state and surface, time, weather |
| `photo` | `1` | start in photo mode |
| `quality` | `low` `medium` `high` `ultra` | graphics preset (default: from the GPU; automated runs use `high`) |
| `fps` | `auto` `<n>` `0` | frame cap: `auto` = largest integer divisor of the display refresh that keeps >= 60 fps (66.7 on a 200 Hz screen); a number; `0` uncapped |
| `cam` | `orbit` `free` or `x,y,z,tx,ty,tz` | camera override (position and look-at target in metres) |
| `webgl` | `1` | force the WebGL 2 backend |
| `test` | `1` | automated run: no pointer lock, audio starts without a gesture, `high` preset, GPU timing on |
| `nopost` `noao` `notaa` `noshadow` | `1` | diagnostics: disable post-processing, ambient occlusion, temporal AA, sun shadows |
| `skip` | comma list of `terrain` `ocean` `oceansim` `river` `village` `lighthouse` `veg` `canopy` | diagnostics: leave those systems out |

## Named spots

| Spot | Where | The `shot` camera |
|---|---|---|
| `beach` | the spawn: the long east-facing crescent beach, the sunrise over the sea, a palm islet offshore | on the sand looking along the beach to the sea and the islet |
| `jungle` | inside the rainforest west of the beach | eye level among the trees |
| `waterfall` | the plunge pool at the foot of the 20 m falls | on the east bank, across the pool to the falls |
| `village` | the fishing village in the south-west cove | from the waterline by the jetties toward the huts, the communal house and the moored canoes |
| `cliffs` | the player stands on the cliff top above the north coast | from a boat off the north coast, along the 50-80 m sea cliffs |
| `lighthouse` | the lighthouse gallery on the 214 m summit | from the gallery over the whole island and the ocean |

## Conditions (as used by `pnpm shots` / `pnpm perf`)

| Condition | Time | Weather |
|---|---|---|
| `sunrise` | 06:33 | clear |
| `noon` | 12:18 | clear |
| `sunset` | 17:25 | clear |
| `night` | 22:30 (moon and stars) | clear |
| `rain` | 14:30 | rain (full overcast, rain streaks and splashes, wet surfaces, puddles, ripples) |

`pnpm shots` also accepts `morning`, `afternoon` and `dusk`.

## The debug API: `window.__island`

Every call is synchronous unless marked async and returns plain JSON-able values.

| Call | Returns / does |
|---|---|
| `await __island.ready(timeoutMs?)` | resolves `true` once streaming (terrain layers, foliage, props, rocks), shader compilation and settling are done |
| `await __island.stage({ spot, tod, weather, camera, worldTime, settleMs })` | one call to stage a capture: moves the player to `spot`, sets and freezes the time, sets the weather instantly, sets the camera (`'follow'` default, `'shot'` = the authored camera of that spot, `'orbit'`, `'free'`, or `{ pos:[x,y,z], target:[x,y,z], fov? }`), optionally freezes the world clock (`worldTime`: seconds; waves, wind and clouds stop at that instant; `null` = running), waits for `ready()` plus `settleMs` (default 1200), resets the frame statistics, and returns `{ time, weather, camera, player }` |
| `__island.spot(name)` / `__island.spots()` | move the player to a spot / list the spot names |
| `__island.setTime(presetOrHours, freeze = true)` / `__island.getTime()` | set the time of day / `{ hour, frozen, sunElevationDeg, exposure }` |
| `__island.setWeather('clear' \| 'rain' \| 'auto', immediate = true)` / `__island.getWeather()` | set the weather / `{ kind, auto, progress, rain, cover, wet, wind }` |
| `__island.setCamera(mode \| { pos, target, fov? })` / `__island.getCamera()` | `'follow'`, `'orbit'`, `'free'` or an explicit pose; returns `{ pos, dir, fov, mode }` |
| `__island.pauseWorld(seconds \| null)` | freeze the world animation clock at a time, or release it |
| `__island.hud(show)` / `__island.debugOverlay(show)` / `__island.mute(m)` | HUD, debug overlay, sound |
| `__island.stats()` / `__island.resetStats()` | frame statistics over the last 600 frames: `{ fps, frame, cpu, gpu, targetFps, refreshHz, preset, renderScale, drawCalls, triangles, backend, adapter }`, where `frame` / `cpu` / `gpu` are `{ n, avg, p50, p95, p99, max }` in ms (`frame` = wall time between presented frames, `gpu` from timestamp queries) |
| `__island.adapter()` | the GPU: `{ name, vendor, architecture, description, backend }` |
| `__island.timeline()` | load milestones `[{ name, ms }]` in ms since navigation start: `boot`, `heightfield`, `vegetation built`, `character`, `scene ready`, `terrain layers`, `foliage textures`, `rocks`, `first frame` (the loading screen lifts), `ready` |
| `__island.audio()` | `{ running, muted, layers: { name: { gain, loaded } }, footstepSurface, steps, buffers }`: the AudioContext state, every ambience layer with its current gain (`waves`, `surf`, `wind`, `birds`, `jungle`, `night`, `rain`, `rain_heavy`, `waterfall`, `stream`, `village`, `chickens`, `creak`, `gulls`), the surface of the last footstep and the step count |
| `__island.player()` | `{ pos, heading, state, speed, surface, waterDepth, weights }`: state is `ground`, `air`, `swim`; `weights` are the active animation clips |
| `__island.act(action, seconds = 3, yaw?)` | drive the character: `walk`, `run`, `sprint`, `jump`, `swim`, `idle`, for `seconds`, heading `yaw` (radians; forward is `(sin yaw, -cos yaw)` in x/z) |
| `__island.manual(on)` / `__island.step(n = 1, dt = 1/30)` | deterministic stepping for motion clips: with `manual(true)` the loop stops and `step` advances and renders `n` fixed frames |
| `__island.fps(cap)` | change the frame cap at run time (`'auto'`, a number, `0`) |
| `__island.quality()` / `__island.info()` | the active preset knobs / renderer counters `{ drawCalls, triangles, geometries, textures, terrainNodes }` |
| `__island.ctx` | the live game objects (for the curious; not a stable API) |

Example, an uncurated angle from anywhere:

```js
await __island.stage({ tod: 'sunset', weather: 'clear', camera: { pos: [600, 6, 120], target: [700, 2, 0], fov: 60 } });
```

## Harness commands

All three use the installed Chrome (`C:\Program Files\Google\Chrome\Application\chrome.exe`) headed on the second
(portrait) monitor at x >= 1930, on the RTX 4060 (`--force_high_performance_gpu`), with a temporary profile,
pointer lock stubbed out, audio muted (except where noted), and close the browser when done. The page renders a true
1920x1080 viewport inside a narrower window (viewport emulation), so every capture is a full 1920x1080 frame.

### `pnpm shots`: screenshots

```bash
pnpm shots --round round-01                                    # all 6 spots x 5 conditions, production build
pnpm shots --round round-01 --spots beach,cliffs --conditions sunrise,rain
pnpm shots --round round-01 --view follow                      # third-person camera instead of the authored shot
pnpm shots --round dev --dev                                   # against the dev server
```

Options: `--spots` (comma list), `--conditions` (comma list), `--view shot|follow`, `--quality low|medium|high|ultra`
(default high), `--settle <ms>` (default 1500), `--dev`.
Output: `E:\shots\island\<round>\<spot>_<condition>.png` (1920x1080) and `report.json` (load time, adapter, the
staged state and frame stats per shot, console warnings). Deterministic: the world clock is frozen at t = 1000 s for
every shot.

### `pnpm perf`: frame-time statistics

```bash
pnpm perf --round round-01                     # every spot x condition, 5 s each, with the game's frame cap
pnpm perf --round round-01 --uncapped          # Chrome without vsync or frame limit: headroom
pnpm perf --round round-01 --spots village --conditions rain --seconds 10
```

The player walks during each measurement so streaming, culling and LOD run as in play.
Output: `E:\shots\island\<round>\perf\perf.json` and `perf.md` (fps and cap, frame avg / p95 / p99, CPU avg, GPU
avg / p95 / p99, draw calls and triangles of a whole frame (shadow cascades, scene and post passes) per spot and
condition). `--q "skip=veg"` etc. passes extra URL parameters for A/B measurements.

### `pnpm clip`: motion clips

```bash
pnpm clip --round round-01 --preset all
pnpm clip --round round-01 --name walk_cliffs --spot cliffs --tod sunset --action walk --seconds 5 --yaw -1.42
```

`--preset all` records: `walk_beach`, `sprint_beach`, `jump_beach`, `swim_pool` (the plunge pool), `waves_beach`
(sunset, shot camera), `foliage_jungle` (wind in the trees, shot camera), `rain_village` (walking in the rain).
Single clips take `--name --spot --tod --weather --action --camera follow|shot --yaw --seconds --fps`.
Frames are stepped at a fixed 1/30 s (smooth and deterministic however slow the capture is).
Output: `E:\shots\island\<round>\clips\<name>\frame_0000.png ...` and `E:\shots\island\<round>\clips\<name>.mp4`
(H.264 via ffmpeg).

### Development captures

`pnpm tsx scripts/look.ts --q "spot=village&tod=noon" --name v1` (one URL to one PNG in `E:\shots\island\dev\`),
`pnpm tsx scripts/poses.ts --file poses.json` (a list of camera poses in one session; a y of `"+2"` means 2 m above
the ground there) and `pnpm tsx scripts/loadtime.ts` (load timeline of a first visit and a returning visit in one
persistent Chrome profile).

## Gotchas

* Test the production build (`pnpm build`, then `pnpm preview` or just `pnpm shots`): the dev server compiles
  modules on demand and its first load is slower.
* Load time on this PC (production build): the world data, character and every texture and model are in by ~2.5 s;
  the first frames then compile every shader pipeline of the whole island (drawn once with culling off, so nothing
  compiles with a hitch later in play) behind the loading screen. First visit: first frame ~16.5 s, `ready()` ~17 s;
  returning visit: first frame ~14.7 s, `ready()` ~15.7 s. This is the known weak point of round 1 (see NOTES.md).
  Later `stage()` calls take ~1-2 s.
* `stage()` freezes the time of day; pass `worldTime: null` to keep waves and wind moving (perf and clips do).
* Rain needs a second or two to build up on surfaces if set with `immediate = false`; `stage()` sets it instantly.
* The `shot` camera of `cliffs` is offshore (a boat's view); the `cliffs` player spot is on the cliff top, so the
  `follow` view shows the cliffs from above.
* GPU timing comes from WebGPU timestamp queries; if the browser disables them `gpu.n` is 0.
* Chrome warns "powerPreference is currently ignored on Windows" (crbug 369219127); the harness forces the RTX with
  `--force_high_performance_gpu` and `adapter()` / the debug overlay report what was used.
* Windows portrait monitor: windows are placed at x = 1930, y = 20 with a 1060x900 window; do not move them to the
  primary screen.
