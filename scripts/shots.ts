/**
 * Screenshot runner for the critic: every spot x condition at a true 1920x1080, from the production build (preview)
 * by default, in the installed Chrome on the second monitor with the RTX. Writes <spot>_<condition>.png and
 * report.json to E:\shots\island\<round>\.
 *
 *   pnpm shots --round round-01 [--spots beach,jungle] [--conditions sunrise,noon,sunset,night,rain]
 *              [--view shot|follow] [--dev] [--quality high] [--settle 1500]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, ensureServer, launch } from './lib/browser';

const a = argv();
const round = a.get('round', 'dev');
const spots = a.get('spots', 'beach,jungle,waterfall,village,cliffs,lighthouse').split(',');
const conditions = a.get('conditions', 'sunrise,noon,sunset,night,rain').split(',');
const view = a.get('view', 'shot');
const quality = a.get('quality', 'high');
const settle = Number(a.get('settle', '1500'));
const outDir = join('E:\\shots\\island', round);
mkdirSync(outDir, { recursive: true });

/** a condition is a time of day plus weather */
const COND: Record<string, { tod: string; weather: 'clear' | 'rain' }> = {
  sunrise: { tod: 'sunrise', weather: 'clear' },
  morning: { tod: 'morning', weather: 'clear' },
  noon: { tod: 'noon', weather: 'clear' },
  afternoon: { tod: 'afternoon', weather: 'clear' },
  sunset: { tod: 'sunset', weather: 'clear' },
  dusk: { tod: 'dusk', weather: 'clear' },
  night: { tod: 'night', weather: 'clear' },
  rain: { tod: '14.5', weather: 'rain' },
};

const server = await ensureServer(a.has('dev') ? 'dev' : 'preview');
const L = await launch();
const results: unknown[] = [];
const t0 = Date.now();
try {
  await L.page.goto(`${server.url}?test=1&hud=0&mute=1&freeze=1&quality=${quality}&spot=${spots[0]}`, { waitUntil: 'domcontentloaded' });
  await L.page.waitForFunction(() => {
    const w = window as unknown as { __island?: { error?: string; ready?: unknown } };
    return !!w.__island && (!!w.__island.error || typeof w.__island.ready === 'function');
  }, null, { timeout: 180000 });
  const err = await L.page.evaluate(() => (window as unknown as { __island: { error?: string } }).__island.error ?? null);
  if (err) throw new Error(err);
  await L.page.evaluate(() => (window as unknown as { __island: { ready: () => Promise<boolean> } }).__island.ready());
  const loadMs = Date.now() - t0;
  const adapter = await L.page.evaluate(() => (window as unknown as { __island: { adapter: () => unknown } }).__island.adapter());
  console.log(`ready in ${loadMs} ms on ${JSON.stringify(adapter)}`);
  for (const cond of conditions) {
    const c = COND[cond];
    if (!c) {
      console.log('unknown condition', cond);
      continue;
    }
    for (const spot of spots) {
      const staged = await L.page.evaluate(async ([s, tod, w, v, st]) => {
        const api = (window as unknown as { __island: { stage: (o: unknown) => Promise<unknown> } }).__island;
        return api.stage({ spot: s, tod, weather: w, camera: v === 'shot' ? 'shot' : 'follow', worldTime: 1000, settleMs: st });
      }, [spot, c.tod, c.weather, view, settle] as const);
      const file = join(outDir, `${spot}_${cond}.png`);
      await L.page.screenshot({ path: file });
      const stats = await L.page.evaluate(() => (window as unknown as { __island: { stats: () => unknown } }).__island.stats());
      results.push({ spot, condition: cond, file, staged, stats });
      console.log(`${spot}_${cond}.png`);
    }
  }
  writeFileSync(join(outDir, 'report.json'), JSON.stringify({ round, view, quality, loadMs, adapter, results, console: L.console.slice(0, 200), at: new Date().toISOString() }, null, 1));
  console.log(`${results.length} shots in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${outDir}`);
  if (L.console.length) console.log('console:\n' + L.console.filter((l) => !l.includes('powerPreference')).slice(0, 15).join('\n'));
} finally {
  await L.browser.close();
  server.stop();
}
