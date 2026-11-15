import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectProfile } from './profiles.ts';

async function fx(files: Record<string, string>) {
  const d = await mkdtemp(join(tmpdir(), 'sf prof '));
  for (const [k, v] of Object.entries(files)) await writeFile(join(d, k), v);
  return d;
}

test('npm profile', async () => {
  const d = await fx({ 'package.json': JSON.stringify({ scripts: { typecheck: 'x', test: 'y', build: 'z' } }) });
  assert.deepEqual(detectProfile(d), { kind: 'ts', setup: [['npm', 'ci']], checks: [
    { name: 'typecheck', cmd: ['npm', 'run', 'typecheck'] }, { name: 'test', cmd: ['npm', 'run', 'test'] }] });
  await rm(d, { recursive: true, force: true });
});

test('pnpm profile', async () => {
  const d = await fx({ 'package.json': JSON.stringify({ scripts: { lint: 'x' } }), 'pnpm-lock.yaml': '' });
  const p = detectProfile(d);
  assert.deepEqual(p.setup, [['pnpm', 'install', '--frozen-lockfile']]);
  assert.deepEqual(p.checks, [{ name: 'lint', cmd: ['pnpm', 'run', 'lint'] }]);
  await rm(d, { recursive: true, force: true });
});

test('python profile', async () => {
  const d = await fx({ 'pyproject.toml': '[tool.ruff]\n[tool.pytest.ini_options]\n' });
  assert.deepEqual(detectProfile(d), { kind: 'py', setup: [['uv', 'sync']], checks: [
    { name: 'ruff', cmd: ['uv', 'run', 'ruff', 'check', '.'] }, { name: 'pytest', cmd: ['uv', 'run', 'pytest'] }] });
  await rm(d, { recursive: true, force: true });
});

test('empty dir and no-check package throw', async () => {
  const d = await fx({});
  assert.throws(() => detectProfile(d), /no checks detected/);
  const e = await fx({ 'package.json': '{}' });
  assert.throws(() => detectProfile(e), /no checks detected/);
  await rm(d, { recursive: true, force: true });
  await rm(e, { recursive: true, force: true });
});
