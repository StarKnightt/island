/**
 * Procedural plant geometry, grown deterministically from a seed: coconut palms (curved ringed trunk, a crown of
 * V-folded frond cards, coconuts), broadleaf canopy trees (buttressed trunk, branch hierarchy, leaf-cluster cards),
 * banana plants, bushes and grass clumps. Every vertex carries a `wind` attribute: x = trunk / branch bend weight,
 * y = leaf flutter weight, z = phase offset; and a vertex colour used as ambient occlusion and tint.
 */
import * as THREE from 'three/webgpu';
import { Rng } from '../core/noise';

export interface PartGeo { geometry: THREE.BufferGeometry; part: 'bark' | 'frond' | 'leaf' | 'nut' | 'banana' | 'grass' | 'palmbark' | 'rock'; material?: THREE.Material }

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  wind: number[] = [];
  idx: number[] = [];
  v(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, ao: number, w: [number, number, number]) {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(ao, ao, ao);
    this.wind.push(...w);
    return this.pos.length / 3 - 1;
  }
  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('wind', new THREE.Float32BufferAttribute(this.wind, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
  get count() {
    return this.pos.length / 3;
  }
}

const up = new THREE.Vector3(0, 1, 0);

/** a tube along a polyline with per-point radius; v follows the length in metres / vScale */
function tube(b: Builder, pts: THREE.Vector3[], radii: number[], sides: number, vScale: number, windOf: (t: number) => [number, number, number], aoOf: (t: number) => number, flare?: (t: number, a: number) => number) {
  const base = b.count;
  let len = 0;
  let prevN = new THREE.Vector3(1, 0, 0);
  for (let i = 0; i < pts.length; i++) {
    const t = i / (pts.length - 1);
    const dir = new THREE.Vector3().subVectors(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]).normalize();
    // parallel transport of the ring frame
    let nrm = prevN.clone().sub(dir.clone().multiplyScalar(prevN.dot(dir))).normalize();
    if (nrm.lengthSq() < 0.5) nrm = new THREE.Vector3().crossVectors(dir, up).normalize();
    prevN = nrm;
    const bin = new THREE.Vector3().crossVectors(dir, nrm).normalize();
    if (i > 0) len += pts[i].distanceTo(pts[i - 1]);
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const r = radii[i] * (flare ? flare(t, a) : 1);
      const off = nrm.clone().multiplyScalar(Math.cos(a)).addScaledVector(bin, Math.sin(a));
      const p = pts[i].clone().addScaledVector(off, r);
      b.v(p, off, s / sides, len / vScale, aoOf(t), windOf(t));
    }
  }
  const ring = sides + 1;
  for (let i = 0; i < pts.length - 1; i++) for (let s = 0; s < sides; s++) {
    const a = base + i * ring + s, c = base + (i + 1) * ring + s;
    b.quad(a, c, c + 1, a + 1);
  }
}

// ---------------------------------------------------------------- coconut palm
export interface PalmOpts { height: number; lean: number; fronds: number; segments: number; sides: number; dead: number; nuts: boolean }

export function palm(seed: number, o: PalmOpts): PartGeo[] {
  const r = new Rng(seed);
  const trunk = new Builder(), frond = new Builder(), nut = new Builder();
  const H = o.height;
  // trunk: leans along +x and curves back up toward the light
  const pts: THREE.Vector3[] = [], radii: number[] = [];
  const nSeg = Math.max(6, Math.round(H * 1.6));
  const sway = r.range(-0.15, 0.15);
  for (let i = 0; i <= nSeg; i++) {
    const t = i / nSeg;
    const lean = o.lean * H * (Math.pow(t, 1.5) - 0.35 * Math.pow(t, 3));
    pts.push(new THREE.Vector3(lean, t * H, sway * H * t * t));
    radii.push((0.19 + 0.04 * r.next()) * (1 - 0.32 * t) * (1 + 0.55 * Math.exp(-t * 18)));
  }
  tube(trunk, pts, radii, o.sides, 1.6, (t) => [t * t, 0, 0], (t) => 0.55 + 0.45 * Math.min(1, t * 4));
  const top = pts[pts.length - 1].clone();
  const topDir = new THREE.Vector3().subVectors(pts[pts.length - 1], pts[pts.length - 2]).normalize();
  // crown
  const n = o.fronds;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let f = 0; f < n; f++) {
    const isDead = f < o.dead;
    // elevation: a few young fronds up, most spread and drooping, dead ones hanging
    const k = f / n;
    const elev = isDead ? r.range(-1.25, -0.95) : THREE.MathUtils.lerp(0.95, -0.45, Math.pow(1 - k, 0.8)) + r.range(-0.12, 0.12);
    const az = f * golden + r.range(-0.2, 0.2);
    const len = (isDead ? 3.3 : 4.3) * r.range(0.85, 1.12) * (o.height < 4 ? 0.62 : 1);
    const droop = isDead ? 0.3 : r.range(0.75, 1.25);
    const fold = THREE.MathUtils.degToRad(r.range(18, 34));
    const Wmax = 1.12 * (o.height < 4 ? 0.62 : 1);
    const vRow = isDead ? 0.5 : 0;
    const segs = o.segments;
    const dir0 = new THREE.Vector3(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev)).normalize();
    const side0 = new THREE.Vector3().crossVectors(dir0, up).normalize();
    if (side0.lengthSq() < 0.5) side0.set(1, 0, 0);
    let p = top.clone().addScaledVector(dir0, 0.15);
    const twist = r.range(-0.4, 0.4);
    const rowIdx: number[][] = [];
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      // the rachis bends down progressively under its own weight
      const bend = droop * Math.pow(t, 1.4) * 1.25;
      const d = dir0.clone().applyAxisAngle(side0, -bend).normalize();
      if (s > 0) p = p.clone().addScaledVector(d, len / segs);
      const sideV = side0.clone().applyAxisAngle(d, twist * t).normalize();
      const nUp = new THREE.Vector3().crossVectors(sideV, d).normalize();
      const W = Wmax * (Math.pow(Math.sin(Math.PI * Math.min(1, 0.06 + t * 0.98)), 0.55) + 0.04);
      const vW = (W / Wmax) * 0.5 * 0.5;
      const ao = 0.55 + 0.45 * Math.min(1, t * 2.2);
      const crownN = p.clone().sub(top).normalize();
      const row: number[] = [];
      for (const side of [-1, 0, 1]) {
        const pos = p.clone();
        let nn: THREE.Vector3;
        if (side !== 0) {
          pos.addScaledVector(sideV, side * W * Math.cos(fold)).addScaledVector(nUp, -W * Math.sin(fold));
          nn = nUp.clone().multiplyScalar(Math.cos(fold)).addScaledVector(sideV, side * Math.sin(fold)).normalize();
        } else nn = nUp.clone();
        // volumetric crown normal blend
        nn.lerp(crownN, 0.45).normalize();
        const v = vRow + 0.25 + side * vW;
        row.push(frond.v(pos, nn, Math.min(0.995, 0.02 + t * 0.97), v, ao, [1, t * (side === 0 ? 0.5 : 1), (f * 0.37) % 1]));
      }
      rowIdx.push(row);
    }
    for (let s = 0; s < segs; s++) {
      const a = rowIdx[s], b2 = rowIdx[s + 1];
      frond.quad(a[0], b2[0], b2[1], a[1]);
      frond.quad(a[1], b2[1], b2[2], a[2]);
    }
  }
  // coconuts under the crown
  if (o.nuts) {
    const ico = new THREE.IcosahedronGeometry(0.13, 1);
    const ip = ico.getAttribute('position') as THREE.BufferAttribute;
    const cnt = r.int(7) + 3;
    for (let c = 0; c < cnt; c++) {
      const a = r.next() * Math.PI * 2;
      const center = top.clone().add(new THREE.Vector3(Math.cos(a) * 0.24, -0.25 - r.next() * 0.2, Math.sin(a) * 0.24));
      const base = nut.count;
      for (let i = 0; i < ip.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(ip, i);
        const nn = v.clone().normalize();
        v.y *= 1.12;
        nut.v(center.clone().add(v), nn, r.next(), r.next(), 0.7, [1, 0, 0]);
      }
      const ii = ico.index ? ico.index.array : Array.from({ length: ip.count }, (_, i) => i);
      for (let i = 0; i < ii.length; i += 3) nut.tri(base + ii[i], base + ii[i + 1], base + ii[i + 2]);
    }
  }
  void topDir;
  const out: PartGeo[] = [{ geometry: trunk.build(), part: 'palmbark' }, { geometry: frond.build(), part: 'frond' }];
  if (o.nuts) out.push({ geometry: nut.build(), part: 'nut' });
  return out;
}

// ---------------------------------------------------------------- broadleaf canopy tree
export interface TreeOpts { height: number; spread: number; cards: number; sides: number; lod: number }

export function canopyTree(seed: number, o: TreeOpts): PartGeo[] {
  const r = new Rng(seed);
  const bark = new Builder(), leaf = new Builder();
  const H1 = o.height * r.range(0.45, 0.6);
  // trunk with a buttress flare
  const pts: THREE.Vector3[] = [], radii: number[] = [];
  const lean = new THREE.Vector3(r.range(-1, 1), 0, r.range(-1, 1)).normalize().multiplyScalar(r.range(0, 0.06));
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    pts.push(new THREE.Vector3(lean.x * H1 * t + Math.sin(t * 3 + seed) * 0.15, t * H1, lean.z * H1 * t + Math.cos(t * 2.3 + seed) * 0.15));
    radii.push(THREE.MathUtils.lerp(0.42, 0.3, t) * (o.height / 22));
  }
  const fl = r.int(3) + 3;
  tube(bark, pts, radii, o.sides, 2.2, (t) => [t * 0.25, 0, 0], (t) => 0.5 + 0.5 * t, (t, a) => 1 + 1.6 * Math.exp(-t * 9) * Math.pow(Math.abs(Math.cos(a * fl * 0.5 + seed)), 6));
  // primary branches from the top of the trunk
  const crownC = new THREE.Vector3(pts[8].x, o.height * 0.82, pts[8].z);
  const tips: { p: THREE.Vector3; d: THREE.Vector3; w: number }[] = [];
  const nb = r.int(3) + 4;
  for (let b = 0; b < nb; b++) {
    const az = (b / nb) * Math.PI * 2 + r.range(-0.4, 0.4);
    const elev = r.range(0.45, 0.95);
    const L = o.spread * r.range(0.55, 0.9);
    const start = pts[8 - r.int(2)].clone();
    const dir = new THREE.Vector3(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev));
    const bp: THREE.Vector3[] = [], br: number[] = [];
    let p = start.clone();
    for (let i = 0; i <= 5; i++) {
      const t = i / 5;
      bp.push(p.clone());
      br.push(radii[8] * 0.75 * (1 - t * 0.75));
      // branches level out toward their ends (umbrella crown)
      const d = dir.clone();
      d.y = THREE.MathUtils.lerp(dir.y, 0.15, t);
      p = p.addScaledVector(d.normalize(), L / 5);
    }
    tube(bark, bp, br, Math.max(4, o.sides - 2), 1.6, (t) => [0.3 + 0.7 * t, 0, b / nb], (t) => 0.55 + 0.4 * t);
    tips.push({ p: bp[5], d: dir, w: 1 });
    // secondaries
    const ns = o.lod === 0 ? 3 : 1;
    for (let s = 0; s < ns; s++) {
      const at = bp[2 + r.int(3)];
      const sa = az + r.range(-1.1, 1.1);
      const se = r.range(0.2, 0.8);
      const sd = new THREE.Vector3(Math.cos(sa) * Math.cos(se), Math.sin(se), Math.sin(sa) * Math.cos(se));
      const sl = L * r.range(0.35, 0.6);
      const sp = [at.clone(), at.clone().addScaledVector(sd, sl * 0.5), at.clone().addScaledVector(sd, sl).add(new THREE.Vector3(0, sl * 0.1, 0))];
      tube(bark, sp, [br[2] * 0.6, br[2] * 0.4, br[2] * 0.2], 4, 1.4, (t) => [0.6 + 0.4 * t, 0, (b + s) / nb], () => 0.7);
      tips.push({ p: sp[2], d: sd, w: 0.7 });
    }
  }
  // leaf cluster cards around the tips and over the crown shell
  const cards = o.cards;
  for (let c = 0; c < cards; c++) {
    const tip = tips[c % tips.length];
    const size = r.range(1.5, 2.6) * (o.lod === 0 ? 1 : 1.55) * (o.height / 22) ** 0.5;
    // place on a squashed dome around the tip
    const a = r.next() * Math.PI * 2;
    const rad = r.next() * o.spread * 0.38 * tip.w;
    const center = tip.p.clone().add(new THREE.Vector3(Math.cos(a) * rad, r.range(-0.9, 1.4), Math.sin(a) * rad));
    const out = center.clone().sub(crownC);
    out.y *= 0.6;
    out.normalize();
    // card faces outward/up with random roll; atlas cell 0..3
    const nrm = out.clone().lerp(up, 0.35).normalize();
    const tang = new THREE.Vector3().crossVectors(up, nrm);
    if (tang.lengthSq() < 1e-4) tang.set(1, 0, 0);
    tang.normalize().applyAxisAngle(nrm, r.range(-0.5, 0.5));
    const bit = new THREE.Vector3().crossVectors(nrm, tang).normalize();
    const cell = r.int(4);
    const u0 = (cell % 2) * 0.5, v0 = Math.floor(cell / 2) * 0.5;
    const ao = THREE.MathUtils.clamp(0.45 + 0.55 * (center.y - crownC.y + o.height * 0.25) / (o.height * 0.4), 0.35, 1);
    const crownN = center.clone().sub(crownC).normalize();
    const nn = nrm.clone().lerp(crownN, 0.6).normalize();
    // the card hangs from its top edge (cluster attachment at the bottom of the texture cell)
    const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const ids = corners.map(([sx, sy]) => {
      const p = center.clone().addScaledVector(tang, sx * size * 0.5).addScaledVector(bit, sy * size * 0.5);
      return leaf.v(p, nn, u0 + (sx * 0.5 + 0.5) * 0.5, v0 + (0.5 - sy * 0.5) * 0.5, ao, [0.85, sy > 0 ? 1 : 0.35, (c * 0.123) % 1]);
    });
    leaf.quad(ids[0], ids[1], ids[2], ids[3]);
  }
  return [{ geometry: bark.build(), part: 'bark' }, { geometry: leaf.build(), part: 'leaf' }];
}

// ---------------------------------------------------------------- bush: leaf cards on a small dome
export function bush(seed: number, size: number, cards: number): PartGeo[] {
  const r = new Rng(seed);
  const leaf = new Builder();
  for (let c = 0; c < cards; c++) {
    const a = r.next() * Math.PI * 2, e = r.range(0.1, 1.2);
    const n = new THREE.Vector3(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e));
    const center = n.clone().multiplyScalar(size * r.range(0.25, 0.55)).add(new THREE.Vector3(0, size * 0.35, 0));
    const s = size * r.range(0.55, 0.85);
    const tang = new THREE.Vector3().crossVectors(up, n).normalize();
    if (tang.lengthSq() < 0.1) tang.set(1, 0, 0);
    const bit = new THREE.Vector3().crossVectors(n, tang).normalize();
    const cell = r.int(4);
    const u0 = (cell % 2) * 0.5, v0 = Math.floor(cell / 2) * 0.5;
    const ao = 0.5 + 0.5 * Math.sin(e);
    const ids = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as [number, number][]).map(([sx, sy]) =>
      leaf.v(center.clone().addScaledVector(tang, sx * s * 0.5).addScaledVector(bit, sy * s * 0.5), n.clone().lerp(up, 0.3).normalize(),
        u0 + (sx * 0.5 + 0.5) * 0.5, v0 + (0.5 - sy * 0.5) * 0.5, ao, [0.4, sy > 0 ? 1 : 0.3, (c * 0.31) % 1]));
    leaf.quad(ids[0], ids[1], ids[2], ids[3]);
  }
  return [{ geometry: leaf.build(), part: 'leaf' }];
}

// ---------------------------------------------------------------- banana plant
export function banana(seed: number, height: number): PartGeo[] {
  const r = new Rng(seed);
  const stem = new Builder(), leaf = new Builder();
  const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.03, height * 0.5, 0), new THREE.Vector3(0.05, height, 0.02)];
  tube(stem, pts, [0.11, 0.09, 0.07], 7, 1, (t) => [t, 0, 0], (t) => 0.6 + 0.4 * t);
  const n = r.int(3) + 6;
  for (let l = 0; l < n; l++) {
    const az = l * 2.4 + r.range(-0.3, 0.3);
    const elev = r.range(0.35, 1.0);
    const len = r.range(1.6, 2.4) * (height / 2.6);
    const W = len * 0.24;
    const dir0 = new THREE.Vector3(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev));
    const side0 = new THREE.Vector3().crossVectors(dir0, up).normalize();
    let p = pts[2].clone().add(new THREE.Vector3(0, -0.1, 0));
    const segs = 6;
    const rows: number[][] = [];
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const d = dir0.clone().applyAxisAngle(side0, -t * t * 1.4).normalize();
      if (s > 0) p = p.clone().addScaledVector(d, len / segs);
      const nUp = new THREE.Vector3().crossVectors(side0, d).normalize();
      const row: number[] = [];
      for (const side of [-1, 0, 1]) {
        const pos = p.clone().addScaledVector(side0, side * W * 0.95).addScaledVector(nUp, -Math.abs(side) * W * 0.18);
        row.push(leaf.v(pos, nUp.clone().addScaledVector(side0, side * 0.2).normalize(), t, 0.5 + side * 0.48, 0.6 + 0.4 * t, [0.8, t, (l * 0.29) % 1]));
      }
      rows.push(row);
    }
    for (let s = 0; s < segs; s++) {
      const a = rows[s], b2 = rows[s + 1];
      leaf.quad(a[0], b2[0], b2[1], a[1]);
      leaf.quad(a[1], b2[1], b2[2], a[2]);
    }
  }
  return [{ geometry: stem.build(), part: 'palmbark' }, { geometry: leaf.build(), part: 'banana' }];
}

// ---------------------------------------------------------------- grass clump: crossed blade cards
export function grassClump(seed: number, height: number, cards: number): PartGeo[] {
  const r = new Rng(seed);
  const g = new Builder();
  for (let c = 0; c < cards; c++) {
    const a = (c / cards) * Math.PI + r.range(-0.3, 0.3);
    const ox = r.range(-0.18, 0.18), oz = r.range(-0.18, 0.18);
    const h = height * r.range(0.7, 1.15);
    const w = height * 0.9;
    const dx = Math.cos(a) * w * 0.5, dz = Math.sin(a) * w * 0.5;
    const lean = new THREE.Vector3(r.range(-0.2, 0.2), 0, r.range(-0.2, 0.2)).multiplyScalar(h);
    const n = new THREE.Vector3(-Math.sin(a), 0.6, Math.cos(a)).normalize();
    const u0 = r.int(2) * 0.5;
    const p0 = g.v(new THREE.Vector3(ox - dx, 0, oz - dz), up, u0, 1, 0.45, [0, 0, 0]);
    const p1 = g.v(new THREE.Vector3(ox + dx, 0, oz + dz), up, u0 + 0.5, 1, 0.45, [0, 0, 0]);
    const p2 = g.v(new THREE.Vector3(ox + dx + lean.x, h, oz + dz + lean.z), n, u0 + 0.5, 0, 1, [0, 1, c / cards]);
    const p3 = g.v(new THREE.Vector3(ox - dx + lean.x, h, oz - dz + lean.z), n, u0, 0, 1, [0, 1, c / cards]);
    g.quad(p0, p1, p2, p3);
  }
  return [{ geometry: g.build(), part: 'grass' }];
}
