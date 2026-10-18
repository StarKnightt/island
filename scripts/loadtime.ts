/**
 * Load-time check: two loads in one persistent Chrome profile (E:\tmp\island\chrome-profile, wiped first unless
 * --keep): the first is a first-ever visit (cold GPU shader cache), the second a returning visit (Chrome keeps the
 * compiled shaders). Prints the load timeline of each (__island.timeline()).
 *   pnpm tsx scripts/loadtime.ts [--dev] [--keep] [--q "spot=beach"]
 */
import { chromium } from 'playwright-core';
import { rmSync } from 'node:fs';
import { argv, ensureServer, launchOptions, targetDisplay, placeWindow, stubPointerLock } from './lib/browser';

const a = argv();
const q = a.get('q', 'spot=beach');
const dir = 'E:\\tmp\\island\\chrome-profile';
if (!a.has('keep')) rmSync(dir, { recursive: true, force: true });
const server = await ensureServer(a.has('dev') ? 'dev' : 'preview');
try {
  for (const run of ['first visit', 'returning visit']) {
    const display = targetDisplay();
    const { headless, real, view, args } = launchOptions(display);
    const ctx = await chromium.launchPersistentContext(dir, { channel: 'chrome', headless, args, ...view });
    await stubPointerLock(ctx);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const mode = headless ? 'headless' : await placeWindow(page, display, 1920, 1080, real);
    if (run === 'first visit') console.log(`[browser] ${display.name} ${display.width}x${display.height}: ${mode} 1920x1080 viewport`);
    const t0 = Date.now();
    await page.goto(`${server.url}?test=1&hud=0&mute=1&${q}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(`window.__island && typeof window.__island.ready === 'function'`, null, { timeout: 180000, polling: 50 });
    await page.evaluate(`window.__island.ready()`);
    const tl = (await page.evaluate(`window.__island.timeline()`)) as { name: string; ms: number }[];
    console.log(`${run}: ${Date.now() - t0} ms to ready (wall) | ${tl.map((m) => `${m.name} ${(m.ms / 1000).toFixed(1)}s`).join(' | ')}`);
    await ctx.close();
  }
} finally {
  server.stop();
}
