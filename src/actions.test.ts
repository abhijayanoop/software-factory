import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { addRepo, createTicket, events, getTicket } from './store.ts';
import { answer, approve, reject, retry } from './actions.ts';

function setup(state: string, blockedFrom: string | null = null) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'sf act ')), 'sf.db'));
  addRepo(db, { id: 'r', path: '/nowhere', targetBranch: 'main', profile: { kind: 'ts', setup: [], checks: [] } });
  createTicket(db, { repoId: 'r', title: 't', body: 'b' });
  db.prepare("UPDATE tickets SET state=?, blocked_from=?, attempt=2, head_sha='abc' WHERE id='T-1'").run(state, blockedFrom);
  return db;
}
const t1 = (db: ReturnType<typeof openDb>) => getTicket(db, 'T-1')!;

test('reject resets attempt and stores note', () => {
  const db = setup('awaiting_approval');
  assert.equal(reject(db, 'T-1', 'use a map'), true);
  assert.deepEqual([t1(db).state, t1(db).attempt, t1(db).humanNote], ['ready', 0, 'use a map']);
  const e = events(db, 'T-1').at(-1)!;
  assert.deepEqual([e.type, e.actor, JSON.parse(e.dataJson!)], ['rejection', 'human', { note: 'use a map' }]);
});

test('approve outside awaiting_approval is illegal', () => {
  const db = setup('blocked', 'integrating');
  assert.throws(() => approve(db, 'T-1'), /illegal transition blocked -> integrating/);
  assert.throws(() => approve(db, 'T-9'), /no such ticket/);
});

test('answer and retry leave blocked with attempt 0', () => {
  let db = setup('blocked', 'building');
  assert.equal(answer(db, 'T-1', 'postgres'), true);
  assert.deepEqual([t1(db).state, t1(db).attempt, t1(db).humanNote], ['ready', 0, 'postgres']);
  assert.equal(events(db, 'T-1').at(-1)!.type, 'answer');
  db = setup('blocked', 'verifying');
  assert.equal(retry(db, 'T-1'), true);
  assert.deepEqual([t1(db).state, t1(db).attempt], ['verifying', 0]);
  assert.throws(() => retry(db, 'T-1'), /illegal transition verifying/);
});
