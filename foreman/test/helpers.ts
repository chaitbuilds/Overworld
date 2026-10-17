import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { silentLogger } from '../src/context.js';
import { Foreman } from '../src/foreman.js';
import { Notifier } from '../src/notifier.js';
import type { Outbound } from '../src/protocol.js';

export function tempDir(prefix = 'ac-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* windows may hold handles briefly */
  }
}

/** The files of the small repository the repo tests work on ("demo-app"). */
const DEMO_FILES: Record<string, string> = {
  'README.md': '# demo-app\n\nA tiny notes CLI.\n',
  'src/cli.ts': "import { list } from './notes.ts';\nimport { render } from './format.ts';\n\nconsole.log(render(list({})));\n",
  'src/notes.ts': 'export interface Note {\n  text: string;\n}\n\nexport interface ListOptions {\n  all?: boolean;\n}\n\nexport function list(_o: ListOptions): Note[] {\n  return [];\n}\n',
  'src/format.ts': "// Human-friendly rendering of notes for the terminal.\nimport type { Note } from './notes.ts';\n\nexport function render(notes: Note[]): string {\n  return notes.map((n) => `- ${n.text}`).join('\\n');\n}\n",
};

/**
 * A fresh git repository in a temp dir: `<tmp>/demo-app` on branch main, four commits by "Demo Author", whose own
 * git config names that author (merges approved in it are made as that user).
 */
export function makeRepo(): string {
  const dir = path.join(tempDir('ac-demo-'), 'demo-app');
  fs.mkdirSync(dir, { recursive: true });
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'Demo Author');
  g('config', 'user.email', 'demo@example.com');
  g('config', 'commit.gpgsign', 'false');
  const steps: Array<[string, string[]]> = [['Add README', ['README.md']], ['Notes model', ['src/notes.ts']], ['Terminal rendering', ['src/format.ts']], ['CLI entry point', ['src/cli.ts']]];
  for (const [message, files] of steps) {
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), DEMO_FILES[f]!);
    }
    g('add', '-A');
    g('commit', '-q', '-m', message);
  }
  return dir;
}

export function testConfig(home: string, args: string[] = []): Config {
  return loadConfig(['--home', home, '--no-notify', ...args], {});
}

export interface Harness {
  fm: Foreman;
  cfg: Config;
  home: string;
  events: Outbound[];
  notifier: Notifier;
  toasts: Array<{ title: string; body: string }>;
}

export function makeForeman(home: string, args: string[] = []): Harness {
  const cfg = testConfig(home, args);
  const toasts: Array<{ title: string; body: string }> = [];
  const notifier = new Notifier({
    enabled: true,
    minIntervalMs: 0,
    bell: false,
    spawnToast: async (title, body) => {
      toasts.push({ title, body });
      return true;
    },
  });
  const fm = new Foreman({ config: cfg, logger: silentLogger, notifier });
  const events: Outbound[] = [];
  fm.subscribe((m) => events.push(m));
  return { fm, cfg, home, events, notifier, toasts };
}

export async function until(cond: () => boolean, timeoutMs = 20_000, stepMs = 25): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
