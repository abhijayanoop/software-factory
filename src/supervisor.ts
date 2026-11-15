// The supervisor: one worker slot, moves one ticket one stage per step.
import type { DatabaseSync } from 'node:sqlite';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sfHome } from './db.ts';
import * as store from './store.ts';
import { ACTIVE, canTransition } from './states.ts';
import { addDetachedWorktree, addWorktree, advanceTarget, commitAll, commonGitDir, diff, findTrailerCommit, mergeTree, pathTracked, removeWorktree, revParse, squashCommit } from './git.ts';
import type { ExecOpts, Sandbox } from './sandbox.ts';
import { runAgent, TIMEOUTS } from './agent.ts';
import { systemPrompt, taskPrompt } from './prompts.ts';
import type { AgentResult, Repo, RepoProfile, Run, Ticket, TicketState } from './types.ts';

export type Deps = {
  db: DatabaseSync;
  sandbox: Sandbox;
  graphify?: (wt: string) => Promise<void>;
  clock?: () => Date;
  heartbeatMs?: number;
};
type RunCtx = { logPath: string; signal: AbortSignal; onPid: (pid: number) => void };

const PAUSE_MS = 30 * 60_000;
const TAIL_LINES = 200;
const SBX_FAILED = 125; // sandbox infra failure, not the command's own exit code

const sizeOf = (p: string) => { try { return statSync(p).size; } catch { return 0; } };
const readFrom = (p: string, at: number) => { try { return readFileSync(p).subarray(at).toString('utf8'); } catch { return ''; } };
const tail = (s: string) => s.trimEnd().split(/\r?\n/).slice(-TAIL_LINES).join('\n');

async function excludeGraphify(repoPath: string, ref: string): Promise<void> {
  if (await pathTracked(repoPath, ref, 'graphify-out')) return;
  const f = join(await commonGitDir(repoPath), 'info', 'exclude');
  const cur = existsSync(f) ? readFileSync(f, 'utf8') : '';
  if (cur.split(/\r?\n/).includes('graphify-out/')) return;
  mkdirSync(dirname(f), { recursive: true });
  appendFileSync(f, `${cur && !cur.endsWith('\n') ? '\n' : ''}graphify-out/\n`);
}

export function createSupervisor(deps: Deps): { step(): Promise<'worked' | 'idle' | 'paused'> } {
  const { db, sandbox: sb } = deps;
  const clock = deps.clock ?? (() => new Date());
  let pausedUntil: Date | null = null;

  const ev = (runId?: number, data?: unknown) => ({ type: 'transition', actor: 'supervisor' as const, runId, data });
  const block = (id: string, from: TicketState, reason: string, runId?: number) =>
    store.transition(db, id, from, 'blocked', ev(runId, { reason }), { blockedReason: reason });
  const paths = (t: Ticket) => ({ wt: t.worktreePath ?? join(sfHome(), 'worktrees', t.repoId, t.id), name: `sf-${t.repoId}-${t.id}` });

  // Spec §9: a sandbox infra failure (create throws, exec exits 125) is retried once, then thrown (-> blocked infra).
  async function create(name: string, mounts: { path: string; ro?: boolean }[]): Promise<void> {
    try { await sb.create(name, mounts); } catch { await sb.create(name, mounts); }
  }
  async function exec(name: string, argv: string[], o: ExecOpts): Promise<{ code: number; timedOut: boolean; before: number }> {
    for (let i = 0; ; i++) {
      const before = sizeOf(o.logPath);
      const r = await sb.exec(name, argv, o);
      if (r.code !== SBX_FAILED || o.signal?.aborted) return { ...r, before };
      if (i === 1) throw new Error(`sandbox exec \`${argv.join(' ')}\` failed (exit ${SBX_FAILED}) twice`);
    }
  }

  // Runs every cleanup even if one fails; step must not reject (the serve loop calls it forever), so a
  // failure becomes a note and sf doctor finds the leftovers.
  async function tidy(id: string, ...fns: (() => Promise<void>)[]): Promise<void> {
    for (const f of fns) {
      try { await f(); } catch (e) {
        try { store.note(db, id, { cleanupFailed: (e as Error).message }); } catch { console.error('cleanup failed', e); }
      }
    }
  }

  // Count a failed attempt and move to `to`; the failure that reaches max_attempts blocks instead (R4).
  function retry(t: Ticket, to: TicketState, reason: string, runId: number): void {
    const attempt = t.attempt + 1;
    const moved = to === t.state
      ? store.patchTicket(db, t.id, to, { attempt })
      : store.transition(db, t.id, t.state, to, ev(runId, { reason }), { attempt });
    if (moved && attempt >= t.maxAttempts) block(t.id, to, `gave up after ${attempt} failed attempts: ${reason}`, runId);
  }

  // Runs fn as a run row with heartbeats; a ticket cancelled mid-run aborts it and yields null (step cleans up).
  async function withRun<T>(t: Ticket, kind: Run['kind'], name: string, fn: (c: RunCtx) => Promise<T>): Promise<{ runId: number; out: T } | null> {
    const runId = store.startRun(db, t.id, kind, name).id;
    const ac = new AbortController();
    let pid: number | undefined;
    const tick = () => {
      try {
        store.heartbeat(db, runId, pid);
        if (store.getTicket(db, t.id)?.state === 'cancelled') ac.abort();
      } catch { /* a transient DB error must not crash the process; next tick retries */ }
    };
    tick();
    const timer = setInterval(tick, deps.heartbeatMs ?? 15_000);
    let out: T;
    try {
      out = await fn({
        logPath: join(sfHome(), 'logs', `${runId}.jsonl`), signal: ac.signal,
        onPid: (p) => { pid = p; tick(); },
      });
    } finally { clearInterval(timer); }
    tick(); // catch a cancel that landed after the last heartbeat
    if (ac.signal.aborted) {
      store.finishRun(db, runId, 'cancelled');
      return null;
    }
    return { runId, out };
  }

  // Non-done agent outcomes shared by spec, build and review. Returns true when it handled the result.
  function setback(t: Ticket, runId: number, r: AgentResult): boolean {
    if (r.kind === 'done') return false;
    store.finishRun(db, runId, r.kind === 'needs_human' ? 'succeeded' : 'failed', r);
    if (r.kind === 'rate_limited') {
      const reset = r.resetAt ? new Date(r.resetAt) : null;
      pausedUntil = reset && reset > clock() ? reset : new Date(clock().getTime() + PAUSE_MS);
      store.note(db, t.id, { pause: 'rate_limited', until: pausedUntil.toISOString() }, runId);
    } else if (r.kind === 'needs_human') block(t.id, t.state, r.question ?? r.summary, runId);
    else retry(t, t.state, r.summary, runId); // error / timeout: same stage again
    return true;
  }

  const agent = (name: string, role: 'spec' | 'build' | 'review', prompt: string) => (c: RunCtx) =>
    runAgent(sb, name, role, prompt, c.logPath, { systemPrompt: systemPrompt(role), onPid: c.onPid, signal: c.signal });

  async function spec(t: Ticket, repo: Repo): Promise<void> {
    const wt = join(sfHome(), 'worktrees', repo.id, `${t.id}-spec`);
    const name = `sf-${repo.id}-${t.id}-spec`;
    try {
      await removeWorktree(repo.path, wt); // a crashed earlier spec run may have left one
      await addDetachedWorktree(repo.path, wt, repo.targetBranch);
      await create(name, [{ path: wt, ro: true }]);
      const res = await withRun(t, 'spec', name, agent(name, 'spec', taskPrompt('spec', t, {})));
      if (!res || setback(t, res.runId, res.out)) return;
      const text = (res.out.text ?? '').trimEnd().split('\n').slice(0, -1).join('\n').trim(); // drop the contract line
      if (!text) {
        store.finishRun(db, res.runId, 'failed', { ...res.out, summary: 'spec run produced no spec text' });
        retry(t, 'specifying', 'spec run produced no spec text', res.runId);
        return;
      }
      store.finishRun(db, res.runId, 'succeeded', res.out);
      store.transition(db, t.id, 'specifying', 'specified', ev(res.runId), { spec: text });
    } finally {
      await sb.remove(name);
      await removeWorktree(repo.path, wt);
    }
  }

  async function prepare(t: Ticket, repo: Repo, profile: RepoProfile): Promise<void> {
    if (t.state === 'ready' && !store.transition(db, t.id, 'ready', 'preparing', ev())) return;
    const { wt, name } = paths(t);
    const branch = `sf/${t.id}`;
    const { baseSha } = await addWorktree(repo.path, wt, branch, repo.targetBranch);
    store.patchTicket(db, t.id, 'preparing', { worktreePath: wt, branch, baseSha });
    await create(name, [{ path: wt }]);
    const logPath = join(sfHome(), 'logs', `${t.id}-setup.log`);
    for (const cmd of profile.setup) {
      const r = await exec(name, cmd, { timeoutMs: TIMEOUTS.verify, logPath });
      if (r.code !== 0 || r.timedOut) throw new Error(`setup \`${cmd.join(' ')}\` ${r.timedOut ? 'timed out' : `exited ${r.code}`} (log: ${logPath})`);
    }
    if (deps.graphify) {
      await deps.graphify(wt);
      await excludeGraphify(repo.path, baseSha);
    }
    store.transition(db, t.id, 'preparing', 'building', ev());
  }

  async function build(t: Ticket, repo: Repo, profile: RepoProfile): Promise<void> {
    const { wt, name } = paths(t);
    const prev = store.latestRun(db, t.id, ['verify', 'review']);
    const failureTail = prev?.state === 'failed' && prev.resultJson ? JSON.parse(prev.resultJson).failureTail : undefined;
    const partialWork = store.latestRun(db, t.id, ['build'])?.state === 'lost';
    const prompt = taskPrompt('build', t, { failureTail, partialWork, checks: profile.checks.map((c) => c.cmd.join(' ')) });
    const res = await withRun(t, 'build', name, agent(name, 'build', prompt));
    if (!res || setback(t, res.runId, res.out)) return;
    const head = (await commitAll(repo.path, wt, `${t.id}: ${t.title} (attempt ${t.attempt + 1})`)) ?? (await revParse(repo.path, `sf/${t.id}`));
    store.finishRun(db, res.runId, 'succeeded', res.out);
    store.transition(db, t.id, 'building', 'verifying', ev(res.runId), { headSha: head });
  }

  async function verify(t: Ticket, profile: RepoProfile): Promise<void> {
    const { name } = paths(t);
    const res = await withRun(t, 'verify', name, async (c) => {
      for (const check of profile.checks) {
        const r = await exec(name, check.cmd, { timeoutMs: TIMEOUTS.verify, logPath: c.logPath, onPid: c.onPid, signal: c.signal });
        if (r.code !== 0 || r.timedOut) return { check: check.name, code: r.code, timedOut: r.timedOut, failureTail: tail(readFrom(c.logPath, r.before)) };
      }
      return null;
    });
    if (!res) return;
    if (res.out) {
      store.finishRun(db, res.runId, 'failed', res.out);
      retry(t, 'building', `check ${res.out.check} failed`, res.runId);
      return;
    }
    store.finishRun(db, res.runId, 'succeeded');
    store.transition(db, t.id, 'verifying', 'reviewing', ev(res.runId));
  }

  async function review(t: Ticket, repo: Repo): Promise<void> {
    const { wt } = paths(t);
    const name = `sf-${repo.id}-${t.id}-review`;
    const prompt = taskPrompt('review', t, { diff: await diff(repo.path, t.baseSha!, t.headSha!) });
    try {
      await create(name, [{ path: wt, ro: true }]);
      const res = await withRun(t, 'review', name, agent(name, 'review', prompt));
      if (!res || setback(t, res.runId, res.out)) return;
      const findings = res.out.findings ?? [];
      const blocking = findings.filter((f) => f.severity === 'blocking');
      if (blocking.length) {
        const failureTail = blocking.map((f) => `${f.file ? `${f.file}${f.line ? `:${f.line}` : ''}: ` : ''}${f.text}`).join('\n');
        store.finishRun(db, res.runId, 'failed', { ...res.out, failureTail });
        retry(t, 'building', `${blocking.length} blocking review finding(s)`, res.runId);
        return;
      }
      store.finishRun(db, res.runId, 'succeeded', res.out);
      store.transition(db, t.id, 'reviewing', 'awaiting_approval', ev(res.runId, { findings }));
    } finally { await sb.remove(name); }
  }

  // Profile setup + checks on the squash commit in a throwaway checkout; returns the failure, or null.
  async function recheck(t: Ticket, repo: Repo, profile: RepoProfile, sha: string, c: RunCtx): Promise<string | null> {
    const wt = join(sfHome(), 'worktrees', repo.id, `${t.id}-integrate`);
    const name = `sf-${repo.id}-${t.id}-integrate`;
    try {
      await removeWorktree(repo.path, wt); // a crashed earlier integrate may have left one
      await addDetachedWorktree(repo.path, wt, sha);
      await create(name, [{ path: wt }]);
      for (const k of [...profile.setup.map((cmd) => ({ name: cmd.join(' '), cmd })), ...profile.checks]) {
        const r = await exec(name, k.cmd, { timeoutMs: TIMEOUTS.verify, logPath: c.logPath, onPid: c.onPid, signal: c.signal });
        if (r.code !== 0 || r.timedOut) return `target moved and recheck failed: ${k.name} ${r.timedOut ? 'timed out' : `exited ${r.code}`}`;
      }
      return null;
    } finally {
      await tidy(t.id, () => sb.remove(name), () => removeWorktree(repo.path, wt));
    }
  }

  async function integrate(t: Ticket, repo: Repo, profile: RepoProfile): Promise<void> {
    const approved = store.events(db, t.id).some((e) => e.type === 'approval' && JSON.parse(e.dataJson ?? '{}').headSha === t.headSha);
    if (!t.headSha || !approved) { block(t.id, 'integrating', 'approval stale'); return; }
    const { wt, name } = paths(t);
    const res = await withRun(t, 'integrate', name, async (c): Promise<{ fail: string } | { sha: string; tip: string; landed?: true }> => {
      const tip = await revParse(repo.path, repo.targetBranch);
      // A crash after advanceTarget but before `done` re-runs this stage: never land the squash twice.
      const landed = await findTrailerCommit(repo.path, t.baseSha!, tip, t.id);
      if (landed) return { sha: landed, tip, landed: true };
      const m = await mergeTree(repo.path, tip, t.headSha!); // the approved commit, not whatever sf/<id> is now
      if ('conflict' in m) return { fail: `merge conflict: ${m.conflict.join(', ')}` };
      const sha = await squashCommit(repo.path, m.tree, tip, `${t.id}: ${t.title}\n\nFactory-Ticket: ${t.id}`);
      const fail = tip === t.baseSha ? null : await recheck(t, repo, profile, sha, c);
      return fail ? { fail } : { sha, tip };
    });
    if (!res) return;
    const out = res.out;
    const failed = (reason: string) => {
      store.finishRun(db, res.runId, 'failed', { reason });
      block(t.id, 'integrating', reason, res.runId);
    };
    if ('fail' in out) return failed(out.fail);
    if (!out.landed) {
      if (store.getTicket(db, t.id)?.state !== 'integrating') { // cancelled after the run's last heartbeat
        store.finishRun(db, res.runId, 'cancelled');
        return;
      }
      const adv = await advanceTarget(repo.path, repo.targetBranch, out.sha, out.tip);
      if (adv !== 'ok') return failed(adv === 'dirty' ? 'target branch checkout is dirty' : 'target branch moved');
    }
    store.finishRun(db, res.runId, 'succeeded', { squashSha: out.sha });
    if (!store.transition(db, t.id, 'integrating', 'done', ev(res.runId, { squashSha: out.sha }))) {
      store.note(db, t.id, { integratedDespiteCancel: out.sha }, res.runId); // cancel raced advanceTarget
      return;
    }
    await tidy(t.id, () => sb.remove(name), () => removeWorktree(repo.path, wt)); // the sf/<id> branch is kept
  }

  async function step(): Promise<'worked' | 'idle' | 'paused'> {
    if (pausedUntil && clock() < pausedUntil) return 'paused';
    pausedUntil = null;
    if (store.activeRun(db)) return 'idle';
    const t = store.listTickets(db).filter((x) => ACTIVE.includes(x.state))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
    if (!t) return 'idle';
    const repo = store.getRepo(db, t.repoId)!;
    const profile = JSON.parse(repo.profileJson) as RepoProfile;
    try {
      if (t.state === 'specifying') await spec(t, repo);
      else if (t.state === 'ready' || t.state === 'preparing') await prepare(t, repo, profile);
      else if (t.state === 'building') await build(t, repo, profile);
      else if (t.state === 'verifying') await verify(t, profile);
      else if (t.state === 'reviewing') await review(t, repo);
      else if (t.state === 'integrating') await integrate(t, repo, profile);
    } catch (e) {
      // infra failure (git, sandbox, setup): never leave a run open (it would freeze the slot), park the ticket
      const msg = (e as Error).message;
      const open = store.activeRun(db);
      if (open?.ticketId === t.id) store.finishRun(db, open.id, 'failed', { error: msg });
      const cur = store.getTicket(db, t.id)!;
      if (canTransition(cur.state, 'blocked')) block(t.id, cur.state, `infra: ${msg}`);
    }
    // Cancelled during this step (mid-run abort, or a lost CAS after the run): free its sandbox and worktree.
    if (t.state !== 'specifying' && store.getTicket(db, t.id)?.state === 'cancelled') {
      const { wt, name } = paths(store.getTicket(db, t.id)!);
      await tidy(t.id, () => sb.remove(name), () => removeWorktree(repo.path, wt));
    }
    return 'worked';
  }

  return { step };
}

// Startup recovery (spec §9): a starting/running run whose process is gone becomes `lost`; its ticket
// keeps its state, so the next step re-dispatches it (a re-build gets partialWork).
export function recover(db: DatabaseSync, isAlive: (pid: number) => boolean): void {
  for (const r of store.openRuns(db)) if (r.pid === null || !isAlive(r.pid)) store.finishRun(db, r.id, 'lost');
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
