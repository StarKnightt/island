/**
 * Static collision for the player and the camera: obstacles (circles and oriented boxes in plan, with a height
 * range) and walkable surfaces above the terrain (docks, hut floors, the lighthouse stair and gallery), kept in a
 * uniform grid. Everything is authored by the systems that build the props.
 */
import * as THREE from 'three/webgpu';

export interface Obstacle { kind: 'circle' | 'box'; x: number; z: number; r: number; hx: number; hz: number; c: number; s: number; y0: number; y1: number }
export interface Surface {
  /** plan bounds for the grid */
  minX: number; maxX: number; minZ: number; maxZ: number;
  /** height of the walkable top at (x, z), or null outside it */
  height(x: number, z: number): number | null;
  material: 'wood' | 'stone' | 'metal';
}

const CELL = 16;

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
      const h = s.height(x, z);
      if (h === null || h > maxY) continue;
      if (!best || h > best.y) best = { y: h, material: s.material };
    }
    return best;
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
    let best = Infinity;
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
        } else {
          const dx = x - o.x, dz = z - o.z;
          const lx = dx * o.c + dz * o.s, lz = -dx * o.s + dz * o.c;
          if (Math.abs(lx) < o.hx + 0.1 && Math.abs(lz) < o.hz + 0.1) return d;
        }
      }
      for (const s of b.surf) {
        const h = s.height(x, z);
        if (h !== null && y < h + 0.2 && y > h - 0.6) return d;
      }
    }
    return best;
  }
}
