/**
 * Performance runner: frame-time statistics (wall avg / p50 / p95 / p99, main-thread CPU, GPU from timestamp queries)
 * for every spot x condition at 1920x1080, on the production build by default. Writes perf.json and perf.md to
 * E:\shots\island\<round>\perf\.
 *
 *   pnpm perf --round round-01 [--spots ...] [--conditions ...] [--seconds 5] [--fps auto|0|60] [--dev] [--uncapped]
 *
 * --uncapped launches Chrome without vsync or a frame limit (headroom measurement); otherwise the game's own cap
 * applies (an integer divisor of the display refresh, >= 60 fps).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, ensureServer, launch } from './lib/browser';

const a = argv();
const round = a.get('round', 'dev');
const spots = a.get('spots', 'beach,jungle,waterfall,village,cliffs,lighthouse').split(',');
const conditions = a.get('conditions', 'sunrise,noon,sunset,night,rain').split(',');
const seconds = Number(a.get('seconds', '5'));
const fps = a.get('fps', a.has('uncapped') ? '0' : 'auto');
const view = a.get('view', 'follow');
const outDir = join('E:\\shots\\island', round, 'perf');
mkdirSync(outDir, { recursive: true });
const COND: Record<string, { tod: string; weather: 'clear' | 'rain' }> = {
  sunrise: { tod: 'sunrise', weather: 'clear' }, noon: { tod: 'noon', weather: 'clear' }, sunset: { tod: 'sunset', weather: 'clear' },
  night: { tod: 'night', weather: 'clear' }, rain: { tod: '14.5', weather: 'rain' },
};

const server = await ensureServer(a.has('dev') ? 'dev' : 'preview');
const L = await launch({ uncapped: a.has('uncapped') });
const rows: Record<string, unknown>[] = [];
try {
  await L.page.goto(`${server.url}?test=1&hud=0&mute=1&freeze=1&fps=${fps}&spot=${spots[0]}`, { waitUntil: 'domcontentloaded' });
  await L.page.waitForFunction(() => typeof (window as unknown as { __island?: { ready?: unknown } }).__island?.ready === 'function' || !!(window as unknown as { __island?: { error?: string } }).__island?.error, null, { timeout: 180000 });
  await L.page.evaluate(() => (window as unknown as { __island: { ready: () => Promise<boolean> } }).__island.ready());
  for (const cond of conditions) for (const spot of spots) {
    const c = COND[cond];
    await L.page.evaluate(async ([s, tod, w, v]) => {
      const api = (window as unknown as { __island: { stage: (o: unknown) => Promise<unknown> } }).__island;
      await api.stage({ spot: s, tod, weather: w, camera: v === 'shot' ? 'shot' : 'follow', worldTime: null, settleMs: 1500 });
    }, [spot, c.tod, c.weather, view] as const);
    // walk the player slowly in a circle while measuring, so streaming and culling run as in play
    await L.page.evaluate((sec) => (window as unknown as { __island: { act: (a: string, s: number, y?: number) => unknown } }).__island.act('walk', sec), seconds);
    await L.page.waitForTimeout(seconds * 1000);
    const s = await L.page.evaluate(() => (window as unknown as { __island: { stats: () => Record<string, { avg: number; p50: number; p95: number; p99: number; max: number; n: number }> & { fps: number; targetFps: number; refreshHz: number; drawCalls: number; triangles: number } } }).__island.stats());
    const row = {
      spot, condition: cond, fps: +s.fps.toFixed(1), target: +s.targetFps.toFixed(1), refreshHz: s.refreshHz,
      frameAvg: +s.frame.avg.toFixed(2), frameP95: +s.frame.p95.toFixed(2), frameP99: +s.frame.p99.toFixed(2), frameMax: +s.frame.max.toFixed(1),
      cpuAvg: +s.cpu.avg.toFixed(2), cpuP95: +s.cpu.p95.toFixed(2),
      gpuAvg: +s.gpu.avg.toFixed(2), gpuP95: +s.gpu.p95.toFixed(2), gpuP99: +s.gpu.p99.toFixed(2), gpuN: s.gpu.n,
      drawCalls: s.drawCalls, triangles: s.triangles,
    };
    rows.push(row);
    console.log(`${spot.padEnd(10)} ${cond.padEnd(8)} fps ${row.fps} (cap ${row.target}) frame avg ${row.frameAvg} p95 ${row.frameP95} p99 ${row.frameP99} | cpu ${row.cpuAvg} | gpu avg ${row.gpuAvg} p95 ${row.gpuP95} p99 ${row.gpuP99} | ${row.drawCalls} draws ${(row.triangles / 1e6).toFixed(2)} M tris`);
  }
  const adapter = await L.page.evaluate(() => (window as unknown as { __island: { adapter: () => unknown } }).__island.adapter());
  writeFileSync(join(outDir, 'perf.json'), JSON.stringify({ round, fps, adapter, rows, at: new Date().toISOString() }, null, 1));
  const md = ['| spot | condition | fps (cap) | frame avg | p95 | p99 | CPU avg | GPU avg | GPU p95 | GPU p99 | draws | tris (M) |', '|---|---|---|---|---|---|---|---|---|---|---|---|']
    .concat(rows.map((r) => `| ${r.spot} | ${r.condition} | ${r.fps} (${r.target}) | ${r.frameAvg} | ${r.frameP95} | ${r.frameP99} | ${r.cpuAvg} | ${r.gpuAvg} | ${r.gpuP95} | ${r.gpuP99} | ${r.drawCalls} | ${((r.triangles as number) / 1e6).toFixed(2)} |`));
  writeFileSync(join(outDir, 'perf.md'), md.join('\n') + '\n');
  console.log(`-> ${outDir}`);
} finally {
  await L.browser.close();
  server.stop();
}
