// An agent session's stream as the town sees it: each tool call sets the agent's state, station and nameplate (the
// code town reads the file an agent is at from it), and everything is written to the agent's log.
import fs from 'node:fs';
import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StreamMapper } from '../src/agents/claude/stream.js';
import { makeForeman, rmrf, tempDir, type Harness } from './helpers.js';

const msg = (data: Record<string, unknown>) => ({ uuid: crypto.randomUUID(), parent_tool_use_id: null, ...data }) as unknown as SDKMessage;
const toolUse = (session: string, name: string, input: Record<string, unknown>) => msg({ type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', id: crypto.randomUUID(), name, input }] } });

describe('stream mapping', () => {
  let home: string, h: Harness;
  beforeEach(() => {
    home = tempDir('stream-');
    h = makeForeman(home, ['--backend', 'claude']);
  });
  afterEach(async () => {
    await h.fm.close();
    rmrf(home);
  });

  it('maps each tool to a state, a station and a nameplate the town can read the file from', () => {
    const repo = path.join(home, 'work');
    const m = new StreamMapper(h.fm, 'wren', repo);
    m.handle(msg({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }));
    const cases: Array<[string, Record<string, unknown>, string, string, string]> = [
      ['Read', { file_path: path.join(repo, 'src', 'app', 'main.ts') }, 'reading', 'library', 'reading app/main.ts'],
      ['Grep', { pattern: 'greet' }, 'reading', 'library', 'searching "greet"'],
      ['Glob', { pattern: 'src/**/*.ts' }, 'reading', 'library', 'browsing src/**/*.ts'],
      ['Edit', { file_path: path.join(repo, 'src', 'app', 'main.ts'), old_string: 'a', new_string: 'b' }, 'editing', 'desk', 'editing app/main.ts'],
      ['Write', { file_path: path.join(repo, 'tests', 'app.test.ts'), content: 'x' }, 'editing', 'desk', 'writing tests/app.test.ts'],
      ['mcp__town__run_checks', {}, 'running', 'terminal', 'run_checks'],
    ];
    for (const [tool, input, state, station, activity] of cases) {
      m.handle(toolUse('s1', tool, input));
      const a = h.fm.agent('wren')!;
      expect([a.state, a.station, a.activity], tool).toEqual([state, station, activity]);
    }
    m.handle(msg({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 3, total_cost_usd: 0.01, session_id: 's1' }));
    expect(m.stats.sessionId).toBe('s1');
    expect(m.stats.isError).toBe(false);
    const log = fs.readFileSync(h.fm.store.logFile('wren'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; text: string });
    expect(log.some((e) => e.kind === 'tool' && e.text === 'Edit src/app/main.ts')).toBe(true);
    expect(log.some((e) => e.kind === 'diff' && e.text.startsWith('src/app/main.ts\n- a\n+ b'))).toBe(true);
    expect(log.at(-1)).toMatchObject({ kind: 'result', text: 'turn complete (3 steps · $0.010)' });
  });

  it('flags authentication failures', () => {
    const m = new StreamMapper(h.fm, 'wren', home);
    m.handle(msg({ type: 'assistant', session_id: 'x', error: 'authentication_failed', message: { content: [] } }));
    expect(m.stats.authFailed).toBe('authentication_failed');
  });
});
