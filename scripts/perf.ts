/**
 * Performance runner: frame-time statistics (wall avg / p50 / p95 / p99, main-thread CPU, GPU from timestamp queries)
 * for every spot x condition at 1920x1080, on the production build by default. Writes perf.json and perf.md to
 * E:\shots\island\<round>\perf\.
 *
 *   pnpm perf --round round-01 [--spots ...] [--conditions ...] [--seconds 5] [--mode both|uncapped|capped] [--dev]
 *             [--q "extra=url&params"]
 *
 * By default it runs twice: once uncapped (Chrome without vsync or a frame limit, the game's cap off: the frame time a
 * view really costs, whatever display the window is on) and once with the game's own cap (an integer divisor of the
 * refresh of the display the window is on, >= 60 fps: what a player sees on that display). `--uncapped` = mode
 * uncapped, `--fps <n>` sets the cap of the capped run.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, ensureServer, launch } from './lib/browser';

const a = argv();
const round = a.get('round', 'dev');
const spots = a.get('spots', 'beach,jungle,waterfall,village,cliffs,lighthouse').split(',');
const conditions = a.get('conditions', 'sunrise,noon,sunset,night,rain').split(',');
const seconds = Number(a.get('seconds', '5'));
const mode = a.has('uncapped') ? 'uncapped' : a.get('mode', 'both');
const view = a.get('view', 'follow');
const outDir = join('E:\\shots\\island', round, 'perf');
mkdirSync(outDir, { recursive: true });
const COND: Record<string, { tod: string; weather: 'clear' | 'rain' }> = {
  sunrise: { tod: 'sunrise', weather: 'clear' }, noon: { tod: 'noon', weather: 'clear' }, sunset: { tod: 'sunset', weather: 'clear' },
  night: { tod: 'night', weather: 'clear' }, rain: { tod: '14.5', weather: 'rain' },
};
type Stat = { avg: number; p50: number; p95: number; p99: number; max: number; n: number };
type Stats = { fps: number; targetFps: number; refreshHz: number; drawCalls: number; triangles: number; frame: Stat; cpu: Stat; gpu: Stat };
interface Run { fps: number; target: number; refreshHz: number; frameAvg: number; frameP95: number; frameP99: number; frameMax: number; cpuAvg: number; cpuP95: number; gpuAvg: number; gpuP95: number; gpuP99: number; gpuN: number; drawCalls: number; triangles: number }

const server = await ensureServer(a.has('dev') ? 'dev' : 'preview');
const runs: Record<string, Map<string, Run>> = {};
let adapter: unknown = null;
let placement: unknown = null;
try {
  for (const m of mode === 'both' ? ['uncapped', 'capped'] : [mode]) {
    const uncapped = m === 'uncapped';
    const fps = uncapped ? '0' : a.get('fps', 'auto');
    const L = await launch({ uncapped });
    const rows = new Map<string, Run>();
    runs[m] = rows;
    try {
      const extra = a.get('q', '');
      await L.page.goto(`${server.url}?test=1&hud=0&mute=1&freeze=1&fps=${fps}&spot=${spots[0]}${extra ? `&${extra}` : ''}`, { waitUntil: 'domcontentloaded' });
      await L.page.waitForFunction(() => typeof (window as unknown as { __island?: { ready?: unknown } }).__island?.ready === 'function' || !!(window as unknown as { __island?: { error?: string } }).__island?.error, null, { timeout: 180000 });
      await L.page.evaluate(() => (window as unknown as { __island: { ready: () => Promise<boolean> } }).__island.ready());
      console.log(`--- ${m} (${L.display.name}, cap ${fps})`);
      for (const cond of conditions) for (const spot of spots) {
        const c = COND[cond];
        await L.page.evaluate(async ([s, tod, w, v]) => {
          const api = (window as unknown as { __island: { stage: (o: unknown) => Promise<unknown> } }).__island;
          await api.stage({ spot: s, tod, weather: w, camera: v === 'shot' ? 'shot' : 'follow', worldTime: null, settleMs: 1500 });
        }, [spot, c.tod, c.weather, view] as const);
        // walk the player slowly while measuring, so streaming and culling run as in play
        await L.page.evaluate((sec) => (window as unknown as { __island: { act: (a: string, s: number, y?: number) => unknown } }).__island.act('walk', sec), seconds);
        await L.page.waitForTimeout(seconds * 1000);
        const s = await L.page.evaluate(() => (window as unknown as { __island: { stats: () => Stats } }).__island.stats());
        const row: Run = {
          fps: +s.fps.toFixed(1), target: +s.targetFps.toFixed(1), refreshHz: s.refreshHz,
          frameAvg: +s.frame.avg.toFixed(2), frameP95: +s.frame.p95.toFixed(2), frameP99: +s.frame.p99.toFixed(2), frameMax: +s.frame.max.toFixed(1),
          cpuAvg: +s.cpu.avg.toFixed(2), cpuP95: +s.cpu.p95.toFixed(2),
          gpuAvg: +s.gpu.avg.toFixed(2), gpuP95: +s.gpu.p95.toFixed(2), gpuP99: +s.gpu.p99.toFixed(2), gpuN: s.gpu.n,
          drawCalls: s.drawCalls, triangles: s.triangles,
        };
        rows.set(`${spot}|${cond}`, row);
        console.log(`${m.padEnd(8)} ${spot.padEnd(10)} ${cond.padEnd(8)} fps ${row.fps}${uncapped ? '' : ` (cap ${row.target} @ ${row.refreshHz} Hz)`} frame avg ${row.frameAvg} p95 ${row.frameP95} p99 ${row.frameP99} | cpu ${row.cpuAvg} | gpu ${row.gpuAvg} | ${row.drawCalls} draws ${(row.triangles / 1e6).toFixed(2)} M tris`);
      }
      adapter = await L.page.evaluate(() => (window as unknown as { __island: { adapter: () => unknown } }).__island.adapter());
      placement = { display: L.display.name, size: [L.display.width, L.display.height], viewport: L.viewportMode };
    } finally {
      await L.browser.close();
    }
  }
  const rows: Record<string, unknown>[] = [];
  for (const cond of conditions) for (const spot of spots) {
    const k = `${spot}|${cond}`;
    rows.push({ spot, condition: cond, uncapped: runs.uncapped?.get(k) ?? null, capped: runs.capped?.get(k) ?? null });
  }
  writeFileSync(join(outDir, 'perf.json'), JSON.stringify({ round, mode, adapter, placement, rows, at: new Date().toISOString() }, null, 1));
  const f = (v: number | undefined, d = 1) => (v === undefined ? '-' : v.toFixed(d));
  const md = [
    '| spot | condition | uncapped fps | frame avg | p95 | p99 | capped fps (cap @ Hz) | capped p99 | CPU avg | GPU avg | draws | tris (M) |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ].concat(rows.map((r) => {
    const u = r.uncapped as Run | null, c = r.capped as Run | null, any = u ?? c!;
    return `| ${r.spot} | ${r.condition} | ${f(u?.fps)} | ${f(u?.frameAvg, 2)} | ${f(u?.frameP95, 2)} | ${f(u?.frameP99, 2)} | ${c ? `${f(c.fps)} (${f(c.target)} @ ${c.refreshHz})` : '-'} | ${f(c?.frameP99, 2)} | ${f(any.cpuAvg, 2)} | ${f(any.gpuAvg, 2)} | ${any.drawCalls} | ${(any.triangles / 1e6).toFixed(2)} |`;
  }));
  const un = rows.map((r) => (r.uncapped as Run | null)?.fps).filter((v): v is number => v !== undefined);
  if (un.length) md.push('', `Uncapped: ${un.filter((v) => v >= 60).length} / ${un.length} at >= 60 fps, ${un.filter((v) => v >= 70).length} at >= 70 fps, lowest ${Math.min(...un).toFixed(1)} fps.`);
  writeFileSync(join(outDir, 'perf.md'), md.join('\n') + '\n');
  console.log(md.slice(-1)[0]);
  console.log(`-> ${outDir}`);
} finally {
  server.stop();
}
