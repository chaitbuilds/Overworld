// The town's plan, computed from the map: where each building stands along one street. Nothing is placed by hand:
// the same function lays out any repository's map.
//
//   - One street runs west to east. Quarters follow one another along it in the map's order (what is depended on
//     first), each behind a gate that carries its name; inside a quarter the buildings follow the map's order too,
//     each on whichever side of the street has room first, so the order along the street is the map's order.
//   - A building's plot is its footprint (the map's step for its lines of code) with one block of margin all round
//     for the town's own signs (the outline, the scaffolding). Its front faces the street; its board hangs on the
//     front; its stake stands on the street's edge before its west corner; people who work on it go in and stand
//     facing its back wall, where its code is shown.
//   - A new module (one a change makes) waits on its quarter's first free lot (freeLot), and a building whose code
//     crosses a step of the size rule grows where it stands (grownPlot): nothing else moves until the town is laid
//     out again.
//   - The green, where idle agents wait, is a square at the gate of the quarter in the middle of the street.
//   - Quarters that stand apart are set beyond a channel of water at the street's east end, with no bridge: nothing
//     in the town imports them.
import { STEPS, type MapModule, type TownMap } from './mapper.js';
import type { Place, PlacesFile } from '../town/places.js';
import { STREET_NORTH, worldBlock, worldBox, worldPoint, worldYaw, type Frame } from './frame.js';

export type Vec3 = [number, number, number];
export type Box = [number, number, number, number, number, number];

export const GROUND_Y = 64;                 // the top block of the ground; people stand at GROUND_Y + 1
export const FEET_Y = GROUND_Y + 1;
const STREET_HALF = 3;                      // the street is z -3..3
const FRONT = STREET_HALF + 3;              // a building's front wall is on row |z| = 6: kerb row 4, board row 5
const GAP = 3;                              // between two plots on one side (a block of margin each, and one free)
const QUARTER_GAP = 9;                      // from the last building of a quarter to the gate of the next
const GATE_CLEAR = 4;                       // from a gate to the first building behind it
const SQUARE = 12;                          // the length of the green's square along the street
const CHANNEL = 14;                         // the width of the water before a quarter that stands apart
export const BOARD_WIDE = 7;                // every board is this wide and two high, whatever the building
export const GATE_HIGH = 7;

export interface Plot {
  module: string;
  /** The place id and the stem of the part name: a simple name made from the folder's path. */
  place: string;
  name: string;
  quarter: string;
  side: 'north' | 'south';
  /** The footprint, inclusive. */
  x0: number; x1: number; z0: number; z1: number;
  /** The row of the front wall, and which way the front faces along z (+1 south, -1 north). */
  zFront: number; face: 1 | -1;
  wide: number; deep: number; high: number; step: number; lines: number;
  /** The door's column (the middle of the front). */
  doorX: number;
  /** The whole plot as a box the town may draw in. */
  box: Box;
  stand: Vec3; standYaw: number;
  stake: Vec3;
  /** Where the middle of the board's face is (the words hang from here). */
  board: { x0: number; x1: number; y0: number; y1: number; z: number; words: Vec3; yaw: number };
}
export interface Gate {
  quarter: string; place: string; name: string;
  /** The column the gate stands on, its two posts' rows and the beam's height. */
  x: number; zNorth: number; zSouth: number; top: number;
  box: Box;
  stand: Vec3; standYaw: number;
  /** The block the person uses to approve a merge (a lever on the north post), and what it hangs on. */
  lever: Vec3;
  apart: boolean;
}
export interface TownLayout {
  version: 1;
  repo: string;
  /** How the street coordinates everything below is in are set into the world. */
  frame: Frame;
  groundY: number;
  street: { x0: number; x1: number; z0: number; z1: number };
  /** Where idle agents wait: the middle of the square (where their feet are). */
  green: Vec3;
  square: { x0: number; x1: number; z0: number; z1: number };
  /** Water before the quarters that stand apart (none when the whole repository is one town). */
  channel?: { x0: number; x1: number; z0: number; z1: number };
  gates: Gate[];
  plots: Plot[];
  /** The ground the town stands on. */
  extent: { x0: number; x1: number; z0: number; z1: number };
  /** Footpaths: for each pair of buildings joined by imports, the door columns they run between. */
  paths: Array<{ a: string; b: string; count: number }>;
  /** The wall on the square where the product itself is shown, live (when the town has one). */
  screen?: ScreenWall;
}
/**
 * A wall on the green's square that shows the product itself: a stone wall on the square's north edge, and on its
 * face a screen of monitor blocks (`wide` x `high`) facing the street, showing the product's page live.
 */
export interface ScreenWall {
  id: string;
  /** The wall's blocks: from x0 to x1, from the ground to `top`, on row z. */
  x0: number; x1: number; z: number; top: number;
  /** The screen: its bottom-left block as someone facing it sees it, its size in blocks, and the row it stands on. */
  origin: Vec3; wide: number; high: number; zScreen: number;
  box: Box;
  /** Where its name hangs (the middle of the words' foot), and the way the words face. */
  words: Vec3; yaw: number;
}

/** The product's screen on the square: as wide as the square allows, 16 by 10 (a laptop's page), facing the street. */
export function screenWallOf(layout: TownLayout, id: string): ScreenWall {
  const sq = layout.square, zc = layout.street.z0 + STREET_HALF;
  const room = sq.x1 - sq.x0 + 1 - 4, wide = Math.max(4, Math.min(8, room)), high = Math.round((wide * 10) / 16);
  const x0 = sq.x0 + Math.floor((sq.x1 - sq.x0 + 1 - (wide + 2)) / 2), x1 = x0 + wide + 1, z = sq.z0 - 3, zScreen = z + 1, top = FEET_Y + high + 1;
  return {
    id, x0, x1, z, top, origin: [x0 + 1, FEET_Y + 1, zScreen], wide, high, zScreen,
    box: [x0 - 1, GROUND_Y, z - 1, x1 + 1, top + 4, zScreen + 1],
    words: [(x0 + x1 + 1) / 2, top + 0.6, zScreen + 0.04], yaw: 0,
  };
  void zc;
}

export function slugOf(id: string): string {
  if (id === '.') return 'root';
  const s = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (/^[a-z]/.test(s) ? s : `m-${s}`).slice(0, 34).replace(/-+$/, '');
}

/** What a plot is made from: a module's name and place in the town, and its size. */
export type PlotSize = Pick<MapModule, 'id' | 'name' | 'quarter' | 'wide' | 'deep' | 'high' | 'step' | 'lines'>;
/** The room a board wider than its building needs either side of it. */
const leadOf = (wide: number): number => Math.max(0, Math.ceil((BOARD_WIDE - wide) / 2));

/** A building's plot: its footprint with its west edge at x0 on one side of the street, and everything that hangs on it. */
export function plotOf(m: PlotSize, side: 'north' | 'south', x0: number, place: string, zc = 0): Plot {
  const face: 1 | -1 = side === 'north' ? 1 : -1;            // a north building's front faces south (+z)
  const zFront = side === 'north' ? zc - FRONT : zc + FRONT;
  const zBack = zFront - face * (m.deep - 1);
  const x1 = x0 + m.wide - 1, doorX = x0 + Math.floor(m.wide / 2);
  const zKerb = zFront + face * 2, zBoard = zFront + face;
  const bx0 = doorX - Math.floor(BOARD_WIDE / 2), roof = Math.ceil(m.deep / 2) + 1;
  return {
    module: m.id, place, name: m.name, quarter: m.quarter, side,
    x0, x1, z0: Math.min(zFront, zBack), z1: Math.max(zFront, zBack), zFront, face,
    wide: m.wide, deep: m.deep, high: m.high, step: m.step, lines: m.lines, doorX,
    box: [Math.min(x0, bx0) - 1, GROUND_Y, Math.min(zBack - face, zKerb), Math.max(x1, bx0 + BOARD_WIDE - 1) + 1, FEET_Y + m.high + roof + 4, Math.max(zBack - face, zKerb)],
    // inside, two blocks from the back wall and to one side of the middle, facing it (the screen where the code is shown
    // stays clear above the name over their heads); the door is how they go in
    stand: [Math.max(x0 + 1.5, doorX - 1.5), FEET_Y, zBack + face * 2.5], standYaw: side === 'north' ? 180 : 0,
    // (on the street's edge, a block out from the kerb: its words turn to whoever looks, and a block nearer they would cut into the scaffolding)
    stake: [x0 - 1, FEET_Y, zFront + face * 3],
    board: { x0: bx0, x1: bx0 + BOARD_WIDE - 1, y0: FEET_Y + 2, y1: FEET_Y + 3, z: zBoard, words: [doorX + 0.5, FEET_Y + 2.42, zBoard + 0.5 + face * 0.54], yaw: side === 'north' ? 0 : 180 },
  };
}

/** The quarter a new module's folder joins: the one that holds most of the modules beside it (same parent folder). */
export function quarterForNew(map: TownMap, id: string): string | undefined {
  const parent = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '';
  const count = new Map<string, number>();
  for (const m of map.modules) if (m.id.includes('/') && m.id.slice(0, m.id.lastIndexOf('/')) === parent) count.set(m.quarter, (count.get(m.quarter) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

const overlaps = (a: Box, b: Box): boolean => a[0] <= b[3] && b[0] <= a[3] && a[2] <= b[5] && b[2] <= a[5];

/**
 * The first free lot of a quarter: where the street's next building would stand by the rules of layoutTown (after the
 * quarter's last building, on whichever side has room first), if it fits before the next gate without touching any
 * other plot. Nothing else in the town moves: until the town is laid out again a new building waits on this lot.
 */
export function freeLot(layout: TownLayout, m: PlotSize, place: string): Plot | undefined {
  const mine = layout.plots.filter((p) => p.quarter === m.quarter);
  const gate = layout.gates.find((g) => g.quarter === m.quarter);
  if (!gate) return undefined;
  const nextGate = layout.gates.filter((g) => g.x > gate.x).sort((a, b) => a.x - b.x)[0];
  const limit = Math.min(nextGate ? nextGate.box[0] - 1 : Infinity, layout.channel && layout.channel.x0 > gate.x ? layout.channel.x0 - 2 : Infinity);
  const start = mine.length ? Math.min(...mine.map((p) => p.x0 - leadOf(p.wide))) : gate.x + GATE_CLEAR;
  const cursor = (side: 'north' | 'south'): number => Math.max(start, ...mine.filter((p) => p.side === side).map((p) => p.x1 + 1 + leadOf(p.wide) + GAP));
  const sides = (['north', 'south'] as const).slice().sort((a, b) => cursor(a) - cursor(b));
  for (const side of sides) {
    const p = plotOf(m, side, cursor(side) + leadOf(m.wide), place, layout.street.z0 + STREET_HALF);
    if (p.box[3] > limit) continue;
    if (layout.plots.some((o) => o.module !== m.id && overlaps(o.box, p.box))) continue;
    return p;
  }
  return undefined;
}

/**
 * A plot grown (or shrunk) to another step of the size rule, where it stands: about its door, so its board and door
 * stay where they are; its back goes deeper. If it would touch a neighbour it keeps its width and grows only deeper
 * and higher.
 */
export function grownPlot(layout: TownLayout, p: Plot, step: number, lines: number): Plot {
  const s = STEPS[step] as (typeof STEPS)[number];
  const sized = (wide: number): Plot => plotOf({ id: p.module, name: p.name, quarter: p.quarter, wide, deep: s.deep, high: s.high, step, lines }, p.side, p.doorX - Math.floor(wide / 2), p.place, layout.street.z0 + STREET_HALF);
  const full = sized(s.wide);
  if (!layout.plots.some((o) => o.place !== p.place && overlaps(o.box, full.box))) return full;
  return sized(Math.min(s.wide, p.wide));
}

/** Lay a map out as a town, in street coordinates (the street runs along +x from 0; `frame` sets it into the world). */
export function layoutTown(map: TownMap, frame: Frame = STREET_NORTH): TownLayout {
  const origin = { x: 0, z: 0 };
  const byId = new Map(map.modules.map((m) => [m.id, m]));
  const taken = new Set<string>();
  const unique = (base: string): string => { let s = base; for (let n = 2; taken.has(s); n++) s = `${base.slice(0, 31)}-${n}`; taken.add(s); return s; };
  const zc = origin.z;
  const street = map.quarters.filter((q) => !q.apart), island = map.quarters.filter((q) => q.apart);
  // the green's square is at the gate of the quarter that holds the middle building of the street
  const inTown = street.flatMap((q) => q.modules);
  const middle = byId.get(inTown[Math.floor((inTown.length - 1) / 2)] ?? '')?.quarter;
  const plots: Plot[] = [], gates: Gate[] = [];
  let x = origin.x + 6, square = { x0: origin.x, x1: origin.x, z0: zc - STREET_HALF, z1: zc + STREET_HALF }, channel: TownLayout['channel'];
  let green: Vec3 = [origin.x + 3.5, FEET_Y, zc + 0.5];

  const gate = (q: { id: string; name: string; apart: boolean }, at: number): Gate => {
    const place = unique(`q-${slugOf(q.id)}`);
    return {
      quarter: q.id, place, name: q.name, x: at, zNorth: zc - STREET_HALF - 1, zSouth: zc + STREET_HALF + 1, top: FEET_Y + GATE_HIGH - 1,
      box: [at - 2, GROUND_Y, zc - STREET_HALF - 2, at + 2, FEET_Y + GATE_HIGH + 3, zc + STREET_HALF + 2],
      // the lead comes to stand before the gate, facing the person who asked (who stands a few blocks further out)
      stand: [at - 2.5, FEET_Y, zc + 1.5], standYaw: 90,
      lever: [at - 1, FEET_Y + 1, zc - STREET_HALF - 1],
      apart: q.apart,
    };
  };
  const quarter = (q: (typeof map.quarters)[number]): void => {
    const g = gate(q, x); gates.push(g);
    if (q.id === middle) { square = { x0: x + 2, x1: x + 1 + SQUARE, z0: zc - STREET_HALF - 2, z1: zc + STREET_HALF + 2 }; green = [x + 2 + SQUARE / 2, FEET_Y, zc - 1.5]; x += SQUARE; }
    const cursor = { north: x + GATE_CLEAR, south: x + GATE_CLEAR };
    for (const id of q.modules) {
      const m = byId.get(id) as MapModule;
      const side: 'north' | 'south' = cursor.north <= cursor.south ? 'north' : 'south';
      // a board wider than its building needs the room either side of it
      const lead = Math.max(0, Math.ceil((BOARD_WIDE - m.wide) / 2));
      plots.push(plotOf(m, side, cursor[side] + lead, unique(slugOf(m.id)), zc));
      cursor[side] += lead * 2 + m.wide + GAP;
    }
    x = Math.max(cursor.north, cursor.south) - GAP + QUARTER_GAP;
  };
  for (const q of street) quarter(q);
  const streetEnd = x - QUARTER_GAP + 5;
  if (island.length) {
    channel = { x0: streetEnd + 2, x1: streetEnd + 1 + CHANNEL, z0: zc - 40, z1: zc + 40 };
    x = channel.x1 + 6;
    for (const q of island) quarter(q);
  }
  const end = x - QUARTER_GAP + 5;
  const deepest = Math.max(...plots.map((p) => Math.abs((p.side === 'north' ? p.z0 : p.z1) - zc)), FRONT);
  return {
    version: 1, repo: map.repo, frame, groundY: GROUND_Y,
    street: { x0: origin.x, x1: island.length ? end : streetEnd, z0: zc - STREET_HALF, z1: zc + STREET_HALF },
    green, square, ...(channel ? { channel } : {}), gates, plots,
    extent: { x0: origin.x - 12, x1: end + 12, z0: zc - deepest - 14, z1: zc + deepest + 14 },
    paths: map.paths.filter((p) => byId.has(p.a) && byId.has(p.b)),
  };
}

/** The places file the game and the backend read: one place for each building and one for each quarter's gate, in the world's coordinates. */
export function placesOf(layout: TownLayout): PlacesFile {
  const f = layout.frame, places: Place[] = [];
  const box = (b: Box): Box => worldBox(f, b), block = (v: Vec3): Vec3 => worldBlock(f, v[0], v[1], v[2]), point = (v: Vec3): Vec3 => worldPoint(f, v);
  for (const g of layout.gates) {
    places.push({
      id: g.place, name: `the gate of ${g.name}`, boxes: [box(g.box)],
      aim: [box([g.x - 1, GROUND_Y + 1, g.zNorth - 1, g.x + 1, g.top + 3, g.zSouth + 1])],
      outline: [box([g.x, FEET_Y, g.zNorth, g.x, g.top + 2, g.zSouth])],
      stand: point(g.stand), standYaw: worldYaw(f, g.standYaw), anchors: { lever: block(g.lever) }, lists: {}, notes: '',
    });
  }
  for (const p of layout.plots) {
    const roofTop = FEET_Y + p.high + Math.ceil(p.deep / 2) + 1;
    places.push({
      id: p.place, name: p.name, boxes: [box(p.box)],
      aim: [box([p.x0, GROUND_Y, p.z0, p.x1, roofTop, p.z1]), box([p.board.x0, p.board.y0, p.board.z, p.board.x1, p.board.y1, p.board.z])],
      outline: [box([p.x0, FEET_Y, p.z0, p.x1, FEET_Y + p.high, p.z1])],
      stake: block(p.stake), stand: point(p.stand), standYaw: worldYaw(f, p.standYaw), anchors: { door: block([p.doorX, FEET_Y, p.zFront]) }, lists: {}, notes: '',
    });
  }
  return { version: 3, places, green: point(layout.green) };
}
