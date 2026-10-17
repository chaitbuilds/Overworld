// Durable state. Everything the backend knows lives under `dir` (a profile directory inside
// OVERWORLD_HOME) and survives restarts:
//
//   <dir>/state.json            agents, decisions, repos, counters, the code town's record, the session count
//   <dir>/logs/<agentId>.jsonl  append-only agent logs (what each agent said and did); rotated at
//                               8 MB into <agentId>.1.jsonl (one old file kept)
//   <dir>/foreman.json          {pid, port, ...} of the backend running this profile (see runfile.ts)
//   <dir>/worktrees/<repo>/<wt> git worktrees the agents work in (see repos.ts)
//
// state.json is written atomically (temp + fsync + rename), debounced, and flushed on exit.
import fs from 'node:fs';
import path from 'node:path';
import type { Decision } from './decisions.js';
import type { Agent } from './protocol.js';
import type { Repo } from './repos.js';
import { ensureDir, readJson, writeJsonAtomic } from './util/fsx.js';

export type LogKind = 'text' | 'tool' | 'result' | 'error' | 'diff';
/** One line of an agent's log. `diff` entries use unified +/- line prefixes. */
export interface LogEntry {
  ts: number;
  kind: LogKind;
  text: string;
}

export interface WorktreeMeta {
  /** the merge commit, once the worktree's branch is merged */
  mergedSha?: string;
  createdAt: number;
  /** the directory of a finished worktree could not be removed yet (busy); retried later */
  pendingRemoval?: boolean;
}

export interface StateData {
  version: 1;
  createdAt: number;
  agents: Agent[];
  decisions: Decision[];
  repos: Repo[];
  counters: Record<string, number>;
  worktreeMeta: Record<string, WorktreeMeta>; // key: `${repoId}/${worktreeId}`
  /** opaque state owned by the code town and the agent runner (its record, the session count) */
  backend: Record<string, unknown>;
}

/** an agent log rotates at this size; one previous file (<agent>.1.jsonl) is kept */
export const LOG_MAX_BYTES = 8 * 1024 * 1024;

function emptyState(now: number): StateData {
  return {
    version: 1,
    createdAt: now,
    agents: [],
    decisions: [],
    repos: [],
    counters: {},
    worktreeMeta: {},
    backend: {},
  };
}

export class Store {
  readonly dir: string;
  readonly file: string;
  data: StateData;
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private logSizes = new Map<string, number>();
  private readonly debounceMs: number;
  private readonly logMaxBytes: number;

  constructor(dir: string, opts: { debounceMs?: number; now?: number; logMaxBytes?: number } = {}) {
    this.dir = path.resolve(dir);
    this.file = path.join(this.dir, 'state.json');
    this.debounceMs = opts.debounceMs ?? 100;
    this.logMaxBytes = opts.logMaxBytes ?? LOG_MAX_BYTES;
    ensureDir(this.dir);
    ensureDir(path.join(this.dir, 'logs'));
    const loaded = this.loadFile();
    this.data = loaded ?? emptyState(opts.now ?? Date.now());
    if (!loaded) this.flush();
  }

  private loadFile(): StateData | undefined {
    const decode = (file: string): StateData => {
      const d = readJson<StateData>(file);
      if (!d || d.version !== 1) throw new Error('Unreadable or unsupported state schema');
      for (const key of ['agents', 'decisions', 'repos'] as const) {
        if (!Array.isArray(d[key])) throw new Error(`Invalid state field ${key}`);
      }
      return { ...emptyState(d.createdAt ?? Date.now()), ...d };
    };
    if (!fs.existsSync(this.file)) {
      if (fs.existsSync(this.file + '.backup')) throw new Error('Primary state missing; preserve the profile and restore state.json.backup before starting.');
      return undefined;
    }
    try { return decode(this.file); }
    catch (error) {
      const bad = `${this.file}.corrupt-${Date.now()}`;
      fs.copyFileSync(this.file, bad);
      try {
        const recovered = decode(this.file + '.backup');
        // Preserve the validated backup through the first recovery flush.
        writeJsonAtomic(this.file, recovered);
        return recovered;
      } catch {
        throw new Error(`State recovery required: ${(error as Error).message}. Original preserved at ${bad}. Restore a validated state.json backup.`);
      }
    }
  }

  /** Allocate the next id for a counter, e.g. nextId('d') -> "d1", "d2"... */
  nextId(prefix: string): string {
    const n = (this.data.counters[prefix] ?? 0) + 1;
    this.data.counters[prefix] = n;
    this.markDirty();
    return `${prefix}${n}`;
  }

  markDirty(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (fs.existsSync(this.file)) writeJsonAtomic(this.file + '.backup', JSON.parse(fs.readFileSync(this.file, 'utf8')));
    writeJsonAtomic(this.file, this.data);
    this.dirty = false;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  // ---- logs -------------------------------------------------------------------------------

  logFile(agentId: string): string {
    return path.join(this.dir, 'logs', `${agentId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
  }

  private rotatedLogFile(agentId: string): string {
    return this.logFile(agentId).replace(/\.jsonl$/, '.1.jsonl');
  }

  appendLog(agentId: string, entries: LogEntry[]): void {
    if (!entries.length) return;
    const f = this.logFile(agentId);
    const data = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const bytes = Buffer.byteLength(data);
    let size = this.logSizes.get(agentId) ?? (fs.existsSync(f) ? fs.statSync(f).size : 0);
    if (size > 0 && size + bytes > this.logMaxBytes) {
      // rotate: keep one previous file, so the logs never grow without bound
      try {
        fs.rmSync(this.rotatedLogFile(agentId), { force: true });
        fs.renameSync(f, this.rotatedLogFile(agentId));
        size = 0;
      } catch {
        /* held open elsewhere: try again on a later append */
      }
    }
    fs.appendFileSync(f, data);
    this.logSizes.set(agentId, size + bytes);
  }

  close(): void {
    this.flush();
  }
}
