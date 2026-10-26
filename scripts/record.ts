/**
 * The trailer: six scripted shots captured frame by frame at exactly 60 fps, mixed with the game's own ambience and
 * encoded for X (Twitter).
 *
 *   pnpm record                      render every shot, mix the sound, encode E:\shots\island\trailer.mp4
 *   pnpm record --preview            one 1920x1080 frame per shot (at its previewAt) into E:\shots\island\trailer-preview\
 *                                    ([--at <s>] another shot time; with --shots for a few)
 *   pnpm record --motion village     one shot only, into E:\tmp\island\trailer-motion\ plus a quick mp4 and the time per frame
 *   pnpm record --shots beach,jetty  render only these shots (the others keep their frames), then mix and encode
 *   pnpm record --encode-only        mix and encode from the frames already on disk
 *   pnpm record --audio-only         only the sound track, E:\tmp\island\trailer\trailer.wav
 *   [--dev] against the dev server; [--keep] keep the PNG frames after the encode
 *
 * Determinism: the page runs with ?capture=1 (no HUD, muted, frozen time of day, seeded Math.random) and in manual
 * mode: every frame is __island.shotFrame(), which sets the camera pose of that frame, steers the walk, advances the
 * world by exactly 1/60 s and renders once; then the frame is read back with a CDP screenshot. Waves, wind, clouds,
 * particles, the character's animation and the temporal AA all move by the frame index, never by the wall clock.
 * Each shot starts from a fixed world time and random seed, after 1.5 s of uncaptured warm-up frames at its first
 * pose (TAA history, exposure and spray settle, so a cut never shows a converging frame).
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as THREE from 'three';
import { argv, ensureServer, launch, ROOT } from './lib/browser';

const FPS = 60;
const W = 1920, H = 1080;
const OUT = 'E:\\shots\\island\\trailer.mp4';
const PREVIEW_DIR = 'E:\\shots\\island\\trailer-preview';
const FRAMES = 'E:\\tmp\\island\\trailer';
const MOTION = 'E:\\tmp\\island\\trailer-motion';
const AUDIO_DIR = join(ROOT, 'public', 'assets', 'audio');
const WARMUP = 90;
/** the picture's fade to black at the end (seconds) */
const FADE_OUT = 2.5;

type V3 = [number, number, number];
type V2 = [number, number];
/** a camera key; `ground`: the y of pos and target are metres above the ground (or sea) under each */
interface Key { pos: V3; target: V3; fov?: number; ground?: boolean }
interface Walk { from: V2; path: V2[]; startAt: number; mode?: 'walk' | 'run' }
interface Layer { file: string; db: number; filter?: string }
interface Shot {
  name: string;
  tod: number;
  /** the spot staged first (streaming and the light settle there) */
  spot: string;
  /** seconds on screen (a dissolve shares half its length with each neighbour) */
  dur: number;
  /** dissolve from the previous shot, seconds (0: a straight cut) */
  xin: number;
  keys: Key[];
  /** 0 = linear along the path, 1 = full ease-in/out (smootherstep); in between keeps the camera drifting at the ends */
  ease: number;
  /** aim partly at the character: target = mix(path target, his position + height, weight) */
  track?: { weight: number; height: number };
  walk?: Walk;
  /** a grade on the game's metered exposure (1 = as played) */
  exposure?: number;
  /** shot time (s) of the preview frame */
  previewAt: number;
  layers: Layer[];
}

// the lighthouse sunset aim (main.ts shotPoseFor): 38 % of the way from the sun's azimuth toward the village
const LH: V2 = [-300, -300], GALLERY = 231;
const LH_A = 2.813;
const LD: V2 = [Math.cos(LH_A), Math.sin(LH_A)];
const LR: V2 = [-LD[1], LD[0]];
const lh = (back: number, side: number, y: number): V3 => [LH[0] - LD[0] * back + LR[0] * side, y, LH[1] - LD[1] * back + LR[1] * side];
const lhAim = (p: V3, dist: number, y: number): V3 => [p[0] + LD[0] * dist, y, p[2] + LD[1] * dist];

const SHOTS: Shot[] = [
  {
    // low over the wet sand at sunrise, the sea and the sun ahead, waves rolling in; he walks in from the left
    name: 'beach', tod: 6.55, spot: 'beach', dur: 6, xin: 0, ease: 0.6, previewAt: 4,
    keys: [
      { pos: [612, 0.95, 74.5], target: [642.6, 3, 48.8], fov: 50 },
      { pos: [611.5, 1.6, 75.5], target: [643, 4, 50], fov: 50 },
    ],
    track: { weight: 0.12, height: 1 },
    walk: { from: [611.1, 69.1], path: [[614, 67], [617.5, 64.5], [620, 62.5]], startAt: -0.3 },
    layers: [{ file: 'amb_waves', db: 0 }, { file: 'amb_surf', db: -4 }, { file: 'amb_birds', db: -9 }],
  },
  {
    // noon in the rainforest: he walks away from us down the sun-flecked floor, the camera follows slowly
    name: 'jungle', tod: 12.8, spot: 'jungle', dur: 6, xin: 0.8, ease: 0.6, previewAt: 3, exposure: 1.6,
    keys: [
      { pos: [359, 1.9, -66.2], target: [325, 2.6, -57.5], fov: 56, ground: true },
      { pos: [353.5, 2.2, -64.8], target: [318, 2.6, -55.5], fov: 56, ground: true },
    ],
    track: { weight: 0.15, height: 1 },
    walk: { from: [350.5, -63.8], path: [[343, -62], [335, -60], [327, -58], [319, -56]], startAt: -0.4 },
    layers: [{ file: 'amb_jungle', db: -6 }, { file: 'amb_birds', db: -12 }, { file: 'amb_wind', db: -20 }],
  },
  {
    // sunset in the village: the camera trucks with him along the shore, the huts on the right, the main jetty and
    // its canoes ahead against the low sun
    name: 'village', tod: 17.42, spot: 'village', dur: 10, xin: 0.8, ease: 0.5, previewAt: 6,
    keys: [
      { pos: [-405.5, 2.6, 348], target: [-445, 3.0, 330], fov: 52 },
      { pos: [-411, 2.9, 349], target: [-450, 3.2, 327], fov: 52 },
      { pos: [-417, 3.3, 349.5], target: [-454, 3.4, 324], fov: 52 },
    ],
    track: { weight: 0.2, height: 1 },
    walk: { from: [-412, 337.5], path: [[-418, 338.3], [-424, 339.2], [-430, 340]], startAt: -0.4 },
    layers: [
      { file: 'amb_waves', db: -3 }, { file: 'amb_chimes', db: -6 }, { file: 'amb_chickens', db: -13 },
      { file: 'amb_wind', db: -11 }, { file: 'amb_surf', db: -12 },
    ],
  },
  {
    // a drone rising off the end of the main jetty, the moored canoes riding the swell, the village beyond
    name: 'jetty', tod: 17.42, spot: 'village', dur: 6, xin: 0, ease: 0.6, previewAt: 3,
    keys: [
      { pos: [-434, 4.5, 398], target: [-458, 1.5, 366], fov: 50 },
      { pos: [-428, 11, 404], target: [-458, 1, 362], fov: 50 },
      { pos: [-420, 18, 410], target: [-458, 0.5, 358], fov: 50 },
    ],
    layers: [{ file: 'amb_waves', db: -6 }, { file: 'amb_creak', db: -11 }, { file: 'amb_gulls', db: -10, filter: 'highpass=f=250' }, { file: 'amb_wind', db: -16 }],
  },
  {
    // a crane up past the lighthouse tower to the gallery's view over the island and the sun on the western sea
    name: 'lighthouse', tod: 17.42, spot: 'lighthouse', dur: 7, xin: 0.8, ease: 0.7, previewAt: 6,
    keys: [
      { pos: lh(16, 10, 225), target: lhAim(lh(16, 10, 225), 300, 262), fov: 52 },
      { pos: lh(16, 10, 231), target: lhAim(lh(16, 10, 231), 400, 215), fov: 52 },
      { pos: lh(16, 10, GALLERY + 6), target: lhAim(lh(16, 10, GALLERY + 6), 700, GALLERY - 120), fov: 52 },
    ],
    layers: [{ file: 'amb_wind', db: 5 }, { file: 'amb_surf', db: -6, filter: 'lowpass=f=700' }, { file: 'amb_birds', db: -20 }],
  },
  {
    // the whole island in the golden hour from the sea, a slow push in, then the fade to black
    name: 'final', tod: 17.3, spot: 'village', dur: 5, xin: 0.8, ease: 0.4, previewAt: 2,
    keys: [
      { pos: [-1000, 110, 620], target: [-150, 40, -80], fov: 40 },
      { pos: [-970, 106, 592], target: [-150, 39, -80], fov: 40 },
    ],
    layers: [{ file: 'amb_waves', db: -3 }, { file: 'amb_wind', db: -5 }],
  },
];

/** frames a shot renders: half of each neighbouring dissolve on either side of its own duration */
function span(i: number) {
  const pre = Math.round((SHOTS[i].xin * FPS) / 2);
  const post = i + 1 < SHOTS.length ? Math.round((SHOTS[i + 1].xin * FPS) / 2) : 0;
  const body = Math.round(SHOTS[i].dur * FPS);
  return { pre, post, body, total: pre + body + post };
}
/** where each shot starts on the trailer's timeline (s) */
function starts() {
  let t = 0;
  return SHOTS.map((s) => {
    const a = t;
    t += s.dur;
    return a;
  });
}

const smoother = (x: number) => x * x * x * (x * (x * 6 - 15) + 10);

/** a shot's camera as a function of shot time: eased, arc-length Catmull-Rom paths through the keys */
function cameraPath(shot: Shot, keys: Key[], i: number) {
  const { pre, post } = span(i);
  const t0 = -pre / FPS, t1 = shot.dur + post / FPS;
  const curve = (pts: V3[]) => (pts.length === 2 ? new THREE.LineCurve3(new THREE.Vector3(...pts[0]), new THREE.Vector3(...pts[1])) : new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)), false, 'centripetal'));
  const pos = curve(keys.map((k) => k.pos));
  const tgt = curve(keys.map((k) => k.target));
  const fovs = keys.map((k) => k.fov ?? 55);
  return (t: number) => {
    const x = THREE.MathUtils.clamp((t - t0) / (t1 - t0), 0, 1);
    const u = (1 - shot.ease) * x + shot.ease * smoother(x);
    const f = u * (fovs.length - 1), j = Math.min(fovs.length - 2, Math.floor(f));
    return { pos: pos.getPointAt(u), target: tgt.getPointAt(u), fov: THREE.MathUtils.lerp(fovs[j], fovs[j + 1], f - j) };
  };
}

/** pure pursuit along the walk's waypoints: the heading toward a point 1.6 m ahead on the path, null at the end */
function steer(walk: Walk, p: { x: number; z: number }, state: { seg: number }) {
  const pts = [walk.from, ...walk.path];
  while (state.seg < pts.length - 2) {
    const [ax, az] = pts[state.seg + 1];
    if (Math.hypot(ax - p.x, az - p.z) < 1.6) state.seg++;
    else break;
  }
  const [ex, ez] = pts[pts.length - 1];
  if (Math.hypot(ex - p.x, ez - p.z) < 0.5) return null;
  const [tx, tz] = pts[state.seg + 1];
  return Math.atan2(tx - p.x, -(tz - p.z));
}

interface Api {
  ready: (ms?: number) => Promise<boolean>;
  stage: (o: unknown) => Promise<unknown>;
  manual: (on: boolean) => boolean;
  shotStart: (t: number, seed: number, exposure?: number) => number;
  placePlayer: (x: number, z: number, yaw: number) => unknown;
  shotFrame: (o: unknown) => { frame: number; player: { pos: number[]; heading: number; speed: number } | null; steps: { surface: string; pos: number[] }[]; pending: number };
  ctx: { hf: { height: (x: number, z: number) => number } };
}

const a = argv();
const preview = a.has('preview');
const motion = a.get('motion', '');
const encodeOnly = a.has('encode-only');
const only = a.get('shots', '') ? a.get('shots', '').split(',') : motion ? [motion] : SHOTS.map((s) => s.name);
for (const n of only) if (!SHOTS.some((s) => s.name === n)) throw new Error(`unknown shot ${n}; have ${SHOTS.map((s) => s.name).join(', ')}`);

const shotDir = (i: number) => join(motion ? MOTION : FRAMES, `${i + 1}_${SHOTS[i].name}`);

async function render() {
  const server = await ensureServer(a.has('dev') ? 'dev' : 'preview');
  const L = await launch({ profile: 'E:\\tmp\\island\\chrome-dev' });
  // (tsx keeps function names with a helper the page does not have)
  await L.context.addInitScript({ content: 'globalThis.__name = (f) => f' });
  const cdp = await L.context.newCDPSession(L.page);
  const first = SHOTS.find((s) => only.includes(s.name))!;
  const timing: Record<string, number> = {};
  try {
    await L.page.goto(`${server.url}?capture=1&quality=high&spot=${first.spot}&tod=${first.tod}`, { waitUntil: 'domcontentloaded' });
    await L.page.waitForFunction(() => typeof (window as unknown as { __island?: { ready?: unknown } }).__island?.ready === 'function', null, { timeout: 180000 });
    await L.page.evaluate(() => (window as unknown as { __island: Api }).__island.ready());
    const dims = await L.page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
    if (dims[0] !== W || dims[1] !== H || dims[2] !== 1) throw new Error(`viewport ${dims.join('x')}, want ${W}x${H} at dpr 1`);
    if (preview) mkdirSync(PREVIEW_DIR, { recursive: true });

    for (let i = 0; i < SHOTS.length; i++) {
      const shot = SHOTS[i];
      if (!only.includes(shot.name)) continue;
      const { pre, total } = span(i);
      // ground-relative keys resolved against the heightfield (the sea counts as ground at 0)
      const keys = await L.page.evaluate((ks) => {
        const hf = (window as unknown as { __island: Api }).__island.ctx.hf;
        const g = (x: number, z: number) => Math.max(hf.height(x, z), 0);
        return ks.map((k) => (k.ground ? { ...k, pos: [k.pos[0], k.pos[1] + g(k.pos[0], k.pos[2]), k.pos[2]], target: [k.target[0], k.target[1] + g(k.target[0], k.target[2]), k.target[2]] } : k));
      }, shot.keys) as Key[];
      const cam = cameraPath(shot, keys, i);
      const pose = (t: number, pl?: number[] | null) => {
        const c = cam(t);
        if (shot.track && pl) c.target.lerp(new THREE.Vector3(pl[0], pl[1] + shot.track.height, pl[2]), shot.track.weight);
        return { pos: c.pos.toArray().map((v) => +v.toFixed(4)), target: c.target.toArray().map((v) => +v.toFixed(4)), fov: +c.fov.toFixed(3) };
      };
      const t0 = -pre / FPS;
      const startYaw = shot.walk ? Math.atan2(shot.walk.path[0][0] - shot.walk.from[0], -(shot.walk.path[0][1] - shot.walk.from[1])) : 0;
      await L.page.evaluate(async (o) => {
        const api = (window as unknown as { __island: Api }).__island;
        api.manual(false);
        await api.stage({ spot: o.spot, tod: o.tod, weather: 'clear', camera: o.cam, worldTime: null, settleMs: 600 });
        api.manual(true);
        api.shotStart(1000 + o.i * 200, 9001 + o.i, o.exposure);
        // (a shot without him parks him in the rainforest, out of every other frame)
        if (o.walk) api.placePlayer(o.walk.from[0], o.walk.from[1], o.yaw);
        else api.placePlayer(365, 18, 0);
      }, { spot: shot.spot, tod: shot.tod, cam: pose(t0), i, walk: shot.walk ?? null, yaw: startYaw, exposure: shot.exposure ?? 1 });

      let pl = null as number[] | null;
      const st = { seg: 0 };
      const frame = async (t: number, warm = false) => {
        let walk: number | null = null;
        if (!warm && shot.walk && t >= shot.walk.startAt && pl) walk = steer(shot.walk, { x: pl[0], z: pl[2] }, st);
        const r = await L.page.evaluate((o) => (window as unknown as { __island: Api }).__island.shotFrame(o), { cam: pose(t, pl), walk, dt: 1 / FPS });
        pl = r.player?.pos ?? null;
        return r;
      };
      // warm-up at the first pose: TAA history, exposure, spray and the sea settle (nothing captured)
      for (let k = 0; k < WARMUP; k++) await frame(t0, true);

      const dir = shotDir(i);
      const capture = async () => {
        const r = (await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, clip: { x: 0, y: 0, width: W, height: H, scale: 1 } })) as { data: string };
        return Buffer.from(r.data, 'base64');
      };
      if (preview) {
        const at = a.has('at') ? Number(a.get('at', '0')) : shot.previewAt;
        const n = Math.round((at - t0) * FPS);
        for (let f = 0; f < n; f++) await frame(t0 + f / FPS);
        const path = join(PREVIEW_DIR, `${i + 1}_${shot.name}.png`);
        writeFileSync(path, await capture());
        console.log(`${shot.name}: ${path} (t = ${at} s, player ${pl?.map((v) => v.toFixed(1)).join(' ')})`);
        continue;
      }
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const steps: { f: number; surface: string; pos: number[]; cam: number[] }[] = [];
      const writes: Promise<void>[] = [];
      let pending = 0;
      const tStart = Date.now();
      for (let f = 0; f < total; f++) {
        const t = t0 + f / FPS;
        const r = await frame(t);
        if (r.pending) pending++;
        for (const s of r.steps) steps.push({ f, surface: s.surface, pos: s.pos, cam: pose(t, pl).pos });
        const png = await capture();
        writes.push(writeFile(join(dir, `f_${String(f).padStart(5, '0')}.png`), png));
        if (writes.length >= 12) await writes.shift();
        if (f % 120 === 0) process.stdout.write(`\r${shot.name} ${f}/${total}`);
      }
      await Promise.all(writes);
      const ms = (Date.now() - tStart) / total;
      timing[shot.name] = ms;
      writeFileSync(join(dir, 'shot.json'), JSON.stringify({ name: shot.name, frames: total, pre, msPerFrame: +ms.toFixed(1), framesWithPendingPipelines: pending, steps }, null, 1));
      console.log(`\r${shot.name}: ${total} frames in ${((ms * total) / 1000).toFixed(0)} s (${ms.toFixed(0)} ms/frame)${pending ? `, ${pending} frames with pipelines still compiling` : ''}`);
    }
  } finally {
    await L.browser.close();
    server.stop();
  }
  if (L.console.some((l) => l.startsWith('[pageerror]'))) console.warn(L.console.filter((l) => l.startsWith('[pageerror]')).join('\n'));
  return timing;
}

function ff(args: string[], what: string) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${what}: ffmpeg failed\n${r.stderr}`);
  return r.stderr;
}

/** integrated loudness (LUFS) of a sound file */
function lufs(file: string) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = [...r.stderr.matchAll(/^\s+I:\s+(-?[\d.]+) LUFS/gm)].pop();
  return m ? Number(m[1]) : -20;
}

/**
 * The sound: per shot a bed of the game's ambience loops (each loop levelled to -20 LUFS, then the shot's dB),
 * running half a second past each cut with 1 s fades so the beds crossfade over the cut; the character's footsteps
 * at the frames the game stepped, quieter with his distance from the camera; then the whole mix normalised to
 * -16 LUFS integrated (two-pass loudnorm), faded in at the start and out with the picture.
 */
function mixAudio(total: number, wav: string) {
  const S = starts();
  const inputs: string[] = [];
  const chains: string[] = [];
  const labels: string[] = [];
  const level = new Map<string, number>();
  const gainFor = (file: string) => {
    if (!level.has(file)) level.set(file, lufs(join(AUDIO_DIR, `${file}.ogg`)));
    return -20 - level.get(file)!;
  };
  SHOTS.forEach((s, i) => {
    const a0 = Math.max(0, S[i] - 0.5), a1 = Math.min(total, S[i] + s.dur + 0.5);
    const len = a1 - a0;
    const fin = i === 0 ? 0.6 : 1, fout = i === SHOTS.length - 1 ? 0 : 1;
    s.layers.forEach((l, k) => {
      const n = inputs.length / 6;
      // (a different start into each loop, so a file used in two shots does not repeat itself)
      inputs.push('-stream_loop', '-1', '-ss', String(3 + i * 7 + k * 2), '-i', join(AUDIO_DIR, `${l.file}.ogg`));
      const f = [`[${n}:a]aresample=48000`, 'aformat=channel_layouts=stereo', `atrim=0:${len.toFixed(4)}`, 'asetpts=PTS-STARTPTS', l.filter, `volume=${(gainFor(l.file) + l.db).toFixed(2)}dB`,
        fin ? `afade=t=in:st=0:d=${fin}` : null, fout ? `afade=t=out:st=${(len - fout).toFixed(4)}:d=${fout}` : null, `adelay=${Math.round(a0 * 1000)}:all=1`].filter(Boolean);
      chains.push(`${f.join(',')}[b${i}_${k}]`);
      labels.push(`[b${i}_${k}]`);
    });
  });
  // footsteps
  const steps: { t: number; file: string; gain: number }[] = [];
  SHOTS.forEach((s, i) => {
    const p = join(FRAMES, `${i + 1}_${s.name}`, 'shot.json');
    if (!existsSync(p)) return;
    const j = JSON.parse(readFileSync(p, 'utf8')) as { pre: number; steps: { f: number; surface: string; pos: number[]; cam: number[] }[] };
    j.steps.forEach((e, k) => {
      const t = S[i] + (e.f - j.pre) / FPS;
      if (t < S[i] - 0.2 || t > S[i] + s.dur + 0.2) return;
      const d = Math.hypot(e.pos[0] - e.cam[0], e.pos[1] - e.cam[1], e.pos[2] - e.cam[2]);
      const kind = ({ wet_sand: 'sand', dirt: 'gravel', rock: 'stone' } as Record<string, string>)[e.surface] ?? e.surface;
      const file = `step_${existsSync(join(AUDIO_DIR, `step_${kind}_1.ogg`)) ? kind : 'sand'}_${1 + (k % 4)}`;
      steps.push({ t, file, gain: 20 * Math.log10(THREE.MathUtils.clamp(3 / Math.max(d, 1), 0.08, 0.6)) });
    });
  });
  const stepFiles = [...new Set(steps.map((s) => s.file))];
  stepFiles.forEach((file) => {
    const n = inputs.length / 6;
    inputs.push('-stream_loop', '0', '-ss', '0', '-i', join(AUDIO_DIR, `${file}.ogg`));
    const uses = steps.filter((s) => s.file === file);
    chains.push(`[${n}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${(gainFor(file) + 2).toFixed(2)}dB,asplit=${uses.length}${uses.map((_, k) => `[s_${file}_${k}]`).join('')}`);
    uses.forEach((u, k) => {
      chains.push(`[s_${file}_${k}]volume=${u.gain.toFixed(2)}dB,adelay=${Math.round(u.t * 1000)}:all=1[t_${file}_${k}]`);
      labels.push(`[t_${file}_${k}]`);
    });
  });
  const graph = `${chains.join(';')};${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest,atrim=0:${total},asetpts=PTS-STARTPTS[mix]`;
  const raw = wav.replace(/\.wav$/, '.raw.wav');
  ff([...inputs, '-filter_complex', graph, '-map', '[mix]', '-c:a', 'pcm_s24le', raw], 'audio mix');
  // two-pass loudness normalisation to -16 LUFS, then the fades
  const m = spawnSync('ffmpeg', ['-hide_banner', '-i', raw, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const js = JSON.parse(m.slice(m.lastIndexOf('{'), m.lastIndexOf('}') + 1)) as Record<string, string>;
  const ln = `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${js.input_i}:measured_TP=${js.input_tp}:measured_LRA=${js.input_lra}:measured_thresh=${js.input_thresh}:offset=${js.target_offset}:linear=true`;
  ff(['-i', raw, '-af', `${ln},aresample=48000,afade=t=in:st=0:d=0.6,afade=t=out:st=${(total - FADE_OUT - 0.5).toFixed(3)}:d=${FADE_OUT + 0.5}`, '-c:a', 'pcm_s24le', wav], 'loudnorm');
  rmSync(raw, { force: true });
  console.log(`audio: ${steps.length} footsteps, ${labels.length - steps.length} ambience layers -> ${wav}`);
}

/** picture: each shot's frames, dissolves (xfade) or cuts (concat) between them, the fade to black, plus the sound */
function encode(wav: string) {
  const inputs: string[] = [];
  const parts: string[] = [];
  let acc = '', D = 0;
  SHOTS.forEach((s, i) => {
    const dir = join(FRAMES, `${i + 1}_${s.name}`);
    const { total } = span(i);
    const n = readdirSync(dir).filter((f) => f.endsWith('.png')).length;
    if (n !== total) throw new Error(`${s.name}: ${n} frames on disk, want ${total}`);
    inputs.push('-framerate', String(FPS), '-start_number', '0', '-i', join(dir, 'f_%05d.png'));
    parts.push(`[${i}:v]settb=1/${FPS},setpts=N,fps=${FPS},format=yuv444p[v${i}]`);
    const len = total / FPS;
    if (i === 0) {
      acc = `[v0]`;
      D = len;
      return;
    }
    const out = `[a${i}]`;
    if (s.xin > 0) {
      parts.push(`${acc}[v${i}]xfade=transition=fade:duration=${s.xin}:offset=${(D - s.xin).toFixed(4)}${out}`);
      D += len - s.xin;
    } else {
      parts.push(`${acc}[v${i}]concat=n=2:v=1:a=0${out}`);
      D += len;
    }
    acc = out;
  });
  parts.push(`${acc}fade=t=out:st=${(D - FADE_OUT).toFixed(4)}:d=${FADE_OUT},format=yuv420p[vout]`);
  const nIn = SHOTS.length;
  ff([...inputs, '-i', wav, '-filter_complex', parts.join(';'), '-map', '[vout]', '-map', `${nIn}:a`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-g', '120',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-shortest', OUT], 'encode');
  console.log(`video: ${D.toFixed(3)} s -> ${OUT} (${(statSync(OUT).size / 1e6).toFixed(1)} MB)`);
}

const total = SHOTS.reduce((t, s) => t + s.dur, 0);
if (a.has('audio-only')) {
  mkdirSync(FRAMES, { recursive: true });
  mixAudio(total, join(FRAMES, 'trailer.wav'));
  process.exit(0);
}
if (!encodeOnly) {
  const timing = await render();
  if (motion) {
    const i = SHOTS.findIndex((s) => s.name === motion);
    const mp4 = join(MOTION, `${i + 1}_${motion}.mp4`);
    ff(['-framerate', String(FPS), '-i', join(shotDir(i), 'f_%05d.png'), '-c:v', 'libx264', '-crf', '20', '-preset', 'fast', '-pix_fmt', 'yuv420p', mp4], 'motion clip');
    const frames = SHOTS.reduce((n, _, k) => n + span(k).total, 0);
    console.log(`motion check: ${mp4}; at ${timing[motion].toFixed(0)} ms/frame the whole trailer (${frames} frames) renders in about ${((frames * (timing[motion] + 5)) / 60000 + SHOTS.length * 0.3).toFixed(0)} min`);
  }
}
if (!preview && !motion) {
  mkdirSync('E:\\shots\\island', { recursive: true });
  const wav = join(FRAMES, 'trailer.wav');
  mixAudio(total, wav);
  encode(wav);
  // (the PNG sequences go; each shot's shot.json with its footsteps and timing stays)
  if (!a.has('keep')) {
    for (let i = 0; i < SHOTS.length; i++) {
      const dir = join(FRAMES, `${i + 1}_${SHOTS[i].name}`);
      for (const f of readdirSync(dir)) if (f.endsWith('.png')) rmSync(join(dir, f));
    }
  }
}
