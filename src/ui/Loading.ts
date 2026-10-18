/** the loading screen in index.html: a progress bar that only moves forward, a status line and the GPU line */
export class Loading {
  private fill = document.getElementById('load-fill') as HTMLDivElement;
  private statusEl = document.getElementById('load-status') as HTMLDivElement;
  private gpuEl = document.getElementById('load-gpu') as HTMLDivElement;
  private root = document.getElementById('loading') as HTMLDivElement;
  private value = 0;
  readonly t0 = performance.now();

  progress(v: number) {
    this.value = Math.max(this.value, Math.min(1, v));
    if (this.fill) this.fill.style.width = `${(this.value * 100).toFixed(1)}%`;
  }
  status(s: string) {
    if (this.statusEl) this.statusEl.textContent = s;
  }
  gpu(s: string) {
    if (this.gpuEl) this.gpuEl.textContent = s;
  }
  /** fades the screen out; resolves once it is gone (a capture taken before that would show it) */
  done(): Promise<void> {
    this.root?.classList.add('done');
    return new Promise((res) => setTimeout(() => {
      this.root?.remove();
      res();
    }, 1200));
  }
}
