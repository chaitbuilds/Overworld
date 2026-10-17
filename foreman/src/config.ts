// Configuration: defaults < <OVERWORLD_HOME>/config.json < environment < CLI flags.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './util/fsx.js';
import type { BackendName } from './protocol.js';
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';

export const FOREMAN_VERSION = '0.1.0';

/** The folder above foreman/ (foreman/src/config.ts -> ../..): where assets-src/cast.json is looked for. */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The real agents (--backend claude): every session of a code town ask, the lead's plan included. */
export interface ClaudeConfig {
  /** the model of every agent session */
  workerModel: string;
  effort: EffortLevel;
  /** turn cap per session */
  maxTurnsWorker: number;
  /** most agent sessions running at the same time */
  maxConcurrent: number;
  /**
   * Use the local `claude` CLI's claude.ai login instead of an API key / cloud provider. Personal use
   * only: Anthropic does not allow third-party tools to offer claude.ai login (see agents/claude/auth.ts).
   */
  useClaudeLogin: boolean;
}

export interface Config {
  backend: BackendName;
  home: string;
  profile: string;
  /** profile directory: <home>/<profile> */
  dataDir: string;
  host: string;
  port: number;
  reset: boolean;
  notify: boolean;
  toastSilent: boolean;
  debug: boolean;
  quiet: boolean;
  projectRoot: string;
  /** reject WebSocket upgrades that carry a browser Origin (CSRF-style protection) */
  allowBrowserOrigins: boolean;
  /** how often the main checkouts are polled for head/dirty changes (ms) */
  repoPollMs: number;
  /** approved merges: a merge commit (keeps the agents' commits) or one squashed commit */
  mergeStyle: 'merge' | 'squash';
  /** sign approved merge commits when the repo's own git config says commit.gpgsign=true */
  signMerges: boolean;
  claude: ClaudeConfig;
}

type Flags = Record<string, string | boolean>;

export function parseFlags(argv: string[]): { flags: Flags; positional: string[] } {
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    if (key.startsWith('no-')) {
      flags[key.slice(3)] = false;
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else flags[key] = true;
  }
  return { flags, positional };
}

function num(v: unknown, d: number): number {
  if (v === undefined || v === '' || v === true) return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function bool(v: unknown, d: boolean): boolean {
  if (v === undefined) return d;
  if (typeof v === 'boolean') return v;
  return !/^(0|false|no|off)$/i.test(String(v));
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined;
}

function mergeStyle(v: unknown): 'merge' | 'squash' {
  if (v === undefined || v === 'merge') return 'merge';
  if (v === 'squash') return 'squash';
  throw new Error(`unknown merge style "${String(v)}" (use merge or squash)`);
}

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
function effort(v: unknown, d: EffortLevel): EffortLevel {
  if (v === undefined) return d;
  if (typeof v === 'string' && (EFFORTS as string[]).includes(v)) return v as EffortLevel;
  throw new Error(`unknown effort "${String(v)}" (use ${EFFORTS.join(', ')})`);
}

/** Every flag loadConfig reads (the `no-` prefix is stripped by parseFlags). */
export const KNOWN_FLAGS = new Set([
  'home', 'backend', 'profile', 'use-claude-login', 'model', 'worker-model', 'effort', 'max-turns', 'max-turns-worker', 'max-concurrent',
  'port', 'reset', 'notify', 'toast-silent', 'debug', 'quiet', 'allow-browser-origins', 'repo-poll-ms', 'merge-style', 'sign-merges',
]);

/**
 * Unknown flags and stray positionals are errors, not silently ignored: a mistyped or mangled flag
 * (e.g. PowerShell passing `--model,sonnet,--effort,low` as ONE argument) would otherwise start real
 * agent sessions on the defaults.
 */
function checkArgs(flags: Flags, positional: string[]): void {
  const unknown = Object.keys(flags).filter((k) => !KNOWN_FLAGS.has(k));
  if (unknown.length) {
    throw new Error(`unknown option${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"--${k}"`).join(', ')} (see --help)`);
  }
  if (positional.length) throw new Error(`unexpected argument "${positional[0]}" (options start with --; see --help)`);
}

export function loadConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): Config {
  const { flags, positional } = parseFlags(argv);
  checkArgs(flags, positional);
  const home = path.resolve(str(flags.home) ?? env.OVERWORLD_HOME ?? path.join(os.homedir(), '.overworld'));
  const file = readJson<Record<string, unknown>>(path.join(home, 'config.json')) ?? {};
  const fileClaude = (file.claude ?? {}) as Record<string, unknown>;
  const pick = (k: string, envKey?: string): unknown => flags[k] ?? (envKey ? env[envKey] : undefined) ?? file[k];

  const backendRaw = String(pick('backend', 'OVERWORLD_BACKEND') ?? 'claude');
  if (backendRaw !== 'none' && backendRaw !== 'claude') throw new Error(`unknown backend "${backendRaw}" (use none or claude)`);
  const backend = backendRaw as BackendName;
  const profile = str(pick('profile', 'OVERWORLD_PROFILE')) ?? backend;
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error(`bad profile name "${profile}"`);

  const cfg: Config = {
    backend,
    home,
    profile,
    dataDir: path.join(home, profile),
    host: '127.0.0.1',
    port: num(pick('port', 'OVERWORLD_PORT'), 7878),
    reset: bool(flags.reset, false),
    notify: bool(pick('notify', 'OVERWORLD_NOTIFY'), backend === 'claude'),
    toastSilent: bool(pick('toast-silent', 'OVERWORLD_TOAST_SILENT'), false),
    debug: bool(pick('debug', 'OVERWORLD_DEBUG'), false),
    quiet: bool(flags.quiet, false),
    projectRoot: PROJECT_ROOT,
    allowBrowserOrigins: bool(pick('allow-browser-origins'), false),
    repoPollMs: Math.max(500, num(pick('repo-poll-ms'), 10_000)),
    mergeStyle: mergeStyle(pick('merge-style', 'OVERWORLD_MERGE_STYLE')),
    // (with no agents, nothing is ever merged)
    signMerges: bool(pick('sign-merges', 'OVERWORLD_SIGN_MERGES'), backend === 'claude'),
    claude: {
      workerModel: str(flags['worker-model']) ?? str(flags.model) ?? str(env.OVERWORLD_WORKER_MODEL) ?? str(fileClaude.workerModel) ?? 'sonnet',
      effort: effort(flags.effort ?? fileClaude.effort, 'medium'),
      maxTurnsWorker: num(flags['max-turns-worker'] ?? flags['max-turns'] ?? fileClaude.maxTurnsWorker, 80),
      maxConcurrent: Math.max(1, num(flags['max-concurrent'] ?? fileClaude.maxConcurrent, 3)),
      useClaudeLogin: bool(flags['use-claude-login'] ?? env.OVERWORLD_USE_CLAUDE_LOGIN ?? fileClaude.useClaudeLogin, false),
    },
  };
  return cfg;
}

export const HELP = `Code Town backend ${FOREMAN_VERSION}

usage: node --import tsx src/main.ts [options]

The town is the repository OVERWORLD_REPO, mapped into OVERWORLD_TOWN by
scripts/codetown-map.ts (see src/codetown/service.ts).

  --backend none|claude    none: no agents, the town is drawn from its map and nothing can be asked;
                           claude: real agent sessions (default)
  --port <n>               WebSocket port (default 7878, env OVERWORLD_PORT)
  --home <dir>             state root (default ~/.overworld, env OVERWORLD_HOME)
  --profile <name>         state profile under home (default: backend name)
  --reset                  wipe this profile's state first
  --notify / --no-notify   desktop notification when a change waits for approval (default: on for claude)
  --toast-silent           notifications without sound
  --repo-poll-ms <n>       how often the repository's checkout is checked for head/dirty changes (default 10000)
  --merge-style merge|squash  approved merges: merge commit keeping the agents' commits (default),
                           or one squashed commit authored by you
  --no-sign-merges         never sign approved merge commits (default: signed when your git
                           config has commit.gpgsign=true; claude backend only)
  --debug                  verbose logging

 claude backend
  auth: ANTHROPIC_API_KEY, or a cloud provider (CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY)
  --use-claude-login       use your local \`claude\` CLI login instead (personal use only; env
                           OVERWORLD_USE_CLAUDE_LOGIN=1, config.json claude.useClaudeLogin)
  OVERWORLD_MAX_SESSIONS=<n>  the most agent sessions this profile may start (required)
  --model <m>              model of every agent session (default sonnet; also --worker-model)
  --effort low|medium|high|xhigh|max   (default medium)
  --max-turns <n>          turn cap per session (default 80; also --max-turns-worker)
  --max-concurrent <n>     agent sessions running at once (default 3)
`;
