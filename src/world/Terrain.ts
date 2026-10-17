/**
 * Terrain: CDLOD (Strugar 2009). A quadtree over the 2048 m heightmap; every selected node draws the same 32x32 grid,
 * instanced, its vertices displaced by the heightmap in the vertex shader and morphed toward the parent grid near the
 * end of each LOD range, so neighbouring levels meet without cracks or pops. Per-pixel normals come from the
 * heightmap, so distant low-detail nodes still shade with 1 m detail.
 */
import * as THREE from 'three/webgpu';
import { Fn, attribute, cameraPosition, float, floor, fract, int, mix, uniformArray, vec2, vec3, vec4, texture, clamp, type N } from '../core/tsl';
import { HALF_WORLD, WORLD_SIZE } from './layout';
import type { Heightfield } from './Heightfield';
import { Q } from '../core/quality';

const GRID = 32;
const LEAF = 16; // metres
const LEVELS = 8; // 16 m .. 2048 m nodes

/** the terrain's height texture lookup (world xz -> metres), shared with other shaders */
export function heightLookup(hf: Heightfield) {
  return Fn(([xz]: N[]) => {
    const uvh = xz.add(HALF_WORLD).div(WORLD_SIZE);
    return texture(hf.heightTex, uvh).level(0).r;
  });
}

interface TNode { x: number; z: number; size: number; lod: number; minH: number; maxH: number }

export class Terrain {
  readonly mesh: THREE.Mesh;
  private geometry: THREE.InstancedBufferGeometry;
  private nodeAttr: THREE.InstancedBufferAttribute;
  private ranges: number[] = [];
  private minMax: Float32Array[] = [];
  private morphU: N;
  readonly heightAt: N;
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private box = new THREE.Box3();
  selected = 0;

  constructor(private hf: Heightfield, material: THREE.NodeMaterial) {
    const plane = new THREE.PlaneGeometry(1, 1, GRID, GRID);
    plane.rotateX(-Math.PI / 2);
    plane.translate(0.5, 0, 0.5);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.setAttribute('position', plane.getAttribute('position'));
    this.nodeAttr = new THREE.InstancedBufferAttribute(new Float32Array(4096 * 4), 4);
    this.nodeAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('nodeData', this.nodeAttr);
    g.instanceCount = 0;
    this.geometry = g;

    // LOD ranges: level 0 covers the nearest ~45 m, each level doubles
    const base = 48 * Q.lodScale;
    for (let i = 0; i < LEVELS; i++) this.ranges.push(base * Math.pow(2, i));
    const morph: THREE.Vector2[] = [];
    for (let i = 0; i < LEVELS; i++) {
      const end = this.ranges[i];
      const start = (i > 0 ? this.ranges[i - 1] : 0) + (end - (i > 0 ? this.ranges[i - 1] : 0)) * 0.6;
      morph.push(new THREE.Vector2(start, end * 0.98));
    }
    this.morphU = uniformArray(morph, 'vec2');

    this.heightAt = heightLookup(hf);
    this.buildMinMax();

    const nodeData = attribute('nodeData', 'vec4');
    const heightAt = this.heightAt;
    const morphU = this.morphU;
    material.positionNode = Fn(() => {
      const local = attribute('position', 'vec3');
      const g0 = local.xz.mul(GRID);
      const size = nodeData.z;
      const xz0 = nodeData.xy.add(g0.mul(size.div(GRID)));
      const h0 = heightAt(xz0);
      const dist = vec3(xz0.x, h0, xz0.y).sub(cameraPosition).length();
      const mr = morphU.element(int(nodeData.w));
      const k = clamp(dist.sub(mr.x).div(mr.y.sub(mr.x)), 0, 1);
      const odd = fract(g0.mul(0.5)).mul(2);
      const g1 = g0.sub(odd.mul(k));
      const xz = nodeData.xy.add(g1.mul(size.div(GRID)));
      const h = heightAt(xz);
      return vec3(xz.x, h, xz.y);
    })();
    void floor;
    void mix;
    void vec2;
    void vec4;
    void float;

    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'terrain';
  }

  /** min/max height per node, every level (for culling and LOD distance) */
  private buildMinMax() {
    const N = this.hf.n;
    const h = this.hf.heights;
    // level 0 = 16 m nodes: 128x128
    let res = WORLD_SIZE / LEAF;
    let mm = new Float32Array(res * res * 2);
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      let lo = 1e9, hi = -1e9;
      const step = LEAF;
      for (let b = 0; b <= step; b += 2) for (let a = 0; a <= step; a += 2) {
        const x = Math.min(N - 1, i * step + a), z = Math.min(N - 1, j * step + b);
        const v = h[z * N + x];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      mm[(j * res + i) * 2] = lo;
      mm[(j * res + i) * 2 + 1] = hi;
    }
    this.minMax.push(mm);
    for (let l = 1; l < LEVELS; l++) {
      const pr = res;
      res = res / 2;
      const prev = mm;
      mm = new Float32Array(res * res * 2);
      for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
        let lo = 1e9, hi = -1e9;
        for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) {
          const k = ((j * 2 + b) * pr + i * 2 + a) * 2;
          lo = Math.min(lo, prev[k]);
          hi = Math.max(hi, prev[k + 1]);
        }
        mm[(j * res + i) * 2] = lo;
        mm[(j * res + i) * 2 + 1] = hi;
      }
      this.minMax.push(mm);
    }
  }

  /** per frame: choose quadtree nodes for this camera */
  update(camera: THREE.PerspectiveCamera, shadowFar: number) {
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView, THREE.WebGPUCoordinateSystem);
    const out: TNode[] = [];
    const cam = camera.position;
    const top = LEVELS - 1;
    const rootSize = LEAF * Math.pow(2, top);
    const visit = (i: number, j: number, lod: number) => {
      const size = LEAF * Math.pow(2, lod);
      const x = -HALF_WORLD + i * size, z = -HALF_WORLD + j * size;
      const res = WORLD_SIZE / size;
      const mm = this.minMax[lod];
      const lo = mm[(j * res + i) * 2], hi = mm[(j * res + i) * 2 + 1];
      this.box.min.set(x, lo - 1, z);
      this.box.max.set(x + size, hi + 1, z + size);
      // distance from the camera to the node's box
      const dx = Math.max(x - cam.x, 0, cam.x - (x + size));
      const dz = Math.max(z - cam.z, 0, cam.z - (z + size));
      const dy = Math.max(lo - cam.y, 0, cam.y - hi);
      const dist = Math.hypot(dx, dy, dz);
      // near nodes always kept (they cast shadows into view); farther ones frustum-culled
      if (dist > shadowFar && !this.frustum.intersectsBox(this.box)) return;
      // entirely under deep water and far away: skip
      if (hi < -30 && dist > 200) return;
      if (lod === 0 || dist > this.ranges[lod - 1]) {
        out.push({ x, z, size, lod, minH: lo, maxH: hi });
        return;
      }
      for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) visit(i * 2 + a, j * 2 + b, lod - 1);
    };
    void rootSize;
    visit(0, 0, top);
    const arr = this.nodeAttr.array as Float32Array;
    const n = Math.min(out.length, arr.length / 4);
    for (let k = 0; k < n; k++) {
      const o = out[k];
      arr[k * 4] = o.x;
      arr[k * 4 + 1] = o.z;
      arr[k * 4 + 2] = o.size;
      arr[k * 4 + 3] = o.lod;
    }
    this.nodeAttr.needsUpdate = true;
    this.nodeAttr.clearUpdateRanges();
    this.nodeAttr.addUpdateRange(0, n * 4);
    this.geometry.instanceCount = n;
    this.selected = n;
  }
}
