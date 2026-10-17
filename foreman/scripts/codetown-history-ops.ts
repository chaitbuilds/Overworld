// The history of a code town, as operations the game can replay: today's town wound back through its repository's
// commits (history.json, from codetown-history.ts), each building drawn at the size its lines of code gave it then.
//
//   node --import tsx scripts/codetown-history-ops.ts <town folder> --out <history town folder> --frame ox,oz[,turn] [--settle 15]
//
// Reads <town>/layout.json, map.json and history.json. Writes into <out>: layout.json (the same layout set down at
// --frame, so that the replay stands apart from the town itself) and history-ops.json: the keyframes, each the commit
// at which some building appears, changes size or gains a lamp, with the blocks that change (only those), bottom up.
//
// Rules, all of them (nothing here is chosen by hand):
//   - plots are today's: a building stands where it stands today, its door where it is today, and grows or shrinks about it;
//   - its size is the mapper's own step for the lines of code it held at that commit (codetown-history.ts says which lines);
//   - a change of size that is undone within `settle` commits is not drawn (a folder that hovers at a threshold would flicker);
//   - its lamps are the test files of today that existed then, DARK: whether they passed then is not known. At the last
//     keyframe ("today") they are lit, as the town's own whole check found them;
//   - a quarter's gate goes up with its first building.
import fs from 'node:fs';
import path from 'node:path';
import { STEPS, stepFor, type TownMap } from '../src/codetown/mapper.js';
import { FEET_Y, GROUND_Y, type Gate, type Plot, type TownLayout } from '../src/codetown/layout.js';
import { boardScale, gateBlocks, gateScale, lampBlocks, shellBlocks, type Lamp } from '../src/codetown/buildings.js';
import { worldBox, worldPlacement, worldPoint, worldYaw, type Frame } from '../src/codetown/frame.js';
import type { Placement } from '../src/town/engine.js';

const args = process.argv.slice(2);
const opt = (name: string, fallback?: string): string | undefined => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
if (!args[0] || !opt('--out')) { console.error('usage: codetown-history-ops.ts <town folder> --out <history town folder> --frame ox,oz[,turn] [--settle 15]'); process.exit(2); }
const town = path.resolve(args[0]), out = path.resolve(opt('--out') as string), settle = Number(opt('--settle', '15'));
const fr = (opt('--frame', '0,0,1') as string).split(',').map(Number), frame: Frame = { ox: fr[0] ?? 0, oz: fr[1] ?? 0, turn: fr[2] === 0 ? 0 : 1 };
const read = <T>(name: string): T => JSON.parse(fs.readFileSync(path.join(town, name), 'utf8')) as T;
const layout = { ...read<TownLayout>('layout.json'), frame }, map = read<TownMap>('map.json');
const history = read<{ commits: number; rev: string; samples: Array<{ index: number; commit: string; date: string; lines: number; modules: Record<string, [number, number]> }> }>('history.json');
const quarterIndex = new Map(map.quarters.map((q, i) => [q.id, i]));
const plots = layout.plots, S = history.samples;

// ---- what each building is at each commit: its step (-1: not there) and its lamps, with hovering sizes settled
type Look = { step: number; lamps: number };
const raw = (k: number, id: string): Look => { const row = S[k]?.modules[id]; return { step: row && row[0] > 0 ? stepFor(row[0]) : -1, lamps: row ? row[1] : 0 }; };
const shown = new Map<string, Look[]>();
for (const p of plots) {
  const series: Look[] = []; let cur: Look = { step: -1, lamps: 0 };
  for (let k = 0; k < S.length; k++) {
    const want = raw(k, p.module);
    if (want.step !== cur.step) {
      // taken up only if it holds for the next `settle` commits (or to the end)
      let holds = true; for (let j = k + 1; j <= Math.min(S.length - 1, k + settle); j++) if (raw(j, p.module).step !== want.step) { holds = false; break; }
      if (holds) cur = { step: want.step, lamps: want.step < 0 ? 0 : want.lamps };
    } else if (want.lamps !== cur.lamps && cur.step >= 0) cur = { step: cur.step, lamps: want.lamps };
    series.push(cur);
  }
  shown.set(p.module, series);
}

// ---- a building at a step: today's plot, about its own door
function plotAt(p: Plot, step: number): Plot {
  const s = STEPS[step] as (typeof STEPS)[number], x0 = p.doorX - Math.floor(s.wide / 2), x1 = x0 + s.wide - 1, zBack = p.zFront - p.face * (s.deep - 1);
  return { ...p, wide: s.wide, deep: s.deep, high: s.high, x0, x1, z0: Math.min(p.zFront, zBack), z1: Math.max(p.zFront, zBack) };
}
const key = (b: Placement): string => `${b[0]},${b[1]},${b[2]}`;
function cellsOf(p: Plot, look: Look, lamp: Lamp): Map<string, Placement> {
  const cells = new Map<string, Placement>();
  if (look.step < 0) return cells;
  const at = plotAt(p, look.step);
  for (const b of shellBlocks(at, quarterIndex.get(p.quarter) ?? 0)) cells.set(key(b), b);
  for (const b of lampBlocks(at, Array.from({ length: Math.min(look.lamps, (at.wide - 2) * 2) }, () => lamp))) cells.set(key(b), b);
  // (air that only clears what never stood there is not sent)
  for (const [k, b] of cells) if (b[3] === 'air') cells.delete(k);
  return cells;
}
/** The blocks that differ between two looks of a building, bottom up; what is no longer there goes back to air (grass at the ground). */
function change(was: Map<string, Placement>, now: Map<string, Placement>): Placement[] {
  const outb: Placement[] = [];
  for (const [k, b] of now) if (was.get(k)?.[3] !== b[3]) outb.push(b);
  for (const [k, b] of was) if (!now.has(k)) outb.push([b[0], b[1], b[2], b[1] <= GROUND_Y ? 'grass_block' : 'air']);
  // what comes down goes first at each height, then what goes up; bottom to top
  return outb.sort((a, b) => a[1] - b[1] || (a[3] === 'air' ? -1 : 0) - (b[3] === 'air' ? -1 : 0));
}

const part = (p: Plot): string => `hb-${p.place}`, gatePart = (g: Gate): string => `h${g.place}`;
type Op = Record<string, unknown>;
const keyframes: Array<{ n: number; index: number; commit: string; date: string; lines: number; standing: number; lamps: number; changed: string[]; rises: string[]; ops: Op[] }> = [];
const standing = new Map<string, Map<string, Placement>>(), begun = new Set<string>(), gatesUp = new Set<string>();
const world = (b: Placement): Placement => worldPlacement(frame, b);

function frameOps(k: number, lamp: Lamp, force = false): { ops: Op[]; changed: string[]; rises: string[] } {
  const ops: Op[] = [], changed: string[] = [], rises: string[] = [];
  for (const p of plots) {
    const look = (shown.get(p.module) as Look[])[k] as Look, prev = k > 0 ? (shown.get(p.module) as Look[])[k - 1] as Look : { step: -1, lamps: 0 };
    if (!force && k > 0 && look.step === prev.step && look.lamps === prev.lamps) continue;
    if (!force && k === 0 && look.step < 0) continue;
    const was = standing.get(p.module) ?? new Map<string, Placement>(), now = cellsOf(p, look, lamp), blocks = change(was, now);
    if (!blocks.length) continue;
    const gate = layout.gates.find((g) => g.quarter === p.quarter);
    if (gate && look.step >= 0 && !gatesUp.has(gate.place)) {
      gatesUp.add(gate.place);
      const wide = gate.zSouth - gate.zNorth + 1, scale = gateScale(gate.name, wide), zMid = (gate.zNorth + gate.zSouth + 1) / 2, y = gate.top + 1 + (2 - 0.25 * scale) / 2;
      ops.push({ op: 'part.begin', part: gatePart(gate), boxes: [worldBox(frame, gate.box)], open: true });
      // (no lever: nothing is approved in a replay)
      ops.push({ op: 'blocks', part: gatePart(gate), blocks: gateBlocks(gate, false).filter((b) => !String(b[3]).startsWith('lever')).map(world), seconds: 0.3 });
      ops.push({ op: 'label', part: gatePart(gate), label: 'west', at: worldPoint(frame, [gate.x - 0.04, y, zMid]), text: `§l${gate.name}`, scale, yaw: worldYaw(frame, 90), width: 900, after: true });
      ops.push({ op: 'label', part: gatePart(gate), label: 'east', at: worldPoint(frame, [gate.x + 1.04, y, zMid]), text: `§l${gate.name}`, scale, yaw: worldYaw(frame, -90), width: 900, after: true });
    }
    if (!begun.has(p.module)) { begun.add(p.module); ops.push({ op: 'part.begin', part: part(p), boxes: [worldBox(frame, p.box)], open: true }); }
    // a building rises over a moment; a change of size is quicker
    ops.push({ op: 'blocks', part: part(p), blocks: blocks.map(world), seconds: prev.step < 0 ? 0.5 : 0.3 });
    if (prev.step < 0 && look.step >= 0) {
      const scale = boardScale(p.name);
      ops.push({ op: 'label', part: part(p), label: 'board', at: worldPoint(frame, [p.board.words[0], p.board.y0 + (2 - 0.25 * scale) / 2, p.board.words[2]]), text: `§l${p.name}`, scale, yaw: worldYaw(frame, p.board.yaw), width: 900, after: true });
      rises.push(p.name);
    }
    if (look.step < 0) ops.push({ op: 'label.remove', part: part(p), label: 'board' });
    standing.set(p.module, now); changed.push(p.name);
  }
  return { ops, changed, rises };
}
const count = (k: number): { standing: number; lamps: number } => ({ standing: plots.filter((p) => ((shown.get(p.module) as Look[])[k] as Look).step >= 0).length, lamps: plots.reduce((n, p) => n + ((shown.get(p.module) as Look[])[k] as Look).lamps, 0) });
for (let k = 0; k < S.length; k++) {
  const { ops, changed, rises } = frameOps(k, 'dark');
  if (!ops.length) continue;
  const s = S[k] as (typeof S)[number];
  keyframes.push({ n: keyframes.length, index: s.index, commit: s.commit, date: s.date, lines: s.lines, ...count(k), changed, rises, ops });
}
// today: the lamps are lit (the town's own whole check of the branch as it stands)
{
  const k = S.length - 1, s = S[k] as (typeof S)[number], ops: Op[] = [], changed: string[] = [];
  for (const p of plots) {
    const look = (shown.get(p.module) as Look[])[k] as Look; if (look.step < 0 || !look.lamps) continue;
    const was = standing.get(p.module) as Map<string, Placement>, now = cellsOf(p, look, 'lit'), blocks = change(was, now);
    if (blocks.length) { ops.push({ op: 'blocks', part: part(p), blocks: blocks.map(world), seconds: 0 }); standing.set(p.module, now); changed.push(p.name); }
  }
  keyframes.push({ n: keyframes.length, index: s.index, commit: s.commit, date: s.date, lines: s.lines, ...count(k), changed, rises: [], ops });
}

// ---- how the last keyframe compares with the town as mapped (they should agree, but for what was merged since)
const lastLooks = plots.map((p) => ({ id: p.module, ...((shown.get(p.module) as Look[])[S.length - 1] as Look) }));
const differs = lastLooks.filter((l) => { const m = map.modules.find((x) => x.id === l.id); return !m || m.step !== l.step || m.tests.length !== l.lamps; }).map((l) => { const m = map.modules.find((x) => x.id === l.id); return `${l.id}: step ${l.step}/${m?.step}, lamps ${l.lamps}/${m?.tests.length}`; });

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'layout.json'), `${JSON.stringify(layout, null, 1)}\n`);
fs.writeFileSync(path.join(out, 'map.json'), `${JSON.stringify(map, null, 1)}\n`);
// every commit's date and lines of code, by its number: [date, lines]
fs.writeFileSync(path.join(out, 'history-commits.json'), `${JSON.stringify({ repo: map.repo, rev: history.rev, commits: history.commits, rows: S.map((x) => [x.date, x.lines]) })}\n`);
fs.writeFileSync(path.join(out, 'history-ops.json'), `${JSON.stringify({ version: 1, repo: map.repo, rev: history.rev, commits: history.commits, frame, settle,
  rule: 'today\'s plots; each building at the mapper\'s size step for the lines of code it held at that commit; a size change undone within `settle` commits is not drawn; lamps are today\'s test files that existed then, dark (lit only at the last keyframe, today); a gate goes up with its quarter\'s first building',
  parts: { buildings: plots.map(part), gates: layout.gates.map(gatePart) }, keyframes })}\n`);
console.log(`${keyframes.length} keyframes from ${S[0]?.date.slice(0, 10)} to ${S.at(-1)?.date.slice(0, 10)} (${history.commits} commits) -> ${path.join(out, 'history-ops.json')}`);
console.log(`blocks in all: ${keyframes.reduce((n, f) => n + f.ops.reduce((m, o) => m + (Array.isArray(o.blocks) ? o.blocks.length : 0), 0), 0)}; the largest keyframe: ${Math.max(...keyframes.map((f) => f.ops.reduce((m, o) => m + (Array.isArray(o.blocks) ? o.blocks.length : 0), 0)))}`);
console.log(differs.length ? `the last keyframe differs from the map in: ${differs.join('; ')}` : 'the last keyframe is the town as mapped');
void FEET_Y;
