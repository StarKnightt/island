/**
 * The far jungle canopy: a shell over every forested part of the island, lifted to crown height and broken into
 * crowns, drawn only beyond the range of the real trees (with a dithered hand-over), so from the lighthouse or the
 * hills the whole island reads as continuous rainforest. Shading: leafy greens with sun-facing crown tops, dark gaps
 * between crowns, and the same cloud shadows as the ground.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, attribute, cameraPosition, float, length, mix, mx_noise_float, mx_worley_noise_float, mx_fractal_noise_float,
  normalize, positionWorld, smoothstep, texture, transformNormalToView, vec2, vec3, vec4, varying, hash, floor,
  screenCoordinate, Discard, If, uniform, select, type N,
} from '../core/tsl';
import type { Heightfield } from '../world/Heightfield';
import { HALF_WORLD, WORLD_SIZE } from '../world/layout';
import { heightLookup } from '../world/Terrain';
import { cloudShadow } from '../sky/Sky';
import { wetness } from '../world/weatherUniforms';

export const canopyU = { near: uniform(285), band: uniform(60) };

export function buildCanopy(hf: Heightfield) {
  const CELLS = 512;
  const step = WORLD_SIZE / CELLS;
  const pos: number[] = [];
  const idx: number[] = [];
  const vid = new Int32Array((CELLS + 1) * (CELLS + 1)).fill(-1);
  const forestAt = (x: number, z: number) => hf.forest(x, z);
  // vertices only where the forest is (plus a ring so edges taper)
  for (let j = 0; j <= CELLS; j++) for (let i = 0; i <= CELLS; i++) {
    const x = -HALF_WORLD + i * step, z = -HALF_WORLD + j * step;
    let f = 0;
    for (const [dx, dz] of [[0, 0], [step, 0], [-step, 0], [0, step], [0, -step]]) f = Math.max(f, forestAt(x + dx, z + dz));
    if (f < 0.08) continue;
    vid[j * (CELLS + 1) + i] = pos.length / 3;
    pos.push(x, 0, z);
  }
  for (let j = 0; j < CELLS; j++) for (let i = 0; i < CELLS; i++) {
    const a = vid[j * (CELLS + 1) + i], b = vid[j * (CELLS + 1) + i + 1], c = vid[(j + 1) * (CELLS + 1) + i], d = vid[(j + 1) * (CELLS + 1) + i + 1];
    if (a < 0 || b < 0 || c < 0 || d < 0) continue;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 60, 0), 1500);

  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'canopy_shell';
  const heightAt = heightLookup(hf);
  const forestTex = (xz: N) => texture(hf.mask0Tex, xz.add(HALF_WORLD).div(WORLD_SIZE)).level(0).w;
  // crown height above ground: forest density, large-scale variation, crowns
  const crown = (xz: N) => {
    const f = forestTex(xz);
    const big = mx_fractal_noise_float(vec3(xz.mul(1 / 160), 0.7), 2, 2, 0.5).mul(0.5).add(0.5);
    const mid = mx_noise_float(vec3(xz.mul(1 / 24), 2.1)).mul(0.5).add(0.5);
    const cells = float(1).sub(mx_worley_noise_float(xz.mul(1 / 9.5)).clamp(0, 1));
    const h = float(13).add(big.mul(12)).add(mid.mul(4)).add(cells.mul(3.5));
    return h.mul(smoothstep(0.08, 0.5, f));
  };
  const vNormal = varying(vec3(0, 1, 0), 'vCanopyN');
  m.positionNode = Fn(() => {
    const p = attribute('position', 'vec3');
    const xz = p.xz;
    const hc = crown(xz);
    const e = 3.0;
    const hx = crown(xz.add(vec2(e, 0))).add(heightAt(xz.add(vec2(e, 0)))), hx2 = crown(xz.sub(vec2(e, 0))).add(heightAt(xz.sub(vec2(e, 0))));
    const hz = crown(xz.add(vec2(0, e))).add(heightAt(xz.add(vec2(0, e)))), hz2 = crown(xz.sub(vec2(0, e))).add(heightAt(xz.sub(vec2(0, e))));
    vNormal.assign(normalize(vec3(hx2.sub(hx), e * 2, hz2.sub(hz))));
    const ground = heightAt(xz);
    // tuck the shell into the ground where the forest ends
    const shell = vec3(xz.x, ground.add(hc).sub(smoothstep(0.3, 0.05, forestTex(xz)).mul(3)), xz.y);
    // well inside the hand-over distance the shell is never seen: collapse it onto the camera, so those triangles
    // have no area and cost no fragments (the ones crossing the line are slivers inside the dithered-out band)
    return select(length(shell.sub(cameraPosition)).lessThan(canopyU.near.sub(25)), cameraPosition, shell);
  })();
  const p = positionWorld;
  const dist = length(p.sub(cameraPosition));
  // hand-over to the real trees: dithered fade-in beyond their range
  const dither = hash(floor(screenCoordinate.xy).dot(vec2(1, 113.7)));
  const fadeIn = smoothstep(canopyU.near, canopyU.near.add(canopyU.band), dist);
  m.colorNode = Fn(() => {
    If(fadeIn.lessThan(dither), () => {
      Discard();
    });
    const xz = p.xz;
    const w = mx_worley_noise_float(xz.mul(1 / 9.5)).clamp(0, 1);
    const gap = smoothstep(0.55, 0.95, w);
    const tint = mx_fractal_noise_float(vec3(xz.mul(1 / 70), 3.3), 3, 2, 0.5).mul(0.5).add(0.5);
    const leaf = mx_noise_float(vec3(xz.mul(1.3), 1.1)).mul(0.5).add(0.5);
    const base = mix(vec3(0.03, 0.07, 0.018), vec3(0.06, 0.105, 0.022), tint).mul(mix(float(0.8), float(1.2), leaf));
    // a few flowering / yellowing crowns
    const odd = smoothstep(0.82, 0.9, hash(floor(xz.div(11)).dot(vec2(1, 57.3))));
    const col = mix(base, vec3(0.13, 0.12, 0.04), odd.mul(0.6)).mul(mix(float(1), float(0.35), gap)).mul(mix(float(1), float(0.75), wetness.rain));
    return vec4(col.mul(mix(float(0.6), float(1), cloudShadow(p))), 1);
  })();
  // per-pixel crown relief: the gradient of the crown field tilts the normal over each crown
  const crownF = (xz: N) => float(1).sub(mx_worley_noise_float(xz.mul(1 / 9.5)).clamp(0, 1)).pow(0.7).mul(4.5)
    .add(mx_noise_float(vec3(xz.mul(0.45), 4.4)).mul(0.6));
  const e = 0.8;
  const c0 = crownF(p.xz);
  const gx = crownF(p.xz.add(vec2(e, 0))).sub(c0).div(e);
  const gz = crownF(p.xz.add(vec2(0, e))).sub(c0).div(e);
  m.normalNode = transformNormalToView(normalize(vNormal.add(vec3(gx.negate(), 0, gz.negate()).mul(0.85))));
  m.roughnessNode = float(0.75);
  m.metalnessNode = float(0);
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'canopy';
  mesh.frustumCulled = false;
  // after the terrain and the trees, so the depth test rejects every shell pixel they already cover (its bounding
  // sphere sits at the island's centre and would otherwise sort it first, shading the whole hidden shell)
  mesh.renderOrder = 2;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  console.log(`[island] canopy shell: ${(pos.length / 3).toFixed(0)} vertices, ${(idx.length / 3).toFixed(0)} triangles`);
  return mesh;
}
