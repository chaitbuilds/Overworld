import { describe, expect, it } from 'vitest';
import {
  CLIENT_MESSAGES,
  ClientMessage,
  parseClientMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
  SERVER_MESSAGES,
  ServerMessage,
} from '../src/protocol.js';
import { CLIENT_EXAMPLES, SERVER_EXAMPLES } from './protocol-examples.js';

describe('protocol v1', () => {
  it('has an example for every message type, and only the code town\'s messages', () => {
    expect(Object.keys(SERVER_EXAMPLES).sort()).toEqual(Object.keys(SERVER_MESSAGES).sort());
    expect(Object.keys(CLIENT_EXAMPLES).sort()).toEqual(Object.keys(CLIENT_MESSAGES).sort());
    expect(Object.keys(CLIENT_MESSAGES).sort()).toEqual(['hello', 'town.ask', 'town.event']);
    expect(Object.keys(SERVER_MESSAGES).sort()).toEqual(['ack', 'agent.upsert', 'error', 'foreman.status', 'snapshot', 'town.do', 'town.state']);
  });

  it.each(Object.entries(SERVER_EXAMPLES))('server %s round-trips through JSON', (type, ex) => {
    const wire = JSON.stringify(ex);
    const r = parseServerMessage(wire);
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) {
      expect(r.msg.type).toBe(type);
      expect(r.msg).toEqual(JSON.parse(wire));
      // specific schema agrees with the union
      expect(SERVER_MESSAGES[type as keyof typeof SERVER_MESSAGES].schema.safeParse(ex).success).toBe(true);
    }
  });

  it.each(Object.entries(CLIENT_EXAMPLES))('client %s round-trips through JSON', (type, ex) => {
    const wire = JSON.stringify(ex);
    const r = parseClientMessage(wire);
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) {
      expect(r.msg.type).toBe(type);
      expect(r.msg).toEqual(JSON.parse(wire));
    }
  });

  it('rejects a wrong protocol version, unknown types and invalid JSON', () => {
    expect(parseClientMessage({ v: 2, type: 'hello', modVersion: 'x', protocol: 1 }).ok).toBe(false);
    expect(parseClientMessage({ v: 1, type: 'hello', modVersion: 'x', protocol: 2 }).ok).toBe(false);
    expect(parseClientMessage({ v: 1, type: 'nope' }).ok).toBe(false);
    expect(parseClientMessage({ v: 1, type: 'goal.submit', text: 'a studio goal' }).ok).toBe(false);
    expect(parseClientMessage('{not json').ok).toBe(false);
    expect(parseServerMessage({ v: 1, type: 'agent.upsert' }).ok).toBe(false);
  });

  it('rejects bad enums, colors and empty required strings', () => {
    const agent = (SERVER_EXAMPLES['agent.upsert'] as { agent: Record<string, unknown> }).agent;
    expect(ServerMessage.safeParse({ v: 1, type: 'agent.upsert', agent: { ...agent, state: 'dancing' } }).success).toBe(false);
    expect(ServerMessage.safeParse({ v: 1, type: 'agent.upsert', agent: { ...agent, station: 'kitchen' } }).success).toBe(false);
    expect(ServerMessage.safeParse({ v: 1, type: 'agent.upsert', agent: { ...agent, color: 'blue' } }).success).toBe(false);
    expect(ClientMessage.safeParse({ v: 1, type: 'town.ask', text: '', place: 'q-src' }).success).toBe(false);
    expect(ClientMessage.safeParse({ v: 1, type: 'town.ask', text: 'x'.repeat(201), place: 'q-src' }).success).toBe(false);
    expect(ClientMessage.safeParse({ v: 1, type: 'town.ask', text: 'hello', place: '' }).success).toBe(false);
  });

  it('ignores (strips) unknown fields for forward compatibility', () => {
    const r = parseClientMessage({ v: 1, type: 'hello', modVersion: '0.1', protocol: 1, futureField: 42 });
    expect(r.ok).toBe(true);
    if (r.ok) expect('futureField' in r.msg).toBe(false);
  });

  it('exposes protocol version 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
