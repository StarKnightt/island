# Island

A realistic open-world tropical island that runs in the browser. Vite + TypeScript + three.js r186 `WebGPURenderer`
with TSL node materials (WebGL 2 fallback through the same renderer).

You spawn on a beach at sunrise. Everything you can see is reachable on foot: the rainforest, a 20 m waterfall with a
pool you can swim in, a fishing village with jetties and outrigger canoes, 50-85 m sea cliffs, and a lighthouse on the
214 m summit with a view over the whole island. The day runs on its own, squalls roll in and clear, and the sound
follows where you are: surf, wind, birds, rain, the falls, and footsteps that change with the ground.

## Run it

```bash
pnpm install
pnpm dev        # http://127.0.0.1:5230/
pnpm build      # type-check + production build into dist/
pnpm preview    # serves dist/ at http://127.0.0.1:5231/ (what viewers get)
```

Chrome or Edge with WebGPU gives the full picture. Browsers without WebGPU fall back to WebGL 2, with a still sea.

## Controls

| | Keyboard and mouse | Gamepad |
|---|---|---|
| Look | click, then move the mouse | right stick |
| Move | WASD | left stick |
| Sprint / walk | Shift / Ctrl | B or L3 |
| Jump | Space | A |
| Photo mode | P or F (WASD/QE fly, `[` `]` lens) | |
| Mute / debug overlay | M / F3 | |

URL parameters jump straight to a place, time and weather, for example `?spot=waterfall&tod=noon&weather=clear`.
`spot`: `beach` `jungle` `waterfall` `village` `cliffs` `lighthouse`; `tod`: `sunrise` `morning` `noon` `afternoon`
`sunset` `dusk` `night` or an hour; `weather`: `clear` `rain` `auto`; `freeze=1` stops the clock; `hud=0` hides the
HUD. The full list and the `window.__island` debug API are in [TESTING.md](TESTING.md).

## Five camera spots for recording

Each one opens with a URL. In the browser console, `await __island.stage({ ... })` then puts the camera on the
authored shot for that place (the sunset variants turn toward the sun). Press P for photo mode to fine-tune the frame.

1. **Beach at sunrise:** the spawn, looking along the crescent beach to the sea and the palm islet as the sun comes up.
   `?spot=beach&tod=sunrise&weather=clear&hud=0`, then `__island.stage({ spot: 'beach', tod: 'sunrise', camera: 'shot', worldTime: null })`
2. **Lighthouse gallery at sunset:** from the rail across the canopy and the island's west coast, the sun going down over
   the sea at the right of the frame (crop the dark tip at the bottom-right corner with a longer lens, `]` in photo mode).
   `?spot=lighthouse&tod=sunset&weather=clear&hud=0`, then `__island.stage({ spot: 'lighthouse', tod: 'sunset', camera: 'shot', worldTime: null })`
3. **Waterfall at noon:** from the east bank across the plunge pool to the falls, with the sun high in the gorge.
   `?spot=waterfall&tod=noon&weather=clear&hud=0`, then `__island.stage({ spot: 'waterfall', tod: 'noon', camera: 'shot', worldTime: null })`
4. **Village at sunset:** from the end of the main jetty, past the moored canoes, to the western shore in the low sun.
   `?spot=village&tod=sunset&weather=clear&hud=0`, then `__island.stage({ spot: 'village', tod: 'sunset', camera: 'shot', worldTime: null })`
5. **Sea cliffs in the afternoon:** from a boat off the north coast along the 50-80 m cliffs, the surf breaking at their
   feet. `?spot=cliffs&tod=afternoon&weather=clear&hud=0`, then `__island.stage({ spot: 'cliffs', tod: 'afternoon', camera: 'shot', worldTime: null })`

Also worth a take: the beach at dusk (`tod: 'dusk'`), with the moon rising over the sea, and a squall walking in over the
village (`__island.timelapse({ squall: 6 })`).

## How it is built

* **World:** an authored island (`src/world/layout.ts`) baked offline by `pnpm gen:island` into heights, masks and
  shore distance: coastline, hills, the summit cone, an 844 m river with its falls, the village terrace, trails.
* **Rendering:** CDLOD terrain with an 8-layer splat; Hillaire-style sky and aerial perspective; cascaded shadows;
  a 3-cascade FFT ocean on WebGPU compute with breakers and swash; GTAO, temporal AA, bloom, AgX.
* **Vegetation:** about 140k plants plus grass, in layers (palms, pandanus, scrub, canopy, mid-storey, understory,
  floor), built in Blender, with wind, LODs and a far canopy shell.
* **Gameplay and sound:** a kinematic third-person controller (walk, sprint, jump, wade, swim) and Web Audio
  ambience by place, time and weather.

[NOTES.md](NOTES.md) has the architecture, the asset pipeline and the known weak spots.

## Credits and licence

The code is MIT ([LICENSE](LICENSE)). Third-party models, textures and sounds keep their own licences, listed in
[CREDITS.md](CREDITS.md).
