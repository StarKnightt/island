/**
 * Static collision for the player and the camera: obstacles (circles, oriented boxes and round walls in plan, with a
 * height range) and walkable surfaces above the terrain (docks, hut floors, the lighthouse stair and gallery), kept
 * in a uniform grid. Everything is authored by the systems that build the props.
 */
import * as THREE from 'three/webgpu';

/** an opening in a ring wall: centre angle (atan2(dz, dx)), half width in radians, height range */
export interface RingGap { a: number; half: number; y0: number; y1: number }
export interface Obstacle {
  kind: 'circle' | 'box' | 'ring';
  x: number; z: number; r: number; hx: number; hz: number; c: number; s: number; y0: number; y1: number;
  /** ring walls: inner and outer radius and the openings */
  ri?: number; ro?: number; gaps?: RingGap[];
}
export interface Surface {
  /** plan bounds for the grid */
  minX: number; maxX: number; minZ: number; maxZ: number;
  /**
   * height of the walkable top at (x, z), or null outside it; surfaces with several levels at one point (a spiral
   * stair) return the highest level that is not above `maxY`
   */
  height(x: number, z: number, maxY: number): number | null;
  material: 'wood' | 'stone' | 'metal';
}

const CELL = 16;

const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

export class Colliders {
  private grid = new Map<number, { obs: Obstacle[]; surf: Surface[] }>();
  count = 0;

  private key(i: number, j: number) {
    return (i + 4096) * 8192 + (j + 4096);
  }
  private cells(minX: number, maxX: number, minZ: number, maxZ: number) {
    const out: number[] = [];
    for (let i = Math.floor(minX / CELL); i <= Math.floor(maxX / CELL); i++)
      for (let j = Math.floor(minZ / CELL); j <= Math.floor(maxZ / CELL); j++) out.push(this.key(i, j));
    return out;
  }
  private bucket(k: number) {
    let b = this.grid.get(k);
    if (!b) {
      b = { obs: [], surf: [] };
      this.grid.set(k, b);
    }
    return b;
  }

  circle(x: number, z: number, r: number, y0 = -1e9, y1 = 1e9) {
    const o: Obstacle = { kind: 'circle', x, z, r, hx: r, hz: r, c: 1, s: 0, y0, y1 };
    for (const k of this.cells(x - r, x + r, z - r, z + r)) this.bucket(k).obs.push(o);
    this.count++;
  }

  /** oriented box obstacle: centre, half extents, rotation about y */
  box(x: number, z: number, hx: number, hz: number, rot: number, y0 = -1e9, y1 = 1e9) {
    const o: Obstacle = { kind: 'box', x, z, r: Math.hypot(hx, hz), hx, hz, c: Math.cos(rot), s: Math.sin(rot), y0, y1 };
    for (const k of this.cells(x - o.r, x + o.r, z - o.r, z + o.r)) this.bucket(k).obs.push(o);
    this.count++;
  }

  /**
   * a round wall between radii ri and ro (a tower, a well): walkers are kept inside or outside it, except through
   * its openings (doors). The jambs of each opening are added as posts.
   */
  ring(x: number, z: number, ri: number, ro: number, y0: number, y1: number, gaps: RingGap[] = []) {
    const o: Obstacle = { kind: 'ring', x, z, r: ro, hx: ro, hz: ro, c: 1, s: 0, y0, y1, ri, ro, gaps };
    for (const k of this.cells(x - ro, x + ro, z - ro, z + ro)) this.bucket(k).obs.push(o);
    this.count++;
    // jamb posts at the opening's edges (thin: the ring itself keeps walkers out of the wall)
    for (const g of gaps) for (const side of [-1, 1]) for (const rr of [ri, ro]) {
      const a = g.a + side * g.half;
      this.circle(x + Math.cos(a) * rr, z + Math.sin(a) * rr, 0.05, Math.max(y0, g.y0 - 0.5), Math.min(y1, g.y1 + 0.5));
    }
  }

  surface(s: Surface) {
    for (const k of this.cells(s.minX, s.maxX, s.minZ, s.maxZ)) this.bucket(k).surf.push(s);
    this.count++;
  }

  /** an oriented flat (or sloped) platform: walkable top at y (+ slope along local x) */
  platform(x: number, z: number, hx: number, hz: number, rot: number, y: number, material: Surface['material'] = 'wood', slopeX = 0) {
    const c = Math.cos(rot), s = Math.sin(rot), r = Math.hypot(hx, hz);
    this.surface({
      minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r, material,
      height: (px, pz) => {
        const dx = px - x, dz = pz - z;
        const lx = dx * c + dz * s, lz = -dx * s + dz * c;
        if (Math.abs(lx) > hx || Math.abs(lz) > hz) return null;
        return y + lx * slopeX;
      },
    });
  }

  /** the highest walkable surface at (x, z) that is no higher than `maxY` */
  surfaceAt(x: number, z: number, maxY: number): { y: number; material: Surface['material'] } | null {
    const b = this.grid.get(this.key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!b) return null;
    let best: { y: number; material: Surface['material'] } | null = null;
    for (const s of b.surf) {
      const h = s.height(x, z, maxY);
      if (h === null || h > maxY) continue;
      if (!best || h > best.y) best = { y: h, material: s.material };
    }
    return best;
  }

  private inGap(o: Obstacle, ang: number, d: number, r: number, y: number) {
    for (const g of o.gaps!) {
      if (y + 1.7 < g.y0 || y + 0.2 > g.y1) continue;
      if (Math.abs(angleDiff(ang, g.a)) < g.half - r / Math.max(d, 0.5)) return true;
    }
    return false;
  }

  /** push a circle of radius r at feet height y (and head height y + 1.7) out of obstacles */
  resolve(p: THREE.Vector3, r: number) {
    const b = this.grid.get(this.key(Math.floor(p.x / CELL), Math.floor(p.z / CELL)));
    if (!b) return false;
    let hit = false;
    for (const o of b.obs) {
      if (p.y + 1.7 < o.y0 || p.y + 0.35 > o.y1) continue;
      if (o.kind === 'circle') {
        const dx = p.x - o.x, dz = p.z - o.z, d = Math.hypot(dx, dz), m = o.r + r;
        if (d < m && d > 1e-6) {
          p.x = o.x + (dx / d) * m;
          p.z = o.z + (dz / d) * m;
          hit = true;
        }
      } else if (o.kind === 'ring') {
        const dx = p.x - o.x, dz = p.z - o.z, d = Math.hypot(dx, dz);
        const ri = o.ri!, ro = o.ro!;
        if (d <= ri - r || d >= ro + r || d < 1e-6) continue;
        const ang = Math.atan2(dz, dx);
        if (this.inGap(o, ang, d, r, p.y)) continue;
        const nd = d < (ri + ro) / 2 ? ri - r : ro + r;
        p.x = o.x + (dx / d) * nd;
        p.z = o.z + (dz / d) * nd;
        hit = true;
      } else {
        const dx = p.x - o.x, dz = p.z - o.z;
        const lx = dx * o.c + dz * o.s, lz = -dx * o.s + dz * o.c;
        const qx = THREE.MathUtils.clamp(lx, -o.hx, o.hx), qz = THREE.MathUtils.clamp(lz, -o.hz, o.hz);
        let ex = lx - qx, ez = lz - qz;
        let d = Math.hypot(ex, ez);
        if (d < r) {
          if (d < 1e-6) {
            // inside: push out along the shallowest axis
            const px = o.hx - Math.abs(lx), pz = o.hz - Math.abs(lz);
            if (px < pz) { ex = Math.sign(lx) || 1; ez = 0; d = 0; } else { ex = 0; ez = Math.sign(lz) || 1; d = 0; }
            const push = (px < pz ? px : pz) + r;
            const nlx = lx + ex * push, nlz = lz + ez * push;
            p.x = o.x + nlx * o.c - nlz * o.s;
            p.z = o.z + nlx * o.s + nlz * o.c;
          } else {
            const k = (r - d) / d;
            const nlx = lx + ex * k, nlz = lz + ez * k;
            p.x = o.x + nlx * o.c - nlz * o.s;
            p.z = o.z + nlx * o.s + nlz * o.c;
          }
          hit = true;
        }
      }
    }
    return hit;
  }

  /** camera ray against obstacles (coarse: circles and boxes as cylinders), distance or Infinity */
  raycast(from: THREE.Vector3, dir: THREE.Vector3, maxDist: number) {
    const steps = Math.ceil(maxDist / 0.25);
    for (let i = 1; i <= steps; i++) {
      const d = (i / steps) * maxDist;
      const x = from.x + dir.x * d, y = from.y + dir.y * d, z = from.z + dir.z * d;
      const b = this.grid.get(this.key(Math.floor(x / CELL), Math.floor(z / CELL)));
      if (!b) continue;
      for (const o of b.obs) {
        if (y < o.y0 || y > o.y1) continue;
        if (o.kind === 'circle') {
          if (Math.hypot(x - o.x, z - o.z) < o.r + 0.15) return d;
        } else if (o.kind === 'ring') {
          const rd = Math.hypot(x - o.x, z - o.z);
          if (rd > o.ri! - 0.15 && rd < o.ro! + 0.15 && !this.inGap(o, Math.atan2(z - o.z, x - o.x), rd, 0, y - 1.5)) return d;
        } else {
          const dx = x - o.x, dz = z - o.z;
          const lx = dx * o.c + dz * o.s, lz = -dx * o.s + dz * o.c;
          if (Math.abs(lx) < o.hx + 0.1 && Math.abs(lz) < o.hz + 0.1) return d;
        }
      }
      for (const s of b.surf) {
        const h = s.height(x, z, y + 0.6);
        if (h !== null && y < h + 0.2 && y > h - 0.6) return d;
      }
    }
    return Infinity;
  }
}
