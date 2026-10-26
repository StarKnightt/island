/**
 * A woven straw panama for the hero, built at load: a lathe of a real hat's section (rolled brim edge with a little
 * thickness, a tapered crown with a centre crease and a pinch either side at the front) fitted to the skinned head and
 * hair, then parented to the head bone so it rides every clip. The straw is a plain weave of ~3 mm strips laid in
 * rows round the hat from the crown's top (as a panama is plaited): each strip rounded across its width, the one on
 * top darkening the one it crosses, every strip a slightly different sun-bleached tone, the weave fading to its mean
 * where a pixel covers several strips (no moire at follow distance). A dark ribbon band round the crown. Wet
 * straw darkens.
 *
 * `?hat=0` leaves it off.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { heroU } from './heroMaterials';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TSL = TSLTyped as any;
const {
  float, vec2, vec3, mix, max, min, smoothstep, sin, floor, fract, abs, attribute, hash, fwidth, select,
} = TSL;

/** section of the hat (r outward from the inner rim, y up from the band's bottom), from the brim's lower inner edge
 *  round the brim, then up the crown to its top. Units: metres; the crown radius is added at build time. */
function section(brim: number, crownH: number) {
  const pts: [number, number][] = [];
  const n = 10;
  // underside of the brim, out to the edge, drooping a little
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([t * brim, -0.004 - 0.013 * t * t]);
  }
  // the rolled edge
  pts.push([brim + 0.003, -0.012]);
  pts.push([brim + 0.0035, -0.008]);
  pts.push([brim + 0.001, -0.005]);
  // top of the brim, back in to the crown
  for (let i = n; i >= 0; i--) {
    const t = i / n;
    pts.push([t * brim - 0.001 * (1 - t), 0.0005 - 0.013 * t * t + 0.004 * (1 - t) * (1 - t)]);
  }
  // the crown wall: up, tapering in, then the rounded top to the axis (r < 0 means "toward the axis")
  const m = 12;
  for (let i = 1; i <= m; i++) {
    const t = i / m;
    pts.push([-0.012 * t * t, 0.004 + t * crownH]);
  }
  const k = 8;
  for (let i = 1; i <= k; i++) {
    const t = i / k;
    const a = (t * Math.PI) / 2;
    // the shoulder of the crown: a quarter round of 2.2 cm, then flat-ish to the axis (marked by NaN: radius 0)
    pts.push([-0.012 - 0.022 * Math.sin(a), 0.004 + crownH + 0.012 * (1 - Math.cos(a)) * 0.6]);
  }
  pts.push([Number.NaN, 0.004 + crownH + 0.012]);
  return pts;
}

export function attachStrawHat(model: THREE.Object3D, head: THREE.SkinnedMesh, hair: THREE.SkinnedMesh | null) {
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('hat') === '0') return null;
  let headBone: THREE.Object3D | null = null;
  model.traverse((o) => { if (!headBone && o.name.replace(/[ _]/g, '') === 'Bip01Head') headBone = o; });
  if (!headBone) return null;
  model.updateMatrixWorld(true);
  // the skinned head and hair in the model's frame (it faces +z, up +y)
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const pts: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  for (const mesh of [head, hair]) {
    if (!mesh) continue;
    const n = mesh.geometry.getAttribute('position').count;
    for (let i = 0; i < n; i++) {
      mesh.getVertexPosition(i, v);
      pts.push(v.clone().applyMatrix4(mesh.matrixWorld).applyMatrix4(inv));
    }
  }
  let top = -Infinity;
  for (const p of pts) top = Math.max(top, p.y);
  // the band sits ~8 cm under the top of the hair: across the forehead and round the back of the skull
  const bandY = top - 0.098;
  const ring = pts.filter((p) => Math.abs(p.y - bandY) < 0.012);
  const cx = ring.reduce((s, p) => s + p.x, 0) / Math.max(1, ring.length);
  let minZ = Infinity, maxZ = -Infinity, rx = 0;
  for (const p of ring) {
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
    rx = Math.max(rx, Math.abs(p.x - cx));
  }
  const cz = (minZ + maxZ) / 2, rz = (maxZ - minZ) / 2;
  const r0 = Math.max(rx, rz) + 0.006, sx = (rx + 0.006) / r0, sz = (rz + 0.006) / r0;

  // ---- geometry: the lathe, with the crown oval like the head, the crease and pinches pressed in
  const sec = section(0.064, 0.088);
  const seg = 72;
  const pos: number[] = [], nrm: number[] = [], wv: number[] = [], idx: number[] = [];
  // arc length along the section (for the weave rows) and the part (0 brim, 1 crown wall, 2 crown top)
  const arc: number[] = [0];
  const radius = (p: [number, number]) => (Number.isNaN(p[0]) ? 0 : Math.max(0, r0 + p[0]));
  for (let i = 1; i < sec.length; i++) arc.push(arc[i - 1] + Math.hypot(radius(sec[i]) - radius(sec[i - 1]), sec[i][1] - sec[i - 1][1]));
  const crownStart = 2 * 11 + 3;
  const topY = sec[sec.length - 1][1];
  for (let j = 0; j <= seg; j++) {
    const a = (j / seg) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let i = 0; i < sec.length; i++) {
      const r = radius(sec[i]);
      let x = sa * r * sx, z = ca * r * sz, y = sec[i][1];
      // the crown: a crease front to back on top, pinches either side of the front
      if (i >= crownStart) {
        const up = THREE.MathUtils.smoothstep(y, 0.05, topY);
        const crease = Math.exp(-((x / (r0 * 0.32)) ** 2)) * 0.008 * up;
        const pinch = Math.exp(-(((a - 0.55) / 0.35) ** 2)) + Math.exp(-(((a - (Math.PI * 2 - 0.55)) / 0.35) ** 2));
        y -= crease;
        const pin = 1 - pinch * 0.12 * up;
        x *= pin;
        z *= 1 - pinch * 0.05 * up;
      }
      pos.push(x, y, z);
      nrm.push(0, 1, 0);
      // weave coordinates (m): round the hat, along the section; and the part
      const part = i < crownStart ? 0 : i < sec.length - 9 ? 1 : 2;
      wv.push((a / (Math.PI * 2)) * 2 * Math.PI * Math.max(r, 0.02), arc[i], part, y);
    }
  }
  const rows = sec.length;
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < rows - 1; i++) {
      const a = j * rows + i, b = (j + 1) * rows + i;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('weave', new THREE.Float32BufferAttribute(wv, 4));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  // ---- the straw
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.name = 'hero_hat';
  mat.side = THREE.DoubleSide;
  const w = attribute('weave', 'vec4');
  const strip = 0.0024;
  const q = vec2(w.x, w.y).div(strip);
  const cell = floor(q), f = fract(q);
  const parity = fract(cell.x.add(cell.y).mul(0.5)).greaterThan(0.25);
  // across the strip on top: rounded (bright middle, dark edges); the crossed strip shows only in the gaps
  const across = select(parity, f.y, f.x);
  const along = select(parity, f.x, f.y);
  const round = sin(across.mul(Math.PI)).pow(0.6);
  const gap = smoothstep(0.0, 0.12, along).mul(smoothstep(1.0, 0.88, along));
  const weave = round.mul(0.35).add(0.65).mul(mix(float(0.78), float(1), gap));
  // every strip its own tone (rows round the hat and strips along the section)
  const id = select(parity, cell.y, cell.x.add(1000));
  const tone = hash(id.add(w.z.mul(7919)).add(5000)).sub(0.5);
  // where a pixel spans several strips, fade to the mean (no moire)
  const fw = max(fwidth(q.x), fwidth(q.y));
  const detail = float(1).sub(smoothstep(0.35, 1.1, fw));
  const pattern = mix(float(0.88), weave, detail).add(tone.mul(0.07).mul(mix(float(0.4), float(1), detail)));
  // sun-bleached straw, each row of the plait a slightly different tone
  const ringTone = hash(floor(w.y.div(0.007)).add(w.z.mul(331)).add(17));
  const straw = mix(vec3(0.5, 0.37, 0.18), vec3(0.6, 0.47, 0.25), ringTone);
  // the ribbon band round the crown's foot
  const band = w.z.equal(1).and(w.w.lessThan(0.024)) as unknown;
  const bandCol = vec3(0.022, 0.018, 0.015);
  const wetDark = mix(float(1), float(0.6), heroU.wet);
  mat.colorNode = select(band, bandCol, straw.mul(pattern)).mul(wetDark);
  mat.roughnessNode = select(band, float(0.6), mix(float(0.8), float(0.62), round.mul(detail))).mul(mix(float(1), float(0.7), heroU.wet));
  mat.metalness = 0;
  // the gaps between the strips see less sky
  mat.aoNode = select(band, float(1), mix(float(1), min(float(1), abs(weave).add(0.5)), detail));

  const hat = new THREE.Mesh(geo, mat);
  hat.name = 'hero_hat';
  hat.castShadow = true;
  hat.receiveShadow = true;
  hat.frustumCulled = false;
  // in the model's frame: centred over the skull, tilted back a few degrees (the brim's front a little higher)
  hat.position.set(cx, bandY, cz - 0.004);
  hat.rotation.x = -0.07;
  model.add(hat);
  hat.updateMatrixWorld(true);
  (headBone as THREE.Object3D).attach(hat);
  return hat;
}
