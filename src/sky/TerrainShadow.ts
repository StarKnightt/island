/**
 * The island's own shadow at a low sun or moon, beyond the reach of the cascades: the summit's shadow laid across the
 * jungle at sunset, the beach in the lee of the hills, ridges throwing long soft shadows down their valleys, and the
 * forest floor in the shade of its own canopy when the sun comes in sideways.
 *
 * For every point of a 512^2 grid over the 2 km tile, the bake marches the heightfield toward the light and keeps
 * - the height above which the light clears every ridge, S = max_t (terrain(x + t d) - t tan(elevation)), and the
 *   distance of the ridge that sets it: a receiver at height y is lit when y > S (exact for anything standing on the
 *   ground: the crowns of a valley's trees catch the last sun while its floor is in shade), with a penumbra that
 *   widens with the distance to the ridge;
 * - the optical depth of leaves that a ray from the ground there crosses inside the forest (forest mask, a 22 m
 *   canopy with a leaf area index of 4) and the canopy top: at a low sun the light reaches the forest floor only at
 *   clearings and along the edges that face it, whatever shadow casters the camera's culling has left out.
 * Re-rendered on the GPU when the light has moved; faded out once the light is high (the cascades have it then).
 */
import * as THREE from 'three/webgpu';
import { Break, Fn, If, Loop, exp, float, mix, smoothstep, texture, uniform, uv, vec2, vec4, type N } from '../core/tsl';
import { HALF_WORLD, H_MAX, WORLD_SIZE } from '../world/layout';

const RES = 512;
const STEPS = 96;
/** the march: from 1.5 texels out to 3 km, steps growing quadratically (7 m at 50 m out, 60 m at the far end) */
const T0 = 1.5 * (WORLD_SIZE / RES), T_MAX = 3000;
const CANOPY_H = 22;
/** leaf extinction per metre of path through a full canopy: G (0.5) x LAI (4) / canopy height */
const LEAF_K = (0.5 * 4) / CANOPY_H;

export const terrainShadowRT = new THREE.RenderTarget(RES, RES, { type: THREE.HalfFloatType, depthBuffer: false });
terrainShadowRT.texture.minFilter = THREE.LinearFilter;
terrainShadowRT.texture.magFilter = THREE.LinearFilter;
terrainShadowRT.texture.wrapS = terrainShadowRT.texture.wrapT = THREE.ClampToEdgeWrapping;
terrainShadowRT.texture.generateMipmaps = false;

const tsU = {
  /** horizontal unit vector toward the light, tan of its elevation */
  dir: uniform(new THREE.Vector2(1, 0)),
  tanEl: uniform(0.1),
  /** 0..1: how much of the baked shadow applies (0 until the first bake and with a high light) */
  on: uniform(0),
  /** 0..1: the canopy's own shade, only with the light low */
  canopy: uniform(0),
};

let quad: THREE.QuadMesh | null = null;
const last = new THREE.Vector3(0, -2, 0);
let age = 1e9;
/** frames left to repeat the latest bake: a draw whose pipeline is still compiling is skipped */
let again = 0;

/** build the bake from the heightfield's texture and the masks (forest in mask0's alpha), once at start-up */
export function initTerrainShadow(heightTex: THREE.Texture, mask0Tex: THREE.Texture) {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = Fn(() => {
    const p0 = uv().mul(WORLD_SIZE).sub(HALF_WORLD);
    const toUV = (xz: N) => xz.add(HALF_WORLD).div(WORLD_SIZE);
    const heightAt = (xz: N) => texture(heightTex, toUV(xz)).level(0).r;
    const y0 = heightAt(p0).toVar();
    const top0 = y0.add(texture(mask0Tex, toUV(p0)).level(0).a.mul(CANOPY_H));
    const S = float(-1e4).toVar();
    const D = float(0).toVar();
    const od = float(0).toVar();
    const tPrev = float(0).toVar();
    Loop(STEPS, ({ i }: { i: N }) => {
      const f = float(i).add(1).div(STEPS);
      const t = f.mul(f).mul(T_MAX - T0).add(T0).toVar();
      const rise = t.mul(tsU.tanEl);
      // nothing farther out can rise above the line any more (nor hold leaves above it)
      If(float(H_MAX).sub(rise).lessThan(S), () => {
        Break();
      });
      const q = p0.add(vec2(tsU.dir).mul(t));
      const g = heightAt(q).toVar();
      const s = g.sub(rise).toVar();
      If(s.greaterThan(S), () => {
        S.assign(s);
        D.assign(t);
      });
      // leaves along the ray from the ground here, while it is inside the canopy layer
      const forest = texture(mask0Tex, toUV(q)).level(0).a;
      const yr = y0.add(rise);
      const inside = yr.greaterThan(g).and(yr.lessThan(g.add(forest.mul(CANOPY_H))));
      od.addAssign(inside.select(forest.mul(LEAF_K).mul(t.sub(tPrev)), float(0)));
      tPrev.assign(t);
    });
    return vec4(S, D, od, top0);
  })();
  quad = new THREE.QuadMesh(m);
}

/**
 * Per frame: re-bake when the light (sun by day, moon by night) has moved by a fifth of a degree, or every few
 * seconds while it moves slowly. `lightDir` is the unit direction toward the light.
 */
export function updateTerrainShadow(renderer: THREE.WebGPURenderer, lightDir: THREE.Vector3, dt: number, force = false) {
  if (!quad) return;
  age += dt;
  const el = Math.asin(THREE.MathUtils.clamp(lightDir.y, -1, 1));
  // with the light high the hills' shadows are short and the cascades have them
  const on = 1 - THREE.MathUtils.smoothstep(el, 0.45, 0.6);
  const active = on > 0 && el >= -0.02;
  const moved = lightDir.angleTo(last) > 0.0035;
  // a forced update (the first frame, before pipelines compile asynchronously) always bakes, whatever the light
  const bake = force || (active && ((moved && age > 0.25) || (age > 4 && lightDir.angleTo(last) > 0.0005)));
  if (bake) again = 2;
  if (bake || again > 0) {
    if (!bake) again--;
    age = 0;
    last.copy(lightDir);
    const h = Math.hypot(lightDir.x, lightDir.z) || 1;
    (tsU.dir.value as THREE.Vector2).set(lightDir.x / h, lightDir.z / h);
    // (a light right on the horizon would cast endless shadows: the march stops at 3 km anyway)
    tsU.tanEl.value = Math.max(Math.tan(el), 0.012);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(terrainShadowRT);
    quad.render(renderer);
    renderer.setRenderTarget(prev);
  }
  tsU.on.value = active ? on : 0;
  // the canopy's shade beyond the cascades matters only while the sun comes in low (its casters lie far off-screen)
  tsU.canopy.value = 1 - THREE.MathUtils.smoothstep(el, 0.12, 0.35);
}

/** 1 = lit, 0 = in the island's shadow, for a world position */
export const terrainShadowAt = Fn(([worldPos]: N[]) => {
  const uvT = worldPos.xz.add(HALF_WORLD).div(WORLD_SIZE);
  const sd = texture(terrainShadowRT.texture, uvT).level(0);
  // penumbra from the ridge's distance (about twice the sun's own, for the haze and the 4 m grid), a small bias
  // against the grid's own bumps on open ground
  const w = sd.y.mul(0.006).add(0.5);
  const ridge = smoothstep(sd.x.sub(w), sd.x.add(w), worldPos.y.add(0.3));
  // under the canopy: the leaves a ray from the floor crosses, fewer the higher the receiver stands in the crowns
  const depth = sd.w.sub(worldPos.y).div(CANOPY_H).clamp(0, 1);
  const leaves = exp(sd.z.mul(depth.mul(depth)).mul(tsU.canopy).negate());
  const inside = uvT.x.greaterThan(0.002).and(uvT.x.lessThan(0.998)).and(uvT.y.greaterThan(0.002)).and(uvT.y.lessThan(0.998));
  return mix(float(1), ridge.mul(leaves), tsU.on.mul(inside.select(float(1), float(0))));
});
