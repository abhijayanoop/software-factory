// Host git: the only module that runs git. All calls use argv arrays, no shell.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sfHome } from './db.ts';

const exec = promisify(execFile);

type Res = { code: number; stdout: string; stderr: string };

async function run(args: string[], opts: { cwd?: string } = {}): Promise<Res> {
  // Repo hooks never run on any host git call (worktree add, update-ref, merge, commit...).
  const hooks = join(sfHome(), 'empty-hooks');
  await mkdir(hooks, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  try {
    const r = await exec('git', ['-c', `core.hooksPath=${hooks}`, ...args], {
      cwd: opts.cwd, shell: false, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', env,
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e: any) {
    if (typeof e.code !== 'number') throw e; // spawn failure, not a git exit code
    return { code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

async function ok(args: string[], opts?: { cwd?: string }): Promise<string> {
  const r = await run(args, opts);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr.trim()}`);
  return r.stdout;
}

const norm = (p: string) => {
  const s = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

export async function commonGitDir(repoPath: string): Promise<string> {
  const out = await ok(['-C', repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  return resolve(out.trim());
}

type Wt = { path: string; branch?: string; head?: string };

async function listWorktrees(repoPath: string): Promise<Wt[]> {
  const common = await commonGitDir(repoPath);
  const out = await ok([`--git-dir=${common}`, 'worktree', 'list', '--porcelain']);
  return out.split(/\r?\n\r?\n/).filter((b) => b.trim()).map((b) => {
    const w: Wt = { path: '' };
    for (const l of b.split(/\r?\n/)) {
      if (l.startsWith('worktree ')) w.path = l.slice(9);
      else if (l.startsWith('branch ')) w.branch = l.slice(7);
      else if (l.startsWith('HEAD ')) w.head = l.slice(5);
    }
    return w;
  });
}

// The linked worktree's own admin dir (own HEAD + index), found via its gitdir back-pointer so it
// still works when the worker deletes <wt>/.git.
async function adminDir(repoPath: string, wtPath: string): Promise<string> {
  const common = await commonGitDir(repoPath);
  const base = join(common, 'worktrees');
  for (const name of await readdir(base).catch(() => [] as string[])) {
    const p = (await readFile(join(base, name, 'gitdir'), 'utf8').catch(() => '')).trim();
    if (p && norm(p.replace(/\/\.git$/, '')) === norm(wtPath)) return join(base, name);
  }
  throw new Error(`no registered worktree at ${wtPath}`);
}

export async function revParse(repoPath: string, ref: string): Promise<string> {
  const common = await commonGitDir(repoPath);
  return (await ok([`--git-dir=${common}`, 'rev-parse', '--verify', `${ref}^{commit}`])).trim();
}

async function dropRegistration(repoPath: string, wtPath: string): Promise<void> {
  const common = await commonGitDir(repoPath);
  await run([`--git-dir=${common}`, 'worktree', 'remove', '--force', '--force', wtPath]);
  const admin = await adminDir(repoPath, wtPath).catch(() => null);
  if (admin) await rm(admin, { recursive: true, force: true });
}

export async function addWorktree(repoPath: string, wtPath: string, branch: string, baseRef: string): Promise<{ baseSha: string }> {
  const common = await commonGitDir(repoPath);
  const g = `--git-dir=${common}`;
  let existing = (await listWorktrees(repoPath)).find((w) => norm(w.path) === norm(wtPath));
  if (existing && !(await stat(wtPath).catch(() => null))) {
    // Registered but dir gone: drop the stale registration (never a global prune).
    await dropRegistration(repoPath, wtPath);
    existing = undefined;
  }
  if (!existing) {
    await mkdir(join(wtPath, '..'), { recursive: true });
    const branchExists = (await run([g, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
    // --lock: a locked worktree is never pruned, even if the worker deletes <wt>/.git.
    await ok(branchExists ? [g, 'worktree', 'add', '--lock', wtPath, branch] : [g, 'worktree', 'add', '--lock', '-b', branch, wtPath, baseRef]);
  } else if (existing.branch !== `refs/heads/${branch}`) {
    throw new Error(`worktree ${wtPath} exists on ${existing.branch}, not ${branch}`);
  }
  return { baseSha: (await ok([g, 'merge-base', `refs/heads/${branch}`, baseRef])).trim() };
}

export async function addDetachedWorktree(repoPath: string, wtPath: string, ref: string): Promise<void> {
  const common = await commonGitDir(repoPath);
  await mkdir(join(wtPath, '..'), { recursive: true });
  await ok([`--git-dir=${common}`, 'worktree', 'add', '--lock', '--detach', wtPath, ref]);
}

export async function commitAll(repoPath: string, wtPath: string, message: string): Promise<string | null> {
  const admin = await adminDir(repoPath, wtPath);
  // Repo autocrlf is respected on purpose: overriding it makes CRLF checkouts look fully modified.
  const base = [`--git-dir=${admin}`, `--work-tree=${wtPath}`];
  await ok([...base, 'add', '-A']);
  if ((await run([...base, 'diff', '--cached', '--quiet'])).code === 0) return null;
  await ok([...base, 'commit', '--no-verify', '-m', message]);
  return (await ok([...base, 'rev-parse', 'HEAD'])).trim();
}

export async function diff(repoPath: string, base: string, head: string): Promise<string> {
  const common = await commonGitDir(repoPath);
  return ok([`--git-dir=${common}`, 'diff', '--no-color', '--no-ext-diff', base, head]);
}

export async function mergeTree(repoPath: string, target: string, branch: string): Promise<{ tree: string } | { conflict: string[] }> {
  const common = await commonGitDir(repoPath);
  const r = await run([`--git-dir=${common}`, 'merge-tree', '--write-tree', '--name-only', '--no-messages', target, branch]);
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  if (r.code === 0) return { tree: lines[0]! };
  if (r.code === 1) return { conflict: lines.slice(1) };
  throw new Error(`git merge-tree failed (${r.code}): ${r.stderr.trim()}`);
}

export async function squashCommit(repoPath: string, tree: string, parent: string, message: string): Promise<string> {
  const common = await commonGitDir(repoPath);
  return (await ok([`--git-dir=${common}`, 'commit-tree', tree, '-p', parent, '-m', message])).trim();
}

export async function advanceTarget(repoPath: string, target: string, newSha: string, oldSha: string): Promise<'ok' | 'dirty' | 'moved'> {
  const common = await commonGitDir(repoPath);
  const ref = `refs/heads/${target}`;
  const co = (await listWorktrees(repoPath)).find((w) => w.branch === ref);
  if (!co) {
    return (await run([`--git-dir=${common}`, 'update-ref', ref, newSha, oldSha])).code === 0 ? 'ok' : 'moved';
  }
  if ((await ok(['-C', co.path, 'status', '--porcelain', '--untracked-files=no'])).trim()) return 'dirty';
  if (co.head !== oldSha) return 'moved';
  const r = await run(['-C', co.path, 'merge', '--ff-only', newSha]);
  if (r.code === 0) return 'ok';
  return (await ok(['-C', co.path, 'rev-parse', 'HEAD'])).trim() === oldSha ? 'dirty' : 'moved';
}

export async function removeWorktree(repoPath: string, wtPath: string): Promise<void> {
  const root = norm(join(sfHome(), 'worktrees'));
  if (!norm(wtPath).startsWith(root + '/') || norm(wtPath) === norm(repoPath)) {
    throw new Error(`refusing to remove ${wtPath}: not inside ${root}`);
  }
  await dropRegistration(repoPath, wtPath);
  await rm(wtPath, { recursive: true, force: true });
}

export async function currentBranch(repoPath: string): Promise<string> {
  return (await ok(['-C', repoPath, 'symbolic-ref', '--short', 'HEAD'])).trim();
}

export async function pathTracked(repoPath: string, ref: string, path: string): Promise<boolean> {
  const common = await commonGitDir(repoPath);
  return (await ok([`--git-dir=${common}`, 'ls-tree', '--name-only', ref, '--', path])).trim() !== '';
}

// Drops a branch (no-op if missing). `branch -D` refuses a branch checked out in any worktree.
export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  const common = await commonGitDir(repoPath);
  const r = await run([`--git-dir=${common}`, 'branch', '-D', branch]);
  if (r.code !== 0 && !/not found/i.test(r.stderr)) throw new Error(`git branch -D ${branch} failed (${r.code}): ${r.stderr.trim()}`);
}

// The commit in base..tip carrying the trailer line exactly `Factory-Ticket: <id>` (T-1 never matches T-10), if any.
export async function findTrailerCommit(repoPath: string, base: string, tip: string, id: string): Promise<string | null> {
  if (!/^T-\d+$/.test(id)) throw new Error(`invalid ticket id: ${id}`); // id goes into a regex
  const common = await commonGitDir(repoPath);
  const out = await ok([`--git-dir=${common}`, 'log', '--format=%H', `--grep=^Factory-Ticket: ${id}$`, `${base}..${tip}`]);
  return out.split(/\r?\n/).find(Boolean) ?? null;
}
