// Local control-room API (spec §9): 127.0.0.1 only, mutations need JSON + a same-origin Origin header.
import { createServer as httpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { sfHome } from './db.ts';
import * as store from './store.ts';
import * as actions from './actions.ts';
import { diff } from './git.ts';
import { pidAlive } from './supervisor.ts';
import type { Sandbox } from './sandbox.ts';

const MAX_BODY = 64 * 1024;
const MAX_LOG = 1024 * 1024;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json',
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (b && typeof b === 'object' && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch { /* fall through */ }
  throw new HttpError(400, 'invalid JSON body');
}

const nonEmpty = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${what} required`);
  return v;
};

export function createServer(db: DatabaseSync, opts: { port: number; webDist: string; sandbox: Sandbox }): Server {
  const server = httpServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return void res.end();
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof HttpError) json(res, e.status, { error: msg });
      else if (/illegal transition/.test(msg)) json(res, 409, { error: msg });
      else json(res, 500, { error: msg });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    if (!path.startsWith('/api/')) return serveStatic(req, res, path);
    if (req.method === 'POST') return mutate(req, res, path);
    if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');

    if (path === '/api/tickets') return json(res, 200, store.listTickets(db));
    if (path === '/api/events') return sse(req, res);
    let m = /^\/api\/tickets\/([^/]+)$/.exec(path);
    if (m) {
      const t = ticket(m[1]!);
      const repo = store.getRepo(db, t.repoId);
      let d: string | undefined;
      if (repo && t.baseSha && t.headSha) d = await diff(repo.path, t.baseSha, t.headSha).catch(() => undefined);
      return json(res, 200, { ticket: t, runs: store.listRuns(db, t.id), events: store.events(db, t.id), ...(d === undefined ? {} : { diff: d }) });
    }
    m = /^\/api\/runs\/([^/]+)\/log$/.exec(path);
    if (m) return runLog(res, m[1]!, url.searchParams.get('offset') ?? '0');
    throw new HttpError(404, 'not found');
  }

  function ticket(id: string) {
    if (!/^T-\d+$/.test(id)) throw new HttpError(400, 'invalid ticket id');
    return store.getTicket(db, id) ?? (() => { throw new HttpError(404, `no such ticket: ${id}`); })();
  }

  async function mutate(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const m = /^\/api\/tickets\/([^/]+)\/(approve|reject|answer|retry|reset|cancel)$/.exec(path);
    if (!m) throw new HttpError(404, 'not found');
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Content-Type must be application/json');
    const port = (server.address() as { port: number } | null)?.port ?? opts.port;
    if (![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin ?? '')) throw new HttpError(403, 'bad origin');
    const body = await readBody(req);
    const id = ticket(m[1]!).id;
    const sb = { db, sandbox: opts.sandbox };
    let ok: boolean;
    switch (m[2]) {
      case 'approve': ok = actions.approve(db, id); break;
      case 'reject': ok = actions.reject(db, id, nonEmpty(body.note, 'note')); break;
      case 'answer': ok = actions.answer(db, id, nonEmpty(body.text, 'text')); break;
      case 'retry': ok = actions.retry(db, id); break;
      case 'reset': ok = await actions.reset(sb, id); break;
      default: ok = await actions.cancel(sb, id);
    }
    if (!ok) throw new HttpError(409, 'ticket state changed, retry');
    json(res, 200, { ticket: store.getTicket(db, id) });
  }

  async function runLog(res: ServerResponse, rawId: string, rawOffset: string): Promise<void> {
    if (!/^\d+$/.test(rawId)) throw new HttpError(400, 'invalid run id');
    if (!/^\d+$/.test(rawOffset)) throw new HttpError(400, 'invalid offset');
    const offset = Number(rawOffset);
    let fh;
    try { fh = await open(join(sfHome(), 'logs', `${rawId}.jsonl`), 'r'); } catch { return json(res, 200, { text: '', offset }); }
    try {
      const buf = Buffer.alloc(MAX_LOG);
      const { bytesRead } = await fh.read(buf, 0, MAX_LOG, offset);
      json(res, 200, { text: buf.subarray(0, bytesRead).toString('utf8'), offset: offset + bytesRead });
    } finally { await fh.close(); }
  }

  function sse(req: IncomingMessage, res: ServerResponse): void {
    const hdr = req.headers['last-event-id'];
    const last = Number(hdr);
    let cursor = hdr && Number.isInteger(last) && last >= 0 ? last : (db.prepare('SELECT COALESCE(MAX(id),0) m FROM events').get()!.m as number);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const tick = () => {
      for (const e of store.eventsSince(db, cursor)) { res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`); cursor = e.id; }
    };
    tick();
    const timer = setInterval(tick, 1000);
    req.on('close', () => clearInterval(timer));
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, path: string): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    const root = resolve(opts.webDist);
    if (!existsSync(root)) {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('dashboard not built: run npm run build:web');
      return;
    }
    let rel: string;
    try { rel = decodeURIComponent(path); } catch { throw new HttpError(404, 'not found'); }
    let file = resolve(root, '.' + rel);
    if (file !== root && !file.startsWith(root + sep)) throw new HttpError(404, 'not found');
    if (!existsSync(file) || !statSync(file).isFile()) file = join(root, 'index.html');
    if (!existsSync(file)) throw new HttpError(404, 'not found');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  }

  return server;
}

// Single-instance lock: the file holds the owner's pid; a dead owner's lock is taken over.
export function acquireLock(path: string): () => void {
  try {
    const fd = openSync(path, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const pid = Number(readFileSync(path, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) throw new Error(`sf serve already running (pid ${pid})`);
    writeFileSync(path, String(process.pid)); // shortcut: stale takeover is not atomic against two simultaneous starters
  }
  return () => {
    try { if (readFileSync(path, 'utf8').trim() === String(process.pid)) unlinkSync(path); } catch { /* already gone */ }
  };
}
