#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb, sfHome } from './db.ts';
import * as store from './store.ts';
import * as git from './git.ts';
import { detectProfile } from './profiles.ts';
import { TRANSITIONS } from './states.ts';
import type { RepoProfile, TicketState } from './types.ts';

type Cmd = (argv: string[]) => Promise<void>;
type Db = ReturnType<typeof openDb>;

const fail = (m: string): never => { throw new Error(m); };

function db(): Db {
  mkdirSync(sfHome(), { recursive: true });
  return openDb(join(sfHome(), 'sf.db'));
}

const opts = (argv: string[], options: Record<string, { type: 'string' | 'boolean' }>, n: number) => {
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true });
  if (positionals.length !== n) fail(`expected ${n} argument(s), got ${positionals.length}`);
  return { v: values as Record<string, string | boolean | undefined>, p: positionals };
};

function ticketOf(d: Db, id: string) {
  if (!/^T-\d+$/.test(id)) fail(`invalid ticket id: ${id}`);
  return store.getTicket(d, id) ?? fail(`no such ticket: ${id}`);
}

// Moves from the ticket's actual current state, so a wrong state surfaces as "illegal transition".
function move(d: Db, id: string, to: TicketState, actor: 'human', patch = {}) {
  const t = ticketOf(d, id);
  if (!store.transition(d, id, t.state, to, { type: 'transition', actor }, patch)) fail('ticket state changed, retry');
}

const repoAdd: Cmd = async (argv) => {
  const { v, p } = opts(argv, { id: { type: 'string' }, target: { type: 'string' } }, 1);
  const path = resolve(p[0]!);
  await git.commonGitDir(path).catch(() => fail(`not a git repo: ${path}`));
  const id = (v.id as string | undefined) ?? basename(path).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z0-9-]+$/.test(id)) fail(`invalid repo id: ${id}`);
  const profile = detectProfile(path);
  const targetBranch = (v.target as string | undefined) ?? await git.currentBranch(path);
  store.addRepo(db(), { id, path, targetBranch, profile });
  console.log(JSON.stringify(profile, null, 2));
};

const repoProfile: Cmd = async (argv) => {
  const { v, p } = opts(argv, { file: { type: 'string' } }, 1);
  if (!v.file) fail('--file required');
  const d = db();
  const repo = store.getRepo(d, p[0]!) ?? fail(`no such repo: ${p[0]}`);
  const profile = JSON.parse(readFileSync(v.file as string, 'utf8')) as RepoProfile;
  const strs = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === 'string');
  const ok = (profile.kind === 'ts' || profile.kind === 'py') && Array.isArray(profile.setup) && profile.setup.every(strs)
    && Array.isArray(profile.checks) && profile.checks.every((k) => typeof k?.name === 'string' && strs(k.cmd) && k.cmd.length > 0);
  if (!ok) fail('invalid profile');
  store.setProfile(d, repo.id, profile);
};

const ticketAdd: Cmd = async (argv) => {
  const { v, p } = opts(argv, { title: { type: 'string' }, body: { type: 'string' }, 'body-file': { type: 'string' } }, 1);
  if (!v.title) fail('--title required');
  if ((v.body === undefined) === (v['body-file'] === undefined)) fail('exactly one of --body / --body-file required');
  const body = v.body !== undefined ? (v.body as string) : readFileSync(v['body-file'] as string, 'utf8');
  const d = db();
  if (!store.getRepo(d, p[0]!)) fail(`no such repo: ${p[0]}`);
  console.log(store.createTicket(d, { repoId: p[0]!, title: v.title as string, body }).id);
};

const ticketList: Cmd = async (argv) => {
  const { v } = opts(argv, { state: { type: 'string' } }, 0);
  if (v.state && !((v.state as string) in TRANSITIONS)) fail(`unknown state: ${v.state}`);
  for (const t of store.listTickets(db(), v.state ? { state: v.state as TicketState } : undefined)) {
    console.log(`${t.id}\t${t.state}\t${t.repoId}\t${t.title}`);
  }
};

const ticketShow: Cmd = async (argv) => {
  const { v, p } = opts(argv, { json: { type: 'boolean' } }, 1);
  const t = ticketOf(db(), p[0]!);
  if (v.json) console.log(JSON.stringify(t, null, 2));
  else console.log(`${t.id} [${t.state}] ${t.repoId}\n${t.title}\n\n${t.body}${t.spec ? `\n\n--- spec ---\n${t.spec}` : ''}`);
};

const spec: Cmd = async (argv) => {
  const { v, p } = opts(argv, { file: { type: 'string' }, agent: { type: 'boolean' } }, 1);
  if (!v.file === !v.agent) fail('exactly one of --file / --agent required');
  const d = db();
  if (v.agent) move(d, p[0]!, 'specifying', 'human');
  else move(d, p[0]!, 'specified', 'human', { spec: readFileSync(v.file as string, 'utf8') });
};

const ready: Cmd = async (argv) => move(db(), opts(argv, {}, 1).p[0]!, 'ready', 'human');

const nested = (table: Record<string, Cmd>): Cmd => async (argv) => {
  const sub = table[argv[0] ?? ''] ?? fail(`unknown subcommand: ${argv[0] ?? ''}`);
  await sub(argv.slice(1));
};

const commands: Record<string, Cmd> = {
  repo: nested({ add: repoAdd, profile: repoProfile }),
  ticket: nested({ add: ticketAdd, list: ticketList, show: ticketShow }),
  spec,
  ready,
};

export async function main(argv: string[]): Promise<number> {
  try {
    await (commands[argv[0] ?? ''] ?? fail(`unknown command: ${argv[0] ?? ''}`))(argv.slice(1));
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
