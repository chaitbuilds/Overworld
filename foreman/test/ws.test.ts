// The WebSocket server with a code town in hand mode (`--backend sim`: no agents), as the game sees it: `hello` gets
// a snapshot with the town, the game's clock makes the town be drawn (`town.do`), an ask is refused because no one can
// do the work, a bad message is answered with an error, and browser origins are refused. Every message the server
// sends is checked against the protocol on both ends.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { NoAgents } from '../src/agents/none.js';
import { layoutTown } from '../src/codetown/layout.js';
import { mapRepository } from '../src/codetown/mapper.js';
import { silentLogger } from '../src/context.js';
import { ServerMessage, type ServerMessage as SM } from '../src/protocol.js';
import { ForemanServer } from '../src/server.js';
import { makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

interface Client {
  ws: WebSocket;
  msgs: SM[];
  invalid: string[];
  send(o: Record<string, unknown>): void;
  close(): void;
}

function connect(port: number, origin?: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
    const c: Client = {
      ws,
      msgs: [],
      invalid: [],
      send: (o) => ws.send(JSON.stringify({ v: 1, ...o })),
      close: () => ws.close(),
    };
    ws.on('message', (d) => {
      const raw = JSON.parse(d.toString());
      const r = ServerMessage.safeParse(raw);
      if (r.success) c.msgs.push(r.data);
      else c.invalid.push(`${raw.type}: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    });
    ws.once('open', () => resolve(c));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

const ENV = ['OVERWORLD_TOWN', 'OVERWORLD_REPO', 'OVERWORLD_BRANCH', 'OVERWORLD_RECORD'];

describe('WebSocket server + a code town with no agents', () => {
  const prior: Record<string, string | undefined> = {};
  let root: string, h: Harness, server: ForemanServer, port: number, gate: string;

  beforeAll(async () => {
    for (const k of ENV) prior[k] = process.env[k];
    root = tempDir('ws-');
    // the product: two modules, and a test command that needs no install and no network
    const repo = path.join(root, 'product');
    const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };
    const lines = (n: number, what: string) => Array.from({ length: n }, (_, i) => `// ${what} ${i + 1}`).join('\n') + '\n';
    write('package.json', '{"name":"product","private":true,"scripts":{"test":"node --version"}}\n');
    write('src/words/index.mjs', `export const hello = 'hello';\n${lines(320, 'words')}`);
    write('src/app/main.mjs', `import { hello } from '../words/index.mjs';\nexport const greet = () => hello;\n${lines(320, 'app')}`);
    const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    g('init', '-q', '-b', 'main'); g('add', '-A'); g('-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'the product');
    // the town, mapped from it
    const townDir = path.join(root, 'town'), map = await mapRepository(repo, { repoName: 'product' }), layout = layoutTown(map);
    fs.mkdirSync(townDir, { recursive: true });
    fs.writeFileSync(path.join(townDir, 'map.json'), JSON.stringify(map)); fs.writeFileSync(path.join(townDir, 'layout.json'), JSON.stringify(layout));
    gate = layout.gates[0]!.place;
    Object.assign(process.env, { OVERWORLD_TOWN: townDir, OVERWORLD_REPO: repo, OVERWORLD_BRANCH: 'main', OVERWORLD_RECORD: path.join(root, 'run', 'record.jsonl') });
    h = makeForeman(path.join(root, 'backend'), ['--backend', 'none']);
    server = new ForemanServer(h.fm, { host: '127.0.0.1', port: 0, validateOutbound: true, log: silentLogger });
    port = await server.start();
    await h.fm.start(new NoAgents());
  });
  afterAll(async () => {
    await server.stop();
    await h.fm.close();
    rmrf(root);
    for (const k of ENV) { if (prior[k] === undefined) delete process.env[k]; else process.env[k] = prior[k]; }
  });

  it('serves the town to the game, draws it when the game is there, and refuses an ask (no agents)', async () => {
    const a = await connect(port);
    a.send({ type: 'hello', modVersion: 'test', protocol: 1, client: 'mod' });
    await until(() => a.msgs.some((m) => m.type === 'snapshot'));
    const snap = a.msgs.find((m) => m.type === 'snapshot')!;
    if (snap.type !== 'snapshot') throw new Error('no snapshot');
    expect(snap.agents.map((x) => x.id).sort()).toEqual(['juniper', 'kit', 'marlow', 'rowan', 'tove', 'wren']);
    expect(snap.agents.every((x) => x.active && x.activity === 'on the green')).toBe(true);
    expect(snap.foreman).toMatchObject({ backend: 'none', auth: 'ok' });
    expect(snap.town).toMatchObject({ mode: 'hand', kind: 'code', repo: 'product', branch: 'main' });
    expect((snap.town!.places as Array<{ id: string }>).map((p) => p.id)).toContain(gate);

    // the game arrives: the town is drawn, every building and gate a part of the town's own
    a.send({ type: 'town.event', id: 'e1', events: [{ kind: 'hello', world: 'Test' }, { kind: 'clock', game: 1, time: 6000 }] });
    await until(() => a.msgs.some((m) => m.type === 'ack' && m.re === 'e1' && m.ok));
    await until(() => a.msgs.some((m) => m.type === 'town.do' && m.ops.some((o) => o.op === 'part.begin' && o.part === gate)));
    await until(() => a.msgs.some((m) => m.type === 'town.state'));

    // an ask: refused, with the reason the game shows the player
    a.send({ type: 'town.ask', id: 'ask1', text: 'let people choose the language', place: gate });
    await until(() => a.msgs.some((m) => m.type === 'ack' && m.re === 'ask1'));
    const ack = a.msgs.find((m) => m.type === 'ack' && m.re === 'ask1')!;
    expect(ack.type === 'ack' && [ack.ok, ack.error]).toEqual([false, 'No one is here to do the work (this backend has no agents).']);
    expect(a.msgs.some((m) => m.type === 'error' && m.re === 'ask1')).toBe(true);

    // a message the protocol does not have: an error, and an ack when it had an id
    a.ws.send(JSON.stringify({ v: 1, id: 'bad1', type: 'goal.submit', text: 'a studio goal' }));
    await until(() => a.msgs.some((m) => m.type === 'ack' && m.re === 'bad1' && !m.ok));

    // a second client gets its own snapshot; replies go only to whoever asked
    const b = await connect(port);
    b.send({ type: 'hello', modVersion: 'test', protocol: 1, client: 'cli' });
    await until(() => b.msgs.some((m) => m.type === 'snapshot'));
    expect(b.msgs.some((m) => m.type === 'ack')).toBe(false);

    expect(a.invalid).toEqual([]);
    expect(b.invalid).toEqual([]);
    a.close();
    b.close();
  });

  it('refuses browser origins and non-loopback hosts', async () => {
    // browser origins are refused, including `null` (sandboxed iframes, data: URLs, file:// pages)
    await expect(connect(port, 'https://evil.example')).rejects.toThrow(/HTTP 401/);
    await expect(connect(port, 'null')).rejects.toThrow(/HTTP 401/);
    await expect(connect(port, 'file://')).rejects.toThrow(/HTTP 401/);
    // DNS rebinding: a page reaching 127.0.0.1 under its own host name
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Host: `evil.example:${port}` } });
        ws.once('open', () => resolve('open'));
        ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
        ws.once('error', reject);
      }),
    ).rejects.toThrow(/HTTP 401/);
    const local = await connect(port); // no Origin (the mod, the CLI): accepted
    local.close();
  });
});
