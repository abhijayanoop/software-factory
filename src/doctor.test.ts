import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { addRepo, createTicket, transition } from './store.ts';
import { findOrphans } from './doctor.ts';

test('findOrphans flags worktree and sandbox of done ticket, keeps active ones', () => {
  const db = openDb(':memory:');
  addRepo(db, { id: 'r1', path: '/p', targetBranch: 'main', profile: { kind: 'ts', setup: [], checks: [] } });
  const t1 = createTicket(db, { repoId: 'r1', title: 'a', body: 'b' });
  createTicket(db, { repoId: 'r1', title: 'c', body: 'd' });
  createTicket(db, { repoId: 'r1', title: 'e', body: 'f' });
  transition(db, t1.id, 'new', 'cancelled', { type: 'x', actor: 'human' });
  const r = findOrphans(db,
    ['/h/worktrees/r1/T-1', '/h/worktrees/r1/T-2', '/h/worktrees/r1/T-9'],
    ['sf-r1-T-1', 'sf-r1-T-2', 'sf-r1-T-3-review', 'sf-r1-T-1-spec', 'other-box', 'sf-garbage']);
  assert.deepEqual(r.worktrees, ['/h/worktrees/r1/T-1', '/h/worktrees/r1/T-9']);
  assert.deepEqual(r.sandboxes, ['sf-r1-T-1', 'sf-r1-T-1-spec']);
});
