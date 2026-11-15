import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as g from './git.ts';

const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).trim();

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'sf test '));
  process.env.SF_HOME = join(root, 'home');
  const repo = join(root, 'repo');
  await mkdir(repo);
  sh(repo, 'init', '-b', 'main');
  sh(repo, 'config', 'user.name', 'T');
  sh(repo, 'config', 'user.email', 't@e.x');
  await writeFile(join(repo, 'a.txt'), 'one\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-m', 'init');
  return { root, repo, wt: join(root, 'home', 'worktrees', 'r', 'T-1') };
}

test('addWorktree creates branch at base, idempotent', async () => {
  const { root, repo, wt } = await setup();
  const base = sh(repo, 'rev-parse', 'HEAD');
  const r = await g.addWorktree(repo, wt, 'sf/T-1', 'main');
  assert.equal(r.baseSha, base);
  assert.equal(sh(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'sf/T-1');
  assert.deepEqual(await g.addWorktree(repo, wt, 'sf/T-1', 'main'), { baseSha: base });
  await rm(root, { recursive: true, force: true });
});

test('commitAll returns null when clean, sha when changed', async () => {
  const { root, repo, wt } = await setup();
  await g.addWorktree(repo, wt, 'sf/T-1', 'main');
  assert.equal(await g.commitAll(repo, wt, 'x'), null);
  await writeFile(join(wt, 'b.txt'), 'b\n');
  const sha = await g.commitAll(repo, wt, 'add b');
  assert.equal(sha, await g.revParse(repo, 'sf/T-1'));
  await rm(root, { recursive: true, force: true });
});

test('commitAll ignores repo hooks', async () => {
  const { root, repo, wt } = await setup();
  await mkdir(join(repo, '.husky'));
  await writeFile(join(repo, '.husky', 'pre-commit'), '#!/bin/sh\necho x > HOOK_RAN\n');
  sh(repo, 'config', 'core.hooksPath', '.husky');
  await g.addWorktree(repo, wt, 'sf/T-1', 'main');
  await writeFile(join(wt, 'b.txt'), 'b\n');
  assert.ok(await g.commitAll(repo, wt, 'add b'));
  await assert.rejects(access(join(wt, 'HOOK_RAN')));
  await assert.rejects(access(join(repo, 'HOOK_RAN')));
  await rm(root, { recursive: true, force: true });
});

test('commitAll works after worker deletes .git file', async () => {
  const { root, repo, wt } = await setup();
  await g.addWorktree(repo, wt, 'sf/T-1', 'main');
  await rm(join(wt, '.git'));
  await writeFile(join(wt, 'b.txt'), 'b\n');
  const sha = await g.commitAll(repo, wt, 'add b');
  assert.ok(sha);
  assert.equal(await g.revParse(repo, 'sf/T-1'), sha);
  await rm(root, { recursive: true, force: true });
});

test('autocrlf does not churn', async () => {
  const { root, repo, wt } = await setup();
  sh(repo, 'config', 'core.autocrlf', 'true');
  await writeFile(join(repo, 'c.txt'), 'l1\r\nl2\r\nl3\r\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-m', 'crlf');
  await g.addWorktree(repo, wt, 'sf/T-1', 'main');
  const base = await g.revParse(repo, 'main');
  await writeFile(join(wt, 'c.txt'), 'l1\nL2\nl3\n');
  await g.commitAll(repo, wt, 'edit');
  const d = await g.diff(repo, base, 'sf/T-1');
  const n = d.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).length;
  assert.equal(n, 2);
  await rm(root, { recursive: true, force: true });
});

test('mergeTree reports conflict and clean tree', async () => {
  const { root, repo, wt } = await setup();
  await g.addWorktree(repo, wt, 'sf/T-1', 'main');
  await writeFile(join(wt, 'a.txt'), 'branch\n');
  await g.commitAll(repo, wt, 'b');
  const clean = await g.mergeTree(repo, 'main', 'sf/T-1');
  assert.ok('tree' in clean);
  await writeFile(join(repo, 'a.txt'), 'main\n');
  sh(repo, 'commit', '-am', 'm');
  const r = await g.mergeTree(repo, 'main', 'sf/T-1');
  assert.deepEqual(r, { conflict: ['a.txt'] });
  await rm(root, { recursive: true, force: true });
});

async function squashed() {
  const s = await setup();
  await g.addWorktree(s.repo, s.wt, 'sf/T-1', 'main');
  await writeFile(join(s.wt, 'b.txt'), 'b\n');
  await g.commitAll(s.repo, s.wt, 'wip');
  const m = await g.mergeTree(s.repo, 'main', 'sf/T-1');
  assert.ok('tree' in m);
  const oldSha = await g.revParse(s.repo, 'main');
  const msg = 'T-1: title\n\nFactory-Ticket: T-1';
  const newSha = await g.squashCommit(s.repo, m.tree, oldSha, msg);
  return { ...s, oldSha, newSha, msg };
}

test('squash + advanceTarget ok when target not checked out', async () => {
  const { root, repo, oldSha, newSha, msg } = await squashed();
  sh(repo, 'checkout', '-b', 'other');
  assert.equal(await g.advanceTarget(repo, 'main', newSha, oldSha), 'ok');
  assert.equal(sh(repo, 'rev-parse', 'main'), newSha);
  assert.equal(sh(repo, 'rev-parse', 'main^'), oldSha);
  assert.equal(sh(repo, 'log', '-1', '--format=%B', 'main'), msg);
  assert.equal(sh(repo, 'log', '-1', '--format=%an', 'main'), 'T');
  await rm(root, { recursive: true, force: true });
});

test('advanceTarget ok when checked out and clean', async () => {
  const { root, repo, oldSha, newSha } = await squashed();
  assert.equal(await g.advanceTarget(repo, 'main', newSha, oldSha), 'ok');
  assert.equal(sh(repo, 'rev-parse', 'HEAD'), newSha);
  await readFile(join(repo, 'b.txt'));
  await rm(root, { recursive: true, force: true });
});

test('advanceTarget dirty', async () => {
  const { root, repo, oldSha, newSha } = await squashed();
  await writeFile(join(repo, 'a.txt'), 'dirty\n');
  assert.equal(await g.advanceTarget(repo, 'main', newSha, oldSha), 'dirty');
  await rm(root, { recursive: true, force: true });
});

test('advanceTarget moved when oldSha stale', async () => {
  const { root, repo, oldSha, newSha } = await squashed();
  sh(repo, 'checkout', '-b', 'other');
  assert.equal(await g.advanceTarget(repo, 'main', newSha, newSha), 'moved');
  assert.equal(await g.advanceTarget(repo, 'main', newSha, '0'.repeat(40)), 'moved');
  assert.equal(sh(repo, 'rev-parse', 'main'), oldSha);
  await rm(root, { recursive: true, force: true });
});

test('advanceTarget moved when checked-out HEAD differs; removeWorktree idempotent; detached', async () => {
  const { root, repo, wt, oldSha, newSha } = await squashed();
  assert.equal(await g.advanceTarget(repo, 'main', newSha, newSha), 'moved');
  await g.removeWorktree(repo, wt);
  await g.removeWorktree(repo, wt);
  const d = join(root, 'home', 'worktrees', 'r', 'det');
  await g.addDetachedWorktree(repo, d, oldSha);
  assert.equal(sh(d, 'rev-parse', 'HEAD'), oldSha);
  await g.removeWorktree(repo, d);
  await rm(root, { recursive: true, force: true });
});

test('removeWorktree of B does not break A whose .git was deleted', async () => {
  const { root, repo, wt } = await setup();
  const b = join(root, 'home', 'worktrees', 'r', 'T-2');
  await g.addWorktree(repo, wt, 'sf/T-1', 'main');
  await g.addWorktree(repo, b, 'sf/T-2', 'main');
  await rm(join(wt, '.git'));
  await g.removeWorktree(repo, b);
  await writeFile(join(wt, 'x.txt'), 'x\n');
  assert.ok(await g.commitAll(repo, wt, 'x'));
  await rm(root, { recursive: true, force: true });
});

test('addWorktree recreates after remove (branch kept) and after dir deleted', async () => {
  const { root, repo, wt } = await setup();
  await g.addWorktree(repo, wt, 'sf/T-1', 'main');
  await writeFile(join(wt, 'x.txt'), 'x\n');
  const sha = await g.commitAll(repo, wt, 'x');
  await g.removeWorktree(repo, wt);
  await g.addWorktree(repo, wt, 'sf/T-1', 'main');
  assert.equal(sh(wt, 'rev-parse', 'HEAD'), sha);
  await rm(wt, { recursive: true, force: true });
  await g.addWorktree(repo, wt, 'sf/T-1', 'main');
  assert.equal(sh(wt, 'rev-parse', 'HEAD'), sha);
  await rm(root, { recursive: true, force: true });
});

test('removeWorktree refuses paths outside SF_HOME/worktrees', async () => {
  const { root, repo } = await setup();
  await assert.rejects(g.removeWorktree(repo, repo));
  await access(join(repo, 'a.txt'));
  await rm(root, { recursive: true, force: true });
});

test('failing post-checkout hook does not run on addWorktree', async () => {
  const { root, repo, wt } = await setup();
  await mkdir(join(repo, '.husky'));
  await writeFile(join(repo, '.husky', 'post-checkout'), '#!/bin/sh\necho x > HOOK_RAN\nexit 1\n');
  sh(repo, 'config', 'core.hooksPath', '.husky');
  await g.addWorktree(repo, wt, 'sf/T-1', 'main');
  await assert.rejects(access(join(wt, 'HOOK_RAN')));
  await assert.rejects(access(join(repo, 'HOOK_RAN')));
  await rm(root, { recursive: true, force: true });
});
