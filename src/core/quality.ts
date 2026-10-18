/**
 * Graphics presets. High is the look and budget the game is tuned to (RTX 4060 at 1920x1080, 60 fps with headroom).
 * The preset is picked from the GPU's name unless ?quality= says otherwise; automated runs (?test=1) use High.
 */
import { params } from './params';

export type Preset = 'low' | 'medium' | 'high' | 'ultra';
export const PRESETS: Preset[] = ['low', 'medium', 'high', 'ultra'];

export interface Knobs {
  renderScale: number;
  /** shadow-map size of the near cascade, and of the middle and far ones */
  shadowMap: number;
  shadowMid: number;
  shadowFarMap: number;
  cascades: number;
  shadowFar: number;
  ao: boolean;
  aoScale: number;
  taa: boolean;
  bloom: boolean;
  /** vegetation instance density multiplier */
  density: number;
  /** grass and ground-cover draw distance (m) */
  grassFar: number;
  /** tree / plant LOD distance multiplier */
  lodScale: number;
  /** ocean mesh rings resolution */
  oceanSegments: number;
  /** cloud ray steps */
  cloudSteps: number;
  rainParticles: number;
}

export const TABLE: Record<Preset, Knobs> = {
  low: { renderScale: 0.7, shadowMap: 1024, shadowMid: 1024, shadowFarMap: 1024, cascades: 2, shadowFar: 140, ao: false, aoScale: 0.5, taa: true, bloom: true, density: 0.45, grassFar: 28, lodScale: 0.6, oceanSegments: 128, cloudSteps: 8, rainParticles: 4000 },
  medium: { renderScale: 0.85, shadowMap: 2048, shadowMid: 1024, shadowFarMap: 1024, cascades: 3, shadowFar: 260, ao: true, aoScale: 0.5, taa: true, bloom: true, density: 0.7, grassFar: 42, lodScale: 0.8, oceanSegments: 192, cloudSteps: 12, rainParticles: 8000 },
  high: { renderScale: 1, shadowMap: 2048, shadowMid: 2048, shadowFarMap: 1024, cascades: 3, shadowFar: 380, ao: true, aoScale: 0.5, taa: true, bloom: true, density: 1, grassFar: 60, lodScale: 1, oceanSegments: 256, cloudSteps: 16, rainParticles: 14000 },
  ultra: { renderScale: 1, shadowMap: 4096, shadowMid: 4096, shadowFarMap: 2048, cascades: 4, shadowFar: 520, ao: true, aoScale: 1, taa: true, bloom: true, density: 1.3, grassFar: 85, lodScale: 1.35, oceanSegments: 320, cloudSteps: 24, rainParticles: 20000 },
};

/** the GPU as WebGL names it (ANGLE on Windows: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 (0x00002882) Direct3D11 ...") */
export function webglRendererName(): string {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return r;
  } catch {
    return '';
  }
}

export function cleanGpuName(r: string): string {
  const m = /^ANGLE \((?:[^,]+), (.+?)(?: \(0x[0-9a-f]+\))?(?: Direct3D| OpenGL| Vulkan| Metal|, )/i.exec(r);
  return (m ? m[1] : r).replace(/\s+/g, ' ').trim();
}

function guess(name: string): Preset {
  const n = name.toLowerCase();
  if (/swiftshader|llvmpipe|software|basic render/.test(n)) return 'low';
  if (/rtx\s*(40[7-9]0|50[7-9]0|30[8-9]0)/.test(n)) return 'ultra';
  if (/rtx|rx\s*(6[6-9]|7[6-9])\d\d|arc\(tm\) a7/.test(n)) return 'high';
  if (/gtx|rx\s*\d{3,4}/.test(n)) return 'medium';
  if (/intel|radeon\(tm\) graphics|vega|apple m1|adreno|mali/.test(n)) return 'low';
  return 'high';
}

export const gpuName = cleanGpuName(webglRendererName());
const forced = params.quality as Preset | null;
export const preset: Preset = forced && PRESETS.includes(forced) ? forced : params.test ? 'high' : Math.min(PRESETS.indexOf(guess(gpuName)), 2) >= 0 ? PRESETS[Math.min(PRESETS.indexOf(guess(gpuName)), 2)] : 'high';
export const Q: Knobs = { ...TABLE[preset] };
// single knobs can be overridden from the URL for A/B measurements, e.g. ?q.lodScale=0.8&q.cloudSteps=12
for (const [k, v] of new URLSearchParams(location.search)) {
  const key = k.startsWith('q.') ? (k.slice(2) as keyof Knobs) : null;
  if (!key || !(key in Q)) continue;
  (Q as unknown as Record<string, number | boolean>)[key] = typeof Q[key] === 'boolean' ? v === '1' || v === 'true' : Number(v);
}
