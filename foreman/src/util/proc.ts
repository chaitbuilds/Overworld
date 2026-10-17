// Child-process helpers. Everything is spawned with explicit argv (no shell) unless stated.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  /** Run through the platform shell (needed for npm/.cmd on Windows). `cmd` is then a full command line. */
  shell?: boolean;
  maxBuffer?: number;
}

/**
 * Kill a child we started together with everything it started (a shell's `npm test` and its
 * node grandchildren). Only ever targets our own child's PID and its descendants.
 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // taskkill /T walks the tree of *this* PID only
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGKILL'); // the child leads its own process group (detached)
    } catch {
      child.kill('SIGKILL');
    }
  }
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, opts.shell ? [] : args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: opts.shell ?? false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // POSIX: own process group, so a timeout can kill the whole tree
      ...(process.platform !== 'win32' && opts.shell ? { detached: true } : {}),
    });
    const max = opts.maxBuffer ?? 8 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      if (stdout.length < max) stdout += d;
    });
    child.stderr!.on('data', (d: string) => {
      if (stderr.length < max) stderr += d;
    });
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, opts.timeoutMs);
    }
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? (timedOut ? 124 : 1), stdout, stderr, timedOut });
    });
    if (opts.input !== undefined) child.stdin!.end(opts.input);
    else child.stdin!.end();
  });
}

/** Run a shell command line (the repository's CI steps and test commands). */
export function runShell(commandLine: string, opts: Omit<RunOptions, 'shell'> = {}): Promise<RunResult> {
  return run(commandLine, [], { ...opts, shell: true });
}
