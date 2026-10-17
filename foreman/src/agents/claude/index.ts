// Claude backend: real agents. At start it checks that Claude can be reached (an API key or cloud provider by
// default, the local `claude` login with --use-claude-login) and reports it in the backend's status; the code town's
// AgentWorker (town/runner.ts) then runs each agent session, in the environment agentEnv() gives it.
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeConfig } from '../../config.js';
import { FOREMAN_VERSION } from '../../config.js';
import type { Backend, Foreman } from '../../foreman.js';
import { withGitSafety } from '../../gitsafety.js';
import { agentGitIdentity } from '../../util/git.js';
import { detectApiAuth, NO_API_AUTH_MESSAGE, withAuthMode } from './auth.js';

/**
 * Environment for an agent's CLI process (and anything it starts): git refuses all transports
 * (no push, ever) and never signs; git does not walk up out of the agent's cwd; the agent's commits
 * carry its own placeholder identity ("Overworld Kit <kit@overworld.local>"), never the user's.
 */
export function agentEnv(base: NodeJS.ProcessEnv = process.env, who: { agentId?: string; cwd?: string } = {}): Record<string, string | undefined> {
  return withGitSafety(
    base,
    {
      CLAUDE_AGENT_SDK_CLIENT_APP: `overworld-foreman/${FOREMAN_VERSION}`,
      CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1',
      ...(who.agentId ? (agentGitIdentity(who.agentId) as Record<string, string>) : {}),
    },
    who.cwd ? { ceiling: path.dirname(path.resolve(who.cwd)) } : {},
  );
}

export interface ClaudeBackendOptions {
  /** injectable for tests */
  queryFn?: typeof query;
  /** skip the startup auth probe (tests) */
  skipAuthCheck?: boolean;
}

export class ClaudeBackend implements Backend {
  readonly name = 'claude' as const;
  private readonly queryFn: typeof query;

  constructor(
    private fm: Foreman,
    private cfg: ClaudeConfig,
    private opts: ClaudeBackendOptions = {},
  ) {
    this.queryFn = opts.queryFn ?? query;
  }

  async start(): Promise<void> {
    await this.checkAuth();
  }

  async stop(): Promise<void> {}

  async checkAuth(): Promise<boolean> {
    if (this.opts.skipAuthCheck) {
      this.fm.setStatus({ auth: 'ok', message: `Claude (${this.cfg.workerModel})` });
      return true;
    }
    // API authentication by default; the claude.ai login only when explicitly opted into
    const api = detectApiAuth(process.env);
    if (!this.cfg.useClaudeLogin && !api.ok) {
      this.markAuthFailed(NO_API_AUTH_MESSAGE);
      return false;
    }
    this.fm.setStatus({ auth: 'checking', message: this.cfg.useClaudeLogin ? 'Checking Claude login...' : 'Checking Claude API access...' });
    async function* never(): AsyncGenerator<never> {
      await new Promise(() => undefined);
    }
    const q = this.queryFn({ prompt: never(), options: { settingSources: [], persistSession: false, permissionMode: 'default', env: withAuthMode(agentEnv(process.env), this.cfg.useClaudeLogin) } });
    try {
      const info = await Promise.race([q.accountInfo(), new Promise<never>((_, r) => setTimeout(() => r(new Error('timed out after 45s')), 45_000))]);
      const ok = !!(info.email || info.organization || (info.apiKeySource && info.apiKeySource !== 'none') || (info.tokenSource && info.tokenSource !== 'none') || (info.apiProvider && info.apiProvider !== 'firstParty'));
      if (!ok) throw new Error('not logged in');
      if (this.cfg.useClaudeLogin && (!info.subscriptionType || (info.apiKeySource && info.apiKeySource !== 'none') || (info.apiProvider && info.apiProvider !== 'firstParty'))) throw new Error('A supported Claude subscription login is required; API fallback is disabled');
      const account = this.cfg.useClaudeLogin
        ? [info.organization, info.subscriptionType].filter(Boolean).join(' · ') || info.apiProvider || 'ok'
        : [api.ok ? api.source : 'API', info.organization].filter(Boolean).join(' · ');
      this.fm.setStatus({ auth: 'ok', account, message: `Claude (${this.cfg.workerModel})` });
      this.fm.log.info(`claude auth ok (${account})`);
      return true;
    } catch (e) {
      this.markAuthFailed(
        this.cfg.useClaudeLogin
          ? `Claude login check failed: ${(e as Error).message}. Run \`claude\` and /login, then restart the backend.`
          : `Claude API check failed: ${(e as Error).message}. Check ANTHROPIC_API_KEY (or your cloud provider settings), then restart the backend.`,
      );
      return false;
    } finally {
      try {
        q.close();
      } catch {
        /* ignore */
      }
    }
  }

  private markAuthFailed(message: string): void {
    this.fm.setStatus({ auth: 'failed', message });
    this.fm.log.error(message);
    if (process.stdout.isTTY) process.stdout.write('\x07');
  }
}
