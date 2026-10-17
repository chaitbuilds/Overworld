// The lead agent's plan for one ask: which modules of the repository the ask touches, what each must do, the order,
// and which tests prove it. The lead reads the repository and writes this one file; the town checks it against the
// map before anyone else works. The file is the town's record of the ask, not part of the product: it is kept in the
// run's record and never merged.
import { classify, type TownMap } from './mapper.js';
import { quarterForNew } from './layout.js';

export const PLAN_FILE = 'PLAN.json';
export const MAX_MODULES = 6;
export const SIGN_LETTERS = 34;
export const MAX_NEW = 2;

export interface PlanModule {
  /** A module of the map, by its folder's path ("features/shop/catalog"); or, with `new`, the folder a new module is made in. */
  module: string;
  /** The module does not exist yet: the change makes its folder, beside modules that do (it gets a lot of its own in their quarter). */
  new?: boolean;
  /** The few plain words the sign at this building carries while it is worked on: what it gets ("prices in euros"). */
  sign: string;
  /** What this module must do for the ask, in a sentence or two. */
  does: string;
  /** Modules of this plan that must be done first (this one is written against their changed code). */
  needs: string[];
  /** The test files that prove this module's part: new files, or existing ones to be added to. Paths in the repository. */
  tests: string[];
}
export interface Plan {
  /** What changes for the person who uses the product, in one sentence. */
  summary: string;
  modules: PlanModule[];
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Check a plan as written against the map. Returns the plan, or everything that is wrong with it in plain words. */
export function checkPlan(raw: unknown, map: TownMap, exists: (file: string) => boolean = () => false): { plan?: Plan; problems: string[] } {
  const problems: string[] = [];
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.summary !== 'string' || !r.summary.trim()) problems.push('"summary" is missing: one sentence saying what changes for the person who uses the product.');
  const list = Array.isArray(r.modules) ? (r.modules as Array<Record<string, unknown>>) : [];
  if (!list.length) problems.push('"modules" is missing or empty: name the modules the ask touches.');
  if (list.length > MAX_MODULES) problems.push(`The plan names ${list.length} modules; at most ${MAX_MODULES} can be worked on for one ask. Keep to the modules that must change.`);
  const known = new Map(map.modules.map((m) => [m.id, m])), seen = new Set<string>(), tests = new Map<string, string>(), modules: PlanModule[] = [];
  for (const m of list) {
    const id = typeof m.module === 'string' ? m.module.replace(/\/+$/, '') : '';
    const fresh = m.new === true;
    if (fresh) {
      const bad = newModuleProblem(id, map, exists);
      if (bad) { problems.push(bad); continue; }
    } else if (!known.has(id)) { problems.push(`"${String(m.module)}" is not a module of this repository. The modules are: ${map.modules.map((x) => x.id).join(', ')}. (A module that does not exist yet is named with "new": true.)`); continue; }
    if (seen.has(id)) { problems.push(`${id} is named twice.`); continue; }
    seen.add(id);
    if (typeof m.does !== 'string' || m.does.trim().length < 8) problems.push(`${id}: "does" must say what this module has to do for the ask.`);
    const sign = typeof m.sign === 'string' ? m.sign.trim().replace(/\s+/g, ' ').replace(/\.$/, '') : '';
    if (sign.length < 3 || sign.length > SIGN_LETTERS) problems.push(`${id}: "sign" must be the few plain words the sign at this building will carry: what this building gets, at most ${SIGN_LETTERS} letters, no file names (it has ${sign.length}).`);
    const needs = isStrings(m.needs) ? m.needs.map((n) => n.replace(/\/+$/, '')) : [];
    if (m.needs !== undefined && !isStrings(m.needs)) problems.push(`${id}: "needs" must be a list of module names (or left out).`);
    const files = isStrings(m.tests) ? m.tests : [];
    if (!files.length) problems.push(`${id}: "tests" must name at least one test file that proves this module's part.`);
    for (const f of files) {
      if (classify(f) !== 'test') problems.push(`${id}: "${f}" is not a test file of this repository (tests live where the existing ones do, and are named like them).`);
      else if (tests.has(f)) problems.push(`"${f}" is named by ${tests.get(f)} and by ${id}: a test file proves one module's part.`);
      else tests.set(f, id);
    }
    modules.push({ module: id, ...(fresh ? { new: true } : {}), sign, does: typeof m.does === 'string' ? m.does.trim() : '', needs, tests: files });
  }
  if (modules.filter((m) => m.new).length > MAX_NEW) problems.push(`The plan makes ${modules.filter((m) => m.new).length} new modules; at most ${MAX_NEW}.`);
  for (const m of modules) for (const n of m.needs) {
    if (n === m.module) problems.push(`${m.module} cannot need itself.`);
    else if (!seen.has(n)) problems.push(`${m.module} needs ${n}, which is not in the plan. A module needs another only when it is written against that module's CHANGED code; then that module must be in the plan too.`);
  }
  if (!problems.length) { try { waves({ summary: '', modules }); } catch (e) { problems.push((e as Error).message); } }
  if (problems.length) return { problems };
  return { plan: { summary: (r.summary as string).trim(), modules }, problems };
}

/**
 * What is wrong with a new module's folder, or '' when it can be one: a folder that does not exist yet, named in lower
 * case, directly inside a folder whose sub-folders are modules already (so by the mapper's own rules it is a module of
 * its own once it holds its code), in a quarter of the town.
 */
export function newModuleProblem(id: string, map: TownMap, exists: (file: string) => boolean): string {
  const parent = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '', name = id.slice(id.lastIndexOf('/') + 1);
  const siblings = [...new Set(map.modules.filter((x) => x.id.includes('/') && x.id.slice(0, x.id.lastIndexOf('/')) === parent).map((x) => x.id))];
  if (map.modules.some((x) => x.id === id)) return `${id} is a module already: leave out "new".`;
  if (!/^[a-z][a-z0-9-]{1,23}$/.test(name)) return `"${id}": a new module's folder is named in lower case letters, digits and hyphens (at most 24), like its neighbours.`;
  if (!parent || !siblings.length) return `"${id}": a new module goes directly inside a folder whose sub-folders are modules already (${[...new Set(map.modules.filter((x) => x.id.includes('/')).map((x) => x.id.slice(0, x.id.lastIndexOf('/'))))].join(', ')}).`;
  if (exists(id)) return `"${id}" exists already as a folder: it is not new.`;
  if (!quarterForNew(map, id)) return `"${id}": no quarter of the town holds its neighbours.`;
  return '';
}

/** The order of work: each wave holds the modules whose needs are all in earlier waves; a wave's modules are worked on at the same time. */
export function waves(plan: Plan): string[][] {
  const left = new Map(plan.modules.map((m) => [m.module, new Set(m.needs)])), out: string[][] = [];
  while (left.size) {
    const ready = [...left].filter(([, needs]) => [...needs].every((n) => !left.has(n))).map(([id]) => id);
    if (!ready.length) throw new Error(`The plan's needs go round in a ring (${[...left.keys()].join(', ')}): nothing could be begun.`);
    out.push(ready);
    for (const id of ready) left.delete(id);
  }
  return out;
}

export function describePlan(plan: Plan): string {
  return [`The plan: ${plan.summary}`, ...waves(plan).map((w, i) => `${i === 0 ? 'First' : 'Then'}, at the same time: ${w.join(', ')}.`),
    ...plan.modules.map((m) => `- ${m.module}: ${m.does} Proved by ${m.tests.join(', ')}.${m.needs.length ? ` Needs ${m.needs.join(', ')}.` : ''}`)].join('\n');
}
