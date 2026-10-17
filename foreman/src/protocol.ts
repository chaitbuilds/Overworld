// The wire protocol between the backend and the game, version 1.
//
// This file is the single source of truth; the Java mod mirrors it. Every message is one JSON object per WebSocket
// text frame:  { "v": 1, "type": "<type>", "id"?: "<client correlation id>", ...payload }
//
// Only what the game's code town uses is here. The game says `hello` and is answered with a `snapshot`; it sends
// what the player asks for (`town.ask`) and what happened in the world (`town.event`); the backend sends the town's
// record (`town.state`), what to draw (`town.do`) and the agents as they change (`agent.upsert`).
//
// Conventions
//  - timestamps are integer epoch milliseconds
//  - colors are "#RRGGBB"
//  - unknown fields must be ignored by receivers (forward compatibility); zod strips them here
//  - optional fields are omitted (never null)
import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------------------------

export const AgentState = z
  .enum(['idle', 'thinking', 'reading', 'editing', 'running', 'testing', 'waiting_user', 'blocked', 'done', 'error'])
  .describe('What the agent is doing right now; drives nameplate dot color, particles and animation.');
export type AgentState = z.infer<typeof AgentState>;

export const Station = z
  .enum(['desk', 'library', 'terminal', 'testbench', 'mergestation', 'meeting', 'lounge', 'user'])
  .describe('The kind of work the agent is at (reading at the library, editing at the desk, ...).');
export type Station = z.infer<typeof Station>;

export const AgentRole = z.enum(['lead', 'worker']);
export type AgentRole = z.infer<typeof AgentRole>;

export const BackendName = z.enum(['none', 'claude']).describe('`none`: no agents (nothing can be asked); `claude`: real agent sessions.');
export type BackendName = z.infer<typeof BackendName>;

export const AuthStatus = z
  .enum(['ok', 'failed', 'unknown', 'checking'])
  .describe('`failed`: the claude backend cannot reach Claude, so no agent can start.');
export type AuthStatus = z.infer<typeof AuthStatus>;

const Id = z.string().min(1);
const Ts = z.number().int().nonnegative().describe('epoch milliseconds');
const HexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/).describe('"#RRGGBB"');

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

export const Agent = z.object({
  id: Id.describe('stable lowercase id, e.g. "kit"'),
  name: z.string().describe('display name, e.g. "Kit"'),
  role: AgentRole,
  title: z.string().optional().describe('short descriptive role, e.g. "Worker"'),
  color: HexColor.describe('agent color (scarf/badge/nameplate)'),
  accent: HexColor.optional(),
  skin: z.string().describe('skin id -> assets/overworld/textures/entity/agent/<skin>.png'),
  state: AgentState,
  activity: z.string().describe('one short line for the nameplate, e.g. "editing src/cli.ts" (<= 48 chars)'),
  station: Station,
  active: z.boolean().describe('false: not in the town; render nothing'),
});
export type Agent = z.infer<typeof Agent>;

export const ForemanStatus = z.object({
  version: z.string(),
  backend: BackendName,
  auth: AuthStatus,
  message: z.string().optional().describe('human-readable backend/auth status'),
  account: z.string().optional().describe('e.g. organization / plan when auth ok'),
});
export type ForemanStatus = z.infer<typeof ForemanStatus>;

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

const envelope = <T extends string>(type: T) => ({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal(type),
  id: z.string().optional().describe('client correlation id; the backend answers with `ack` {re: id}'),
});

/** The code town as the backend records it: places, asks and the agents at work on them. Free-form on purpose: the mod reads the fields it knows. */
export const TownView = z.record(z.string(), z.unknown());
export type TownView = z.infer<typeof TownView>;
const TownItems = z.array(z.record(z.string(), z.unknown()));

// Backend -> game -----------------------------------------------------------------------------

export const SnapshotMsg = z.object({
  ...envelope('snapshot'),
  town: TownView.optional().describe('the code town: see `town.state`'),
  foreman: ForemanStatus,
  agents: z.array(Agent),
});
export const AgentUpsertMsg = z.object({ ...envelope('agent.upsert'), agent: Agent });
export const ForemanStatusMsg = z.object({ ...envelope('foreman.status'), status: ForemanStatus });
export const AckMsg = z.object({
  ...envelope('ack'),
  re: z.string().describe('the `id` of the client message being acknowledged'),
  ok: z.boolean(),
  error: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional().describe('e.g. {askId} for town.ask'),
});
export const ErrorMsg = z.object({
  ...envelope('error'),
  message: z.string(),
  re: z.string().optional(),
});
export const TownStateMsg = z.object({ ...envelope('town.state'), town: TownView });
export const TownDoMsg = z.object({ ...envelope('town.do'), ops: TownItems.describe('operations for the game to carry out, in order: {op: "blocks" | "label" | ..., part, ...}') });

export const ServerMessage = z.discriminatedUnion('type', [SnapshotMsg, TownStateMsg, TownDoMsg, AgentUpsertMsg, ForemanStatusMsg, AckMsg, ErrorMsg]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// Game -> backend -----------------------------------------------------------------------------

export const HelloMsg = z.object({
  ...envelope('hello'),
  modVersion: z.string(),
  protocol: z.literal(PROTOCOL_VERSION),
  client: z.string().optional().describe('"mod" | "cli" | ... (informational)'),
});
export const TownAskMsg = z.object({
  ...envelope('town.ask'),
  text: z.string().min(1).max(200).describe("the player's own words"),
  place: z.string().min(1).describe('id of the place the player aimed at'),
  at: z.array(z.number()).length(3).optional().describe('the block aimed at'),
});
export const TownEventMsg = z.object({ ...envelope('town.event'), events: TownItems.describe('what happened in the world: {kind: "clock" | "use" | "done" | ..., ...}') });

export const ClientMessage = z.discriminatedUnion('type', [HelloMsg, TownAskMsg, TownEventMsg]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// Helper types ----------------------------------------------------------------------------------

/** A server message without the envelope's `v` (added by the sender). */
export type Outbound = ServerMessage extends infer M ? (M extends { v: 1 } ? Omit<M, 'v'> : never) : never;

export function parseClientMessage(raw: unknown): { ok: true; msg: ClientMessage } | { ok: false; error: string } {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'invalid JSON' };
    }
  }
  const r = ClientMessage.safeParse(data);
  if (r.success) return { ok: true, msg: r.data };
  return { ok: false, error: formatZodError(r.error) };
}

export function parseServerMessage(raw: unknown): { ok: true; msg: ServerMessage } | { ok: false; error: string } {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'invalid JSON' };
    }
  }
  const r = ServerMessage.safeParse(data);
  if (r.success) return { ok: true, msg: r.data };
  return { ok: false, error: formatZodError(r.error) };
}

export function formatZodError(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/** Every message type, with what it is for. */
export const SERVER_MESSAGES = {
  snapshot: { schema: SnapshotMsg, doc: 'Full state. Sent in reply to every `hello`; the mod rebuilds its view from it.' },
  'town.state': { schema: TownStateMsg, doc: 'The code town\'s whole record (places, asks with their markers and who is at work on them). Replaces the previous one.' },
  'town.do': { schema: TownDoMsg, doc: 'Operations that draw the town (blocks, labels, the lever\'s watch). The game checks each and carries it out itself, tick by tick; an operation with an `id` is answered by a `town.event` of kind "done" or "error".' },
  'agent.upsert': { schema: AgentUpsertMsg, doc: 'An agent changed (state, station, activity). Replace by `agent.id`.' },
  'foreman.status': { schema: ForemanStatusMsg, doc: 'Backend/auth status changed.' },
  ack: { schema: AckMsg, doc: 'Reply to any client message that carried an `id`.' },
  error: { schema: ErrorMsg, doc: 'A client message was invalid or failed (also sent as ack.ok=false when it had an id).' },
} as const;

export const CLIENT_MESSAGES = {
  hello: { schema: HelloMsg, doc: 'First message after connecting. The backend replies with `snapshot`, then streams changes.' },
  'town.ask': { schema: TownAskMsg, doc: 'The player asked for something at a place (a quarter\'s gate or a building), in their own words.' },
  'town.event': { schema: TownEventMsg, doc: 'What happened in the world since the last message (the clock, a player using the lever, an operation done or refused).' },
} as const;
