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

export const TOD_PRESETS: Record<string, number> = { sunrise: 6.15, morning: 8.5, noon: 12.5, afternoon: 15.5, sunset: 17.85, dusk: 18.4, night: 22.5 };

function parseTod(v: string | null): number | null {
  if (v === null) return null;
  if (v in TOD_PRESETS) return TOD_PRESETS[v];
  const n = Number(v);
  return Number.isFinite(n) ? ((n % 24) + 24) % 24 : null;
}

export const params = {
  spot: str('spot'),
  tod: parseTod(str('tod')),
  freeze: flag('freeze'),
  weather: (str('weather') ?? 'auto') as 'clear' | 'rain' | 'auto',
  dayMinutes: num('daylen', 30),
  hud: q.get('hud') !== '0',
  mute: flag('mute'),
  debug: flag('debug'),
  photo: flag('photo'),
  quality: str('quality'),
  fps: str('fps') ?? 'auto',
  cam: str('cam'),
  webgl: flag('webgl'),
  test: flag('test'),
  noPost: flag('nopost'),
  noAO: flag('noao'),
  noTAA: flag('notaa'),
  gpuTiming: flag('gputime') || flag('debug') || flag('test'),
};
export type Params = typeof params;
