/**
 * Shared browser launcher for the harness scripts: the installed Chrome, headed, on the high-performance GPU, with its
 * own temporary profile, on one monitor chosen from the layout Windows reports at launch: the one named in
 * ~/.island-display (primary, secondary or a device name such as DISPLAY2), else in ISLAND_DISPLAY (the same, or a
 * 1-based index in Windows' order), else the primary. `headless` (in either) opens no window at all: Chrome's headless
 * mode on the same GPU, the page a real 1920x1080 viewport.
 * When that display is exactly the requested viewport (1920x1080), the window goes borderless fullscreen on it and the
 * page renders a real 1920x1080 viewport; on any other display size the window fits the work area and the viewport is
 * emulated at 1920x1080. Pointer lock is stubbed so a test window can never capture the real mouse.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createServer as createNetServer } from 'node:net';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');
export const DEV_PORT = Number(process.env.ISLAND_DEV_PORT) || 5230;
export const PREVIEW_PORT = Number(process.env.ISLAND_PREVIEW_PORT) || 5231;

export interface Rect { x: number; y: number; width: number; height: number }
export interface Display extends Rect { name: string; primary: boolean; work: Rect; headless?: boolean }
export interface Launch {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  console: string[];
  display: Display;
  /** 'fullscreen': a real viewport the size of the display; 'emulated': a device-metrics viewport in a normal window;
   *  'headless': no window, the page is the viewport */
  viewportMode: 'fullscreen' | 'emulated' | 'headless';
}

let layout: Display[] | null = null;

/** the monitors as Windows reports them (physical pixels); a single 1920x1080 primary if the query fails */
export function displays(): Display[] {
  if (layout) return layout;
  const ps = [
    `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' -Name U -Namespace W`,
    '[void][W.U]::SetProcessDPIAware()',
    'Add-Type -AssemblyName System.Windows.Forms',
    '@([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { @{ name = $_.DeviceName; primary = $_.Primary; ' +
      'x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height; ' +
      'work = @{ x = $_.WorkingArea.X; y = $_.WorkingArea.Y; width = $_.WorkingArea.Width; height = $_.WorkingArea.Height } } }) | ConvertTo-Json -Compress -Depth 3',
  ].join('; ');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const parsed = JSON.parse(out.trim()) as Display | Display[];
    const list = (Array.isArray(parsed) ? parsed : [parsed]).map((d) => ({ ...d, name: String(d.name).replace(/^\\\\\.\\/, '') }));
    if (list.length) return (layout = list);
  } catch (e) {
    console.warn(`[browser] monitor query failed (${(e as Error).message.split('\n')[0]}); assuming one 1920x1080 display`);
  }
  const fallback: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
  return (layout = [{ name: 'DISPLAY1', primary: true, ...fallback, work: { ...fallback, height: 1040 } }]);
}

/** the virtual display of a headless run: no window anywhere, a 1920x1080 page on the same GPU */
const HEADLESS: Display = { name: 'headless', primary: false, x: 0, y: 0, width: 1920, height: 1080, work: { x: 0, y: 0, width: 1920, height: 1080 }, headless: true };

/** the display the test browser opens on (see the header) */
export function targetDisplay(): Display {
  // (ISLAND_DISPLAY_FORCE=secondary is a one-command exception to the user's file, for a headed check on the second
  // screen; it never falls back to the primary)
  const force = (process.env.ISLAND_DISPLAY_FORCE ?? '').trim().toLowerCase();
  if (force) {
    if (force !== 'secondary') throw new Error('ISLAND_DISPLAY_FORCE only accepts "secondary"');
    const second = displays().find((d) => !d.primary);
    if (!second) throw new Error('ISLAND_DISPLAY_FORCE=secondary: no secondary display connected');
    return second;
  }
  const want = (displayOverride() ?? process.env.ISLAND_DISPLAY ?? '').trim().toLowerCase();
  if (want === 'headless') return HEADLESS;
  const list = displays();
  const primary = list.find((d) => d.primary) ?? list[0];
  if (!want || want === 'primary') return primary;
  if (want === 'secondary') return list.find((d) => !d.primary) ?? primary;
  const byName = list.find((d) => d.name.toLowerCase() === want || d.name.toLowerCase() === `display${want}`);
  const byIndex = /^\d+$/.test(want) ? list[Number(want) - 1] : undefined;
  const d = byName ?? byIndex;
  if (!d) console.warn(`[browser] display "${want}" not found (have ${list.map((x) => x.name).join(', ')}); using the primary`);
  return d ?? primary;
}

/** the user's machine-wide choice in ~/.island-display; it beats ISLAND_DISPLAY so one edit moves every test window */
function displayOverride(): string | undefined {
  try {
    return readFileSync(join(homedir(), '.island-display'), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Chrome flags: placed on the target display, the high-performance GPU, never throttled in the background */
export function chromeArgs(opts: { uncapped?: boolean; audio?: boolean; display?: Display } = {}) {
  const d = opts.display ?? targetDisplay();
  const args = [
    ...(d.headless ? [] : [`--window-position=${d.work.x},${d.work.y}`, `--window-size=${Math.min(d.work.width, 1920)},${Math.min(d.work.height, 1080)}`]),
    // CSS pixels = physical pixels whatever the Windows display scaling (DISPLAY1 runs at ~120 %), so a fullscreen
    // window on a 1920x1080 display is a 1920x1080 viewport at devicePixelRatio 1
    '--force-device-scale-factor=1',
    '--force_high_performance_gpu',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
  ];
  if (!opts.audio) args.push('--mute-audio');
  if (opts.uncapped) args.push('--disable-gpu-vsync', '--disable-frame-rate-limit');
  return args;
}

/** true when the display is exactly the viewport, so a borderless fullscreen window gives the real thing */
export function fitsExactly(d: Display, width: number, height: number) {
  return d.width === width && d.height === height;
}

/**
 * Put the page's window on the display: borderless fullscreen when the display is the viewport size (real viewport),
 * else a normal window filling the work area with the viewport emulated. Returns the mode that took effect.
 */
export async function placeWindow(page: Page, d: Display, width: number, height: number, fullscreen = fitsExactly(d, width, height)): Promise<Launch['viewportMode']> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number };
    const set = (bounds: Record<string, unknown>) => cdp.send('Browser.setWindowBounds', { windowId, bounds });
    await set({ windowState: 'normal' });
    await set({ left: d.work.x, top: d.work.y, width: Math.min(d.work.width, 1920), height: Math.min(d.work.height, 1080) });
    if (fullscreen) {
      await set({ windowState: 'fullscreen' });
      for (let i = 0; i < 40; i++) {
        const [w, h, dpr] = (await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio])) as number[];
        if (w === width && h === height && dpr === 1) return 'fullscreen';
        await page.waitForTimeout(100);
      }
      console.warn('[browser] fullscreen did not give a real viewport; emulating it');
      await set({ windowState: 'normal' });
    }
  } catch (e) {
    console.warn(`[browser] window placement failed (${(e as Error).message.split('\n')[0]}); emulating the viewport`);
  } finally {
    await cdp.detach().catch(() => {});
  }
  await page.setViewportSize({ width, height });
  return 'emulated';
}

export async function stubPointerLock(context: BrowserContext) {
  await context.addInitScript(() => {
    Element.prototype.requestPointerLock = function () {
      return Promise.resolve();
    } as typeof Element.prototype.requestPointerLock;
  });
}

/** the persistent profile of development captures (look, poses, session): Chrome keeps its compiled shaders there */
export const DEV_PROFILE = process.env.ISLAND_DEV_PROFILE || 'E:\\tmp\\island\\chrome-dev';

/** Playwright launch options for a display: headed and placed, or headless with the page as a 1920x1080 viewport */
export function launchOptions(display: Display, opts: { width?: number; height?: number; dsf?: number; uncapped?: boolean; audio?: boolean } = {}) {
  const width = opts.width ?? 1920, height = opts.height ?? 1080;
  const headless = !!display.headless;
  // a real viewport cannot carry a device scale factor: any other than 1 means emulation
  const real = !headless && fitsExactly(display, width, height) && (opts.dsf ?? 1) === 1;
  const view = real ? { viewport: null } : { viewport: { width, height }, deviceScaleFactor: opts.dsf ?? 1 };
  return { headless, real, view, args: chromeArgs({ ...opts, display }) };
}

export async function launch(opts: { width?: number; height?: number; dsf?: number; uncapped?: boolean; audio?: boolean; profile?: string } = {}): Promise<Launch> {
  const width = opts.width ?? 1920, height = opts.height ?? 1080;
  const display = targetDisplay();
  const { headless, real, view, args } = launchOptions(display, opts);
  let browser: Browser, context: BrowserContext;
  let persistent: BrowserContext | null = null;
  if (opts.profile) {
    // a persistent profile keeps Chrome's GPU shader cache between runs (a returning visit loads in seconds); a
    // profile left locked by a crashed run falls back to a temporary one
    try {
      mkdirSync(opts.profile, { recursive: true });
      persistent = await chromium.launchPersistentContext(opts.profile, { channel: 'chrome', headless, args, ...view });
    } catch (e) {
      console.warn(`[browser] profile ${opts.profile} unusable (${(e as Error).message.split('\n')[0]}); using a temporary one`);
    }
  }
  if (persistent) {
    context = persistent;
    browser = { close: () => persistent!.close() } as unknown as Browser;
  } else {
    browser = await chromium.launch({ channel: 'chrome', headless, args });
    context = await browser.newContext(view);
  }
  await stubPointerLock(context);
  const page = context.pages()[0] ?? (await context.newPage());
  const viewportMode = headless ? 'headless' : await placeWindow(page, display, width, height, real);
  console.log(`[browser] ${display.name} ${display.width}x${display.height} at (${display.x},${display.y}): ${viewportMode} ${width}x${height} viewport`);
  const consoleLines: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('[island]') || m.text().startsWith('vegetation')) consoleLines.push(`[${m.type()}] ${m.text()}`.slice(0, 600));
  });
  page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));
  return { browser, context, page, console: consoleLines, display, viewportMode };
}

function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createNetServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, '127.0.0.1');
  });
}

/** the capture conditions shared by `pnpm shots` and `pnpm perf`: a time of day plus weather */
export const CONDITIONS: Record<string, { tod: string; weather: 'clear' | 'rain' }> = {
  sunrise: { tod: 'sunrise', weather: 'clear' },
  morning: { tod: 'morning', weather: 'clear' },
  noon: { tod: 'noon', weather: 'clear' },
  afternoon: { tod: 'afternoon', weather: 'clear' },
  sunset: { tod: 'sunset', weather: 'clear' },
  dusk: { tod: 'dusk', weather: 'clear' },
  night: { tod: 'night', weather: 'clear' },
  rain: { tod: '14.5', weather: 'rain' },
};

/** throw on a condition name the table doesn't have, before any browser starts */
export function checkConditions(names: string[]) {
  const bad = names.filter((n) => !CONDITIONS[n]);
  if (bad.length) throw new Error(`unknown condition ${bad.join(', ')}; use ${Object.keys(CONDITIONS).join(', ')}`);
}

/** make sure a server is answering: reuse one on the port, else start `pnpm dev|preview` and stop it afterwards */
export async function ensureServer(kind: 'dev' | 'preview'): Promise<{ url: string; stop: () => void }> {
  const port = kind === 'dev' ? DEV_PORT : PREVIEW_PORT;
  const url = `http://127.0.0.1:${port}/`;
  try {
    const r = await fetch(url);
    if (r.ok) return { url, stop: () => {} };
  } catch {
    // not running
  }
  if (!(await portFree(port))) throw new Error(`port ${port} busy but not answering`);
  const child: ChildProcess = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [kind], { cwd: ROOT, stdio: 'ignore', shell: true });
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await fetch(url);
      if (r.ok) break;
    } catch {
      // starting
    }
  }
  return {
    url,
    stop: () => {
      if (child.pid) {
        // synchronous, so the tree (pnpm, then vite) is gone before this process exits
        if (process.platform === 'win32') {
          try {
            execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
          } catch {
            // already gone
          }
        } else child.kill();
      }
    },
  };
}

export function argv() {
  const args = process.argv.slice(2);
  return {
    get: (name: string, def: string) => {
      const i = args.indexOf(`--${name}`);
      return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
    },
    has: (name: string) => args.includes(`--${name}`),
  };
}
