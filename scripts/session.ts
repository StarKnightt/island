/**
 * Development session: one browser, one page load, then a steps module drives it.
 *   pnpm tsx scripts/session.ts --steps E:/tmp/island/steps.mjs [--q "spot=lighthouse&tod=noon"] [--preview] [--uncapped] [--fresh]
 * The steps module exports `default async (s) => { ... }` with
 *   s.page            the Playwright page
 *   s.ev(src)         evaluate a source string in the page (window.__island is `api`, its ctx is `api.ctx`)
 *   s.stage(opts)     __island.stage(opts)
 *   s.shot(name)      1920x1080 PNG to E:\shots\island\dev\<name>.png
 *   s.wait(ms)        real-time wait
 *   s.log(...)        print
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argv, ensureServer, launch, DEV_PROFILE } from './lib/browser';

const a = argv();
const stepsFile = a.get('steps', '');
const q = a.get('q', 'spot=beach&tod=noon&weather=clear');
const outDir = 'E:\\shots\\island\\dev';
mkdirSync(outDir, { recursive: true });

const server = await ensureServer(a.has('preview') ? 'preview' : 'dev');
// (a persistent profile: Chrome keeps the compiled shaders, so a capture loads in seconds; --fresh: a new one)
const L = await launch({ uncapped: a.has('uncapped'), profile: a.has('fresh') ? undefined : DEV_PROFILE });
const t0 = Date.now();
try {
  await L.page.goto(`${server.url}?test=1&hud=0&mute=1&freeze=1&${q}`, { waitUntil: 'domcontentloaded' });
  await L.page.waitForFunction(() => {
    const w = window as unknown as { __island?: { error?: string; ready?: unknown } };
    return !!w.__island && (!!w.__island.error || typeof w.__island.ready === 'function');
  }, null, { timeout: 180000 });
  const err = await L.page.evaluate(() => (window as unknown as { __island?: { error?: string } }).__island?.error ?? null);
  if (err) throw new Error(err);
  await L.page.evaluate(() => (window as unknown as { __island: { ready: () => Promise<boolean> } }).__island.ready());
  console.log(`ready after ${Date.now() - t0} ms`);
  const s = {
    page: L.page,
    ev: (src: string) => L.page.evaluate(`(async () => { const api = window.__island; const ctx = api.ctx; ${src} })()`),
    stage: (opts: unknown) => L.page.evaluate(`window.__island.stage(${JSON.stringify(opts)})`),
    shot: async (name: string) => {
      const file = join(outDir, `${name}.png`);
      await L.page.screenshot({ path: file });
      console.log('shot', file);
      return file;
    },
    wait: (ms: number) => L.page.waitForTimeout(ms),
    log: (...x: unknown[]) => console.log(...x),
  };
  const mod = await import(pathToFileURL(stepsFile).href);
  await mod.default(s);
  if (L.console.length) console.log('console:\n' + L.console.filter((l) => !l.includes('powerPreference') && !l.startsWith('[log]')).slice(0, 25).join('\n'));
} finally {
  await L.browser.close();
  server.stop();
}
