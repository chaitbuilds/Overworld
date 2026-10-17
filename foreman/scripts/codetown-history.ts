// The history of a code town: what each of TODAY's buildings held at earlier commits of its repository.
//
//   node --import tsx scripts/codetown-history.ts <repo> --dir <town folder> [--samples 90] [--rev main]
//
// Reads the town's map (map.json: today's modules and which folders are theirs) and walks the first-parent history of
// <rev>. At each sampled commit it counts, with the mapper's own rules (classify, the same line count), the lines of
// source code that lay in each of today's modules' folders then, and how many of that module's present test files
// existed. It checks nothing out: files and their sizes are read from git's objects. Written to <town>/history.json.
//
// What this is NOT: the town as the mapper would have laid it out at that commit (folders that no longer exist have no
// building today and are counted only in the totals as "elsewhere"). It is today's town, wound back.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { classify, moduleOfPath, stepFor, type TownMap } from '../src/codetown/mapper.js';

const args = process.argv.slice(2);
const opt = (name: string, fallback?: string): string | undefined => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const repo = path.resolve(args[0] ?? ''), dir = path.resolve(opt('--dir') ?? ''), samples = Number(opt('--samples', '90')), rev = opt('--rev', 'main') as string;
if (!args[0] || !opt('--dir')) { console.error('usage: codetown-history.ts <repo> --dir <town folder> [--samples 90] [--rev main]'); process.exit(2); }

function git(a: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', ['-C', repo, ...a], { stdio: ['pipe', 'pipe', 'pipe'] }); const out: Buffer[] = []; let err = '';
    p.stdout.on('data', (d: Buffer) => out.push(d)); p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('error', reject); p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`git ${a.join(' ')}: ${err.trim()}`))));
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}

/** The line counts of many blobs at once (git cat-file --batch), by the mapper's count: lines, a last one without a newline counted. */
async function linesOf(shas: string[], known: Map<string, number>): Promise<void> {
  const want = [...new Set(shas.filter((s) => !known.has(s)))];
  if (!want.length) return;
  const out = await git(['cat-file', '--batch'], Buffer.from(want.join('\n') + '\n'));
  let at = 0;
  for (const sha of want) {
    const nl = out.indexOf(10, at), head = out.subarray(at, nl).toString(), size = Number(head.split(' ')[2]);
    const body = out.subarray(nl + 1, nl + 1 + size); at = nl + 1 + size + 1;
    let n = 0; for (const b of body) if (b === 10) n++;
    known.set(sha, size === 0 ? 0 : n + (body[size - 1] === 10 ? 0 : 1));
  }
}

const map = JSON.parse(fs.readFileSync(path.join(dir, 'map.json'), 'utf8')) as TownMap;
const commits = (await git(['rev-list', '--first-parent', '--reverse', rev])).toString().trim().split('\n');
const picks = [...new Set(Array.from({ length: samples }, (_, i) => Math.round((i * (commits.length - 1)) / (samples - 1))))];
const wanted = new Set(picks.map((i) => commits[i] as string));

// Where each file of an old commit is TODAY: followed forward through git's own rename tracking (a file moved in a
// reorganisation is the same file). Walked backwards from the tip, one first-parent step at a time: a file added in a
// step has no ancestor before it, a renamed one carries its lineage to its old name, a deleted one existed before and
// has no descendant (null). `now` is that map for the commit being looked at.
const tipTree = (await git(['ls-tree', '-r', '-z', '--name-only', rev])).toString().split('\0').filter(Boolean);
const now = new Map<string, string | null>(tipTree.map((f) => [f, f]));
const lineageAt = new Map<string, Map<string, string | null>>();
const log = (await git(['log', '--first-parent', '-m', '-M', '--name-status', '-z', '--format=%x01%H', rev])).toString().split('\x01').filter(Boolean);
for (const entry of log) {
  const cells = entry.split('\0'), commit = (cells[0] as string).trim();
  if (wanted.has(commit)) lineageAt.set(commit, new Map(now));
  // undo this commit: what the tree was before it
  const adds: string[] = [], dels: string[] = [], moves: Array<[string, string]> = [];
  for (let k = 1; k < cells.length; k++) {
    const code = (cells[k] as string).trim(); if (!code) continue;
    if (code[0] === 'R' || code[0] === 'C') { const from = cells[++k] as string, to = cells[++k] as string; if (code[0] === 'R') moves.push([from, to]); else adds.push(to); }
    else { const file = cells[++k] as string; if (code[0] === 'A') adds.push(file); else if (code[0] === 'D') dels.push(file); }
  }
  const carried = moves.map(([from, to]) => [from, now.get(to) ?? null] as [string, string | null]);
  for (const [, to] of moves) now.delete(to);
  for (const f of adds) now.delete(f);
  for (const [from, was] of carried) now.set(from, was);
  for (const f of dels) now.set(f, null);
}

const known = new Map<string, number>(), out: unknown[] = [];
for (const i of picks) {
  const commit = commits[i] as string, lineage = lineageAt.get(commit) ?? new Map<string, string | null>();
  const date = (await git(['show', '-s', '--format=%cI', commit])).toString().trim();
  const tree = (await git(['ls-tree', '-r', '-z', commit])).toString().split('\0').filter(Boolean).map((row) => { const [meta, file] = row.split('\t') as [string, string]; return { sha: meta.split(' ')[2] as string, file }; });
  const source = tree.filter((t) => classify(t.file) === 'source');
  await linesOf(source.map((t) => t.sha), known);
  // today's test files that already existed (under whatever name)
  const alive = new Set(tree.map((t) => lineage.get(t.file)).filter((f): f is string => !!f));
  const modules: Record<string, [number, number]> = {}; let elsewhere = 0, total = 0, moved = 0;
  for (const t of source) {
    const n = known.get(t.sha) ?? 0, later = lineage.get(t.file); total += n;
    // the building that holds this file today; a file that did not survive counts for the building whose folder it lay in
    const m = (later ? moduleOfPath(map, later) : undefined) ?? moduleOfPath(map, t.file);
    if (m) { const row = modules[m.id] ?? (modules[m.id] = [0, 0]); row[0] += n; if (later && later !== t.file) moved += n; } else elsewhere += n;
  }
  for (const m of map.modules) { const row = modules[m.id]; if (row) row[1] = m.tests.filter((f) => alive.has(f)).length; }
  out.push({ index: i + 1, commit: commit.slice(0, 7), date, lines: total, elsewhere, moved, modules });
}
const result = { version: 1, repo: map.repo, rev, commits: commits.length, mappedAt: map.commit, rule: 'today\'s modules (map.json), wound back: at each sampled commit a building holds the lines of source code (the mapper\'s classify and line count) of the files that are in it today, followed back through git\'s rename tracking, and of files then lying in its folders that did not survive. Lamps: how many of its present test files existed then, under whatever name. "elsewhere": source lines with no descendant and no building today. "moved": lines counted for a building under an older path.',
  steps: map.modules.map((m) => ({ id: m.id, name: m.name, quarter: m.quarter, lines: m.lines, step: m.step })), samples: out };
fs.writeFileSync(path.join(dir, 'history.json'), `${JSON.stringify(result)}\n`);
// a short account for whoever runs it
const last = out.at(-1) as { modules: Record<string, [number, number]> };
const off = map.modules.filter((m) => (last.modules[m.id]?.[0] ?? 0) !== m.lines).map((m) => `${m.id} ${last.modules[m.id]?.[0] ?? 0}/${m.lines}`);
console.log(`${commits.length} commits on ${rev}, ${picks.length} sampled -> ${path.join(dir, 'history.json')}`);
console.log(off.length ? `the last sample differs from the map (the map may be of a later commit): ${off.join(', ')}` : 'the last sample matches the map, module by module');
void stepFor;
