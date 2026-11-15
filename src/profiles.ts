import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoProfile } from './types.ts';

export function detectProfile(repoPath: string): RepoProfile {
  const pkg = join(repoPath, 'package.json');
  const pyp = join(repoPath, 'pyproject.toml');
  let profile: RepoProfile | undefined;
  if (existsSync(pkg)) {
    const scripts = JSON.parse(readFileSync(pkg, 'utf8')).scripts ?? {};
    const pnpm = existsSync(join(repoPath, 'pnpm-lock.yaml'));
    const pm = pnpm ? 'pnpm' : 'npm';
    profile = {
      kind: 'ts',
      setup: [pnpm ? ['pnpm', 'install', '--frozen-lockfile'] : ['npm', 'ci']],
      checks: ['typecheck', 'lint', 'test'].filter((n) => n in scripts).map((name) => ({ name, cmd: [pm, 'run', name] })),
    };
  } else if (existsSync(pyp)) {
    const text = readFileSync(pyp, 'utf8'); // shortcut: substring match, no TOML parser
    const checks: RepoProfile['checks'] = [];
    if (text.includes('ruff')) checks.push({ name: 'ruff', cmd: ['uv', 'run', 'ruff', 'check', '.'] });
    if (text.includes('pytest')) checks.push({ name: 'pytest', cmd: ['uv', 'run', 'pytest'] });
    profile = { kind: 'py', setup: [['uv', 'sync']], checks };
  }
  if (!profile || !profile.checks.length) throw new Error('no checks detected');
  return profile;
}
