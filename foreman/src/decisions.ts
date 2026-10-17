// DecisionQueue: the merge approvals the person gives.
//
// The code town opens a merge decision when a change has passed every check; the lever in the town answers it with
// "Merge", and RepoManager.merge() refuses to merge without such an answered decision for that exact worktree.
// create() opens one (persisted, and the person is notified); answer() records the choice; cancel() closes one that
// became moot.
import type { Ctx } from './context.js';

export class DecisionError extends Error {}

export type DecisionStatus = 'open' | 'answered' | 'cancelled';

export interface Decision {
  /** e.g. "d4" */
  id: string;
  /** the agent the change is from */
  agentId: string;
  kind: 'merge';
  question: string;
  /** button labels; the first is the default choice */
  options: string[];
  /** extra detail, plain text */
  context?: string;
  status: DecisionStatus;
  answer?: { option: string; ts: number };
  /** the repo and the worktree whose branch would be merged */
  repoId?: string;
  worktree?: string;
  createdAt: number;
}

export interface CreateDecisionInput {
  agentId: string;
  kind: 'merge';
  question: string;
  options: string[];
  context?: string;
  repoId?: string;
  worktree?: string;
}

export class DecisionQueue {
  private createdListeners: Array<(d: Decision) => void> = [];

  constructor(private ctx: Ctx) {}

  private get all(): Decision[] {
    return this.ctx.store.data.decisions;
  }

  list(): Decision[] {
    return this.all;
  }

  open(): Decision[] {
    return this.all.filter((d) => d.status === 'open');
  }

  get(id: string): Decision | undefined {
    return this.all.find((d) => d.id === id);
  }

  onCreated(l: (d: Decision) => void): void {
    this.createdListeners.push(l);
  }

  create(input: CreateDecisionInput): Decision {
    if (!input.question.trim()) throw new DecisionError('decision question is empty');
    const options = input.options.map((o) => o.trim()).filter(Boolean);
    if (options.length === 0) throw new DecisionError(`${input.kind} decisions need options`);
    const d: Decision = {
      id: this.ctx.store.nextId('d'),
      agentId: input.agentId,
      kind: input.kind,
      question: input.question.trim(),
      options,
      status: 'open',
      createdAt: this.ctx.now(),
    };
    if (input.context) d.context = input.context;
    if (input.repoId) d.repoId = input.repoId;
    if (input.worktree) d.worktree = input.worktree;
    this.all.push(d);
    this.trim();
    this.ctx.store.markDirty();
    for (const l of this.createdListeners) l(d);
    return d;
  }

  /** Resolve an option given as label (case-insensitive, or an unambiguous prefix) or 0-based index. */
  resolveOption(d: Decision, option: string | number): string {
    if (typeof option === 'number') {
      const o = d.options[option];
      if (o === undefined) throw new DecisionError(`option index ${option} out of range (0..${d.options.length - 1})`);
      return o;
    }
    const exact = d.options.find((o) => o === option);
    if (exact) return exact;
    const ci = d.options.find((o) => o.toLowerCase() === option.trim().toLowerCase());
    if (ci) return ci;
    const prefix = d.options.filter((o) => o.toLowerCase().startsWith(option.trim().toLowerCase()));
    if (prefix.length === 1) return prefix[0]!;
    throw new DecisionError(`"${option}" is not one of: ${d.options.join(' | ')}`);
  }

  /** Record the person's choice. */
  answer(id: string, option: string | number): Decision {
    const d = this.get(id);
    if (!d) throw new DecisionError(`no decision ${id}`);
    if (d.status !== 'open') throw new DecisionError(`decision ${id} is already ${d.status}`);
    const chosen = this.resolveOption(d, option);
    d.status = 'answered';
    d.answer = { option: chosen, ts: this.ctx.now() };
    this.ctx.store.markDirty();
    return d;
  }

  cancel(id: string, reason?: string): Decision | undefined {
    const d = this.get(id);
    if (!d || d.status !== 'open') return d;
    d.status = 'cancelled';
    if (reason) d.context = d.context ? `${d.context}\n(cancelled: ${reason})` : `(cancelled: ${reason})`;
    this.ctx.store.markDirty();
    return d;
  }

  /** Keep all open decisions and the latest 100 closed ones. */
  private trim(): void {
    const closed = this.all.filter((d) => d.status !== 'open');
    if (closed.length <= 100) return;
    const drop = new Set(closed.slice(0, closed.length - 100).map((d) => d.id));
    this.ctx.store.data.decisions = this.all.filter((d) => !drop.has(d.id));
  }
}
