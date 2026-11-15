// The supervisor: one worker slot, moves one ticket one stage per step.
import type { DatabaseSync } from 'node:sqlite';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sfHome } from './db.ts';
import * as store from './store.ts';
import { ACTIVE, canTransition } from './states.ts';
import { addDetachedWorktree, addWorktree, commitAll, commonGitDir, diff, pathTracked, removeWorktree, revParse } from './git.ts';
import type { Sandbox } from './sandbox.ts';
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
  const cleanup = (repo: Repo, wt: string, name: string) => async () => { await sb.remove(name); await removeWorktree(repo.path, wt); };

  // Count a failed attempt and move to `to`; the failure that reaches max_attempts blocks instead (R4).
  function retry(t: Ticket, to: TicketState, reason: string, runId: number): void {
    const attempt = t.attempt + 1;
    const moved = to === t.state
      ? store.patchTicket(db, t.id, to, { attempt })
      : store.transition(db, t.id, t.state, to, ev(runId, { reason }), { attempt });
    if (moved && attempt >= t.maxAttempts) block(t.id, to, `gave up after ${attempt} failed attempts: ${reason}`, runId);
  }

  // Runs fn as a run row with heartbeats; a ticket cancelled mid-run aborts it, cleans up and yields null.
  async function withRun<T>(
    t: Ticket, kind: Run['kind'], name: string, onCancel: () => Promise<void>, fn: (c: RunCtx) => Promise<T>,
  ): Promise<{ runId: number; out: T } | null> {
    const runId = store.startRun(db, t.id, kind, name).id;
    const ac = new AbortController();
    let pid: number | undefined;
    const tick = () => {
      store.heartbeat(db, runId, pid);
      if (store.getTicket(db, t.id)?.state === 'cancelled') ac.abort();
    };
    tick();
    const timer = setInterval(tick, deps.heartbeatMs ?? 15_000);
    let out: T;
    try {
      out = await fn({
        logPath: join(sfHome(), 'logs', `${runId}.jsonl`), signal: ac.signal,
        onPid: (p) => { pid = p; store.heartbeat(db, runId, p); },
      });
    } catch (e) {
      store.finishRun(db, runId, 'failed', { error: (e as Error).message });
      throw e;
    } finally { clearInterval(timer); }
    tick(); // catch a cancel that landed after the last heartbeat
    if (ac.signal.aborted) {
      store.finishRun(db, runId, 'cancelled');
      await onCancel();
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
    const clean = cleanup(repo, wt, name);
    try {
      await removeWorktree(repo.path, wt); // a crashed earlier spec run may have left one
      await addDetachedWorktree(repo.path, wt, repo.targetBranch);
      await sb.create(name, [{ path: wt, ro: true }]);
      const res = await withRun(t, 'spec', name, async () => {}, agent(name, 'spec', taskPrompt('spec', t, {})));
      if (!res || setback(t, res.runId, res.out)) return;
      const text = (res.out.text ?? '').trimEnd().split('\n').slice(0, -1).join('\n').trim(); // drop the contract line
      store.finishRun(db, res.runId, 'succeeded', res.out);
      store.transition(db, t.id, 'specifying', 'specified', ev(res.runId), { spec: text });
    } finally { await clean(); }
  }

  async function prepare(t: Ticket, repo: Repo, profile: RepoProfile): Promise<void> {
    if (t.state === 'ready' && !store.transition(db, t.id, 'ready', 'preparing', ev())) return;
    const { wt, name } = paths(t);
    const branch = `sf/${t.id}`;
    const { baseSha } = await addWorktree(repo.path, wt, branch, repo.targetBranch);
    store.patchTicket(db, t.id, 'preparing', { worktreePath: wt, branch, baseSha });
    await sb.create(name, [{ path: wt }]);
    const logPath = join(sfHome(), 'logs', `${t.id}-setup.log`);
    for (const cmd of profile.setup) {
      const r = await sb.exec(name, cmd, { timeoutMs: TIMEOUTS.verify, logPath });
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
    // partialWork (lost-run recovery) arrives with Task 9.
    const prompt = taskPrompt('build', t, { failureTail, partialWork: false, checks: profile.checks.map((c) => c.cmd.join(' ')) });
    const res = await withRun(t, 'build', name, cleanup(repo, wt, name), agent(name, 'build', prompt));
    if (!res || setback(t, res.runId, res.out)) return;
    const head = (await commitAll(repo.path, wt, `${t.id}: ${t.title} (attempt ${t.attempt + 1})`)) ?? (await revParse(repo.path, `sf/${t.id}`));
    store.finishRun(db, res.runId, 'succeeded', res.out);
    store.transition(db, t.id, 'building', 'verifying', ev(res.runId), { headSha: head });
  }

  async function verify(t: Ticket, repo: Repo, profile: RepoProfile): Promise<void> {
    const { wt, name } = paths(t);
    const res = await withRun(t, 'verify', name, cleanup(repo, wt, name), async (c) => {
      for (const check of profile.checks) {
        const before = sizeOf(c.logPath);
        const r = await sb.exec(name, check.cmd, { timeoutMs: TIMEOUTS.verify, logPath: c.logPath, onPid: c.onPid, signal: c.signal });
        if (r.code !== 0 || r.timedOut) return { check: check.name, code: r.code, timedOut: r.timedOut, failureTail: tail(readFrom(c.logPath, before)) };
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
    const { wt, name } = paths(t);
    const prompt = taskPrompt('review', t, { diff: await diff(repo.path, t.baseSha!, t.headSha!) });
    // shortcut: review reuses the build sandbox (worktree rw, not ro); its edits are never committed by review.
    const res = await withRun(t, 'review', name, cleanup(repo, wt, name), agent(name, 'review', prompt));
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
  }

  async function step(): Promise<'worked' | 'idle' | 'paused'> {
    if (pausedUntil && clock() < pausedUntil) return 'paused';
    pausedUntil = null;
    if (store.activeRun(db)) return 'idle';
    // integrating is handled by the integrator (Task 10), not here.
    const t = store.listTickets(db).filter((x) => ACTIVE.includes(x.state) && x.state !== 'integrating')
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
    if (!t) return 'idle';
    const repo = store.getRepo(db, t.repoId)!;
    const profile = JSON.parse(repo.profileJson) as RepoProfile;
    try {
      if (t.state === 'specifying') await spec(t, repo);
      else if (t.state === 'ready' || t.state === 'preparing') await prepare(t, repo, profile);
      else if (t.state === 'building') await build(t, repo, profile);
      else if (t.state === 'verifying') await verify(t, repo, profile);
      else if (t.state === 'reviewing') await review(t, repo);
    } catch (e) {
      // infra failure (git, sandbox create, setup): park the ticket with the reason
      const cur = store.getTicket(db, t.id)!;
      if (canTransition(cur.state, 'blocked')) block(t.id, cur.state, `infra: ${(e as Error).message}`);
    }
    return 'worked';
  }

  return { step };
}
