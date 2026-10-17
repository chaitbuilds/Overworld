// The code town in the backend: a real repository shown as a town, and what a person asks for there turned into a
// change to that repository by agents, in the open.
//
//   ask (the person's words, at a quarter's gate or at a building)
//     -> the lead reads the repository and writes the plan                  (it changes nothing; PLAN.json is the town's)
//     -> the plan is checked against the map
//     -> for each module, in waves by what needs what, side by side within a wave:
//          one agent writes the module's tests first      (only the test files the plan names; it may correct old tests)
//          the backend runs the tests: the new ones must fail, and only they          -> the building's lamps go red
//          another agent writes the change                                    (only inside that module's own folder)
//          the backend runs the type check and every test                                       -> the lamps light
//     -> each wave's branches are merged one at a time into the ask's staging branch, the repository's whole CI
//        after each (and its own generator, as a labelled mechanical commit, when it has something to say)
//     -> the person approves by one action in the town (the lever on a gate)
//     -> the staging branch is merged into the town branch by RepoManager's guarded merge (never pushed)
//     -> the whole CI once more on the branch as it stands; the map is read again, and the town grows to it
//
// Two modes, by the backend: `--backend none` is "hand" (no agents: the town is drawn from the map and nothing can be
// asked), `--backend claude` is "real" (real agent sessions, at most OVERWORLD_MAX_SESSIONS of them).
//
// Working copies and the merge come from RepoManager (repos.ts). The backend runs every check (checks.ts); no agent
// has a shell. Who may start agent sessions is the worker's business (town/worker.ts): this file never starts one.
// The town itself is drawn from the map by draw.ts; every sign on a building is a fact this file knows at that moment.
import fs from 'node:fs';
import path from 'node:path';
import type { Foreman } from '../foreman.js';
import { TownRecord, type ListRow } from '../town/record.js';
import { LiveDriver, type GameEvent } from '../town/live.js';
import type { Place, PlacesFile } from '../town/places.js';
import { AgentWorker } from '../town/runner.js';
import type { TownWorker, WorkRequest } from '../town/worker.js';
import { git, gitOut, identityEnv } from '../util/git.js';
import { ciSteps, describeTests, describeWhole, RepoChecks, unreadable, type CiStep, type TestRun, type WholeCheck } from './checks.js';
import { AT_REST, gatePart, LEVER_KEY, screenFit, TownDrawer, type BuildingLook, type Stage } from './draw.js';
import { textPixels, type Lamp } from './buildings.js';
import { FEET_Y, freeLot, grownPlot, placesOf, quarterForNew, screenWallOf, slugOf, type Gate, type Plot, type TownLayout } from './layout.js';
import { worldBlock } from './frame.js';
import { boardName, classify, mapRepository, moduleOfPath, STEPS, stepFor, type MapModule, type TownMap } from './mapper.js';
import { checkPlan, describePlan, PLAN_FILE, waves, type Plan, type PlanModule } from './plan.js';
import { changeBrief, leadBrief, testsBrief } from './prompts.js';

export class CodeTownError extends Error {}
export type CodeMode = 'hand' | 'real';

export interface ModuleWork {
  module: string;
  place: string;
  status: 'planned' | 'tests' | 'red' | 'change' | 'green' | 'staged' | 'merged' | 'failed';
  testsBy?: string;
  changeBy?: string;
  /** Agents that hold this module's work right now. */
  working: string[];
  /** The module's working copy as RepoManager knows it, and where its files are. */
  worktree?: string;
  dir?: string;
  /** The branch its commits are on, and the commit its change is counted from. */
  branch?: string;
  from?: string;
  /** The state of each of its plan's test files (and of any old test it had to correct). */
  lamps: Record<string, Lamp>;
  /** Lines added and removed so far, the file last written, tests counted. */
  added: number; removed: number; file?: string; tests?: number; failing?: number;
  /** What the screen inside its building shows while it is worked on: the code being written, as it stands. */
  screen?: string;
  repairs: number;
  failure?: string;
}
export interface AskRecord {
  id: string;
  text: string;
  place: string;
  status: 'asked' | 'planning' | 'working' | 'checking' | 'ready' | 'merging' | 'done' | 'failed';
  askedAt: number;
  lead?: string;
  working: string[];
  plan?: Plan;
  modules: Record<string, ModuleWork>;
  staging?: { worktree: string; dir: string; branch: string };
  decision?: string;
  sessions: number;
  failure?: string;
  merge?: { sha: string; added: number; removed: number; files: number; tests: number; testFiles: number; at: number };
  doneAt?: number;
  log: Array<{ ms: number; what: string }>;
}
interface CodeData {
  asks: AskRecord[]; counter: number; done: Record<string, number>;
  /** Each test file as the last whole run of the tests on the town branch left it. */
  lamps: Record<string, Lamp>;
  /** A few letters that are this profile's own, in the name of every branch it makes: two runs' branches never meet in the repository. */
  token?: string;
  /** New modules a change made (or is making): how far each building stands, and at what step of the size rule. */
  built?: Record<string, { stage: Stage; step: number; lines: number }>;
}

const TOWN = identityEnv('The Town', 'town@overworld.local');
const short = (text: string, max: number): string => { const t = text.replace(/\s+/g, ' ').trim(); return t.length <= max ? t : `${t.slice(0, max - 1).replace(/[\s,.;:]+\S*$/, '')}…`; };
const LIVE = ['asked', 'planning', 'working', 'checking', 'ready', 'merging'];
/** Words that must never reach the town's screens: anyone's e-mail address, and the home folder in a path. */
const scrub = (line: string): string => line.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<address>').replace(/\/Users\/[^/\s'"`]+/g, '~').replace(/\/home\/[^/\s'"`]+/g, '~');

export class CodeTownService {
  readonly mode: CodeMode;
  readonly repoPath: string;
  readonly branch: string;
  readonly townDir: string;
  map: TownMap;
  layout: TownLayout;
  places: PlacesFile;
  readonly live: LiveDriver;
  readonly drawer: TownDrawer;
  readonly rec: TownRecord;
  readonly checks: RepoChecks;
  worker: TownWorker | undefined;
  private data: CodeData;
  private repoId = '';
  private steps: CiStep[] = [];
  private gameUp = false;
  private lastClock = 0;
  private closed = false;
  private timer: NodeJS.Timeout | undefined;
  private sampler: NodeJS.Timeout | undefined;
  private emitTimer: NodeJS.Timeout | undefined;
  private waiters: Array<() => void> = [];
  private busyAgents = new Set<string>();
  private approvals: Array<(gate: string) => void> = [];
  private sampling = false;
  /** The whole check that is running now, for the tags: which step, and how many are done. */
  private checking: { what: string; step: string; done: number; of: number } | undefined;
  /** Lines of each source file of the branch as it stands (for the screens at rest), and the screens made from them. */
  private fileLines = new Map<string, number>();
  private restScreens = new Map<string, string>();
  /** What each module's newest file held at the last look (to find where the latest edit is). */
  private lastSeen = new Map<string, { file: string; rows: string[]; focus: number }>();

  constructor(private fm: Foreman) {
    this.mode = fm.config.backend === 'claude' ? 'real' : 'hand';
    this.townDir = process.env.OVERWORLD_TOWN ?? '';
    this.repoPath = process.env.OVERWORLD_REPO ?? '';
    this.branch = process.env.OVERWORLD_BRANCH ?? 'overworld-town';
    if (!this.townDir || !fs.existsSync(path.join(this.townDir, 'map.json')) || !fs.existsSync(path.join(this.townDir, 'layout.json'))) throw new Error('OVERWORLD_TOWN must name the folder the mapper wrote (map.json, layout.json): node --import tsx scripts/codetown-map.ts <repository> --dir <folder>');
    if (!this.repoPath || !fs.existsSync(path.join(this.repoPath, '.git'))) throw new Error('OVERWORLD_REPO must name the repository the town is the code of');
    this.map = JSON.parse(fs.readFileSync(path.join(this.townDir, 'map.json'), 'utf8')) as TownMap;
    // the town as it stands after changes that grew it (new buildings, buildings grown in place), else as it was laid out
    const live = path.join(this.townDir, 'layout-live.json');
    this.layout = JSON.parse(fs.readFileSync(fs.existsSync(live) ? live : path.join(this.townDir, 'layout.json'), 'utf8')) as TownLayout;
    // the product itself on a wall of the square, live, when the profile names its screen (the hidden browser's --wall)
    const screen = process.env.OVERWORLD_SCREEN;
    if (screen && /^[A-Za-z0-9_-]{1,64}$/.test(screen)) {
      const sw = screenWallOf(this.layout, screen), sq = this.layout.square;
      // the agents who wait on the green stand in the square's far corner, out of the way of anyone facing the screen
      this.layout = { ...this.layout, screen: sw, green: [sq.x1 - 1.5, FEET_Y, sq.z1 - 1.5] };
    } else if (this.layout.screen) this.layout = { ...this.layout, screen: undefined };
    this.places = placesOf(this.layout);
    this.live = new LiveDriver((ops) => fm.ctx.emit({ type: 'town.do', ops }));
    this.drawer = new TownDrawer(this.live, this.layout, this.map.quarters.map((q) => q.id), (line) => fm.log.warn(`code town: ${line}`), (module) => this.moduleOf(module)?.files.length ?? 0);
    this.drawer.screenName = process.env.OVERWORLD_SCREEN_NAME ?? this.map.repo;
    this.rec = new TownRecord(process.env.OVERWORLD_RECORD, () => fm.ctx.now());
    this.checks = new RepoChecks((line) => fm.log.warn(`code town: ${line}`));
    const saved = (fm.store.data.backend as Record<string, unknown>).codetown as CodeData | undefined;
    this.data = saved ?? { asks: [], counter: 0, done: {}, lamps: {} };
    this.data.done ??= {}; this.data.lamps ??= {}; this.data.built ??= {};
    // a new module made by an earlier change stands in the map as the town knows it (until the town is mapped again)
    for (const [id, b] of Object.entries(this.data.built)) { if (!this.moduleOf(id) && this.plot(id)) this.addModule(id, b.lines); }
    for (const [id, b] of Object.entries(this.data.built)) { const p = this.plot(id); if (p && b.stage !== 'built') this.drawer.lot(p); if (p && b.stage === 'frame') this.drawer.frame(p, p, 0); }
    this.data.token ??= `r${Date.now().toString(36).slice(-5)}`;
    (fm.store.data.backend as Record<string, unknown>).codetown = this.data;
  }

  private get log() { return this.fm.log; }
  private name(id: string | undefined): string { return id ? this.fm.nameOf(id) : ''; }
  private plot(module: string): Plot | undefined { return this.layout.plots.find((p) => p.module === module); }
  private moduleOf(id: string): MapModule | undefined { return this.map.modules.find((m) => m.id === id); }
  /** The town's plots changed (a new lot, a building grown): the places, the drawer and layout-live.json (the town as it stands, read at the next start) follow. */
  private setPlots(plots: Plot[]): void {
    this.layout = { ...this.layout, plots };
    this.places = placesOf(this.layout);
    this.drawer.layout = this.layout;
    fs.writeFileSync(path.join(this.townDir, 'layout-live.json'), `${JSON.stringify(this.layout, null, 1)}\n`);
  }
  /** A module that a change makes, as the map would hold it: its own folder, in the quarter of the modules beside it. */
  private addModule(id: string, lines: number, files: string[] = []): MapModule {
    const step = stepFor(lines), size = STEPS[step] as (typeof STEPS)[number], quarter = quarterForNew(this.map, id) ?? this.plot(id)?.quarter ?? '';
    const m: MapModule = { id, name: boardName(id, this.map.repo), dirs: [id], files, lines, quarter, step, wide: size.wide, deep: size.deep, high: size.high, tests: [], depth: 0 };
    this.map = { ...this.map, modules: [...this.map.modules.filter((x) => x.id !== id), m], quarters: this.map.quarters.map((q) => (q.id === quarter && !q.modules.includes(id) ? { ...q, modules: [...q.modules, id] } : q)) };
    return m;
  }
  /** Lines of source code under a folder of a working copy (the mapper's count), and how many files hold them. */
  private linesUnder(dir: string, folder: string): { lines: number; files: string[] } {
    const out: string[] = []; let lines = 0;
    const walk = (rel: string): void => {
      let names: fs.Dirent[] = []; try { names = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
      for (const d of names) {
        const r = `${rel}/${d.name}`;
        if (d.isDirectory()) walk(r);
        else if (classify(r) === 'source') { try { const t = fs.readFileSync(path.join(dir, r), 'utf8'); lines += t.length ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0; out.push(r); } catch { /* being written */ } }
      }
    };
    walk(folder);
    return { lines, files: out.sort() };
  }
  private save(): void { this.fm.store.markDirty(); this.afterChange(); }
  private note(ask: AskRecord, what: string): void { ask.log.push({ ms: this.fm.ctx.now(), what }); this.log.info(`ask ${ask.id}: ${what}`); }
  /** The name a piece of an ask's work goes by in the repository (its working copy and its branch). */
  private taskId(ask: AskRecord, what: string): string { return `${this.data.token}-${ask.id}-${what}`; }
  private current(): AskRecord | undefined { return [...this.data.asks].reverse().find((a) => LIVE.includes(a.status)); }

  // ------------------------------------------------------------------ lifecycle
  async start(): Promise<void> {
    const repo = await this.fm.repos.add(this.repoPath);
    this.repoId = repo.id;
    // the town's base is the town branch, and the checkout must be on it: a merge goes there and nowhere else
    if (repo.branch !== this.branch) throw new Error(`the repository at ${this.repoPath} is on "${repo.branch}", not "${this.branch}": check out ${this.branch} there first (the town merges into the branch that is checked out, and never into another)`);
    this.steps = ciSteps(this.repoPath);
    // work that was in flight when a backend stopped cannot be picked up: its agent sessions are gone
    for (const ask of this.data.asks) if (LIVE.includes(ask.status)) { ask.status = 'failed'; ask.failure = 'the backend stopped while this was being made'; ask.working = []; for (const w of Object.values(ask.modules)) { w.working = []; if (!['merged', 'staged'].includes(w.status)) w.status = 'failed'; } }
    if (this.mode === 'real' && !this.worker) {
      const c = this.fm.config.claude;
      // real agent sessions, inside a session cap
      if (!(Number(process.env.OVERWORLD_MAX_SESSIONS) > 0)) throw new Error('a real code town run needs OVERWORLD_MAX_SESSIONS (the cap on agent sessions)');
      this.worker = new AgentWorker(this.fm, { model: c.workerModel, effort: c.effort, maxTurns: c.maxTurnsWorker, maxConcurrent: c.maxConcurrent, useClaudeLogin: c.useClaudeLogin, resumeMarginMs: Number(process.env.OVERWORLD_LIMIT_RESUME_MARGIN_MS) || undefined });
      this.log.info(`code town: REAL RUN. Agent sessions on ${c.useClaudeLogin ? 'the local Claude login' : 'the Claude API (or a cloud provider)'}, at most ${process.env.OVERWORLD_MAX_SESSIONS}, ${this.worker.sessions().used} used so far`);
    }
    for (const a of this.fm.agents()) this.fm.setAgent(a.id, { active: true, state: 'idle', station: 'lounge', activity: 'on the green' });
    this.log.info(`code town: mode ${this.mode}, ${this.map.repo} on ${this.branch} at ${repo.head ?? ''}: ${this.map.totals.modules} buildings in ${this.map.totals.quarters} quarters; ${this.steps.length} CI steps (${this.steps.map((s) => s.name).join('; ')})`);
    this.rec.write('start', { mode: this.mode, repo: this.map.repo, branch: this.branch, commit: this.map.commit, buildings: this.map.totals.modules, ciSteps: this.steps.map((s) => s.run), sessions: this.worker?.sessions() ?? { used: 0, cap: 0 } });
    this.timer = setInterval(() => this.poll(), 1000); this.timer.unref?.();
    this.sampler = setInterval(() => void this.sample(), 2000); this.sampler.unref?.();
    this.save();
    void this.baseline();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.sampler) clearInterval(this.sampler);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    await this.worker?.stop();
  }

  /** The lamps as the tests leave them on the branch as it stands: run once at the start, and again after a merge. */
  private async baseline(): Promise<void> {
    try {
      const run = await this.checks.tests(this.repoPath);
      this.takeLamps(run);
      this.log.info(`code town: tests on ${this.branch}: ${run.ran ? `${run.passed} of ${run.total} pass in ${run.files.length} files` : `could not be run (${(run.error ?? '').split('\n')[0]})`}`);
      this.rec.write('baseline', { ran: run.ran, total: run.total, passed: run.passed, files: run.files.length, failing: run.files.filter((f) => !f.ok).map((f) => f.file) });
      this.save();
    } catch (e) { this.log.warn(`code town: the tests could not be run on ${this.branch}: ${(e as Error).message}`); }
  }
  private takeLamps(run: TestRun): void {
    if (!run.ran) return;
    for (const f of run.files) this.data.lamps[f.file] = f.ok ? 'lit' : 'red';
  }

  // ------------------------------------------------------------------ the game
  events(list: Array<Record<string, unknown>>): void {
    for (const raw of list) {
      const e = raw as GameEvent;
      switch (e.kind) {
        case 'clock':
          this.lastClock = Date.now();
          if (!this.gameUp) { this.gameUp = true; this.log.info('code town: the game is here'); this.redraw('the game arrived'); }
          break;
        case 'hello': this.log.info(`code town: world "${String(e.world ?? '')}" loaded`); if (this.gameUp) this.redraw('the world was loaded again'); break;
        case 'done': this.live.settle(e); break;
        case 'error': if (!this.live.settle(e) && typeof e.part === 'string') this.log.warn(`code town: the game refused ${String(e.op ?? 'an operation')} of ${e.part}: ${String(e.message ?? '')}`); break;
        case 'use': if (e.key === LEVER_KEY) this.leverUsed(String(e.part), String((e.player as { name?: string } | undefined)?.name ?? '')); break;
      }
    }
  }
  private poll(): void {
    if (this.closed) return;
    if (this.gameUp && Date.now() - this.lastClock > 6000) {
      this.gameUp = false;
      this.log.warn('code town: the game has gone quiet');
      this.live.abandon('the game went away'); this.drawer.forget();
    }
  }
  private redraw(why: string): void {
    this.log.info(`code town: drawing the town (${why})`);
    this.live.abandon(why); this.drawer.forget();
    this.drawer.drawAll(0);
    this.afterChange();
  }

  // ------------------------------------------------------------------ what the town shows
  /** The lamps of a building: one for each test file that covers it, by name; the plan's test files for it too. */
  private lampFiles(module: string): string[] {
    const files = new Set(this.moduleOf(module)?.tests ?? []);
    for (const ask of this.data.asks) { const w = ask.modules[module]; if (w && ask.status !== 'failed') for (const f of Object.keys(w.lamps)) files.add(f); }
    return [...files].sort();
  }
  private lookOf(p: Plot): BuildingLook {
    const ask = this.current() ?? [...this.data.asks].reverse().find((a) => a.status === 'done');
    const w = ask?.modules[p.module], inFlight = ask && LIVE.includes(ask.status) ? w : undefined;
    const lamps = this.lampFiles(p.module).map((f) => inFlight?.lamps[f] ?? w?.lamps[f] ?? this.data.lamps[f] ?? 'dark');
    // while its working copy is open the screen shows the code being written (and still does while the checks run);
    // the door stands open while someone is inside
    const open = !!(inFlight && w && w.dir && ['tests', 'red', 'change'].includes(w.status)), atWork = open && !!w?.working.length;
    const screen = open && w?.screen ? w.screen : this.restScreen(p);
    if (!w || !ask) return { ...AT_REST, lamps, screen };
    // merged: banners, and nothing else of the work is left standing
    if (w.status === 'merged') return { lamps, outline: 'none', scaffold: false, banners: true, note: this.boardWords(w), screen };
    if (ask.status === 'done') return { ...AT_REST, lamps, screen };
    return {
      lamps,
      outline: w.status === 'failed' ? 'red' : 'yellow',
      scaffold: ['tests', 'red', 'change'].includes(w.status) && !!w.dir,
      banners: false,
      note: this.boardWords(w),
      door: atWork,
      screen,
    };
  }
  /** The screen of a building at rest: its files, the largest first, with their lines of code. */
  private restScreen(p: Plot): string {
    const cached = this.restScreens.get(p.module), building = this.data.built?.[p.module];
    if (cached !== undefined && (!building || building.stage === 'built')) return cached;
    const m = this.moduleOf(p.module);
    if (!m) return '';
    const fit = screenFit(p);
    const count = (f: string): number => {
      let n = this.fileLines.get(f);
      if (n === undefined) { try { const t = fs.readFileSync(path.join(this.repoPath, f), 'utf8'); n = t.length ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0; this.fileLines.set(f, n); } catch { n = 0; } }
      return n;
    };
    const rows = m.files.map((f) => [f, count(f)] as const).sort((a, b) => b[1] - a[1]), room = Math.max(1, fit.lines - 4);
    const shown = rows.slice(0, room).map(([f, n]) => `§f${path.posix.basename(f)}  §7${n.toLocaleString('en-US')}`);
    if (rows.length > room) shown.push(`§7… and ${rows.length - room} more files`);
    const text = [`§f§l${p.name}`, `§7${m.lines.toLocaleString('en-US')} lines of code in ${m.files.length} file${m.files.length === 1 ? '' : 's'} · ${m.tests.length} test file${m.tests.length === 1 ? '' : 's'}`, '', ...shown].join('\n');
    this.restScreens.set(p.module, text);
    return text;
  }
  /**
   * The screen of a building whose module is being worked on: the file its agent wrote last, around the latest edit,
   * lines added since the work began in green and lines taken out in red. Read from the working copy as it stands.
   */
  private async workScreen(w: ModuleWork, p: Plot): Promise<string> {
    const dir = w.dir as string, from = w.from as string, fit = screenFit(p);
    const who = w.working[0] ? `AI agent ${this.name(w.working[0])}` : 'AI agent';
    const head = `§e${who}§7 · ${w.status === 'tests' ? 'writing the tests first' : w.status === 'red' ? 'reading the tests' : 'writing the change'}`;
    const tracked = (await git(dir, ['diff', '--name-only', '-z', from], { allowFail: true })).stdout.split('\0');
    const fresh = (await git(dir, ['ls-files', '--others', '--exclude-standard', '-z'], { allowFail: true })).stdout.split('\0').filter(Boolean);
    let newest = '', when = 0;
    for (const f of new Set([...tracked, ...fresh])) {
      if (!f || classify(f) === 'other') continue;
      try { const t = fs.statSync(path.join(dir, f)).mtimeMs; if (t > when) { when = t; newest = f; } } catch { /* gone */ }
    }
    if (!newest) return `${head}\n\n§7reading the code…`;
    let rows: string[];
    if (fresh.includes(newest)) rows = fs.readFileSync(path.join(dir, newest), 'utf8').split('\n').map((l) => `+${l}`);
    else {
      const out = (await git(dir, ['diff', '-U100000', '--no-color', from, '--', newest], { allowFail: true })).stdout.split('\n');
      const at = out.findIndex((l) => l.startsWith('@@'));
      rows = at < 0 ? [] : out.slice(at + 1).filter((l) => !l.startsWith('\\'));
    }
    while (rows.length && (rows[rows.length - 1] === '+' || rows[rows.length - 1] === '')) rows.pop();
    // where the latest edit is: the first row that differs from the last look at this file; else the last added row
    const seen = this.lastSeen.get(w.module);
    let focus = -1;
    if (seen && seen.file === newest) {
      const n = Math.min(seen.rows.length, rows.length);
      for (let i = 0; i < n; i++) if (seen.rows[i] !== rows[i]) { focus = i; break; }
      if (focus < 0) focus = rows.length !== seen.rows.length ? n : seen.focus;
    }
    if (focus < 0) for (let i = rows.length - 1; i >= 0; i--) if (rows[i]?.startsWith('+')) { focus = i; break; }
    focus = Math.max(0, focus);
    this.lastSeen.set(w.module, { file: newest, rows, focus });
    const room = Math.max(1, fit.lines - 3), start = Math.max(0, Math.min(focus - Math.floor(room / 3), rows.length - room));
    const px = Math.floor(((p.wide - 2 - 0.4) * 40) / fit.scale) - 14;
    const lineOf = (r: string): string => {
      let code = scrub(r.slice(1)).replace(/\t/g, '  ').replace(/§/g, 'S');
      while (code.length && textPixels(code, false) > px) code = code.slice(0, -1);
      return `${r[0] === '+' ? '§a+ ' : r[0] === '-' ? '§c- ' : '§8  '}${code}`;
    };
    const added = rows.filter((r) => r[0] === '+').length, removed = rows.filter((r) => r[0] === '-').length;
    return [head, `§f${newest.split('/').slice(-2).join('/')}  §a+${added}${removed ? ` §c-${removed}` : ''}`, '', ...rows.slice(start, start + room).map(lineOf)].join('\n');
  }

  /** The line on a building's board under its name: who is at it and how its tests stand, in as few words as say it. */
  private boardWords(w: ModuleWork): string {
    const who = w.working[0] ? `AI agent ${this.name(w.working[0])}` : '';
    const pass = w.tests ? `${w.tests} tests pass` : 'tests pass';
    switch (w.status) {
      case 'planned': return '§7planned';
      case 'tests': return who ? `§e${who}: tests first` : '§7planned';
      case 'red': return `§c${w.failing ?? 0} new tests failing`;
      case 'change': return who ? `§e${who}: ${(w.failing ?? 0) > 0 ? `${w.failing} failing` : 'changing'}` : (w.failing ?? 0) > 0 ? `§c${w.failing} tests failing` : `§a${pass}`;
      case 'green': case 'staged': return `§a${pass}`;
      case 'merged': return `§amerged · ${pass}`;
      case 'failed': return '§cstopped';
    }
    return '';
  }
  private afterChange(): void {
    if (this.closed) return;
    for (const w of this.waiters.splice(0)) w();
    if (this.gameUp && this.drawer.drawn) {
      for (const p of this.layout.plots) this.drawer.set(p, this.lookOf(p));
      const last = this.current() ?? [...this.data.asks].reverse().find((a) => a.status === 'done');
      for (const g of this.layout.gates) this.drawer.plate(g, last && (last.place === g.place || this.layout.plots.some((p) => p.place === last.place && p.quarter === g.quarter)) ? this.gateWords(last) : '');
    }
    this.rec.list(this.listRows());
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => { this.emitTimer = undefined; if (!this.closed) this.fm.ctx.emit({ type: 'town.state', town: this.view() }); }, 60);
    this.emitTimer.unref?.();
  }

  /** The record's rows: one for each module of the plan in hand (in street order), and one for the ask as a whole. */
  listRows(): ListRow[] {
    const ask = this.current() ?? [...this.data.asks].reverse().find((a) => a.status === 'done' || a.status === 'failed');
    if (!ask) return [];
    const tests = (n: number): string => `${n} test${n === 1 ? '' : 's'}`;
    const rows: ListRow[] = [];
    const whole = ((): ListRow => {
      const who = ask.working[0] ? `agent ${this.name(ask.working[0])}` : '';
      const c = this.checking;
      let state: ListRow['state'] = 'work', text = '';
      if (ask.status === 'asked' || ask.status === 'planning') text = who ? `${who} reading the code` : 'asked';
      else if (ask.status === 'working') text = `${Object.values(ask.modules).filter((w) => ['green', 'staged'].includes(w.status)).length} of ${Object.keys(ask.modules).length} modules done`;
      else if (ask.status === 'checking') text = c ? `checking · ${c.step} · ${c.done} of ${c.of}` : 'checking';
      else if (ask.status === 'ready') text = 'every check passed · waiting for approval';
      else if (ask.status === 'merging') text = 'approved · merging';
      else if (ask.status === 'done') { state = 'live'; text = this.mergeWords(ask); }
      else { state = 'failed'; text = `stopped: ${short(ask.failure ?? '', 70)}`; }
      return { part: '@ask', plot: ask.place, state, text };
    })();
    rows.push(whole);
    for (const p of this.layout.plots) {
      const w = ask.modules[p.module]; if (!w) continue;
      const who = w.working[0] ? `agent ${this.name(w.working[0])}` : '';
      const file = w.file ? path.posix.basename(w.file) : '';
      let state: ListRow['state'] = 'work', text = '';
      switch (w.status) {
        case 'planned': state = 'planned'; text = 'planned'; break;
        case 'tests': text = who ? `${who} writing tests${file ? ` · ${file}` : ''}` : 'waiting for an agent'; break;
        case 'red': text = who ? `${who} reading the tests · ${w.failing ?? 0} failing` : `${tests(w.failing ?? 0)} written · failing, as they should`; break;
        case 'change': { const t = (w.failing ?? 0) > 0 ? `${w.failing} failing` : 'tests pass'; text = who ? `${who} changing ${file || p.name} · +${w.added} lines · ${t}` : `+${w.added} lines · ${t}`; break; }
        case 'green': text = `${tests(w.tests ?? 0)} pass · +${w.added} lines`; break;
        case 'staged': text = `checked with the rest · +${w.added} lines`; break;
        case 'merged': state = 'live'; text = 'merged'; break;
        case 'failed': state = 'failed'; text = `stopped: ${short(w.failure ?? '', 60)}`; break;
      }
      rows.push({ part: p.name, plot: p.place, state, text });
    }
    return rows;
  }
  private mergeWords(ask: AskRecord): string {
    const m = ask.merge; if (!m) return 'merged';
    return `merged · +${m.added} lines · ${m.tests} tests pass`;
  }

  /** What a building's stake says: what the plan asks of this module, and under it who is at it and how its tests stand. Words that change only when the work does (no running counts: the game draws the sign again each time). */
  private stakeWords(ask: AskRecord, w: ModuleWork): string {
    const entry = ask.plan?.modules.find((m) => m.module === w.module);
    const who = w.working[0] ? `AI agent ${this.name(w.working[0])}` : '', file = w.file ? path.posix.basename(w.file) : '';
    const tests = (w.failing ?? 0) > 0 ? `${w.failing} tests failing` : w.tests ? `${w.tests} tests pass` : '';
    let now = '';
    switch (w.status) {
      case 'planned': now = 'planned'; break;
      case 'tests': now = who ? `${who}: writing its tests first` : 'waiting for an agent'; break;
      case 'red': now = `${who ? `${who}: reading the tests. ` : ''}${w.failing ?? 0} new tests failing`; break;
      case 'change': now = `${who ? `${who}: changing ${file || 'the code'}. ` : ''}${tests}`; break;
      case 'green': now = tests || 'tests pass'; break;
      case 'staged': now = 'every check passed with the rest'; break;
      case 'merged': now = `merged. ${w.tests ? `${w.tests} tests pass` : ''}`; break;
      case 'failed': now = `stopped: ${short(w.failure ?? '', 60)}`; break;
    }
    return `${entry?.sign ? `${entry.sign}\n` : ''}${now}`.slice(0, 236);
  }
  /** What the plate on a gate says: how the change asked there stands, and when the lever will do something. */
  private gateWords(ask: AskRecord): string {
    const lead = ask.working[0] ? `AI agent ${this.name(ask.working[0])}` : '';
    const n = Object.keys(ask.modules).length, done = Object.values(ask.modules).filter((w) => ['green', 'staged', 'merged'].includes(w.status)).length;
    switch (ask.status) {
      case 'asked': case 'planning': return lead ? `${lead}\nis reading the code` : 'asked';
      case 'working': case 'checking': return `${done} of ${n} modules done`;
      case 'ready': return 'every check passed\npull the lever to merge';
      case 'merging': return 'approved\nmerging';
      case 'done': return ask.merge ? `merged\n+${ask.merge.added} lines\n${ask.merge.tests} tests pass` : 'merged';
      default: return `stopped`;
    }
  }

  /** The record as the game is told it. */
  view(): Record<string, unknown> {
    const asks: Array<Record<string, unknown>> = [];
    for (const a of this.data.asks) {
      const live = LIVE.includes(a.status);
      asks.push({ id: a.id, text: a.text, place: a.place, part: '@ask', kind: 'ask', status: a.status, lamp: a.status === 'done' ? 'on' : a.status === 'failed' ? 'failed' : 'off', agents: [...a.working], busy: live, failure: a.failure ?? null, askedAt: a.askedAt });
      if (a.status === 'failed' && !a.plan) continue;
      for (const w of Object.values(a.modules)) {
        asks.push({ id: `${a.id}:${slugOf(w.module)}`, text: this.stakeWords(a, w), place: w.place, part: w.module, kind: 'module', status: w.status, lamp: w.status === 'merged' ? 'on' : w.status === 'failed' ? 'failed' : 'off', agents: [...w.working], busy: live && !['merged', 'failed'].includes(w.status), failure: w.failure ?? null, askedAt: a.askedAt });
      }
    }
    return {
      mode: this.mode,
      kind: 'code', repo: this.map.repo, branch: this.branch,
      // OVERWORLD_STAKES=gates: only the gates keep a stake (where an ask is typed); a building's own board says
      // who is at it, so its stake would say it twice
      places: this.places.places.map((p) => ({ id: p.id, name: p.name, boxes: p.boxes, ...(p.aim ? { aim: p.aim } : {}), ...(p.outline ? { outline: p.outline } : {}), ...(p.stake && (process.env.OVERWORLD_STAKES !== 'gates' || this.layout.gates.some((g) => g.place === p.id)) ? { stake: p.stake } : {}), ...(p.stand ? { stand: p.stand } : {}), ...(p.standYaw === undefined ? {} : { standYaw: p.standYaw }) })),
      ...(this.places.green ? { green: this.places.green } : {}),
      // the product's screen on the square: the panel's bottom-left block in the world, and the page it shows
      ...(this.layout.screen ? { screens: [{ id: this.layout.screen.id, at: worldBlock(this.layout.frame, ...this.layout.screen.origin), wide: this.layout.screen.wide, high: this.layout.screen.high }] } : {}),
      asks, parts: [],
      sessions: this.worker?.sessions() ?? { used: 0, cap: 0 },
      game: this.gameUp,
      list: this.listRows(),
      plan: this.current()?.plan ?? null,
      ready: this.current()?.status === 'ready',
      // new modules' buildings: how far each stands (a lot, a frame as its code is written, built)
      built: this.data.built ?? {},
    };
  }
  record(): CodeData { return this.data; }

  // ------------------------------------------------------------------ asking
  /** The person asked for something, at a gate or at a building, in their own words. */
  async ask(text: string, placeId: string, _at?: [number, number, number]): Promise<Record<string, unknown>> {
    const words = text.replace(/\s+/g, ' ').trim();
    if (!words) throw new CodeTownError('Say what you want.');
    const place = this.places.places.find((p) => p.id === placeId);
    if (!place) throw new CodeTownError('That is not a place in the town.');
    if (!this.worker) throw new CodeTownError('No one is here to do the work (this backend has no agents).');
    if (this.current()) throw new CodeTownError('Work is still going on: one change at a time.');
    const gate = this.worker.canStart(3);
    if (!gate.ok) throw new CodeTownError(gate.why ?? 'No more work can be started.');
    const id = `a${++this.data.counter}`;
    const ask: AskRecord = { id, text: words, place: placeId, status: 'asked', askedAt: this.fm.ctx.now(), working: [], modules: {}, sessions: 0, log: [] };
    this.data.asks.push(ask);
    this.note(ask, `asked at ${place.name}: "${words}"`);
    this.rec.write('ask', { id, text: words, place: placeId, placeName: place.name });
    this.save();
    void this.make(ask, place);
    return { askId: id, part: '@ask', kind: 'ask' };
  }

  private fail(ask: AskRecord, why: string): void {
    ask.status = 'failed'; ask.failure = why.split('\n')[0]?.slice(0, 240); ask.working = [];
    for (const w of Object.values(ask.modules)) { w.working = []; if (!['merged'].includes(w.status)) { if (w.status !== 'failed') w.failure ??= 'the change it was part of was stopped'; w.status = 'failed'; } }
    this.note(ask, `failed: ${why.split('\n').slice(0, 14).join(' | ')}`);
    this.save();
  }

  /** An agent that holds no work, preferring whoever has done least; never `not`. Waits until there is one. */
  private async agentFor(not?: string, prefer?: (id: string) => boolean): Promise<string> {
    for (;;) {
      const free = this.fm.agents().map((a) => a.id).filter((id) => id !== not && !this.busyAgents.has(id));
      if (free.length) {
        free.sort((a, b) => Number(prefer?.(b) ?? false) - Number(prefer?.(a) ?? false) || (this.data.done[a] ?? 0) - (this.data.done[b] ?? 0));
        const id = free[0] as string; this.busyAgents.add(id); return id;
      }
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
  private letGo(id: string): void {
    this.busyAgents.delete(id);
    this.fm.setAgent(id, { state: 'idle', activity: 'on the green' });
    this.afterChange();
  }

  /** Commit everything in a working copy as the agent who wrote it. */
  private async commit(dir: string, message: string, agent: string): Promise<boolean> {
    await git(dir, ['add', '-A']);
    if ((await git(dir, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim().length === 0) return false;
    await git(dir, ['commit', '-q', '--no-verify', '-m', message], { env: identityEnv(this.name(agent), `${agent}@overworld.local`) });
    return true;
  }
  /** Files that differ between a commit and a working copy's HEAD. */
  private async changed(dir: string, from: string): Promise<string[]> {
    return (await git(dir, ['diff', '--name-only', '-z', from, 'HEAD'])).stdout.split('\0').filter(Boolean);
  }
  /** Lines added and removed in a working copy since a commit, counting files not yet committed. */
  private async delta(dir: string, from: string): Promise<{ added: number; removed: number; last?: string }> {
    let added = 0, removed = 0;
    const out = (await git(dir, ['diff', '--numstat', from], { allowFail: true })).stdout;
    for (const line of out.split('\n')) { const m = /^(\d+|-)\t(\d+|-)\t/.exec(line); if (m) { added += m[1] === '-' ? 0 : Number(m[1]); removed += m[2] === '-' ? 0 : Number(m[2]); } }
    const fresh = (await git(dir, ['ls-files', '--others', '--exclude-standard', '-z'], { allowFail: true })).stdout.split('\0').filter(Boolean);
    for (const f of fresh) { try { const t = fs.readFileSync(path.join(dir, f), 'utf8'); added += t.length ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0; } catch { /* being written */ } }
    return { added, removed };
  }

  private async job(ask: AskRecord, w: ModuleWork | undefined, role: 'plan' | 'checks' | 'build', agent: string, dir: string, brief: WorkRequest['brief'], allowed: WorkRequest['allowed'], runChecks: WorkRequest['runChecks'], repair?: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.worker) throw new CodeTownError('no worker');
    ask.sessions++;
    this.data.done[agent] = (this.data.done[agent] ?? 0) + 1;
    if (w) w.working = [agent]; else ask.working = [agent];
    const what = role === 'plan' ? 'the plan' : `${role === 'checks' ? 'the tests of' : 'the change to'} ${w?.module ?? ''}`;
    this.note(ask, `${this.name(agent)} ${repair ? 'repairs' : 'begins'} ${what}`);
    this.rec.write('job', { ask: ask.id, role: role === 'plan' ? 'plan' : role === 'checks' ? 'tests' : 'change', module: w?.module ?? null, agent: this.name(agent), repair: !!repair });
    this.save();
    const req: WorkRequest = { askId: ask.id, part: w?.module ?? 'plan', role, agentId: agent, worktree: dir, repair, allowed, runChecks, brief, unreadable };
    try {
      const out = await this.worker.run(req);
      this.note(ask, `${this.name(agent)} handed in ${what}${out.summary ? `: ${out.summary.slice(0, 200)}` : ''}${out.ok ? '' : ` (${out.error ?? 'not finished'})`}`);
      this.rec.write('handin', { ask: ask.id, role: role === 'plan' ? 'plan' : role === 'checks' ? 'tests' : 'change', module: w?.module ?? null, agent: this.name(agent), ok: out.ok, summary: out.summary.slice(0, 300), error: out.error ?? null });
      return { ok: out.ok, error: out.error };
    } finally {
      if (w) w.working = []; else ask.working = [];
      this.save();
    }
  }

  // ------------------------------------------------------------------ one ask, from the words to the merge
  private async make(ask: AskRecord, place: Place): Promise<void> {
    const repos = this.fm.repos;
    const open: string[] = [];                // working copies to put away at the end
    let lead: string | undefined;
    try {
      // ---- the lead plans (it reads; its one writable file is the plan, which is the town's and is never merged)
      ask.status = 'planning';
      lead = await this.agentFor(undefined, (id) => this.fm.agent(id)?.role === 'lead');
      ask.lead = lead; ask.working = [lead]; this.save();
      const leadWt = await repos.createWorktree(this.repoId, lead, { id: this.taskId(ask, 'plan'), title: 'plan' });
      open.push(leadWt.id);
      await this.checks.prepare(leadWt.path);            // (dependencies too: the lead may read a library's types)
      const readPlan = (): { plan?: Plan; why: string } => {
        const file = path.join(leadWt.path, PLAN_FILE);
        if (!fs.existsSync(file)) return { why: `${PLAN_FILE} has not been written` };
        let raw: unknown;
        try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { why: `${PLAN_FILE} is not JSON: ${(e as Error).message}` }; }
        const got = checkPlan(raw, this.map, (f) => fs.existsSync(path.join(leadWt.path, f)));
        if (!got.plan) return { why: got.problems.join('\n') };
        const room = STEPS[1] as (typeof STEPS)[number];
        const noLot = got.plan.modules.filter((m) => m.new && !freeLot(this.layout, { id: m.module, name: boardName(m.module, this.map.repo), quarter: quarterForNew(this.map, m.module) ?? '', wide: room.wide, deep: room.deep, high: room.high, step: 1, lines: 0 }, slugOf(m.module))).map((m) => m.module);
        return noLot.length ? { why: `There is no free lot in the town for ${noLot.join(', ')}: the quarter it would join is full. Put that code in an existing module instead.` } : { plan: got.plan, why: '' };
      };
      const planRule = (rel: string): string | undefined => (rel.split(path.sep).join('/') === PLAN_FILE ? undefined : `the lead writes ${PLAN_FILE} at the top of the working copy and nothing else`);
      const planCheck = async (): Promise<string> => { const got = readPlan(); return got.plan ? `The plan can be worked from: ${got.plan.modules.length} module${got.plan.modules.length === 1 ? '' : 's'}; ${waves(got.plan).map((x) => x.join(' and ')).join(', then ')}.` : `The plan cannot be worked from yet:\n${got.why}`; };
      const verifyPlan = async (): Promise<{ plan?: Plan; why: string }> => {
        const stray = (await git(leadWt.path, ['status', '--porcelain', '-z', '--untracked-files=all'])).stdout.split('\0').filter((l) => l.length > 3).map((l) => l.slice(3)).filter((f) => planRule(f));
        if (stray.length) return { why: `files other than ${PLAN_FILE} were written (the lead changes nothing in the product): ${stray.join(', ')}` };
        return readPlan();
      };
      await this.job(ask, undefined, 'plan', lead, leadWt.path, leadBrief(ask.text, place.name, this.map), planRule, planCheck);
      let got = await verifyPlan();
      if (!got.plan) { this.note(ask, `plan sent back: ${got.why.split('\n')[0]}`); await this.job(ask, undefined, 'plan', lead, leadWt.path, { ...leadBrief(ask.text, place.name, this.map), prompt: `${leadBrief(ask.text, place.name, this.map).prompt}\n\nYOUR PLAN WAS SENT BACK. This is what was wrong:\n${got.why}\nCorrect ${PLAN_FILE} and hand in again.` }, planRule, planCheck, got.why); got = await verifyPlan(); }
      if (!got.plan) return this.fail(ask, `it could not be planned: ${got.why}`);
      const plan = ask.plan = got.plan;
      // a new module gets a lot of its own in its quarter, where its building will rise as its code is written
      for (const m of plan.modules.filter((x) => x.new)) {
        const mod = this.addModule(m.module, 0), room = STEPS[1] as (typeof STEPS)[number];
        const taken = new Set(this.places.places.map((x) => x.id));
        let place = slugOf(m.module); for (let n = 2; taken.has(place); n++) place = `${slugOf(m.module).slice(0, 31)}-${n}`;
        const lot = freeLot(this.layout, { ...mod, step: 1, wide: room.wide, deep: room.deep, high: room.high }, place);
        if (!lot) return this.fail(ask, `there is no free lot in the quarter of ${m.module} for its building`);
        this.setPlots([...this.layout.plots, lot]);
        (this.data.built as NonNullable<CodeData['built']>)[m.module] = { stage: 'lot', step: 1, lines: 0 };
        this.drawer.lot(lot);
        this.note(ask, `${m.module} is new: a lot is kept for it in ${lot.quarter} (${lot.side} side)`);
        this.rec.write('lot', { ask: ask.id, module: m.module, place: lot.place, quarter: lot.quarter, side: lot.side, x0: lot.x0, x1: lot.x1 });
      }
      for (const m of plan.modules) ask.modules[m.module] = { module: m.module, place: (this.plot(m.module) as Plot).place, status: 'planned', working: [], lamps: {}, added: 0, removed: 0, repairs: 0 };
      this.note(ask, `planned over ${plan.modules.length} modules: ${waves(plan).map((x) => x.join(' and ')).join(', then ')}`);
      this.rec.write('plan', { ask: ask.id, by: this.name(lead), plan, waves: waves(plan) });
      this.letGo(lead); lead = undefined;
      ask.status = 'working'; this.save();

      // ---- the staging branch: where the modules' branches meet, one at a time, before anything reaches the product
      const base = await gitOut(this.repoPath, ['rev-parse', `refs/heads/${this.branch}`]);
      const staging = await repos.createWorktree(this.repoId, 'town', { id: this.taskId(ask, 'staging'), title: 'staging' });
      open.push(staging.id);
      ask.staging = { worktree: staging.id, dir: staging.path, branch: staging.branch };
      const ready = await this.checks.prepare(staging.path, { scrub: false });
      if (!ready.ok) return this.fail(ask, `the staging copy's dependencies could not be put in place: ${ready.output.split('\n').slice(-2).join(' ')}`);

      // ---- wave by wave
      const doneModules: string[] = [];
      for (const wave of waves(plan)) {
        const results = await Promise.all(wave.map((id) => this.workModule(ask, plan, plan.modules.find((m) => m.module === id) as PlanModule, staging.branch, [...doneModules], open)));
        const bad = wave.filter((_, i) => !results[i]);
        if (bad.length) return this.fail(ask, `${bad.join(', ')}: ${ask.modules[bad[0] as string]?.failure ?? 'not finished'}`);
        // merged one at a time into staging, the whole check after each
        ask.status = 'checking'; this.save();
        for (const id of wave) {
          const w = ask.modules[id] as ModuleWork, entry = plan.modules.find((m) => m.module === id) as PlanModule;
          let staged = await this.stage(ask, w, entry, staging.path);
          if (!staged.ok && w.repairs < 2 && w.changeBy) {
            // what failed with the rest goes back to the change's writer once, in a working copy of the combined code
            w.repairs++; this.note(ask, `${id}: the whole check failed with the rest; one repair`);
            const fixed = await this.repair(ask, plan, entry, w, staging.branch, doneModules, staged.why, open);
            staged = fixed ? await this.stage(ask, w, entry, staging.path) : staged;
          }
          if (!staged.ok) { w.status = 'failed'; w.failure = staged.why.split('\n')[0]?.slice(0, 200); return this.fail(ask, `${id} did not pass the whole check with the rest: ${staged.why}`); }
          w.status = 'staged'; this.save();
        }
        doneModules.push(...wave);
        ask.status = 'working'; this.save();
      }

      // ---- ready: the whole check has passed on exactly what would be merged; the person decides
      const stat = await this.delta(staging.path, base);
      const head = await gitOut(staging.path, ['rev-parse', 'HEAD']);
      ask.status = 'ready';
      const decision = this.fm.decisions.create({ agentId: ask.lead as string, kind: 'merge', question: `Merge "${short(ask.text, 80)}" into ${this.branch}? Every check passed on it: +${stat.added} -${stat.removed} lines over ${plan.modules.length} modules.`, options: ['Merge', 'Not yet'], repoId: this.repoId, worktree: staging.id });
      ask.decision = decision.id;
      this.note(ask, `ready to merge (${head.slice(0, 8)}): every check passed; waiting for the person's approval (decision ${decision.id})`);
      this.rec.write('ready', { ask: ask.id, commit: head, added: stat.added, removed: stat.removed, decision: decision.id });
      this.save();
      const gate = await new Promise<string>((resolve) => this.approvals.push(resolve));
      if (this.closed) return;

      // ---- the merge: RepoManager's guarded merge of the staging branch into the town branch (never pushed)
      ask.status = 'merging'; this.save();
      this.rec.write('approved', { ask: ask.id, gate, decision: decision.id });
      this.note(ask, `approved at ${gate}`);
      const answered = this.fm.decisions.answer(decision.id, 'Merge');
      const res = await repos.merge(answered, { commitMessage: `${ask.text} (ask ${ask.id})` });
      open.splice(open.indexOf(staging.id), 1);
      const after = await gitOut(this.repoPath, ['rev-parse', `refs/heads/${this.branch}`]);
      const numstat = (await git(this.repoPath, ['diff', '--shortstat', base, after])).stdout;
      const added = Number(/(\d+) insertion/.exec(numstat)?.[1] ?? 0), removed = Number(/(\d+) deletion/.exec(numstat)?.[1] ?? 0);
      for (const w of Object.values(ask.modules)) w.status = 'merged';
      this.note(ask, `merged into ${this.branch} (${res.sha}): +${added} -${removed} lines in ${res.files} files`);
      this.save();
      // the town as the branch now stands: new modules' buildings are built whole, buildings that crossed a step grow
      await this.remap();
      // the whole check on the branch as it now stands, and the map read again from it
      this.checking = { what: this.branch, step: 'starting', done: 0, of: this.steps.length };
      const final = await this.checks.whole(this.repoPath, this.steps, (s) => { this.checking = { what: this.branch, step: s.name, done: (this.checking?.done ?? 0) + 1, of: this.steps.length }; this.afterChange(); });
      this.checking = undefined;
      if (final.tests) this.takeLamps(final.tests);
      ask.merge = { sha: after, added, removed, files: res.files, tests: final.tests?.passed ?? 0, testFiles: final.tests?.files.length ?? 0, at: this.fm.ctx.now() };
      this.rec.write('merged', { ask: ask.id, branch: this.branch, commit: after, added, removed, files: res.files, tests: final.tests?.passed ?? 0, testsTotal: final.tests?.total ?? 0, wholeCheck: final.ok, steps: final.steps.map((s) => ({ name: s.name, ok: s.ok, seconds: Math.round(s.seconds * 10) / 10 })) });
      if (!final.ok) this.note(ask, `AFTER THE MERGE the whole check did not pass on ${this.branch}:\n${describeWhole(final)}`);
      ask.status = 'done'; ask.doneAt = this.fm.ctx.now();
      this.save();
    } catch (e) {
      this.log.error(`ask ${ask.id}: ${(e as Error).stack ?? e}`);
      this.fail(ask, (e as Error).message);
    } finally {
      if (lead) this.letGo(lead);
      for (const w of Object.values(ask.modules)) { w.dir = undefined; }
      for (const id of open) await repos.abandon(this.repoId, id, `${ask.id}: put away`).catch((e) => this.log.warn(`code town: ${id}: ${(e as Error).message}`));
      if (ask.status === 'failed' && ask.decision) this.fm.decisions.cancel(ask.decision, 'the change was stopped');
      this.rec.write('ask-end', { ask: ask.id, status: ask.status, sessions: ask.sessions, failure: ask.failure ?? null, ledger: this.worker?.sessions() ?? null });
      this.save();
    }
  }

  /** One module: its tests first by one agent, then its change by another. True when the change passes. */
  private async workModule(ask: AskRecord, plan: Plan, entry: PlanModule, startPoint: string, done: string[], open: string[]): Promise<boolean> {
    const repos = this.fm.repos, w = ask.modules[entry.module] as ModuleWork, mod = this.moduleOf(entry.module) as MapModule, slug = slugOf(entry.module);
    let agent: string | undefined;
    try {
      // ---- the tests, first
      agent = await this.agentFor();
      w.testsBy = agent; w.status = 'tests'; w.working = [agent]; this.save();
      const t = await repos.createWorktree(this.repoId, agent, { id: this.taskId(ask, `${slug}-t`), title: `${entry.module} tests` }, { startPoint });
      open.push(t.id);
      w.worktree = t.id; w.dir = t.path; w.branch = t.branch; w.from = await gitOut(t.path, ['rev-parse', 'HEAD']); this.save();
      const prep = await this.checks.prepare(t.path);
      if (!prep.ok) { w.status = 'failed'; w.failure = 'its working copy could not be made ready'; return false; }
      const existed = new Set((await git(t.path, ['ls-files', '-z'])).stdout.split('\0').filter(Boolean));
      const testsRule = (rel: string): string | undefined => {
        const p = rel.split(path.sep).join('/');
        if (entry.tests.includes(p)) return undefined;
        if (classify(p) === 'test' && existed.has(p) && !plan.modules.some((m) => m.tests.includes(p))) return undefined;      // an existing test this change makes wrong
        return `the tests of ${entry.module} are ${entry.tests.join(', ')}; nothing else is yours to write (an existing test file may be corrected)`;
      };
      const runTests = async (): Promise<string> => {
        const run = await this.checks.tests(t.path);
        this.readTests(w, entry, run, await this.touchedTests(t.path, w.from as string, entry));
        return describeTests(run);
      };
      const verifyTests = async (): Promise<{ ok: boolean; why: string }> => {
        const dirty = (await git(t.path, ['status', '--porcelain', '-z', '--untracked-files=all'])).stdout.split('\0').filter((l) => l.length > 3).map((l) => l.slice(3));
        const stray = dirty.filter((f) => testsRule(f));
        if (stray.length) return { ok: false, why: `files that are not this module's tests were written: ${stray.join(', ')}` };
        await this.commit(t.path, `Tests for ${entry.module}: ${entry.sign || short(entry.does, 60)}`, w.testsBy as string);
        const missing = entry.tests.filter((f) => !fs.existsSync(path.join(t.path, f)));
        if (missing.length) return { ok: false, why: `the plan's test file${missing.length === 1 ? '' : 's'} ${missing.join(', ')} ${missing.length === 1 ? 'was' : 'were'} not written` };
        const run = await this.checks.tests(t.path);
        if (!run.ran) return { ok: false, why: `the tests could not be run:\n${run.error ?? ''}` };
        const touched = await this.touchedTests(t.path, w.from as string, entry);
        this.readTests(w, entry, run, touched);
        const failing = run.files.filter((f) => !f.ok).map((f) => f.file);
        const outside = failing.filter((f) => !touched.includes(f));
        if (outside.length) return { ok: false, why: `tests that are not yours fail now: ${outside.join(', ')}. Your tests must fail and nothing else:\n${describeTests(run)}` };
        const passing = entry.tests.filter((f) => !failing.includes(f));
        if (passing.length) return { ok: false, why: `${passing.join(', ')} ${passing.length === 1 ? 'passes' : 'pass'} already, before the change exists: ${passing.length === 1 ? 'it proves' : 'they prove'} nothing. Each test file of the plan must fail until this module does its part.` };
        this.rec.write('tests-red', { ask: ask.id, module: entry.module, by: this.name(w.testsBy), files: touched, failing: w.failing, tests: w.tests });
        this.note(ask, `${entry.module}: tests accepted (${w.failing} failing in ${failing.length} file${failing.length === 1 ? '' : 's'}, as they should; every other test passes)`);
        return { ok: true, why: '' };
      };
      await this.job(ask, w, 'checks', agent, t.path, testsBrief(ask.text, plan, entry, mod, done), testsRule, runTests);
      let tests = await verifyTests();
      if (!tests.ok) { w.repairs++; this.note(ask, `${entry.module}: tests sent back: ${tests.why.split('\n')[0]}`); await this.job(ask, w, 'checks', agent, t.path, testsBrief(ask.text, plan, entry, mod, done, tests.why), testsRule, runTests, tests.why); tests = await verifyTests(); }
      this.letGo(agent); agent = undefined;
      if (!tests.ok) { w.status = 'failed'; w.failure = `its tests could not be written: ${tests.why.split('\n')[0]}`.slice(0, 200); this.save(); return false; }
      w.status = 'red'; w.file = undefined; this.save();
      const testsCommit = await gitOut(t.path, ['rev-parse', 'HEAD']);

      // ---- the change, by another agent, in a working copy that begins where the tests end
      agent = await this.agentFor(w.testsBy);
      w.changeBy = agent; w.working = [agent]; this.save();
      await repos.abandon(this.repoId, t.id, `${ask.id}: tests of ${entry.module}`); open.splice(open.indexOf(t.id), 1);
      const c = await repos.createWorktree(this.repoId, agent, { id: this.taskId(ask, `${slug}-c`), title: `${entry.module} change` }, { startPoint: t.branch });
      open.push(c.id);
      w.worktree = c.id; w.dir = c.path; w.branch = c.branch; w.status = 'change'; w.added = 0; w.removed = 0; this.save();
      if (!(await this.checks.prepare(c.path)).ok) { w.status = 'failed'; w.failure = 'its working copy could not be made ready'; return false; }
      const changeRule = (rel: string): string | undefined => {
        const p = rel.split(path.sep).join('/');
        if (classify(p) === 'test') return 'the tests are not the change writer\'s to touch';
        return moduleOfPath(this.map, p)?.id === entry.module ? undefined : `the change to ${entry.module} is written inside ${entry.module} only`;
      };
      const typecheck = this.steps.find((s) => /\btsc\b|typecheck|type-check/.test(s.run));
      const runAll = async (): Promise<{ ok: boolean; text: string; run: TestRun }> => {
        const tc = typecheck ? await this.checks.step(c.path, typecheck.name, typecheck.run) : undefined;
        const run = await this.checks.tests(c.path);
        this.readTests(w, entry, run, await this.touchedTests(c.path, w.from as string, entry));
        const ok = (tc?.ok ?? true) && run.ok;
        return { ok, run, text: [tc ? (tc.ok ? `The type check passes.` : `THE TYPE CHECK FAILS:\n${tc.output}`) : '', describeTests(run)].filter(Boolean).join('\n\n') };
      };
      const verifyChange = async (): Promise<{ ok: boolean; why: string }> => {
        const dirty = (await git(c.path, ['status', '--porcelain', '-z', '--untracked-files=all'])).stdout.split('\0').filter((l) => l.length > 3).map((l) => l.slice(3));
        const stray = [...dirty, ...(await this.changed(c.path, testsCommit))].filter((f) => changeRule(f));
        if (stray.length) return { ok: false, why: `files outside ${entry.module} (or tests) were changed: ${[...new Set(stray)].join(', ')}. Put them back as they were: only this module is yours.` };
        await this.commit(c.path, `${entry.module}: ${entry.sign || short(entry.does, 64)}`, w.changeBy as string);
        if (!(await this.changed(c.path, testsCommit)).length) return { ok: false, why: 'nothing was changed' };
        const all = await runAll();
        if (!all.ok) return { ok: false, why: all.text };
        const d = await this.delta(c.path, w.from as string); w.added = d.added; w.removed = d.removed;
        this.rec.write('change-green', { ask: ask.id, module: entry.module, by: this.name(w.changeBy), added: w.added, removed: w.removed, tests: all.run.passed, files: await this.changed(c.path, testsCommit) });
        this.note(ask, `${entry.module}: the change passes (type check, ${all.run.passed} tests): +${w.added} -${w.removed} lines`);
        return { ok: true, why: '' };
      };
      await this.job(ask, w, 'build', agent, c.path, changeBrief(ask.text, plan, entry, mod, done), changeRule, async () => (await runAll()).text);
      let change = await verifyChange();
      if (!change.ok && w.repairs < 2) { w.repairs++; this.note(ask, `${entry.module}: the change was sent back: ${change.why.split('\n')[0]}`); await this.job(ask, w, 'build', agent, c.path, changeBrief(ask.text, plan, entry, mod, done, change.why), changeRule, async () => (await runAll()).text, change.why); change = await verifyChange(); }
      this.letGo(agent); agent = undefined;
      if (!change.ok) { w.status = 'failed'; w.failure = `its change did not pass: ${change.why.split('\n')[0]}`.slice(0, 200); this.save(); return false; }
      w.status = 'green'; w.file = undefined;
      await repos.abandon(this.repoId, c.id, `${ask.id}: change to ${entry.module}`); open.splice(open.indexOf(c.id), 1);
      w.dir = undefined; this.save();
      return true;
    } catch (e) {
      this.log.error(`ask ${ask.id}, ${entry.module}: ${(e as Error).stack ?? e}`);
      w.status = 'failed'; w.failure = (e as Error).message.split('\n')[0]?.slice(0, 200); this.save();
      return false;
    } finally { if (agent) this.letGo(agent); w.working = []; }
  }

  /** Test files a module's agents have added or changed since its work began (its plan's files among them). */
  private async touchedTests(dir: string, from: string, entry: PlanModule): Promise<string[]> {
    const names = new Set(entry.tests);
    for (const f of (await git(dir, ['diff', '--name-only', '-z', from], { allowFail: true })).stdout.split('\0')) if (f && classify(f) === 'test') names.add(f);
    for (const f of (await git(dir, ['ls-files', '--others', '--exclude-standard', '-z'], { allowFail: true })).stdout.split('\0')) if (f && classify(f) === 'test') names.add(f);
    return [...names].sort();
  }
  /** A module's lamps from a run of the tests in its working copy: its own test files, and any other file that now fails and covers it. */
  private readTests(w: ModuleWork, entry: PlanModule, run: TestRun, touched: string[]): void {
    if (!run.ran) return;
    const byFile = new Map(run.files.map((f) => [f.file, f]));
    for (const f of touched) { const r = byFile.get(f); w.lamps[f] = r ? (r.ok ? 'lit' : 'red') : 'red'; }
    // its own tests, counted: how many there are and how many fail now
    const mine = touched.map((f) => byFile.get(f)).filter((r): r is NonNullable<typeof r> => !!r);
    w.failing = mine.reduce((n, r) => n + r.failed, 0); w.tests = mine.reduce((n, r) => n + Math.max(r.tests, r.failed), 0);
    void entry;
    this.afterChange();
  }

  /** Merge one module's branch into the staging copy and run the repository's whole CI on the result. */
  private async stage(ask: AskRecord, w: ModuleWork, entry: PlanModule, dir: string): Promise<{ ok: boolean; why: string }> {
    const before = await gitOut(dir, ['rev-parse', 'HEAD']);
    const m = await git(dir, ['merge', '-q', '--no-ff', '-m', `Merge ${entry.module}: ${entry.sign || short(entry.does, 60)} (ask ${ask.id})`, w.branch as string], { env: TOWN, allowFail: true });
    if (m.code !== 0) { await git(dir, ['merge', '--abort'], { allowFail: true }); return { ok: false, why: `it could not be combined with the rest: ${(m.stderr || m.stdout).trim().split('\n').slice(-2).join(' ')}` }; }
    // the repository's own generators the profile names (OVERWORLD_MECHANICAL: package scripts, comma
    // separated; none by default), as labelled mechanical commits when they have something to say
    for (const script of (process.env.OVERWORLD_MECHANICAL ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }; } catch { return {}; } })();
      if (!pkg.scripts?.[script]) continue;
      const g = await this.checks.step(dir, script, `pnpm ${script}`);
      if (!g.ok) return this.unstage(dir, before, `the repository's own generator "${script}" failed:\n${g.output}`);
      await git(dir, ['add', '-A']);
      if ((await git(dir, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim().length) {
        await git(dir, ['commit', '-q', '--no-verify', '-m', `Mechanical: pnpm ${script} after ${entry.module} (the repository's own generator, run by the town; no agent wrote this)`], { env: TOWN });
        this.rec.write('mechanical', { ask: ask.id, module: entry.module, script });
        this.note(ask, `mechanical commit: pnpm ${script} after ${entry.module}`);
      }
    }
    this.checking = { what: entry.module, step: 'starting', done: 0, of: this.steps.length };
    let whole: WholeCheck;
    try { whole = await this.checks.whole(dir, this.steps, (s, tests) => { this.checking = { what: entry.module, step: s.name, done: (this.checking?.done ?? 0) + 1, of: this.steps.length }; if (tests) for (const f of tests.files) if (f.file in w.lamps || !f.ok) w.lamps[f.file] = f.ok ? 'lit' : 'red'; this.afterChange(); }); }
    finally { this.checking = undefined; }
    this.rec.write('staged', { ask: ask.id, module: entry.module, ok: whole.ok, tests: whole.tests?.passed ?? 0, steps: whole.steps.map((s) => ({ name: s.name, ok: s.ok, seconds: Math.round(s.seconds * 10) / 10 })) });
    if (!whole.ok) return this.unstage(dir, before, describeWhole(whole));
    this.note(ask, `${entry.module}: merged into staging; the whole check passes (${whole.steps.length} steps, ${whole.tests?.passed ?? 0} tests)`);
    return { ok: true, why: '' };
  }
  /** Put the staging copy back as it was before a merge that did not pass (it is the town's own branch). */
  private async unstage(dir: string, before: string, why: string): Promise<{ ok: boolean; why: string }> {
    await git(dir, ['reset', '-q', '--hard', before], { allowFail: true });
    return { ok: false, why };
  }
  /** What failed with the rest goes back to the change's writer, in a working copy of the combined code. */
  private async repair(ask: AskRecord, plan: Plan, entry: PlanModule, w: ModuleWork, startPoint: string, done: string[], why: string, open: string[]): Promise<boolean> {
    const repos = this.fm.repos, agent = w.changeBy as string, mod = this.moduleOf(entry.module) as MapModule;
    if (this.busyAgents.has(agent)) return false;
    this.busyAgents.add(agent);
    try {
      // the module's own branch, with the rest brought into it
      const c = await repos.createWorktree(this.repoId, agent, { id: this.taskId(ask, `${slugOf(entry.module)}-r`), title: `${entry.module} repair` }, { startPoint: w.branch });
      open.push(c.id);
      const m = await git(c.path, ['merge', '-q', '--no-edit', startPoint], { env: TOWN, allowFail: true });
      if (m.code !== 0) { await git(c.path, ['merge', '--abort'], { allowFail: true }); return false; }
      if (!(await this.checks.prepare(c.path)).ok) return false;
      const from = await gitOut(c.path, ['rev-parse', 'HEAD']);
      w.worktree = c.id; w.dir = c.path; w.branch = c.branch; w.status = 'change'; this.save();
      const rule = (rel: string): string | undefined => { const p = rel.split(path.sep).join('/'); if (classify(p) === 'test') return 'the tests are not the change writer\'s to touch'; return moduleOfPath(this.map, p)?.id === entry.module ? undefined : `the change to ${entry.module} is written inside ${entry.module} only`; };
      const whole = async (): Promise<WholeCheck> => this.checks.whole(c.path, this.steps);
      await this.job(ask, w, 'build', agent, c.path, changeBrief(ask.text, plan, entry, mod, done, `Your change passed its own tests, but with the other modules' changes the repository's whole check fails:\n${why}`), rule, async () => describeWhole(await whole()), why);
      const stray = (await git(c.path, ['status', '--porcelain', '-z', '--untracked-files=all'])).stdout.split('\0').filter((l) => l.length > 3).map((l) => l.slice(3)).filter((f) => rule(f));
      if (stray.length) return false;
      await this.commit(c.path, `${entry.module}: repair after the whole check`, agent);
      void from;
      await repos.abandon(this.repoId, c.id, `${ask.id}: repair of ${entry.module}`); open.splice(open.indexOf(c.id), 1);
      w.dir = undefined; w.status = 'green';
      return true;
    } finally { this.letGo(agent); w.working = []; }
  }

  // ------------------------------------------------------------------ approval: one action in the town
  private leverUsed(part: string, player: string): void {
    const gate = this.layout.gates.find((g) => gatePart(g) === part);
    if (!gate) return;
    const ask = this.current();
    this.log.info(`code town: the lever on the gate of ${gate.name} was used by ${player || 'the person'}${ask?.status === 'ready' ? '' : ' (nothing is waiting for approval)'}`);
    if (ask?.status !== 'ready') return;
    this.drawer.lever(gate, true);
    setTimeout(() => this.drawer.lever(gate, false), 4000).unref?.();
    for (const a of this.approvals.splice(0)) a(gate.name);
  }

  // ------------------------------------------------------------------ after a merge
  /**
   * Read the map again from the branch as it stands (lines, tests, imports), and bring the town to it where it stands:
   * a new module's building is built whole at the size its lines make; a building whose lines crossed a step of the
   * size rule is built again a step larger (or smaller) about its door. Nothing else moves: a module that has no
   * building (one made outside the town) waits until the town is laid out again.
   */
  private async remap(): Promise<void> {
    try {
      const fresh = await mapRepository(this.repoPath, { repoName: this.map.repo });
      let plots = [...this.layout.plots];
      const raised: Array<[Plot, Plot]> = [], grown: Array<{ module: string; from: number; to: number; lines: number }> = [];
      for (const p of this.layout.plots) {
        const m = fresh.modules.find((x) => x.id === p.module), b = this.data.built?.[p.module];
        if (b && b.stage !== 'built') {
          const counted = m ? { lines: m.lines, files: m.files } : this.linesUnder(this.repoPath, p.module);
          const step = stepFor(counted.lines), now = grownPlot({ ...this.layout, plots }, p, step, counted.lines);
          plots = plots.map((x) => (x.place === p.place ? now : x)); raised.push([p, now]);
          (this.data.built as NonNullable<CodeData['built']>)[p.module] = { stage: 'built', step, lines: counted.lines };
          grown.push({ module: p.module, from: -1, to: step, lines: counted.lines });
        } else if (m && stepFor(m.lines) !== p.step) {
          const step = stepFor(m.lines), now = grownPlot({ ...this.layout, plots }, p, step, m.lines);
          plots = plots.map((x) => (x.place === p.place ? now : x)); raised.push([p, now]);
          grown.push({ module: p.module, from: p.step, to: step, lines: m.lines });
          this.log.info(`code town: ${m.id} is now ${m.lines} lines: it is built again a step ${step > p.step ? 'larger' : 'smaller'}, where it stands`);
        }
      }
      const waiting = fresh.modules.filter((m) => !plots.some((p) => p.module === m.id)).map((m) => m.id);
      if (waiting.length) this.log.info(`code town: modules with no building until the town is laid out again: ${waiting.join(', ')}`);
      // lines and tests are the branch's as it stands; places are the town's
      this.map = { ...fresh, modules: fresh.modules.filter((m) => plots.some((p) => p.module === m.id)) };
      for (const [id, b] of Object.entries(this.data.built ?? {})) if (!this.moduleOf(id)) { const c = this.linesUnder(this.repoPath, id); this.addModule(id, c.lines || b.lines, c.files); }
      this.setPlots(plots);
      this.fileLines.clear(); this.restScreens.clear();
      for (const [was, now] of raised) this.drawer.raise(was, now, 3);
      fs.writeFileSync(path.join(this.townDir, 'map-after.json'), `${JSON.stringify(fresh, null, 1)}\n`);
      this.rec.write('remap', { commit: fresh.commit, lines: fresh.totals.lines, tests: fresh.totals.tests, grown, waiting, modules: fresh.modules.map((m) => ({ id: m.id, lines: m.lines, tests: m.tests.length })) });
      this.afterChange();
    } catch (e) { this.log.warn(`code town: the map could not be read again: ${(e as Error).message}`); }
  }

  // ------------------------------------------------------------------ the sampler: what the working copies hold now
  private async sample(): Promise<void> {
    if (this.closed || this.sampling) return;
    const ask = this.current();
    if (!ask) return;
    this.sampling = true;
    try {
      let changed = false;
      for (const w of Object.values(ask.modules)) {
        if (!w.dir || !w.from || !fs.existsSync(w.dir) || !['tests', 'change'].includes(w.status)) continue;
        const d = await this.delta(w.dir, w.from);
        // the file an agent is at, from what it says it is doing ("editing features/shop/copy.ts")
        const act = w.working[0] ? this.fm.agent(w.working[0])?.activity ?? '' : '';
        const file = /(?:editing|writing|reading)\s+(\S+\.\w+)/.exec(act)?.[1];
        if (d.added !== w.added || d.removed !== w.removed || (file && file !== w.file)) { w.added = d.added; w.removed = d.removed; if (file) w.file = file; changed = true; }
        const p = this.plot(w.module);
        if (!p) continue;
        // the screen inside: the code being written, as the working copy holds it now
        const screen = await this.workScreen(w, p);
        if (screen !== w.screen) { w.screen = screen; changed = true; }
        // a new module's frame rises as its code is written: the size its lines make so far
        const b = this.data.built?.[w.module];
        if (b && w.status === 'change') {
          const { lines, files } = this.linesUnder(w.dir, w.module);
          if (lines > 0 && (b.stage === 'lot' || stepFor(lines) !== b.step)) {
            const step = stepFor(lines), now = grownPlot(this.layout, p, step, lines);
            this.addModule(w.module, lines, files);
            this.setPlots(this.layout.plots.map((x) => (x.place === p.place ? now : x)));
            this.drawer.frame(p, now, files.length);
            (this.data.built as NonNullable<CodeData['built']>)[w.module] = { stage: 'frame', step, lines };
            this.rec.write('frame', { ask: ask.id, module: w.module, lines, step, files: files.length });
            this.note(ask, `${w.module}: ${lines} lines written so far; its frame stands at step ${step}`);
            changed = true;
          } else if (lines > 0) b.lines = lines;
        }
      }
      if (changed) this.afterChange();
    } catch { /* a working copy went away between two looks */ } finally { this.sampling = false; }
  }
}
