import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemPrompt, taskPrompt } from './prompts.ts';
import type { Ticket } from './types.ts';

const t = { id: 'T-1', title: 'Add X', body: 'BODY_TEXT', spec: 'SPEC_TEXT', humanNote: 'NOTE_TEXT' } as Ticket;

test('every role system prompt states the JSON contract', () => {
  for (const r of ['spec', 'build', 'review'] as const) {
    const s = systemPrompt(r);
    assert.match(s, /"status"/);
    assert.match(s, /last line/i);
  }
  assert.match(systemPrompt('build'), /never run git/i);
});

test('build task prompt carries spec, note, failure tail, contract', () => {
  const p = taskPrompt('build', t, { failureTail: 'TAIL_TEXT' });
  for (const s of ['SPEC_TEXT', 'NOTE_TEXT', 'TAIL_TEXT', '"status"']) assert.ok(p.includes(s), s);
  assert.ok(!p.includes('Partial work'));
});

test('partialWork adds the sentence', () => {
  assert.ok(taskPrompt('build', t, { partialWork: true }).includes('Partial work from an interrupted run may exist in this folder.'));
});

test('review task prompt contains diff and spec; spec role contains body', () => {
  const p = taskPrompt('review', t, { diff: 'DIFF_TEXT' });
  assert.ok(p.includes('DIFF_TEXT') && p.includes('SPEC_TEXT'));
  assert.ok(taskPrompt('spec', t, {}).includes('BODY_TEXT'));
});
