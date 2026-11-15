import { execFile } from 'node:child_process';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { sfHome } from './db.ts';
import { getRepo, getTicket } from './store.ts';
import { removeWorktree } from './git.ts';
import { SbxSandbox } from './sandbox.ts';

const TOOLS: { name: string; required: boolean }[] = [
  { name: 'git', required: true }, { name: 'sbx', required: true },
  { name: 'uv', required: true }, { name: 'graphify', required: false },
];

export function runCmd(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((res) => {
    execFile(cmd, args, { shell: false, timeout: 10_000, windowsHide: true }, (err, stdout, stderr) =>
      res({ ok: !err, out: `${stdout}${stderr}`.trim() }));
  });
}

export async function checkTools(): Promise<{ name: string; ok: boolean; detail: string }[]> {
  return Promise.all(TOOLS.map(async (t) => {
    const r = await runCmd(t.name, ['--version']);
    return { name: t.name, ok: r.ok, detail: r.ok ? r.out.split('\n')[0]! : t.required ? 'not found' : 'not found (optional, warn)' };
  }));
}

// A ticket id with an optional role suffix: T-3, T-3-spec, T-3-review, T-3-integrate.
const live = (db: DatabaseSync, id: string | undefined) => {
  const s = id && getTicket(db, id)?.state;
  return !!s && s !== 'done' && s !== 'cancelled';
};

export function findOrphans(db: DatabaseSync, worktreeDirs: string[], sandboxNames: string[]): { worktrees: string[]; sandboxes: string[] } {
  const wt = /^(T-\d+)(?:-(?:spec|review|integrate))?$/;
  const sb = /^sf-.+-(T-\d+)(?:-(?:spec|review|integrate))?$/;
  return {
    worktrees: worktreeDirs.filter((d) => { const m = wt.exec(basename(d)); return m && !live(db, m[1]); }),
    sandboxes: sandboxNames.filter((n) => { const m = sb.exec(n); return m && !live(db, m[1]); }),
  };
}

const subdirs = (p: string) => { try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };

// Prints the report; returns the exit code (0 when all required tools are present).
export async function doctor(db: DatabaseSync, fix: boolean): Promise<number> {
  const tools = await checkTools();
  for (const t of tools) console.log(`${t.ok ? 'ok  ' : t.name === 'graphify' ? 'warn' : 'FAIL'} ${t.name}: ${t.detail}`);
  const sbxOk = tools.find((t) => t.name === 'sbx')!.ok;
  if (sbxOk) {
    if (!(await runCmd('sbx', ['template', 'ls'])).out.includes('sf-claude-node24')) console.log('warn template sf-claude-node24 missing: see README, one-time setup');
    if (!/anthropic/i.test((await runCmd('sbx', ['secret', 'ls'])).out)) console.log('warn no anthropic secret in sbx: see README, one-time setup');
  }
  const root = join(sfHome(), 'worktrees');
  const dirs = subdirs(root).flatMap((r) => subdirs(join(root, r)).map((t) => join(root, r, t)));
  const names = sbxOk
    ? (await runCmd('sbx', ['ls'])).out.split('\n').slice(1).map((l) => l.trim().split(/\s+/)[0]!).filter((n) => n && !/^no$/i.test(n))
    : [];
  const o = findOrphans(db, dirs, names);
  for (const w of o.worktrees) console.log(`orphan worktree: ${w}`);
  for (const n of o.sandboxes) console.log(`orphan sandbox: ${n}`);
  if (!o.worktrees.length && !o.sandboxes.length) console.log('no orphans');
  else if (!fix) console.log('run `sf doctor --fix` to remove them');
  else {
    for (const w of o.worktrees) {
      const repo = getRepo(db, basename(join(w, '..')));
      if (!repo) { console.log(`skip ${w}: unknown repo`); continue; }
      await removeWorktree(repo.path, w).then(() => console.log(`removed ${w}`), (e) => console.log(`failed ${w}: ${e.message}`));
    }
    for (const n of o.sandboxes) await new SbxSandbox().remove(n).then(() => console.log(`removed ${n}`), (e) => console.log(`failed ${n}: ${e.message}`));
  }
  return tools.every((t) => t.ok || t.name === 'graphify') ? 0 : 1;
}
