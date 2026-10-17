/**
 * The baked island data (tools/gen-island.ts): heights at 1 m, material masks and the distance to the waterline at
 * 2 m. CPU-side queries for physics, scatter and audio; GPU textures for terrain, water and vegetation shaders.
 */
import * as THREE from 'three/webgpu';
import { HALF_WORLD, HEIGHT_RES, H_MAX, H_MIN, MASK_RES, WORLD_SIZE } from './layout';

export interface RiverSample { x: number; z: number; bed: number; water: number; w: number; s: number }
export interface IslandMeta {
  river: number[][];
  falls: { lip: [number, number]; toward: [number, number]; s: number; top: number; bottom: number; width: number };
  pool: { p: [number, number]; r: number; level: number };
}

async function fetchGz(url: string, onBytes?: (n: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: ${res.status}`);
  // count compressed bytes as they arrive (loading progress), then inflate
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    onBytes?.(value.length);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  // a server may already have removed the gzip layer (Content-Encoding); the magic bytes tell
  if (all[0] !== 0x1f || all[1] !== 0x8b) return all.buffer;
  const ds = new DecompressionStream('gzip');
  const out = new Response(new Blob([all]).stream().pipeThrough(ds));
  return out.arrayBuffer();
}

export class Heightfield {
  readonly n = HEIGHT_RES;
  readonly m = MASK_RES;
  heights!: Float32Array;
  mask0!: Uint8Array;
  mask1!: Uint8Array;
  shore!: Float32Array;
  meta!: IslandMeta;
  river: RiverSample[] = [];
  heightTex!: THREE.DataTexture;
  mask0Tex!: THREE.DataTexture;
  mask1Tex!: THREE.DataTexture;
  shoreTex!: THREE.DataTexture;

  /** total compressed bytes, for the loading bar */
  static readonly BYTES = 3_970_000 + 367_000 + 303_000 + 1_072_000 + 16_000;

  async load(base: string, onBytes?: (n: number) => void) {
    const [h, m0, m1, sh, meta] = await Promise.all([
      fetchGz(`${base}height.bin.gz`, onBytes),
      fetchGz(`${base}mask0.bin.gz`, onBytes),
      fetchGz(`${base}mask1.bin.gz`, onBytes),
      fetchGz(`${base}shore.bin.gz`, onBytes),
      fetch(`${base}meta.json`).then((r) => r.json() as Promise<IslandMeta>),
    ]);
    const N = this.n;
    // byte planes of row deltas -> heights
    const planes = new Uint8Array(h);
    const heights = new Float32Array(N * N);
    const scale = (H_MAX - H_MIN) / 65535;
    let prevRowStart = 0;
    for (let j = 0; j < N; j++) {
      let prev = j > 0 ? prevRowStart : 0;
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const d = planes[k] | (planes[N * N + k] << 8);
        const v = (prev + d) & 0xffff;
        if (i === 0) prevRowStart = v;
        heights[k] = H_MIN + v * scale;
        prev = v;
      }
    }
    this.heights = heights;
    this.mask0 = new Uint8Array(m0);
    this.mask1 = new Uint8Array(m1);
    const s16 = new Uint16Array(sh);
    this.shore = new Float32Array(s16.length);
    for (let i = 0; i < s16.length; i++) this.shore[i] = s16[i] / 32 - 1024;
    this.meta = meta;
    this.river = meta.river.map(([x, z, bed, water, w, s]) => ({ x, z, bed, water, w, s }));

    const ht = new THREE.DataTexture(heights, N, N, THREE.RedFormat, THREE.FloatType);
    ht.magFilter = THREE.LinearFilter;
    ht.minFilter = THREE.LinearFilter;
    ht.wrapS = ht.wrapT = THREE.ClampToEdgeWrapping;
    ht.generateMipmaps = false;
    ht.needsUpdate = true;
    this.heightTex = ht;
    const mk = (data: Uint8Array) => {
      const t = new THREE.DataTexture(data, this.m, this.m, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.needsUpdate = true;
      return t;
    };
    this.mask0Tex = mk(this.mask0);
    this.mask1Tex = mk(this.mask1);
    // R: distance to the waterline (m, + on land), G: kind of the nearest coast (0 beach .. 0.5 rock .. 1 cliff),
    // in one texture so the shaders that need both spend one sampler
    const coast = new Float32Array(this.m * this.m * 2);
    for (let i = 0; i < this.m * this.m; i++) {
      coast[i * 2] = this.shore[i];
      coast[i * 2 + 1] = this.mask1[i * 4 + 3] / 255;
    }
    const st = new THREE.DataTexture(coast, this.m, this.m, THREE.RGFormat, THREE.FloatType);
    st.magFilter = THREE.LinearFilter;
    st.minFilter = THREE.LinearFilter;
    st.generateMipmaps = false;
    st.needsUpdate = true;
    this.shoreTex = st;
  }

  /** bilinear height (m) */
  height(x: number, z: number) {
    const N = this.n;
    const fx = (x + HALF_WORLD) - 0.5, fz = (z + HALF_WORLD) - 0.5;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= N - 1 || j >= N - 1) return -70;
    const tx = fx - i, tz = fz - j;
    const h = this.heights;
    const k = j * N + i;
    const a = h[k], b = h[k + 1], c = h[k + N], d = h[k + N + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }

  /** unit normal (x, y, z) from central differences over `e` metres */
  normal(x: number, z: number, out = new THREE.Vector3(), e = 1) {
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  private maskAt(data: Uint8Array, x: number, z: number, c: number) {
    const M = this.m, cell = WORLD_SIZE / M;
    const fx = (x + HALF_WORLD) / cell - 0.5, fz = (z + HALF_WORLD) / cell - 0.5;
    const i = Math.max(0, Math.min(M - 2, Math.floor(fx))), j = Math.max(0, Math.min(M - 2, Math.floor(fz)));
    const tx = Math.min(1, Math.max(0, fx - i)), tz = Math.min(1, Math.max(0, fz - j));
    const k = (j * M + i) * 4 + c;
    const a = data[k], b = data[k + 4], cc = data[k + M * 4], d = data[k + M * 4 + 4];
    return (a + (b - a) * tx + (cc - a) * tz + (a - b - cc + d) * tx * tz) / 255;
  }

  sand(x: number, z: number) { return this.maskAt(this.mask0, x, z, 0); }
  grass(x: number, z: number) { return this.maskAt(this.mask0, x, z, 1); }
  dirt(x: number, z: number) { return this.maskAt(this.mask0, x, z, 2); }
  forest(x: number, z: number) { return this.maskAt(this.mask0, x, z, 3); }
  rock(x: number, z: number) { return this.maskAt(this.mask1, x, z, 0); }
  wet(x: number, z: number) { return this.maskAt(this.mask1, x, z, 1); }
  water(x: number, z: number) { return this.maskAt(this.mask1, x, z, 2); }
  /** the kind of the nearest coast: 0 beach .. 0.5 rock shelf .. 1 sea cliff */
  coastKind(x: number, z: number) { return this.maskAt(this.mask1, x, z, 3); }

  /** signed distance to the waterline (m), positive on land */
  shoreDist(x: number, z: number) {
    const M = this.m, cell = WORLD_SIZE / M;
    const i = Math.max(0, Math.min(M - 1, Math.floor((x + HALF_WORLD) / cell)));
    const j = Math.max(0, Math.min(M - 1, Math.floor((z + HALF_WORLD) / cell)));
    return this.shore[j * M + i];
  }

  /** nearest river sample (for the water level, flow direction and sound) */
  nearestRiver(x: number, z: number): { d: number; i: number } {
    let best = 1e9, bi = 0;
    const r = this.river;
    for (let i = 0; i < r.length; i += 1) {
      const dx = r[i].x - x, dz = r[i].z - z;
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    return { d: Math.sqrt(best), i: bi };
  }

  /** water surface height at (x, z): river/pool level if over the river, else the sea (0), or -Infinity on dry land */
  waterLevel(x: number, z: number): number {
    const { pool } = this.meta;
    const dp = Math.hypot(x - pool.p[0], z - pool.p[1]);
    if (dp < pool.r + 1) return pool.level;
    const nr = this.nearestRiver(x, z);
    const s = this.river[nr.i];
    if (nr.d < s.w / 2 + 1.2 && s.water > 0.05) return s.water;
    return 0;
  }
}
