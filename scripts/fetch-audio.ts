/**
 * Finds and downloads CC0 sounds from Freesound (HQ Ogg previews of CC0 works; no API key needed) into
 * E:\tmp\island\raw\audio\ with their metadata (author, title, link) for CREDITS.md.
 *
 *   pnpm tsx scripts/fetch-audio.ts
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAW = 'E:/tmp/island/raw/audio';
mkdirSync(RAW, { recursive: true });

interface Want { id: string; q: string; n: number; min: number; max: number; sort?: string; must?: RegExp }
const WANTS: Want[] = [
  { id: 'waves', q: 'waves beach gentle', n: 2, min: 40, max: 900 },
  { id: 'waves_b', q: 'ocean waves shore', n: 2, min: 40, max: 900 },
  { id: 'surf', q: 'ocean surf', n: 1, min: 30, max: 900, must: /surf|ocean|sea|wave/i },
  { id: 'wind', q: 'wind trees ambience', n: 1, min: 40, max: 900 },
  { id: 'birds', q: 'tropical birds', n: 2, min: 30, max: 900 },
  { id: 'jungle', q: 'rainforest ambience', n: 1, min: 40, max: 900 },
  { id: 'night', q: 'night insects frogs', n: 2, min: 30, max: 900 },
  { id: 'rain', q: 'rain leaves forest', n: 1, min: 30, max: 900, must: /rain/i },
  { id: 'rain_heavy', q: 'heavy rain storm', n: 1, min: 30, max: 900, must: /rain/i },
  { id: 'thunder', q: 'thunder', n: 3, min: 4, max: 40 },
  { id: 'waterfall', q: 'waterfall', n: 1, min: 20, max: 900 },
  { id: 'chimes', q: 'wind chimes', n: 1, min: 15, max: 400 },
  { id: 'chickens', q: 'chickens', n: 1, min: 10, max: 300 },
  { id: 'creak', q: 'boat creaking', n: 1, min: 10, max: 300 },
  { id: 'gulls', q: 'seagulls', n: 1, min: 10, max: 300 },
  { id: 'steps_sand', q: 'footsteps sand', n: 1, min: 4, max: 120 },
  { id: 'steps_leaves', q: 'footsteps leaves', n: 1, min: 4, max: 120, must: /step|walk/i },
  { id: 'steps_stone', q: 'footsteps stone', n: 1, min: 4, max: 120, must: /step|walk/i },
  { id: 'steps_water', q: 'walking in water', n: 1, min: 4, max: 120, must: /water|wad|splash/i },
  { id: 'steps_metal', q: 'footsteps metal', n: 1, min: 4, max: 120, must: /step|walk|stair/i },
  { id: 'swim', q: 'swimming', n: 1, min: 4, max: 120, must: /swim/i },
];

interface Hit { sid: string; user: string; title: string; dur: number; dl: number; ogg: string }

async function search(q: string): Promise<Hit[]> {
  const url = `https://freesound.org/search/?q=${encodeURIComponent(q)}&f=license%3A%22Creative+Commons+0%22&s=Downloads+%28most+first%29`;
  const html = await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  const out: Hit[] = [];
  const re = /data-sound-id="(\d+)"[\s\S]*?data-username="([^"]+)"[\s\S]*?data-ogg="([^"]+)"[\s\S]*?data-title="([^"]*)"[\s\S]*?data-duration="([\d.]+)"[\s\S]*?data-num-downloads="(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push({ sid: m[1], user: m[2], ogg: m[3].replace('-lq.ogg', '-hq.ogg'), title: m[4], dur: Number(m[5]), dl: Number(m[6]) });
  return out;
}

async function main() {
  const metaPath = join(RAW, 'meta.json');
  const meta: Record<string, unknown[]> = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
  const used = new Set<string>();
  for (const w of WANTS) {
    if (meta[w.id]) {
      console.log('have', w.id);
      for (const h of meta[w.id] as Hit[]) used.add(h.sid);
      continue;
    }
    const bad = /music|song|beat|starship|interweb|loop kit|synth|game|drone|guitar|piano|voice|speech|no rain|strike/i;
    const hits = (await search(w.q)).filter((h) => h.dur >= w.min && h.dur <= w.max && !used.has(h.sid) && !bad.test(h.title) && (!w.must || w.must.test(h.title)));
    const pick = hits.slice(0, w.n);
    const got: unknown[] = [];
    for (const [i, h] of pick.entries()) {
      const file = join(RAW, `${w.id}_${i}.ogg`);
      const r = await fetch(h.ogg, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      used.add(h.sid);
      got.push({ ...h, file, page: `https://freesound.org/people/${h.user}/sounds/${h.sid}/`, license: 'CC0 1.0' });
      console.log(`${w.id}_${i}: "${h.title}" by ${h.user} (${h.dur.toFixed(0)} s, ${h.dl} downloads)`);
    }
    meta[w.id] = got;
    writeFileSync(metaPath, JSON.stringify(meta, null, 1));
    await new Promise((res) => setTimeout(res, 800));
  }
  console.log('done');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
