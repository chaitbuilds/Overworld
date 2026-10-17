// Real agents for the code town: one Claude session for one job (an ask's plan, a module's tests, or its change).
//
// What bounds it:
//  - Every session is counted BEFORE it is dispatched, against OVERWORLD_MAX_SESSIONS. The count is kept in
//    state.json (backend.claude.sessionsStarted) and is written to disk at once, so it survives a restart. With no
//    cap set, nothing starts. A session resumed after a plan limit counts again.
//    When OVERWORLD_SESSION_LEDGER names a file, every session of every profile is counted there too, against
//    OVERWORLD_SESSION_LEDGER_CAP, before it is dispatched: one allowance for a whole piece of work, whatever the profile.
//  - Authentication is the backend's choice (agents/claude/auth.ts): an API key or cloud provider by default, the local
//    claude.ai login with --use-claude-login. On that login, a refused plan limit stops the session and waits for the
//    window to reset, and any sign of paid overage (usage beyond the plan) stops for good.
//  - An agent has file tools and two town tools, nothing else: no shell, no network, no sub-agents. Those few tools
//    are approved in advance and the session is started in the SDK's "dontAsk" mode, so NO PERMISSION PROMPT EXISTS:
//    nothing asks, and nothing answers on anyone's behalf. A fixed guard runs before every tool call and can only
//    refuse (a path outside the agent's checkout, a file its role may not write or read); it never approves anything.
//    What an agent wrote is judged again afterwards from the repository itself (codetown/service.ts).
import fs from 'node:fs';
import path from 'node:path';
import { createSdkMcpServer, query, tool, type HookCallback, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { withAuthMode } from '../agents/claude/auth.js';
import { agentEnv } from '../agents/claude/index.js';
import { StreamMapper } from '../agents/claude/stream.js';
import type { Foreman } from '../foreman.js';
import type { TownWorker, WorkRequest, WorkResult } from './worker.js';

export interface RunnerOptions {
  model: string;
  effort: Options['effort'];
  maxTurns: number;
  maxConcurrent: number;
  useClaudeLogin: boolean;
  /** Injected in tests: a scripted fake of the SDK. */
  queryFn?: typeof query;
  /** How long past the plan window's reset to wait before resuming (ms). */
  resumeMarginMs?: number;
}

const SESSION_TIMEOUT_MS = 40 * 60_000;
const TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'TodoWrite'];
const NEVER = ['Bash', 'BashOutput', 'KillShell', 'Task', 'Agent', 'WebSearch', 'WebFetch', 'NotebookEdit', 'MultiEdit'];
export const TOWN_SERVER = 'town';
/** Everything an agent can call, approved in advance. Nothing else exists for it, and nothing else is ever approved. */
export const APPROVED = [...TOOLS, `mcp__${TOWN_SERVER}__run_checks`, `mcp__${TOWN_SERVER}__hand_in`];
/** What the guard says of one tool call: nothing (it is within bounds), or why it is refused. */
export type Guard = (toolName: string, input: Record<string, unknown>) => string | undefined;

const RESUME = 'You were stopped part-way by a usage limit and may now go on. Look at the files as they are, finish the job you were given, run the checks, and hand in.';

/** One allowance of agent sessions for a whole piece of work, whatever the profile: a file every dispatch is counted in first. */
export class SessionLedger {
  readonly cap: number;
  constructor(readonly file: string | undefined = process.env.OVERWORLD_SESSION_LEDGER, cap = Number(process.env.OVERWORLD_SESSION_LEDGER_CAP)) { this.cap = Math.max(0, Math.floor(cap || 0)); }
  get on(): boolean { return !!this.file; }
  read(): { total: number; profiles: Record<string, number> } {
    try { const d = JSON.parse(fs.readFileSync(this.file as string, 'utf8')) as { total?: number; profiles?: Record<string, number> }; return { total: Math.max(0, Math.floor(d.total ?? 0)), profiles: d.profiles ?? {} }; } catch { return { total: 0, profiles: {} }; }
  }
  left(): number { return this.on ? Math.max(0, this.cap - this.read().total) : Infinity; }
  /** Count one session. False (and nothing written) when the allowance is used up, or when the ledger cannot be written. */
  take(profile: string, what: string): boolean {
    if (!this.on) return true;
    const d = this.read();
    if (!this.cap || d.total >= this.cap) return false;
    d.total++; d.profiles[profile] = (d.profiles[profile] ?? 0) + 1;
    try {
      const tmp = `${this.file}.tmp`;
      fs.mkdirSync(path.dirname(this.file as string), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify({ cap: this.cap, ...d, last: `${new Date().toISOString()} ${profile}: ${what}` }, null, 1)}\n`);
      fs.renameSync(tmp, this.file as string);
      return true;
    } catch { return false; }
  }
}

export class AgentWorker implements TownWorker {
  private queryFn: typeof query;
  private cap = Math.max(0, Math.floor(Number(process.env.OVERWORLD_MAX_SESSIONS) || 0));
  private runningNow = 0;
  private waiting: Array<() => void> = [];
  private heldUntil = 0;
  private stopped = false;
  private aborts = new Set<AbortController>();
  private capReported = false;
  private ledger = new SessionLedger();

  constructor(
    private fm: Foreman,
    private opts: RunnerOptions,
  ) {
    this.queryFn = opts.queryFn ?? query;
  }

  private counter(): { sessionsStarted?: number } {
    const b = this.fm.store.data.backend as Record<string, { sessionsStarted?: number } | undefined>;
    return (b.claude ??= {});
  }
  sessions(): { used: number; cap: number } { return { used: this.counter().sessionsStarted ?? 0, cap: this.cap }; }

  canStart(need = 2): { ok: boolean; why?: string } {
    const { used, cap } = this.sessions();
    if (!cap) return { ok: false, why: 'No agent can start: this town has no session allowance.' };
    if (this.fm.status.auth !== 'ok') return { ok: false, why: 'No agent can start: Claude cannot be reached (see the backend\'s status).' };
    if (this.heldUntil === Infinity) return { ok: false, why: 'No agent can start: paid usage was signalled and the run stopped.' };
    if (used + need > cap) return { ok: false, why: `No more can be asked: ${used} of ${cap} agent sessions are used${need > 2 ? ` and this needs ${need}` : ''}.` };
    if (this.ledger.left() < need) return { ok: false, why: `No more can be asked: the allowance of ${this.ledger.cap} agent sessions for this whole work has ${this.ledger.left()} left${need > 2 ? ` and this needs ${need}` : ''}.` };
    return { ok: true };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const a of this.aborts) a.abort();
    for (const w of this.waiting.splice(0)) w();
  }

  /** Wait for a free slot and for any plan-limit hold to pass. */
  private async slot(): Promise<void> {
    for (;;) {
      if (this.stopped) throw new Error('the backend is stopping');
      const held = this.heldUntil - Date.now();
      if (held > 0) { if (this.heldUntil === Infinity) throw new Error('paid usage was signalled; the run stopped'); await new Promise<void>((r) => { const t = setTimeout(r, Math.min(held, 30_000)); t.unref?.(); this.waiting.push(() => { clearTimeout(t); r(); }); }); continue; }
      if (this.runningNow < this.opts.maxConcurrent) return;
      await new Promise<void>((r) => this.waiting.push(r));
    }
  }
  private wake(): void { for (const w of this.waiting.splice(0)) w(); }

  /** Count one session against the cap, on disk, before it is dispatched. False when the cap is reached. */
  private count(req: WorkRequest, what: string): boolean {
    const st = this.counter(), used = st.sessionsStarted ?? 0;
    if (!this.cap || used >= this.cap) {
      if (!this.capReported) { this.capReported = true; this.fm.log.warn(`session cap reached (${used} of ${this.cap}): no further agent session will start`); }
      return false;
    }
    if (!this.ledger.take(this.fm.config.profile ?? 'profile', `${req.agentId} ${what} for ask ${req.askId} (${req.part})`)) {
      if (!this.capReported) { this.capReported = true; this.fm.log.warn(`the allowance of ${this.ledger.cap} agent sessions for this whole work is used up: no further agent session will start`); }
      return false;
    }
    st.sessionsStarted = used + 1;
    this.fm.store.markDirty();
    this.fm.store.flush();
    this.fm.log.info(`agent session ${used + 1} of ${this.cap}: ${req.agentId} ${what} for ask ${req.askId} (${req.part})`);
    return true;
  }

  /** The fixed rule for one job's tool calls: why a call is refused, or nothing when it is within bounds. */
  policy(req: WorkRequest): Guard {
    const root = fs.realpathSync(req.worktree);
    const within = (p: unknown): string | undefined => {
      if (typeof p !== 'string' || !p) return undefined;
      // the real path of the deepest folder that exists, then the rest: a link cannot lead out, and a file in a
      // folder that does not exist yet is still judged by where it would really be
      let known = path.resolve(root, p);
      const rest: string[] = [];
      while (!fs.existsSync(known) && path.dirname(known) !== known) { rest.unshift(path.basename(known)); known = path.dirname(known); }
      let real: string;
      try { real = path.join(fs.realpathSync(known), ...rest); } catch { return undefined; }
      const rel = path.relative(root, real);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
      if (rel === '.git' || rel.startsWith(`.git${path.sep}`)) return undefined;
      return rel || '.';
    };
    const outside = 'You work only inside your checkout of the repository.';
    return (toolName, input) => {
      if (this.stopped) return 'The town is stopping.';
      if (toolName.startsWith(`mcp__${TOWN_SERVER}__`) || toolName === 'TodoWrite') return undefined;
      if (toolName === 'Read') { const rel = within(input.file_path); if (!rel) return outside; const why = req.unreadable?.(rel); return why ? `${rel}: ${why}.` : undefined; }
      if (toolName === 'Glob' || toolName === 'Grep') {
        const pattern = String(input.pattern ?? '') + String(input.glob ?? '');
        if (input.path !== undefined && !within(input.path)) return outside;
        // a search aimed at a file that may not be read is a read of it
        if (req.unreadable) { const at = input.path !== undefined ? within(input.path) : undefined; const why = at ? req.unreadable(at) : undefined; if (why) return `${at}: ${why}.`; if (/(^|[\/*{,])\.env/.test(String(input.glob ?? '')) || (toolName === 'Glob' && /(^|[\/*{,])\.env/.test(String(input.pattern ?? '')))) return 'environment files are not yours to read.'; }
        if (toolName === 'Glob' && (pattern.includes('..') || path.isAbsolute(String(input.pattern ?? '')))) return outside;
        if (toolName === 'Grep' && String(input.glob ?? '').includes('..')) return outside;
        return undefined;
      }
      if (toolName === 'Edit' || toolName === 'Write') {
        const rel = within(input.file_path);
        if (!rel) return outside;
        const why = req.allowed(rel);
        return why ? `${rel}: ${why}.` : undefined;
      }
      return `${toolName} is not available here: there is no shell and no network. Use the file tools and run_checks.`;
    };
  }

  /** The guard as the SDK runs it, before every tool call. It refuses or says nothing; it never approves. */
  guard(req: WorkRequest): HookCallback {
    const rule = this.policy(req);
    return async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const why = rule(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
      if (!why) return {};
      this.fm.agentLog(req.agentId, 'error', `refused ${input.tool_name}: ${why}`);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } };
    };
  }

  async run(req: WorkRequest): Promise<WorkResult> {
    let prompt = req.brief.prompt, resume: string | undefined, what = `${req.role}${req.repair ? ' repair' : ''}`;
    for (;;) {
      try { await this.slot(); } catch (e) { return { ok: false, summary: '', error: (e as Error).message }; }
      if (!this.count(req, what)) return { ok: false, summary: '', error: 'the session cap is reached' };
      this.runningNow++;
      let out: { result?: WorkResult; held?: boolean; sessionId?: string };
      try { out = await this.session(req, prompt, resume); } finally { this.runningNow--; this.wake(); }
      if (out.result) return out.result;
      // stopped by the plan's limit: wait for the window, then take the same session up again
      resume = out.sessionId; prompt = RESUME; what = `${req.role} resumed`;
      this.fm.setAgent(req.agentId, { state: 'blocked', activity: 'waiting for the plan limit' });
    }
  }

  private async session(req: WorkRequest, prompt: string, resume: string | undefined): Promise<{ result?: WorkResult; held?: boolean; sessionId?: string }> {
    const abort = new AbortController();
    this.aborts.add(abort);
    let handedIn: string | undefined;
    const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
    const server = createSdkMcpServer({
      name: TOWN_SERVER, version: '0.1.0', alwaysLoad: true,
      instructions: req.brief.server,
      tools: [
        tool('run_checks', req.brief.runChecks, {}, async () => {
          if (abort.signal.aborted) return text('Your session was stopped.');
          this.fm.setAgent(req.agentId, { state: 'testing', activity: req.role === 'plan' ? 'checking the plan' : req.role === 'checks' ? 'running the tests' : 'running the checks' });
          try { return text(await req.runChecks()); } catch (e) { return text(`The checks could not be run: ${(e as Error).message}`); }
        }),
        tool('hand_in', req.brief.handIn, { summary: z.string().describe('one or two sentences: what you did') }, async ({ summary }) => {
          handedIn = summary;
          return text('Handed in. Stop now: your work will be checked.');
        }),
      ],
    });
    const options: Options = {
      cwd: req.worktree,
      model: this.opts.model,
      effort: this.opts.effort,
      maxTurns: this.opts.maxTurns,
      settingSources: [],
      // no permission prompt exists: the few tools are approved in advance, anything else is refused without asking,
      // and the guard below can only refuse
      permissionMode: 'dontAsk',
      tools: TOOLS,
      allowedTools: APPROVED,
      disallowedTools: NEVER,
      hooks: { PreToolUse: [{ hooks: [this.guard(req)] }] },
      mcpServers: { [TOWN_SERVER]: server },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: req.brief.system },
      abortController: abort,
      env: withAuthMode(agentEnv(process.env, { agentId: req.agentId, cwd: req.worktree }), this.opts.useClaudeLogin),
      ...(resume ? { resume } : {}),
    };
    this.fm.setAgent(req.agentId, { state: 'thinking', activity: req.brief.activity });
    this.fm.agentLog(req.agentId, 'text', `${resume ? 'Resuming' : 'Starting'}: ${req.brief.starting} (${this.opts.model})`);
    const mapper = new StreamMapper(this.fm, req.agentId, req.worktree);
    const timer = setTimeout(() => abort.abort(), SESSION_TIMEOUT_MS);
    timer.unref?.();
    let held = false, failure: string | undefined;
    try {
      const q = this.queryFn({ prompt, options });
      const close = () => { try { q.close(); } catch { /* already closed */ } };
      abort.signal.addEventListener('abort', close, { once: true });
      for await (const msg of q) {
        if (abort.signal.aborted) break;
        mapper.handle(msg as SDKMessage);
        const m = msg as { type: string; rate_limit_info?: { status?: string; isUsingOverage?: boolean; overageInUse?: boolean; rateLimitType?: string; overageStatus?: string; resetsAt?: number } };
        if (m.type !== 'rate_limit_event') continue;
        const info = m.rate_limit_info ?? {};
        const overage = info.isUsingOverage === true || info.overageInUse === true || info.rateLimitType === 'overage';
        this.fm.log.info(`rate limit status: ${info.status ?? 'unknown'} (${info.rateLimitType ?? 'window'}), overage ${info.overageStatus ?? 'unreported'}, using overage ${overage}`);
        if (info.status !== 'rejected' && !overage) continue;
        // included plan usage only: a refused window waits for its reset; any sign of paid usage ends the run
        held = true;
        const resetMs = !overage && info.resetsAt ? (info.resetsAt > 1e11 ? info.resetsAt : info.resetsAt * 1000) : undefined;
        if (resetMs && resetMs - Date.now() < 6 * 3600_000) { this.heldUntil = Math.max(this.heldUntil, resetMs + (this.opts.resumeMarginMs ?? 90_000)); this.fm.log.warn(`plan limit refused during ${req.agentId} ${req.role}: dispatch is held until ${new Date(this.heldUntil).toTimeString().slice(0, 8)}`); }
        else { this.heldUntil = Infinity; this.fm.log.warn(`plan limit: ${overage ? 'paid usage signalled' : 'no reset time given'} during ${req.agentId} ${req.role}; no further agent session will start`); }
        abort.abort();
        break;
      }
    } catch (e) {
      if (!abort.signal.aborted) failure = (e as Error).message ?? String(e);
    } finally {
      clearTimeout(timer);
      this.aborts.delete(abort);
    }
    const stats = mapper.stats;
    if (held) {
      if (this.heldUntil === Infinity || !stats.sessionId) return { result: { ok: false, summary: '', error: 'stopped by the plan limit' } };
      return { held: true, sessionId: stats.sessionId };
    }
    if (failure) { this.fm.log.error(`${req.agentId} ${req.role} failed: ${failure}`); this.fm.agentLog(req.agentId, 'error', `session error: ${failure.slice(0, 300)}`); return { result: { ok: false, summary: '', error: failure } }; }
    if (this.stopped) return { result: { ok: false, summary: '', error: 'the backend stopped' } };
    if (stats.authFailed) return { result: { ok: false, summary: '', error: `Claude authentication failed (${stats.authFailed})` } };
    if (handedIn === undefined) return { result: { ok: false, summary: '', error: stats.isError ? `the session ended in an error (${stats.subtype ?? stats.errors[0] ?? 'unknown'})` : 'the session ended without handing in' } };
    return { result: { ok: true, summary: handedIn } };
  }
}
