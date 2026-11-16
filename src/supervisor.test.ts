import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from './db.ts';
import { activeRun, addRepo, createTicket, events, getTicket, heartbeat, patchTicket, startRun, transition } from './store.ts';
import { FakeSandbox } from './sandbox.ts';
import { createSupervisor, recover } from './supervisor.ts';
import { approve, cancel, reset } from './actions.ts';

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
  const { db, repo, wt, home } = setup();
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
  // review runs in its own sandbox on a throwaway checkout of the head (sbx needs a rw primary), removed afterwards
  const reviewWt = join(home, 'worktrees', 'r', 'T-1-review');
  assert.deepEqual(sb.creates[1], { name: 'sf-r-T-1-review', mounts: [{ path: reviewWt }] });
  assert.equal(sb.calls[3].name, 'sf-r-T-1-review');
  assert.deepEqual(sb.removes, ['sf-r-T-1-review']);
  assert.ok(!existsSync(reviewWt));
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
  assert.deepEqual(sb.creates[0], { name: 'sf-r-T-1-spec', mounts: [{ path: join(home, 'worktrees', 'r', 'T-1-spec') }] });
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

test('a host failure after a run finishes the run and blocks (slot not frozen)', async () => {
  const { db, repo, wt } = setup();
  const sb = new FakeSandbox((argv) => {
    if (argv[0] !== 'claude') return { code: 0 };
    writeFileSync(join(wt, 'x.txt'), 'x');
    rmSync(join(repo, '.git', 'worktrees', 'T-1', 'gitdir')); // commitAll can no longer find the worktree
    return { code: 0, stdout: done() };
  });
  assert.equal(await drive(createSupervisor({ db, sandbox: sb })), 'idle');
  assert.equal(activeRun(db), undefined);
  assert.equal(db.prepare('SELECT state FROM runs').get()!.state, 'failed');
  const t = getTicket(db, 'T-1')!;
  assert.equal(t.state, 'blocked');
  assert.match(t.blockedReason!, /^infra: no registered worktree/);
});

test('sandbox exit 125 on a check is retried once, then blocks as infra without counting an attempt', async () => {
  const { db, wt } = setup();
  const sb = fake(wt, { check: () => 125 });
  assert.equal(await drive(createSupervisor({ db, sandbox: sb })), 'idle');
  const t = getTicket(db, 'T-1')!;
  assert.equal(t.state, 'blocked');
  assert.equal(t.blockedFrom, 'verifying');
  assert.equal(t.attempt, 0);
  assert.match(t.blockedReason!, /^infra: sandbox exec `check a` failed \(exit 125\) twice/);
  assert.equal(sb.calls.filter((c) => c.argv[0] === 'check').length, 2);
  assert.equal(activeRun(db), undefined);
});

test('an empty spec result is a failure, not an empty spec', async () => {
  const { db } = setup('specifying');
  const sb = new FakeSandbox((argv) => ({ code: 0, stdout: argv[0] === 'claude' ? result('{"status":"done","summary":"s"}') : undefined }));
  assert.equal(await drive(createSupervisor({ db, sandbox: sb })), 'idle');
  const t = getTicket(db, 'T-1')!;
  assert.equal(t.state, 'blocked');
  assert.equal(t.blockedFrom, 'specifying');
  assert.equal(t.spec, null);
  assert.deepEqual(runKinds(db), ['spec', 'spec', 'spec']);
});

test('a failing cancel cleanup is noted, step still resolves', async () => {
  const { db } = setup();
  const sb = new FakeSandbox((argv) => ({ code: 0, hang: argv[0] === 'claude' }));
  sb.remove = async () => { throw new Error('sbx rm exploded'); };
  const sup = createSupervisor({ db, sandbox: sb, heartbeatMs: 10 });
  await sup.step(); // preparing -> building
  const p = sup.step();
  setTimeout(() => transition(db, 'T-1', 'building', 'cancelled', { type: 'transition', actor: 'human' }), 30);
  assert.equal(await p, 'worked');
  assert.ok(events(db, 'T-1').some((e) => e.type === 'note' && e.dataJson!.includes('sbx rm exploded')));
});

// Drives T-1 to awaiting_approval; `base` is the target tip the branch was cut from.
async function toApproval(o: Parameters<typeof fake>[1] = {}) {
  const s = setup();
  const sb = fake(s.wt, o);
  const sup = createSupervisor({ db: s.db, sandbox: sb });
  assert.equal(await drive(sup), 'idle');
  assert.equal(getTicket(s.db, 'T-1')!.state, 'awaiting_approval');
  return { ...s, sb, sup, base: sh(s.repo, 'rev-parse', 'main') };
}
const userCommit = (repo: string, file: string, text: string) => {
  writeFileSync(join(repo, file), text);
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-m', `user ${file}`);
  return sh(repo, 'rev-parse', 'HEAD');
};

test('approve then integrate advances target with one squash commit', async () => {
  const { db, repo, wt, sb, sup, base } = await toApproval();
  const head = getTicket(db, 'T-1')!.headSha!;
  assert.equal(approve(db, 'T-1'), true);
  assert.ok(events(db, 'T-1').some((e) => e.type === 'approval' && e.actor === 'human' && JSON.parse(e.dataJson!).headSha === head));
  assert.equal(await drive(sup), 'idle');
  assert.equal(getTicket(db, 'T-1')!.state, 'done');
  assert.equal(sh(repo, 'rev-list', '--count', `${base}..main`), '1');
  assert.equal(sh(repo, 'rev-parse', 'main^'), base);
  assert.equal(sh(repo, 'log', '-1', '--format=%B', 'main'), 'T-1: Add X\n\nFactory-Ticket: T-1');
  assert.equal(sh(repo, 'log', '-1', '--format=%an', 'main'), 'T');
  assert.equal(sh(repo, 'rev-parse', 'main^{tree}'), sh(repo, 'rev-parse', `${head}^{tree}`));
  assert.ok(existsSync(join(repo, 'f1.txt'))); // checked-out target fast-forwarded
  assert.equal(sh(repo, 'rev-parse', 'sf/T-1'), head); // branch kept
  assert.ok(!existsSync(wt));
  assert.ok(sb.removes.includes('sf-r-T-1'));
  assert.ok(!sb.creates.some((c) => c.name.endsWith('-integrate'))); // target did not move: no recheck
  assert.equal(runKinds(db).at(-1), 'integrate');
  assert.equal(activeRun(db), undefined);
});

test('approval for old head_sha is rejected', async () => {
  const { db, repo, sup, base } = await toApproval();
  approve(db, 'T-1');
  patchTicket(db, 'T-1', 'integrating', { headSha: base });
  assert.equal(await drive(sup), 'idle');
  const t = getTicket(db, 'T-1')!;
  assert.equal(t.state, 'blocked');
  assert.equal(t.blockedFrom, 'integrating');
  assert.equal(t.blockedReason, 'approval stale');
  assert.equal(sh(repo, 'rev-parse', 'main'), base);
});

test('target moved and recheck passes -> done', async () => {
  const { db, repo, home, sb, sup } = await toApproval();
  const moved = userCommit(repo, 'b.txt', 'b\n');
  approve(db, 'T-1');
  assert.equal(await drive(sup), 'idle');
  assert.equal(getTicket(db, 'T-1')!.state, 'done');
  assert.equal(sh(repo, 'rev-parse', 'main^'), moved);
  assert.deepEqual(sh(repo, 'ls-tree', '--name-only', 'main').split('\n'), ['a.txt', 'b.txt', 'f1.txt']);
  const iwt = join(home, 'worktrees', 'r', 'T-1-integrate');
  assert.deepEqual(sb.creates.at(-1), { name: 'sf-r-T-1-integrate', mounts: [{ path: iwt }] });
  assert.deepEqual(sb.calls.filter((c) => c.name === 'sf-r-T-1-integrate').map((c) => c.argv[0]), ['setup', 'check']);
  assert.ok(sb.removes.includes('sf-r-T-1-integrate'));
  assert.ok(!existsSync(iwt));
});

test('target moved and recheck fails -> blocked', async () => {
  const { db, repo, home, sb, sup } = await toApproval({ check: (n) => (n === 1 ? 0 : 1) });
  const moved = userCommit(repo, 'b.txt', 'b\n');
  approve(db, 'T-1');
  assert.equal(await drive(sup), 'idle');
  const t = getTicket(db, 'T-1')!;
  assert.equal(t.state, 'blocked');
  assert.equal(t.blockedFrom, 'integrating');
  assert.equal(t.blockedReason, 'target moved and recheck failed: a exited 1');
  assert.equal(sh(repo, 'rev-parse', 'main'), moved);
  assert.ok(sb.removes.includes('sf-r-T-1-integrate'));
  assert.ok(!existsSync(join(home, 'worktrees', 'r', 'T-1-integrate')));
  assert.equal(activeRun(db), undefined);
});

test('conflict -> blocked; reset rebuilds from the current target tip', async () => {
  const { db, repo, wt, sb, sup } = await toApproval();
  const moved = userCommit(repo, 'f1.txt', 'theirs\n');
  approve(db, 'T-1');
  assert.equal(await drive(sup), 'idle');
  let t = getTicket(db, 'T-1')!;
  assert.equal(t.state, 'blocked');
  assert.match(t.blockedReason!, /conflict.*f1\.txt/);
  assert.equal(sh(repo, 'rev-parse', 'main'), moved);

  assert.equal(await reset({ db, sandbox: sb }, 'T-1'), true);
  t = getTicket(db, 'T-1')!;
  assert.equal(t.state, 'ready');
  assert.deepEqual([t.worktreePath, t.baseSha, t.headSha, t.attempt], [null, null, null, 0]);
  assert.ok(!existsSync(wt));
  assert.equal(await drive(sup), 'idle');
  t = getTicket(db, 'T-1')!;
  assert.equal(t.state, 'awaiting_approval');
  assert.equal(t.baseSha, moved);
  assert.equal(sh(repo, 'rev-list', '--count', 'main..sf/T-1'), '1');
});

test('recover marks dead-pid run lost and step redispatches with partialWork', async () => {
  const { db, wt } = setup();
  const sb = fake(wt);
  const sup = createSupervisor({ db, sandbox: sb });
  await sup.step(); // ready -> building
  const run = startRun(db, 'T-1', 'build', 'sf-r-T-1');
  heartbeat(db, run.id, 424242);
  assert.equal(await sup.step(), 'idle'); // slot held by the orphaned run
  recover(db, () => true);
  assert.equal(activeRun(db)?.id, run.id); // a live pid is left alone
  recover(db, (pid) => pid !== 424242);
  assert.equal(db.prepare('SELECT state FROM runs WHERE id=?').get(run.id)!.state, 'lost');
  assert.equal(await sup.step(), 'worked');
  const build = sb.calls.find((c) => c.argv[0] === 'claude')!;
  assert.match(build.stdin!, /Partial work from an interrupted run/);
  assert.equal(getTicket(db, 'T-1')!.state, 'verifying');
});

test('cancel during build kills run', async () => {
  const { db, wt } = setup();
  const sb = new FakeSandbox((argv) => ({ code: 0, hang: argv[0] === 'claude' }));
  const sup = createSupervisor({ db, sandbox: sb, heartbeatMs: 10 });
  await sup.step(); // ready -> building
  const p = sup.step();
  const c = new Promise((res) => setTimeout(() => res(cancel({ db, sandbox: sb }, 'T-1')), 30));
  assert.equal(await c, true);
  assert.deepEqual(sb.removes, []); // the run is live: the supervisor cleans up, not the action
  assert.equal(await p, 'worked');
  assert.equal(db.prepare('SELECT state FROM runs').get()!.state, 'cancelled');
  assert.equal(getTicket(db, 'T-1')!.state, 'cancelled');
  assert.deepEqual(sb.removes, ['sf-r-T-1']);
  assert.ok(!existsSync(wt));
});

test('cancel with no active run cleans up itself', async () => {
  const { db, repo, home, wt, sb } = await toApproval();
  const leftover = join(home, 'worktrees', 'r', 'T-1-integrate'); // e.g. from a crashed integrate
  sh(repo, 'worktree', 'add', '--detach', leftover, 'main');
  sb.removes.length = 0;
  assert.equal(await cancel({ db, sandbox: sb }, 'T-1'), true);
  assert.equal(getTicket(db, 'T-1')!.state, 'cancelled');
  assert.ok(sb.removes.includes('sf-r-T-1'));
  assert.ok(!existsSync(wt));
  assert.ok(!existsSync(leftover));
});

test('integrate after a crash past advanceTarget finishes without a second squash', async () => {
  const { db, repo, sup } = await toApproval();
  approve(db, 'T-1');
  assert.equal(await drive(sup), 'idle');
  // the crash left the ticket in integrating after the squash landed; the user committed on top since
  db.prepare("UPDATE tickets SET state='integrating' WHERE id='T-1'").run();
  const tip = userCommit(repo, 'f1.txt', 'user edit on top\n'); // would conflict if re-merged
  assert.equal(await drive(sup), 'idle');
  assert.equal(getTicket(db, 'T-1')!.state, 'done');
  assert.equal(sh(repo, 'rev-parse', 'main'), tip);
  assert.equal(sh(repo, 'log', '--format=%H', '--grep=^Factory-Ticket: T-1$', 'main').split('\n').length, 1);
  assert.deepEqual(db.prepare("SELECT state FROM runs WHERE kind='integrate'").all().map((r) => r.state), ['succeeded', 'succeeded']);
});

test('cancel during integrate recheck never advances the target', async () => {
  let onCheck = (_n: number) => 0;
  const { db, repo, home, sb, sup } = await toApproval({ check: (n) => onCheck(n) });
  const moved = userCommit(repo, 'b.txt', 'b\n');
  approve(db, 'T-1');
  onCheck = () => { transition(db, 'T-1', 'integrating', 'cancelled', { type: 'transition', actor: 'human' }); return 0; };
  assert.equal(await drive(sup), 'idle');
  assert.equal(getTicket(db, 'T-1')!.state, 'cancelled');
  assert.equal(sh(repo, 'rev-parse', 'main'), moved);
  assert.equal(db.prepare("SELECT state FROM runs WHERE kind='integrate'").get()!.state, 'cancelled');
  assert.ok(sb.removes.includes('sf-r-T-1-integrate'));
  assert.ok(sb.removes.includes('sf-r-T-1'));
  assert.ok(!existsSync(join(home, 'worktrees', 'r', 'T-1')));
});
