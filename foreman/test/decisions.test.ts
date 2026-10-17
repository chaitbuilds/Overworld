import { afterEach, describe, expect, it } from 'vitest';
import { makeForeman, rmrf, tempDir, type Harness } from './helpers.js';

let h: Harness;
let home: string;
afterEach(async () => {
  await h?.fm.close();
  rmrf(home);
});

function setup(): Harness {
  home = tempDir();
  h = makeForeman(home, ['--backend', 'none']);
  return h;
}

const merge = (fm: Harness['fm']) => fm.decisions.create({ agentId: 'marlow', kind: 'merge', question: 'Merge "add Spanish" into overworld-town?', options: ['Merge', 'Not yet'], repoId: 'r', worktree: 'w' });

describe('DecisionQueue', () => {
  it('opens a merge decision, persists it and tells the person outside the game', async () => {
    const { fm, toasts, notifier } = setup();
    const d = merge(fm);
    expect(d.status).toBe('open');
    expect(fm.store.data.decisions.map((x) => x.id)).toEqual([d.id]);
    await notifier.flush();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.body).toBe('Marlow: Merge "add Spanish" into overworld-town?');
  });

  it('accepts an option by label, prefix or index, and rejects bad answers', () => {
    const { fm } = setup();
    expect(fm.decisions.answer(merge(fm).id, 'merge').answer!.option).toBe('Merge');
    expect(fm.decisions.answer(merge(fm).id, 1).answer!.option).toBe('Not yet');
    const d = merge(fm);
    expect(() => fm.decisions.answer(d.id, 'Maybe')).toThrow(/not one of/);
    expect(() => fm.decisions.answer(d.id, 5)).toThrow(/out of range/);
    expect(fm.decisions.get(d.id)!.status).toBe('open');
    fm.decisions.answer(d.id, 'Merge');
    expect(() => fm.decisions.answer(d.id, 'Merge')).toThrow(/already answered/);
    expect(() => fm.decisions.create({ agentId: 'marlow', kind: 'merge', question: ' ', options: ['Merge'] })).toThrow(/empty/);
    expect(() => fm.decisions.create({ agentId: 'marlow', kind: 'merge', question: 'Merge?', options: [] })).toThrow(/need options/);
  });

  it('cancels an open decision (and leaves an answered one as it is)', () => {
    const { fm } = setup();
    const d = merge(fm);
    expect(fm.decisions.cancel(d.id, 'the change was stopped')!.status).toBe('cancelled');
    expect(fm.decisions.get(d.id)!.context).toBe('(cancelled: the change was stopped)');
    const e = merge(fm);
    fm.decisions.answer(e.id, 'Merge');
    expect(fm.decisions.cancel(e.id)!.status).toBe('answered');
    expect(fm.decisions.open()).toEqual([]);
  });

  it('rate-limits and coalesces notifications', async () => {
    const { Notifier } = await import('../src/notifier.js');
    const shown: string[] = [];
    let now = 1000;
    const n = new Notifier({ enabled: true, minIntervalMs: 60_000, bell: false, now: () => now, spawnToast: async (t, b) => (shown.push(`${t}|${b}`), true) });
    n.needUser('first');
    await n.flush();
    n.needUser('second');
    n.needUser('third');
    expect(shown).toHaveLength(1); // second/third wait for the window
    now += 60_000;
    await n.flush();
    expect(shown).toHaveLength(2);
    expect(shown[1]).toContain('2 decisions waiting');
    n.dispose();
    const off = new Notifier({ enabled: false, spawnToast: async () => (shown.push('x'), true) });
    off.needUser('nope');
    await off.flush();
    expect(shown).toHaveLength(2);
  });
});
