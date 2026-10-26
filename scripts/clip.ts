/**
 * Motion clips for judging animation: the world is stepped at a fixed rate (manual frames, so every clip is smooth
 * and deterministic however long a capture takes), frames are written as PNGs and joined into an MP4 with ffmpeg.
 *
 *   pnpm clip --round round-01 --name walk_beach --spot beach --tod morning --action walk [--seconds 4] [--fps 30]
 *             [--weather clear|rain] [--camera follow|shot] [--yaw <heading>] [--dev]
 *   pnpm clip --round round-01 --preset all        every standard clip: walk, sprint, jump, swim, waves, foliage, rain
 *   pnpm clip --round round-01 --preset timelapse  the two time-lapses: a whole day at the beach (24 s), and a
 *                                                  squall rolling in over the beach and clearing (25 s)
 *   pnpm clip --round round-01 --preset <name>     one preset by name (e.g. timelapse_day)
 *
 * Output: E:\shots\island\<round>\clips\<name>\frame_0000.png (.jpg for time-lapses) ... and <name>.mp4 next to the
 * folder. Time-lapses step the world at real time (waves, foliage and rain move as in life) while the clock runs a
 * whole day in `dayMinutes` (the sun, sky, clouds, lamps and exposure follow) or the weather runs `squall` times
 * faster than life (see __island.timelapse in TESTING.md).
 */
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { argv, ensureServer, launch } from './lib/browser';

const a = argv();
const round = a.get('round', 'dev');
const fps = Number(a.get('fps', '30'));
const seconds = Number(a.get('seconds', '4'));
const outRoot = join('E:\\shots\\island', round, 'clips');
mkdirSync(outRoot, { recursive: true });

interface ClipDef {
  name: string; spot: string; tod: string; weather: 'clear' | 'rain'; action: string; camera: string; yaw?: number; seconds?: number;
  fps?: number; timelapse?: { dayMinutes?: number; squall?: number };
}
const TIMELAPSES: ClipDef[] = [
  // from before dawn through sunrise, noon, sunset and the night (lamps, moon, stars) back to the next dawn
  { name: 'timelapse_day', spot: 'beach', tod: '4.5', weather: 'clear', action: 'idle', camera: 'shot', seconds: 24, fps: 15, timelapse: { dayMinutes: 0.4 } },
  // a clear early afternoon: the cloud gathers, the squall rains, it clears again (12x)
  { name: 'timelapse_rain', spot: 'beach', tod: '13', weather: 'clear', action: 'idle', camera: 'shot', seconds: 25, fps: 15, timelapse: { squall: 12 } },
];
const PRESETS: ClipDef[] = [
  { name: 'walk_beach', spot: 'beach', tod: 'morning', weather: 'clear', action: 'walk', camera: 'follow', yaw: 0.2 },
  { name: 'sprint_beach', spot: 'beach', tod: 'noon', weather: 'clear', action: 'sprint', camera: 'follow', yaw: 3.2 },
  { name: 'jump_beach', spot: 'beach', tod: 'noon', weather: 'clear', action: 'jump', camera: 'follow', yaw: 0.0, seconds: 2.5 },
  { name: 'swim_pool', spot: 'waterfall', tod: 'noon', weather: 'clear', action: 'swim', camera: 'follow', yaw: -1.6 },
  { name: 'waves_beach', spot: 'beach', tod: 'sunset', weather: 'clear', action: 'idle', camera: 'shot' },
  { name: 'foliage_jungle', spot: 'jungle', tod: 'noon', weather: 'clear', action: 'idle', camera: 'shot' },
  { name: 'rain_village', spot: 'village', tod: '14.5', weather: 'rain', action: 'walk', camera: 'follow', yaw: 3.0 },
];

const preset = a.get('preset', '');
const named = [...PRESETS, ...TIMELAPSES].filter((c) => c.name === preset);
const list: ClipDef[] = preset === 'all' ? PRESETS : preset === 'timelapse' ? TIMELAPSES : named.length ? named : [{
  name: a.get('name', 'clip'), spot: a.get('spot', 'beach'), tod: a.get('tod', 'noon'), weather: a.get('weather', 'clear') as 'clear' | 'rain',
  action: a.get('action', 'walk'), camera: a.get('camera', 'follow'), yaw: a.has('yaw') ? Number(a.get('yaw', '0')) : undefined,
}];

const server = await ensureServer(a.has('dev') ? 'dev' : 'preview');
const L = await launch();
try {
  await L.page.goto(`${server.url}?test=1&hud=0&mute=1&freeze=1&spot=${list[0].spot}`, { waitUntil: 'domcontentloaded' });
  await L.page.waitForFunction(() => typeof (window as unknown as { __island?: { ready?: unknown } }).__island?.ready === 'function', null, { timeout: 180000 });
  await L.page.evaluate(() => (window as unknown as { __island: { ready: () => Promise<boolean> } }).__island.ready());
  for (const c of list) {
    const dir = join(outRoot, c.name);
    mkdirSync(dir, { recursive: true });
    const secs = c.seconds ?? seconds;
    const rate = c.fps ?? fps;
    // time-lapses are long: JPEG frames keep the folder small
    const ext = c.timelapse ? 'jpg' : 'png';
    await L.page.evaluate(async (d) => {
      const api = (window as unknown as { __island: Record<string, (...x: unknown[]) => unknown> }).__island;
      api.manual(false);
      await (api.stage as (o: unknown) => Promise<unknown>)({ spot: d.spot, tod: d.tod, weather: d.weather, camera: d.camera === 'shot' ? 'shot' : 'follow', worldTime: null, settleMs: 800 });
      api.manual(true);
      if (d.timelapse) api.timelapse(d.timelapse);
      if (d.action !== 'idle') api.act(d.action, 60, d.yaw);
    }, c);
    const n = Math.round(secs * rate);
    for (let i = 0; i < n; i++) {
      await L.page.evaluate((dt) => (window as unknown as { __island: { step: (n: number, dt: number) => number } }).__island.step(1, dt), 1 / rate);
      const path = join(dir, `frame_${String(i).padStart(4, '0')}.${ext}`);
      // (always the full 1920x1080 frame: an emulated viewport on another display once gave 1920x1079)
      const clip = { x: 0, y: 0, width: 1920, height: 1080 };
      await L.page.screenshot(ext === 'jpg' ? { path, type: 'jpeg', quality: 90, clip } : { path, clip });
    }
    await L.page.evaluate(() => {
      const api = (window as unknown as { __island: Record<string, (...x: unknown[]) => unknown> }).__island;
      api.act('idle', 0.1);
      api.timelapse({});
      api.manual(false);
    });
    const mp4 = join(outRoot, `${c.name}.mp4`);
    const ff = spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(rate), '-i', join(dir, `frame_%04d.${ext}`), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-threads', '4', mp4]);
    console.log(`${c.name}: ${n} frames${ff.status === 0 && existsSync(mp4) ? ` -> ${mp4}` : ' (ffmpeg failed)'}`);
  }
} finally {
  await L.browser.close();
  server.stop();
}
