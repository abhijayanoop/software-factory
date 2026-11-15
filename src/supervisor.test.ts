import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from './db.ts';
import { addRepo, createTicket, events, getTicket, transition } from './store.ts';
import { FakeSandbox } from './sandbox.ts';
import { createSupervisor } from './supervisor.ts';

const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const result = (text: string, extra = {}) => JSON.stringify({ type: 'result', is_error: false, result: text, ...extra }) + '\n';
const done = (o: object = {}) => result(`work\n${JSON.stringify({ status: 'done', summary: 's', ...o })}`);
const isReview = (stdin?: string) => !!stdin?.includes('<<<DIFF-');

function setup(state: 'ready' | 'specifying' = 'ready') {
  const root = mkdtempSync(join(tmpdir(), 'sf sup '));
  const home = join(root, 'home');
  process.env.SF_HOME = home;
  mkdirSync(home);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  sh(repo, 'init', '-b', 'main');
  sh(repo, 'config', 'user.name', 'T');
  sh(repo, 'config', 'user.email', 't@e.x');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-m', 'init');
  const db = openDb(join(home, 'sf.db'));
  addRepo(db, { id: 'r', path: repo, targetBranch: 'main', profile: { kind: 'ts', setup: [['setup']], checks: [{ name: 'a', cmd: ['check', 'a'] }] } });
  createTicket(db, { repoId: 'r', title: 'Add X', body: 'BODY_TEXT' });
  if (state === 'specifying') transition(db, 'T-1', 'new', 'specifying', { type: 'transition', actor: 'human' });
  else {
    transition(db, 'T-1', 'new', 'specified', { type: 'transition', actor: 'human' });
    transition(db, 'T-1', 'specified', 'ready', { type: 'transition', actor: 'human' });
  }
  return { db, repo, home, wt: join(home, 'worktrees', 'r', 'T-1') };
}

// FakeSandbox script: build writes a file into the worktree; review/check outcomes come from the callbacks.
function fake(wt: string, o: { build?: (n: number) => string; review?: (n: number) => string; check?: (n: number) => number } = {}) {
  let b = 0, r = 0, c = 0;
  return new FakeSandbox((argv, stdin) => {
    if (argv[0] === 'claude') {
      if (isReview(stdin)) return { code: 0, stdout: (o.review ?? (() => done({ findings: [] })))(++r) };
      writeFileSync(join(wt, `f${++b}.txt`), `${b}\n`);
      return { code: 0, stdout: (o.build ?? (() => done()))(b) };
    }
    if (argv[0] === 'check') return { code: (o.check ?? (() => 0))(++c), stdout: `check output ${c}\n` };
    return { code: 0 };
  });
}

async function drive(sup: { step(): Promise<string> }) {
  let r;
  for (let i = 0; i < 50; i++) if ((r = await sup.step()) !== 'worked') return r;
  throw new Error('did not settle');
}

const runKinds = (db: ReturnType<typeof openDb>) => db.prepare('SELECT kind FROM runs ORDER BY id').all().map((x) => x.kind);

test('happy path reaches awaiting_approval', async () => {
  const { db, repo, wt } = setup();
  const sb = fake(wt);
  const graphify = async (p: string) => { mkdirSync(join(p, 'graphify-out')); writeFileSync(join(p, 'graphify-out', 'g.json'), '{}'); };
  assert.equal(await drive(createSupervisor({ db, sandbox: sb, graphify })), 'idle');
  const t = getTicket(db, 'T-1')!;
  assert.equal(t.state, 'awaiting_approval');
  assert.equal(sh(repo, 'rev-list', '--count', 'main..sf/T-1'), '1');
  assert.equal(sh(repo, 'log', '-1', '--format=%s', 'sf/T-1'), 'T-1: Add X (attempt 1)');
  assert.equal(t.headSha, sh(repo, 'rev-parse', 'sf/T-1'));
  assert.deepEqual(runKinds(db), ['build', 'verify', 'review']);
  assert.deepEqual(sb.calls.map((c) => c.argv[0]), ['setup', 'claude', 'check', 'claude']);
  assert.equal(sb.creates[0].mounts[0].ro, undefined);
  // graphify output is excluded, never committed
  assert.ok(!sh(repo, 'show', '--name-only', '--format=', 'sf/T-1').includes('graphify-out'));
  assert.match(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^graphify-out\/$/m);
  assert.match(sb.calls[1].stdin!, /Checks you will be judged by[\s\S]*check a/);
});

test('ticket body is passed on stdin', async () => {
  const { db, wt } = setup();
  const sb = fake(wt);
  await drive(createSupervisor({ db, sandbox: sb }));
  const build = sb.calls.find((c) => c.argv[0] === 'claude')!;
  assert.ok(build.stdin!.includes('BODY_TEXT'));
  assert.ok(!build.argv.join(' ').includes('BODY_TEXT'));
});

test('check fails 3x -> blocked', async () => {
  const { db, wt } = setup();
  const sb = fake(wt, { check: () => 1 });
  assert.equal(await drive(createSupervisor({ db, sandbox: sb })), 'idle');
  const t = getTicket(db, 'T-1')!;
  assert.equal(t.state, 'blocked');
  assert.equal(t.blockedFrom, 'building');
  assert.equal(t.attempt, 3);
  assert.deepEqual(runKinds(db), ['build', 'verify', 'build', 'verify', 'build', 'verify']);
  // the failing check's log tail is fed to the next build
  const builds = sb.calls.filter((c) => c.argv[0] === 'claude');
  assert.ok(!builds[0].stdin!.includes('PREVIOUS_FAILURE_OUTPUT'));
  assert.ok(builds[1].stdin!.includes('check output 1'));
});

test('needs_human -> blocked with the question', async () => {
  const { db, wt } = setup();
  const sb = fake(wt, { build: () => result(JSON.stringify({ status: 'needs_human', summary: 's', question: 'Which DB?' })) });
  await drive(createSupervisor({ db, sandbox: sb }));
  const t = getTicket(db, 'T-1')!;
  assert.equal(t.state, 'blocked');
  assert.equal(t.blockedFrom, 'building');
  assert.equal(t.blockedReason, 'Which DB?');
});

test('rate_limited does not count attempt and pauses', async () => {
  const { db, wt } = setup();
  let now = new Date('2026-11-16T10:00:00Z');
  const sb = fake(wt, { build: (n) => (n === 1 ? JSON.stringify({ type: 'result', is_error: true, api_error_status: 429, result: 'usage limit' }) + '\n' : done()) });
  const sup = createSupervisor({ db, sandbox: sb, clock: () => now });
  assert.equal(await drive(sup), 'paused');
  const t = getTicket(db, 'T-1')!;
  assert.equal(t.state, 'building');
  assert.equal(t.attempt, 0);
  assert.ok(events(db, 'T-1').some((e) => e.type === 'note' && e.dataJson!.includes('pause')));
  now = new Date('2026-11-16T10:29:00Z');
  assert.equal(await sup.step(), 'paused');
  now = new Date('2026-11-16T10:31:00Z');
  assert.equal(await drive(sup), 'idle');
  assert.equal(getTicket(db, 'T-1')!.state, 'awaiting_approval');
  assert.deepEqual(runKinds(db), ['build', 'build', 'verify', 'review']);
});

test('blocking review finding -> building', async () => {
  const { db, wt } = setup();
  const sb = fake(wt, {
    review: (n) => done({ findings: n === 1 ? [{ severity: 'blocking', text: 'NO_TESTS', file: 'a.ts', line: 2 }] : [{ severity: 'minor', text: 'nit' }] }),
  });
  const sup = createSupervisor({ db, sandbox: sb });
  for (let i = 0; i < 4; i++) await sup.step(); // prepare, build, verify, review
  let t = getTicket(db, 'T-1')!;
  assert.equal(t.state, 'building');
  assert.equal(t.attempt, 1);
  assert.equal(await drive(sup), 'idle');
  t = getTicket(db, 'T-1')!;
  assert.equal(t.state, 'awaiting_approval');
  const builds = sb.calls.filter((c) => c.argv[0] === 'claude' && !isReview(c.stdin));
  assert.ok(builds[1].stdin!.includes('NO_TESTS'));
  assert.equal(sh(t.worktreePath!, 'log', '-1', '--format=%s'), 'T-1: Add X (attempt 2)');
});

test('spec run stores the final message minus the contract line', async () => {
  const { db, home } = setup('specifying');
  const sb = new FakeSandbox((argv) => ({ code: 0, stdout: argv[0] === 'claude' ? result('# Spec\n- [ ] works\n{"status":"done","summary":"s"}') : undefined }));
  assert.equal(await drive(createSupervisor({ db, sandbox: sb })), 'idle');
  const t = getTicket(db, 'T-1')!;
  assert.equal(t.state, 'specified');
  assert.equal(t.spec, '# Spec\n- [ ] works');
  assert.deepEqual(sb.creates[0], { name: 'sf-r-T-1-spec', mounts: [{ path: join(home, 'worktrees', 'r', 'T-1-spec'), ro: true }] });
  assert.deepEqual(sb.removes, ['sf-r-T-1-spec']);
  assert.ok(!existsSync(join(home, 'worktrees', 'r', 'T-1-spec')));
  assert.deepEqual(runKinds(db), ['spec']);
});

test('cancel mid-run aborts the run and cleans up', async () => {
  const { db, wt } = setup();
  const sb = new FakeSandbox((argv) => ({ code: 0, hang: argv[0] === 'claude' }));
  const sup = createSupervisor({ db, sandbox: sb, heartbeatMs: 10 });
  assert.equal(await sup.step(), 'worked'); // preparing -> building
  const p = sup.step();
  setTimeout(() => transition(db, 'T-1', 'building', 'cancelled', { type: 'transition', actor: 'human' }), 30);
  assert.equal(await p, 'worked');
  const run = db.prepare('SELECT state, heartbeat_at FROM runs').get()!;
  assert.equal(run.state, 'cancelled');
  assert.ok(run.heartbeat_at);
  assert.deepEqual(sb.removes, ['sf-r-T-1']);
  assert.ok(!existsSync(wt));
  assert.equal(await sup.step(), 'idle');
});

test('setup failure -> blocked (infra) with the reason', async () => {
  const { db } = setup();
  const sb = new FakeSandbox((argv) => ({ code: argv[0] === 'setup' ? 2 : 0 }));
  assert.equal(await drive(createSupervisor({ db, sandbox: sb })), 'idle');
  const t = getTicket(db, 'T-1')!;
  assert.equal(t.state, 'blocked');
  assert.equal(t.blockedFrom, 'preparing');
  assert.match(t.blockedReason!, /^infra: setup `setup` exited 2/);
});
