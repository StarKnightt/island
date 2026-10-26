/**
 * Loading-screen captures: one load of the production build, screenshots mid-load and through the crossfade into the
 * first frame, then a reduced-motion load and a phone-width load (early frames only).
 *   pnpm tsx scripts/loader.ts [--dev] [--out E:\shots\island\loader]
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { argv, ensureServer, launch, DEV_PROFILE } from './lib/browser';

const a = argv();
const out = a.get('out', 'E:\\shots\\island\\loader');
mkdirSync(out, { recursive: true });
const server = await ensureServer(a.has('dev') ? 'dev' : 'preview');
const url = `${server.url}?test=1&mute=1`;

async function run(name: string, opts: { reduced?: boolean; width?: number; height?: number; full?: boolean }) {
  const L = await launch({ profile: DEV_PROFILE, width: opts.width, height: opts.height });
  try {
    if (opts.reduced) await L.page.emulateMedia({ reducedMotion: 'reduce' });
    const t0 = Date.now();
    await L.page.goto(url, { waitUntil: 'commit' });
    const shot = async (tag: string) => {
      const file = join(out, `${name}_${tag}.png`);
      await L.page.screenshot({ path: file });
      console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s`, file);
    };
    for (const at of opts.full ? [300, 1500, 4000, 7000] : [300, 2500]) {
      await L.page.waitForTimeout(Math.max(0, at - (Date.now() - t0)));
      await shot(`${String(at).padStart(5, '0')}ms`);
    }
    if (!opts.full) return;
    await L.page.waitForSelector('#loading.done', { timeout: 120000, state: 'attached' });
    for (const d of [100, 450, 800]) {
      await L.page.waitForTimeout(d === 100 ? 100 : 350);
      await shot(`fade_${d}ms`);
    }
    await L.page.waitForSelector('#loading', { state: 'detached', timeout: 10000 });
    await L.page.waitForTimeout(300);
    await shot('live');
    console.log('timeline', JSON.stringify(await L.page.evaluate('window.__island.timeline()')));
  } finally {
    await L.browser.close();
  }
}

try {
  await run('load', { full: true });
  await run('reduced', { reduced: true });
  await run('phone', { width: 390, height: 844 });
} finally {
  server.stop();
}
