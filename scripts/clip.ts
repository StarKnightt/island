/**
 * Motion clips for judging animation: the world is stepped at a fixed rate (manual frames, so every clip is smooth
 * and deterministic however long a capture takes), frames are written as PNGs and joined into an MP4 with ffmpeg.
 *
 *   pnpm clip --round round-01 --name walk_beach --spot beach --tod morning --action walk [--seconds 4] [--fps 30]
 *             [--weather clear|rain] [--camera follow|shot] [--yaw <heading>] [--dev]
 *   pnpm clip --round round-01 --preset all      every standard clip: walk, sprint, jump, swim, waves, foliage, rain
 *
 * Output: E:\shots\island\<round>\clips\<name>\frame_0000.png ... and <name>.mp4 next to the folder.
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

interface ClipDef { name: string; spot: string; tod: string; weather: 'clear' | 'rain'; action: string; camera: string; yaw?: number; seconds?: number }
const PRESETS: ClipDef[] = [
  { name: 'walk_beach', spot: 'beach', tod: 'morning', weather: 'clear', action: 'walk', camera: 'follow', yaw: 0.2 },
  { name: 'sprint_beach', spot: 'beach', tod: 'noon', weather: 'clear', action: 'sprint', camera: 'follow', yaw: 3.2 },
  { name: 'jump_beach', spot: 'beach', tod: 'noon', weather: 'clear', action: 'jump', camera: 'follow', yaw: 0.0, seconds: 2.5 },
  { name: 'swim_pool', spot: 'waterfall', tod: 'noon', weather: 'clear', action: 'swim', camera: 'follow', yaw: -1.6 },
  { name: 'waves_beach', spot: 'beach', tod: 'sunset', weather: 'clear', action: 'idle', camera: 'shot' },
  { name: 'foliage_jungle', spot: 'jungle', tod: 'noon', weather: 'clear', action: 'idle', camera: 'shot' },
  { name: 'rain_village', spot: 'village', tod: '14.5', weather: 'rain', action: 'walk', camera: 'follow', yaw: 3.0 },
];

const list: ClipDef[] = a.get('preset', '') === 'all' ? PRESETS : [{
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
    await L.page.evaluate(async (d) => {
      const api = (window as unknown as { __island: Record<string, (...x: unknown[]) => unknown> }).__island;
      api.manual(false);
      await (api.stage as (o: unknown) => Promise<unknown>)({ spot: d.spot, tod: d.tod, weather: d.weather, camera: d.camera === 'shot' ? 'shot' : 'follow', worldTime: null, settleMs: 800 });
      api.manual(true);
      if (d.action !== 'idle') api.act(d.action, 60, d.yaw);
    }, c);
    const n = Math.round(secs * fps);
    for (let i = 0; i < n; i++) {
      await L.page.evaluate((dt) => (window as unknown as { __island: { step: (n: number, dt: number) => number } }).__island.step(1, dt), 1 / fps);
      await L.page.screenshot({ path: join(dir, `frame_${String(i).padStart(4, '0')}.png`) });
    }
    await L.page.evaluate(() => {
      const api = (window as unknown as { __island: Record<string, (...x: unknown[]) => unknown> }).__island;
      api.act('idle', 0.1);
      api.manual(false);
    });
    const mp4 = join(outRoot, `${c.name}.mp4`);
    const ff = spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(fps), '-i', join(dir, 'frame_%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-threads', '4', mp4]);
    console.log(`${c.name}: ${n} frames${ff.status === 0 && existsSync(mp4) ? ` -> ${mp4}` : ' (ffmpeg failed)'}`);
  }
} finally {
  await L.browser.close();
  server.stop();
}
