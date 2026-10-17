// Map a repository as a town: node --import tsx scripts/codetown-map.ts <repository> [--dir <folder>] [--name <board name of the root>] [--frame ox,oz[,turn]] [--lamps lit|dark]
// Prints the quarters and their buildings. With --dir, writes what the town is built from:
//   map.json       the mapper's whole result            layout.json    where everything stands
//   places.json    the places file the game and the backend read
//   draw-ops.json  the operations that draw the town at rest (for looking at a town without a backend)
import fs from 'node:fs';
import path from 'node:path';
import { mapRepository } from '../src/codetown/mapper.js';
import { layoutTown, placesOf } from '../src/codetown/layout.js';
import { TownDrawer } from '../src/codetown/draw.js';
import type { WorldDriver } from '../src/town/engine.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const repo = args.find((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--'));
if (!repo) { console.error('usage: codetown-map.ts <repository> [--dir <folder>] [--name <name>] [--frame ox,oz[,turn]] [--lamps lit|dark]'); process.exit(2); }
const map = await mapRepository(path.resolve(repo), { repoName: flag('--name') });
const byId = new Map(map.modules.map((m) => [m.id, m]));
console.log(`${map.repo} @ ${map.commit.slice(0, 7)} (${map.branch}): ${map.totals.lines} lines in ${map.totals.files} files -> ${map.totals.modules} buildings in ${map.totals.quarters} quarters, ${map.totals.paths} paths, ${map.totals.tests} test files`);
for (const q of map.quarters) {
  console.log(`\n${q.name}${q.apart ? '  (apart: across the water)' : ''}   [${q.id}]`);
  for (const id of q.modules) {
    const m = byId.get(id)!;
    console.log(`  ${m.name.padEnd(26)} ${String(m.lines).padStart(6)} lines  ${String(m.files.length).padStart(3)} files  ${m.wide}x${m.deep}x${m.high}  depth ${m.depth}  lamps ${m.tests.length}   ${m.id}${m.looseOf ? ' (shared)' : ''}`);
  }
}
const dir = flag('--dir');
if (dir) {
  // where the town is set into the world: "ox,oz" (the street runs north from there) or "ox,oz,0" (it runs east)
  const fr = (flag('--frame') ?? '0,0,1').split(',').map(Number);
  const layout = layoutTown(map, { ox: fr[0] ?? 0, oz: fr[1] ?? 0, turn: fr[2] === 0 ? 0 : 1 });
  fs.mkdirSync(path.resolve(dir), { recursive: true });
  const write = (name: string, value: unknown): void => fs.writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 1)}\n`);
  write('map.json', map); write('layout.json', layout); write('places.json', placesOf(layout));
  // the town at rest, as operations: every gate and building, its board, and its lamps as the flag says
  const ops: Array<Record<string, unknown>> = [];
  const rec = {
    begin: (part: string, boxes: unknown, open: boolean) => { ops.push({ op: 'part.begin', part, boxes, open }); },
    build: (part: string, blocks: unknown, seconds: number | undefined) => { ops.push({ op: 'blocks', part, blocks, seconds: seconds ?? 0 }); return Promise.resolve({ placed: 0, refused: [] }); },
    label: (part: string, id: string, at: unknown, text: string, scale: number | undefined, fixed?: { yaw?: number; width?: number }) => { ops.push({ op: 'label', part, label: id, at, text, scale, ...(fixed ?? {}) }); },
    labelRemove: (part: string, id: string) => { ops.push({ op: 'label.remove', part, label: id }); },
    watch: (part: string, key: string, kind: string, box: unknown) => { ops.push({ op: 'watch', part, key, kind, box }); },
    sound: () => undefined,
  } as unknown as WorldDriver;
  const drawer = new TownDrawer(rec, layout, map.quarters.map((q) => q.id), (line) => console.error(line));
  drawer.drawAll(0);
  await new Promise((r) => setImmediate(r));
  const lamps = flag('--lamps') ?? 'lit';
  for (const p of layout.plots) drawer.set(p, { lamps: (byId.get(p.module)?.tests ?? []).map(() => (lamps === 'dark' ? 'dark' : 'lit')), outline: 'none', scaffold: false, banners: false });
  await new Promise((r) => setImmediate(r));
  write('draw-ops.json', { ops });
  console.log(`\nstreet x ${layout.street.x0}..${layout.street.x1}; ground x ${layout.extent.x0}..${layout.extent.x1}, z ${layout.extent.z0}..${layout.extent.z1}; ${layout.plots.length} plots, ${layout.gates.length} gates, ${ops.length} operations; green at ${layout.green.join(', ')}`);
  for (const g of layout.gates) console.log(`  gate ${g.name.padEnd(20)} x ${g.x}${g.apart ? ' (apart)' : ''}`);
  console.log(`written: ${dir}/map.json, layout.json, places.json, draw-ops.json`);
}
