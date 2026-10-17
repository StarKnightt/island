/**
 * Spectral (FFT) wave simulation on WebGPU compute: three cascades of a JONSWAP + swell spectrum, evolved in frequency
 * space every frame, inverse-transformed in workgroup memory, then assembled into displacement / derivative maps with
 * a persistent Jacobian foam history.
 *
 * Adapted from the "submerged-snell-ocean" example of the threejs-spectral-ocean agent skill
 * (scottstts/threejs-awesome-graphics-agent-skills, MIT licence; see CREDITS.md): the spectrum (JONSWAP x TMA x
 * directional spreading, Hermitian packed), the shared-memory radix-2 IFFT and the assembly kernel follow it; the
 * sea state, cascade sizes and the probe readback are this game's.
 */
import * as THREE from 'three/webgpu';
import { StorageTexture, StorageBufferAttribute } from 'three/webgpu';
import {
  Fn, float, instanceIndex, int, ivec2, max, min, select, texture, textureLoad, textureStore, uint, uniform, vec2, vec4,
  localId, workgroupArray, workgroupBarrier, workgroupId, storage, type N,
} from '../core/tsl';
import { Rng } from '../core/noise';

export interface SeaState {
  gravity: number; depth: number; windSpeed: number; windAzimuth: number; fetch: number;
  localScale: number; swellScale: number; swellAzimuth: number; swellOmega: number; shortWaveFade: number;
}

/** trade-wind sea from the east-south-east with a long south-easterly swell */
export const SEA: SeaState = {
  gravity: 9.81, depth: 400, windSpeed: 7.5, windAzimuth: Math.PI * 1.07, fetch: 220_000,
  localScale: 1.0, swellScale: 0.65, swellAzimuth: Math.PI * 0.86, swellOmega: 0.62, shortWaveFade: 0.003,
};

export const OCEAN = {
  resolution: 256,
  patchLengths: [233, 37, 7.3],
  boundaryFactor: 6,
  choppiness: 1.25,
  foamRecovery: 0.32,
  amplitude: 0.42,
};

function jonswapTma(omega: number, sea: SeaState): number {
  const { gravity: g, windSpeed, fetch, depth } = sea;
  if (omega <= 0) return 0;
  const alpha = 0.076 * Math.pow((g * fetch) / (windSpeed * windSpeed), -0.22);
  const peakOmega = 22 * Math.pow((windSpeed * fetch) / (g * g), -0.33);
  const sigma = omega <= peakOmega ? 0.07 : 0.09;
  const r = Math.exp(-((omega - peakOmega) ** 2) / (2 * sigma * sigma * peakOmega * peakOmega));
  const jonswap = ((alpha * g * g) / omega ** 5) * Math.exp(-1.25 * Math.pow(peakOmega / omega, 4)) * Math.pow(3.3, r);
  const omegaH = omega * Math.sqrt(depth / g);
  const phi = omegaH <= 1 ? 0.5 * omegaH * omegaH : omegaH < 2 ? 1 - 0.5 * (2 - omegaH) ** 2 : 1;
  return jonswap * phi;
}
const wrapAngle = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
function spreading(delta: number, omegaOverPeak: number): number {
  const cosHalf = Math.max(Math.cos(delta * 0.5), 0);
  const broad = cosHalf * cosHalf;
  const power = 4 + 24 * Math.min(1, Math.max(0, omegaOverPeak - 0.4));
  return (broad * 0.35 + Math.pow(cosHalf, power) * 0.65) * (1 / Math.PI);
}

interface Band { patchLength: number; cutoffLow: number; cutoffHigh: number }

function spectrumTexture(rng: Rng, band: Band, sea: SeaState, n: number): { tex: THREE.DataTexture; slope2: number } {
  const deltaK = (Math.PI * 2) / band.patchLength;
  const { gravity: g, depth } = sea;
  const peakOmega = 22 * Math.pow((sea.windSpeed * sea.fetch) / (g * g), -0.33);
  const h0 = new Float32Array(n * n * 2);
  let slope2 = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const kx = (i - n / 2) * deltaK, kz = (j - n / 2) * deltaK;
    const kLength = Math.hypot(kx, kz);
    const index = (j * n + i) * 2;
    const u1 = Math.max(rng.next(), 1e-9), u2 = rng.next();
    if (kLength < band.cutoffLow || kLength > band.cutoffHigh || kLength < 1e-6) continue;
    const kSafe = Math.max(kLength, band.cutoffLow > 0 ? band.cutoffLow : 1e-4);
    const tanhArg = Math.min(kSafe * depth, 20);
    const tanhKd = Math.tanh(tanhArg);
    const omega = Math.sqrt(g * kSafe * tanhKd);
    const sech2 = tanhArg >= 20 ? 0 : 1 / Math.cosh(tanhArg) ** 2;
    const dOmegaDk = Math.max((g * tanhKd + g * kSafe * depth * sech2) / (2 * omega), 1e-6);
    const theta = Math.atan2(kz, kx);
    const local = jonswapTma(omega, sea) * spreading(wrapAngle(theta - sea.windAzimuth), omega / peakOmega) * sea.localScale;
    const swell = sea.swellScale * Math.exp(-(((omega - sea.swellOmega) / 0.12) ** 2)) *
      Math.pow(Math.max(Math.cos(wrapAngle(theta - sea.swellAzimuth) * 0.5), 0), 48) * 0.9;
    const energy = (local + swell) * Math.exp(-(sea.shortWaveFade ** 2) * kLength * kLength);
    const amplitude = Math.sqrt(((energy * 2 * dOmegaDk) / kSafe) * deltaK * deltaK);
    slope2 += kLength * kLength * amplitude * amplitude * 2;
    const mag = Math.sqrt(-2 * Math.log(u1));
    h0[index] = (mag * Math.cos(Math.PI * 2 * u2) * amplitude) / Math.SQRT2;
    h0[index + 1] = (mag * Math.sin(Math.PI * 2 * u2) * amplitude) / Math.SQRT2;
  }
  const packed = new Float32Array(n * n * 4);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const src = (j * n + i) * 2, mirror = (((n - j) % n) * n + ((n - i) % n)) * 2, dst = (j * n + i) * 4;
    packed[dst] = h0[src];
    packed[dst + 1] = h0[src + 1];
    packed[dst + 2] = h0[mirror];
    packed[dst + 3] = -h0[mirror + 1];
  }
  const t = new THREE.DataTexture(packed, n, n, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return { tex: t, slope2 };
}

function freqTexture(n: number) {
  const t = new StorageTexture(n, n);
  t.type = THREE.FloatType;
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
}
function mapTexture(n: number) {
  const t = new StorageTexture(n, n);
  t.type = THREE.HalfFloatType;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}

/** radix-2 inverse FFT of the packed complex fields, one workgroup per row / column (n <= 256) */
function ifftStages(ping: StorageTexture, pong: StorageTexture, n: number): N[] {
  const logN = Math.log2(n);
  const axis = (source: StorageTexture, dest: StorageTexture, horizontal: boolean) => {
    const shared = workgroupArray('vec4', n);
    return Fn(() => {
      const lane = localId.x.toVar();
      const line = int(workgroupId.x);
      const reversed = uint(0).toVar();
      const remaining = lane.toVar();
      for (let bit = 0; bit < logN; bit++) {
        reversed.assign(reversed.shiftLeft(1).bitOr(remaining.bitAnd(1)));
        remaining.assign(remaining.shiftRight(1));
      }
      const input = horizontal ? ivec2(int(reversed), line) : ivec2(line, int(reversed));
      shared.element(lane).assign(textureLoad(texture(source), input));
      workgroupBarrier();
      for (let stage = 0; stage < logN; stage++) {
        const groupSize = uint(1 << (stage + 1));
        const halfSize = uint(1 << stage);
        const local = lane.mod(groupSize);
        const top = local.lessThan(halfSize);
        const offset = local.mod(halfSize);
        const indexA = select(top, lane, lane.sub(halfSize));
        const indexB = indexA.add(halfSize);
        const a = shared.element(indexA).toVar();
        const b = shared.element(indexB).toVar();
        const angle = float(offset).mul((Math.PI * 2) / (1 << (stage + 1)));
        const sign = select(top, float(1), float(-1));
        const w = vec2(angle.cos(), angle.sin()).mul(sign);
        const f1 = a.xy.add(vec2(b.x.mul(w.x).sub(b.y.mul(w.y)), b.x.mul(w.y).add(b.y.mul(w.x))));
        const f2 = a.zw.add(vec2(b.z.mul(w.x).sub(b.w.mul(w.y)), b.z.mul(w.y).add(b.w.mul(w.x))));
        const res = vec4(f1, f2).toVar();
        workgroupBarrier();
        shared.element(lane).assign(res);
        workgroupBarrier();
      }
      const output = horizontal ? ivec2(int(lane), line) : ivec2(line, int(lane));
      textureStore(dest, output, shared.element(lane));
    })().compute(n * n, [n]);
  };
  return [axis(ping, pong, true), axis(pong, ping, false)];
}

interface Cascade {
  patchLength: number;
  evolve: N;
  stages: N[];
  assemble: [N, N];
  clear: [N, N];
  disp: [StorageTexture, StorageTexture];
  deriv: StorageTexture;
}

export class OceanSim {
  readonly patchLengths = OCEAN.patchLengths;
  /** texture nodes repointed at the freshest maps after every update */
  readonly dispNodes: N[];
  readonly derivNodes: N[];
  /** mean square slope of each cascade at unit amplitude scale (the shader folds faded-out slopes into roughness) */
  readonly slope2: number[] = [];
  private cascades: Cascade[];
  private timeU = uniform(0);
  private dtU = uniform(1 / 60);
  private current = 0;
  private initialized = false;
  /** probes: world xz in, displacement (dx, dy, dz) out (async readback, a frame or two late) */
  private probeIn: StorageBufferAttribute;
  private probeOut: StorageBufferAttribute;
  private probeNode: N;
  private probeBusy = false;
  readonly probeCount = 16;
  probeXZ = new Float32Array(16 * 4);
  probeResult = new Float32Array(16 * 4);
  amplitudeU = uniform(OCEAN.amplitude);

  constructor(seed = 7) {
    const n = OCEAN.resolution;
    const logN = Math.log2(n);
    const mask = uint(n - 1);
    const shift = uint(logN);
    const pl = OCEAN.patchLengths;
    const handoff = (i: number) => ((Math.PI * 2) / pl[i]) * OCEAN.boundaryFactor;
    const bands: Band[] = pl.map((p, i) => ({ patchLength: p, cutoffLow: i === 0 ? 1e-4 : handoff(i), cutoffHigh: i === pl.length - 1 ? 1e4 : handoff(i + 1) }));
    const rng = new Rng(seed);
    const cellOf = () => {
      const x = int(instanceIndex.bitAnd(mask));
      const y = int(instanceIndex.shiftRight(shift));
      return { x, y, cell: ivec2(x, y) };
    };
    const choppy = OCEAN.choppiness;
    this.cascades = bands.map((band) => {
      const { tex: spectrum, slope2 } = spectrumTexture(rng, band, SEA, n);
      this.slope2.push(slope2);
      const ping = freqTexture(n), pong = freqTexture(n);
      const stages = ifftStages(ping, pong, n);
      const disp: [StorageTexture, StorageTexture] = [mapTexture(n), mapTexture(n)];
      const deriv = mapTexture(n);
      const twoPiOverPatch = (Math.PI * 2) / band.patchLength;
      const amp = this.amplitudeU;
      const evolve = Fn(() => {
        const { x, y, cell } = cellOf();
        const h0 = textureLoad(texture(spectrum), cell);
        const k = vec2(float(x).sub(n / 2), float(y).sub(n / 2)).mul(twoPiOverPatch);
        const kLength = max(k.length(), 1e-4);
        const omega = k.length().mul(SEA.gravity).mul(min(kLength.mul(SEA.depth), 20.0).tanh()).sqrt();
        const phase = omega.mul(this.timeU);
        const pc = phase.cos(), ps = phase.sin();
        const h = vec2(
          h0.x.mul(pc).sub(h0.y.mul(ps)).add(h0.z.mul(pc).sub(h0.w.mul(ps.negate()))),
          h0.x.mul(ps).add(h0.y.mul(pc)).add(h0.z.mul(ps.negate()).add(h0.w.mul(pc))),
        ).mul(amp);
        const ih = vec2(h.y.negate(), h.x);
        const dx = ih.mul(k.x.div(kLength));
        const dz = ih.mul(k.y.div(kLength));
        textureStore(ping, cell, vec4(h, vec2(dx.x.sub(dz.y), dx.y.add(dz.x))));
      })().compute(n * n);
      const spatial = ping;
      const inverseSpacing = n / (2 * band.patchLength);
      const makeAssemble = (prev: StorageTexture, next: StorageTexture) => Fn(() => {
        const { x, y, cell } = cellOf();
        const parity = float(int(instanceIndex.bitAnd(mask)).add(int(instanceIndex.shiftRight(shift))).bitAnd(int(1)));
        const sign = float(1).sub(parity.mul(2));
        const nSign = sign.negate();
        const xp = int(uint(x.add(1)).bitAnd(mask)), xm = int(uint(x.add(n - 1)).bitAnd(mask));
        const yp = int(uint(y.add(1)).bitAnd(mask)), ym = int(uint(y.add(n - 1)).bitAnd(mask));
        const center = textureLoad(texture(spatial), cell);
        const right = textureLoad(texture(spatial), ivec2(xp, y)).mul(nSign);
        const left = textureLoad(texture(spatial), ivec2(xm, y)).mul(nSign);
        const up = textureLoad(texture(spatial), ivec2(x, yp)).mul(nSign);
        const down = textureLoad(texture(spatial), ivec2(x, ym)).mul(nSign);
        const height = center.x.mul(sign);
        const horizontal = center.zw.mul(sign);
        const slopeX = right.x.sub(left.x).mul(inverseSpacing);
        const slopeZ = up.x.sub(down.x).mul(inverseSpacing);
        const dDxDx = right.z.sub(left.z).mul(inverseSpacing);
        const dDzDz = up.w.sub(down.w).mul(inverseSpacing);
        const dDxDz = up.z.sub(down.z).mul(inverseSpacing);
        const dDzDx = right.w.sub(left.w).mul(inverseSpacing);
        const jxx = float(1).add(dDxDx.mul(choppy));
        const jzz = float(1).add(dDzDz.mul(choppy));
        const jxz = dDxDz.add(dDzDx).mul(0.5).mul(choppy);
        const jac = jxx.mul(jzz).sub(jxz.mul(jxz));
        const prevH = textureLoad(texture(prev), cell).w;
        const rec = prevH.add(this.dtU.mul(OCEAN.foamRecovery).div(max(jac, 0.5)));
        const hist = min(min(jac, rec), 2.0);
        textureStore(next, cell, vec4(horizontal.x.mul(choppy), height, horizontal.y.mul(choppy), hist));
        textureStore(deriv, cell, vec4(slopeX, slopeZ, dDxDx.mul(choppy), dDzDz.mul(choppy)));
      })().compute(n * n);
      const makeClear = (t: StorageTexture) => Fn(() => {
        textureStore(t, cellOf().cell, vec4(0, 0, 0, 1));
      })().compute(n * n);
      return {
        patchLength: band.patchLength, evolve, stages,
        assemble: [makeAssemble(disp[0], disp[1]), makeAssemble(disp[1], disp[0])],
        clear: [makeClear(disp[0]), makeClear(disp[1])],
        disp, deriv,
      } as Cascade;
    });
    this.dispNodes = this.cascades.map((c) => texture(c.disp[0]));
    this.derivNodes = this.cascades.map((c) => texture(c.deriv));

    // probes: sum the cascades' displacement at a few world points
    this.probeIn = new StorageBufferAttribute(this.probeXZ, 4);
    this.probeOut = new StorageBufferAttribute(new Float32Array(this.probeCount * 4), 4);
    const inB = storage(this.probeIn, 'vec4', this.probeCount);
    const outB = storage(this.probeOut, 'vec4', this.probeCount);
    this.probeNode = Fn(() => {
      const p = inB.element(instanceIndex);
      const xz = p.xy;
      let d: N = vec4(0);
      for (let i = 0; i < this.cascades.length; i++) {
        const uvc = xz.div(this.cascades[i].patchLength);
        d = d.add(this.dispNodes[i].sample(uvc).level(0));
      }
      outB.element(instanceIndex).assign(vec4(d.x, d.y, d.z, p.z));
    })().compute(this.probeCount);
  }

  update(renderer: THREE.WebGPURenderer, elapsed: number, dt: number) {
    if (!this.initialized) {
      this.initialized = true;
      for (const c of this.cascades) {
        renderer.compute(c.clear[0]);
        renderer.compute(c.clear[1]);
      }
    }
    this.timeU.value = elapsed;
    this.dtU.value = Math.min(dt, 0.1);
    renderer.compute(this.cascades.map((c) => c.evolve));
    for (let s = 0; s < 2; s++) renderer.compute(this.cascades.map((c) => c.stages[s]));
    const parity = this.current;
    renderer.compute(this.cascades.map((c) => c.assemble[parity]));
    this.current = 1 - this.current;
    for (let i = 0; i < this.cascades.length; i++) this.dispNodes[i].value = this.cascades[i].disp[this.current === 0 ? 0 : 1];
    // probes
    if (!this.probeBusy) {
      this.probeBusy = true;
      (this.probeIn.array as Float32Array).set(this.probeXZ);
      this.probeIn.needsUpdate = true;
      renderer.compute(this.probeNode);
      renderer.getArrayBufferAsync(this.probeOut).then((buf) => {
        this.probeResult.set(new Float32Array(buf as ArrayBuffer));
        this.probeBusy = false;
      }, () => (this.probeBusy = false));
    }
  }

  /** set probe i to a world position */
  setProbe(i: number, x: number, z: number) {
    this.probeXZ[i * 4] = x;
    this.probeXZ[i * 4 + 1] = z;
    this.probeXZ[i * 4 + 2] = i;
  }
  /** last read displacement at probe i: [dx, dy, dz] (open-sea amplitude; the caller attenuates near shore) */
  probe(i: number): [number, number, number] {
    return [this.probeResult[i * 4], this.probeResult[i * 4 + 1], this.probeResult[i * 4 + 2]];
  }
}
