/**
 * Downloads the raw third-party sources (all CC0, Poly Haven) into E:\tmp\island\raw\ (never into the repo).
 * `pnpm assets:fetch` then `pnpm assets:build` turns them into the optimised files under public/assets/.
 *
 *   pnpm assets:fetch [--only id1,id2]
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const RAW = 'E:\\tmp\\island\\raw';
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;

/** textures: Poly Haven ids with the maps we need at 2k */
export const TEXTURES = [
  // terrain layers
  'aerial_beach_01', 'damp_beach_sand', 'leaves_forest_ground', 'leafy_grass', 'dirt_floor', 'dark_rock_02',
  'mossy_rock', 'coral_ground_02', 'forest_leaves_02',
  // buildings, docks, boats, lighthouse
  'thatch_roof_angled', 'bamboo_wall', 'weathered_planks', 'blue_painted_planks', 'wood_planks_grey',
  'white_plaster_rough_01', 'rough_wood', 'worn_planks', 'wood_peeling_paint_weathered', 'rusty_painted_metal',
  'bark_willow_02', 'fever_tree_bark', 'stone_wall', 'coral_stone_wall',
];

/** models: glTF at 1k or 2k */
export const MODELS: [string, string][] = [
  ['anthurium_botany_01', '1k'], ['calathea_orbifolia_01', '1k'], ['fern_02', '1k'], ['pachira_aquatica_01', '1k'],
  ['wooden_crate_01', '1k'], ['wooden_crate_02', '1k'], ['wooden_barrels_01', '1k'], ['wooden_bucket_01', '1k'],
  ['wicker_basket_01', '1k'], ['ocean_buoy', '1k'], ['lifebuoy', '1k'], ['wooden_lantern_01', '1k'],
  ['modular_wooden_pier', '2k'], ['boulder_01', '1k'], ['rock_moss_set_01', '1k'], ['rock_moss_set_02', '1k'],
  ['namaqualand_boulder_05', '1k'], ['lambis_shell', '1k'], ['bananas', '1k'], ['folding_wooden_stool', '1k'],
  ['wooden_stool_01', '1k'], ['painted_wooden_bench', '1k'], ['fishermans_hat', '1k'], ['wooden_ladder', '1k'],
  ['sand_rocks_small_01', '1k'], ['dead_tree_trunk', '1k'], ['root_cluster_01', '1k'], ['shrub_04', '1k'],
  ['island_tree_02', '1k'],
];

const MAPS = ['Diffuse', 'nor_gl', 'Rough', 'AO', 'Displacement'];

async function get(url: string, dest: string) {
  if (existsSync(dest)) return false;
  mkdirSync(dirname(dest), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status}`);
      writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
      return true;
    } catch (e) {
      if (attempt === 2) throw new Error(`${url}: ${e}`);
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
  return false;
}

type Files = Record<string, Record<string, Record<string, { url: string; include?: Record<string, { url: string }> }>>>;

async function main() {
  const meta: Record<string, unknown> = {};
  for (const id of TEXTURES) {
    if (only && !only.includes(id)) continue;
    const info = await (await fetch(`https://api.polyhaven.com/info/${id}`)).json();
    const files = (await (await fetch(`https://api.polyhaven.com/files/${id}`)).json()) as Files;
    meta[id] = { name: info.name, authors: info.authors, license: 'CC0 1.0' };
    for (const m of MAPS) {
      const entry = files[m]?.['2k'];
      if (!entry) {
        console.log(`  ${id}: no ${m}`);
        continue;
      }
      const f = entry.png && (m === 'nor_gl' || m === 'Displacement') ? entry.png : entry.jpg ?? entry.png;
      const ext = f.url.split('.').pop();
      const did = await get(f.url, join(RAW, 'polyhaven', 'tex', id, `${m}.${ext}`));
      if (did) console.log(`  ${id} ${m}`);
    }
  }
  for (const [id, res] of MODELS) {
    if (only && !only.includes(id)) continue;
    const info = await (await fetch(`https://api.polyhaven.com/info/${id}`)).json();
    const files = (await (await fetch(`https://api.polyhaven.com/files/${id}`)).json()) as Files;
    meta[id] = { name: info.name, authors: info.authors, license: 'CC0 1.0' };
    const g = files.gltf?.[res]?.gltf ?? files.gltf?.['1k']?.gltf;
    if (!g) {
      console.log(`  ${id}: no gltf`);
      continue;
    }
    const dir = join(RAW, 'polyhaven', 'models', id);
    await get(g.url, join(dir, `${id}.gltf`));
    for (const [rel, inc] of Object.entries(g.include ?? {})) await get(inc.url, join(dir, rel));
    console.log(`  model ${id}`);
  }
  mkdirSync(join(RAW, 'polyhaven'), { recursive: true });
  writeFileSync(join(RAW, 'polyhaven', `meta${only ? '-partial' : ''}.json`), JSON.stringify(meta, null, 1));
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
