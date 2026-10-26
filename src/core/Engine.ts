import * as THREE from 'three/webgpu';
import {
  unpackRGBToNormal, packNormalToRGB, float, mix, mrt, normalView, output, pass, renderOutput, screenUV,
  vec3, vec4, velocity, sample,
} from './tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { params } from './params';
import { Q, gpuName, preset } from './quality';
import { grade, toneAndGrade } from './grade';

export { grade };

export type Updater = (dt: number, t: number) => void;

/** a measured refresh to the display rate it is (a busy main thread reads 200 Hz as 196) */
function snapHz(hz: number) {
  for (const r of [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 170, 180, 200, 240, 280, 360]) if (Math.abs(hz - r) / r < 0.04) return r;
  return Math.round(hz);
}

interface GpuPool { timestamps: Map<string, number>; frames?: number[] }

// Shadow passes draw every caster with one shared override material and copy each caster's alphaTest onto it; the
// alphaTest setter bumps the material's version whenever the test switches on or off, so with leaves and trunks
// interleaved nearly every shadow draw re-derived its full material cache key (a quarter of the main thread). A render
// object of the override always draws the same source material, so its alphaTest never really changes for it.
{
  const desc = Object.getOwnPropertyDescriptor(THREE.Material.prototype, 'alphaTest');
  if (desc?.set && desc.get) {
    const set = desc.set;
    Object.defineProperty(THREE.Material.prototype, 'alphaTest', {
      configurable: true,
      get: desc.get,
      set(this: THREE.Material & { _alphaTest: number; isShadowPassMaterial?: boolean }, v: number) {
        if (this.isShadowPassMaterial) this._alphaTest = v;
        else set.call(this, v);
      },
    });
  }
}

export class Engine {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 30000);
  pipeline!: THREE.RenderPipeline;
  private lastDraws = 0;
  private lastTris = 0;
  private updaters: Updater[] = [];
  /** game time (s), frame count */
  time = 0;
  frame = 0;
  /** wall intervals between displayed frames, main-thread ms per frame, GPU ms per frame (last 600) */
  private wall: number[] = [];
  private cpu: number[] = [];
  private gpu: number[] = [];
  private gpuFrames = new Map<number, number>();
  private resolving = false;
  adapterInfo: { vendor?: string; architecture?: string; device?: string; description?: string } = {};
  /** integer number of display refreshes per rendered frame (frame cap), 0 = uncapped */
  refreshHz = 60;
  divisor = 1;
  private capMode: string | number = 'auto';
  /** rAF intervals (every display refresh, rendered or not): the refresh is re-measured from them as the game runs,
   * so the cap follows the window to a display with another rate */
  private rafIntervals: number[] = [];
  private lastRaf = 0;
  private refreshVotes = 0;
  /**
   * While on, render pipelines are created with createRenderPipelineAsync: the driver compiles them on its worker
   * threads in parallel, and a draw whose pipeline is still compiling is skipped (three r186 checks
   * Pipelines.isReady before every draw) instead of the frame stalling on a serial compile.
   */
  asyncPipelines = false;
  pipelinesPending = 0;
  pipelinesCompiled = 0;
  /** draws skipped in the last rendered frame because their pipeline was still compiling */
  skippedDraws = 0;
  private skipping = 0;
  /** while true the loop neither updates nor renders */
  hold = false;
  /** manual stepping (harness clips): the loop stops; stepOnce advances a fixed dt and renders */
  manual = false;
  /** frozen world time for deterministic captures (waves, wind, clouds); null = running */
  frozenTime: number | null = null;
  renderScale = Q.renderScale;

  static async create(container: HTMLElement) {
    // ask for the texture limits the terrain and water shaders need (16 sampled textures per stage is the default)
    const limits: Record<string, number> = {};
    try {
      const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
      const adapter = gpu ? await gpu.requestAdapter({ powerPreference: 'high-performance' }) : null;
      if (adapter) {
        const L = adapter.limits;
        limits.maxSampledTexturesPerShaderStage = Math.min(32, L.maxSampledTexturesPerShaderStage);
        limits.maxSamplersPerShaderStage = Math.min(32, L.maxSamplersPerShaderStage);
        limits.maxColorAttachmentBytesPerSample = Math.min(64, L.maxColorAttachmentBytesPerSample);
        limits.maxStorageBuffersPerShaderStage = Math.min(10, L.maxStorageBuffersPerShaderStage);
      }
    } catch {
      // keep the defaults
    }
    const e = new Engine(container, limits);
    await e.renderer.init();
    const backend = e.renderer.backend as unknown as { isWebGPUBackend?: boolean; device?: GPUDevice; adapter?: GPUAdapter };
    try {
      const info = (backend.adapter as unknown as { info?: GPUAdapterInfo } | undefined)?.info;
      if (info) e.adapterInfo = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description };
    } catch {
      // no adapter info
    }
    e.installAsyncPipelines();
    e.resize();
    return e;
  }

  private installAsyncPipelines() {
    type Pipes = { getForRender(ro: unknown, promises?: unknown): unknown; updateForRender(ro: unknown): void; isReady(ro: unknown): boolean };
    const pipes = (this.renderer as unknown as { _pipelines?: Pipes })._pipelines;
    const webgpu = (this.renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend;
    if (!pipes || !webgpu || typeof pipes.getForRender !== 'function' || typeof pipes.isReady !== 'function') return;
    // three only ever calls push() on the promises array it is given
    const sink = {
      push: (p: Promise<unknown>) => {
        this.pipelinesPending++;
        const done = () => {
          this.pipelinesPending--;
          this.pipelinesCompiled++;
        };
        p.then(done, done);
      },
    };
    pipes.updateForRender = (ro) => void pipes.getForRender(ro, this.asyncPipelines ? sink : null);
    const isReady = pipes.isReady.bind(pipes);
    pipes.isReady = (ro) => {
      const ready = isReady(ro);
      if (!ready) this.skipping++;
      return ready;
    };
  }

  private constructor(container: HTMLElement, requiredLimits: Record<string, number>) {
    this.renderer = new THREE.WebGPURenderer({
      requiredLimits,
      antialias: false,
      powerPreference: 'high-performance',
      reversedDepthBuffer: true,
      forceWebGL: params.webgl,
      trackTimestamp: params.gpuTiming,
    } as ConstructorParameters<typeof THREE.WebGPURenderer>[0]);
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // counted over the whole frame (every pass), reset by the loop
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);
    window.addEventListener('resize', () => this.resize());
  }

  get backendName(): string {
    const b = this.renderer.backend as unknown as { isWebGPUBackend?: boolean };
    return b.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  }

  get gpu_name() {
    return gpuName;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    if (w < 2 || h < 2) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr * this.renderScale);
    this.renderer.setSize(w, h);
  }

  setRenderScale(s: number) {
    this.renderScale = s;
    this.resize();
  }

  /** the post chain: scene (HDR, MRT normal + velocity) -> GTAO -> TRAA -> bloom -> exposure -> AgX -> grade */
  setupPost() {
    const { scene, camera, renderer } = this;
    const pipeline = new THREE.RenderPipeline(renderer);
    pipeline.outputColorTransform = false;
    const scenePass = pass(scene, camera);
    scenePass.name = 'scene';
    if (params.noPost) {
      pipeline.outputNode = renderOutput(scenePass, THREE.AgXToneMapping, THREE.SRGBColorSpace);
      this.pipeline = pipeline;
      return;
    }
    const useAO = Q.ao && !params.noAO;
    const useTAA = Q.taa && !params.noTAA;
    const outs: Record<string, unknown> = { output };
    if (useAO) outs.normal = packNormalToRGB(normalView);
    if (useTAA) outs.velocity = velocity;
    scenePass.setMRT(mrt(outs));
    const color = scenePass.getTextureNode('output');
    const depthTex = scenePass.getTextureNode('depth');
    let hdr = color;
    if (useAO) {
      const normalRaw = scenePass.getTextureNode('normal');
      const normalTex = sample((uvN: unknown) => unpackRGBToNormal(normalRaw.sample(uvN)));
      const aoPass = ao(depthTex, normalTex, camera);
      aoPass.resolutionScale = Q.aoScale;
      aoPass.radius.value = 1.1;
      aoPass.distanceExponent.value = 1.6;
      aoPass.thickness.value = 1.4;
      aoPass.scale.value = 1.0;
      aoPass.samples.value = 12;
      const aoV = aoPass.getTextureNode().sample(screenUV).r;
      // reversed depth: the sky is the cleared far plane (0) and gets no AO
      const isSky = depthTex.sample(screenUV).x.lessThan(1e-7);
      const k = isSky.select(float(0), grade.aoStrength);
      hdr = vec4(color.rgb.mul(mix(float(1), aoV, k)), color.a);
    }
    let aa = hdr;
    if (useTAA) {
      const t = traa(hdr, depthTex, scenePass.getTextureNode('velocity'), camera);
      // the clouds, the hair and the near leaves are dithered per frame and left to the temporal AA to average; the
      // subpixel correction lifts the current frame's weight from 5 % to as much as 30 % as soon as the camera moves
      // at all, which lets that dither through: the clouds and edges fizz the moment the player starts walking
      t.useSubpixelCorrection = params.taaSubpixel;
      aa = t;
    }
    const hdrClamped = aa.rgb.min(vec3(64));
    // bloom thresholds the exposed image (mid-grey ~0.2, sunlit sand ~0.6): glints, the sun, lamps and the moon
    // bloom by day and by night alike, bright sand and surf do not veil the picture
    const lit = hdrClamped.mul(grade.exposure);
    // (its input is clamped so the sun disc gives a glare around it, not a blown-out third of the frame)
    // (only what is far above white blooms: the sun, glints, lamps, the moon; not bright sky or sand)
    const exposed = Q.bloom ? lit.add(bloom(vec4(lit.min(vec3(12)), 1), 0.55, 0.2, 2.6).rgb.mul(grade.bloomStrength.mul(16))) : lit;
    pipeline.outputNode = toneAndGrade(exposed);
    this.pipeline = pipeline;
  }

  addUpdater(fn: Updater) {
    this.updaters.push(fn);
  }

  /** measure the display refresh (median rAF interval) and pick the frame cap */
  async measureRefresh() {
    const ts: number[] = [];
    await new Promise<void>((res) => {
      let last = 0;
      const step = (t: number) => {
        if (last) ts.push(t - last);
        last = t;
        if (ts.length < 40) requestAnimationFrame(step);
        else res();
      };
      requestAnimationFrame(step);
    });
    ts.sort((a, b) => a - b);
    const med = ts[Math.floor(ts.length / 2)] || 16.7;
    this.refreshHz = snapHz(1000 / med);
    this.applyCap(params.fps);
  }

  /** every rAF tick: a low percentile of the recent intervals is the refresh (late frames only make intervals longer) */
  private trackRefresh(now: number) {
    const d = now - this.lastRaf;
    this.lastRaf = now;
    if (d > 2 && d < 50) this.rafIntervals.push(d);
    if (this.rafIntervals.length < 120) return;
    const s = this.rafIntervals.sort((a, b) => a - b);
    const hz = 1000 / s[Math.floor(s.length * 0.2)];
    this.rafIntervals.length = 0;
    // two windows in a row must agree before the cap changes (a hitch or a busy GPU can skew one)
    if (Math.abs(hz - this.refreshHz) / this.refreshHz > 0.08) {
      if (++this.refreshVotes >= 2) {
        this.refreshHz = snapHz(hz);
        this.refreshVotes = 0;
        this.applyCap(this.capMode);
      }
    } else this.refreshVotes = 0;
  }

  /** 'auto': the largest frame time that is an integer number of refreshes with >= 60 fps; a number: that rate; 0: uncapped */
  applyCap(fps: string | number) {
    this.capMode = fps;
    const hz = this.refreshHz;
    if (fps === 'auto') this.divisor = Math.max(1, Math.floor(hz / 60));
    else if (Number(fps) === 0) this.divisor = 0;
    else this.divisor = Math.max(1, Math.round(hz / Math.max(1, Number(fps))));
  }

  get targetFps() {
    return this.divisor === 0 ? Infinity : this.refreshHz / this.divisor;
  }

  start() {
    let last = performance.now();
    this.renderer.setAnimationLoop((time?: number) => {
      const t0 = performance.now();
      // the cap goes by the display's frame times (the rAF timestamp: whole refreshes, however late the callback
      // runs), not by counting refreshes: a frame whose own work outlasts two refreshes then still lands in the next
      // slot (counting the ticks after it would wait out the whole count again: 25 ms instead of 15)
      const now = time ?? t0;
      this.trackRefresh(now);
      if (this.divisor > 1 && now - last < (this.divisor - 0.5) * (1000 / this.refreshHz)) return;
      if (this.hold || this.manual) {
        last = now;
        return;
      }
      const interval = now - last;
      last = now;
      const dt = Math.min(interval / 1000, 1 / 15);
      this.time = this.frozenTime ?? this.time + dt;
      this.renderer.info.reset();
      for (const u of this.updaters) u(dt, this.time);
      this.pipeline.render();
      this.lastDraws = this.renderer.info.render.drawCalls;
      this.lastTris = this.renderer.info.render.triangles;
      this.skippedDraws = this.skipping;
      this.skipping = 0;
      this.frame++;
      const cpu = performance.now() - t0;
      this.push(this.wall, interval);
      this.push(this.cpu, cpu);
      if (params.gpuTiming) this.resolveGpu();
    });
  }

  /** advance exactly dt seconds and render one frame (manual mode) */
  stepOnce(dt: number) {
    this.time = this.frozenTime ?? this.time + dt;
    for (const u of this.updaters) u(dt, this.time);
    this.pipeline.render();
    this.skippedDraws = this.skipping;
    this.skipping = 0;
    this.frame++;
  }

  private push(a: number[], v: number) {
    a.push(v);
    if (a.length > 600) a.shift();
  }

  /** GPU ms per frame: the render and compute timestamp pools, summed by frame id */
  private resolveGpu() {
    if (this.resolving) return;
    const backend = this.renderer.backend as unknown as { trackTimestamp?: boolean; timestampQueryPool?: Record<string, GpuPool | null> };
    if (!backend.trackTimestamp) return;
    this.resolving = true;
    Promise.all([this.renderer.resolveTimestampsAsync('render'), this.renderer.resolveTimestampsAsync('compute')]).then(() => {
      const totals = new Map<number, number>();
      for (const key of ['render', 'compute']) {
        const pool = backend.timestampQueryPool?.[key];
        if (!pool) continue;
        for (const [uid, ms] of pool.timestamps) {
          const cut = uid.lastIndexOf(':f');
          const f = Number(uid.slice(cut + 2));
          totals.set(f, (totals.get(f) ?? 0) + ms);
        }
      }
      for (const [f, ms] of totals) {
        if (this.gpuFrames.has(f)) continue;
        this.gpuFrames.set(f, ms);
        this.push(this.gpu, ms);
      }
      if (this.gpuFrames.size > 2000) this.gpuFrames.clear();
      this.resolving = false;
    }, () => (this.resolving = false));
  }

  resetStats() {
    this.wall.length = 0;
    this.cpu.length = 0;
    this.gpu.length = 0;
  }

  stats() {
    const st = (a: number[]) => {
      if (!a.length) return { n: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
      const s = [...a].sort((x, y) => x - y);
      const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
      return { n: a.length, avg: a.reduce((x, y) => x + y, 0) / a.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1] };
    };
    const w = st(this.wall);
    return {
      fps: w.avg ? 1000 / w.avg : 0,
      frame: w,
      cpu: st(this.cpu),
      gpu: st(this.gpu),
      targetFps: this.targetFps,
      refreshHz: this.refreshHz,
      preset,
      renderScale: this.renderScale,
      // every pass of the last frame: shadow cascades, the scene, the post chain
      drawCalls: this.lastDraws,
      triangles: this.lastTris,
      pipelines: { compiled: this.pipelinesCompiled, pending: this.pipelinesPending, skippedDraws: this.skippedDraws },
    };
  }
}
