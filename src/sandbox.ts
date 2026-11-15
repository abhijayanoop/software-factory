import { spawn, execFile } from 'node:child_process';
import { createWriteStream, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ExecOpts {
  stdin?: string;
  timeoutMs: number;
  logPath: string;
  onPid?: (pid: number) => void;
  signal?: AbortSignal;
}
export interface Sandbox {
  create(name: string, mounts: { path: string; ro?: boolean }[]): Promise<void>;
  exec(name: string, argv: string[], o: ExecOpts): Promise<{ code: number; timedOut: boolean }>;
  remove(name: string): Promise<void>;
}

export function buildSbxCreateArgs(name: string, mounts: { path: string; ro?: boolean }[]): string[] {
  const m = mounts.map((x) => (x.ro ? `${x.path}:ro` : x.path));
  return ['--no-input', 'create', 'claude', ...m, '--name', name, '-t', 'sf-claude-node24', '--pull', 'never', '--static-mcp', 'context7'];
}

export function buildSbxExecArgs(name: string, argv: string[], interactive: boolean): string[] {
  return ['exec', ...(interactive ? ['-i'] : []), name, ...argv];
}

function sbx(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('sbx', args, { shell: false, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}${err && typeof err.code !== 'number' ? String(err.message) : ''}` });
    });
  });
}

function killTree(pid: number, child: { kill(s: 'SIGKILL'): boolean }): void {
  if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {});
  else child.kill('SIGKILL');
}

export class SbxSandbox implements Sandbox {
  async create(name: string, mounts: { path: string; ro?: boolean }[]): Promise<void> {
    const r = await sbx(buildSbxCreateArgs(name, mounts));
    // idempotent: an existing sandbox of that name is success
    if (r.code !== 0 && !/already exists/i.test(r.out)) throw new Error(`sbx create failed (${r.code}): ${r.out.trim()}`);
  }

  async remove(name: string): Promise<void> {
    const r = await sbx(['rm', '--force', name]);
    if (r.code !== 0 && r.code !== 125 && !/not found/i.test(r.out)) throw new Error(`sbx rm failed (${r.code}): ${r.out.trim()}`);
  }

  exec(name: string, argv: string[], o: ExecOpts): Promise<{ code: number; timedOut: boolean }> {
    mkdirSync(dirname(o.logPath), { recursive: true });
    const log = createWriteStream(o.logPath, { flags: 'a' });
    const child = spawn('sbx', buildSbxExecArgs(name, argv, o.stdin !== undefined), { shell: false, windowsHide: true });
    if (child.pid !== undefined) o.onPid?.(child.pid);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.stdin.on('error', () => {});
    child.stdin.end(o.stdin);
    return new Promise((resolve) => {
      let timedOut = false;
      let aborted = false;
      const kill = () => { if (child.pid !== undefined) killTree(child.pid, child); };
      const timer = setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs);
      const onAbort = () => { aborted = true; kill(); };
      if (o.signal?.aborted) onAbort(); else o.signal?.addEventListener('abort', onAbort, { once: true });
      const done = (code: number) => {
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
        log.end(() => resolve({ code: aborted && code === 0 ? 1 : code, timedOut }));
      };
      child.on('error', (e) => { log.write(`spawn error: ${e.message}\n`); done(127); });
      child.on('close', (code) => done(code ?? 1));
    });
  }
}

export type FakeScript = (argv: string[], stdin?: string) => { code: number; stdout?: string; hang?: boolean };

export class FakeSandbox implements Sandbox {
  calls: { name: string; argv: string[]; stdin?: string }[] = [];
  creates: { name: string; mounts: { path: string; ro?: boolean }[] }[] = [];
  removes: string[] = [];
  script: FakeScript;
  constructor(script: FakeScript = () => ({ code: 0 })) { this.script = script; }

  async create(name: string, mounts: { path: string; ro?: boolean }[]): Promise<void> { this.creates.push({ name, mounts }); }
  async remove(name: string): Promise<void> { this.removes.push(name); }

  exec(name: string, argv: string[], o: ExecOpts): Promise<{ code: number; timedOut: boolean }> {
    this.calls.push({ name, argv, stdin: o.stdin });
    const r = this.script(argv, o.stdin);
    if (r.stdout) {
      mkdirSync(dirname(o.logPath), { recursive: true });
      appendFileSync(o.logPath, r.stdout);
    }
    if (!r.hang) return Promise.resolve({ code: r.code, timedOut: false });
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ code: 124, timedOut: true }), o.timeoutMs);
      const onAbort = () => { clearTimeout(timer); resolve({ code: 130, timedOut: false }); };
      if (o.signal?.aborted) onAbort(); else o.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
