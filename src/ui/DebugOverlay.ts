/**
 * Debug overlay (?debug=1, or F3 to toggle): the GPU adapter and backend, preset and frame cap, frame / CPU / GPU
 * times over the last 600 frames, draw calls and triangles, the player's position and footing, time and weather.
 */
export interface DebugInfo {
  adapter: string;
  backend: string;
  preset: string;
  stats: () => {
    fps: number; targetFps: number; refreshHz: number; drawCalls: number; triangles: number;
    frame: { avg: number; p95: number; p99: number }; cpu: { avg: number }; gpu: { avg: number; p95: number; n: number };
  };
  extra: () => Record<string, string | number>;
}

export class DebugOverlay {
  private el: HTMLPreElement;
  private t = 0;
  visible: boolean;

  constructor(private info: DebugInfo, visible: boolean) {
    this.el = document.createElement('pre');
    Object.assign(this.el.style, {
      position: 'fixed', left: '10px', top: '10px', margin: '0', padding: '8px 10px', zIndex: '30', pointerEvents: 'none',
      font: '11px/1.45 ui-monospace, Consolas, monospace', color: '#e8f3e8', background: 'rgba(8, 14, 12, 0.62)',
      borderRadius: '4px', whiteSpace: 'pre',
    } as CSSStyleDeclaration);
    document.body.appendChild(this.el);
    this.visible = visible;
    this.el.style.display = visible ? 'block' : 'none';
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        e.preventDefault();
        this.show(!this.visible);
      }
    });
  }

  show(v: boolean) {
    this.visible = v;
    this.el.style.display = v ? 'block' : 'none';
  }

  update(dt: number) {
    if (!this.visible) return;
    this.t -= dt;
    if (this.t > 0) return;
    this.t = 0.25;
    const s = this.info.stats();
    const cap = Number.isFinite(s.targetFps) ? `${s.targetFps.toFixed(1)} (${s.refreshHz} Hz)` : `uncapped (${s.refreshHz} Hz)`;
    const lines = [
      `${this.info.adapter}`,
      `${this.info.backend} · ${this.info.preset} · cap ${cap}`,
      `fps ${s.fps.toFixed(1)}  frame ${s.frame.avg.toFixed(2)} / p95 ${s.frame.p95.toFixed(2)} / p99 ${s.frame.p99.toFixed(2)} ms`,
      `cpu ${s.cpu.avg.toFixed(2)} ms  gpu ${s.gpu.n ? `${s.gpu.avg.toFixed(2)} / p95 ${s.gpu.p95.toFixed(2)} ms` : 'n/a'}`,
      `draws ${s.drawCalls}  tris ${(s.triangles / 1e6).toFixed(2)} M`,
      ...Object.entries(this.info.extra()).map(([k, v]) => `${k} ${v}`),
    ];
    this.el.textContent = lines.join('\n');
  }
}
