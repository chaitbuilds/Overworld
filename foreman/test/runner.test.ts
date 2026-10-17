// The code town's real-agent runner, with a scripted fake of the Agent SDK: no network, no provider, no agent session.
// It shows what a session is given (file tools only, a fixed refuse-only guard, the auth the backend chose), that every
// session is counted on disk before it is dispatched and none starts past the cap, and that a refused plan limit waits
// and resumes while a sign of paid usage stops for good.
import fs from 'node:fs';
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unreadable } from '../src/codetown/checks.js';
import { AgentWorker, SessionLedger, TOWN_SERVER, type RunnerOptions } from '../src/town/runner.js';
import type { WorkRequest } from '../src/town/worker.js';
import { makeForeman, rmrf, tempDir, type Harness } from './helpers.js';

type ToolServer = { instance: { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }> }> }> } };
const message = (data: Record<string, unknown>) => ({ ...data, uuid: crypto.randomUUID(), parent_tool_use_id: null }) as unknown as SDKMessage;
const done = (session: string) => message({ type: 'result', subtype: 'success', is_error: false, result: 'fixture complete', num_turns: 1, total_cost_usd: 0, session_id: session, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [] });
const ENV = ['OVERWORLD_MAX_SESSIONS', 'OVERWORLD_SESSION_LEDGER', 'OVERWORLD_SESSION_LEDGER_CAP', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

describe('code town: the real-agent runner (scripted SDK)', () => {
  const prior: Record<string, string | undefined> = {};
  let home: string, wt: string, h: Harness;
  const seen: Array<{ options: Options; prompt: string }> = [];
  const refusals: string[] = [];
  const checks: string[] = [];
  let limit: 'none' | 'window' | 'overage' = 'none';

  /** A scripted model: tries what it must not, writes the one file that is its to write, runs the checks and hands in. */
  const queryFn = ({ prompt, options }: { prompt: unknown; options: Options }) => {
    async function* run() {
      const text = String(prompt), session = options.resume ?? crypto.randomUUID();
      seen.push({ options, prompt: text });
      yield message({ type: 'system', subtype: 'init', session_id: session, model: 'injected-fixture', tools: [] });
      if (limit !== 'none' && !options.resume) {
        const was = limit; limit = 'none';
        yield message({ type: 'rate_limit_event', session_id: session, rate_limit_info: was === 'window' ? { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000), overageStatus: 'rejected', isUsingOverage: false } : { status: 'allowed', rateLimitType: 'overage', isUsingOverage: true } });
        await new Promise((r) => setTimeout(r, 20));
        return;
      }
      const cwd = options.cwd as string, ctx = { signal: new AbortController().signal } as never;
      // what the SDK does: before each tool call it runs the guard, which can refuse and never approves; a call the
      // guard says nothing about goes through only because the tool was approved in advance
      const guard = options.hooks!.PreToolUse![0]!.hooks[0]!;
      expect(options.canUseTool).toBeUndefined();
      const can = async (name: string, input: Record<string, unknown>): Promise<{ behavior: string; message?: string }> => {
        const out = (await guard({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: 't', session_id: session, transcript_path: '', cwd } as never, 't', ctx)) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
        const decision = out.hookSpecificOutput?.permissionDecision;
        expect(decision === undefined || decision === 'deny').toBe(true);
        if (decision === 'deny') return { behavior: 'deny', message: out.hookSpecificOutput?.permissionDecisionReason };
        return (options.allowedTools ?? []).includes(name) ? { behavior: 'allow' } : { behavior: 'deny', message: 'not approved in advance' };
      };
      const attempts: Array<[string, Record<string, unknown>]> = [
        ['Bash', { command: 'ls' }],
        ['WebFetch', { url: 'https://example.invalid' }],
        ['Read', { file_path: '/etc/hosts' }],
        ['Read', { file_path: path.join(cwd, '.git', 'config') }],
        ['Read', { file_path: path.join(cwd, '.env.local') }],
        ['Grep', { pattern: 'KEY', glob: '.env*' }],
        ['Glob', { pattern: '../../**' }],
        ['Write', { file_path: path.join(cwd, '..', 'escape.txt'), content: 'x' }],
        ['Write', { file_path: path.join(cwd, 'src', 'other', 'x.ts'), content: 'x' }],
      ];
      for (const [name, input] of attempts) {
        const r = await can(name, input);
        if (r.behavior !== 'allow') refusals.push(`${name}: ${r.message}`);
      }
      expect((await can('Read', { file_path: path.join(cwd, 'src', 'app', 'main.ts') })).behavior).toBe('allow');
      const target = path.join(cwd, 'src', 'app', 'main.ts');
      if ((await can('Write', { file_path: target, content: 'changed' })).behavior === 'allow') fs.writeFileSync(target, 'export const changed = true;\n');
      const tools = (options.mcpServers![TOWN_SERVER] as unknown as ToolServer).instance._registeredTools;
      checks.push((await tools.run_checks!.handler({}, {})).content[0]!.text);
      await tools.hand_in!.handler({ summary: 'Injected fixture; not an agent.' }, {});
      yield done(session);
    }
    return Object.assign(run(), { close() {}, accountInfo: async () => ({ email: 'fixture@example.invalid' }) });
  };

  const request = (over: Partial<WorkRequest> = {}): WorkRequest => ({
    askId: 'a1', part: 'src/app', role: 'build', agentId: 'kit', worktree: wt,
    allowed: (rel) => (rel.split(path.sep).join('/').startsWith('src/app/') ? undefined : 'the change to src/app is written inside src/app only'),
    runChecks: async () => 'Every test passes.',
    brief: { prompt: 'Make the change to src/app.', system: 'the system words', server: 'the town tools', runChecks: 'run the checks', handIn: 'hand in', activity: 'reading src/app', starting: 'the change to src/app' },
    unreadable,
    ...over,
  });
  const worker = (over: Partial<RunnerOptions> = {}) => new AgentWorker(h.fm, { model: 'injected-fixture', effort: 'high', maxTurns: 10, maxConcurrent: 2, useClaudeLogin: false, queryFn: queryFn as never, resumeMarginMs: 50, ...over });
  const counted = () => (h.fm.store.data.backend.claude as { sessionsStarted?: number } | undefined)?.sessionsStarted ?? 0;
  const onDisk = () => (JSON.parse(fs.readFileSync(path.join(h.cfg.dataDir, 'state.json'), 'utf8')) as { backend: { claude?: { sessionsStarted?: number } } }).backend.claude?.sessionsStarted ?? 0;

  beforeEach(() => {
    for (const k of ENV) prior[k] = process.env[k];
    for (const k of ENV) delete process.env[k];
    seen.length = 0; refusals.length = 0; checks.length = 0; limit = 'none';
    home = tempDir('runner-');
    wt = path.join(home, 'work');
    fs.mkdirSync(path.join(wt, 'src', 'app'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'src', 'app', 'main.ts'), 'export const changed = false;\n');
    process.env.OVERWORLD_MAX_SESSIONS = '3';
    h = makeForeman(path.join(home, 'backend'), ['--backend', 'claude']);
    h.fm.setStatus({ auth: 'ok' });
  });
  afterEach(async () => {
    await h.fm.close();
    rmrf(home);
    for (const k of ENV) { if (prior[k] === undefined) delete process.env[k]; else process.env[k] = prior[k]; }
  });

  it('a session has file tools only, approved in advance; the guard only refuses; the work is handed in', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-fixture';
    const out = await worker().run(request());
    expect(out).toEqual({ ok: true, summary: 'Injected fixture; not an agent.' });
    expect(seen).toHaveLength(1);
    const { options, prompt } = seen[0]!;
    expect(prompt).toBe('Make the change to src/app.');
    expect(options.tools).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'TodoWrite']);
    expect(options.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Task', 'Agent', 'WebSearch', 'WebFetch']));
    // no permission prompt exists: these few are approved in advance, the mode refuses the rest without asking
    expect(options.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'TodoWrite', 'mcp__town__run_checks', 'mcp__town__hand_in']);
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.settingSources).toEqual([]);
    expect(options.cwd).toBe(wt);
    expect(options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'the system words' });
    // the API key by default: the claude.ai login token does not reach the agent's process
    const env = options.env as Record<string, string | undefined>;
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-fixture');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    // git in the agent's process: its own identity, never a push, never above its working copy
    expect(env.GIT_AUTHOR_NAME).toBe('Overworld Kit');
    expect(env.GIT_CEILING_DIRECTORIES!.split(process.platform === 'win32' ? ';' : ':')[0]).toBe(path.dirname(wt));
    const gitConfig = Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_x, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
    expect(gitConfig['protocol.allow']).toBe('never');
    // nothing outside the working copy, no shell, no network, no environment file; only its own module
    const outside = 'You work only inside your checkout of the repository.';
    expect(refusals).toEqual([
      'Bash: Bash is not available here: there is no shell and no network. Use the file tools and run_checks.',
      'WebFetch: WebFetch is not available here: there is no shell and no network. Use the file tools and run_checks.',
      `Read: ${outside}`,
      `Read: ${outside}`,
      'Read: .env.local: environment files are not yours to read.',
      'Grep: environment files are not yours to read.',
      `Glob: ${outside}`,
      `Write: ${outside}`,
      `Write: ${path.join('src', 'other', 'x.ts')}: the change to src/app is written inside src/app only.`,
    ]);
    expect(fs.existsSync(path.join(home, 'escape.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(wt, 'src', 'app', 'main.ts'), 'utf8')).toContain('changed = true');
    expect(checks).toEqual(['Every test passes.']);
    // no decision was ever put to a person; every refusal is in the agent's log
    expect(h.fm.store.data.decisions).toEqual([]);
    expect(fs.readFileSync(h.fm.store.logFile('kit'), 'utf8')).toContain('refused Bash');
    expect(counted()).toBe(1);
    expect(onDisk()).toBe(1);
  });

  it('--use-claude-login: only the local login reaches the agent, no API or cloud credential', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture';
    await worker({ useClaudeLogin: true }).run(request());
    const env = seen[0]!.options.env as Record<string, string | undefined>;
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK']) expect(env[k]).toBeUndefined();
  });

  it('no session starts past the cap, and the count survives a restart', async () => {
    process.env.OVERWORLD_MAX_SESSIONS = '2';
    const w = worker();
    expect(w.canStart(2)).toEqual({ ok: true });
    expect((await w.run(request())).ok).toBe(true);
    expect((await w.run(request({ role: 'checks' }))).ok).toBe(true);
    expect(w.canStart(1)).toMatchObject({ ok: false, why: expect.stringContaining('2 of 2 agent sessions are used') });
    expect(await w.run(request())).toMatchObject({ ok: false, error: 'the session cap is reached' });
    expect(seen).toHaveLength(2);
    // a new worker on the same state starts from the same count
    expect(worker().sessions()).toEqual({ used: 2, cap: 2 });
    expect(onDisk()).toBe(2);
  });

  it('with no cap, or without Claude, nothing can start', async () => {
    delete process.env.OVERWORLD_MAX_SESSIONS;
    const none = worker();
    expect(none.canStart()).toMatchObject({ ok: false, why: expect.stringContaining('no session allowance') });
    expect(await none.run(request())).toMatchObject({ ok: false, error: 'the session cap is reached' });
    process.env.OVERWORLD_MAX_SESSIONS = '3';
    h.fm.setStatus({ auth: 'failed' });
    expect(worker().canStart()).toMatchObject({ ok: false, why: expect.stringContaining('Claude cannot be reached') });
    expect(seen).toHaveLength(0);
  });

  it('a refused plan window waits and takes the same session up again; each start is counted', async () => {
    limit = 'window';
    const out = await worker().run(request());
    expect(out.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.options.resume).toBeDefined();
    expect(seen[1]!.prompt).toContain('stopped part-way by a usage limit');
    expect(counted()).toBe(2);
  });

  it('any sign of paid usage stops the run: the job fails and nothing more can start', async () => {
    limit = 'overage';
    const w = worker();
    expect(await w.run(request())).toMatchObject({ ok: false, error: 'stopped by the plan limit' });
    expect(w.canStart()).toMatchObject({ ok: false, why: expect.stringContaining('paid usage was signalled') });
    expect(await w.run(request())).toMatchObject({ ok: false, error: 'paid usage was signalled; the run stopped' });
    expect(seen).toHaveLength(1);
  });

  it('the ledger counts every profile in one file and refuses when the allowance is used', () => {
    const file = path.join(home, 'ledger.json');
    const a = new SessionLedger(file, 3), b = new SessionLedger(file, 3);
    expect(a.take('one', 'x')).toBe(true); expect(b.take('two', 'y')).toBe(true); expect(a.take('one', 'z')).toBe(true);
    expect(b.take('two', 'w')).toBe(false);
    expect(new SessionLedger(file, 3).read()).toEqual({ total: 3, profiles: { one: 2, two: 1 } });
    expect(a.left()).toBe(0);
  });
});
