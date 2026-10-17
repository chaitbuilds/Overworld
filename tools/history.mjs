#!/usr/bin/env node
// Replay a town's history in the game: today's town wound back to the repository's first commit and grown again,
// commit by commit. The keyframes come from foreman/scripts/codetown-history-ops.ts (history-ops.json).
//
//   node tools/history.mjs <history town folder> [play] [--from n] [--to n] [--pace 0.12] [--port <DevBridge port>]
//   node tools/history.mjs <history town folder> clear      take the replay's buildings away again
import fs from 'node:fs';
import path from 'node:path';
import { DevClient } from './lib/devclient.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const [folder, what = 'play'] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!folder || !['play', 'clear'].includes(what)) { console.error('usage: node tools/history.mjs <history town folder> [play|clear] [--from n] [--to n] [--pace 0.12] [--port n]'); process.exit(2); }
const history = JSON.parse(fs.readFileSync(path.join(folder, 'history-ops.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dev = await DevClient.connect({ ...(flag('--port') ? { port: Number(flag('--port')) } : {}), timeoutMs: 30_000 });
const living = (ops) => dev.call('dev.living.do', { ops });

if (what === 'clear') {
  const have = new Set(Object.keys((await dev.call('dev.living.state', { events: 0 })).parts ?? {}));
  const ops = [...history.parts.buildings, ...history.parts.gates].filter((n) => have.has(n)).map((part) => ({ op: 'part.remove', part }));
  for (let i = 0; i < ops.length; i += 12) { await living(ops.slice(i, i + 12)); await sleep(300); }
  console.log('parts taken away:', ops.length);
} else {
  // the player is taken to the start of the replay's street, above it, looking along it
  const layout = JSON.parse(fs.readFileSync(path.join(folder, 'layout.json'), 'utf8')), f = layout.frame, y = (layout.groundY ?? 64) + 28;
  const eye = f.turn ? [f.ox, y, f.oz + 30] : [f.ox - 30, y, f.oz], yaw = f.turn ? 180 : -90;
  await dev.call('dev.command', { cmd: `/tp @s ${eye.join(' ')} ${yaw} 28` });
  await sleep(3000);
  // each keyframe's blocks at once; the words on a new board or gate a moment later, when its blocks stand
  const first = Number(flag('--from', '0')), last = flag('--to') === undefined ? undefined : Number(flag('--to')) + 1;
  const pace = Number(flag('--pace', '0.12')) * 1000, rise = 220, words = 750;
  const owed = [];
  const payDue = async () => { for (const due of owed.filter((o) => o.at <= Date.now())) { owed.splice(owed.indexOf(due), 1); await living(due.ops); } };
  for (const frame of history.keyframes.slice(first, last)) {
    const t0 = Date.now();
    const now = frame.ops.filter((o) => !o.after), later = frame.ops.filter((o) => o.after).map(({ after, ...o }) => o);
    if (now.length) await living(now);
    if (later.length) owed.push({ at: t0 + words, ops: later });
    console.log(`${frame.date}  commit ${frame.index}  ${frame.lines} lines`);
    while (Date.now() - t0 < pace + (frame.rises ? rise : 0)) { await payDue(); await sleep(10); }
  }
  while (owed.length) { await payDue(); await sleep(20); }
}
dev.close();
