// What the town is drawn with: positions, boxes and block placements, and the world a drawing goes to (a WorldDriver:
// the real game through live.ts). The code town's drawer (codetown/draw.ts) works in street coordinates and hands
// everything to the world through codetown/frame.ts.

export type Vec = [number, number, number];
/** x0, y0, z0, x1, y1, z1 of whole blocks, both corners included. */
export type Box6 = [number, number, number, number, number, number];
export type Placement = [number, number, number, string];

/** A world that can carry out what the town draws. Promises resolve when the thing has happened there. */
export interface WorldDriver {
  /** A part of the town (a building, a gate) begins: the boxes it may draw in. */
  begin(part: string, boxes: Box6[], open: boolean): void;
  build(part: string, blocks: Placement[], seconds: number | undefined): Promise<{ placed: number; refused: string[] }>;
  label(part: string, id: string, at: Vec, text: string, scale: number | undefined, fixed?: { yaw?: number; width?: number; left?: boolean; background?: number }): void;
  labelRemove(part: string, id: string): void;
  /** Watch a box: a player using a block in it is reported as a `use` event with this key. */
  watch(part: string, key: string, kind: 'use' | 'zone' | 'container', box: Box6): void;
  sound(part: string, name: string, at: Vec, volume: number | undefined, pitch: number | undefined): void;
}
