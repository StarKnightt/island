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
  /** a camera path through keys (position and aim on their own curves) ... */
  keys?: Key[];
  /** ... or a rig around the character: a pose from the shot's eased progress and his spring-followed position */
  rig?: (p: { x: number; u: number; s: number; subj: THREE.Vector3; dir: THREE.Vector3 }) => { pos: THREE.Vector3; target: THREE.Vector3; fov: number };
  /** the speed ramp: 0 = constant speed, 1 = a full cubic ease-in/out (a near hold, a fast middle, a settle) */
  ease: number;
  /** aim partly at the character: target = mix(path target, his spring-followed position + height, weight) */
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
    // low over the wet sand at sunrise, the sea and the sun ahead, waves rolling in; he walks in from the left while
    // the camera pushes in toward the sun (3.6 m of dolly and a zoom from 52 to 44 degrees on one ramp)
    name: 'beach', tod: 6.55, spot: 'beach', dur: 6, xin: 0, ease: 0.75, previewAt: 4,
    keys: [
      { pos: [611.5, 1.0, 76], target: [642.6, 3, 48.8], fov: 52 },
      { pos: [613.2, 1.25, 72.8], target: [643, 3.6, 49.5], fov: 44 },
    ],
    track: { weight: 0.1, height: 1 },
    walk: { from: [611.1, 69.1], path: [[614, 67], [617.5, 64.5], [620, 62.5]], startAt: -0.3 },
    layers: [{ file: 'amb_waves', db: 0 }, { file: 'amb_surf', db: -4 }, { file: 'amb_birds', db: -9 }],
  },
  {
    // noon in the rainforest: he walks away from us down the sun-flecked trail; the camera holds, picks him up and
    // tracks 7 m along the trail behind him while it zooms in from 56 to 47 degrees, the aim on his spring
    name: 'jungle', tod: 12.8, spot: 'jungle', dur: 6, xin: 0.8, ease: 0.8, previewAt: 3, exposure: 1.6,
    keys: [
      { pos: [355.6, 1.9, -66.0], target: [325, 2.6, -57.5], fov: 56, ground: true },
      { pos: [348.6, 2.1, -64.3], target: [316, 2.6, -55], fov: 47, ground: true },
    ],
    track: { weight: 0.3, height: 1 },
    walk: { from: [350.5, -63.8], path: [[343, -62], [335, -60], [327, -58], [319, -56]], startAt: -0.4 },
    layers: [{ file: 'amb_jungle', db: -6 }, { file: 'amb_birds', db: -12 }, { file: 'amb_wind', db: -20 }],
  },
  {
    // sunset in the village, on the rhythm measured from the ocean-drive trailer (its opening dive and the runner
    // tracking shot, 10 fps optical flow): a dive that accelerates to a peak at 1.3 s (13 m off and 7.5 m up down to
    // 4.4 m and 1.35 m), a near hold, then a re-accelerating 90-degree orbit round behind him toward the sun and the
    // jetty, closing to 3.8 m and zooming from 52 to 45 degrees, still moving at 40 % speed into the next shot.
    // He stays backlit, so his face never reads; the hillside's round crowns stay behind the camera
    name: 'village', tod: 17.42, spot: 'village', dur: 10, xin: 0.8, ease: 0, previewAt: 6,
    rig: ({ x, subj, dir }) => {
      const { lerp, smootherstep, degToRad } = THREE.MathUtils;
      const t = x * 10;
      const dive = smootherstep(t, 0, 2.6);
      // the orbit's speed: up to full over its first 18 %, then easing to 40 % at the end (integrated, normalized)
      const ramp = (q: number) => (q < 0.18 ? (q * q / 2 - 0.2 * q * q * q) / 0.18 : (0.0162 - 0.2 * 0.005832) / 0.18 + (q - 0.3 * q * q) - (0.18 - 0.3 * 0.0324));
      const orbit = t < 3.1 ? 0 : ramp(Math.min(1, (t - 3.1) / 6.9)) / ramp(1);
      const phi = degToRad(lerp(lerp(80, 60, dive), -30, orbit));
      const r = lerp(lerp(13, 4.4, dive), 3.8, orbit);
      const y = lerp(lerp(7.5, 1.35, dive), 1.25, orbit);
      const pos = subj.clone().add(new THREE.Vector3(Math.cos(phi) * r, y, Math.sin(phi) * r));
      // (lead room ahead of him; aimed a little above his head so the sky and the treeline keep the upper half)
      const target = subj.clone().add(new THREE.Vector3(0, lerp(2.2, 1.5, dive), 0)).addScaledVector(dir, lerp(3.0, 1.8, orbit));
      return { pos, target, fov: lerp(52, 45, orbit) };
    },
    walk: { from: [-412, 337.5], path: [[-418, 338.3], [-424, 339.2], [-430, 340]], startAt: -0.4 },
    layers: [
      { file: 'amb_waves', db: -3 }, { file: 'amb_chimes', db: -6 }, { file: 'amb_chickens', db: -13 },
      { file: 'amb_wind', db: -11 }, { file: 'amb_surf', db: -12 },
    ],
  },
  {
    // a drone rising off the end of the main jetty from 3 to 22 m, back and up on one curve, widening from 46 to 56
    // degrees: the moored canoes riding the swell, then the village beyond
    name: 'jetty', tod: 17.42, spot: 'village', dur: 6, xin: 0, ease: 0.85, previewAt: 3,
    keys: [
      { pos: [-436, 3.0, 396], target: [-456, 1.2, 368], fov: 46 },
      { pos: [-430, 10, 404], target: [-457, 1, 362], fov: 50 },
      { pos: [-421, 22, 413], target: [-458, 0, 352], fov: 56 },
    ],
    layers: [{ file: 'amb_waves', db: -6 }, { file: 'amb_creak', db: -11 }, { file: 'amb_gulls', db: -10, filter: 'highpass=f=250' }, { file: 'amb_wind', db: -16 }],
  },
  {
    // a pull-back reveal: tight on the gallery and the lantern at the left edge, the camera backs away and up from
    // 7 to 18 m off the tower while the lens widens from 40 to 52 degrees, opening onto the island and the sun on
    // the western sea (the tower keeps its place in the frame and shrinks)
    name: 'lighthouse', tod: 17.42, spot: 'lighthouse', dur: 7, xin: 0.8, ease: 0.85, previewAt: 6,
    keys: [
      { pos: lh(7, 4.4, GALLERY + 3), target: lhAim(lh(7, 4.4, GALLERY + 3), 700, GALLERY - 110), fov: 40 },
      { pos: lh(12, 7.5, GALLERY + 5), target: lhAim(lh(12, 7.5, GALLERY + 5), 700, GALLERY - 116), fov: 46 },
      { pos: lh(18, 11.25, GALLERY + 7), target: lhAim(lh(18, 11.25, GALLERY + 7), 700, GALLERY - 120), fov: 52 },
    ],
    layers: [{ file: 'amb_wind', db: 5 }, { file: 'amb_surf', db: -6, filter: 'lowpass=f=700' }, { file: 'amb_birds', db: -20 }],
  },
  {
    // the whole island in the golden hour from the sea: a slow zoom out from 32 to 44 degrees with a little drift
    // back, settling into a hold as the picture fades to black
    name: 'final', tod: 17.3, spot: 'village', dur: 5, xin: 0.8, ease: 0.7, previewAt: 2,
    keys: [
      { pos: [-995, 109, 615], target: [-150, 40, -80], fov: 32 },
      { pos: [-1015, 113, 635], target: [-150, 41, -80], fov: 44 },
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

// the speed ramps: a cubic ease-in/out for the camera's travel (it nearly holds, runs through the middle and settles),
// a softer smoothstep for its aim, so the view turns a little ahead of the move and lands with it
const cubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const smooth = (x: number) => x * x * (3 - 2 * x);
const ramp = (x: number, k: number) => (1 - k) * x + k * cubic(x);
const aimRamp = (x: number, k: number) => (1 - k) * x + k * smooth(x);

/** a shot's camera as a function of shot time and the followed subject: arc-length Catmull-Rom paths through the
 *  keys (or the shot's rig), travelled on the speed ramp */
function cameraPath(shot: Shot, keys: Key[], i: number) {
  const { pre, post } = span(i);
  const t0 = -pre / FPS, t1 = shot.dur + post / FPS;
  const curve = (pts: V3[]) => (pts.length === 2 ? new THREE.LineCurve3(new THREE.Vector3(...pts[0]), new THREE.Vector3(...pts[1])) : new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)), false, 'centripetal'));
  const pos = keys.length ? curve(keys.map((k) => k.pos)) : null;
  const tgt = keys.length ? curve(keys.map((k) => k.target)) : null;
  const fovs = keys.map((k) => k.fov ?? 55);
  return (t: number, subj: THREE.Vector3, dir: THREE.Vector3) => {
    const x = THREE.MathUtils.clamp((t - t0) / (t1 - t0), 0, 1);
    const u = ramp(x, shot.ease), s = aimRamp(x, shot.ease);
    if (shot.rig) return shot.rig({ x, u, s, subj, dir });
    const f = u * (fovs.length - 1), j = Math.min(fovs.length - 2, Math.floor(f));
    const target = tgt!.getPointAt(s);
    if (shot.track) target.lerp(subj.clone().setY(subj.y + shot.track.height), shot.track.weight);
    return { pos: pos!.getPointAt(u), target, fov: THREE.MathUtils.lerp(fovs[j], fovs[j + 1], f - j) };
  };
}

/** the character as the camera sees him: a critically damped spring on his position (no overshoot, no step bob)
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
      }, shot.keys ?? []) as Key[];
      const cam = cameraPath(shot, keys, i);
      const fol = follower(2.2);
      if (shot.walk) {
        fol.p.set(shot.walk.from[0], 0, shot.walk.from[1]);
        fol.dir.set(shot.walk.path[0][0] - shot.walk.from[0], 0, shot.walk.path[0][1] - shot.walk.from[1]).normalize();
      }
      const pose = (t: number) => {
        const c = cam(t, fol.p, fol.dir);
        return { pos: c.pos.toArray().map((v) => +v.toFixed(4)), target: c.target.toArray().map((v) => +v.toFixed(4)), fov: +c.fov.toFixed(3) };
      };
      const t0 = -pre / FPS;
      const startYaw = shot.walk ? Math.atan2(shot.walk.path[0][0] - shot.walk.from[0], -(shot.walk.path[0][1] - shot.walk.from[1])) : 0;
      const placed = await L.page.evaluate(async (o) => {
        const api = (window as unknown as { __island: Api }).__island;
        api.manual(false);
        await api.stage({ spot: o.spot, tod: o.tod, weather: 'clear', camera: o.cam, worldTime: null, settleMs: 600 });
        api.manual(true);
        api.shotStart(1000 + o.i * 200, 9001 + o.i, o.exposure);
        // (a shot without him parks him in the rainforest, out of every other frame)
        return (o.walk ? api.placePlayer(o.walk.from[0], o.walk.from[1], o.yaw) : api.placePlayer(365, 18, 0)) as { pos: number[] } | null;
      }, { spot: shot.spot, tod: shot.tod, cam: pose(t0), i, walk: shot.walk ?? null, yaw: startYaw, exposure: shot.exposure ?? 1 });

      let pl = (shot.walk && placed?.pos) || null;
      // (the spring starts at rest on him)
      fol.step(pl, 0);
      const st = { seg: 0 };
      let lastCam = pose(t0);
      const frame = async (t: number, warm = false) => {
        let walk: number | null = null;
        if (!warm && shot.walk && t >= shot.walk.startAt && pl) walk = steer(shot.walk, { x: pl[0], z: pl[2] }, st);
        if (!warm) fol.step(pl, 1 / FPS);
        lastCam = pose(t);
        const r = await L.page.evaluate((o) => (window as unknown as { __island: Api }).__island.shotFrame(o), { cam: lastCam, walk, dt: 1 / FPS });
        if (shot.walk) pl = r.player?.pos ?? pl;
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
        for (const s of r.steps) steps.push({ f, surface: s.surface, pos: s.pos, cam: lastCam.pos });
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
