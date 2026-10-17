// Foreman core: owns all state, composes the subsystems and applies what the game sends. The code town
// (codetown/service.ts) is the one thing it serves; a backend (no agents, or real Claude agents) says whether agents
// can work at all. Transport-agnostic: the WS server feeds it ClientMessages and subscribes to outbound messages.
import path from 'node:path';
import { CodeTownError, CodeTownService } from './codetown/service.js';
import { loadCast, type CastMember } from './cast.js';
import type { Config } from './config.js';
import { FOREMAN_VERSION } from './config.js';
import { consoleLogger, type Ctx, type Logger } from './context.js';
import { DecisionQueue, type Decision } from './decisions.js';
import { Notifier } from './notifier.js';
import type { Agent, ClientMessage, ForemanStatus, Outbound } from './protocol.js';
import { RepoManager } from './repos.js';
import { Store, type LogKind } from './store.js';
import { truncate } from './util/text.js';

export interface Backend {
  readonly name: 'none' | 'claude';
  /** Called once after the core is ready. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type Reply = (msg: Outbound) => void;

export class ClientError extends Error {}

export interface ForemanOptions {
  config: Config;
  logger?: Logger;
  notifier?: Notifier;
  now?: () => number;
}

const LOG_TEXT_MAX = 2000;

export class Foreman {
  /** The code town (OVERWORLD_TOWN names its folder): a real repository shown as a town, and the asks that change it. */
  readonly codetown: CodeTownService | undefined;
  readonly config: Config;
  readonly store: Store;
  readonly ctx: Ctx;
  readonly decisions: DecisionQueue;
  readonly repos: RepoManager;
  readonly notifier: Notifier;
  readonly log: Logger;
  readonly cast: CastMember[];
  backend: Backend | undefined;
  status: ForemanStatus;

  private listeners = new Set<(m: Outbound) => void>();
  private closed = false;

  constructor(opts: ForemanOptions) {
    this.config = opts.config;
    this.log = opts.logger ?? consoleLogger('foreman', { debug: opts.config.debug, quiet: opts.config.quiet });
    this.store = new Store(opts.config.dataDir);
    const now = opts.now ?? Date.now;
    this.ctx = { store: this.store, emit: (m) => this.emit(m), now, log: this.log };
    this.decisions = new DecisionQueue(this.ctx);
    this.repos = new RepoManager(this.ctx, path.join(opts.config.dataDir, 'worktrees'), { mergeStyle: opts.config.mergeStyle, signMerges: opts.config.signMerges });
    this.notifier =
      opts.notifier ??
      new Notifier({ enabled: opts.config.notify, silent: opts.config.toastSilent, log: this.log, now });
    const { cast, source } = loadCast(opts.config.projectRoot);
    this.cast = cast;
    this.log.debug(`cast from ${source}`);
    this.status = { version: FOREMAN_VERSION, backend: opts.config.backend, auth: opts.config.backend === 'none' ? 'ok' : 'unknown' };
    if (opts.config.backend === 'none') this.status.message = 'No agents';
    this.codetown = process.env.OVERWORLD_TOWN ? new CodeTownService(this) : undefined;
    this.initRoster();
    this.decisions.onCreated((d) => this.onDecisionCreated(d));
  }

  // ---- event plumbing ---------------------------------------------------------------------

  subscribe(l: (m: Outbound) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(m: Outbound): void {
    for (const l of this.listeners) {
      try {
        l(m);
      } catch (e) {
        this.log.error(`listener failed: ${(e as Error).message}`);
      }
    }
  }

  // ---- roster -----------------------------------------------------------------------------

  /** Every member of the cast is an agent of the town, waiting on the green until there is work. */
  private initRoster(): void {
    const saved = new Map(this.store.data.agents.map((a) => [a.id, a]));
    this.store.data.agents = this.cast.map((c) => {
      const was = saved.get(c.id);
      const a: Agent = {
        id: c.id,
        name: c.name,
        role: c.role,
        title: c.title,
        color: c.color,
        skin: c.id,
        state: was?.state ?? 'idle',
        activity: was?.activity ?? 'on the green',
        station: was?.station ?? 'lounge',
        active: true,
      };
      if (c.accent) a.accent = c.accent;
      return a;
    });
    this.store.markDirty();
  }

  agents(): Agent[] {
    return this.store.data.agents;
  }

  agent(id: string): Agent | undefined {
    return this.store.data.agents.find((a) => a.id === id);
  }

  requireAgent(id: string): Agent {
    const a = this.agent(id);
    if (!a) throw new ClientError(`no agent "${id}"`);
    return a;
  }

  nameOf(id: string): string {
    return this.agent(id)?.name ?? id;
  }

  /** Patch an agent and broadcast if anything changed. */
  setAgent(id: string, patch: Partial<Pick<Agent, 'state' | 'station' | 'activity' | 'active'>>): Agent {
    const a = this.requireAgent(id);
    let changed = false;
    const set = <K extends 'state' | 'station' | 'activity' | 'active'>(k: K, v: Agent[K] | undefined) => {
      if (v !== undefined && a[k] !== v) {
        a[k] = v;
        changed = true;
      }
    };
    set('state', patch.state);
    set('station', patch.station);
    if (patch.activity !== undefined) set('activity', truncate(patch.activity.replace(/\s+/g, ' ').trim(), 48));
    set('active', patch.active);
    if (changed) {
      this.store.markDirty();
      this.emit({ type: 'agent.upsert', agent: { ...a } });
    }
    return a;
  }

  /** Append a line to an agent's log (<profile>/logs/<agent>.jsonl): what it said and did. */
  agentLog(agentId: string, kind: LogKind, text: string): void {
    if (this.closed) return;
    this.store.appendLog(agentId, [{ ts: this.ctx.now(), kind, text: truncate(text.replace(/\r\n/g, '\n'), LOG_TEXT_MAX) }]);
  }

  // ---- decisions ----------------------------------------------------------------------------

  /** A change waits for the person's approval: tell them outside the game too (desktop notification). */
  private onDecisionCreated(d: Decision): void {
    this.notifier.needUser(`${this.nameOf(d.agentId)}: ${d.question}`);
  }

  // ---- foreman status -------------------------------------------------------------------------

  setStatus(patch: Partial<ForemanStatus>): void {
    const next = { ...this.status, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    this.emit({ type: 'foreman.status', status: { ...this.status } });
  }

  // ---- snapshot -----------------------------------------------------------------------------

  snapshot(): Outbound {
    return {
      type: 'snapshot',
      ...(this.codetown ? { town: this.codetown.view() } : {}),
      foreman: { ...this.status },
      agents: this.agents().map((a) => ({ ...a })),
    };
  }

  // ---- inbound ------------------------------------------------------------------------------

  /** Apply a client message. `reply` sends to the originating client only. */
  async handle(msg: ClientMessage, reply: Reply): Promise<void> {
    const ack = (ok: boolean, extra: { error?: string; result?: Record<string, unknown> } = {}) => {
      if (msg.id) reply({ type: 'ack', re: msg.id, ok, ...extra });
    };
    try {
      const result = await this.dispatch(msg, reply);
      ack(true, result ? { result } : {});
    } catch (e) {
      const known = e instanceof CodeTownError || e instanceof ClientError;
      const message = known ? (e as Error).message : `internal error: ${(e as Error).message}`;
      if (!known) this.log.error(`${msg.type}: ${(e as Error).stack ?? e}`);
      reply({ type: 'error', message, ...(msg.id ? { re: msg.id } : {}) });
      ack(false, { error: message });
    }
  }

  private async dispatch(msg: ClientMessage, reply: Reply): Promise<Record<string, unknown> | undefined> {
    switch (msg.type) {
      case 'hello':
        reply(this.snapshot());
        return undefined;
      case 'town.ask':
        if (!this.codetown) throw new ClientError('this backend has no code town');
        return this.codetown.ask(msg.text, msg.place, msg.at as [number, number, number] | undefined);
      case 'town.event':
        this.codetown?.events(msg.events);
        return undefined;
    }
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  async start(backend: Backend): Promise<void> {
    this.backend = backend;
    this.repos.startPolling(this.config.repoPollMs);
    await backend.start();
    await this.codetown?.start();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.repos.stopPolling();
    await this.codetown?.close();
    try {
      await this.backend?.stop();
    } catch (e) {
      this.log.error(`backend stop: ${(e as Error).message}`);
    }
    this.notifier.dispose();
    this.store.close();
  }
}
