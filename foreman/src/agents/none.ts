// `--backend none`: no agents. The code town is drawn from its map and can be walked round, and nothing can be asked
// of it (its "hand" mode): no agent session can start.
import type { Backend } from '../foreman.js';

export class NoAgents implements Backend {
  readonly name = 'none' as const;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}
