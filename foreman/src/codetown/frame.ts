// A town is laid out and drawn in its own street coordinates (the street runs along +x, its north side at -z) and
// then set into the world by a frame: where the street's west end is, and which way the street runs. By default the
// street runs from south to north in the world, so that the midday sun, which stands in the south, lights the fronts
// on both sides alike. Everything that leaves this folder for the game (blocks, boxes, labels, places) goes through
// here; nothing else knows which way the town is turned.
import type { Box6, Placement, Vec, WorldDriver } from '../town/engine.js';

export interface Frame {
  /** The world block the street-coordinate origin falls on. */
  ox: number; oz: number;
  /** 0: the street runs east (street x is world x). 1: the street runs north (street +x is world -z; the street's north side is the world's west). */
  turn: 0 | 1;
}
export const STREET_NORTH: Frame = { ox: 0, oz: 0, turn: 1 };

const DIRS_TURNED: Record<string, string> = { north: 'west', west: 'south', south: 'east', east: 'north' };

export function worldBlock(f: Frame, x: number, y: number, z: number): [number, number, number] {
  return f.turn ? [f.ox + z, y, f.oz - x] : [f.ox + x, y, f.oz + z];
}
/** A point (not a block): the same turn about the same origin, so a point inside a block stays inside it. */
export function worldPoint(f: Frame, p: Vec): Vec {
  return f.turn ? [f.ox + p[2], p[1], f.oz + 1 - p[0]] : [f.ox + p[0], p[1], f.oz + p[2]];
}
export function worldBox(f: Frame, b: Box6): Box6 {
  const a = worldBlock(f, b[0], b[1], b[2]), c = worldBlock(f, b[3], b[4], b[5]);
  return [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.min(a[2], c[2]), Math.max(a[0], c[0]), Math.max(a[1], c[1]), Math.max(a[2], c[2])];
}
/** A yaw in the game's sense (0 south, 90 west, 180 north, -90 east). */
export function worldYaw(f: Frame, yaw: number): number {
  if (!f.turn) return yaw;
  const y = yaw - 90;
  return y <= -180 ? y + 360 : y;
}
/** A block state whose properties name directions, turned with the town. */
export function worldState(f: Frame, state: string): string {
  if (!f.turn || !state.includes('[')) return state;
  const open = state.indexOf('['), name = state.slice(0, open);
  const props = state.slice(open + 1, -1).split(',').map((kv) => {
    const [k, v] = kv.split('=') as [string, string];
    if ((k === 'facing' || k === 'hinge_facing') && DIRS_TURNED[v]) return `${k}=${DIRS_TURNED[v]}`;
    if (k === 'rotation') return `${k}=${(Number(v) + 12) % 16}`;
    if (k === 'axis' && (v === 'x' || v === 'z')) return `${k}=${v === 'x' ? 'z' : 'x'}`;
    if (DIRS_TURNED[k]) return `${DIRS_TURNED[k]}=${v}`;
    return kv;
  });
  return `${name}[${props.join(',')}]`;
}
export function worldPlacement(f: Frame, p: Placement): Placement {
  const [x, y, z] = worldBlock(f, p[0], p[1], p[2]);
  return [x, y, z, worldState(f, p[3])];
}

/** A driver that takes everything in street coordinates and hands it on in the world's. */
export function turned(driver: WorldDriver, f: Frame): WorldDriver {
  return {
    begin: (part, boxes, open) => driver.begin(part, boxes.map((b) => worldBox(f, b)), open),
    build: (part, blocks, seconds) => driver.build(part, blocks.map((b) => worldPlacement(f, b)), seconds),
    label: (part, id, at, text, scale, fixed) => driver.label(part, id, worldPoint(f, at), text, scale, fixed ? { ...fixed, ...(fixed.yaw === undefined ? {} : { yaw: worldYaw(f, fixed.yaw) }) } : fixed),
    labelRemove: (part, id) => driver.labelRemove(part, id),
    watch: (part, key, kind, box) => driver.watch(part, key, kind, worldBox(f, box)),
    sound: (part, name, at, volume, pitch) => driver.sound(part, name, worldPoint(f, at), volume, pitch),
  };
}
