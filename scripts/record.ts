/**
 * The gameplay trailer: the island dive down to him on the village beach, then quick straight cuts of real play (the
 * game's own third-person follow camera, the character steered like a player steers him), a hard cut to black.
 * Captured frame by frame at exactly 60 fps, with the game's own ambience and footsteps, encoded for X (Twitter).
 *
 *   pnpm record                      render every beat, mix the sound, encode E:\shots\island\trailer.mp4
 *   pnpm record --seconds 10         only the first 10 s, into E:\shots\island\trailer-preview\gameplay_edit_v2_first10s.mp4
 *   pnpm record --preview            one 1920x1080 frame per beat (at its previewAt) into E:\shots\island\trailer-preview\
 *                                    ([--at <s>] another beat time; with --shots for a few)
 *   pnpm record --shots beach,jetty  render only these beats (the others keep their frames), then mix and encode
 *   pnpm record --encode-only        mix and encode from the frames already on disk
 *   pnpm record --audio-only         only the sound track
 *   [--dev] against the dev server; [--keep] keep the PNG frames after the encode
 *
 * Determinism: the page runs with ?capture=1&clean=1 (no HUD, muted, frozen time of day, seeded Math.random, no
 * vignette) in manual mode: every frame is __island.shotFrame(), which places the camera (an exact pose from the
 * opening's rig, or the game's follow camera updating itself as in play), steers the walk, advances the world by
 * exactly 1/60 s and renders once; then the frame is read back with a CDP screenshot. Each beat starts from a fixed
 * world time and random seed after 1.5 s of uncaptured warm-up (TAA history, exposure and the sea settle; on the
 * gameplay beats he is already walking and the follow camera has settled behind him). The picture is the game's own:
 * its tone mapping, metered exposure and grade, no exposure grades, dissolves or fades on top.
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
const FRAMES = 'E:\\tmp\\island\\gameplay';
const AUDIO_DIR = join(ROOT, 'public', 'assets', 'audio');
const WARMUP = 90;
/** renders averaged into each frame (?accum: jittered supersampling, the dithers resolved) */
const ACCUM = 8;
/** the sound's crossfade at each cut and its fade at the end (s) */
const XF = 0.16;
/** the sound: every layer high-passed (no rumble or boom), gently compressed and limited, soft (LUFS integrated) */
const HP = 140;
const LUFS = -20;
const MASTER = 'highpass=f=110:poles=2,acompressor=threshold=-26dB:ratio=2.5:attack=30:release=300:makeup=1,alimiter=limit=0.6:attack=5:release=80:level=false';
/** black held after the last beat (s) */
const TAIL = 0.5;

type V2 = [number, number];
/** `from`: where he stands at the first warm-up frame (gameplay beats walk through the warm-up); `jumpAt`: he
 *  jumps once on reaching it */
interface Walk { from: V2; path: V2[]; startAt: number; mode?: 'walk' | 'run' | 'sprint'; jumpAt?: V2 }
interface Layer { file: string; db: number; filter?: string }
interface Shot {
  name: string;
  tod: number;
  /** the spot staged first (streaming and the light settle there) */
  spot: string;
  /** seconds on screen; every cut is straight */
  dur: number;
  /** the game's own third-person follow camera, at this pitch (negative looks up: the sky in frame) ... */
  follow?: boolean;
  pitch?: number;
  /** a look round with the mouse, standing: from shot time `at`, over `dur` s on an eased stroke, the camera turns
   *  to the sun's heading (+ `offset` rad) and pitches by `pitch` rad (positive looks down) */
  look?: { at: number; dur: number; offset: number; pitch: number };
  /** ... or a rig around the character: a pose from the shot time and his spring-followed position */
  rig?: (p: { t: number; subj: THREE.Vector3; dir: THREE.Vector3 }) => { pos: THREE.Vector3; target: THREE.Vector3; fov: number };
  walk: Walk;
  /** world clock and random seed at the first frame (default from the beat's index) */
  world?: number;
  seed?: number;
  /** shot time (s) of the preview frame */
  previewAt: number;
  layers: Layer[];
}

const SHOTS: Shot[] = [
  {
    // the opening, exactly as the old trailer's village shot: the whole island seen from the sea (1.3 km off and about
    // 415 m up) rushes down to 4.4 m behind him on the village beach at sunset, the distance falling on a log scale,
    // the aim handing over from the island to him; cut once the dive has landed (clip frame 275), before its orbit
    name: 'opening', tod: 17.42, spot: 'village', dur: 276 / FPS, world: 1400, seed: 9003, previewAt: 2,
    rig: ({ t: st, subj, dir }) => {
      const { lerp, smoothstep, smootherstep, degToRad } = THREE.MathUtils;
      // (the old shot's timing: its 12 s rig ran over 12.4 s of frames, the first 0.4 s a dissolve's lead-in)
      const t = st * (12 / 12.4);
      const dive = smootherstep(t, 0, 4.2);
      const ramp = (q: number) => (q < 0.18 ? (q * q / 2 - 0.2 * q * q * q) / 0.18 : (0.0162 - 0.2 * 0.005832) / 0.18 + (q - 0.3 * q * q) - (0.18 - 0.3 * 0.0324));
      const orbit = t < 4.6 ? 0 : ramp(Math.min(1, (t - 4.6) / 7.4)) / ramp(1);
      const rDive = Math.exp(lerp(Math.log(1300), Math.log(4.4), dive));
      const phi = degToRad(lerp(lerp(122, 70, smoothstep(dive, 0.2, 1)), -30, orbit));
      const r = lerp(rDive, 3.8, orbit);
      const y = lerp(1.35 + (rDive - 4.4) * 0.32, 1.25, orbit);
      const pos = subj.clone().add(new THREE.Vector3(Math.cos(phi) * r, y, Math.sin(phi) * r));
      const near = subj.clone().add(new THREE.Vector3(0, lerp(2.2, 1.5, dive), 0)).addScaledVector(dir, lerp(3.0, 1.8, orbit));
      const target = new THREE.Vector3(-150, 40, -80).lerp(near, smoothstep(dive, 0.35, 0.85));
      return { pos, target, fov: lerp(lerp(40, 52, dive), 45, orbit) };
    },
    walk: { from: [-412, 337.5], path: [[-418, 338.3], [-424, 339.2], [-430, 340]], startAt: 0 },
    layers: [{ file: 'amb_waves', db: -5 }, { file: 'amb_wind', db: -13 }, { file: 'amb_birds', db: -14 }],
  },
  {
    // sunrise: walking north along the firm sand 6 m up from the waterline, the sea and the sun on his left, the
    // crescent of the beach curving away ahead
    name: 'beach', tod: 6.55, spot: 'beach', dur: 3.5, follow: true, pitch: -0.07, previewAt: 2,
    walk: { from: [606, -2], path: [[606, 10], [606.3, 22], [606.8, 34], [607.8, 46], [609.5, 58], [611.5, 70]], startAt: 0 },
    layers: [{ file: 'amb_waves', db: -4 }, { file: 'amb_birds', db: -12 }, { file: 'amb_wind', db: -16 }],
  },
  {
    // early morning: sprinting off the top of the beach into the rainforest, along the trail toward the waterfall
    name: 'jungle', tod: 7.3, spot: 'beach', dur: 3.5, follow: true, pitch: -0.06, previewAt: 2,
    walk: { from: [604, -79], path: [[592, -82], [578, -85.5], [562, -89], [546, -91.5], [530, -91.5], [510, -89.5]], startAt: 0, mode: 'sprint' },
    layers: [{ file: 'amb_birds', db: -9 }, { file: 'amb_wind', db: -16 }, { file: 'amb_waves', db: -17 }],
  },
  {
    // golden hour in the village: walking west along the sand in front of the stilt huts, into the low sun
    name: 'village', tod: 17.0, spot: 'village', dur: 3.5, follow: true, pitch: -0.06, previewAt: 2,
    walk: { from: [-398, 322], path: [[-404, 321.5], [-412, 321], [-420, 320.5], [-428, 320], [-436, 320]], startAt: 0 },
    layers: [{ file: 'amb_waves', db: -6 }, { file: 'amb_birds', db: -14 }, { file: 'amb_wind', db: -14 }],
  },
  {
    // sunset: jogging out along the main jetty past its crates, off the end in a jump, and swimming out
    name: 'jetty', tod: 17.42, spot: 'village', dur: 4.5, follow: true, pitch: -0.05, previewAt: 2.5,
    walk: { from: [-452, 374.5], path: [[-452.2, 378], [-452.3, 383], [-452.2, 388.5], [-452, 394], [-451.5, 400], [-451, 406]], startAt: 0, mode: 'run', jumpAt: [-452.2, 386.6] },
    layers: [{ file: 'amb_waves', db: -4 }, { file: 'amb_wind', db: -14 }, { file: 'amb_birds', db: -18 }],
  },
  {
    // the last switchback up the summit cone, jogging toward the tower
    name: 'climb', tod: 17.25, spot: 'lighthouse', dur: 3, follow: true, pitch: -0.08, previewAt: 2,
    walk: { from: [-255, -276], path: [[-258.5, -285], [-264, -300], [-275, -303.5], [-286, -306]], startAt: 0, mode: 'run' },
    layers: [{ file: 'amb_wind', db: -9 }, { file: 'amb_birds', db: -13 }],
  },
  {
    // golden hour on the summit: walking round the foot of the tower with the sun on his left, he stops; the player
    // looks round with the mouse, the follow camera swinging round him to the sun on the western sea and tipping
    // down onto the water; then the cut to black
    name: 'summit', tod: 17.5, spot: 'lighthouse', dur: 7, follow: true, pitch: -0.05, previewAt: 3,
    walk: { from: [-308, -297], path: [[-309.5, -298.5], [-311.5, -300.5], [-312.5, -301.5]], startAt: 0 },
    look: { at: 3.4, dur: 3.0, offset: -0.22, pitch: 0.24 },
    layers: [{ file: 'amb_wind', db: -8 }, { file: 'amb_waves', db: -19 }, { file: 'amb_birds', db: -20 }],
  },
];

const a = argv();
const preview = a.has('preview');
const encodeOnly = a.has('encode-only');
const seconds = a.has('seconds') ? Number(a.get('seconds', '0')) : 0;
const only = a.get('shots', '') ? a.get('shots', '').split(',') : SHOTS.map((s) => s.name);
for (const n of only) if (!SHOTS.some((s) => s.name === n)) throw new Error(`unknown shot ${n}; have ${SHOTS.map((s) => s.name).join(', ')}`);

/** where each beat starts on the timeline (s) */
const START = SHOTS.reduce<number[]>((s, x, i) => [...s, i ? s[i - 1] + SHOTS[i - 1].dur : 0], []);
const FULL = SHOTS.reduce((t, s) => t + s.dur, 0);
/** the edit's length without the black tail: everything, or the first --seconds */
const LEN = seconds ? Math.min(seconds, FULL) : FULL;
/** frames a beat contributes to the edit (0: past --seconds) */
const framesOf = (i: number) => Math.max(0, Math.min(Math.round(SHOTS[i].dur * FPS), Math.round((LEN - START[i]) * FPS)));
const used = SHOTS.map((_, i) => i).filter((i) => framesOf(i) > 0);
const shotDir = (i: number) => join(FRAMES, `${i + 1}_${SHOTS[i].name}`);

/** the character as the opening's rig sees him: a critically damped spring on his position (no overshoot, no step bob)
 *  and his smoothed walking direction, stepped once per frame */
function follower(w: number) {
  const p = new THREE.Vector3(), v = new THREE.Vector3(), dir = new THREE.Vector3(1, 0, 0), last = new THREE.Vector3();
  let init = false;
  return {
    p, dir,
    step(pos: number[] | null, dt: number) {
      if (!pos) return;
      const x = new THREE.Vector3(pos[0], pos[1], pos[2]);
      if (!init) {
        p.copy(x);
        last.copy(x);
        init = true;
        return;
      }
      const k = w * w, c = 2 * w;
      v.addScaledVector(x.clone().sub(p).multiplyScalar(k).sub(v.clone().multiplyScalar(c)), dt);
      p.addScaledVector(v, dt);
      const d = x.clone().sub(last).setY(0);
      if (d.lengthSq() > 1e-8) dir.lerp(d.normalize(), 1 - Math.exp(-dt * 1.5)).normalize();
      last.copy(x);
    },
  };
}

/** a player's steering: pure pursuit along the walk's waypoints, the heading toward the next point (1.6 m capture
 *  radius, so the turns round off), null at the end */
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

type Cam = { pos: number[]; target: number[]; fov: number } | 'follow';
interface Api {
  ready: (ms?: number) => Promise<boolean>;
  stage: (o: unknown) => Promise<unknown>;
  manual: (on: boolean) => boolean;
  shotStart: (t: number, seed: number, exposure?: number) => number;
  placePlayer: (x: number, z: number, yaw: number) => unknown;
  shotFrame: (o: { cam: Cam; snap?: number; pitch?: number; walk: number | null; mode?: 'walk' | 'run' | 'sprint'; jump?: boolean; look?: number[]; accum?: number; dt: number }) => { frame: number; player: { pos: number[] } | null; cam: number[]; camYaw: number; steps: { surface: string; pos: number[] }[]; pending: number };
}

async function render() {
  const server = await ensureServer(a.has('dev') ? 'dev' : 'preview');
  const L = await launch({ profile: 'E:\\tmp\\island\\chrome-dev' });
  // (tsx keeps function names with a helper the page does not have)
  await L.context.addInitScript({ content: 'globalThis.__name = (f) => f' });
  const cdp = await L.context.newCDPSession(L.page);
  const todo = used.filter((i) => only.includes(SHOTS[i].name));
  const first = SHOTS[todo[0]];
  try {
    await L.page.goto(`${server.url}?capture=1&clean=1&accum=${ACCUM}&quality=high&spot=${first.spot}&tod=${first.tod}`, { waitUntil: 'domcontentloaded' });
    await L.page.waitForFunction(() => typeof (window as unknown as { __island?: { ready?: unknown } }).__island?.ready === 'function', null, { timeout: 180000 });
    await L.page.evaluate(() => (window as unknown as { __island: Api }).__island.ready());
    const dims = await L.page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
    if (dims[0] !== W || dims[1] !== H || dims[2] !== 1) throw new Error(`viewport ${dims.join('x')}, want ${W}x${H} at dpr 1`);
    if (preview) mkdirSync(PREVIEW_DIR, { recursive: true });
    // the averaging passes' own pipelines compile here, not on a beat's first frame (each beat then starts afresh)
    for (let k = 0; k < 600; k++) {
      const r = await L.page.evaluate(() => {
        const api = (window as unknown as { __island: Api }).__island;
        api.manual(true);
        return api.shotFrame({ cam: 'follow', walk: null, dt: 1 / 60 });
      });
      if (k > 3 && !r.pending) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    const capture = async () => {
      const r = (await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, clip: { x: 0, y: 0, width: W, height: H, scale: 1 } })) as { data: string };
      return Buffer.from(r.data, 'base64');
    };

    for (const i of todo) {
      const shot = SHOTS[i];
      const { walk } = shot;
      const fol = follower(2.2);
      fol.p.set(walk.from[0], 0, walk.from[1]);
      fol.dir.set(walk.path[0][0] - walk.from[0], 0, walk.path[0][1] - walk.from[1]).normalize();
      const pose = (t: number): Cam => {
        if (shot.follow || !shot.rig) return 'follow';
        const c = shot.rig({ t, subj: fol.p, dir: fol.dir });
        return { pos: c.pos.toArray().map((v) => +v.toFixed(4)), target: c.target.toArray().map((v) => +v.toFixed(4)), fov: +c.fov.toFixed(3) };
      };
      const yaw = Math.atan2(walk.path[0][0] - walk.from[0], -(walk.path[0][1] - walk.from[1]));
      const placed = await L.page.evaluate(async (o) => {
        const api = (window as unknown as { __island: Api }).__island;
        api.manual(false);
        await api.stage({ spot: o.spot, tod: o.tod, weather: 'clear', camera: o.cam, worldTime: null, settleMs: 600 });
        api.manual(true);
        api.shotStart(o.world, o.seed, 1);
        const sun = (api as unknown as { ctx: { tod: { sun: { x: number; z: number } } } }).ctx.tod.sun;
        return { ...(api.placePlayer(o.from[0], o.from[1], o.yaw) as { pos: number[] } | null), sunYaw: Math.atan2(sun.x, -sun.z) };
      }, { spot: shot.spot, tod: shot.tod, cam: pose(0), world: shot.world ?? 1000 + i * 200, seed: shot.seed ?? 9001 + i, from: walk.from, yaw });

      let pl = placed?.pos ?? null;
      // the look round: its whole turn, fixed from the camera's yaw when it starts
      let camYaw = 0, turn: number | null = null;
      const ease = (u: number) => THREE.MathUtils.smootherstep(u, 0, 1);
      const lookAt = (t: number): number[] | undefined => {
        const L0 = shot.look;
        if (!L0 || t < L0.at) return undefined;
        if (turn === null) turn = Math.atan2(Math.sin(placed.sunYaw + L0.offset - camYaw), Math.cos(placed.sunYaw + L0.offset - camYaw));
        const k = ease(Math.min(1, (t - L0.at) / L0.dur)) - ease(Math.min(1, (t - L0.at - 1 / FPS) / L0.dur));
        return [turn * k, -L0.pitch * k];
      };
      // (the spring starts at rest on him)
      fol.step(pl, 0);
      const st = { seg: 0 };
      let snap: number | undefined = yaw;
      // (the jump is held for 4 frames, a key press)
      let jumpFrames = walk.jumpAt ? -1 : 0;
      const frame = async (t: number, warm = false, single = warm) => {
        // (a gameplay beat walks through its warm-up, so it opens on him already under way)
        const go = pl && (shot.follow || (!warm && t >= walk.startAt));
        const heading = go ? steer(walk, { x: pl![0], z: pl![2] }, st) : null;
        if (walk.jumpAt && jumpFrames < 0 && pl && Math.hypot(pl[0] - walk.jumpAt[0], pl[2] - walk.jumpAt[1]) < 0.5) jumpFrames = 4;
        const jump = jumpFrames > 0;
        if (jump) jumpFrames--;
        if (!warm) fol.step(pl, 1 / FPS);
        const r = await L.page.evaluate((o) => (window as unknown as { __island: Api }).__island.shotFrame(o), { cam: pose(t), snap, pitch: snap !== undefined ? shot.pitch : undefined, walk: heading, mode: walk.mode, jump, look: warm ? undefined : lookAt(t), accum: single ? 1 : undefined, dt: 1 / FPS });
        camYaw = r.camYaw;
        snap = undefined;
        pl = r.player?.pos ?? pl;
        return r;
      };
      for (let k = 0; k < WARMUP; k++) await frame(0, true);

      if (preview) {
        const at = a.has('at') ? Number(a.get('at', '0')) : shot.previewAt;
        const n = Math.round(at * FPS);
        for (let f = 0; f < n; f++) await frame(f / FPS, false, f < n - 1);
        const path = join(PREVIEW_DIR, `gp_${i + 1}_${shot.name}.png`);
        writeFileSync(path, await capture());
        console.log(`${shot.name}: ${path} (t = ${at} s, player ${pl?.map((v) => v.toFixed(1)).join(' ')})`);
        continue;
      }
      const dir = shotDir(i);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const total = framesOf(i);
      const steps: { f: number; surface: string; pos: number[]; cam: number[] }[] = [];
      const writes: Promise<void>[] = [];
      let pending = 0;
      const tStart = Date.now();
      for (let f = 0; f < total; f++) {
        const r = await frame(f / FPS);
        if (r.pending) pending++;
        for (const s of r.steps) steps.push({ f, surface: s.surface, pos: s.pos, cam: r.cam });
        writes.push(writeFile(join(dir, `f_${String(f).padStart(5, '0')}.png`), await capture()));
        if (writes.length >= 12) await writes.shift();
        if (f % 120 === 0) process.stdout.write(`\r${shot.name} ${f}/${total}`);
      }
      await Promise.all(writes);
      const ms = (Date.now() - tStart) / total;
      writeFileSync(join(dir, 'shot.json'), JSON.stringify({ name: shot.name, frames: total, msPerFrame: +ms.toFixed(1), framesWithPendingPipelines: pending, end: pl, steps }, null, 1));
      console.log(`\r${shot.name}: ${total} frames in ${((ms * total) / 1000).toFixed(0)} s (${ms.toFixed(0)} ms/frame)${pending ? `, ${pending} frames with pipelines still compiling` : ''}`);
    }
  } finally {
    await L.browser.close();
    server.stop();
  }
  if (L.console.some((l) => l.startsWith('[pageerror]'))) console.warn(L.console.filter((l) => l.startsWith('[pageerror]')).join('\n'));
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
 * The sound: per beat a soft bed of the game's waves, wind and birds (each loop levelled to -20 LUFS, high-passed
 * at HP, then the beat's dB), overlapping each cut by XF with short fades so the beds crossfade on the cut; his
 * footsteps at the frames the game stepped, quieter with his distance from the camera; the whole mix through MASTER
 * (high-pass, gentle compression, a limiter) and normalised to LUFS integrated with a narrow loudness range (two-pass
 * loudnorm), cut with the picture at the end (an XF fade, against a click), then silence over the black tail.
 */
function mixAudio(wav: string, tail: number) {
  const inputs: string[] = [];
  const chains: string[] = [];
  const labels: string[] = [];
  const level = new Map<string, number>();
  const gainFor = (file: string) => {
    if (!level.has(file)) level.set(file, lufs(join(AUDIO_DIR, `${file}.ogg`)));
    return -20 - level.get(file)!;
  };
  const last = used[used.length - 1];
  used.forEach((i) => {
    const s = SHOTS[i];
    const a0 = Math.max(0, START[i] - XF / 2), a1 = Math.min(LEN, START[i] + s.dur + XF / 2);
    const len = a1 - a0;
    const fin = i === 0 ? 0.3 : XF, fout = i === last ? 0 : XF;
    s.layers.forEach((l, k) => {
      const n = inputs.length / 6;
      // (a different start into each loop, so a file used in two beats does not repeat itself)
      inputs.push('-stream_loop', '-1', '-ss', String(3 + i * 7 + k * 2), '-i', join(AUDIO_DIR, `${l.file}.ogg`));
      const f = [`[${n}:a]aresample=48000`, 'aformat=channel_layouts=stereo', `atrim=0:${len.toFixed(4)}`, 'asetpts=PTS-STARTPTS', `highpass=f=${HP}:poles=2`, l.filter, `volume=${(gainFor(l.file) + l.db).toFixed(2)}dB`,
        `afade=t=in:st=0:d=${fin}`, fout ? `afade=t=out:st=${(len - fout).toFixed(4)}:d=${fout}` : null, `adelay=${Math.round(a0 * 1000)}:all=1`].filter(Boolean);
      chains.push(`${f.join(',')}[b${i}_${k}]`);
      labels.push(`[b${i}_${k}]`);
    });
  });
  // footsteps
  const steps: { t: number; file: string; gain: number }[] = [];
  used.forEach((i) => {
    const p = join(shotDir(i), 'shot.json');
    if (!existsSync(p)) return;
    const j = JSON.parse(readFileSync(p, 'utf8')) as { steps: { f: number; surface: string; pos: number[]; cam: number[] }[] };
    j.steps.forEach((e, k) => {
      const t = START[i] + e.f / FPS;
      if (t > Math.min(LEN, START[i] + SHOTS[i].dur) - 0.02) return;
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
    chains.push(`[${n}:a]aresample=48000,aformat=channel_layouts=stereo,highpass=f=120:poles=2,volume=${(gainFor(file) - 2).toFixed(2)}dB,asplit=${uses.length}${uses.map((_, k) => `[s_${file}_${k}]`).join('')}`);
    uses.forEach((u, k) => {
      chains.push(`[s_${file}_${k}]volume=${u.gain.toFixed(2)}dB,adelay=${Math.round(u.t * 1000)}:all=1[t_${file}_${k}]`);
      labels.push(`[t_${file}_${k}]`);
    });
  });
  const graph = `${chains.join(';')};${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest,atrim=0:${LEN},asetpts=PTS-STARTPTS[mix]`;
  const raw = wav.replace(/\.wav$/, '.raw.wav');
  ff([...inputs, '-filter_complex', graph, '-map', '[mix]', '-c:a', 'pcm_s24le', raw], 'audio mix');
  const m = spawnSync('ffmpeg', ['-hide_banner', '-i', raw, '-af', `${MASTER},loudnorm=I=${LUFS}:TP=-3:LRA=7:print_format=json`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const js = JSON.parse(m.slice(m.lastIndexOf('{'), m.lastIndexOf('}') + 1)) as Record<string, string>;
  const ln = `${MASTER},loudnorm=I=${LUFS}:TP=-3:LRA=7:measured_I=${js.input_i}:measured_TP=${js.input_tp}:measured_LRA=${js.input_lra}:measured_thresh=${js.input_thresh}:offset=${js.target_offset}:linear=true`;
  ff(['-i', raw, '-af', `${ln},aresample=48000,atrim=0:${LEN},afade=t=out:st=${(LEN - XF).toFixed(4)}:d=${XF}${tail ? `,apad=pad_dur=${tail}` : ''}`, '-c:a', 'pcm_s24le', wav], 'loudnorm');
  rmSync(raw, { force: true });
  console.log(`audio: ${steps.length} footsteps, ${labels.length - steps.length} ambience layers -> ${wav}`);
}

/** picture: the beats' frames on straight cuts, then the black tail; plus the sound */
function encode(wav: string, out: string, tail: number) {
  const inputs: string[] = [];
  const parts: string[] = [];
  used.forEach((i, k) => {
    const n = readdirSync(shotDir(i)).filter((f) => f.endsWith('.png')).length;
    if (n !== framesOf(i)) throw new Error(`${SHOTS[i].name}: ${n} frames on disk, want ${framesOf(i)}`);
    inputs.push('-framerate', String(FPS), '-start_number', '0', '-i', join(shotDir(i), 'f_%05d.png'));
    parts.push(`[${k}:v]settb=1/${FPS},setpts=N,format=yuv444p[v${k}]`);
  });
  parts.push(`${used.map((_, k) => `[v${k}]`).join('')}concat=n=${used.length}:v=1:a=0,settb=1/${FPS},setpts=N${tail ? `,tpad=stop_mode=add:stop_duration=${tail}:color=black` : ''},format=yuv420p[vout]`);
  ff([...inputs, '-i', wav, '-filter_complex', parts.join(';'), '-map', '[vout]', '-map', `${used.length}:a`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-g', '120',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-shortest', out], 'encode');
  console.log(`video: ${(LEN + tail).toFixed(3)} s -> ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
}

/** about 12 frames of the edit, evenly spaced, on one sheet next to it */
function contactSheet(video: string) {
  const sheet = video.replace(/\.mp4$/, '_contact.jpg');
  ff(['-i', video, '-vf', `fps=12/${LEN.toFixed(3)},scale=480:-1,tile=4x3`, '-frames:v', '1', '-q:v', '3', sheet], 'contact sheet');
  console.log(`contact sheet: ${sheet}`);
}

const tail = seconds ? 0 : TAIL;
const out = seconds ? join(PREVIEW_DIR, `gameplay_edit_v2_first${seconds}s.mp4`) : OUT;
mkdirSync(FRAMES, { recursive: true });
if (a.has('audio-only')) {
  mixAudio(join(FRAMES, 'gameplay.wav'), tail);
  process.exit(0);
}
if (!encodeOnly) await render();
if (!preview) {
  mkdirSync(PREVIEW_DIR, { recursive: true });
  const wav = join(FRAMES, 'gameplay.wav');
  mixAudio(wav, tail);
  encode(wav, out, tail);
  contactSheet(out);
  // (the PNG sequences go; each beat's shot.json with its footsteps and timing stays)
  if (!a.has('keep')) for (const i of used) for (const f of readdirSync(shotDir(i))) if (f.endsWith('.png')) rmSync(join(shotDir(i), f));
}
