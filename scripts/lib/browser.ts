/**
 * Shared browser launcher for the harness scripts: the installed Chrome, headed, on the second (portrait) monitor at
 * x >= 1930, on the RTX (high-performance GPU), with its own temporary profile. The page renders a true 1920x1080
 * viewport through emulation even though the window is narrower (the portrait screen is 1080 wide).
 * Pointer lock is stubbed so a test window can never capture the real mouse.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createServer as createNetServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');
export const DEV_PORT = 5230;
export const PREVIEW_PORT = 5231;

export interface Launch { browser: Browser; context: BrowserContext; page: Page; console: string[] }

export async function launch(opts: { width?: number; height?: number; dsf?: number; uncapped?: boolean; audio?: boolean } = {}): Promise<Launch> {
  const width = opts.width ?? 1920, height = opts.height ?? 1080;
  const args = [
    '--window-position=1930,20',
    '--window-size=1060,900',
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
  const browser = await chromium.launch({ channel: 'chrome', headless: false, args });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: opts.dsf ?? 1 });
  await context.addInitScript(() => {
    Element.prototype.requestPointerLock = function () {
      return Promise.resolve();
    } as typeof Element.prototype.requestPointerLock;
  });
  const page = await context.newPage();
  const consoleLines: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') consoleLines.push(`[${m.type()}] ${m.text()}`.slice(0, 600));
  });
  page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));
  return { browser, context, page, console: consoleLines };
}

function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createNetServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, '127.0.0.1');
  });
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
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else child.kill();
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
