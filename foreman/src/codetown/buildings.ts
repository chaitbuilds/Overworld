// The generator: every building of a code town, drawn from its plot. A building is stone below and timber above,
// with a gabled roof whose colour is its quarter's; its size is the map's (lines of code), and everything else on it
// is one of the town's signs, each a fact of the repository at that moment:
//
//   the board         the folder's name, on a board of one size whatever the building
//   the lamps         one for each test file that covers it, in the top course of the front: lit when that file
//                     passed in the last whole check, red when it failed, dark when it has not been run
//   the outline       a coloured ring on the ground round the plot: the plan names this module for the ask
//   the scaffolding   an agent has a working copy open on it
//   the banners       two on the board: its change is merged
//
// Nothing here knows any repository: it is all computed from the plot.
import type { Placement } from '../town/engine.js';
import { BOARD_WIDE, FEET_Y, GROUND_Y, type Gate, type Plot, type ScreenWall } from './layout.js';

export type Lamp = 'lit' | 'red' | 'dark';
/**
 * A quarter's look, in the map's order of quarters (the list goes round again after eight): the stone its buildings
 * stand on, their walls, timbers, roof, chimney and the rug inside. Only the look: every sign on a building means the
 * same in every quarter.
 */
interface Palette { base: Array<[string, number]>; wall: string; timber: string; beam: string; roof: string; chimney: string; rug: string }
const GREY: Array<[string, number]> = [['stone_bricks', 0.62], ['cobblestone', 0.18], ['andesite', 0.13], ['mossy_stone_bricks', 0.07]];
export const PALETTES: Palette[] = [
  { base: GREY, wall: 'white_terracotta', timber: 'spruce_log', beam: 'dark_oak_planks', roof: 'deepslate_tile', chimney: 'cobblestone', rug: 'gray_carpet' },
  { base: [['bricks', 0.7], ['stone_bricks', 0.3]], wall: 'smooth_sandstone', timber: 'dark_oak_log', beam: 'dark_oak_planks', roof: 'mangrove', chimney: 'bricks', rug: 'red_carpet' },
  { base: [['cobblestone', 0.6], ['mossy_cobblestone', 0.2], ['andesite', 0.2]], wall: 'birch_planks', timber: 'stripped_dark_oak_log', beam: 'dark_oak_planks', roof: 'spruce', chimney: 'stone_bricks', rug: 'green_carpet' },
  { base: GREY, wall: 'white_terracotta', timber: 'spruce_log', beam: 'dark_oak_planks', roof: 'warped', chimney: 'cobblestone', rug: 'cyan_carpet' },
  { base: [['polished_andesite', 0.5], ['stone_bricks', 0.5]], wall: 'calcite', timber: 'stripped_spruce_log', beam: 'spruce_planks', roof: 'brick', chimney: 'bricks', rug: 'orange_carpet' },
  { base: [['cobblestone', 0.5], ['mossy_cobblestone', 0.5]], wall: 'spruce_planks', timber: 'spruce_log', beam: 'dark_oak_planks', roof: 'deepslate_tile', chimney: 'cobblestone', rug: 'brown_carpet' },
  { base: GREY, wall: 'mud_bricks', timber: 'stripped_oak_log', beam: 'spruce_planks', roof: 'dark_oak', chimney: 'bricks', rug: 'yellow_carpet' },
  { base: GREY, wall: 'white_terracotta', timber: 'oak_log', beam: 'dark_oak_planks', roof: 'acacia', chimney: 'stone_bricks', rug: 'purple_carpet' },
];
/** Roofs by quarter (the palettes' roofs). */
export const ROOFS = PALETTES.map((p) => p.roof);
const paletteOf = (quarterIndex: number): Palette => PALETTES[quarterIndex % PALETTES.length] as Palette;
const pick = (mix: Array<[string, number]>, r: number): string => { let acc = 0; for (const [b, w] of mix) { acc += w; if (r < acc) return b; } return (mix[mix.length - 1] as [string, number])[0]; };
const roofBlocks = (kind: string): { stairs: string; slab: string; full: string } =>
  kind === 'deepslate_tile' ? { stairs: 'deepslate_tile_stairs', slab: 'deepslate_tile_slab', full: 'deepslate_tiles' }
    : kind === 'brick' ? { stairs: 'brick_stairs', slab: 'brick_slab', full: 'bricks' }
      : { stairs: `${kind}_stairs`, slab: `${kind}_slab`, full: `${kind}_planks` };

export const LAMP_BLOCK: Record<Lamp, string> = { lit: 'redstone_lamp[lit=true]', red: 'red_stained_glass', dark: 'redstone_lamp[lit=false]' };
/** What glows red behind the red glass of a failing lamp. */
const LAMP_BACK: Record<Lamp, string | undefined> = { lit: undefined, red: 'shroomlight', dark: undefined };

function hash(x: number, y: number, z: number): number {
  let h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const stone = (x: number, y: number, z: number): string => { const r = hash(x, y, z); return r < 0.62 ? 'stone_bricks' : r < 0.8 ? 'cobblestone' : r < 0.93 ? 'andesite' : 'mossy_stone_bricks'; };
const dirOf = (face: 1 | -1): { front: string; back: string } => (face === 1 ? { front: 'south', back: 'north' } : { front: 'north', back: 'south' });

/** How many lamps fit in one row of a building's front (between its corner posts). */
export const lampSlots = (p: Plot): number => p.wide - 2;
/** The top course of the walls: the row the first lamps are in. */
export const eaveY = (p: Plot): number => FEET_Y + p.high;

/**
 * The building itself: floor, walls, door, windows, roof and board, in its quarter's palette; a chimney with a fire on
 * a building wider than five, a window in each gable, and a lantern hanging under each end of the board. Not its lamps.
 */
export function shellBlocks(p: Plot, quarterIndex: number): Placement[] {
  const out: Placement[] = [], put = (x: number, y: number, z: number, b: string): void => { out.push([x, y, z, b]); };
  const pal = paletteOf(quarterIndex), roof = roofBlocks(pal.roof), d = dirOf(p.face);
  const stone = (x: number, y: number, z: number): string => pick(pal.base, hash(x, y, z));
  const zBack = p.zFront - p.face * (p.deep - 1), top = FEET_Y + p.high - 1, eave = eaveY(p);
  const isFront = (z: number): boolean => z === p.zFront;
  const edge = (x: number, z: number): boolean => x === p.x0 || x === p.x1 || z === p.z0 || z === p.z1;
  const corner = (x: number, z: number): boolean => (x === p.x0 || x === p.x1) && (z === p.z0 || z === p.z1);
  // a post every four blocks along the front and the back, between the corners
  const post = (x: number, z: number): boolean => corner(x, z) || ((z === p.z0 || z === p.z1) && x !== p.doorX && (x - p.doorX) % 4 === 0 && Math.abs(x - p.doorX) > 1);
  const stoneHigh = Math.max(2, Math.floor(p.high / 2));           // the lower courses are stone, the upper ones plaster in a timber frame
  for (let x = p.x0; x <= p.x1; x++) for (let z = p.z0; z <= p.z1; z++) {
    put(x, GROUND_Y, z, edge(x, z) ? stone(x, GROUND_Y, z) : 'spruce_planks');
    for (let y = FEET_Y; y <= eave; y++) {
      if (!edge(x, z)) { put(x, y, z, 'air'); continue; }
      let b: string;
      const side = x === p.x0 || x === p.x1, onFront = isFront(z);
      const band = p.high >= 6 && y === FEET_Y + stoneHigh;        // a timber band where the stone ends, on a building tall enough to have one
      if (y === eave) b = pal.beam;                                  // the top course: a beam (the lamps go in the front of it)
      else if (post(x, z)) b = pal.timber;
      else if (band) b = side ? `${pal.timber}[axis=z]` : `${pal.timber}[axis=x]`;
      else if (y - FEET_Y < stoneHigh) b = stone(x, y, z);
      else b = pal.wall;
      if (onFront && x === p.doorX && y <= FEET_Y + 1) b = y === FEET_Y ? `spruce_door[half=lower,facing=${d.back},hinge=left,open=false]` : `spruce_door[half=upper,facing=${d.back},hinge=left,open=false]`;
      else if (!post(x, z) && y !== eave && !band) {
        // windows in a rhythm: every other column at head height, and again under the eave of a building of two storeys
        const col = side ? Math.abs(z - p.zFront) : Math.abs(x - p.doorX);
        const rhythm = col % 2 === 0 && col > 0 && !(side && (z === p.z0 || z === p.z1));
        const upper = p.high >= 6 && (y === top - 1 || (p.high >= 9 && y === top - 2));
        if (rhythm && (y === FEET_Y + 1 || upper)) b = 'glass_pane';
      }
      put(x, y, z, b);
    }
  }
  // the roof: a gable whose ridge runs along the street, one block wider than the walls at each end
  const layers = Math.ceil(p.deep / 2);
  for (let k = 0; k < layers; k++) {
    const y = eave + 1 + k, zf = p.zFront - p.face * k, zb = zBack + p.face * k;
    for (let x = p.x0 - 1; x <= p.x1 + 1; x++) {
      if (zf === zb) { put(x, y, zf, roof.slab); continue; }
      put(x, y, zf, `${roof.stairs}[facing=${d.back},half=bottom]`);
      put(x, y, zb, `${roof.stairs}[facing=${d.front},half=bottom]`);
    }
    // the gable ends, filled between the two slopes, with a window in the middle of the second course
    const zMid = Math.round((zf + zb) / 2);
    for (const x of [p.x0, p.x1]) for (let z = Math.min(zf, zb) + 1; z <= Math.max(zf, zb) - 1; z++) put(x, y, z, k === 1 && z === zMid && Math.abs(zf - zb) >= 4 ? 'glass_pane' : pal.wall);
    for (let x = p.x0 + 1; x <= p.x1 - 1; x++) for (let z = Math.min(zf, zb) + 1; z <= Math.max(zf, zb) - 1; z++) put(x, y, z, 'air');
  }
  // the board: one size for every building, standing proud of the front over the door
  for (let x = p.board.x0; x <= p.board.x1; x++) for (let y = p.board.y0; y <= p.board.y1; y++) put(x, y, p.board.z, 'dark_oak_planks');
  // the kerb row and the board's row are cleared (a board, banners, an outline and scaffolding come and go there)
  for (let x = p.box[0]; x <= p.box[3]; x++) for (const z of [p.zFront + p.face]) for (let y = FEET_Y; y <= eave + 2; y++) {
    const board = x >= p.board.x0 && x <= p.board.x1 && y >= p.board.y0 && y <= p.board.y1;
    if (!board) put(x, y, z, 'air');
  }
  // a lantern hanging under each end of the board, either side of the door
  for (const x of [p.board.x0, p.board.x1]) put(x, p.board.y0 - 1, p.board.z, 'lantern[hanging=true]');
  // a chimney through the back of the roof, on a building wider than five, with a fire on top (its smoke rises)
  if (p.wide > 5) {
    const cx = hash(p.x0, p.x1, p.zFront) < 0.5 ? p.x0 + 1 : p.x1 - 1, cz = zBack + p.face, ridge = eave + layers;
    for (let y = eave + 1; y <= ridge + 1; y++) put(cx, y, cz, pal.chimney);
    put(cx, ridge + 2, cz, 'campfire[lit=true,signal_fire=false,facing=north]');
  }
  return out;
}

/** The door of a building, open while someone works inside, shut otherwise. */
export function doorBlocks(p: Plot, open: boolean): Placement[] {
  const d = dirOf(p.face);
  return [[p.doorX, FEET_Y, p.zFront, `spruce_door[half=lower,facing=${d.back},hinge=left,open=${open}]`], [p.doorX, FEET_Y + 1, p.zFront, `spruce_door[half=upper,facing=${d.back},hinge=left,open=${open}]`]];
}

/** The screen inside a building: a dark panel standing against its back wall, the width of the room, where its code is shown. */
export function screenCells(p: Plot): { x0: number; x1: number; y0: number; y1: number; z: number } {
  const zBack = p.zFront - p.face * (p.deep - 1);
  return { x0: p.x0 + 1, x1: p.x1 - 1, y0: FEET_Y + 1, y1: eaveY(p) - 1, z: zBack + p.face };
}
/**
 * The inside of a building: the screen against the back wall, one bookshelf for each of its source files along the side
 * walls (as many as there is room for), and light that is not seen (the room is lit without lamps standing in the way).
 */
export function interiorBlocks(p: Plot, files: number, quarterIndex = 0): Placement[] {
  const out: Placement[] = [], sc = screenCells(p);
  // a rug down the middle of the floor, in the quarter's colour (the bookshelves and the screen stand round it)
  for (let x = p.x0 + 2; x <= p.x1 - 2; x++) for (let z = Math.min(sc.z, p.zFront) + 2; z <= Math.max(sc.z, p.zFront) - 1; z++) out.push([x, FEET_Y, z, paletteOf(quarterIndex).rug]);
  for (let x = sc.x0; x <= sc.x1; x++) for (let y = sc.y0; y <= sc.y1; y++) out.push([x, y, sc.z, 'black_concrete']);
  for (let x = sc.x0; x <= sc.x1; x++) out.push([x, FEET_Y, sc.z, 'polished_blackstone']);
  // bookshelves: from the back (beside the screen) towards the door, bottom row first, on both side walls in turn
  const rows: number[] = []; for (let z = sc.z + p.face; z !== p.zFront - p.face; z += p.face) rows.push(z);
  const high = Math.min(3, p.high - 1);
  let left = files;
  for (let y = FEET_Y; y < FEET_Y + high && left > 0; y++) for (const z of rows) for (const x of [p.x0 + 1, p.x1 - 1]) {
    if (left <= 0) break;
    if (Math.abs(x - p.doorX) <= 1 && z === p.zFront - p.face) continue;
    out.push([x, y, z, 'bookshelf']); left--;
  }
  const zMid = Math.round((sc.z + p.zFront) / 2);
  for (const x of [p.x0 + 2, p.x1 - 2]) out.push([x, eaveY(p) - 1, zMid, 'light[level=15]']);
  // a torch on each side wall near the screen, over the bookshelves (the room is lit where the agent works, at dusk too)
  // (one row away from the screen, so that no torch stands before the code)
  out.push([p.x0 + 1, FEET_Y + 3, sc.z + 2 * p.face, 'wall_torch[facing=east]'], [p.x1 - 1, FEET_Y + 3, sc.z + 2 * p.face, 'wall_torch[facing=west]']);
  // a lantern in each front corner, behind the front windows (on the bookshelves there if there are any): from the
  // street the windows glow
  const shelf = new Set(out.filter((b) => b[3] === 'bookshelf').map((b) => `${b[0]},${b[1]},${b[2]}`));
  for (const x of [p.x0 + 1, p.x1 - 1]) {
    const z = p.zFront - p.face;
    if (Math.abs(x - p.doorX) <= 1) continue;
    let y = FEET_Y; while (shelf.has(`${x},${y},${z}`)) y++;
    if (y < eaveY(p) - 1) out.push([x, y, z, 'lantern[hanging=false]']);
  }
  return out;
}
/** Everything interiorBlocks puts in, as air (before a building is drawn again at another size). */
export function interiorGone(p: Plot): Placement[] {
  const out: Placement[] = [];
  const zBack = p.zFront - p.face * (p.deep - 1);
  for (let x = p.x0 + 1; x <= p.x1 - 1; x++) for (let z = Math.min(zBack, p.zFront) + 1; z <= Math.max(zBack, p.zFront) - 1; z++) for (let y = FEET_Y; y <= eaveY(p); y++) out.push([x, y, z, 'air']);
  return out;
}

/** A lot for a building that does not exist yet: its floor, and its board on two posts (the building comes when its code does). */
export function lotBlocks(p: Plot): Placement[] {
  const out: Placement[] = [];
  for (let x = p.x0; x <= p.x1; x++) for (let z = p.z0; z <= p.z1; z++) {
    const edge = x === p.x0 || x === p.x1 || z === p.z0 || z === p.z1;
    out.push([x, GROUND_Y, z, edge ? stone(x, GROUND_Y, z) : 'spruce_planks']);
  }
  for (let x = p.board.x0; x <= p.board.x1; x++) for (let y = p.board.y0; y <= p.board.y1; y++) out.push([x, y, p.board.z, 'dark_oak_planks']);
  for (const x of [p.board.x0, p.board.x1]) for (let y = FEET_Y; y < p.board.y0; y++) out.push([x, y, p.board.z, 'spruce_fence']);
  return out;
}
/**
 * A building being written in a working copy: the frame of the building its lines would make so far (posts of logs at
 * its corners and along its front and back, a beam round the top), open to the sky. Drawn again as the lines grow; the
 * whole building is drawn when the change is merged.
 */
export function frameBlocks(p: Plot): Placement[] {
  const out: Placement[] = [], eave = eaveY(p);
  const edge = (x: number, z: number): boolean => x === p.x0 || x === p.x1 || z === p.z0 || z === p.z1;
  const corner = (x: number, z: number): boolean => (x === p.x0 || x === p.x1) && (z === p.z0 || z === p.z1);
  const post = (x: number, z: number): boolean => corner(x, z) || ((z === p.z0 || z === p.z1) && x !== p.doorX && (x - p.doorX) % 4 === 0 && Math.abs(x - p.doorX) > 1) || ((x === p.x0 || x === p.x1) && (z - p.zFront) % 4 === 0);
  for (let x = p.x0; x <= p.x1; x++) for (let z = p.z0; z <= p.z1; z++) {
    out.push([x, GROUND_Y, z, edge(x, z) ? stone(x, GROUND_Y, z) : 'spruce_planks']);
    if (!edge(x, z)) continue;
    for (let y = FEET_Y; y < eave; y++) out.push([x, y, z, post(x, z) ? 'spruce_log' : 'air']);
    out.push([x, eave, z, post(x, z) ? 'spruce_log' : 'dark_oak_planks']);
  }
  return out;
}

/**
 * The product's wall on the square: stone, a cornice, a lantern either side, and the screen on its face, made of the
 * mod's monitor blocks joined into one panel (each block told which neighbours it joins, as a viewer sees them).
 */
export function screenWallBlocks(w: ScreenWall): Placement[] {
  const out: Placement[] = [];
  for (let x = w.x0; x <= w.x1; x++) {
    out.push([x, GROUND_Y, w.z, 'stone_bricks']);
    for (let y = FEET_Y; y <= w.top; y++) out.push([x, y, w.z, x === w.x0 || x === w.x1 || y === w.top || y === FEET_Y ? 'polished_deepslate' : 'stone_bricks']);
    out.push([x, w.top + 1, w.z, 'deepslate_tile_slab[type=bottom]']);
  }
  for (let i = 0; i < w.wide; i++) for (let j = 0; j < w.high; j++) {
    const x = w.origin[0] + i, y = w.origin[1] + j;
    out.push([x, y, w.zScreen, `overworld:monitor[facing=south,lit=true,left=${i > 0},right=${i < w.wide - 1},down=${j > 0},up=${j < w.high - 1}]`]);
  }
  for (const x of [w.x0, w.x1]) out.push([x, w.top - 1, w.zScreen, 'lantern[hanging=false]']);
  return out;
}

/** How wide a name is in the game's own letters, bold, in font pixels (forty are one block at scale 1). */
const NARROW: Record<string, number> = { i: 2, l: 3, t: 4, f: 5, k: 5, ' ': 4, '.': 2, ',': 2, ':': 2, ';': 2, '!': 2, "'": 2, '|': 2, '(': 4, ')': 4, '[': 4, ']': 4, '{': 4, '}': 4, '*': 4, '"': 4, I: 4, '<': 5, '>': 5, '`': 3, '@': 7, '~': 7 };
export function textPixels(text: string, bold = true): number {
  let n = 0;
  for (const ch of text) n += (NARROW[ch] ?? 6) + (bold ? 1 : 0);
  return Math.max(1, n - 1);
}
/** The scale at which a name fills a board `wide` blocks wide and two high (a line of words is a quarter of a block high at scale 1). */
export function boardScale(name: string, wide = BOARD_WIDE): number {
  return Math.min(6.2, ((wide - 0.5) * 40) / textPixels(name));
}
/** Where each lamp is: slots fill the top course from its middle outwards, then the course below, and so on. */
export function lampCells(p: Plot, count: number): Array<[number, number, number]> {
  const per = lampSlots(p), cells: Array<[number, number, number]> = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / per), inRow = Math.min(per, count - row * per), k = i - row * per;
    const y = eaveY(p) - row;
    if (y <= p.board.y1) break;                                     // no room left above the board
    const start = p.doorX - Math.floor((inRow - 1) / 2);
    cells.push([start + k, y, p.zFront]);
  }
  return cells;
}
/** The lamps of a building's front, in the order of its test files. Rows that held lamps before and hold none now go back to wall. */
export function lampBlocks(p: Plot, lamps: Lamp[]): Placement[] {
  const out: Placement[] = [], cells = lampCells(p, lamps.length), used = new Set(cells.map((c) => c.join(',')));
  const inside = (x: number, y: number): [number, number, number] => [x, y, p.zFront - p.face];
  // the top course is a beam where it holds no lamp
  for (let x = p.x0 + 1; x <= p.x1 - 1; x++) if (!used.has(`${x},${eaveY(p)},${p.zFront}`)) { out.push([x, eaveY(p), p.zFront, 'dark_oak_planks']); out.push([...inside(x, eaveY(p)), 'air']); }
  cells.forEach(([x, y, z], i) => {
    const state = lamps[i] as Lamp;
    out.push([x, y, z, LAMP_BLOCK[state]]);
    // a failing lamp is red glass with a light behind it; any other lamp has nothing behind it
    out.push([...inside(x, y), LAMP_BACK[state] ?? 'air']);
  });
  return out;
}

function ring(p: Plot): Array<[number, number]> {
  const x0 = Math.min(p.x0, p.board.x0) - 1, x1 = Math.max(p.x1, p.board.x1) + 1, z0 = p.z0 - 1, z1 = p.z1 + 1, out: Array<[number, number]> = [];
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (x === x0 || x === x1 || z === z0 || z === z1) out.push([x, z]);
  return out;
}
/** The coloured outline on the ground round a plot ('none' takes it away). */
export function outlineBlocks(p: Plot, colour: 'yellow' | 'red' | 'lime' | 'none'): Placement[] {
  return ring(p).map(([x, z]) => [x, FEET_Y, z, colour === 'none' ? 'air' : `${colour}_carpet`] as Placement);
}
/**
 * Scaffolding round a plot, as high as its walls: poles first, then rails (in the game a rail holds only within
 * reach of a pole, so the poles must stand before the rails go up). The front stays open: the board and the lamps
 * must be seen.
 */
export function scaffoldBlocks(p: Plot): { poles: Placement[]; rails: Placement[] } {
  const cells = ring(p), xs = cells.map((c) => c[0]), zs = cells.map((c) => c[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs), zFrontRow = p.zFront + p.face, top = eaveY(p);
  const poles: Placement[] = [], taken = new Set<string>();
  const pole = (x: number, z: number, from = FEET_Y): void => { for (let y = from; y <= top; y++) { if (taken.has(`${x},${y},${z}`)) continue; poles.push([x, y, z, 'scaffolding']); taken.add(`${x},${y},${z}`); } };
  for (const [x, z] of cells) {
    const cornerCell = (x === x0 || x === x1) && (z === z0 || z === z1);
    const along = z === z0 || z === z1 ? x - x0 : z - z0;
    if (z === zFrontRow && !cornerCell) continue;                   // the front holds no pole between its corners
    if (cornerCell || along % 4 === 0) pole(x, z);
  }
  // rails on the sides and the back only: the front is left open from the ground to the eave (and a rail there would be
  // out of reach of the corner poles on a wide building)
  const rails: Placement[] = [];
  for (const y of [...new Set([Math.min(top, FEET_Y + 3), top])]) for (const [x, z] of cells) {
    if (z === zFrontRow) continue;
    if (!taken.has(`${x},${y},${z}`)) rails.push([x, y, z, 'scaffolding']);
  }
  return { poles, rails };
}
/** Everything scaffoldBlocks puts up, as air (the outline it stood on is drawn again by the caller). */
export function scaffoldGone(p: Plot): Placement[] {
  const { poles, rails } = scaffoldBlocks(p);
  return [...rails, ...poles].map(([x, y, z]) => [x, y, z, 'air'] as Placement);
}
/** Two banners standing on the ends of the board: its change is merged ('none' takes them away). */
export function bannerBlocks(p: Plot, colour: 'lime' | 'none' = 'lime'): Placement[] {
  const rotation = p.face === 1 ? 0 : 8;
  return [p.board.x0, p.board.x1].map((x) => [x, p.board.y1 + 1, p.board.z, colour === 'none' ? 'air' : `${colour}_banner[rotation=${rotation}]`] as Placement);
}

/** A quarter's gate: two posts, a beam across the street with the quarter's name on both faces, and the lever on its north post. */
export function gateBlocks(g: Gate, powered = false): Placement[] {
  const out: Placement[] = [];
  for (const z of [g.zNorth, g.zSouth]) {
    out.push([g.x, GROUND_Y, z, 'stone_bricks']);
    for (let y = FEET_Y; y <= g.top; y++) out.push([g.x, y, z, 'stripped_spruce_log']);
  }
  for (let z = g.zNorth; z <= g.zSouth; z++) for (const y of [g.top + 1, g.top + 2]) out.push([g.x, y, z, 'dark_oak_planks']);
  // a lantern hanging under the beam inside each post
  for (const z of [g.zNorth + 1, g.zSouth - 1]) out.push([g.x, g.top, z, 'lantern[hanging=true]']);
  out.push(leverBlock(g, powered));
  return out;
}
export function leverBlock(g: Gate, powered: boolean): Placement {
  return [g.lever[0], g.lever[1], g.lever[2], `lever[face=wall,facing=west,powered=${powered}]`];
}
export function gateScale(name: string, wide: number): number {
  return Math.min(6.4, ((wide - 0.8) * 40) / textPixels(name));
}
