/**
 * The hero's materials. Both lighting models extend three's physical model, so the sun or moon, the lamps, the shadow
 * maps and the environment light the hero exactly as they light the island; only the response differs:
 *
 *   hair  the cards are lit as a strand volume: a wrapped diffuse (light passes through hair), two Kajiya-Kay
 *         highlights along the strands (a near-white primary, a hair-coloured secondary toward the roots), little
 *         sky reflection (hair shadows itself), darker roots, and dithered coverage that the temporal AA resolves
 *         into soft fringes (shadows keep a stable cut-out)
 *   skin  a red-tinted band where light wraps past the terminator, sky light warmed a little by scattering, a
 *         satin sheen; the painted scalp hair is near-matte, the eyes are wet (sharp highlights)
 *
 * Wet (swimming, rain): everything darker, hair and skin glossier.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TSL = TSLTyped as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
const {
  float, vec3, vec4, mix, max, saturate, pow, sqrt, dot, normalize, smoothstep, texture, uv, uniform, varying,
  modelViewMatrix, tangentLocal, normalView, normalViewGeometry, positionViewDirection, diffuseColor, attribute,
  interleavedGradientNoise, screenCoordinate, luminance, specularColor, specularColorBlended, specularF90, reflect,
} = TSL;

export const heroU = {
  /** 0 dry .. 1 soaked */
  wet: uniform(0),
  /** frame counter: the hair dither changes every frame so the temporal AA averages it into coverage */
  frame: uniform(0),
  /** extra irradiance on the hero's shaded side at night (moon-lit sky fill), set per frame by the player */
  fill: uniform(new THREE.Color(0, 0, 0)),
};

const INV_PI = 1 / Math.PI;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PhysicalLightingModel = (THREE as any).PhysicalLightingModel as new () => {
  direct(data: N, builder: N): void;
  indirectDiffuse(builder: N): void;
  indirectSpecular(builder: N): void;
};

// ---------------------------------------------------------------------------------------------------- hair

interface HairNodes {
  /** strand direction in view space (not flipped on back faces: the cards are lit as one volume) */
  strand: N;
  /** 0 at the scalp .. 1 on the outer layer */
  depth: N;
  /** hair colour normalised to unit luminance, for the secondary highlight */
  tint: N;
  /** 0 in the gaps between strands of the texture .. 1 on a strand; and a per-strand shift of the highlights */
  strandMask: N;
  jitter: N;
}

class HairLighting extends PhysicalLightingModel {
  constructor(private h: HairNodes) {
    super();
  }

  direct({ lightDirection, lightColor, reflectedLight }: N) {
    const n = normalView, v = positionViewDirection, l = lightDirection;
    const ndl = dot(n, l);
    const ao = mix(float(0.45), float(1), this.h.depth);
    // light scatters through the hair: a wrapped Lambert, with a little transmission on the far side
    const wrap = saturate(ndl.add(0.35).div(1.35));
    reflectedLight.directDiffuse.addAssign(lightColor.mul(wrap).mul(diffuseColor.rgb).mul(INV_PI).mul(ao));
    // Kajiya-Kay: highlights where the half vector is perpendicular to the strand, shifted along the normal
    const hv = normalize(l.add(v));
    const lobe = (shift: number, exponent: N) => {
      // each strand of the texture shifts its highlight a little: the band breaks up along the hair
      const t = normalize(this.h.strand.add(n.mul(this.h.jitter.add(shift))));
      const th = dot(t, hv);
      const sinTH = sqrt(max(float(1).sub(th.mul(th)), 0));
      return smoothstep(-1, 0, th).mul(pow(sinTH, exponent));
    };
    const wet = heroU.wet;
    const primary = lobe(-0.07, mix(float(140), float(300), wet)).mul(mix(float(0.03), float(0.09), wet));
    const secondary = lobe(0.11, float(30)).mul(0.07);
    // highlights only where the light reaches the strands (soft toward the terminator), weaker deep in the volume,
    // and on the strands of the texture rather than across whole cards
    const vis = saturate(ndl.mul(1.6).add(0.45)).mul(ao).mul(ao).mul(this.h.strandMask);
    const spec = vec3(primary).add(this.h.tint.mul(secondary)).mul(vis);
    reflectedLight.directSpecular.addAssign(lightColor.mul(spec));
  }

  indirectDiffuse(builder: N) {
    const { irradiance, reflectedLight } = builder.context;
    const ao = mix(float(0.4), float(1), this.h.depth);
    reflectedLight.indirectDiffuse.addAssign(irradiance.add(heroU.fill).mul(diffuseColor.rgb).mul(INV_PI).mul(ao));
  }

  indirectSpecular(builder: N) {
    // hair shadows itself: only the outer strands see the sky, and only at grazing angles much
    const { radiance, iblIrradiance, reflectedLight } = builder.context;
    const n = normalView, v = positionViewDirection;
    const nv = saturate(dot(n, v));
    const fres = float(0.03).add(pow(float(1).sub(nv), 5).mul(0.1));
    const occ = this.h.depth.mul(this.h.depth).mul(mix(float(0.6), float(0.95), heroU.wet));
    reflectedLight.indirectSpecular.addAssign(radiance.mul(fres).mul(occ));
    // the sky's sheen along the strands: a broad Kajiya-Kay lobe toward the bright sky overhead (in shade, where no
    // sun highlight falls, dark hair still shows a soft band)
    const sky = normalize(TSL.cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz);
    const hv = normalize(sky.add(v));
    const th = dot(this.h.strand, hv);
    const band = pow(sqrt(max(float(1).sub(th.mul(th)), 0)), float(36)).mul(saturate(dot(n, sky).mul(0.8).add(0.3)));
    reflectedLight.indirectSpecular.addAssign(vec3(luminance(iblIrradiance)).mul(INV_PI).mul(band).mul(0.12).mul(occ));
  }
}

class HairMaterial extends THREE.MeshStandardNodeMaterial {
  hair!: HairNodes;
  setupLightingModel() {
    return new HairLighting(this.hair) as never;
  }
}

/**
 * Hair cards. The geometry must carry outward volume normals, a `tangent` along the strands and a `hairDepth`
 * attribute (0 at the scalp .. 1 outside); see `prepareHairGeometry`.
 */
export function hairMaterial(map: THREE.Texture) {
  const m = new HairMaterial();
  m.name = 'hero_hair';
  const tex = texture(map, uv());
  const depth = saturate(attribute('hairDepth', 'float'));
  // roots darker and a touch warmer than the tips; the scan's albedo is near black (baked occlusion), lifted to a
  // dark brown (sun-lightened a little) so strands read in the light
  const root = mix(vec3(0.62, 0.55, 0.5), vec3(1), depth);
  const wetDark = mix(float(1), float(0.55), heroU.wet);
  m.colorNode = vec4(tex.rgb.mul(root).mul(wetDark).mul(vec3(3.0, 2.55, 2.15)), tex.a);
  const lum = max(luminance(tex.rgb), 1e-4);
  // dithered coverage: discard below a per-pixel threshold that changes every frame; the shadow pass uses the
  // numeric alphaTest (a stable cut) because it does not see alphaTestNode
  const ign = interleavedGradientNoise(screenCoordinate.xy.add(heroU.frame.mul(5.588238)));
  m.alphaTestNode = mix(float(0.2), float(0.72), ign);
  m.alphaTest = 0.5;
  m.side = THREE.DoubleSide;
  // the stored (outward) normal on both faces of a card: the hair is shaded as a volume
  m.normalNode = normalViewGeometry;
  m.roughness = 0.6;
  m.metalness = 0;
  m.hair = {
    strand: normalize(varying(modelViewMatrix.mul(vec4(tangentLocal, 0)).xyz, 'v_heroStrand')),
    depth,
    tint: saturate(tex.rgb.div(lum).mul(0.22)).mul(mix(float(1), float(0.7), heroU.wet)),
    strandMask: smoothstep(0.004, 0.03, lum).mul(0.75).add(0.25),
    jitter: lum.sub(0.012).mul(6).clamp(-0.12, 0.12),
  };
  return m;
}

/**
 * Rebuilds the Rocketbox hair geometry for the volume shading: every card is modelled as two coincident faces of
 * opposite winding (one of them with inward normals), which z-fight when drawn double-sided. Keeps one face per card,
 * points every normal outward (the nearest scalp normal blended with the direction from the head centre), adds the
 * strand direction (radial from the crown, in the tangent plane) and the depth above the scalp.
 */
export function prepareHairGeometry(hair: THREE.BufferGeometry, head: THREE.BufferGeometry) {
  const hp = hair.getAttribute('position'), sp = head.getAttribute('position'), sn = head.getAttribute('normal');
  const index = hair.getIndex();
  if (!index || !sp || !sn) return;
  const P = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number, v = new THREE.Vector3()) => v.set(a.getX(i), a.getY(i), a.getZ(i));
  // head centre and size from the scalp (head vertices above the ears)
  const box = new THREE.Box3();
  for (let i = 0; i < sp.count; i++) box.expandByPoint(P(sp, i));
  const size = box.getSize(new THREE.Vector3());
  const top = box.max.y;
  const centre = new THREE.Vector3();
  let k = 0;
  for (let i = 0; i < sp.count; i++) {
    const p = P(sp, i);
    if (p.y > top - size.y * 0.42) {
      centre.add(p);
      k++;
    }
  }
  centre.divideScalar(Math.max(1, k));
  const radius = size.y * 0.42;
  // the whorl: on top of the head, a little behind the centre (the model faces +z)
  const crown = centre.clone().add(new THREE.Vector3(0, radius * 0.95, -radius * 0.35));

  // 1. one face per card
  const key = (i: number) => {
    const p = P(hp, i);
    return `${Math.round(p.x * 4000)},${Math.round(p.y * 4000)},${Math.round(p.z * 4000)}`;
  };
  const seen = new Set<string>();
  const kept: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2);
    const id = [key(a), key(b), key(c)].sort().join('|');
    if (seen.has(id)) continue;
    seen.add(id);
    kept.push(a, b, c);
  }
  hair.setIndex(kept);

  // 2. outward normals, 3. strand tangents, 4. depth above the scalp
  const n = hp.count;
  const normals = new Float32Array(n * 3), tangents = new Float32Array(n * 4), depth = new Float32Array(n);
  const p = new THREE.Vector3(), q = new THREE.Vector3(), nrm = new THREE.Vector3(), radial = new THREE.Vector3(), t = new THREE.Vector3();
  const dists: number[] = [];
  for (let i = 0; i < n; i++) {
    P(hp, i, p);
    // the three nearest scalp vertices, inverse-distance weighted
    const best: [number, number][] = [[1e9, -1], [1e9, -1], [1e9, -1]];
    for (let j = 0; j < sp.count; j++) {
      const d = P(sp, j, q).distanceToSquared(p);
      if (d < best[2][0]) {
        best[2] = [d, j];
        best.sort((x, y) => x[0] - y[0]);
      }
    }
    nrm.set(0, 0, 0);
    for (const [d, j] of best) if (j >= 0) nrm.addScaledVector(q.set(sn.getX(j), sn.getY(j), sn.getZ(j)).normalize(), 1 / (Math.sqrt(d) + 1e-4));
    nrm.normalize();
    radial.subVectors(p, centre).normalize();
    nrm.multiplyScalar(0.6).addScaledVector(radial, 0.4).normalize();
    normals.set([nrm.x, nrm.y, nrm.z], i * 3);
    // strands grow away from the whorl, along the surface
    t.subVectors(p, crown);
    t.addScaledVector(nrm, -t.dot(nrm));
    if (t.lengthSq() < 1e-8) t.set(0, 0, -1).addScaledVector(nrm, -nrm.z);
    t.normalize();
    tangents.set([t.x, t.y, t.z, 1], i * 4);
    dists.push(Math.sqrt(best[0][0]));
  }
  // depth: the distance above the scalp, relative to the spread over the hair (the shell sits ~1 cm out)
  const sorted = [...dists].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.05)], hi = sorted[Math.floor(sorted.length * 0.9)];
  for (let i = 0; i < n; i++) depth[i] = THREE.MathUtils.clamp((dists[i] - lo) / Math.max(1e-5, hi - lo), 0, 1) * 0.8 + 0.2;
  hair.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  hair.setAttribute('tangent', new THREE.BufferAttribute(tangents, 4));
  hair.setAttribute('hairDepth', new THREE.BufferAttribute(depth, 1));
}

/**
 * Smooth shading across UV seams: vertices split at a seam (and the head's ring where it meets the neck of the body)
 * get the average of their normals, so the face shows no creases along its UV islands. Real creases (normals more
 * than ~70 degrees apart, e.g. the lips or the collar) are kept.
 */
export function smoothSeams(head: THREE.BufferGeometry, body: THREE.BufferGeometry | null) {
  const geos = body ? [head, body] : [head];
  const out = geos.map((g) => {
    const n = g.getAttribute('normal');
    const a = new Float32Array(n.count * 3);
    for (let i = 0; i < n.count; i++) a.set(new THREE.Vector3(n.getX(i), n.getY(i), n.getZ(i)).normalize().toArray(), i * 3);
    return a;
  });
  const groups = new Map<string, [number, number][]>();
  geos.forEach((g, gi) => {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      // the body only where it meets the head (its vertices near the head's lowest ring)
      const k = `${Math.round(p.getX(i) * 2500)},${Math.round(p.getY(i) * 2500)},${Math.round(p.getZ(i) * 2500)}`;
      const list = groups.get(k);
      if (list) list.push([gi, i]);
      else if (gi === 0) groups.set(k, [[gi, i]]);
    }
  });
  const v = new THREE.Vector3(), w = new THREE.Vector3(), s = new THREE.Vector3();
  let merged = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    s.set(0, 0, 0);
    const [g0, i0] = list[0];
    v.fromArray(out[g0], i0 * 3);
    let ok = true;
    for (const [gi, i] of list) {
      w.fromArray(out[gi], i * 3);
      if (w.dot(v) < 0.34) ok = false;
      s.add(w);
    }
    if (!ok) continue;
    s.normalize();
    for (const [gi, i] of list) out[gi].set(s.toArray(), i * 3);
    merged++;
  }
  geos.forEach((g, gi) => g.setAttribute('normal', new THREE.BufferAttribute(out[gi], 3)));
  return merged;
}

// ---------------------------------------------------------------------------------------------------- skin

interface SkinNodes {
  /** 0..1 where the albedo is skin */
  skin: N;
  /** 0..1 on the eyes */
  eye: N;
}

const SSS_TINT = [0.9, 0.42, 0.3] as const;

class SkinLighting extends PhysicalLightingModel {
  constructor(private s: SkinNodes) {
    super();
  }

  direct(data: N, builder: N) {
    const { lightDirection, lightColor, reflectedLight } = data;
    // light scattered under the skin comes out past the terminator, reddened: the band between a wrapped and a
    // plain Lambert, tinted
    const ndl = dot(normalView, lightDirection);
    const band = max(saturate(ndl.add(0.5).div(1.5)).sub(saturate(ndl)), 0);
    const sss = vec3(...SSS_TINT).mul(band).mul(this.s.skin).mul(0.45);
    reflectedLight.directDiffuse.addAssign(lightColor.mul(sss).mul(diffuseColor.rgb).mul(INV_PI));
    super.direct(data, builder);
  }

  indirectDiffuse(builder: N) {
    // sky light on skin comes out a little warmer (scattering) instead of the blue-grey of the sky
    const { irradiance, reflectedLight } = builder.context;
    const irr = irradiance.add(heroU.fill);
    const warm = mix(irr, vec3(luminance(irr)).mul(vec3(1.12, 0.95, 0.86)), this.s.skin.mul(0.4));
    reflectedLight.indirectDiffuse.addAssign(warm.mul(diffuseColor.rgb).mul(INV_PI));
  }

  indirectSpecular(builder: N) {
    super.indirectSpecular(builder);
    // a catchlight in the wet cornea: the bright sky above and behind the viewer, as bright as the sky light is
    const { iblIrradiance, reflectedLight } = builder.context;
    const r = reflect(positionViewDirection.negate(), normalView);
    const glint = pow(saturate(dot(r, normalize(vec3(0.22, 0.55, 0.8)))), 120);
    reflectedLight.indirectSpecular.addAssign(vec3(luminance(iblIrradiance.add(heroU.fill))).mul(glint).mul(this.s.eye));
  }
}

class SkinMaterial extends THREE.MeshStandardNodeMaterial {
  skin!: SkinNodes;
  /** F0 per pixel (skin ~0.028, cloth 0.04, painted scalp hair low) */
  f0: N = null;
  setupLightingModel() {
    return new SkinLighting(this.skin) as never;
  }
  setupSpecular() {
    const f0 = this.f0 ?? vec3(0.04);
    specularColor.assign(f0);
    specularColorBlended.assign(f0);
    specularF90.assign(1.0);
  }
}

/**
 * Head or body: skin, clothes, painted scalp hair and eyes from one albedo map. The masks come from the albedo
 * itself (skin is warm and red, the painted hair dark and brown) and, for the eyes, from the UV island.
 */
export function skinMaterial(map: THREE.Texture, normalMap: THREE.Texture | null, part: 'head' | 'body') {
  const m = new SkinMaterial();
  m.name = `hero_${part}`;
  const t = uv();
  const alb = texture(map, t);
  // masks in display (gamma) space, where the thresholds were fitted
  const s = pow(max(alb.rgb, vec3(1e-4)), vec3(1 / 2.2));
  const mx = max(max(s.r, s.g), s.b);
  const warm = s.r.sub(s.b).div(mx.add(1e-3));
  const red = s.r.sub(s.g).div(mx.add(1e-3));
  const skin = saturate(warm.sub(0.18).div(0.12)).mul(saturate(red.sub(0.13).div(0.08))).mul(saturate(mx.sub(0.25).div(0.15)));
  const isHead = part === 'head';
  // the head map: eyes in the lower left island; painted hair dark brown above the face
  const eye = isHead ? smoothstep(0.065, 0.045, t.sub(TSL.vec2(0.257, 0.931)).length()) : float(0);
  const hair = isHead
    ? saturate(float(0.06).sub(luminance(alb.rgb)).div(0.04)).mul(saturate(warm.sub(0.1).div(0.15))).mul(smoothstep(0.62, 0.58, t.y))
    : float(0);
  const wet = heroU.wet;
  // wet: skin a little darker, cloth and hair much darker (water fills the weave)
  const dry = mix(mix(float(0.62), float(0.86), skin), float(0.55), hair);
  m.colorNode = vec4(alb.rgb.mul(mix(float(1), dry, wet)), 1);
  if (normalMap) m.normalMap = normalMap;
  const rough = mix(mix(float(0.86), float(0.48), skin), float(0.8), hair);
  const roughWet = mix(mix(float(0.42), float(0.26), skin), float(0.3), hair);
  m.roughnessNode = mix(mix(rough, roughWet, wet), float(0.07), eye);
  m.metalness = 0;
  m.f0 = vec3(mix(mix(mix(float(0.04), float(0.028), skin), float(0.012), hair), float(0.03), eye));
  m.skin = { skin, eye };
  return m;
}
