import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, isHumanTransition, TRANSITIONS, ACTIVE, type TicketState } from './states.ts';

const edges = ['new>specifying', 'new>specified', 'specifying>specified', 'specified>ready', 'ready>preparing',
  'preparing>building', 'building>verifying', 'verifying>reviewing', 'reviewing>awaiting_approval',
  'awaiting_approval>integrating', 'awaiting_approval>ready', 'integrating>done', 'verifying>building',
  'reviewing>building', 'building>blocked', 'verifying>blocked', 'reviewing>blocked', 'preparing>blocked',
  'specifying>blocked', 'integrating>blocked', 'blocked>ready'];

test('spec edges allowed', () => {
  for (const e of edges) { const [f, t] = e.split('>') as TicketState[]; assert.ok(canTransition(f, t), e); }
});

test('cancel from every non-terminal', () => {
  for (const s of Object.keys(TRANSITIONS) as TicketState[]) {
    if (s === 'done' || s === 'cancelled') assert.equal(TRANSITIONS[s].length, 0);
    else { assert.ok(canTransition(s, 'cancelled'), s); assert.ok(isHumanTransition(s, 'cancelled'), s); }
  }
});

test('illegal edges', () => {
  for (const [f, t] of [['building', 'done'], ['done', 'ready'], ['cancelled', 'ready'], ['ready', 'integrating'],
    ['building', 'building']] as TicketState[][]) assert.equal(canTransition(f, t), false, `${f}>${t}`);
});

test('human edges', () => {
  assert.ok(isHumanTransition('specified', 'ready'));
  assert.ok(isHumanTransition('awaiting_approval', 'integrating'));
  assert.ok(isHumanTransition('awaiting_approval', 'ready'));
  assert.equal(isHumanTransition('building', 'verifying'), false);
  for (const t of TRANSITIONS.blocked) assert.ok(isHumanTransition('blocked', t), t);
  assert.ok(!TRANSITIONS.blocked.includes('done') && !TRANSITIONS.blocked.includes('blocked'));
});

test('ACTIVE', () => {
  assert.deepEqual([...ACTIVE].sort(), ['building', 'integrating', 'preparing', 'ready', 'reviewing', 'specifying', 'verifying']);
});
