/**
 * Spray where the swell hits rock: at the foot of the sea cliffs and over the rock shelves, every wave throws up a
 * burst of white water that climbs the wall, hangs as mist and drifts off with the wind. Emitters are points on the
 * rocky waterline near the camera (re-picked as it moves); each burst is timed by the same waterline phase that
 * drives the foam in surf.ts, so the white water on the sea and the spray in the air agree.
 */
import { effectMRT } from '../core/fx';
import * as THREE from 'three/webgpu';
import {
  cameraPosition, exp, float, hash, instanceIndex, int, length, max, mix, positionView, pow, screenUV, select,
  smoothstep, texture, uniform, uniformArray, uv, varying, vec2, vec3, vec4, type N,
} from '../core/tsl';
import type { Heightfield } from '../world/Heightfield';
import { HALF_WORLD, WORLD_SIZE, MASK_RES } from '../world/layout';
import { coastAt, waterlinePhase, surfU, laceTex } from './surf';
import { atmo, particleSky } from '../sky/Atmosphere';
import { cloudShadow } from '../sky/Sky';
import { sceneViewDepth } from '../core/depth';
import { wetness } from '../world/weatherUniforms';
import { preset } from '../core/quality';

const EMITTERS = 40;
const PER = 60;

export const sprayU = {
  /** sun (or moon) radiance on the spray, set from the key light each frame */
  sun: uniform(new THREE.Color(1, 1, 1)),
  /** diagnostics (?spraydebug=1 every particle drawn, 2 without the soft fade) */
  debug: uniform(Number(new URLSearchParams(location.search).get('spraydebug') ?? 0)),
};

export class Spray {
  readonly sprite: THREE.Sprite;
  readonly u = sprayU;
  private points: Float32Array = new Float32Array(0);
  private slots: THREE.Vector4[] = [];
  private arr: N;
  private age = 1e9;
  private last = new THREE.Vector3(1e9, 0, 0);

  constructor(private hf: Heightfield) {
    this.collect();
    this.slots = Array.from({ length: EMITTERS }, () => new THREE.Vector4(1e5, 1e5, 1, 0));
    this.arr = uniformArray(this.slots, 'vec4');
    this.sprite = this.build();
  }

  /** rocky waterline points every ~6 m with their seaward normal: (x, z, nx, nz) */
  private collect() {
    const M = MASK_RES, cell = WORLD_SIZE / M, sh = this.hf.shore, m1 = this.hf.mask1;
    const out: number[] = [];
    const seen = new Set<number>();
    for (let j = 1; j < M - 1; j++) for (let i = 1; i < M - 1; i++) {
      const k = j * M + i;
      const s = sh[k];
      if (s < -1.2 || s > 0.6) continue;
      const kind = (m1[k * 4 + 3] / 255) * 2;
      if (kind < 0.7) continue;
      const x = -HALF_WORLD + (i + 0.5) * cell, z = -HALF_WORLD + (j + 0.5) * cell;
      const key = Math.floor(x / 6) * 100003 + Math.floor(z / 6);
      if (seen.has(key)) continue;
      seen.add(key);
      const gx = sh[k + 1] - sh[k - 1], gz = sh[k + M] - sh[k - M];
      const g = Math.hypot(gx, gz) || 1;
      // (the sea-cliff meshes overhang the baked shoreline by 5-10 m, as in surf.ts: a burst born there rose inside
      // the rock and was never seen)
      const foot = kind > 1.5 ? 7 : kind > 1.1 ? 3.5 : 0;
      out.push(x - (gx / g) * foot, z - (gz / g) * foot, -gx / g, -gz / g);
    }
    this.points = new Float32Array(out);
  }

  private build() {
    const m = new THREE.SpriteNodeMaterial();
    m.transparent = true;
    m.mrtNode = effectMRT();
    m.depthWrite = false;
    m.blending = THREE.NormalBlending;
    const id = float(instanceIndex);
    const e = this.arr.element(int(id.div(PER).floor()));
    const seed = (k: number) => hash(id.mul(k).add(31.7));
    const exz = e.xy;
    const out = vec2(e.z, e.w);
    const along = vec2(out.y.negate(), out.x);
    const c = coastAt(this.hf, exz.sub(out.mul(2)));
    const ph = waterlinePhase(c);
    // this wave's strength at this point of the coast (the set, cliffs more than shelves, the weather)
    const big = float(0.72).add(hash(ph.n0.add(5000)).sub(0.5).mul(0.22)).add(ph.n0.mul(Math.PI * 2 / 6.3).add(0.7).sin().mul(0.25));
    const hit = c.wc.add(c.wr.mul(0.55)).mul(big).mul(surfU.storm.mul(0.7).add(1)).mul(float(1).sub(c.shelter));
    // two kinds: the burst (fast, rising high, a few seconds) and the mist it leaves (slow, low, outliving the wave,
    // so a haze hangs at the foot of the wall between bursts)
    const mist = seed(10.3).lessThan(0.38);
    const tRaw = ph.tau0.sub(seed(1.7).mul(0.7));
    // (a fifth of the burst, on the strong waves only, is the tall column: the swell slamming into the wall and thrown
    // a quarter of the way up it, there and gone in two seconds)
    const tall = mist.not().and(seed(11.7).lessThan(0.4)).and(hit.greaterThan(0.35));
    const life = select(mist, float(5.5).add(seed(2.3).mul(3.5)), select(tall, float(1.7).add(seed(2.3).mul(0.8)), float(3.0).add(seed(2.3).mul(2.2))));
    const t = select(mist.and(tRaw.lessThan(0)), tRaw.add(surfU.period), tRaw);
    const u = t.div(life);
    const alive = t.greaterThan(0).and(u.lessThan(1)).and(seed(9.1).lessThan(hit.mul(0.9).add(0.1)));
    // ballistic with heavy drag: a fast climb that stalls into hanging mist, carried off by the wind
    const k = select(mist, float(1.8), select(tall, float(0.8), float(1.1)));
    // (a third of the burst is the sheet thrown straight up the wall, the rest a plume leaning out to sea)
    const sheet = seed(4.9).lessThan(0.35).and(seed(10.3).greaterThanEqual(0.38));
    const v0up = select(tall, float(22).add(seed(3.1).mul(12)).mul(hit.clamp(0.6, 1.3)), select(mist, float(1).add(seed(3.1).mul(3)), select(sheet, float(10).add(seed(3.1).mul(14)), float(5).add(seed(3.1).mul(11)))).mul(hit.clamp(0.3, 1.4)));
    // (out from the wall as they climb: the drawn faces lean out over the foot, and a sheet hugging the line rose inside the rock)
    const v0out = select(tall, float(0.6).add(seed(4.3).mul(0.8)), select(sheet, float(1.2).add(seed(4.3).mul(1.4)), float(1.6).add(seed(4.3).mul(2.8))));
    const v0al = seed(5.9).sub(0.5).mul(4);
    const tt = max(t, 0);
    const reach = float(1).sub(exp(tt.mul(k).negate())).div(k);
    const wd = wetness.windDir.mul(wetness.wind.mul(3).add(0.8));
    const up = v0up.mul(reach).sub(select(mist, float(0.02), float(9.81 * 0.35)).mul(tt.mul(tt)));
    const horiz = out.mul(v0out.mul(reach).add(select(tall, float(2.0), select(sheet, float(1.4), float(1.8))))).add(along.mul(v0al.mul(reach).add(seed(6.6).sub(0.5).mul(5)))).add(wd.mul(tt));
    const p = vec3(exz.x, 0.25, exz.y).add(vec3(horiz.x, max(up, 0.2), horiz.y));
    m.positionNode = p;
    const size = mix(float(1.6), select(mist, float(8.5), select(tall, float(10.0), select(sheet, float(7.5), float(6.0)))), pow(u.clamp(0, 1), 0.5)).mul(seed(7.7).mul(0.6).add(0.7)).mul(hit.clamp(0.4, 1.2));
    m.scaleNode = vec2(size, size);
    // per particle (vertex stage): lit by the sun (forward scattering toward the eye when backlit) and the sky,
    // under the cloud shadows; its life fade
    const V = cameraPosition.sub(p).normalize();
    const L = atmo.sunDir.normalize();
    const fwd = pow(max(L.negate().dot(V), 0), 6).mul(1.6);
    const sunL = vec3(sprayU.sun).mul(fwd.add(0.32)).mul(cloudShadow(p));
    const col = varying(sunL.mul(0.9).add(particleSky().mul(2.6)).mul(0.85));
    const dist = length(p.sub(cameraPosition));
    const fade = varying(pow(float(1).sub(u.clamp(0, 1)), 1.4).mul(smoothstep(0.0, 0.08, u)).mul(smoothstep(2, 8, dist)).mul(select(alive, select(mist, float(0.3), select(tall, float(0.7), float(0.95))), float(0))));
    const tex = varying(vec2(seed(8.2), seed(8.9)));
    // per pixel: a soft, lumpy puff, faded where it meets rock or water
    const r = length(uv().sub(0.5)).mul(2);
    const lump = texture(laceTex, uv().mul(0.22).add(tex)).b;
    // (chunky: the lumps cut deep into each puff, so a burst reads as torn white water, not soft round discs)
    // (the mist it leaves stays soft: hard-edged, its big puffs read as discs)
    // (the tall column too: chunky puffs that high up read as cotton balls; soft ones merge into one plume)
    const puff = select(mist.or(tall), smoothstep(1.0, 0.0, r).pow(2.2).mul(lump.mul(1.4).sub(0.1).clamp(0.2, 1.2)),
      smoothstep(1.0, 0.15, r).pow(1.3).mul(lump.mul(2.2).sub(0.55).clamp(0.0, 1.3)));
    const soft = smoothstep(0.0, 1.6, sceneViewDepth(screenUV).sub(positionView.z.negate()));
    const a = select(sprayU.debug.greaterThan(1.5), puff.mul(fade), select(sprayU.debug.greaterThan(0.5), puff, puff.mul(fade).mul(soft)));
    m.colorNode = vec4(col, a);
    m.opacityNode = a;
    const sprite = new THREE.Sprite(m);
    (sprite as unknown as { count: number }).count = preset === 'low' ? EMITTERS * 12 : EMITTERS * PER;
    sprite.frustumCulled = false;
    sprite.renderOrder = 22;
    sprite.name = 'spray';
    return sprite;
  }

  /** re-pick the emitters nearest the camera (in front of it first) when it has moved */
  update(dt: number, camera: THREE.Camera) {
    this.age += dt;
    const cp = camera.position;
    if (this.age < 0.5 && cp.distanceToSquared(this.last) < 100) return;
    this.age = 0;
    this.last.copy(cp);
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    const P = this.points;
    const best: { i: number; d: number }[] = [];
    for (let i = 0; i < P.length; i += 4) {
      const dx = P[i] - cp.x, dz = P[i + 1] - cp.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 420 * 420) continue;
      const d = Math.sqrt(d2);
      const facing = (dx * fwd.x + dz * fwd.z) / (d || 1);
      best.push({ i, d: d * (facing > -0.2 ? 1 : 3) });
    }
    best.sort((a, b) => a.d - b.d);
    for (let k = 0; k < EMITTERS; k++) {
      const b = best[k];
      if (b) this.slots[k].set(P[b.i], P[b.i + 1], P[b.i + 2], P[b.i + 3]);
      else this.slots[k].set(1e5, 1e5, 1, 0);
    }
  }
}
