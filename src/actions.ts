// Human gate actions, shared by the CLI and the server. Each returns false when it loses the CAS race.
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { sfHome } from './db.ts';
import * as store from './store.ts';
import { deleteBranch, removeWorktree } from './git.ts';
import type { Sandbox } from './sandbox.ts';
import type { Ticket, TicketState } from './types.ts';

type Deps = { db: DatabaseSync; sandbox: Sandbox };

function get(db: DatabaseSync, id: string, from?: TicketState, to?: TicketState): Ticket {
  const t = store.getTicket(db, id);
  if (!t) throw new Error(`no such ticket: ${id}`);
  if (from && t.state !== from) throw new Error(`illegal transition ${t.state} -> ${to}`);
  return t;
}

const human = (type: string, data?: unknown) => ({ type, actor: 'human' as const, data });

export function approve(db: DatabaseSync, id: string): boolean {
  const t = get(db, id, 'awaiting_approval', 'integrating');
  return store.transition(db, id, 'awaiting_approval', 'integrating', human('approval', { headSha: t.headSha }));
}

export function reject(db: DatabaseSync, id: string, note: string): boolean {
  get(db, id, 'awaiting_approval', 'ready');
  return store.transition(db, id, 'awaiting_approval', 'ready', human('rejection', { note }), { attempt: 0, humanNote: note });
}

// A spec-blocked ticket goes back to specifying, so no build starts without a spec a human accepted.
const restart = (t: Ticket): TicketState => (t.blockedFrom === 'specifying' ? 'specifying' : 'ready');

export function answer(db: DatabaseSync, id: string, text: string): boolean {
  const t = get(db, id, 'blocked', 'ready');
  return store.transition(db, id, 'blocked', restart(t), human('answer', { text }), { attempt: 0, humanNote: text });
}

export function retry(db: DatabaseSync, id: string): boolean {
  const t = get(db, id);
  if (t.state !== 'blocked' || !t.blockedFrom) throw new Error(`illegal transition ${t.state} -> ${t.blockedFrom ?? 'blocked_from'}`);
  return store.transition(db, id, 'blocked', t.blockedFrom, human('transition'), { attempt: 0 });
}

// Every removal is tried even if one fails; a failure becomes a note and sf doctor finds the leftovers.
export async function cleanup(db: DatabaseSync, sb: Sandbox, t: Ticket): Promise<void> {
  const name = `sf-${t.repoId}-${t.id}`;
  const repo = store.getRepo(db, t.repoId)!.path;
  const dir = join(sfHome(), 'worktrees', t.repoId);
  const wts = [t.worktreePath ?? join(dir, t.id), join(dir, `${t.id}-spec`), join(dir, `${t.id}-review`), join(dir, `${t.id}-integrate`)];
  for (const f of [...['', '-review', '-spec', '-integrate'].map((s) => () => sb.remove(name + s)), ...wts.map((wt) => () => removeWorktree(repo, wt))]) {
    try { await f(); } catch (e) { store.note(db, t.id, { cleanupFailed: (e as Error).message }); }
  }
}

// Fresh start from the current target tip: drops the worktree, sandbox and sf/<id> branch, then -> ready
// (or -> specifying for a spec-blocked ticket).
export async function reset({ db, sandbox }: Deps, id: string): Promise<boolean> {
  const t = get(db, id, 'blocked', 'ready');
  await cleanup(db, sandbox, t);
  await deleteBranch(store.getRepo(db, t.repoId)!.path, `sf/${t.id}`);
  return store.transition(db, id, 'blocked', restart(t), human('transition', { reset: true }),
    { worktreePath: null, baseSha: null, headSha: null, attempt: 0 });
}

// R3: with a live run for this ticket the supervisor's heartbeat aborts it and cleans up; otherwise we do.
export async function cancel({ db, sandbox }: Deps, id: string): Promise<boolean> {
  const t = get(db, id);
  if (!store.transition(db, id, t.state, 'cancelled', human('transition'))) return false;
  if (store.activeRun(db)?.ticketId === id) return true;
  await cleanup(db, sandbox, t);
  return true;
}
