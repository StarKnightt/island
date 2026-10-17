/**
 * Terrain shading: eight material layers from the baked masks (dry sand, wet sand, jungle floor, grass, laterite
 * trail, basalt, mossy rock, reef), height-blended, with per-pixel normals from the 1 m heightmap plus each layer's
 * detail normal, wetness (shore swash, rain, puddles), cloud shadows and caustics on the lagoon floor. The layers are
 * Poly Haven scans packed into two KTX2 texture arrays (albedo+height, normal+roughness+AO); flat colours stand in
 * until they stream in, swapped without recompiling the shader.
 */
import * as THREE from 'three/webgpu';
import {
  abs, float, max, mix, mx_noise_float, mx_fractal_noise_float, normalize, positionWorld, pow, smoothstep, texture,
  transformNormalToView, uniform, vec2, vec3, vec4, exp, int, Fn, fract, floor, hash, dFdx, dFdy, cross, dot, sign,
  length, cameraPosition, type N,
} from '../core/tsl';
import { HALF_WORLD, WORLD_SIZE } from './layout';
import type { Heightfield } from './Heightfield';
import { heightLookup } from './Terrain';
import { cloudShadow } from '../sky/Sky';
import { wetness } from './weatherUniforms';
import { loadKTX2, placeholderArray, toArray } from '../core/Assets';

/** layer order in the arrays (matches scripts/build-assets.ts TERRAIN_LAYERS) */
const LAYERS = ['sand_dry', 'sand_wet', 'jungle', 'grass', 'dirt', 'rock', 'moss', 'reef'];
/** linear target albedos, for the stand-in colours */
const TARGET = [[0.5, 0.44, 0.34], [0.25, 0.215, 0.165], [0.085, 0.065, 0.04], [0.085, 0.13, 0.035], [0.2, 0.11, 0.06], [0.055, 0.052, 0.05], [0.075, 0.085, 0.05], [0.34, 0.29, 0.21]];
/** world metres per texture repeat */
const SCALE = [3.4, 3.6, 2.8, 2.2, 2.8, 4.8, 3.4, 3.8];
const ROUGH = [0.9, 0.55, 0.92, 0.95, 0.9, 0.82, 0.85, 0.75];

const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export const terrainU = {
  time: uniform(0),
  /** highest the swash reaches above sea level (m): the top of the wet band */
  swash: uniform(0.62),
};

export function createTerrainMaterial(hf: Heightfield) {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'terrain';
  const heightAt = heightLookup(hf);
  const maskUV = (p: N) => p.add(HALF_WORLD).div(WORLD_SIZE);

  const albedoPh = placeholderArray(TARGET.map((c) => [...c.map(toSrgb), 0.5]), true);
  const normalPh = placeholderArray(ROUGH.map((r) => [0.5, 0.5, r, 1]), false);
  const albedoNodes: N[] = [];
  const normalNodes: N[] = [];
  const sampleA = (layer: number, uvL: N) => {
    const t = texture(albedoPh, uvL).depth(int(layer));
    albedoNodes.push(t);
    return t;
  };
  const sampleN = (layer: number, uvL: N) => {
    const t = texture(normalPh, uvL).depth(int(layer));
    normalNodes.push(t);
    return t;
  };

  const nrm = Fn(([xz]: N[]) => {
    const e = 1.0;
    const hl = heightAt(xz.sub(vec2(e, 0))), hr = heightAt(xz.add(vec2(e, 0)));
    const hd = heightAt(xz.sub(vec2(0, e))), hu = heightAt(xz.add(vec2(0, e)));
    return normalize(vec3(hl.sub(hr), e * 2, hd.sub(hu)));
  });

  const p = positionWorld;
  const xz = p.xz;
  const n = nrm(xz);
  const m0 = texture(hf.mask0Tex, maskUV(xz));
  const m1 = texture(hf.mask1Tex, maskUV(xz));
  const h = p.y;
  const slope = float(1).sub(n.y);
  const macro = mx_fractal_noise_float(vec3(xz.mul(1 / 70), 0.5), 3, 2, 0.5);
  const micro = mx_noise_float(vec3(xz.mul(1 / 6), 2.5));

  // ---- layer weights from the masks
  const sand = m0.x;
  const wetShore = smoothstep(terrainU.swash.add(0.45).add(macro.mul(0.12)), terrainU.swash.sub(0.15), h).mul(sand);
  // steep ground turns to rock, but not small ripples on the beach
  const rock = max(m1.x, smoothstep(0.42, 0.6, slope.add(micro.mul(0.05))).mul(float(1).sub(m0.x.mul(0.9))).mul(smoothstep(1.5, 4.0, positionWorld.y)));
  const grass = m0.y, dirt = m0.z, forest = m0.w;
  const underwater = smoothstep(0.15, -0.5, h);
  const reefN = mx_fractal_noise_float(vec3(xz.mul(1 / 24), 7.0), 3, 2, 0.5).mul(0.5).add(0.5);
  const reef = underwater.mul(smoothstep(0.42, 0.62, reefN)).mul(smoothstep(-0.9, -2.2, h)).mul(sand);
  const notRock = float(1).sub(rock);
  const wBase = float(1).sub(max(max(sand, rock), max(max(grass, dirt), forest))).clamp(0, 1);
  const ws = [
    sand.mul(float(1).sub(wetShore)).mul(float(1).sub(underwater)),
    sand.mul(max(wetShore, underwater)).mul(float(1).sub(reef)),
    forest.mul(float(1).sub(sand)).mul(notRock).add(wBase.mul(0.55)),
    grass.mul(notRock).mul(float(1).sub(sand.mul(0.8))).add(wBase.mul(0.45)),
    dirt.mul(float(1).sub(rock.mul(0.7))),
    rock.mul(float(1).sub(forest.mul(0.5))),
    rock.mul(forest.mul(0.8).add(0.1)).mul(smoothstep(170, 120, h)),
    reef,
  ];

  let albedo: N = vec3(0), rough: N = float(0), dn: N = vec2(0), aoAcc: N = float(0), total: N = float(0.0001);
  // triplanar weights for the rock layers on steep faces (no stretching down cliffs)
  const tw = pow(abs(n), vec3(4));
  const twn = tw.div(tw.x.add(tw.y).add(tw.z));
  // volcanic strata on steep rock: lava-flow bands a few metres thick, each its own shade, a recessed joint at the top
  // of each; warped so they wander like real layers (only on steep faces, or flat shelves would show contour lines)
  const steepW = smoothstep(0.32, 0.62, slope);
  const warp = mx_noise_float(vec3(xz.mul(1 / 55), 3.3)).mul(5.0).add(mx_noise_float(vec3(xz.mul(1 / 13), 1.7)).mul(1.2));
  // uneven layer thickness: the band coordinate runs faster and slower with height
  const bandC = h.add(warp).div(4.2).add(mx_noise_float(vec3(h.mul(1 / 9), 0.4, 6.1)).mul(0.6));
  const bandF = fract(bandC);
  const bandShade = hash(floor(bandC).mul(17.3).add(4.1)).mul(0.4).add(0.8);
  // joints are broken and come and go along the face
  const jointOn = smoothstep(0.42, 0.62, mx_noise_float(vec3(xz.mul(1 / 9), h.mul(1 / 6))).mul(0.5).add(0.5));
  const groove = smoothstep(0.84, 0.94, bandF).mul(smoothstep(1.0, 0.96, bandF)).mul(jointOn);
  let rockBig: N = vec4(0.5), wRock: N = float(0);
  for (let i = 0; i < LAYERS.length; i++) {
    const uvL = xz.div(SCALE[i]).add(i * 0.37);
    let tA = sampleA(i, uvL);
    let tN = sampleN(i, uvL);
    if (i === 5 || i === 6) {
      const sx = p.zy.div(SCALE[i]), sz = p.xy.div(SCALE[i]);
      tA = tA.mul(twn.y).add(sampleA(i, sx).mul(twn.x)).add(sampleA(i, sz).mul(twn.z));
      tN = tN.mul(twn.y).add(sampleN(i, sx).mul(twn.x)).add(sampleN(i, sz).mul(twn.z));
    }
    if (i === 5) {
      // the same stone at ~22 m: lighter and darker patches over whole faces, so a cliff is not one repeating tile;
      // turned on its side on walls, so its layering crosses the strata as vertical joints
      const sB = SCALE[i] * 4.6;
      rockBig = sampleA(i, xz.div(sB).add(0.71)).mul(twn.y).add(sampleA(i, p.yz.div(sB).add(0.23)).mul(twn.x)).add(sampleA(i, p.yx.div(sB).add(0.57)).mul(twn.z));
      // the arrays decode sRGB on sampling and the packer normalised each layer's mean to its linear target
      const mean = vec3(...TARGET[5]);
      const patch = mix(vec3(1), rockBig.rgb.div(mean), 0.6);
      const strata = mix(float(1), bandShade.mul(float(1).sub(groove.mul(0.28))), steepW);
      // walls: dark runoff streaks (narrow across, long down the face) and broad lighter and darker reaches
      const along = p.x.add(p.z);
      const streak = smoothstep(0.15, 0.65, mx_noise_float(vec3(along.mul(0.32), h.mul(0.022), 2.2)).mul(0.5).add(0.5).mul(
        mx_noise_float(vec3(along.mul(0.07), h.mul(0.01), 5.1)).mul(0.6).add(0.7)));
      const reach = mx_noise_float(vec3(along.mul(1 / 38), h.mul(1 / 30), 8.3)).mul(0.25).add(1);
      const streakTint = mix(vec3(0.58, 0.62, 0.55), vec3(1), float(1).sub(streak));
      const wall = mix(vec3(1), streakTint.mul(reach), steepW);
      tA = vec4(tA.rgb.mul(patch).mul(strata).mul(wall), mix(tA.a, rockBig.a, 0.5));
    }
    // height blend: each layer's height sharpens its edges against the others
    const w = max(ws[i], 0).mul(tA.a.mul(1.4).add(0.3)).pow(2.2);
    if (i === 5) wRock = w;
    albedo = albedo.add(tA.rgb.mul(w));
    rough = rough.add(tN.z.mul(w));
    dn = dn.add(tN.xy.mul(2).sub(1).mul(w));
    aoAcc = aoAcc.add(tN.w.mul(w));
    total = total.add(w);
  }
  albedo = albedo.div(total);
  rough = rough.div(total);
  dn = dn.div(total);
  const ao = aoAcc.div(total);
  // macro variation breaks the tiling
  albedo = albedo.mul(macro.mul(0.16).add(1)).mul(vec3(1.0, mix(1.0, 1.05, macro.mul(0.5).add(0.5)), 1.0));

  // ---- wetness: shore swash, rain on upward faces, the river banks; darker and glossier
  const rainWet = wetness.rain.mul(smoothstep(0.3, 0.9, n.y));
  const wet = max(max(wetShore, rainWet), m1.y.mul(0.65)).clamp(0, 1);
  albedo = albedo.mul(mix(float(1), float(0.58), wet.mul(float(1).sub(underwater.mul(0.6)))));
  rough = mix(rough, float(0.4), wet.mul(0.8));
  const puddle = wetness.rain.mul(smoothstep(0.58, 0.74, mx_noise_float(vec3(xz.mul(1 / 4.5), 1.3)).mul(0.5).add(0.5)))
    .mul(smoothstep(0.975, 0.995, n.y)).mul(float(1).sub(sand.mul(0.7)));
  rough = mix(rough, float(0.03), puddle);
  albedo = mix(albedo, albedo.mul(0.55), puddle);

  // ---- normal: heightmap normal + layer detail (flattened in puddles)
  const flat = float(1).sub(puddle);
  const detailN = normalize(vec3(n.x.add(dn.x.mul(flat).mul(0.9)), n.y, n.z.sub(dn.y.mul(flat).mul(0.9))));
  // relief on rock faces the 1 m heightmap cannot carry: the large-scale stone height and the strata joints as a bump
  // (surface-gradient bump mapping from screen derivatives, faded out before it would alias in the distance)
  const reliefH = rockBig.a.mul(1.5).sub(groove.mul(0.35).mul(steepW));
  const dpx = dFdx(p), dpy = dFdy(p);
  const r1 = cross(dpy, detailN), r2 = cross(detailN, dpx);
  const det = dot(dpx, r1);
  const grad = sign(det).mul(r1.mul(dFdx(reliefH)).add(r2.mul(dFdy(reliefH))));
  const bumped = normalize(abs(det).mul(detailN).sub(grad).add(detailN.mul(1e-6)));
  const camDist = length(cameraPosition.sub(p));
  const bumpW = wRock.div(total).mul(smoothstep(160, 40, camDist)).clamp(0, 1);
  const finalN = normalize(mix(detailN, bumped, bumpW));

  // ---- caustics on the lagoon floor
  const depthW = max(float(0).sub(h), 0);
  const ct = terrainU.time.mul(0.55);
  const c1 = mx_noise_float(vec3(xz.mul(0.95), ct));
  const c2 = mx_noise_float(vec3(xz.mul(0.95).add(13.1), ct.mul(1.13).add(4)));
  const caustic = pow(max(float(1).sub(abs(c1.sub(c2))), 0), 9).mul(smoothstep(0.1, 1.0, depthW)).mul(exp(depthW.mul(-0.25))).mul(1.3);
  const cloud = cloudShadow(p);

  m.colorNode = vec4(albedo.mul(float(1).add(caustic.mul(cloud))).mul(mix(float(0.62), float(1), cloud)), 1);
  m.roughnessNode = rough;
  m.metalnessNode = float(0);
  m.normalNode = transformNormalToView(finalN);
  m.aoNode = mix(float(1), ao, 0.7);

  /** stream the real layers in and swap them under the compiled shader */
  const loadLayers = async () => {
    const [albedos, normals] = await Promise.all([
      Promise.all(LAYERS.map((l) => loadKTX2(`assets/terrain/${l}_a.ktx2`))),
      Promise.all(LAYERS.map((l) => loadKTX2(`assets/terrain/${l}_n.ktx2`))),
    ]);
    const A = toArray(albedos, true), Nn = toArray(normals, false);
    for (const t of albedoNodes) t.value = A;
    for (const t of normalNodes) t.value = Nn;
  };
  return { material: m, loadLayers };
}
