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
| `fps` | `auto` `<n>` `0` | frame cap: `auto` = largest integer divisor of the display refresh that keeps >= 60 fps (66.7 on a 200 Hz screen), paced evenly: when more than 4 % of the last 120 frames land a refresh late it steps to the next divisor (50 fps on a 200 Hz screen, never below 45) and steps back up on trial after 8 s of clear headroom; a number = that fixed rate, no adaptation; `0` uncapped |
| `cam` | `orbit` `free` or `x,y,z,tx,ty,tz` | camera override (position and look-at target in metres) |
| `webgl` | `1` | force the WebGL 2 backend |
| `test` | `1` | automated run: no pointer lock, audio starts without a gesture, `high` preset, GPU timing on |
| `capture` | `1` | trailer capture (`pnpm record`): `test` plus no HUD, muted, frozen time of day, clear weather, a seeded `Math.random` |
| `clean` | `1` | with `capture=1` only: no vignette (the picture exactly as rendered and tone mapped) |
| `accum` | `n` | with `capture=1` only: every stepped frame is the mean of n renders of the same instant, each with its own sub-pixel jitter and fresh dither seeds (supersampling; the temporal AA is off) |
| `nopost` `noao` `notaa` `noshadow` | `1` | diagnostics: disable post-processing, ambient occlusion, temporal AA, sun shadows |
| `skip` | comma list of `terrain` `ocean` `oceansim` `river` `village` `lighthouse` `veg` `canopy` | diagnostics: leave those systems out |

## Named spots

| Spot | Where | The `shot` camera |
|---|---|---|
| `beach` | the spawn: the long east-facing crescent beach, the sunrise over the sea, a palm islet offshore | on the sand looking along the beach to the sea and the islet |
| `jungle` | inside the rainforest west of the beach | eye level among the trees |
| `waterfall` | the plunge pool at the foot of the 20 m falls | on the east bank, across the pool to the falls |
| `village` | the fishing village in the south-west cove | from the end of the main jetty back along its planks, past the moored canoes, to the huts, the fire pit and the palms |
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

`pnpm shots` and `pnpm perf` also accept `morning`, `afternoon` and `dusk`; an unknown name stops the run before the browser starts.

## The debug API: `window.__island`

Every call is synchronous unless marked async and returns plain JSON-able values.

| Call | Returns / does |
|---|---|
| `await __island.ready(timeoutMs?)` | resolves `true` once streaming (terrain layers, foliage, props, rocks), shader compilation and settling are done |
| `await __island.stage({ spot, tod, weather, camera, worldTime, settleMs })` | one call to stage a capture: moves the player to `spot`, sets and freezes the time, sets the weather instantly, sets the camera (`'follow'` default, `'shot'` = the authored camera of that spot, `'orbit'`, `'free'`, or `{ pos:[x,y,z], target:[x,y,z], fov? }`), optionally freezes the world clock (`worldTime`: seconds; waves, wind and clouds stop at that instant; `null` = running), waits for `ready()` plus `settleMs` (default 1200), resets the frame statistics, and returns `{ time, weather, camera, player }` |
| `__island.spot(name)` / `__island.spots()` | move the player to a spot / list the spot names |
| `__island.setTime(presetOrHours, freeze = true)` / `__island.getTime()` | set the time of day / `{ hour, frozen, sunElevationDeg, exposure }` |
| `__island.setWeather('clear' \| 'rain' \| 'auto', immediate = true)` / `__island.getWeather()` | set the weather / `{ kind, auto, progress, rain, cover, wet, wind }` |
| `__island.timelapse({ dayMinutes?, squall? })` | time-lapse for filming the automatic cycles: `dayMinutes` runs the clock with a day that long (`0.4` = a whole day in 24 s; sun, moon, sky, clouds, lamps and exposure follow), `squall: k` runs one squall from a clear sky `k` times faster than life (gathering 70 s, rain 150 s, clearing 80 s at 1x, then clear); `timelapse({})` restores the normal day and real-time weather. Use with `stage({ worldTime: null })` and `manual`/`step` (or just let it run) |
| `__island.pick(x, y, root?)` | what the camera sees at a screen point (`x`, `y` from the top left, 0..1): the nearest meshes along the ray `[{ name, parent, d, p, instance }]`; `root` limits it to one group (`rockkit`, `vegetation`, `village`, `river`, `lighthouse`). The terrain and the sea are displaced on the GPU and are not found |
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
| `__island.shotStart(worldTime, seed, exposure = 1)` / `__island.placePlayer(x, z, yaw)` / `__island.shotFrame({ cam, walk, mode?, dt? })` | trailer capture in manual mode: start a shot at a fixed world time and random seed with an exposure grade; put the player down standing; one frame with the camera at the pose `cam` (or `'follow'`: the game's own follow camera, `snap: yaw` first puts it behind that heading, `pitch` sets its pitch as the mouse would; `mode` `walk` `run` `sprint`, `jump`, `accum` the renders averaged for this frame), the player walking toward world heading `walk` (`null`: standing), exactly `dt` (default 1/60) s of world and one render; returns `{ frame, player, cam, steps, pending }` (`cam`: the camera position) (footsteps of that frame, pipelines still compiling) |
| `__island.fps(cap)` | change the frame cap at run time (`'auto'`, a number, `0`) |
| `__island.quality()` / `__island.info()` | the active preset knobs / renderer counters `{ drawCalls, triangles, geometries, textures, terrainNodes }` |
| `__island.ctx` | the live game objects (for the curious; not a stable API) |

Example, an uncurated angle from anywhere:

```js
await __island.stage({ tod: 'sunset', weather: 'clear', camera: { pos: [600, 6, 120], target: [700, 2, 0], fov: 60 } });
```

## Harness commands

All of them use the installed Chrome (`C:\Program Files\Google\Chrome\Application\chrome.exe`) on the RTX 4060
(`--force_high_performance_gpu`), with a temporary profile (the development captures keep a persistent one, below),
pointer lock stubbed out, audio muted (except where noted), and close the browser when done.

Headless: when `%USERPROFILE%\.island-display` (or `ISLAND_DISPLAY`) says `headless`, every harness command runs Chrome
in its headless mode with the same flags: no window opens on any screen, the page is a real 1920x1080 viewport at
devicePixelRatio 1, and WebGPU runs on the RTX 4060 as headed (checked round 3: same adapter, same draw counts and
frame times, captures within run-to-run noise of headed ones, mean difference 2-4 / 255). This is the setting on this
PC while the user works at it (each run prints `[browser] headless 1920x1080 at (0,0): headless 1920x1080
viewport`). In headless mode the page still reports the main display's refresh (200 Hz), so the frame cap is 66.7 fps.

Window placement (headed): each launch asks Windows for the monitor layout and opens the window on the display named in
`%USERPROFILE%\.island-display` (`primary`, `secondary` or a device name such as `DISPLAY2`). That file is the user's
machine-wide choice and overrides everything else; without it, `ISLAND_DISPLAY` (the same values, or a 1-based index in
Windows' order) decides, and the default is the primary (DISPLAY1, 1920x1080 at (0,0), ~200 Hz). The vertical second
monitor, when it is on, is DISPLAY2 (portrait 1080x1920 at X 1920..3000). Chrome runs with `--force-device-scale-factor=1`,
so Windows display scaling (DISPLAY1 is at ~120 %) does not shrink the viewport. On a display that is exactly
1920x1080 the window goes borderless fullscreen, so the page renders a real 1920x1080 viewport at devicePixelRatio 1
with no emulation. On a display of any
other size the window fills that display's work area and the 1920x1080 viewport is emulated. Either way every capture
is a full 1920x1080 frame, and each run prints the display and mode it used (`[browser] DISPLAY1 1920x1080 at (0,0):
fullscreen 1920x1080 viewport`). While a command runs, its window covers that screen; leave it alone until the command
finishes.

The frame cap follows the refresh rate of the display the window is on: it is measured at start and re-measured from
the frame times while the game runs, so it also follows a window that moves to another screen (66.7 fps on the
~200 Hz DISPLAY1, 60 fps on a 60 Hz display). Frame rates measured under the cap therefore depend on the display;
`pnpm perf` also measures with Chrome's vsync and frame-rate limit off (below), which is the display-independent
number.

Driving your own browser instead: the easiest way is `pnpm tsx scripts/poses.ts` or `scripts/look.ts` (Development
captures, below), which place the window as above. If you launch Chrome yourself, follow `%USERPROFILE%\.island-display`
the same way and always pass `--force-device-scale-factor=1 --force_high_performance_gpu` and a temporary
`--user-data-dir`. On DISPLAY1 use `--window-position=0,0 --window-size=1920,1080`, then CDP
`Browser.setWindowBounds { windowState: 'fullscreen' }` with Playwright's `viewport: null` for a real 1920x1080
viewport. On DISPLAY2 use `--window-position=1930,20 --window-size=1060,1880` and emulate a 1920x1080 viewport (CDP
`Emulation.setDeviceMetricsOverride` 1920x1080 at deviceScaleFactor 1). A window at x >= 1920 is off-screen whenever
only DISPLAY1 is connected.

### `pnpm shots`: screenshots

```bash
pnpm shots --round round-01                                    # all 6 spots x 5 conditions, production build
pnpm shots --round round-01 --spots beach,cliffs --conditions sunrise,rain
pnpm shots --round round-01 --view follow                      # third-person camera instead of the authored shot
pnpm shots --round dev --dev                                   # against the dev server
```

Options: `--spots` (comma list), `--conditions` (comma list), `--view shot|follow`, `--quality low|medium|high|ultra`
(default high), `--settle <ms>` (default 1500), `--dev`.
Output: `E:\shots\island\<round>\<spot>_<condition>.png` (1920x1080) and `report.json` (load time, adapter, window
placement (display, real or emulated viewport), the staged state and frame stats per shot, console warnings). Deterministic: the world clock is frozen at t = 1000 s for
every shot.

### `pnpm perf`: frame-time statistics

```bash
pnpm perf --round round-03                     # every spot x condition, 5 s each: uncapped, then with the frame cap
pnpm perf --round round-03 --mode uncapped     # only uncapped (same as --uncapped)
pnpm perf --round round-03 --mode capped       # only with the game's frame cap (--fps <n> to set it)
pnpm perf --round round-03 --spots village --conditions rain --seconds 10
```

By default every combination is measured twice, in two browser sessions: uncapped (Chrome's vsync and frame-rate limit
off and the game's cap off: what the view costs on this GPU, whatever display the window is on, so this is the
headroom number) and capped (the game's own cap for the refresh of that display: what a player sees there). The
player walks during each measurement so streaming, culling and LOD run as in play.
Output: `E:\shots\island\<round>\perf\perf.json` (both runs per row) and `perf.md` (uncapped fps and frame avg / p95 /
p99, capped fps with its cap and the refresh it came from, capped p99, CPU avg, GPU avg, draw calls and triangles of a
whole frame (shadow cascades, scene and post passes) per spot and condition, and a summary line: how many
combinations hold 60 and 70 fps uncapped). `--q "skip=veg"` etc. passes extra URL parameters for A/B measurements.

### `pnpm clip`: motion clips

```bash
pnpm clip --round round-01 --preset all
pnpm clip --round round-02 --preset timelapse        # timelapse_day + timelapse_rain (about 5 min together)
pnpm clip --round round-02 --preset timelapse_rain   # any one preset by name
pnpm clip --round round-01 --name walk_cliffs --spot cliffs --tod sunset --action walk --seconds 5 --yaw -1.42
```

`--preset all` records: `walk_beach`, `sprint_beach`, `jump_beach`, `swim_pool` (the plunge pool), `waves_beach`
(sunset, shot camera), `foliage_jungle` (wind in the trees, shot camera), `rain_village` (walking in the rain).
`--preset timelapse` records the two cycles the game runs on its own, at 15 fps from the beach shot camera:
`timelapse_day` (24 s: from 04:30 through dawn, sunrise, noon, sunset, the lamps and the night to the next dawn, a
whole day in 24 s) and `timelapse_rain` (25 s: a clear 13:00, a squall gathers, rains with wind and haze, and clears,
12x faster than life). Waves, wind and rain streaks move at real speed in both; only the clock or the weather is fast.
Single clips take `--name --spot --tod --weather --action --camera follow|shot --yaw --seconds --fps`.
Frames are stepped at a fixed 1/fps (smooth and deterministic however slow the capture is).
Output: `E:\shots\island\<round>\clips\<name>\frame_0000.png ...` (`.jpg` for the time-lapses) and
`E:\shots\island\<round>\clips\<name>.mp4` (H.264 via ffmpeg).

### `pnpm record`: the trailer

```bash
pnpm record --preview                # one 1920x1080 frame per beat -> E:\shots\island\trailer-preview\gp_<n>_<beat>.png
pnpm record --seconds 10             # only the first 10 s -> E:\shots\island\trailer-preview\gameplay_edit_v2_first10s.mp4
pnpm record                          # every beat, the sound, the encode -> E:\shots\island\gameplay_edit_v2.mp4
```

The gameplay trailer (about 30 s), defined at the top of `scripts/record.ts`: the opening dive from the whole island
down to him on the village beach at sunset (an exact camera rig), then straight cuts of play filmed by the game's own
follow camera (`shotFrame({ cam: 'follow' })`, its own lag, easing and collision), the character steered toward
waypoints like a player steers him, and a hard cut to black with 0.5 s of black held. The page runs with
`?capture=1&clean=1&accum=8` (`clean`: no vignette; `accum`: each frame the mean of 8 jittered renders, so the
dithered sky, clouds and hair come out clean); nothing is graded, dissolved or faded on top. Every frame is stepped by
exactly 1/60 s through `shotFrame` and read back with a CDP screenshot; each beat starts from a fixed world time and
seed after 1.5 s of uncaptured warm-up (on the gameplay beats he already walks through it and the camera settles
behind him). Frames go to `E:\tmp\island\gameplay\<n>_<beat>\` (PNG, deleted after a good encode; `--keep` keeps them;
`shot.json` keeps the footsteps and timing). The sound is a soft bed of the game's waves, wind and birds per beat (every
layer high-passed at 140 Hz) with 0.16 s crossfades on the cuts plus his footsteps, gently compressed and limited and
normalised to -20 LUFS with a narrow loudness range, cut with the picture. Every encode also writes a 12-frame
contact sheet next to the mp4. Other flags: `--shots a,b`, `--encode-only`, `--audio-only`, `--at <s>` (preview
time), `--dev`. About 230 ms a frame on the RTX 4060.

### Development captures

`pnpm tsx scripts/look.ts --q "spot=village&tod=noon" --name v1` (one URL to one PNG in `E:\shots\island\dev\`),
`pnpm tsx scripts/poses.ts --file poses.json` (a list of camera poses in one session; a y of `"+2"` means 2 m above
the ground there), `pnpm tsx scripts/session.ts --steps steps.mjs` (one page load, then a steps module stages and
captures as it likes; see its header) and `pnpm tsx scripts/loadtime.ts` (load timeline of a first visit and a
returning visit in one persistent Chrome profile, with the bytes over the wire, the main thread's long tasks and the
longest gap between animation frames, i.e. how long the loading screen could have stood still), and
`pnpm tsx scripts/loader.ts` (the loading screen mid-load, through the crossfade and live, then reduced-motion and
phone-width loads, into `E:\shots\island\loader\`). look, poses and session keep a persistent profile
(`E:\tmp\island\chrome-dev`, so Chrome's compiled shaders survive and a page loads in seconds; `--fresh` for a new
one) and take `--uncapped` (vsync and frame limit off).

## Gotchas

* Test the production build (`pnpm build`, then `pnpm preview` or just `pnpm shots`): the dev server compiles
  modules on demand and its first load is slower.
* Load time on this PC (production build): the world data, character and every texture and model are in by ~4-5 s;
  the loading screen then builds every shader of the whole island (drawn once with culling off, so nothing compiles
  with a hitch later in play), a batch of materials per frame. The status names the stages in the world's words: the
  shader stages read `Catching the light k / 14` (the island's materials), `Dressing the palms k / 2` (the plants) and
  `Settling the tide n / m` (pipelines the driver is still compiling). The progress line steps forward after each
  batch, with a light travelling along it all the time, and the screen crossfades into the first live frame. Most of that time is three.js building node
  materials on the main thread, not the driver, so a returning visit is only a few seconds faster. The real numbers
  are in NOTES.md and the round report (`pnpm tsx scripts/loadtime.ts`). Later `stage()` calls take ~1-2 s.
* `ready()` (and so `stage()`) resolves only once the loading screen has left the page, and the game records its own
  `ready` milestone in `timeline()` whether or not anyone calls `ready()`. `pick()` brings the camera's matrices up to
  date first, so it is right straight after `stage()` or `setCamera()`.
* `stage()` freezes the time of day; pass `worldTime: null` to keep waves and wind moving (perf and clips do).
* Rain needs a second or two to build up on surfaces if set with `immediate = false`; `stage()` sets it instantly.
* The `shot` camera of `cliffs` is offshore (a boat's view); the `cliffs` player spot is on the cliff top, so the
  `follow` view shows the cliffs from above.
* GPU timing comes from WebGPU timestamp queries; if the browser disables them `gpu.n` is 0. The GPU columns do not
  include the main scene pass (with `?noshadow=1` they read about 1 ms): they are the shadow and post passes. The
  frame time (and fps) is the measure of a view's real cost.
* `stage()` resets the auto cap's pacing to its own rate, so every staged view starts at 66.7 fps and steps down to 50 only if it cannot hold it; `stats().targetFps` is the rate in force.
* The frame cap renders on every third refresh of the 200 Hz display, timed by the display's frame times, so frame
  intervals are 15 ms, or 20 ms when a frame runs over; an fps between 60 and 66.7 is a mix of the two.
* Chrome warns "powerPreference is currently ignored on Windows" (crbug 369219127); the harness forces the RTX with
  `--force_high_performance_gpu` and `adapter()` / the debug overlay report what was used.
* Window placement is never hardcoded: the monitor layout is read at every launch (about 0.5 s), so the harness keeps
  working if monitors are added, removed or rearranged. With only DISPLAY1 connected, anything at x >= 1920 would be
  off-screen (Chrome may throttle or misplace it), so do not position test windows by hand.
