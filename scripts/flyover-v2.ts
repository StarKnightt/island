/**
 * The round 7 update video, second cut: the shots of scripts/lib/cut-v2.ts rendered one by one and joined by short
 * dissolves. Captured as flyover.ts captures (?capture=1&clean=1, every frame exactly 1/60 s of world, the mean of
 * ACCUM jittered renders, supersampled at DSF and scaled down with lanczos at the encode).
 *
 * Every shot is pre-warmed before a frame is kept: the camera is put at its first pose, the whole path is flown once
 * uncaptured (streaming and the vegetation's cell lists catch up along it), then at the start, middle and end poses
 * the world clock is frozen and two renders a second apart are compared; capture starts only once no pipeline is
 * compiling and under STABLE of the pixels changed by more than 24 levels between them (something loading in).
 *
 *   pnpm flyover-v2 --stills            the checkpoint: full-quality stills (STILLS) to update-r7\v2-preview\NN.jpg
 *   pnpm flyover-v2 [--shots pool,cliffs] render shots (all by default) to E:\tmp\island\flyover-v2\<shot>\
 *   pnpm flyover-v2 --encode-only       mix and encode from the frames on disk to update-r7\update-r7-v2.mp4
 *   [--rest <ms>] idle after each frame (default 60); a rest of PAUSE s after every BATCH frames; Idle priority
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setPriority, constants } from 'node:os';
import sharp from 'sharp';
import { argv, ensureServer, launch, ROOT } from './lib/browser';
import { SHOTS, XFADE, shotPose, shotStarts, cutLength, type Shot } from './lib/cut-v2';

const a = argv();
const FPS = 60, W = 1920, H = 1080, ACCUM = 8, DSF = Number(a.get('dsf', '1.5'));
const OUT_DIR = 'E:\\shots\\island\\update-r7';
const OUT = join(OUT_DIR, 'update-r7-v2.mp4');
const PREVIEW_DIR = join(OUT_DIR, 'v2-preview');
const FRAMES = 'E:\\tmp\\island\\flyover-v2';
const AUDIO_DIR = join(ROOT, 'public', 'assets', 'audio');
const WORLD = 2400, SEED = 7007;
const REST = Number(a.get('rest', '60')), BATCH = 120, PAUSE = 8;
const MAX_BYTES = 99e6, TARGET_MB = 96;
/** share of pixels allowed to change by > 24 levels between two renders of a frozen frame a second apart */
const STABLE = 0.0005;
/** checkpoint stills: shot, seconds into it */
const STILLS: [string, number][] = [['jungle', 2.0], ['jungle', 7.0], ['pool', 4.5], ['cliffs', 3.5], ['rise', 5.0], ['sunset', 8.6]];
setPriority(0, constants.priority.PRIORITY_LOW);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
interface FrameLog { t: number; cam: number[]; layers: Record<string, number> }

async function render(only: Set<string> | null, stills: boolean) {
  const server = await ensureServer('preview');
  const L = await launch({ width: W, height: H, dsf: DSF, profile: 'E:\\tmp\\island\\chrome-dev' });
  await L.context.addInitScript({ content: 'globalThis.__name = (f) => f' });
  const cdp = await L.context.newCDPSession(L.page);
  const capture = async (scale = DSF) => Buffer.from(((await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, clip: { x: 0, y: 0, width: W, height: H, scale } })) as { data: string }).data, 'base64');
  const p0 = shotPose(SHOTS[0], 0);
  try {
    await L.page.goto(`${server.url}?capture=1&clean=1&accum=${ACCUM}&quality=high&spot=waterfall&tod=${p0.hour.toFixed(3)}`, { waitUntil: 'domcontentloaded' });
    await L.page.waitForFunction(() => typeof (window as any).__island?.ready === 'function', null, { timeout: 180000 });
    await L.page.evaluate(() => (window as any).__island.ready());
    const dims = await L.page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
    if (dims[0] !== W || dims[1] !== H || dims[2] !== DSF) throw new Error(`viewport ${dims.join('x')}, want ${W}x${H} at dpr ${DSF}`);
    const frame = (c: ReturnType<typeof shotPose>, accum: number, dt = 1 / FPS) => L.page.evaluate((o) => {
      const api = (window as any).__island;
      api.ctx.tod.setHour(o.c.hour);
      api.ctx.tod.frozen = true;
      api.ctx.exposureBias = o.c.bias;
      api.ctx.engine.camera.up.set(o.c.up[0], o.c.up[1], o.c.up[2]);
      const r = api.shotFrame({ cam: { pos: o.c.pos, target: o.c.target, fov: o.c.fov }, walk: null, accum: o.accum, dt: o.dt });
      const layers: Record<string, number> = {};
      for (const [k, v] of Object.entries(api.audio()?.layers ?? {})) layers[k] = (v as { gain: number }).gain;
      return { cam: r.cam as number[], pending: r.pending as number, layers };
    }, { c, accum, dt });
    const setClock = (t: number) => L.page.evaluate((w) => { (window as any).__island.ctx.engine.time = w; }, t);
    const freeze = (on: boolean) => L.page.evaluate((f) => { const e = (window as any).__island.ctx.engine; e.frozenTime = f ? e.time : null; }, on);

    /** renders until two renders a second apart (world frozen) agree: nothing left to load at this pose */
    const settle = async (c: ReturnType<typeof shotPose>, label: string) => {
      await freeze(true);
      for (let attempt = 0; attempt < 40; attempt++) {
        let pending = 0;
        for (let k = 0; k < 4; k++) pending += (await frame(c, 1, 0)).pending;
        const A = await sharp(await capture(1)).greyscale().resize(480).raw().toBuffer();
        for (let k = 0; k < 30; k++) pending += (await frame(c, 1, 0)).pending;
        await sleep(400);
        const B = await sharp(await capture(1)).greyscale().resize(480).raw().toBuffer();
        let moved = 0;
        for (let i = 0; i < A.length; i++) if (Math.abs(A[i] - B[i]) > 24) moved++;
        const share = moved / A.length;
        if (!pending && share < STABLE) {
          console.log(`  ${label}: stable (${(share * 100).toFixed(3)} % changed, attempt ${attempt + 1})`);
          await freeze(false);
          return;
        }
        await sleep(500);
      }
      await freeze(false);
      throw new Error(`${label}: did not settle (still loading or popping)`);
    };

    /** stage a shot: the first pose, the whole path flown once uncaptured, stability at start / middle / end */
    const prewarm = async (s: Shot, i: number) => {
      const c0 = shotPose(s, 0);
      await L.page.evaluate(async (c) => {
        const api = (window as any).__island;
        api.manual(false);
        await api.stage({ spot: 'waterfall', tod: c.hour, weather: 'clear', camera: { pos: c.pos, target: c.target, fov: c.fov }, worldTime: null, settleMs: 600 });
        api.manual(true);
        api.placePlayer(596, 34, Math.PI / 2);
      }, c0);
      for (let k = 0; k < 60; k++) await frame(c0, 1);
      for (let f = 0; f <= s.dur * FPS; f += 2) await frame(shotPose(s, f / FPS), 1, 2 / FPS);
      for (const u of [0.5, 1, 0]) await settle(shotPose(s, s.dur * u), `${s.name} at ${(s.dur * u).toFixed(1)} s`);
      // the averaging passes compile before a kept frame; then the world clock and the seeded randomness restart
      for (let k = 0; k < 2; k++) await frame(c0, ACCUM);
      await setClock(WORLD + i * 100);
      await L.page.evaluate((seed) => (window as any).__island.shotStart((window as any).__island.ctx.engine.time, seed, 1), SEED + i);
    };

    if (stills) {
      mkdirSync(PREVIEW_DIR, { recursive: true });
      let n = 0;
      for (const [name, at] of STILLS) {
        const i = SHOTS.findIndex((s) => s.name === name), s = SHOTS[i];
        await prewarm(s, i);
        // (the world runs from the shot's start to the still, as the render will run it)
        for (let f = 0; f < Math.round(at * FPS); f++) await frame(shotPose(s, f / FPS), 1);
        await frame(shotPose(s, at), ACCUM);
        const file = join(PREVIEW_DIR, `${String(++n).padStart(2, '0')}.jpg`);
        await sharp(await capture()).resize(W, H, { kernel: 'lanczos3' }).jpeg({ quality: 93, chromaSubsampling: '4:4:4' }).toFile(file);
        console.log(`still ${n}: ${name} +${at} s -> ${file}`);
        await sleep(3000);
      }
      return;
    }

    const starts = shotStarts(FPS);
    for (let i = 0; i < SHOTS.length; i++) {
      const s = SHOTS[i];
      if (only && !only.has(s.name)) continue;
      console.log(`shot ${s.name}: ${s.dur} s from ${starts[i].toFixed(2)} s`);
      await prewarm(s, i);
      const dir = join(FRAMES, s.name);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const n = Math.round(s.dur * FPS), log: FrameLog[] = [], writes: Promise<void>[] = [], t0 = Date.now();
      for (let f = 0; f < n; f++) {
        let r = await frame(shotPose(s, f / FPS), ACCUM);
        // the clock reset at the shot start recompiles a few pipelines; frame 0 would render black
        for (let k = 0; r.pending && k < 40; k++) {
          await sleep(250);
          r = await frame(shotPose(s, f / FPS), ACCUM, 0);
        }
        if (r.pending) console.warn(`\n  frame ${f}: ${r.pending} pipelines still compiling`);
        log.push({ t: f / FPS, cam: r.cam, layers: r.layers });
        writes.push(writeFile(join(dir, `f_${String(f).padStart(5, '0')}.png`), await capture()));
        if (writes.length >= 12) await writes.shift();
        if (REST) await sleep(REST);
        if (f && f % BATCH === 0) await sleep(PAUSE * 1000);
        if (f % 60 === 0) process.stdout.write(`\r  frame ${f}/${n} (${((Date.now() - t0) / Math.max(1, f)).toFixed(0)} ms/frame)`);
      }
      await Promise.all(writes);
      writeFileSync(join(dir, 'flight.json'), JSON.stringify({ fps: FPS, frames: log }));
      console.log(`\r  ${n} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      await sleep(20000);
    }
  } finally {
    await L.browser.close();
    server.stop();
  }
}

function ff(args: string[], what: string) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${what}: ffmpeg failed\n${r.stderr}`);
  return r.stderr;
}

/** the game's ambience layers; `at`: positional (as the game's PannerNode: inverse, ref 12, rolloff 1.1) */
const LAYERS: { name: string; file: string; at?: number[] }[] = [
  { name: 'waves', file: 'amb_waves' }, { name: 'surf', file: 'amb_surf' }, { name: 'wind', file: 'amb_wind' },
  { name: 'birds', file: 'amb_birds' }, { name: 'jungle', file: 'amb_jungle' }, { name: 'night', file: 'amb_night' },
  { name: 'waterfall', file: 'amb_waterfall', at: [146, 50, -55] }, { name: 'stream', file: 'amb_stream' },
  { name: 'gulls', file: 'amb_gulls' },
];
const LUFS = -16, TP = -2;
const MASTER = 'highpass=f=110:poles=2,lowpass=f=14000,acompressor=threshold=-24dB:ratio=2:attack=40:release=400:makeup=1,alimiter=limit=0.7:attack=5:release=120:level=false';

function decode(file: string) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-i', join(AUDIO_DIR, `${file}.ogg`), '-af', 'highpass=f=140:poles=2', '-ac', '2', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`decode ${file}: ${r.stderr}`);
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

function smooth(v: number[], fps: number, tau: number) {
  const k = 1 - Math.exp(-1 / (fps * tau));
  const o = v.slice();
  for (let i = 1; i < o.length; i++) o[i] = o[i - 1] + (o[i] - o[i - 1]) * k;
  for (let i = o.length - 2; i >= 0; i--) o[i] = o[i + 1] + (o[i] - o[i + 1]) * k;
  return o;
}

function writeWav(path: string, data: Float32Array, rate = 48000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.byteLength, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 8, 28); h.writeUInt16LE(8, 32); h.writeUInt16LE(32, 34); h.write('data', 36); h.writeUInt32LE(data.byteLength, 40);
  writeFileSync(path, Buffer.concat([h, Buffer.from(data.buffer, data.byteOffset, data.byteLength)]));
}

/**
 * Each shot's logged layer levels (times its panner's distance gain), held flat past its ends; across a cut the two
 * shots' levels cross over a raised cosine 0.8 s wide centred on the dissolve, so the jungle hands over to the falls,
 * the falls to the surf, the surf to the evening shore without a step. Then the loops under those envelopes, MASTER
 * and a two-pass linear loudnorm to LUFS / TP.
 */
function mixAudio(wav: string) {
  const len = cutLength(FPS), n = Math.round(len * FPS), S = Math.round(len * 48000);
  const starts = shotStarts(FPS);
  const logs = SHOTS.map((s) => JSON.parse(readFileSync(join(FRAMES, s.name, 'flight.json'), 'utf8')) as { frames: FrameLog[] });
  const level = (si: number, name: string, t: number) => {
    const fr = logs[si].frames, f = fr[Math.min(fr.length - 1, Math.max(0, Math.round((t - starts[si]) * FPS)))];
    const l = LAYERS.find((x) => x.name === name)!;
    let g = f.layers[name] ?? 0;
    if (l.at) {
      const d = Math.hypot(f.cam[0] - l.at[0], f.cam[1] - l.at[1], f.cam[2] - l.at[2]);
      g *= 12 / (12 + 1.1 * (Math.max(d, 12) - 12));
    }
    return g;
  };
  const cuts = starts.slice(1).map((st) => st + XFADE / FPS / 2);
  const env = new Map<string, number[]>();
  for (const l of LAYERS) {
    const v: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / FPS;
      let si = 0;
      while (si < cuts.length && t >= cuts[si]) si++;
      // within 0.4 s of cut j, shot j hands over to shot j + 1 on a raised cosine
      const j = cuts.findIndex((c) => Math.abs(t - c) < 0.4);
      if (j < 0) v.push(level(si, l.name, t));
      else {
        const k = 0.5 + 0.5 * Math.cos((Math.PI * (t - cuts[j] + 0.4)) / 0.8);
        v.push(level(j, l.name, t) * k + level(j + 1, l.name, t) * (1 - k));
      }
    }
    env.set(l.name, smooth(v, FPS, 0.15));
  }
  const out = new Float32Array(S * 2);
  LAYERS.forEach((l, li) => {
    const e = env.get(l.name)!;
    if (Math.max(...e) < 1e-3) return;
    const src = decode(l.file);
    const frames = src.length / 2;
    let pos = Math.floor(((0.17 + li * 0.13) % 1) * frames);
    for (let s = 0; s < S; s++) {
      const fi = (s / 48000) * FPS, i0 = Math.min(n - 1, Math.floor(fi)), i1 = Math.min(n - 1, i0 + 1), u = fi - i0;
      const g = e[i0] * (1 - u) + e[i1] * u;
      out[s * 2] += src[pos * 2] * g;
      out[s * 2 + 1] += src[pos * 2 + 1] * g;
      if (++pos >= frames) pos = 0;
    }
  });
  const fadeIn = 0.5 * 48000, fadeOut = 1.5 * 48000;
  for (let s = 0; s < S; s++) {
    const k = Math.min(1, s / fadeIn, (S - s) / fadeOut);
    out[s * 2] *= k;
    out[s * 2 + 1] *= k;
  }
  const raw = wav.replace(/\.wav$/, '.raw.wav');
  writeWav(raw, out);
  const m = spawnSync('ffmpeg', ['-hide_banner', '-i', raw, '-af', `${MASTER},loudnorm=I=${LUFS}:TP=${TP}:LRA=7:print_format=json`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const js = JSON.parse(m.slice(m.lastIndexOf('{'), m.lastIndexOf('}') + 1)) as Record<string, string>;
  const ln = `${MASTER},loudnorm=I=${LUFS}:TP=${TP}:LRA=7:measured_I=${js.input_i}:measured_TP=${js.input_tp}:measured_LRA=${js.input_lra}:measured_thresh=${js.input_thresh}:offset=${js.target_offset}:linear=true`;
  ff(['-i', raw, '-af', `${ln},aresample=48000,atrim=0:${len.toFixed(4)}`, '-c:a', 'pcm_s24le', wav], 'loudnorm');
  rmSync(raw, { force: true });
  console.log(`audio: ${len.toFixed(2)} s -> ${wav}`);
}

/** the shots joined by XFADE-frame dissolves, scaled down and encoded as update-r7.mp4 is (2-pass, ~TARGET_MB) */
function encode(wav: string) {
  const len = cutLength(FPS), starts = shotStarts(FPS);
  const kbps = Math.floor((TARGET_MB * 8e3) / len - 192 - 120);
  const inputs: string[] = [];
  for (const s of SHOTS) inputs.push('-framerate', String(FPS), '-start_number', '0', '-i', join(FRAMES, s.name, 'f_%05d.png'));
  const d = (XFADE / FPS).toFixed(4);
  let chain = '', last = '[0:v]';
  for (let i = 1; i < SHOTS.length; i++) {
    const tag = `[x${i}]`;
    chain += `${last}[${i}:v]xfade=transition=fade:duration=${d}:offset=${starts[i].toFixed(4)}${tag};`;
    last = tag;
  }
  chain += `${last}scale=${W}:${H}:flags=lanczos+accurate_rnd+full_chroma_int:sws_dither=ed,format=yuv420p[v]`;
  const log = join(FRAMES, 'x264');
  const x = ['-c:v', 'libx264', '-preset', 'slower', '-b:v', `${kbps}k`, '-maxrate', `${kbps * 2}k`, '-bufsize', `${kbps * 2}k`,
    '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-x264-params', 'aq-mode=3:aq-strength=0.9', '-r', String(FPS), '-g', String(FPS * 2),
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-passlogfile', log];
  ff([...inputs, '-filter_complex', chain, '-map', '[v]', ...x, '-pass', '1', '-an', '-f', 'mp4', 'NUL'], 'encode pass 1');
  ff([...inputs, '-i', wav, '-filter_complex', chain, '-map', '[v]', '-map', `${SHOTS.length}:a`, ...x, '-pass', '2', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-shortest', OUT], 'encode pass 2');
  for (const f of readdirSync(FRAMES)) if (f.startsWith('x264')) rmSync(join(FRAMES, f));
  console.log(`video: ${len.toFixed(3)} s at ${kbps} kbit/s -> ${OUT} (${(statSync(OUT).size / 1e6).toFixed(1)} MB)`);
  if (statSync(OUT).size > MAX_BYTES) console.warn('over 99 MB: lower TARGET_MB and run --encode-only');
}

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(FRAMES, { recursive: true });
if (a.has('stills')) {
  await render(null, true);
} else {
  if (!a.has('encode-only')) await render(a.has('shots') ? new Set(a.get('shots', '').split(',')) : null, false);
  if (SHOTS.every((s) => existsSync(join(FRAMES, s.name, 'flight.json')))) {
    const wav = join(FRAMES, 'cut.wav');
    mixAudio(wav);
    encode(wav);
  }
}
