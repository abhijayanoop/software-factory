import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, tx, now, migrate, rowTo } from './db.ts';

test('openDb creates schema v1', () => {
  const db = openDb(':memory:');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ['repos', 'tickets', 'runs', 'events']) assert.ok(names.includes(t), t);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 1);
  assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
  migrate(db); // no-op, must not throw "table exists"
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 1);
});

test('tx rolls back on throw', () => {
  const db = openDb(':memory:');
  const ins = () => db.prepare("INSERT INTO repos VALUES ('r','/p','main','{}',?)").run(now());
  assert.throws(() => tx(db, () => { ins(); throw new Error('boom'); }), /boom/);
  assert.equal(db.prepare('SELECT count(*) c FROM repos').get()!.c, 0);
  assert.equal(tx(db, () => { ins(); return 7; }), 7);
  assert.equal(db.prepare('SELECT count(*) c FROM repos').get()!.c, 1);
});

test('rowTo camelCases columns', () => {
  assert.deepEqual(rowTo({ repo_id: 'r', worktree_path: null }), { repoId: 'r', worktreePath: null });
});

test('tx failing rollback does not mask original error', () => {
  const stub = { exec: (sql: string) => { if (sql === 'ROLLBACK') throw new Error('rollback failed'); } };
  assert.throws(() => tx(stub as never, () => { throw new Error('orig'); }), /orig/);
});
