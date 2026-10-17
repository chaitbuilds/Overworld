import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { rmrf, tempDir } from './helpers.js';

let home: string | undefined;
afterEach(() => {
  if (home) rmrf(home);
  home = undefined;
});

function load(args: string[]) {
  home = tempDir();
  return loadConfig(['--home', home, ...args], {});
}

describe('loadConfig argument checking', () => {
  it('accepts the documented claude flags', () => {
    const cfg = load(['--backend', 'claude', '--model', 'sonnet', '--effort', 'low', '--max-turns', '50', '--max-concurrent', '2', '--no-notify', '--use-claude-login']);
    expect(cfg.backend).toBe('claude');
    expect(cfg.claude.workerModel).toBe('sonnet');
    expect(cfg.claude.effort).toBe('low');
    expect(cfg.claude.maxTurnsWorker).toBe(50);
    expect(cfg.claude.maxConcurrent).toBe(2);
    expect(cfg.claude.useClaudeLogin).toBe(true);
    expect(cfg.notify).toBe(false);
  });

  it('defaults: the API key (no claude login), sonnet, and the per-agent spellings of the flags', () => {
    const d = load(['--backend', 'claude']);
    expect(d.claude).toEqual({ workerModel: 'sonnet', effort: 'medium', maxTurnsWorker: 80, maxConcurrent: 3, useClaudeLogin: false });
    expect(d.notify).toBe(true);
    const cfg = load(['--backend', 'claude', '--worker-model', 'opus', '--max-turns-worker', '150']);
    expect(cfg.claude.workerModel).toBe('opus');
    expect(cfg.claude.maxTurnsWorker).toBe(150);
  });

  it('accepts the flags the backend with no agents is started with', () => {
    const cfg = load(['--backend', 'none', '--profile', 'code-town', '--port', '41000', '--reset', '--no-notify']);
    expect(cfg.backend).toBe('none');
    expect(cfg.profile).toBe('code-town');
    expect(cfg.port).toBe(41000);
    expect(cfg.reset).toBe(true);
  });

  // regression: PowerShell `-File launch.ps1 -ForemanArgs '--model,sonnet,--effort,low'` hands the backend ONE
  // argument; it must not be ignored silently
  it('refuses an argument that PowerShell joined with commas', () => {
    expect(() => load(['--backend', 'claude', '--model,sonnet,--effort,low'])).toThrow(/unknown option "--model,sonnet,--effort,low"/);
  });

  it('refuses mistyped flags, stray positionals and an unknown backend', () => {
    expect(() => load(['--efort', 'low'])).toThrow(/unknown option "--efort"/);
    expect(() => load(['--backend', 'none', 'oops', 'extra'])).toThrow(/unexpected argument "oops"/);
    expect(() => load(['--backend', 'studio'])).toThrow(/unknown backend "studio"/);
  });

  it('refuses an unknown effort instead of falling back to medium', () => {
    expect(() => load(['--effort', 'lo'])).toThrow(/unknown effort "lo"/);
  });
});
