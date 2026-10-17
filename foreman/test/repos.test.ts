import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Decision } from '../src/decisions.js';
import { git, gitOut } from '../src/util/git.js';
import { makeForeman, makeRepo, rmrf, tempDir, type Harness } from './helpers.js';

let h: Harness;
let home: string;
let repoPath: string;

beforeAll(() => {
  home = tempDir();
  repoPath = makeRepo();
  h = makeForeman(home, ['--backend', 'none']);
});
afterAll(async () => {
  await h.fm.close();
  rmrf(home);
  rmrf(path.dirname(repoPath));
});

function mergeDecision(fm: Harness['fm'], repoId: string, worktree: string): Decision {
  return fm.decisions.create({ agentId: 'marlow', kind: 'merge', question: `Merge ${worktree}?`, options: ['Merge', 'Not yet'], repoId, worktree });
}
/** What the lever does in the code town: the decision answered "Merge", then RepoManager's guarded merge. */
function approve(fm: Harness['fm'], d: Decision) {
  return fm.repos.merge(fm.decisions.answer(d.id, 'Merge'));
}

describe('RepoManager', () => {
  it('registers a repo and refuses non-git paths', async () => {
    const r = await h.fm.repos.add(repoPath);
    expect(r.id).toBe('demo-app');
    expect(r.branch).toBe('main');
    expect(r.head).toMatch(/^[0-9a-f]{7}$/);
    expect(r.dirty).toBe(false);
    expect((await h.fm.repos.add(repoPath)).id).toBe('demo-app'); // idempotent
    const notGit = tempDir();
    await expect(h.fm.repos.add(notGit)).rejects.toThrow(/not a git repository/);
    await expect(h.fm.repos.add(path.join(notGit, 'missing'))).rejects.toThrow(/does not exist/);
    rmrf(notGit);
    // a folder inside a repo is refused instead of silently registering the enclosing repo
    const sub = path.join(repoPath, 'new-folder');
    fs.mkdirSync(sub, { recursive: true });
    await expect(h.fm.repos.add(sub)).rejects.toThrow(/not a repository root: it is inside the git repository/);
    await expect(h.fm.repos.add(path.join(repoPath, 'src'))).rejects.toThrow(/not a repository root/);
    fs.rmSync(sub, { recursive: true, force: true });
    expect(h.fm.repos.list().map((r) => r.id)).toEqual(['demo-app']);
  });

  it('creates a per-agent worktree on overworld/<agent>/<task-slug>', async () => {
    const wt = await h.fm.repos.createWorktree('demo-app', 'kit', { id: 't1', title: 'Tag parser module (src/tags.ts)' });
    expect(wt.id).toBe('kit-t1');
    expect(wt.branch).toBe('overworld/kit/t1-tag-parser-module');
    expect(fs.existsSync(path.join(wt.path, 'src', 'cli.ts'))).toBe(true);
    expect(path.resolve(wt.path).startsWith(path.resolve(h.cfg.dataDir))).toBe(true);
    const again = await h.fm.repos.createWorktree('demo-app', 'kit', { id: 't1', title: 'Tag parser module (src/tags.ts)' });
    expect(again.path).toBe(wt.path);
    // the user's checkout is untouched
    expect(await gitOut(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect((await git(repoPath, ['status', '--porcelain'])).stdout.trim()).toBe('');
    // the agent's work: a new file and a changed one, not committed yet
    fs.writeFileSync(path.join(wt.path, 'src', 'tags.ts'), 'export const TAG = 1;\nexport const OTHER = 2;\n');
    const notes = path.join(wt.path, 'src', 'notes.ts');
    fs.writeFileSync(notes, fs.readFileSync(notes, 'utf8').replace('  all?: boolean;', '  all?: boolean;\n  tag?: string;'));
  });

  it('refuses to merge without an answered "Merge" decision for that worktree', async () => {
    const wt = h.fm.repos.findWorktree('demo-app', 'kit')!;
    const open = mergeDecision(h.fm, 'demo-app', wt.id);
    await expect(h.fm.repos.merge(open)).rejects.toThrow(/does not approve/);
    await expect(h.fm.repos.merge({ ...open, kind: 'question' } as never)).rejects.toThrow(/requires a merge decision/);
    const notYet = mergeDecision(h.fm, 'demo-app', wt.id);
    await expect(h.fm.repos.merge(h.fm.decisions.answer(notYet.id, 'Not yet'))).rejects.toThrow(/does not approve/);
    await expect(approve(h.fm, mergeDecision(h.fm, 'demo-app', 'nobody-t99'))).rejects.toThrow(/no worktree/);
    expect(await gitOut(repoPath, ['rev-list', '--count', 'main'])).toBe('4');
  });

  it('refuses to merge into a dirty checkout and leaves the user tree untouched', async () => {
    const wt = h.fm.repos.findWorktree('demo-app', 'kit')!;
    const readme = path.join(repoPath, 'README.md');
    const original = fs.readFileSync(readme, 'utf8');
    fs.writeFileSync(readme, original + '\nuser edit in progress\n');
    const headBefore = await gitOut(repoPath, ['rev-parse', 'HEAD']);
    await expect(approve(h.fm, mergeDecision(h.fm, 'demo-app', wt.id))).rejects.toThrow(/uncommitted changes/);
    expect(await gitOut(repoPath, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(fs.readFileSync(readme, 'utf8')).toContain('user edit in progress');
    fs.writeFileSync(readme, original);
  });

  it('refuses a conflicting merge', async () => {
    const wt = await h.fm.repos.createWorktree('demo-app', 'wren', { id: 't2', title: 'Conflicting change' });
    const fmt = 'src/format.ts';
    const line = '// Human-friendly rendering of notes for the terminal.';
    fs.writeFileSync(path.join(wt.path, fmt), fs.readFileSync(path.join(wt.path, fmt), 'utf8').replace(line, '// Terminal rendering (agent version).'));
    // the user commits a different change to the same line on main
    fs.writeFileSync(path.join(repoPath, fmt), fs.readFileSync(path.join(repoPath, fmt), 'utf8').replace(line, '// Terminal rendering (user version).'));
    await git(repoPath, ['-c', 'user.name=U', '-c', 'user.email=u@x', 'commit', '-qam', 'user change']);
    const headBefore = await gitOut(repoPath, ['rev-parse', 'HEAD']);
    await expect(approve(h.fm, mergeDecision(h.fm, 'demo-app', wt.id))).rejects.toThrow(/conflict in: src\/format\.ts/);
    expect(await gitOut(repoPath, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect((await git(repoPath, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim()).toBe('');
  });

  it('merges an approved branch with a merge commit made as the user, and keeps the branch', async () => {
    const wt = h.fm.repos.findWorktree('demo-app', 'kit')!;
    const res = await approve(h.fm, mergeDecision(h.fm, 'demo-app', wt.id));
    expect(res).toMatchObject({ base: 'main', branch: wt.branch, files: 2 });
    const parents = (await gitOut(repoPath, ['rev-list', '--parents', '-n', '1', 'HEAD'])).split(' ');
    expect(parents).toHaveLength(3); // merge commit: self + 2 parents
    // made as the user (the repo's own git identity), not as a placeholder
    expect(await gitOut(repoPath, ['log', '-1', '--format=%an <%ae> | %cn <%ce>'])).toBe('Demo Author <demo@example.com> | Demo Author <demo@example.com>');
    expect(fs.readFileSync(path.join(repoPath, 'src', 'tags.ts'), 'utf8')).toContain('TAG = 1');
    expect((await git(repoPath, ['status', '--porcelain'])).stdout.trim()).toBe('');
    const merged = h.fm.repos.findWorktree('demo-app', wt.id)!;
    expect(merged.status).toBe('merged');
    expect(fs.existsSync(merged.path)).toBe(false);
    expect((await git(repoPath, ['rev-parse', '--verify', `refs/heads/${merged.branch}`], { allowFail: true })).code).toBe(0);
    // merging again is refused
    await expect(approve(h.fm, mergeDecision(h.fm, 'demo-app', wt.id))).rejects.toThrow(/merged/);
  });

  it('when the user has another branch checked out, merges only move the base ref', async () => {
    await git(repoPath, ['checkout', '-q', '-b', 'user-feature']);
    fs.writeFileSync(path.join(repoPath, 'user.txt'), 'mine\n');
    const wt = await h.fm.repos.createWorktree('demo-app', 'juniper', { id: 't3', title: 'Small change' });
    fs.writeFileSync(path.join(wt.path, 'CHANGELOG.md'), '# 0.3.0\n');
    const mainBefore = await gitOut(repoPath, ['rev-parse', 'main']);
    await approve(h.fm, mergeDecision(h.fm, 'demo-app', wt.id));
    expect(await gitOut(repoPath, ['rev-parse', 'main'])).not.toBe(mainBefore);
    expect(await gitOut(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('user-feature');
    expect(fs.existsSync(path.join(repoPath, 'CHANGELOG.md'))).toBe(false); // user's tree untouched
    expect(fs.readFileSync(path.join(repoPath, 'user.txt'), 'utf8')).toBe('mine\n');
    await git(repoPath, ['checkout', '-q', 'main']);
  });

  it('polls the main checkout for dirty/clean changes, reporting only when they happen', async () => {
    const readme = path.join(repoPath, 'README.md');
    const original = fs.readFileSync(readme, 'utf8');
    await h.fm.repos.pollStatus('demo-app');
    expect(await h.fm.repos.pollStatus('demo-app')).toBe(false); // nothing changed
    fs.writeFileSync(readme, original + '\nAlex is editing\n');
    expect(await h.fm.repos.pollStatus('demo-app')).toBe(true);
    expect(h.fm.repos.get('demo-app')!.dirty).toBe(true);
    fs.writeFileSync(readme, original);
    expect(await h.fm.repos.pollStatus('demo-app')).toBe(true);
    expect(h.fm.repos.get('demo-app')!.dirty).toBe(false);
  });

  it('a worktree can start from another branch (start point), and abandoning one keeps its work on its branch', async () => {
    const first = await h.fm.repos.createWorktree('demo-app', 'kit', { id: 't4', title: 'Tests first' });
    fs.writeFileSync(path.join(first.path, 'PARTIAL.md'), 'kit was here\n');
    await h.fm.repos.abandon('demo-app', first.id, 'overworld: t4 tests');
    expect(fs.existsSync(first.path)).toBe(false);
    expect(h.fm.repos.findWorktree('demo-app', first.id)!.status).toBe('abandoned');
    const second = await h.fm.repos.createWorktree('demo-app', 'rowan', { id: 't4', title: 'Tests first' }, { startPoint: first.branch });
    expect(second.branch).toBe('overworld/rowan/t4-tests-first');
    expect(fs.readFileSync(path.join(second.path, 'PARTIAL.md'), 'utf8')).toBe('kit was here\n');
    expect(await gitOut(second.path, ['log', '-1', '--format=%s %an'])).toBe('overworld: t4 tests Overworld Kit');
  });

  it('respects the checkout\'s line-ending config (autocrlf=true): not falsely dirty, merges write CRLF, worktrees stay LF', async () => {
    const repo2 = makeRepo();
    try {
      // the user's checkout uses autocrlf=true (the Git for Windows default): files are CRLF on disk.
      // Set up with plain git, the way the user's own git would do it.
      const plainGit = (...args: string[]) => execFileSync('git', args, { cwd: repo2, stdio: 'pipe' });
      plainGit('config', 'core.autocrlf', 'true');
      for (const f of ['README.md', 'src/format.ts']) fs.rmSync(path.join(repo2, f));
      plainGit('checkout', '--', '.');
      expect(fs.readFileSync(path.join(repo2, 'README.md'), 'utf8')).toContain('\r\n');
      const r = await h.fm.repos.add(repo2);
      // an editor saves README.md without changing it: still clean for the user's git and the backend
      const readme = path.join(repo2, 'README.md');
      fs.writeFileSync(readme, fs.readFileSync(readme));
      expect(await h.fm.repos.isDirty(repo2)).toBe(false);
      // the agent worktree has the repository bytes (LF)
      const wt = await h.fm.repos.createWorktree(r.id, 'kit', { id: 't5', title: 'Line endings' });
      const fmt = path.join(wt.path, 'src', 'format.ts');
      expect(fs.readFileSync(fmt, 'utf8')).not.toContain('\r\n');
      fs.writeFileSync(fmt, fs.readFileSync(fmt, 'utf8').replace('// Human-friendly rendering of notes for the terminal.', '// Rendering of notes for the terminal.'));
      await approve(h.fm, mergeDecision(h.fm, r.id, wt.id)); // not refused as dirty
      const merged = fs.readFileSync(path.join(repo2, 'src', 'format.ts'), 'utf8');
      expect(merged).toContain('// Rendering of notes for the terminal.');
      expect(merged).toContain('\r\n'); // written the way the user's git writes it
      expect(plainGit('status', '--porcelain').toString().trim()).toBe('');
    } finally {
      rmrf(path.dirname(repo2));
    }
  });
});

describe('approved merges are made as the user', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach(rmrf));

  async function mergeOnce(args: string[], setup: (repo: string) => void) {
    const home2 = tempDir();
    const repo = makeRepo();
    dirs.push(home2, path.dirname(repo));
    setup(repo);
    const h2 = makeForeman(home2, ['--backend', 'claude', ...args]);
    const r = await h2.fm.repos.add(repo);
    const wt = await h2.fm.repos.createWorktree(r.id, 'kit', { id: 't1', title: 'Signed change' });
    fs.writeFileSync(path.join(wt.path, 'CHANGELOG.md'), '# 0.2.0\n');
    await h2.fm.repos.commitAll(r.id, wt.id, 'Add changelog');
    const headBefore = await gitOut(repo, ['rev-parse', 'HEAD']);
    const error = await approve(h2.fm, mergeDecision(h2.fm, r.id, wt.id)).then(() => undefined, (e: Error) => e.message);
    const out = { repo, error, headBefore, head: await gitOut(repo, ['rev-parse', 'HEAD']) };
    await h2.fm.close();
    return out;
  }

  // a fake gpg: reads the payload, reports success, prints a (fake) signature
  function fakeSigner(dir: string, works: boolean): string {
    const p = path.join(dir, works ? 'fake-gpg.sh' : 'broken-gpg.sh');
    fs.writeFileSync(
      p,
      works
        ? ['#!/bin/sh', 'cat >/dev/null', 'echo "" >&2', 'echo "[GNUPG:] SIG_CREATED D 1 8 00 0 0" >&2', 'echo "-----BEGIN PGP SIGNATURE-----"', 'echo "ZmFrZQ=="', 'echo "-----END PGP SIGNATURE-----"', ''].join('\n')
        : ['#!/bin/sh', 'cat >/dev/null', 'echo "no secret key" >&2', 'exit 2', ''].join('\n'),
    );
    fs.chmodSync(p, 0o755);
    return p.split(path.sep).join('/');
  }

  const signing = (signer: string) => (repo: string) => {
    const kv: Array<[string, string]> = [['commit.gpgsign', 'true'], ['gpg.format', 'openpgp'], ['gpg.program', signer], ['user.signingkey', 'TESTKEY']];
    for (const [k, v] of kv) execFileSync('git', ['config', '--local', k, v], { cwd: repo });
  };

  it('signs the merge commit when the repo signs commits', async () => {
    const dir = tempDir('ac-gpg-');
    dirs.push(dir);
    const { repo, error } = await mergeOnce([], signing(fakeSigner(dir, true)));
    expect(error).toBeUndefined();
    expect((await gitOut(repo, ['cat-file', '-p', 'HEAD'])).includes('gpgsig -----BEGIN PGP SIGNATURE-----')).toBe(true);
  });

  it('refuses (checkout untouched) when signing fails', async () => {
    const dir = tempDir('ac-gpg-');
    dirs.push(dir);
    const { error, head, headBefore } = await mergeOnce([], signing(fakeSigner(dir, false)));
    expect(error).toMatch(/signing the merge commit failed/);
    expect(head).toBe(headBefore);
  });

  it('--no-sign-merges never signs; --merge-style squash makes one commit with co-authors', async () => {
    const dir = tempDir('ac-gpg-');
    dirs.push(dir);
    const { repo, error } = await mergeOnce(['--no-sign-merges', '--merge-style', 'squash'], signing(fakeSigner(dir, false)));
    expect(error).toBeUndefined();
    const raw = await gitOut(repo, ['cat-file', '-p', 'HEAD']);
    expect(raw.includes('gpgsig')).toBe(false);
    expect((await gitOut(repo, ['rev-list', '--parents', '-n', '1', 'HEAD'])).split(' ')).toHaveLength(2); // one parent
    expect(await gitOut(repo, ['log', '-1', '--format=%an'])).toBe('Demo Author');
    expect(raw).toMatch(/Co-authored-by: Overworld Kit <kit@overworld\.local>/);
    expect(fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n')).toBe('# 0.2.0\n');
  });
});

// An agent can rewrite or delete its worktree's `.git` link (or move HEAD). The backend's own git writes in a
// worktree (commitAll: at merge and abandon) must never follow it into the user's checkout or another repository,
// and must only ever move the agent's own branch.
describe('worktree .git tampering and a moved HEAD', () => {
  let outer: string;
  let h3: Harness;
  let repo: string;
  let n = 0;
  // .git link files are hidden on Windows: overwrite in place (a plain write is refused with EPERM)
  const overwrite = (file: string, text: string) => {
    const fd = fs.openSync(file, 'r+');
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, text, 0);
    fs.closeSync(fd);
  };
  const userState = async () => ({ head: await gitOut(repo, ['rev-parse', 'refs/heads/main']), status: (await git(repo, ['status', '--porcelain'])).stdout.trim() });

  beforeAll(async () => {
    // the backend's home sits inside another git repository, so a worktree without its .git link
    // would make git walk up into that one
    outer = tempDir('ac-outer-');
    execFileSync('git', ['init', '-q', '-b', 'main', outer]);
    execFileSync('git', ['-c', 'user.name=o', '-c', 'user.email=o@o', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'outer'], { cwd: outer });
    repo = makeRepo();
    h3 = makeForeman(path.join(outer, 'home'), ['--backend', 'none']);
    await h3.fm.repos.add(repo);
  });
  afterAll(async () => {
    await h3.fm.close();
    rmrf(outer);
    rmrf(path.dirname(repo));
  });

  async function worktreeWithWork(title: string, agent = 'kit') {
    const wt = await h3.fm.repos.createWorktree('demo-app', agent, { id: `t${++n}`, title });
    fs.writeFileSync(path.join(wt.path, 'WORK.md'), `${title}\n`);
    return wt;
  }

  it('.git rewritten to point at the user checkout: no commit, user branch untouched, dir kept', async () => {
    const wt = await worktreeWithWork('hijack via gitdir');
    const before = await userState();
    overwrite(path.join(wt.path, '.git'), `gitdir: ${path.join(repo, '.git').split(path.sep).join('/')}\n`);
    await expect(h3.fm.repos.commitAll('demo-app', wt.id, 'x')).rejects.toThrow(/will not run git in worktree .*its \.git link was removed or changed|points at/);
    await h3.fm.repos.abandon('demo-app', wt.id);
    expect(fs.existsSync(wt.path)).toBe(true); // left for inspection
    expect(await userState()).toEqual(before);
  });

  it('.git removed (git would walk up into the enclosing repo): refused, enclosing repo untouched', async () => {
    const wt = await worktreeWithWork('hijack via walk-up');
    const outerHead = await gitOut(outer, ['rev-parse', 'HEAD']);
    const before = await userState();
    fs.rmSync(path.join(wt.path, '.git'));
    await expect(h3.fm.repos.commitAll('demo-app', wt.id, 'x')).rejects.toThrow(/works on .* instead/);
    expect(await gitOut(outer, ['rev-parse', 'HEAD'])).toBe(outerHead);
    expect((await git(outer, ['status', '--porcelain'])).stdout).not.toMatch(/WORK\.md/); // nothing staged there
    expect(await userState()).toEqual(before);
  });

  it(".git pointing at another worktree's entry is refused", async () => {
    const a = await worktreeWithWork('worktree a');
    const b = await h3.fm.repos.createWorktree('demo-app', 'juniper', { id: `t${++n}`, title: 'worktree b' });
    const bLink = fs.readFileSync(path.join(b.path, '.git'), 'utf8');
    const bBranch = await gitOut(repo, ['rev-parse', `refs/heads/${b.branch}`]);
    overwrite(path.join(a.path, '.git'), bLink);
    await expect(h3.fm.repos.commitAll('demo-app', a.id, 'x')).rejects.toThrow(/points at the worktree entry of/);
    expect(await gitOut(repo, ['rev-parse', `refs/heads/${b.branch}`])).toBe(bBranch);
  });

  it("HEAD moved to another branch: the work is committed on the agent's own branch, the other branch is untouched", async () => {
    const wt = await worktreeWithWork('moved head');
    await git(wt.path, ['checkout', '-q', '-b', 'alex-feature']);
    const other = await gitOut(repo, ['rev-parse', 'refs/heads/alex-feature']);
    const own = await gitOut(repo, ['rev-parse', `refs/heads/${wt.branch}`]);
    const before = await userState();
    expect(await h3.fm.repos.commitAll('demo-app', wt.id, 'overworld: snapshot test')).toBe(true);
    expect(await gitOut(repo, ['rev-parse', 'refs/heads/alex-feature'])).toBe(other);
    expect(await gitOut(wt.path, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/alex-feature');
    const tip = await gitOut(repo, ['rev-parse', `refs/heads/${wt.branch}`]);
    expect(tip).not.toBe(own);
    expect(await gitOut(repo, ['rev-parse', `${tip}^`])).toBe(own);
    expect(await gitOut(repo, ['show', `${tip}:WORK.md`])).toBe('moved head');
    expect(await gitOut(repo, ['log', '-1', '--format=%an <%ae>', tip])).toBe('Overworld Kit <kit@overworld.local>');
    expect(await userState()).toEqual(before);
    // nothing new: no second commit
    expect(await h3.fm.repos.commitAll('demo-app', wt.id, 'again')).toBe(false);
  });

  it('an intact worktree still commits normally', async () => {
    const wt = await worktreeWithWork('normal');
    expect(await h3.fm.repos.commitAll('demo-app', wt.id, 'overworld: normal')).toBe(true);
    expect((await git(wt.path, ['status', '--porcelain'])).stdout.trim()).toBe('');
    expect(await gitOut(wt.path, ['log', '-1', '--format=%s'])).toBe('overworld: normal');
  });
});
