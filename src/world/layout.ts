/**
 * The authored layout of the island, shared by the offline terrain baker (tools/gen-island.ts) and the game.
 *
 * Coordinates are metres: +x east, +z south, +y up; sea level is y = 0. The world square is 2048 m on a side,
 * centred on the origin. The sun rises in the east (+x), so the spawn beach on the east coast faces the sunrise.
 */
export const WORLD_SIZE = 2048;
export const HALF_WORLD = WORLD_SIZE / 2;
/** heightmap texels per side (1 m per texel) */
export const HEIGHT_RES = 2048;
/** mask texels per side (2 m per texel) */
export const MASK_RES = 1024;
/** heights are stored as uint16 between these bounds */
export const H_MIN = -90;
export const H_MAX = 250;

export type V2 = [number, number];

/** coast kinds: 0 beach, 1 rock shelf, 2 sea cliff */
export interface CoastPoint {
  p: V2;
  /** 0 beach .. 1 rock .. 2 cliff (fractional values blend) */
  kind: number;
}

/**
 * Coastline, walked clockwise as seen from above (north at the top): north cliffs, the NE point, the spawn bay on
 * the east coast, the south shore, the village cove in the south-west, the rocky west coast and back.
 */
export const COAST: CoastPoint[] = [
  { p: [-600, -470], kind: 2 },
  { p: [-470, -548], kind: 2 },
  { p: [-330, -592], kind: 2 },
  { p: [-190, -608], kind: 2 },
  { p: [-60, -592], kind: 2 },
  { p: [40, -565], kind: 1.7 },
  // a small north cove with a pocket beach
  { p: [100, -512], kind: 1.0 },
  { p: [160, -486], kind: 0.3 },
  { p: [228, -492], kind: 0.5 },
  { p: [300, -528], kind: 1.6 },
  { p: [400, -478], kind: 1.8 },
  { p: [515, -418], kind: 1.7 },
  { p: [610, -360], kind: 1.6 },
  // the north-east point
  { p: [668, -305], kind: 1.5 },
  { p: [652, -240], kind: 0.9 },
  { p: [626, -185], kind: 0.3 },
  // the spawn bay: a long crescent of sand facing east
  { p: [628, -130], kind: 0 },
  { p: [626, -60], kind: 0 },
  { p: [618, 10], kind: 0 },
  { p: [622, 80], kind: 0 },
  { p: [640, 150], kind: 0 },
  { p: [680, 215], kind: 0.2 },
  { p: [742, 262], kind: 0.8 },
  { p: [795, 318], kind: 1.4 },
  // south-east point and the south shore
  { p: [770, 370], kind: 1.2 },
  { p: [690, 405], kind: 0.9 },
  { p: [610, 425], kind: 0.7 },
  { p: [500, 448], kind: 0.3 },
  { p: [370, 470], kind: 0.2 },
  { p: [240, 498], kind: 0.6 },
  { p: [110, 532], kind: 1.0 },
  { p: [-20, 538], kind: 1.1 },
  { p: [-140, 515], kind: 0.9 },
  { p: [-240, 478], kind: 0.6 },
  // the village cove: a sheltered bay with a beach on its north shore
  { p: [-305, 432], kind: 0.2 },
  { p: [-360, 378], kind: 0 },
  { p: [-420, 352], kind: 0 },
  { p: [-480, 350], kind: 0 },
  { p: [-540, 372], kind: 0.1 },
  { p: [-600, 395], kind: 0.6 },
  { p: [-665, 372], kind: 1.0 },
  // the rocky west coast with a small bay and a headland
  { p: [-735, 300], kind: 1.2 },
  { p: [-790, 232], kind: 1.3 },
  { p: [-772, 175], kind: 0.4 },
  { p: [-818, 118], kind: 1.4 },
  { p: [-872, -10], kind: 1.8 },
  { p: [-850, -120], kind: 1.9 },
  { p: [-800, -240], kind: 2 },
  { p: [-715, -370], kind: 2 },
];

/** small islands and sea stacks, each its own closed coast */
export interface Islet { c: V2; rx: number; rz: number; rot: number; kind: number; h: number; e: number }
export const ISLETS: Islet[] = [
  // a palm islet off the spawn beach, silhouetted against the sunrise
  { c: [812, -48], rx: 46, rz: 26, rot: 0.35, kind: 0.5, h: 7, e: 1.2 },
  // sea stacks off the north-west cliffs
  { c: [-702, -488], rx: 14, rz: 11, rot: 0.6, kind: 2, h: 34, e: 0.35 },
  { c: [-655, -545], rx: 9, rz: 8, rot: 1.2, kind: 2, h: 22, e: 0.3 },
  { c: [-905, -78], rx: 12, rz: 9, rot: 0.2, kind: 2, h: 26, e: 0.35 },
  // a rocky skerry south of the village cove
  { c: [-470, 452], rx: 18, rz: 10, rot: -0.3, kind: 1.2, h: 3.5, e: 0.8 },
];

/** the summit: the lighthouse stands on a small levelled platform here */
export const PEAK = { p: [-300, -300] as V2, h: 214 };
export const LIGHTHOUSE = { p: [-300, -300] as V2, base: 214, platformR: 13 };

/** broad elevation blobs that make up the island body (smooth-max combined) */
export interface Hill { p: V2; r: number; h: number; e: number }
export const HILLS: Hill[] = [
  // the island body: a low dome that keeps the interior above the sea
  { p: [-120, -60], r: 760, h: 62, e: 1.6 },
  // central plateau west of the waterfall escarpment
  { p: [-20, -150], r: 300, h: 72, e: 1.4 },
  // east ridge between the river and the north-east point
  { p: [400, -250], r: 250, h: 58, e: 1.5 },
  // south-east hill behind the south end of the beach
  { p: [470, 250], r: 250, h: 66, e: 1.5 },
  // south hill above the south shore
  { p: [60, 330], r: 260, h: 70, e: 1.5 },
  // west headland
  { p: [-690, -40], r: 230, h: 64, e: 1.4 },
  // hill behind the village, west of the summit trail's saddle
  { p: [-520, 70], r: 240, h: 54, e: 1.6 },
  // north-west shoulder of the peak
  { p: [-560, -330], r: 220, h: 96, e: 1.4 },
];

/** river from the spring under the peak to its mouth at the north end of the spawn beach */
export interface RiverPoint { p: V2; bed: number; w: number }
export const RIVER: RiverPoint[] = [
  { p: [-150, -205], bed: 100, w: 2.5 },
  { p: [-95, -180], bed: 93, w: 3.0 },
  { p: [-35, -150], bed: 84, w: 3.6 },
  { p: [25, -118], bed: 74, w: 4.2 },
  { p: [80, -88], bed: 66, w: 5.0 },
  { p: [118, -68], bed: 61.5, w: 5.5 },
  { p: [140, -58], bed: 60.4, w: 6.0 },
  // the lip of the falls
  { p: [146, -55.5], bed: 60.0, w: 6.5 },
  // the plunge pool below
  { p: [158, -50.5], bed: 39.2, w: 14 },
  { p: [180, -45], bed: 39.0, w: 9 },
  { p: [215, -48], bed: 37.6, w: 7.5 },
  { p: [270, -62], bed: 32, w: 7.5 },
  { p: [335, -80], bed: 24, w: 8 },
  { p: [400, -95], bed: 15, w: 8.5 },
  { p: [470, -104], bed: 7.5, w: 9 },
  { p: [540, -110], bed: 2.6, w: 10 },
  { p: [600, -114], bed: 0.3, w: 12 },
  { p: [650, -116], bed: -1.2, w: 16 },
];
/** index in RIVER of the point at the lip of the falls; the next point is in the pool */
export const FALLS_INDEX = 7;
/** the plunge pool: a round basin at the foot of the falls */
export const POOL = { p: [165, -49] as V2, r: 17, depth: 4.2, level: 40.6 };
/** water level of the river above the falls (for the water ribbon), relative to the bed */
export const RIVER_DEPTH = 0.75;

/** the escarpment the river falls over: a rock step running north-south, highest at the falls */
export const ESCARPMENT: { p: V2; step: number }[] = [
  { p: [190, 150], step: 0 },
  { p: [165, 60], step: 10 },
  { p: [150, -10], step: 17 },
  { p: [146, -56], step: 24 },
  { p: [160, -130], step: 16 },
  { p: [200, -210], step: 9 },
  { p: [260, -280], step: 0 },
];

/** the fishing village on the cove's north shore */
export const VILLAGE = {
  center: [-455, 300] as V2,
  /** levelled ground: radius and height at the waterfront / at the back */
  r: 95,
  front: 2.2,
  back: 7.5,
};

/** walking paths (dirt trails); grades are kept walkable with switchbacks */
export const PATHS: V2[][] = [
  // beach to the waterfall pool, along the river's south bank
  [[592, -82], [540, -92], [470, -86], [400, -76], [335, -60], [270, -44], [222, -32], [190, -32]],
  // pool to the top of the falls: south along the foot of the escarpment, then a ramp slanting up its face
  [[190, -32], [198, -10], [188, 16], [173, 36], [158, 10], [146, -14], [130, -30], [112, -46]],
  // top of the falls, upstream across the plateau toward the peak
  [[112, -46], [60, -82], [0, -112], [-60, -130], [-120, -150], [-175, -150]],
  // village up to the lighthouse: north through the jungle, then switchbacks up the summit cone
  [[-440, 262], [-472, 236], [-428, 212], [-466, 182], [-426, 156], [-410, 110], [-385, 30], [-360, -50], [-330, -100], [-262, -140], [-232, -178],
    [-310, -198], [-372, -222], [-352, -258], [-292, -252], [-254, -270], [-264, -300], [-286, -306]],
  // plateau trail meets the summit trail
  [[-175, -150], [-232, -178]],
  // village east along the south shore to the beach's south end
  [[-400, 290], [-330, 322], [-240, 388], [-130, 418], [0, 432], [120, 420], [240, 398], [360, 392], [450, 400]],
];

/** named places for the test harness: where the player stands, where the camera looks */
export interface Spot { name: string; player: [number, number, number?]; yaw: number; cam?: { pos: [number, number, number]; target: [number, number, number] } }
export const SPOTS: Spot[] = [
  { name: 'beach', player: [596, 34], yaw: Math.PI / 2 },
  { name: 'jungle', player: [365, 18], yaw: -2.6 },
  { name: 'waterfall', player: [186, -40], yaw: -1.15 },
  { name: 'village', player: [-452, 318], yaw: Math.PI },
  { name: 'cliffs', player: [118, -526], yaw: -Math.PI / 2 - 0.15 },
  { name: 'lighthouse', player: [-296.9, -297.6], yaw: 2.2 },
];

/** the spawn: on the beach at sunrise, facing the sea and the rising sun */
export const SPAWN = SPOTS[0];
