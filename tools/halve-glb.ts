/**
 * Halve the large textures inside GLBs without re-encoding anything: every embedded UASTC/Zstandard KTX2 image at or
 * above --min pixels wide loses its top mip level (the next level down is already in the file), and the GLB's binary
 * chunk is repacked around the smaller images (meshopt-compressed geometry is copied byte for byte).
 * With --share <dir>, an image found byte-identical in more than one of the given GLBs moves out to <dir>/<hash>.ktx2
 * and each GLB refers to it by URI, so it is downloaded once (the trees and the palms share their atlases).
 *   pnpm tsx tools/halve-glb.ts [--min 2048] [--share public/assets/shared] file.glb ...
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, relative, join } from 'node:path';

const args = process.argv.slice(2);
let min = 2048;
let shareDir = '';
const files: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--min') min = Number(args[++i]);
  else if (args[i] === '--share') shareDir = args[++i];
  else files.push(args[i]);
}
const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex').slice(0, 16);

/** the embedded KTX2 images of a GLB */
function images(file: string): Buffer[] {
  const glb = readFileSync(file);
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen + 8;
  return (json.images ?? []).filter((im: { bufferView?: number }) => im.bufferView !== undefined).map((im: { bufferView: number }) => {
    const v = json.bufferViews[im.bufferView];
    return glb.subarray(binStart + (v.byteOffset ?? 0), binStart + (v.byteOffset ?? 0) + v.byteLength);
  });
}
// (hashes after halving, so two files halved alike still match)
const seenIn = new Map<string, Set<string>>();
if (shareDir) {
  for (const f of files) {
    for (const im of images(f)) {
      const d = im.readUInt32LE(20) >= min ? dropTopMip(im) ?? im : im;
      const h = md5(d);
      (seenIn.get(h) ?? seenIn.set(h, new Set()).get(h)!).add(f);
    }
  }
  mkdirSync(shareDir, { recursive: true });
}

/** a KTX2 file without its largest mip level, or null when it cannot be halved */
function dropTopMip(src: Buffer): Buffer | null {
  const levels = src.readUInt32LE(40);
  const w = src.readUInt32LE(20), h = src.readUInt32LE(24);
  if (levels < 2 || src.readUInt32LE(28) > 1 || src.readUInt32LE(32) > 1 || src.readUInt32LE(36) !== 1) return null;
  const dfdOff = src.readUInt32LE(48), dfdLen = src.readUInt32LE(52), kvdOff = src.readUInt32LE(56), kvdLen = src.readUInt32LE(60);
  const sgdOff = Number(src.readBigUInt64LE(64)), sgdLen = Number(src.readBigUInt64LE(72));
  if (sgdLen > 0) return null; // (BasisLZ global data describes every level: not handled)
  const lv = [...Array(levels)].map((_, i) => ({ off: Number(src.readBigUInt64LE(80 + i * 24)), len: Number(src.readBigUInt64LE(88 + i * 24)), raw: Number(src.readBigUInt64LE(96 + i * 24)) }));
  const keep = lv.slice(1);
  const indexEnd = 80 + keep.length * 24;
  const meta = Buffer.concat([src.subarray(dfdOff, dfdOff + dfdLen), src.subarray(kvdOff, kvdOff + kvdLen)]);
  const head = Buffer.alloc(indexEnd);
  src.copy(head, 0, 0, 48);
  head.writeUInt32LE(Math.max(1, w >> 1), 20);
  head.writeUInt32LE(h > 0 ? Math.max(1, h >> 1) : 0, 24);
  head.writeUInt32LE(keep.length, 40);
  head.writeUInt32LE(indexEnd, 48);
  head.writeUInt32LE(dfdLen, 52);
  head.writeUInt32LE(kvdLen ? indexEnd + dfdLen : 0, 56);
  head.writeUInt32LE(kvdLen, 60);
  head.writeBigUInt64LE(0n, 64);
  head.writeBigUInt64LE(0n, 72);
  void sgdOff;
  // the levels, smallest first as the writers lay them out
  let at = indexEnd + meta.length;
  const order = keep.map((l, i) => ({ ...l, i })).sort((a, b) => b.i - a.i);
  const chunks: Buffer[] = [];
  for (const l of order) {
    head.writeBigUInt64LE(BigInt(at), 80 + l.i * 24);
    head.writeBigUInt64LE(BigInt(l.len), 88 + l.i * 24);
    head.writeBigUInt64LE(BigInt(l.raw), 96 + l.i * 24);
    chunks.push(src.subarray(l.off, l.off + l.len));
    at += l.len;
  }
  return Buffer.concat([head, meta, ...chunks]);
}

for (const file of files) {
  const glb = readFileSync(file);
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen + 8;
  const binLen = glb.readUInt32LE(20 + jsonLen);
  const bin = glb.subarray(binStart, binStart + binLen);
  // every range of the binary chunk: plain buffer views and meshopt's compressed streams
  type R = { off: number; len: number; set(off: number, len: number): void; img?: number };
  const ranges: R[] = [];
  const imageView = new Map<number, number>();
  (json.images ?? []).forEach((im: { bufferView?: number; mimeType?: string }, i: number) => {
    if (im.bufferView !== undefined && im.mimeType === 'image/ktx2') imageView.set(im.bufferView, i);
  });
  json.bufferViews.forEach((bv: { buffer: number; byteOffset?: number; byteLength: number; extensions?: Record<string, { buffer: number; byteOffset?: number; byteLength: number }> }, i: number) => {
    if (bv.buffer === 0) ranges.push({ off: bv.byteOffset ?? 0, len: bv.byteLength, set: (o, l) => { bv.byteOffset = o; bv.byteLength = l; }, img: imageView.get(i) });
    const ext = bv.extensions?.EXT_meshopt_compression;
    if (ext && ext.buffer === 0) ranges.push({ off: ext.byteOffset ?? 0, len: ext.byteLength, set: (o, l) => { ext.byteOffset = o; ext.byteLength = l; } });
  });
  ranges.sort((a, b) => a.off - b.off);
  for (let i = 1; i < ranges.length; i++) if (ranges[i].off < ranges[i - 1].off + ranges[i - 1].len) throw new Error(`${file}: overlapping buffer ranges`);
  const out: Buffer[] = [];
  let at = 0, halved = 0, shared = 0;
  for (const r of ranges) {
    let data: Buffer = bin.subarray(r.off, r.off + r.len);
    if (r.img !== undefined && data.readUInt32LE(20) >= min) {
      const d = dropTopMip(data);
      if (d) {
        data = d;
        halved++;
      }
    }
    if (r.img !== undefined && shareDir && (seenIn.get(md5(data))?.size ?? 0) > 1) {
      const name = `${md5(data)}.ktx2`;
      writeFileSync(join(shareDir, name), data);
      const im = json.images[r.img];
      delete im.bufferView;
      im.uri = relative(dirname(file), join(shareDir, name)).replace(/\\/g, '/');
      // (the view stays, unused, over four bytes: indices of the other views do not move)
      data = Buffer.alloc(4);
      shared++;
    }
    r.set(at, data.length);
    out.push(data);
    at += data.length;
    const pad = (4 - (at % 4)) % 4;
    if (pad) {
      out.push(Buffer.alloc(pad));
      at += pad;
    }
  }
  json.buffers[0].byteLength = at;
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]);
  const newBin = Buffer.concat(out);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + newBin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonBuf.length, 0);
  jh.write('JSON', 4, 'ascii');
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(newBin.length, 0);
  bh.write('BIN\0', 4, 'ascii');
  writeFileSync(file, Buffer.concat([header, jh, jsonBuf, bh, newBin]));
  console.log(`${file}: ${halved} images halved, ${shared} shared, ${(glb.length / 1048576).toFixed(1)} -> ${((12 + 16 + jsonBuf.length + newBin.length) / 1048576).toFixed(1)} MB`);
}
