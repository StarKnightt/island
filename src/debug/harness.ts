/**
 * The test harness API on window.__island (TESTING.md documents it). The critic drives captures through it and
 * never reads the source, so every call is defensive and returns plain JSON.
 */
import * as THREE from 'three/webgpu';
import type { Engine } from '../core/Engine';
import type { TimeOfDay } from '../sky/TimeOfDay';
import { TOD_PRESETS, params, seedRandom } from '../core/params';
import { heroU } from '../player/heroMaterials';
import { clouds } from '../sky/Sky';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Ctx = { engine: Engine; tod: TimeOfDay; [k: string]: any };

export function installHarness(ctx: Ctx) {
  const { engine, tod } = ctx;
  // the averaged capture's extra renders: the hair and sky dithers move on as they do from frame to frame
  engine.onSubframe.push(() => {
    heroU.frame.value = (heroU.frame.value + 1) % 64;
    clouds.frame.value = (clouds.frame.value + 1) % 64;
  });
  let readyAt = 0;
  let stepHooked = false;
  const stepLog: { surface: string; foot: number; pos: number[] }[] = [];
  const api = {
    version: 1,
    error: null as string | null,
    ctx,
    /** resolves when streaming, shader compilation and settling are done */
    async ready(timeoutMs = 120000) {
      const t0 = performance.now();
      for (;;) {
        // (and the loading screen gone from the page, not just fading)
        const busy = (ctx.isBusy?.() ?? false) || !!document.getElementById('loading');
        if (!busy && engine.frame > 30) {
          if (!readyAt) readyAt = performance.now();
          if (performance.now() - readyAt > 400) {
            if (!ctx.timeline?.some((m: { name: string }) => m.name === 'ready')) ctx.timeline?.push({ name: 'ready', ms: Math.round(performance.now()) });
            return true;
          }
        } else readyAt = 0;
        if (performance.now() - t0 > timeoutMs) return false;
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    /** load milestones in ms since navigation start: boot, heightfield, vegetation, character, shaders, first frame,
     *  streamed groups (terrain layers, foliage textures, rocks), ready */
    timeline() {
      return ctx.timeline ?? [];
    },
    /** frame-time statistics since the last reset (ms) */
    stats() {
      return { ...engine.stats(), backend: engine.backendName, adapter: api.adapter() };
    },
    resetStats() {
      engine.resetStats();
    },
    adapter() {
      return { name: engine.gpu_name, ...engine.adapterInfo, backend: engine.backendName };
    },
    /** set the time of day: preset name or hours; freeze stops it advancing */
    setTime(t: string | number, freeze = true) {
      const h = typeof t === 'string' ? (TOD_PRESETS[t] ?? Number(t)) : t;
      tod.setHour(h);
      tod.frozen = freeze;
      ctx.sky?.update(0, engine.scene, true);
      return tod.hour;
    },
    getTime() {
      return { hour: tod.hour, frozen: tod.frozen, sunElevationDeg: (tod.sunElevation * 180) / Math.PI, exposure: tod.exposure };
    },
    setWeather(w: 'clear' | 'rain' | 'auto', immediate = true) {
      return ctx.weather?.set(w, immediate) ?? null;
    },
    getWeather() {
      return ctx.weather?.state() ?? null;
    },
    /**
     * Time-lapse (for filming the automatic day cycle and a squall): `dayMinutes` runs the clock with a day that
     * long (e.g. 0.4 = a whole day in 24 s; the light, sky, clouds, lamps and exposure all follow); `squall` runs one
     * squall from a clear sky that many times faster than life (gathering 70 s, rain 150 s, clearing 80 s at 1x).
     * timelapse({}) restores the normal day length and real-time weather.
     */
    timelapse(o: { dayMinutes?: number; squall?: number }) {
      if (o.dayMinutes) {
        tod.dayMinutes = o.dayMinutes;
        tod.frozen = false;
      } else tod.dayMinutes = ctx.dayMinutes ?? 30;
      ctx.weather?.squall(o.squall ?? 0);
      return { time: api.getTime(), weather: api.getWeather() };
    },
    /** move the player to a named spot (beach, jungle, waterfall, village, cliffs, lighthouse) */
    spot(name: string) {
      return ctx.player?.toSpot(name) ?? ctx.goSpot?.(name) ?? null;
    },
    spots() {
      return ctx.spotNames ?? [];
    },
    /** camera: 'follow' (third person), 'orbit', 'free', or explicit position + target */
    setCamera(mode: string | { pos: number[]; target: number[]; fov?: number }) {
      return ctx.cameraRig?.set(mode) ?? null;
    },
    getCamera() {
      const c = engine.camera;
      const d = new THREE.Vector3();
      c.getWorldDirection(d);
      return { pos: c.position.toArray(), dir: d.toArray(), fov: c.fov, mode: ctx.cameraRig?.mode ?? 'debug' };
    },
    hud(show: boolean) {
      ctx.hud?.show(show);
      return show;
    },
    /** the debug overlay (adapter, fps, frame / CPU / GPU ms, draws, position): also ?debug=1 or F3 */
    debugOverlay(show: boolean) {
      ctx.dbg?.show(show);
      return show;
    },
    mute(m: boolean) {
      ctx.audio?.mute(m);
      return m;
    },
    audio() {
      return ctx.audio?.state() ?? null;
    },
    /** trigger a character action: walk, sprint, jump, swim, idle (with optional duration in s and heading) */
    act(action: string, seconds = 3, yaw?: number) {
      return ctx.player?.act(action, seconds, yaw) ?? null;
    },
    player() {
      return ctx.player?.state() ?? null;
    },
    fps(cap: string | number) {
      engine.applyCap(cap);
      return engine.targetFps;
    },
    quality() {
      return ctx.quality ?? null;
    },
    /** one call to stage a capture: spot, time of day, weather, camera ('follow' | 'shot' | pose), frozen world time */
    async stage(o: { spot?: string; tod?: string | number; weather?: 'clear' | 'rain' | 'auto'; camera?: string | { pos: number[]; target: number[]; fov?: number }; worldTime?: number | null; settleMs?: number }) {
      if (o.spot) api.spot(o.spot);
      if (o.tod !== undefined) api.setTime(o.tod, true);
      if (o.weather) api.setWeather(o.weather, true);
      if (o.worldTime !== undefined) engine.frozenTime = o.worldTime;
      if (o.camera === 'shot' && o.spot) {
        // (the low evening sun gets a pose that looks into it where the spot's own does not)
        const pose = ctx.shotPoseFor?.(o.spot) ?? ctx.shotPoses?.[o.spot];
        if (pose) api.setCamera(pose);
      } else if (o.camera) api.setCamera(o.camera as never);
      else api.setCamera('follow');
      ctx.forceRefresh?.();
      await api.ready(60000);
      engine.resetPacing();
      await new Promise((r) => setTimeout(r, o.settleMs ?? 1200));
      engine.resetStats();
      return { time: api.getTime(), weather: api.getWeather(), camera: api.getCamera(), player: api.player() };
    },
    /** freeze (number) or release (null) the world animation clock */
    pauseWorld(t: number | null) {
      engine.frozenTime = t;
      return t;
    },
    /** manual stepping for motion clips: manual(true), then step(n, dt) advances n fixed frames */
    manual(on: boolean) {
      engine.manual = on;
      return on;
    },
    step(n = 1, dt = 1 / 30) {
      for (let i = 0; i < n; i++) engine.stepOnce(dt);
      return engine.frame;
    },
    /** start a trailer shot from a known state: the world clock at `worldTime` s, the capture's random sequence at
     *  `seed` (?capture=1 only), the time of day frozen, the metered exposure times `exposure` (a grade per shot) */
    shotStart(worldTime: number, seed: number, exposure = 1) {
      engine.frozenTime = null;
      engine.time = worldTime;
      seedRandom(seed);
      tod.frozen = true;
      ctx.exposureBias = exposure;
      return engine.time;
    },
    /** put the player down at x, z (on the ground or deck there) facing `yaw`, standing still */
    placePlayer(x: number, z: number, yaw: number) {
      const p = ctx.player?.obj;
      if (!p) return null;
      if (ctx.input) ctx.input.scripted = null;
      p.place(x, z, yaw);
      return api.player();
    },
    /**
     * One trailer frame (pnpm record, manual mode): the camera at an exact pose, the player walking toward world
     * heading `walk` (radians, as act) or standing (`null`), then exactly `dt` seconds of world and one render.
     * Returns the player, the footsteps of this frame and whether any pipeline was still compiling (a mesh whose
     * pipeline is not ready is not drawn).
     */
    shotFrame(o: { cam: { pos: number[]; target: number[]; fov?: number } | 'follow'; snap?: number; pitch?: number; walk: number | null; mode?: 'walk' | 'run' | 'sprint'; jump?: boolean; accum?: number; dt?: number }) {
      const p = ctx.player?.obj;
      if (p && !stepHooked) {
        stepHooked = true;
        const prev = p.onStep;
        p.onStep = (e: { surface: string; speed: number; foot: number; pos: THREE.Vector3 }) => {
          prev?.(e);
          stepLog.push({ surface: e.surface, foot: e.foot, pos: e.pos.toArray().map((v: number) => +v.toFixed(2)) });
        };
      }
      // 'follow': the game's own third-person camera, as in play (`snap`: first put it behind that heading)
      if (o.cam !== 'follow') api.setCamera(o.cam);
      else if (ctx.cameraRig && (ctx.cameraRig.mode !== 'follow' || o.snap !== undefined)) {
        ctx.cameraRig.set('follow');
        if (o.snap !== undefined) ctx.cameraRig.snapBehind(o.snap);
      }
      // (as the mouse would: the follow camera's pitch, negative looks up)
      if (o.pitch !== undefined && ctx.cameraRig) ctx.cameraRig.pitch = o.pitch;
      const mode = o.mode ?? 'walk';
      if (ctx.input) ctx.input.scripted = o.walk === null ? null : { t: 1, intent: { moveX: 0, moveY: 1, walk: mode === 'walk', sprint: mode === 'sprint', jump: !!o.jump, worldYaw: o.walk } };
      stepLog.length = 0;
      const pending = engine.pipelinesPending;
      // (?accum=n: n renders averaged; `accum` overrides it for this frame, 1 for an uncaptured warm-up)
      engine.accum = o.accum ?? params.accum;
      engine.stepOnce(o.dt ?? 1 / 60);
      const s = p ? { pos: p.pos.toArray().map((v: number) => +v.toFixed(3)), heading: +p.heading.toFixed(4), speed: +p.speed.toFixed(3) } : null;
      const cam = engine.camera.position.toArray().map((v: number) => +v.toFixed(3));
      return { frame: engine.frame, player: s, cam, steps: stepLog.slice(), pending: Math.max(pending, engine.pipelinesPending) };
    },
    /** debug: read back a few texels of a named render target */
    async readRT(name: string, x = 0, y = 0, w = 4, h = 4) {
      const rt = ctx.rts?.[name] as THREE.RenderTarget | undefined;
      if (!rt) return null;
      const data = await engine.renderer.readRenderTargetPixelsAsync(rt, x, y, w, h);
      return Array.from(data as ArrayLike<number>).slice(0, w * h * 4);
    },
    /**
     * What the camera sees at a screen point (x, y from the top left, 0..1): the nearest meshes along the ray, each
     * with its name, its parent's name, distance, hit point and instance. `root` limits the search to one named group
     * ('rockkit', 'vegetation', 'village', 'river', 'lighthouse'); the terrain and ocean are shaded on the GPU and are
     * not found.
     */
    pick(x: number, y: number, root?: string) {
      // (the camera's matrices are otherwise only brought up to date by the next rendered frame)
      engine.camera.updateMatrixWorld(true);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(x * 2 - 1, 1 - y * 2), engine.camera);
      ray.camera = engine.camera;
      const from = root ? engine.scene.getObjectByName(root) : engine.scene;
      if (!from) return null;
      return ray.intersectObject(from, true).filter((h) => h.object.visible).slice(0, 4).map((h) => ({
        name: h.object.name, parent: h.object.parent?.name ?? '', d: +h.distance.toFixed(2),
        p: h.point.toArray().map((v) => +v.toFixed(2)), instance: h.instanceId ?? null,
      }));
    },
    info() {
      const r = engine.renderer.info;
      return { drawCalls: r.render.drawCalls, triangles: r.render.triangles, geometries: r.memory.geometries, textures: r.memory.textures, terrainNodes: ctx.terrain?.selected };
    },
  };
  (window as unknown as { __island: typeof api }).__island = api;
  return api;
}
