// The backend's entry point: `node --import tsx src/main.ts --backend none|claude [--profile <name>] [--port <n>] ...`
// (see config.ts HELP). It serves the code town (codetown/service.ts) to the game.
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeBackend } from './agents/claude/index.js';
import { NoAgents } from './agents/none.js';
import { FOREMAN_VERSION, HELP, loadConfig, type Config } from './config.js';
import { consoleLogger } from './context.js';
import { Foreman } from './foreman.js';
import { ForemanServer } from './server.js';
import { claimRunFiles, homeRunFile, liveOwner, profileRunFile, releaseRunFiles } from './runfile.js';
import { isInsideOrEqual } from './util/fsx.js';

function wipeProfile(cfg: Config): void {
  // only ever delete inside the configured home
  if (!isInsideOrEqual(cfg.dataDir, cfg.home) || path.resolve(cfg.dataDir) === path.resolve(cfg.home)) {
    throw new Error(`refusing to wipe ${cfg.dataDir}`);
  }
  fs.rmSync(cfg.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

export async function main(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }
  const cfg = loadConfig(argv);
  const log = consoleLogger('foreman', { debug: cfg.debug, quiet: cfg.quiet });

  // one backend per profile (two would both write its state.json) - checked before --reset wipes it
  const owner = await liveOwner(profileRunFile(cfg.dataDir));
  if (owner) {
    log.error(`profile "${cfg.profile}" is in use by the backend pid ${owner.pid} (ws://${owner.host}:${owner.port}). Stop it first, or use another --profile.`);
    process.exitCode = 1;
    return;
  }

  if (cfg.reset) {
    log.info(`reset: wiping ${cfg.dataDir}`);
    wipeProfile(cfg);
  }

  const foreman = new Foreman({ config: cfg, logger: log });
  const backend = cfg.backend === 'none' ? new NoAgents() : new ClaudeBackend(foreman, cfg.claude);
  const server = new ForemanServer(foreman, { host: cfg.host, port: cfg.port, allowBrowserOrigins: cfg.allowBrowserOrigins, validateOutbound: cfg.debug, log });

  try {
    await server.start();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      log.error(`port ${cfg.port} is already in use - is another backend running? (see ${homeRunFile(cfg.home)} and <home>/<profile>/foreman.json) Use --port or OVERWORLD_PORT.`);
    } else log.error(`could not listen on ${cfg.host}:${cfg.port}: ${(e as Error).message}`);
    await foreman.close();
    process.exitCode = 1;
    return;
  }

  await claimRunFiles(cfg.home, cfg.dataDir, { pid: process.pid, port: server.port, host: cfg.host, backend: cfg.backend, profile: cfg.profile, version: FOREMAN_VERSION, startedAt: new Date().toISOString() });

  log.info(`Overworld backend ${FOREMAN_VERSION} | backend ${cfg.backend} | ws://${cfg.host}:${server.port} | state ${cfg.dataDir}`);

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${sig}: shutting down (state is saved)`);
    const force = setTimeout(() => process.exit(0), 8000);
    force.unref();
    await server.stop();
    await foreman.close();
    await releaseRunFiles(cfg.home, cfg.dataDir).catch(() => undefined);
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
  // stdin "q" + Enter also quits cleanly (handy on Windows where signals to children are awkward)
  if (process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d: string) => {
      if (d.trim() === 'q') void shutdown('quit');
    });
  }
  process.on('uncaughtException', (e) => log.error(`uncaught: ${e.stack ?? e}`));
  process.on('unhandledRejection', (e) => log.error(`unhandled rejection: ${(e as Error)?.stack ?? e}`));

  await foreman.start(backend);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
