// The backend's own checks on a working copy of the repository: the repository's CI, step for step, read from its
// workflow file and run here. No agent runs any of this; an agent only asks for it (run_checks) and reads the answer.
//
// What is run is repository code that agents may have edited (tests are code), so every command runs with git's
// transports disabled and a ceiling at the working copy's parent (gitsafety.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withGitSafety } from '../gitsafety.js';
import { git } from '../util/git.js';
import { runShell } from '../util/proc.js';
import { tailLines } from '../util/text.js';

export interface TestFile { file: string; ok: boolean; tests: number; failed: number; messages: string[] }
export interface TestRun { ran: boolean; ok: boolean; files: TestFile[]; total: number; passed: number; failed: number; seconds: number; error?: string }
export interface Step { name: string; command: string; ok: boolean; seconds: number; output: string }
export interface WholeCheck { ok: boolean; steps: Step[]; tests?: TestRun }
export interface CiStep { name: string; run: string }

const ENV = { CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', NEXT_TELEMETRY_DISABLED: '1' };
/** Commands run with the working copy's own tools first on the path (as a package script would have them). */
const env = (cwd: string): NodeJS.ProcessEnv => withGitSafety(process.env, { ...ENV, PATH: `${path.join(path.resolve(cwd), 'node_modules', '.bin')}${path.delimiter}${process.env.PATH ?? ''}` }, { ceiling: path.dirname(path.resolve(cwd)) });

/**
 * Files an agent must never be shown: any `.env*`, always, and the repository files the profile names
 * (OVERWORLD_HIDE: paths in the repository, comma separated; none by default).
 */
export const HIDDEN = (process.env.OVERWORLD_HIDE ?? '').split(',').map((s) => s.trim()).filter(Boolean);
export function unreadable(rel: string): string | undefined {
  const p = rel.split(path.sep).join('/');
  if (path.posix.basename(p).startsWith('.env')) return 'environment files are not yours to read';
  if (HIDDEN.includes(p)) return 'this file is hidden from agents and is not yours to read';
  return undefined;
}

/**
 * A CI line as it is run here. `pnpm <script>` (or `pnpm run`, `npm run`) is the package's own script, run as its
 * line says with the working copy's tools on the path; any other `pnpm` is the pinned one through corepack (so it runs
 * where pnpm is not installed globally).
 */
function shellLine(cwd: string, run: string): string {
  const scripts = (() => { try { return (JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {}; } catch { return {}; } })();
  const m = /^(?:pnpm|npm)\s+(?:run\s+)?([\w:.-]+)\s*$/.exec(run.trim());
  if (m && scripts[m[1] as string]) return scripts[m[1] as string] as string;
  return run.replace(/(^|&&\s*|;\s*)pnpm\s/g, '$1corepack pnpm ');
}

/** The CI's own steps, in order: every `run:` of the workflow that is not an install. */
export function ciSteps(repo: string): CiStep[] {
  const dir = path.join(repo, '.github', 'workflows');
  if (!fs.existsSync(dir)) return [];
  const file = ['ci.yml', 'ci.yaml', 'test.yml', 'tests.yml'].map((n) => path.join(dir, n)).find((f) => fs.existsSync(f)) ?? fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).map((n) => path.join(dir, n))[0];
  if (!file) return [];
  const out: CiStep[] = []; let name = '';
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const n = /^\s*-\s*name:\s*(.+?)\s*$/.exec(line); if (n) { name = (n[1] as string).replace(/^["']|["']$/g, ''); continue; }
    const r = /^\s*(?:-\s*)?run:\s*(.+?)\s*$/.exec(line);
    if (r && !/^\|/.test(r[1] as string)) {
      const run = (r[1] as string).replace(/^["']|["']$/g, '');
      if (!/\b(install|ci)\b/.test(run.split(/\s+/).slice(0, 3).join(' ')) || /check-/.test(run)) out.push({ name: name || run, run });
      name = '';
    }
    if (/^\s*-\s*uses:/.test(line)) name = '';
  }
  return out;
}

export class RepoChecks {
  constructor(private log: (line: string) => void = () => undefined) {}

  /**
   * Make a fresh working copy ready: its dependencies (from the local store, no network), and the hidden files
   * emptied of what they hide. A hidden file that other code imports must still be there for the type check, so it is
   * kept with every quoted string that holds an address replaced, and git is told not to look at it (it can then be
   * neither read for what it held nor committed as changed).
   */
  async prepare(cwd: string, opts: { scrub?: boolean } = {}): Promise<{ ok: boolean; seconds: number; output: string }> {
    const t0 = Date.now();
    if (opts.scrub !== false) for (const rel of HIDDEN) {
      const file = path.join(cwd, rel);
      if (!fs.existsSync(file)) continue;
      await git(cwd, ['update-index', '--skip-worktree', rel], { allowFail: true });
      try { fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/(['"`])[^'"`\n]*@[^'"`\n]*\1/g, '$1hidden@example.invalid$1')); } catch { /* left as it is: the read guard still refuses it */ }
    }
    if (!fs.existsSync(path.join(cwd, 'package.json'))) return { ok: true, seconds: 0, output: 'no package.json: nothing to install' };
    if (fs.existsSync(path.join(cwd, 'node_modules', '.modules.yaml')) || (fs.existsSync(path.join(cwd, 'node_modules')) && !fs.existsSync(path.join(cwd, 'pnpm-lock.yaml')))) return { ok: true, seconds: 0, output: 'dependencies already there' };
    const line = fs.existsSync(path.join(cwd, 'pnpm-lock.yaml')) ? 'corepack pnpm install --frozen-lockfile --offline' : 'npm ci --offline';
    const r = await runShell(line, { cwd, timeoutMs: 300_000, env: env(cwd) });
    const ok = r.code === 0 && !r.timedOut;
    if (!ok) this.log(`install failed in ${cwd}: ${tailLines(`${r.stdout}\n${r.stderr}`, 6, 600)}`);
    return { ok, seconds: (Date.now() - t0) / 1000, output: tailLines(`${r.stdout}\n${r.stderr}`, 12, 1200) };
  }

  /** Run the tests (all, or the files named) and say what each file did. */
  async tests(cwd: string, only?: string[]): Promise<TestRun> {
    const t0 = Date.now(), out = path.join(os.tmpdir(), `codetown-vitest-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }; } catch { return {}; } })();
    if (!/vitest/.test(pkg.scripts?.test ?? '')) {
      // not vitest: run the repository's own test command and take its exit code
      const r = await runShell(pkg.scripts?.test ?? 'npm test --silent', { cwd, timeoutMs: 600_000, env: env(cwd) });
      const ok = r.code === 0 && !r.timedOut;
      return { ran: true, ok, files: [], total: 0, passed: 0, failed: ok ? 0 : 1, seconds: (Date.now() - t0) / 1000, ...(ok ? {} : { error: tailLines(`${r.stdout}\n${r.stderr}`, 30, 2500) }) };
    }
    // (the working copy's own vitest, with a report of every file; the same run `vitest run` makes)
    const r = await runShell(`vitest run --reporter=json --outputFile=${JSON.stringify(out)} ${(only ?? []).map((f) => JSON.stringify(f)).join(' ')}`, { cwd, timeoutMs: 600_000, env: env(cwd) });
    let data: { numTotalTests?: number; numPassedTests?: number; numFailedTests?: number; testResults?: Array<{ name: string; status: string; message?: string; assertionResults?: Array<{ fullName: string; status: string; failureMessages?: string[] }> }> } | undefined;
    try { data = JSON.parse(fs.readFileSync(out, 'utf8')) as typeof data; } catch { data = undefined; } finally { fs.rmSync(out, { force: true }); }
    const seconds = (Date.now() - t0) / 1000;
    if (!data?.testResults) return { ran: false, ok: false, files: [], total: 0, passed: 0, failed: 0, seconds, error: tailLines(`${r.stdout}\n${r.stderr}`, 30, 2500) || 'the test runner wrote no report' };
    const root = fs.realpathSync(cwd);
    const files: TestFile[] = data.testResults.map((f) => {
      const cases = f.assertionResults ?? [], failed = cases.filter((c) => c.status === 'failed');
      const messages = [...(f.status === 'failed' && !failed.length ? [`the file did not load: ${(f.message ?? '').split('\n').slice(0, 4).join(' | ').slice(0, 400)}`] : []), ...failed.slice(0, 8).map((c) => `${c.fullName}: ${(c.failureMessages?.[0] ?? '').split('\n').slice(0, 3).join(' | ').slice(0, 400)}`)];
      return { file: path.relative(root, fs.existsSync(f.name) ? fs.realpathSync(f.name) : f.name).split(path.sep).join('/'), ok: f.status === 'passed', tests: cases.length, failed: failed.length + (f.status === 'failed' && !failed.length ? 1 : 0), messages };
    }).sort((a, b) => a.file.localeCompare(b.file));
    const failedFiles = files.filter((f) => !f.ok);
    return { ran: true, ok: failedFiles.length === 0 && r.code === 0, files, total: data.numTotalTests ?? 0, passed: data.numPassedTests ?? 0, failed: data.numFailedTests ?? failedFiles.length, seconds };
  }

  async step(cwd: string, name: string, command: string, timeoutMs = 600_000): Promise<Step> {
    const t0 = Date.now(), r = await runShell(shellLine(cwd, command), { cwd, timeoutMs, env: env(cwd) });
    return { name, command, ok: r.code === 0 && !r.timedOut, seconds: (Date.now() - t0) / 1000, output: tailLines(`${r.stdout}\n${r.stderr}${r.timedOut ? '\n(timed out; stopped)' : ''}`, 40, 3000) };
  }

  /**
   * The whole check: the CI's steps in order. The test step is run with a report of each file (so the lamps can
   * follow); every other step is run as written. All steps run even when one fails, so one answer names everything.
   */
  async whole(cwd: string, steps: CiStep[], onStep?: (s: Step, tests?: TestRun) => void): Promise<WholeCheck> {
    const done: Step[] = []; let tests: TestRun | undefined;
    for (const s of steps) {
      if (/\b(pnpm|npm)\s+(run\s+)?test\b|vitest/.test(s.run)) {
        tests = await this.tests(cwd);
        const step: Step = { name: s.name, command: s.run, ok: tests.ok, seconds: tests.seconds, output: describeTests(tests) };
        done.push(step); onStep?.(step, tests);
      } else { const step = await this.step(cwd, s.name, s.run); done.push(step); onStep?.(step); }
    }
    return { ok: done.every((s) => s.ok), steps: done, ...(tests ? { tests } : {}) };
  }
}

/** A test run in plain words, for an agent or a log. */
export function describeTests(t: TestRun, limit = 12): string {
  if (!t.ran) return `The tests could not be run:\n${t.error ?? ''}`;
  const bad = t.files.filter((f) => !f.ok);
  if (!bad.length) return `Every test passes: ${t.passed} tests in ${t.files.length} files${t.error ? `\n${t.error}` : ''}.`;
  return [`${t.failed} of ${t.total} tests fail, in ${bad.length} of ${t.files.length} files:`, ...bad.slice(0, limit).flatMap((f) => [`- ${f.file} (${f.failed} failing)`, ...f.messages.slice(0, 5).map((m) => `    ${m}`)]), ...(bad.length > limit ? [`(and ${bad.length - limit} more files)`] : []), ...(t.error ? [t.error] : [])].join('\n');
}
export function describeWhole(w: WholeCheck): string {
  return w.steps.map((s) => `${s.ok ? 'passed' : 'FAILED'}  ${s.name}${s.ok ? '' : `\n${s.output.split('\n').map((l) => `    ${l}`).join('\n')}`}`).join('\n');
}
