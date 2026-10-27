/**
 * Development profiling of the start-up stall: a CPU profile of the main thread from the moment the shaders are
 * precompiled until the game is ready, summarised by self time and by callers of the WebGPU pipeline creation.
 *   pnpm tsx scripts/profile-start.ts [--q "spot=beach"] [--preview]
 */
import { writeFileSync } from 'node:fs';
import { argv, ensureServer, launch } from './lib/browser';

const a = argv();
const q = a.get('q', 'spot=beach&tod=noon&weather=clear');
const server = await ensureServer(a.has('preview') ? 'preview' : 'dev');
const L = await launch({ uncapped: a.has("uncapped") });
try {
  const cdp = await L.context.newCDPSession(L.page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await L.page.goto(`${server.url}?test=1&hud=0&mute=1&freeze=1&${q}`, { waitUntil: 'domcontentloaded' });
  await L.page.waitForFunction(`!!(window.__island && window.__island.timeline && window.__island.timeline().length) || !!(window.__island && window.__island.ctx)`, null, { timeout: 120000, polling: 50 }).catch(() => {});
  const steady = a.get('steady', '');
  if (steady) {
    // steady state: stage a spot, walk, then profile a few seconds of frames
    await L.page.waitForFunction(`window.__island && typeof window.__island.ready === 'function'`, null, { timeout: 120000, polling: 50 });
    await L.page.evaluate(`window.__island.ready()`);
    await L.page.evaluate(`window.__island.stage({ spot: '${steady}', tod: '${a.get('tod','noon')}', weather: '${a.get('tod','noon')==='rain'?'rain':'clear'}', camera: 'follow', worldTime: null, settleMs: 1500 })`);
    await L.page.evaluate(`window.__island.act('walk', 8)`);
    await L.page.waitForTimeout(1000);
    await cdp.send('Profiler.start');
    await L.page.waitForTimeout(Number(a.get('seconds', '3')) * 1000);
    console.log('stats', JSON.stringify(await L.page.evaluate(`(() => { const s = window.__island.stats(); return { fps: s.fps, cpu: s.cpu.avg, draws: s.drawCalls }; })()`)));
  } else {
    await cdp.send('Profiler.start');
    await L.page.waitForFunction(`window.__island && typeof window.__island.ready === 'function'`, null, { timeout: 120000, polling: 50 });
    await L.page.evaluate(`window.__island.ready()`);
  }
  const { profile } = await cdp.send('Profiler.stop') as { profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }[]; samples: number[]; timeDeltas: number[] } };
  writeFileSync(a.get('out', 'E:/tmp/island/start.cpuprofile'), JSON.stringify(profile));
  const self = new Map<number, number>();
  for (let i = 0; i < profile.samples.length; i++) self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const label = (n: { callFrame: { functionName: string; url: string; lineNumber: number } }) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`;
  const agg = new Map<string, number>();
  for (const [id, ms] of self) agg.set(label(byId.get(id)!), (agg.get(label(byId.get(id)!)) ?? 0) + ms);
  console.log('top self time (ms):');
  for (const [k, v] of [...agg].sort((x, y) => y[1] - x[1]).slice(0, 25)) console.log(`  ${v.toFixed(0).padStart(7)}  ${k}`);
  // inclusive time per stack path for the heaviest self nodes
  const incl = new Map<string, number>();
  for (const [id, ms] of self) {
    const seen = new Set<string>();
    let cur: number | undefined = id;
    while (cur !== undefined) {
      const k = label(byId.get(cur)!);
      if (!seen.has(k)) {
        incl.set(k, (incl.get(k) ?? 0) + ms);
        seen.add(k);
      }
      cur = parent.get(cur);
    }
  }
  console.log('top inclusive time (ms):');
  for (const [k, v] of [...incl].sort((x, y) => y[1] - x[1]).slice(0, 45)) console.log(`  ${v.toFixed(0).padStart(7)}  ${k}`);
  console.log('timeline', JSON.stringify(await L.page.evaluate(`window.__island.timeline()`)));
} finally {
  await L.browser.close();
  server.stop();
}
