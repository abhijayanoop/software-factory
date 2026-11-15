import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { openDb } from './db.ts';
import { addRepo, createTicket, getTicket, note } from './store.ts';
import { FakeSandbox } from './sandbox.ts';
import { acquireLock, createServer } from './server.ts';

const home = mkdtempSync(join(tmpdir(), 'sf srv '));
process.env.SF_HOME = home;
const webDist = join(home, 'dist');
mkdirSync(webDist);
writeFileSync(join(webDist, 'index.html'), '<h1>hi</h1>');
writeFileSync(join(home, 'secret.txt'), 'secret');
const db = openDb(join(home, 'sf.db'));
addRepo(db, { id: 'r', path: '/nowhere', targetBranch: 'main', profile: { kind: 'ts', setup: [], checks: [] } });
createTicket(db, { repoId: 'r', title: 't', body: 'b' });
db.prepare("UPDATE tickets SET state='awaiting_approval' WHERE id='T-1'").run();

let server: Server, base: string, port: number;
before(async () => {
  server = createServer(db, { port: 0, webDist, sandbox: new FakeSandbox() });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
});
after(() => { server.closeAllConnections(); server.close(); });

const post = (path: string, o: { origin?: string | null; type?: string | null; body?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (o.origin !== null) headers.Origin = o.origin ?? base;
  if (o.type !== null) headers['Content-Type'] = o.type ?? 'application/json';
  return fetch(base + path, { method: 'POST', headers, body: o.body ?? '{}' });
};

test('POST without application/json -> 415', async () => {
  assert.equal((await post('/api/tickets/T-1/approve', { type: 'text/plain' })).status, 415);
});

test('POST with foreign or missing Origin -> 403', async () => {
  assert.equal((await post('/api/tickets/T-1/approve', { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post('/api/tickets/T-1/approve', { origin: null })).status, 403);
  assert.equal(getTicket(db, 'T-1')!.state, 'awaiting_approval');
});

test('ids: malformed 400, unknown 404', async () => {
  assert.equal((await fetch(base + '/api/tickets/nope')).status, 400);
  assert.equal((await fetch(base + '/api/tickets/T-99')).status, 404);
  assert.equal((await post('/api/tickets/T-99/approve')).status, 404);
});

test('reject needs a note; oversized body 413', async () => {
  assert.equal((await post('/api/tickets/T-1/reject')).status, 400);
  assert.equal((await post('/api/tickets/T-1/answer')).status, 400);
  assert.equal((await post('/api/tickets/T-1/approve', { body: 'x'.repeat(70_000) })).status, 413);
});

test('GET ticket and list', async () => {
  const j = await (await fetch(base + '/api/tickets/T-1')).json() as { ticket: { id: string }; runs: unknown[]; events: unknown[] };
  assert.equal(j.ticket.id, 'T-1');
  assert.deepEqual(j.runs, []);
  assert.equal(((await (await fetch(base + '/api/tickets')).json()) as unknown[]).length, 1);
});

test('run log from offset, missing file empty', async () => {
  mkdirSync(join(home, 'logs'), { recursive: true });
  writeFileSync(join(home, 'logs', '5.jsonl'), 'hello world');
  assert.deepEqual(await (await fetch(base + '/api/runs/5/log?offset=6')).json(), { text: 'world', offset: 11 });
  assert.deepEqual(await (await fetch(base + '/api/runs/6/log?offset=3')).json(), { text: '', offset: 3 });
  assert.equal((await fetch(base + '/api/runs/x/log')).status, 400);
  assert.equal((await fetch(base + '/api/runs/5/log?offset=-1')).status, 400);
});

test('static: file, SPA fallback, traversal refused', async () => {
  assert.equal(await (await fetch(base + '/')).text(), '<h1>hi</h1>');
  assert.equal(await (await fetch(base + '/some/route')).text(), '<h1>hi</h1>');
  const raw = await fetch(base + '/..%2fsecret.txt');
  assert.notEqual(await raw.text(), 'secret');
});

test('SSE streams events', async () => {
  note(db, 'T-1', { hi: 1 });
  const ac = new AbortController();
  const res = await fetch(base + '/api/events', { signal: ac.signal, headers: { 'Last-Event-ID': '0' } });
  assert.match(res.headers.get('content-type')!, /text\/event-stream/);
  const chunk = await res.body!.getReader().read();
  assert.match(new TextDecoder().decode(chunk.value), /^id: \d+\ndata: /);
  ac.abort();
});

test('POST approve with good Origin -> 200 integrating; repeat -> 409', async () => {
  const r = await post('/api/tickets/T-1/approve', { origin: `http://localhost:${port}` });
  assert.equal(r.status, 200);
  assert.equal(getTicket(db, 'T-1')!.state, 'integrating');
  assert.equal((await post('/api/tickets/T-1/approve')).status, 409);
});

const lockPath = () => join(mkdtempSync(join(tmpdir(), 'sf lock ')), 'serve.lock');

test('second acquireLock with live pid throws; release frees', () => {
  const p = lockPath();
  const release = acquireLock(p);
  assert.throws(() => acquireLock(p), (e: Error) => e.message === `sf serve already running (pid ${process.pid})`);
  release();
  acquireLock(p)();
});

test('stale lock replaced', () => {
  const p = lockPath();
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(p, String(dead));
  const release = acquireLock(p);
  release();
});
