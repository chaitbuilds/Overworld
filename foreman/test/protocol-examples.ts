// One realistic example per message type, for the protocol round-trip tests (every example must validate against its
// schema).
import type { Agent, ClientMessage, ServerMessage } from '../src/protocol.js';

const agent: Agent = {
  id: 'kit',
  name: 'Kit',
  role: 'worker',
  title: 'Worker',
  color: '#2E78C6',
  accent: '#F4EFE6',
  skin: 'kit',
  state: 'editing',
  activity: 'editing app/main.ts',
  station: 'desk',
  active: true,
};

type Ex<T> = Record<string, T>;

export const SERVER_EXAMPLES: Ex<ServerMessage> = {
  snapshot: {
    v: 1,
    type: 'snapshot',
    town: { mode: 'real', kind: 'code', repo: 'product', branch: 'overworld-town', places: [{ id: 'q-src', name: 'the gate of src', boxes: [[-3, 64, -2, 3, 74, 2]] }], asks: [], parts: [] },
    foreman: { version: '0.1.0', backend: 'claude', auth: 'ok', account: 'API key · Acme', message: 'Claude (sonnet)' },
    agents: [agent],
  },
  'town.state': {
    v: 1,
    type: 'town.state',
    town: {
      mode: 'real',
      places: [{ id: 'words', name: 'words', boxes: [[-9, 64, -14, -3, 72, -8]], stake: [-4, 65, -6], stand: [-6.5, 65, -11.5] }],
      asks: [{ id: 'a1', text: 'let people choose the language', place: 'q-src', part: '@ask', kind: 'ask', status: 'working', lamp: 'off', agents: ['kit'], busy: true }],
      parts: [],
    },
  },
  'town.do': { v: 1, type: 'town.do', ops: [{ op: 'blocks', part: 'b-words', blocks: [[-6, 66, -8, 'redstone_lamp[lit=true]']], seconds: 0, id: 'o12' }] },
  'agent.upsert': { v: 1, type: 'agent.upsert', agent },
  'foreman.status': { v: 1, type: 'foreman.status', status: { version: '0.1.0', backend: 'claude', auth: 'failed', message: 'Claude login check failed: not logged in. Run `claude` and /login, then restart the backend.' } },
  ack: { v: 1, type: 'ack', re: 'mc-7', ok: true, result: { askId: 'a1', part: '@ask', kind: 'ask' } },
  error: { v: 1, type: 'error', message: 'Work is still going on: one change at a time.', re: 'mc-8' },
};

export const CLIENT_EXAMPLES: Ex<ClientMessage> = {
  hello: { v: 1, type: 'hello', modVersion: '0.1.0', protocol: 1, client: 'mod' },
  'town.ask': { v: 1, type: 'town.ask', id: 'mc-7', text: 'let people choose the language', place: 'q-src', at: [0, 66, -3] },
  'town.event': { v: 1, type: 'town.event', events: [{ kind: 'clock', game: 48211, time: 1042 }, { kind: 'done', id: 'o12', placed: 1, bad: [] }, { kind: 'use', part: 'q-src', key: 'approve', player: { name: 'Sam' } }] },
};
