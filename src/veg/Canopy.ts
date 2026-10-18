/**
 * The far jungle canopy: a shell over every forested part of the island, lifted to crown height and broken into
 * crowns, drawn only beyond the range of the real trees (with a dithered hand-over), so from the lighthouse or the
 * hills the whole island reads as continuous rainforest. Shading: leafy greens with sun-facing crown tops, dark gaps
 * between crowns, and the same cloud shadows as the ground.
 *
 * The crown field (height, relief, gaps, tint: Worley cells and fbm) depends on the map position only, so it is
 * baked once at load into a 1 m texture: the shell reads a few texels where it would evaluate a dozen noises per
 * pixel and per vertex.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, attribute, cameraPosition, float, length, mix, mx_noise_float, mx_worley_noise_float, mx_fractal_noise_float,
  normalize, positionWorld, smoothstep, texture, transformNormalToView, uv, vec2, vec3, vec4, varying, hash, floor,
  screenCoordinate, Discard, If, uniform, select, type N,
} from '../core/tsl';
import type { Heightfield } from '../world/Heightfield';
import { HALF_WORLD, WORLD_SIZE } from '../world/layout';
import { heightLookup } from '../world/Terrain';
import { wetness } from '../world/weatherUniforms';
import { sunLit } from '../core/lighting';
import { atmo } from '../sky/Atmosphere';

export const canopyU = { near: uniform(285), band: uniform(60) };

const BAKE = 2048;
/** stored ranges: crown height above the ground (m), crown relief (m) */
const H_MAX = 36, RELIEF_LO = -0.6, RELIEF_SPAN = 6;

/** the crown field over the whole map: R crown height, G crown relief, B gap between crowns, A tint */
function bakeCrowns(hf: Heightfield, renderer: THREE.WebGPURenderer) {
  const rt = new THREE.RenderTarget(BAKE, BAKE, { depthBuffer: false });
  rt.texture.minFilter = THREE.LinearFilter;
  rt.texture.magFilter = THREE.LinearFilter;
  rt.texture.generateMipmaps = false;
  rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = Fn(() => {
    const xz = uv().mul(WORLD_SIZE).sub(HALF_WORLD);
    const f = texture(hf.mask0Tex, uv()).level(0).w;
    const big = mx_fractal_noise_float(vec3(xz.mul(1 / 160), 0.7), 2, 2, 0.5).mul(0.5).add(0.5);
    const mid = mx_noise_float(vec3(xz.mul(1 / 24), 2.1)).mul(0.5).add(0.5);
    const w = mx_worley_noise_float(xz.mul(1 / 9.5)).clamp(0, 1);
    const h = float(13).add(big.mul(12)).add(mid.mul(4)).add(float(1).sub(w).mul(3.5)).mul(smoothstep(0.08, 0.5, f));
    const relief = float(1).sub(w).pow(0.7).mul(4.5).add(mx_noise_float(vec3(xz.mul(0.45), 4.4)).mul(0.6));
    const tint = mx_fractal_noise_float(vec3(xz.mul(1 / 70), 3.3), 3, 2, 0.5).mul(0.5).add(0.5);
    return vec4(h.div(H_MAX), relief.sub(RELIEF_LO).div(RELIEF_SPAN), smoothstep(0.55, 0.95, w), tint);
  })();
  const quad = new THREE.QuadMesh(m);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  quad.render(renderer);
  renderer.setRenderTarget(prev);
  return rt.texture;
}

export function buildCanopy(hf: Heightfield, renderer: THREE.WebGPURenderer) {
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

  const crowns = bakeCrowns(hf, renderer);
  const field = (xz: N) => texture(crowns, xz.add(HALF_WORLD).div(WORLD_SIZE));
  const m = sunLit(new THREE.MeshPhysicalNodeMaterial());
  m.name = 'canopy_shell';
  const heightAt = heightLookup(hf);
  const forestTex = (xz: N) => texture(hf.mask0Tex, xz.add(HALF_WORLD).div(WORLD_SIZE)).level(0).w;
  // the crowns' top surface at a map position
  const top = (xz: N) => field(xz).level(0).r.mul(H_MAX).add(heightAt(xz));
  const vNormal = varying(vec3(0, 1, 0), 'vCanopyN');
  m.positionNode = Fn(() => {
    const p = attribute('position', 'vec3');
    const xz = p.xz;
    const e = 3.0;
    const hx = top(xz.add(vec2(e, 0))), hx2 = top(xz.sub(vec2(e, 0)));
    const hz = top(xz.add(vec2(0, e))), hz2 = top(xz.sub(vec2(0, e)));
    vNormal.assign(normalize(vec3(hx2.sub(hx), e * 2, hz2.sub(hz))));
    // tuck the shell into the ground where the forest ends
    const shell = vec3(xz.x, top(xz).sub(smoothstep(0.3, 0.05, forestTex(xz)).mul(3)), xz.y);
    // well inside the hand-over distance the shell is never seen: collapse it onto the camera, so those triangles
    // have no area and cost no fragments (the ones crossing the line are slivers inside the dithered-out band)
    return select(length(shell.sub(cameraPosition)).lessThan(canopyU.near.sub(25)), cameraPosition, shell);
  })();
  const p = positionWorld;
  const dist = length(p.sub(cameraPosition));
  // hand-over to the real trees: dithered fade-in beyond their range
  const dither = hash(floor(screenCoordinate.xy).dot(vec2(1, 113.7)));
  const fadeIn = smoothstep(canopyU.near, canopyU.near.add(canopyU.band), dist);
  const here = field(p.xz);
  m.colorNode = Fn(() => {
    If(fadeIn.lessThan(dither), () => {
      Discard();
    });
    const xz = p.xz;
    const leaf = mx_noise_float(vec3(xz.mul(1.3), 1.1)).mul(0.5).add(0.5);
    const base = mix(vec3(0.03, 0.07, 0.018), vec3(0.06, 0.105, 0.022), here.a).mul(mix(float(0.8), float(1.2), leaf));
    // a few flowering / yellowing crowns
    // (hash seeds must stay positive: a negative one clamps to 0 and the whole west of the island would match)
    const odd = smoothstep(0.82, 0.9, hash(floor(xz.div(11)).add(200).dot(vec2(1, 57.3))));
    const col = mix(base, vec3(0.13, 0.12, 0.04), odd.mul(0.6)).mul(mix(float(1), float(0.35), here.b)).mul(mix(float(1), float(0.75), wetness.rain));
    return vec4(col, 1);
  })();
  // per-pixel crown relief: the gradient of the baked relief tilts the normal over each crown
  const texel = WORLD_SIZE / BAKE;
  const c0 = here.g.mul(RELIEF_SPAN);
  const gx = field(p.xz.add(vec2(texel, 0))).g.mul(RELIEF_SPAN).sub(c0).div(texel);
  const gz = field(p.xz.add(vec2(0, texel))).g.mul(RELIEF_SPAN).sub(c0).div(texel);
  m.normalNode = transformNormalToView(normalize(vNormal.add(vec3(gx.negate(), 0, gz.negate()).mul(0.85))));
  m.roughnessNode = float(0.75);
  m.metalnessNode = float(0);
  // crowns are leaf volumes that mostly mirror one another: under an overcast little of the bright sky's sheen
  // (glb.ts skyVisibility, the same for the far trees)
  m.specularIntensityNode = float(1).sub(atmo.overcast.mul(0.7));
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
