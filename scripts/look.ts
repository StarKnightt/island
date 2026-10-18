/**
 * Quick development capture: one URL (query string) -> one 1920x1080 PNG in E:\shots\island\dev\.
 *   pnpm tsx scripts/look.ts --q "spot=beach&tod=sunrise" --name beach_sunrise [--wait 2000] [--eval "js" | --evalfile f.js] [--uncapped] [--fresh]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, ensureServer, launch, DEV_PROFILE } from './lib/browser';

const a = argv();
const q = a.get('q', 'spot=beach&tod=sunrise');
const name = a.get('name', 'look');
const wait = Number(a.get('wait', '1500'));
const evalFile = a.get('evalfile', '');
const evalJs = evalFile ? readFileSync(evalFile, 'utf8') : a.get('eval', '');
const kind = a.has('preview') ? 'preview' : 'dev';
const outDir = 'E:\\shots\\island\\dev';
mkdirSync(outDir, { recursive: true });

const server = await ensureServer(kind);
// (a persistent profile: Chrome keeps the compiled shaders, so a capture loads in seconds; --fresh: a new one)
const L = await launch({ uncapped: a.has('uncapped'), profile: a.has('fresh') ? undefined : DEV_PROFILE });
const initFile = a.get('initfile', '');
if (initFile) await L.context.addInitScript({ content: readFileSync(initFile, 'utf8') });
try {
  const t0 = Date.now();
  await L.page.goto(`${server.url}?test=1&hud=0&freeze=1&${q}`, { waitUntil: 'domcontentloaded' });
  const ok = await L.page.waitForFunction(() => {
    const w = window as unknown as { __island?: { error?: string; ready?: () => Promise<boolean> } };
    return !!w.__island && (!!w.__island.error || typeof w.__island.ready === 'function');
  }, null, { timeout: 120000 }).then(() => true, () => false);
  const err = await L.page.evaluate(() => (window as unknown as { __island?: { error?: string } }).__island?.error ?? null);
  if (!ok || err) console.log('ERROR', err);
  else {
    await L.page.evaluate(() => (window as unknown as { __island: { ready: () => Promise<boolean> } }).__island.ready());
    if (evalJs) console.log('eval:', JSON.stringify(await L.page.evaluate(evalJs)));
    await L.page.waitForTimeout(wait);
  }
  const file = join(outDir, `${name}.png`);
  await L.page.screenshot({ path: file });
  const stats = await L.page.evaluate(() => (window as unknown as { __island?: { stats?: () => unknown; info?: () => unknown } }).__island?.stats?.() ?? null).catch(() => null);
  const info = await L.page.evaluate(() => (window as unknown as { __island?: { info?: () => unknown } }).__island?.info?.() ?? null).catch(() => null);
  console.log(`load+settle ${Date.now() - t0} ms -> ${file}`);
  console.log('stats', JSON.stringify(stats));
  console.log('info', JSON.stringify(info));
  if (L.console.length) console.log('console:\n' + L.console.slice(0, 30).join('\n'));
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify({ stats, info, console: L.console }, null, 1));
} finally {
  await L.browser.close();
  server.stop();
}
