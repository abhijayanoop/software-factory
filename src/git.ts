// Host git: the only module that runs git. All calls use argv arrays, no shell.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sfHome } from './db.ts';

const exec = promisify(execFile);

type Res = { code: number; stdout: string; stderr: string };

async function run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<Res> {
  try {
    const r = await exec('git', args, {
      cwd: opts.cwd, shell: false, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, ...opts.env },
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

export async function addWorktree(repoPath: string, wtPath: string, branch: string, baseRef: string): Promise<{ baseSha: string }> {
  const common = await commonGitDir(repoPath);
  const existing = (await listWorktrees(repoPath)).find((w) => norm(w.path) === norm(wtPath));
  if (!existing) {
    await mkdir(join(wtPath, '..'), { recursive: true });
    await ok([`--git-dir=${common}`, 'worktree', 'add', '-b', branch, wtPath, baseRef]);
  } else if (existing.branch !== `refs/heads/${branch}`) {
    throw new Error(`worktree ${wtPath} exists on ${existing.branch}, not ${branch}`);
  }
  return { baseSha: (await ok([`--git-dir=${common}`, 'merge-base', `refs/heads/${branch}`, baseRef])).trim() };
}

export async function addDetachedWorktree(repoPath: string, wtPath: string, ref: string): Promise<void> {
  const common = await commonGitDir(repoPath);
  await mkdir(join(wtPath, '..'), { recursive: true });
  await ok([`--git-dir=${common}`, 'worktree', 'add', '--detach', wtPath, ref]);
}

export async function commitAll(repoPath: string, wtPath: string, message: string): Promise<string | null> {
  const admin = await adminDir(repoPath, wtPath);
  const hooks = join(sfHome(), 'empty-hooks');
  await mkdir(hooks, { recursive: true });
  const base = [`--git-dir=${admin}`, `--work-tree=${wtPath}`];
  await ok([...base, 'add', '-A']);
  if ((await run([...base, 'diff', '--cached', '--quiet'])).code === 0) return null;
  await ok([...base, '-c', `core.hooksPath=${hooks}`, 'commit', '--no-verify', '-m', message]);
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
  if ((await ok(['-C', co.path, 'status', '--porcelain'])).trim()) return 'dirty';
  if (co.head !== oldSha) return 'moved';
  const hooks = join(sfHome(), 'empty-hooks');
  await mkdir(hooks, { recursive: true });
  // ff-only can only fail here on untracked files that would be overwritten (HEAD verified above).
  const r = await run(['-C', co.path, '-c', `core.hooksPath=${hooks}`, 'merge', '--ff-only', newSha]);
  return r.code === 0 ? 'ok' : 'dirty';
}

export async function removeWorktree(repoPath: string, wtPath: string): Promise<void> {
  const common = await commonGitDir(repoPath);
  await run([`--git-dir=${common}`, 'worktree', 'remove', '--force', wtPath]);
  await rm(wtPath, { recursive: true, force: true });
  await ok([`--git-dir=${common}`, 'worktree', 'prune']);
}
