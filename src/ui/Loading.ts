/** the loading screen in index.html: a progress line that only moves forward, a status line and the GPU line */
export class Loading {
  private fill = document.getElementById('load-fill') as HTMLDivElement;
  private bar = document.getElementById('load-bar') as HTMLDivElement;
  private statusEl = document.getElementById('load-status') as HTMLDivElement;
  private gpuEl = document.getElementById('load-gpu') as HTMLDivElement;
  private root = document.getElementById('loading') as HTMLDivElement;
  private value = 0;
  readonly t0 = performance.now();

  progress(v: number) {
    this.value = Math.max(this.value, Math.min(1, v));
    // (a transform, not a width: its transition runs on the compositor while the main thread builds shaders)
    if (this.fill) this.fill.style.transform = `scaleX(${this.value.toFixed(3)})`;
    this.bar?.setAttribute('aria-valuenow', String(Math.round(this.value * 100)));
  }
  status(s: string) {
    if (this.statusEl) this.statusEl.textContent = s;
  }
  gpu(s: string) {
    if (this.gpuEl) this.gpuEl.textContent = s;
  }
  /** crossfades the screen into the live frame; resolves once it is gone (a capture taken before that would show it) */
  done(): Promise<void> {
    this.root?.classList.add('done');
    return new Promise((res) => setTimeout(() => {
      this.root?.remove();
      res();
    }, 1200));
  }
}
