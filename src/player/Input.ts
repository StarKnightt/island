/**
 * Keyboard, mouse (pointer lock) and gamepad, merged into one intent per frame: a move vector relative to the
 * camera, look deltas, and buttons (sprint, jump, crouch, photo mode, free camera).
 */
import { params } from '../core/params';

export interface Intent {
  moveX: number;
  moveY: number;
  lookX: number;
  lookY: number;
  sprint: boolean;
  jump: boolean;
  walk: boolean;
  zoom: number;
  /** free camera vertical (photo mode) */
  up: number;
}

export class Input {
  private keys = new Set<string>();
  private pressed = new Set<string>();
  private mdx = 0;
  private mdy = 0;
  private wheel = 0;
  locked = false;
  /** scripted control (harness `act`): overrides the devices while > 0 */
  scripted: { t: number; intent: Partial<Intent> } | null = null;
  readonly canvas: HTMLCanvasElement;
  sensitivity = 0.0022;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (['Space', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('click', () => {
      if (!params.test && document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mdx += e.movementX;
      this.mdy += e.movementY;
    });
    window.addEventListener('wheel', (e) => {
      this.wheel += Math.sign(e.deltaY);
    }, { passive: true });
  }

  private frameHits = new Set<string>();
  /** a key went down during the last frame (valid after read()) */
  hit(code: string) {
    return this.frameHits.has(code);
  }

  read(dt: number): Intent {
    const k = (c: string) => this.keys.has(c);
    let mx = (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0);
    let my = (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0);
    let lx = this.mdx * this.sensitivity, ly = this.mdy * this.sensitivity;
    let sprint = k('ShiftLeft') || k('ShiftRight');
    let jump = this.pressed.has('Space');
    const walk = k('ControlLeft') || k('KeyC');
    let up = (k('KeyE') ? 1 : 0) - (k('KeyQ') ? 1 : 0);
    // gamepad
    const pads = navigator.getGamepads?.() ?? [];
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
      mx += dz(gp.axes[0] ?? 0);
      my -= dz(gp.axes[1] ?? 0);
      lx += dz(gp.axes[2] ?? 0) * 2.6 * dt;
      ly += dz(gp.axes[3] ?? 0) * 2.0 * dt;
      if (gp.buttons[10]?.pressed || gp.buttons[1]?.pressed) sprint = true;
      if (gp.buttons[0]?.pressed) jump = jump || !this.padJump;
      this.padJump = !!gp.buttons[0]?.pressed;
      up += (gp.buttons[5]?.value ?? 0) - (gp.buttons[4]?.value ?? 0);
    }
    this.mdx = 0;
    this.mdy = 0;
    const zoom = this.wheel;
    this.wheel = 0;
    this.frameHits = new Set(this.pressed);
    this.pressed.clear();
    const len = Math.hypot(mx, my);
    if (len > 1) {
      mx /= len;
      my /= len;
    }
    const intent: Intent = { moveX: mx, moveY: my, lookX: lx, lookY: ly, sprint, jump, walk, zoom, up };
    if (this.scripted) {
      Object.assign(intent, this.scripted.intent);
      this.scripted.t -= dt;
      if (this.scripted.t <= 0) this.scripted = null;
    }
    return intent;
  }
  private padJump = false;
}
