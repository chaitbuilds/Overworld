// Who does an ask's work. The code town (codetown/service.ts) decides what is to be done, by whom and what they may
// write; a worker carries one job out in its working copy: a real agent session (runner.ts). Only a worker can start
// an agent session.

export interface WorkRequest {
  askId: string;
  /** What the job is about, for the log: the module, or "plan". */
  part: string;
  /** 'plan': write the plan and nothing else. 'checks': write a module's tests. 'build': make the module's change. */
  role: 'plan' | 'checks' | 'build';
  agentId: string;
  /** The job's own working copy of the repository. */
  worktree: string;
  /** Set when the first hand-in was sent back: what was wrong with it. */
  repair?: string;
  /** For a path inside the worktree: why it may not be written, or undefined when it may. */
  allowed: (relativePath: string) => string | undefined;
  /** Run the job's checks on the worktree; the answer is text for the agent. */
  runChecks: () => Promise<string>;
  /** The job's own words: the whole prompt, the system words, what its two tools say they do, what the agent is shown doing as it starts. */
  brief: { prompt: string; system: string; server: string; runChecks: string; handIn: string; activity: string; starting: string };
  /** For a path inside the worktree: why it may not be READ, or undefined when it may (when not given, everything in the worktree may be read). */
  unreadable?: (relativePath: string) => string | undefined;
}
export interface WorkResult { ok: boolean; summary: string; error?: string }

export interface TownWorker {
  /** Whether a new ask may be taken on at all (session cap, auth). `sessions` is how many it will need at least (two unless said). */
  canStart(sessions?: number): { ok: boolean; why?: string };
  run(req: WorkRequest): Promise<WorkResult>;
  sessions(): { used: number; cap: number };
  stop(): Promise<void>;
}
