import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { addRepo, getRepo, createTicket, getTicket, listTickets, transition, patchTicket, startRun, heartbeat, finishRun, activeRun, events, eventsSince } from './store.ts';

const profile = { kind: 'ts' as const, setup: [], checks: [] };
function setup() {
  const db = openDb(':memory:');
  addRepo(db, { id: 'r', path: '/p', targetBranch: 'main', profile });
  return db;
}
const mk = (db: ReturnType<typeof setup>) => createTicket(db, { repoId: 'r', title: 't', body: 'b' });
const sup = (type = 'x') => ({ type, actor: 'supervisor' as const });
const hum = (type = 'x') => ({ type, actor: 'human' as const });

test('repo roundtrip', () => {
  const db = setup();
  assert.equal(getRepo(db, 'r')!.targetBranch, 'main');
  assert.deepEqual(JSON.parse(getRepo(db, 'r')!.profileJson), profile);
  assert.equal(getRepo(db, 'nope'), undefined);
});

test('createTicket ids increment', () => {
  const db = setup();
  assert.equal(mk(db).id, 'T-1');
  assert.equal(mk(db).id, 'T-2');
  assert.equal(getTicket(db, 'T-2')!.state, 'new');
  assert.equal(listTickets(db, { state: 'new' }).length, 2);
  assert.equal(listTickets(db, { state: 'done' }).length, 0);
});

test('transition CAS', () => {
  const db = setup(); mk(db);
  assert.equal(transition(db, 'T-1', 'new', 'specifying', sup()), true);
  assert.equal(transition(db, 'T-1', 'new', 'specifying', sup()), false);
  assert.equal(events(db, 'T-1').length, 1);
  assert.equal(eventsSince(db, 0).length, 1);
  assert.equal(eventsSince(db, events(db, 'T-1')[0].id).length, 0);
});

test('transition illegal throws', () => {
  const db = setup(); mk(db);
  assert.throws(() => transition(db, 'T-1', 'new', 'done', sup()), /illegal transition/);
});

test('transition validates actor', () => {
  const db = setup(); mk(db);
  assert.throws(() => transition(db, 'T-1', 'new', 'specified', sup()), /illegal transition/);
  assert.throws(() => transition(db, 'T-1', 'new', 'specifying', hum()), /illegal transition/);
  assert.equal(transition(db, 'T-1', 'new', 'specified', hum()), true);
});

function toBuilding(db: ReturnType<typeof setup>) {
  mk(db);
  transition(db, 'T-1', 'new', 'specified', hum());
  transition(db, 'T-1', 'specified', 'ready', hum());
  transition(db, 'T-1', 'ready', 'preparing', sup());
  transition(db, 'T-1', 'preparing', 'building', sup());
}

test('blocked records blocked_from', () => {
  const db = setup(); toBuilding(db);
  transition(db, 'T-1', 'building', 'blocked', sup(), { blockedReason: 'why' });
  const t = getTicket(db, 'T-1')!;
  assert.equal(t.blockedFrom, 'building');
  assert.equal(t.blockedReason, 'why');
});

test('blocked exits restricted to blocked_from, ready, cancelled', () => {
  const db = setup(); toBuilding(db);
  transition(db, 'T-1', 'building', 'blocked', sup(), { blockedReason: 'why' });
  assert.throws(() => transition(db, 'T-1', 'blocked', 'verifying', hum()), /illegal transition/);
  assert.equal(transition(db, 'T-1', 'blocked', 'building', hum()), true);
  const t = getTicket(db, 'T-1')!;
  assert.equal(t.blockedFrom, null);
  assert.equal(t.blockedReason, null);
  transition(db, 'T-1', 'building', 'blocked', sup());
  assert.equal(transition(db, 'T-1', 'blocked', 'ready', hum()), true);
  transition(db, 'T-1', 'ready', 'preparing', sup());
  transition(db, 'T-1', 'preparing', 'blocked', sup());
  assert.equal(transition(db, 'T-1', 'blocked', 'cancelled', hum()), true);
});

test('patch applied atomically', () => {
  const db = setup(); mk(db);
  assert.equal(transition(db, 'T-1', 'new', 'specifying', sup(), { attempt: 2 }), true);
  assert.equal(getTicket(db, 'T-1')!.attempt, 2);
  assert.equal(transition(db, 'T-1', 'new', 'specifying', sup(), { attempt: 9 }), false);
  assert.equal(getTicket(db, 'T-1')!.attempt, 2);
  assert.throws(() => patchTicket(db, 'T-1', 'specifying', { id: 'x' } as never), /unknown patch field/);
  assert.equal(patchTicket(db, 'T-1', 'specifying', { attempt: 3, headSha: 'abc' }), true);
  assert.equal(patchTicket(db, 'T-1', 'new', { attempt: 4 }), false);
  assert.equal(getTicket(db, 'T-1')!.attempt, 3);
  assert.equal(getTicket(db, 'T-1')!.headSha, 'abc');
});

test('activeRun returns starting|running only', () => {
  const db = setup(); mk(db);
  assert.equal(activeRun(db), undefined);
  const r = startRun(db, 'T-1', 'build', 'sb');
  assert.equal(r.state, 'starting');
  assert.equal(activeRun(db)!.id, r.id);
  heartbeat(db, r.id, 42);
  assert.equal(activeRun(db)!.pid, 42);
  assert.equal(activeRun(db)!.state, 'running');
  finishRun(db, r.id, 'succeeded', { ok: true });
  assert.equal(activeRun(db), undefined);
});
