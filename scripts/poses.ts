/**
 * Development captures of several camera poses in one session, for framing shots:
 *   pnpm tsx scripts/poses.ts --file poses.json [--q "tod=noon&weather=clear"] [--preview] [--uncapped] [--fresh]
 * poses.json: [{ "name": "a", "pos": [x, y, z] | [x, "+2", z], "target": [x, y, z], "fov": 55 }]
 * A y given as "+h" is h metres above the ground (or the sea) at that point. PNGs go to E:\shots\island\dev\.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, ensureServer, launch, DEV_PROFILE } from './lib/browser';

type Y = number | string;
interface Pose { name: string; pos: [number, Y, number]; target: [number, Y, number]; fov?: number; tod?: string; weather?: string }

const a = argv();
const poses: Pose[] = JSON.parse(readFileSync(a.get('file', 'poses.json'), 'utf8'));
const q = a.get('q', 'tod=noon&weather=clear');
const outDir = 'E:\\shots\\island\\dev';
mkdirSync(outDir, { recursive: true });

const server = await ensureServer(a.has('preview') ? 'preview' : 'dev');
// (a persistent profile: Chrome keeps the compiled shaders, so a capture loads in seconds; --fresh: a new one)
const L = await launch({ uncapped: a.has('uncapped'), profile: a.has('fresh') ? undefined : DEV_PROFILE });
try {
  await L.page.goto(`${server.url}?test=1&hud=0&mute=1&freeze=1&${q}`, { waitUntil: 'domcontentloaded' });
  await L.page.waitForFunction(() => {
    const w = window as unknown as { __island?: { error?: string; ready?: unknown } };
    return !!w.__island && (!!w.__island.error || typeof w.__island.ready === 'function');
  }, null, { timeout: 180000 });
  await L.page.evaluate(() => (window as unknown as { __island: { ready: () => Promise<boolean> } }).__island.ready());
  for (const p of poses) {
    // a source string, not a function: tsx's keepNames helpers do not exist in the page
    const res = await L.page.evaluate(`(async (pose) => {
      const api = window.__island, hf = api.ctx.hf;
      const y = function (v, x, z) { return typeof v === 'string' ? Math.max(hf.height(x, z), 0) + Number(v) : v; };
      const pos = [pose.pos[0], y(pose.pos[1], pose.pos[0], pose.pos[2]), pose.pos[2]];
      const target = [pose.target[0], y(pose.target[1], pose.target[0], pose.target[2]), pose.target[2]];
      await api.stage({ tod: pose.tod, weather: pose.weather, camera: { pos, target, fov: pose.fov || 55 }, worldTime: 1000, settleMs: 1200 });
      return { pos, target };
    })(${JSON.stringify(p)})`);
    const file = join(outDir, `${p.name}.png`);
    await L.page.screenshot({ path: file });
    console.log(`${p.name}: ${JSON.stringify(res)}`);
  }
  if (L.console.length) console.log('console:\n' + L.console.filter((l) => !l.includes('powerPreference') && !l.startsWith('[log]')).slice(0, 15).join('\n'));
} finally {
  await L.browser.close();
  server.stop();
}
