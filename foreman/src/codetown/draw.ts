// Draws a code town in the game through the block and label channel (town/live.ts), from the layout and the state
// of each building. It draws only what differs from what it last drew, so the service can call it after anything
// changes. No agent writes any of this: every building and every gate is a part of the town's own.
import type { WorldDriver, Placement } from '../town/engine.js';
import { GROUND_Y } from './layout.js';
import { bannerBlocks, boardScale, doorBlocks, eaveY, frameBlocks, gateBlocks, gateScale, interiorBlocks, lampBlocks, leverBlock, lotBlocks, outlineBlocks, scaffoldBlocks, scaffoldGone, screenCells, screenWallBlocks, shellBlocks, textPixels, type Lamp } from './buildings.js';
import { BOARD_WIDE } from './layout.js';
import { FEET_Y, type Gate, type Plot, type TownLayout } from './layout.js';
import { turned } from './frame.js';

/** What a building shows at a moment. */
export interface BuildingLook {
  /** One for each test file that covers it, in the order of the files' names. */
  lamps: Lamp[];
  /** The plan names it: 'planned' yellow; a check failed on it: 'red'; its change is merged: 'lime'. */
  outline: 'none' | 'yellow' | 'red' | 'lime';
  scaffold: boolean;
  banners: boolean;
  /** A short line on the board under the building's name while it is part of a change: who is at it, how its tests stand ('' for none). */
  note?: string;
  /** Its door stands open: someone is at work inside. */
  door?: boolean;
  /** What the screen inside shows: lines of words with colour codes ('' for nothing). */
  screen?: string;
}
export const AT_REST: BuildingLook = { lamps: [], outline: 'none', scaffold: false, banners: false, note: '', door: false, screen: '' };
/** How far a building stands: a lot (a new module, nothing written yet), a frame (its code being written), or built. */
export type Stage = 'lot' | 'frame' | 'built';

/** The size of the words on a building's screen, and how many lines and letters fit it. */
export function screenFit(p: Plot): { scale: number; lines: number; letters: number } {
  const sc = screenCells(p), wide = sc.x1 - sc.x0 + 1, high = sc.y1 - sc.y0 + 1;
  const scale = Math.min(((wide - 0.4) * 40) / (40 * 6), (high - 0.35) / (0.25 * 12));
  return { scale, lines: Math.max(4, Math.floor((high - 0.35) / (0.25 * scale))), letters: Math.max(20, Math.floor(((wide - 0.4) * 40) / (6 * scale))) };
}
/** Placements in the order they should go up: from the ground, course by course. */
const upward = (blocks: Placement[]): Placement[] => [...blocks].sort((a, b) => a[1] - b[1]);

export const buildingPart = (p: Plot): string => `b-${p.place}`;
export const gatePart = (g: Gate): string => g.place;
/** The key of the watch on a gate's lever. */
export const LEVER_KEY = 'approve';

export class TownDrawer {
  private shown = new Map<string, BuildingLook>();
  private levers = new Map<string, boolean>();
  private plates = new Map<string, string>();
  private standing = false;
  private quarterIndex: Map<string, number>;
  /** The name over the product's screen on the square. */
  screenName = '';
  /** Plots that are not (yet) built: a new module's lot, or its frame. Everything else is built. */
  private stages = new Map<string, Stage>();

  private driver: WorldDriver;

  constructor(
    driver: WorldDriver,
    public layout: TownLayout,
    quarterOrder: string[],
    private log: (line: string) => void = () => undefined,
    /** How many source files a module has (a bookshelf for each, inside). */
    private filesOf: (module: string) => number = () => 0,
  ) {
    // everything below is in street coordinates; the frame sets it into the world
    this.driver = turned(driver, layout.frame);
    this.quarterIndex = new Map(quarterOrder.map((q, i) => [q, i]));
  }

  /** The world is new to us (the game arrived or was loaded again): nothing is known to stand. */
  forget(): void { this.shown.clear(); this.levers.clear(); this.plates.clear(); this.standing = false; }
  get drawn(): boolean { return this.standing; }

  private build(part: string, blocks: Placement[], seconds = 0): Promise<void> {
    if (!blocks.length) return Promise.resolve();
    return this.driver.build(part, blocks, seconds).then(
      (r) => { if (r.refused.length) this.log(`${part}: ${r.refused.length} block(s) refused, first: ${r.refused[0]}`); },
      (e) => this.log(`${part}: ${(e as Error).message}`),
    );
  }

  /** Every gate and every building, as it is at rest. `seconds` paces each building's rise (0: at once). */
  drawAll(seconds = 0): void {
    for (const g of this.layout.gates) {
      const part = gatePart(g);
      this.driver.begin(part, [g.box], true);
      const up = this.build(part, gateBlocks(g, false), 0);
      this.levers.set(g.place, false);
      const wide = g.zSouth - g.zNorth + 1, scale = gateScale(g.name, wide), zMid = (g.zNorth + g.zSouth + 1) / 2, y = g.top + 1 + (2 - 0.25 * scale) / 2;
      // the name on both faces of the beam, written once the beam stands (words must never hang in the air)
      void up.then(() => {
        this.driver.label(part, 'west', [g.x - 0.04, y, zMid], `§l${g.name}`, scale, { yaw: 90, width: 900 });
        this.driver.label(part, 'east', [g.x + 1.04, y, zMid], `§l${g.name}`, scale, { yaw: -90, width: 900 });
      });
      // the lever, and the post it is on at that height: a hand that reaches for the lever and touches the post beside it has still thrown it
      this.driver.watch(part, LEVER_KEY, 'use', [g.lever[0], g.lever[1] - 1, g.lever[2], g.lever[0] + 1, g.lever[1] + 1, g.lever[2]]);
    }
    const sw = this.layout.screen;
    if (sw) {
      const part = `screen-${sw.id}`;
      this.driver.begin(part, [sw.box], true);
      void this.build(part, screenWallBlocks(sw), seconds).then(() => this.driver.label(part, 'name', sw.words, `§l${this.screenName}`, 2.2, { yaw: sw.yaw, width: 900 }));
    }
    for (const p of this.layout.plots) {
      const part = buildingPart(p), stage = this.stages.get(p.place) ?? 'built';
      this.driver.begin(part, [p.box], true);
      const body = stage === 'built' ? [...shellBlocks(p, this.quarterIndex.get(p.quarter) ?? 0), ...interiorBlocks(p, this.filesOf(p.module), this.quarterIndex.get(p.quarter) ?? 0)] : stage === 'frame' ? [...frameBlocks(p), ...interiorBlocks(p, this.filesOf(p.module), this.quarterIndex.get(p.quarter) ?? 0)] : lotBlocks(p);
      const up = this.build(part, body, seconds);
      // whatever an earlier run left of the town's signs is taken away: the town is drawn at rest, then brought to what the record says
      void this.build(part, [...scaffoldGone(p), ...outlineBlocks(p, 'none'), ...bannerBlocks(p, 'none')], 0);
      void up.then(() => this.board(p, ''));
      this.driver.labelRemove(part, 'note'); this.driver.labelRemove(part, 'screen');
      this.shown.set(p.place, { ...AT_REST, lamps: [] });
    }
    this.standing = true;
  }

  stage(p: Plot): Stage { return this.stages.get(p.place) ?? 'built'; }

  /** A new module's lot: its floor and its board (its name), where its building will stand when its code is written. */
  lot(p: Plot): void {
    const part = buildingPart(p);
    this.stages.set(p.place, 'lot');
    if (!this.standing) return;
    this.driver.begin(part, [p.box], true);
    void this.build(part, upward(lotBlocks(p)), 1.2).then(() => this.board(p, this.shown.get(p.place)?.note ?? ''));
    this.shown.set(p.place, { ...AT_REST, lamps: [], note: this.shown.get(p.place)?.note ?? '' });
  }
  /** A new module's frame, at the size its lines make so far (`was`: the frame or lot it replaces). */
  frame(was: Plot, p: Plot, files: number): void {
    const part = buildingPart(p);
    this.stages.set(p.place, 'frame');
    if (!this.standing) return;
    this.driver.begin(part, [was.box, p.box], true);
    // what stood before goes (a frame is drawn whole each time it grows), then the new one rises from the ground
    const gone: Placement[] = [...scaffoldGone(was), ...outlineBlocks(was, 'none')];
    for (let x = was.x0; x <= was.x1; x++) for (let z = was.z0; z <= was.z1; z++) for (let y = GROUND_Y + 1; y <= eaveY(was); y++) gone.push([x, y, z, 'air']);
    for (let x = was.board.x0; x <= was.board.x1; x++) for (let y = GROUND_Y + 1; y <= was.board.y1 + 1; y++) gone.push([x, y, was.board.z, 'air']);
    const look = this.shown.get(p.place) ?? AT_REST;
    void this.build(part, gone, 0);
    void this.build(part, [...upward(frameBlocks(p)), ...interiorBlocks(p, files, this.quarterIndex.get(p.quarter) ?? 0)], 2.0).then(() => {
      // (what the building shows NOW: its look may have changed while it rose)
      const now = this.shown.get(p.place) ?? look;
      void this.build(part, lotBlocks(p).filter((b) => b[2] === p.board.z), 0).then(() => this.board(p, now.note ?? ''));
      if (now.screen) this.screen(p, now.screen);
    });
    if (look.scaffold) { const { poles, rails } = scaffoldBlocks(p); void this.build(part, poles, 0); void this.build(part, rails, 0); }
    this.shown.set(p.place, { ...look, lamps: [], door: false });
  }
  /**
   * A building drawn again at another size where it stands (`was`: what stood there): a new module's building when its
   * change is merged, or a building whose code crossed a step of the size rule. It rises from the ground.
   */
  raise(was: Plot, p: Plot, seconds = 3): void {
    const part = buildingPart(p), stage = this.stages.get(was.place) ?? 'built';
    this.stages.set(p.place, 'built');
    if (!this.standing) return;
    this.driver.begin(part, [was.box, p.box], true);
    const shrink = p.x0 > was.x0 || p.x1 < was.x1 || p.deep < was.deep || p.high < was.high;
    const gone: Placement[] = [...scaffoldGone(was), ...outlineBlocks(was, 'none'), ...bannerBlocks(was, 'none')];
    if (shrink || stage !== 'built') {
      const roof = eaveY(was) + Math.ceil(was.deep / 2) + 1;
      for (let x = was.x0 - 1; x <= was.x1 + 1; x++) for (let z = was.z0; z <= was.z1; z++) for (let y = GROUND_Y + 1; y <= roof; y++) gone.push([x, y, z, 'air']);
    }
    for (let x = was.board.x0; x <= was.board.x1; x++) for (let y = GROUND_Y + 1; y <= was.board.y1 + 1; y++) gone.push([x, y, was.board.z, 'air']);
    this.driver.labelRemove(part, 'screen');
    void this.build(part, gone, 0);
    const look = this.shown.get(p.place) ?? AT_REST;
    void this.build(part, upward([...shellBlocks(p, this.quarterIndex.get(p.quarter) ?? 0), ...interiorBlocks(p, this.filesOf(p.module), this.quarterIndex.get(p.quarter) ?? 0)]), seconds).then(() => {
      // (what the building shows NOW: its look may have changed while it rose)
      const now = this.shown.get(p.place) ?? look;
      this.board(p, now.note ?? '');
      if (now.screen) this.screen(p, now.screen);
      if (now.banners) void this.build(part, bannerBlocks(p, 'lime'), 0);
      if (now.lamps.length) void this.build(part, lampBlocks(p, now.lamps), 0);
    });
    this.shown.set(p.place, { ...look, scaffold: false, outline: 'none', door: false });
  }

  /** The words on the screen inside a building. */
  private screen(p: Plot, text: string): void {
    const part = buildingPart(p);
    if (!text) { this.driver.labelRemove(part, 'screen'); return; }
    const sc = screenCells(p), fit = screenFit(p);
    const z = p.face === 1 ? sc.z + 1.02 : sc.z - 0.02;
    // the words hang from the top of the screen (a label stands on its foot: it is set as far down as its lines reach)
    const rows = Math.min(fit.lines, text.split('\n').length), foot = Math.max(sc.y0 + 0.12, sc.y1 + 1 - 0.18 - rows * 0.25 * fit.scale);
    this.driver.label(part, 'screen', [(sc.x0 + sc.x1 + 1) / 2, foot, z], text, fit.scale, { yaw: p.board.yaw, width: Math.round(((sc.x1 - sc.x0 + 1 - 0.3) * 40) / fit.scale), left: true });
  }

  /** The words on a building's board: its name, filling the board; with a note, the name on the upper half and the note under it. */
  private board(p: Plot, note: string): void {
    const part = buildingPart(p), at = (y: number): [number, number, number] => [p.board.words[0], y, p.board.words[2]];
    if (!note) {
      const scale = boardScale(p.name);
      this.driver.labelRemove(part, 'note');
      this.driver.label(part, 'board', at(p.board.y0 + (2 - 0.25 * scale) / 2), `§l${p.name}`, scale, { yaw: p.board.yaw, width: 900 });
      return;
    }
    // (a colour code at its start is not part of the words' width)
    const plain = note.replace(/§./g, '');
    const name = Math.min(boardScale(p.name), 3.3), small = Math.min(2.9, ((BOARD_WIDE - 0.5) * 40) / textPixels(plain, false));
    this.driver.label(part, 'board', at(p.board.y0 + 1 + (1 - 0.25 * name) / 2), `§l${p.name}`, name, { yaw: p.board.yaw, width: 900 });
    this.driver.label(part, 'note', at(p.board.y0 + 0.04 + (1 - 0.25 * small) / 2), note, small, { yaw: p.board.yaw, width: 900 });
  }

  /** Bring one building to a look. Only what changed is drawn. */
  set(p: Plot, look: BuildingLook): void {
    const was = this.shown.get(p.place) ?? AT_REST, part = buildingPart(p), built = this.stage(p) === 'built';
    if (built && was.lamps.join() !== look.lamps.join()) void this.build(part, lampBlocks(p, look.lamps), 0);
    if (built && !!was.door !== !!look.door) void this.build(part, doorBlocks(p, !!look.door), 0);
    if (this.stage(p) !== 'lot' && (was.screen ?? '') !== (look.screen ?? '')) this.screen(p, look.screen ?? '');
    // the scaffolding comes down at once (taken apart slowly, what is left would fall); the outline it stood on is drawn again
    const scaffoldDown = was.scaffold && !look.scaffold;
    if (scaffoldDown) void this.build(part, scaffoldGone(p), 0);
    if (was.outline !== look.outline || scaffoldDown) void this.build(part, outlineBlocks(p, look.scaffold ? 'none' : look.outline), 0);
    if (!was.scaffold && look.scaffold) {
      const { poles, rails } = scaffoldBlocks(p);
      // poles first, then rails: a rail holds only within reach of a pole
      void this.build(part, outlineBlocks(p, 'none'), 0);
      void this.build(part, poles, 2); void this.build(part, rails, 1.5);
    }
    if (was.banners !== look.banners) void this.build(part, bannerBlocks(p, look.banners ? 'lime' : 'none'), 0);
    if ((was.note ?? '') !== (look.note ?? '')) this.board(p, look.note ?? '');
    this.shown.set(p.place, { lamps: built ? [...look.lamps] : [], outline: look.outline, scaffold: look.scaffold, banners: look.banners, note: look.note ?? '', door: built && !!look.door, screen: this.stage(p) !== 'lot' ? look.screen ?? '' : '' });
  }

  /** The lever on a gate, thrown or not. */
  lever(g: Gate, powered: boolean): void {
    if (this.levers.get(g.place) === powered) return;
    this.levers.set(g.place, powered);
    void this.build(gatePart(g), [leverBlock(g, powered)], 0);
    if (powered) { this.driver.sound(gatePart(g), 'block.bell.use', [g.lever[0] + 0.5, g.lever[1], g.lever[2] + 0.5], 1.0, 1.0); }
  }

  /** The small plate on a gate's north post, over the lever: how the change asked at this gate stands ('' takes it away). */
  plate(g: Gate, text: string): void {
    if ((this.plates.get(g.place) ?? '') === text) return;
    this.plates.set(g.place, text);
    const part = gatePart(g);
    if (!text) { this.driver.labelRemove(part, 'plate'); return; }
    // on the post's west face (the side people come from), above the lever, as wide as the post lets it be read from the lever
    this.driver.label(part, 'plate', [g.lever[0] + 0.96, g.lever[1] + 1.25, g.lever[2] + 0.5], text, 0.62, { yaw: 90, width: 120 });
  }

  /** Where a tag over a building would point: the middle of its roof ridge. */
  static crown(p: Plot): [number, number, number] {
    return [(p.x0 + p.x1 + 1) / 2, FEET_Y + p.high + Math.ceil(p.deep / 2) + 1, (p.z0 + p.z1 + 1) / 2];
  }
}
