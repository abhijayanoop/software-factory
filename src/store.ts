import type { DatabaseSync } from 'node:sqlite';
import { now, rowTo, tx } from './db.ts';
import { canTransition, isHumanTransition } from './states.ts';
import type { Event, Repo, RepoProfile, Run, Ticket, TicketState } from './types.ts';

const get = <T>(db: DatabaseSync, sql: string, ...args: (string | number)[]): T | undefined => {
  const r = db.prepare(sql).get(...args);
  return r ? rowTo<T>(r) : undefined;
};
const all = <T>(db: DatabaseSync, sql: string, ...args: (string | number)[]): T[] =>
  db.prepare(sql).all(...args).map((r) => rowTo<T>(r));

export function addRepo(db: DatabaseSync, r: { id: string; path: string; targetBranch: string; profile: RepoProfile }): Repo {
  db.prepare('INSERT INTO repos (id, path, target_branch, profile_json, created_at) VALUES (?,?,?,?,?)')
    .run(r.id, r.path, r.targetBranch, JSON.stringify(r.profile), now());
  return getRepo(db, r.id)!;
}

export function setProfile(db: DatabaseSync, id: string, profile: RepoProfile): void {
  db.prepare('UPDATE repos SET profile_json=? WHERE id=?').run(JSON.stringify(profile), id);
}

export const getRepo = (db: DatabaseSync, id: string): Repo | undefined => get<Repo>(db, 'SELECT * FROM repos WHERE id=?', id);

export function createTicket(db: DatabaseSync, t: { repoId: string; title: string; body: string }): Ticket {
  return tx(db, () => {
    const max = db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(id,3) AS INTEGER)),0) m FROM tickets").get()!.m as number;
    const id = `T-${max + 1}`;
    const ts = now();
    db.prepare("INSERT INTO tickets (id, repo_id, title, body, state, created_at, updated_at) VALUES (?,?,?,?,'new',?,?)")
      .run(id, t.repoId, t.title, t.body, ts, ts);
    return getTicket(db, id)!;
  });
}

export const getTicket = (db: DatabaseSync, id: string): Ticket | undefined => get<Ticket>(db, 'SELECT * FROM tickets WHERE id=?', id);

export function listTickets(db: DatabaseSync, filter?: { state?: TicketState }): Ticket[] {
  return filter?.state
    ? all<Ticket>(db, 'SELECT * FROM tickets WHERE state=? ORDER BY CAST(SUBSTR(id,3) AS INTEGER)', filter.state)
    : all<Ticket>(db, 'SELECT * FROM tickets ORDER BY CAST(SUBSTR(id,3) AS INTEGER)');
}

// Allowlist: camelCase Ticket field -> column. Never interpolate caller keys into SQL.
const COLUMNS: Partial<Record<keyof Ticket, string>> = {
  title: 'title', body: 'body', spec: 'spec', blockedFrom: 'blocked_from', blockedReason: 'blocked_reason',
  humanNote: 'human_note', branch: 'branch', worktreePath: 'worktree_path', baseSha: 'base_sha',
  headSha: 'head_sha', attempt: 'attempt', maxAttempts: 'max_attempts',
};

function setClause(patch: Partial<Ticket>, extra: Record<string, unknown>): { sql: string; vals: (string | number | null)[] } {
  const cols: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    const c = COLUMNS[k as keyof Ticket];
    if (!c) throw new Error(`unknown patch field: ${k}`);
    cols[c] = v;
  }
  Object.assign(cols, extra, { updated_at: now() });
  return { sql: Object.keys(cols).map((c) => `${c}=?`).join(', '), vals: Object.values(cols) as (string | number | null)[] };
}

export function transition(
  db: DatabaseSync, id: string, from: TicketState, to: TicketState,
  ev: { type: string; actor: 'human' | 'supervisor'; runId?: number; data?: unknown },
  patch: Partial<Ticket> = {},
): boolean {
  const illegal = () => new Error(`illegal transition ${from} -> ${to}`);
  if (!canTransition(from, to)) throw illegal();
  if (isHumanTransition(from, to) !== (ev.actor === 'human')) throw illegal();
  return tx(db, () => {
    const cur = getTicket(db, id);
    if (!cur || cur.state !== from) return false;
    if (from === 'blocked' && to !== cur.blockedFrom && to !== 'ready' && to !== 'cancelled') throw illegal();
    const extra: Record<string, unknown> = { state: to };
    if (to === 'blocked') extra.blocked_from = from;
    if (from === 'blocked') Object.assign(extra, { blocked_from: null, blocked_reason: null });
    const { sql, vals } = setClause(patch, extra);
    if (db.prepare(`UPDATE tickets SET ${sql} WHERE id=? AND state=?`).run(...vals, id, from).changes !== 1) return false;
    db.prepare('INSERT INTO events (ticket_id, run_id, type, from_state, to_state, actor, data_json, at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, ev.runId ?? null, ev.type, from, to, ev.actor, ev.data === undefined ? null : JSON.stringify(ev.data), now());
    return true;
  });
}

export function patchTicket(db: DatabaseSync, id: string, expectedState: TicketState, patch: Partial<Ticket>): boolean {
  const { sql, vals } = setClause(patch, {});
  return db.prepare(`UPDATE tickets SET ${sql} WHERE id=? AND state=?`).run(...vals, id, expectedState).changes === 1;
}

export function startRun(db: DatabaseSync, ticketId: string, kind: Run['kind'], sandbox?: string): Run {
  const id = db.prepare("INSERT INTO runs (ticket_id, kind, state, sandbox, started_at) VALUES (?,?,'starting',?,?)")
    .run(ticketId, kind, sandbox ?? null, now()).lastInsertRowid;
  return get<Run>(db, 'SELECT * FROM runs WHERE id=?', Number(id))!;
}

export function heartbeat(db: DatabaseSync, runId: number, pid?: number): void {
  db.prepare("UPDATE runs SET heartbeat_at=?, pid=COALESCE(?, pid), state=CASE WHEN state='starting' THEN 'running' ELSE state END WHERE id=?")
    .run(now(), pid ?? null, runId);
}

export function finishRun(db: DatabaseSync, runId: number, state: Run['state'], result?: unknown): void {
  db.prepare('UPDATE runs SET state=?, result_json=?, ended_at=? WHERE id=?')
    .run(state, result === undefined ? null : JSON.stringify(result), now(), runId);
}

export const activeRun = (db: DatabaseSync): Run | undefined =>
  get<Run>(db, "SELECT * FROM runs WHERE state IN ('starting','running') ORDER BY id LIMIT 1");

export const events = (db: DatabaseSync, ticketId: string): Event[] =>
  all<Event>(db, 'SELECT * FROM events WHERE ticket_id=? ORDER BY id', ticketId);

export const eventsSince = (db: DatabaseSync, afterId: number): Event[] =>
  all<Event>(db, 'SELECT * FROM events WHERE id>? ORDER BY id', afterId);

export function note(db: DatabaseSync, ticketId: string, data: unknown, runId?: number): void {
  db.prepare("INSERT INTO events (ticket_id, run_id, type, actor, data_json, at) VALUES (?,?,'note','supervisor',?,?)")
    .run(ticketId, runId ?? null, JSON.stringify(data), now());
}

export const latestRun = (db: DatabaseSync, ticketId: string, kinds: Run['kind'][]): Run | undefined =>
  get<Run>(db, `SELECT * FROM runs WHERE ticket_id=? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`, ticketId, ...kinds);

export const openRuns = (db: DatabaseSync): Run[] =>
  all<Run>(db, "SELECT * FROM runs WHERE state IN ('starting','running') ORDER BY id");

export const listRuns = (db: DatabaseSync, ticketId: string): Run[] =>
  all<Run>(db, 'SELECT * FROM runs WHERE ticket_id=? ORDER BY id', ticketId);
