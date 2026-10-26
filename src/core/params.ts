/**
 * URL parameters. Every one is optional; TESTING.md lists them for the test harness.
 *
 *   spot=beach|jungle|waterfall|village|cliffs|lighthouse   start at a named place
 *   tod=sunrise|noon|sunset|night|<hours 0-24>            time of day at start
 *   freeze=1                                              time of day does not advance
 *   weather=clear|rain|auto                               weather at start (auto: rain comes and goes on its own)
 *   daylen=<minutes>                                      length of a full day (default 30)
 *   hud=0  mute=1  debug=1  photo=1                       hide the HUD, mute, debug overlay, photo mode
 *   quality=low|medium|high|ultra                         graphics preset (default: picked from the GPU)
 *   fps=auto|<n>|0                                        frame cap (auto: integer divisor of the refresh rate >= 60; 0 uncapped)
 *   cam=orbit|free|x,y,z,tx,ty,tz                          camera override for captures
 *   webgl=1                                               force the WebGL 2 backend
 *   test=1                                                automated run: no pointer lock, no autoplay prompts
 */
const q = new URLSearchParams(location.search);
const str = (k: string) => q.get(k);
const num = (k: string, def: number) => {
  const v = q.get(k);
  if (v === null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const flag = (k: string) => q.has(k) && q.get(k) !== '0' && q.get(k) !== 'false';

export const TOD_PRESETS: Record<string, number> = { sunrise: 6.55, morning: 8.5, noon: 12.3, afternoon: 15.5, sunset: 17.42, dusk: 18.1, night: 22.5 };

function parseTod(v: string | null): number | null {
  if (v === null) return null;
  if (v in TOD_PRESETS) return TOD_PRESETS[v];
  const n = Number(v);
  return Number.isFinite(n) ? ((n % 24) + 24) % 24 : null;
}

/** trailer capture (`pnpm record`): no HUD, muted, frozen clock, automated, every frame stepped by the recorder */
const capture = flag('capture');

export const params = {
  capture,
  spot: str('spot'),
  tod: parseTod(str('tod')),
  freeze: flag('freeze') || capture,
  weather: (str('weather') ?? (capture ? 'clear' : 'auto')) as 'clear' | 'rain' | 'auto',
  dayMinutes: num('daylen', 30),
  hud: q.get('hud') !== '0' && !capture,
  mute: flag('mute') || capture,
  debug: flag('debug'),
  photo: flag('photo'),
  quality: str('quality'),
  fps: str('fps') ?? 'auto',
  cam: str('cam'),
  webgl: flag('webgl'),
  test: flag('test') || capture,
  noPost: flag('nopost'),
  noAO: flag('noao'),
  noTAA: flag('notaa'),
  /** diagnostics: TRAA's subpixel correction back on (three's default; it lets the per-frame dither through in motion) */
  taaSubpixel: flag('taasub'),
  gpuTiming: flag('gputime') || flag('debug') || flag('test'),
  /** tone mapping for look comparisons: aces (default) | agx | neutral */
  toneMap: str('tm') ?? 'aces',
};
export type Params = typeof params;

// a capture renders the same frames on every run: the few unseeded draws (blinks, sand puffs, wade drops) follow a
// fixed sequence (the world itself is placed by its own seeded generators)
let s = 0x2f6b1d3;
/** restart the capture's random sequence (each trailer shot starts from its own seed) */
export function seedRandom(seed: number) {
  s = seed | 0;
}
if (capture) {
  Math.random = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
