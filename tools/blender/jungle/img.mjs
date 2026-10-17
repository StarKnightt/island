// Small image utility for the jungle asset pipeline (uses the repo's sharp).
//   node tools/blender/jungle/img.mjs sheet <out.jpg> <cols> <cellW> <img1> [img2 ...]   contact sheet with file labels
//   node tools/blender/jungle/img.mjs torgba <in> <out.rgba>                            raw RGBA8 + <out.rgba>.json {w,h}
//   node tools/blender/jungle/img.mjs fromrgba <in.rgba> <w> <h> <out.png|jpg>           raw RGBA8 -> image
//   node tools/blender/jungle/img.mjs resize <in> <out> <w> [h]
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const [cmd, ...a] = process.argv.slice(2);

if (cmd === 'sheet') {
  const [out, colsS, cellS, ...files] = a;
  const cols = Number(colsS), cw = Number(cellS);
  const cells = [];
  let ch = 0;
  for (const f of files) {
    const img = sharp(f).resize({ width: cw, height: cw, fit: 'inside' }).flatten({ background: '#808080' });
    const { data, info } = await img.png().toBuffer({ resolveWithObject: true });
    cells.push({ data, info, name: path.basename(f) });
    ch = Math.max(ch, info.height);
  }
  const lh = 22, rows = Math.ceil(cells.length / cols);
  const W = cols * cw, H = rows * (ch + lh);
  const comps = [];
  cells.forEach((c, i) => {
    const x = (i % cols) * cw, y = Math.floor(i / cols) * (ch + lh);
    comps.push({ input: c.data, left: x, top: y });
    const svg = `<svg width="${cw}" height="${lh}"><rect width="100%" height="100%" fill="#111"/><text x="4" y="16" font-family="Arial" font-size="14" fill="#fff">${c.name.replace(/&/g, '&amp;').slice(0, 60)}</text></svg>`;
    comps.push({ input: Buffer.from(svg), left: x, top: y + ch });
  });
  await sharp({ create: { width: W, height: H, channels: 3, background: '#202020' } }).composite(comps).jpeg({ quality: 88 }).toFile(out);
  console.log(`sheet ${out} ${W}x${H}`);
} else if (cmd === 'torgba') {
  const [inp, out] = a;
  const { data, info } = await sharp(inp, { limitInputPixels: false }).ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  fs.writeFileSync(out, data);
  fs.writeFileSync(out + '.json', JSON.stringify({ w: info.width, h: info.height }));
  console.log(`torgba ${out} ${info.width}x${info.height}`);
} else if (cmd === 'fromrgba') {
  const [inp, w, h, out] = a;
  const img = sharp(fs.readFileSync(inp), { raw: { width: Number(w), height: Number(h), channels: 4 } });
  if (out.endsWith('.jpg')) await img.flatten({ background: '#000' }).jpeg({ quality: 90 }).toFile(out);
  else await img.png().toFile(out);
  console.log(`fromrgba ${out}`);
} else if (cmd === 'resize') {
  const [inp, out, w, h] = a;
  await sharp(inp).resize({ width: Number(w), height: h ? Number(h) : undefined, fit: 'inside' }).toFile(out);
  console.log(`resize ${out}`);
} else {
  console.error('unknown command');
  process.exit(1);
}
