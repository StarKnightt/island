// temporary (round 7 video fix): capture-mode probes of flyover poses or explicit cameras, headless
//   pnpm tsx scripts/_r7probe.ts --jobs jobs.json --out E:\tmp\island\r7fix\probe [--dsf 1.5] [--preview] [--accum 8]
// a job: { name, t?: flyover time, cam?: {pos,target,fov}, hour?, accum?, warm?, hide?: [object names], eval?: js,
//          seq?: frames (consecutive 1/60 s frames, tiled), crop?: [x,y,w,h] (of the 1920x1080 frame) }
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setPriority, constants } from 'node:os';
import sharp from 'sharp';
import { argv, ensureServer, launch } from './lib/browser';
import { pose } from './lib/flyover-route';

setPriority(0, constants.priority.PRIORITY_LOW);
const a = argv();
const jobs = JSON.parse(readFileSync(a.get('jobs', ''), 'utf8')) as {
  name: string; t?: number; cam?: { pos: number[]; target: number[]; fov: number }; hour?: number; accum?: number;
  warm?: number; hide?: string[]; eval?: string; seq?: number; crop?: number[]; up?: number[]; camEval?: string;
}[];
const out = a.get('out', 'E:\\tmp\\island\\r7fix\\probe');
const dsf = Number(a.get('dsf', '1'));
const ACC = Number(a.get('accum', '8'));
mkdirSync(out, { recursive: true });
const server = await ensureServer(a.has('preview') ? 'preview' : 'dev');
const L = await launch({ width: 1920, height: 1080, dsf, profile: a.get('profile', 'E:\\tmp\\island\\chrome-r7probe') });
await L.context.addInitScript({ content: 'globalThis.__name = (f) => f' });
const cdp = await L.context.newCDPSession(L.page);
// --bias: the flyover's metered exposure lift (as flyover.ts works it out) on flyover poses
const meterBias = (() => {
  if (!a.has('bias')) return () => 1;
  const m = JSON.parse(readFileSync('E:\\tmp\\island\\flyover-meter.json', 'utf8')) as { fps: number; luma: number[] };
  const raw = m.luma.map((l) => (l > 100 ? Math.max(0.7, Math.pow(100 / l, 0.9)) : Math.min(3, Math.max(1, Math.pow(44 / Math.max(l, 4), 1.4 * 0.88)))));
  const k = 1 - Math.exp(-1 / (m.fps * 1.1));
  const o = raw.slice();
  for (let i = 1; i < o.length; i++) o[i] = o[i - 1] + (o[i] - o[i - 1]) * k;
  for (let i = o.length - 2; i >= 0; i--) o[i] = o[i + 1] + (o[i] - o[i + 1]) * k;
  return (t: number) => o[Math.min(o.length - 1, Math.round(t * m.fps))];
})();
const camOf = (j: (typeof jobs)[number], t: number) => {
  if (j.cam) return { pos: j.cam.pos, target: j.cam.target, fov: j.cam.fov, up: j.up ?? [0, 1, 0], hour: j.hour ?? 13, bias: 1 };
  const p = pose(t);
  return { pos: p.pos.toArray(), target: p.target.toArray(), fov: p.fov, up: p.up.toArray(), hour: j.hour ?? p.hour, bias: meterBias(t) };
};
try {
  const c0 = camOf(jobs[0], jobs[0].t ?? 0);
  await L.page.goto(`${server.url}?capture=1&clean=1&accum=${ACC}&quality=high&spot=falls&tod=${c0.hour.toFixed(3)}${a.get('q', '') ? '&' + a.get('q', '') : ''}`, { waitUntil: 'domcontentloaded' });
  await L.page.waitForFunction(() => typeof (window as any).__island?.ready === 'function', null, { timeout: 180000 });
  await L.page.evaluate(() => (window as any).__island.ready());
  console.log('dims', await L.page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]));
  await L.page.evaluate(async (c) => {
    const api = (window as any).__island;
    api.manual(false);
    await api.stage({ spot: 'falls', tod: c.hour, weather: 'clear', camera: { pos: c.pos, target: c.target, fov: c.fov }, worldTime: null, settleMs: 600 });
    api.manual(true);
    api.shotStart(2400, 7007, 1);
    api.placePlayer(596, 34, Math.PI / 2);
  }, c0);
  const frame = (c: ReturnType<typeof camOf>, accum: number) => L.page.evaluate((o) => {
    const api = (window as any).__island;
    api.ctx.tod.setHour(o.c.hour);
    api.ctx.tod.frozen = true;
    api.ctx.exposureBias = o.c.bias;
    api.ctx.engine.camera.up.set(o.c.up[0], o.c.up[1], o.c.up[2]);
    return api.shotFrame({ cam: { pos: o.c.pos, target: o.c.target, fov: o.c.fov }, walk: null, accum: o.accum, dt: 1 / 60 }).pending;
  }, { c, accum });
  const capture = async () => Buffer.from(((await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1920, height: 1080, scale: dsf } })) as { data: string }).data, 'base64');
  for (const j of jobs) {
    const t0 = j.t ?? 0;
    if (j.eval) console.log(j.name, 'eval', JSON.stringify(await L.page.evaluate(j.eval)));
    const hidden = await L.page.evaluate((names) => {
      const s = (window as any).__island.ctx.engine.scene;
      const got: string[] = [];
      s.traverse((o: any) => { if (names.includes(o.name) && o.visible) { o.visible = false; o.userData.__probeHidden = true; got.push(o.name); } });
      return got;
    }, j.hide ?? []);
    if (j.hide?.length) console.log(j.name, 'hidden', hidden.join(','));
    if (j.camEval) j.cam = await L.page.evaluate(j.camEval);
    const c = camOf(j, t0);
    for (let k = 0; k < (j.warm ?? 8); k++) await frame(c, 1);
    for (let k = 0; k < 400; k++) { if (!(await frame(c, 1))) break; await new Promise((r) => setTimeout(r, 50)); }
    const n = j.seq ?? 1;
    // (the averaging passes compile on the first averaged render, which comes out black)
    await frame(c, j.accum ?? ACC);
    const pngs: Buffer[] = [];
    for (let f = 0; f < n; f++) {
      await frame(camOf(j, t0 + f / 60), j.accum ?? ACC);
      pngs.push(await capture());
    }
    const crop = j.crop;
    const prep = async (b: Buffer) => {
      let s = sharp(b);
      const m = await s.metadata();
      if (crop) { const k = m.width! / 1920; s = sharp(b).extract({ left: Math.round(crop[0] * k), top: Math.round(crop[1] * k), width: Math.round(crop[2] * k), height: Math.round(crop[3] * k) }); }
      return s;
    };
    if (n === 1) {
      writeFileSync(join(out, `${j.name}.png`), pngs[0]);
      await (await prep(pngs[0])).resize(crop ? undefined : 960).jpeg({ quality: 88 }).toFile(join(out, `${j.name}.jpg`));
    } else {
      const tw = 480, cols = 4, rows = Math.ceil(n / cols);
      const tiles = await Promise.all(pngs.map(async (b) => (await prep(b)).resize(tw).png().toBuffer()));
      const th = (await sharp(tiles[0]).metadata()).height!;
      await sharp({ create: { width: tw * cols, height: th * rows, channels: 3, background: '#000' } })
        .composite(tiles.map((t, i) => ({ input: t, left: (i % cols) * tw, top: Math.floor(i / cols) * th })))
        .jpeg({ quality: 85 }).toFile(join(out, `${j.name}_seq.jpg`));
      writeFileSync(join(out, `${j.name}_0.png`), pngs[0]);
      for (let i = 0; i < n; i++) await (await prep(pngs[i])).png().toFile(join(out, `${j.name}_c${i}.png`));
    }
    await L.page.evaluate(() => (window as any).__island.ctx.engine.scene.traverse((o: any) => { if (o.userData.__probeHidden) { o.visible = true; delete o.userData.__probeHidden; } }));
    console.log('done', j.name);
  }
} finally {
  console.log(L.console.filter((l) => l.includes('error')).slice(0, 10).join('\n'));
  await L.browser.close();
  server.stop();
}
