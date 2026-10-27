import * as THREE from 'three/webgpu';
import {
  unpackRGBToNormal, packNormalToRGB, float, mix, mrt, normalView, output, pass, renderOutput, screenUV,
  vec3, vec4, velocity, sample, texture, uniform,
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
  private gpuPasses = new Map<string, [number, number]>();
  private gpuDone = -1;
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
  readonly builds: { at: number; ms: number; mat: string; obj: string; shadow: boolean }[] = [];
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
  /** capture (?accum=n): run before each extra render of a frame, to re-seed the per-frame dithers */
  readonly onSubframe: (() => void)[] = [];
  /** capture: renders averaged into each stepped frame (1 = one plain render) */
  accum = params.accum;
  private acc: { cur: THREE.RenderTarget; ping: THREE.RenderTarget[]; prev: ReturnType<typeof texture>; now: ReturnType<typeof texture>; k: ReturnType<typeof uniform>; add: THREE.RenderPipeline; show: THREE.RenderPipeline; out: ReturnType<typeof texture> } | null = null;

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
    // shared-instancing meshes (core/instancing.ts) look up their render objects under one uuid, so meshes of one
    // material share a node build
    const objects = (this.renderer as unknown as { _objects?: { get(o: THREE.Object3D, ...rest: unknown[]): unknown } })._objects;
    if (objects) {
      const get = objects.get.bind(objects);
      objects.get = (o, ...rest) => {
        if (!o.userData.sharedInstancing) return get(o, ...rest);
        const uuid = o.uuid;
        o.uuid = 'shared-instancing';
        try {
          return get(o, ...rest);
        } finally {
          o.uuid = uuid;
        }
      };
    }
    // (automated runs: the time each node material takes to build into shaders, for __island.ctx.engine.builds)
    const nodes = (this.renderer as unknown as { _nodes?: { getForRender(ro: unknown): unknown } })._nodes;
    if (params.test && nodes) {
      const get = nodes.getForRender.bind(nodes);
      nodes.getForRender = (ro) => {
        const t = performance.now();
        const r = get(ro);
        const ms = performance.now() - t;
        if (ms > 2) {
          const o = ro as { material: THREE.Material & { isShadowPassMaterial?: boolean }; object: THREE.Object3D };
          this.builds.push({ at: Math.round(t), ms: Math.round(ms), mat: o.material.name || o.material.type, obj: o.object.name || o.object.type, shadow: !!o.material.isShadowPassMaterial });
        }
        return r;
      };
    }
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
      // (the averaged capture: its noise turns with every render, so the mean resolves it)
      aoPass.useTemporalFiltering = params.accum > 1;
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
    if (fps === 'auto') this.divisor = this.autoBase = Math.max(1, Math.floor(hz / 60));
    else if (Number(fps) === 0) this.divisor = 0;
    else this.divisor = Math.max(1, Math.round(hz / Math.max(1, Number(fps))));
  }

  /**
   * Even pacing for the auto cap: a frame rate that is held only most of the time alternates one-refresh-late frames
   * with on-time ones (15 / 20 ms on a 200 Hz screen), which reads as judder. When more than 4 % of the last 120
   * frames land a refresh late, the cap steps to the next divisor (66.7 -> 50 fps there: a steady 20 ms) as long as
   * that still gives at least 45 fps. It steps back up only on trial: after 8 s at the slower rate with the main
   * thread well inside the faster frame; a trial that falls back within 6 s doubles the wait (up to two minutes).
   */
  private pace(interval: number, cpu: number, now: number) {
    const period = 1000 / this.refreshHz;
    const w = this.paceWin;
    w.push(interval > (this.divisor + 0.5) * period ? 1 : 0);
    if (w.length > 120) w.shift();
    const late = w.reduce((a, b) => a + b, 0);
    if (w.length >= 60 && late > w.length * 0.04 && this.refreshHz / (this.divisor + 1) >= 45) {
      if (now - this.paceUpAt < 6000) this.paceWait = Math.min(this.paceWait * 2, 120000);
      this.divisor++;
      w.length = 0;
      this.paceDownAt = now;
      this.paceCpu.length = 0;
      return;
    }
    if (this.divisor <= this.autoBase) return;
    this.paceCpu.push(cpu);
    if (this.paceCpu.length > 240) this.paceCpu.shift();
    if (now - this.paceDownAt < this.paceWait || this.paceCpu.length < 240) return;
    const sorted = [...this.paceCpu].sort((a, b) => a - b);
    if (sorted[Math.floor(sorted.length * 0.9)] < 0.6 * (this.divisor - 1) * period) {
      this.divisor--;
      w.length = 0;
      this.paceCpu.length = 0;
      this.paceUpAt = now;
      this.paceDownAt = now;
    }
  }
  /** back to the auto cap's own rate with a fresh window (the end of loading, a staged capture) */
  resetPacing() {
    if (this.capMode === 'auto') this.divisor = this.autoBase;
    this.paceWin.length = 0;
    this.paceCpu.length = 0;
    this.paceWait = 8000;
    this.paceDownAt = this.paceUpAt = -1e9;
  }
  private autoBase = 1;
  private paceWin: number[] = [];
  private paceCpu: number[] = [];
  private paceDownAt = -1e9;
  private paceUpAt = -1e9;
  private paceWait = 8000;

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
      if (this.capMode === 'auto' && this.divisor > 0) this.pace(interval, cpu, now);
      if (params.gpuTiming) this.resolveGpu();
    });
  }

  /** advance exactly dt seconds and render one frame (manual mode) */
  stepOnce(dt: number) {
    this.time = this.frozenTime ?? this.time + dt;
    for (const u of this.updaters) u(dt, this.time);
    if (this.accum > 1) this.renderAccumulated(this.accum);
    else this.pipeline.render();
    this.skippedDraws = this.skipping;
    this.skipping = 0;
    this.frame++;
  }

  /**
   * Capture only: the frame as the mean of n renders of the same instant, each with its own sub-pixel jitter (a
   * Halton 2,3 pattern over the pixel) and fresh per-frame dither seeds, summed in half float and shown once. The
   * graded display-space output of every render is averaged, so it is n-sample supersampling of the game's picture.
   */
  private renderAccumulated(n: number) {
    const { renderer, camera } = this;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (!this.acc || this.acc.cur.width !== size.x || this.acc.cur.height !== size.y) {
      this.acc?.cur.dispose();
      this.acc?.ping.forEach((t) => t.dispose());
      const rt = () => new THREE.RenderTarget(size.x, size.y, { type: THREE.HalfFloatType, depthBuffer: false });
      const cur = rt(), ping = [rt(), rt()];
      const prev = texture(ping[0].texture), now = texture(cur.texture), out = texture(ping[1].texture), k = uniform(1);
      const add = new THREE.RenderPipeline(renderer);
      add.outputColorTransform = false;
      add.outputNode = mix(prev.sample(screenUV), now.sample(screenUV), k);
      const show = new THREE.RenderPipeline(renderer);
      show.outputColorTransform = false;
      show.outputNode = out.sample(screenUV);
      this.acc = { cur, ping, prev, now, k, add, show, out };
    }
    const A = this.acc;
    const halton = (i: number, b: number) => {
      let f = 1, r = 0;
      for (; i > 0; i = Math.floor(i / b)) r += (f /= b) * (i % b);
      return r;
    };
    // (three's per-frame passes run once per node frame, which only the animation loop advances)
    const nodeFrame = (renderer as unknown as { _nodes: { nodeFrame: { update(): void } } })._nodes.nodeFrame;
    let dst = 0;
    for (let s = 0; s < n; s++) {
      if (s) {
        nodeFrame.update();
        for (const f of this.onSubframe) f();
      }
      camera.setViewOffset(size.x, size.y, halton(s + 1, 2) - 0.5, halton(s + 1, 3) - 0.5, size.x, size.y);
      renderer.setRenderTarget(A.cur);
      this.pipeline.render();
      // running mean: the target written last holds the mean of the renders so far
      dst = s % 2 === 0 ? 1 : 0;
      A.prev.value = A.ping[1 - dst].texture;
      A.k.value = 1 / (s + 1);
      renderer.setRenderTarget(A.ping[dst]);
      A.add.render();
    }
    camera.clearViewOffset();
    renderer.setRenderTarget(null);
    A.out.value = A.ping[dst].texture;
    A.show.render();
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
    // three's pools hold 2048 queries (~50 frames here; WebGPU allows 4096): with the GPU busy a resolve comes back
    // over 100 frames later, the pool fills and the passes late in a frame (the scene) went untimed
    const pools = backend.timestampQueryPool;
    for (const key of ['render', 'compute']) {
      const pool = pools?.[key] as unknown as { maxQueries: number; device: GPUDevice; dispose(): void; constructor: new (d: GPUDevice, t: string, n: number) => GpuPool } | null;
      if (pool && pool.maxQueries < 4096) {
        pools![key] = new pool.constructor(pool.device, key, 4096);
        pool.dispose();
      }
    }
    this.resolving = true;
    Promise.all([this.renderer.resolveTimestampsAsync('render'), this.renderer.resolveTimestampsAsync('compute')]).then(() => {
      // a frame's passes can arrive over two resolves (the scene pass after the shadow passes): collect them per
      // pass and count a frame only once later frames have arrived
      let newest = 0;
      for (const key of ['render', 'compute']) {
        const pool = backend.timestampQueryPool?.[key];
        if (!pool) continue;
        for (const [uid, ms] of pool.timestamps) {
          const f = Number(uid.slice(uid.lastIndexOf(':f') + 2));
          if (f <= this.gpuDone) continue;
          this.gpuPasses.set(key + uid, [f, ms]);
          newest = Math.max(newest, f);
        }
      }
      const totals = new Map<number, [number, number]>();
      for (const [k, [f, ms]] of this.gpuPasses) {
        if (f > newest - 8) continue;
        const t = totals.get(f) ?? [0, 0];
        totals.set(f, [t[0] + ms, t[1] + 1]);
        this.gpuPasses.delete(k);
      }
      // (a frame with only a few passes back is a fragment, not a frame: not counted)
      let most = 0;
      for (const [, n] of totals.values()) most = Math.max(most, n);
      for (const f of [...totals.keys()].sort((x, y) => x - y)) {
        const [ms, n] = totals.get(f)!;
        if (n >= most / 2) this.push(this.gpu, ms);
        this.gpuDone = Math.max(this.gpuDone, f);
      }
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
