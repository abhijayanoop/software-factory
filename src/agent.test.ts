import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStream, runAgent } from './agent.ts';
import { FakeSandbox } from './sandbox.ts';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const res = (text: string, extra = {}) => JSON.stringify({ type: 'result', is_error: false, result: text, ...extra });

test('parseStream done fixture', () => {
  const r = parseStream(fx('stream-done.jsonl'));
  assert.equal(r.kind, 'done');
  assert.equal(r.ok, true);
  assert.equal(r.summary, 'created hello.txt');
  assert.ok(typeof r.costUsd === 'number');
});

test('parseStream rate limited fixture', () => {
  const r = parseStream(fx('stream-rate-limited.jsonl'));
  assert.equal(r.kind, 'rate_limited');
  assert.equal(r.resetAt, '2026-11-15T23:00:00.000Z');
});

test('parseStream missing result / invalid final line gives error', () => {
  assert.equal(parseStream('{"type":"system"}\n').kind, 'error');
  assert.equal(parseStream(res('all done, no json')).kind, 'error');
  assert.equal(parseStream(res('{"status":"weird","summary":"x"}')).kind, 'error');
  assert.equal(parseStream(res('{"status":"done","summary":"x","findings":[{"severity":"nope","text":"t"}]}')).kind, 'error');
});

test('parseStream needs_human with question and findings', () => {
  const r = parseStream(res('hm\n{"status":"needs_human","summary":"s","question":"which?","findings":[{"severity":"minor","text":"t","file":"a.ts","line":3}]}'));
  assert.equal(r.kind, 'needs_human');
  assert.equal(r.question, 'which?');
  assert.equal(r.findings?.length, 1);
});

test('runAgent with FakeSandbox timeout gives kind timeout', async () => {
  const sb = new FakeSandbox(() => ({ code: 0, hang: true }));
  const dir = mkdtempSync(join(tmpdir(), 'sf-agent-'));
  const r = await runAgent(sb, 'n', 'spec', 'prompt', join(dir, 'l.jsonl'), { timeoutMs: 20 });
  assert.equal(r.kind, 'timeout');
  assert.equal(r.summary, 'timed out');
});

test('runAgent passes prompt on stdin, not argv, and parses log', async () => {
  const sb = new FakeSandbox(() => ({ code: 0, stdout: fx('stream-done.jsonl') }));
  const dir = mkdtempSync(join(tmpdir(), 'sf-agent-'));
  const r = await runAgent(sb, 'n', 'build', 'SECRET TICKET', join(dir, 'x', 'l.jsonl'), { systemPrompt: 'SYS' });
  assert.equal(r.kind, 'done');
  const c = sb.calls[0];
  assert.equal(c.stdin, 'SECRET TICKET');
  assert.ok(!c.argv.includes('SECRET TICKET'));
  assert.deepEqual(c.argv.slice(-2), ['--append-system-prompt', 'SYS']);
});
