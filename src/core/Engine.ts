import * as THREE from 'three/webgpu';
import {
  unpackRGBToNormal, packNormalToRGB, dot, float, length, mix, mrt, normalView, output, pass, renderOutput, screenUV,
  smoothstep, uniform, vec3, vec4, velocity, sample,
} from './tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { params } from './params';
import { Q, gpuName, preset } from './quality';

export type Updater = (dt: number, t: number) => void;

/** display-space grade applied after tone mapping */
export const grade = {
  exposure: uniform(1.0),
  saturation: uniform(1.06),
  contrast: uniform(1.06),
  lift: uniform(new THREE.Vector3(0.0, 0.002, 0.006)),
  gain: uniform(new THREE.Vector3(1.0, 1.0, 1.0)),
  vignette: uniform(0.2),
  aoStrength: uniform(0.75),
  bloomStrength: uniform(0.06),
};

interface GpuPool { timestamps: Map<string, number>; frames?: number[] }

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
    e.resize();
    return e;
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
      aa = t;
    }
    const hdrClamped = aa.rgb.min(vec3(64));
    // bloom thresholds the exposed image (mid-grey ~0.2, sunlit sand ~0.6): glints, the sun, lamps and the moon
    // bloom by day and by night alike, bright sand and surf do not veil the picture
    const lit = hdrClamped.mul(grade.exposure);
    // (its input is clamped so the sun disc gives a glare around it, not a blown-out third of the frame)
    const exposed = Q.bloom ? lit.add(bloom(vec4(lit.min(vec3(10)), 1), 0.6, 0.22, 1.5).rgb.mul(grade.bloomStrength.mul(16))) : lit;
    const display = renderOutput(vec4(exposed, 1), THREE.AgXToneMapping, THREE.SRGBColorSpace);
    const lum = dot(display.rgb, vec3(0.2126, 0.7152, 0.0722));
    let c = mix(vec3(lum), display.rgb, grade.saturation);
    c = c.sub(0.5).mul(grade.contrast).add(0.5);
    c = c.mul(grade.gain).add(grade.lift.mul(float(1).sub(c)));
    const v = length(screenUV.sub(0.5).mul(vec3(1.0, 0.75, 0).xy));
    c = c.mul(mix(float(1), float(1).sub(grade.vignette), smoothstep(0.3, 0.85, v)));
    pipeline.outputNode = vec4(c.clamp(0, 1), 1);
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
    this.refreshHz = Math.round(1000 / med);
    this.applyCap(params.fps);
  }

  /** 'auto': the largest frame time that is an integer number of refreshes with >= 60 fps; a number: that rate; 0: uncapped */
  applyCap(fps: string | number) {
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
    let tick = 0;
    this.renderer.setAnimationLoop(() => {
      tick++;
      if (this.divisor > 1 && tick % this.divisor !== 0) return;
      const now = performance.now();
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
      this.frame++;
      const cpu = performance.now() - now;
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
    };
  }
}
