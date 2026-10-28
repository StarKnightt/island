/**
 * The round 7 update video: one continuous drone flight over the island (no cuts), the route and the time of day in
 * scripts/lib/flyover-route.ts. Captured as record.ts captures: ?capture=1&clean=1 (no HUD, no vignette, seeded
 * randomness), every frame exactly 1/60 s of world through __island.shotFrame and the mean of ACCUM jittered renders,
 * read back with a CDP screenshot. The time of day is set every frame (the sky, light and lamps follow, the exposure
 * metered for that light), the camera banks through `camera.up`.
 *
 * The sound is the game's own ambience along the flight: every frame the game's per-layer levels (waves, surf, wind,
 * birds, jungle, night, waterfall, stream, village, chickens, creaks, gulls, as Audio.ts sets them from the camera's
 * place, height and the hour; the positional ones attenuated by their distance as the game's panners do) are logged,
 * then the same loops are mixed offline under those envelopes, high-passed (no rumble), smoothed, evened out,
 * compressed, limited and normalised (-20 LUFS, -3 dBTP).
 *
 *   pnpm flyover                          render (supersampled: --dsf, default 1.5, a 2880x1620 render), mix, encode
 *                                         E:\shots\island\update-r7\update-r7.mp4 and update-r7_1440.mp4 (--no-1440:
 *                                         not that one), review JPGs; a previous update-r7.mp4 is kept as _v1
 *   pnpm flyover --meter                  the metering pass (640x360, 20 fps, one render a frame): mean luma along the
 *                                         flight, from which the render sets its exposure (below); run it first
 *   pnpm flyover --preview --from 13 --to 19   a cheap look at part of it: 1280x720, 30 fps, 2 renders a frame
 *   pnpm flyover --encode-only            mix and encode from the frames on disk
 *   pnpm flyover --resume                 finish an interrupted render: keeps the PNGs on disk, replays the flight from
 *                                         frame 0 uncaptured (one render a frame, the dither counters stepped as the
 *                                         averaged renders step them) so the world, its seeded randomness and every
 *                                         smoothed state reach the first missing frame exactly as the first run had
 *                                         them, renders the last REPLAY_FULL frames before it in full and checks the
 *                                         last CHECK of them against the files, then captures on
 *   [--rest <ms>] idle time after each frame (default 60), [--batch <n>] [--pause <s>] a rest after every n frames
 *   (default 120 and 8): the GPU is shared (someone may be playing a game). Everything runs at Idle priority (Chrome
 *   and ffmpeg inherit it). [--keep] keep the PNG frames; [--dev] against the dev server
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync, existsSync, renameSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setPriority, constants } from 'node:os';
import sharp from 'sharp';
import { argv, ensureServer, launch, ROOT } from './lib/browser';
import { pose, DURATION } from './lib/flyover-route';

const a = argv();
const preview = a.has('preview');
const meter = a.has('meter');
const FPS = meter ? 20 : preview ? 30 : 60;
const W = meter ? 640 : preview ? 1280 : 1920, H = meter ? 360 : preview ? 720 : 1080;
const ACCUM = meter ? 1 : preview ? 2 : 8;
/** supersampling: the page renders at DSF x its CSS size (2880x1620 for the video) and the encode scales it down */
const DSF = meter || preview ? 1 : Number(a.get('dsf', '1.5'));
/** the metering pass's mean luma per video time */
const METER = 'E:\\tmp\\island\\flyover-meter.json';
const OUT_DIR = 'E:\\shots\\island\\update-r7';
const OUT = join(OUT_DIR, preview ? 'preview.mp4' : 'update-r7.mp4');
const FRAMES = meter ? 'E:\\tmp\\island\\flyover-meter' : preview ? 'E:\\tmp\\island\\flyover-preview' : 'E:\\tmp\\island\\flyover';
const AUDIO_DIR = join(ROOT, 'public', 'assets', 'audio');
const WARMUP = 90;
const WORLD = 2400, SEED = 7007;
const from = Number(a.get('from', '0')), to = Math.min(DURATION, Number(a.get('to', String(DURATION))));
const REST = Number(a.get('rest', '60')), BATCH = Number(a.get('batch', '120')), PAUSE = Number(a.get('pause', '8'));
/** the mp4 stays under this (bytes): a CRF encode that comes out larger is redone in two passes to fit */
const MAX_BYTES = 99e6;
// (Windows hands an Idle process's priority class to the processes it starts: Chrome, its GPU process and ffmpeg)
setPriority(0, constants.priority.PRIORITY_LOW);
const N = Math.round((to - from) * FPS);
const resume = a.has('resume');
/** --resume: frames rendered in full (averaged) before the first missing one, and how many of those are compared */
const REPLAY_FULL = 30, CHECK = 3;
const checkOnly = a.has('check-only');
/** the other side of a shared GPU: when it is busy while this capture rests, a game is running; rests grow */
let courtesy = 1;
function gpuBusy() {
  const r = spawnSync('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8' });
  return r.status === 0 ? Number(r.stdout.trim().split('\n')[0]) : 0;
}

/**
 * The camera's exposure on top of the game's metering (ctx.exposureBias, a multiplier on the exposure): from the
 * metering pass, pulled toward a steady mean luma (88 % of the way in exposure, lifting the dark stretches up to 3x)
 * and smoothed over about a second each way, so the frame holds its brightness from the late sun through dusk into
 * night and under the canopy, changing only slowly. Stretches metered over `bright` (flying into the low sun's glow
 * in the haze) are held back a little, as a camera exposing for the land would (they came out washed out). 1 without
 * a metering pass.
 */
const bias = (() => {
  if (meter || !existsSync(METER)) return () => 1;
  const m = JSON.parse(readFileSync(METER, 'utf8')) as { fps: number; luma: number[] };
  const want = 44, bright = 100;
  const raw = m.luma.map((l) => (l > bright ? Math.max(0.7, Math.pow(bright / l, 0.9)) : Math.min(3, Math.max(1, Math.pow(want / Math.max(l, 4), 1.4 * 0.88)))));
  const sm = smooth(raw, m.fps, 1.1);
  return (t: number) => {
    const f = t * m.fps, i = Math.min(sm.length - 1, Math.floor(f)), j = Math.min(sm.length - 1, i + 1);
    return sm[i] + (sm[j] - sm[i]) * (f - i);
  };
})();

/** the game's ambience layers and their loops; `at`: positional (the game's PannerNode: inverse, ref 12, rolloff 1.1) */
const LAYERS: { name: string; file: string; at?: 'falls' | number[] }[] = [
  { name: 'waves', file: 'amb_waves' }, { name: 'surf', file: 'amb_surf' }, { name: 'wind', file: 'amb_wind' },
  { name: 'birds', file: 'amb_birds' }, { name: 'jungle', file: 'amb_jungle' }, { name: 'night', file: 'amb_night' },
  { name: 'waterfall', file: 'amb_waterfall', at: 'falls' }, { name: 'stream', file: 'amb_stream' },
  { name: 'village', file: 'amb_chimes', at: [-455, 4, 320] }, { name: 'chickens', file: 'amb_chickens', at: [-475, 4, 290] },
  { name: 'creak', file: 'amb_creak', at: [-452, 1.5, 370] }, { name: 'gulls', file: 'amb_gulls' },
];
const HP = 140;
const LUFS = -20;
const MASTER = 'highpass=f=110:poles=2,acompressor=threshold=-26dB:ratio=2.5:attack=30:release=300:makeup=1,alimiter=limit=0.6:attack=5:release=80:level=false';

interface FrameLog { t: number; cam: number[]; hour: number; layers: Record<string, number>; pending: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function render() {
  const server = await ensureServer(a.has('dev') ? 'dev' : 'preview');
  const L = await launch({ width: W, height: H, dsf: DSF, profile: 'E:\\tmp\\island\\chrome-dev' });
  await L.context.addInitScript({ content: 'globalThis.__name = (f) => f' });
  const cdp = await L.context.newCDPSession(L.page);
  const p0 = pose(from);
  const log: FrameLog[] = [];
  let fallsPos: number[] = [146, 50, -55];
  try {
    await L.page.goto(`${server.url}?capture=1&clean=1&accum=${ACCUM}&quality=high&spot=cliffs&tod=${p0.hour.toFixed(3)}`, { waitUntil: 'domcontentloaded' });
    await L.page.waitForFunction(() => typeof (window as unknown as { __island?: { ready?: unknown } }).__island?.ready === 'function', null, { timeout: 180000 });
    await L.page.evaluate(() => (window as unknown as { __island: { ready: () => Promise<boolean> } }).__island.ready());
    const dims = await L.page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
    if (dims[0] !== W || dims[1] !== H || dims[2] !== DSF) throw new Error(`viewport ${dims.join('x')}, want ${W}x${H} at dpr ${DSF}`);
    const cam = (t: number) => {
      const p = pose(t);
      const r = (v: { toArray: () => number[] }) => v.toArray().map((x) => +x.toFixed(4));
      return { pos: r(p.pos), target: r(p.target), fov: +p.fov.toFixed(3), up: r(p.up), hour: p.hour, bias: +bias(t).toFixed(4) };
    };
    // stage at the first pose (streaming and the light settle there), the world clock and seed fixed; the player is
    // put down on the spawn beach, out of the whole flight's sight
    fallsPos = await L.page.evaluate(async (o) => {
      const api = (window as unknown as { __island: any }).__island;
      api.manual(false);
      await api.stage({ spot: 'cliffs', tod: o.c.hour, weather: 'clear', camera: { pos: o.c.pos, target: o.c.target, fov: o.c.fov }, worldTime: null, settleMs: 600 });
      api.manual(true);
      api.shotStart(o.world, o.seed, 1);
      api.placePlayer(596, 34, Math.PI / 2);
      return api.ctx.audio?.fallsPos?.toArray() ?? [146, 50, -55];
    }, { c: cam(from), world: WORLD + from, seed: SEED });

    const frame = async (t: number, single: boolean) => L.page.evaluate((o) => {
      const api = (window as unknown as { __island: any }).__island;
      const { tod, engine } = api.ctx;
      // (setHour meters the exposure for the new light at once: the hour moves smoothly, so the exposure does too,
      // without the eye adaptation's lag that let the frame sink a stop while dusk fell)
      tod.setHour(o.c.hour);
      tod.frozen = true;
      api.ctx.exposureBias = o.c.bias;
      engine.camera.up.set(o.c.up[0], o.c.up[1], o.c.up[2]);
      const r = api.shotFrame({ cam: { pos: o.c.pos, target: o.c.target, fov: o.c.fov }, walk: null, accum: o.single ? 1 : undefined, dt: o.dt });
      const layers: Record<string, number> = {};
      for (const [k, v] of Object.entries(api.audio()?.layers ?? {})) layers[k] = (v as { gain: number }).gain;
      return { cam: r.cam, pending: r.pending, layers };
    }, { c: cam(t), single, dt: 1 / FPS });

    // the averaging passes compile and the history, exposure and sea settle on the first pose (uncaptured); the
    // world clock is set back after it so the flight starts at WORLD + from
    for (let k = 0; k < WARMUP; k++) await frame(from, true);
    await L.page.evaluate((w) => (window as unknown as { __island: any }).__island.ctx.engine.time = w, WORLD + from);
    for (let k = 0; k < 600; k++) {
      const r = await frame(from, true);
      if (k > 3 && !r.pending) break;
      await sleep(50);
    }
    // (two averaged frames: the averaging passes compile here, not on the first captured frame, which came out black)
    for (let k = 0; k < 2; k++) await frame(from, false);
    await L.page.evaluate((w) => (window as unknown as { __island: any }).__island.ctx.engine.time = w, WORLD + from);

    // --resume: the frames already on disk (a run from 0, contiguous, each a whole PNG) stay
    let start = 0;
    if (resume) {
      if (from !== 0) throw new Error('--resume continues a whole flight (from 0)');
      while (existsSync(join(FRAMES, `f_${String(start).padStart(5, '0')}.png`)) && statSync(join(FRAMES, `f_${String(start).padStart(5, '0')}.png`)).size > 10e3) start++;
      console.log(`resume: ${start} frames on disk, replaying to frame ${start}`);
    } else {
      rmSync(FRAMES, { recursive: true, force: true });
      mkdirSync(FRAMES, { recursive: true });
    }
    const checkDir = join(FRAMES, 'resume-check');
    // (W x H CSS pixels at DSF: the PNG holds every rendered pixel)
    const capture = async () => {
      const r = (await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, clip: { x: 0, y: 0, width: W, height: H, scale: DSF } })) as { data: string };
      return Buffer.from(r.data, 'base64');
    };
    const writes: Promise<void>[] = [];
    const luma: number[] = [];
    const t0 = Date.now();
    let pending = 0;
    for (let f = 0; f < N; f++) {
      const t = from + f / FPS;
      if (checkOnly && f >= start) break;
      if (f < start - REPLAY_FULL) {
        // replay: one render, the dither counters stepped as the other ACCUM - 1 renders would have stepped them
        const r = await frame(t, true);
        await L.page.evaluate((n) => { const e = (window as unknown as { __island: any }).__island.ctx.engine; for (let k = 0; k < n; k++) for (const h of e.onSubframe) h(); }, ACCUM - 1);
        log.push({ t: f / FPS, cam: r.cam, hour: +pose(t).hour.toFixed(4), layers: r.layers, pending: r.pending });
        if (f % 120 === 0) process.stdout.write(`\rreplay ${f}/${start}`);
        continue;
      }
      const r = await frame(t, false);
      if (r.pending) pending++;
      log.push({ t: f / FPS, cam: r.cam, hour: +pose(t).hour.toFixed(4), layers: r.layers, pending: r.pending });
      if (meter) {
        // (every half second a small JPG too: the whole flight to look over without a preview pass)
        const png = await capture();
        const st = await sharp(png).stats();
        luma.push(+(0.2126 * st.channels[0].mean + 0.7152 * st.channels[1].mean + 0.0722 * st.channels[2].mean).toFixed(2));
        if (f % 10 === 0) await sharp(png).jpeg({ quality: 80 }).toFile(join(FRAMES, `m_${(f / FPS).toFixed(1).padStart(4, '0')}.jpg`));
      } else if (f < start) {
        // the last replayed frames, rendered in full: the ones checked are kept beside the originals
        if (f >= start - CHECK) {
          mkdirSync(checkDir, { recursive: true });
          writeFileSync(join(checkDir, `f_${String(f).padStart(5, '0')}.png`), await capture());
        }
        continue;
      } else writes.push(writeFile(join(FRAMES, `f_${String(f).padStart(5, '0')}.png`), await capture()));
      if (writes.length >= 12) await writes.shift();
      if (REST) await sleep(REST * courtesy);
      if (f && f % BATCH === 0 && PAUSE) {
        await sleep(1500);
        const busy = gpuBusy();
        const was = courtesy;
        courtesy = busy > 45 ? Math.min(6, courtesy * 2) : Math.max(1, courtesy / 2);
        if (courtesy !== was) console.log(`\n[gpu] ${busy} % busy while resting: rests x${courtesy}`);
        await sleep(PAUSE * 1000 * courtesy);
      }
      if (f % 60 === 0) process.stdout.write(`\rframe ${f}/${N} (${((Date.now() - t0) / Math.max(1, f)).toFixed(0)} ms/frame)`);
    }
    await Promise.all(writes);
    if (meter) writeFileSync(METER, JSON.stringify({ fps: FPS, luma }));
    console.log(`\r${N} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s${pending ? `, ${pending} with pipelines still compiling` : ''}`);
  } finally {
    await L.browser.close();
    server.stop();
  }
  if (L.console.some((l) => l.startsWith('[pageerror]'))) console.warn(L.console.filter((l) => l.startsWith('[pageerror]')).join('\n'));
  if (!checkOnly) writeFileSync(join(FRAMES, 'flight.json'), JSON.stringify({ fps: FPS, from, fallsPos, frames: log }));
}

function ff(args: string[], what: string) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${what}: ffmpeg failed\n${r.stderr}`);
  return r.stderr;
}

/** a loop decoded to 48 kHz stereo float, high-passed */
function decode(file: string) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-i', join(AUDIO_DIR, `${file}.ogg`), '-af', `highpass=f=${HP}:poles=2`, '-ac', '2', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`decode ${file}: ${r.stderr}`);
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

/** forward and backward one-pole smoothing (no lag) with time constant tau (s) at rate fps */
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
 * The game's layers under the logged envelopes: each layer's level per frame (times its panner's distance gain),
 * smoothed (0.35 s) so every change is a crossfade; the sum is evened out (its slow loudness pulled two thirds of the
 * way toward its mean), faded in and out, then MASTER and a two-pass linear loudnorm.
 */
function mixAudio(wav: string) {
  // the render's own log of the game's levels when it covers the whole flight, else the metering pass's (same flight,
  // 20 fps; the envelopes are smoothed far below that)
  const own = join(FRAMES, 'flight.json'), metered = 'E:\\tmp\\island\\flyover-meter\\flight.json';
  const whole = (p: string) => existsSync(p) && Math.abs((JSON.parse(readFileSync(p, 'utf8')).frames.length / JSON.parse(readFileSync(p, 'utf8')).fps) - (to - from)) < 0.1;
  const src = whole(own) ? own : metered;
  const j = JSON.parse(readFileSync(src, 'utf8')) as { fps: number; fallsPos: number[]; frames: FrameLog[] };
  console.log(`audio levels from ${src}`);
  const fps = j.fps, n = j.frames.length, len = n / fps, S = Math.round(len * 48000);
  const env = new Map<string, number[]>();
  for (const l of LAYERS) {
    const at = l.at === 'falls' ? j.fallsPos : l.at;
    const v = j.frames.map((f) => {
      let g = f.layers[l.name] ?? 0;
      if (at) {
        const d = Math.hypot(f.cam[0] - at[0], f.cam[1] - at[1], f.cam[2] - at[2]);
        g *= 12 / (12 + 1.1 * (Math.max(d, 12) - 12));
      }
      return g;
    });
    env.set(l.name, smooth(v, fps, 0.35));
  }
  // evening: the summed power envelope against its mean (over 2 s), two thirds compensated
  const power = Array.from({ length: n }, (_, i) => LAYERS.reduce((s, l) => s + env.get(l.name)![i] ** 2, 0));
  const mean = power.reduce((s, x) => s + x, 0) / n;
  const even = smooth(power.map((p) => Math.pow(Math.max(p, mean * 0.05) / mean, -0.33)), fps, 1.0);
  const out = new Float32Array(S * 2);
  LAYERS.forEach((l, li) => {
    const e = env.get(l.name)!;
    if (Math.max(...e) < 1e-3) return;
    const src = decode(l.file);
    const frames = src.length / 2;
    let pos = Math.floor((0.17 + li * 0.13) % 1 * frames);
    for (let s = 0; s < S; s++) {
      const fi = (s / 48000) * fps, i0 = Math.min(n - 1, Math.floor(fi)), i1 = Math.min(n - 1, i0 + 1), u = fi - i0;
      const g = (e[i0] * (1 - u) + e[i1] * u) * (even[i0] * (1 - u) + even[i1] * u);
      out[s * 2] += src[pos * 2] * g;
      out[s * 2 + 1] += src[pos * 2 + 1] * g;
      if (++pos >= frames) pos = 0;
    }
  });
  const fadeIn = 0.6 * 48000, fadeOut = 1.2 * 48000;
  for (let s = 0; s < S; s++) {
    const k = Math.min(1, s / fadeIn, (S - s) / fadeOut);
    out[s * 2] *= k;
    out[s * 2 + 1] *= k;
  }
  const raw = wav.replace(/\.wav$/, '.raw.wav');
  writeWav(raw, out);
  const m = spawnSync('ffmpeg', ['-hide_banner', '-i', raw, '-af', `${MASTER},loudnorm=I=${LUFS}:TP=-3.5:LRA=7:print_format=json`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const js = JSON.parse(m.slice(m.lastIndexOf('{'), m.lastIndexOf('}') + 1)) as Record<string, string>;
  const ln = `${MASTER},loudnorm=I=${LUFS}:TP=-3.5:LRA=7:measured_I=${js.input_i}:measured_TP=${js.input_tp}:measured_LRA=${js.input_lra}:measured_thresh=${js.input_thresh}:offset=${js.target_offset}:linear=true`;
  ff(['-i', raw, '-af', `${ln},aresample=48000,atrim=0:${len.toFixed(4)}`, '-c:a', 'pcm_s24le', wav], 'loudnorm');
  rmSync(raw, { force: true });
  const peaks = Object.fromEntries(LAYERS.map((l) => [l.name, +Math.max(...env.get(l.name)!).toFixed(3)]));
  console.log(`audio: ${len.toFixed(2)} s, layer peaks ${JSON.stringify(peaks)} -> ${wav}`);
}

/**
 * H.264 (High, yuv420p, for X) two-pass at the bitrate that lands the file at about TARGET_MB, AAC 192k. The
 * supersampled frames are scaled down with lanczos; the conversion to 8-bit 4:2:0 is error-diffusion dithered (the
 * downscale carries more than 8 bits: no banding in the sky, no visible grain), and x264's variance AQ biased to dark,
 * flat areas keeps bits on the sky and the night. No tune (film and grain spend bits on noise there is none of).
 */
const TARGET_MB = 97;
function encode(wav: string, out: string, height: number) {
  const n = readdirSync(FRAMES).filter((f) => f.endsWith('.png')).length;
  if (n !== N) throw new Error(`${n} frames on disk, want ${N}`);
  const kbps = Math.floor((TARGET_MB * 8e3) / (N / FPS) - 192 - 120);
  const log = join(FRAMES, 'x264');
  const width = Math.round((height * 16) / 9);
  const v = ['-framerate', String(FPS), '-start_number', '0', '-i', join(FRAMES, 'f_%05d.png')];
  const vf = ['-vf', `scale=${width}:${height}:flags=lanczos+accurate_rnd+full_chroma_int:sws_dither=ed,format=yuv420p`];
  const x = ['-c:v', 'libx264', '-preset', 'slower', '-b:v', `${kbps}k`, '-maxrate', `${kbps * 2}k`, '-bufsize', `${kbps * 2}k`,
    '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-x264-params', 'aq-mode=3:aq-strength=0.9', '-r', String(FPS), '-g', String(FPS * 2),
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-passlogfile', log];
  ff([...v, ...vf, ...x, '-pass', '1', '-an', '-f', 'mp4', 'NUL'], 'encode pass 1');
  ff([...v, '-i', wav, '-map', '0:v', '-map', '1:a', ...vf, ...x, '-pass', '2', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-shortest', out], 'encode pass 2');
  for (const f of readdirSync(FRAMES)) if (f.startsWith('x264')) rmSync(join(FRAMES, f));
  console.log(`video: ${width}x${height}, ${(N / FPS).toFixed(3)} s at ${kbps} kbit/s -> ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
}

/** review frames as JPGs (video time in s), and a 12-frame contact sheet */
function stills() {
  const at = preview ? [0.25, 0.5, 0.75].map((k) => (N / FPS) * k) : [3, 25.6, 31, 32.6, 40];
  at.forEach((t, i) => ff(['-ss', t.toFixed(3), '-i', OUT, '-frames:v', '1', '-q:v', '2', join(OUT_DIR, `${preview ? 'preview' : 'frame'}_${i + 1}_${t.toFixed(1)}s.jpg`)], 'still'));
  ff(['-i', OUT, '-vf', `fps=12/${(N / FPS).toFixed(3)},scale=480:-1,tile=4x3`, '-frames:v', '1', '-q:v', '3', OUT.replace(/\.mp4$/, '_contact.jpg')], 'contact sheet');
}

mkdirSync(OUT_DIR, { recursive: true });
if (!a.has('encode-only')) await render();
if (checkOnly) process.exit(0);
if (meter) {
  const m = JSON.parse(readFileSync(METER, 'utf8')) as { luma: number[] };
  console.log(`metered ${m.luma.length} frames -> ${METER}; luma ${Math.min(...m.luma).toFixed(0)}..${Math.max(...m.luma).toFixed(0)}`);
  process.exit(0);
}
const wav = join(FRAMES, 'flight.wav');
mixAudio(wav);
// (the previous cut is kept once, as <name>_v1.mp4)
const V1 = OUT.replace(/\.mp4$/, '_v1.mp4');
if (!preview && existsSync(OUT) && !existsSync(V1)) renameSync(OUT, V1);
encode(wav, OUT, preview ? H : 1080);
const OUT1440 = OUT.replace(/\.mp4$/, '_1440.mp4');
if (!preview && !a.has('no-1440')) encode(wav, OUT1440, 1440);
stills();
const fits = (p: string) => existsSync(p) && statSync(p).size <= MAX_BYTES;
if (!a.has('keep') && fits(OUT) && (preview || a.has('no-1440') || fits(OUT1440))) for (const f of readdirSync(FRAMES)) if (f.endsWith('.png')) rmSync(join(FRAMES, f));
