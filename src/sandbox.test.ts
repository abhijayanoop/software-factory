import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSbxCreateArgs, buildSbxExecArgs, FakeSandbox } from './sandbox.ts';

test('buildSbxCreateArgs maps ro mounts to PATH:ro and adds --static-mcp context7', () => {
  const a = buildSbxCreateArgs('sf-r-T-1', [{ path: 'C:/w' }, { path: 'C:/git', ro: true }]);
  assert.deepEqual(a, ['--no-input', 'create', 'claude', 'C:/w', 'C:/git:ro', '--name', 'sf-r-T-1',
    '-t', 'sf-claude-node24', '--pull', 'never', '--static-mcp', 'context7']);
  assert.equal(buildSbxCreateArgs('n', [{ path: 'p', ro: true }])[3], 'p:ro');
});

test('buildSbxExecArgs keeps prompt off argv', () => {
  assert.deepEqual(buildSbxExecArgs('n', ['claude', '-p'], true), ['exec', '-i', 'n', 'claude', '-p']);
  assert.deepEqual(buildSbxExecArgs('n', ['git', 'status'], false), ['exec', 'n', 'git', 'status']);
});

test('FakeSandbox hang resolves on abort and on timeout', async () => {
  const sb = new FakeSandbox(() => ({ code: 0, hang: true }));
  const t = await sb.exec('n', ['x'], { timeoutMs: 20, logPath: 'unused' });
  assert.deepEqual(t, { code: 124, timedOut: true });
  const ac = new AbortController();
  const p = sb.exec('n', ['x'], { timeoutMs: 60000, logPath: 'unused', signal: ac.signal });
  ac.abort();
  const r = await p;
  assert.equal(r.timedOut, false);
  assert.notEqual(r.code, 0);
});
