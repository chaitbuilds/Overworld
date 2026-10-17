import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimRunFiles, homeRunFile, liveOwner, profileRunFile, releaseRunFiles } from '../src/runfile.js';
import { Store } from '../src/store.js';
import { makeForeman, rmrf, tempDir } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmrf(d);
});

describe('persistence', () => {
  it('restores agents, decisions, counters and the backend-owned state after a restart; logs stay on disk', async () => {
    const home = tempDir();
    dirs.push(home);
    const a = makeForeman(home, ['--backend', 'none']);
    const d = a.fm.decisions.create({ agentId: 'marlow', kind: 'merge', question: 'Merge?', options: ['Merge', 'Not yet'] });
    a.fm.agentLog('kit', 'tool', 'Read src/cli.ts');
    a.fm.agentLog('kit', 'result', '81 lines');
    a.fm.setAgent('kit', { state: 'editing', station: 'desk', activity: 'editing src/cli.ts' });
    (a.fm.store.data.backend as Record<string, unknown>).claude = { sessionsStarted: 4 };
    a.fm.store.markDirty();
    await a.fm.close();

    const raw = JSON.parse(fs.readFileSync(path.join(a.cfg.dataDir, 'state.json'), 'utf8'));
    expect(raw.version).toBe(1);

    const b = makeForeman(home, ['--backend', 'none']);
    expect(b.fm.decisions.get(d.id)!.status).toBe('open');
    expect(b.fm.agent('kit')).toMatchObject({ state: 'editing', activity: 'editing src/cli.ts', active: true });
    expect(b.fm.store.data.backend.claude).toEqual({ sessionsStarted: 4 });
    expect(fs.readFileSync(b.fm.store.logFile('kit'), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { text: string }).text)).toEqual(['Read src/cli.ts', '81 lines']);
    // counters continue
    expect(b.fm.decisions.create({ agentId: 'marlow', kind: 'merge', question: 'Again?', options: ['Merge'] }).id).toBe('d2');
    // the snapshot: the backend's status and every agent of the cast
    const snap = b.fm.snapshot();
    if (snap.type !== 'snapshot') throw new Error('no snapshot');
    expect(snap.agents.map((x) => x.id).sort()).toEqual(['juniper', 'kit', 'marlow', 'rowan', 'tove', 'wren']);
    expect(snap.foreman).toMatchObject({ backend: 'none', auth: 'ok' });
    expect('town' in snap).toBe(false);
    // an answer after the restart still works
    expect(b.fm.decisions.answer(d.id, 'Merge').answer!.option).toBe('Merge');
    await b.fm.close();
  });

  it('writes state atomically (no temp files left) and survives a corrupt state file', () => {
    const dir = tempDir();
    dirs.push(dir);
    const s = new Store(dir, { debounceMs: 1 });
    s.data.counters.t = 5;
    s.flush();
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    fs.writeFileSync(path.join(dir, 'state.json'), '{ this is not json');
    const s2 = new Store(dir);
    expect(s2.data.counters.t).toBeUndefined();
    expect(fs.readdirSync(dir).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
  });

  it('rotates agent logs, keeping one old file', () => {
    const dir = tempDir();
    dirs.push(dir);
    const s = new Store(dir, { debounceMs: 1, logMaxBytes: 20_000 });
    for (let i = 0; i < 600; i++) s.appendLog('kit', [{ ts: i, kind: 'text', text: `line ${i} ${'x'.repeat(60)}` }]);
    const logs = path.join(dir, 'logs');
    expect(fs.statSync(path.join(logs, 'kit.jsonl')).size).toBeLessThanOrEqual(20_000);
    expect(fs.readdirSync(logs).sort()).toEqual(['kit.1.jsonl', 'kit.jsonl']);
    const last = fs.readFileSync(path.join(logs, 'kit.jsonl'), 'utf8').trim().split('\n').at(-1)!;
    expect((JSON.parse(last) as { ts: number }).ts).toBe(599);
  });

  it('run files: one per profile; a live owner keeps <home>/foreman.json; release hands it over', async () => {
    const home = tempDir();
    dirs.push(home);
    const net = await import('node:net');
    const server = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    // another live backend (pid of this test process' parent is alive; its port answers)
    const other = { pid: process.ppid, port, host: '127.0.0.1', backend: 'claude', profile: 'claude', version: '0', startedAt: '2026-01-01T00:00:00.000Z' };
    fs.mkdirSync(path.join(home, 'claude'), { recursive: true });
    fs.writeFileSync(profileRunFile(path.join(home, 'claude')), JSON.stringify(other));
    fs.writeFileSync(homeRunFile(home), JSON.stringify(other));
    expect(await liveOwner(profileRunFile(path.join(home, 'claude')))).toMatchObject({ pid: process.ppid });
    // we start on profile "none": our own profile file, but the primary stays the other backend
    const mine = { ...other, pid: process.pid, profile: 'none', backend: 'none', startedAt: new Date().toISOString() };
    await claimRunFiles(home, path.join(home, 'none'), mine);
    expect(JSON.parse(fs.readFileSync(profileRunFile(path.join(home, 'none')), 'utf8')).pid).toBe(process.pid);
    expect(JSON.parse(fs.readFileSync(homeRunFile(home), 'utf8')).pid).toBe(process.ppid);
    await releaseRunFiles(home, path.join(home, 'none'));
    expect(fs.existsSync(profileRunFile(path.join(home, 'none')))).toBe(false);
    expect(JSON.parse(fs.readFileSync(homeRunFile(home), 'utf8')).pid).toBe(process.ppid);
    // a dead owner (port closed) does not count: the next backend takes over and hands back on exit
    server.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(await liveOwner(homeRunFile(home))).toBeUndefined();
    await claimRunFiles(home, path.join(home, 'none'), mine);
    expect(JSON.parse(fs.readFileSync(homeRunFile(home), 'utf8')).pid).toBe(process.pid);
    await releaseRunFiles(home, path.join(home, 'none'));
    expect(fs.existsSync(homeRunFile(home))).toBe(false);
  });
});
