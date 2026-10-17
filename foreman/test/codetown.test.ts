// The code town, with no game, no agent and no real product: the mapper's rules on a made-up repository, the plan's
// checks, the town's geometry, and the whole service with a test-only worker that copies a prepared, hand-written
// change (plan, tests first, change, the whole check, approval, the guarded merge) on a small repository whose
// "vitest" is a fake script that writes the same report.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bannerBlocks, boardScale, doorBlocks, frameBlocks, gateBlocks, interiorBlocks, lampBlocks, lampCells, lotBlocks, outlineBlocks, scaffoldBlocks, screenCells, shellBlocks, textPixels } from '../src/codetown/buildings.js';
import { ciSteps, RepoChecks, unreadable } from '../src/codetown/checks.js';
import { STREET_NORTH, worldBlock, worldBox, worldPoint, worldState, worldYaw } from '../src/codetown/frame.js';
import { freeLot, grownPlot, layoutTown, placesOf, slugOf } from '../src/codetown/layout.js';
import { boardName, classify, mapRepository, moduleOfPath, stepFor, STEPS } from '../src/codetown/mapper.js';
import { checkPlan, PLAN_FILE, waves } from '../src/codetown/plan.js';
import type { CodeTownService } from '../src/codetown/service.js';
import type { Foreman } from '../src/foreman.js';
import type { TownWorker, WorkRequest, WorkResult } from '../src/town/worker.js';
import { git } from '../src/util/git.js';
import { makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

// the town's checks read once, as they load, which files the profile hides from agents: here one of the made-up
// product's (any `.env*` is hidden always)
vi.hoisted(() => { process.env.OVERWORLD_HIDE = 'scripts/people.mjs'; });

/**
 * A test-only worker: it copies a PREPARED, hand-written change into the job's working copy (no agent session), then
 * runs the job's checks. The prepared change is a folder:
 *   PLAN.json                               the plan a lead would have written
 *   <module, "/" as "-">/tests/<path>       that module's test files, whole
 *   <module, "/" as "-">/change/<path>      the files of that module's change, whole
 */
class HandWorker implements TownWorker {
  constructor(private fm: Foreman, private dir: string) {}
  canStart(): { ok: boolean; why?: string } { return { ok: true }; }
  sessions(): { used: number; cap: number } { return { used: 0, cap: 0 }; }
  async stop(): Promise<void> {}
  async run(req: WorkRequest): Promise<WorkResult> {
    const under = (root: string, rel = ''): string[] => {
      const here = path.join(root, rel);
      if (!fs.existsSync(here)) return [];
      if (!fs.statSync(here).isDirectory()) return [rel];
      return fs.readdirSync(here).sort().flatMap((n) => under(root, rel ? path.join(rel, n) : n));
    };
    const base = path.join(this.dir, req.part.replace(/\//g, '-'), req.role === 'checks' ? 'tests' : 'change');
    const files = req.role === 'plan' ? [{ from: path.join(this.dir, PLAN_FILE), to: PLAN_FILE }] : under(base).map((rel) => ({ from: path.join(base, rel), to: rel }));
    if (!files.length) return { ok: false, summary: '', error: `nothing prepared for ${req.part}` };
    for (const f of files) {
      const why = req.allowed(f.to);
      if (why) return { ok: false, summary: '', error: `${f.to}: ${why}` };
      this.fm.setAgent(req.agentId, { state: 'editing', activity: `editing ${f.to}` });
      fs.mkdirSync(path.dirname(path.join(req.worktree, f.to)), { recursive: true });
      fs.copyFileSync(f.from, path.join(req.worktree, f.to));
      await new Promise((r) => setTimeout(r, 20));
    }
    await req.runChecks();
    return { ok: true, summary: `copied ${files.length} prepared file${files.length === 1 ? '' : 's'}` };
  }
}

const lines = (n: number, what: string): string => Array.from({ length: n }, (_, i) => `// ${what} ${i + 1}`).join('\n') + '\n';
function write(root: string, file: string, text: string): void { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); }
async function commitAll(root: string, message = 'start'): Promise<void> {
  if (!fs.existsSync(path.join(root, '.git'))) await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '-m', message], { env: { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' } });
}

describe('code town: the mapper', () => {
  let root: string;
  beforeEach(async () => {
    root = tempDir('codetown-map-');
    // a made-up product: features/{shop (large, split, with a tiny sub-folder), billing}, lib/{db, config}, app pages, a separate extension
    write(root, 'tsconfig.json', '{ // comments, and a glob that looks like one\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*"] } }, "include": ["**/*.ts", ".next/types/**/*.ts"] }');
    write(root, 'package.json', '{"name":"made-up"}');
    write(root, 'next.config.js', 'module.exports = {};\n');
    write(root, 'features/shop/copy.ts', `export const words = 1;\n${lines(400, 'copy')}`);
    write(root, 'features/shop/catalog/catalog.ts', `import { words } from '@/features/shop/copy';\nimport { a } from '../cart/a';\nimport { b } from '../cart/b';\nimport { c } from '../cart/c';\nexport const catalog = words + a + b + c;\n${lines(3600, 'catalog')}`);
    write(root, 'features/shop/cart/a.ts', `import { words } from '../copy';\nexport const a = words;\n${lines(1300, 'a')}`);
    write(root, 'features/shop/cart/b.ts', `export const b = 2;\n${lines(1300, 'b')}`);
    write(root, 'features/shop/cart/c.ts', `export const c = 3;\n${lines(300, 'c')}`);
    write(root, 'features/shop/tiny/t.ts', `export const t = 0;\n${lines(40, 't')}`);
    write(root, 'features/billing/bill.ts', `import { db } from '@/lib/db/db';\nexport const bill = db;\n${lines(500, 'bill')}`);
    write(root, 'lib/db/db.ts', `export const db = 1;\n${lines(700, 'db')}`);
    write(root, 'lib/db/schema.ts', `export const schema = 1;\n${lines(30, 'schema')}`);
    write(root, 'lib/config/env.ts', `export const env = 1;\n${lines(320, 'env')}`);
    write(root, 'lib/config/flags.ts', `export const flags = 1;\n${lines(30, 'flags')}`);
    write(root, 'lib/logger.ts', `export const log = 1;\n${lines(50, 'log')}`);
    for (const page of ['about', 'faq', 'terms']) write(root, `app/${page}/page.tsx`, `export const page = '${page}';\n${lines(350, page)}`);
    write(root, 'app/api/route.ts', `import { db } from '@/lib/db/db';\nimport { bill } from '@/features/billing/bill';\nexport const r = db + bill;\n${lines(400, 'api')}`);
    write(root, 'app/api/other.ts', `export const o = 1;\n${lines(20, 'o')}`);
    write(root, 'extension/package.json', '{"name":"ext"}');
    write(root, 'extension/lib/x.ts', `export const x = 1;\n${lines(400, 'x')}`);
    write(root, 'extension/entry/main.ts', `import { x } from '../lib/x';\nexport const m = x;\n${lines(400, 'm')}`);
    write(root, 'tests/shop/catalog.test.ts', `import { catalog } from '@/features/shop/catalog/catalog';\nimport { words } from '@/features/shop/copy';\nexport const t = catalog + words;\n`);
    write(root, 'tests/db.test.ts', `import { db } from '../lib/db/db';\nexport const t = db;\n`);
    write(root, 'scripts/tool.ts', lines(900, 'tool'));
    write(root, 'docs/readme.ts', lines(900, 'doc'));
    write(root, 'public/vendor.js', lines(900, 'vendor'));
    await commitAll(root);
  });
  afterEach(() => rmrf(root));

  it('makes one building for each module: districts, the split of a large module, small siblings and pages sharing one', async () => {
    const map = await mapRepository(root, { repoName: 'made-up' });
    const byId = new Map(map.modules.map((m) => [m.id, m]));
    // the shop is over the limit: its sub-folders are buildings, and its loose file with the small sibling share one named for it
    expect([...byId.keys()].filter((k) => k.startsWith('features/shop')).sort()).toEqual(['features/shop', 'features/shop/cart', 'features/shop/catalog']);
    expect(byId.get('features/shop')!.files.sort()).toEqual(['features/shop/copy.ts', 'features/shop/tiny/t.ts']);
    expect(byId.get('features/shop')!.looseOf).toBe('features/shop');
    // a district's sub-folders are modules whatever their size; its loose files share one building
    expect(byId.has('lib/db') && byId.has('lib/config') && byId.has('lib')).toBe(true);
    // pages (one file each, importing nothing of one another) share the building of their folder; the api is its own
    expect(byId.get('app')!.files.length).toBe(3);
    expect(byId.has('app/api')).toBe(true);
    // tests, scripts, docs, assets and configuration are not buildings
    expect(map.modules.flatMap((m) => m.files).some((f) => /^(tests|scripts|docs|public)\//.test(f) || f === 'next.config.js')).toBe(false);
    expect(map.totals.lines).toBe(map.modules.reduce((n, m) => n + m.lines, 0));
    // size steps up with lines
    for (const m of map.modules) { expect(m.step).toBe(stepFor(m.lines)); expect(m.wide).toBe(STEPS[m.step]!.wide); }
    expect(byId.get('features/shop/catalog')!.wide).toBeGreaterThan(byId.get('lib/config')!.wide);
  });

  it('lays paths where one imports another three times, lights a lamp for each test file, and orders by what depends on what', async () => {
    const map = await mapRepository(root, { repoName: 'made-up' });
    const byId = new Map(map.modules.map((m) => [m.id, m]));
    expect(map.paths.find((p) => [p.a, p.b].sort().join() === 'features/shop/cart,features/shop/catalog')?.count).toBe(3);
    expect(map.paths.some((p) => [p.a, p.b].includes('lib/db'))).toBe(false);           // imported once by two others: no path
    expect(map.tests['tests/shop/catalog.test.ts']).toEqual(['features/shop', 'features/shop/catalog']);
    expect(byId.get('lib/db')!.tests).toEqual(['tests/db.test.ts']);
    // what is depended on stands before what depends on it
    expect(byId.get('features/shop')!.depth).toBeLessThan(byId.get('features/shop/cart')!.depth);
    expect(byId.get('features/shop/cart')!.depth).toBeLessThan(byId.get('features/shop/catalog')!.depth);
    const street = map.modules.map((m) => m.id), shop = map.quarters.find((q) => q.id === 'features/shop')!;
    expect(shop.modules).toEqual(['features/shop', 'features/shop/cart', 'features/shop/catalog']);
    expect(street.indexOf('lib/db')).toBeLessThan(street.indexOf('app/api'));
    // the extension imports nothing of the town and is imported by none of it: it stands apart, last
    expect(map.quarters.at(-1)).toMatchObject({ id: 'extension', apart: true });
    expect(map.quarters.filter((q) => q.apart).length).toBe(1);
  });

  it('names boards by the last two parts of the path, and knows which building a path belongs to', async () => {
    const map = await mapRepository(root, { repoName: 'made-up' });
    expect(boardName('features/shop/catalog', 'r')).toBe('shop/catalog');
    expect(boardName('frontend/src/hooks', 'r')).toBe('frontend/hooks');
    expect(boardName('.', 'made-up')).toBe('made-up');
    expect(moduleOfPath(map, 'features/shop/catalog/new-file.ts')?.id).toBe('features/shop/catalog');
    expect(moduleOfPath(map, 'features/shop/language.ts')?.id).toBe('features/shop');          // a new loose file of the folder
    expect(moduleOfPath(map, 'features/shop/tiny/more.ts')?.id).toBe('features/shop');          // the small sibling that shares its building
    expect(moduleOfPath(map, 'lib/db/schema.ts')?.id).toBe('lib/db');
    expect(moduleOfPath(map, 'tests/anything.test.ts')).toBeUndefined();
    expect(classify('tests/shop/x.test.ts')).toBe('test');
    expect(classify('features/shop/x.spec.tsx')).toBe('test');
    expect(classify('scripts/x.ts')).toBe('other');
    expect(classify('vitest.config.ts')).toBe('other');
  });

  it('lays the town out along one street and draws every building inside its own plot', async () => {
    const map = await mapRepository(root, { repoName: 'made-up' });
    const layout = layoutTown(map), places = placesOf(layout);
    expect(layout.plots.length).toBe(map.modules.length);
    expect(layout.gates.map((g) => g.quarter)).toEqual(map.quarters.map((q) => q.id));
    expect(layout.channel).toBeDefined();                                                // water before the quarter that stands apart
    expect(new Set(places.places.map((p) => p.id)).size).toBe(places.places.length);
    for (const p of places.places) expect(p.id).toMatch(/^[a-z][a-z0-9-]{0,39}$/);
    // along the street the order is the map's, and no two plots on one side overlap
    for (const side of ['north', 'south'] as const) {
      const row = layout.plots.filter((p) => p.side === side);
      for (let i = 1; i < row.length; i++) expect(row[i]!.box[0]).toBeGreaterThan(row[i - 1]!.box[3]);
    }
    const order = layout.plots.map((p) => p.module);
    expect(order).toEqual(map.modules.map((m) => m.id));
    for (const p of layout.plots) {
      const inside = (b: readonly [number, number, number, ...unknown[]]): boolean => b[0] >= p.box[0] && b[0] <= p.box[3] && b[1] >= p.box[1] && b[1] <= p.box[4] && b[2] >= p.box[2] && b[2] <= p.box[5];
      const { poles, rails } = scaffoldBlocks(p);
      for (const b of [...shellBlocks(p, 0), ...lampBlocks(p, ['lit', 'red', 'dark']), ...outlineBlocks(p, 'yellow'), ...poles, ...rails, ...bannerBlocks(p)]) expect(inside(b), `${p.name}: ${b.join(' ')} is outside its plot`).toBe(true);
      // a rail holds only within reach of a pole at its own height
      const poleAt = new Set(poles.map(([x, y, z]) => `${x},${y},${z}`));
      for (const [x, y, z] of rails) {
        let near = false;
        for (let d = 1; d <= 6 && !near; d++) for (const [dx, dz] of [[d, 0], [-d, 0], [0, d], [0, -d]] as Array<[number, number]>) if (poleAt.has(`${x + dx},${y},${z + dz}`)) near = true;
        expect(near, `${p.name}: a rail at ${x} ${y} ${z} is out of reach of every pole`).toBe(true);
      }
      // lamps sit in the front wall, above the board, one cell each
      const cells = lampCells(p, p.wide + 3);
      expect(new Set(cells.map((c) => c.join())).size).toBe(cells.length);
      for (const [x, y, z] of cells) { expect(z).toBe(p.zFront); expect(y).toBeGreaterThan(p.board.y1); expect(x).toBeGreaterThan(p.x0); expect(x).toBeLessThan(p.x1); }
      // the name fits the board
      expect((textPixels(p.name) * boardScale(p.name)) / 40).toBeLessThanOrEqual(7);
    }
    for (const g of layout.gates) for (const [x, y, z] of gateBlocks(g)) expect(x >= g.box[0] && x <= g.box[3] && y >= g.box[1] && y <= g.box[4] && z >= g.box[2] && z <= g.box[5]).toBe(true);
  });

  it('keeps the first free lot of a quarter for a new module, and grows a building where it stands', async () => {
    const map = await mapRepository(root, { repoName: 'made-up' });
    const layout = layoutTown(map);
    const overlaps = (a: number[], b: number[]): boolean => a[0]! <= b[3]! && b[0]! <= a[3]! && a[2]! <= b[5]! && b[2]! <= a[5]!;
    const shop = layout.plots.find((p) => p.module === 'features/shop/catalog')!;
    const lot = freeLot(layout, { id: 'features/shop/wishlist', name: 'shop/wishlist', quarter: shop.quarter, wide: 7, deep: 7, high: 5, step: 1, lines: 0 }, 'features-shop-wishlist')!;
    expect(lot).toBeDefined();
    expect(lot.quarter).toBe(shop.quarter);
    for (const o of layout.plots) expect(overlaps(o.box, lot.box), `${o.name} and the lot overlap`).toBe(false);
    // the lot is in its quarter: after the gate of its quarter and before the next one
    const gate = layout.gates.find((g) => g.quarter === shop.quarter)!, next = layout.gates.filter((g) => g.x > gate.x).sort((a, b) => a.x - b.x)[0];
    expect(lot.box[0]).toBeGreaterThan(gate.box[3]);
    if (next) expect(lot.box[3]).toBeLessThan(next.box[0]);
    // a frame, an inside, a lot and a door stay inside the plot
    const inside = (p: typeof lot, b: readonly [number, number, number, ...unknown[]]): boolean => b[0] >= p.box[0] && b[0] <= p.box[3] && b[1] >= p.box[1] && b[1] <= p.box[4] && b[2] >= p.box[2] && b[2] <= p.box[5];
    for (const b of [...frameBlocks(lot), ...interiorBlocks(lot, 40), ...lotBlocks(lot), ...doorBlocks(lot, true)]) expect(inside(lot, b), `${b.join(' ')} is outside the lot`).toBe(true);
    // the screen stands against the back wall, inside the walls
    const sc = screenCells(lot);
    expect(sc.x0).toBe(lot.x0 + 1); expect(sc.x1).toBe(lot.x1 - 1);
    expect(sc.z).toBe(lot.zFront - lot.face * (lot.deep - 2));
    // grown a step where it stands: the door, the board and the front stay; nothing it does not own is touched
    for (const p of layout.plots) {
      const g = grownPlot(layout, p, Math.min(STEPS.length - 1, p.step + 1), 99_999);
      expect(g.doorX).toBe(p.doorX); expect(g.board).toEqual(p.board); expect(g.zFront).toBe(p.zFront);
      expect(g.deep).toBeGreaterThanOrEqual(p.deep); expect(g.high).toBeGreaterThanOrEqual(p.high);
      for (const o of layout.plots) if (o.place !== p.place) expect(overlaps(o.box, g.box), `${p.name} grown touches ${o.name}`).toBe(false);
    }
  });

  it('sets street coordinates into the world, a block staying the block it was', () => {
    const f = STREET_NORTH;
    expect(worldBlock(f, 10, 65, -6)).toEqual([-6, 65, -10]);                              // along the street is north; the street's north side is the west
    const p = worldPoint(f, [10.5, 65, -5.5]), b = worldBlock(f, 10, 65, -6);
    expect(p[0] >= b[0] && p[0] < b[0] + 1 && p[2] >= b[2] && p[2] < b[2] + 1).toBe(true);
    expect(worldBox(f, [0, 64, -3, 5, 70, 3])).toEqual([-3, 64, -5, 3, 70, 0]);
    expect(worldState(f, 'spruce_stairs[facing=north,half=bottom]')).toBe('spruce_stairs[facing=west,half=bottom]');
    expect(worldState(f, 'lime_banner[rotation=0]')).toBe('lime_banner[rotation=12]');
    expect(worldState(f, 'spruce_log[axis=x]')).toBe('spruce_log[axis=z]');
    expect(worldState(f, 'stone_bricks')).toBe('stone_bricks');
    expect(worldYaw(f, 0)).toBe(-90);
    expect(worldYaw(f, -90)).toBe(180);
    expect(slugOf('app/(auth)')).toBe('app-auth');
    expect(slugOf('.')).toBe('root');
  });
});

describe('code town: the plan and the rules of reading', () => {
  const map = { modules: [{ id: 'src/words' }, { id: 'src/app' }, { id: 'lib' }] } as never;
  const good = (): any => ({ summary: 'The app speaks Spanish.', modules: [{ module: 'src/words', sign: 'words in Spanish', does: 'adds the Spanish words', needs: [], tests: ['tests/words-es.test.ts'] }, { module: 'src/app', sign: 'a language choice', does: 'uses the chosen language', needs: ['src/words'], tests: ['tests/app-es.test.ts'] }] });
  it('accepts a plan that can be worked from and gives its waves', () => {
    const got = checkPlan(good(), map);
    expect(got.problems).toEqual([]);
    expect(waves(got.plan!)).toEqual([['src/words'], ['src/app']]);
    expect(Object.keys(got.plan!).sort()).toEqual(['modules', 'summary']);
  });
  it('refuses a module that is not in the map, a ring of needs, a test file named twice, a file that is not a test, a missing sign', () => {
    const a = good(); a.modules[0].module = 'src/nowhere'; expect(checkPlan(a, map).problems.join(' ')).toContain('not a module of this repository');
    const b = good(); b.modules[0].needs = ['src/app']; expect(checkPlan(b, map).problems.join(' ')).toContain('ring');
    const c = good(); c.modules[1].tests = ['tests/words-es.test.ts']; expect(checkPlan(c, map).problems.join(' ')).toContain('proves one module');
    const d = good(); d.modules[0].tests = ['src/words/index.ts']; expect(checkPlan(d, map).problems.join(' ')).toContain('not a test file');
    const f = good(); f.modules[1].needs = ['lib']; expect(checkPlan(f, map).problems.join(' ')).toContain('not in the plan');
    const h = good(); delete h.modules[0].sign; expect(checkPlan(h, map).problems.join(' ')).toContain('"sign"');
    const s = good(); delete s.summary; expect(checkPlan(s, map).problems.join(' ')).toContain('"summary"');
  });
  it('accepts a new module beside existing ones, and refuses one that exists, has no neighbours or is named oddly', () => {
    const m2 = { repo: 'x', modules: [{ id: 'src/words', quarter: 'src' }, { id: 'src/app', quarter: 'src' }, { id: 'lib', quarter: 'lib' }] } as never;
    const add = (module: string, extra: Record<string, unknown> = { new: true }): any => { const p = good(); p.modules.push({ module, ...extra, sign: 'a history of greetings', does: 'keeps a history of the greetings', needs: [], tests: ['tests/history.test.ts'] }); return p; };
    const ok = checkPlan(add('src/history'), m2);
    expect(ok.problems).toEqual([]);
    expect(ok.plan!.modules[2]).toMatchObject({ module: 'src/history', new: true });
    expect(checkPlan(add('src/history', {}), m2).problems.join(' ')).toContain('"new": true');
    expect(checkPlan(add('src/app'), m2).problems.join(' ')).toContain('a module already');
    expect(checkPlan(add('nowhere/history'), m2).problems.join(' ')).toContain('directly inside a folder');
    expect(checkPlan(add('src/History_X'), m2).problems.join(' ')).toContain('lower case');
    expect(checkPlan(add('src/history'), m2, () => true).problems.join(' ')).toContain('exists already');
  });
  it('lets no agent read an environment file, nor a file the profile hides (none unless it says)', async () => {
    // (this file's checks were loaded hiding scripts/people.mjs: see the top)
    expect(unreadable('.env.local')).toBeTruthy();
    expect(unreadable('frontend/.env')).toBeTruthy();
    expect(unreadable('scripts/people.mjs')).toBeTruthy();
    expect(unreadable('features/shop/copy.ts')).toBeUndefined();
    // a fresh working copy: the hidden file stays (other code may import it), with every address in it replaced, and git
    // is told not to look at it, so it can be neither read for what it held nor committed as changed
    const dir = tempDir('codetown-hide-');
    try {
      write(dir, 'scripts/people.mjs', "export const people = ['someone@example.com'];\n");
      write(dir, 'src/a.ts', 'export const a = 1;\n');
      await commitAll(dir);
      expect((await new RepoChecks().prepare(dir)).ok).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'scripts/people.mjs'), 'utf8')).toBe("export const people = ['hidden@example.invalid'];\n");
      expect((await git(dir, ['status', '--porcelain'])).stdout.trim()).toBe('');
    } finally { rmrf(dir); }
    // with no list, nothing but the environment files is hidden
    delete process.env.OVERWORLD_HIDE;
    vi.resetModules();
    try {
      const plain = await import('../src/codetown/checks.js');
      expect(plain.HIDDEN).toEqual([]);
      expect(plain.unreadable('scripts/people.mjs')).toBeUndefined();
      expect(plain.unreadable('.env')).toBeTruthy();
    } finally {
      process.env.OVERWORLD_HIDE = 'scripts/people.mjs';
      vi.resetModules();
    }
  });
});

// ------------------------------------------------------------------------------------------ the whole service
/** A fake vitest for the made-up repository: runs tests/*.test.mjs and writes vitest's JSON report. */
const FAKE_VITEST = `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
const out = (process.argv.find((a) => a.startsWith('--outputFile=')) ?? '').slice(13);
const only = process.argv.slice(2).filter((a) => !a.startsWith('--') && a !== 'run');
const walk = (d) => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
const files = (only.length ? only.map((f) => path.resolve(f)) : walk(path.resolve('tests'))).filter((f) => f.endsWith('.test.mjs')).sort();
const results = []; let total = 0, failed = 0;
for (const f of files) {
  const cases = [];
  try { const mod = await import(pathToFileURL(f).href + '?t=' + Date.now()); for (const [name, fn] of mod.default) { total++; try { await fn(); cases.push({ fullName: name, status: 'passed', failureMessages: [] }); } catch (e) { failed++; cases.push({ fullName: name, status: 'failed', failureMessages: [String(e && e.message || e)] }); } }
    results.push({ name: f, status: cases.some((c) => c.status === 'failed') ? 'failed' : 'passed', message: '', assertionResults: cases });
  } catch (e) { failed++; total++; results.push({ name: f, status: 'failed', message: String(e && e.message || e), assertionResults: [] }); }
}
if (out) fs.writeFileSync(out, JSON.stringify({ numTotalTests: total, numPassedTests: total - failed, numFailedTests: failed, success: failed === 0, testResults: results }));
process.exit(failed ? 1 : 0);
`;
const eq = "const eq = (a, b) => { if (a !== b) throw new Error('expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); };\n";

describe('code town: one ask, with a prepared change, from the words to the merge', () => {
  const ENV = ['OVERWORLD_TOWN', 'OVERWORLD_REPO', 'OVERWORLD_BRANCH', 'OVERWORLD_RECORD', 'OVERWORLD_MECHANICAL', 'OVERWORLD_SESSION_LEDGER'];
  const prior: Record<string, string | undefined> = {};
  let home: string, repo: string, hand: string, h: Harness, town: CodeTownService, ops: Array<Record<string, unknown>>, clock: NodeJS.Timeout;

  beforeEach(async () => {
    for (const k of ENV) prior[k] = process.env[k];
    home = tempDir('codetown-'); repo = path.join(home, 'product'); hand = path.join(home, 'hand');
    // the product: two modules, a guard script, a CI that runs both the guard and the tests, a docs generator, and a file
    // with people's addresses in it that the profile hides from agents
    write(repo, 'package.json', '{"name":"product","private":true,"scripts":{"test":"vitest run","docs:generate":"node scripts/generate-docs.mjs"}}\n');
    write(repo, 'node_modules/.bin/vitest', FAKE_VITEST); fs.chmodSync(path.join(repo, 'node_modules/.bin/vitest'), 0o755);
    write(repo, '.github/workflows/ci.yml', 'name: CI\njobs:\n  checks:\n    steps:\n      - name: Install dependencies\n        run: pnpm install --frozen-lockfile\n      - name: Guard - no shouting\n        run: node scripts/guard.mjs\n      - name: Tests\n        run: pnpm test\n');
    write(repo, 'scripts/guard.mjs', "import fs from 'node:fs';\nif (/[A-Z]{6,}/.test(fs.readFileSync('src/words/index.mjs', 'utf8'))) { console.error('shouting in the words'); process.exit(1); }\n");
    write(repo, 'scripts/generate-docs.mjs', "import fs from 'node:fs';\nconst uses = fs.readFileSync('src/app/main.mjs', 'utf8').includes('language') ? 'app uses the language' : 'app uses the words';\nfs.writeFileSync('DOCS.md', uses + '\\n');\n");
    write(repo, 'DOCS.md', 'app uses the words\n');
    write(repo, 'scripts/people.mjs', "export const people = ['someone@example.com'];\n");
    write(repo, 'src/words/index.mjs', `export const hello = { en: 'hello' };\nexport function say() { return hello.en; }\n${lines(320, 'words')}`);
    write(repo, 'src/app/main.mjs', `import { say } from '../words/index.mjs';\nexport function greet() { return say(); }\n${lines(320, 'app')}`);
    write(repo, 'tests/words.test.mjs', `import { say } from '../src/words/index.mjs';\n${eq}export default [['says hello', () => eq(say(), 'hello')]];\n`);
    write(repo, 'tests/app.test.mjs', `import { greet } from '../src/app/main.mjs';\n${eq}export default [['greets', () => eq(greet(), 'hello')]];\n`);
    await commitAll(repo, 'the product');
    await git(repo, ['checkout', '-q', '-b', 'overworld-town']);
    // the prepared, hand-written change
    write(hand, 'PLAN.json', JSON.stringify({ summary: 'The app can greet in Spanish.', modules: [
      { module: 'src/words', sign: 'the word in Spanish', does: 'adds the Spanish word and say(language)', needs: [], tests: ['tests/words-es.test.mjs'] },
      { module: 'src/app', sign: 'a greeting in any language', does: 'greet(language) says it in the chosen language', needs: ['src/words'], tests: ['tests/app-es.test.mjs'] }] }));
    write(hand, 'src-words/tests/tests/words-es.test.mjs', `import { say } from '../src/words/index.mjs';\n${eq}export default [['says hola', () => eq(say('es'), 'hola')], ['English is the default', () => eq(say(), 'hello')]];\n`);
    write(hand, 'src-words/change/src/words/index.mjs', `export const hello = { en: 'hello', es: 'hola' };\nexport function say(language = 'en') { return hello[language] ?? hello.en; }\n${lines(320, 'words')}`);
    write(hand, 'src-app/tests/tests/app-es.test.mjs', `import { greet } from '../src/app/main.mjs';\n${eq}export default [['greets in Spanish', () => eq(greet('es'), 'hola')]];\n`);
    write(hand, 'src-app/change/src/app/main.mjs', `import { say } from '../words/index.mjs';\nexport function greet(language) { return say(language); }\n${lines(320, 'app')}`);
    // the town, mapped from the product
    const townDir = path.join(home, 'town'), map = await mapRepository(repo, { repoName: 'product' }), layout = layoutTown(map);
    fs.mkdirSync(townDir, { recursive: true });
    fs.writeFileSync(path.join(townDir, 'map.json'), JSON.stringify(map)); fs.writeFileSync(path.join(townDir, 'layout.json'), JSON.stringify(layout));
    Object.assign(process.env, { OVERWORLD_TOWN: townDir, OVERWORLD_REPO: repo, OVERWORLD_BRANCH: 'overworld-town', OVERWORLD_RECORD: path.join(home, 'run', 'record.jsonl') });
    delete process.env.OVERWORLD_MECHANICAL; delete process.env.OVERWORLD_SESSION_LEDGER;
    // the backend has no agents (hand mode): the test's own worker does the work
    h = makeForeman(path.join(home, 'backend'), ['--backend', 'none']);
    town = h.fm.codetown as CodeTownService;
    expect(town.mode).toBe('hand');
    town.worker = new HandWorker(h.fm, hand);
    ops = [];
    // a fake game: it carries nothing out, answers every build, and keeps the clock going
    h.fm.subscribe((m) => { if (m.type === 'town.do') for (const op of m.ops as Array<Record<string, unknown>>) { ops.push(op); if (typeof op.id === 'string') setImmediate(() => town.events([{ kind: 'done', id: op.id, placed: Array.isArray(op.blocks) ? op.blocks.length : 0, bad: [] }])); } });
    await town.start();
    clock = setInterval(() => town.events([{ kind: 'clock', game: Date.now(), time: 6000 }]), 200);
    town.events([{ kind: 'hello', world: 'Test' }, { kind: 'clock', game: 1, time: 6000 }]);
  });
  afterEach(async () => {
    clearInterval(clock);
    await h.fm.close();
    rmrf(home);
    for (const k of ENV) { if (prior[k] === undefined) delete process.env[k]; else process.env[k] = prior[k]; }
  });

  it('makes a new module on a lot of its own, and builds it whole when its change is merged', async () => {
    write(hand, 'PLAN.json', JSON.stringify({ summary: 'The app keeps a history of greetings.', modules: [
      { module: 'src/history', new: true, sign: 'a history of greetings', does: 'history(names) lists the greetings', needs: [], tests: ['tests/history.test.mjs'] }] }));
    write(hand, 'src-history/tests/tests/history.test.mjs', `import { history } from '../src/history/index.mjs';\n${eq}export default [['lists the greetings', () => eq(history(['hello', 'hola']), 'hello hola')]];\n`);
    write(hand, 'src-history/change/src/history/index.mjs', `export function history(names) { return names.join(' '); }\n${lines(400, 'history')}`);
    const view = (): any => town.view(), gate = town.layout.gates[0]!, words = town.layout.plots.find((p) => p.module === 'src/words')!;
    await until(() => ops.some((o) => o.op === 'label' && o.text === '§lwords'));
    await until(() => town.record().lamps['tests/words.test.mjs'] === 'lit');
    // at rest, a building's screen lists its files with their lines
    await until(() => ops.some((o) => o.op === 'label' && o.part === `b-${words.place}` && o.label === 'screen' && String(o.text).includes('index.mjs')));
    await town.ask('keep a history of the greetings', gate.place);
    // the plan names a module that does not exist: a lot is kept for it in the quarter of the modules beside it
    await until(() => town.layout.plots.some((p) => p.module === 'src/history'), 30_000);
    const lot = town.layout.plots.find((p) => p.module === 'src/history')!;
    expect(lot.quarter).toBe(words.quarter);
    for (const o of town.layout.plots) if (o !== lot && o.side === lot.side) expect(o.box[3] < lot.box[0] || lot.box[3] < o.box[0]).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(process.env.OVERWORLD_TOWN!, 'layout-live.json'), 'utf8')).plots.some((p: any) => p.module === 'src/history')).toBe(true);
    expect(view().places.some((p: any) => p.id === lot.place)).toBe(true);
    await until(() => view().ready === true, 90_000);
    town.events([{ kind: 'use', part: gate.place, key: 'approve', at: gate.lever, player: { name: 'Sam' } }]);
    await until(() => town.record().asks[0]!.status === 'done', 60_000);
    // merged: built whole at the step its lines make, with the lamp of its test, and a module of the map
    expect(town.record().built!['src/history']).toMatchObject({ stage: 'built', step: stepFor(401) });
    const built = town.layout.plots.find((p) => p.module === 'src/history')!;
    expect(built.step).toBe(stepFor(401));
    expect(town.map.modules.find((m) => m.id === 'src/history')?.tests).toEqual(['tests/history.test.mjs']);
    await until(() => ops.some((o) => o.op === 'blocks' && o.part === `b-${built.place}` && (o.blocks as string[][]).some((b) => String(b[3]).startsWith('spruce_door'))));
    await until(() => fs.readFileSync(process.env.OVERWORLD_RECORD!, 'utf8').includes('"kind":"ask-end"'));
    const record = fs.readFileSync(process.env.OVERWORLD_RECORD!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(record.find((r) => r.kind === 'lot')).toMatchObject({ module: 'src/history' });
    expect(record.find((r) => r.kind === 'remap')?.grown).toEqual(expect.arrayContaining([expect.objectContaining({ module: 'src/history', from: -1, to: stepFor(401) })]));
    // no generator was named for this town: there is no mechanical commit
    expect(record.some((r) => r.kind === 'mechanical')).toBe(false);
  }, 180_000);

  it('reads the CI from the workflow, leaving the install out', () => {
    expect(ciSteps(repo).map((s) => s.run)).toEqual(['node scripts/guard.mjs', 'pnpm test']);
  });

  it('plans, writes tests that fail, changes each module inside its own folder, checks, waits for approval, merges', async () => {
    const view = (): any => town.view(), rows = (): Record<string, [string, string]> => Object.fromEntries(view().list.map((r: any) => [r.part, [r.state, r.text]]));
    const gate = town.layout.gates[0]!, words = town.layout.plots.find((p) => p.module === 'src/words')!, app = town.layout.plots.find((p) => p.module === 'src/app')!;
    // the town was drawn when the game arrived: every building and gate is a part of the town's own
    await until(() => ops.some((o) => o.op === 'label' && o.text === '§lwords'));
    expect(ops.filter((o) => o.op === 'part.begin').map((o) => o.part).sort()).toEqual([`b-${app.place}`, `b-${words.place}`, gate.place].sort());
    // the lamps of the branch as it stands: one for each test file that covers a building, lit once the tests have run
    await until(() => town.record().lamps['tests/words.test.mjs'] === 'lit');
    await until(() => ops.some((o) => o.op === 'blocks' && o.part === `b-${words.place}` && (o.blocks as string[][]).some((b) => b[3] === 'redstone_lamp[lit=true]')));
    const head = (await git(repo, ['rev-parse', 'overworld-town'])).stdout.trim(), main = (await git(repo, ['rev-parse', 'main'])).stdout.trim();

    // the profile names the repository's own docs generator: it runs after each module is combined with the rest
    process.env.OVERWORLD_MECHANICAL = 'docs:generate';
    await expect(town.ask('', gate.place)).rejects.toThrow(/Say what you want/);
    expect(await town.ask('let people choose the language. add Spanish.', gate.place)).toMatchObject({ kind: 'ask' });
    await expect(town.ask('and French', gate.place)).rejects.toThrow(/one change at a time/);

    // the lead plans; the plan names both modules and the town marks them
    await until(() => !!view().plan, 30_000);
    expect(view().asks.filter((a: any) => a.kind === 'module').map((a: any) => a.place).sort()).toEqual([app.place, words.place].sort());
    // the words' tests are written first and fail, and only they: its lamps show one red
    await until(() => (town.record().asks[0]!.modules['src/words']?.lamps['tests/words-es.test.mjs'] ?? '') === 'red', 30_000);
    await until(() => ops.some((o) => o.op === 'blocks' && o.part === `b-${words.place}` && (o.blocks as string[][]).some((b) => b[3] === 'red_stained_glass')), 30_000);
    await until(() => ops.some((o) => o.op === 'blocks' && o.part === `b-${words.place}` && (o.blocks as string[][]).some((b) => b[3] === 'scaffolding')), 30_000);
    // src/app needs src/words: it is not begun until the words are checked with the rest
    expect(town.record().asks[0]!.modules['src/app']!.status).toBe('planned');

    await until(() => view().ready === true, 90_000);
    const ask = town.record().asks[0]!;
    expect(ask.status).toBe('ready');
    expect(Object.values(ask.modules).map((w) => w.status)).toEqual(['staged', 'staged']);
    expect(rows()['@ask']![1]).toContain('waiting for approval');
    // nothing has reached the town branch or main yet; the product's checkout is as it was
    expect((await git(repo, ['rev-parse', 'overworld-town'])).stdout.trim()).toBe(head);
    expect(fs.readFileSync(path.join(repo, 'src/words/index.mjs'), 'utf8')).not.toContain('hola');
    // the test writer and the change writer of a module are two different agents
    for (const w of Object.values(ask.modules)) expect(w.testsBy).not.toBe(w.changeBy);

    // the lever on the gate: the person's one action
    town.events([{ kind: 'use', part: gate.place, key: 'approve', at: gate.lever, player: { name: 'Sam' } }]);
    await until(() => town.record().asks[0]!.status === 'done', 60_000);
    expect(ask.merge!.added).toBeGreaterThan(0);
    expect(ask.merge!.tests).toBe(5);
    // the town branch has it, by a merge commit that keeps the agents' commits; main is as it was; nothing was pushed (there is no remote)
    expect((await git(repo, ['rev-parse', 'main'])).stdout.trim()).toBe(main);
    expect(fs.readFileSync(path.join(repo, 'src/words/index.mjs'), 'utf8')).toContain('hola');
    expect(fs.readFileSync(path.join(repo, 'src/app/main.mjs'), 'utf8')).toContain('greet(language)');
    const log = (await git(repo, ['log', '--format=%an|%s', 'overworld-town'])).stdout;
    // each commit is made under the name of the agent who wrote it
    const cast = h.fm.agents().map((a) => a.name).join('|');
    expect(log).toMatch(new RegExp(`^(${cast})\\|Tests for src/words`, 'm'));
    expect(log).toMatch(new RegExp(`^(${cast})\\|src/app:`, 'm'));
    // the repository's own generator ran as a labelled mechanical commit once the import changed what it writes
    expect(log).toMatch(/The Town\|Mechanical: pnpm docs:generate after src\/app/);
    expect(fs.readFileSync(path.join(repo, 'DOCS.md'), 'utf8')).toBe('app uses the language\n');
    // the hidden file was never committed as changed, and the product's own copy still holds what it held
    expect(fs.readFileSync(path.join(repo, 'scripts/people.mjs'), 'utf8')).toContain('someone@example.com');
    expect((await git(repo, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim()).toBe('');
    // the buildings: banners where the change was merged, scaffolding gone, every lamp lit
    await until(() => ops.some((o) => o.op === 'blocks' && o.part === `b-${app.place}` && (o.blocks as string[][]).some((b) => String(b[3]).startsWith('lime_banner'))));
    expect(rows()['@ask']).toEqual(['live', expect.stringContaining('5 tests pass')]);
    expect(rows()['words']![0]).toBe('live');          // (a board never carries a wrapper folder's name: src/words reads "words")
    expect(town.record().lamps['tests/app-es.test.mjs']).toBe('lit');
    // the record: every row has its time as "ms", and none carries a field named "at"
    await until(() => fs.readFileSync(process.env.OVERWORLD_RECORD!, 'utf8').includes('"kind":"ask-end"'));
    const record = fs.readFileSync(process.env.OVERWORLD_RECORD!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    if (process.env.CODETOWN_TEST_TRACE) console.log(record.filter((r) => r.kind !== 'list').map((r) => `${String(r.ms - record[0].ms).padStart(6)} ${r.kind} ${r.module ?? ''} ${r.role ?? ''} ${r.script ?? ''}`).join('\n'));
    for (const r of record) { expect(typeof r.ms).toBe('number'); expect('at' in r).toBe(false); }
    expect(record.map((r) => r.kind)).toEqual(expect.arrayContaining(['start', 'baseline', 'ask', 'plan', 'job', 'tests-red', 'change-green', 'staged', 'mechanical', 'ready', 'approved', 'merged', 'remap', 'ask-end', 'list']));
    // after the merge, the final check and the map read again, the ask is done
    expect(record.filter((r) => ['merged', 'remap', 'ask-end'].includes(r.kind)).map((r) => r.kind)).toEqual(['remap', 'merged', 'ask-end']);
    // the working copies are put away
    expect(fs.readdirSync(path.join(h.cfg.dataDir, 'worktrees', 'product')).length).toBe(0);
  }, 180_000);
});
