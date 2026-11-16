#!/usr/bin/env node
// Creates two throwaway sample repos for the end-to-end manual check (docs/manual-check.md):
//   <SF_HOME>-samples/sample-ts  npm, `node --test`, `tsc --noEmit`
//   <SF_HOME>-samples/sample-py  uv, pytest, ruff
// Each is a git repo with one commit on `main` and a local (not global) git identity.
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = `${resolve(process.env.SF_HOME || join(homedir(), '.sf'))}-samples`;
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

function make(name, files, lock) {
  const dir = join(root, name);
  if (existsSync(dir)) { console.log(`exists, skipped: ${dir}`); return; }
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  lock(dir);
  sh('git', ['init', '-q', '-b', 'main'], dir);
  sh('git', ['config', 'user.name', 'sf e2e'], dir);
  sh('git', ['config', 'user.email', 'sf-e2e@localhost'], dir);
  sh('git', ['add', '-A'], dir);
  sh('git', ['commit', '-q', '-m', 'initial commit'], dir);
  console.log(`created ${dir}`);
}

make('sample-ts', {
  '.gitignore': 'node_modules/\n',
  'package.json': `${JSON.stringify({
    name: 'sample-ts', version: '0.0.0', private: true, type: 'module',
    scripts: { test: 'node --test', typecheck: 'tsc --noEmit' },
    devDependencies: { '@types/node': '^24.0.0', typescript: '^5.9.0' },
  }, null, 2)}\n`,
  'tsconfig.json': `${JSON.stringify({
    compilerOptions: {
      target: 'es2023', module: 'nodenext', moduleResolution: 'nodenext', strict: true, noEmit: true,
      allowImportingTsExtensions: true, erasableSyntaxOnly: true, types: ['node'],
    },
    include: ['src'],
  }, null, 2)}\n`,
  'src/math.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
  'src/math.test.ts': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './math.ts';\n\ntest('add', () => {\n  assert.equal(add(2, 3), 5);\n});\n",
  // npm is npm.cmd on Windows, which only a shell can start; the command is a fixed string.
}, (dir) => execSync('npm install --package-lock-only --no-audit --no-fund', { cwd: dir, stdio: 'inherit' }));

make('sample-py', {
  '.gitignore': '.venv/\n__pycache__/\n.pytest_cache/\n.ruff_cache/\n',
  'pyproject.toml': [
    '[project]', 'name = "sample-py"', 'version = "0.0.0"', 'requires-python = ">=3.12"', 'dependencies = []', '',
    '[dependency-groups]', 'dev = ["pytest>=8", "ruff>=0.6"]', '',
    '[tool.pytest.ini_options]', 'pythonpath = ["."]', '',
  ].join('\n'),
  'sample_py/__init__.py': '',
  'sample_py/math.py': 'def add(a: int, b: int) -> int:\n    return a + b\n',
  'tests/test_math.py': 'from sample_py.math import add\n\n\ndef test_add() -> None:\n    assert add(2, 3) == 5\n',
}, (dir) => sh('uv', ['lock', '--quiet'], dir));
