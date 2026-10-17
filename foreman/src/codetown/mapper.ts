// The mapper: reads any repository and makes the map a town is built from. One building for each real module;
// nothing here is laid out or named by hand, and nothing is special to one repository.
//
// THE RULES, in general form (the same for every repository):
//
//  1. What counts. Tracked source files (and new ones not ignored). Tests, scripts, docs, assets, generated files and
//     configuration are not buildings; test files are kept apart and light the lamps (rule 7).
//  2. Districts. The repository's top-level source folders are districts: each district's sub-folders are its
//     modules. A top-level folder with no sub-folders is one module itself. A wrapper (a folder that holds nothing
//     but one sub-folder, such as `src`) is looked through.
//  3. Splitting. A module over about 6,000 lines is split into its sub-folders, again and again.
//  4. Sharing. Wherever a folder is split, its own loose files, its sub-folders under about 300 lines, and its
//     sub-folders that are one file each and import nothing from one another (pages) share ONE building, named for
//     the folder.
//  5. Size. A building's footprint and height step up with its lines of code (STEPS below).
//  6. Paths. A path joins two buildings when one imports the other three times or more.
//  7. Lamps. A test file lights one lamp on every building it imports from.
//  8. Quarters. Buildings that are pieces of one folder stand together as a quarter with that folder's name over it.
//     A quarter of fewer than three buildings joins the quarter of the folder above it; a lone building at the top
//     level joins the quarter it is most tied to by imports. Districts joined by imports are one town; a district
//     that imports nothing of the town and is imported by none of it stands apart (across the water).
//  9. Order. Along the street, quarters and the buildings in them are ordered by what depends on what: what is
//     depended on comes first, what depends on it later, so the work on a change tends to run one way.
// 10. Names. A building's board carries the last two parts of its folder's path.
import fs from 'node:fs';
import path from 'node:path';
import { git, gitOut } from '../util/git.js';

export const SPLIT_OVER = 6000;
export const SHARE_UNDER = 300;
export const PATH_AT = 3;
/** Footprint (blocks wide along the street, blocks deep) and height of the walls, by lines of code: a building is on the first step its lines fit under. */
export const STEPS: Array<{ under: number; wide: number; deep: number; high: number }> = [
  { under: 300, wide: 5, deep: 5, high: 4 },
  { under: 1000, wide: 7, deep: 7, high: 5 },
  { under: 2000, wide: 9, deep: 7, high: 6 },
  { under: 3500, wide: 11, deep: 9, high: 7 },
  { under: 6000, wide: 13, deep: 9, high: 9 },
  { under: 12000, wide: 15, deep: 11, high: 11 },
  { under: Infinity, wide: 17, deep: 11, high: 13 },
];
const CODE = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'rb', 'php', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'vue', 'svelte']);
const TEST_DIRS = new Set(['tests', 'test', '__tests__', 'e2e', 'spec', 'specs', '__mocks__', 'mocks', 'fixtures']);
const NOT_SOURCE_DIRS = new Set(['scripts', 'docs', 'doc', 'public', 'assets', 'static', 'node_modules', 'dist', 'build', 'out', 'vendor', 'cache', 'coverage', 'migrations', 'generated', '__generated__']);
const TEST_FILE = /(\.(test|spec)\.[a-z]+$)|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/;
const NOT_SOURCE_FILE = /\.d\.ts$|\.config\.[a-z]+$|\.stories\.[a-z]+$|\.min\.js$|(^|\/)(setup|conftest)\.py$/;

export interface MapModule {
  /** The folder's path in the repository ("features/shop/catalog"); "." is the repository's own loose files. */
  id: string;
  /** What the board says: the last two parts of the path. */
  name: string;
  /** Folders that are wholly this module's. */
  dirs: string[];
  /** For a shared building: the folder whose loose files are this module's too. */
  looseOf?: string;
  files: string[];
  lines: number;
  quarter: string;
  /** Which step of STEPS it stands on, and that step's size. */
  step: number; wide: number; deep: number; high: number;
  /** Test files that import from it. */
  tests: string[];
  /** How deep it stands in what depends on what: 0 depends on no other building. */
  depth: number;
}
export interface MapQuarter { id: string; name: string; modules: string[]; apart: boolean; depth: number }
export interface TownMap {
  version: 1;
  repo: string;
  commit: string;
  branch: string;
  rules: { splitOver: number; shareUnder: number; pathAt: number; steps: typeof STEPS };
  totals: { files: number; lines: number; modules: number; quarters: number; tests: number; paths: number };
  /** In street order. */
  quarters: MapQuarter[];
  /** In street order. */
  modules: MapModule[];
  /** Every import between two buildings: how many import statements. */
  edges: Array<{ from: string; to: string; count: number }>;
  /** The edges a path is laid for (count >= pathAt), as unordered pairs with the larger direction's count. */
  paths: Array<{ a: string; b: string; count: number }>;
  /** Each test file and the buildings it lights a lamp on. */
  tests: Record<string, string[]>;
}

interface Dir { path: string; files: string[]; dirs: Map<string, Dir>; lines: number; count: number }

const posix = (p: string): string => p.split(path.sep).join('/');
const ext = (f: string): string => { const i = f.lastIndexOf('.'); return i < 0 ? '' : f.slice(i + 1).toLowerCase(); };
function countLines(file: string): number {
  try { const t = fs.readFileSync(file, 'utf8'); return t.length ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0; } catch { return 0; }
}
/** Folders that only wrap the source (`src`) are never part of a name. */
const WRAPPERS = new Set(['src', 'source']);
export function boardName(id: string, repoName: string): string {
  if (id === '.') return repoName;
  const parts = id.split('/').filter((p) => !WRAPPERS.has(p));
  return (parts.length ? parts : id.split('/')).slice(-2).join('/');
}
export function stepFor(lines: number): number { const i = STEPS.findIndex((s) => lines < s.under); return i < 0 ? STEPS.length - 1 : i; }

/** Files of the working tree that git tracks or would track (not ignored). */
async function listFiles(repo: string): Promise<string[]> {
  const out = (await git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).stdout;
  return [...new Set(out.split('\0').filter(Boolean))].filter((f) => fs.existsSync(path.join(repo, f))).sort();
}

export function classify(file: string): 'source' | 'test' | 'other' {
  if (!CODE.has(ext(file))) return 'other';
  const parts = file.split('/');
  const dirs = parts.slice(0, -1);
  if (dirs.some((d) => d.startsWith('.') || NOT_SOURCE_DIRS.has(d))) return 'other';
  if (dirs.some((d) => TEST_DIRS.has(d)) || TEST_FILE.test(file)) return 'test';
  if (NOT_SOURCE_FILE.test(file)) return 'other';
  return 'source';
}

// ------------------------------------------------------------------ imports
const IMPORT_JS = /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[\w*${}\s,]+\s+from\s+)?["']([^"'\n]+)["']|(?:require|import)\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
const IMPORT_PY = /^[ \t]*(?:from\s+([.\w]+)\s+import\s+([\w*, \t()]+)|import\s+([\w., \t]+))/gm;
const JS_EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs'];

interface Resolver { all: Set<string>; aliases: Array<{ prefix: string; targets: string[] }>; packages: Map<string, string> }

/** JSON with comments and trailing commas (a tsconfig), read without mistaking a "/*" inside a string for a comment. */
function readJsonLoose(file: string): Record<string, unknown> | undefined {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string, n = text[i + 1];
    if (c === '"') { let j = i + 1; while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1; out += text.slice(i, j + 1); i = j; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && n === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 1; continue; }
    out += c;
  }
  try { return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>; } catch { return undefined; }
}
function makeResolver(repo: string, files: string[]): Resolver {
  const all = new Set(files);
  const aliases: Resolver['aliases'] = [];
  const packages = new Map<string, string>();
  for (const f of files) {
    const base = path.posix.basename(f), dir = path.posix.dirname(f) === '.' ? '' : path.posix.dirname(f);
    if (base === 'package.json') {
      const name = readJsonLoose(path.join(repo, f))?.name;
      if (typeof name === 'string' && dir) packages.set(name, dir);
    }
    if (/^tsconfig(\.[\w-]+)?\.json$/.test(base) || base === 'jsconfig.json') {
      const co = (readJsonLoose(path.join(repo, f))?.compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> };
      const baseDir = path.posix.join(dir, co.baseUrl ?? '.');
      for (const [key, targets] of Object.entries(co.paths ?? {})) {
        if (!key.endsWith('*')) continue;
        aliases.push({ prefix: key.slice(0, -1), targets: targets.filter((t) => t.endsWith('*')).map((t) => path.posix.normalize(path.posix.join(baseDir, t.slice(0, -1)))) });
      }
    }
  }
  aliases.sort((a, b) => b.prefix.length - a.prefix.length);
  return { all, aliases, packages };
}
function tryJs(r: Resolver, base: string): string | undefined {
  const clean = path.posix.normalize(base).replace(/^\.\//, '');
  if (clean.startsWith('..')) return undefined;
  for (const e of JS_EXT) { const c = clean + e; if (r.all.has(c)) return c; }
  // "./x.js" written for a file that is x.ts
  const m = /^(.*)\.(js|jsx|mjs)$/.exec(clean);
  if (m) for (const e of ['.ts', '.tsx']) { const c = (m[1] as string) + e; if (r.all.has(c)) return c; }
  return undefined;
}
function resolveJs(r: Resolver, from: string, spec: string): string | undefined {
  if (spec.startsWith('.')) return tryJs(r, path.posix.join(path.posix.dirname(from), spec));
  for (const a of r.aliases) if (spec.startsWith(a.prefix)) for (const t of a.targets) { const hit = tryJs(r, path.posix.join(t, spec.slice(a.prefix.length))); if (hit) return hit; }
  for (const [name, dir] of r.packages) {
    if (spec !== name && !spec.startsWith(`${name}/`)) continue;
    const rest = spec.slice(name.length).replace(/^\//, '');
    for (const c of rest ? [path.posix.join(dir, rest), path.posix.join(dir, 'src', rest)] : [path.posix.join(dir, 'src', 'index'), path.posix.join(dir, 'index'), path.posix.join(dir, 'src', 'main')]) { const hit = tryJs(r, c); if (hit) return hit; }
  }
  return undefined;
}
function resolvePy(r: Resolver, from: string, mod: string, names: string[]): string[] {
  const here = path.posix.dirname(from) === '.' ? '' : path.posix.dirname(from);
  const dots = /^\.+/.exec(mod)?.[0].length ?? 0;
  const rest = mod.slice(dots).split('.').filter(Boolean);
  const bases: string[] = [];
  if (dots) { let d = here; for (let i = 1; i < dots; i++) d = path.posix.dirname(d) === '.' ? '' : path.posix.dirname(d); bases.push(d); }
  else { let d = here; for (;;) { bases.push(d); if (!d) break; d = path.posix.dirname(d) === '.' ? '' : path.posix.dirname(d); } }
  const out: string[] = [];
  for (const b of bases) {
    const p = path.posix.join(b, ...rest);
    for (const c of [`${p}.py`, path.posix.join(p, '__init__.py')]) if (rest.length && r.all.has(c)) out.push(c);
    if (r.all.has(path.posix.join(p, '__init__.py')) || !rest.length) for (const n of names) { const c = path.posix.join(p, `${n}.py`); if (r.all.has(c)) out.push(c); }
    if (out.length) break;
  }
  return out;
}
/** The repository files a source file imports, one entry for each import statement that names one. */
export function importsOf(repo: string, r: Resolver, file: string): string[] {
  let text: string;
  try { text = fs.readFileSync(path.join(repo, file), 'utf8'); } catch { return []; }
  const out: string[] = [];
  if (ext(file) === 'py') {
    for (const m of text.matchAll(IMPORT_PY)) {
      if (m[1]) out.push(...resolvePy(r, file, m[1], (m[2] ?? '').replace(/[()]/g, '').split(',').map((s) => s.trim().split(/\s+/)[0] ?? '').filter(Boolean)).slice(0, 1));
      else for (const one of (m[3] ?? '').split(',')) out.push(...resolvePy(r, file, (one.trim().split(/\s+/)[0] ?? ''), []).slice(0, 1));
    }
    return out;
  }
  for (const m of text.matchAll(IMPORT_JS)) { const hit = resolveJs(r, file, (m[1] ?? m[2]) as string); if (hit) out.push(hit); }
  return out;
}

// ------------------------------------------------------------------ the tree and its modules
function buildTree(files: string[], linesOf: Map<string, number>): Dir {
  const root: Dir = { path: '', files: [], dirs: new Map(), lines: 0, count: 0 };
  for (const f of files) {
    const parts = f.split('/'); let d = root; const n = linesOf.get(f) ?? 0;
    d.lines += n; d.count++;
    for (const p of parts.slice(0, -1)) {
      let k = d.dirs.get(p);
      if (!k) { k = { path: d.path ? `${d.path}/${p}` : p, files: [], dirs: new Map(), lines: 0, count: 0 }; d.dirs.set(p, k); }
      d = k; d.lines += n; d.count++;
    }
    d.files.push(f);
  }
  return root;
}
/** A wrapper (no loose files, exactly one sub-folder) is looked through. */
function through(d: Dir): Dir { let x = d; while (!x.files.length && x.dirs.size === 1) x = [...x.dirs.values()][0] as Dir; return x; }
/** The path a looked-through folder is known by: the innermost folder, without a trailing wrapper name such as `src`. */
function knownAs(top: Dir, inner: Dir): string { const parts = inner.path.split('/'); while (parts.length > top.path.split('/').length && WRAPPERS.has(parts[parts.length - 1] as string)) parts.pop(); return parts.join('/'); }
function filesUnder(d: Dir, out: string[] = []): string[] { out.push(...d.files); for (const k of d.dirs.values()) filesUnder(k, out); return out; }

interface Draft { id: string; dirs: string[]; looseOf?: string; files: string[]; parent: string }

/**
 * Split one folder into buildings: each sub-folder is one (and is split again when it is over the limit); the folder's
 * loose files, its small sub-folders and its page sub-folders share one building named for the folder.
 */
function splitFolder(d: Dir, linked: (a: string[], b: string[]) => boolean, out: Draft[], as?: string): void {
  const kids = [...d.dirs.values()].sort((a, b) => a.path.localeCompare(b.path));
  // (`as`: the path this folder is known by when it was reached through a wrapper; its loose files are still in d.path)
  const shared: Draft = { id: as ?? (d.path || '.'), dirs: [], looseOf: d.path || '.', files: [...d.files], parent: as ?? (d.path || '.') };
  const own: Dir[] = [];
  for (const k of kids) {
    const small = k.lines < SHARE_UNDER;
    if (small) { shared.dirs.push(k.path); shared.files.push(...filesUnder(k)); } else own.push(k);
  }
  // pages: sub-folders that are one file each and import nothing from one another
  const single = own.filter((k) => k.count === 1);
  const pages = single.filter((k) => !own.some((o) => o !== k && (linked(filesUnder(k), filesUnder(o)) || linked(filesUnder(o), filesUnder(k)))));
  if (pages.length >= 2) for (const k of pages) { own.splice(own.indexOf(k), 1); shared.dirs.push(k.path); shared.files.push(...filesUnder(k)); }
  for (const k of own) {
    const inner = through(k);
    if (k.lines > SPLIT_OVER && inner.dirs.size > 0) { splitFolder(inner, linked, out, knownAs(k, inner)); continue; }
    out.push({ id: knownAs(k, inner), dirs: [k.path], files: filesUnder(k), parent: as ?? (d.path || '.') });
  }
  if (shared.files.length) out.push(shared);
}

function tarjan(nodes: string[], next: (n: string) => string[]): Map<string, number> {
  let index = 0; const idx = new Map<string, number>(), low = new Map<string, number>(), on = new Set<string>(), stack: string[] = [], comp = new Map<string, number>(); let comps = 0;
  const visit = (v: string): void => {
    idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
    for (const w of next(v)) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v) as number, low.get(w) as number)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v) as number, idx.get(w) as number));
    }
    if (low.get(v) === idx.get(v)) { for (;;) { const w = stack.pop() as string; on.delete(w); comp.set(w, comps); if (w === v) break; } comps++; }
  };
  for (const n of nodes) if (!idx.has(n)) visit(n);
  return comp;
}

export interface MapOptions { /** The name on the board of the repository's own loose files (default: the folder's name). */ repoName?: string }

/** Read a repository's working tree and make its map. */
export async function mapRepository(repo: string, opts: MapOptions = {}): Promise<TownMap> {
  const root = fs.realpathSync(repo), repoName = opts.repoName ?? path.basename(root);
  const files = await listFiles(root);
  const source = files.filter((f) => classify(f) === 'source'), tests = files.filter((f) => classify(f) === 'test');
  const linesOf = new Map<string, number>();
  for (const f of source) linesOf.set(f, countLines(path.join(root, f)));
  const resolver = makeResolver(root, files);
  const imports = new Map<string, string[]>();
  for (const f of [...source, ...tests]) imports.set(f, importsOf(root, resolver, f));

  const tree = buildTree(source, linesOf);
  const linked = (a: string[], b: string[]): boolean => { const set = new Set(b); return a.some((f) => (imports.get(f) ?? []).some((t) => set.has(t))); };
  // rule 2: districts; rule 3 and 4: splitting and sharing
  const drafts: Draft[] = [];
  const rootShared: Draft = { id: '.', dirs: [], looseOf: '.', files: [...tree.files], parent: '.' };
  for (const top of [...tree.dirs.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const inner = through(top);
    if (top.lines < SHARE_UNDER) { rootShared.dirs.push(top.path); rootShared.files.push(...filesUnder(top)); continue; }
    if (!inner.dirs.size) { drafts.push({ id: knownAs(top, inner), dirs: [top.path], files: filesUnder(top), parent: '.' }); continue; }
    splitFolder(inner, linked, drafts, knownAs(top, inner));
  }
  if (rootShared.files.length) drafts.push(rootShared);

  const moduleOfFile = new Map<string, string>();
  for (const d of drafts) for (const f of d.files) moduleOfFile.set(f, d.id);
  // edges: import statements from one building's files to another's
  const edgeCount = new Map<string, number>();
  for (const d of drafts) for (const f of d.files) for (const t of imports.get(f) ?? []) {
    const to = moduleOfFile.get(t);
    if (to && to !== d.id) edgeCount.set(`${d.id}\0${to}`, (edgeCount.get(`${d.id}\0${to}`) ?? 0) + 1);
  }
  const edges = [...edgeCount].map(([k, count]) => { const [from, to] = k.split('\0') as [string, string]; return { from, to, count }; }).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  // lamps: a test file lights a lamp on every building it imports from
  const testMap: Record<string, string[]> = {};
  for (const t of tests) {
    const hit = [...new Set((imports.get(t) ?? []).map((f) => moduleOfFile.get(f)).filter((m): m is string => !!m))].sort();
    if (hit.length) testMap[t] = hit;
  }

  // rule 9: depth in what depends on what (buildings that import each other in a ring stand at one depth)
  const ids = drafts.map((d) => d.id);
  const deps = new Map<string, string[]>(ids.map((i) => [i, []]));
  for (const e of edges) (deps.get(e.from) as string[]).push(e.to);
  const comp = tarjan(ids, (n) => deps.get(n) ?? []);
  const compDepth = new Map<number, number>();
  const depthOf = (c: number, seen = new Set<number>()): number => {
    const known = compDepth.get(c); if (known !== undefined) return known;
    if (seen.has(c)) return 0; seen.add(c);
    let dmax = 0;
    for (const i of ids) if (comp.get(i) === c) for (const t of deps.get(i) ?? []) { const tc = comp.get(t) as number; if (tc !== c) dmax = Math.max(dmax, 1 + depthOf(tc, seen)); }
    compDepth.set(c, dmax); return dmax;
  };
  const depth = new Map<string, number>(ids.map((i) => [i, depthOf(comp.get(i) as number)]));

  // rule 8: quarters
  const quarterOf = new Map<string, string>(drafts.map((d) => [d.id, d.parent]));
  const tie = (a: string, b: string): number => (edgeCount.get(`${a}\0${b}`) ?? 0) + (edgeCount.get(`${b}\0${a}`) ?? 0);
  const linesOfModule = new Map(drafts.map((d) => [d.id, d.files.reduce((n, f) => n + (linesOf.get(f) ?? 0), 0)]));
  const members = (q: string): string[] => ids.filter((i) => quarterOf.get(i) === q);
  const topOf = (id: string): string => (id === '.' ? '.' : (id.split('/')[0] as string));
  // Districts joined by imports, however far, are one town: the largest such group (by lines) is the town, and a
  // district outside it (it imports nothing of the town and nothing of the town imports it) stands apart.
  const tops = [...new Set(ids.map(topOf))];
  const group = new Map<string, string>(tops.map((t) => [t, t]));
  const find = (t: string): string => { let x = t; while (group.get(x) !== x) x = group.get(x) as string; return x; };
  for (const e of edges) { const x = find(topOf(e.from)), y = find(topOf(e.to)); if (x !== y) group.set(x, y); }
  const weight = new Map<string, number>();
  for (const i of ids) weight.set(find(topOf(i)), (weight.get(find(topOf(i))) ?? 0) + (linesOfModule.get(i) ?? 0));
  const town = [...weight].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0];
  const apart = new Set<string>(tops.filter((t) => find(t) !== town));
  // the repository's own top level is not a folder anyone shares: each building there is looked at by itself
  for (const m of members('.')) quarterOf.set(m, `.:${m}`);
  for (let pass = 0; pass < 8; pass++) {
    const quarters = [...new Set(quarterOf.values())];
    const small = quarters.filter((q) => members(q).length < 3 && !members(q).every((m) => apart.has(topOf(m))));
    if (!small.length || quarters.length === 1) break;
    let moved = false;
    for (const q of small.sort((x, y) => y.length - x.length)) {
      const mine = members(q); if (!mine.length) continue;
      const score = new Map<string, number>();
      for (const o of ids) { const oq = quarterOf.get(o) as string; if (oq === q || apart.has(topOf(o))) continue; const sc = mine.reduce((n, m) => n + tie(m, o), 0); if (sc) score.set(oq, (score.get(oq) ?? 0) + sc); }
      // pieces of a split folder go back to the quarter of the folder above them; a lone building at the top level
      // has no such folder and joins the quarter it is most tied to by imports (a real quarter before another small one)
      const up = q.startsWith('.:') ? '' : q.includes('/') ? q.split('/').slice(0, -1).join('/') : '';
      const rank = [...score].sort((x, y) => Number(members(y[0]).length >= 3) - Number(members(x[0]).length >= 3) || y[1] - x[1] || x[0].localeCompare(y[0]));
      const best = up && up !== q && members(up).length ? up : rank[0]?.[0];
      if (!best) continue;
      for (const m of mine) quarterOf.set(m, best);
      moved = true;
    }
    if (!moved) break;
  }
  // what is left alone at the top level keeps the repository's own name over it
  for (const [m, q] of quarterOf) if (q.startsWith('.:')) quarterOf.set(m, apart.has(topOf(m)) ? m : '.');

  const modules: MapModule[] = drafts.map((d) => {
    const lines = d.files.reduce((n, f) => n + (linesOf.get(f) ?? 0), 0), step = stepFor(lines), s = STEPS[step] as (typeof STEPS)[number];
    return { id: d.id, name: boardName(d.id, repoName), dirs: d.dirs.sort(), ...(d.looseOf ? { looseOf: d.looseOf } : {}), files: d.files.sort(), lines, quarter: quarterOf.get(d.id) as string,
      step, wide: s.wide, deep: s.deep, high: s.high, tests: Object.keys(testMap).filter((t) => (testMap[t] as string[]).includes(d.id)).sort(), depth: depth.get(d.id) ?? 0 };
  });
  const quarterIds = [...new Set(modules.map((m) => m.quarter))];
  const quarters: MapQuarter[] = quarterIds.map((q) => {
    const mine = modules.filter((m) => m.quarter === q);
    return { id: q, name: q === '.' ? repoName : boardName(q, repoName), modules: [], apart: mine.every((m) => apart.has(topOf(m.id))), depth: mine.reduce((n, m) => n + m.depth * m.lines, 0) / Math.max(1, mine.reduce((n, m) => n + m.lines, 0)) };
  });
  quarters.sort((a, b) => Number(a.apart) - Number(b.apart) || a.depth - b.depth || a.id.localeCompare(b.id));
  for (const q of quarters) q.modules = modules.filter((m) => m.quarter === q.id).sort((a, b) => a.depth - b.depth || b.lines - a.lines || a.id.localeCompare(b.id)).map((m) => m.id);
  const street = quarters.flatMap((q) => q.modules);
  modules.sort((a, b) => street.indexOf(a.id) - street.indexOf(b.id));

  const pairs = new Map<string, { a: string; b: string; count: number }>();
  for (const e of edges) {
    if (e.count < PATH_AT) continue;
    const [a, b] = [e.from, e.to].sort() as [string, string], k = `${a}\0${b}`, was = pairs.get(k);
    if (!was || e.count > was.count) pairs.set(k, { a, b, count: e.count });
  }
  const branch = (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true })).stdout.trim();
  const commit = await gitOut(root, ['rev-parse', 'HEAD']).catch(() => '');
  return {
    version: 1, repo: repoName, commit, branch,
    rules: { splitOver: SPLIT_OVER, shareUnder: SHARE_UNDER, pathAt: PATH_AT, steps: STEPS },
    totals: { files: source.length, lines: modules.reduce((n, m) => n + m.lines, 0), modules: modules.length, quarters: quarters.length, tests: Object.keys(testMap).length, paths: pairs.size },
    quarters, modules, edges, paths: [...pairs.values()].sort((x, y) => y.count - x.count || x.a.localeCompare(y.a)), tests: testMap,
  };
}

/** The building a path of the repository belongs to (a source file, or a file that would be one), or undefined. */
export function moduleOfPath(map: TownMap, file: string): MapModule | undefined {
  const f = posix(file);
  let best: MapModule | undefined, bestLen = -1;
  for (const m of map.modules) {
    for (const d of m.dirs) if ((f === d || f.startsWith(`${d}/`)) && d.length > bestLen) { best = m; bestLen = d.length; }
    if (m.looseOf !== undefined) {
      const dir = path.posix.dirname(f) === '.' ? '.' : path.posix.dirname(f);
      if (dir === m.looseOf && m.looseOf.length > bestLen) { best = m; bestLen = m.looseOf === '.' ? 0 : m.looseOf.length; }
    }
  }
  return best;
}

/** The map in a few lines of plain words (for a log, a note, an agent's brief). */
export function describeMap(map: TownMap): string {
  const byId = new Map(map.modules.map((m) => [m.id, m]));
  return map.quarters.map((q) => `${q.name}${q.apart ? ' (apart)' : ''}: ${q.modules.map((id) => { const m = byId.get(id) as MapModule; return `${m.id} (${m.lines} lines, ${m.tests.length} test file${m.tests.length === 1 ? '' : 's'})`; }).join(', ')}`).join('\n');
}
