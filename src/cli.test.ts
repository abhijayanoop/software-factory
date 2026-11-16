import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'sf cli '));
  const repo = join(root, 'My Repo');
  await mkdir(repo);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, windowsHide: true });
  git('init', '-b', 'main');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@e.x');
  await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  git('add', '-A');
  git('commit', '-m', 'init');
  const sf = (...a: string[]) => {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, 'cli.ts'), ...a], {
      env: { ...process.env, SF_HOME: join(root, 'home') }, encoding: 'utf8', windowsHide: true,
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return { root, repo, sf };
}

test('repo add -> ticket add -> spec --file -> ready', async () => {
  const { root, repo, sf } = await setup();
  try {
    const add = sf('repo', 'add', repo);
    assert.equal(add.code, 0, add.err);
    assert.equal(JSON.parse(add.out).kind, 'ts');
    const t = sf('ticket', 'add', 'my-repo', '--title', 'Do it', '--body', 'body');
    assert.equal(t.code, 0, t.err);
    const id = t.out.trim();
    assert.match(id, /^T-\d+$/);
    const specFile = join(root, 'spec.md');
    await writeFile(specFile, '# spec');
    assert.equal(sf('spec', id, '--file', specFile).code, 0);
    assert.equal(sf('ready', id).code, 0);
    const show = JSON.parse(sf('ticket', 'show', id, '--json').out);
    assert.equal(show.state, 'ready');
    assert.equal(show.spec, '# spec');
    assert.match(sf('ticket', 'list', '--state', 'ready').out, new RegExp(id));
    assert.equal(sf('ticket', 'list', '--state', 'bogus').code, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ready on a new ticket exits 1 with illegal transition', async () => {
  const { root, repo, sf } = await setup();
  try {
    sf('repo', 'add', repo);
    const id = sf('ticket', 'add', 'my-repo', '--title', 't', '--body', 'b').out.trim();
    const r = sf('ready', id);
    assert.equal(r.code, 1);
    assert.match(r.err, /illegal transition/);
    assert.equal(sf('spec', id, '--agent').code, 0);
    const h = new DatabaseSync(join(root, 'home', 'sf.db'));
    const ev = h.prepare("SELECT actor FROM events WHERE ticket_id=? AND to_state='specifying'").all(id);
    h.close();
    assert.deepEqual(ev.map((e) => e.actor), ['human']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gate actions validate flags, ids and state', async () => {
  const { root, repo, sf } = await setup();
  try {
    sf('repo', 'add', repo);
    const id = sf('ticket', 'add', 'my-repo', '--title', 't', '--body', 'b').out.trim();
    assert.match(sf('reject', id).err, /--note required/);
    assert.match(sf('answer', id, '--note', 'x').err, /Unknown option/);
    assert.match(sf('approve', 'nope').err, /invalid ticket id/);
    const r = sf('approve', id);
    assert.equal(r.code, 1);
    assert.match(r.err, /illegal transition new -> integrating/);
    const h = new DatabaseSync(join(root, 'home', 'sf.db'));
    h.prepare("UPDATE tickets SET state='awaiting_approval', attempt=2 WHERE id=?").run(id);
    h.close();
    assert.equal(sf('reject', id, '--note', 'redo it').code, 0);
    const t = JSON.parse(sf('ticket', 'show', id, '--json').out);
    assert.deepEqual([t.state, t.attempt, t.humanNote], ['ready', 0, 'redo it']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ticket title is stored verbatim', async () => {
  const { root, repo, sf } = await setup();
  try {
    sf('repo', 'add', repo);
    const id = sf('ticket', 'add', 'my-repo', '--title', '$(rm -rf ~)', '--body', 'b').out.trim();
    assert.equal(JSON.parse(sf('ticket', 'show', id, '--json').out).title, '$(rm -rf ~)');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('non-git path and bad id are rejected', async () => {
  const { root, sf } = await setup();
  try {
    assert.equal(sf('repo', 'add', root).code, 1);
    assert.equal(sf('ticket', 'show', 'nope').code, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('repo profile rejects malformed profile', async () => {
  const { root, repo, sf } = await setup();
  try {
    sf('repo', 'add', repo);
    const f = join(root, 'p.json');
    await writeFile(f, JSON.stringify({ kind: 'ts', setup: [], checks: [{ name: 'x', cmd: [] }] }));
    const r = sf('repo', 'profile', 'my-repo', '--file', f);
    assert.equal(r.code, 1);
    assert.match(r.err, /invalid profile/);
    await writeFile(f, JSON.stringify({ kind: 'ts', setup: [['a']], checks: [{ name: 'x', cmd: ['b'] }] }));
    assert.equal(sf('repo', 'profile', 'my-repo', '--file', f).code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('spec --file replaces the spec of a specified ticket; show prints blocked reason and note', async () => {
  const { root, repo, sf } = await setup();
  try {
    sf('repo', 'add', repo);
    const id = sf('ticket', 'add', 'my-repo', '--title', 't', '--body', 'b').out.trim();
    const f = join(root, 'spec.md');
    await writeFile(f, '# one');
    assert.equal(sf('spec', id, '--file', f).code, 0);
    await writeFile(f, '# two');
    const r = sf('spec', id, '--file', f);
    assert.equal(r.code, 0, r.err);
    const t = JSON.parse(sf('ticket', 'show', id, '--json').out);
    assert.deepEqual([t.state, t.spec], ['specified', '# two']);
    const h = new DatabaseSync(join(root, 'home', 'sf.db'));
    assert.equal(h.prepare("SELECT COUNT(*) n FROM events WHERE ticket_id=? AND type='note'").get(id)!.n, 1);
    h.prepare("UPDATE tickets SET state='blocked', blocked_from='building', blocked_reason='why?', human_note='hint' WHERE id=?").run(id);
    h.close();
    assert.match(sf('ticket', 'show', id).out, /blocked: why\?\nnote: hint/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
