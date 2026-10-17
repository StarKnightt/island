/**
 * Asset loading: KTX2 textures (Basis Universal, transcoded to BC7 / ASTC / ETC by the GPU's support), meshopt-
 * compressed glTF, and texture arrays assembled from per-layer KTX2 files. Tracks progress for the loading screen.
 */
import * as THREE from 'three/webgpu';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

let ktx2: KTX2Loader | null = null;
let gltf: GLTFLoader | null = null;
const BASE = './';

export const progress = { pending: 0, done: 0, onChange: null as null | (() => void) };
function track<T>(p: Promise<T>): Promise<T> {
  progress.pending++;
  progress.onChange?.();
  return p.finally(() => {
    progress.done++;
    progress.onChange?.();
  });
}

export function initAssets(renderer: THREE.WebGPURenderer) {
  ktx2 = new KTX2Loader().setTranscoderPath(`${BASE}basis/`).setWorkerLimit(2);
  ktx2.detectSupport(renderer);
  gltf = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
}

export function loadKTX2(url: string): Promise<THREE.CompressedTexture> {
  return track(ktx2!.loadAsync(`${BASE}${url}`) as Promise<THREE.CompressedTexture>);
}

export function loadGLTF(url: string): Promise<GLTF> {
  return track(gltf!.loadAsync(`${BASE}${url}`));
}

/** stack same-sized compressed textures into one array texture (mip by mip) */
export function toArray(layers: THREE.CompressedTexture[], srgb: boolean): THREE.CompressedArrayTexture {
  const first = layers[0];
  const mips = first.mipmaps as unknown as { data: Uint8Array; width: number; height: number }[];
  const out = mips.map((m, level) => {
    const parts = layers.map((l) => (l.mipmaps as unknown as { data: Uint8Array }[])[level].data);
    const total = parts.reduce((a, p) => a + p.byteLength, 0);
    const data = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      data.set(p, o);
      o += p.byteLength;
    }
    return { data, width: m.width, height: m.height };
  });
  const tex = new THREE.CompressedArrayTexture(out as never, first.image.width, first.image.height, layers.length, first.format, first.type);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  for (const l of layers) l.dispose();
  return tex;
}

/** a tiny uncompressed array of flat colours that stands in until the real layers stream in */
export function placeholderArray(colors: number[][], srgb: boolean, alpha = 128): THREE.DataArrayTexture {
  const n = colors.length;
  const data = new Uint8Array(4 * 4 * 4 * n);
  for (let l = 0; l < n; l++) for (let i = 0; i < 16; i++) {
    const o = (l * 16 + i) * 4;
    data[o] = Math.round(colors[l][0] * 255);
    data[o + 1] = Math.round(colors[l][1] * 255);
    data[o + 2] = Math.round(colors[l][2] * 255);
    data[o + 3] = colors[l][3] !== undefined ? Math.round(colors[l][3] * 255) : alpha;
  }
  const t = new THREE.DataArrayTexture(data, 4, 4, n);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export function configureTex(t: THREE.Texture, srgb: boolean, repeat = true) {
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}
